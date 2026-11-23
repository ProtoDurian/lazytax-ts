// LazyTax App/Modules/Payment/API/V1/PaymentController.cs, mounted at /api/v1/Payment.
import { Owner, route, z } from '@lazytax/kernel';
import { isCurrency, parsePurpose } from '../../domain/model';
import type { PaymentService } from '../../domain/payment-service';

// LazyTax CreatePaymentIntentReqValidator: 0 < amount <= 10,000 (major units), ISO currency,
// description 1..500.
const CreatePaymentIntentReq = z.object({
  amount: z.number().gt(0, 'Amount must be greater than 0').lte(10000, 'Amount must not exceed 10,000'),
  currency: z
    .string()
    .length(3, 'Currency must be a 3-letter ISO code')
    .refine(isCurrency, 'Currency must be a valid ISO currency code (e.g., USD, AUD, EUR)'),
  description: z.string().min(1, 'Description is required').max(500, 'Description must not exceed 500 characters'),
});

// LazyTax ConfirmPaymentIntentReqValidator.
const ConfirmPaymentIntentReq = z.object({
  paymentConsentId: z
    .string()
    .min(1, 'PaymentConsentId is required')
    .max(100, 'PaymentConsentId must not exceed 100 characters'),
});

const PurposeQuery = z.object({ purpose: z.string().optional() });

const toCents = (amount: number) => Math.round(amount * 100);

export const paymentRoutes = (svc: PaymentService) => [
  route.put('/:userId/customers', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.createCustomer(Owner.user(params.userId)),
  }),
  route.get('/:userId/client-secret', {
    policy: 'registered',
    subject: 'userId',
    handler: ({ params }) => svc.clientSecret(Owner.user(params.userId)),
  }),
  route.get('/:userId/consent', {
    policy: 'registered',
    subject: 'userId',
    query: PurposeQuery,
    handler: async ({ params, query }) => {
      const c = await svc.getConsent(Owner.user(params.userId), parsePurpose(query.purpose));
      return { hasPaymentConsent: c.hasPaymentConsent, consentId: c.consentId, status: c.status };
    },
  }),
  route.delete('/:userId/consent', {
    policy: 'registered',
    subject: 'userId',
    query: PurposeQuery,
    handler: async ({ params, query }) => {
      await svc.disableConsent(Owner.user(params.userId), parsePurpose(query.purpose));
    },
  }),
  route.post('/:userId/intent', {
    policy: 'registered',
    subject: 'userId',
    body: CreatePaymentIntentReq,
    handler: ({ params, body }) =>
      svc.createIntent(Owner.user(params.userId), {
        amountCents: toCents(body.amount),
        currency: body.currency,
        description: body.description,
      }),
  }),
  route.post('/:userId/intent/:intentId', {
    policy: 'registered',
    subject: 'userId',
    body: ConfirmPaymentIntentReq,
    handler: ({ params, body }) => svc.confirmIntent(Owner.user(params.userId), params.intentId, body.paymentConsentId),
  }),
  // Airwallex calls this. No token: the HMAC signature over the raw body is the authentication.
  route.post('/webhook', {
    policy: 'public',
    handler: async ({ headers, rawBody }) => {
      await svc.handleWebhook(headers, rawBody);
    },
  }),
];
