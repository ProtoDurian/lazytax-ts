import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, expectProblem, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
let admin: Actor;
let user: Actor;

beforeAll(async () => {
  app = await startTestApp({ contexts: ['charity'] });
  admin = await app.admin();
  user = await app.user();
});
afterAll(() => app.close());

const wwf = { name: 'World Wildlife Fund', slug: 'wwf', countries: ['US', 'GB'], websiteUrl: 'https://wwf.example' };
const NO_ID = '00000000-0000-4000-8000-000000000000';

const createCharity = async (body: Record<string, unknown> = wwf) => {
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/Charity', body });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; name: string; countries: string[] };
};
const createCause = async (key: string, name = key) => {
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/Causes', body: { key, name } });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; key: string; name: string };
};

describe('charity routes', () => {
  it('should create, read and search a charity without any token (reads are public)', async () => {
    const c = await createCharity({ ...wwf, name: 'Public Reads Fund' });

    const one = await app.request(null, { method: 'GET', path: `/api/v1/Charity/${c.id}` });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({
      principal: { id: c.id, name: 'Public Reads Fund', countries: ['US', 'GB'] },
    });

    const found = await app.request(null, {
      method: 'GET',
      path: '/api/v1/Charity',
      query: { name: 'public reads', country: 'GB' },
    });
    expect(((await found.json()) as { id: string }[]).map(x => x.id)).toEqual([c.id]);
  });

  it('should 404 an unknown or malformed charity id on read, update, delete and set-causes', async () => {
    for (const id of [NO_ID, 'not-a-guid']) {
      await expectProblem(
        await app.request(user, { method: 'GET', path: `/api/v1/Charity/${id}` }),
        404,
        'entity_not_found',
      );
      await expectProblem(
        await app.request(admin, { method: 'PUT', path: `/api/v1/Charity/${id}`, body: { name: 'x' } }),
        404,
        'entity_not_found',
      );
      await expectProblem(
        await app.request(admin, { method: 'DELETE', path: `/api/v1/Charity/${id}` }),
        404,
        'entity_not_found',
      );
      await expectProblem(
        await app.request(admin, { method: 'PUT', path: `/api/v1/Charity/${id}/causes`, body: { keys: [] } }),
        404,
        'entity_not_found',
      );
    }
  });

  it('should answer 401 without a token and 403 for a non-admin on every write', async () => {
    const writes = [
      { method: 'POST', path: '/api/v1/Charity', body: wwf },
      { method: 'PUT', path: `/api/v1/Charity/${NO_ID}`, body: wwf },
      { method: 'DELETE', path: `/api/v1/Charity/${NO_ID}` },
      { method: 'PUT', path: `/api/v1/Charity/${NO_ID}/causes`, body: { keys: [] } },
      { method: 'POST', path: '/api/v1/Causes', body: { key: 'k', name: 'n' } },
      { method: 'PUT', path: `/api/v1/Causes/${NO_ID}`, body: { name: 'n' } },
      { method: 'DELETE', path: `/api/v1/Causes/${NO_ID}` },
      { method: 'POST', path: '/api/v1/charities/sync/pledge' },
    ] as const;
    for (const w of writes) {
      await expectProblem(await app.request(null, w), 401, 'unauthenticated');
      await expectProblem(await app.request(user, w), 403, 'unauthorized');
    }
  });

  it('should answer 401 for an expired token on a write', async () => {
    const token = await app.token('someone', { scopes: ['admin'], expiresInSec: -60 });
    await expectProblem(
      await app.request({ sub: 'someone', token }, { method: 'POST', path: '/api/v1/Charity', body: wwf }),
      401,
    );
  });

  it('should refuse an invalid body with 400 validation_error', async () => {
    for (const body of [{ name: '' }, { name: 'x', countries: ['USA'] }, { name: 'x', websiteUrl: 'nope' }]) {
      await expectProblem(
        await app.request(admin, { method: 'POST', path: '/api/v1/Charity', body }),
        400,
        'validation_error',
      );
    }
    await expectProblem(
      await app.request(null, { method: 'GET', path: '/api/v1/Charity', query: { limit: '101' } }),
      400,
      'validation_error',
    );
  });

  it('should update every field and clear the ones left out', async () => {
    const c = await createCharity({ ...wwf, name: 'Before' });
    const res = await app.request(admin, { method: 'PUT', path: `/api/v1/Charity/${c.id}`, body: { name: 'After' } });
    expect(await res.json()).toMatchObject({ id: c.id, name: 'After', slug: null, countries: [], websiteUrl: null });
  });

  it('should list the supported countries before the id route can swallow the path', async () => {
    const res = await app.request(null, { method: 'GET', path: '/api/v1/Charity/supported-countries' });
    const countries = (await res.json()) as string[];
    expect(countries).toContain('US');
    expect(countries).toHaveLength(60);
  });

  it('should set causes to exactly the keys given, and 400 on a key that does not exist', async () => {
    const c = await createCharity({ name: 'Cause Setter' });
    await createCause('set-a');
    await createCause('set-b');

    const put = (keys: string[]) =>
      app.request(admin, { method: 'PUT', path: `/api/v1/Charity/${c.id}/causes`, body: { keys } });
    expect((await put(['set-a', 'set-b'])).status).toBe(204);
    expect(await app.contract('charity.v1').causeKeys(c.id)).toEqual(['set-a', 'set-b']);
    expect((await put(['set-b'])).status).toBe(204);
    expect(await app.contract('charity.v1').causeKeys(c.id)).toEqual(['set-b']);

    const bad = await expectProblem(await put(['set-a', 'ghost']), 400, 'validation_error');
    expect(bad.data).toEqual({ errors: { causeKeys: ['ghost'] } });
    expect(await app.contract('charity.v1').causeKeys(c.id)).toEqual(['set-b']);
  });

  it('should find charities by cause key', async () => {
    const c = await createCharity({ name: 'By Cause' });
    await createCause('by-cause');
    await app.request(admin, { method: 'PUT', path: `/api/v1/Charity/${c.id}/causes`, body: { keys: ['by-cause'] } });
    const res = await app.request(null, { method: 'GET', path: '/api/v1/Charity', query: { causeKey: 'by-cause' } });
    expect(((await res.json()) as { id: string }[]).map(x => x.id)).toEqual([c.id]);
  });

  it('should delete the charity, its links, and say so on the outbox', async () => {
    const c = await createCharity({ name: 'Doomed' });
    await createCause('doomed-cause');
    await app.request(admin, {
      method: 'PUT',
      path: `/api/v1/Charity/${c.id}/causes`,
      body: { keys: ['doomed-cause'] },
    });

    const res = await app.request(admin, { method: 'DELETE', path: `/api/v1/Charity/${c.id}` });
    expect(res.status).toBe(204);
    await expectProblem(await app.request(null, { method: 'GET', path: `/api/v1/Charity/${c.id}` }), 404);
    expect(await app.sql`SELECT 1 FROM charity.charity_causes WHERE charity_id = ${c.id}`).toHaveLength(0);
    const events =
      await app.sql`SELECT 1 FROM kernel.outbox_events WHERE type = 'charity.deleted' AND payload::text LIKE ${`%${c.id}%`}`;
    expect(events).toHaveLength(1);
  });
});

describe('cause routes', () => {
  it('should create, read, rename and delete a cause, and keep the key fixed', async () => {
    const cause = await createCause('cause-crud', 'Original');
    const one = await app.request(null, { method: 'GET', path: `/api/v1/Causes/${cause.id}` });
    expect(await one.json()).toEqual({ principal: cause });

    const renamed = await app.request(admin, {
      method: 'PUT',
      path: `/api/v1/Causes/${cause.id}`,
      body: { name: 'Renamed' },
    });
    expect(await renamed.json()).toEqual({ id: cause.id, key: 'cause-crud', name: 'Renamed' });

    expect((await app.request(admin, { method: 'DELETE', path: `/api/v1/Causes/${cause.id}` })).status).toBe(204);
    await expectProblem(
      await app.request(null, { method: 'GET', path: `/api/v1/Causes/${cause.id}` }),
      404,
      'entity_not_found',
    );
  });

  it('should answer 409 entity_conflict for a key that is taken', async () => {
    await createCause('cause-dup');
    const res = await app.request(admin, {
      method: 'POST',
      path: '/api/v1/Causes',
      body: { key: 'cause-dup', name: 'Again' },
    });
    await expectProblem(res, 409, 'entity_conflict');
  });

  it('should 404 an unknown cause on read, update and delete', async () => {
    await expectProblem(
      await app.request(null, { method: 'GET', path: `/api/v1/Causes/${NO_ID}` }),
      404,
      'entity_not_found',
    );
    await expectProblem(
      await app.request(admin, { method: 'PUT', path: `/api/v1/Causes/${NO_ID}`, body: { name: 'n' } }),
      404,
      'entity_not_found',
    );
    await expectProblem(
      await app.request(admin, { method: 'DELETE', path: `/api/v1/Causes/${NO_ID}` }),
      404,
      'entity_not_found',
    );
  });

  it('should search causes by key and name', async () => {
    await createCause('searchable-key', 'Searchable Name');
    const res = await app.request(null, { method: 'GET', path: '/api/v1/Causes', query: { name: 'SEARCHABLE' } });
    expect(((await res.json()) as { key: string }[]).map(c => c.key)).toEqual(['searchable-key']);
  });
});
