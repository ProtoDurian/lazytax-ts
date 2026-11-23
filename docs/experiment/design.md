# LazyTax on the bounded-context model: first answers (Phase A)

Sun 22 Nov 2026, Pacific. Baseline: LazyTax = AtomiCloud/alcohol.zinc @ 934d8c3 (release 1.43.2). Paths below are relative to that repo unless marked.

**Short answer: the model fits LazyTax.** Contexts call each other only through contracts, in-process. One unit of work, carried implicitly (TransactionScope in .NET, AsyncLocalStorage in Bun, `context.Context` in Go, a Zone in Dart), makes several contexts' writes one Postgres transaction. Account stays local. Plan splits: billing goes external later, entitlement checks stay local. Email delivery goes external; the inbox stays local. Auth is 5 layers in a fixed order, each declared by the context that owns it.

---

## 1. Cross-context calls and transactions

**Rule:** a context owns its tables, repositories and services. Another context may call its **contract** (a typed service interface in `contract/v1`), never its repository or tables. The calls are in-process, so they cost nothing.

**What LazyTax does today (the thing to fix):**

- `Domain/Check/Service.cs:10-17`: `CheckService` takes `IVacationRepository` and `IProtectionRepository`, which are two other areas' repositories.
- The check repository (`App/Modules/Check/Data/`, `ListSchedulableHabits`) reads `db.Habits`, `db.HabitVersions` and `db.Configurations` directly. Those are three other areas' tables.
- `App/Modules/Users/Data/UserRepository.cs:170+` (`DeleteAllRemnants`) deletes rows from every area's tables in one method.

**The same thing on the new model:**

```ts
// contexts/check/src/domain/settle.ts
const status = (await vacation.isAway(userId, date))
  ? 'vacation' // vacation.v1 contract
  : (await protection.tryConsumeFreeze(userId, date))
    ? 'frozen' // protection.v1 contract
    : 'missed';
```

**One real flow that crosses contexts: a check settles as missed** (`Domain/Check/Service.cs:52-120`, `PenaltyStakeBinding.cs`)

1. check: the scheduler finds a pending check past deadline plus grace.
2. habit: reads the habit's schedule and the user's timezone (account).
3. vacation, then protection: is the user away? If not, spend one freeze (capped by plan, `FreezeCapService`).
4. check: writes the execution and an outbox row (`CheckEvents`).
5. penalty: the dispatcher hands the event to `PenaltyStakeBinding`, which enqueues a penalty.
6. payment: charges it later through Airwallex. This is an HTTP call, so it runs **outside** any transaction.

**Account deletion is the flow that needs one transaction across contexts** (`Domain/User/Service.cs:53-66`):

- the debt gate reads penalty;
- the Airwallex consent revoke is HTTP, so it runs **outside** the transaction;
- the purge runs **inside** one `tm.Start`.
- New model: every context's contract has `purgeUser(userId)`. The account context runs them all in one unit of work.

**Transactions, per language**

| Language             | Unit of work                                                                                                                       | How a repository finds it                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| .NET (LazyTax today) | `ITransactionManager.Start` → `TransactionScope(Required, RepeatableRead, AsyncFlow)` (`App/Modules/System/TransactionManager.cs`) | Npgsql enlists in the ambient scope by itself             |
| Bun                  | `uow.run(fn)` → `sql.begin(tx => als.run({tx}, fn))`                                                                               | `uow.db()` = the tx in `AsyncLocalStorage`, else the pool |
| Go                   | `uow.Do(ctx, fn)` → `pool.BeginTx` and `context.WithValue(ctx, txKey, tx)`                                                         | `q(ctx)` = the tx in ctx, else the pool                   |
| Dart                 | `uow.run(fn)` → `conn.runTx(tx => runZoned(fn, zoneValues: {#tx: tx}))`                                                            | `Zone.current[#tx] ?? pool`                               |

Bun example (the kernel ships this, contexts only call it):

```ts
const als = new AsyncLocalStorage<{ tx: TransactionSQL }>();
export const uow = {
  run: <T>(fn: () => Promise<T>) =>
    als.getStore()
      ? fn() // join, like TransactionScopeOption.Required
      : sql.begin(async tx => {
          await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
          return als.run({ tx }, fn);
        }),
  db: () => als.getStore()?.tx ?? sql,
  lockUser: (id: string) => uow.db()`SELECT pg_advisory_xact_lock(hashtextextended(${'user:' + id}, 0))`,
};
```

**Rules carried over from LazyTax's own comments:**

- One connection per transaction. Npgsql cannot promote to a distributed transaction (`Domain/User/Service.cs:55-62`), and neither can Bun, Go or Dart.
- So every context must share **one database** to join a transaction. A context with its own database cannot take part; it gets an outbox event instead.
- No HTTP, Logto, payment or notification call inside a transaction, and none while the user lock is held (`App/StartUp/Database/UserLock.cs:7-11`). Side effects go to an outbox, which is already how `CheckEvents` works.
- The per-user advisory lock (`UserLock.LockUser`) moves into the kernel as `uow.lockUser(id)`. Every "count, then write" rule takes it first.
- **Correction found in the build (madalynn):** under REPEATABLE READ the snapshot is taken by the lock statement itself, before the lock is granted, so "lock, count, write" can let two requests through. Units now default to READ COMMITTED, which is what LazyTax's own lock-then-count repositories run (`App/Modules/Habit/Data/HabitRepository.cs:219` `BeginTransactionAsync`). In an RR unit, `lockUser` tries the lock first, and if it has to wait, the whole unit reruns.
- RepeatableRead can fail with SQLSTATE 40001. The kernel retries the whole unit of work, at most 3 times.

## 2. Plan, notification, account

**What "account" covers in LazyTax today** (tables from `App/StartUp/Database/MainDbContext.cs`):

| Table                                 | Holds                                                                                                    | Used by                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Users`                               | JWT sub as id, username, email, email-verified, scopes, active (`App/Modules/Users/Data/UserData.cs`)    | every area: about 10 tables have a foreign key to it    |
| `Configurations`                      | timezone, end of day, default charity                                                                    | check (which local day it is), habit, penalty (charity) |
| Logto custom claims                   | `alcohol_zinc`, `configuration_id`, `has_payment_consent` (`App/StartUp/Registry/AuthPolicies.cs:16-21`) | the app reads them from the JWT to skip lookups         |
| (no table) delete account             | debt gate, then consent revoke, then purge of every table                                                | users                                                   |
| `PaymentCustomers`, `PaymentConsents` | Airwallex customer and consents                                                                          | penalty charges and subscription charges                |

**What "plan" covers:** `UserSubscriptions` (tier, status, period, cancel-at-end, next tier, last charge) plus the tier catalog in config (`App/StartUp/Registry/SubscriptionTiers.cs`). Entitlement (`Domain/Entitlement/IService.cs`) turns it into limits: habit quota, skip quota, vacation-window quota, freeze cap, and the minimum tier for each proof plugin.

**What "notification" covers:** `InboxNotifications` (the in-app feed, with an actor user for friend events) and `IEmailNotifier` over SMTP. Callers: friend, penalty, subscription, payment webhook, friend stake.

**Verdict**

| Part                                                     | Where                                                                                                        | Why                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Login, email verify, roles                               | **external already** (Logto)                                                                                 | it issues the JWT; the app never stores passwords                                                                                 |
| Account profile and settings (`Users`, `Configurations`) | **local** context `account`                                                                                  | every ownership filter joins to `user_id`, and every check settle reads the timezone. Over the network that is one call per check |
| Delete account                                           | **local**, in `account`                                                                                      | the purge must be one transaction over every context's tables                                                                     |
| Plan billing (subscribe, renew, grace, charge)           | **external later**, a shared billing service (`needs: [billing.v1]`, as in the module study's services page) | the same in every product; Stripe or Airwallex move the money                                                                     |
| Entitlement (quotas, tier checks)                        | **local** context `plan`                                                                                     | checked on every create, skip and vacation, inside the user lock, in the same transaction as the count                            |
| Payment for penalties (Airwallex consents)               | **local** context `payment`                                                                                  | it is LazyTax's own product money (charity stakes), not the plan                                                                  |
| Email delivery                                           | **external** (shared notifier)                                                                               | it is always a side effect, so it already has to leave the transaction through the outbox                                         |
| Inbox feed                                               | **local** context `notification`                                                                             | it is a user-facing list that joins friend data                                                                                   |

- For the TypeScript build, `plan` is a local context behind a `plan.v1` contract. Swapping it for the billing service later is a change in config, not in code.

## 3. Registration (controllers, MCP endpoints, the wiring file, dependency.yaml)

**The context declares; the kernel wires.** There is no hand-edited shared list.

```yaml
# contexts/vacation/context.yaml   (the wiring file)
id: ctx_7f3k2q # random, never changes
name: vacation
needs: [account.v1, plan.v1] # contracts it calls
provides: [vacation.v1]
uses: [postgres.main] # must exist in dependency.yaml
http: { prefix: /api/v1/vacation }
mcp: { prefix: vacation }
```

```ts
// contexts/vacation/src/register.ts
export default defineContext({
  provides: { 'vacation.v1': deps => new VacationService(deps['plan.v1'], deps['account.v1']) },
  http: [vacationController], // routes, each with its policy (see 4)
  mcp: [listVacationsTool, createVacationTool],
  migrations: './data/migrations', // SQL files, one folder per context
  workers: [],
});
```

- `tools/gen.ts` runs on `bun install`. It writes `src/generated/contexts.ts`, which imports every `register.ts`. That file is not committed (A372).
- The kernel orders contexts by `needs` and refuses a cycle or a missing contract. The error names the context and its folder.
- **HTTP:** the kernel mounts each controller under its prefix. A route without a policy fails the start.
- **MCP:** the kernel serves one MCP endpoint at `/mcp` (streamable HTTP). Tools are named `vacation.create`. A tool calls the same service method as the controller, with the same principal, so the policy and the ownership filter are the same.
- **dependency.yaml** stays **one per service** (the deployed app), not one per context. It lists infrastructure: `postgres.main`, `redis.cache`, `s3.proof`, `smtp`, with `shared: true` for what carbon owns. A context's `uses:` must name an entry there; the check refuses one that is missing.

## 4. Authorisation: 5 layers, always in this order

| #   | Check                                                                            | Where it lives                                           | How a context declares it          | LazyTax today                                                                     |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| 1   | JWT valid (issuer, audience, expiry)                                             | kernel middleware                                        | nothing                            | `App/StartUp/Services/Auth/AuthExt.cs`                                            |
| 2   | role or scope from the JWT (`scope` has `admin`)                                 | kernel, per route                                        | `policy: admin` or `registered`    | `[Authorize(Policy = AuthPolicies.OnlyAdmin)]`                                    |
| 3   | subject: the `{userId}` in the path is the token's `sub`, or the caller is admin | kernel, per route                                        | `subject: userId`                  | `Guard` / `GuardOrAny` in `App/Modules/Common/BaseController.cs:117-170`          |
| 4   | ownership: the row belongs to the user                                           | the context's repository, as SQL                         | an owner-scoped repository         | `repo.Update(habitId, userId, …)`                                                 |
| 5   | business rules: plan, skips, freezes, vacation, debt                             | the owning context's domain, called through its contract | a guard list on the service method | `HabitService.SkipHabit`, `CheckService.ProtectionFor`, `UserService.GuardNoDebt` |

**Layer 4, ownership as a filter, including chains through foreign keys.** The repository never takes an id on its own; it always takes the owner too.

```sql
-- skip: user 1 wants habit version 5; the chain is version → habit → user
SELECT hv.* FROM habit_versions hv
JOIN habits h ON h.id = hv.habit_id
WHERE hv.id = $5 AND h.user_id = $1;        -- 0 rows → 404, never 403, so nothing leaks
```

- A chain that crosses contexts (a penalty → its execution → the habit) is not a cross-context join. Each step asks the next context's contract `owns(userId, id)`, or the row keeps a copy of `user_id`. LazyTax already copies `UserId` onto `Penalties` and `FreezeConsumptions`.
- A bug to fix on the way: `HabitService.SkipHabit` (`Domain/Habit/Service.cs:93-97`) loads the version by id only and relies on a later step to filter by user. In the new model the first read is already owner-scoped.

**Layer 5, LazyTax's own rules, in the order they run:**

1. **Plan:** cheap reads first, and a "no" stops here. `plan.ensure(userId, "habits.enable")` or `plan.minTier(plugin)` (`Domain/Entitlement/IService.cs`).
2. **Debt gate** (delete account only): `penalty.outstanding(userId) == 0`.
3. **Lock** `uow.lockUser(userId)`, then **count, then write** in the same transaction: the skip quota per month (`HabitRepository.CountSkips`), the habit quota, the vacation-window quota. The count and the write must sit under one lock, or two requests both pass.
4. **At settle time:** vacation first, then one freeze per day (capped by plan), else missed (`Domain/Check/Service.cs:111-123`).
5. **Side effects after commit:** the penalty, email and inbox go through the outbox.

How a context declares them:

```ts
http.post('/:userId/habits/:versionId/skip', {
  policy: 'registered',
  subject: 'userId',
  guards: [plan.quota('skips')], // layer 5, step 1
  handler: (p, req) => habit.skip(p.sub, req.params.versionId),
}); // steps 3-5 inside
```

- Layers 1 to 3 are data on the route, so the kernel can print a table of every route with its policy. A route with none is an error, not a default. This answers "auth policies clean".

## 5. What to split and what not

| Thing                             | Split?                                       | Why                                                                |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Logto (login, roles)              | already external                             | it issues the JWT                                                  |
| account (users, settings, delete) | **no, local**                                | the hub of every foreign key and ownership filter                  |
| plan: billing                     | **yes, later**: shared billing service       | the same in every product                                          |
| plan: entitlement checks          | **no, local**                                | on every write, under the user lock                                |
| notification: email and push      | **yes**: shared notifier, via the outbox     | always a side effect                                               |
| notification: inbox               | **no, local**                                | joins friend data                                                  |
| payment (Airwallex, penalties)    | **no, local context**                        | product money; HTTP stays outside transactions                     |
| habit vs check                    | **two contexts**                             | check reads habits through `habit.listSchedulable`, not the tables |
| vacation, protection (freezes)    | **own contexts**                             | both are called by check settle and by plan                        |
| penalty, disbursement, charity    | **own contexts**                             | money flow; the outbox binding stays                               |
| friend, friend stake              | **own contexts**                             | friend stake is a second stake binding                             |
| proof (NFC, Strava, manual)       | **one context, plugins inside**              | `IProofRouter` is already a plugin router                          |
| database                          | **no**: one Postgres, one schema per context | a transaction across contexts needs one connection                 |
| migrations                        | **split**: one folder per context            | two new tables merge cleanly (A372)                                |
| `dependency.yaml`                 | **no**: one per service                      | it describes infrastructure, not contexts                          |
| contracts                         | **split**: `contract/v1` per context         | the only thing others import                                       |

## 6. What nitroso (production) adds

Paths are relative to the nitroso repos. It has the same .NET shape as LazyTax and the same `TransactionManager`, so it shows the same strengths and the same gaps.

| Lesson                                                                                                                                    | nitroso evidence                                                                                                                   | In the TypeScript build                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Services take other areas' repositories, the same smell as LazyTax                                                                        | `zinc/Domain/Booking/Service.cs:83`: `BookingService` takes the wallet and transaction repositories inside one `transaction.Start` | `wallet.v1` and `ledger.v1` contracts inside one `uow.run`                                                                   |
| Signal **after** commit, best effort, no payload; readers re-read the database                                                            | `.DoAwait(DoType.Ignore, _ => cdcRepository.Add("create"))` after the transaction (Redis `XADD`, capped by length)                 | outbox row in the transaction, sent after commit                                                                             |
| Calls to the payment gateway in 3 phases: claim in a tx, HTTP outside with key `{id}-{attempt}`, write back only if the claim still holds | `zinc/Domain/Withdrawal/Service.cs:414-560`                                                                                        | the payment context copies it for Airwallex charges                                                                          |
| Auth policies **in config**, issuer pinned                                                                                                | `zinc/App/Config/settings.yaml` `Policies: OnlyAdmin { Target: [admin], Type: All, Field: roles }`                                 | `policies.yaml` per context, the same shape                                                                                  |
| A machine role for service accounts                                                                                                       | `AdminOrTin` (role `tin`)                                                                                                          | `policy: admin-or-service`                                                                                                   |
| **Do not copy:** `userId == null` means "every user" in the repository                                                                    | `zinc/App/Modules/Booking/Data/BookingRepository.cs:373`                                                                           | the repository takes an `Owner` type, never a nullable string. Admin passes `Owner.anyone()` explicitly, and a lint finds it |
| **Do not copy:** no retry on 40001, no rate limit, webhook signature compared with `==`                                                   | nitroso's notes                                                                                                                    | the kernel retries the unit of work; constant-time compare; rate limit per `sub`                                             |
| Workers: a fresh scope per tick, never crash the API, idempotent so several replicas are safe                                             | `zinc/App/Modules/Payments/GatewayFeeSyncWorker.cs`                                                                                | a context declares `workers:`; the kernel runs each tick in its own unit of work                                             |

---

## Phase B plan and ETA (honest)

**Scope.** LazyTax's API in TypeScript on Bun, starting from bun-base. The contexts are those in section 5: 13, about 180 .NET files to port. Two rounds:

| Round                  | Contexts                                                                                           | Builders                          | Wall time |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- | --------- |
| 0, the kernel and auth | kernel (wiring, gen, unit of work, user lock, outbox, policies, MCP host, mock Logto), account     | 1 Opus                            | about 3 h |
| 1, the core            | habit, check, vacation, protection, plan, penalty, charity                                         | 4 Sonnet, parallel, a branch each | about 4 h |
| 2, the rest            | payment (Airwallex mocked), friend and friend stake, notification, proof, disbursement             | 3 Sonnet                          | about 3 h |
| 3, the edges           | Bruno SIT per context, the log-file test, CI on free GitHub runners, lint, types, the policy table | 1 Sonnet plus me                  | about 2 h |

- **The conflict log:** each builder works on its own branch and merges the way real work does. Every conflict is logged (file, kind, minutes, tokens) in `CONFLICTS.md`.
- **Total: about 12 h of wall time, so first green locally at about 9 AM Pacific Mon 23 Nov.** CI comes after that, once jaeda creates the ProtoDurian repo.
- **Risk 1:** LazyTax's Bruno tests are not in alcohol.zinc (no `.bru` files there), so the SIT suite gets written fresh, from the controllers.
- **Risk 2:** porting 1:1 is big. If round 2 runs late, the core round still proves the model, and round 2 then becomes the owner's "add a feature" test.
