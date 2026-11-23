// vacation: the reference context. It shows every pattern: contract calls (plan.v1, account.v1),
// a layer-5 guard, lock + count + write in one unit of work, an owner-scoped repository, the
// purge hook and an outbox event.
import '@lazytax/vacation-contract/v1';
import { defineContext } from '@lazytax/kernel';
import { vacationAllowed, vacationRoutes } from './api/v1/routes';
import { VacationRepository } from './data/vacation-repository';
import { VacationService } from './domain/vacation-service';
import { vacationTools } from './mcp/tools';

export default defineContext({
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox }) => {
    const plan = deps.get('plan.v1');
    const repo = new VacationRepository(uow);
    const service = new VacationService(repo, plan, deps.get('account.v1'), uow, outbox);
    const allowed = vacationAllowed(plan);
    return {
      provides: { 'vacation.v1': service },
      http: vacationRoutes(service, allowed),
      mcp: vacationTools(service, allowed),
      users: { purgeUser: userId => service.purgeUser(userId) },
    };
  },
});
