import { describe, expect, it } from 'bun:test';
import type { Outbox, OutboxEventInput, UnitOfWork } from '@lazytax/kernel';
import type { CauseRepository } from '../../src/data/cause-repository';
import type { CharityRepository } from '../../src/data/charity-repository';
import { CharityService } from '../../src/domain/charity-service';
import type {
  BulkUpsertItem,
  CauseDto,
  CharityDto,
  CharityRecord,
  ExternalIdRecord,
  ExternalIdRow,
} from '../../src/domain/model';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// An in-memory stand-in for the two repositories: just enough SQL semantics for the service rules.
class Memory {
  charities = new Map<string, CharityDto>();
  causes: CauseDto[] = [];
  links = new Set<string>(); // "charityId|causeId"
  externals: ExternalIdRow[] = [];
  next = 1;

  repo = {
    exists: async (id: string) => this.charities.has(id),
    get: async (id: string) => this.charities.get(id) ?? null,
    create: async (r: CharityRecord) => {
      const c: CharityDto = { id: ID(this.next++), ...r };
      this.charities.set(c.id, c);
      return c;
    },
    update: async (id: string, r: CharityRecord) => {
      if (!this.charities.has(id)) return null;
      const c: CharityDto = { id, ...r };
      this.charities.set(id, c);
      return c;
    },
    delete: async (id: string) => this.charities.delete(id),
    linkedCauseIds: async (id: string) =>
      [...this.links].filter(l => l.startsWith(`${id}|`)).map(l => l.split('|')[1] as string),
    linkCauses: async (id: string, ids: string[]) => {
      let n = 0;
      for (const c of ids) {
        if (this.links.has(`${id}|${c}`)) continue;
        this.links.add(`${id}|${c}`);
        n++;
      }
      return n;
    },
    unlinkCauses: async (id: string, ids: string[]) => {
      for (const c of ids) this.links.delete(`${id}|${c}`);
    },
    findExternal: async (source: string, key: string) =>
      this.externals.find(e => e.source === source && e.externalKey === key) ?? null,
    insertExternal: async (charityId: string, e: ExternalIdRecord) => {
      this.externals.push({ charityId, ...e });
    },
    updateExternal: async (e: ExternalIdRecord) => {
      const row = this.externals.find(x => x.source === e.source && x.externalKey === e.externalKey);
      if (row) Object.assign(row, e);
    },
  } as unknown as CharityRepository;

  causeRepo = {
    getByKeys: async (keys: string[]) => this.causes.filter(c => keys.includes(c.key)),
    getByKey: async (key: string) => this.causes.find(c => c.key === key) ?? null,
  } as unknown as CauseRepository;
}

const record = (name: string): CharityRecord => ({
  name,
  slug: null,
  mission: null,
  countries: [],
  primaryRegistrationNumber: null,
  primaryRegistrationCountry: null,
  websiteUrl: null,
  logoUrl: null,
});
const ext = (key: string, source = 'pledge'): ExternalIdRecord => ({
  source,
  externalKey: key,
  url: null,
  payload: null,
  lastSyncedAt: null,
});
const item = (name: string, key: string, causeKeys: string[], source = 'pledge'): BulkUpsertItem => ({
  charity: record(name),
  externalId: ext(key, source),
  causeKeys,
});

function setup() {
  const mem = new Memory();
  mem.causes = [
    { id: 'c1', key: 'k1', name: 'One' },
    { id: 'c2', key: 'k2', name: 'Two' },
    { id: 'c3', key: 'k3', name: 'Three' },
  ];
  const events: OutboxEventInput[] = [];
  const outbox = { add: async (e: OutboxEventInput) => void events.push(e) } as unknown as Outbox;
  const uow = { run: <T>(fn: () => Promise<T>) => fn() } as unknown as UnitOfWork;
  return { mem, events, service: new CharityService(mem.repo, mem.causeRepo, uow, outbox) };
}

describe('CharityService', () => {
  it('should answer null or false for an id that is not a uuid, without touching the database', async () => {
    const { service } = setup();
    expect(await service.get('nope')).toBeNull();
    expect(await service.exists('nope')).toBe(false);
    expect(await service.causeKeys('nope')).toEqual([]);
    expect(await service.externalId('nope', 'pledge')).toBeNull();
  });

  it('should 404 an update of an unknown charity', async () => {
    const { service } = setup();
    expect(service.update(ID(9), record('x'))).rejects.toMatchObject({ status: 404, id: 'entity_not_found' });
  });

  it('should delete a charity and tell the outbox, and 404 a second delete', async () => {
    const { service, events } = setup();
    const c = await service.create(record('Gone'));
    await service.delete(c.id);
    expect(events).toEqual([{ type: 'charity.deleted', payload: { charityId: c.id } }]);
    expect(service.delete(c.id)).rejects.toMatchObject({ status: 404 });
    expect(events).toHaveLength(1);
  });

  describe('setCauses', () => {
    it('should replace the links with exactly the keys given', async () => {
      const { service, mem } = setup();
      const c = await service.create(record('A'));
      await service.setCauses(c.id, ['k1', 'k2']);
      await service.setCauses(c.id, ['k2', 'k3', 'k3']);
      expect([...mem.links].sort()).toEqual([`${c.id}|c2`, `${c.id}|c3`]);
    });

    it('should name every missing key in a 400 and change nothing', async () => {
      const { service, mem } = setup();
      const c = await service.create(record('A'));
      await service.setCauses(c.id, ['k1']);
      const err = await service.setCauses(c.id, ['k2', 'x', 'y']).catch(e => e);
      expect(err).toMatchObject({ status: 400, id: 'validation_error', data: { errors: { causeKeys: ['x', 'y'] } } });
      expect([...mem.links]).toEqual([`${c.id}|c1`]);
    });

    it('should 404 an unknown charity', async () => {
      const { service } = setup();
      expect(service.setCauses(ID(7), ['k1'])).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('bulkUpsert', () => {
    it('should create new charities, link their ids and causes, and count them', async () => {
      const { service } = setup();
      const r = await service.bulkUpsert([item('A', 'a', ['k1']), item('B', 'b', ['k1', 'k2'])]);
      expect(r).toEqual({ charitiesCreated: 2, charitiesUpdated: 0, externalIdsLinked: 2, causesLinked: 3 });
    });

    it('should update by outside id on a second run and link only new causes', async () => {
      const { service, mem } = setup();
      await service.bulkUpsert([item('A', 'a', ['k1'])]);
      const r = await service.bulkUpsert([item('A renamed', 'a', ['k1', 'k2'])]);
      expect(r).toEqual({ charitiesCreated: 0, charitiesUpdated: 1, externalIdsLinked: 1, causesLinked: 1 });
      expect([...mem.charities.values()].map(c => c.name)).toEqual(['A renamed']);
    });

    it('should ignore a cause key that does not exist', async () => {
      const { service } = setup();
      const r = await service.bulkUpsert([item('A', 'a', ['k1', 'nope'])]);
      expect(r.causesLinked).toBe(1);
    });

    it('should refuse a batch that mixes sources', async () => {
      const { service } = setup();
      expect(service.bulkUpsert([item('A', 'a', [], 'pledge'), item('B', 'b', [], 'other')])).rejects.toMatchObject({
        status: 400,
      });
    });

    it('should do nothing for an empty batch', async () => {
      const { service } = setup();
      expect(await service.bulkUpsert([])).toEqual({
        charitiesCreated: 0,
        charitiesUpdated: 0,
        externalIdsLinked: 0,
        causesLinked: 0,
      });
    });
  });

  describe('upsertExternalId', () => {
    it('should 409 when the key already belongs to another charity', async () => {
      const { service } = setup();
      const a = await service.create(record('A'));
      const b = await service.create(record('B'));
      await service.upsertExternalId(a.id, ext('same'));
      expect(service.upsertExternalId(b.id, ext('same'))).rejects.toMatchObject({ status: 409, id: 'entity_conflict' });
    });

    it('should refresh the same charity link', async () => {
      const { service, mem } = setup();
      const a = await service.create(record('A'));
      await service.upsertExternalId(a.id, ext('k'));
      await service.upsertExternalId(a.id, { ...ext('k'), url: 'https://x.example' });
      expect(mem.externals).toHaveLength(1);
      expect(mem.externals[0]?.url).toBe('https://x.example');
    });
  });
});
