import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

const SECRET = 'penalty-it-secret';
let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ now: '2026-03-01T00:00:00Z', config: { payment: { webhookSecret: SECRET } } });
});
afterAll(() => app.close());
beforeEach(async () => {
  app.clock.set('2026-03-01T00:00:00Z');
  await app.sql`DELETE FROM penalty.penalties`;
  await app.sql`DELETE FROM penalty.charity_balances`;
});

const CHARITY = '11111111-1111-1111-1111-111111111111';

async function seedPenalty(userId: string, over: { cents?: number; status?: string; currency?: string } = {}) {
  const [row] = await app.sql`
    INSERT INTO penalty.penalties (habit_execution_id, habit_id, user_id, charity_id, amount_cents, currency, status)
    VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${userId}, ${CHARITY}, ${over.cents ?? 500},
            ${over.currency ?? 'USD'}, ${over.status ?? 'pending'})
    RETURNING id`;
  return String(row.id);
}

// Puts a check.settled event in the outbox as check would, with a delivery for penalty.
async function settle(payload: Record<string, unknown>) {
  const [e] = await app.sql`
    INSERT INTO kernel.outbox_events (type, payload, user_id)
    VALUES ('check.settled', ${JSON.stringify(payload)}::text::jsonb, ${payload.userId as string}) RETURNING id`;
  await app.sql`INSERT INTO kernel.outbox_deliveries (event_id, subscriber) VALUES (${e.id}, 'penalty.check.settled')`;
  await app.drainOutbox();
}

const settled = (userId: string, executionId: string, over: Record<string, unknown> = {}) => ({
  userId,
  habitId: crypto.randomUUID(),
  habitVersionId: crypto.randomUUID(),
  checkId: crypto.randomUUID(),
  executionId,
  date: '2026-02-28',
  status: 'missed',
  stakeCents: 1000,
  ratioBps: 5000,
  currency: 'USD',
  charityId: CHARITY,
  maxStreak: 0,
  adopted: false,
  ...over,
});

const get = (actor: Actor | null, path: string) => app.request(actor, { method: 'GET', path });

describe('check.settled -> pending penalty (LazyTax PenaltyStakeBinding)', () => {
  it('should enqueue one penalty per missed execution, exactly once', async () => {
    // Arrange
    const a = await app.user();
    const exec = crypto.randomUUID();
    // Act
    await settle(settled(a.sub, exec));
    await settle(settled(a.sub, exec));
    await settle(settled(a.sub, crypto.randomUUID(), { status: 'done' }));
    // Assert
    const rows = await app.sql`SELECT amount_cents, status FROM penalty.penalties WHERE user_id = ${a.sub}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_cents)).toBe(500);
    expect(rows[0].status).toBe('pending');
  });
});

describe('GET /api/v1/Penalty/:userId', () => {
  it('should list only the caller penalties', async () => {
    const a = await app.user();
    const b = await app.user();
    await seedPenalty(a.sub);
    await seedPenalty(b.sub);
    const res = await get(a, `/api/v1/Penalty/${a.sub}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string }[];
    expect(body.map(p => p.userId)).toEqual([a.sub]);
  });

  it('should 401 with no token', async () => {
    const a = await app.user();
    await expectProblem(await get(null, `/api/v1/Penalty/${a.sub}`), 401, 'unauthenticated');
  });

  it("should 403 on another user's id in the path", async () => {
    const a = await app.user();
    const b = await app.user();
    await expectProblem(await get(b, `/api/v1/Penalty/${a.sub}`), 403, 'unauthorized');
  });

  it('should 404 on an unknown penalty', async () => {
    const a = await app.user();
    await expectProblem(await get(a, `/api/v1/Penalty/${a.sub}/${crypto.randomUUID()}`), 404, 'entity_not_found');
  });

  it("should 404 user B on user A's penalty, and change nothing", () =>
    expectOwnerScoped(app, {
      seed: owner => seedPenalty(owner.sub),
      request: (id, caller) => ({ method: 'GET', path: `/api/v1/Penalty/${caller.sub}/${id}` }),
      unchanged: id => app.sql`SELECT * FROM penalty.penalties WHERE id = ${id}`,
    }));
});

describe('GET /api/v1/Penalty/:userId/outstanding', () => {
  it('should owe what is not charged', async () => {
    const a = await app.user();
    await seedPenalty(a.sub, { cents: 300 });
    await seedPenalty(a.sub, { cents: 200, status: 'failed' });
    await seedPenalty(a.sub, { cents: 900, status: 'charged' });
    const res = await get(a, `/api/v1/Penalty/${a.sub}/outstanding`);
    expect(await res.json()).toMatchObject({ totalCents: 500, currency: 'USD', count: 2 });
  });
});

describe('admin routes', () => {
  it('should 403 a user on the charity ledger', async () => {
    const a = await app.user();
    await expectProblem(await get(a, '/api/v1/Penalty/admin/charity-balances'), 403, 'unauthorized');
  });

  it('should drain: a user without a consent is skipped, not charged', async () => {
    const a = await app.user();
    const id = await seedPenalty(a.sub);
    const admin = await app.admin();
    const res = await app.request(admin, { method: 'POST', path: '/api/v1/Penalty/admin/process' });
    expect(await res.json()).toEqual({ processed: 1 });
    const [row] = await app.sql`SELECT status FROM penalty.penalties WHERE id = ${id}`;
    expect(row.status).toBe('skipped');
    expect(await (await get(admin, '/api/v1/Penalty/admin/charity-balances')).json()).toEqual([]);
  });
});

describe('MCP', () => {
  it('should serve penalty.get with the same owner scope', async () => {
    const a = await app.user();
    const b = await app.user();
    const id = await seedPenalty(a.sub);
    const mine = await app.mcp(a, 'penalty.get', { userId: a.sub, id });
    expect(mine.ok).toBe(true);
    const theirs = await app.mcp(b, 'penalty.get', { userId: b.sub, id });
    expect(theirs.ok).toBe(false);
    expect(theirs.problem?.status).toBe(404);
  });
});

describe('account deletion', () => {
  it('should block deletion with 409 while a debt is open', async () => {
    const a = await app.user();
    await seedPenalty(a.sub, { cents: 300 });
    await expectProblem(
      await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' }),
      409,
      'account_deletion_blocked',
    );
    expect(await app.sql`SELECT id FROM penalty.penalties WHERE user_id = ${a.sub}`).toHaveLength(1);
  });

  it("should purge: 0 of A's rows left, the money facts kept, B untouched", async () => {
    // Arrange
    const a = await app.user();
    const b = await app.user();
    await seedPenalty(a.sub, { status: 'charged' });
    await seedPenalty(b.sub);
    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    // Assert
    expect(res.status).toBeLessThan(300);
    expect(await app.sql`SELECT id FROM penalty.penalties WHERE user_id = ${a.sub}`).toHaveLength(0);
    expect(await app.sql`SELECT id FROM penalty.penalties WHERE user_id = 'deleted-user'`).toHaveLength(1);
    expect(await app.sql`SELECT id FROM penalty.penalties WHERE user_id = ${b.sub}`).toHaveLength(1);
  });
});

// A user with a verified penalty consent, through payment's own routes and its signed webhook.
async function withConsent(a: Actor): Promise<void> {
  const res = await app.request(a, { method: 'PUT', path: `/api/v1/Payment/${a.sub}/customers` });
  const { customerId } = (await res.json()) as { customerId: string };
  const event = {
    id: `evt_${a.sub}`,
    name: 'payment_consent.verified',
    data: {
      object: {
        id: `cst_${a.sub}`,
        status: 'VERIFIED',
        customer_id: customerId,
        merchant_trigger_reason: 'unscheduled',
      },
    },
  };
  const ts = String(app.clock.now().getTime());
  const sig = createHmac('sha256', SECRET)
    .update(ts + JSON.stringify(event))
    .digest('hex');
  const hook = await app.request(null, {
    method: 'POST',
    path: '/api/v1/Payment/webhook',
    body: event,
    headers: { 'x-timestamp': ts, 'x-signature': sig },
  });
  expect(hook.status).toBeLessThan(300);
}

const process = async () => {
  const admin = await app.admin();
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/Penalty/admin/process' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { processed: number }).processed;
};

describe('the drain with a real consent (payment fake gateway)', () => {
  it('should charge once, credit the charity, and put a receipt in the inbox', async () => {
    // Arrange
    const a = await app.user();
    await withConsent(a);
    const id = await seedPenalty(a.sub, { cents: 700 });
    // Act
    expect(await process()).toBe(1);
    await app.drainOutbox();
    expect(await process()).toBe(0);
    // Assert
    const [row] = await app.sql`SELECT status, payment_intent_id FROM penalty.penalties WHERE id = ${id}`;
    expect(row.status).toBe('charged');
    expect(row.payment_intent_id).toBeString();
    const [bal] = await app.sql`SELECT accrued_cents FROM penalty.charity_balances WHERE charity_id = ${CHARITY}`;
    expect(Number(bal.accrued_cents)).toBe(700);
    const inbox = await app.sql`SELECT kind FROM notification.inbox_notifications WHERE user_id = ${a.sub}`;
    expect(inbox.map((r: { kind: string }) => r.kind)).toEqual(['penalty_charged']);
    expect(await (await get(a, `/api/v1/Penalty/${a.sub}/outstanding`)).json()).toMatchObject({ totalCents: 0 });
  });

  it('should hand each penalty to exactly one of two drains running at once', async () => {
    // Arrange
    const a = await app.user();
    await withConsent(a);
    for (let i = 0; i < 6; i++) await seedPenalty(a.sub, { cents: 100 });
    // Act
    const [x, y] = await Promise.all([process(), process()]);
    // Assert
    expect(x + y).toBe(6);
    const [bal] = await app.sql`SELECT accrued_cents FROM penalty.charity_balances WHERE charity_id = ${CHARITY}`;
    expect(Number(bal.accrued_cents)).toBe(600);
    const charged =
      await app.sql`SELECT count(*)::int AS n FROM penalty.penalties WHERE user_id = ${a.sub} AND status = 'charged'`;
    expect(charged[0].n).toBe(6);
  });
});
