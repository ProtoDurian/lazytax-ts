// plan's MCP tools: the same service methods as the routes.
import { Owner, tool, z } from '@lazytax/kernel';
import type { PlanService } from '../domain/plan-service';

export function planTools(plan: PlanService) {
  return [
    tool('plans', {
      description: 'The public plan catalog: tiers, prices and limits',
      policy: 'public',
      input: z.object({}),
      handler: () => plan.plans(),
    }),
    tool('get', {
      description: "A user's effective subscription",
      policy: 'registered',
      subject: 'userId',
      input: z.object({ userId: z.string() }),
      handler: ({ principal, input }) =>
        plan.get(principal.isAdmin ? Owner.anyone(principal) : Owner.user(input.userId), input.userId),
    }),
    tool('setTier', {
      description: "Admin: set a user's tier (free cancels)",
      policy: 'admin',
      input: z.object({ userId: z.string(), tier: z.string() }),
      handler: ({ principal, input }) => plan.setTier(Owner.anyone(principal), input.userId, input.tier, principal.sub),
    }),
  ];
}
