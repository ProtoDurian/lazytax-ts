// defineContext: the one thing a context's src/register.ts exports (as default).
//
//   export default defineContext({
//     config: VacationConfig,                    // optional zod schema with defaults
//     migrations: 'src/data/migrations',         // optional; relative to the context folder
//     build: ({ deps, uow, outbox, log, config, clock, users }) => {
//       const repo = new VacationRepository(uow);
//       const service = new VacationService(repo, deps.get('plan.v1'), deps.get('account.v1'), uow, clock);
//       return {
//         provides: { 'vacation.v1': service },  // = context.yaml provides
//         http: vacationRoutes(service),
//         mcp: vacationTools(service),
//         users: { purgeUser: (userId) => repo.purge(userId) },
//         subscribers: [],
//         workers: [],
//       };
//     },
//   });
//
// The kernel calls `build` once per context, in `needs` order, so `deps.get(...)` always returns
// a contract that is already built. `deps.get` refuses a contract not listed in context.yaml.
import type { z } from 'zod';
import type { Outbox, SubscriberDef } from './db/outbox';
import type { UnitOfWork } from './db/uow';
import type { RouteDef } from './http/route';
import type { Logger } from './log';
import type { ToolDef } from './mcp/tool';
import type { ContractId, ContractRegistry } from './registry';

export interface Deps {
  get<K extends ContractId>(id: K): ContractRegistry[K];
}

export interface Clock {
  now(): Date;
}

// The three kernel user hooks. Every context that stores user data registers `purgeUser`.
// Contexts register them here, so nobody needs a contract to take part in account deletion.
export interface UserHooks {
  // Runs first; any throw blocks the deletion (e.g. penalty: outstanding debt -> 409).
  deleteGuard?: (userId: string) => Promise<void>;
  // Runs after every guard passed, OUTSIDE any unit of work, best effort: a throw is logged and
  // ignored (e.g. payment: revoke consents at the gateway).
  beforePurge?: (userId: string) => Promise<void>;
  // Runs INSIDE account's one unit of work: delete (or anonymise) every row of this user.
  // Must be idempotent: a missing user is not an error.
  purgeUser?: (userId: string) => Promise<void>;
}

// How account runs deletion: users.deleteGuard -> users.beforePurge -> uow.run(users.purgeUser).
// Each runs every context's registered hook. Any context may read it; only account should call it.
export interface UserLifecycle {
  deleteGuard(userId: string): Promise<void>;
  beforePurge(userId: string): Promise<void>;
  // Throws outside uow.run.
  purgeUser(userId: string): Promise<void>;
}

export interface WorkerDef {
  // Unique within the context; logged as "<context>.<name>".
  name: string;
  everyMs: number;
  // Runs in its own unit of work unless tx: false. A throw is logged; the worker keeps ticking.
  // Must be idempotent: several replicas may tick at once.
  tick: (now: Date) => Promise<void>;
  tx?: boolean;
}

export interface ContextSetup<C> {
  // The context's name from context.yaml.
  name: string;
  deps: Deps;
  uow: UnitOfWork;
  outbox: Outbox;
  users: UserLifecycle;
  log: Logger;
  config: C;
  clock: Clock;
}

export type Provides = Partial<{ [K in ContractId]: ContractRegistry[K] }>;

export interface ContextParts {
  provides?: Provides;
  http?: RouteDef[];
  mcp?: ToolDef[];
  users?: UserHooks;
  // biome-ignore lint/suspicious/noExplicitAny: each subscriber is typed by its own event
  subscribers?: SubscriberDef<any>[];
  workers?: WorkerDef[];
}

export interface ContextDefinition<C = unknown> {
  readonly kind: 'lazytax.context';
  readonly config?: z.ZodType<C>;
  readonly migrations?: string;
  readonly build: (k: ContextSetup<C>) => ContextParts;
}

type NoConfig = Record<string, never>;

export function defineContext<S extends z.ZodType = z.ZodType<NoConfig>>(def: {
  config?: S;
  migrations?: string;
  build: (k: ContextSetup<z.output<S>>) => ContextParts;
}): ContextDefinition<z.output<S>> {
  return { kind: 'lazytax.context', ...def } as ContextDefinition<z.output<S>>;
}
