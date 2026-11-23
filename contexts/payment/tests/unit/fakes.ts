// In-memory fakes for the payment service's unit tests (no database).
import type { Logger, Outbox, OutboxEventInput, Owner, UnitOfWork } from '@lazytax/kernel';
import type { ConsentPurpose, ConsentStatus } from '@lazytax/payment-contract/v1';
import { FakeAirwallexGateway } from '../../src/domain/gateway';
import type { ChargeRow, CustomerRow } from '../../src/domain/model';
import { type ConsentNotifier, PaymentService, type PaymentStore } from '../../src/domain/payment-service';

const visible = (owner: Owner, userId: string) => owner.kind === 'anyone' || owner.userId === userId;

class FakeStore implements PaymentStore {
  customers: CustomerRow[] = [];
  charges = new Map<string, ChargeRow>();

  async getCustomer(owner: Owner, by: { airwallexCustomerId?: string } = {}) {
    const c = this.customers.find(
      x =>
        visible(owner, x.userId) &&
        (by.airwallexCustomerId === undefined || x.airwallexCustomerId === by.airwallexCustomerId),
    );
    return c ? structuredClone(c) : null;
  }

  async createCustomer(owner: Owner, airwallexCustomerId: string, now: Date) {
    if (owner.kind !== 'user') throw new Error('user only');
    const existing = await this.getCustomer(owner);
    if (existing) return existing;
    const row: CustomerRow = {
      id: crypto.randomUUID(),
      userId: owner.userId,
      airwallexCustomerId,
      consents: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.customers.push(row);
    return structuredClone(row);
  }

  async setConsent(
    owner: Owner,
    customer: CustomerRow,
    purpose: ConsentPurpose,
    consentId: string | null,
    status: ConsentStatus | null,
  ) {
    const c = this.customers.find(x => x.id === customer.id && visible(owner, x.userId));
    if (!c) return;
    c.consents = c.consents.filter(k => k.purpose !== purpose);
    if (consentId !== null) c.consents.push({ purpose, consentId, status });
  }

  async deleteConsentIf(owner: Owner, purpose: ConsentPurpose, expected: string) {
    let deleted = false;
    for (const c of this.customers.filter(x => visible(owner, x.userId))) {
      const before = c.consents.length;
      c.consents = c.consents.filter(k => !(k.purpose === purpose && k.consentId === expected));
      deleted ||= c.consents.length < before;
    }
    return deleted;
  }

  async getCharge(owner: Owner, requestId: string) {
    const r = this.charges.get(requestId);
    return r && visible(owner, r.userId) ? { ...r } : null;
  }

  async getChargeByIntent(owner: Owner, intentId: string) {
    const r = [...this.charges.values()].find(x => x.intentId === intentId && visible(owner, x.userId));
    return r ? { ...r } : null;
  }

  async insertCharge(_owner: Owner, row: ChargeRow) {
    if (this.charges.has(row.requestId)) return false;
    this.charges.set(row.requestId, { ...row });
    return true;
  }

  async updateCharge(
    owner: Owner,
    requestId: string,
    patch: { status: ChargeRow['status']; attempt?: number; intentId?: string | null; detail?: string | null },
  ) {
    const r = this.charges.get(requestId);
    if (!r || !visible(owner, r.userId)) return;
    r.status = patch.status;
    if (patch.attempt !== undefined) r.attempt = patch.attempt;
    if (patch.intentId !== undefined) r.intentId = patch.intentId;
    if (patch.detail !== undefined) r.detail = patch.detail;
  }

  // Arrange: a customer with a verified consent per purpose.
  seed(userId: string, consents: Partial<Record<ConsentPurpose, { id: string; status: ConsentStatus }>> = {}) {
    const row: CustomerRow = {
      id: crypto.randomUUID(),
      userId,
      airwallexCustomerId: `cus_${userId}`,
      consents: Object.entries(consents).map(([purpose, c]) => ({
        purpose: purpose as ConsentPurpose,
        consentId: c.id,
        status: c.status,
      })),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    this.customers.push(row);
    return row;
  }
}

class FakeUow implements UnitOfWork {
  depth = 0;
  runs = 0;
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.runs++;
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
    }
  }
  db(): never {
    throw new Error('FakeUow has no database');
  }
  async lockUser() {}
  inUnit() {
    return this.depth > 0;
  }
  afterCommit(fn: () => void) {
    fn();
  }
}

class FakeOutbox implements Outbox {
  events: OutboxEventInput[] = [];
  constructor(private readonly uow: FakeUow) {}
  async add(e: OutboxEventInput) {
    if (!this.uow.inUnit()) throw new Error('outbox.add outside a unit');
    this.events.push(e);
  }
  of(type: string) {
    return this.events.filter(e => e.type === type);
  }
}

class FakeNotifier implements ConsentNotifier {
  sent: { userId: string; linked: boolean; purpose: string; inUnit: boolean }[] = [];
  constructor(private readonly uow: FakeUow) {}
  async consentChanged(userId: string, linked: boolean, purpose: string) {
    this.sent.push({ userId, linked, purpose, inUnit: this.uow.inUnit() });
  }
}

const noop = () => undefined;
const silentLog: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLog };

export const SECRET = 'unit-secret';

export function harness(now = new Date('2026-03-01T00:00:00Z')) {
  const store = new FakeStore();
  const gateway = new FakeAirwallexGateway();
  const uow = new FakeUow();
  // Every gateway call must run outside a unit of work (DESIGN §1: no HTTP inside a transaction).
  for (const m of [
    'findCustomer',
    'createCustomer',
    'clientSecret',
    'disableConsent',
    'createIntent',
    'retrieveIntent',
    'confirmIntent',
  ] as const) {
    const real = gateway[m].bind(gateway) as (...a: unknown[]) => Promise<unknown>;
    (gateway as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      if (uow.inUnit()) throw new Error(`gateway.${m} inside a unit of work`);
      return real(...a);
    };
  }
  const outbox = new FakeOutbox(uow);
  const notifier = new FakeNotifier(uow);
  const clock = { now: () => new Date(now) };
  const service = new PaymentService(store, gateway, uow, outbox, clock, notifier, silentLog, {
    webhookSecret: SECRET,
    webhookToleranceSec: 300,
  });
  return { store, gateway, uow, outbox, notifier, clock, service, now };
}
