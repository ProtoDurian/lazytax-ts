// SQL for payment.* (LazyTax App/Modules/Payment/Data/PaymentCustomerRepository.cs). Every method
// that reads or changes user data takes the Owner first and filters on it in its first query.
import { type Owner, ownerFilter, type UnitOfWork } from '@lazytax/kernel';
import type { ConsentPurpose, ConsentStatus } from '@lazytax/payment-contract/v1';
import type { ChargeRow, ChargeRowStatus, ConsentRow, CustomerRow } from '../domain/model';

interface CustomerSql {
  id: string;
  user_id: string;
  airwallex_customer_id: string;
  created_at: Date;
  updated_at: Date;
}

interface ConsentSql {
  customer_id: string;
  purpose: ConsentPurpose;
  consent_id: string;
  status: ConsentStatus | null;
}

interface ChargeSql {
  request_id: string;
  user_id: string;
  amount_cents: string | number;
  currency: string;
  purpose: ConsentPurpose;
  description: string;
  status: ChargeRowStatus;
  attempt: number;
  intent_id: string | null;
  detail: string | null;
}

export interface ChargePatch {
  status: ChargeRowStatus;
  attempt?: number;
  intentId?: string | null;
  detail?: string | null;
  completed?: boolean;
}

const toCharge = (r: ChargeSql): ChargeRow => ({
  requestId: r.request_id,
  userId: r.user_id,
  amountCents: Number(r.amount_cents),
  currency: r.currency,
  purpose: r.purpose,
  description: r.description,
  status: r.status,
  attempt: r.attempt,
  intentId: r.intent_id,
  detail: r.detail,
});

// Account deletion anonymises the charge ledger instead of dropping money records.
export const DELETED_USER = 'deleted-user';

export class PaymentRepository {
  constructor(private readonly uow: UnitOfWork) {}

  // The owner's customer with its consents (Owner.user), or by Airwallex id for the webhook.
  async getCustomer(owner: Owner, by: { airwallexCustomerId?: string } = {}): Promise<CustomerRow | null> {
    const db = this.uow.db();
    if (owner.kind === 'anyone' && by.airwallexCustomerId === undefined)
      throw new Error('getCustomer: Owner.anyone needs an airwallexCustomerId');
    const byAirwallex =
      by.airwallexCustomerId === undefined ? db`` : db`AND c.airwallex_customer_id = ${by.airwallexCustomerId}`;
    const rows: CustomerSql[] = await db`
      SELECT c.id, c.user_id, c.airwallex_customer_id, c.created_at, c.updated_at
      FROM payment.customers c
      WHERE true ${ownerFilter(db, owner, 'c.user_id')} ${byAirwallex}
      LIMIT 1`;
    const c = rows[0];
    if (!c) return null;
    const consents: ConsentSql[] = await db`
      SELECT customer_id, purpose, consent_id, status FROM payment.consents WHERE customer_id = ${c.id}
      ORDER BY purpose`;
    return {
      id: c.id,
      userId: c.user_id,
      airwallexCustomerId: c.airwallex_customer_id,
      consents: consents.map((x): ConsentRow => ({ purpose: x.purpose, consentId: x.consent_id, status: x.status })),
      createdAt: c.created_at.toISOString(),
      updatedAt: c.updated_at.toISOString(),
    };
  }

  // Idempotent: a second create for the same user keeps the first row.
  async createCustomer(owner: Owner, airwallexCustomerId: string, now: Date): Promise<CustomerRow> {
    if (owner.kind !== 'user') throw new Error('createCustomer needs Owner.user');
    const db = this.uow.db();
    await db`
      INSERT INTO payment.customers (user_id, airwallex_customer_id, created_at, updated_at)
      VALUES (${owner.userId}, ${airwallexCustomerId}, ${now}, ${now})
      ON CONFLICT (user_id) DO NOTHING`;
    const row = await this.getCustomer(owner);
    if (!row) throw new Error('createCustomer: row vanished');
    return row;
  }

  // LazyTax UpdatePaymentConsentByAirwallexCustomerId: a null consent id removes the purpose's row.
  async setConsent(
    owner: Owner,
    customer: CustomerRow,
    purpose: ConsentPurpose,
    consentId: string | null,
    status: ConsentStatus | null,
    now: Date,
  ): Promise<void> {
    const db = this.uow.db();
    const own: { id: string }[] = await db`
      SELECT id FROM payment.customers c WHERE c.id = ${customer.id} ${ownerFilter(db, owner, 'c.user_id')}`;
    if (own.length === 0) return;
    if (consentId === null) {
      await db`DELETE FROM payment.consents WHERE customer_id = ${customer.id} AND purpose = ${purpose}`;
    } else {
      await db`
        INSERT INTO payment.consents (customer_id, user_id, purpose, consent_id, status, created_at, updated_at)
        VALUES (${customer.id}, ${customer.userId}, ${purpose}, ${consentId}, ${status}, ${now}, ${now})
        ON CONFLICT (customer_id, purpose)
        DO UPDATE SET consent_id = EXCLUDED.consent_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`;
    }
    await db`UPDATE payment.customers SET updated_at = ${now} WHERE id = ${customer.id}`;
  }

  // Deletes the purpose's consent ONLY if it still holds expectedConsentId (a consent stored
  // concurrently, e.g. by a webhook between the gateway revoke and here, survives).
  async deleteConsentIf(owner: Owner, purpose: ConsentPurpose, expectedConsentId: string, now: Date): Promise<boolean> {
    const db = this.uow.db();
    const rows: { id: string }[] = await db`
      DELETE FROM payment.consents k
      WHERE k.purpose = ${purpose} AND k.consent_id = ${expectedConsentId} ${ownerFilter(db, owner, 'k.user_id')}
      RETURNING k.id`;
    await db`UPDATE payment.customers c SET updated_at = ${now} WHERE true ${ownerFilter(db, owner, 'c.user_id')}`;
    return rows.length > 0;
  }

  // forUpdate: lock the row for the rest of the unit (phase 1 and phase 3 of a charge).
  async getCharge(owner: Owner, requestId: string, forUpdate = false): Promise<ChargeRow | null> {
    const db = this.uow.db();
    const lock = forUpdate ? db`FOR UPDATE` : db``;
    const rows: ChargeSql[] = await db`
      SELECT request_id, user_id, amount_cents, currency, purpose, description, status, attempt, intent_id, detail
      FROM payment.charges ch
      WHERE ch.request_id = ${requestId} ${ownerFilter(db, owner, 'ch.user_id')}
      ${lock}`;
    return rows[0] ? toCharge(rows[0]) : null;
  }

  // The webhook's lookup: which charge holds this gateway intent.
  async getChargeByIntent(owner: Owner, intentId: string): Promise<ChargeRow | null> {
    const db = this.uow.db();
    const rows: ChargeSql[] = await db`
      SELECT request_id, user_id, amount_cents, currency, purpose, description, status, attempt, intent_id, detail
      FROM payment.charges ch
      WHERE ch.intent_id = ${intentId} ${ownerFilter(db, owner, 'ch.user_id')}
      LIMIT 1`;
    return rows[0] ? toCharge(rows[0]) : null;
  }

  // Inserts the charge row once; returns false when it already existed (then read it FOR UPDATE).
  async insertCharge(owner: Owner, row: ChargeRow, now: Date): Promise<boolean> {
    if (owner.kind !== 'user' || owner.userId !== row.userId) throw new Error('insertCharge needs the row owner');
    const db = this.uow.db();
    const rows: { request_id: string }[] = await db`
      INSERT INTO payment.charges
        (request_id, user_id, amount_cents, currency, purpose, description, status, attempt, intent_id, detail,
         created_at, updated_at)
      VALUES (${row.requestId}, ${row.userId}, ${row.amountCents}, ${row.currency}, ${row.purpose},
              ${row.description}, ${row.status}, ${row.attempt}, ${row.intentId}, ${row.detail}, ${now}, ${now})
      ON CONFLICT (request_id) DO NOTHING
      RETURNING request_id`;
    return rows.length > 0;
  }

  async updateCharge(owner: Owner, requestId: string, patch: ChargePatch, now: Date): Promise<void> {
    const db = this.uow.db();
    const attempt = patch.attempt === undefined ? db`` : db`, attempt = ${patch.attempt}`;
    const intent = patch.intentId === undefined ? db`` : db`, intent_id = ${patch.intentId}`;
    const detail = patch.detail === undefined ? db`` : db`, detail = ${patch.detail}`;
    const completed = patch.completed ? db`, completed_at = ${now}` : db``;
    await db`
      UPDATE payment.charges ch SET status = ${patch.status}, updated_at = ${now} ${attempt} ${intent} ${detail} ${completed}
      WHERE ch.request_id = ${requestId} ${ownerFilter(db, owner, 'ch.user_id')}`;
  }

  // The purge hook: the one method that takes a bare userId. Customers and consents go; the
  // charge ledger is anonymised (money records), so no row of the user is left in payment.*.
  async purgeUser(userId: string): Promise<void> {
    const db = this.uow.db();
    await db`DELETE FROM payment.consents WHERE user_id = ${userId}`;
    await db`DELETE FROM payment.customers WHERE user_id = ${userId}`;
    await db`UPDATE payment.charges SET user_id = ${DELETED_USER}, detail = NULL WHERE user_id = ${userId}`;
  }
}
