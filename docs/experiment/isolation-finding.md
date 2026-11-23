# Lock, then count, then write, at REPEATABLE READ: is LazyTax exposed?

**Answer: LazyTax is not exposed today. All 3 places that take the user lock run at READ COMMITTED, so two parallel requests cannot both pass a quota. The bug is latent: it fires the moment one of these is wrapped in `tm.Start`, which uses REPEATABLE READ. That wrapping is exactly what our own new kernel did first, until we fixed it.**

## Every place the user lock is taken (AtomiCloud/alcohol.zinc @ 934d8c3)

| File:line                                                          | Quota                                                  | Transaction                                                  | Inside `tm.Start`?                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `App/Modules/Habit/Data/HabitRepository.cs:219-226` (`Create`)     | habits per tier                                        | `BeginTransactionAsync()`, the Npgsql default READ COMMITTED | no. Called from `HabitService.Create` (`Domain/Habit/Service.cs:28-32`), which has no `tm.Start`             |
| `App/Modules/Vacation/Data/VacationRepository.cs:46-51` (`Create`) | vacation windows per year                              | `BeginTransactionAsync()`, READ COMMITTED                    | no. Called from `App/Modules/Vacation/VacationService.cs:17-28`, which has no `tm.Start`                     |
| `App/Modules/Check/Data/CheckRepository.cs:252-255` (`Settle`)     | skips per month (via `Skip`), and one settle per check | `BeginTransactionAsync()`, READ COMMITTED                    | no. Its callers (`CloseDue`, `Report`, `Skip`, `MoveToTimezone` from `Configuration.Update`) are not wrapped |

- `tm.Start` (REPEATABLE READ, `App/Modules/System/TransactionManager.cs:11-13`) wraps only these: user create, update and purge, configuration create, and the habit overview (`Domain/User/Service.cs:30,38,50,65`, `Domain/Configuration/Service.cs:29`, `Domain/Habit/HabitOverviewService.cs:33`).
- None of them takes the user lock or counts a quota.
- No setting changes the default isolation level: there is no `default_transaction_isolation` and no `IsolationLevel=` in the repo.

## The mechanism, proven on real Postgres 17

The test runs LazyTax's exact statement order in 2 sessions, the second starting 0.3 s after the first:

1. `SET LOCAL lock_timeout`
2. `pg_advisory_xact_lock(hashtextextended('user:u1', 0))`
3. count, then insert if under the limit (limit 1)
4. hold for 1 s, then commit

| Isolation       | Rows written with a limit of 1 |
| --------------- | ------------------------------ |
| REPEATABLE READ | **2** (both requests passed)   |
| READ COMMITTED  | 1 (correct)                    |

- **Why:** at REPEATABLE READ, the snapshot is taken by the first real statement. That statement is the lock call itself, so the snapshot exists before the lock is granted. `SET` does not take a snapshot.
- The waiting request then counts from a snapshot older than the first request's commit.
- The repro files are in `isorepro/`.

## Why it still matters for LazyTax

- It is one refactor away. Wrap habit create in `tm.Start` and the guard silently breaks; nothing fails, and the quota just stops holding. That is a natural move, for example to make create plus RetimePending atomic.
- `UserLock.cs` says nothing about isolation. Suggested guard: in `LockUser`, assert `IsolationLevel == ReadCommitted`, or use the kernel's try-lock-then-rerun.
- The .NET kernel builder in this experiment got the same fix: units default to READ COMMITTED.

## About "prove it with a concurrent test against the .NET app"

- LazyTax has no exposed call site, so a test against the real app would only prove the safe path.
- The mechanism proof above uses LazyTax's exact SQL sequence.
- A concurrent app-level test of the fix is in the Bun kernel (`tests/integration/uow.test.ts`: two overlapping units write 1 row at both levels). The .NET kernel is adding the same test.
