import { route } from '@lazytax/kernel';
import type { DisbursementService } from '../../domain/disbursement-service';

// Admin-only manual trigger for the charity payout pass: runs one pass on demand (reconcile,
// claim, donate) with the configured donor and thresholds. The worker runs the same pass on a timer.
export const disbursementRoutes = (svc: DisbursementService) => [
  route.post('/run', {
    policy: 'admin',
    handler: async () => ({ completed: await svc.processPending() }),
  }),
];
