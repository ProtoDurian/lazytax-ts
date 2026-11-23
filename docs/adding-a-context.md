# Adding a context

A context is one folder under `contexts/`. It owns its tables, its routes, its MCP tools and its
contract. The kernel finds it, checks it and wires it. You never edit a shared file by hand.

**Copy the reference contexts:** `contexts/vacation` shows every pattern (contract calls, lock,
count then write, owner-scoped repository, purge hook, outbox). `contexts/account` and
`contexts/plan` show the rest (admin routes, a foreign-key ownership chain, config).

Commands (run inside the dev shell: `direnv exec . <cmd>`):

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `bun install`                       | links your packages and regenerates `src/generated/contexts.ts` |
| `task typecheck`                    | `tsc --noEmit` over everything                                  |
| `task lint`                         | biome, 0 warnings                                               |
| `task boundaries`                   | import rules + owner-scoped repositories                        |
| `task policies`                     | prints every route and tool with policy, subject and guards     |
| `task test:unit -- contexts/<name>` | your unit tests                                                 |
| `task test:int -- contexts/<name>`  | your integration tests (starts Postgres)                        |
| `task sit`                          | Bruno SIT for every context                                     |
| `task check`                        | all of the above                                                |

- Set `LAZYTAX_PG_PORT` to your lane's Postgres port (kernel: 55430) before any integration test or SIT.
- Every `bun test` goes through the box slot queue; the tasks already do it. If you run `bun test`
  by hand, prefix it: `slot.sh bun-ts timeout 300 bun test <files>`.

---

## 1. The folder

```
contexts/<name>/
  context.yaml          # the wiring file
  package.json          # @lazytax/<name>
  contract/
    package.json        # @lazytax/<name>-contract
    v1/index.ts         # interfaces + DTO types + registry augmentation; nothing else
  src/
    register.ts         # export default defineContext(...)
    api/v1/             # routes (one file per controller) and request schemas
    mcp/                # tools
    domain/             # service, model, errors (no SQL, no HTTP)
    data/               # repository (SQL)
      migrations/       # 0001_init.sql, 0002_...sql
  policies.yaml         # optional: extra policies (same shape as the root one)
  tests/
    unit/               # no database
    integration/        # real Postgres, through @lazytax/kernel/testing
    sit/                # Bruno collection
```

`<name>` is lowercase letters and digits (`friendstake`, not `friend-stake`).

## 2. context.yaml

```yaml
id: ctx_q8d3n2 # ctx_ + 6 random lowercase letters/digits; never changes
name: habit # = the folder name
needs: [account.v1, plan.v1, charity.v1] # every contract you call (see lanes.md for your row)
provides: [habit.v1] # your contract(s): "<name>.v<N>"
uses: [postgres.main] # each must be in /dependency.yaml
http: { prefix: /api/v1/Habit } # LazyTax's controller path; /api/v1 if you own several controllers
mcp: { prefix: habit }
```

- The kernel builds contexts in `needs` order. A cycle, or a need nobody provides, stops the start
  with a message naming your context and folder. Use a kernel user hook or an outbox event instead
  of a need that would make a loop.
- Keep LazyTax's paths and casing (`/api/v1/Habit/{userId}/...`). Paths are case-sensitive.

## 3. The packages

`contexts/<name>/package.json`:

```json
{
  "name": "@lazytax/habit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/register.ts" },
  "dependencies": {
    "@lazytax/kernel": "workspace:*",
    "@lazytax/habit-contract": "workspace:*",
    "@lazytax/account-contract": "workspace:*",
    "@lazytax/plan-contract": "workspace:*",
    "@lazytax/charity-contract": "workspace:*"
  }
}
```

List your own contract and one contract per `needs` entry. No other npm packages unless you need
them; `zod` comes from the kernel (`import { z } from '@lazytax/kernel'`).

`contexts/<name>/contract/package.json`:

```json
{
  "name": "@lazytax/habit-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { "./v1": "./v1/index.ts" },
  "dependencies": { "@lazytax/kernel": "workspace:*" }
}
```

Then run `bun install`. It changes `bun.lock` (the one shared file) and regenerates
`src/generated/contexts.ts` (gitignored).

## 4. The contract (`contract/v1/index.ts`)

Interfaces and DTO types only, plus the registry augmentation that makes `deps.get('habit.v1')`
and your events typed everywhere:

```ts
import type { Owner } from '@lazytax/kernel';

export interface HabitVersionDto {
  id: string;
  habitId: string;
  userId: string; /* ... */
}

export interface HabitV1 {
  getVersion(owner: Owner, versionId: string): Promise<HabitVersionDto | null>;
  owns(userId: string, habitId: string): Promise<boolean>;
}

export interface HabitChanged {
  userId: string;
  habitIds: string[];
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'habit.v1': HabitV1;
  }
  interface EventRegistry {
    'habit.changed': HabitChanged;
  }
}
```

- Dates are strings: `"YYYY-MM-DD"` for local dates, ISO 8601 for instants. Money is integer cents + currency.
- `userId` arguments come only from trusted callers (other contexts, workers). A method that serves a
  user's request takes an `Owner`.
- Never rename or remove a member once merged. Add new ones.

## 5. register.ts

```ts
import '@lazytax/habit-contract/v1';
import { defineContext, z } from '@lazytax/kernel';
import { habitRoutes } from './api/v1/habit-routes';
import { HabitRepository } from './data/habit-repository';
import { HabitService } from './domain/habit-service';
import { habitTools } from './mcp/habit-tools';

export default defineContext({
  // Optional. Defaults here; override with env LAZYTAX_HABIT_CONFIG='{"maxNameLength":80}'.
  config: z.object({ maxNameLength: z.number().default(64) }),
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const repo = new HabitRepository(uow);
    const service = new HabitService(repo, deps.get('plan.v1'), deps.get('account.v1'), uow, outbox, clock, config);
    return {
      provides: { 'habit.v1': service }, // keys = context.yaml provides
      http: habitRoutes(service, deps.get('plan.v1')),
      mcp: habitTools(service, deps.get('plan.v1')),
      users: { purgeUser: userId => repo.purgeUser(userId) },
      subscribers: [],
      workers: [],
    };
  },
});
```

- `deps.get(id)` refuses an id that is not in your `needs`.
- `build` must not touch the database or the network; it only constructs objects.
- What `build` gets: `name`, `deps`, `uow`, `outbox`, `users`, `log` (already tagged with your
  context), `config`, `clock` (always use `clock.now()`, never `new Date()`, so tests can set time).

## 6. Migrations

- Files `src/data/migrations/0001_init.sql`, `0002_<what>.sql`, ... run in name order, once each.
  The kernel creates schema `<name>` before your first file and records each file's checksum in
  `kernel.migrations`. **Never edit a merged migration**: a changed checksum stops the start. Add a new file.
- Always write the schema: `CREATE TABLE habit.habits (...)`. Never touch another context's schema,
  and never add a foreign key into one (copy the `user_id` instead).
- Every row that belongs to a user has `user_id text NOT NULL` (the JWT sub) and an index on it.

```sql
CREATE TABLE vacation.vacation_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vacation_periods_user_id ON vacation.vacation_periods (user_id, start_date);
```

`bun src/index.ts migrate` runs every context's migrations in `needs` order.

## 7. Routes and policies (auth layers 1 to 3)

```ts
import { type Guard, Owner, route, z } from '@lazytax/kernel';

const CreateVacationReq = z.object({ startDate: z.string(), endDate: z.string(), timezone: z.string() });

export const vacationRoutes = (svc: VacationService, allowed: Guard) => [
  route.post('/:userId', {
    policy: 'registered', // required: 'public' | 'registered' | 'admin' | a policies.yaml name
    subject: 'userId', // :userId must equal the token's sub, unless the caller is admin
    guards: [allowed], // layer 5, see section 9
    body: CreateVacationReq, // a bad body is 400 validation_error
    handler: ({ params, body }) => svc.create(Owner.user(params.userId), body),
  }),
  route.delete('/:userId/:id', {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      await svc.delete(Owner.user(params.userId), params.id);
    }, // undefined -> 204
  }),
];
```

- Layer 1 (JWT: signature, issuer, audience, expiry) is the kernel's. A bad or missing token on a
  non-public route is 401.
- Layer 2 is `policy`. A route without one stops the start. `admin` = `scope` contains `admin`.
  Extra policies go in `contexts/<name>/policies.yaml`:
  ```yaml
  habit-service: { field: roles, type: any, target: [service, admin] }
  ```
- Layer 3 is `subject`: use it on every route with a `{userId}` path param (LazyTax `Guard` /
  `GuardOrAny`). A mismatch is 403. Routes with no `{userId}` and a `registered` policy act on the
  caller: use `Owner.user(principal.sub)`.
- The handler returns the 200 body; `undefined` is 204; a `Response` passes through.
- Errors: throw a `Problem` (or a helper: `notFound`, `validationFailed`, `unauthorized`,
  `unauthenticated`, `conflict`, `preconditionFailed`). The kernel maps: not_found 404,
  validation 400, unauthorized 403, unauthenticated 401, conflict 409, precondition 412, as
  LazyTax's BaseController does. The body is problem-details JSON with type
  `urn:lazytax:problem:<id>`. Anything else thrown is a 500 with no detail.
- Check yours with `task policies` (`bun tools/policies.ts --only <you>,<your needs>` while main still has stubs).
- Webhooks: the call also has `headers` (a `Headers`) and `rawBody` (the body text, read once) for
  signature checks; compare signatures in constant time (`crypto.timingSafeEqual`).
- The caller's verified token claims are on `principal.claims` (never log them).

## 8. MCP tools

One tool per user-facing action you want an agent to have; at least one per context. Same
policy, same subject, same guards, **same service method** as the route:

```ts
import { type Guard, Owner, tool, z } from '@lazytax/kernel';

export const vacationTools = (svc: VacationService, allowed: Guard) => [
  tool('create', {
    description: "Create a vacation window for a user (dates are the user's local dates)",
    policy: 'registered',
    subject: 'userId',
    guards: [allowed],
    input: z.object({ userId: z.string(), startDate: z.string(), endDate: z.string(), timezone: z.string() }),
    handler: ({ input }) => svc.create(Owner.user(input.userId), input),
  }),
];
```

The tool is served as `<mcp.prefix>.<verb>` (`vacation.create`) at `POST /mcp`. Clients send
`Accept: application/json, text/event-stream` and a JSON-RPC body (`initialize`, `tools/list`,
`tools/call`); the kernel uses the official `@modelcontextprotocol/sdk` (stateless, JSON responses).

## 9. The owner-scoped repository (layer 4)

Every repository method that reads or changes user data takes `owner: Owner` **first** and
filters on it **in the first query**. `task boundaries` fails on a method in `src/data/` that does
not. 0 rows is 404 (`notFound(...)`), never 403.

```ts
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';

export class VacationRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(owner: Owner, id: string): Promise<VacationRow | null> {
    const db = this.uow.db();
    const rows = await db`
      SELECT id, user_id, start_date::text, end_date::text, timezone, created_at
      FROM vacation.vacation_periods v
      WHERE v.id = ${id} ${ownerFilter(db, owner, 'v.user_id')}`;
    return rows[0] ?? null;
  }

  // The purge hook is the one method that takes a bare userId.
  async purgeUser(userId: string): Promise<void> {
    await this.uow.db()`DELETE FROM vacation.vacation_periods WHERE user_id = ${userId}`;
  }
}
```

- A chain through a foreign key filters with a JOIN on the row that holds `user_id`:
  ```sql
  SELECT hv.* FROM habit.habit_versions hv JOIN habit.habits h ON h.id = hv.habit_id
  WHERE hv.id = ${versionId} ${ownerFilter(db, owner, 'h.user_id')}
  ```
  See `contexts/plan/src/data/` (subscription change -> subscription -> user).
- A chain into another context is not a join: ask its contract (`habit.owns(userId, habitId)`) or keep a copy of `user_id`.
- `Owner.user(sub)` for a user; `Owner.anyone(principal)` for an admin route (throws unless admin);
  `Owner.system()` for workers and subscribers. There is no nullable user id anywhere.
- Ids in a path are not trusted: the first read of every request is owner-scoped (the LazyTax
  `SkipHabit` bug, `Domain/Habit/Service.cs:93-97`, is exactly a first read by id only).
- Data that belongs to no user (a charity catalog, a webhook queue): a repository file that never
  mentions `user_id` is not checked. A single exception in a user-data repository takes
  `// owner-exempt: <why>` on the line above the method.
- Bun.sql: bind JSON as `${JSON.stringify(x)}::text::jsonb` (a string bound to `::jsonb` is stored
  as a JSON string), bind arrays the same way and unpack with `jsonb_array_elements_text`, and
  select dates as `col::text` to keep `YYYY-MM-DD`. `check` is a reserved word: quote it, `"check".table`.

## 10. Layer-5 guards, the lock, and the unit of work

Order inside a request: policy -> subject -> body -> guards -> handler.

1. **Cheap reads first, as guards** on the route and the tool:
   ```ts
   const vacationAllowed = (plan: PlanV1) =>
     guard('plan:vacationWindows', async ({ userId }) => {
       const q = await plan.quota(userId, 'vacationWindows');
       plan.ensureWithin(q, 0); // a 0 limit refuses here, before any lock
     });
   ```
2. **Count, then write, under the user's lock**, in one unit of work, in the service:
   ```ts
   return this.uow.run(async () => {
     await this.uow.lockUser(owner.userId); // 409 user_busy after 5 s
     const used = await this.repo.countWindowsForYear(owner, year);
     this.plan.ensureWithin(await this.plan.quota(owner.userId, 'vacationWindows'), used);
     const row = await this.repo.create(owner, input);
     await this.outbox.add({
       type: 'vacation.created',
       payload: { userId: owner.userId, vacationId: row.id },
       userId: owner.userId,
     });
     return row;
   });
   ```

- `uow.run` joins an open unit or starts one at **READ COMMITTED** (the default), so a count after
  `lockUser` sees every write committed before the lock. `uow.run(fn, { isolation: 'repeatable read' })`
  opts in to RR; there `lockUser` reruns the unit when it had to wait. Contract calls made inside a
  unit join the same transaction. The kernel retries the whole unit on 40001/40P01 (3 attempts), so keep it
  free of in-memory side effects.
- **No HTTP inside a unit of work** (the kernel's fetch guard throws). Put side effects in the outbox.

## 11. The user hooks (account deletion)

Register in `build`'s `users`:

| Hook                  | When                                                                | Who                               |
| --------------------- | ------------------------------------------------------------------- | --------------------------------- |
| `deleteGuard(userId)` | first; a throw blocks the deletion                                  | penalty (outstanding debt -> 409) |
| `beforePurge(userId)` | outside any transaction, best effort; a throw is logged and ignored | payment (revoke consents)         |
| `purgeUser(userId)`   | inside account's one unit of work                                   | **every context with user data**  |

`purgeUser` deletes (or anonymises, for money ledgers) every row of the user in your schema, and
is idempotent. `task boundaries` fails a context whose migrations have a `user_id` column and that
registers no `purgeUser`.

## 12. Outbox events and subscribers

- Emit inside a unit of work: `await outbox.add({ type: '<name>.<event>', payload, userId })`.
  Only your own `<name>.` prefix is allowed. Declare the payload in your contract's `EventRegistry`.
- To subscribe to another context's event, depend on its contract package for the event type; it
  need not be in your `needs` (only `deps.get` calls do).
- Subscribe in `build`:
  ```ts
  subscribers: [
    subscribe('check.settled', async (e) => { await service.onSettled(e.payload, e.id); }),
    subscribe('penalty.charged', (e) => mailer.send(e), { tx: false }),   // HTTP: outside a unit
  ],
  ```
  Default (`tx: true`): your handler runs in its own unit of work together with marking the
  delivery done, so database writes happen exactly once. `tx: false`: at least once; be idempotent
  by `e.id`. Failures retry with backoff, up to 5 attempts, then the delivery is marked dead.
- In tests, `await app.drainOutbox()` dispatches everything due.

## 13. Workers

```ts
workers: [{ name: 'tick', everyMs: 60_000, tick: now => service.settleDue(now) }];
```

Each tick runs in its own unit of work (`tx: false` to opt out), never crashes the process, and
must be idempotent (several replicas may run). Workers run in `worker` mode.

## 14. The three kinds of test

**Unit** (`tests/unit/*.test.ts`): the domain with fakes for the repository and the contracts. No
database. Arrange / Act / Assert.

**Integration** (`tests/integration/*.test.ts`): real Postgres, the whole app in-process.

```ts
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ config: { plan: { tiers: { free: { vacationWindowsYearly: 2 } } } } });
});
afterAll(() => app.close());

it("should 404 user B on user A's vacation", () =>
  expectOwnerScoped(app, {
    seed: async a =>
      (await (await app.request(a, { method: 'POST', path: `/api/v1/Vacation/${a.sub}`, body })).json()).id,
    request: (id, b) => ({ method: 'PATCH', path: `/api/v1/Vacation/${b.sub}/${id}/end-today` }),
    unchanged: id => app.sql`SELECT * FROM vacation.vacation_periods WHERE id = ${id}`,
  }));
```

Required in every context:

- **One `expectOwnerScoped` test per entity** (per table a user owns), on the read or change that
  takes the id.
- A 401 (no token), a 403 (other user's `userId` in the path) and a 404 case.
- A `purgeUser` test: seed data as user A, call `DELETE /api/v1/User/Me` as A, then assert 0 rows
  of A in your schema (and B's rows untouched). Deletion runs every hook even when A never
  registered in account, so no account setup is needed.
- A unit-of-work test if you write under `lockUser` (two concurrent requests, one passes).

Helpers: `app.user()`, `app.admin()`, `app.token(sub, { scopes, expiresInSec, audience, claims })`,
`app.request(actor, { method, path, body, query, headers })`, `app.mcp(actor, 'vacation.create', args)`, `app.contract('plan.v1')`, `app.sql`,
`app.clock.set('2026-03-01T00:00:00Z')`, `app.drainOutbox()`, `expectProblem(res, 404, 'entity_not_found')`.

**SIT** (`tests/sit/`): a Bruno collection run by `task sit` against the real app process.

```
tests/sit/
  bruno.json            # { "version": "1", "name": "vacation", "type": "collection" }
  environments/local.bru
  01-create.bru  02-list.bru  03-forbidden.bru  ...
```

`task sit` starts Postgres, mock Logto and the app, mints tokens and passes these variables to
every collection: `baseUrl`, `subA`, `tokenA`, `subB`, `tokenB`, `subAdmin`, `tokenAdmin`,
`tokenExpired`. Cover the happy path **and** 401, 403 and 404.

## 15. Which shared files a new context touches

| File       | Why                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `bun.lock` | `bun install` adds your two workspace packages. On a merge conflict, take either side and run `bun install`. |

Nothing else:

- `src/generated/contexts.ts` is generated by `bun install` and not committed.
- Root `package.json` globs `contexts/*` and `contexts/*/contract`.
- `dependency.yaml` only changes if you need new infrastructure (none of the 13 contexts does).
- Config, policies and migrations live in your folder.
