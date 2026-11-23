import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { FriendRelation, FriendRequestRow, FriendshipRow, InviteRow } from '../domain/model';

// Every method that touches a user's data takes the Owner first and filters on it in its first
// query. Friendships are stored one row per direction, so "the owner's friendships" is
// `user_id = owner`; the mirror row (friend -> owner) is written and removed together with it.

const relationOf = (friend: boolean, incoming: boolean, outgoing: boolean): FriendRelation =>
  // A friendship wins over requests; an incoming request wins over an outgoing one (when both
  // exist after a race), so the caller is offered the accept.
  friend ? 'friend' : incoming ? 'incoming' : outgoing ? 'outgoing' : 'none';

const asUserId = (owner: Owner): string => {
  if (owner.kind !== 'user') throw new Error('this friend operation needs a user owner');
  return owner.userId;
};

export class FriendRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // How each of `others` relates to the owner.
  async relations(owner: Owner, others: string[]): Promise<Map<string, FriendRelation>> {
    const out = new Map<string, FriendRelation>();
    if (others.length === 0) return out;
    const db = this.uow.db();
    const friends = await db`
      SELECT f.friend_user_id FROM friend.friendships f
      WHERE f.friend_user_id IN ${db(others)} ${ownerFilter(db, owner, 'f.user_id')}`;
    const incoming = await db`
      SELECT r.user_id AS other FROM friend.friend_requests r
      WHERE r.user_id IN ${db(others)} ${ownerFilter(db, owner, 'r.to_user_id')}`;
    const outgoing = await db`
      SELECT r.to_user_id AS other FROM friend.friend_requests r
      WHERE r.to_user_id IN ${db(others)} ${ownerFilter(db, owner, 'r.user_id')}`;
    const f = new Set(friends.map((r: { friend_user_id: string }) => r.friend_user_id));
    const i = new Set(incoming.map((r: { other: string }) => r.other));
    const o = new Set(outgoing.map((r: { other: string }) => r.other));
    for (const id of others) out.set(id, relationOf(f.has(id), i.has(id), o.has(id)));
    return out;
  }

  async relation(owner: Owner, other: string): Promise<FriendRelation> {
    return (await this.relations(owner, [other])).get(other) ?? 'none';
  }

  // Idempotent: a concurrent send of the same request already created it.
  async createRequest(owner: Owner, toUserId: string): Promise<void> {
    const db = this.uow.db();
    await db`
      INSERT INTO friend.friend_requests (user_id, to_user_id)
      VALUES (${asUserId(owner)}, ${toUserId})
      ON CONFLICT (user_id, to_user_id) DO NOTHING`;
  }

  async listIncoming(owner: Owner): Promise<FriendRequestRow[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT r.user_id AS other, r.created_at, r.id FROM friend.friend_requests r
      WHERE true ${ownerFilter(db, owner, 'r.to_user_id')}
      ORDER BY r.created_at DESC, r.id`;
    return rows.map((r: { other: string; created_at: Date }) => ({ userId: r.other, createdAt: r.created_at }));
  }

  async listOutgoing(owner: Owner): Promise<FriendRequestRow[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT r.to_user_id AS other, r.created_at, r.id FROM friend.friend_requests r
      WHERE true ${ownerFilter(db, owner, 'r.user_id')}
      ORDER BY r.created_at DESC, r.id`;
    return rows.map((r: { other: string; created_at: Date }) => ({ userId: r.other, createdAt: r.created_at }));
  }

  // Deletes the request either way (owner -> other or other -> owner). False when there was none.
  async deleteRequest(owner: Owner, otherUserId: string): Promise<boolean> {
    const db = this.uow.db();
    const outgoing = await db`
      DELETE FROM friend.friend_requests r
      WHERE r.to_user_id = ${otherUserId} ${ownerFilter(db, owner, 'r.user_id')}
      RETURNING 1 AS one`;
    const incoming = await db`
      DELETE FROM friend.friend_requests r
      WHERE r.user_id = ${otherUserId} ${ownerFilter(db, owner, 'r.to_user_id')}
      RETURNING 1 AS one`;
    return outgoing.length + incoming.length > 0;
  }

  // Creates both directions and deletes any request between them. Idempotent. Returns the
  // owner's row and whether this call created the friendship (false: it already existed).
  async createFriendship(owner: Owner, friendUserId: string): Promise<{ since: Date; created: boolean }> {
    const userId = asUserId(owner);
    const db = this.uow.db();
    const mine = await db`
      INSERT INTO friend.friendships (user_id, friend_user_id) VALUES (${userId}, ${friendUserId})
      ON CONFLICT (user_id, friend_user_id) DO NOTHING RETURNING created_at`;
    const theirs = await db`
      INSERT INTO friend.friendships (user_id, friend_user_id) VALUES (${friendUserId}, ${userId})
      ON CONFLICT (user_id, friend_user_id) DO NOTHING RETURNING created_at`;
    await this.deleteRequest(owner, friendUserId);
    const rows = await db`
      SELECT f.created_at FROM friend.friendships f
      WHERE f.friend_user_id = ${friendUserId} ${ownerFilter(db, owner, 'f.user_id')}`;
    return { since: rows[0].created_at, created: mine.length + theirs.length > 0 };
  }

  async listFriends(owner: Owner): Promise<FriendshipRow[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT f.friend_user_id, f.created_at FROM friend.friendships f
      WHERE true ${ownerFilter(db, owner, 'f.user_id')}`;
    return rows.map((r: { friend_user_id: string; created_at: Date }) => ({
      friendUserId: r.friend_user_id,
      since: r.created_at,
    }));
  }

  // Deletes both directions and the watchers each had on the other's habits. False when they
  // were not friends.
  async deleteFriendship(owner: Owner, friendUserId: string): Promise<boolean> {
    const userId = asUserId(owner);
    const db = this.uow.db();
    const mine = await db`
      DELETE FROM friend.friendships f
      WHERE f.friend_user_id = ${friendUserId} ${ownerFilter(db, owner, 'f.user_id')}
      RETURNING 1 AS one`;
    const theirs = await db`
      DELETE FROM friend.friendships f
      WHERE f.user_id = ${friendUserId} AND f.friend_user_id = ${userId}
      RETURNING 1 AS one`;
    // Each stops watching the other's habits.
    await db`
      DELETE FROM friend.habit_watchers w
      WHERE w.friend_user_id = ${friendUserId} ${ownerFilter(db, owner, 'w.user_id')}`;
    await db`
      DELETE FROM friend.habit_watchers w
      WHERE w.user_id = ${friendUserId} AND w.friend_user_id = ${userId}`;
    return mine.length + theirs.length > 0;
  }

  // The owner's invite, or a new one with this code when they have none (one per user).
  async getOrCreateInvite(owner: Owner, code: string): Promise<InviteRow> {
    const userId = asUserId(owner);
    const db = this.uow.db();
    await db`
      INSERT INTO friend.friend_invites (code, user_id) VALUES (${code}, ${userId})
      ON CONFLICT (user_id) DO NOTHING`;
    const rows = await db`
      SELECT i.code, i.user_id FROM friend.friend_invites i
      WHERE true ${ownerFilter(db, owner, 'i.user_id')}`;
    return { code: rows[0].code, userId: rows[0].user_id };
  }

  // An invite by its code. The code is the capability (unguessable, permanent), so this read is
  // not scoped to a user: the caller passes Owner.system() on purpose.
  async getInvite(owner: Owner, code: string): Promise<InviteRow | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT i.code, i.user_id FROM friend.friend_invites i
      WHERE i.code = ${code} ${ownerFilter(db, owner, 'i.user_id')}`;
    return rows[0] ? { code: rows[0].code, userId: rows[0].user_id } : null;
  }

  // Watchers of the owner's habit who are still the owner's friends, ordered by user id (the
  // service orders by username).
  async watchers(owner: Owner, habitId: string): Promise<string[]> {
    const db = this.uow.db();
    const rows = await db`
      SELECT w.friend_user_id FROM friend.habit_watchers w
      JOIN friend.friendships f ON f.user_id = w.user_id AND f.friend_user_id = w.friend_user_id
      WHERE w.habit_id = ${habitId} ${ownerFilter(db, owner, 'w.user_id')}
      ORDER BY w.friend_user_id`;
    return rows.map((r: { friend_user_id: string }) => r.friend_user_id);
  }

  // Replaces the habit's watchers (call under the owner's lock so concurrent replaces serialize).
  async replaceWatchers(owner: Owner, habitId: string, friendUserIds: string[]): Promise<void> {
    const userId = asUserId(owner);
    const db = this.uow.db();
    await db`
      DELETE FROM friend.habit_watchers w
      WHERE w.habit_id = ${habitId} ${ownerFilter(db, owner, 'w.user_id')}`;
    for (const id of friendUserIds)
      await db`
        INSERT INTO friend.habit_watchers (user_id, habit_id, friend_user_id)
        VALUES (${userId}, ${habitId}, ${id})`;
  }

  // The purge hook is the one method that takes a bare userId. Everything the user has, and
  // every row where they are the other side.
  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM friend.friend_requests WHERE user_id = ${userId} OR to_user_id = ${userId}`;
    await db`DELETE FROM friend.friendships WHERE user_id = ${userId} OR friend_user_id = ${userId}`;
    await db`DELETE FROM friend.friend_invites WHERE user_id = ${userId}`;
    await db`DELETE FROM friend.habit_watchers WHERE user_id = ${userId} OR friend_user_id = ${userId}`;
  }
}

