// The outbox behind the Outbox interface: `add` writes inside the unit of work; the dispatcher
// delivers after commit, one delivery row per subscriber, with backoff and an attempt cap.
// (LazyTax: CheckEvents / CheckEventDeliveries / IStakeBinding, Domain/Check/Service.cs DispatchEvents.)
import type { Logger } from '../log';
import type { EventType } from '../registry';
import type { Outbox, OutboxEvent, OutboxEventInput, SubscriberDef } from './outbox';
import type { UnitOfWork } from './uow';

export interface RegisteredSubscriber {
  // "<context>.<name>"
  id: string;
  context: string;
  def: SubscriberDef;
}

export interface Dispatcher {
  outboxFor(context: string): Outbox;
  // Deliver every due delivery; resolves when none is left due.
  drain(): Promise<number>;
  // Ask for a drain soon (called after each commit that added events).
  poke(): void;
  start(): void;
  stop(): Promise<void>;
}

export function createDispatcher(opts: {
  uow: UnitOfWork;
  // Read lazily: contexts are built (and their subscribers known) after the outbox exists.
  subscribers: () => RegisteredSubscriber[];
  log: Logger;
  pollMs: number;
  maxAttempts: number;
}): Dispatcher {
  const { uow, log } = opts;
  const byEvent = new Map<string, RegisteredSubscriber[]>();
  const byId = new Map<string, RegisteredSubscriber>();
  let indexed = false;
  const index = () => {
    if (indexed) return;
    indexed = true;
    for (const s of opts.subscribers()) {
      byEvent.set(s.def.event, [...(byEvent.get(s.def.event) ?? []), s]);
      byId.set(s.id, s);
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;
  let again = false;

  const outboxFor = (context: string): Outbox => ({
    async add<E extends EventType>(event: OutboxEventInput<E>) {
      if (!event.type.startsWith(`${context}.`))
        throw new Error(`context "${context}" may only add "${context}.*" events, not "${event.type}"`);
      if (!uow.inUnit()) throw new Error('outbox.add must run inside uow.run');
      index();
      const db = uow.db();
      const [row] = await db`
        INSERT INTO kernel.outbox_events (type, payload, user_id)
        VALUES (${event.type}, ${JSON.stringify(event.payload)}::text::jsonb, ${event.userId ?? null})
        RETURNING id`;
      for (const s of byEvent.get(event.type) ?? [])
        await db`INSERT INTO kernel.outbox_deliveries (event_id, subscriber) VALUES (${row.id}, ${s.id})`;
      uow.afterCommit(() => d.poke());
    },
  });

  const toEvent = (r: Record<string, unknown>, attempt: number): OutboxEvent => ({
    id: String(r.id),
    type: r.type as EventType,
    payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as never,
    userId: (r.user_id as string | null) ?? null,
    createdAt: r.created_at as Date,
    attempt,
  });

  async function fail(s: RegisteredSubscriber, eventId: string, e: unknown) {
    const max = s.def.maxAttempts ?? opts.maxAttempts;
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    const db = uow.db();
    const [r] = await db`
      UPDATE kernel.outbox_deliveries
      SET attempts = attempts + 1, last_error = ${msg}, updated_at = now(),
          status = CASE WHEN attempts + 1 >= ${max} THEN 'dead' ELSE 'pending' END,
          next_at = now() + make_interval(secs => LEAST(300, power(2, attempts)))
      WHERE event_id = ${eventId} AND subscriber = ${s.id}
      RETURNING status, attempts`;
    const level = r?.status === 'dead' ? 'error' : 'warn';
    log[level]('outbox delivery failed', {
      context: s.context,
      subscriber: s.id,
      eventId,
      attempts: r?.attempts ?? null,
      status: r?.status ?? null,
      error: msg,
    });
  }

  async function deliverOne(s: RegisteredSubscriber, eventId: string): Promise<boolean> {
    try {
      if (s.def.tx !== false) {
        return await uow.run(async () => {
          const db = uow.db();
          const [r] = await db`
            SELECT e.id, e.type, e.payload, e.user_id, e.created_at, d.attempts
            FROM kernel.outbox_deliveries d JOIN kernel.outbox_events e ON e.id = d.event_id
            WHERE d.event_id = ${eventId} AND d.subscriber = ${s.id} AND d.status = 'pending' AND d.next_at <= now()
            FOR UPDATE OF d SKIP LOCKED`;
          if (!r) return false;
          await s.def.handle(toEvent(r, Number(r.attempts) + 1));
          await db`UPDATE kernel.outbox_deliveries SET status = 'done', attempts = attempts + 1, updated_at = now()
                   WHERE event_id = ${eventId} AND subscriber = ${s.id}`;
          return true;
        });
      }
      // Outside a unit: take a 60 s lease, call, then mark done. At least once.
      const db = uow.db();
      const [r] = await db`
        WITH claimed AS (
          UPDATE kernel.outbox_deliveries SET next_at = now() + interval '60 seconds', updated_at = now()
          WHERE event_id = ${eventId} AND subscriber = ${s.id} AND status = 'pending' AND next_at <= now()
          RETURNING event_id, attempts)
        SELECT e.id, e.type, e.payload, e.user_id, e.created_at, c.attempts
        FROM claimed c JOIN kernel.outbox_events e ON e.id = c.event_id`;
      if (!r) return false;
      await s.def.handle(toEvent(r, Number(r.attempts) + 1));
      await db`UPDATE kernel.outbox_deliveries SET status = 'done', attempts = attempts + 1, updated_at = now()
               WHERE event_id = ${eventId} AND subscriber = ${s.id}`;
      return true;
    } catch (e) {
      await fail(s, eventId, e).catch(e2 => log.error('outbox: could not record a failure', { error: String(e2) }));
      return false;
    }
  }

  async function drainOnce(): Promise<number> {
    index();
    let delivered = 0;
    for (;;) {
      const due = await uow.db()`
        SELECT event_id, subscriber FROM kernel.outbox_deliveries
        WHERE status = 'pending' AND next_at <= now()
        ORDER BY next_at LIMIT 100`;
      if (due.length === 0) return delivered;
      let progressed = 0;
      for (const row of due) {
        const s = byId.get(row.subscriber as string);
        if (!s) continue; // a subscriber that no longer exists stays pending
        if (await deliverOne(s, String(row.event_id))) progressed++;
      }
      delivered += progressed;
      if (progressed === 0) return delivered;
    }
  }

  const d: Dispatcher = {
    outboxFor,
    drain() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let n = 0;
        do {
          again = false;
          n += await drainOnce();
        } while (again);
        return n;
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    poke() {
      if (timer === undefined) return; // only the worker process dispatches on its own
      void d.drain().catch(e => log.error('outbox drain failed', { error: String(e) }));
    },
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => d.poke(), opts.pollMs);
      d.poke();
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
  return d;
}
