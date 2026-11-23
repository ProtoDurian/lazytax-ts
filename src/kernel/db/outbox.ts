// The outbox: side effects that must happen only if a unit of work commits.
//
//   await outbox.add({ type: 'vacation.created', payload: { vacationId }, userId });   // inside uow.run
//
// `add` writes the event row, and one delivery row per subscriber, in the CURRENT unit of work
// (it throws outside one). After commit the kernel's dispatcher (worker mode) hands each event to
// every subscriber that declared it, records each delivery per subscriber, retries with
// exponential backoff and stops after `maxAttempts` (the delivery is then marked dead).
//
// A subscriber either runs in its own unit of work together with marking its delivery done
// (`tx: true`, the default: exactly once for database writes), or outside any unit
// (`tx: false`: for HTTP calls such as email; at least once, so it must be idempotent by `event.id`).
import type { EventRegistry, EventType } from '../registry';

export interface OutboxEventInput<E extends EventType = EventType> {
  type: E;
  payload: EventRegistry[E];
  // The user the event is about, if any. Lets the account purge drop a user's pending events.
  userId?: string;
}

export interface OutboxEvent<E extends EventType = EventType> {
  id: string;
  type: E;
  payload: EventRegistry[E];
  userId: string | null;
  createdAt: Date;
  // 1 on the first delivery to this subscriber, 2 on the first retry, ...
  attempt: number;
}

export interface Outbox {
  // Only events named "<this context>.<event>" may be added.
  add<E extends EventType>(event: OutboxEventInput<E>): Promise<void>;
}

export interface SubscriberDef<E extends EventType = EventType> {
  event: E;
  // Unique within the context; the delivery is recorded as "<context>.<name>".
  name: string;
  handle: (event: OutboxEvent<E>) => Promise<void>;
  // Default true: run inside a unit of work with the delivery mark. false: outside (HTTP allowed).
  tx?: boolean;
  // Default 5 (kernel config outbox.maxAttempts).
  maxAttempts?: number;
}

// subscribe("check.settled", handler) -- name defaults to the event type.
export function subscribe<E extends EventType>(
  event: E,
  handle: (event: OutboxEvent<E>) => Promise<void>,
  opts: { name?: string; tx?: boolean; maxAttempts?: number } = {},
): SubscriberDef<E> {
  return { event, name: opts.name ?? event, handle, tx: opts.tx, maxAttempts: opts.maxAttempts };
}
