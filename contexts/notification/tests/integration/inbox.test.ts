import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
const dir = mkdtempSync(join(tmpdir(), 'lt-notif-int-'));
const mailFile = join(dir, 'mail.jsonl');

interface Row {
  id: string;
  title: string;
  kind: string;
  data: string | null;
  actorUserId: string | null;
  readAtUtc: string | null;
}
const rows = async (res: Response): Promise<Row[]> => (await res.json()) as Row[];
const count = async (res: Response): Promise<number> => ((await res.json()) as { count: number }).count;
const notification = () => app.contract('notification.v1');
const inbox = (sub: string, suffix = '') => `/api/v1/Inbox/${sub}${suffix}`;
const mail = (): { to: string; template: string; userId: string; html: string }[] => {
  try {
    return readFileSync(mailFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeAll(async () => {
  app = await startTestApp({
    contexts: ['account', 'notification'],
    config: { notification: { smtp: { file: mailFile } } },
  });
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('inbox over HTTP', () => {
  it('should list newest first, page with limit and skip, and filter unread', async () => {
    const a = await app.user();
    app.clock.set('2026-03-01T10:00:00Z');
    await notification().post(a.sub, 'friend_request', 'first', 'b');
    app.clock.set('2026-03-01T11:00:00Z');
    const second = await notification().post(a.sub, 'friend_accepted', 'second', 'b', null, { friend: 'x' });
    app.clock.set('2026-03-01T12:00:00Z');
    await notification().post(a.sub, 'friend_missed', 'third', 'b');

    const all = await rows(await app.request(a, { method: 'GET', path: inbox(a.sub) }));
    expect(all.map(n => n.title)).toEqual(['third', 'second', 'first']);
    expect(all[1]).toMatchObject({
      kind: 'friend_accepted',
      data: '{"friend":"x"}',
      actorUserId: null,
      readAtUtc: null,
    });

    const page = await rows(
      await app.request(a, { method: 'GET', path: inbox(a.sub), query: { limit: '1', skip: '1' } }),
    );
    expect(page.map(n => n.id)).toEqual([second.id]);

    await app.request(a, { method: 'POST', path: inbox(a.sub, `/${second.id}/read`) });
    const unread = await rows(
      await app.request(a, { method: 'GET', path: inbox(a.sub), query: { unreadOnly: 'true' } }),
    );
    expect(unread.map(n => n.title)).toEqual(['third', 'first']);
  });

  it('should count unread, mark one read idempotently, then mark all read', async () => {
    const a = await app.user();
    const n1 = await notification().post(a.sub, 'k', 't1', 'b');
    await notification().post(a.sub, 'k', 't2', 'b');
    const unreadCount = async () => count(await app.request(a, { method: 'GET', path: inbox(a.sub, '/unread-count') }));
    const readAtOf = async (id: string) =>
      (await rows(await app.request(a, { method: 'GET', path: inbox(a.sub) }))).find(n => n.id === id)?.readAtUtc;
    expect(await unreadCount()).toBe(2);

    const first = await app.request(a, { method: 'POST', path: inbox(a.sub, `/${n1.id}/read`) });
    expect(first.status).toBe(204);
    const readAt = await readAtOf(n1.id);
    expect(readAt).not.toBeNull();
    app.clock.set('2030-01-01T00:00:00Z');
    const again = await app.request(a, { method: 'POST', path: inbox(a.sub, `/${n1.id}/read`) });
    expect(again.status).toBe(204);
    expect(await readAtOf(n1.id)).toBe(readAt);
    expect(await unreadCount()).toBe(1);

    const all = await app.request(a, { method: 'POST', path: inbox(a.sub, '/read-all') });
    expect(await count(all)).toBe(1);
    expect(await unreadCount()).toBe(0);
  });

  it('should record a repeated dedupe key once', async () => {
    const a = await app.user();
    const one = await notification().post(a.sub, 'k', 't', 'b', null, null, 'evt-1');
    const two = await notification().post(a.sub, 'k', 't', 'b', null, null, 'evt-1');
    expect(two.id).toBe(one.id);
    const stored = await app.sql`SELECT id FROM notification.inbox_notifications WHERE user_id = ${a.sub}`;
    expect(stored).toHaveLength(1);
  });

  it('should answer 400 for a limit outside 1..50 and a negative skip', async () => {
    const a = await app.user();
    const queries: Record<string, string>[] = [{ limit: '0' }, { limit: '51' }, { skip: '-1' }];
    for (const query of queries) {
      await expectProblem(await app.request(a, { method: 'GET', path: inbox(a.sub), query }), 400, 'validation_error');
    }
  });

  it("should answer 401 with no token, 403 on another user's path, 404 on an unknown id", async () => {
    const a = await app.user();
    const b = await app.user();
    await expectProblem(await app.request(null, { method: 'GET', path: inbox(a.sub) }), 401);
    await expectProblem(await app.request(b, { method: 'GET', path: inbox(a.sub) }), 403);
    await expectProblem(await app.request(b, { method: 'GET', path: inbox(a.sub, '/unread-count') }), 403);
    await expectProblem(
      await app.request(a, { method: 'POST', path: inbox(a.sub, '/11111111-1111-1111-1111-111111111111/read') }),
      404,
      'entity_not_found',
    );
    await expectProblem(await app.request(a, { method: 'POST', path: inbox(a.sub, '/nope/read') }), 404);
  });

  it('should serve the same inbox through MCP', async () => {
    const a = await app.user();
    const n = await notification().post(a.sub, 'k', 't', 'b');
    const listed = await app.mcp(a, 'notification.list', { userId: a.sub });
    expect(listed.ok).toBe(true);
    expect((listed.data as { id: string }[])[0]?.id).toBe(n.id);
    expect((await app.mcp(a, 'notification.unreadCount', { userId: a.sub })).data).toEqual({ count: 1 });
    const b = await app.user();
    const refused = await app.mcp(b, 'notification.markRead', { userId: a.sub, id: n.id });
    expect(refused.ok).toBe(false);
    expect(refused.problem?.status).toBe(403);
    expect((await app.mcp(a, 'notification.markAllRead', { userId: a.sub })).data).toEqual({ count: 1 });
  });
});

describe('layer 4: owner-scoped', () => {
  it("should 404 user B marking user A's inbox notification read, and leave it unread", () =>
    expectOwnerScoped(app, {
      seed: async a => (await notification().post(a.sub, 'k', 't', 'b')).id,
      request: (id, b) => ({ method: 'POST', path: inbox(b.sub, `/${id}/read`) }),
      unchanged: id => app.sql`SELECT * FROM notification.inbox_notifications WHERE id = ${id}`,
    }));

  it("should not count or read-all across users: B's read-all leaves A's rows unread", async () => {
    const a = await app.user();
    const b = await app.user();
    await notification().post(a.sub, 'k', 't', 'b');
    const res = await app.request(b, { method: 'POST', path: inbox(b.sub, '/read-all') });
    expect(await res.json()).toEqual({ count: 0 });
    expect(await notification().unreadCount(a.sub)).toBe(1);
  });
});

// Registers the user in account (token claims carry the address), so email has a recipient.
// Registration emits account.userCreated, which sends one welcome email; drain it first.
const registered = async () => {
  const u = await app.user();
  const token = await app.token(u.sub, {
    claims: { username: `n${u.sub.slice(2, 10)}`, email: `${u.sub}@x.test`, email_verified: true },
  });
  const actor = { sub: u.sub, token };
  const res = await app.request(actor, { method: 'POST', path: '/api/v1/User', body: {} });
  expect(res.status).toBe(200);
  await app.drainOutbox();
  await app.drainOutbox();
  return actor;
};

describe('email', () => {
  it('should send a welcome email when a user registers', async () => {
    const a = await registered();
    const sent = mail().filter(m => m.userId === a.sub);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: `${a.sub}@x.test`, template: 'welcome' });
  });

  it('should leave through the outbox after commit and land in the fake SMTP file once', async () => {
    const a = await registered();
    const before = mail().length;
    await notification().email(a.sub, 'welcome');
    expect(mail()).toHaveLength(before);
    await app.drainOutbox();
    await app.drainOutbox();
    const sent = mail().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: a.sub, template: 'welcome' });
  });

  it('should not throw, and send nothing, for a template with a missing variable', async () => {
    const a = await registered();
    const before = mail().length;
    await notification().email(a.sub, 'penalty-charged', {});
    await app.drainOutbox();
    expect(mail()).toHaveLength(before);
  });
});

describe('purge', () => {
  it("should delete the user's inbox and every notification they caused, and leave other users' rows", async () => {
    const a = await app.user();
    const b = await app.user();
    await notification().post(a.sub, 'k', 'to a', 'b');
    await notification().post(b.sub, 'friend_request', 'a asked b', 'b', a.sub);
    await notification().post(b.sub, 'k', 'b alone', 'b');

    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });
    expect(res.status).toBe(204);

    const a_rows =
      await app.sql`SELECT id FROM notification.inbox_notifications WHERE user_id = ${a.sub} OR actor_user_id = ${a.sub}`;
    expect(a_rows).toHaveLength(0);
    const b_rows = await app.sql`SELECT title FROM notification.inbox_notifications WHERE user_id = ${b.sub}`;
    expect(b_rows.map((r: { title: string }) => r.title)).toEqual(['b alone']);
  });

  it('should purge a user who never registered in account', async () => {
    const ghost = await app.user();
    await notification().post(ghost.sub, 'k', 't', 'b');
    await app.request(ghost, { method: 'DELETE', path: '/api/v1/User/Me' });
    const rows = await app.sql`SELECT id FROM notification.inbox_notifications WHERE user_id = ${ghost.sub}`;
    expect(rows).toHaveLength(0);
  });
});
