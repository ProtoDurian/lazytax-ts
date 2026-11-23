// charity.v1: the catalogue of charities and causes (LazyTax Domain/Charity + Domain/Cause).
// Global data: no row belongs to a user, so no method takes an Owner.
// Interfaces and DTOs only. Never rename or remove a member once merged; add new ones.

export interface CharityDto {
  id: string;
  name: string;
  slug: string | null;
  mission: string | null;
  // ISO alpha-2 codes.
  countries: string[];
  primaryRegistrationNumber: string | null;
  primaryRegistrationCountry: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
}

export interface CauseDto {
  id: string;
  // Stable key (for Pledge: the Pledge cause id as text). Immutable.
  key: string;
  name: string;
}

export interface CharityExternalIdDto {
  // e.g. "pledge".
  source: string;
  // The id at that source (for Pledge: the organization id disbursement donates to).
  externalKey: string;
  url: string | null;
  // ISO 8601 instant.
  lastSyncedAt: string | null;
}

export interface CharitySearchQuery {
  // Case-insensitive "contains".
  name?: string;
  slug?: string;
  // ISO alpha-2: the charity lists this country.
  country?: string;
  primaryRegistrationNumber?: string;
  primaryRegistrationCountry?: string;
  causeKey?: string;
  // Default 20, at most 100.
  limit?: number;
  // Default 0.
  skip?: number;
}

export interface CharityV1 {
  // null when there is no such charity.
  get(id: string): Promise<CharityDto | null>;
  exists(id: string): Promise<boolean>;
  search(query: CharitySearchQuery): Promise<CharityDto[]>;
  // Several charities by id in one read; unknown ids are left out. Order is not guaranteed.
  getMany(ids: string[]): Promise<CharityDto[]>;
  // The charity's id at an outside source, or null when it is not linked there.
  externalId(charityId: string, source: string): Promise<CharityExternalIdDto | null>;
  // null when there is no such cause.
  getCause(id: string): Promise<CauseDto | null>;
  // Cause keys the charity is linked to; [] when none (or no such charity).
  causeKeys(charityId: string): Promise<string[]>;
}

// A charity was removed by an admin. Contexts that hold a charity id (habit, penalty, ...) react.
export interface CharityDeleted {
  charityId: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'charity.v1': CharityV1;
  }
  interface EventRegistry {
    'charity.deleted': CharityDeleted;
  }
}
