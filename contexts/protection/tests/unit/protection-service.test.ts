import { expect, it } from 'bun:test';
import type { Outbox, OutboxEventInput, Owner, UnitOfWork } from '@lazytax/kernel';
import type { ProtectionRepository } from '../../src/data/protection-repository';
import type { SettledDayRow } from '../../src/domain/model';
import { ProtectionService } from '../../src/domain/protection-service';

// In-memory repository: just enough state to prove the domain rules, no database.
class FakeRepo {
  freeze = new Map<string, number>();
  maxStreak = new Map<string, number>();
  consumed = new Set<string>();
  awards = new Set<string>();
  days: (SettledDayRow & { userId: string })[] = [];
  async upsert(owner: Owner) {
    const u = (owner as { userId: string }).userId;
    if (!this.freeze.has(u)) this.freeze.set(u, 0);
    return { userId: u, freezeCurrent: this.freeze.get(u) ?? 0, maxStreak: this.maxStreak.get(u) ?? 0 };
  }
  async setMaxStreak(owner: Owner, n: number) {
    this.maxStreak.set((owner as { userId: string }).userId, n);
  }
  async clampToCap(owner: Owner, cap: number) {
    const u = (owner as { userId: string }).userId;
    const v = Math.min(this.freeze.get(u) ?? 0, cap);
    this.freeze.set(u, v);
    return v;
  }
  async increment(owner: Owner, n: number) {
    const u = (owner as { userId: string }).userId;
    this.freeze.set(u, (this.freeze.get(u) ?? 0) + n);
  }
  async tryConsume(owner: Owner, date: string) {
    const u = (owner as { userId: string }).userId;
    if (this.consumed.has(`${u}|${date}`)) return true;
    if ((this.freeze.get(u) ?? 0) <= 0) return false;
    this.freeze.set(u, (this.freeze.get(u) ?? 0) - 1);
    this.consumed.add(`${u}|${date}`);
    return true;
  }
  async recordAwardIfAbsent(_o: Owner, habitId: string, weekStart: string) {
    const k = `${habitId}|${weekStart}`;
    if (this.awards.has(k)) return false;
    this.awards.add(k);
    return true;
  }
  async recordSettled(owner: Owner, d: { executionId: string; habitId: string; date: string; status: string }) {
    this.days.push({
      userId: (owner as { userId: string }).userId,
      habitId: d.habitId,
      date: d.date,
      status: d.status,
    });
  }
  async settledBetween(owner: Owner, from: string, to: string) {
    const u = (owner as { userId: string }).userId;
    return this.days.filter(d => d.userId === u && d.date >= from && d.date <= to);
  }
}

const uow: UnitOfWork = {
  run: fn => fn(),
  db: () => {
    throw new Error('no db in unit tests');
  },
  lockUser: async () => undefined,
  inUnit: () => true,
  afterCommit: fn => fn(),
};

function setup(opts: { cap?: number; today?: string } = {}) {
  const repo = new FakeRepo();
  const events: OutboxEventInput[] = [];
  const outbox: Outbox = { add: async e => void events.push(e) };
  const plan = { freezeCap: async () => opts.cap ?? 2 };
  const account = { today: async () => opts.today ?? '2026-11-22' };
  const log = { error: () => undefined };
  const svc = new ProtectionService(
    repo as unknown as ProtectionRepository,
    plan as never,
    account as never,
    uow,
    outbox,
    log as never,
  );
  return { repo, svc, events };
}

const settle = (repo: FakeRepo, habitId: string, date: string, status: string) =>
  repo.recordSettled({ kind: 'user', userId: 'u1' } as Owner, {
    executionId: `${habitId}${date}`,
    habitId,
    date,
    status,
  });

it('should award one freeze for a habit whose last week was all completed', async () => {
  const { repo, svc, events } = setup();
  for (const d of ['2026-11-16', '2026-11-18', '2026-11-20']) await settle(repo, 'h1', d, 'done');
  expect(await svc.awardWeeklyForUser('u1')).toBe(1);
  expect(repo.freeze.get('u1')).toBe(1);
  expect(events.map(e => e.type)).toEqual(['protection.awarded']);
});

it('should not award twice for the same habit and week', async () => {
  const { repo, svc } = setup();
  await settle(repo, 'h1', '2026-11-16', 'done');
  await svc.awardWeeklyForUser('u1');
  expect(await svc.awardWeeklyForUser('u1')).toBe(0);
  expect(repo.freeze.get('u1')).toBe(1);
});

it('should not award a habit that failed, froze or was skipped any day of the week', async () => {
  for (const bad of ['missed', 'frozen', 'vacation', 'skipped']) {
    const { repo, svc } = setup();
    await settle(repo, 'h1', '2026-11-16', 'done');
    await settle(repo, 'h1', '2026-11-17', bad);
    expect(await svc.awardWeeklyForUser('u1')).toBe(0);
  }
});

it('should award each perfect habit and skip the imperfect one', async () => {
  const { repo, svc } = setup({ cap: 5 });
  await settle(repo, 'h1', '2026-11-16', 'done');
  await settle(repo, 'h2', '2026-11-16', 'done');
  await settle(repo, 'h3', '2026-11-16', 'missed');
  expect(await svc.awardWeeklyForUser('u1')).toBe(3 - 1);
  expect(repo.freeze.get('u1')).toBe(2);
});

it('should cap the balance at the plan cap (a free tier with cap 0 earns nothing)', async () => {
  const { repo, svc } = setup({ cap: 0 });
  await settle(repo, 'h1', '2026-11-16', 'done');
  await svc.awardWeeklyForUser('u1');
  expect(repo.freeze.get('u1')).toBe(0);
});

it('should ignore days outside the last completed week', async () => {
  const { repo, svc } = setup();
  await settle(repo, 'h1', '2026-11-14', 'done'); // the week before
  await settle(repo, 'h1', '2026-11-22', 'done'); // today's week
  expect(await svc.awardWeeklyForUser('u1')).toBe(0);
});

it('should return 0 when the user has no configuration', async () => {
  const { svc } = setup();
  const { Problem } = await import('@lazytax/kernel');
  const repo = new FakeRepo();
  const notFound = new Problem({ kind: 'not_found', id: 'entity_not_found', title: 't', detail: 'd' });
  const s = new ProtectionService(
    repo as unknown as ProtectionRepository,
    { freezeCap: async () => 1 } as never,
    {
      today: async () => {
        throw notFound;
      },
    } as never,
    uow,
    { add: async () => undefined },
    { error: () => undefined } as never,
  );
  expect(await s.awardWeeklyForUser('u1')).toBe(0);
  expect(svc).toBeDefined();
});

it('should cut banked freezes to a lower cap and never restore them', async () => {
  const { repo, svc } = setup({ cap: 3 });
  repo.freeze.set('u1', 3);
  expect((await svc.reconcileCap('u1', 0)).balance).toBe(3);
  const lower = setup({ cap: 1 });
  lower.repo.freeze.set('u1', 3);
  expect(await lower.svc.reconcileCap('u1', 0)).toEqual({ userId: 'u1', balance: 1, cap: 1 });
});

it('should spend a freeze once per date and refuse at zero', async () => {
  const { repo, svc } = setup();
  repo.freeze.set('u1', 1);
  expect(await svc.tryConsumeFreeze('u1', '2026-11-20')).toBe(true);
  expect(await svc.tryConsumeFreeze('u1', '2026-11-20')).toBe(true); // same day: no second spend
  expect(repo.freeze.get('u1')).toBe(0);
  expect(await svc.tryConsumeFreeze('u1', '2026-11-21')).toBe(false);
});

it('should refuse a balance for Owner.anyone', () => {
  const { svc } = setup();
  expect(() => svc.balance({ kind: 'anyone', by: 'system' })).toThrow();
});
