// SQL for charities, their cause links and their outside ids. The catalogue is global, so no
// method here is owner-scoped; the admin routes carry the access rule (policy: admin).
import type { UnitOfWork } from '@lazytax/kernel';
import type { CharityDto, CharityRecord, CharitySearch, ExternalIdRecord, ExternalIdRow } from '../domain/model';

interface CharityRow {
  id: string;
  name: string;
  slug: string | null;
  mission: string | null;
  countries: string[] | null;
  primary_registration_number: string | null;
  primary_registration_country: string | null;
  website_url: string | null;
  logo_url: string | null;
}

interface ExternalRow {
  charity_id: string;
  source: string;
  external_key: string;
  url: string | null;
  payload: string | null;
  last_synced_at: Date | null;
}

const COLUMNS = `c.id, c.name, c.slug, c.mission, c.countries, c.primary_registration_number,
  c.primary_registration_country, c.website_url, c.logo_url`;

const toDto = (r: CharityRow): CharityDto => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  mission: r.mission,
  countries: r.countries ?? [],
  primaryRegistrationNumber: r.primary_registration_number,
  primaryRegistrationCountry: r.primary_registration_country,
  websiteUrl: r.website_url,
  logoUrl: r.logo_url,
});

const toExternal = (r: ExternalRow): ExternalIdRow => ({
  charityId: r.charity_id,
  source: r.source,
  externalKey: r.external_key,
  url: r.url,
  payload: r.payload,
  lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
});

export class CharityRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async get(id: string): Promise<CharityDto | null> {
    const db = this.uow.db();
    const rows = (await db`SELECT ${db.unsafe(COLUMNS)} FROM charity.charities c WHERE c.id = ${id}`) as CharityRow[];
    return rows[0] ? toDto(rows[0]) : null;
  }

  async exists(id: string): Promise<boolean> {
    const rows = await this.uow.db()`SELECT 1 FROM charity.charities WHERE id = ${id}`;
    return rows.length > 0;
  }

  async getMany(ids: string[]): Promise<CharityDto[]> {
    if (ids.length === 0) return [];
    const db = this.uow.db();
    const rows = (await db`
      SELECT ${db.unsafe(COLUMNS)} FROM charity.charities c
      WHERE c.id = ANY(${db.array(ids, 'UUID')})`) as CharityRow[];
    return rows.map(toDto);
  }

  async search(q: CharitySearch): Promise<CharityDto[]> {
    const db = this.uow.db();
    const rows = (await db`
      SELECT ${db.unsafe(COLUMNS)} FROM charity.charities c
      WHERE TRUE
        ${q.name ? db`AND c.name ILIKE ${`%${q.name}%`}` : db``}
        ${q.slug ? db`AND c.slug ILIKE ${`%${q.slug}%`}` : db``}
        ${q.primaryRegistrationNumber ? db`AND c.primary_registration_number = ${q.primaryRegistrationNumber}` : db``}
        ${q.primaryRegistrationCountry ? db`AND c.primary_registration_country = ${q.primaryRegistrationCountry}` : db``}
        ${q.country ? db`AND ${q.country} = ANY(c.countries)` : db``}
        ${
          q.causeKey
            ? db`AND EXISTS (
                SELECT 1 FROM charity.charity_causes cc JOIN charity.causes ca ON ca.id = cc.cause_id
                WHERE cc.charity_id = c.id AND ca.key = ${q.causeKey})`
            : db``
        }
      ORDER BY c.name, c.id
      LIMIT ${q.limit} OFFSET ${q.skip}`) as CharityRow[];
    return rows.map(toDto);
  }

  async create(r: CharityRecord): Promise<CharityDto> {
    const db = this.uow.db();
    const rows = (await db`
      INSERT INTO charity.charities
        (name, slug, mission, countries, primary_registration_number, primary_registration_country, website_url, logo_url)
      VALUES (${r.name}, ${r.slug}, ${r.mission}, ${db.array(r.countries, 'TEXT')}, ${r.primaryRegistrationNumber},
        ${r.primaryRegistrationCountry}, ${r.websiteUrl}, ${r.logoUrl})
      RETURNING id, name, slug, mission, countries, primary_registration_number, primary_registration_country,
        website_url, logo_url`) as CharityRow[];
    return toDto(rows[0] as CharityRow);
  }

  // Every field is overwritten, as LazyTax does (a null clears the column).
  async update(id: string, r: CharityRecord): Promise<CharityDto | null> {
    const db = this.uow.db();
    const rows = (await db`
      UPDATE charity.charities SET name = ${r.name}, slug = ${r.slug}, mission = ${r.mission},
        countries = ${db.array(r.countries, 'TEXT')}, primary_registration_number = ${r.primaryRegistrationNumber},
        primary_registration_country = ${r.primaryRegistrationCountry}, website_url = ${r.websiteUrl},
        logo_url = ${r.logoUrl}
      WHERE id = ${id}
      RETURNING id, name, slug, mission, countries, primary_registration_number, primary_registration_country,
        website_url, logo_url`) as CharityRow[];
    return rows[0] ? toDto(rows[0]) : null;
  }

  // Cause links and outside ids go with it (ON DELETE CASCADE).
  async delete(id: string): Promise<boolean> {
    const rows = await this.uow.db()`DELETE FROM charity.charities WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  // ── cause links ──

  async causeKeys(charityId: string): Promise<string[]> {
    const rows = (await this.uow.db()`
      SELECT ca.key FROM charity.charity_causes cc JOIN charity.causes ca ON ca.id = cc.cause_id
      WHERE cc.charity_id = ${charityId} ORDER BY ca.key`) as { key: string }[];
    return rows.map(r => r.key);
  }

  async linkedCauseIds(charityId: string): Promise<string[]> {
    const rows = (await this.uow.db()`SELECT cause_id FROM charity.charity_causes WHERE charity_id = ${charityId}`) as {
      cause_id: string;
    }[];
    return rows.map(r => r.cause_id);
  }

  // Links the causes that are not linked yet; returns how many were new.
  async linkCauses(charityId: string, causeIds: string[]): Promise<number> {
    if (causeIds.length === 0) return 0;
    const db = this.uow.db();
    const rows = await db`
      INSERT INTO charity.charity_causes (charity_id, cause_id)
      SELECT ${charityId}, UNNEST(${db.array(causeIds, 'UUID')})
      ON CONFLICT (charity_id, cause_id) DO NOTHING
      RETURNING id`;
    return rows.length;
  }

  async unlinkCauses(charityId: string, causeIds: string[]): Promise<void> {
    if (causeIds.length === 0) return;
    const db = this.uow.db();
    await db`DELETE FROM charity.charity_causes
      WHERE charity_id = ${charityId} AND cause_id = ANY(${db.array(causeIds, 'UUID')})`;
  }

  // ── outside ids ──

  async externalIdOf(charityId: string, source: string): Promise<ExternalIdRow | null> {
    const rows = (await this.uow.db()`
      SELECT charity_id, source, external_key, url, payload, last_synced_at
      FROM charity.external_ids WHERE charity_id = ${charityId} AND source = ${source}
      ORDER BY external_key LIMIT 1`) as ExternalRow[];
    return rows[0] ? toExternal(rows[0]) : null;
  }

  async findExternal(source: string, externalKey: string): Promise<ExternalIdRow | null> {
    const rows = (await this.uow.db()`
      SELECT charity_id, source, external_key, url, payload, last_synced_at
      FROM charity.external_ids WHERE source = ${source} AND external_key = ${externalKey}`) as ExternalRow[];
    return rows[0] ? toExternal(rows[0]) : null;
  }

  async findByExternal(source: string, externalKey: string): Promise<CharityDto | null> {
    const db = this.uow.db();
    const rows = (await db`
      SELECT ${db.unsafe(COLUMNS)} FROM charity.charities c
      JOIN charity.external_ids e ON e.charity_id = c.id
      WHERE e.source = ${source} AND e.external_key = ${externalKey}`) as CharityRow[];
    return rows[0] ? toDto(rows[0]) : null;
  }

  async insertExternal(charityId: string, e: ExternalIdRecord): Promise<void> {
    await this.uow.db()`
      INSERT INTO charity.external_ids (charity_id, source, external_key, url, payload, last_synced_at)
      VALUES (${charityId}, ${e.source}, ${e.externalKey}, ${e.url}, ${e.payload}, ${e.lastSyncedAt})`;
  }

  // Identity (charity, source, key) never changes; only url, payload and sync time do.
  async updateExternal(e: ExternalIdRecord): Promise<void> {
    await this.uow.db()`
      UPDATE charity.external_ids SET url = ${e.url}, payload = ${e.payload}, last_synced_at = ${e.lastSyncedAt}
      WHERE source = ${e.source} AND external_key = ${e.externalKey}`;
  }
}
