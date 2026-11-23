// The payment service (LazyTax Domain/Payment/Service.cs + AirwallexWebhookService), behind
// payment.v1 and the Payment routes.
//
// Gateway calls never run inside a unit of work. Database writes that follow a gateway call run
// in their own short unit, after it. The merchant-initiated charge copies nitroso's 3 phases.
import { randomUUID } from 'node:crypto';
import {
  type Clock,
  conflict,
  type Logger,
  notFound,
  type Outbox,
  Owner,
  type UnitOfWork,
  validationFailed,
} from '@lazytax/kernel';
import type {
  ChargeResultDto,
  ConsentDto,
  ConsentPurpose,
  ConsentStatus,
  PaymentV1,
} from '@lazytax/payment-contract/v1';
import { type GatewayIntent, GatewayRejected, type PaymentGateway } from './gateway';
import {
  type ChargeRow,
  type ConsentRow,
  type CustomerRow,
  consentFor,
  hasVerified,
  isCurrency,
  PURPOSES,
  parseConsentStatus,
  purposeLabel,
} from './model';
import { AirwallexEvent, verifySignature } from './webhook';

// The store the service needs (PaymentRepository implements it; unit tests fake it).
export interface PaymentStore {
  getCustomer(owner: Owner, by?: { airwallexCustomerId?: string }): Promise<CustomerRow | null>;
  createCustomer(owner: Owner, airwallexCustomerId: string, now: Date): Promise<CustomerRow>;
  setConsent(
    owner: Owner,
    customer: CustomerRow,
    purpose: ConsentPurpose,
    consentId: string | null,
    status: ConsentStatus | null,
    now: Date,
  ): Promise<void>;
  deleteConsentIf(owner: Owner, purpose: ConsentPurpose, expectedConsentId: string, now: Date): Promise<boolean>;
  getCharge(owner: Owner, requestId: string, forUpdate?: boolean): Promise<ChargeRow | null>;
  getChargeByIntent(owner: Owner, intentId: string): Promise<ChargeRow | null>;
  insertCharge(owner: Owner, row: ChargeRow, now: Date): Promise<boolean>;
  updateCharge(
    owner: Owner,
    requestId: string,
    patch: {
      status: ChargeRow['status'];
      attempt?: number;
      intentId?: string | null;
      detail?: string | null;
      completed?: boolean;
    },
    now: Date,
  ): Promise<void>;
}

// The security email (LazyTax IEmailNotifier.NotifyConsentChanged). Called INSIDE a unit of
// work: notification.v1 email() leaves through the outbox after commit.
export interface ConsentNotifier {
  consentChanged(userId: string, linked: boolean, purpose: string, at: Date): Promise<void>;
}

export interface PaymentConfig {
  webhookSecret: string;
  webhookToleranceSec: number;
}

export interface CustomerRes {
  customerId: string;
  clientSecret: string;
}

export interface IntentRes {
  paymentIntentId: string;
  status: string;
  // Major units, as LazyTax's decimal Amount.
  amount: number;
  currency: string;
}

const toIntentRes = (i: GatewayIntent): IntentRes => ({
  paymentIntentId: i.id,
  status: i.status,
  amount: i.amountCents / 100,
  currency: i.currency,
});

const toConsentDto = (purpose: ConsentPurpose, c: ConsentRow | undefined): ConsentDto => ({
  purpose,
  consentId: c?.consentId ?? null,
  status: c?.status ?? null,
  hasPaymentConsent: c?.status === 'Verified',
});

const toResult = (r: ChargeRow): ChargeResultDto => ({
  requestId: r.requestId,
  userId: r.userId,
  amountCents: r.amountCents,
  currency: r.currency,
  purpose: r.purpose,
  // A row still "processing" is in flight (or its caller crashed): to callers it is pending.
  status: r.status === 'processing' ? 'pending' : r.status,
  intentId: r.intentId,
  attempt: r.attempt,
  detail: r.detail,
});

const CONTENDED_ATTEMPTS = 6;

const message = (e: unknown) => String((e as Error)?.message ?? e);

const customerNotFound = (userId: string) => notFound('PaymentCustomer', userId);

interface Claim {
  done?: ChargeRow;
  row?: ChargeRow;
  consentId?: string;
  customerId?: string;
  redrive?: boolean;
}

export class PaymentService implements PaymentV1 {
  constructor(
    private readonly repo: PaymentStore,
    private readonly gateway: PaymentGateway,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly notifier: ConsentNotifier,
    private readonly log: Logger,
    private readonly config: PaymentConfig,
  ) {}

  // ── Routes ────────────────────────────────────────────────────────────────────────────────

  // PUT /{userId}/customers: DB -> gateway lookup by merchant id -> gateway create, then a secret.
  async createCustomer(owner: Owner): Promise<CustomerRes> {
    const userId = this.userOf(owner);
    let customer = await this.repo.getCustomer(owner);
    if (!customer) {
      const airwallexId = (await this.gateway.findCustomer(userId)) ?? (await this.gateway.createCustomer(userId));
      customer = await this.uow.run(() => this.repo.createCustomer(owner, airwallexId, this.clock.now()));
    }
    const clientSecret = await this.gateway.clientSecret(customer.airwallexCustomerId);
    return { customerId: customer.airwallexCustomerId, clientSecret };
  }

  // GET /{userId}/client-secret
  async clientSecret(owner: Owner): Promise<{ clientSecret: string; customerId: string }> {
    const customer = await this.mustCustomer(owner);
    return {
      clientSecret: await this.gateway.clientSecret(customer.airwallexCustomerId),
      customerId: customer.airwallexCustomerId,
    };
  }

  // GET /{userId}/consent?purpose=
  async getConsent(owner: Owner, purpose: ConsentPurpose): Promise<ConsentDto> {
    const customer = await this.mustCustomer(owner);
    return toConsentDto(purpose, consentFor(customer, purpose));
  }

  // DELETE /{userId}/consent?purpose=: revoke at the gateway first (outside any unit), then drop
  // the row only if it still holds the revoked id, emit consentChanged and send the email.
  async disableConsent(owner: Owner, purpose: ConsentPurpose): Promise<void> {
    const userId = this.userOf(owner);
    const customer = await this.mustCustomer(owner);
    const consent = consentFor(customer, purpose);
    if (!consent) throw notFound('PaymentConsent', `${userId}:${purpose}`);
    await this.gateway.disableConsent(consent.consentId);
    await this.uow.run(async () => {
      const now = this.clock.now();
      await this.repo.deleteConsentIf(owner, purpose, consent.consentId, now);
      await this.outbox.add({ type: 'payment.consentChanged', payload: { userId, purpose, linked: false }, userId });
      // The user-initiated revoke only: account deletion (revokeAll) must not email.
      await this.notifier.consentChanged(userId, false, purposeLabel(purpose), now);
    });
  }

  // POST /{userId}/intent: an interactive intent with fresh ids (LazyTax mints GUIDs here).
  async createIntent(
    owner: Owner,
    input: { amountCents: number; currency: string; description: string },
  ): Promise<IntentRes> {
    const customer = await this.mustCustomer(owner);
    const intent = await this.gateway.createIntent({
      requestId: randomUUID(),
      merchantOrderId: randomUUID(),
      customerId: customer.airwallexCustomerId,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      description: input.description,
    });
    return toIntentRes(intent);
  }

  // POST /{userId}/intent/{intentId}: confirm with a consent. The intent must be this user's.
  async confirmIntent(owner: Owner, intentId: string, consentId: string): Promise<IntentRes> {
    const customer = await this.mustCustomer(owner);
    const intent = await this.gateway.retrieveIntent(intentId).catch(() => null);
    if (!intent || intent.customerId !== customer.airwallexCustomerId) throw notFound('PaymentIntent', intentId);
    return toIntentRes(await this.gateway.confirmIntent(intentId, consentId, customer.airwallexCustomerId));
  }

  // POST /webhook (public): signature first, then route by event name.
  async handleWebhook(headers: Headers, rawBody: string): Promise<void> {
    verifySignature({
      secret: this.config.webhookSecret,
      timestamp: headers.get('x-timestamp'),
      signature: headers.get('x-signature'),
      rawBody,
      now: this.clock.now(),
      toleranceSec: this.config.webhookToleranceSec,
    });
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw validationFailed('Invalid JSON body', { body: ['is not valid JSON'] });
    }
    const parsed = AirwallexEvent.safeParse(json);
    if (!parsed.success) throw validationFailed('Invalid webhook event', { body: ['is not an Airwallex event'] });
    const evt = parsed.data;
    switch (evt.name) {
      case 'payment_consent.verified':
      case 'payment_consent.verification_failed':
        return this.onConsentEvent(evt);
      case 'payment_intent.succeeded':
        return this.onIntentSucceeded(evt);
      default:
        this.log.warn('unknown webhook event', { event: evt.name });
    }
  }

  // ── payment.v1 ────────────────────────────────────────────────────────────────────────────

  async hasConsent(userId: string, purpose: ConsentPurpose = 'penalty'): Promise<boolean> {
    const customer = await this.repo.getCustomer(Owner.user(userId));
    return customer !== null && hasVerified(customer, purpose);
  }

  async charge(
    requestId: string,
    userId: string,
    amountCents: number,
    currency: string,
    purpose: ConsentPurpose,
    description = `LazyTax ${purpose} ${requestId}`,
  ): Promise<ChargeResultDto> {
    if (this.uow.inUnit()) throw new Error('payment.charge must run outside a unit of work (it calls the gateway)');
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw validationFailed('Invalid charge', { amountCents: ['must be a positive integer'] });
    if (!isCurrency(currency)) throw validationFailed('Invalid charge', { currency: ['must be an ISO currency code'] });
    if (!PURPOSES.includes(purpose)) throw validationFailed('Invalid charge', { purpose: ['unknown purpose'] });
    const owner = Owner.user(userId);
    const cur = currency.toUpperCase();

    // Phase 1: claim the row in one unit. A row already processing (or pending) keeps its attempt,
    // so a re-drive reuses the same gateway key and collapses onto the same intent.
    const claim = await this.contended(async (): Promise<Claim> => {
      const now = this.clock.now();
      await this.repo.insertCharge(
        owner,
        {
          requestId,
          userId,
          amountCents,
          currency: cur,
          purpose,
          description,
          status: 'processing',
          attempt: 0,
          intentId: null,
          detail: null,
        },
        now,
      );
      const row = await this.repo.getCharge(owner, requestId, true);
      if (!row) throw conflict('charge_request_conflict', 'This request id belongs to another charge', { requestId });
      if (row.amountCents !== amountCents || row.currency !== cur || row.purpose !== purpose)
        throw conflict('charge_request_conflict', 'This request id was charged with other terms', { requestId });
      if (row.status === 'succeeded') return { done: row };
      const customer = await this.repo.getCustomer(owner);
      const consent = customer ? consentFor(customer, purpose) : undefined;
      if (!customer || !consent || consent.status !== 'Verified') {
        await this.repo.updateCharge(owner, requestId, { status: 'no_consent', detail: 'no verified consent' }, now);
        return { done: { ...row, status: 'no_consent', detail: 'no verified consent' } };
      }
      const redrive = (row.status === 'processing' && row.attempt > 0) || row.status === 'pending';
      const attempt = redrive ? row.attempt : row.attempt + 1;
      // A fresh attempt starts without an intent; a re-drive keeps the one it has.
      const intentId = redrive ? row.intentId : null;
      await this.repo.updateCharge(owner, requestId, { status: 'processing', attempt, intentId }, now);
      return {
        row: { ...row, status: 'processing', attempt, intentId },
        consentId: consent.consentId,
        customerId: customer.airwallexCustomerId,
        redrive,
      };
    });
    if (claim.done) return toResult(claim.done);
    const row = claim.row as ChargeRow;
    const consentId = claim.consentId as string;
    const customerId = claim.customerId as string;

    // Phase 2: the gateway, outside any unit, keyed "<requestId>-<attempt>".
    let intent: GatewayIntent | null = null;
    let intentId = row.intentId;
    let outcome: 'succeeded' | 'pending' | 'declined';
    let detail: string | null = null;
    try {
      if (intentId) {
        intent = await this.gateway.retrieveIntent(intentId);
        if (intent.status !== 'SUCCEEDED') intent = await this.gateway.confirmIntent(intentId, consentId, customerId);
      } else {
        const key = `${requestId}-${row.attempt}`;
        intent = await this.gateway.createIntent({
          requestId: key,
          merchantOrderId: key,
          customerId,
          amountCents,
          currency: cur,
          description,
        });
        intentId = intent.id;
        if (intent.status !== 'SUCCEEDED') {
          // Keep the intent id before confirming, so a lost confirm is reconciled, never re-created.
          await this.saveIntentId(owner, requestId, row.attempt, intent.id);
          intent = await this.gateway.confirmIntent(intent.id, consentId, customerId);
        }
      }
      outcome = intent.status === 'SUCCEEDED' ? 'succeeded' : 'pending';
      detail = intent.status;
    } catch (e) {
      // Only a definitive rejection of a first send, before any intent, proves no money moved.
      outcome = e instanceof GatewayRejected && !claim.redrive && intentId === null ? 'declined' : 'pending';
      detail = message(e);
      this.log.warn('charge gateway call failed', { requestId, attempt: row.attempt, outcome, error: detail });
    }

    // Phase 3: write back only if this claim still holds (same attempt, not already settled).
    return this.contended(async () => {
      const now = this.clock.now();
      const current = await this.repo.getCharge(owner, requestId, true);
      if (!current) throw notFound('Charge', requestId);
      if (current.attempt !== row.attempt || current.status === 'succeeded') return toResult(current);
      await this.repo.updateCharge(
        owner,
        requestId,
        { status: outcome, intentId, detail, completed: outcome === 'succeeded' },
        now,
      );
      const next: ChargeRow = { ...current, status: outcome, intentId, detail };
      await this.emitOutcome(next);
      return toResult(next);
    });
  }

  // Account deletion (kernel beforePurge): revoke every consent at the gateway; every purpose is
  // attempted even when one fails, and the first failure is thrown after all attempts.
  async revokeAll(userId: string): Promise<void> {
    if (this.uow.inUnit()) throw new Error('payment.revokeAll must run outside a unit of work (it calls the gateway)');
    const owner = Owner.user(userId);
    const customer = await this.repo.getCustomer(owner);
    if (!customer) return;
    let first: unknown;
    for (const purpose of PURPOSES) {
      const consent = consentFor(customer, purpose);
      if (!consent) continue;
      try {
        await this.gateway.disableConsent(consent.consentId);
        await this.uow.run(async () => {
          await this.repo.deleteConsentIf(owner, purpose, consent.consentId, this.clock.now());
          await this.outbox.add({
            type: 'payment.consentChanged',
            payload: { userId, purpose, linked: false },
            userId,
          });
        });
      } catch (e) {
        first ??= e;
        this.log.warn('consent revoke failed', { userId, purpose, error: message(e) });
      }
    }
    if (first !== undefined) throw first;
  }

  async getCharge(requestId: string): Promise<ChargeResultDto | null> {
    const row = await this.repo.getCharge(Owner.system(), requestId);
    return row ? toResult(row) : null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private userOf(owner: Owner): string {
    if (owner.kind !== 'user') throw new Error('payment routes act for one user');
    return owner.userId;
  }

  private async mustCustomer(owner: Owner): Promise<CustomerRow> {
    const customer = await this.repo.getCustomer(owner);
    if (!customer) throw customerNotFound(this.userOf(owner));
    return customer;
  }

  // Several callers may charge the same request id at once (replicas, a retry racing the first
  // call). REPEATABLE READ turns that into 40001 on the charge row, and the kernel retries a unit
  // only 3 times, so the claim and the write-backs get more tries, with a little jitter.
  private async contended<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(fn);
      } catch (e) {
        const state = String((e as { errno?: unknown })?.errno ?? '');
        if (attempt >= CONTENDED_ATTEMPTS || (state !== '40001' && state !== '40P01')) throw e;
        await Bun.sleep(5 + Math.floor(Math.random() * 20 * attempt));
      }
    }
  }

  private async saveIntentId(owner: Owner, requestId: string, attempt: number, intentId: string): Promise<void> {
    await this.contended(async () => {
      const current = await this.repo.getCharge(owner, requestId, true);
      if (!current || current.attempt !== attempt || current.status !== 'processing') return;
      await this.repo.updateCharge(owner, requestId, { status: 'processing', intentId }, this.clock.now());
    });
  }

  private async emitOutcome(row: ChargeRow): Promise<void> {
    if (row.status === 'succeeded' && row.intentId)
      await this.outbox.add({
        type: 'payment.completed',
        payload: {
          requestId: row.requestId,
          userId: row.userId,
          kind: row.purpose,
          intentId: row.intentId,
          amountCents: row.amountCents,
          currency: row.currency,
        },
        userId: row.userId,
      });
    if (row.status === 'declined')
      await this.outbox.add({
        type: 'payment.failed',
        payload: {
          requestId: row.requestId,
          userId: row.userId,
          kind: row.purpose,
          attempt: row.attempt,
          reason: row.detail ?? 'declined',
        },
        userId: row.userId,
      });
  }

  // LazyTax ProcessPaymentConsentEvent. The purpose comes from merchant_trigger_reason
  // ("scheduled" -> subscription; anything else, including none, -> penalty).
  private async onConsentEvent(evt: AirwallexEvent): Promise<void> {
    const o = evt.data.object;
    const purpose: ConsentPurpose =
      (o.merchant_trigger_reason ?? '').toLowerCase() === 'scheduled' ? 'subscription' : 'penalty';
    const status = parseConsentStatus(o.status);
    const consentId = o.id === '' ? null : o.id;
    if (!o.merchant_trigger_reason)
      this.log.warn('consent carries no merchant_trigger_reason; classified as penalty', {
        consentId,
        customerId: o.customer_id,
      });
    await this.uow.run(async () => {
      const now = this.clock.now();
      const customer = await this.repo.getCustomer(Owner.system(), { airwallexCustomerId: o.customer_id });
      if (!customer) {
        this.log.warn('webhook for an unknown payment customer', { customerId: o.customer_id });
        return;
      }
      const owner = Owner.user(customer.userId);
      await this.repo.setConsent(owner, customer, purpose, consentId, status, now);
      if (status === 'Verified') {
        await this.outbox.add({
          type: 'payment.consentChanged',
          payload: { userId: customer.userId, purpose, linked: true },
          userId: customer.userId,
        });
        await this.notifier.consentChanged(customer.userId, true, purposeLabel(purpose), now);
      }
    });
  }

  // A pending charge settled at the gateway later: mark it and emit payment.completed once.
  private async onIntentSucceeded(evt: AirwallexEvent): Promise<void> {
    const intentId = evt.data.object.id;
    await this.uow.run(async () => {
      const found = await this.repo.getChargeByIntent(Owner.system(), intentId);
      if (!found) return;
      const owner = Owner.user(found.userId);
      const row = await this.repo.getCharge(owner, found.requestId, true);
      if (!row || row.status === 'succeeded') return;
      await this.repo.updateCharge(
        owner,
        row.requestId,
        { status: 'succeeded', detail: 'SUCCEEDED', completed: true },
        this.clock.now(),
      );
      await this.emitOutcome({ ...row, status: 'succeeded', detail: 'SUCCEEDED' });
    });
  }
}
