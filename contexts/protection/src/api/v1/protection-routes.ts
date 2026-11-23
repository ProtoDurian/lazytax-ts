import { Owner, route, z } from '@lazytax/kernel';
import type { ProtectionService } from '../../domain/protection-service';

const AwardWeeklyReq = z.object({ userId: z.string().min(1) });

export const protectionRoutes = (svc: ProtectionService) => [
  // GET /api/v1/Protection/{userId}: the balance, cut to the cap first.
  route.get('/:userId', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.balance(Owner.user(params.userId)),
  }),
  // POST /api/v1/Protection/award-weekly: an admin triggers the weekly award for one user.
  route.post('/award-weekly', {
    policy: 'admin',
    body: AwardWeeklyReq,
    handler: async ({ body }) => ({ userId: body.userId, awards: await svc.awardWeeklyForUser(body.userId) }),
  }),
];
