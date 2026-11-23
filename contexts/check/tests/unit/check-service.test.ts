import { describe, expect, it } from 'bun:test';
import { Owner, Problem } from '@lazytax/kernel';
import { fixture, version } from './fakes';

// 2026-03-02 is a Monday. 10:00 in Singapore = 02:00Z.
const MON_10_SG = '2026-03-02T02:00:00Z';

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
};

describe('CheckService.openUpcoming', () => {
  it("should open today's and tomorrow's checks of scheduled habits", async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    f.habits.push(version({ daysOfWeek: ['Monday', 'Tuesday', 'Wednesday'] }));
    f.zones.set('user-a', 'Asia/Singapore');
    // Act
    const n = await f.service.openUpcoming(f.clock.now());
    // Assert
    expect(n).toBe(2);
    expect(f.store.checks.map(c => c.localDate).sort()).toEqual(['2026-03-02', '2026-03-03']);
  });

  it('should not open a day whose deadline already passed', async () => {
    // Arrange: deadline 08:00, it is 10:00
    const f = fixture(MON_10_SG);
    f.habits.push(version({ daysOfWeek: ['Monday'], deadlineTime: '08:00:00' }));
    // Act
    const n = await f.service.openUpcoming(f.clock.now());
    // Assert
    expect(n).toBe(0);
  });
});

describe('CheckService.report', () => {
  it('should settle the open check as done and emit check.settled with the stake', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    // Act
    const e = await f.service.report('user-a', h.habitId, {
      proofKey: 'nfc',
      externalId: 'tap-1',
      verdict: 'passed',
      occurredAt: MON_10_SG,
    });
    // Assert
    expect(e?.status).toBe('done');
    expect(e?.date).toBe('2026-03-02');
    expect(f.store.checks[0]?.status).toBe('done');
    expect(f.uow.locks).toContain('user-a');
    const ev = f.outbox.events[0];
    expect(ev?.type).toBe('check.settled');
    expect(ev?.payload).toMatchObject({ status: 'done', stakeCents: 1000, ratioBps: 10000, maxStreak: 1 });
  });

  it('should change nothing on a replayed evidence', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    const ev = { proofKey: 'nfc', externalId: 'tap-1', verdict: 'passed' as const, occurredAt: MON_10_SG };
    await f.service.report('user-a', h.habitId, ev);
    // Act
    const again = await f.service.report('user-a', h.habitId, ev);
    // Assert
    expect(again).toBeNull();
    expect(f.store.executions).toHaveLength(1);
    expect(f.outbox.events).toHaveLength(1);
  });

  it('should ignore evidence that comes in after deadline + grace', async () => {
    // Arrange: the check opened Monday; it is now Tuesday 01:00 SG (deadline Monday 24:00 + 30 min)
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    await f.service.openUpcoming(f.clock.now());
    f.clock.at = new Date('2026-03-02T17:00:00Z');
    // Act
    const e = await f.service.report('user-a', h.habitId, {
      proofKey: 'nfc',
      externalId: 'late',
      verdict: 'passed',
      occurredAt: MON_10_SG,
    });
    // Assert
    expect(e).toBeNull();
  });

  it("should 404 on another user's habit", async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version({ userId: 'user-a' });
    f.habits.push(h);
    // Act
    const err = await rejects(
      f.service.report('user-b', h.habitId, {
        proofKey: 'nfc',
        externalId: 'x',
        verdict: 'passed',
        occurredAt: MON_10_SG,
      }),
    );
    // Assert
    expect((err as Problem).status).toBe(404);
    expect(f.store.checks).toHaveLength(0);
  });
});

describe('CheckService.skip', () => {
  it("should 404 user B skipping user A's habit version, and change nothing", async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version({ userId: 'user-a' });
    f.habits.push(h);
    f.zones.set('user-a', 'Asia/Singapore');
    f.zones.set('user-b', 'Asia/Singapore');
    await f.service.openUpcoming(f.clock.now());
    const before = JSON.stringify([f.store.checks, f.store.executions]);
    // Act
    const err = await rejects(f.service.skip(Owner.user('user-b'), h.id, null));
    // Assert
    expect(err).toBeInstanceOf(Problem);
    expect((err as Problem).status).toBe(404);
    expect(JSON.stringify([f.store.checks, f.store.executions])).toBe(before);
  });

  it('should refuse a skip past the month quota, under the lock', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    f.skipLimit.value = 1;
    const a = version();
    const b = version();
    f.habits.push(a, b);
    f.zones.set('user-a', 'Asia/Singapore');
    await f.service.skip(Owner.user('user-a'), a.id, 'tired');
    // Act
    const err = await rejects(f.service.skip(Owner.user('user-a'), b.id, null));
    // Assert
    expect((err as Problem).id).toBe('tier_insufficient');
    expect(f.store.executions.filter(e => e.status === 'skipped')).toHaveLength(1);
    expect(f.store.checks.find(c => c.habitId === b.habitId)?.status).toBe('pending');
  });
});

describe('CheckService.closeDue', () => {
  const overdue = async (setup: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    setup(f);
    await f.service.openUpcoming(f.clock.now());
    f.clock.at = new Date('2026-03-02T16:31:00Z'); // Monday's deadline + 31 min
    const n = await f.service.closeDue(f.clock.now());
    return { f, h, n };
  };

  it('should settle a missed day as vacation when the user is away', async () => {
    // Act
    const { f, n } = await overdue(f => f.away.add('user-a:2026-03-02'));
    // Assert
    expect(n).toBe(1);
    expect(f.store.executions[0]?.status).toBe('vacation');
    expect(f.store.checks.find(c => c.localDate === '2026-03-02')?.settledBy).toBe('vacation');
  });

  it('should spend a freeze before marking missed', async () => {
    // Act
    const { f } = await overdue(f => f.freezes.set('user-a', 1));
    // Assert
    expect(f.store.executions[0]?.status).toBe('frozen');
    expect(f.freezes.get('user-a')).toBe(0);
  });

  it('should mark the day missed and emit the stake for penalty', async () => {
    // Act
    const { f } = await overdue(() => {});
    // Assert
    expect(f.store.executions[0]?.status).toBe('missed');
    expect(f.outbox.events[0]?.payload).toMatchObject({ status: 'missed', stakeCents: 1000 });
  });

  it('should drop pending checks of a habit that was disabled', async () => {
    // Act
    const { f, n } = await overdue(() => {});
    const g = fixture(MON_10_SG);
    const h = version();
    g.habits.push(h);
    await g.service.openUpcoming(g.clock.now());
    h.enabled = false;
    g.clock.at = new Date('2026-03-02T16:31:00Z');
    const closed = await g.service.closeDue(g.clock.now());
    // Assert
    expect(n).toBe(1);
    expect(f.store.executions).toHaveLength(1);
    expect(closed).toBe(0);
    expect(g.store.checks.filter(c => c.localDate === '2026-03-02')).toHaveLength(0);
  });
});

describe('CheckService.retimePending', () => {
  it('should never shorten a started check on a habit edit', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    await f.service.openUpcoming(f.clock.now());
    const today = f.store.checks.find(c => c.localDate === '2026-03-02');
    const tomorrow = f.store.checks.find(c => c.localDate === '2026-03-03');
    const before = today?.deadline.getTime();
    h.deadlineTime = '20:00:00';
    // Act
    await f.service.retimePending('user-a', [h.habitId]);
    // Assert: today's (started) keeps its deadline; tomorrow's (not started) takes 20:00 SG
    expect(today?.deadline.getTime()).toBe(before as number);
    expect(tomorrow?.deadline.toISOString()).toBe('2026-03-03T12:01:00.000Z');
  });

  it('should remove pending checks of days no longer scheduled', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    await f.service.openUpcoming(f.clock.now());
    h.daysOfWeek = ['Monday'];
    // Act
    await f.service.retimePending('user-a', [h.habitId]);
    // Assert
    expect(f.store.checks.map(c => c.localDate)).toEqual(['2026-03-02']);
  });
});

describe('CheckService proof hooks', () => {
  it('should let a revoked external id prove again, keeping the proven day done', async () => {
    // Arrange
    const f = fixture(MON_10_SG);
    const h = version();
    f.habits.push(h);
    await f.service.report('user-a', h.habitId, {
      proofKey: 'nfc',
      externalId: 't',
      verdict: 'passed',
      occurredAt: MON_10_SG,
    });
    // Act
    const n = await f.service.evidenceRevoked('user-a', 'nfc', null);
    // Assert
    expect(n).toBe(1);
    expect(f.store.evidence).toHaveLength(0);
    expect(f.store.executions[0]?.status).toBe('done');
    const found = await f.service.executionForDate(Owner.user('user-a'), h.habitId, '2026-03-02');
    expect(found?.status).toBe('done');
    expect(await f.service.executionForDate(Owner.user('user-b'), h.habitId, '2026-03-02')).toBeNull();
  });
});
