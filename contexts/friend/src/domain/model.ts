import type { FriendRelation, FriendUserDto } from '@lazytax/friend-contract/v1';

export type { FriendRelation };

// What another user may see of you: the username only, never email or name.
export type FriendUser = FriendUserDto;

export interface FriendCandidate {
  user: FriendUser;
  relation: FriendRelation;
}

export interface FriendRequestRow {
  // The other person: the sender for incoming, the recipient for outgoing.
  userId: string;
  createdAt: Date;
}

export interface FriendshipRow {
  friendUserId: string;
  since: Date;
}

export interface InviteRow {
  code: string;
  userId: string;
}

// The account facts friend needs (account.v1 additions: usernames and searchUsers).
export interface UserDirectory {
  // Usernames of the users that exist; unknown ids are left out.
  usernames(userIds: string[]): Promise<Record<string, string>>;
  // Usernames starting with prefix (case-insensitive), excluding one user, ordered by
  // lower(username), username, id.
  searchUsers(prefix: string, excludeUserId: string, limit: number): Promise<FriendUser[]>;
}

export const MIN_QUERY_LENGTH = 2;
export const MAX_SEARCH_LIMIT = 20;
export const INVITE_CODE_LENGTH = 10;
// Lowercase letters and digits without the look-alikes 0/o, 1/l/i, so a code read aloud or
// retyped from a screenshot still works.
export const INVITE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const MAX_WATCHERS = 20;
