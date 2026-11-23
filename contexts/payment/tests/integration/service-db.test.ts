// The service and repository on real Postgres with a real unit of work, without the kernel boot:
// the fake gateway, a recording outbox, payment's own migration on a fresh database.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Outbox, type OutboxEventInput, Owner, type UnitOfWork } from '@lazytax/kernel';
import { testDatabase } from '@lazytax/kernel/testing';
import { DELETED_USER, PaymentRepository } from '../../src/data/payment-repository';
import { FakeAirwallexGateway } from '../../src/domain/gateway';
import { PaymentService } from '../../src/domain/payment-service';
import { computeSignature } from '../../src/domain/webhook';
import { testUow } from './test-uow';

const SECRET = 'db-secret';
let db: { url: string; drop(): Promise<void> };
let pool: Bun.SQL;
let uow: UnitOfWork;
let repo: PaymentRepository;
let gateway: FakeAirwallexGateway;
let svc: PaymentService;
const events: OutboxEventInput[] = [];
const clock = { now: () => new Date() };

beforeAll(async () => {
  db = await testDatabase();
  pool = new Bun.SQL(db.url, { max: 10 });
  await pool.unsafe('CREATE SCHEMA payment');
  await pool.unsafe(readFileSync(join(import.meta.dir, '../../src/data/migrations/0001_init.sql'), 'utf8'));
  uow = testUow(pool);
  const outbox: Outbox = {
    add: async e => {
      if (!uow.inUnit()) throw new Error('outbox.add outside a unit');
      events.push(e);
    },
  };
  repo = new PaymentRepository(uow);
  gateway = new FakeAirwallexGateway();
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
  svc = new PaymentService(repo, gateway, uow, outbox, clock, { consentChanged: async () => {} }, log, {
    webhookSecret: SECRET,
    webhookToleranceSec: 300,
  });
});

afterAll(async () => {
  await pool.close();
  await db.drop();
});

// A customer with a verified consent, through the same webhook Airwallex calls.
async function linked(userId: string, purpose: 'penalty' | 'subscription' = 'penalty', consentId = `cst_${userId}`) {
  const { customerId } = await svc.createCustomer(Owner.user(userId));
  const raw = JSON.stringify({
    id: 'evt',
    name: 'payment_consent.verified',
    data: {
      object: {
        id: consentId,
        status: 'VERIFIED',
        customer_id: customerId,
        merchant_trigger_reason: purpose === 'subscription' ? 'scheduled' : 'unscheduled',
      },
    },
  });
  const ts = String(Date.now());
  await svc.handleWebhook(new Headers({ 'x-timestamp': ts, 'x-signature': computeSignature(SECRET, ts, raw) }), raw);
  return customerId;
}

const completed = (requestId: string) =>
  events.filter(e => e.type === 'payment.completed' && (e.payload as { requestId: string }).requestId === requestId);

describe('charge on Postgres', () => {
  it('should settle once and record the row', async () => {
    // Arrange
    await linked('db-u1');

    // Act
    const r = await svc.charge('db-pen-1', 'db-u1', 1234, 'sgd', 'penalty');

    // Assert
    expect(r.status).toBe('succeeded');
    const rows =
      await pool`SELECT status, attempt, intent_id, completed_at FROM payment.charges WHERE request_id = 'db-pen-1'`;
    expect(rows[0]).toMatchObject({ status: 'succeeded', attempt: 1, intent_id: r.intentId });
    expect(rows[0].completed_at).not.toBeNull();
    expect(completed('db-pen-1')).toHaveLength(1);
  });

  it('should move money once when the same request is charged concurrently', async () => {
    // Arrange
    await linked('db-u2');
    const before = gateway.settlements.length;

    // Act
    const results = await Promise.all(
      Array.from({ length: 4 }, () => svc.charge('db-pen-2', 'db-u2', 500, 'SGD', 'penalty')),
    );

    // Assert
    expect(gateway.settlements.length - before).toBe(1);
    expect(new Set(results.map(r => r.intentId).filter(Boolean)).size).toBe(1);
    expect(completed('db-pen-2')).toHaveLength(1);
    expect((await svc.getCharge('db-pen-2'))?.status).toBe('succeeded');
  });

  it('should reconcile a lost confirm without a second charge', async () => {
    // Arrange
    await linked('db-u3');
    const before = gateway.settlements.length;

    // Act
    const first = await svc.charge('db-pen-3', 'db-u3', 700, 'SGD', 'penalty', 'stake [lost]');
    const retry = await svc.charge('db-pen-3', 'db-u3', 700, 'SGD', 'penalty', 'stake [lost]');

    // Assert
    expect(first.status).toBe('pending');
    expect(retry.status).toBe('succeeded');
    expect(gateway.settlements.length - before).toBe(1);
  });

  it('should keep purposes apart', async () => {
    // Arrange
    await linked('db-u4', 'subscription');

    // Act
    const penalty = await svc.charge('db-pen-4', 'db-u4', 100, 'SGD', 'penalty');
    const subscription = await svc.charge('db-sub-4', 'db-u4', 100, 'SGD', 'subscription');

    // Assert
    expect(penalty.status).toBe('no_consent');
    expect(subscription.status).toBe('succeeded');
  });
});

describe('owner scoping on Postgres', () => {
  it("should not show or change user A's customer, consent or charge to user B", async () => {
    // Arrange
    const aCustomer = await linked('db-a');
    await svc.charge('db-pen-a', 'db-a', 100, 'SGD', 'penalty');

    // Act
    const asB = await repo.getCustomer(Owner.user('db-b'), { airwallexCustomerId: aCustomer });
    const deleted = await uow.run(() => repo.deleteConsentIf(Owner.user('db-b'), 'penalty', 'cst_db-a', new Date()));
    const charge = await repo.getCharge(Owner.user('db-b'), 'db-pen-a');
    const reuse = svc.charge('db-pen-a', 'db-b', 100, 'SGD', 'penalty');

    // Assert
    expect(asB).toBeNull();
    expect(deleted).toBe(false);
    expect(charge).toBeNull();
    await expect(reuse).rejects.toMatchObject({ id: 'charge_request_conflict' });
    expect(await svc.hasConsent('db-a')).toBe(true);
    expect((await svc.getCharge('db-pen-a'))?.userId).toBe('db-a');
  });
});

describe('purgeUser on Postgres', () => {
  it("should leave 0 rows of the user in payment.* and keep user B's", async () => {
    // Arrange
    await linked('db-purge-a');
    await linked('db-purge-b');
    await svc.charge('db-pen-pa', 'db-purge-a', 100, 'SGD', 'penalty');
    await svc.charge('db-pen-pb', 'db-purge-b', 100, 'SGD', 'penalty');

    // Act
    await uow.run(() => repo.purgeUser('db-purge-a'));
    await uow.run(() => repo.purgeUser('db-purge-a'));

    // Assert
    const left = await pool`
      SELECT (SELECT count(*) FROM payment.customers WHERE user_id = 'db-purge-a')
           + (SELECT count(*) FROM payment.consents WHERE user_id = 'db-purge-a')
           + (SELECT count(*) FROM payment.charges WHERE user_id = 'db-purge-a') AS n`;
    expect(Number(left[0].n)).toBe(0);
    expect((await svc.getCharge('db-pen-pa'))?.userId).toBe(DELETED_USER);
    expect(await svc.hasConsent('db-purge-b')).toBe(true);
  });
});
