# habit

Habits, their versions and routines. Ported from LazyTax `App/Modules/{Habit,HabitVersion,Routine}`
and `Domain/{Habit,Routine}`. check owns complete, skip, executions, streaks, overview and the tick.

- Contract: `habit.v1` (`listSchedulable`, `getVersion`, `getCurrent`, `owns`, plus `listVersions`,
  `listCurrent`, `getVersionsByIds`, `countHabits`).
- Needs: `account.v1` (declared per lanes.md, not called yet), `plan.v1` (habit quota), `charity.v1` (charity exists).
- Routes (`/api/v1`): `Habit/{userId}` search and create, `Habit/{userId}/{id}` get, update, delete,
  `Habit/{userId}/order`, and `Routine/{userId}[/{id}]` CRUD. `{id}` is constrained to a GUID so check's
  `executions` and `overview` routes under the same prefix are never swallowed.
- MCP: `habit.list|get|create|update|delete|reorder|listRoutines|createRoutine|renameRoutine|deleteRoutine`.
- Events: emits `habit.changed` (update, delete) and `habit.deleted` (delete, routine delete).
- Purge: `purgeUser` hard deletes versions, habits and routines of the user.
- Config: `LAZYTAX_HABIT_CONFIG='{"maxStakeCents":1000000}'` (LazyTax `HabitOption.MaxStakeCents`).

## Changed from LazyTax

- **Ownership on the first read.** Reads of versions take an `Owner` and join version -> habit -> user. A
  version of another user is 404 on the contract (`getVersion`), which is what check's `SkipHabit` uses (the
  `Domain/Habit/Service.cs:93-97` bug).
- **Complete and skip routes moved to check.** habit tells check about changes only through `habit.changed`
  (LazyTax called `CheckService.RetimePending` directly). It is now an outbox event, so the retime runs
  after commit and at least once.
- **Admin can act on habit routes.** The kernel's `subject` check lets an admin through; LazyTax `Guard` on
  `HabitController` did not (only the Routine controller used `GuardOrAny`).
- **NFC tag release on delete** is the `habit.deleted` event (proof subscribes), not a delete inside the
  habit repository.
- **Charity is a contract call, not a foreign key.** An unknown charity is checked with `charity.exists`
  before the write and answers 400 `validation_error` on `CharityId` (as the FK violation did). There is no
  FK on `habit_versions.charity_id`, so a charity removed later leaves old versions pointing at it.
- **Quota counted under the user lock** with `plan.ensureWithin` (LazyTax counted in the repository). Habit
  create has a cheap guard first: a plan with 0 habits refuses before any lock. Switching a habit on takes the
  same count (`count >= limit` refuses, as LazyTax).
- **`habit_versions.user_id` is a copy** of the habit's user id, for the purge; reads still filter through
  the habit.
- **Task search escapes `%` and `_`** in the text (LazyTax passed them to `ILIKE` as wildcards).
- **Bad bodies are a kernel `validation_error`** (zod) instead of FluentValidation messages; the rules are the
  same: task 1-256, valid weekday names (any case, distinct, canonical), `HH:mm:ss` times, valid IANA timezone,
  stake with at most 2 decimals up to `maxStakeCents`, a charity when stake > 0.
- **Search query:** `limit` 0-100, `skip` >= 0; the `userId` query field is accepted and ignored (the path wins).
- **SortOrder** of a new habit is `max + 1` among the user's live habits, as LazyTax.
- **Isolation:** habit does not rely on REPEATABLE READ. Count-then-write runs under `uow.lockUser` at the default READ COMMITTED; the quota race test (two concurrent creates at a limit of 1) failed on the old snapshot-before-lock kernel and passes now.
