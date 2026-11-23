// Charities: reads for other contexts (charity.v1), admin writes, and the bulk upsert the Pledge
// sync uses. Writes that touch several tables run in one unit of work.
import type { CharityExternalIdDto, CharitySearchQuery, CharityV1 } from '@lazytax/charity-contract/v1';
import { conflict, notFound, type Outbox, type UnitOfWork, validationFailed } from '@lazytax/kernel';
import type { CauseRepository } from '../data/cause-repository';
import type { CharityRepository } from '../data/charity-repository';
import type {
  BulkUpsertItem,
  BulkUpsertResult,
  CauseDto,
  CharityDto,
  CharityRecord,
  CharitySearch,
  ExternalIdRecord,
} from './model';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (s: string): boolean => UUID.test(s);

const clamp = (n: number | undefined, d: number, max: number) => Math.min(Math.max(n ?? d, 0), max);

export function toSearch(q: CharitySearchQuery): CharitySearch {
  return {
    name: q.name,
    slug: q.slug,
    country: q.country,
    primaryRegistrationNumber: q.primaryRegistrationNumber,
    primaryRegistrationCountry: q.primaryRegistrationCountry,
    causeKey: q.causeKey,
    limit: clamp(q.limit, DEFAULT_LIMIT, MAX_LIMIT),
    skip: clamp(q.skip, 0, Number.MAX_SAFE_INTEGER),
  };
}

const toExternalDto = (e: {
  source: string;
  externalKey: string;
  url: string | null;
  lastSyncedAt: string | null;
}): CharityExternalIdDto => ({
  source: e.source,
  externalKey: e.externalKey,
  url: e.url,
  lastSyncedAt: e.lastSyncedAt,
});

export class CharityService implements CharityV1 {
  constructor(
    private readonly repo: CharityRepository,
    private readonly causes: CauseRepository,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
  ) {}

  // ── charity.v1 ──

  async get(id: string): Promise<CharityDto | null> {
    return isId(id) ? this.repo.get(id) : null;
  }

  async exists(id: string): Promise<boolean> {
    return isId(id) && (await this.repo.exists(id));
  }

  search(query: CharitySearchQuery): Promise<CharityDto[]> {
    return this.repo.search(toSearch(query));
  }

  getMany(ids: string[]): Promise<CharityDto[]> {
    return this.repo.getMany([...new Set(ids.filter(isId))]);
  }

  async externalId(charityId: string, source: string): Promise<CharityExternalIdDto | null> {
    if (!isId(charityId)) return null;
    const e = await this.repo.externalIdOf(charityId, source);
    return e ? toExternalDto(e) : null;
  }

  async getCause(id: string): Promise<CauseDto | null> {
    return isId(id) ? this.causes.get(id) : null;
  }

  async causeKeys(charityId: string): Promise<string[]> {
    return isId(charityId) ? this.repo.causeKeys(charityId) : [];
  }

  // ── admin ──

  create(record: CharityRecord): Promise<CharityDto> {
    return this.repo.create(record);
  }

  async update(id: string, record: CharityRecord): Promise<CharityDto> {
    const updated = isId(id) ? await this.repo.update(id, record) : null;
    if (!updated) throw notFound('Charity', id);
    return updated;
  }

  // Removes the charity (its cause links and outside ids go with it) and tells the contexts
  // that hold a charity id, through the outbox, in the same transaction.
  async delete(id: string): Promise<void> {
    const gone = isId(id)
      ? await this.uow.run(async () => {
          const deleted = await this.repo.delete(id);
          if (deleted) await this.outbox.add({ type: 'charity.deleted', payload: { charityId: id } });
          return deleted;
        })
      : false;
    if (!gone) throw notFound('Charity', id);
  }

  // Replaces the charity's causes with exactly these keys (LazyTax SetCauses).
  async setCauses(id: string, causeKeys: string[]): Promise<void> {
    if (!isId(id)) throw notFound('Charity', id);
    await this.uow.run(async () => {
      if (!(await this.repo.exists(id))) throw notFound('Charity', id);
      const keys = [...new Set(causeKeys)];
      const found = await this.causes.getByKeys(keys);
      const foundKeys = new Set(found.map(c => c.key));
      const missing = keys.filter(k => !foundKeys.has(k));
      if (missing.length > 0) throw validationFailed('Some causes not found', { causeKeys: missing });

      const desired = new Set(found.map(c => c.id));
      const existing = new Set(await this.repo.linkedCauseIds(id));
      await this.repo.linkCauses(
        id,
        [...desired].filter(c => !existing.has(c)),
      );
      await this.repo.unlinkCauses(
        id,
        [...existing].filter(c => !desired.has(c)),
      );
    });
  }

  async addCause(id: string, causeKey: string): Promise<void> {
    if (!isId(id)) throw notFound('Charity', id);
    await this.uow.run(async () => {
      if (!(await this.repo.exists(id))) throw notFound('Charity', id);
      const cause = await this.causes.getByKey(causeKey);
      if (!cause) throw validationFailed('Cause not found', { causeKey: [causeKey] });
      await this.repo.linkCauses(id, [cause.id]);
    });
  }

  // ── sync support ──

  getByExternalId(source: string, externalKey: string): Promise<CharityDto | null> {
    return this.repo.findByExternal(source, externalKey);
  }

  // Creates the link, or refreshes url, payload and sync time. 409 when the key already
  // belongs to another charity.
  async upsertExternalId(charityId: string, external: ExternalIdRecord): Promise<void> {
    if (!isId(charityId)) throw notFound('Charity', charityId);
    await this.uow.run(async () => {
      if (!(await this.repo.exists(charityId))) throw notFound('Charity', charityId);
      await this.linkExternal(charityId, external);
    });
  }

  private async linkExternal(charityId: string, external: ExternalIdRecord): Promise<void> {
    const existing = await this.repo.findExternal(external.source, external.externalKey);
    if (!existing) return this.repo.insertExternal(charityId, external);
    if (existing.charityId !== charityId) {
      throw conflict('entity_conflict', 'ExternalId is already linked to a different Charity', {
        entity: 'ExternalId',
      });
    }
    await this.repo.updateExternal(external);
  }

  // One unit of work for the whole batch: all or nothing. Charities are matched by their
  // outside id (source + key); unmatched ones are created. Every item shares one source.
  async bulkUpsert(items: BulkUpsertItem[]): Promise<BulkUpsertResult> {
    const result: BulkUpsertResult = {
      charitiesCreated: 0,
      charitiesUpdated: 0,
      externalIdsLinked: 0,
      causesLinked: 0,
    };
    if (items.length === 0) return result;
    const source = items[0]?.externalId.source;
    if (items.some(i => i.externalId.source !== source)) {
      throw validationFailed('All items in a bulk upsert must have the same external id source', {
        source: [...new Set(items.map(i => i.externalId.source))],
      });
    }
    return this.uow.run(async () => {
      const r = { ...result };
      const keys = [...new Set(items.flatMap(i => i.causeKeys))];
      const causeIds = new Map((await this.causes.getByKeys(keys)).map(c => [c.key, c.id]));
      for (const item of items) {
        const known = await this.repo.findExternal(item.externalId.source, item.externalId.externalKey);
        let charityId: string;
        if (known) {
          const updated = await this.repo.update(known.charityId, item.charity);
          if (!updated) throw notFound('Charity', known.charityId);
          charityId = updated.id;
          r.charitiesUpdated++;
        } else {
          charityId = (await this.repo.create(item.charity)).id;
          r.charitiesCreated++;
        }
        if (known) await this.repo.updateExternal(item.externalId);
        else await this.repo.insertExternal(charityId, item.externalId);
        r.externalIdsLinked++;
        const wanted = [...new Set(item.causeKeys)].flatMap(k => {
          const id = causeIds.get(k);
          return id ? [id] : [];
        });
        r.causesLinked += await this.repo.linkCauses(charityId, wanted);
      }
      return r;
    });
  }
}
