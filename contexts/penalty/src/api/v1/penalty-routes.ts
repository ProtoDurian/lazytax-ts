// /api/v1/Penalty. LazyTax had no penalty controller (the drain was a hosted service only); these
// routes let a user see what they owe and an admin see the ledger and run the drain.
import { Owner, route, z } from '@lazytax/kernel';
import type { PenaltyService } from '../../domain/penalty-service';

const PenaltyStatusSchema = z.enum(['pending', 'processing', 'charged', 'failed', 'skipped']);

export const SearchQuery = z.object({
  status: PenaltyStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

const AdminSearchQuery = SearchQuery.extend({ userId: z.string().min(1).optional() });

export const penaltyRoutes = (svc: PenaltyService) => [
  // Admin routes first: their static segments must win over /:userId.
  route.get('/admin/search', {
    policy: 'admin',
    query: AdminSearchQuery,
    handler: ({ principal, query }) =>
      svc.search(query.userId ? Owner.user(query.userId) : Owner.anyone(principal), query),
  }),
  route.get('/admin/charity-balances', {
    policy: 'admin',
    handler: () => svc.charityBalances(),
  }),
  route.post('/admin/process', {
    policy: 'admin',
    handler: async () => ({ processed: await svc.processPending() }),
  }),
  route.get('/:userId', {
    policy: 'registered',
    subject: 'userId',
    query: SearchQuery,
    handler: ({ params, query }) => svc.search(Owner.user(params.userId), query),
  }),
  route.get('/:userId/outstanding', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.outstanding(params.userId),
  }),
  route.get('/:userId/:id', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.getOwned(Owner.user(params.userId), params.id),
  }),
];
