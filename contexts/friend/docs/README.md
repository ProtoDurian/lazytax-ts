# friend

Friendships, requests, permanent invites, and "tell my friends if I miss" (LazyTax `Domain/Friend` + `Domain/FriendStake`).

- **Contract** `friend.v1`: `areFriends(a, b)`, `friendIds(userId)`, `watchersOf(ownerUserId, habitId)`.
- **Needs**: account (usernames, search), habit (ownership of a habit), notification (inbox).
- **Routes**: `/api/v1/Friend/...` and `/api/v1/FriendStake/...`, same paths and bodies as LazyTax.
- **Tables** (schema `friend`): `friend_requests`, `friendships` (one row per direction), `friend_invites`, `habit_watchers`. No foreign keys; `user_id` is a copy of the JWT sub.
- **Events out**: `friend.requested`, `friend.accepted`. **Events in**: `check.settled` (status `missed` only).
- **Purge**: removes every row where the user is either side.

## Changed from LazyTax

- **Usernames come from `account.v1`** (`usernames`, `searchUsers`), not from a join to `Users`. A user whose account is gone is left out of lists, as the inner join did.
- **Inbox posts leave through the outbox.** LazyTax posted inline, best effort, after the change. Now `friend.requested` and `friend.accepted` are written in the same unit of work as the change, and subscribers post to `notification.v1` once, in their own unit of work (retried on failure, deduped by event id). Tests need `app.drainOutbox()`.
- **`friend_accepted` dedupe**: the event is written only when this call created the friendship, instead of a key from the friendship's `SinceUtc` ticks.
- **`friend_missed` is one unit of work**: if posting to any watcher fails, none are kept and the event retries; the dedupe key `friend_missed:{checkId}` makes the retry safe. LazyTax tried every watcher and failed at the end. The habit name is the version at settle time (`habitVersionId` from `check.settled`).
- **Habit ownership** is `habit.getCurrent(owner, habitId)`, the first read, so another user's habit, a deleted one or a non-uuid is 404 and nothing changes.
- **Watchers sit in `friend.habit_watchers`** with `user_id` = the habit's owner (a copy), so removing a friendship deletes both sides' watchers without reading the habit schema. `GetWatchers` still only returns watchers who are currently friends.
- **Concurrent accepts**: `accept` and `sendRequest` take the caller's user lock. A second accept of the same request now returns 404 (the request is gone) where LazyTax's idempotent path returned 200.
- **Invite codes** are looked up by code with `Owner.system()` on purpose: the code is the capability.
- **Isolation**: units of work run at the kernel default READ COMMITTED. Friend does not need repeatable read: writes are idempotent (`ON CONFLICT DO NOTHING`, unique pairs) and serialize on the caller's user lock.
