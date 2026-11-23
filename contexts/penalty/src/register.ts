import '@lazytax/penalty-contract/v1';
import '@lazytax/check-contract/v1';
import { defineContext, subscribe, z } from '@lazytax/kernel';
import { paymentGateway } from './adapters/payment-gateway';
import { penaltyRoutes } from './api/v1/penalty-routes';
import { PenaltyRepository } from './data/penalty-repository';
import { PenaltyService } from './domain/penalty-service';
import { penaltyTools } from './mcp/penalty-tools';

export default defineContext({
  // Override with env LAZYTAX_PENALTY_CONFIG='{"maxAttempts":3}'.
  config: z.object({
    batchSize: z.number().int().positive().default(100),
    maxAttempts: z.number().int().positive().default(5),
    claimLeaseMs: z
      .number()
      .int()
      .positive()
      .default(10 * 60_000),
    blockDeletionOnDebt: z.boolean().default(true),
    // LazyTax PenaltyProcessorHostedService: every 15 minutes.
    everyMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
  }),
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const repo = new PenaltyRepository(uow, clock);
    const service = new PenaltyService(
      repo,
      paymentGateway(deps.get('payment.v1')),
      deps.get('charity.v1'),
      uow,
      outbox,
      clock,
      config,
      log,
    );
    return {
      provides: { 'penalty.v1': service },
      http: penaltyRoutes(service),
      mcp: penaltyTools(service),
      users: {
        deleteGuard: userId => service.guardNoDebt(userId),
        purgeUser: userId => repo.purgeUser(userId),
      },
      subscribers: [
        // LazyTax PenaltyStakeBinding: a missed check enqueues one pending penalty.
        subscribe('check.settled', async e => {
          await service.onSettled(e.payload);
        }),
        // A penalty charge that settled after the drain's call returned (the gateway webhook).
        subscribe('payment.completed', async e => {
          if (e.payload.kind === 'penalty') await service.onPaymentCompleted(e.payload.requestId, e.payload.intentId);
        }),
      ],
      // Charges leave the process, so the tick runs outside a unit (tx: false).
      workers: [
        { name: 'process', everyMs: config.everyMs, tx: false, tick: () => service.processPending().then(() => {}) },
      ],
    };
  },
});
