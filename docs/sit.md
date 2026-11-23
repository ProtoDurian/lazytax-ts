# SIT: black-box tests with Bruno

`task sit` runs the real app as a separate process and calls it over HTTP with Bruno.

## What `task sit` does

1. Starts (or reuses) Postgres in Docker (label `lazytax-model=1`, port `LAZYTAX_PG_PORT`) and creates a fresh database.
2. Starts mock Logto, a local issuer with a JWKS and a `POST /token` that mints tokens. No real Logto, no secrets.
3. Starts the app: `bun src/index.ts migrate api worker` with `PORT`, `DATABASE_URL`, `AUTH_*` set. It waits for `GET /health`.
4. Runs every collection with `bunx @usebruno/cli@<pinned> run`, writing one JUnit file per collection to `reports/sit/`.
5. Stops everything, even when a collection fails or the app never starts: app, mock Logto, database, and the Postgres container if this run started it.

The Bruno version is pinned in one place: `BRUNO_VERSION` in `tools/sit.ts` (override with `SIT_BRUNO_VERSION`).

`bun tools/sit.ts --only <text>` runs only collections whose path contains the text.

## Which collections run

A collection is a folder with a `bruno.json`. These are found:

- `contexts/<name>/tests/sit/`: one per context. Each context adds its own.
- `tests/sit/`: the kernel's own (health, 401, 403).
- `tests/sit-flows/`: flows across contexts (below).

## Tokens: your `.bru` files only name a user

Every collection gets these variables (Bruno `--env-var`), so no `.bru` file mints a token:

| Variable                 | Meaning                                          |
| ------------------------ | ------------------------------------------------ |
| `baseUrl`                | the app, for example `http://127.0.0.1:41233`    |
| `subA`, `tokenA`         | user A, scope none                               |
| `subB`, `tokenB`         | user B, scope none                               |
| `subC`, `tokenC`         | user C (use it when the test deletes the user)   |
| `subAdmin`, `tokenAdmin` | an admin: scope `admin`                          |
| `tokenExpired`           | A's token, already expired (must give 401)       |
| `logtoUrl`               | mock Logto; `POST {{logtoUrl}}/token` mints more |

A request picks a user in its auth block:

```
auth:bearer {
  token: {{tokenB}}
}
```

Need another user or scope? Add a request that posts `{ "sub": "x", "scope": "admin plus" }` to `{{logtoUrl}}/token` and keep `res.body.access_token` with `bru.setVar`.

Users A, B and C are per collection: each collection gets its own subs (`sit-<collection path>-a`), so one collection's configuration or completions never reach another. The admin is shared. Within one collection the users are shared by its requests, and the flows in `tests/sit-flows/` share theirs. Use `subC` for a test that deletes an account.

## Rules for a context's collection

- Cover the happy path, the 401 (no token), the 403 (another user's `userId` in the path, or a non-admin on an admin route) and the 404 (another user's id).
- Do not depend on another collection's data. Create what you need.

## Cross-context flows (`tests/sit-flows/`)

| Flow                   | What it proves                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `flow1-missed-habit`   | sign up, configuration, habit with a stake, a tick before the deadline: no failed execution, no penalty inbox item |
| `flow2-skip-ownership` | user B skipping user A's habit version gets 404, and A has no new execution                                        |
| `flow3-delete-account` | after `DELETE /api/v1/User/Me` user C's habits and inbox are gone and admin search finds no user                   |

They use LazyTax's paths and bodies. What the sweep confirmed against the real contexts:

- Sign up posts the user's token as both `idToken` and `accessToken` (account ignores the body). A second sign-up is 409, so flow 2 (which reuses user A) accepts 200 or 409.
- Times are `HH:mm:ss` (LazyTax `TimeOnly`); `HH:mm` is a 400.
- **"Missed" cannot be reached in real time.** check never opens a day whose deadline has already passed (a habit created after its deadline), and it settles a day only 30 minutes after the deadline. So flow 1 in SIT stops before the deadline, and the rest of flow 1 runs with a movable clock in `tests/integration/flow-missed-habit.test.ts` (full app, same routes and bodies): tick past deadline + grace, the execution is `failed` with `paymentProcessed: false` and the penalty is `pending`; then the penalty worker charges it through the fake Airwallex (the user has a verified consent) and the inbox gets a `penalty_charged` item.
- "Penalty pending" is the execution with `status: failed` and `paymentProcessed: false` (LazyTax has no penalty HTTP route). Without a payment consent LazyTax skips the penalty and posts nothing.

## The log-file test

`tests/logfile/logfile.test.ts` (`task test:logfile`) starts the app with `LOG_FILE` set and asserts on the file: one JSON line per request with context, route or tool, sub, request id, status and duration; no token, email or request body; an error at error level with its problem type; an MCP `tools/call` with its tool name.

## Testing the harness without the app

`SIT_APP_CMD="bun path/to/stand-in.ts"` replaces the app. The stand-in reads `PORT`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `LOG_FILE`.
