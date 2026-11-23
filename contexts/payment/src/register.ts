// The payment context: Airwallex customers, purpose-scoped consents and merchant-initiated charges.
import '@lazytax/notification-contract/v1';
import '@lazytax/payment-contract/v1';
import { defineContext, z } from '@lazytax/kernel';
import { paymentRoutes } from './api/v1/payment-routes';
import { PaymentRepository } from './data/payment-repository';
import { FakeAirwallexGateway } from './domain/gateway';
import { PaymentService } from './domain/payment-service';
import { paymentTools } from './mcp/payment-tools';

// Override with env LAZYTAX_PAYMENT_CONFIG='{"webhookSecret":"..."}'.
const PaymentConfig = z.object({
  // LazyTax Payment:Airwallex:Webhook. The dev default is not a secret.
  webhookSecret: z.string().min(1).default('dev-airwallex-webhook-secret'),
  // A webhook older (or newer) than this is refused.
  webhookToleranceSec: z.number().int().positive().default(300),
});

export default defineContext({
  config: PaymentConfig,
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const notification = deps.get('notification.v1');
    const repo = new PaymentRepository(uow);
    const gateway = new FakeAirwallexGateway();
    const notifier = {
      consentChanged: (userId: string, linked: boolean, purpose: string, at: Date) =>
        notification.email(userId, 'payment-consent-changed', {
          ChangeSummary: linked ? 'Payment method linked' : 'Payment method unlinked',
          Purpose: purpose,
          ChangeDate: at.toISOString().slice(0, 10),
        }),
    };
    const service = new PaymentService(repo, gateway, uow, outbox, clock, notifier, log, config);
    return {
      provides: { 'payment.v1': service },
      http: paymentRoutes(service),
      mcp: paymentTools(service),
      users: {
        // Outside any unit, best effort (the kernel logs and ignores a throw).
        beforePurge: userId => service.revokeAll(userId),
        purgeUser: userId => repo.purgeUser(userId),
      },
      subscribers: [],
      workers: [],
    };
  },
});
