// A minimal unit of work for tests that run without the kernel boot: the same shape the kernel
// ships (one REPEATABLE READ transaction in AsyncLocalStorage, a per-user advisory lock, and a
// retry of the whole unit on 40001/40P01, at most 3 attempts).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitOfWork } from '@lazytax/kernel';

const RETRY = new Set(['40001', '40P01']);

export function testUow(pool: Bun.SQL): UnitOfWork {
  const als = new AsyncLocalStorage<{ tx: Bun.SQL; after: (() => void)[] }>();
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (als.getStore()) return fn();
      for (let attempt = 1; ; attempt++) {
        const store = { tx: pool, after: [] as (() => void)[] };
        try {
          const out = await pool.begin(async tx => {
            await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
            store.tx = tx;
            return als.run(store, fn);
          });
          for (const f of store.after) f();
          return out as T;
        } catch (e) {
          const state = String((e as { errno?: unknown }).errno);
          if (RETRY.has(state) && attempt < 3) continue;
          throw e;
        }
      }
    },
    db: () => als.getStore()?.tx ?? pool,
    async lockUser(userId: string) {
      const s = als.getStore();
      if (!s) throw new Error('lockUser outside a unit');
      await s.tx`SELECT pg_advisory_xact_lock(hashtextextended(${`user:${userId}`}, 0))`;
    },
    inUnit: () => als.getStore() !== undefined,
    afterCommit(fn) {
      const s = als.getStore();
      if (s) s.after.push(fn);
      else fn();
    },
  };
}
