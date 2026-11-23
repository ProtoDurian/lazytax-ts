import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Actor, startTestApp, type TestApp } from '@lazytax/kernel/testing';

let app: TestApp;
let admin: Actor;

beforeAll(async () => {
  app = await startTestApp({
    contexts: ['charity'],
    config: {
      charity: {
        pledge: {
          causes: [
            { id: 10, name: 'Animals' },
            { id: 11, name: 'Wildlife', parentId: 10 },
          ],
          organizations: [
            { id: 'p-1', name: 'Pandas United', ngoId: 'N1', country: 'US', causeIds: [10, 11] },
            { id: 'p-2', name: 'Owls GB', ngoId: 'N2', country: 'GB', causeIds: [11], mission: 'x'.repeat(9000) },
          ],
        },
      },
    },
  });
  admin = await app.admin();
});
afterAll(() => app.close());

const sync = async () => {
  const res = await app.request(admin, { method: 'POST', path: '/api/v1/charities/sync/pledge' });
  expect(res.status).toBe(200);
  return res.json();
};

describe('Pledge sync (fake gateway)', () => {
  it('should load causes with their full names, then charities, and be repeatable', async () => {
    expect(await sync()).toEqual({
      causesUpserted: 2,
      charitiesCreated: 2,
      charitiesUpdated: 1,
      externalIdsLinked: 3,
      charitiesProcessed: 3,
    });
    const causes = await app.sql`SELECT key, name FROM charity.causes ORDER BY key`;
    expect(causes.map((c: { key: string; name: string }) => [c.key, c.name])).toEqual([
      ['10', 'Animals'],
      ['11', 'Animals > Wildlife'],
    ]);
    // Same fixture again: nothing new, everything refreshed.
    expect(await sync()).toEqual({
      causesUpserted: 0,
      charitiesCreated: 0,
      charitiesUpdated: 3,
      externalIdsLinked: 3,
      charitiesProcessed: 3,
    });
    expect(await app.sql`SELECT 1 FROM charity.charities`).toHaveLength(2);
  });

  it('should cut a mission to 8192 characters and fill the registration fields', async () => {
    const res = await app.request(null, { method: 'GET', path: '/api/v1/Charity', query: { name: 'owls' } });
    const [owls] = (await res.json()) as {
      mission: string;
      primaryRegistrationNumber: string;
      primaryRegistrationCountry: string;
      slug: string;
    }[];
    expect(owls?.mission).toHaveLength(8192);
    expect(owls).toMatchObject({ primaryRegistrationNumber: 'N2', primaryRegistrationCountry: 'GB', slug: 'owls-gb' });
  });

  it('should run the same sync as an MCP tool, for admins only', async () => {
    const out = await app.mcp(admin, 'charity.syncPledge', {});
    expect(out.ok).toBe(true);
    const user = await app.user();
    const denied = await app.mcp(user, 'charity.syncPledge', {});
    expect(denied.ok).toBe(false);
    expect(denied.problem?.status).toBe(403);
  });
});

describe('charity.v1 contract', () => {
  it('should read charities, outside ids and causes for other contexts', async () => {
    const c = app.contract('charity.v1');
    const [pandas] = await c.search({ name: 'pandas' });
    expect(pandas).toBeDefined();
    const id = (pandas as { id: string }).id;

    expect(await c.exists(id)).toBe(true);
    expect(await c.get(id)).toMatchObject({ name: 'Pandas United' });
    expect((await c.getMany([id, 'not-a-guid'])).map(x => x.id)).toEqual([id]);
    expect(await c.externalId(id, 'pledge')).toMatchObject({ source: 'pledge', externalKey: 'p-1' });
    expect(await c.externalId(id, 'other')).toBeNull();
    expect((await c.causeKeys(id)).sort()).toEqual(['10', '11']);
  });

  it('should say no for an unknown or malformed id instead of throwing', async () => {
    const c = app.contract('charity.v1');
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      expect(await c.exists(id)).toBe(false);
      expect(await c.get(id)).toBeNull();
      expect(await c.getCause(id)).toBeNull();
      expect(await c.causeKeys(id)).toEqual([]);
    }
  });
});
