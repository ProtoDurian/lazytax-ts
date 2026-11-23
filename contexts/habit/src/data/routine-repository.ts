// Routines (LazyTax RoutineRepository). Owner first, filtered in the first query.
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { Routine, RoutineSearch } from '../domain/model';

interface RoutineDbRow {
  id: string;
  user_id: string;
  name: string;
}

const toRoutine = (r: RoutineDbRow): Routine => ({ id: r.id, userId: r.user_id, name: r.name });

export class RoutineRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner, id: string): Promise<Routine | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT r.id, r.user_id, r.name FROM habit.routines r
      WHERE r.id = ${id} AND r.deleted_at IS NULL ${ownerFilter(db, owner, 'r.user_id')}`;
    const row = (rows as RoutineDbRow[])[0];
    return row ? toRoutine(row) : null;
  }

  async search(owner: Owner, search: RoutineSearch): Promise<Routine[]> {
    const db = this.uow.db();
    const name =
      search.name === undefined || search.name.trim() === ''
        ? db``
        : db`AND r.name ILIKE ${`%${search.name.replace(/[\\%_]/g, c => `\\${c}`)}%`}`;
    const rows = await db`
      SELECT r.id, r.user_id, r.name FROM habit.routines r
      WHERE r.deleted_at IS NULL ${ownerFilter(db, owner, 'r.user_id')} ${name}
      ORDER BY r.created_at, r.id
      LIMIT ${search.limit} OFFSET ${search.skip}`;
    return (rows as RoutineDbRow[]).map(toRoutine);
  }

  async create(owner: Owner, name: string): Promise<Routine> {
    if (owner.kind !== 'user') throw new Error('creating a row needs Owner.user');
    const userId = owner.userId;
    const rows = await this.uow.db()`
      INSERT INTO habit.routines (user_id, name) VALUES (${userId}, ${name})
      RETURNING id, user_id, name`;
    return toRoutine((rows as RoutineDbRow[])[0] as RoutineDbRow);
  }

  // null when it is not the owner's live routine.
  async rename(owner: Owner, id: string, name: string): Promise<Routine | null> {
    const db = this.uow.db();
    const rows = await db`
      UPDATE habit.routines r SET name = ${name}
      WHERE r.id = ${id} AND r.deleted_at IS NULL ${ownerFilter(db, owner, 'r.user_id')}
      RETURNING r.id, r.user_id, r.name`;
    const row = (rows as RoutineDbRow[])[0];
    return row ? toRoutine(row) : null;
  }

  // Soft delete. false when it is not the owner's live routine.
  async delete(owner: Owner, id: string, now: Date): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db`
      UPDATE habit.routines r SET deleted_at = ${now}
      WHERE r.id = ${id} AND r.deleted_at IS NULL ${ownerFilter(db, owner, 'r.user_id')}
      RETURNING r.id`;
    return (rows as unknown[]).length > 0;
  }
}
