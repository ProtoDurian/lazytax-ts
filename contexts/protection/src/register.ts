import '@lazytax/protection-contract/v1';
import { defineContext, subscribe } from '@lazytax/kernel';
import { protectionRoutes } from './api/v1/protection-routes';
import { ProtectionRepository } from './data/protection-repository';
import { ProtectionService } from './domain/protection-service';
import { protectionTools } from './mcp/protection-tools';

export default defineContext({
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log }) => {
    const repo = new ProtectionRepository(uow);
    const service = new ProtectionService(repo, deps.get('plan.v1'), deps.get('account.v1'), uow, outbox, log);
    return {
      provides: { 'protection.v1': service },
      http: protectionRoutes(service),
      mcp: protectionTools(service),
      users: { purgeUser: userId => repo.purgeUser(userId) },
      // Runs in its own unit of work with the delivery mark: the ledger row is written exactly once.
      subscribers: [subscribe('check.settled', e => service.onSettled(e.payload))],
      // Hourly: finishes the weeks that ended since the last tick. Idempotent per (habit, week).
      workers: [
        {
          name: 'weekly-award',
          everyMs: 3_600_000,
          tick: now => service.awardAll(now).then(() => undefined),
          tx: false,
        },
      ],
    };
  },
});
