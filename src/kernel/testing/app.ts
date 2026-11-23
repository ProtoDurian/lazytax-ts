// The test app behind the TestApp surface: a fresh database, mock Logto, the kernel in-process.
import { randomUUID } from 'node:crypto';
import { generatedContexts } from '../../generated/contexts';
import { bootKernel } from '../boot';
import { loadKernelConfig } from '../config';
import type { ProblemJson } from '../errors';
import type { McpResult, TestApp, TestAppOptions } from './index';
import { startMockLogto } from './mock-logto';
import { createTestDatabase } from './db';

export async function startTestAppImpl(opts: TestAppOptions): Promise<TestApp> {
  const db = await createTestDatabase();
  const logto = await startMockLogto();
  let fixed: Date | undefined = opts.now === undefined ? undefined : new Date(opts.now);
  const clock = { now: () => (fixed ? new Date(fixed) : new Date()) };
  const logs: string[] = [];
  const base = loadKernelConfig({});
  const kernel = await bootKernel({
    config: {
      ...base,
      databaseUrl: db.url,
      auth: { jwksUrl: logto.jwksUrl, issuer: logto.issuer, audience: logto.audience },
      log: { level: 'debug' },
      outbox: { ...base.outbox, pollMs: 60_000 },
    },
    contexts: generatedContexts,
    only: opts.contexts,
    contextConfig: opts.config,
    env: {},
    clock,
    logSink: l => logs.push(l),
  });
  await kernel.migrate();

  const request: TestApp['request'] = async (actor, req) => {
    const url = new URL(`http://test.local${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (actor) headers.authorization = `Bearer ${actor.token}`;
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, req.headers ?? {});
    return kernel.fetch(
      new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      }),
    );
  };

  let rpc = 0;
  const mcp: TestApp['mcp'] = async (actor, tool, args) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (actor) headers.authorization = `Bearer ${actor.token}`;
    const res = await kernel.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpc,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      }),
    );
    const text = await res.text();
    if (res.status !== 200) return { ok: false, data: undefined, problem: JSON.parse(text) as ProblemJson };
    const body = JSON.parse(text) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
    if (!body.result) throw new Error(`MCP error: ${text}`);
    const out = JSON.parse(body.result.content?.[0]?.text ?? 'null');
    return (body.result.isError ? { ok: false, data: undefined, problem: out } : { ok: true, data: out }) as McpResult;
  };

  return {
    request,
    mcp,
    user: async (sub = `u_${randomUUID()}`) => ({ sub, token: await logto.mint(sub) }),
    registeredUser: async (o = {}) => {
      const sub = o.sub ?? `u_${randomUUID()}`;
      const username = o.username ?? `u${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const token = await logto.mint(sub, {
        claims: { username, email: o.email ?? `${username}@example.test`, email_verified: true },
      });
      const actor = { sub, token };
      const res = await request(actor, { method: 'POST', path: '/api/v1/User', body: {} });
      if (res.status !== 200)
        throw new Error(`registeredUser: POST /api/v1/User answered ${res.status}: ${await res.text()}`);
      if (o.timezone !== undefined) {
        const c = await request(actor, {
          method: 'POST',
          path: '/api/v1/Configuration',
          body: { timezone: o.timezone },
        });
        if (c.status !== 200)
          throw new Error(`registeredUser: POST /api/v1/Configuration answered ${c.status}: ${await c.text()}`);
      }
      return actor;
    },
    admin: async (sub = `admin_${randomUUID()}`) => ({ sub, token: await logto.mint(sub, { scopes: ['admin'] }) }),
    token: (sub, o) => logto.mint(sub, o),
    contract: ((id: string) => kernel.contract(id)) as TestApp['contract'],
    uow: kernel.uow,
    sql: kernel.pool,
    clock: {
      now: clock.now,
      set: at => {
        fixed = new Date(at);
      },
    },
    tick: async (name: string) => {
      const w = kernel.workers.find(x => x.def.name === name || `${x.context}.${x.def.name}` === name);
      if (!w)
        throw new Error(
          `tick: no worker "${name}"; have ${kernel.workers.map(x => `${x.context}.${x.def.name}`).join(', ') || 'none'}`,
        );
      const run = () => w.def.tick(clock.now());
      await (w.def.tx === false ? run() : kernel.uow.run(run));
    },
    drainOutbox: async () => {
      await kernel.dispatcher.drain();
    },
    logs,
    close: async () => {
      await kernel.close();
      await logto.stop();
      await db.drop();
    },
  };
}
