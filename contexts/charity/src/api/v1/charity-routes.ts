// /api/v1/Charity, /api/v1/Causes and /api/v1/charities/sync (LazyTax CharityController,
// CausesController, PledgeSyncController). Reads are public, as in LazyTax; writes are admin.
import { notFound, route } from '@lazytax/kernel';
import type { CauseService } from '../../domain/cause-service';
import { type CharityService, toSearch } from '../../domain/charity-service';
import { SUPPORTED_COUNTRIES, type PledgeSyncService } from '../../domain/pledge-sync-service';
import {
  CauseSearchReq,
  CharitySearchReq,
  CreateCauseReq,
  CreateCharityReq,
  SetCharityCausesReq,
  toRecord,
  UpdateCauseReq,
  UpdateCharityReq,
  withPrincipal,
} from './schemas';

const page = (q: { limit?: number; skip?: number }) => ({ limit: q.limit ?? 20, skip: q.skip ?? 0 });

export const charityRoutes = (charities: CharityService, causes: CauseService, sync: PledgeSyncService) => [
  // ── /Charity ──
  route.get('/Charity', {
    policy: 'public',
    query: CharitySearchReq,
    handler: ({ query }) => charities.search(toSearch(query)),
  }),
  // Declared before /Charity/:id so "supported-countries" is not read as an id.
  route.get('/Charity/supported-countries', {
    policy: 'public',
    handler: () => [...SUPPORTED_COUNTRIES],
  }),
  route.get('/Charity/:id', {
    policy: 'public',
    handler: async ({ params }) => {
      const c = await charities.get(params.id);
      if (!c) throw notFound('Charity', params.id);
      return withPrincipal(c);
    },
  }),
  route.put('/Charity/:id/causes', {
    policy: 'admin',
    body: SetCharityCausesReq,
    handler: async ({ params, body }) => {
      await charities.setCauses(params.id, body.keys);
    },
  }),
  route.post('/Charity', {
    policy: 'admin',
    body: CreateCharityReq,
    handler: ({ body }) => charities.create(toRecord(body)),
  }),
  route.put('/Charity/:id', {
    policy: 'admin',
    body: UpdateCharityReq,
    handler: ({ params, body }) => charities.update(params.id, toRecord(body)),
  }),
  route.delete('/Charity/:id', {
    policy: 'admin',
    handler: async ({ params }) => {
      await charities.delete(params.id);
    },
  }),

  // ── /Causes ──
  route.get('/Causes', {
    policy: 'public',
    query: CauseSearchReq,
    handler: ({ query }) => causes.search({ key: query.key, name: query.name, ...page(query) }),
  }),
  route.get('/Causes/:id', {
    policy: 'public',
    handler: async ({ params }) => withPrincipal(await causes.get(params.id)),
  }),
  route.post('/Causes', {
    policy: 'admin',
    body: CreateCauseReq,
    handler: ({ body }) => causes.create(body.key, body.name),
  }),
  route.put('/Causes/:id', {
    policy: 'admin',
    body: UpdateCauseReq,
    handler: ({ params, body }) => causes.update(params.id, body.name),
  }),
  route.delete('/Causes/:id', {
    policy: 'admin',
    handler: async ({ params }) => {
      await causes.delete(params.id);
    },
  }),

  // ── /charities/sync ──
  route.post('/charities/sync/pledge', {
    policy: 'admin',
    handler: () => sync.sync(),
  }),
];
