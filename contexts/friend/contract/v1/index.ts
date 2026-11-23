// friend.v1: friendships, requests, invites and "tell my friends if I miss" (LazyTax
// Domain/Friend + Domain/FriendStake). Interfaces and DTOs only. Never rename or remove a member
// once merged; add new ones.

// What another user may see of you: the username only, never email or name.
export interface FriendUserDto {
  userId: string;
  username: string;
}

// lowercase, as LazyTax's API returns it.
export type FriendRelation = 'none' | 'friend' | 'outgoing' | 'incoming';

export interface FriendV1 {
  // True when a and b are friends (friendship rows exist both ways). Trusted callers only.
  areFriends(a: string, b: string): Promise<boolean>;
  // The ids of the user's friends. Trusted callers only.
  friendIds(userId: string): Promise<string[]>;
  // The friends told when this habit of this user ends Missed, still friends of the owner.
  // Trusted callers only (the caller holds a habit id from its own owner-scoped row).
  watchersOf(ownerUserId: string, habitId: string): Promise<FriendUserDto[]>;
}

// A friend request was sent (inbox: "Friend request" to toUserId).
export interface FriendRequested {
  fromUserId: string;
  toUserId: string;
}

// A request was accepted, or a request crossed one already pending (inbox: "New friend" to
// requesterUserId).
export interface FriendAccepted {
  accepterUserId: string;
  requesterUserId: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'friend.v1': FriendV1;
  }
  interface EventRegistry {
    'friend.requested': FriendRequested;
    'friend.accepted': FriendAccepted;
  }
}
