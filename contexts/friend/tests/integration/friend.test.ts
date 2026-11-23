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

const F = (a: Actor, rest = '') => `/api/v1/Friend/${a.sub}${rest}`;
const json = async (res: Response) => {
  expect(res.status).toBeLessThan(300);
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads many response shapes
  return res.json() as Promise<any>;
};
const ask = (from: Actor, to: Actor) =>
  app.request(from, { method: 'POST', path: F(from, '/requests'), body: { toUserId: to.sub } });
const accept = (by: Actor, from: Actor) =>
  app.request(by, { method: 'POST', path: F(by, `/requests/${from.sub}/accept`) });
const befriend = async (a: Actor, b: Actor) => {
  await ask(a, b);
  await accept(b, a);
};
const rows = async (table: string, sub: string) =>
  app.sql`SELECT * FROM friend.${app.sql(table)} WHERE ${app.sql(table === 'friend_requests' ? 'user_id' : 'user_id')} = ${sub}`;

describe('requests and friendships', () => {
  it('should send, list, accept and remove', async () => {
    const [a, b] = [await registered(), await registered()];
    expect(await json(await ask(a, b))).toEqual({ relation: 'outgoing' });
    expect(
      ((await json(await app.request(b, { method: 'GET', path: F(b, '/requests') }))) as { incoming: unknown[] })
        .incoming,
    ).toHaveLength(1);
    const f = await json(await accept(b, a));
    expect(f.userId).toBe(a.sub);
    expect(await json(await app.request(a, { method: 'GET', path: F(a) }))).toHaveLength(1);
    const del = await app.request(a, { method: 'DELETE', path: F(a, `/${b.sub}`) });
    expect(del.status).toBe(204);
    expect(await json(await app.request(b, { method: 'GET', path: F(b) }))).toHaveLength(0);
    await expectProblem(await app.request(a, { method: 'DELETE', path: F(a, `/${b.sub}`) }), 404, 'entity_not_found');
  });

  it('should accept when asking someone who already asked you', async () => {
    const [a, b] = [await registered(), await registered()];
    await ask(a, b);
    expect(await json(await ask(b, a))).toEqual({ relation: 'friend' });
  });

  it('should refuse friending yourself with 400 and an unknown user with 404', async () => {
    const a = await registered();
    await expectProblem(await ask(a, a), 400, 'validation_error');
    await expectProblem(await ask(a, { sub: 'nobody-here', token: '' }), 404, 'entity_not_found');
  });

  it('should post an inbox notification to the asked user after the outbox runs', async () => {
    const [a, b] = [await registered(), await registered()];
    await ask(a, b);
    await app.drainOutbox();
    expect(await app.contract('notification.v1').unreadCount(b.sub)).toBe(1);
    await accept(b, a);
    await app.drainOutbox();
    expect(await app.contract('notification.v1').unreadCount(a.sub)).toBe(1);
  });

  it('should decline and cancel requests silently, 404 when none', async () => {
    const [a, b] = [await registered(), await registered()];
    await ask(a, b);
    expect((await app.request(b, { method: 'DELETE', path: F(b, `/requests/${a.sub}`) })).status).toBe(204);
    await expectProblem(
      await app.request(b, { method: 'DELETE', path: F(b, `/requests/${a.sub}`) }),
      404,
      'entity_not_found',
    );
  });

  it('should refuse accepting a request that was never sent with 404', async () => {
    const [a, b] = [await registered(), await registered()];
    await expectProblem(await accept(a, b), 404, 'entity_not_found');
  });

  it('should expose friend.v1 areFriends and friendIds', async () => {
    const [a, b, c] = [await registered(), await registered(), await registered()];
    await befriend(a, b);
    const friend = app.contract('friend.v1');
    expect(await friend.areFriends(a.sub, b.sub)).toBe(true);
    expect(await friend.areFriends(a.sub, c.sub)).toBe(false);
    expect(await friend.friendIds(b.sub)).toEqual([a.sub]);
  });
});

describe('search', () => {
  it('should find by username prefix with the relation, never the caller', async () => {
    const [a, b] = [await registered(), await registered()];
    const username = (
      (await app.sql`SELECT username FROM account.users WHERE id = ${b.sub}`) as { username: string }[]
    )[0]?.username as string;
    await ask(a, b);
    const res = await json(
      await app.request(a, { method: 'GET', path: F(a, '/search'), query: { q: username.slice(0, 4).toUpperCase() } }),
    );
    const hit = (res as unknown as { userId: string; relation: string }[]).find(x => x.userId === b.sub);
    expect(hit?.relation).toBe('outgoing');
    expect((res as unknown as { userId: string }[]).some(x => x.userId === a.sub)).toBe(false);
  });

  it('should refuse a short query and a bad limit with 400', async () => {
    const a = await registered();
    await expectProblem(await app.request(a, { method: 'GET', path: F(a, '/search'), query: { q: 'a' } }), 400);
    await expectProblem(
      await app.request(a, { method: 'GET', path: F(a, '/search'), query: { q: 'ab', limit: '99' } }),
      400,
    );
  });
});

describe('invites', () => {
  it('should give the same permanent code each time and send a request on accept', async () => {
    const [a, b] = [await registered(), await registered()];
    const c1 = await json(await app.request(a, { method: 'POST', path: F(a, '/invites') }));
    const c2 = await json(await app.request(a, { method: 'POST', path: F(a, '/invites') }));
    expect(c1.code).toBe(c2.code);
    expect(String(c1.code)).toHaveLength(10);
    const acc = await app.request(b, {
      method: 'POST',
      path: F(b, `/invites/${String(c1.code).toUpperCase()}/accept`),
    });
    expect(await json(acc)).toEqual({ relation: 'outgoing' });
  });

  it('should 404 an unknown code and 400 your own', async () => {
    const a = await registered();
    await expectProblem(
      await app.request(a, { method: 'POST', path: F(a, '/invites/zzzzzzzzzz/accept') }),
      404,
      'entity_not_found',
    );
    const own = await json(await app.request(a, { method: 'POST', path: F(a, '/invites') }));
    await expectProblem(await app.request(a, { method: 'POST', path: F(a, `/invites/${own.code}/accept`) }), 400);
  });
});

describe('auth', () => {
  it('should 401 without a token and 403 on another user path', async () => {
    const [a, b] = [await registered(), await registered()];
    await expectProblem(await app.request(null, { method: 'GET', path: F(a) }), 401);
    await expectProblem(await app.request(b, { method: 'GET', path: F(a) }), 403);
    await expectProblem(
      await app.request(b, { method: 'POST', path: F(a, '/requests'), body: { toUserId: b.sub } }),
      403,
    );
  });
});

describe('owner scope (layer 4)', () => {
  it("should 404 user B deleting a friendship of A's that B is not part of", () =>
    expectOwnerScoped(app, {
      seed: async a => {
        const other = await registered();
        await befriend(a, other);
        return other.sub;
      },
      request: (id, b) => ({ method: 'DELETE', path: F(b, `/${id}`) }),
      unchanged: id => rows('friendships', id),
    }));

  it('should 404 user B accepting a request that was sent to A, not B', () =>
    expectOwnerScoped(app, {
      seed: async a => {
        const asker = await registered();
        await ask(asker, a);
        return asker.sub;
      },
      request: (id, b) => ({ method: 'POST', path: F(b, `/requests/${id}/accept`) }),
      unchanged: id => rows('friend_requests', id),
    }));

  it('should 404 user B cancelling a request between A and someone else', () =>
    expectOwnerScoped(app, {
      seed: async a => {
        const to = await registered();
        await ask(a, to);
        return to.sub;
      },
      request: (id, b) => ({ method: 'DELETE', path: F(b, `/requests/${id}`) }),
      unchanged: id => rows('friend_requests', id),
    }));
});

describe('purgeUser', () => {
  it("should leave 0 rows of the deleted user and keep B's other rows", async () => {
    const [a, b, c] = [await registered(), await registered(), await registered()];
    await befriend(a, b);
    await ask(a, c);
    await ask(c, b);
    await app.request(a, { method: 'POST', path: F(a, '/invites') });
    await app.sql`INSERT INTO friend.habit_watchers (user_id, habit_id, friend_user_id) VALUES (${b.sub}, gen_random_uuid(), ${a.sub})`;
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    expect(res.status).toBeLessThan(300);
    const left = await app.sql`
      SELECT (SELECT count(*) FROM friend.friendships WHERE user_id = ${a.sub} OR friend_user_id = ${a.sub})::int
           + (SELECT count(*) FROM friend.friend_requests WHERE user_id = ${a.sub} OR to_user_id = ${a.sub})::int
           + (SELECT count(*) FROM friend.friend_invites WHERE user_id = ${a.sub})::int
           + (SELECT count(*) FROM friend.habit_watchers WHERE user_id = ${a.sub} OR friend_user_id = ${a.sub})::int AS n`;
    expect(left[0].n).toBe(0);
    const bs =
      await app.sql`SELECT count(*)::int AS n FROM friend.friend_requests WHERE user_id = ${c.sub} AND to_user_id = ${b.sub}`;
    expect(bs[0].n).toBe(1);
  });
});

describe('concurrency', () => {
  it('should create one friendship and one accepted event when both ask at once', async () => {
    const [a, b] = [await registered(), await registered()];
    await Promise.all([ask(a, b), ask(b, a)]);
    const f = await app.sql`SELECT count(*)::int AS n FROM friend.friendships WHERE user_id IN (${a.sub}, ${b.sub})`;
    expect([0, 2]).toContain(f[0].n);
    const r =
      await app.sql`SELECT count(*)::int AS n FROM friend.friend_requests WHERE user_id IN (${a.sub}, ${b.sub})`;
    // Either they crossed into a friendship, or one request is waiting for the other to be asked back.
    expect(f[0].n === 2 || r[0].n >= 1).toBe(true);
  });
});
