// The unit of work: one Postgres transaction that several contexts' writes share.
//
//   await uow.run(async () => {          // joins an open unit, or starts one (READ COMMITTED)
//     await uow.lockUser(userId);        // per-user advisory xact lock, 5 s wait cap
//     const db = uow.db();               // the open transaction (or the pool outside a unit)
//     await db`INSERT INTO ...`;
//     await outbox.add({...});           // side effects leave through the outbox
//   });
//
// Isolation: READ COMMITTED by default, so a count taken after lockUser sees every write that
// committed before the lock was granted (this is what LazyTax's lock-then-count repositories ran:
// BeginTransactionAsync, default RC). `uow.run(fn, { isolation: 'repeatable read' })` opts in to
// RR; there lockUser tries the lock, and when it had to wait, reruns the whole unit so its
// snapshot is taken after the lock (an RR snapshot is taken by the first statement).
//
// The whole unit is retried on SQLSTATE 40001 (serialization) and 40P01 (deadlock), at most 3
// attempts, so the function you pass must be safe to run again (no HTTP, no in-memory side
// effects). No HTTP call may run inside a unit: the kernel's fetch guard throws if one does.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQL } from 'bun';
import { userBusy } from '../errors';

export type Isolation = 'read committed' | 'repeatable read';

export interface RunOptions {
  // Default 'read committed'. Only the outermost unit's choice counts.
  isolation?: Isolation;
}

export interface UnitOfWork {
  run<T>(fn: () => Promise<T>, opts?: RunOptions): Promise<T>;
  // The open transaction, or the pool when no unit is open (plain reads).
  db(): SQL;
  // Take the user's advisory lock for the rest of the unit. Throws outside a unit.
  // A wait longer than 5 s fails the request with 409 user_busy.
  lockUser(userId: string): Promise<void>;
  inUnit(): boolean;
  // Run fn once the outermost unit has committed (never on rollback). Outside a unit: now.
  afterCommit(fn: () => void): void;
}

interface Store {
  tx: SQL;
  isolation: Isolation;
  afterCommit: (() => void)[];
  locked: Set<string>;
  lockedUser?: string;
}

const RETRY = new Set(['40001', '40P01']);
const LOCK_TIMEOUT = '55P03';
const MAX_ATTEMPTS = 3;
const MAX_LOCK_RERUNS = 5;

// RR only: lockUser had to wait, so this attempt's snapshot predates the lock. Rerun the unit.
class RerunAfterLock extends Error {
  constructor(readonly userId: string) {
    super(`unit of work reruns: it waited for the lock of ${userId} after its snapshot`);
  }
}

const sqlState = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'errno' in e ? String((e as { errno: unknown }).errno) : undefined;

const key = (userId: string) => `user:${userId}`;

export function createUnitOfWork(
  pool: SQL,
  opts: { onRetry?: (attempt: number, state: string) => void } = {},
): UnitOfWork {
  const als = new AsyncLocalStorage<Store>();
  const uow: UnitOfWork = {
    async run<T>(fn: () => Promise<T>, o: RunOptions = {}): Promise<T> {
      if (als.getStore()) return fn();
      const isolation = o.isolation ?? 'read committed';
      let reruns = 0;
      for (let attempt = 1; ; ) {
        const store: Store = { tx: pool, isolation, afterCommit: [], locked: new Set() };
        try {
          const result = await pool.begin(async tx => {
            if (isolation === 'repeatable read') await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
            store.tx = tx;
            return als.run(store, fn);
          });
          for (const f of store.afterCommit) f();
          return result as T;
        } catch (e) {
          if (e instanceof RerunAfterLock && reruns < MAX_LOCK_RERUNS) {
            reruns++;
            continue;
          }
          const state = sqlState(e);
          if (state === LOCK_TIMEOUT && store.lockedUser) throw userBusy(store.lockedUser);
          if (state !== undefined && RETRY.has(state) && attempt < MAX_ATTEMPTS) {
            opts.onRetry?.(attempt, state);
            attempt++;
            continue;
          }
          throw e;
        }
      }
    },
    db: () => als.getStore()?.tx ?? pool,
    async lockUser(userId: string) {
      const store = als.getStore();
      if (!store) throw new Error('uow.lockUser must run inside uow.run');
      if (store.locked.has(userId)) return;
      store.lockedUser = userId;
      await store.tx`SET LOCAL lock_timeout = '5s'`;
      if (store.isolation === 'read committed') {
        await store.tx`SELECT pg_advisory_xact_lock(hashtextextended(${key(userId)}, 0))`;
      } else {
        const [r] = await store.tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${key(userId)}, 0)) AS ok`;
        if (!r?.ok) {
          // Wait for the holder to finish, then rerun with a snapshot taken after it committed.
          await store.tx`SELECT pg_advisory_xact_lock(hashtextextended(${key(userId)}, 0))`;
          throw new RerunAfterLock(userId);
        }
      }
      store.locked.add(userId);
    },
    inUnit: () => als.getStore() !== undefined,
    afterCommit(fn) {
      const store = als.getStore();
      if (store) store.afterCommit.push(fn);
      else fn();
    },
  };
  return uow;
}
