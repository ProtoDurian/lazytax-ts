// The only SQL in protection. Every method takes the Owner first and filters on it in the first
// query. Writes need a user owner (Owner.user), never Owner.anyone.
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { ProtectionRow, SettledDayInput, SettledDayRow } from '../domain/model';

interface ProtectionSql {
  user_id: string;
  freeze_current: number;
  max_streak: number;
}

const toRow = (r: ProtectionSql): ProtectionRow => ({
  userId: r.user_id,
  freezeCurrent: r.freeze_current,
  maxStreak: r.max_streak,
});

// A write belongs to one user: refuse "anyone" instead of writing a row for nobody.
function writer(owner: Owner): string {
  if (owner.kind !== 'user') throw new Error('protection writes need Owner.user');
  return owner.userId;
}

export class ProtectionRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner): Promise<ProtectionRow | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT p.user_id, p.freeze_current, p.max_streak
      FROM protection.user_protections p
      WHERE true ${ownerFilter(db, owner, 'p.user_id')}`;
    return rows[0] ? toRow(rows[0] as ProtectionSql) : null;
  }

  // LazyTax UpsertProtection: the row, created with 0 freezes when missing.
  async upsert(owner: Owner): Promise<ProtectionRow> {
    const userId = writer(owner);
    const rows = await this.uow.db()`
      INSERT INTO protection.user_protections (user_id) VALUES (${userId})
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING user_id, freeze_current, max_streak`;
    return toRow(rows[0] as ProtectionSql);
  }

  async setMaxStreak(owner: Owner, maxStreak: number): Promise<void> {
    const userId = writer(owner);
    await this.uow.db()`
      UPDATE protection.user_protections SET max_streak = ${Math.max(0, maxStreak)}, updated_at = now()
      WHERE user_id = ${userId}`;
  }

  // Cuts the balance down to the cap. Returns the balance afterwards.
  async clampToCap(owner: Owner, cap: number): Promise<number> {
    const userId = writer(owner);
    const rows = await this.uow.db()`
      UPDATE protection.user_protections
      SET freeze_current = LEAST(freeze_current, ${Math.max(0, cap)}), updated_at = now()
      WHERE user_id = ${userId}
      RETURNING freeze_current`;
    return (rows[0] as { freeze_current: number }).freeze_current;
  }

  async increment(owner: Owner, n: number): Promise<void> {
    const userId = writer(owner);
    await this.uow.db()`
      UPDATE protection.user_protections SET freeze_current = freeze_current + ${Math.max(0, n)}, updated_at = now()
      WHERE user_id = ${userId}`;
  }

  // LazyTax TryConsumeFreeze. Call it under uow.lockUser: the check and the write are one step.
  async tryConsume(owner: Owner, date: string): Promise<boolean> {
    const userId = writer(owner);
    const db = this.uow.db();
    const done = await db`
      SELECT 1 FROM protection.freeze_consumptions c
      WHERE c.date = ${date}::date ${ownerFilter(db, owner, 'c.user_id')}`;
    if (done.length > 0) return true;
    await this.upsert(owner);
    const spent = await db`
      UPDATE protection.user_protections SET freeze_current = freeze_current - 1, updated_at = now()
      WHERE user_id = ${userId} AND freeze_current > 0
      RETURNING freeze_current`;
    if (spent.length === 0) return false;
    await db`
      INSERT INTO protection.freeze_consumptions (user_id, date) VALUES (${userId}, ${date}::date)
      ON CONFLICT (user_id, date) DO NOTHING`;
    return true;
  }

  // True when this (habit, week) was not awarded before.
  async recordAwardIfAbsent(owner: Owner, habitId: string, weekStart: string): Promise<boolean> {
    const userId = writer(owner);
    const rows = await this.uow.db()`
      INSERT INTO protection.freeze_awards (user_id, habit_id, week_start)
      VALUES (${userId}, ${habitId}, ${weekStart}::date)
      ON CONFLICT (habit_id, week_start) DO NOTHING
      RETURNING id`;
    return rows.length > 0;
  }

  // From check.settled. Idempotent by execution id (a redelivered event changes nothing).
  async recordSettled(owner: Owner, day: SettledDayInput): Promise<void> {
    const userId = writer(owner);
    await this.uow.db()`
      INSERT INTO protection.settled_days (user_id, habit_id, execution_id, date, status)
      VALUES (${userId}, ${day.habitId}, ${day.executionId}, ${day.date}::date, ${day.status})
      ON CONFLICT (execution_id) DO NOTHING`;
  }

  async settledBetween(owner: Owner, from: string, to: string): Promise<SettledDayRow[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT s.habit_id, s.date::text AS date, s.status
      FROM protection.settled_days s
      WHERE s.date >= ${from}::date AND s.date <= ${to}::date ${ownerFilter(db, owner, 's.user_id')}
      ORDER BY s.date`;
    return rows.map((r: { habit_id: string; date: string; status: string }) => ({
      habitId: r.habit_id,
      date: r.date,
      status: r.status,
    }));
  }

  // The worker's candidate list: users with settled days in the window (Owner.system() only).
  async usersSettledBetween(owner: Owner, from: string, to: string): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT DISTINCT s.user_id
      FROM protection.settled_days s
      WHERE s.date >= ${from}::date AND s.date <= ${to}::date ${ownerFilter(db, owner, 's.user_id')}
      ORDER BY s.user_id`;
    return rows.map((r: { user_id: string }) => r.user_id);
  }

  // Keeps the settled ledger small: weeks older than the window can no longer be awarded.
  async pruneSettledBefore(owner: Owner, before: string): Promise<void> {
    const db = this.uow.db();
    await db`
      DELETE FROM protection.settled_days s
      WHERE s.date < ${before}::date ${ownerFilter(db, owner, 's.user_id')}`;
  }

  // The purge hook is the one method that takes a bare userId.
  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM protection.settled_days WHERE user_id = ${userId}`;
    await db`DELETE FROM protection.freeze_awards WHERE user_id = ${userId}`;
    await db`DELETE FROM protection.freeze_consumptions WHERE user_id = ${userId}`;
    await db`DELETE FROM protection.user_protections WHERE user_id = ${userId}`;
  }
}
