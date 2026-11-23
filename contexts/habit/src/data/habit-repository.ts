// Habits and their versions (LazyTax HabitRepository). Layer 4: every method takes the Owner
// first and filters on it in the first query. Reads of a version go through its habit
// (version -> habit -> user), as in the guide.
import { Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { HabitRow, HabitSearch, HabitVersion, VersionInput } from '../domain/model';

interface VersionDbRow {
  id: string;
  habit_id: string;
  user_id: string;
  version: number;
  enabled: boolean;
  routine_id: string | null;
  task: string;
  days_of_week: string[];
  notification_time: string;
  deadline_time: string;
  stake_cents: number;
  stake_currency: string;
  ratio_basis_points: number;
  charity_id: string | null;
  timezone: string;
}

const toVersion = (r: VersionDbRow): HabitVersion => ({
  id: r.id,
  habitId: r.habit_id,
  userId: r.user_id,
  version: r.version,
  enabled: r.enabled,
  routineId: r.routine_id,
  task: r.task,
  daysOfWeek: [...r.days_of_week],
  notificationTime: r.notification_time,
  deadlineTime: r.deadline_time,
  stakeCents: r.stake_cents,
  currency: r.stake_currency,
  ratioBps: r.ratio_basis_points,
  charityId: r.charity_id,
  timezone: r.timezone,
});

// The columns of a version, with the habit's enabled flag and routine.
const VERSION_COLUMNS = `
  hv.id, hv.habit_id, h.user_id, hv.version, h.enabled, h.routine_id, hv.task, hv.days_of_week,
  hv.notification_time::text AS notification_time, hv.deadline_time::text AS deadline_time,
  hv.stake_cents, hv.stake_currency, hv.ratio_basis_points, hv.charity_id, hv.timezone`;

export class HabitRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // Live habits' current versions that are enabled, optionally of some users and/or habits.
  // `owner` is the system for the tick; a user's own call narrows it to that user.
  async listSchedulable(owner: Owner, userIds?: string[], habitIds?: string[]): Promise<HabitVersion[]> {
    const db = this.uow.db();
    const users = userIds === undefined ? db`` : db`AND h.user_id = ANY(${db.array(userIds, 'TEXT')})`;
    const habits = habitIds === undefined ? db`` : db`AND h.id = ANY(${db.array(habitIds, 'UUID')})`;
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habits h
      JOIN habit.habit_versions hv ON hv.habit_id = h.id AND hv.version = h.version
      WHERE h.deleted_at IS NULL AND h.enabled
        ${ownerFilter(db, owner, 'h.user_id')} ${users} ${habits}
      ORDER BY h.user_id, h.sort_order, h.id`;
    return (rows as VersionDbRow[]).map(toVersion);
  }

  // Any version of a live habit by version id: version -> habit -> user.
  async getVersion(owner: Owner, versionId: string): Promise<HabitVersion | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habit_versions hv
      JOIN habit.habits h ON h.id = hv.habit_id
      WHERE hv.id = ${versionId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}`;
    const row = (rows as VersionDbRow[])[0];
    return row ? toVersion(row) : null;
  }

  async getCurrent(owner: Owner, habitId: string): Promise<HabitVersion | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habits h
      JOIN habit.habit_versions hv ON hv.habit_id = h.id AND hv.version = h.version
      WHERE h.id = ${habitId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}`;
    const row = (rows as VersionDbRow[])[0];
    return row ? toVersion(row) : null;
  }

  async listVersions(owner: Owner, habitId: string): Promise<HabitVersion[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habits h
      JOIN habit.habit_versions hv ON hv.habit_id = h.id
      WHERE h.id = ${habitId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}
      ORDER BY hv.version DESC`;
    return (rows as VersionDbRow[]).map(toVersion);
  }

  // The user's habit list: current versions in the user's order; Id breaks ties so pages never overlap.
  async search(owner: Owner, search: HabitSearch): Promise<HabitVersion[]> {
    const db = this.uow.db();
    const id = search.id === undefined ? db`` : db`AND h.id = ${search.id}`;
    const task =
      search.task === undefined || search.task.trim() === ''
        ? db``
        : db`AND hv.task ILIKE ${`%${escapeLike(search.task)}%`}`;
    const enabled = search.enabled === undefined ? db`` : db`AND h.enabled = ${search.enabled}`;
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habits h
      JOIN habit.habit_versions hv ON hv.habit_id = h.id AND hv.version = h.version
      WHERE h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')} ${id} ${task} ${enabled}
      ORDER BY h.sort_order, h.id
      LIMIT ${search.limit} OFFSET ${search.skip}`;
    return (rows as VersionDbRow[]).map(toVersion);
  }

  // Versions by id for trusted callers (the system owner). Deleted habits still resolve.
  async getVersionsByIds(owner: Owner, versionIds: string[]): Promise<HabitVersion[]> {
    if (versionIds.length === 0) return [];
    const db = this.uow.db();
    const rows = await db`
      SELECT ${db.unsafe(VERSION_COLUMNS)}
      FROM habit.habit_versions hv
      JOIN habit.habits h ON h.id = hv.habit_id
      WHERE hv.id = ANY(${db.array(versionIds, 'UUID')}) ${ownerFilter(db, owner, 'h.user_id')}`;
    return (rows as VersionDbRow[]).map(toVersion);
  }

  async getHabit(owner: Owner, habitId: string): Promise<HabitRow | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT h.id, h.user_id, h.version, h.enabled, h.routine_id, h.sort_order
      FROM habit.habits h
      WHERE h.id = ${habitId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}`;
    const r = (rows as HabitDbRow[])[0];
    return r ? toHabitRow(r) : null;
  }

  async owns(owner: Owner, habitId: string): Promise<boolean> {
    return (await this.getHabit(owner, habitId)) !== null;
  }

  async countHabits(owner: Owner): Promise<number> {
    const db = this.uow.db();
    const rows = await db`
      SELECT count(*)::int AS n FROM habit.habits h
      WHERE h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}`;
    return (rows as { n: number }[])[0]?.n ?? 0;
  }

  // Creates the habit and its first version. routineId null: a new one-habit routine named after
  // the task. A supplied routine must be the owner's own live routine (null result: not found).
  // The caller holds the user's lock and has counted against the quota.
  async create(owner: Owner, input: VersionInput, routineId: string | null): Promise<HabitVersion | null> {
    const userId = ownerUserId(owner);
    const db = this.uow.db();
    let routine = routineId;
    if (routine !== null) {
      const owned = await db`
        SELECT r.id FROM habit.routines r
        WHERE r.id = ${routine} AND r.deleted_at IS NULL ${ownerFilter(db, owner, 'r.user_id')}`;
      if ((owned as unknown[]).length === 0) return null;
    } else {
      const made = await db`INSERT INTO habit.routines (user_id, name) VALUES (${userId}, ${input.task}) RETURNING id`;
      routine = (made as { id: string }[])[0]?.id ?? null;
    }
    // A new habit goes to the bottom of the user's list.
    const last = await db`
      SELECT max(h.sort_order) AS last FROM habit.habits h
      WHERE h.user_id = ${userId} AND h.deleted_at IS NULL`;
    const next = ((last as { last: number | null }[])[0]?.last ?? -1) + 1;
    const habit = await db`
      INSERT INTO habit.habits (user_id, version, enabled, sort_order, routine_id)
      VALUES (${userId}, 1, true, ${next}, ${routine}) RETURNING id`;
    const habitId = (habit as { id: string }[])[0]?.id as string;
    const versionId = await this.insertVersion(userId, habitId, 1, input);
    return this.getVersion(Owner.user(userId), versionId);
  }

  // Moves the habit to its next version and sets enabled. null when it is not the owner's live habit.
  async update(owner: Owner, habitId: string, input: VersionInput, enabled: boolean): Promise<HabitVersion | null> {
    const db = this.uow.db();
    const moved = await db`
      UPDATE habit.habits h SET version = h.version + 1, enabled = ${enabled}
      WHERE h.id = ${habitId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}
      RETURNING h.version, h.user_id`;
    const row = (moved as { version: number; user_id: string }[])[0];
    if (!row) return null;
    const versionId = await this.insertVersion(row.user_id, habitId, row.version, input);
    return this.getVersion(owner, versionId);
  }

  // Soft deletes the habit, and its routine when this was the routine's last live habit. Returns
  // false when it is not the owner's live habit.
  async delete(owner: Owner, habitId: string, now: Date): Promise<boolean> {
    const db = this.uow.db();
    const done = await db`
      UPDATE habit.habits h SET deleted_at = ${now}
      WHERE h.id = ${habitId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}
      RETURNING h.routine_id`;
    const row = (done as { routine_id: string | null }[])[0];
    if (!row) return false;
    await this.closeEmptyRoutine(row.routine_id, now);
    return true;
  }

  // A routine lives as long as it has a live habit: soft delete it when the last one went.
  private async closeEmptyRoutine(routineId: string | null, now: Date): Promise<void> {
    if (routineId === null) return;
    await this.uow.db()`
      UPDATE habit.routines r SET deleted_at = ${now}
      WHERE r.id = ${routineId} AND r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM habit.habits live WHERE live.routine_id = r.id AND live.deleted_at IS NULL)`;
  }

  async getOrderedIds(owner: Owner): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT h.id FROM habit.habits h
      WHERE h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}
      ORDER BY h.sort_order, h.id`;
    return (rows as { id: string }[]).map(r => r.id);
  }

  // One statement, so the whole order is written or none of it. Ids that are not the owner's live
  // habits match no row.
  async setOrder(owner: Owner, orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const db = this.uow.db();
    await db`
      UPDATE habit.habits h SET sort_order = o.idx - 1
      FROM unnest(${db.array(orderedIds, 'UUID')}) WITH ORDINALITY AS o(id, idx)
      WHERE h.id = o.id AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}`;
  }

  // Soft deletes every live habit of a routine. Returns the ids it deleted.
  async deleteHabitsOfRoutine(owner: Owner, routineId: string, now: Date): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db`
      UPDATE habit.habits h SET deleted_at = ${now}
      WHERE h.routine_id = ${routineId} AND h.deleted_at IS NULL ${ownerFilter(db, owner, 'h.user_id')}
      RETURNING h.id`;
    return (rows as { id: string }[]).map(r => r.id);
  }

  // The purge hook is the one method that takes a bare userId. Hard delete, idempotent.
  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM habit.habit_versions WHERE user_id = ${userId}`;
    await db`DELETE FROM habit.habits WHERE user_id = ${userId}`;
    await db`DELETE FROM habit.routines WHERE user_id = ${userId}`;
  }

  private async insertVersion(userId: string, habitId: string, version: number, v: VersionInput): Promise<string> {
    const db = this.uow.db();
    const rows = await db`
      INSERT INTO habit.habit_versions
        (habit_id, user_id, version, charity_id, task, days_of_week, notification_time, deadline_time,
         stake_cents, stake_currency, ratio_basis_points, timezone)
      VALUES
        (${habitId}, ${userId}, ${version}, ${v.charityId}, ${v.task}, ${db.array(v.daysOfWeek, 'TEXT')},
         ${v.notificationTime}::time, ${v.deadlineTime}::time, ${v.stakeCents}, ${v.currency},
         ${v.ratioBps}, ${v.timezone})
      RETURNING id`;
    return (rows as { id: string }[])[0]?.id as string;
  }
}

interface HabitDbRow {
  id: string;
  user_id: string;
  version: number;
  enabled: boolean;
  routine_id: string | null;
  sort_order: number;
}

const toHabitRow = (r: HabitDbRow): HabitRow => ({
  id: r.id,
  userId: r.user_id,
  version: r.version,
  enabled: r.enabled,
  routineId: r.routine_id,
  sortOrder: r.sort_order,
});

// ILIKE "contains": a literal % or _ in the search text must not act as a wildcard.
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);

// A write that creates a row needs a concrete user: anyone cannot own a new row.
const ownerUserId = (owner: Owner): string => {
  if (owner.kind !== 'user') throw new Error('creating a row needs Owner.user');
  return owner.userId;
};
