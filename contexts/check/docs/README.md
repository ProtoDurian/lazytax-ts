# check

The daily checks of every habit, their settled executions, the evidence that settled them, streaks, the
habit overview and the scheduler tick. Ported from LazyTax `Domain/Check/*`, `App/Modules/{Check,HabitExecution}`,
`App/Modules/Habit/Data/StreakRepository.cs`, `Domain/Habit/{Streak*,HabitOverview*}`, the complete and skip
routes of `HabitController.cs` and `HabitCronController.cs`.

- Contract: `check.v1` (`report`, `pendingCheckAt`, `streaks`, plus `maxStreak`, `getExecution`,
  `ownsExecution`, `executionForDate`).
- Needs: `account.v1` (timezone, today), `plan.v1` (skip quota), `habit.v1` (schedulable habits, owner-scoped
  versions, the overview list), `vacation.v1` and `protection.v1` (settle), `charity.v1` (charity names in the
  overview).
- Routes (`/api/v1`): `POST Habit/{userId}/{habitVersionId}/executions` (complete),
  `POST Habit/{userId}/{habitVersionId}/executions/skip`, `GET Habit/{userId}/executions`,
  `GET Habit/{userId}/overview`, `POST habit-cron/mark-daily-failures` (admin). `{habitVersionId}` is a GUID.
- MCP: `check.complete|skip|executions|overview|tick`.
- Events: emits `check.settled` (every settle, in the settle's unit of work). Subscribes to `habit.changed`
  (retime), `habit.deleted` (drop pending checks, hide history), `account.timezoneChanged` (move pending
  checks, settle days that are already over) and `proof.evidenceRevoked` (drop the evidence rows).
- Worker: `check.tick` every `tickEveryMs` (default 60 s): open today's and tomorrow's checks, settle the
  ones past deadline + 30 min grace. Each user-day settles in its own unit of work.
- Tables: `"check".checks`, `"check".executions`, `"check".evidence` (the schema name is a reserved word, so
  it is quoted). Purge: `purgeUser` deletes all three.
- Config: `LAZYTAX_CHECK_CONFIG='{"tickEveryMs":60000}'`.

## Changed from LazyTax

- **Ownership on the first read (the SkipHabit bug).** Complete and skip first read the habit version through
  `habit.getVersion(owner, id)`. User B on user A's version id is 404 and no row changes; LazyTax
  `Domain/Habit/Service.cs:93-97` read the version by id only.
- **Settle protections run in the settle's unit of work.** Vacation, the freeze cap (`protection.reconcileCap`
  with the user's max streak) and `protection.tryConsumeFreeze` join the same transaction as the execution
  write, under the user lock. LazyTax spent the freeze in its own transaction before the settle.
- **The check outbox is the kernel outbox.** `CheckEvents` and `CheckEventDeliveries` are gone; the tick no
  longer dispatches. `PenaltyStakeBinding` is now penalty's subscriber on `check.settled`, which carries the
  stake (cents, ratio, currency, charity) and the user's max streak, so penalty never reads check's tables.
  The event fires for every settle (done, skipped, frozen, vacation, missed, adopted), not only missed.
- **Executions carry `user_id`, `habit_id` and a copy of the stake.** LazyTax joined executions to
  `HabitVersions` and `Habits` for every read; check cannot read habit's tables. One execution per habit and
  day (unique), which LazyTax enforced in its settle SQL.
- **Deleted habits.** `habit.deleted` hides the habit's executions from searches and streaks (a flag, not a
  join on `Habits.DeletedAt`). Debts still count them, as LazyTax `GetOpenDebtsForUser` did.
- **Execution search** returns executions of all versions of the user's live habits, newest first. LazyTax
  joined only the current version, so older versions' executions vanished after an edit.
- **Complete does not go through the proof router.** proof needs check, so check cannot call it back; complete
  calls `report` with the manual proof (`proofKey: "manual"`) directly.
- **Overview `proof` is always `"manual"`.** The NFC tag and Strava binding lists live in proof, which check
  cannot call (no cycles). `sortOrder` is the position in `habit.listCurrent` (the user's order), not the
  stored number. Debt amounts come from check's own executions (failed, stake > 0, not paid).
- **Stats** were commented out in LazyTax (`App/Modules/Stats`), so there is nothing to port.
- **Retime on habit change** is the `habit.changed` subscriber (after commit, at least once) instead of a
  direct `CheckService.RetimePending` call inside `HabitService.Update`.
- **Bad query values** (`limit` outside 0-100, a date not `dd-MM-yyyy`, a non-GUID `id`) are a kernel
  `validation_error` (zod) instead of FluentValidation messages.
