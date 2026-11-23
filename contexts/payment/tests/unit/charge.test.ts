import { describe, expect, it } from 'bun:test';
import { Problem } from '@lazytax/kernel';
import { harness } from './fakes';

const verified = { penalty: { id: 'cst_pen_1', status: 'Verified' as const } };

describe('PaymentService.charge', () => {
  it('should charge once and emit payment.completed once when the consent is verified', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const first = await h.service.charge('pen-1', 'u1', 1500, 'SGD', 'penalty');
    const again = await h.service.charge('pen-1', 'u1', 1500, 'SGD', 'penalty');

    // Assert
    expect(first.status).toBe('succeeded');
    expect(first.attempt).toBe(1);
    expect(again).toEqual(first);
    expect(h.gateway.settlements).toHaveLength(1);
    expect(h.gateway.createCalls[0]?.requestId).toBe('pen-1-1');
    expect(h.outbox.of('payment.completed')).toHaveLength(1);
    expect(h.outbox.of('payment.completed')[0]?.payload).toMatchObject({
      requestId: 'pen-1',
      userId: 'u1',
      kind: 'penalty',
      amountCents: 1500,
      currency: 'SGD',
    });
  });

  it('should return no_consent and send nothing when the user has no customer', async () => {
    // Arrange
    const h = harness();

    // Act
    const r = await h.service.charge('pen-2', 'u1', 100, 'SGD', 'penalty');

    // Assert
    expect(r.status).toBe('no_consent');
    expect(h.gateway.createCalls).toHaveLength(0);
    expect(h.outbox.events).toHaveLength(0);
  });

  it('should return no_consent when only the other purpose is verified', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', { subscription: { id: 'cst_sub', status: 'Verified' } });

    // Act
    const r = await h.service.charge('pen-3', 'u1', 100, 'SGD', 'penalty');

    // Assert
    expect(r.status).toBe('no_consent');
  });

  it('should return no_consent when the consent is not verified', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', { penalty: { id: 'cst_x', status: 'RequiresPaymentMethod' } });

    // Act
    const r = await h.service.charge('pen-4', 'u1', 100, 'SGD', 'penalty');

    // Assert
    expect(r.status).toBe('no_consent');
    expect(h.gateway.createCalls).toHaveLength(0);
  });

  it('should mark a definitive rejection declined, emit payment.failed, and start attempt 2 on retry', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const first = await h.service.charge('pen-5', 'u1', 100, 'SGD', 'penalty', 'stake [decline]');
    const second = await h.service.charge('pen-5', 'u1', 100, 'SGD', 'penalty', 'stake [decline]');

    // Assert
    expect(first.status).toBe('declined');
    expect(first.intentId).toBeNull();
    expect(second.attempt).toBe(2);
    expect(h.gateway.createCalls.map(c => c.requestId)).toEqual(['pen-5-1', 'pen-5-2']);
    expect(h.outbox.of('payment.failed')).toHaveLength(2);
    expect(h.gateway.settlements).toHaveLength(0);
  });

  it('should never charge twice when the confirm response is lost', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const lost = await h.service.charge('pen-6', 'u1', 900, 'SGD', 'penalty', 'stake [lost]');
    const retry = await h.service.charge('pen-6', 'u1', 900, 'SGD', 'penalty', 'stake [lost]');

    // Assert
    expect(lost.status).toBe('pending');
    expect(lost.intentId).not.toBeNull();
    expect(retry.status).toBe('succeeded');
    expect(retry.intentId).toBe(lost.intentId);
    expect(retry.attempt).toBe(1);
    expect(h.gateway.settlements).toHaveLength(1);
    expect(h.gateway.createCalls).toHaveLength(1);
    expect(h.outbox.of('payment.completed')).toHaveLength(1);
  });

  it('should confirm the same intent after a timeout before confirm', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const first = await h.service.charge('pen-7', 'u1', 900, 'SGD', 'penalty', 'stake [flaky]');
    const retry = await h.service.charge('pen-7', 'u1', 900, 'SGD', 'penalty', 'stake [flaky]');

    // Assert
    expect(first.status).toBe('pending');
    expect(retry.status).toBe('succeeded');
    expect(retry.intentId).toBe(first.intentId);
    expect(h.gateway.settlements).toHaveLength(1);
  });

  it('should stay pending with the intent kept when the gateway needs customer action', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const r = await h.service.charge('pen-8', 'u1', 900, 'SGD', 'penalty', 'stake [pending]');

    // Assert
    expect(r.status).toBe('pending');
    expect(r.detail).toBe('REQUIRES_CUSTOMER_ACTION');
    expect(h.store.charges.get('pen-8')?.intentId).toBe(r.intentId);
    expect(h.outbox.events).toHaveLength(0);
  });

  it('should refuse to run inside a unit of work', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);

    // Act
    const act = h.uow.run(() => h.service.charge('pen-9', 'u1', 100, 'SGD', 'penalty'));

    // Assert
    await expect(act).rejects.toThrow('outside a unit of work');
  });

  it('should 409 when a request id is reused with other terms', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);
    await h.service.charge('pen-10', 'u1', 100, 'SGD', 'penalty');

    // Act
    const act = h.service.charge('pen-10', 'u1', 200, 'SGD', 'penalty');

    // Assert
    await expect(act).rejects.toMatchObject({ kind: 'conflict', id: 'charge_request_conflict' });
  });

  it("should 409 when another user's request id is reused", async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);
    h.store.seed('u2', { penalty: { id: 'cst_pen_2', status: 'Verified' } });
    await h.service.charge('pen-11', 'u1', 100, 'SGD', 'penalty');

    // Act
    const act = h.service.charge('pen-11', 'u2', 100, 'SGD', 'penalty');

    // Assert
    await expect(act).rejects.toBeInstanceOf(Problem);
    expect(h.gateway.settlements).toHaveLength(1);
  });

  it('should reject a bad amount or currency before touching anything', async () => {
    // Arrange
    const h = harness();

    // Act
    const zero = h.service.charge('pen-12', 'u1', 0, 'SGD', 'penalty');
    const fraction = h.service.charge('pen-12', 'u1', 1.5, 'SGD', 'penalty');
    const currency = h.service.charge('pen-12', 'u1', 100, 'XYZ', 'penalty');

    // Assert
    await expect(zero).rejects.toMatchObject({ kind: 'validation' });
    await expect(fraction).rejects.toMatchObject({ kind: 'validation' });
    await expect(currency).rejects.toMatchObject({ kind: 'validation' });
    expect(h.store.charges.size).toBe(0);
  });

  it('should report a charge by request id through getCharge', async () => {
    // Arrange
    const h = harness();
    h.store.seed('u1', verified);
    await h.service.charge('pen-13', 'u1', 100, 'SGD', 'penalty');

    // Act
    const r = await h.service.getCharge('pen-13');
    const none = await h.service.getCharge('missing');

    // Assert
    expect(r?.status).toBe('succeeded');
    expect(none).toBeNull();
  });
});
