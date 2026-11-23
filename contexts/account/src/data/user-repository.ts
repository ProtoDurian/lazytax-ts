// account.users. Every method takes the Owner first; a user row's owner column is its id.
import type { UserMatchDto } from '@lazytax/account-contract/v1';
import { conflict, type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { UserPrincipal, UserRecord, UserSearch } from '../domain/model';

interface Row {
  id: string;
  username: string;
  email: string;
  email_verified: boolean;
  scopes: string[];
  active: boolean;
}

const toPrincipal = (r: Row): UserPrincipal => ({
  id: r.id,
  record: {
    username: r.username,
    email: r.email,
    emailVerified: r.email_verified,
    active: r.active,
    scopes: [...r.scopes],
  },
});

const isUniqueViolation = (e: unknown) => (e as { errno?: string })?.errno === '23505';
const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

export class UserRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner, id: string): Promise<UserPrincipal | null> {
    const db = this.uow.db();
    const rows: Row[] = await db`SELECT * FROM account.users u WHERE u.id = ${id} ${ownerFilter(db, owner, 'u.id')}`;
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async getByUsername(owner: Owner, username: string): Promise<UserPrincipal | null> {
    const db = this.uow.db();
    const rows: Row[] =
      await db`SELECT * FROM account.users u WHERE u.username = ${username} ${ownerFilter(db, owner, 'u.id')}`;
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  async search(owner: Owner, s: UserSearch): Promise<UserPrincipal[]> {
    const db = this.uow.db();
    const pat = (v: string | undefined) => (v === undefined ? null : `%${escapeLike(v)}%`);
    const rows: Row[] = await db`
      SELECT * FROM account.users u
      WHERE TRUE ${ownerFilter(db, owner, 'u.id')}
        AND (${pat(s.id)}::text IS NULL OR u.id ILIKE ${pat(s.id)})
        AND (${pat(s.username)}::text IS NULL OR u.username ILIKE ${pat(s.username)})
        AND (${pat(s.email)}::text IS NULL OR u.email ILIKE ${pat(s.email)})
        AND (${s.emailVerified ?? null}::boolean IS NULL OR u.email_verified = ${s.emailVerified ?? null})
        AND (${s.active ?? null}::boolean IS NULL OR u.active = ${s.active ?? null})
      ORDER BY u.id
      LIMIT ${s.limit} OFFSET ${s.skip}`;
    return rows.map(toPrincipal);
  }

  async usernames(owner: Owner, ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const db = this.uow.db();
    const rows: { id: string; username: string }[] =
      await db`SELECT u.id, u.username FROM account.users u WHERE u.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)) ${ownerFilter(db, owner, 'u.id')}`;
    return Object.fromEntries(rows.map(r => [r.id, r.username]));
  }

  async searchByPrefix(owner: Owner, prefix: string, excludeUserId: string, limit: number): Promise<UserMatchDto[]> {
    const db = this.uow.db();
    const pattern = `${escapeLike(prefix.toLowerCase())}%`;
    const rows: { id: string; username: string }[] = await db`
      SELECT u.id, u.username FROM account.users u
      WHERE lower(u.username) LIKE ${pattern} AND u.id <> ${excludeUserId} AND u.username <> ''
        ${ownerFilter(db, owner, 'u.id')}
      ORDER BY lower(u.username), u.username, u.id
      LIMIT ${limit}`;
    return rows.map(r => ({ userId: r.id, username: r.username }));
  }

  async create(owner: Owner, id: string, rec: UserRecord): Promise<UserPrincipal> {
    if (owner.kind === 'user' && owner.userId !== id)
      throw new Error('UserRepository.create: owner must be the new user');
    try {
      const rows: Row[] = await this.uow.db()`
        INSERT INTO account.users (id, username, email, email_verified, scopes, active)
        VALUES (${id}, ${rec.username}, ${rec.email}, ${rec.emailVerified}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(rec.scopes)}::text::jsonb)), ${rec.active})
        RETURNING *`;
      return toPrincipal(rows[0] as Row);
    } catch (e) {
      if (isUniqueViolation(e))
        throw conflict('entity_conflict', 'Failed to create User due to conflicting with existing record');
      throw e;
    }
  }

  async update(owner: Owner, id: string, rec: UserRecord): Promise<UserPrincipal | null> {
    const db = this.uow.db();
    try {
      const rows: Row[] = await db`
        UPDATE account.users u SET username = ${rec.username}, email = ${rec.email}, email_verified = ${rec.emailVerified},
          scopes = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(rec.scopes)}::text::jsonb)), active = ${rec.active}
        WHERE u.id = ${id} ${ownerFilter(db, owner, 'u.id')}
        RETURNING *`;
      return rows[0] ? toPrincipal(rows[0]) : null;
    } catch (e) {
      if (isUniqueViolation(e))
        throw conflict('entity_conflict', 'Failed to update User due to conflicting with existing record');
      throw e;
    }
  }

  // The purge hook: the one method that takes a bare userId.
  async purgeUser(userId: string): Promise<boolean> {
    const rows = await this.uow.db()`DELETE FROM account.users WHERE id = ${userId} RETURNING id`;
    return rows.length > 0;
  }
}
