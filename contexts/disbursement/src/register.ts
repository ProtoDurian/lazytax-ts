import '@lazytax/charity-contract/v1';
import '@lazytax/disbursement-contract/v1';
import '@lazytax/penalty-contract/v1';
import { defineContext, z } from '@lazytax/kernel';
import { fakePledge } from './adapters/fake-pledge-gateway';
import { disbursementRoutes } from './api/v1/disbursement-routes';
import { DisbursementRepository } from './data/disbursement-repository';
import { DisbursementService } from './domain/disbursement-service';
import { disbursementTools } from './mcp/disbursement-tools';

// Override with env LAZYTAX_DISBURSEMENT_CONFIG='{"enabled":true,"minPayoutCents":500}'.
const DisbursementConfig = z.object({
  // Master switch for the background payout worker. Off by default (the route still works).
  enabled: z.boolean().default(false),
  // Skip a (charity, currency) group whose total is below this. 0 = no threshold.
  minPayoutCents: z.number().int().min(0).default(0),
  // Cap on (charity, currency) groups paid out per pass.
  maxGroupsPerRun: z.number().int().min(1).default(100),
  // Worker period: daily.
  everyMs: z
    .number()
    .int()
    .min(1000)
    .default(24 * 60 * 60 * 1000),
  // A pending disbursement older than this is reconciled against the vendor.
  reconcileLeaseMs: z
    .number()
    .int()
    .min(0)
    .default(10 * 60 * 1000),
  // The legal donor of record recorded on every donation.
  donorFirstName: z.string().min(1).default('LazyTax'),
  donorLastName: z.string().min(1).default('Donations'),
  donorEmail: z.string().email().default('donations@lazytax.club'),
});

export default defineContext({
  config: DisbursementConfig,
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const penalty = deps.get('penalty.v1');
    const charity = deps.get('charity.v1');
    const repo = new DisbursementRepository(uow);
    const service = new DisbursementService(
      repo,
      penalty,
      {
        pledgeOrganizationId: async charityId => (await charity.externalId(charityId, 'pledge'))?.externalKey ?? null,
      },
      fakePledge,
      uow,
      outbox,
      clock,
      log,
      {
        donor: { firstName: config.donorFirstName, lastName: config.donorLastName, email: config.donorEmail },
        minPayoutCents: config.minPayoutCents,
        maxGroups: config.maxGroupsPerRun,
        reconcileLeaseMs: config.reconcileLeaseMs,
      },
    );
    return {
      provides: { 'disbursement.v1': service },
      http: disbursementRoutes(service),
      mcp: disbursementTools(service),
      // No row here belongs to a user (a payout sums many users' penalties): nothing to purge.
      users: { purgeUser: async () => {} },
      // The payout runs outside any unit of work (it calls the gateway); each step opens its own.
      workers: [
        {
          name: 'payout',
          everyMs: config.everyMs,
          tx: false,
          tick: async () => {
            if (config.enabled) await service.processPending();
          },
        },
      ],
    };
  },
});
