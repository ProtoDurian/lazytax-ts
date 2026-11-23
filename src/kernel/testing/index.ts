// @lazytax/kernel/testing: helpers for integration tests (tests/integration in each context).
//
//   const app = await startTestApp();                 // fresh database, all contexts, mock Logto
//   const a = await app.user();                       // a registered user: { sub, token }
//   const res = await app.request(a, { method: 'GET', path: `/api/v1/Vacation/${a.sub}` });
//
//   // One per entity: user B gets 404 on user A's id at the first read, and nothing changes.
//   await expectOwnerScoped(app, {
//     seed: async (owner) => (await (await app.request(owner, create(owner))).json()).id,
//     request: (id, caller) => ({ method: 'PATCH', path: `/api/v1/Vacation/${caller.sub}/${id}/end-today` }),
//     unchanged: (id) => app.sql`SELECT * FROM vacation.vacation_periods WHERE id = ${id}`,
//   });
//
// Tests never import another context's src; they reach other contexts through `app.contract(...)`.
import type { SQL } from 'bun';
import type { UnitOfWork } from '../db/uow';
import type { ProblemJson } from '../errors';
import type { HttpMethod } from '../http/route';
import type { ContractId, ContractRegistry } from '../registry';
import type { MintOptions } from './mock-logto';

export { type MintOptions, type MockLogto, startMockLogto } from './mock-logto';

export interface Actor {
  sub: string;
  token: string;
}

export interface TestRequest {
  method: HttpMethod;
  // Full path, e.g. /api/v1/Vacation/<sub>
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  // Extra request headers (e.g. a webhook signature).
  headers?: Record<string, string>;
}

export interface McpResult {
  ok: boolean;
  // The tool's JSON result when ok.
  data: unknown;
  // The problem-details JSON when not ok.
  problem?: ProblemJson;
}

export interface TestApp {
  // Calls the app in-process (no port). actor null sends no token.
  request(actor: Actor | null, req: TestRequest): Promise<Response>;
  // Calls an MCP tool through POST /mcp, e.g. mcp(a, 'vacation.create', {...}).
  mcp(actor: Actor | null, tool: string, args: Record<string, unknown>): Promise<McpResult>;
  // A registered user with a random sub (or the one given).
  user(sub?: string): Promise<Actor>;
  // A user registered in account (POST /api/v1/User) with a token carrying username, email and
  // email_verified claims, and, when timezone is given, a configuration. Needs the account context.
  registeredUser(opts?: RegisterOptions): Promise<Actor>;
  // A user whose token has scope "admin".
  admin(sub?: string): Promise<Actor>;
  // Any token: bad audience, expired, extra scopes...
  token(sub: string, opts?: MintOptions): Promise<string>;
  // A built contract, to arrange state in another context or to test your own provides.
  contract<K extends ContractId>(id: K): ContractRegistry[K];
  uow: UnitOfWork;
  // The raw pool, for arrange/assert queries.
  sql: SQL;
  // The kernel clock every context sees. Starts at `now` (default: real time).
  clock: { now(): Date; set(at: Date | string): void };
  // Dispatches every due outbox delivery now (no waiting for the worker).
  drainOutbox(): Promise<void>;
  // Run one tick of a worker, the way the worker mode does (in a unit of work unless tx: false),
  // at clock.now(). Name it "<name>" or "<context>.<name>". A throw rejects (the runner would log it).
  tick(worker: string): Promise<void>;
  // Every log line written so far, as JSON strings.
  logs: string[];
  close(): Promise<void>;
}

export interface RegisterOptions {
  sub?: string;
  // Default: "u" + 8 random characters (unique per call).
  username?: string;
  // Default: "<username>@example.test".
  email?: string;
  // Also POST /api/v1/Configuration with this IANA timezone.
  timezone?: string;
}

export interface TestAppOptions {
  // Context names to load (with what they need). Default: all.
  contexts?: string[];
  // Per-context config overrides, e.g. { plan: { tiers: { free: { vacationWindowsYearly: 1 } } } }.
  config?: Record<string, unknown>;
  now?: Date | string;
}

export async function startTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const { startTestAppImpl } = await import('./app');
  return startTestAppImpl(opts);
}

// Asserts a response is a problem-details error with this status (and problem id, if given).
export async function expectProblem(res: Response, status: number, id?: string): Promise<ProblemJson> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected HTTP ${status}, got ${res.status}: ${text}`);
  const body = JSON.parse(text) as ProblemJson;
  if (id !== undefined && body.type !== `urn:lazytax:problem:${id}`)
    throw new Error(`expected problem ${id}, got ${body.type}: ${text}`);
  return body;
}

export interface OwnerScopedSpec {
  // Create the entity as `owner` (user A); return its id.
  seed: (owner: Actor) => Promise<string>;
  // The request user B (`caller`) makes on A's id. B uses B's own sub in the path, so layer 3
  // passes and only layer 4 (the owner-scoped first read) can stop it.
  request: (id: string, caller: Actor) => TestRequest;
  // Optional snapshot of A's rows; must be equal before and after B's request.
  unchanged?: (id: string) => Promise<unknown>;
}

// Proves layer 4 for one entity: user B gets 404 entity_not_found on user A's id, never 403,
// and A's data does not change. The guide requires one of these per entity.
export async function expectOwnerScoped(app: TestApp, spec: OwnerScopedSpec): Promise<void> {
  const a = await app.user();
  const b = await app.user();
  const id = await spec.seed(a);
  const before = spec.unchanged ? JSON.stringify(await spec.unchanged(id)) : undefined;
  const res = await app.request(b, spec.request(id, b));
  await expectProblem(res, 404, 'entity_not_found');
  if (spec.unchanged) {
    const after = JSON.stringify(await spec.unchanged(id));
    if (after !== before) throw new Error(`user B changed user A's data:\nbefore ${before}\nafter  ${after}`);
  }
}

// A fresh, empty database on the local test Postgres (LAZYTAX_PG_PORT, default 55430).
export async function testDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const { createTestDatabase } = await import('./db');
  return createTestDatabase();
}
