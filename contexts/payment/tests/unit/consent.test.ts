import { describe, expect, it } from 'bun:test';
import { Owner } from '@lazytax/kernel';
import { parsePurpose } from '../../src/domain/model';
import { computeSignature } from '../../src/domain/webhook';
import { harness, SECRET } from './fakes';

const signed = (body: unknown, at: Date, secret = SECRET) => {
  const raw = JSON.stringify(body);
  const ts = String(at.getTime());
  return { raw, headers: new Headers({ 'x-timestamp': ts, 'x-signature': computeSignature(secret, ts, raw) }) };
};

const consentEvent = (customerId: string, id: string, status: string, reason?: string) => ({
  id: 'evt_1',
  name: status === 'VERIFIED' ? 'payment_consent.verified' : 'payment_consent.verification_failed',
  data: { object: { id, status, customer_id: customerId, merchant_trigger_reason: reason } },
});

describe('PaymentService consents', () => {
  it('should create a customer once and reuse it', async () => {
    // Arrange
    const h = harness();

    // Act
    const a = await h.service.createCustomer(Owner.user('u1'));
    const b = await h.service.createCustomer(Owner.user('u1'));

    // Assert
    expect(a.customerId).toBe(b.customerId);
    expect(a.clientSecret).toContain(a.customerId);
    expect(h.store.customers).toHaveLength(1);
  });

  it('should 404 the consent of a user with no customer', async () => {
    // Arrange
    const h = harness();

    // Act
    const act = h.service.getConsent(Owner.user('u1'), 'penalty');

    // Assert
    await expect(act).rejects.toMatchObject({ kind: 'not_found', id: 'entity_not_found' });
  });

  it('should revoke a consent at the gateway, drop it, email and emit consentChanged', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', { penalty: { id: 'cst_p', status: 'Verified' } });

    // Act
    await h.service.disableConsent(Owner.user('u1'), 'penalty');

    // Assert
    expect(h.gateway.disabledConsents).toEqual(['cst_p']);
    expect(await h.service.hasConsent('u1')).toBe(false);
    expect(h.notifier.sent).toEqual([{ userId: 'u1', linked: false, purpose: 'Habit stakes', inUnit: true }]);
    expect(h.outbox.of('payment.consentChanged')[0]?.payload).toEqual({
      userId: 'u1',
      purpose: 'penalty',
      linked: false,
    });
  });

  it('should 404 disabling a purpose that has no consent', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', { penalty: { id: 'cst_p', status: 'Verified' } });

    // Act
    const act = h.service.disableConsent(Owner.user('u1'), 'subscription');

    // Assert
    await expect(act).rejects.toMatchObject({ kind: 'not_found' });
    expect(h.gateway.disabledConsents).toHaveLength(0);
  });

  it('should try every purpose in revokeAll, keep going after a failure, then throw it, without email', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', {
      penalty: { id: 'cst_fail_p', status: 'Verified' },
      subscription: { id: 'cst_s', status: 'Verified' },
    });

    // Act
    const act = h.service.revokeAll('u1');

    // Assert
    await expect(act).rejects.toThrow('cst_fail_p');
    expect(h.gateway.disabledConsents).toEqual(['cst_s']);
    expect(await h.service.hasConsent('u1', 'subscription')).toBe(false);
    expect(await h.service.hasConsent('u1', 'penalty')).toBe(true);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('should do nothing in revokeAll for a user with no customer', async () => {
    // Arrange
    const h = harness();

    // Act
    await h.service.revokeAll('nobody');

    // Assert
    expect(h.gateway.disabledConsents).toHaveLength(0);
  });

  it('should keep a consent stored concurrently when the revoked id no longer matches', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1', { penalty: { id: 'cst_old', status: 'Verified' } });
    const realDisable = h.gateway.disableConsent;
    h.gateway.disableConsent = async id => {
      await realDisable(id);
      // A webhook stores a newer consent between the gateway revoke and the row delete.
      await h.store.setConsent(Owner.user('u1'), c, 'penalty', 'cst_new', 'Verified');
    };

    // Act
    await h.service.disableConsent(Owner.user('u1'), 'penalty');

    // Assert
    expect(await h.service.getConsent(Owner.user('u1'), 'penalty')).toMatchObject({
      consentId: 'cst_new',
      hasPaymentConsent: true,
    });
  });

  it('should parse the purpose like LazyTax', () => {
    // Arrange / Act / Assert
    expect(parsePurpose(undefined)).toBe('penalty');
    expect(parsePurpose('')).toBe('penalty');
    expect(parsePurpose('PENALTY')).toBe('penalty');
    expect(parsePurpose('Subscription')).toBe('subscription');
    expect(() => parsePurpose('gift')).toThrow('Invalid purpose');
  });
});

describe('PaymentService webhook', () => {
  it('should store a verified penalty consent, email and emit linked', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const { raw, headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_v', 'VERIFIED', 'unscheduled'), h.now);

    // Act
    await h.service.handleWebhook(headers, raw);

    // Assert
    expect(await h.service.hasConsent('u1', 'penalty')).toBe(true);
    expect(h.notifier.sent).toEqual([{ userId: 'u1', linked: true, purpose: 'Habit stakes', inUnit: true }]);
    expect(h.outbox.of('payment.consentChanged')[0]?.payload).toEqual({
      userId: 'u1',
      purpose: 'penalty',
      linked: true,
    });
  });

  it('should classify a scheduled consent as subscription', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const { raw, headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_s', 'VERIFIED', 'scheduled'), h.now);

    // Act
    await h.service.handleWebhook(headers, raw);

    // Assert
    expect(await h.service.hasConsent('u1', 'subscription')).toBe(true);
    expect(await h.service.hasConsent('u1', 'penalty')).toBe(false);
  });

  it('should store a failed verification without email', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const { raw, headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_f', 'REQUIRES_PAYMENT_METHOD'), h.now);

    // Act
    await h.service.handleWebhook(headers, raw);

    // Assert
    expect(await h.service.getConsent(Owner.user('u1'), 'penalty')).toMatchObject({
      consentId: 'cst_f',
      status: 'RequiresPaymentMethod',
      hasPaymentConsent: false,
    });
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('should refuse a wrong signature with 403 and change nothing', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const { raw, headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_v', 'VERIFIED'), h.now, 'other-secret');

    // Act
    const act = h.service.handleWebhook(headers, raw);

    // Assert
    await expect(act).rejects.toMatchObject({ kind: 'unauthorized', id: 'webhook_signature_invalid' });
    expect(await h.service.hasConsent('u1')).toBe(false);
  });

  it('should refuse a stale timestamp even with a good signature', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const old = new Date(h.now.getTime() - 301_000);
    const { raw, headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_v', 'VERIFIED'), old);

    // Act
    const act = h.service.handleWebhook(headers, raw);

    // Assert
    await expect(act).rejects.toMatchObject({ id: 'webhook_signature_invalid' });
  });

  it('should refuse a body changed after signing', async () => {
    // Arrange
    const h = harness();
    const c = h.store.seed('u1');
    const { headers } = signed(consentEvent(c.airwallexCustomerId, 'cst_v', 'VERIFIED'), h.now);
    const tampered = JSON.stringify(consentEvent(c.airwallexCustomerId, 'cst_evil', 'VERIFIED'));

    // Act
    const act = h.service.handleWebhook(headers, tampered);

    // Assert
    await expect(act).rejects.toMatchObject({ id: 'webhook_signature_invalid' });
  });

  it('should ignore an event for an unknown customer', async () => {
    // Arrange
    const h = harness();
    const { raw, headers } = signed(consentEvent('cus_unknown', 'cst_v', 'VERIFIED'), h.now);

    // Act
    await h.service.handleWebhook(headers, raw);

    // Assert
    expect(h.outbox.events).toHaveLength(0);
  });

  it('should settle a pending charge on payment_intent.succeeded and emit completed once', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', { penalty: { id: 'cst_p', status: 'Verified' } });
    const pending = await h.service.charge('pen-w', 'u1', 500, 'SGD', 'penalty', 'stake [pending]');
    const evt = { id: 'evt_2', name: 'payment_intent.succeeded', data: { object: { id: pending.intentId } } };
    const { raw, headers } = signed(evt, h.now);

    // Act
    await h.service.handleWebhook(headers, raw);
    await h.service.handleWebhook(headers, raw);

    // Assert
    expect((await h.service.getCharge('pen-w'))?.status).toBe('succeeded');
    expect(h.outbox.of('payment.completed')).toHaveLength(1);
  });
});
