// The service and repository on real Postgres with the real unit of work, without the kernel
// boot: fake plan and account, the context's own migration applied to a fresh database.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Outbox, type OutboxEventInput, Owner, type UnitOfWork } from '@lazytax/kernel';
import { testDatabase } from '@lazytax/kernel/testing';
import { ProtectionRepository } from '../../src/data/protection-repository';
import { ProtectionService } from '../../src/domain/protection-service';
import { testUow } from './test-uow';

let db: { url: string; drop(): Promise<void> };
let pool: Bun.SQL;
let repo: ProtectionRepository;
let svc: ProtectionService;
let uow: UnitOfWork;
let cap = 3;
const today = '2026-11-22';
const events: OutboxEventInput[] = [];

beforeAll(async () => {
  db = await testDatabase();
  pool = new Bun.SQL(db.url, { max: 10 });
  await pool.unsafe('CREATE SCHEMA protection');
  await pool.unsafe(readFileSync(join(import.meta.dir, '../../src/data/migrations/0001_init.sql'), 'utf8'));
  uow = testUow(pool);
  const outbox: Outbox = { add: async e => void events.push(e) };
  repo = new ProtectionRepository(uow);
  svc = new ProtectionService(
    repo,
    { freezeCap: async () => cap } as never,
    { today: async () => today } as never,
    uow,
    outbox,
    { error: () => undefined } as never,
  );
});

afterAll(async () => {
  await pool.close();
  await db.drop();
});

const settled = (
  userId: string,
  habitId: string,
  date: string,
  status: 'done' | 'missed' | 'frozen' = 'done',
  executionId = `${userId}-${habitId}-${date}`,
) =>
  uow.run(() =>
    svc.onSettled({
      userId,
      habitId,
      executionId,
      date,
      status,
      stakeCents: 0,
      ratioBps: 0,
      currency: 'USD',
      charityId: null,
      maxStreak: 4,
      habitVersionId: 'v',
      checkId: `c-${executionId}`,
      adopted: false,
    }),
  );

const rows = async (table: string, userId: string) =>
  (await pool.unsafe(`SELECT * FROM protection.${table} WHERE user_id = $1`, [userId])) as unknown[];

it('should award from settled days and be idempotent on redelivery and a second run', async () => {
  const u = 'award-user';
  for (const d of ['2026-11-16', '2026-11-18']) await settled(u, 'ha', d);
  await settled(u, 'ha', '2026-11-18'); // the same event delivered twice
  await settled(u, 'hb', '2026-11-17', 'missed');
  expect(await svc.awardWeeklyForUser(u)).toBe(1);
  expect(await svc.awardWeeklyForUser(u)).toBe(0);
  expect((await svc.balance(Owner.user(u))).balance).toBe(1);
  expect(await rows('settled_days', u)).toHaveLength(3);
  expect(events.at(-1)).toMatchObject({ type: 'protection.awarded', userId: u });
});

it('should remember the max streak from check and use it for the cap on a read', async () => {
  const u = 'streak-user';
  await settled(u, 'h1', '2026-11-16');
  expect((await rows('user_protections', u))[0]).toMatchObject({ max_streak: 4 });
  await svc.reconcileCap(u, 80);
  expect((await rows('user_protections', u))[0]).toMatchObject({ max_streak: 80 });
});

it('should cut banked freezes to a lower cap and not restore them when the cap rises', async () => {
  const u = 'cut-user';
  cap = 3;
  await settled(u, 'h1', '2026-11-16');
  await pool.unsafe(`UPDATE protection.user_protections SET freeze_current = 3 WHERE user_id = $1`, [u]);
  cap = 1;
  expect(await svc.balance(Owner.user(u))).toEqual({ userId: u, balance: 1, cap: 1 });
  cap = 3;
  expect((await svc.balance(Owner.user(u))).balance).toBe(1);
});

it('should let only one of two concurrent freeze spends win a single freeze', async () => {
  const u = 'race-user';
  cap = 3;
  await settled(u, 'h1', '2026-11-16');
  await pool.unsafe(`UPDATE protection.user_protections SET freeze_current = 1 WHERE user_id = $1`, [u]);
  const results = await Promise.all([
    svc.tryConsumeFreeze(u, '2026-11-20'),
    svc.tryConsumeFreeze(u, '2026-11-21'),
    svc.tryConsumeFreeze(u, '2026-11-22'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await rows('user_protections', u))[0]).toMatchObject({ freeze_current: 0 });
  expect(await rows('freeze_consumptions', u)).toHaveLength(1);
});

it('should count one spend for the same date even when asked twice at once', async () => {
  const u = 'twice-user';
  await settled(u, 'h1', '2026-11-16');
  await pool.unsafe(`UPDATE protection.user_protections SET freeze_current = 2 WHERE user_id = $1`, [u]);
  const results = await Promise.all([svc.tryConsumeFreeze(u, '2026-11-20'), svc.tryConsumeFreeze(u, '2026-11-20')]);
  expect(results).toEqual([true, true]);
  expect((await rows('user_protections', u))[0]).toMatchObject({ freeze_current: 1 });
});

it("should not show or change user A's rows when user B reads, spends or reconciles", async () => {
  const a = 'owner-a';
  const b = 'owner-b';
  cap = 3;
  await settled(a, 'h1', '2026-11-16');
  await pool.unsafe(`UPDATE protection.user_protections SET freeze_current = 2 WHERE user_id = $1`, [a]);
  const before = JSON.stringify(await rows('user_protections', a));
  expect(await repo.get(Owner.user(b))).toBeNull(); // the owner-scoped read finds nothing of A's
  expect((await svc.balance(Owner.user(b))).balance).toBe(0);
  expect(await svc.tryConsumeFreeze(b, '2026-11-20')).toBe(false);
  await svc.reconcileCap(b, 200);
  expect(JSON.stringify(await rows('user_protections', a))).toBe(before);
  expect(await rows('freeze_consumptions', a)).toHaveLength(0);
});

it('should leave 0 rows of the deleted user in every table and keep the other user', async () => {
  const a = 'purge-a';
  const b = 'purge-b';
  for (const u of [a, b]) {
    await settled(u, `habit-of-${u}`, '2026-11-16');
    await pool.unsafe(`UPDATE protection.user_protections SET freeze_current = 2 WHERE user_id = $1`, [u]);
    await svc.tryConsumeFreeze(u, '2026-11-19');
    await svc.awardWeeklyForUser(u);
  }
  for (const t of ['user_protections', 'freeze_consumptions', 'freeze_awards', 'settled_days'])
    expect((await rows(t, a)).length).toBeGreaterThan(0);
  await uow.run(() => repo.purgeUser(a));
  for (const t of ['user_protections', 'freeze_consumptions', 'freeze_awards', 'settled_days']) {
    expect(await rows(t, a)).toHaveLength(0);
    expect((await rows(t, b)).length).toBeGreaterThan(0);
  }
});

it('should run the worker over users with recent settled days and prune old ones', async () => {
  const u = 'worker-user';
  await settled(u, 'h1', '2026-11-16');
  await settled(u, 'old', '2026-09-01');
  expect(await svc.awardAll(new Date('2026-11-22T10:00:00Z'))).toBe(1);
  expect((await rows('settled_days', u)).map(r => (r as { habit_id: string }).habit_id)).toEqual(['h1']);
});
