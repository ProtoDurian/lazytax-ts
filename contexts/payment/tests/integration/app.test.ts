// The payment context in the whole app: HTTP routes with auth layers 1-4, the webhook, MCP, the
// payment.v1 contract and account deletion (beforePurge revoke + purgeUser).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Owner } from '@lazytax/kernel';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';
import { computeSignature } from '../../src/domain/webhook';

const SECRET = 'app-secret';
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ contexts: ['payment', 'account'], config: { payment: { webhookSecret: SECRET } } });
});
afterAll(() => app.close());

const base = (a: Actor) => `/api/v1/Payment/${a.sub}`;

async function createCustomer(a: Actor): Promise<string> {
  const res = await app.request(a, { method: 'PUT', path: `${base(a)}/customers` });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { customerId: string; clientSecret: string };
  expect(body.clientSecret).toBeString();
  return body.customerId;
}

// Airwallex's webhook, signed the way Airwallex signs it.
async function webhook(event: unknown, opts: { secret?: string; at?: number } = {}): Promise<Response> {
  const raw = JSON.stringify(event);
  const ts = String(opts.at ?? Date.now());
  const sig = computeSignature(opts.secret ?? SECRET, ts, raw);
  return app.request(null, {
    method: 'POST',
    path: '/api/v1/Payment/webhook',
    body: event,
    headers: { 'x-timestamp': ts, 'x-signature': sig },
  });
}

const consentVerified = (customerId: string, consentId: string, reason = 'unscheduled') => ({
  id: `evt_${consentId}`,
  name: 'payment_consent.verified',
  data: { object: { id: consentId, status: 'VERIFIED', customer_id: customerId, merchant_trigger_reason: reason } },
});

async function linked(a: Actor, consentId = `cst_${a.sub}`): Promise<string> {
  const customerId = await createCustomer(a);
  const res = await webhook(consentVerified(customerId, consentId));
  expect(res.status).toBeLessThan(300);
  return customerId;
}

describe('auth layers', () => {
  it('should 401 without a token', async () => {
    const a = await app.user();
    const res = await app.request(null, { method: 'GET', path: `${base(a)}/consent` });
    await expectProblem(res, 401, 'unauthenticated');
  });

  it("should 403 a user on another user's path", async () => {
    const a = await app.user();
    const b = await app.user();
    const res = await app.request(b, { method: 'GET', path: `${base(a)}/consent` });
    await expectProblem(res, 403);
  });

  it('should 404 the consent of a user with no payment customer', async () => {
    const a = await app.user();
    const res = await app.request(a, { method: 'GET', path: `${base(a)}/consent` });
    await expectProblem(res, 404, 'entity_not_found');
  });

  it('should 400 an unknown purpose', async () => {
    const a = await app.user();
    await createCustomer(a);
    const res = await app.request(a, { method: 'GET', path: `${base(a)}/consent`, query: { purpose: 'gift' } });
    await expectProblem(res, 400, 'validation_error');
  });
});

describe('owner scoping (layer 4)', () => {
  it("should 404 user B revoking while only user A holds a consent, and keep A's", () =>
    expectOwnerScoped(app, {
      seed: async a => {
        await linked(a);
        return a.sub;
      },
      request: (_aSub, b) => ({ method: 'DELETE', path: `${base(b)}/consent` }),
      unchanged: aSub => app.sql`SELECT consent_id, status FROM payment.consents WHERE user_id = ${aSub}`,
    }));

  it("should 404 user B confirming user A's payment intent", async () => {
    const b = await app.user();
    await createCustomer(b);
    await expectOwnerScoped(app, {
      seed: async a => {
        await createCustomer(a);
        const res = await app.request(a, {
          method: 'POST',
          path: `${base(a)}/intent`,
          body: { amount: 12.5, currency: 'SGD', description: 'top up' },
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { paymentIntentId: string }).paymentIntentId;
      },
      request: (id, caller) => ({
        method: 'POST',
        path: `${base(caller)}/intent/${id}`,
        body: { paymentConsentId: 'cst_whatever' },
      }),
    });
  });

  it("should refuse user B's charge on user A's request id and keep A's row", async () => {
    const a = await app.user();
    const b = await app.user();
    await linked(a);
    await linked(b);
    const pay = app.contract('payment.v1');
    await pay.charge(`req-${a.sub}`, a.sub, 100, 'SGD', 'penalty');
    const before = await app.sql`SELECT * FROM payment.charges WHERE request_id = ${`req-${a.sub}`}`;

    await expect(pay.charge(`req-${a.sub}`, b.sub, 100, 'SGD', 'penalty')).rejects.toMatchObject({
      id: 'charge_request_conflict',
    });

    expect(await app.sql`SELECT * FROM payment.charges WHERE request_id = ${`req-${a.sub}`}`).toEqual(before);
  });
});

describe('consent flow', () => {
  it('should link through the webhook, then unlink by DELETE', async () => {
    const a = await app.user();
    await linked(a);

    const got = await app.request(a, { method: 'GET', path: `${base(a)}/consent` });
    expect(await got.json()).toEqual({ hasPaymentConsent: true, consentId: `cst_${a.sub}`, status: 'Verified' });

    const del = await app.request(a, { method: 'DELETE', path: `${base(a)}/consent` });
    expect(del.status).toBe(204);
    expect(await app.contract('payment.v1').hasConsent(a.sub)).toBe(false);
    const changed = await app.sql`
      SELECT payload FROM kernel.outbox_events WHERE type = 'payment.consentChanged' AND user_id = ${a.sub}`;
    expect(changed).toHaveLength(2);
  });

  it('should 403 a webhook with a bad signature and change nothing', async () => {
    const a = await app.user();
    const customerId = await createCustomer(a);
    const res = await webhook(consentVerified(customerId, 'cst_bad'), { secret: 'wrong' });
    await expectProblem(res, 403, 'webhook_signature_invalid');
    expect(await app.contract('payment.v1').hasConsent(a.sub)).toBe(false);
  });

  it('should 403 a replayed webhook older than the tolerance', async () => {
    const a = await app.user();
    const customerId = await createCustomer(a);
    const res = await webhook(consentVerified(customerId, 'cst_old'), { at: Date.now() - 10 * 60_000 });
    await expectProblem(res, 403, 'webhook_signature_invalid');
  });

  it('should serve the consent over MCP with the same subject rule', async () => {
    const a = await app.user();
    const b = await app.user();
    await linked(a);
    const ok = await app.mcp(a, 'payment.getConsent', { userId: a.sub });
    expect(ok).toMatchObject({ ok: true, data: { hasPaymentConsent: true } });
    const denied = await app.mcp(b, 'payment.getConsent', { userId: a.sub });
    expect(denied.ok).toBe(false);
  });
});

describe('payment.v1 charge', () => {
  it('should settle once and put one payment.completed in the outbox', async () => {
    const a = await app.user();
    await linked(a);
    const pay = app.contract('payment.v1');
    const first = await pay.charge(`pen-${a.sub}`, a.sub, 2500, 'SGD', 'penalty');
    const again = await pay.charge(`pen-${a.sub}`, a.sub, 2500, 'SGD', 'penalty');
    expect(first.status).toBe('succeeded');
    expect(again.intentId).toBe(first.intentId);
    const events = await app.sql`
      SELECT payload FROM kernel.outbox_events WHERE type = 'payment.completed' AND user_id = ${a.sub}`;
    expect(events).toHaveLength(1);
  });

  it('should say no_consent without a verified consent', async () => {
    const a = await app.user();
    const r = await app.contract('payment.v1').charge(`pen-${a.sub}`, a.sub, 100, 'SGD', 'penalty');
    expect(r.status).toBe('no_consent');
  });

  it('should refuse a call from inside a unit of work', async () => {
    const a = await app.user();
    await expect(
      app.uow.run(() => app.contract('payment.v1').charge(`pen-${a.sub}`, a.sub, 100, 'SGD', 'penalty')),
    ).rejects.toThrow('outside a unit of work');
  });
});

describe('account deletion', () => {
  it("should revoke A's consents and leave 0 rows of A in payment.*, B untouched", async () => {
    const a = await app.user();
    const b = await app.user();
    await linked(a);
    await linked(b);
    await app.contract('payment.v1').charge(`pen-${a.sub}`, a.sub, 100, 'SGD', 'penalty');

    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    expect(res.status).toBeLessThan(300);

    const left = await app.sql`
      SELECT (SELECT count(*) FROM payment.customers WHERE user_id = ${a.sub})
           + (SELECT count(*) FROM payment.consents WHERE user_id = ${a.sub})
           + (SELECT count(*) FROM payment.charges WHERE user_id = ${a.sub}) AS n`;
    expect(Number(left[0].n)).toBe(0);
    expect(await app.contract('payment.v1').hasConsent(b.sub)).toBe(true);
    expect(await app.contract('payment.v1').getConsent(Owner.user(b.sub), 'penalty')).toMatchObject({
      consentId: `cst_${b.sub}`,
    });
  });
});
