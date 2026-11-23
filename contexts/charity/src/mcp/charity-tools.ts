// MCP tools: the same service methods as the routes, the same policies.
import { notFound, tool, z } from '@lazytax/kernel';
import type { CauseService } from '../domain/cause-service';
import { type CharityService, toSearch } from '../domain/charity-service';
import type { PledgeSyncService } from '../domain/pledge-sync-service';
import { CreateCharityReq, toRecord } from '../api/v1/schemas';

export const charityTools = (charities: CharityService, causes: CauseService, sync: PledgeSyncService) => [
  tool('search', {
    description: 'Search the charity catalogue by name, slug, country, registration or cause key',
    policy: 'public',
    input: z.object({
      name: z.string().optional(),
      slug: z.string().optional(),
      country: z.string().length(2).optional(),
      primaryRegistrationNumber: z.string().optional(),
      primaryRegistrationCountry: z.string().length(2).optional(),
      causeKey: z.string().optional(),
      limit: z.number().int().min(0).max(100).optional(),
      skip: z.number().int().min(0).optional(),
    }),
    handler: ({ input }) => charities.search(toSearch(input)),
  }),
  tool('get', {
    description: 'Get one charity by id',
    policy: 'public',
    input: z.object({ id: z.string() }),
    handler: async ({ input }) => {
      const c = await charities.get(input.id);
      if (!c) throw notFound('Charity', input.id);
      return { principal: c };
    },
  }),
  tool('searchCauses', {
    description: 'Search causes by key or name',
    policy: 'public',
    input: z.object({
      key: z.string().max(128).optional(),
      name: z.string().max(256).optional(),
      limit: z.number().int().min(0).max(100).optional(),
      skip: z.number().int().min(0).optional(),
    }),
    handler: ({ input }) =>
      causes.search({ key: input.key, name: input.name, limit: input.limit ?? 20, skip: input.skip ?? 0 }),
  }),
  tool('create', {
    description: 'Create a charity (admin)',
    policy: 'admin',
    input: CreateCharityReq,
    handler: ({ input }) => charities.create(toRecord(input)),
  }),
  tool('setCauses', {
    description: 'Replace the causes of a charity with exactly these cause keys (admin)',
    policy: 'admin',
    input: z.object({ id: z.string(), keys: z.array(z.string().min(1).max(128)) }),
    handler: async ({ input }) => {
      await charities.setCauses(input.id, input.keys);
      return { ok: true };
    },
  }),
  tool('syncPledge', {
    description: 'Pull causes and charities from Pledge into the catalogue (admin)',
    policy: 'admin',
    input: z.object({}),
    handler: () => sync.sync(),
  }),
];
