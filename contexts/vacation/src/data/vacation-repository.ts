// vacation.vacation_periods. Every method takes the Owner first and filters on it in the query.
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { Vacation, VacationRecord, VacationSearch } from '../domain/model';

interface Row {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  timezone: string;
  created_at: Date;
}

const toVacation = (r: Row): Vacation => ({
  id: r.id,
  userId: r.user_id,
  record: { startDate: r.start_date, endDate: r.end_date, timezone: r.timezone },
  createdAt: r.created_at,
});

export class VacationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner, id: string): Promise<Vacation | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT v.id::text, v.user_id, v.start_date::text, v.end_date::text, v.timezone, v.created_at
      FROM vacation.vacation_periods v WHERE v.id = ${id} ${ownerFilter(db, owner, 'v.user_id')}`;
    return rows[0] ? toVacation(rows[0]) : null;
  }

  async search(owner: Owner, userId: string, s: VacationSearch): Promise<Vacation[]> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT v.id::text, v.user_id, v.start_date::text, v.end_date::text, v.timezone, v.created_at
      FROM vacation.vacation_periods v
      WHERE v.user_id = ${userId} ${ownerFilter(db, owner, 'v.user_id')}
        AND (${s.year ?? null}::int IS NULL
             OR extract(year FROM v.start_date) = ${s.year ?? null} OR extract(year FROM v.end_date) = ${s.year ?? null})
      ORDER BY v.start_date DESC, v.id
      LIMIT ${s.limit} OFFSET ${s.skip}`;
    return rows.map(toVacation);
  }

  async listActive(owner: Owner, userId: string, date: string): Promise<Vacation[]> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT v.id::text, v.user_id, v.start_date::text, v.end_date::text, v.timezone, v.created_at
      FROM vacation.vacation_periods v
      WHERE v.user_id = ${userId} ${ownerFilter(db, owner, 'v.user_id')}
        AND v.start_date <= ${date}::date AND v.end_date >= ${date}::date
      ORDER BY v.start_date`;
    return rows.map(toVacation);
  }

  async countWindowsForYear(owner: Owner, userId: string, year: number): Promise<number> {
    const db = this.uow.db();
    const [r] = await db`
      SELECT count(*)::int AS n FROM vacation.vacation_periods v
      WHERE v.user_id = ${userId} ${ownerFilter(db, owner, 'v.user_id')} AND extract(year FROM v.start_date) = ${year}`;
    return Number(r?.n ?? 0);
  }

  async hasOverlap(owner: Owner, userId: string, start: string, end: string): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db`
      SELECT 1 FROM vacation.vacation_periods v
      WHERE v.user_id = ${userId} ${ownerFilter(db, owner, 'v.user_id')}
        AND ${start}::date <= v.end_date AND ${end}::date >= v.start_date
      LIMIT 1`;
    return rows.length > 0;
  }

  async create(owner: Owner, userId: string, r: VacationRecord): Promise<Vacation> {
    if (owner.kind === 'user' && owner.userId !== userId) throw new Error('VacationRepository.create: owner mismatch');
    const rows: Row[] = await this.uow.db()`
      INSERT INTO vacation.vacation_periods (user_id, start_date, end_date, timezone)
      VALUES (${userId}, ${r.startDate}::date, ${r.endDate}::date, ${r.timezone})
      RETURNING id::text, user_id, start_date::text, end_date::text, timezone, created_at`;
    return toVacation(rows[0] as Row);
  }

  // Owner-scoped (LazyTax updated by id only).
  async update(owner: Owner, id: string, r: VacationRecord): Promise<Vacation | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      UPDATE vacation.vacation_periods v SET start_date = ${r.startDate}::date, end_date = ${r.endDate}::date, timezone = ${r.timezone}
      WHERE v.id = ${id} ${ownerFilter(db, owner, 'v.user_id')}
      RETURNING v.id::text, v.user_id, v.start_date::text, v.end_date::text, v.timezone, v.created_at`;
    return rows[0] ? toVacation(rows[0]) : null;
  }

  async delete(owner: Owner, id: string): Promise<boolean> {
    const db = this.uow.db();
    const rows =
      await db`DELETE FROM vacation.vacation_periods v WHERE v.id = ${id} ${ownerFilter(db, owner, 'v.user_id')} RETURNING v.id`;
    return rows.length > 0;
  }

  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM vacation.vacation_periods WHERE user_id = ${userId}`;
  }
}
