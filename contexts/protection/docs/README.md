# protection

The user's freeze-day pool: how many freezes a user has banked, the one-per-day spend, and the
weekly award for perfect habit weeks. Port of LazyTax `Domain/Protection` and
`App/Modules/Protection`.

## What it does

| Part | How |
| --- | --- |
| Balance | `GET /api/v1/Protection/{userId}` (and MCP `protection.balance`). Reading cuts the balance to the cap first, so `balance` is never above `cap`. |
| Spend | `protection.v1 tryConsumeFreeze(userId, date)`. One freeze per user-local day; a second call for the same day is `true` and spends nothing. Runs under the user lock. |
| Cap | `reconcileCap(userId, maxStreak)` asks `plan.v1 freezeCap`, then cuts the balance. Cut freezes are gone for good. |
| Award | Worker `weekly-award` (hourly) and admin `POST /api/v1/Protection/award-weekly` (MCP `protection.awardWeekly`). One freeze per habit per perfect week, once ever per (habit, week). Emits `protection.awarded`. |
| Delete account | `purgeUser` removes the user's rows from all four tables. |

## Contract (`protection.v1`)

`reconcileCap(userId, maxStreak)`, `tryConsumeFreeze(userId, date)`, `balance(owner)`.
Event `protection.awarded {userId, habitId, weekStart, balance, cap}`.

`needs: [account.v1, plan.v1]`. lanes.md lists only `plan`. `account` is added because the weekly
award needs the user's local today (`account.today`). It sits earlier in the `needs` order and
makes no cycle.

## Tables (schema `protection`)

`user_protections` (balance and last max streak), `freeze_consumptions` (unique per user and
date), `freeze_awards` (unique per habit and week), `settled_days` (new, see below).

## Changed from LazyTax

1. **The weekly award reads protection's own ledger, not habit and streak tables.** LazyTax
   called `HabitRepository.SearchHabits` and `StreakService.GetStatusForHabit`. Protection `needs`
   only plan and account, so it records every `check.settled` into `settled_days`. A habit's week
   is perfect when it has at least one settled day and every one is `done`. LazyTax counted
   only the habit's scheduled days; every scheduled day settles, so the sets match. Two edge
   differences: a habit with no scheduled days at all was vacuously perfect in LazyTax and earns
   nothing here; a habit disabled mid-week is judged on the days it settled.
2. **The max streak comes from check.** LazyTax read `StreakRepository.GetUserMaxStreakAcrossHabits`.
   check now passes `maxStreak` on `check.settled` and in `reconcileCap`; protection stores the
   last value (`user_protections.max_streak`) and uses it for `GET` and for the award clamp.
   Between two settles the cap uses the value from the last settle.
3. **The award moved from a per-user event to a worker plus the admin route.** The worker looks at
   users with settled days in the last 14 days, one at a time, and finishes the week that ended.
   Settled days older than 45 days are pruned.
4. **Awards are an outbox event** (`protection.awarded`), written in the same unit of work as the
   award row. LazyTax emitted nothing.
5. **Ownership.** Every repository method takes an `Owner` first. The balance has no id in any
   path, so the owner-scoped test is "user B's read shows none of A's and A's row is unchanged";
   the user-id-in-path mismatch is a 403 from layer 3.
6. **One unit of work.** `tryConsume` was its own EF transaction inside a repository; it is now one
   lock-then-write step in the caller's unit of work, so a settle that freezes a day and writes
   its execution commits or rolls back together.

## Not done / open

- The award treats only status `done` (check's name for completed) as success; `isDone` in
  `src/domain/weeks.ts`.
- `check.settled` must be emitted for done days too, not only missed ones, or no week is
  ever perfect.
