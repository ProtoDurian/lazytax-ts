// account: users, their configuration, and account deletion through the kernel user hooks.
import '@lazytax/account-contract/v1';
import { defineContext } from '@lazytax/kernel';
import { configurationRoutes, userRoutes } from './api/v1/routes';
import { ConfigurationRepository } from './data/configuration-repository';
import { UserRepository } from './data/user-repository';
import { AccountApi, ConfigurationService, UserService } from './domain/account-service';
import { accountTools } from './mcp/tools';

export default defineContext({
  migrations: 'src/data/migrations',
  build: ({ uow, outbox, users: lifecycle, clock }) => {
    const users = new UserRepository(uow);
    const configs = new ConfigurationRepository(uow);
    const userService = new UserService(users, configs, uow, outbox, lifecycle);
    const configService = new ConfigurationService(configs, uow, outbox);
    return {
      provides: { 'account.v1': new AccountApi(users, configs, clock) },
      http: [...userRoutes(userService), ...configurationRoutes(configService)],
      mcp: accountTools(userService, configService),
      users: { purgeUser: userId => userService.purgeUser(userId) },
    };
  },
});
