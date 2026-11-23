// account.configurations: one per user.
import { conflict, type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { ConfigurationPrincipal, ConfigurationRecord } from '../domain/model';

interface Row {
  id: string;
  user_id: string;
  timezone: string;
  end_of_day: string;
  default_charity_id: string | null;
}

const toPrincipal = (r: Row): ConfigurationPrincipal => ({
  id: r.id,
  userId: r.user_id,
  endOfDay: r.end_of_day,
  record: { timezone: r.timezone, defaultCharityId: r.default_charity_id },
});

export class ConfigurationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner, id: string): Promise<ConfigurationPrincipal | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT c.id::text, c.user_id, c.timezone, c.end_of_day::text, c.default_charity_id::text
      FROM account.configurations c WHERE c.id = ${id} ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async getForUser(owner: Owner, userId: string): Promise<ConfigurationPrincipal | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      SELECT c.id::text, c.user_id, c.timezone, c.end_of_day::text, c.default_charity_id::text
      FROM account.configurations c WHERE c.user_id = ${userId} ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async create(owner: Owner, userId: string, rec: ConfigurationRecord): Promise<ConfigurationPrincipal> {
    if (owner.kind === 'user' && owner.userId !== userId)
      throw new Error('ConfigurationRepository.create: owner mismatch');
    try {
      const rows: Row[] = await this.uow.db()`
        INSERT INTO account.configurations (user_id, timezone, default_charity_id)
        VALUES (${userId}, ${rec.timezone}, ${rec.defaultCharityId}::uuid)
        RETURNING id::text, user_id, timezone, end_of_day::text, default_charity_id::text`;
      return toPrincipal(rows[0] as Row);
    } catch (e) {
      if ((e as { errno?: string })?.errno === '23505')
        throw conflict('entity_conflict', 'Configuration already exists for this user');
      throw e;
    }
  }

  async update(owner: Owner, id: string, rec: ConfigurationRecord): Promise<ConfigurationPrincipal | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`
      UPDATE account.configurations c SET timezone = ${rec.timezone}, default_charity_id = ${rec.defaultCharityId}::uuid
      WHERE c.id = ${id} ${ownerFilter(db, owner, 'c.user_id')}
      RETURNING c.id::text, c.user_id, c.timezone, c.end_of_day::text, c.default_charity_id::text`;
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM account.configurations WHERE user_id = ${userId}`;
  }
}
