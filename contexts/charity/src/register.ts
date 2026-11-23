import '@lazytax/charity-contract/v1';
import { defineContext, z } from '@lazytax/kernel';
import { charityRoutes } from './api/v1/charity-routes';
import { CauseRepository } from './data/cause-repository';
import { CharityRepository } from './data/charity-repository';
import { CauseService } from './domain/cause-service';
import { CharityService } from './domain/charity-service';
import { PledgeSyncService } from './domain/pledge-sync-service';
import { FakePledgeGateway, PledgeFixture } from './gateway/pledge-gateway';
import { charityTools } from './mcp/charity-tools';

export default defineContext({
  // Override with env LAZYTAX_CHARITY_CONFIG='{"pledge":{"causes":[...],"organizations":[...]}}'.
  // Pledge is a fake with no network: this fixture is everything it serves.
  config: z.object({ pledge: PledgeFixture.default(PledgeFixture.parse({})) }),
  migrations: 'src/data/migrations',
  build: ({ uow, outbox, log, config, clock }) => {
    const charityRepo = new CharityRepository(uow);
    const causeRepo = new CauseRepository(uow);
    const charities = new CharityService(charityRepo, causeRepo, uow, outbox);
    const causes = new CauseService(causeRepo);
    const sync = new PledgeSyncService(new FakePledgeGateway(config.pledge), charities, causes, uow, log, () =>
      clock.now(),
    );
    return {
      provides: { 'charity.v1': charities },
      http: charityRoutes(charities, causes, sync),
      mcp: charityTools(charities, causes, sync),
      // The catalogue is global: no row belongs to a user, so there is nothing to purge.
      users: { purgeUser: async () => undefined },
      subscribers: [],
      workers: [],
    };
  },
});
