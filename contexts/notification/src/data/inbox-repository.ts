import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { InboxRecord, InboxRow, InboxSearch } from '../domain/model';

interface Raw {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  actor_user_id: string | null;
  data: string | null;
  created_at: Date;
  read_at: Date | null;
}

const toRow = (r: Raw): InboxRow => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  actorUserId: r.actor_user_id,
  data: r.data,
  createdAtUtc: r.created_at.toISOString(),
  readAtUtc: r.read_at ? r.read_at.toISOString() : null,
});

const userOf = (owner: Owner): string => {
  if (owner.kind !== 'user') throw new Error('an inbox notification belongs to exactly one user');
  return owner.userId;
};

export class InboxRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // The posted row, or the existing one when its dedupe key was already posted to this user.
  async create(owner: Owner, record: InboxRecord, at: Date): Promise<InboxRow> {
    const db = this.uow.db();
    const userId = userOf(owner);
    const rows = await db<Raw[]>`
      INSERT INTO notification.inbox_notifications
        (user_id, kind, title, body, actor_user_id, data, dedupe_key, created_at)
      VALUES (${userId}, ${record.kind}, ${record.title}, ${record.body}, ${record.actorUserId},
              ${record.data}, ${record.dedupeKey}, ${at})
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
      DO UPDATE SET dedupe_key = notification.inbox_notifications.dedupe_key
      RETURNING *`;
    return toRow(rows[0] as Raw);
  }

  // Newest first; the id breaks ties so pages never overlap or skip rows created at the same instant.
  async search(owner: Owner, search: InboxSearch): Promise<InboxRow[]> {
    const db = this.uow.db();
    const unread = search.unreadOnly ? db`AND n.read_at IS NULL` : db``;
    const rows = await db<Raw[]>`
      SELECT n.* FROM notification.inbox_notifications n
      WHERE true ${ownerFilter(db, owner, 'n.user_id')} ${unread}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${search.limit} OFFSET ${search.skip}`;
    return rows.map(toRow);
  }

  async unreadCount(owner: Owner): Promise<number> {
    const db = this.uow.db();
    const rows = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM notification.inbox_notifications n
      WHERE n.read_at IS NULL ${ownerFilter(db, owner, 'n.user_id')}`;
    return rows[0]?.count ?? 0;
  }

  // false when the notification is not this owner's. Already-read ones still match (idempotent)
  // and keep their first read time.
  async markRead(owner: Owner, id: string, at: Date): Promise<boolean> {
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      UPDATE notification.inbox_notifications n SET read_at = COALESCE(n.read_at, ${at})
      WHERE n.id = ${id} ${ownerFilter(db, owner, 'n.user_id')}
      RETURNING n.id`;
    return rows.length > 0;
  }

  // How many were unread and are now read.
  async markAllRead(owner: Owner, at: Date): Promise<number> {
    const db = this.uow.db();
    const rows = await db<{ id: string }[]>`
      UPDATE notification.inbox_notifications n SET read_at = ${at}
      WHERE n.read_at IS NULL ${ownerFilter(db, owner, 'n.user_id')}
      RETURNING n.id`;
    return rows.length;
  }

  // The purge hook takes a bare userId. A user's own inbox and every notification they caused go.
  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`
      DELETE FROM notification.inbox_notifications
      WHERE user_id = ${userId} OR actor_user_id = ${userId}`;
  }
}
