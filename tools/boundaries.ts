// `task boundaries`: the rules the compiler cannot enforce inside one Bun workspace.
//
//  imports      a context imports only: its own files, @lazytax/kernel (and /testing from tests),
//               contract packages listed in its package.json, node:/bun builtins and the npm
//               packages in its own package.json. Never another context's src or files.
//  contract     contract/ holds types only: no class, function, const or let exports.
//  kernel       src/kernel never imports a context (only the generated list).
//  owner        every public method of a repository over user data (its file mentions user_id) in
//               contexts/*/src/data/ takes `owner: Owner` first,
//               except purgeUser(userId); `// owner-exempt: <why>` on the line above exempts one.
//  purge        a context whose migrations have a user_id column registers users.purgeUser.
//  sql          a context's SQL never names another context's schema.
//  uses         every context.yaml `uses:` entry is listed in dependency.yaml.
//
//   bun tools/boundaries.ts [root]     prints each breach; exit 1 if any
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface Breach {
  rule: 'imports' | 'contract' | 'kernel' | 'owner' | 'purge' | 'sql' | 'uses';
  file: string;
  line: number;
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

export function importsOf(text: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec === undefined) continue;
    out.push({ spec, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

// Blank out comments (keeping line numbers) so prose like "from charity.v1" is not read as SQL.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(--|\/\/).*$/gm, '');

interface Ctx {
  name: string;
  dir: string;
  needs: string[];
  uses: string[];
  deps: Set<string>;
}

function readContexts(root: string): Ctx[] {
  const base = join(root, 'contexts');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(base, d.name, 'context.yaml')))
    .map(d => {
      const dir = join(base, d.name);
      const y = Bun.YAML.parse(readFileSync(join(dir, 'context.yaml'), 'utf8'));
      const pkgFile = join(dir, 'package.json');
      const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {};
      const yy = isObject(y) ? y : {};
      return {
        name: d.name,
        dir,
        needs: Array.isArray(yy.needs) ? (yy.needs as string[]) : [],
        uses: Array.isArray(yy.uses) ? (yy.uses as string[]) : [],
        deps: new Set(Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })),
      };
    });
}

const BUILTIN = /^(node:|bun:|bun$)/;
const packageName = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec);

function checkImports(root: string, c: Ctx, breaches: Breach[]): void {
  for (const file of walk(c.dir).filter(f => /\.(ts|tsx|js|mjs)$/.test(f))) {
    const rel = relative(root, file);
    const inTests = rel.split(sep).includes('tests');
    const inContract = relative(c.dir, file).startsWith(`contract${sep}`);
    const text = readFileSync(file, 'utf8');
    for (const { spec, line } of importsOf(text)) {
      const bad = (message: string) => breaches.push({ rule: 'imports', file: rel, line, message });
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        const home = inContract ? join(c.dir, 'contract') : c.dir;
        if (!target.startsWith(home + sep) && target !== home)
          bad(
            `imports "${spec}", which is outside ${relative(root, home)}. Fix: import the other context's contract package instead`,
          );
        continue;
      }
      if (BUILTIN.test(spec)) continue;
      if (spec === '@lazytax/kernel') continue;
      if (spec === '@lazytax/kernel/testing') {
        if (!inTests) bad('imports @lazytax/kernel/testing outside tests/. Fix: only tests may use the test helpers');
        continue;
      }
      if (spec.startsWith('@lazytax/kernel/')) {
        bad(`imports "${spec}", a kernel internal. Fix: import from @lazytax/kernel`);
        continue;
      }
      const contract = /^@lazytax\/([a-z0-9]+)-contract(\/|$)/.exec(spec);
      if (contract) {
        // Contracts are types only, so importing one (e.g. for an event you subscribe to) is always
        // allowed; calling it needs it in context.yaml needs, which deps.get enforces at start.
        const owner = contract[1] ?? '';
        if (!c.deps.has(`@lazytax/${owner}-contract`) && !inContract)
          bad(`imports @lazytax/${owner}-contract but package.json does not list it. Fix: add it to dependencies`);
        continue;
      }
      if (spec.startsWith('@lazytax/')) {
        bad(`imports "${spec}", another context's internals. Fix: depend on its contract package`);
        continue;
      }
      if (!c.deps.has(packageName(spec)))
        bad(
          `imports npm package "${packageName(spec)}", which ${relative(root, join(c.dir, 'package.json'))} does not list. Fix: add it, or use what @lazytax/kernel exports`,
        );
    }
    if (inContract) {
      for (const m of text.matchAll(/^\s*export\s+(?:default\s+)?(class|function|const|let|var|enum)\b/gm))
        breaches.push({
          rule: 'contract',
          file: rel,
          line: lineOf(text, m.index),
          message: `contract exports a ${m[1]}; a contract holds interfaces and DTO types only`,
        });
    }
  }
}

function checkKernel(root: string, breaches: Breach[]): void {
  for (const file of walk(join(root, 'src', 'kernel')).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const { spec, line } of importsOf(text))
      if (spec.includes('contexts/') || /^@lazytax\/(?!kernel)/.test(spec))
        breaches.push({
          rule: 'kernel',
          file: relative(root, file),
          line,
          message: `the kernel imports "${spec}"; it must never import a context`,
        });
  }
}

// A public method is `[async] name(` at class-member indentation, not private/protected/static/constructor.
const METHOD_RE = /^( {2}|\t)(?:public\s+)?(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gm;

function checkOwner(root: string, c: Ctx, breaches: Breach[]): void {
  for (const file of walk(join(c.dir, 'src', 'data')).filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    // Only repositories over user data: a global catalog (charities, causes) has no owner.
    if (!/\bclass\s+\w+/.test(text) || !/\buser_id\b/.test(text)) continue;
    const lines = text.split('\n');
    for (const m of text.matchAll(METHOD_RE)) {
      const name = m[2] ?? '';
      if (['constructor', 'if', 'for', 'while', 'switch', 'return', 'catch', 'function'].includes(name)) continue;
      if (name === 'purgeUser') continue;
      const line = lineOf(text, m.index);
      if ((lines[line - 2] ?? '').includes('owner-exempt:')) continue;
      const first = (m[3] ?? '').split(',')[0]?.trim() ?? '';
      if (!/^owner\s*:\s*Owner\b/.test(first))
        breaches.push({
          rule: 'owner',
          file: relative(root, file),
          line,
          message: `repository method ${name}(${(m[3] ?? '').trim()}) must take "owner: Owner" first and filter on it. Fix: add owner: Owner and ownerFilter(...), or "// owner-exempt: <why>" above it`,
        });
    }
  }
}

function checkPurge(root: string, c: Ctx, breaches: Breach[]): void {
  const sql = walk(c.dir).filter(f => f.endsWith('.sql'));
  const withUser = sql.find(f => /\buser_id\b/.test(readFileSync(f, 'utf8')));
  if (!withUser) return;
  const register = join(c.dir, 'src', 'register.ts');
  const text = existsSync(register) ? readFileSync(register, 'utf8') : '';
  if (!/\bpurgeUser\s*:/.test(text))
    breaches.push({
      rule: 'purge',
      file: relative(root, register),
      line: 1,
      message: `${relative(root, withUser)} stores user_id but register.ts registers no users.purgeUser. Fix: users: { purgeUser: (userId) => repo.purgeUser(userId) }`,
    });
}

function checkSql(root: string, c: Ctx, all: Ctx[], breaches: Breach[]): void {
  const others = all.filter(o => o.name !== c.name).map(o => o.name);
  if (others.length === 0) return;
  const re = new RegExp(
    `\\b(FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE)\\s+"?(${others.join('|')})"?\\.(?!v\\d)[a-z_]`,
    'gi',
  );
  const files = walk(c.dir).filter(f => f.endsWith('.sql') || (f.endsWith('.ts') && f.includes(`${sep}src${sep}`)));
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(re))
      breaches.push({
        rule: 'sql',
        file: relative(root, file),
        line: lineOf(text, m.index),
        message: `SQL names schema "${m[2]}", which belongs to another context. Fix: call its contract`,
      });
  }
}

function checkUses(root: string, all: Ctx[], breaches: Breach[]): void {
  const depFile = join(root, 'dependency.yaml');
  const listed = existsSync(depFile) ? Bun.YAML.parse(readFileSync(depFile, 'utf8')) : {};
  const keys = new Set(isObject(listed) ? Object.keys(listed) : []);
  for (const c of all)
    for (const u of c.uses)
      if (!keys.has(u))
        breaches.push({
          rule: 'uses',
          file: relative(root, join(c.dir, 'context.yaml')),
          line: 1,
          message: `uses "${u}", which dependency.yaml does not list. Fix: add it to dependency.yaml or remove it`,
        });
}

export function checkBoundaries(root: string): Breach[] {
  const breaches: Breach[] = [];
  const all = readContexts(root);
  for (const c of all) {
    checkImports(root, c, breaches);
    checkOwner(root, c, breaches);
    checkPurge(root, c, breaches);
    checkSql(root, c, all, breaches);
  }
  checkKernel(root, breaches);
  checkUses(root, all, breaches);
  return breaches;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const breaches = checkBoundaries(root);
  for (const b of breaches) console.error(`${b.file}:${b.line}  [${b.rule}] ${b.message}`);
  if (breaches.length > 0) {
    console.error(`boundaries: ${breaches.length} breach(es)`);
    process.exit(1);
  }
  console.log(`boundaries: ok (${readContexts(root).length} contexts)`);
}
