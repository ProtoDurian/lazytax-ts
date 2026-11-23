// The outside Pledge catalogue (LazyTax IPledgeClient: GetCauses, GetOrganizations).
// The donation calls (CreateDonation, GetDonations) belong to the disbursement context.
// Nothing here talks to a network: the only adapter is a fake that serves a fixture from config.
import { z } from '@lazytax/kernel';

export interface PledgeCause {
  id: number;
  name: string;
  parentId: number | null;
}

export interface PledgeOrganization {
  id: string;
  name: string;
  ngoId: string;
  mission: string;
  country: string;
  websiteUrl: string;
  profileUrl: string;
  logoUrl: string;
  // Pledge cause ids this organisation is listed under.
  causeIds: number[];
}

export interface PledgeOrganizationsPage {
  page: number;
  perPage: number;
  totalCount: number;
  data: PledgeOrganization[];
}

export interface PledgeGateway {
  getCauses(): Promise<PledgeCause[]>;
  getOrganizations(q: {
    page: number;
    perPage: number;
    causeKey?: string;
    country?: string;
  }): Promise<PledgeOrganizationsPage>;
}

export const PledgeFixture = z.object({
  causes: z
    .array(z.object({ id: z.number().int(), name: z.string(), parentId: z.number().int().nullable().default(null) }))
    .default([
      { id: 1, name: 'Animals', parentId: null },
      { id: 2, name: 'Wildlife', parentId: 1 },
      { id: 3, name: 'Education', parentId: null },
      { id: 4, name: 'Health', parentId: null },
    ]),
  organizations: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        ngoId: z.string().default(''),
        mission: z.string().default(''),
        country: z.string().default(''),
        websiteUrl: z.string().default(''),
        profileUrl: z.string().default(''),
        logoUrl: z.string().default(''),
        causeIds: z.array(z.number().int()).default([]),
      }),
    )
    .default([
      {
        id: 'org-wwf-us',
        name: 'World Wildlife Fund',
        ngoId: '53-0193089',
        mission: 'Conserve nature and reduce threats to wildlife.',
        country: 'US',
        websiteUrl: 'https://www.worldwildlife.org',
        profileUrl: 'https://pledge.example/org-wwf-us',
        logoUrl: 'https://pledge.example/logos/wwf.png',
        causeIds: [1, 2],
      },
      {
        id: 'org-room-gb',
        name: 'Room to Read',
        ngoId: '1105982',
        mission: 'Literacy and gender equality in education.',
        country: 'GB',
        websiteUrl: 'https://www.roomtoread.org',
        profileUrl: 'https://pledge.example/org-room-gb',
        logoUrl: '',
        causeIds: [3],
      },
      {
        id: 'org-msf-ch',
        name: 'Doctors Without Borders',
        ngoId: 'CHE-100',
        mission: 'Medical humanitarian aid.',
        country: 'CH',
        websiteUrl: 'https://www.msf.org',
        profileUrl: 'https://pledge.example/org-msf-ch',
        logoUrl: '',
        causeIds: [4],
      },
    ]),
});
export type PledgeFixture = z.output<typeof PledgeFixture>;

export class FakePledgeGateway implements PledgeGateway {
  constructor(private readonly fixture: PledgeFixture) {}

  async getCauses(): Promise<PledgeCause[]> {
    return this.fixture.causes.map(c => ({ id: c.id, name: c.name, parentId: c.parentId }));
  }

  async getOrganizations(q: {
    page: number;
    perPage: number;
    causeKey?: string;
    country?: string;
  }): Promise<PledgeOrganizationsPage> {
    const all = this.fixture.organizations.filter(
      o =>
        (q.causeKey === undefined || o.causeIds.map(String).includes(q.causeKey)) &&
        (q.country === undefined || o.country === q.country),
    );
    const start = (q.page - 1) * q.perPage;
    return { page: q.page, perPage: q.perPage, totalCount: all.length, data: all.slice(start, start + q.perPage) };
  }
}
