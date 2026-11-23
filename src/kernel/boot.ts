// The kernel boot: find, check, order, build and wire every context. Everything that can be wrong
// with a context fails here, before the app listens, as one ContextError naming the context, its
// folder, the problem and the fix.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { SQL } from 'bun';
import { Hono } from 'hono';
import { z } from 'zod';
import { createAuthenticator } from './auth/jwt';
import { ADMIN_POLICY, type Policy, type PolicyTable, readPolicyFile } from './auth/policies';
import { ANONYMOUS } from './auth/principal';
import { contextConfigOverride, type KernelConfig } from './config';
import { createDispatcher, type Dispatcher, type RegisteredSubscriber } from './db/dispatcher';
import { guardFetch } from './db/fetch-guard';
import { type MigrationSet, runMigrations } from './db/migrate';
import { createUnitOfWork, type UnitOfWork } from './db/uow';
import type {
  Clock,
  ContextDefinition,
  ContextParts,
  ContextSetup,
  UserHooks,
  UserLifecycle,
  WorkerDef,
} from './define';
import { Problem } from './errors';
import { logRequest, type MountedRoute, mountRoutes, problemResponse, requestIdOf } from './http/server';
import { createLogger, type Logger } from './log';
import { ContextError, type Manifest, ManifestSchema } from './manifest';
import { type MountedTool, mountMcp } from './mcp/server';

const REPO_ROOT = resolve(import.meta.dir, '../..');

interface GeneratedContext {
  folder: string;
  // biome-ignore lint/suspicious/noExplicitAny: each context has its own config type
  definition: ContextDefinition<any>;
}

interface LoadedContext {
  manifest: Manifest;
  // Relative to the repo root, e.g. contexts/vacation
  folder: string;
  // biome-ignore lint/suspicious/noExplicitAny: each context has its own config type
  definition: ContextDefinition<any>;
  parts: ContextParts;
}

export interface BootOptions {
  config: KernelConfig;
  contexts: GeneratedContext[];
  root?: string;
  // Load only these contexts (plus what they need).
  only?: string[];
  // Per-context config overrides, merged over LAZYTAX_<NAME>_CONFIG.
  contextConfig?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  logSink?: (line: string) => void;
  // Compare src/generated/contexts.ts with the folders on disk (default true).
  checkGenerated?: boolean;
}

export interface Kernel {
  app: Hono;
  fetch(req: Request): Promise<Response>;
  contexts: LoadedContext[];
  routes: MountedRoute[];
  tools: MountedTool[];
  workers: { context: string; def: WorkerDef }[];
  policies: PolicyTable;
  contract(id: string): unknown;
  pool: SQL;
  uow: UnitOfWork;
  dispatcher: Dispatcher;
  log: Logger;
  migrate(): Promise<number>;
  startWorkers(): void;
  close(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

function readManifest(root: string, folder: string): Manifest {
  const name = basename(folder);
  const file = join(root, folder, 'context.yaml');
  if (!existsSync(file))
    throw new ContextError(
      name,
      folder,
      'context.yaml is missing',
      'add contexts/<name>/context.yaml (see docs/adding-a-context.md)',
    );
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ContextError(
      name,
      folder,
      `context.yaml is not valid YAML (${(e as Error).message})`,
      'fix the YAML syntax',
    );
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join('.') : 'context.yaml';
    throw new ContextError(
      name,
      folder,
      `context.yaml ${where} ${first?.message ?? 'is invalid'}`,
      `fix "${where}" in ${folder}/context.yaml`,
    );
  }
  if (parsed.data.name !== name)
    throw new ContextError(
      parsed.data.name,
      folder,
      `name "${parsed.data.name}" does not match its folder "${name}"`,
      `set name: ${name}, or rename the folder`,
    );
  return parsed.data;
}

function onDisk(root: string): string[] {
  const dir = join(root, 'contexts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'context.yaml')))
    .map(d => `contexts/${d.name}`);
}

function readDependencies(root: string): Set<string> {
  const file = join(root, 'dependency.yaml');
  if (!existsSync(file)) return new Set();
  const raw = Bun.YAML.parse(readFileSync(file, 'utf8'));
  return new Set(isObject(raw) ? Object.keys(raw) : []);
}

// Kahn's algorithm over `needs`; ties keep name order so the order is stable.
export function orderContexts<T extends { manifest: Manifest; folder: string }>(items: T[]): T[] {
  const provider = new Map<string, T>();
  for (const it of items)
    for (const c of it.manifest.provides) {
      const other = provider.get(c);
      if (other)
        throw new ContextError(
          it.manifest.name,
          it.folder,
          `provides "${c}", which "${other.manifest.name}" already provides`,
          'each contract has exactly one provider',
        );
      provider.set(c, it);
    }
  const deps = new Map<T, Set<T>>();
  for (const it of items) {
    const set = new Set<T>();
    for (const need of it.manifest.needs) {
      const p = provider.get(need);
      if (!p)
        throw new ContextError(
          it.manifest.name,
          it.folder,
          `needs "${need}" but no context provides it`,
          `add the context that provides ${need}, or remove it from needs`,
        );
      if (p === it)
        throw new ContextError(it.manifest.name, it.folder, `needs its own contract "${need}"`, 'remove it from needs');
      set.add(p);
    }
    deps.set(it, set);
  }
  const out: T[] = [];
  const done = new Set<T>();
  const sorted = [...items].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  while (out.length < items.length) {
    const next = sorted.find(it => !done.has(it) && [...(deps.get(it) ?? [])].every(d => done.has(d)));
    if (!next) {
      const left = sorted.filter(it => !done.has(it));
      const cycle = findCycle(left, deps);
      const first = cycle[0] ?? left[0];
      throw new ContextError(
        first?.manifest.name ?? '?',
        first?.folder ?? '?',
        `its needs form a cycle: ${cycle.map(c => c.manifest.name).join(' -> ')}`,
        'break the cycle with a kernel user hook (deleteGuard/beforePurge/purgeUser) or an outbox event instead of a need',
      );
    }
    out.push(next);
    done.add(next);
  }
  return out;
}

function findCycle<T>(left: T[], deps: Map<T, Set<T>>): T[] {
  const inLeft = new Set(left);
  for (const start of left) {
    const path: T[] = [];
    const seen = new Set<T>();
    let cur: T | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = [...(deps.get(cur) ?? [])].find(d => inLeft.has(d));
    }
    if (cur !== undefined) {
      const i = path.indexOf(cur);
      return [...path.slice(i), cur];
    }
  }
  return left;
}

function closure(all: { manifest: Manifest }[], only: string[]): Set<string> {
  const byName = new Map(all.map(c => [c.manifest.name, c]));
  const provider = new Map<string, string>();
  for (const c of all) for (const p of c.manifest.provides) provider.set(p, c.manifest.name);
  const out = new Set<string>();
  const visit = (n: string) => {
    if (out.has(n)) return;
    const c = byName.get(n);
    if (!c) throw new Error(`startTestApp/boot: no context named "${n}"`);
    out.add(n);
    for (const need of c.manifest.needs) {
      const p = provider.get(need);
      if (p) visit(p);
    }
  };
  for (const n of only) visit(n);
  return out;
}

function policyTable(root: string, loaded: { manifest: Manifest; folder: string }[]): PolicyTable {
  const table = new Map<string, Policy | 'public' | 'registered'>([
    ['public', 'public'],
    ['registered', 'registered'],
    ['admin', ADMIN_POLICY],
  ]);
  const from = new Map<string, string>();
  const add = (owner: string, folder: string, file: string) => {
    for (const [name, p] of Object.entries(readPolicyFile(file))) {
      if (name === 'public' || name === 'registered')
        throw new ContextError(
          owner,
          folder,
          `policies.yaml redefines the built-in policy "${name}"`,
          'pick another name',
        );
      if (from.has(name) && !(owner === 'kernel' && name === 'admin'))
        throw new ContextError(
          owner,
          folder,
          `policy "${name}" is already defined by ${from.get(name)}`,
          'pick another name, or reuse that policy',
        );
      table.set(name, p);
      from.set(name, owner);
    }
  };
  add('kernel', '.', join(root, 'policies.yaml'));
  for (const c of loaded) add(c.manifest.name, c.folder, join(root, c.folder, 'policies.yaml'));
  return table;
}

export async function bootKernel(opts: BootOptions): Promise<Kernel> {
  const root = opts.root ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  const log = createLogger({ level: opts.config.log.level, file: opts.config.log.file, sink: opts.logSink }, {});
  const kernelLog = log.child({ context: 'kernel' });

  // 1. Manifests, checked against the disk and dependency.yaml.
  const all = opts.contexts.map(g => {
    const manifest = readManifest(root, g.folder);
    if (g.definition?.kind !== 'lazytax.context')
      throw new ContextError(
        manifest.name,
        g.folder,
        'src/register.ts does not export default defineContext(...)',
        'export default defineContext({ build: ... })',
      );
    return { manifest, folder: g.folder, definition: g.definition };
  });
  if (opts.checkGenerated !== false) {
    const known = new Set(opts.contexts.map(g => g.folder));
    for (const folder of onDisk(root))
      if (!known.has(folder))
        throw new ContextError(
          basename(folder),
          folder,
          'is on disk but not in src/generated/contexts.ts',
          'run bun install (it regenerates the file)',
        );
  }
  const ids = new Map<string, string>();
  const infra = readDependencies(root);
  for (const c of all) {
    const dup = ids.get(c.manifest.id);
    if (dup)
      throw new ContextError(
        c.manifest.name,
        c.folder,
        `id ${c.manifest.id} is already used by "${dup}"`,
        'generate a new random id',
      );
    ids.set(c.manifest.id, c.manifest.name);
    for (const p of c.manifest.provides)
      if (!p.startsWith(`${c.manifest.name}.`))
        throw new ContextError(
          c.manifest.name,
          c.folder,
          `provides "${p}", which is not named after it`,
          `name it ${c.manifest.name}.v1`,
        );
    for (const u of c.manifest.uses)
      if (!infra.has(u))
        throw new ContextError(
          c.manifest.name,
          c.folder,
          `uses "${u}", which dependency.yaml does not list`,
          `add ${u} to /dependency.yaml, or remove it from uses`,
        );
  }
  const names = new Set(all.map(c => c.manifest.name));
  const keep = opts.only ? closure(all, opts.only) : names;
  const ordered = orderContexts(all.filter(c => keep.has(c.manifest.name)));
  const policies = policyTable(root, ordered);

  // 2. Runtime pieces.
  const pool = new Bun.SQL(opts.config.databaseUrl, { max: 20, idleTimeout: 30 });
  const uow = createUnitOfWork(pool, {
    onRetry: (attempt, state) => kernelLog.warn('unit of work retried', { attempt, sqlState: state }),
  });
  const unguard = guardFetch(() => uow.inUnit());
  const clock: Clock = opts.clock ?? { now: () => new Date() };
  const subscribers: RegisteredSubscriber[] = [];
  const dispatcher = createDispatcher({
    uow,
    subscribers: () => subscribers,
    log: kernelLog,
    pollMs: opts.config.outbox.pollMs,
    maxAttempts: opts.config.outbox.maxAttempts,
  });
  const hooks: { context: string; hooks: UserHooks }[] = [];
  const users: UserLifecycle = {
    async deleteGuard(userId) {
      for (const h of hooks) await h.hooks.deleteGuard?.(userId);
    },
    async beforePurge(userId) {
      for (const h of hooks)
        try {
          await h.hooks.beforePurge?.(userId);
        } catch (e) {
          log.warn('beforePurge failed (ignored)', { context: h.context, error: String((e as Error)?.message ?? e) });
        }
    },
    async purgeUser(userId) {
      if (!uow.inUnit()) throw new Error('users.purgeUser must run inside uow.run');
      for (const h of [...hooks].reverse()) await h.hooks.purgeUser?.(userId);
    },
  };

  // 3. Build each context in needs order.
  const built = new Map<string, unknown>();
  const loaded: LoadedContext[] = [];
  const routes: MountedRoute[] = [];
  const tools: MountedTool[] = [];
  const workers: { context: string; def: WorkerDef }[] = [];
  const seenRoutes = new Map<string, string>();
  for (const c of ordered) {
    const { manifest: m, folder } = c;
    const fail = (problem: string, fix: string) => new ContextError(m.name, folder, problem, fix);
    let config: unknown = {};
    if (c.definition.config) {
      const schema = c.definition.config as z.ZodType;
      const defaults = schema.safeParse({});
      const merged = deepMerge(
        deepMerge(defaults.success ? defaults.data : {}, contextConfigOverride(m.name, env)),
        opts.contextConfig?.[m.name],
      );
      const r = schema.safeParse(merged);
      if (!r.success)
        throw fail(
          `config is invalid: ${z.prettifyError(r.error)}`,
          `fix LAZYTAX_${m.name.toUpperCase()}_CONFIG or the defaults in register.ts`,
        );
      config = r.data;
    }
    const needs = new Set(m.needs);
    const setup: ContextSetup<unknown> = {
      name: m.name,
      deps: {
        get: ((id: string) => {
          if (!needs.has(id))
            throw fail(`calls deps.get("${id}") but context.yaml does not list it in needs`, `add ${id} to needs`);
          return built.get(id);
        }) as ContextSetup<unknown>['deps']['get'],
      },
      uow,
      outbox: dispatcher.outboxFor(m.name),
      users,
      log: log.child({ context: m.name }),
      config,
      clock,
    };
    let parts: ContextParts;
    try {
      parts = c.definition.build(setup) ?? {};
    } catch (e) {
      if (e instanceof ContextError) throw e;
      throw fail(
        `build() threw: ${(e as Error).message}`,
        'build must only construct objects; no database or network calls',
      );
    }
    const provided = Object.keys(parts.provides ?? {});
    for (const p of m.provides)
      if (!provided.includes(p))
        throw fail(
          `context.yaml provides "${p}" but build() returns no provides["${p}"]`,
          `return provides: { '${p}': service }`,
        );
    for (const p of provided)
      if (!m.provides.includes(p))
        throw fail(`build() provides "${p}" but context.yaml does not list it`, `add ${p} to provides in context.yaml`);
    for (const [id, impl] of Object.entries(parts.provides ?? {})) built.set(id, impl);

    for (const r of parts.http ?? []) {
      if (!m.http)
        throw fail('has http routes but context.yaml has no http.prefix', 'add http: { prefix: /api/v1/<Controller> }');
      const path = `${m.http.prefix}${r.path === '/' ? '' : r.path}`;
      const label = `${r.method} ${path}`;
      if (!r.policy) throw fail(`route ${label} has no policy`, "add policy: 'registered' (or 'public' / 'admin')");
      if (!policies.has(r.policy))
        throw fail(
          `route ${label} uses unknown policy "${r.policy}"`,
          'use public, registered, admin, or define it in policies.yaml',
        );
      if (r.subject !== undefined && !path.split('/').includes(`:${r.subject}`))
        throw fail(
          `route ${label} has subject "${r.subject}" but no :${r.subject} in its path`,
          `add :${r.subject} to the path or drop subject`,
        );
      const dup = seenRoutes.get(label);
      if (dup) throw fail(`route ${label} is already defined by "${dup}"`, 'change the path');
      seenRoutes.set(label, m.name);
      routes.push({ context: m.name, method: r.method, path, route: r });
    }
    for (const t of parts.mcp ?? []) {
      if (!m.mcp) throw fail('has MCP tools but context.yaml has no mcp.prefix', `add mcp: { prefix: ${m.name} }`);
      const name = `${m.mcp.prefix}.${t.verb}`;
      if (!t.policy) throw fail(`tool ${name} has no policy`, "add policy: 'registered' (or 'public' / 'admin')");
      if (!policies.has(t.policy))
        throw fail(
          `tool ${name} uses unknown policy "${t.policy}"`,
          'use public, registered, admin, or define it in policies.yaml',
        );
      if (t.subject !== undefined && !(t.subject in t.input.shape))
        throw fail(
          `tool ${name} has subject "${t.subject}" but its input has no such field`,
          `add ${t.subject} to input or drop subject`,
        );
      if (tools.some(x => x.name === name)) throw fail(`tool ${name} is defined twice`, 'rename one');
      tools.push({ context: m.name, name, tool: t });
    }
    for (const s of parts.subscribers ?? []) {
      const owner = s.event.split('.')[0] ?? '';
      if (!names.has(owner))
        throw fail(`subscribes to "${s.event}" but no context "${owner}" exists`, 'check the event name');
      const id = `${m.name}.${s.name}`;
      if (subscribers.some(x => x.id === id))
        throw fail(`subscriber "${s.name}" is defined twice`, 'give each subscriber a unique name');
      subscribers.push({ id, context: m.name, def: s });
    }
    for (const w of parts.workers ?? []) {
      if (workers.some(x => x.context === m.name && x.def.name === w.name))
        throw fail(`worker "${w.name}" is defined twice`, 'rename one');
      workers.push({ context: m.name, def: w });
    }
    if (parts.users) hooks.push({ context: m.name, hooks: parts.users });
    loaded.push({ manifest: m, folder, definition: c.definition, parts });
  }

  // 4. HTTP + MCP.
  const auth = createAuthenticator({ ...opts.config.auth, admin: (policies.get('admin') as Policy) ?? ADMIN_POLICY });
  const app = new Hono();
  const httpDeps = { auth, policies, log };
  mountRoutes(app, routes, httpDeps);
  mountMcp(app, tools, httpDeps);
  app.get('/health', c => c.json({ status: 'ok' }));
  app.notFound(c => {
    const requestId = requestIdOf(c.req.raw);
    const started = performance.now();
    const err = new Problem({
      kind: 'not_found',
      id: 'route_not_found',
      title: 'Route Not Found',
      detail: `${c.req.method} ${new URL(c.req.url).pathname} is not a route`,
    });
    const res = problemResponse(err, requestId, new URL(c.req.url).pathname);
    logRequest(log, {
      context: 'kernel',
      route: `${c.req.method} (unmatched)`,
      principal: ANONYMOUS,
      requestId,
      status: 404,
      started,
      err,
    });
    return res;
  });

  // 5. Workers.
  const timers: ReturnType<typeof setInterval>[] = [];
  const busy = new Set<string>();
  const startWorkers = () => {
    dispatcher.start();
    for (const w of workers) {
      const key = `${w.context}.${w.def.name}`;
      const wlog = log.child({ context: w.context, worker: w.def.name });
      timers.push(
        setInterval(() => {
          if (busy.has(key)) return;
          busy.add(key);
          const tick = () => w.def.tick(clock.now());
          (w.def.tx === false ? tick() : uow.run(tick))
            .catch(e => wlog.error('worker tick failed', { error: String((e as Error)?.message ?? e) }))
            .finally(() => busy.delete(key));
        }, w.def.everyMs),
      );
    }
  };

  const migrationSets: MigrationSet[] = [
    { schema: 'kernel', dir: join(import.meta.dir, 'migrations') },
    ...loaded.map(c => ({
      schema: c.manifest.name,
      dir: c.definition.migrations ? join(root, c.folder, c.definition.migrations) : undefined,
    })),
  ];

  return {
    app,
    fetch: async req => app.fetch(req),
    contexts: loaded,
    routes,
    tools,
    workers,
    policies,
    contract: id => built.get(id),
    pool,
    uow,
    dispatcher,
    log,
    migrate: () => runMigrations(pool, migrationSets, kernelLog),
    startWorkers,
    async close() {
      for (const t of timers) clearInterval(t);
      await dispatcher.stop();
      unguard();
      await pool.close({ timeout: 5 });
    },
  };
}
