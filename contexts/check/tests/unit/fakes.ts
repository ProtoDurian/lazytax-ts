// In-memory fakes for the check service: the store, the unit of work, the outbox and the
// contracts it calls. No database.
import { randomUUID } from 'node:crypto';
import type { AccountV1 } from '@lazytax/account-contract/v1';
import type { HabitV1, HabitVersionDto } from '@lazytax/habit-contract/v1';
import type { Logger, Outbox, OutboxEventInput, Owner, UnitOfWork } from '@lazytax/kernel';
import { notFound, Problem } from '@lazytax/kernel';
import type { PlanV1, QuotaDto } from '@lazytax/plan-contract/v1';
import type { ProtectionV1 } from '@lazytax/protection-contract/v1';
import type { VacationV1 } from '@lazytax/vacation-contract/v1';
import { CheckService } from '../../src/domain/check-service';
import type {
  CheckRow,
  DayRecord,
  ExecutionRow,
  ExecutionSearch,
  HabitDebt,
  NewCheck,
  NewEvidence,
  NewExecution,
} from '../../src/domain/model';
import type { CheckStore } from '../../src/domain/store';

const mine = (owner: Owner, userId: string) => owner.kind === 'anyone' || owner.userId === userId;

interface Exec extends ExecutionRow {
  stakeCents: number;
  ratioBps: number;
  live: boolean;
}

class FakeStore implements CheckStore {
  checks: CheckRow[] = [];
  executions: Exec[] = [];
  evidence: NewEvidence[] = [];

  async createPending(_owner: Owner, checks: NewCheck[]) {
    let n = 0;
    for (const c of checks) {
      if (this.checks.some(x => x.habitId === c.habitId && x.localDate === c.localDate)) continue;
      this.checks.push({
        id: randomUUID(),
        ...c,
        status: 'pending',
        settledAt: null,
        settledBy: null,
        executionId: null,
      });
      n++;
    }
    return n;
  }
  async listDuePending(owner: Owner, before: Date, limit: number) {
    return this.checks
      .filter(c => mine(owner, c.userId) && c.status === 'pending' && c.deadline <= before)
      .slice(0, limit);
  }
  async listPending(owner: Owner, habitIds: string[]) {
    return this.checks.filter(c => mine(owner, c.userId) && c.status === 'pending' && habitIds.includes(c.habitId));
  }
  async listForDate(owner: Owner, habitIds: string[], date: string) {
    return this.checks.filter(c => mine(owner, c.userId) && c.localDate === date && habitIds.includes(c.habitId));
  }
  async listCovering(owner: Owner, habitId: string, at: Date) {
    return this.checks.filter(
      c => mine(owner, c.userId) && c.habitId === habitId && c.opensAt <= at && c.deadline > at,
    );
  }
  async getForDay(owner: Owner, habitId: string, date: string) {
    return this.checks.find(c => mine(owner, c.userId) && c.habitId === habitId && c.localDate === date) ?? null;
  }
  async updatePendingWindow(owner: Owner, id: string, timezone: string, opensAt: Date, deadline: Date) {
    const c = this.checks.find(x => x.id === id && x.status === 'pending' && mine(owner, x.userId));
    if (!c) return false;
    Object.assign(c, { timezone, opensAt, deadline });
    return true;
  }
  async deletePending(owner: Owner, ids: string[]) {
    const before = this.checks.length;
    this.checks = this.checks.filter(c => !(ids.includes(c.id) && c.status === 'pending' && mine(owner, c.userId)));
    return before - this.checks.length;
  }
  async lockForSettle(owner: Owner, id: string) {
    const c = this.checks.find(x => x.id === id && mine(owner, x.userId));
    return c ? { ...c } : null;
  }
  async listRecorded(owner: Owner, checkIds: string[]) {
    return new Set(
      this.checks
        .filter(c => checkIds.includes(c.id) && mine(owner, c.userId))
        .filter(c => this.executions.some(e => e.habitId === c.habitId && e.date === c.localDate))
        .map(c => c.id),
    );
  }
  async evidenceExists(owner: Owner, habitId: string, proofKey: string, externalId: string) {
    return this.evidence.some(
      v => mine(owner, v.userId) && v.habitId === habitId && v.proofKey === proofKey && v.externalId === externalId,
    );
  }
  async countSkips(owner: Owner, from: string, to: string) {
    return this.executions.filter(
      e => mine(owner, e.userId) && e.status === 'skipped' && e.date >= from && e.date <= to,
    ).length;
  }
  async insertExecution(_owner: Owner, x: NewExecution) {
    if (this.executions.some(e => e.habitId === x.habitId && e.date === x.date)) return null;
    const row: Exec = { id: randomUUID(), ...x, paymentProcessed: false, live: true };
    this.executions.push(row);
    return row;
  }
  async markSettled(
    _owner: Owner,
    id: string,
    s: { status: string; settledAt: Date; settledBy: string; executionId: string },
  ) {
    const c = this.checks.find(x => x.id === id);
    if (c) Object.assign(c, { ...s, status: s.status as CheckRow['status'] });
  }
  async insertEvidence(_owner: Owner, v: NewEvidence) {
    this.evidence.push(v);
  }
  private group(rows: Exec[]) {
    const out = new Map<string, DayRecord[]>();
    for (const e of [...rows].sort((a, b) => a.date.localeCompare(b.date)))
      out.set(e.habitId, [...(out.get(e.habitId) ?? []), { date: e.date, status: e.status }]);
    return out;
  }
  async daysForHabits(owner: Owner, habitIds: string[]) {
    return this.group(this.executions.filter(e => mine(owner, e.userId) && habitIds.includes(e.habitId)));
  }
  async daysForLiveHabits(owner: Owner) {
    return this.group(this.executions.filter(e => mine(owner, e.userId) && e.live));
  }
  async searchExecutions(owner: Owner, q: ExecutionSearch) {
    return this.executions
      .filter(e => mine(owner, e.userId) && e.live)
      .filter(e => (q.habitId ? e.habitId === q.habitId : true) && (q.date ? e.date === q.date : true))
      .slice(q.skip, q.skip + q.limit);
  }
  async getExecution(owner: Owner, id: string) {
    return this.executions.find(e => e.id === id && mine(owner, e.userId)) ?? null;
  }
  async executionForDate(owner: Owner, habitId: string, date: string) {
    return this.executions.find(e => mine(owner, e.userId) && e.habitId === habitId && e.date === date) ?? null;
  }
  async deleteEvidence(owner: Owner, proofKey: string, externalId: string | null) {
    const before = this.evidence.length;
    this.evidence = this.evidence.filter(
      v => !(mine(owner, v.userId) && v.proofKey === proofKey && (externalId === null || v.externalId === externalId)),
    );
    return before - this.evidence.length;
  }
  async openDebts(owner: Owner): Promise<HabitDebt[]> {
    const by = new Map<string, number>();
    for (const e of this.executions)
      if (mine(owner, e.userId) && e.status === 'missed' && !e.paymentProcessed)
        by.set(e.habitId, (by.get(e.habitId) ?? 0) + Math.trunc((e.stakeCents * e.ratioBps) / 10000));
    return [...by].map(([habitId, cents]) => ({ habitId, cents }));
  }
  async markHabitsDeleted(owner: Owner, habitIds: string[]) {
    this.checks = this.checks.filter(
      c => !(c.status === 'pending' && habitIds.includes(c.habitId) && mine(owner, c.userId)),
    );
    for (const e of this.executions) if (habitIds.includes(e.habitId) && mine(owner, e.userId)) e.live = false;
  }
  async purgeUser(userId: string) {
    this.checks = this.checks.filter(c => c.userId !== userId);
    this.executions = this.executions.filter(e => e.userId !== userId);
    this.evidence = this.evidence.filter(v => v.userId !== userId);
  }
}

const fakeUow = (): UnitOfWork & { locks: string[] } => {
  const locks: string[] = [];
  let depth = 0;
  return {
    locks,
    async run<T>(fn: () => Promise<T>) {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
      }
    },
    db: () => {
      throw new Error('no database in unit tests');
    },
    async lockUser(userId: string) {
      if (depth === 0) throw new Error('lockUser outside a unit');
      locks.push(userId);
    },
    inUnit: () => depth > 0,
    afterCommit: fn => fn(),
  };
};

const fakeOutbox = (): Outbox & { events: OutboxEventInput[] } => {
  const events: OutboxEventInput[] = [];
  return {
    events,
    async add(e) {
      events.push(e as OutboxEventInput);
    },
  };
};

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
} as unknown as Logger;

export interface Fixture {
  service: CheckService;
  store: FakeStore;
  outbox: ReturnType<typeof fakeOutbox>;
  uow: ReturnType<typeof fakeUow>;
  clock: { at: Date; now(): Date };
  habits: HabitVersionDto[];
  zones: Map<string, string>;
  away: Set<string>;
  freezes: Map<string, number>;
  skipLimit: { value: number };
}

export const version = (over: Partial<HabitVersionDto> = {}): HabitVersionDto => ({
  id: randomUUID(),
  habitId: randomUUID(),
  userId: 'user-a',
  version: 1,
  enabled: true,
  routineId: null,
  task: 'Run',
  daysOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  notificationTime: '07:00:00',
  deadlineTime: '23:59:00',
  stakeCents: 1000,
  currency: 'SGD',
  ratioBps: 10000,
  charityId: randomUUID(),
  timezone: 'Asia/Singapore',
  ...over,
});

export function fixture(now: string): Fixture {
  const store = new FakeStore();
  const outbox = fakeOutbox();
  const uow = fakeUow();
  const clock = {
    at: new Date(now),
    now() {
      return new Date(this.at);
    },
  };
  const habits: HabitVersionDto[] = [];
  const zones = new Map<string, string>();
  const away = new Set<string>();
  const freezes = new Map<string, number>();
  const skipLimit = { value: 3 };

  const live = (h: HabitVersionDto) => h.enabled;
  const habit = {
    listSchedulable: async (userIds?: string[], habitIds?: string[]) =>
      habits.filter(
        h => live(h) && (!userIds || userIds.includes(h.userId)) && (!habitIds || habitIds.includes(h.habitId)),
      ),
    getVersion: async (owner: Owner, id: string) =>
      habits.find(h => h.id === id && (owner.kind === 'anyone' || owner.userId === h.userId)) ?? null,
  } as unknown as HabitV1;
  const account = {
    getTimezone: async (userId: string) => {
      const z = zones.get(userId);
      if (!z) throw notFound('Configuration', userId);
      return z;
    },
    today: async (userId: string) => {
      const z = zones.get(userId);
      if (!z) throw notFound('Configuration', userId);
      return new Intl.DateTimeFormat('en-CA', { timeZone: z }).format(clock.now());
    },
  } as unknown as AccountV1;
  const plan = {
    quota: async (_userId: string, key: string): Promise<QuotaDto> => ({
      tier: 'free',
      key: `ent.${key}`,
      limit: skipLimit.value,
    }),
    ensureWithin: (q: QuotaDto, used: number) => {
      if (used >= q.limit)
        throw new Problem({ kind: 'validation', id: 'tier_insufficient', title: 'Tier', detail: 'quota used' });
    },
  } as unknown as PlanV1;
  const vacation = { isAway: async (userId: string, date: string) => away.has(`${userId}:${date}`) } as VacationV1;
  const protection = {
    reconcileCap: async (userId: string) => ({ userId, balance: freezes.get(userId) ?? 0, cap: 5 }),
    tryConsumeFreeze: async (userId: string) => {
      const n = freezes.get(userId) ?? 0;
      if (n <= 0) return false;
      freezes.set(userId, n - 1);
      return true;
    },
  } as unknown as ProtectionV1;

  const service = new CheckService(store, { account, plan, habit, vacation, protection }, uow, outbox, clock, silent);
  return { service, store, outbox, uow, clock, habits, zones, away, freezes, skipLimit };
}
