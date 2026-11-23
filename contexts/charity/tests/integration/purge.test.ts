import { afterAll, beforeAll, expect, it } from 'bun:test';
import { startTestApp, type TestApp } from '@lazytax/kernel/testing';

// Boots every context, because deleting a user is account's job and runs every context's hook.
let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

// The catalogue is global: no table in the charity schema has a user_id column, so a user's
// deletion has nothing to remove here and must not touch the catalogue.
it('should have no user_id column anywhere in the charity schema', async () => {
  const cols = await app.sql`
    SELECT table_name FROM information_schema.columns WHERE table_schema = 'charity' AND column_name = 'user_id'`;
  expect(cols).toHaveLength(0);
});

it('should leave the catalogue untouched when a user is deleted, and find 0 rows of theirs', async () => {
  const admin = await app.admin();
  const a = await app.user();
  await app.request(admin, { method: 'POST', path: '/api/v1/Charity', body: { name: 'Survivor' } });
  const before = await app.sql`SELECT count(*)::int AS n FROM charity.charities`;

  const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
  expect([200, 204]).toContain(res.status);

  const after = await app.sql`SELECT count(*)::int AS n FROM charity.charities`;
  expect(after[0]?.n).toBe(before[0]?.n);
  expect(await app.sql`SELECT 1 FROM charity.charities WHERE name = 'Survivor'`).toHaveLength(1);
});
