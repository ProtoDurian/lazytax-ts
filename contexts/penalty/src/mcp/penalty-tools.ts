// penalty.* MCP tools: the same policy, subject and service method as the routes.
import { Owner, tool, z } from '@lazytax/kernel';
import type { PenaltyService } from '../domain/penalty-service';
import { SearchQuery } from '../api/v1/penalty-routes';

export const penaltyTools = (svc: PenaltyService) => [
  tool('search', {
    description: "List a user's penalties (missed staked checks), newest first",
    policy: 'registered',
    subject: 'userId',
    input: SearchQuery.extend({ userId: z.string() }),
    handler: ({ input }) => svc.search(Owner.user(input.userId), input),
  }),
  tool('get', {
    description: "Get one of a user's penalties by id",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string(), id: z.string() }),
    handler: ({ input }) => svc.getOwned(Owner.user(input.userId), input.id),
  }),
  tool('outstanding', {
    description: 'What a user still owes: penalties not charged yet, per currency',
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string() }),
    handler: ({ input }) => svc.outstanding(input.userId),
  }),
  tool('charityBalances', {
    description: 'Admin: the amount accrued per charity and currency from charged penalties',
    policy: 'admin',
    input: z.object({}),
    handler: () => svc.charityBalances(),
  }),
];
