// The payment gateway port (LazyTax Domain/Payment/IPaymentGateway.cs) and its fake.
//
// The design rules out real Airwallex here: the fake keeps everything in memory and never opens
// a socket. It still behaves like Airwallex where the service depends on it: create-intent is
// idempotent by request_id, a confirm of a SUCCEEDED intent never moves money twice, and the
// gateway can fail in the two ways that matter (a definitive rejection, a lost response).
//
// Test hooks (fake only), so integration tests and SIT can drive each branch through the API:
//   description contains "[decline]" -> create-intent is rejected (GatewayRejected)
//   description contains "[pending]" -> confirm leaves the intent REQUIRES_CUSTOMER_ACTION
//   description contains "[lost]"    -> the FIRST confirm settles the money, then the response
//                                       is lost (GatewayUnavailable): a retry must not re-charge
//   description contains "[flaky]"   -> the FIRST confirm fails before settling (GatewayUnavailable)
//   a consent id containing "fail"   -> disabling it fails (GatewayUnavailable)
import { randomUUID } from 'node:crypto';

type IntentStatus = 'REQUIRES_PAYMENT_METHOD' | 'REQUIRES_CUSTOMER_ACTION' | 'SUCCEEDED';

export interface GatewayIntent {
  id: string;
  status: IntentStatus;
  amountCents: number;
  currency: string;
  customerId: string;
  merchantOrderId: string;
}

export interface CreateIntentInput {
  // Airwallex request_id: the idempotency key. Same key -> the same intent.
  requestId: string;
  merchantOrderId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  description: string;
}

// The gateway said no, and the request did not create anything (safe to start a new attempt).
export class GatewayRejected extends Error {
  override name = 'GatewayRejected';
}

// Timeout, 5xx, a lost response: the outcome is unknown (money may have moved).
class GatewayUnavailable extends Error {
  override name = 'GatewayUnavailable';
}

export interface PaymentGateway {
  findCustomer(merchantCustomerId: string): Promise<string | null>;
  createCustomer(merchantCustomerId: string): Promise<string>;
  clientSecret(customerId: string): Promise<string>;
  disableConsent(consentId: string): Promise<void>;
  createIntent(input: CreateIntentInput): Promise<GatewayIntent>;
  retrieveIntent(intentId: string): Promise<GatewayIntent>;
  confirmIntent(intentId: string, consentId: string, customerId: string): Promise<GatewayIntent>;
}

interface FakeIntent extends GatewayIntent {
  description: string;
  confirms: number;
}

export class FakeAirwallexGateway implements PaymentGateway {
  private readonly customers = new Map<string, string>();
  private readonly intents = new Map<string, FakeIntent>();
  private readonly byRequestId = new Map<string, string>();
  readonly disabledConsents: string[] = [];
  // Every time money moved: one entry per settled intent. Exactly-once tests read it.
  readonly settlements: { intentId: string; amountCents: number; currency: string }[] = [];
  // Every createIntent call, including idempotent replays.
  readonly createCalls: CreateIntentInput[] = [];

  async findCustomer(merchantCustomerId: string): Promise<string | null> {
    return this.customers.get(merchantCustomerId) ?? null;
  }

  async createCustomer(merchantCustomerId: string): Promise<string> {
    const existing = this.customers.get(merchantCustomerId);
    if (existing) return existing;
    const id = `cus_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.customers.set(merchantCustomerId, id);
    return id;
  }

  async clientSecret(customerId: string): Promise<string> {
    return `cs_fake_${customerId}_${randomUUID().slice(0, 8)}`;
  }

  async disableConsent(consentId: string): Promise<void> {
    if (consentId.includes('fail')) throw new GatewayUnavailable(`fake: disabling ${consentId} failed`);
    this.disabledConsents.push(consentId);
  }

  async createIntent(input: CreateIntentInput): Promise<GatewayIntent> {
    this.createCalls.push(input);
    const known = this.byRequestId.get(input.requestId);
    if (known) return this.view(this.mustGet(known));
    if (input.description.includes('[decline]')) throw new GatewayRejected('fake: card declined');
    const intent: FakeIntent = {
      id: `int_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      status: 'REQUIRES_PAYMENT_METHOD',
      amountCents: input.amountCents,
      currency: input.currency,
      customerId: input.customerId,
      merchantOrderId: input.merchantOrderId,
      description: input.description,
      confirms: 0,
    };
    this.intents.set(intent.id, intent);
    this.byRequestId.set(input.requestId, intent.id);
    return this.view(intent);
  }

  async retrieveIntent(intentId: string): Promise<GatewayIntent> {
    return this.view(this.mustGet(intentId));
  }

  async confirmIntent(intentId: string, _consentId: string, _customerId: string): Promise<GatewayIntent> {
    const intent = this.mustGet(intentId);
    intent.confirms++;
    if (intent.status === 'SUCCEEDED') return this.view(intent);
    if (intent.description.includes('[flaky]') && intent.confirms === 1)
      throw new GatewayUnavailable('fake: timeout before confirm');
    if (intent.description.includes('[pending]')) {
      intent.status = 'REQUIRES_CUSTOMER_ACTION';
      return this.view(intent);
    }
    intent.status = 'SUCCEEDED';
    this.settlements.push({ intentId, amountCents: intent.amountCents, currency: intent.currency });
    if (intent.description.includes('[lost]') && intent.confirms === 1)
      throw new GatewayUnavailable('fake: response lost after confirm');
    return this.view(intent);
  }

  private mustGet(intentId: string): FakeIntent {
    const i = this.intents.get(intentId);
    if (!i) throw new GatewayRejected(`fake: no intent ${intentId}`);
    return i;
  }

  private view(i: FakeIntent): GatewayIntent {
    return {
      id: i.id,
      status: i.status,
      amountCents: i.amountCents,
      currency: i.currency,
      customerId: i.customerId,
      merchantOrderId: i.merchantOrderId,
    };
  }
}
