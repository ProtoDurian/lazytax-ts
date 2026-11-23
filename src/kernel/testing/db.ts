// Fresh databases on the local test Postgres (tools/pg.ts, port LAZYTAX_PG_PORT, default 55430).
import { randomBytes } from 'node:crypto';

function adminUrl(): string {
  if (process.env.TEST_DATABASE_ADMIN_URL) return process.env.TEST_DATABASE_ADMIN_URL;
  const port = process.env.LAZYTAX_PG_PORT ?? '55430';
  return `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const admin = new Bun.SQL(adminUrl(), { max: 1 });
  const name = `t_${randomBytes(6).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }
  const url = adminUrl().replace(/\/[^/]*$/, `/${name}`);
  return {
    url,
    drop: async () => {
      const a = new Bun.SQL(adminUrl(), { max: 1 });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}
