// The outbox on a two-context fixture app: an emitter and a listener that subscribes to it.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineContext, type SubscriberDef, subscribe } from '@lazytax/kernel';
import { testDatabase } from '@lazytax/kernel/testing';
import { bootKernel, type Kernel } from '../../src/kernel/boot';
import { loadKernelConfig } from '../../src/kernel/config';

const root = resolve(import.meta.dir, `../../.tmp-outbox-${process.pid}`);
let kernel: Kernel;
let drop: () => Promise<void>;
const seen: string[] = [];
let failNext = 0;

// Fixture events are not in EventRegistry, so their names are cast.
const PING = 'emitter.ping' as never;

const emitter = defineContext({ build: () => ({}) });
const listener = defineContext({
  build: ({ uow }) => ({
    subscribers: [
      subscribe(
        PING,
        async e => {
          const p = e.payload as { n: number };
          await uow.db()`INSERT INTO kernel.outbox_probe (n) VALUES (${p.n})`;
          if (failNext > 0) {
            failNext--;
            throw new Error('subscriber failed');
          }
          seen.push(`${p.n}#${e.attempt}`);
        },
        { maxAttempts: 2 },
      ) as unknown as SubscriberDef,
    ],
  }),
});

beforeAll(async () => {
  for (const name of ['emitter', 'listener']) {
    mkdirSync(join(root, 'contexts', name), { recursive: true });
    writeFileSync(join(root, 'contexts', name, 'context.yaml'), `id: ctx_${name}\nname: ${name}\n`);
  }
  const db = await testDatabase();
  drop = db.drop;
  const base = loadKernelConfig({});
  kernel = await bootKernel({
    root,
    config: { ...base, databaseUrl: db.url, outbox: { pollMs: 60_000, maxAttempts: 5 } },
    contexts: [
      { folder: 'contexts/emitter', definition: emitter },
      { folder: 'contexts/listener', definition: listener },
    ],
    env: {},
    logSink: () => undefined,
  });
  await kernel.migrate();
  await kernel.pool`CREATE TABLE kernel.outbox_probe (n int NOT NULL)`;
});

afterAll(async () => {
  await kernel.close();
  await drop();
  rmSync(root, { recursive: true, force: true });
});

const emit = (n: number, fail = false) =>
  kernel.uow.run(async () => {
    await kernel.dispatcher.outboxFor('emitter').add({ type: PING, payload: { n } as never, userId: 'u1' });
    if (fail) throw new Error('rollback');
  });

const delivery = async (n: number) => {
  const [r] = await kernel.pool`
    SELECT d.status, d.attempts FROM kernel.outbox_deliveries d JOIN kernel.outbox_events e ON e.id = d.event_id
    WHERE (e.payload->>'n')::int = ${n}`;
  return r as { status: string; attempts: number } | undefined;
};

describe('outbox', () => {
  it('should deliver an event once, after commit, and record the delivery', async () => {
    // Arrange
    await emit(1);
    expect((await delivery(1))?.status).toBe('pending');

    // Act
    await kernel.dispatcher.drain();
    await kernel.dispatcher.drain();

    // Assert
    expect(seen.filter(s => s.startsWith('1#'))).toEqual(['1#1']);
    expect(await delivery(1)).toEqual({ status: 'done', attempts: 1 });
  });

  it('should write nothing when the unit rolls back', async () => {
    // Act
    await expect(emit(2, true)).rejects.toThrow('rollback');

    // Assert
    expect(await delivery(2)).toBeUndefined();
  });

  it("should retry with backoff, roll back the failed attempt's writes, and stop at the cap", async () => {
    // Arrange
    failNext = 5;
    await emit(3);

    // Act: first attempt fails and is scheduled later; make it due and fail again (cap 2).
    await kernel.dispatcher.drain();
    const afterFirst = await delivery(3);
    await kernel.pool`UPDATE kernel.outbox_deliveries SET next_at = now() WHERE status = 'pending'`;
    await kernel.dispatcher.drain();

    // Assert
    expect(afterFirst).toEqual({ status: 'pending', attempts: 1 });
    expect(await delivery(3)).toEqual({ status: 'dead', attempts: 2 });
    expect((await kernel.pool`SELECT 1 FROM kernel.outbox_probe WHERE n = 3`).length).toBe(0);
  });

  it('should refuse an event outside a unit of work or with another context prefix', async () => {
    // Act
    const outside = kernel.dispatcher.outboxFor('emitter').add({ type: PING, payload: {} as never });
    const foreign = kernel.uow.run(() =>
      kernel.dispatcher.outboxFor('listener').add({ type: PING, payload: {} as never }),
    );

    // Assert
    await expect(outside).rejects.toThrow('inside uow.run');
    await expect(foreign).rejects.toThrow('may only add "listener.*" events');
  });
});
