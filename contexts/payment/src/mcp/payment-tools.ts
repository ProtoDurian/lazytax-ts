// MCP tools: the same policy, subject and service method as the matching Payment route.
import { Owner, tool, z } from '@lazytax/kernel';
import { parsePurpose } from '../domain/model';
import type { PaymentService } from '../domain/payment-service';

const UserInput = z.object({ userId: z.string() });
const ConsentInput = z.object({ userId: z.string(), purpose: z.enum(['penalty', 'subscription']).optional() });

export const paymentTools = (svc: PaymentService) => [
  tool('createCustomer', {
    description: "Create (or reuse) the user's payment customer and return a client secret for the card form",
    policy: 'registered',
    subject: 'userId',
    input: UserInput,
    handler: ({ input }) => svc.createCustomer(Owner.user(input.userId)),
  }),
  tool('getConsent', {
    description: "Show whether the user has a verified payment consent for a purpose (default 'penalty')",
    policy: 'registered',
    subject: 'userId',
    input: ConsentInput,
    handler: async ({ input }) => {
      const c = await svc.getConsent(Owner.user(input.userId), parsePurpose(input.purpose));
      return { hasPaymentConsent: c.hasPaymentConsent, consentId: c.consentId, status: c.status };
    },
  }),
  tool('disableConsent', {
    description: "Revoke the user's payment consent for a purpose (default 'penalty')",
    policy: 'registered',
    subject: 'userId',
    input: ConsentInput,
    handler: async ({ input }) => {
      await svc.disableConsent(Owner.user(input.userId), parsePurpose(input.purpose));
      return { disabled: true };
    },
  }),
];
