// The black-box stack shared by `task sit` and the log-file test: Postgres, a fresh database,
// mock Logto and the real app process (bun src/index.ts <modes>). Nothing here is in-process;
// the app is a child process reached over HTTP, like in production.
//
//   const stack = await startStack({ logFile });   // ... talk to stack.baseUrl ...   await stack.stop();
//
// `stop` always runs the full teardown: kills the app, stops mock Logto, drops the database,
// removes our Postgres container. Callers put it in a finally block.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockLogto, testDatabase } from '@lazytax/kernel/testing';
import { pgDown, pgUp } from './pg';

const ROOT = resolve(import.meta.dir, '..');

export interface Stack {
  baseUrl: string;
  logtoUrl: string;
  // Tokens and subs every collection receives (see docs/sit.md).
  vars: Record<string, string>;
  // Users A, B and C (subs and tokens, plus tokenExpired) of one collection only, so a
  // collection that configures or completes for its users never collides with another.
  usersFor(collection: string): Promise<Record<string, string>>;
  // Mint a token for any sub and scopes through mock Logto's POST /token.
  mint(sub: string, scopes?: string[]): Promise<string>;
  // The app's stdout+stderr file, for diagnosing a failed start.
  appOutput: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  // Modes passed to src/index.ts. `worker` is needed for ticks and the outbox.
  modes?: string[];
  // Sets LOG_FILE for the app.
  logFile?: string;
  // Extra env for the app (e.g. LAZYTAX_PLAN_CONFIG).
  env?: Record<string, string>;
  healthPath?: string;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = s.port;
  await s.stop(true);
  if (port === undefined) throw new Error('could not find a free port');
  return port;
}

async function waitHttp(url: string, alive: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error('the app process exited before it answered');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`${url} did not answer in ${ms / 1000} s`);
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const cleanups: Array<() => Promise<void>> = [];
  const stop = async () => {
    for (const c of cleanups.reverse()) await c().catch(e => console.error('teardown step failed:', e));
    cleanups.length = 0;
  };
  try {
    // Reuse a running Postgres (another run may share it); remove it afterwards only if we started it.
    const wasUp =
      (await Bun.spawn(['bun', join(ROOT, 'tools', 'pg.ts'), 'url'], { stdout: 'ignore', stderr: 'ignore' }).exited) ===
      0;
    await pgUp();
    if (!wasUp && process.env.SIT_KEEP_PG !== '1') cleanups.push(pgDown);
    const db = await testDatabase();
    cleanups.push(db.drop);
    const logto = await startMockLogto();
    cleanups.push(logto.stop);

    const mint = async (sub: string, scopes: string[] = []) => {
      const res = await fetch(`${logto.url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub, scope: scopes.join(' ') }),
      });
      if (!res.ok) throw new Error(`mock Logto /token answered ${res.status}`);
      return ((await res.json()) as { access_token: string }).access_token;
    };

    const tmp = mkdtempSync(join(tmpdir(), 'lazytax-sit-'));
    cleanups.push(async () => rmSync(tmp, { recursive: true, force: true }));
    const appOutput = join(tmp, 'app.out');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATABASE_URL: db.url,
      AUTH_ISSUER: logto.issuer,
      AUTH_JWKS_URL: logto.jwksUrl,
      AUTH_AUDIENCE: logto.audience,
      ...(opts.logFile ? { LOG_FILE: opts.logFile } : {}),
      ...opts.env,
    };
    mkdirSync(tmp, { recursive: true });
    const modes = opts.modes ?? ['migrate', 'api', 'worker'];
    // SIT_APP_CMD swaps the app for a stand-in (used to test this harness on its own).
    const cmd = process.env.SIT_APP_CMD ? process.env.SIT_APP_CMD.split(' ') : ['bun', 'src/index.ts', ...modes];
    const app = Bun.spawn(cmd, {
      cwd: ROOT,
      env,
      stdout: Bun.file(appOutput),
      stderr: Bun.file(appOutput),
    });
    cleanups.push(async () => {
      app.kill('SIGTERM');
      const done = await Promise.race([app.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!done) app.kill('SIGKILL');
    });
    let exited = false;
    void app.exited.then(() => {
      exited = true;
    });
    try {
      await waitHttp(`${baseUrl}${opts.healthPath ?? '/health'}`, () => !exited, 60_000);
    } catch (e) {
      const out = await Bun.file(appOutput)
        .text()
        .catch(() => '');
      throw new Error(`${(e as Error).message}\n--- app output ---\n${out.slice(-4000)}`);
    }

    const subA = 'sit-user-a';
    const subB = 'sit-user-b';
    const subC = 'sit-user-c';
    const subAdmin = 'sit-admin';
    const vars: Record<string, string> = {
      baseUrl,
      logtoUrl: logto.url,
      subA,
      subB,
      subC,
      subAdmin,
      tokenA: await mint(subA),
      tokenB: await mint(subB),
      tokenC: await mint(subC),
      tokenAdmin: await mint(subAdmin, ['admin']),
      tokenExpired: await logto.mint(subA, { expiresInSec: -60 }),
    };
    const usersFor = async (collection: string) => {
      const slug = collection
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const [a, b, c] = ['a', 'b', 'c'].map(x => `sit-${slug}-${x}`) as [string, string, string];
      return {
        subA: a,
        subB: b,
        subC: c,
        tokenA: await mint(a),
        tokenB: await mint(b),
        tokenC: await mint(c),
        tokenExpired: await logto.mint(a, { expiresInSec: -60 }),
      };
    };
    return { baseUrl, logtoUrl: logto.url, vars, usersFor, mint, appOutput, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
