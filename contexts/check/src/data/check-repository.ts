// check's SQL. Every method takes the Owner first and filters on it in its first query (layer 4);
// only purgeUser takes a bare user id. The schema name is a reserved word, so it is quoted.
import type { CheckStatus, SettledStatus } from '@lazytax/check-contract/v1';
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type {
  CheckRow,
  DayRecord,
  ExecutionRow,
  ExecutionSearch,
  HabitDebt,
  NewCheck,
  NewEvidence,
  NewExecution,
} from '../domain/model';
import type { CheckStore } from '../domain/store';

interface CheckSql {
  id: string;
  user_id: string;
  habit_id: string;
  local_date: string;
  timezone: string;
  opens_at: Date;
  deadline: Date;
  status: CheckStatus;
  settled_at: Date | null;
  settled_by: string | null;
  execution_id: string | null;
}

interface ExecutionSql {
  id: string;
  user_id: string;
  habit_id: string;
  habit_version_id: string;
  date: string;
  status: SettledStatus;
  completed_at: Date | null;
  notes: string | null;
  payment_processed: boolean;
}

const toCheck = (r: CheckSql): CheckRow => ({
  id: r.id,
  userId: r.user_id,
  habitId: r.habit_id,
  localDate: r.local_date,
  timezone: r.timezone,
  opensAt: r.opens_at,
  deadline: r.deadline,
  status: r.status,
  settledAt: r.settled_at,
  settledBy: r.settled_by,
  executionId: r.execution_id,
});

const toExecution = (r: ExecutionSql): ExecutionRow => ({
  id: r.id,
  userId: r.user_id,
  habitId: r.habit_id,
  habitVersionId: r.habit_version_id,
  date: r.date,
  status: r.status,
  completedAt: r.completed_at,
  notes: r.notes,
  paymentProcessed: r.payment_processed,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ids from a path are not trusted to be uuids; a non-uuid simply matches nothing.
const uuids = (ids: readonly string[]) => ids.filter(id => UUID.test(id));

const groupDays = (rows: { habit_id: string; date: string; status: SettledStatus }[]) => {
  const out = new Map<string, DayRecord[]>();
  for (const r of rows) {
    const list = out.get(r.habit_id) ?? [];
    list.push({ date: r.date, status: r.status });
    out.set(r.habit_id, list);
  }
  return out;
};

// A write under Owner.user may only carry that user's rows.
function assertOwns(owner: Owner, userIds: string[]) {
  if (owner.kind === 'user' && userIds.some(u => u !== owner.userId))
    throw new Error('check repository: a row for another user under Owner.user');
}

const CHECK_COLS = `c.id, c.user_id, c.habit_id, c.local_date::text AS local_date, c.timezone, c.opens_at,
  c.deadline, c.status, c.settled_at, c.settled_by, c.execution_id`;
const EXEC_COLS = `e.id, e.user_id, e.habit_id, e.habit_version_id, e.date::text AS date, e.status, e.completed_at,
  e.notes, e.payment_processed`;

export class CheckRepository implements CheckStore {
  constructor(private readonly uow: UnitOfWork) {}

  async createPending(owner: Owner, checks: NewCheck[]): Promise<number> {
    if (checks.length === 0) return 0;
    assertOwns(
      owner,
      checks.map(c => c.userId),
    );
    const db = this.uow.db();
    const rows = checks.map(c => ({
      user_id: c.userId,
      habit_id: c.habitId,
      local_date: c.localDate,
      timezone: c.timezone,
      opens_at: c.opensAt,
      deadline: c.deadline,
    }));
    const r = await db`
      INSERT INTO "check".checks ${db(rows, 'user_id', 'habit_id', 'local_date', 'timezone', 'opens_at', 'deadline')}
      ON CONFLICT (habit_id, local_date) DO NOTHING RETURNING id`;
    return r.length;
  }

  async listDuePending(owner: Owner, deadlineBefore: Date, limit: number): Promise<CheckRow[]> {
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.status = 'pending' AND c.deadline <= ${deadlineBefore} ${ownerFilter(db, owner, 'c.user_id')}
      ORDER BY c.deadline LIMIT ${limit}`;
    return rows.map(toCheck);
  }

  async listPending(owner: Owner, habitIds: string[]): Promise<CheckRow[]> {
    const ids = uuids(habitIds);
    if (ids.length === 0) return [];
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.status = 'pending' AND c.habit_id = ANY(${db.array(ids, 'uuid')}) ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows.map(toCheck);
  }

  async listForDate(owner: Owner, habitIds: string[], localDate: string): Promise<CheckRow[]> {
    const ids = uuids(habitIds);
    if (ids.length === 0) return [];
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.local_date = ${localDate}::date AND c.habit_id = ANY(${db.array(ids, 'uuid')})
      ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows.map(toCheck);
  }

  async listCovering(owner: Owner, habitId: string, at: Date): Promise<CheckRow[]> {
    if (!UUID.test(habitId)) return [];
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.habit_id = ${habitId} AND c.opens_at <= ${at} AND c.deadline > ${at}
      ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows.map(toCheck);
  }

  async getForDay(owner: Owner, habitId: string, localDate: string): Promise<CheckRow | null> {
    if (!UUID.test(habitId)) return null;
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.habit_id = ${habitId} AND c.local_date = ${localDate}::date ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows[0] ? toCheck(rows[0]) : null;
  }

  async updatePendingWindow(owner: Owner, id: string, timezone: string, opensAt: Date, deadline: Date) {
    const db = this.uow.db();
    const r = await db`
      UPDATE "check".checks c SET timezone = ${timezone}, opens_at = ${opensAt}, deadline = ${deadline}
      WHERE c.id = ${id} AND c.status = 'pending' ${ownerFilter(db, owner, 'c.user_id')} RETURNING c.id`;
    return r.length > 0;
  }

  async deletePending(owner: Owner, ids: string[]): Promise<number> {
    const valid = uuids(ids);
    if (valid.length === 0) return 0;
    const db = this.uow.db();
    const r = await db`
      DELETE FROM "check".checks c
      WHERE c.id = ANY(${db.array(valid, 'uuid')}) AND c.status = 'pending' ${ownerFilter(db, owner, 'c.user_id')}
      RETURNING c.id`;
    return r.length;
  }

  async lockForSettle(owner: Owner, checkId: string): Promise<CheckRow | null> {
    if (!UUID.test(checkId)) return null;
    const db = this.uow.db();
    const rows: CheckSql[] = await db`
      SELECT ${db.unsafe(CHECK_COLS)} FROM "check".checks c
      WHERE c.id = ${checkId} ${ownerFilter(db, owner, 'c.user_id')} FOR UPDATE`;
    return rows[0] ? toCheck(rows[0]) : null;
  }

  async listRecorded(owner: Owner, checkIds: string[]): Promise<Set<string>> {
    const ids = uuids(checkIds);
    if (ids.length === 0) return new Set();
    const db = this.uow.db();
    const rows: { id: string }[] = await db`
      SELECT c.id FROM "check".checks c
      WHERE c.id = ANY(${db.array(ids, 'uuid')}) ${ownerFilter(db, owner, 'c.user_id')}
        AND EXISTS (SELECT 1 FROM "check".executions e WHERE e.habit_id = c.habit_id AND e.date = c.local_date)`;
    return new Set(rows.map(r => r.id));
  }

  async evidenceExists(owner: Owner, habitId: string, proofKey: string, externalId: string): Promise<boolean> {
    if (!UUID.test(habitId)) return false;
    const db = this.uow.db();
    const rows = await db`
      SELECT 1 FROM "check".evidence v
      WHERE v.habit_id = ${habitId} AND v.proof_key = ${proofKey} AND v.external_id = ${externalId}
      ${ownerFilter(db, owner, 'v.user_id')} LIMIT 1`;
    return rows.length > 0;
  }

  async countSkips(owner: Owner, from: string, to: string): Promise<number> {
    const db = this.uow.db();
    const rows: { n: number }[] = await db`
      SELECT count(*)::int AS n FROM "check".executions e
      WHERE e.status = 'skipped' AND e.date >= ${from}::date AND e.date <= ${to}::date
      ${ownerFilter(db, owner, 'e.user_id')}`;
    return rows[0]?.n ?? 0;
  }

  async insertExecution(owner: Owner, x: NewExecution): Promise<ExecutionRow | null> {
    assertOwns(owner, [x.userId]);
    const db = this.uow.db();
    const rows: ExecutionSql[] = await db`
      INSERT INTO "check".executions AS e (user_id, habit_id, habit_version_id, date, status, completed_at, notes,
        stake_cents, ratio_bps, currency, charity_id)
      VALUES (${x.userId}, ${x.habitId}, ${x.habitVersionId}, ${x.date}::date, ${x.status}, ${x.completedAt},
        ${x.notes}, ${x.stakeCents}, ${x.ratioBps}, ${x.currency}, ${x.charityId})
      ON CONFLICT (habit_id, date) DO NOTHING
      RETURNING ${db.unsafe(EXEC_COLS)}`;
    return rows[0] ? toExecution(rows[0]) : null;
  }

  async markSettled(
    owner: Owner,
    checkId: string,
    s: { status: string; settledAt: Date; settledBy: string; executionId: string },
  ): Promise<void> {
    const db = this.uow.db();
    await db`
      UPDATE "check".checks c SET status = ${s.status}, settled_at = ${s.settledAt}, settled_by = ${s.settledBy},
        execution_id = ${s.executionId}
      WHERE c.id = ${checkId} ${ownerFilter(db, owner, 'c.user_id')}`;
  }

  async insertEvidence(owner: Owner, v: NewEvidence): Promise<void> {
    assertOwns(owner, [v.userId]);
    await this.uow.db()`
      INSERT INTO "check".evidence (user_id, habit_id, check_id, proof_key, external_id, passed, occurred_at,
        received_at, data)
      VALUES (${v.userId}, ${v.habitId}, ${v.checkId}, ${v.proofKey}, ${v.externalId}, ${v.passed}, ${v.occurredAt},
        ${v.receivedAt}, ${v.data})`;
  }

  async daysForHabits(owner: Owner, habitIds: string[]): Promise<Map<string, DayRecord[]>> {
    const ids = uuids(habitIds);
    if (ids.length === 0) return new Map();
    const db = this.uow.db();
    const rows: { habit_id: string; date: string; status: SettledStatus }[] = await db`
      SELECT e.habit_id, e.date::text AS date, e.status FROM "check".executions e
      WHERE e.habit_id = ANY(${db.array(ids, 'uuid')}) ${ownerFilter(db, owner, 'e.user_id')}
      ORDER BY e.date`;
    return groupDays(rows);
  }

  async daysForLiveHabits(owner: Owner): Promise<Map<string, DayRecord[]>> {
    const db = this.uow.db();
    const rows: { habit_id: string; date: string; status: SettledStatus }[] = await db`
      SELECT e.habit_id, e.date::text AS date, e.status FROM "check".executions e
      WHERE e.habit_live ${ownerFilter(db, owner, 'e.user_id')}
      ORDER BY e.habit_id, e.date`;
    return groupDays(rows);
  }

  async searchExecutions(owner: Owner, q: ExecutionSearch): Promise<ExecutionRow[]> {
    if (q.habitId !== undefined && !UUID.test(q.habitId)) return [];
    const db = this.uow.db();
    const rows: ExecutionSql[] = await db`
      SELECT ${db.unsafe(EXEC_COLS)} FROM "check".executions e
      WHERE e.habit_live ${ownerFilter(db, owner, 'e.user_id')}
        ${q.habitId === undefined ? db`` : db`AND e.habit_id = ${q.habitId}`}
        ${q.date === undefined ? db`` : db`AND e.date = ${q.date}::date`}
      ORDER BY e.date DESC, e.id
      LIMIT ${q.limit} OFFSET ${q.skip}`;
    return rows.map(toExecution);
  }

  async getExecution(owner: Owner, id: string): Promise<ExecutionRow | null> {
    if (!UUID.test(id)) return null;
    const db = this.uow.db();
    const rows: ExecutionSql[] = await db`
      SELECT ${db.unsafe(EXEC_COLS)} FROM "check".executions e WHERE e.id = ${id} ${ownerFilter(db, owner, 'e.user_id')}`;
    return rows[0] ? toExecution(rows[0]) : null;
  }

  async executionForDate(owner: Owner, habitId: string, date: string): Promise<ExecutionRow | null> {
    if (!UUID.test(habitId)) return null;
    const db = this.uow.db();
    const rows: ExecutionSql[] = await db`
      SELECT ${db.unsafe(EXEC_COLS)} FROM "check".executions e
      WHERE e.habit_id = ${habitId} AND e.date = ${date}::date ${ownerFilter(db, owner, 'e.user_id')}
      ORDER BY (e.status = 'done') DESC, e.created_at DESC LIMIT 1`;
    return rows[0] ? toExecution(rows[0]) : null;
  }

  async deleteEvidence(owner: Owner, proofKey: string, externalId: string | null): Promise<number> {
    const db = this.uow.db();
    const r = await db`
      DELETE FROM "check".evidence v
      WHERE v.proof_key = ${proofKey} ${externalId === null ? db`` : db`AND v.external_id = ${externalId}`}
      ${ownerFilter(db, owner, 'v.user_id')} RETURNING v.id`;
    return r.length;
  }

  // Failed executions with a money stake that nobody has marked paid (LazyTax GetOpenDebtsForUser).
  async openDebts(owner: Owner): Promise<HabitDebt[]> {
    const db = this.uow.db();
    const rows: { habit_id: string; cents: string }[] = await db`
      SELECT e.habit_id, sum(e.stake_cents * e.ratio_bps / 10000)::text AS cents FROM "check".executions e
      WHERE e.status = 'missed' AND NOT e.payment_processed ${ownerFilter(db, owner, 'e.user_id')}
      GROUP BY e.habit_id`;
    return rows.map(r => ({ habitId: r.habit_id, cents: Number(r.cents) }));
  }

  async markHabitsDeleted(owner: Owner, habitIds: string[]): Promise<void> {
    const ids = uuids(habitIds);
    if (ids.length === 0) return;
    const db = this.uow.db();
    await db`
      DELETE FROM "check".checks c
      WHERE c.status = 'pending' AND c.habit_id = ANY(${db.array(ids, 'uuid')}) ${ownerFilter(db, owner, 'c.user_id')}`;
    await db`
      UPDATE "check".executions e SET habit_live = false
      WHERE e.habit_id = ANY(${db.array(ids, 'uuid')}) ${ownerFilter(db, owner, 'e.user_id')}`;
  }

  // The account purge: every row of the user in this schema.
  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM "check".evidence WHERE user_id = ${userId}`;
    await db`DELETE FROM "check".executions WHERE user_id = ${userId}`;
    await db`DELETE FROM "check".checks WHERE user_id = ${userId}`;
  }
}
