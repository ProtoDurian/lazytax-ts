// account's MCP tools: the same service methods as the routes.
import { Owner, tool, z } from '@lazytax/kernel';
import { toConfigRes, toUserRes } from '../api/v1/routes';
import type { ConfigurationService, UserService } from '../domain/account-service';

export function accountTools(users: UserService, configs: ConfigurationService) {
  return [
    tool('me', {
      description: "The caller's profile",
      policy: 'registered',
      input: z.object({}),
      handler: async ({ principal }) => toUserRes(await users.get(Owner.user(principal.sub), principal.sub)),
    }),
    tool('getConfiguration', {
      description: "A user's configuration (timezone, default charity)",
      policy: 'registered',
      subject: 'userId',
      input: z.object({ userId: z.string() }),
      handler: async ({ principal, input }) =>
        toConfigRes(
          await configs.getForUser(
            principal.isAdmin ? Owner.anyone(principal) : Owner.user(input.userId),
            input.userId,
          ),
        ),
    }),
  ];
}
