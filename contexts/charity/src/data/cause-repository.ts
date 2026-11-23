// SQL for causes. Global data, like charities: the admin routes carry the access rule.
import type { UnitOfWork } from '@lazytax/kernel';
import type { CauseDto, CauseSearch } from '../domain/model';

interface CauseRow {
  id: string;
  key: string;
  name: string;
}

export class CauseRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(id: string): Promise<CauseDto | null> {
    const rows = (await this.uow.db()`SELECT id, key, name FROM charity.causes WHERE id = ${id}`) as CauseRow[];
    return rows[0] ?? null;
  }

  async getByKey(key: string): Promise<CauseDto | null> {
    const rows = (await this.uow.db()`SELECT id, key, name FROM charity.causes WHERE key = ${key}`) as CauseRow[];
    return rows[0] ?? null;
  }

  async getByKeys(keys: string[]): Promise<CauseDto[]> {
    if (keys.length === 0) return [];
    const db = this.uow.db();
    return (await db`SELECT id, key, name FROM charity.causes WHERE key = ANY(${db.array(keys, 'TEXT')})`) as CauseRow[];
  }

  async search(q: CauseSearch): Promise<CauseDto[]> {
    const db = this.uow.db();
    return (await db`
      SELECT id, key, name FROM charity.causes
      WHERE TRUE
        ${q.key ? db`AND key ILIKE ${`%${q.key}%`}` : db``}
        ${q.name ? db`AND name ILIKE ${`%${q.name}%`}` : db``}
      ORDER BY name, id
      LIMIT ${q.limit} OFFSET ${q.skip}`) as CauseRow[];
  }

  // null when the key is taken (no exception, so the open transaction stays usable).
  async create(key: string, name: string): Promise<CauseDto | null> {
    const rows = (await this.uow.db()`
      INSERT INTO charity.causes (key, name) VALUES (${key}, ${name})
      ON CONFLICT (key) DO NOTHING RETURNING id, key, name`) as CauseRow[];
    return rows[0] ?? null;
  }

  // Only the name is mutable; the key is fixed once created.
  async update(id: string, name: string): Promise<CauseDto | null> {
    const rows = (await this.uow.db()`
      UPDATE charity.causes SET name = ${name} WHERE id = ${id} RETURNING id, key, name`) as CauseRow[];
    return rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.uow.db()`DELETE FROM charity.causes WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }
}
