// No HTTP call may run inside a unit of work (DESIGN §1: one connection per transaction, no
// Logto/payment/notification call while a transaction or the user lock is held). The kernel wraps
// fetch once; it throws when any booted kernel's unit of work is open in the calling async context.
const checks = new Set<() => boolean>();
let installed = false;

class FetchInUnitOfWorkError extends Error {
  override name = 'FetchInUnitOfWorkError';
}

export function guardFetch(inUnit: () => boolean): () => void {
  checks.add(inUnit);
  if (!installed) {
    installed = true;
    const real = globalThis.fetch;
    const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      for (const c of checks)
        if (c())
          throw new FetchInUnitOfWorkError(
            'HTTP call inside a unit of work. Fix: do it after commit, or emit an outbox event and call it from a subscriber with tx: false',
          );
      return real(input, init);
    }) as typeof fetch;
    Object.assign(guarded, real);
    globalThis.fetch = guarded;
  }
  return () => checks.delete(inUnit);
}
