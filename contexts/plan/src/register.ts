// plan: subscription tier and entitlement (quotas, freeze cap, minimum tier). Billing is out of scope.
import '@lazytax/plan-contract/v1';
import { defineContext } from '@lazytax/kernel';
import { planRoutes } from './api/v1/routes';
import { SubscriptionRepository } from './data/subscription-repository';
import { PlanConfig } from './domain/model';
import { PlanService } from './domain/plan-service';
import { planTools } from './mcp/tools';

export default defineContext({
  config: PlanConfig,
  migrations: 'src/data/migrations',
  build: ({ uow, outbox, config, clock }) => {
    const service = new PlanService(new SubscriptionRepository(uow), config, uow, outbox, clock);
    return {
      provides: { 'plan.v1': service },
      http: planRoutes(service),
      mcp: planTools(service),
      users: { purgeUser: userId => service.purgeUser(userId) },
    };
  },
});
