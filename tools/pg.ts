// Local Postgres for integration tests and SIT, in Docker.
//
//   bun tools/pg.ts up     start (or reuse) this checkout's container, print its URL
//   bun tools/pg.ts url    print the URL of the running container (exit 1 if none)
//   bun tools/pg.ts down   remove this checkout's container
//
// Every container carries the label lazytax-model=1 plus a label naming this checkout, so
// `down` removes only ours, never another builder's. Never prune Docker.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const IMAGE = 'postgres:17.6';
const ROOT = resolve(import.meta.dir, '..');
const PORT = process.env.LAZYTAX_PG_PORT ?? '55430';
const KEY = createHash('sha256').update(`${ROOT}:${PORT}`).digest('hex').slice(0, 10);
const NAME = `lazytax-pg-${KEY}`;

async function docker(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

async function runningPort(): Promise<string | null> {
  const r = await docker('port', NAME, '5432/tcp');
  if (r.code !== 0 || r.out === '') return null;
  const first = r.out.split('\n')[0] ?? '';
  return first.split(':').pop() ?? null;
}

const urlFor = (port: string) => `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const sql = new Bun.SQL(url, { max: 1, connectionTimeout: 2 });
    try {
      await sql`SELECT 1`;
      await sql.close();
      return;
    } catch {
      await sql.close().catch(() => undefined);
      await Bun.sleep(300);
    }
  }
  throw new Error(`Postgres in container ${NAME} did not become ready in 60 s`);
}

export async function pgUp(): Promise<string> {
  let port = await runningPort();
  if (port === null) {
    await docker('rm', '-f', NAME);
    const r = await docker(
      'run',
      '-d',
      '--name',
      NAME,
      '--label',
      'lazytax-model=1',
      '--label',
      `lazytax-model.checkout=${KEY}`,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      `127.0.0.1:${PORT}:5432`,
      IMAGE,
      '-c',
      'max_connections=300',
      '-c',
      'fsync=off',
    );
    if (r.code !== 0) throw new Error(`docker run failed: ${r.err}`);
    port = await runningPort();
    if (port === null) throw new Error(`container ${NAME} started without a port`);
  }
  const url = urlFor(port);
  await waitReady(url);
  return url;
}

export async function pgDown(): Promise<void> {
  const ids = await docker(
    'ps',
    '-aq',
    '--filter',
    'label=lazytax-model=1',
    '--filter',
    `label=lazytax-model.checkout=${KEY}`,
  );
  for (const id of ids.out.split('\n').filter(Boolean)) await docker('rm', '-f', id);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'up') console.log(await pgUp());
  else if (cmd === 'down') await pgDown();
  else if (cmd === 'url') {
    const port = await runningPort();
    if (port === null) process.exit(1);
    console.log(urlFor(port));
  } else {
    console.error('usage: bun tools/pg.ts up|url|down');
    process.exit(2);
  }
}
