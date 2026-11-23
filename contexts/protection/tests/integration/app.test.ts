// The whole app in-process on real Postgres: routes, policies, MCP, the contract, the outbox
// subscriber and the account-deletion purge.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { type Actor, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ now: '2026-11-22T10:00:00Z' });
});
afterAll(() => app.close());

const balanceOf = (actor: Actor | null, sub: string) =>
  app.request(actor, { method: 'GET', path: `/api/v1/Protection/${sub}` });

const awardWeekly = (actor: Actor | null, userId: string) =>
  app.request(actor, { method: 'POST', path: '/api/v1/Protection/award-weekly', body: { userId } });

it('should return a zero balance for a user who never earned a freeze', async () => {
  const a = await app.user();
  const res = await balanceOf(a, a.sub);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ userId: a.sub, balance: 0 });
});

it('should be 401 without a token or with an expired one, and 403 on another user path', async () => {
  const a = await app.user();
  const b = await app.user();
  await expectProblem(await balanceOf(null, a.sub), 401);
  const expired = { sub: a.sub, token: await app.token(a.sub, { expiresInSec: -60 }) };
  await expectProblem(await balanceOf(expired, a.sub), 401);
  await expectProblem(await balanceOf(b, a.sub), 403, 'unauthorized');
});

it('should be 404 on a protection route that does not exist', async () => {
  const a = await app.user();
  const res = await app.request(a, { method: 'GET', path: `/api/v1/Protection/${a.sub}/nope` });
  expect(res.status).toBe(404);
});

it('should let an admin read any balance but refuse award-weekly to a plain user', async () => {
  const a = await app.user();
  const admin = await app.admin();
  expect((await balanceOf(admin, a.sub)).status).toBe(200);
  await expectProblem(await awardWeekly(null, a.sub), 401);
  await expectProblem(await awardWeekly(a, a.sub), 403);
  const ok = await awardWeekly(admin, a.sub);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ userId: a.sub, awards: 0 });
});

it('should 400 an award-weekly body with no userId', async () => {
  const admin = await app.admin();
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/Protection/award-weekly', body: {} });
  await expectProblem(res, 400, 'validation_error');
});

// A freeze balance has no id in any path: it is always read by owner. So the owner-scoped test
// for this entity is "B's own read shows none of A's, and nothing of A's changes".
it("should show user B nothing of user A's freezes and leave A's row unchanged", async () => {
  const a = await app.user();
  const b = await app.user();
  await app.sql`INSERT INTO protection.user_protections (user_id, freeze_current) VALUES (${a.sub}, 1)`;
  const before = JSON.stringify(await app.sql`SELECT * FROM protection.user_protections WHERE user_id = ${a.sub}`);
  const res = await balanceOf(b, b.sub);
  expect(await res.json()).toMatchObject({ userId: b.sub, balance: 0 });
  const after = JSON.stringify(await app.sql`SELECT * FROM protection.user_protections WHERE user_id = ${a.sub}`);
  expect(after).toBe(before);
});

it('should cut a balance above the cap when it is read', async () => {
  const a = await app.user();
  await app.sql`INSERT INTO protection.user_protections (user_id, freeze_current) VALUES (${a.sub}, 99)`;
  const body = (await (await balanceOf(a, a.sub)).json()) as { balance: number; cap: number };
  expect(body.balance).toBeLessThanOrEqual(body.cap);
  expect(body.balance).toBeLessThan(99);
});

it('should serve the same balance through MCP, with the same policy', async () => {
  const a = await app.user();
  const b = await app.user();
  const admin = await app.admin();
  expect((await app.mcp(a, 'protection.balance', { userId: a.sub })).ok).toBe(true);
  expect((await app.mcp(b, 'protection.balance', { userId: a.sub })).ok).toBe(false);
  expect((await app.mcp(a, 'protection.awardWeekly', { userId: a.sub })).ok).toBe(false);
  const r = await app.mcp(admin, 'protection.awardWeekly', { userId: a.sub });
  expect(r.data).toEqual({ userId: a.sub, awards: 0 });
});

it('should spend a freeze once per date through the contract and refuse when empty', async () => {
  const a = await app.user();
  const protection = app.contract('protection.v1');
  await app.sql`INSERT INTO protection.user_protections (user_id, freeze_current) VALUES (${a.sub}, 1)`;
  expect(await protection.tryConsumeFreeze(a.sub, '2026-11-20')).toBe(true);
  expect(await protection.tryConsumeFreeze(a.sub, '2026-11-20')).toBe(true);
  expect(await protection.tryConsumeFreeze(a.sub, '2026-11-21')).toBe(false);
});

it('should let two requests for the same user race for one freeze and only one wins', async () => {
  const a = await app.user();
  const protection = app.contract('protection.v1');
  await app.sql`INSERT INTO protection.user_protections (user_id, freeze_current) VALUES (${a.sub}, 1)`;
  const results = await Promise.all([
    protection.tryConsumeFreeze(a.sub, '2026-11-20'),
    protection.tryConsumeFreeze(a.sub, '2026-11-21'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('should record a settled day from check.settled delivered through the outbox', async () => {
  const a = await app.user();
  const payload = {
    userId: a.sub,
    habitId: `h-${a.sub}`,
    executionId: `e-${a.sub}`,
    date: '2026-11-16',
    status: 'done',
    stakeCents: 0,
    ratioBps: 0,
    currency: 'USD',
    charityId: null,
    maxStreak: 0,
    habitVersionId: 'v',
    checkId: `c-${a.sub}`,
    adopted: false,
  };
  // check is not built yet, so the test plays its part: the event and the delivery row for protection.
  const [event] =
    await app.sql`INSERT INTO kernel.outbox_events (type, payload, user_id) VALUES ('check.settled', ${JSON.stringify(payload)}::jsonb, ${a.sub}) RETURNING id`;
  await app.sql`INSERT INTO kernel.outbox_deliveries (event_id, subscriber) VALUES (${event.id}, 'protection.check.settled')`;
  await app.drainOutbox();
  expect(await app.sql`SELECT 1 FROM protection.settled_days WHERE user_id = ${a.sub}`).toHaveLength(1);
});

it('should leave 0 rows of a deleted user in every table and keep the other user', async () => {
  const a = await app.user();
  const b = await app.user();
  for (const u of [a, b]) {
    await app.sql`INSERT INTO protection.user_protections (user_id, freeze_current) VALUES (${u.sub}, 1)`;
    await app.sql`INSERT INTO protection.freeze_consumptions (user_id, date) VALUES (${u.sub}, '2026-11-20')`;
    await app.sql`INSERT INTO protection.freeze_awards (user_id, habit_id, week_start) VALUES (${u.sub}, ${`h-${u.sub}`}, '2026-11-15')`;
    await app.sql`INSERT INTO protection.settled_days (user_id, habit_id, execution_id, date, status) VALUES (${u.sub}, ${`h-${u.sub}`}, ${`e-${u.sub}`}, '2026-11-16', 'done')`;
  }
  const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
  expect(res.status).toBeLessThan(300);
  for (const t of ['user_protections', 'freeze_consumptions', 'freeze_awards', 'settled_days']) {
    expect(await app.sql.unsafe(`SELECT 1 FROM protection.${t} WHERE user_id = $1`, [a.sub])).toHaveLength(0);
    expect((await app.sql.unsafe(`SELECT 1 FROM protection.${t} WHERE user_id = $1`, [b.sub])).length).toBeGreaterThan(
      0,
    );
  }
});
