import { Owner, tool, z } from '@lazytax/kernel';
import type { ProtectionService } from '../domain/protection-service';

export const protectionTools = (svc: ProtectionService) => [
  tool('balance', {
    description: "Get a user's freeze-day balance and cap (the balance is cut to the cap first)",
    policy: 'registered',
    subject: 'userId',
    input: z.object({ userId: z.string().min(1) }),
    handler: ({ input }) => svc.balance(Owner.user(input.userId)),
  }),
  tool('awardWeekly', {
    description: "Admin: award a user's freeze days for their last perfect habit weeks",
    policy: 'admin',
    input: z.object({ userId: z.string().min(1) }),
    handler: async ({ input }) => ({ userId: input.userId, awards: await svc.awardWeeklyForUser(input.userId) }),
  }),
];
