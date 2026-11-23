import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, expectOwnerScoped, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ contexts: ['account'] });
});
afterAll(() => app.close());

const registered = (): Promise<Actor> => app.registeredUser();

const configure = async (a: Actor, timezone = 'Asia/Singapore'): Promise<string> => {
  const res = await app.request(a, { method: 'POST', path: `/api/v1/Configuration/${a.sub}`, body: { timezone } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
};

describe('account users', () => {
  it('should register a user from the token claims and read it back', async () => {
    // Arrange
    const a = await registered();

    // Act
    const res = await app.request(a, { method: 'GET', path: '/api/v1/User/Me/All' });

    // Assert
    const body = (await res.json()) as { principal: { id: string; active: boolean } };
    expect(body.principal.id).toBe(a.sub);
    expect(body.principal.active).toBe(true);
  });

  it('should 409 on a second registration', async () => {
    // Arrange
    const a = await registered();

    // Act
    const res = await app.request(a, { method: 'POST', path: '/api/v1/User', body: {} });

    // Assert
    await expectProblem(res, 409, 'entity_conflict');
  });

  it('should 401 without a token and 403 on another user id', async () => {
    // Arrange
    const a = await registered();
    const b = await registered();

    // Act
    const anon = await app.request(null, { method: 'GET', path: `/api/v1/User/${a.sub}` });
    const other = await app.request(b, { method: 'GET', path: `/api/v1/User/${a.sub}` });

    // Assert
    await expectProblem(anon, 401, 'unauthenticated');
    await expectProblem(other, 403, 'unauthorized');
  });

  it('should let only an admin search users', async () => {
    // Arrange
    const a = await registered();
    const admin = await app.admin();

    // Act
    const asUser = await app.request(a, { method: 'GET', path: '/api/v1/User' });
    const asAdmin = await app.request(admin, { method: 'GET', path: '/api/v1/User', query: { id: a.sub } });

    // Assert
    await expectProblem(asUser, 403, 'unauthorized');
    expect(((await asAdmin.json()) as unknown[]).length).toBe(1);
  });
});

describe('account configuration', () => {
  it('should 404 user B on user A configuration id', () =>
    expectOwnerScoped(app, {
      seed: a => configure(a),
      request: (id, b) => ({ method: 'PUT', path: `/api/v1/Configuration/${b.sub}/${id}`, body: { timezone: 'UTC' } }),
      unchanged: id => app.sql`SELECT timezone FROM account.configurations WHERE id = ${id}`,
    }));

  it('should 400 an invalid timezone', async () => {
    // Arrange
    const a = await app.user();

    // Act
    const res = await app.request(a, {
      method: 'POST',
      path: '/api/v1/Configuration',
      body: { timezone: 'Mars/Base' },
    });

    // Assert
    await expectProblem(res, 400, 'validation_error');
  });

  it("should give other contexts the user's local date through account.v1", async () => {
    // Arrange
    const a = await app.user();
    await configure(a, 'Pacific/Kiritimati');
    app.clock.set('2026-03-01T12:00:00Z');

    // Act
    const today = await app.contract('account.v1').today(a.sub);

    // Assert
    expect(today).toBe('2026-03-02');
  });

  it('should emit account.timezoneChanged when the timezone moves', async () => {
    // Arrange
    const a = await app.user();
    const id = await configure(a);

    // Act
    const res = await app.request(a, {
      method: 'PUT',
      path: `/api/v1/Configuration/${id}`,
      body: { timezone: 'Europe/Paris' },
    });

    // Assert
    expect(res.status).toBe(200);
    const rows =
      await app.sql`SELECT payload FROM kernel.outbox_events WHERE type = 'account.timezoneChanged' AND user_id = ${a.sub}`;
    expect(rows.length).toBe(1);
  });
});

describe('account deletion', () => {
  it("should purge the user's rows in one unit of work and keep other users", async () => {
    // Arrange
    const a = await registered();
    const b = await registered();
    await configure(a);
    await configure(b);

    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });

    // Assert
    expect(res.status).toBe(204);
    expect((await app.sql`SELECT 1 FROM account.users WHERE id = ${a.sub}`).length).toBe(0);
    expect((await app.sql`SELECT 1 FROM account.configurations WHERE user_id = ${a.sub}`).length).toBe(0);
    expect((await app.sql`SELECT 1 FROM account.users WHERE id = ${b.sub}`).length).toBe(1);
  });

  it('should succeed again for an already deleted user (idempotent)', async () => {
    // Arrange
    const a = await app.user();

    // Act
    const res = await app.request(a, { method: 'DELETE', path: '/api/v1/User/Me' });

    // Assert
    expect(res.status).toBe(204);
  });
});

describe('account MCP', () => {
  it('should serve account.me with the same auth as HTTP', async () => {
    // Arrange
    const a = await registered();

    // Act
    const ok = await app.mcp(a, 'account.me', {});
    const other = await app.mcp(a, 'account.getConfiguration', { userId: 'someone-else' });

    // Assert
    expect((ok.data as { id: string }).id).toBe(a.sub);
    expect(other.ok).toBe(false);
    expect(other.problem?.status).toBe(403);
  });
});
