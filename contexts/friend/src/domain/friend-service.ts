import type { FriendAccepted, FriendRequested, FriendV1 } from '@lazytax/friend-contract/v1';
import type { HabitV1 } from '@lazytax/habit-contract/v1';
import { notFound, type Outbox, Owner, type UnitOfWork, validationFailed } from '@lazytax/kernel';
import type { NotificationV1 } from '@lazytax/notification-contract/v1';
import type { FriendRepository } from '../data/friend-repository';
import {
  type FriendCandidate,
  type FriendRelation,
  type FriendUser,
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  MAX_SEARCH_LIMIT,
  MAX_WATCHERS,
  MIN_QUERY_LENGTH,
  type UserDirectory,
} from './model';

export interface FriendshipView {
  userId: string;
  username: string;
  sinceUtc: string;
}

export interface RequestView {
  userId: string;
  username: string;
  createdAtUtc: string;
}

// The part of check.settled friend reads. check's contract owns the full payload.
export interface SettledForFriend {
  userId: string;
  habitId: string;
  habitVersionId: string;
  checkId: string;
  date: string;
  status: string;
}

const invalid = (field: string, message: string) => validationFailed(message, { [field]: [message] });

const byUsername = (a: FriendUser, b: FriendUser) => {
  const la = a.username.toLowerCase();
  const lb = b.username.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a.username < b.username ? -1 : a.username > b.username ? 1 : a.userId < b.userId ? -1 : 1;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-01-05" -> "Mon 5 Jan" (LazyTax: ddd d MMM, invariant culture).
export const shortDate = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

const newCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH));
  // 31 symbols: reject the tail of the byte range so every symbol is equally likely.
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  let out = '';
  for (let i = 0; out.length < INVITE_CODE_LENGTH; i++) {
    let b = bytes[i % bytes.length] as number;
    if (i >= bytes.length) b = crypto.getRandomValues(new Uint8Array(1))[0] as number;
    if (b < limit) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  }
  return out;
};

export class FriendService implements FriendV1 {
  constructor(
    private readonly repo: FriendRepository,
    private readonly users: UserDirectory,
    private readonly habit: Pick<HabitV1, 'getCurrent' | 'getVersionsByIds'>,
    private readonly notification: Pick<NotificationV1, 'post'>,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
  ) {}

  // ── Friends ──────────────────────────────────────────────────────────────────────────────

  // Usernames starting with query (case-insensitive), excluding the caller, with how each
  // relates to the caller.
  async search(owner: Owner, query: string, limit: number): Promise<FriendCandidate[]> {
    const q = (query ?? '').trim();
    if (q.length < MIN_QUERY_LENGTH) throw invalid('q', `Search needs at least ${MIN_QUERY_LENGTH} characters`);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)
      throw invalid('limit', `Limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
    const userId = this.userOf(owner);
    const found = await this.users.searchUsers(q, userId, limit);
    const relations = await this.repo.relations(
      owner,
      found.map(u => u.userId),
    );
    return found.map(user => ({ user, relation: relations.get(user.userId) ?? 'none' }));
  }

  // Asks toUserId to be friends. If they already asked the caller, this accepts their request
  // instead. Already friends or already asked: no-op, current relation.
  async sendRequest(owner: Owner, toUserId: string): Promise<FriendRelation> {
    const userId = this.userOf(owner);
    if (userId === toUserId) throw invalid('toUserId', "You can't friend yourself");
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      const names = await this.users.usernames([userId, toUserId]);
      if (!names[userId]) throw notFound('User', userId);
      if (!names[toUserId]) throw notFound('User', toUserId);
      const relation = await this.repo.relation(owner, toUserId);
      if (relation === 'friend' || relation === 'outgoing') return relation;
      if (relation === 'incoming') {
        // They already asked: asking back is accepting.
        await this.acceptRequest(owner, toUserId);
        return 'friend';
      }
      await this.repo.createRequest(owner, toUserId);
      await this.outbox.add({ type: 'friend.requested', payload: { fromUserId: userId, toUserId }, userId });
      return 'outgoing';
    });
  }

  async listRequests(owner: Owner): Promise<{ incoming: RequestView[]; outgoing: RequestView[] }> {
    const [incoming, outgoing] = await Promise.all([this.repo.listIncoming(owner), this.repo.listOutgoing(owner)]);
    const names = await this.users.usernames([...incoming, ...outgoing].map(r => r.userId));
    const view = (rows: { userId: string; createdAt: Date }[]): RequestView[] =>
      rows
        .filter(r => names[r.userId])
        .map(r => ({ userId: r.userId, username: names[r.userId] as string, createdAtUtc: r.createdAt.toISOString() }));
    return { incoming: view(incoming), outgoing: view(outgoing) };
  }

  // Accepts fromUserId's request. Null when there is no such request.
  async accept(owner: Owner, fromUserId: string): Promise<FriendshipView | null> {
    const userId = this.userOf(owner);
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      if ((await this.repo.relation(owner, fromUserId)) !== 'incoming') return null;
      const names = await this.users.usernames([userId, fromUserId]);
      if (!names[userId]) throw notFound('User', userId);
      const since = await this.acceptRequest(owner, fromUserId);
      const username = names[fromUserId];
      // The requester's account is gone: the friendship cannot be shown.
      if (!username) return null;
      return { userId: fromUserId, username, sinceUtc: since.toISOString() };
    });
  }

  // Declines an incoming request or cancels an outgoing one, silently. False when none.
  deleteRequest(owner: Owner, otherUserId: string): Promise<boolean> {
    return this.uow.run(() => this.repo.deleteRequest(owner, otherUserId));
  }

  async listFriends(owner: Owner): Promise<FriendshipView[]> {
    const rows = await this.repo.listFriends(owner);
    const names = await this.users.usernames(rows.map(r => r.friendUserId));
    return rows
      .filter(r => names[r.friendUserId])
      .map(r => ({ userId: r.friendUserId, username: names[r.friendUserId] as string, since: r.since }))
      .sort((a, b) => byUsername(a, b))
      .map(r => ({ userId: r.userId, username: r.username, sinceUtc: r.since.toISOString() }));
  }

  // Ends the friendship both ways, and stops each telling the other about missed habits.
  // False when they weren't friends.
  remove(owner: Owner, friendUserId: string): Promise<boolean> {
    return this.uow.run(() => this.repo.deleteFriendship(owner, friendUserId));
  }

  // The user's one invite: the same code every time, created on the first call.
  async getOrCreateInvite(owner: Owner): Promise<{ code: string }> {
    const invite = await this.uow.run(() => this.repo.getOrCreateInvite(owner, newCode()));
    return { code: invite.code };
  }

  // Sends the invite's owner a friend request, exactly as sendRequest does. Null for an unknown
  // code.
  async acceptInvite(owner: Owner, code: string): Promise<FriendRelation | null> {
    const userId = this.userOf(owner);
    // The code is the capability: the lookup is not scoped to a user.
    const invite = await this.repo.getInvite(Owner.system(), (code ?? '').trim().toLowerCase());
    if (!invite) return null;
    if (invite.userId === userId) throw invalid('code', "You can't accept your own invite");
    // The owner still decides: a link only saves searching for their username.
    return this.sendRequest(owner, invite.userId);
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    return (await this.repo.relation(Owner.user(a), b)) === 'friend';
  }

  async friendIds(userId: string): Promise<string[]> {
    return (await this.repo.listFriends(Owner.user(userId))).map(r => r.friendUserId);
  }

  // ── Friend stake: "tell my friends if I miss" ─────────────────────────────────────────────

  async getWatchers(owner: Owner, habitId: string): Promise<FriendUser[]> {
    await this.ensureOwned(owner, habitId);
    return this.watchersOf(this.userOf(owner), habitId);
  }

  // Replaces the habit's watchers. Each must be a friend of the user; an empty list turns it off.
  async setWatchers(owner: Owner, habitId: string, friendUserIds: string[]): Promise<FriendUser[]> {
    const userId = this.userOf(owner);
    await this.uow.run(async () => {
      await this.uow.lockUser(userId);
      await this.ensureOwned(owner, habitId);
      const ids = [...new Set(friendUserIds)];
      if (ids.length > MAX_WATCHERS) throw invalid('friendUserIds', `At most ${MAX_WATCHERS} friends can be told`);
      const relations = await this.repo.relations(owner, ids);
      const notFriends = ids.filter(id => relations.get(id) !== 'friend');
      if (notFriends.length > 0) throw invalid('friendUserIds', `Not your friends: ${notFriends.join(', ')}`);
      await this.repo.replaceWatchers(owner, habitId, ids);
    });
    return this.watchersOf(userId, habitId);
  }

  // Only watchers still friends with the habit's owner: a stale row of a removed friend never
  // tells them anything.
  async watchersOf(ownerUserId: string, habitId: string): Promise<FriendUser[]> {
    if (!UUID.test(habitId)) return [];
    const ids = await this.repo.watchers(Owner.user(ownerUserId), habitId);
    const names = await this.users.usernames(ids);
    return ids
      .filter(id => names[id])
      .map(id => ({ userId: id, username: names[id] as string }))
      .sort(byUsername);
  }

  // ── Outbox subscribers ────────────────────────────────────────────────────────────────────

  async onRequested(e: FriendRequested): Promise<void> {
    await this.notifyFriend(e.fromUserId, e.toUserId, 'friend_request', 'Friend request', n => `${n} wants to be friends`, {
      fromUserId: e.fromUserId,
    });
  }

  async onAccepted(e: FriendAccepted, eventId: string): Promise<void> {
    await this.notifyFriend(
      e.accepterUserId,
      e.requesterUserId,
      'friend_accepted',
      'New friend',
      n => `${n} is now your friend`,
      { friendUserId: e.accepterUserId },
      `friend_accepted:${eventId}`,
    );
  }

  // A missed check posts one friend_missed notification to each friend watching the habit.
  // Friends only learn that it was missed, never proof details. Safe to retry: every post
  // carries the dedupe key friend_missed:{checkId}.
  async onSettled(e: SettledForFriend): Promise<void> {
    if (e.status !== 'missed') return;
    const watchers = await this.watchersOf(e.userId, e.habitId);
    if (watchers.length === 0) return;
    // The habit as it was when the check settled (a deleted habit still resolves).
    const [habit] = await this.habit.getVersionsByIds([e.habitVersionId]);
    const names = await this.users.usernames([e.userId]);
    const username = names[e.userId];
    // The habit or the owner is gone: nothing left to tell.
    if (!habit || !username) return;
    const task = habit.task.length > 200 ? `${habit.task.slice(0, 199)}…` : habit.task;
    const title = `${username} missed a habit`;
    for (const w of watchers)
      await this.notification.post(
        w.userId,
        'friend_missed',
        title.slice(0, 256),
        `${username} missed "${task}" on ${shortDate(e.date)}`,
        e.userId,
        { habitId: e.habitId, userId: e.userId, localDate: e.date },
        `friend_missed:${e.checkId}`,
      );
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private userOf(owner: Owner): string {
    if (owner.kind !== 'user') throw new Error('this friend operation needs a user owner');
    return owner.userId;
  }

  // Makes the friendship and tells the requester, once, only when this call created it.
  private async acceptRequest(owner: Owner, requesterId: string): Promise<Date> {
    const userId = this.userOf(owner);
    const { since, created } = await this.repo.createFriendship(owner, requesterId);
    if (created)
      await this.outbox.add({
        type: 'friend.accepted',
        payload: { accepterUserId: userId, requesterUserId: requesterId },
        userId,
      });
    return since;
  }

  // The first read is owner-scoped: another user's habit, a deleted one, or a non-uuid is 404.
  private async ensureOwned(owner: Owner, habitId: string): Promise<void> {
    const habit = UUID.test(habitId) ? await this.habit.getCurrent(owner, habitId) : null;
    if (!habit) throw notFound('Habit', habitId);
  }

  private async notifyFriend(
    actorUserId: string,
    toUserId: string,
    kind: string,
    title: string,
    body: (actorName: string) => string,
    data: Record<string, unknown>,
    dedupeKey?: string,
  ): Promise<void> {
    const names = await this.users.usernames([actorUserId]);
    const actor = names[actorUserId];
    if (!actor) return;
    await this.notification.post(toUserId, kind, title, body(actor), actorUserId, data, dedupeKey);
  }
}
