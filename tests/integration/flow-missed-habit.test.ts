// SIT flow 1 (missed habit) on the whole app with a movable clock. check never opens a day whose
// deadline has already passed, so a black-box run in real time cannot reach "missed"; this test
// keeps flow 1's routes and bodies and moves the clock instead (docs/sit.md).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, startTestApp, type TestApp } from '@lazytax/kernel/testing';

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let app: TestApp;
let admin: Actor;
beforeAll(async () => {
  // Monday 2 Mar 2026, 10:00 UTC.
  app = await startTestApp({ now: '2026-03-02T10:00:00Z' });
  admin = await app.admin();
});
afterAll(() => app.close());

const tick = async () => {
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/habit-cron/mark-daily-failures' });
  expect(res.status).toBe(200);
};
// The user links a card: a payment customer, then Airwallex's signed consent.verified webhook.
const consent = async (a: Actor) => {
  const cust = await app.request(a, { method: 'PUT', path: `/api/v1/Payment/${a.sub}/customers` });
  expect(cust.status).toBe(200);
  const customerId = ((await cust.json()) as { customerId: string }).customerId;
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
  const sig = createHmac('sha256', 'dev-airwallex-webhook-secret')
    .update(ts + JSON.stringify(event))
    .digest('hex');
  const res = await app.request(null, {
    method: 'POST',
    path: '/api/v1/Payment/webhook',
    body: event,
    headers: { 'x-timestamp': ts, 'x-signature': sig },
  });
  expect(res.status).toBeLessThan(300);
};
// LazyTax has no penalty route; read penalty's table to see the stake.
const penalties = async (a: Actor) => [
  ...((await app.sql`SELECT status, amount_cents::int AS cents FROM penalty.penalties WHERE user_id = ${a.sub}`) as {
    status: string;
    cents: number;
  }[]),
];
const drain = async () => {
  for (let i = 0; i < 3; i++) await app.drainOutbox();
};

describe('flow 1: a missed habit', () => {
  it('should fail the execution, leave its penalty pending, then charge it and post an inbox item', async () => {
    // Arrange: a charity, a signed-up user in UTC, a habit with a 5.00 stake.
    const charity = await app.request(admin, {
      method: 'POST',
      path: '/api/v1/Charity',
      body: { name: 'Flow Charity', countries: ['SG'] },
    });
    expect(charity.status).toBe(200);
    const charityId = ((await charity.json()) as { id: string }).id;
    const a = await app.registeredUser({ timezone: 'UTC' });
    await consent(a);
    const habit = await app.request(a, {
      method: 'POST',
      path: `/api/v1/Habit/${a.sub}`,
      body: {
        task: 'flow habit',
        daysOfWeek: ALL_DAYS,
        notificationTime: '00:00:00',
        deadlineTime: '23:59:00',
        stake: '5.00',
        charityId,
        timezone: 'UTC',
      },
    });
    expect(habit.status).toBe(200);
    const versionId = ((await habit.json()) as { id: string }).id;
    await drain();
    await tick(); // opens today's check

    // Act: the day ends unproven; the tick after deadline + grace settles it.
    app.clock.set('2026-03-03T01:00:00Z');
    await tick();
    await drain();

    // Assert: LazyTax's "penalty pending" is a failed execution with paymentProcessed false.
    const ex = await app.request(a, { method: 'GET', path: `/api/v1/Habit/${a.sub}/executions` });
    const rows = ((await ex.json()) as { habitVersionId: string; status: string; paymentProcessed: boolean }[]).filter(
      e => e.habitVersionId === versionId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', paymentProcessed: false });
    expect(await penalties(a)).toEqual([{ status: 'pending', cents: 500 }]);
    const before = await app.request(a, { method: 'GET', path: `/api/v1/Inbox/${a.sub}` });
    expect(await before.json()).toEqual([]);

    // Act: the penalty processor charges it through the fake Airwallex.
    await app.tick('penalty.process');
    await drain();

    // Assert: the outcome reaches the user's inbox.
    const inbox = await app.request(a, { method: 'GET', path: `/api/v1/Inbox/${a.sub}` });
    expect(((await inbox.json()) as { kind: string }[]).map(i => i.kind)).toEqual(['penalty_charged']);
    expect(await penalties(a)).toEqual([{ status: 'charged', cents: 500 }]);
  });
});
