import { describe, expect, it } from 'bun:test';
import type { CharityV1 } from '@lazytax/charity-contract/v1';
import type { HabitVersionDto } from '@lazytax/habit-contract/v1';
import { type Outbox, Owner, Problem, type UnitOfWork } from '@lazytax/kernel';
import type { PlanV1, QuotaDto } from '@lazytax/plan-contract/v1';
import type { HabitRepository } from '../../src/data/habit-repository';
import { HabitService } from '../../src/domain/habit-service';
import type { HabitRow, VersionInput } from '../../src/domain/model';

const CHARITY = '11111111-1111-4111-8111-111111111111';
const input: VersionInput = {
  task: 'Run',
  daysOfWeek: ['Monday'],
  notificationTime: '07:00:00',
  deadlineTime: '23:59:00',
  stakeCents: 0,
  currency: 'USD',
  ratioBps: 10_000,
  charityId: null,
  timezone: 'Asia/Singapore',
};

function setup(opts: { limit?: number; used?: number; habit?: HabitRow | null; charities?: string[] } = {}) {
  const events: { type: string; payload: unknown; userId?: string }[] = [];
  const calls: string[] = [];
  const version = { id: 'v1', habitId: 'h1', userId: 'u1' } as HabitVersionDto;
  const repo = {
    countHabits: async () => opts.used ?? 0,
    create: async (_u: string, _i: VersionInput, routineId: string | null) =>
      routineId === 'missing' ? null : version,
    getHabit: async () =>
      opts.habit === undefined
        ? { id: 'h1', userId: 'u1', version: 1, enabled: true, routineId: null, sortOrder: 0 }
        : opts.habit,
    update: async () => version,
    delete: async () => true,
  } as unknown as HabitRepository;
  const plan = {
    quota: async (): Promise<QuotaDto> => ({ tier: 'free', key: 'ent.habits', limit: opts.limit ?? 5 }),
    ensureWithin: (q: QuotaDto, used: number) => {
      if (used >= q.limit) throw new Problem({ kind: 'validation', id: 'tier_insufficient', title: 't', detail: 'd' });
    },
  } as unknown as PlanV1;
  const charity = { exists: async (id: string) => (opts.charities ?? [CHARITY]).includes(id) } as unknown as CharityV1;
  const uow = {
    run: async <T>(fn: () => Promise<T>) => fn(),
    lockUser: async (u: string) => {
      calls.push(`lock:${u}`);
    },
  } as unknown as UnitOfWork;
  const outbox = {
    add: async (e: { type: string; payload: unknown; userId?: string }) => void events.push(e),
  } as unknown as Outbox;
  const svc = new HabitService(repo, plan, charity, uow, outbox, { now: () => new Date('2026-01-01T00:00:00Z') });
  return { svc, events, calls };
}

describe('HabitService.create', () => {
  it('should create under the user lock when under quota', async () => {
    const { svc, calls } = setup({ used: 1, limit: 2 });
    expect((await svc.create('u1', input, null)).id).toBe('v1');
    expect(calls).toEqual(['lock:u1']);
  });
  it('should refuse at the quota', async () => {
    const { svc } = setup({ used: 2, limit: 2 });
    await expect(svc.create('u1', input, null)).rejects.toMatchObject({ id: 'tier_insufficient' });
  });
  it('should 400 on an unknown charity', async () => {
    const { svc } = setup();
    const err = await svc
      .create('u1', { ...input, charityId: '22222222-2222-4222-8222-222222222222' }, null)
      .catch(e => e);
    expect(err).toBeInstanceOf(Problem);
    expect(err.status).toBe(400);
  });
  it('should 404 on a routine that is not the', async () => {
    const { svc } = setup();
    await expect(svc.create('u1', input, 'missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('HabitService.update', () => {
  it('should return null for a habit that is not the owner', async () => {
    const { svc, events } = setup({ habit: null });
    expect(await svc.update(Owner.user('u2'), 'h1', input, true)).toBeNull();
    expect(events).toEqual([]);
  });
  it('should emit habit.changed after an update', async () => {
    const { svc, events } = setup();
    await svc.update(Owner.user('u1'), 'h1', input, true);
    expect(events).toEqual([{ type: 'habit.changed', payload: { userId: 'u1', habitIds: ['h1'] }, userId: 'u1' }]);
  });
  it('should count against the quota only when switching a habit on', async () => {
    const off: HabitRow = { id: 'h1', userId: 'u1', version: 1, enabled: false, routineId: null, sortOrder: 0 };
    const full = setup({ habit: off, used: 2, limit: 2 });
    await expect(full.svc.update(Owner.user('u1'), 'h1', input, true)).rejects.toMatchObject({
      id: 'tier_insufficient',
    });
    // Staying off, or switching off, takes no place.
    expect(await full.svc.update(Owner.user('u1'), 'h1', input, false)).not.toBeNull();
  });
});

describe('HabitService.delete', () => {
  it('should emit changed and deleted', async () => {
    const { svc, events } = setup();
    expect(await svc.delete(Owner.user('u1'), 'h1')).toBe(true);
    expect(events.map(e => e.type)).toEqual(['habit.changed', 'habit.deleted']);
  });
  it('should return false for someone else', async () => {
    const { svc, events } = setup({ habit: null });
    expect(await svc.delete(Owner.user('u2'), 'h1')).toBe(false);
    expect(events).toEqual([]);
  });
});
