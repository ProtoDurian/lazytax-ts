import { describe, expect, it } from 'bun:test';
import { Owner, Problem } from '@lazytax/kernel';
import { type SettledCheck, stakeAmount } from '../../src/domain/penalty-service';
import { fixture } from './fakes';

const settled = (over: Partial<SettledCheck> = {}): SettledCheck => ({
  userId: 'ua',
  habitId: 'h1',
  executionId: 'e-1',
  status: 'missed',
  stakeCents: 1000,
  ratioBps: 5000,
  currency: 'USD',
  charityId: 'c1',
  ...over,
});

describe('stakeAmount', () => {
  it('should take the ratio of the stake in exact cents, floored', () => {
    // Arrange / Act / Assert
    expect(stakeAmount(1000, 5000)).toBe(500);
    expect(stakeAmount(999, 3333)).toBe(332);
    expect(stakeAmount(1000, 0)).toBe(0);
  });
});

describe('onSettled (LazyTax PenaltyStakeBinding)', () => {
  it('should enqueue one pending penalty for a missed staked check', async () => {
    // Arrange
    const f = fixture();
    // Act
    const added = await f.service.onSettled(settled());
    // Assert
    expect(added).toBe(true);
    expect(f.repo.rows).toHaveLength(1);
    expect(f.repo.rows[0]).toMatchObject({
      userId: 'ua',
      amountCents: 500,
      status: 'pending',
      habitExecutionId: 'e-1',
    });
  });

  it('should be idempotent on the execution id', async () => {
    const f = fixture();
    await f.service.onSettled(settled());
    expect(await f.service.onSettled(settled())).toBe(false);
    expect(f.repo.rows).toHaveLength(1);
  });

  it.each([
    ['done', settled({ status: 'done' })],
    ['frozen', settled({ status: 'frozen' })],
    ['vacation', settled({ status: 'vacation' })],
    ['no charity', settled({ charityId: null })],
    ['zero stake', settled({ stakeCents: 0 })],
    ['zero ratio', settled({ ratioBps: 0 })],
    ['no execution', settled({ executionId: null })],
  ])('should not enqueue for %s', async (_name, e) => {
    const f = fixture();
    expect(await f.service.onSettled(e)).toBe(false);
    expect(f.repo.rows).toHaveLength(0);
  });
});

describe('processPending (LazyTax PenaltyService.ProcessPending)', () => {
  it('should charge outside any unit, mark charged, credit the charity and emit penalty.charged once', async () => {
    // Arrange
    const f = fixture();
    const p = f.repo.seed({ userId: 'ua' });
    // Act
    const done = await f.service.processPending();
    // Assert
    expect(done).toBe(1);
    expect(f.gateway.calls).toEqual([{ id: p.id, inUnit: false }]);
    expect(f.repo.rows[0]).toMatchObject({ status: 'charged', paymentIntentId: 'int_1' });
    expect(f.repo.balances.get('c1|USD')).toBe(500);
    expect(f.events.map(e => e.type)).toEqual(['penalty.charged']);
    expect(f.events[0]?.payload).toMatchObject({
      penaltyId: p.id,
      charityName: 'Doctors Without Borders',
      amountCents: 500,
    });
  });

  it('should refuse to run inside a unit of work', async () => {
    const f = fixture();
    await expect(f.uow.run(() => f.service.processPending())).rejects.toThrow(/must not run inside/);
  });

  it('should keep a not-yet-settled intent pending with its intent id and count the attempt', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua' });
    f.gateway.next = () => ({ kind: 'pending', paymentIntentId: 'int_9', status: 'REQUIRES_CUSTOMER_ACTION' });
    expect(await f.service.processPending()).toBe(0);
    expect(f.repo.rows[0]).toMatchObject({ status: 'pending', attempts: 1, paymentIntentId: 'int_9' });
    expect(f.events).toHaveLength(0);
  });

  it('should fail and emit penalty.failed once the attempts run out', async () => {
    const f = fixture({ maxAttempts: 2 });
    f.repo.seed({ userId: 'ua', attempts: 1 });
    f.gateway.next = () => ({ kind: 'pending', paymentIntentId: 'int_9', status: 'REQUIRES_PAYMENT_METHOD' });
    expect(await f.service.processPending()).toBe(1);
    expect(f.repo.rows[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(f.repo.rows[0]?.lastError).toContain('REQUIRES_PAYMENT_METHOD');
    expect(f.events.map(e => e.type)).toEqual(['penalty.failed']);
  });

  it('should skip a penalty when the user has no consent', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua' });
    f.gateway.next = () => ({ kind: 'noConsent' });
    expect(await f.service.processPending()).toBe(1);
    expect(f.repo.rows[0]?.status).toBe('skipped');
    expect(f.events).toHaveLength(0);
  });

  it('should bump on a gateway error and isolate a throw to its own penalty', async () => {
    // Arrange
    const f = fixture();
    const a = f.repo.seed({ userId: 'ua' });
    f.repo.seed({ userId: 'ub' });
    f.gateway.next = p => {
      if (p.id === a.id) throw new Error('boom');
      return { kind: 'error', message: 'declined' };
    };
    // Act
    const done = await f.service.processPending();
    // Assert
    expect(done).toBe(0);
    expect(f.repo.rows.map(r => [r.status, r.attempts, r.lastError])).toEqual([
      ['pending', 1, 'boom'],
      ['pending', 1, 'declined'],
    ]);
  });

  it('should not claim a fresh processing row, but re-claim a stale one', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua', status: 'processing', updatedAt: '2026-03-01T00:00:00.000Z' });
    f.repo.seed({ userId: 'ub', status: 'processing', updatedAt: '2026-02-28T23:00:00.000Z' });
    await f.service.processPending();
    expect(f.gateway.calls.map(c => c.id)).toEqual(['p2']);
  });

  it('should never charge or credit a penalty twice', async () => {
    const f = fixture();
    const p = f.repo.seed({ userId: 'ua' });
    await f.service.processPending();
    // A late payment.completed and a second settle are no-ops.
    await f.service.onPaymentCompleted(p.id, 'int_1');
    expect(await f.service.settle(p.id, { kind: 'succeeded', paymentIntentId: 'int_2' })).toBe(0);
    expect(f.repo.balances.get('c1|USD')).toBe(500);
    expect(f.events).toHaveLength(1);
  });
});

describe('onPaymentCompleted', () => {
  it('should charge a penalty whose payment settled later', async () => {
    const f = fixture();
    const p = f.repo.seed({ userId: 'ua', paymentIntentId: 'int_5' });
    await f.service.onPaymentCompleted(p.id, 'int_5');
    expect(f.repo.rows[0]?.status).toBe('charged');
    expect(f.repo.balances.get('c1|USD')).toBe(500);
  });

  it('should ignore an unknown request id', async () => {
    const f = fixture();
    await f.service.onPaymentCompleted('nope', 'int_5');
    expect(f.events).toHaveLength(0);
  });
});

describe('outstanding and the delete guard (LazyTax GuardNoDebt)', () => {
  it('should owe every penalty that is not charged, per currency', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua', amountCents: 300, status: 'pending' });
    f.repo.seed({ userId: 'ua', amountCents: 200, status: 'failed' });
    f.repo.seed({ userId: 'ua', amountCents: 100, status: 'skipped' });
    f.repo.seed({ userId: 'ua', amountCents: 900, status: 'charged' });
    f.repo.seed({ userId: 'ua', amountCents: 50, currency: 'SGD' });
    f.repo.seed({ userId: 'ub', amountCents: 999 });
    const o = await f.service.outstanding('ua');
    expect(o).toEqual({
      totalCents: 600,
      currency: 'USD',
      byCurrency: [
        { currency: 'USD', totalCents: 600 },
        { currency: 'SGD', totalCents: 50 },
      ],
      count: 4,
    });
  });

  it('should block deletion with 409 account_deletion_blocked while a debt is open', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua', amountCents: 300 });
    const err = await f.service.guardNoDebt('ua').catch(e => e);
    expect(err).toBeInstanceOf(Problem);
    expect((err as Problem).status).toBe(409);
    expect((err as Problem).id).toBe('account_deletion_blocked');
    expect((err as Problem).data).toEqual({ totalDebt: 3, totalCents: 300, currency: 'USD' });
  });

  it('should let a user with no debt, or with the gate off, delete', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua', status: 'charged' });
    await f.service.guardNoDebt('ua');
    const off = fixture({ blockDeletionOnDebt: false });
    off.repo.seed({ userId: 'ua' });
    await off.service.guardNoDebt('ua');
  });
});

describe('reads', () => {
  it('should 404 on another user penalty, never 403', async () => {
    const f = fixture();
    const p = f.repo.seed({ userId: 'ua' });
    const err = await f.service.getOwned(Owner.user('ub'), p.id).catch(e => e);
    expect((err as Problem).status).toBe(404);
    expect((await f.service.getOwned(Owner.user('ua'), p.id)).id).toBe(p.id);
  });

  it('should clamp the search page', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.repo.seed({ userId: 'ua' });
    expect(await f.service.search(Owner.user('ua'), { limit: 1000 })).toHaveLength(3);
    expect(await f.service.search(Owner.user('ua'), { limit: 2, skip: 2 })).toHaveLength(1);
  });
});

describe('payouts (for disbursement)', () => {
  it('should group charged unclaimed penalties, stamp them, and release them', async () => {
    const f = fixture();
    f.repo.seed({ userId: 'ua', status: 'charged', amountCents: 300 });
    f.repo.seed({ userId: 'ub', status: 'charged', amountCents: 200 });
    f.repo.seed({ userId: 'ua', status: 'charged', amountCents: 50, charityId: 'c2' });
    f.repo.seed({ userId: 'ua', status: 'pending', amountCents: 999 });
    expect(await f.service.payoutCandidates(100)).toEqual([{ charityId: 'c1', currency: 'USD', amountCents: 500 }]);
    expect(await f.service.claimForPayout('d1', 'c1', 'USD')).toBe(500);
    expect(await f.service.payoutCandidates(0)).toEqual([{ charityId: 'c2', currency: 'USD', amountCents: 50 }]);
    await f.service.releasePayout('d1');
    await f.service.releasePayout('d1');
    expect(await f.service.claimForPayout('d2', 'c1', 'USD')).toBe(500);
  });
});
