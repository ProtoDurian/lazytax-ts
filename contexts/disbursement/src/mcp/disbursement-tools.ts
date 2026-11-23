import { tool, z } from '@lazytax/kernel';
import type { DisbursementService } from '../domain/disbursement-service';

export const disbursementTools = (svc: DisbursementService) => [
  tool('run', {
    description: 'Run one charity payout pass now: reconcile in-flight donations, then claim and donate (admin only)',
    policy: 'admin',
    input: z.object({}),
    handler: async () => ({ completed: await svc.processPending() }),
  }),
];
