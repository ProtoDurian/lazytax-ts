// `bun run policies`: every HTTP route and MCP tool with its policy, subject and guards.
//
//   bun tools/policies.ts            print the table
//   bun tools/policies.ts --check    exit 1 unless every route and tool has a known policy
//   bun tools/policies.ts --json     print JSON rows
//   bun tools/policies.ts --only vacation,plan,account   only these contexts (while main is half-merged)
//
// It boots the kernel without listening and without touching the database: a route without a
// policy, or with an unknown one, fails the boot itself, with the context, folder and fix.
import { generatedContexts } from '../src/generated/contexts';
import { bootKernel } from '../src/kernel/boot';
import { loadKernelConfig } from '../src/kernel/config';
import { ContextError } from '../src/kernel/manifest';

export interface PolicyRow {
  context: string;
  method: string;
  path: string;
  policy: string;
  subject: string;
  guards: string;
}

export async function policyRows(only?: string[]): Promise<PolicyRow[]> {
  const kernel = await bootKernel({
    config: loadKernelConfig(),
    contexts: only ? generatedContexts.filter(g => only.some(n => g.folder === `contexts/${n}`)) : generatedContexts,
    only,
    checkGenerated: only === undefined,
    logSink: () => undefined,
  });
  try {
    const rows: PolicyRow[] = kernel.routes.map(r => ({
      context: r.context,
      method: r.method,
      path: r.path,
      policy: r.route.policy,
      subject: r.route.subject ?? '',
      guards: r.route.guards.map(g => g.name).join(', '),
    }));
    for (const t of kernel.tools)
      rows.push({
        context: t.context,
        method: 'MCP',
        path: t.name,
        policy: t.tool.policy,
        subject: t.tool.subject ?? '',
        guards: t.tool.guards.map(g => g.name).join(', '),
      });
    rows.push({ context: 'kernel', method: 'GET', path: '/health', policy: 'public', subject: '', guards: '' });
    rows.push({ context: 'kernel', method: 'POST', path: '/mcp', policy: 'per tool', subject: '', guards: '' });
    return rows;
  } finally {
    await kernel.close();
  }
}

function table(rows: PolicyRow[]): string {
  const cols = ['method', 'path', 'policy', 'subject', 'guards'] as const;
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => r[c].length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(width[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line([...cols]), line(width.map(w => '-'.repeat(w))), ...rows.map(r => line(cols.map(c => r[c])))].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const i = argv.indexOf('--only');
  const only = i >= 0 ? (argv[i + 1] ?? '').split(',').filter(Boolean) : undefined;
  try {
    const rows = await policyRows(only);
    const missing = rows.filter(r => r.policy === '');
    if (args.has('--json')) console.log(JSON.stringify(rows, null, 2));
    else if (!args.has('--check')) console.log(table(rows));
    if (missing.length > 0) {
      console.error(`policies: ${missing.length} route(s) without a policy`);
      process.exit(1);
    }
    if (args.has('--check')) {
      const routes = rows.filter(r => r.method !== 'MCP').length;
      console.log(`policies: ok, ${routes} routes and ${rows.length - routes} MCP tools, every one has a policy`);
    }
  } catch (e) {
    if (e instanceof ContextError) {
      console.error(`policies: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
