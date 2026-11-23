// The charity domain's own types. The contract's DTOs (CharityDto, CauseDto) are what leaves the context.
import type { CauseDto, CharityDto } from '@lazytax/charity-contract/v1';

export type { CauseDto, CharityDto };

// What an admin writes for a charity (LazyTax CharityRecord). Null fields clear the column.
export interface CharityRecord {
  name: string;
  slug: string | null;
  mission: string | null;
  countries: string[];
  primaryRegistrationNumber: string | null;
  primaryRegistrationCountry: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
}

export interface CharitySearch {
  name?: string;
  slug?: string;
  country?: string;
  primaryRegistrationNumber?: string;
  primaryRegistrationCountry?: string;
  causeKey?: string;
  limit: number;
  skip: number;
}

export interface CauseSearch {
  key?: string;
  name?: string;
  limit: number;
  skip: number;
}

export interface ExternalIdRecord {
  source: string;
  externalKey: string;
  url: string | null;
  payload: string | null;
  // ISO 8601.
  lastSyncedAt: string | null;
}

export interface ExternalIdRow extends ExternalIdRecord {
  charityId: string;
}

export interface BulkUpsertItem {
  charity: CharityRecord;
  externalId: ExternalIdRecord;
  causeKeys: string[];
}

export interface BulkUpsertResult {
  charitiesCreated: number;
  charitiesUpdated: number;
  externalIdsLinked: number;
  causesLinked: number;
}

export interface PledgeSyncSummary {
  causesUpserted: number;
  charitiesCreated: number;
  charitiesUpdated: number;
  externalIdsLinked: number;
  charitiesProcessed: number;
}
