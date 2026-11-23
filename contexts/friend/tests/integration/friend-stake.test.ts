import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ contexts: ['friend'] });
});
afterAll(() => app.close());

// A user the account context knows (usernames come from the token claims).
const registered = async (): Promise<Actor> => {
  const a = await app.user();
  const token = await app.token(a.sub, {
    claims: { username: `n${a.sub.slice(2, 10)}`, email: `${a.sub}@x.test`, email_verified: true },
  });
  const actor = { sub: a.sub, token };
  const res = await app.request(actor, { method: 'POST', path: '/api/v1/User', body: {} });
  expect(res.status).toBe(200);
  return actor;
};

const S = (a: Actor, habitId: string) => `/api/v1/FriendStake/${a.sub}/${habitId}`;
const befriend = async (a: Actor, b: Actor) => {
  await app.request(a, { method: 'POST', path: `/api/v1/Friend/${a.sub}/requests`, body: { toUserId: b.sub } });
  await app.request(b, { method: 'POST', path: `/api/v1/Friend/${b.sub}/requests/${a.sub}/accept` });
};
const newHabit = async (a: Actor): Promise<string> => {
  const res = await app.request(a, {
    method: 'POST',
    path: `/api/v1/Habit/${a.sub}`,
    body: { task: 'Run', daysOfWeek: ['Monday'], notificationTime: '08:00:00', stake: '0', timezone: 'Asia/Singapore' },
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { habitId?: string; id: string }).habitId ?? '';
};

describe('friend stake', () => {
  it('should set, get and clear the watchers of an owned habit', async () => {
    const [a, b] = [await registered(), await registered()];
    await befriend(a, b);
    const h = await newHabit(a);
    const put = await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [b.sub] } });
    expect(((await put.json()) as { friends: { userId: string }[] }).friends.map(f => f.userId)).toEqual([b.sub]);
    const got = await app.request(a, { method: 'GET', path: S(a, h) });
    expect(((await got.json()) as { habitId: string }).habitId).toBe(h);
    const off = await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [] } });
    expect(((await off.json()) as { friends: unknown[] }).friends).toEqual([]);
  });

  it('should refuse a non-friend with 400 and more than 20 friends with 400', async () => {
    const [a, c] = [await registered(), await registered()];
    const h = await newHabit(a);
    await expectProblem(
      await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [c.sub] } }),
      400,
      'validation_error',
    );
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`);
    await expectProblem(await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: many } }), 400);
  });

  it("should 404 user B on user A's habit", () =>
    expectOwnerScoped(app, {
      seed: async a => {
        const f = await registered();
        await befriend(a, f);
        const h = await newHabit(a);
        await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [f.sub] } });
        return h;
      },
      request: (id, b) => ({ method: 'PUT', path: S(b, id), body: { friendUserIds: [] } }),
      unchanged: id => app.sql`SELECT * FROM friend.habit_watchers WHERE habit_id = ${id}`,
    }));

  it('should stop watching when the friendship ends', async () => {
    const [a, b] = [await registered(), await registered()];
    await befriend(a, b);
    const h = await newHabit(a);
    await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [b.sub] } });
    await app.request(b, { method: 'DELETE', path: `/api/v1/Friend/${b.sub}/${a.sub}` });
    const got = await app.request(a, { method: 'GET', path: S(a, h) });
    expect(((await got.json()) as { friends: unknown[] }).friends).toEqual([]);
  });

  it('should tell watching friends once when a check settles missed', async () => {
    const [a, b] = [await registered(), await registered()];
    await befriend(a, b);
    await app.drainOutbox();
    const before = await app.contract('notification.v1').unreadCount(b.sub);
    const h = await newHabit(a);
    await app.request(a, { method: 'PUT', path: S(a, h), body: { friendUserIds: [b.sub] } });
    const versionId = (
      (await app.sql`SELECT id FROM habit.habit_versions WHERE habit_id = ${h}`) as { id: string }[]
    )[0]?.id;
    const payload = {
      userId: a.sub,
      habitId: h,
      habitVersionId: versionId,
      checkId: crypto.randomUUID(),
      executionId: crypto.randomUUID(),
      date: '2026-01-05',
      status: 'missed',
      stakeCents: 0,
      ratioBps: 0,
      currency: 'SGD',
      charityId: null,
      maxStreak: 0,
      adopted: false,
    };
    // Same event twice (a retry): the dedupe key keeps it to one notification.
    for (let i = 0; i < 2; i++) {
      const [e] = (await app.sql`
        INSERT INTO kernel.outbox_events (type, payload, user_id)
        VALUES ('check.settled', ${JSON.stringify(payload)}::text::jsonb, ${a.sub}) RETURNING id`) as { id: string }[];
      await app.sql`INSERT INTO kernel.outbox_deliveries (event_id, subscriber) VALUES (${e?.id}, 'friend.check.settled')`;
    }
    await app.drainOutbox();
    expect((await app.contract('notification.v1').unreadCount(b.sub)) - before).toBe(1);
  });
});
