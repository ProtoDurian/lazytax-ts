-- friend: requests, friendships, invites and "tell my friends if I miss" watchers.
-- No foreign keys: users live in account, habits in habit. user_id is a copy of the JWT sub.

-- A pending request from user_id (the asker) to to_user_id. Accepting or declining deletes it.
CREATE TABLE friend.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  to_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friend_requests_pair UNIQUE (user_id, to_user_id)
);
CREATE INDEX friend_requests_user_id ON friend.friend_requests (user_id);
CREATE INDEX friend_requests_to_user_id ON friend.friend_requests (to_user_id);

-- One row per direction: a friendship between A and B is (A, B) and (B, A).
CREATE TABLE friend.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  friend_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friendships_pair UNIQUE (user_id, friend_user_id)
);
CREATE INDEX friendships_user_id ON friend.friendships (user_id);
CREATE INDEX friendships_friend_user_id ON friend.friendships (friend_user_id);

-- A user's permanent invite link (one per user); it never expires.
CREATE TABLE friend.friend_invites (
  code text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX friend_invites_user_id ON friend.friend_invites (user_id);

-- A friend told when the habit's day ends missed. user_id = the habit's owner.
CREATE TABLE friend.habit_watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  habit_id uuid NOT NULL,
  friend_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT habit_watchers_pair UNIQUE (habit_id, friend_user_id)
);
CREATE INDEX habit_watchers_user_id ON friend.habit_watchers (user_id);
CREATE INDEX habit_watchers_friend_user_id ON friend.habit_watchers (friend_user_id);
