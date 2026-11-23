// LazyTax App/Modules/Subscription/API/V1/SubscriptionController.cs (billing parts out of scope),
// plus the admin tier endpoint and the tier-change audit, under /api/v1/Subscription.
import { notFound, Owner, type Principal, route, z } from '@lazytax/kernel';
import type { SubscriptionChange } from '../../domain/model';
import type { PlanService } from '../../domain/plan-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SetTierReq = z.object({ tier: z.string().min(1) });

const ownerFor = (p: Principal, userId: string) => (p.isAdmin ? Owner.anyone(p) : Owner.user(userId));
const toChangeRes = (c: SubscriptionChange) => ({
  id: c.id,
  fromTier: c.fromTier,
  toTier: c.toTier,
  changedBy: c.changedBy,
  createdAt: c.createdAt.toISOString(),
});

export function planRoutes(plan: PlanService) {
  return [
    route.get('/plans', { policy: 'public', handler: () => plan.plans() }),
    route.get('/:userId', {
      policy: 'registered',
      subject: 'userId',
      handler: ({ principal, params }) => plan.get(ownerFor(principal, params.userId), params.userId),
    }),
    route.put('/:userId/tier', {
      policy: 'admin',
      body: SetTierReq,
      handler: ({ principal, params, body }) =>
        plan.setTier(Owner.anyone(principal), params.userId, body.tier, principal.sub),
    }),
    route.post('/:userId/cancel', {
      policy: 'registered',
      subject: 'userId',
      handler: ({ principal, params }) => plan.cancel(ownerFor(principal, params.userId), params.userId),
    }),
    route.get('/:userId/changes', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ principal, params }) =>
        (await plan.listChanges(ownerFor(principal, params.userId), params.userId)).map(toChangeRes),
    }),
    route.get('/:userId/changes/:changeId', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ principal, params }) => {
        if (!UUID.test(params.changeId)) throw notFound('SubscriptionChange', params.changeId);
        return toChangeRes(await plan.getChange(ownerFor(principal, params.userId), params.changeId));
      },
    }),
  ];
}
