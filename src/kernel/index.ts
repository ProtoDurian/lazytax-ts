// @lazytax/kernel: everything a context may import. Contexts import nothing else from the kernel.
export type { Principal } from './auth/principal';
export type { KernelConfig } from './config';
export { type OutboxEvent, type Outbox, type OutboxEventInput, type SubscriberDef, subscribe } from './db/outbox';
export type { Isolation, RunOptions, UnitOfWork } from './db/uow';
export {
  type Clock,
  type ContextDefinition,
  type ContextParts,
  type ContextSetup,
  defineContext,
  type Deps,
  type Provides,
  type UserHooks,
  type UserLifecycle,
  type WorkerDef,
} from './define';
export {
  conflict,
  notFound,
  Problem,
  type ProblemInit,
  type ProblemJson,
  type ProblemKind,
  preconditionFailed,
  unauthenticated,
  unauthorized,
  userBusy,
  validationFailed,
} from './errors';
export {
  type Guard,
  type GuardCall,
  guard,
  type HttpMethod,
  type ParamsOf,
  type PolicyName,
  type RouteCall,
  type RouteDef,
  route,
} from './http/route';
export type { LogFields, Logger } from './log';
export { type ToolCall, type ToolDef, tool } from './mcp/tool';
export { Owner, ownerFilter } from './owner';
export type { ContractId, ContractRegistry, EventRegistry, EventType } from './registry';
// One zod for every context (request bodies, MCP inputs, config), so versions never drift.
export { z } from 'zod';
