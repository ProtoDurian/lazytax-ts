import '@lazytax/check-contract/v1';
import '@lazytax/habit-contract/v1';
import '@lazytax/account-contract/v1';
import '@lazytax/proof-contract/v1';
import { defineContext, guard, subscribe, z } from '@lazytax/kernel';
import { checkRoutes } from './api/v1/check-routes';
import { CheckRepository } from './data/check-repository';
import { CheckService } from './domain/check-service';
import { OverviewService } from './domain/overview';
import { checkTools } from './mcp/check-tools';

export default defineContext({
  // How often the scheduler ticks. Override with LAZYTAX_CHECK_CONFIG='{"tickEveryMs":30000}'.
  config: z.object({ tickEveryMs: z.number().int().min(1000).default(60_000) }),
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const plan = deps.get('plan.v1');
    const account = deps.get('account.v1');
    const habit = deps.get('habit.v1');
    const repo = new CheckRepository(uow);
    const service = new CheckService(
      repo,
      { account, plan, habit, vacation: deps.get('vacation.v1'), protection: deps.get('protection.v1') },
      uow,
      outbox,
      clock,
      log,
    );
    const overview = new OverviewService(repo, { account, plan, habit, charity: deps.get('charity.v1') }, clock);
    // Layer 5, step 1: a plan with 0 skips refuses before any lock. The count runs under the lock.
    const skipsAllowed = guard('plan:skips', async ({ userId }) => {
      plan.ensureWithin(await plan.quota(userId, 'skips'), 0);
    });
    const now = () => clock.now();
    return {
      provides: { 'check.v1': service },
      http: checkRoutes(service, overview, skipsAllowed, now),
      mcp: checkTools(service, overview, skipsAllowed, now),
      users: { purgeUser: userId => repo.purgeUser(userId) },
      subscribers: [
        subscribe('habit.changed', async e => {
          await service.retimePending(e.payload.userId, e.payload.habitIds);
        }),
        subscribe('habit.deleted', e => service.habitsDeleted(e.payload.userId, e.payload.habitIds)),
        // Outside a unit: each user-day settles in its own unit, like the tick.
        subscribe(
          'account.timezoneChanged',
          async e => {
            await service.moveToTimezone(e.payload.userId);
          },
          { tx: false },
        ),
        subscribe('proof.evidenceRevoked', async e => {
          await service.evidenceRevoked(e.payload.userId, e.payload.proofKey, e.payload.externalId);
        }),
      ],
      // Each user-day settles in its own unit of work, so the tick itself runs outside one.
      workers: [{ name: 'tick', everyMs: config.tickEveryMs, tx: false, tick: at => service.tick(at).then(() => {}) }],
    };
  },
});
