// Pulls causes and organisations from Pledge into the catalogue (LazyTax PledgeSyncService).
// The gateway call runs OUTSIDE any unit of work; each write batch is its own unit of work.
import type { Logger, UnitOfWork } from '@lazytax/kernel';
import type { PledgeGateway, PledgeCause, PledgeOrganization } from '../gateway/pledge-gateway';
import type { CauseService } from './cause-service';
import type { CharityService } from './charity-service';
import type { BulkUpsertItem, PledgeSyncSummary } from './model';

export const SUPPORTED_COUNTRIES = [
  'US',
  'GB',
  'CA',
  'AU',
  'DE',
  'FR',
  'NL',
  'SE',
  'NO',
  'DK',
  'FI',
  'CH',
  'AT',
  'BE',
  'IE',
  'NZ',
  'SG',
  'HK',
  'JP',
  'KR',
  'IN',
  'ID',
  'CN',
  'BR',
  'MX',
  'AR',
  'CL',
  'CO',
  'PE',
  'ES',
  'IT',
  'PT',
  'PL',
  'CZ',
  'GR',
  'TR',
  'RU',
  'ZA',
  'EG',
  'NG',
  'KE',
  'TH',
  'MY',
  'PH',
  'VN',
  'AE',
  'SA',
  'IL',
  'UA',
  'RO',
  'HU',
  'BG',
  'HR',
  'SI',
  'SK',
  'LT',
  'LV',
  'EE',
  'IS',
  'LU',
] as const;

const PLEDGE_SOURCE = 'pledge';
const PAGE_SIZE = 25;
const MAX_MISSION = 8192;

// "Animals > Wildlife": the cause's name under all its parents. A parent loop stops the walk.
export function hierarchicalName(cause: PledgeCause, lookup: Map<number, PledgeCause>): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let current: PledgeCause | undefined = cause;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.push(current.name);
    current = current.parentId === null ? undefined : lookup.get(current.parentId);
  }
  return names.reverse().join(' > ');
}

export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(' ', '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s);

export class PledgeSyncService {
  constructor(
    private readonly gateway: PledgeGateway,
    private readonly charities: CharityService,
    private readonly causes: CauseService,
    private readonly uow: UnitOfWork,
    private readonly log: Logger,
    private readonly now: () => Date,
  ) {}

  async sync(): Promise<PledgeSyncSummary> {
    const pledgeCauses = await this.gateway.getCauses();
    const lookup = new Map(pledgeCauses.map(c => [c.id, c]));

    const causesUpserted = await this.uow.run(async () => {
      let n = 0;
      for (const c of pledgeCauses) {
        const key = String(c.id);
        const name = hierarchicalName(c, lookup);
        const existing = await this.causes.getByKey(key);
        if (!existing) {
          await this.causes.create(key, name);
          n++;
        } else if (existing.name !== name) {
          await this.causes.update(existing.id, name);
          n++;
        }
      }
      return n;
    });

    const total: PledgeSyncSummary = {
      causesUpserted,
      charitiesCreated: 0,
      charitiesUpdated: 0,
      externalIdsLinked: 0,
      charitiesProcessed: 0,
    };
    for (const country of SUPPORTED_COUNTRIES) {
      for (const cause of pledgeCauses) {
        const r = await this.syncBatch(country, String(cause.id));
        total.charitiesCreated += r.charitiesCreated;
        total.charitiesUpdated += r.charitiesUpdated;
        total.externalIdsLinked += r.externalIdsLinked;
        total.charitiesProcessed += r.charitiesProcessed;
      }
    }
    return total;
  }

  // The top organisations of one country and cause. A failed batch is logged and counts as zero.
  private async syncBatch(country: string, causeKey: string): Promise<Omit<PledgeSyncSummary, 'causesUpserted'>> {
    const none = { charitiesCreated: 0, charitiesUpdated: 0, externalIdsLinked: 0, charitiesProcessed: 0 };
    try {
      const page = await this.gateway.getOrganizations({ page: 1, perPage: PAGE_SIZE, causeKey, country });
      if (page.data.length === 0) return none;
      const items = page.data.map(o => this.toItem(o, causeKey));
      const r = await this.charities.bulkUpsert(items);
      return { ...r, charitiesProcessed: page.data.length };
    } catch (e) {
      this.log.warn('pledge sync batch failed', { country, causeKey, error: String(e) });
      return none;
    }
  }

  private toItem(o: PledgeOrganization, causeKey: string): BulkUpsertItem {
    const mission = orNull(o.mission);
    return {
      charity: {
        name: o.name,
        slug: slugOf(o.name),
        mission: mission === null ? null : mission.slice(0, MAX_MISSION),
        countries: o.country.trim() === '' ? [] : [o.country],
        primaryRegistrationNumber: orNull(o.ngoId),
        primaryRegistrationCountry: orNull(o.country),
        websiteUrl: orNull(o.websiteUrl),
        logoUrl: orNull(o.logoUrl),
      },
      externalId: {
        source: PLEDGE_SOURCE,
        externalKey: o.id,
        url: orNull(o.profileUrl),
        payload: null,
        lastSyncedAt: this.now().toISOString(),
      },
      causeKeys: [causeKey],
    };
  }
}
