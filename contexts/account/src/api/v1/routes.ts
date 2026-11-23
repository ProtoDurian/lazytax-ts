// LazyTax App/Modules/Users/API/V1/UserController.cs and
// App/Modules/Configurations/API/V1/ConfigurationController.cs, under the http prefix /api/v1.
import { notFound, Owner, type Principal, route, unauthenticated, z } from '@lazytax/kernel';
import type { ConfigurationService, UserService } from '../../domain/account-service';
import type { ConfigurationPrincipal, UserPrincipal, UserRecord } from '../../domain/model';
import { isTimezone, isUuid } from '../../domain/time';

const optBool = z
  .enum(['true', 'false'])
  .transform(v => v === 'true')
  .optional();

const SearchUserQuery = z.object({
  id: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  emailVerified: optBool,
  active: optBool,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).default(0),
});

// Kept for API compatibility with LazyTax; the profile comes from the verified bearer token.
const TokenReq = z.object({ idToken: z.string().optional(), accessToken: z.string().optional() }).optional();

const timezone = z
  .string()
  .max(64, 'Timezone must be between 1 and 64 characters')
  .refine(isTimezone, 'Timezone must be a valid IANA timezone');
const charityId = z
  .string()
  .nullish()
  .refine(v => v === undefined || v === null || v === '' || isUuid(v), 'DefaultCharityId must be a valid GUID')
  .transform(v => (v ? v : null));
const ConfigurationReq = z.object({ timezone, defaultCharityId: charityId });

export const toUserRes = (u: UserPrincipal) => ({
  id: u.id,
  username: u.record.username,
  email: u.record.email,
  emailVerified: u.record.emailVerified,
  active: u.record.active,
});

export const toConfigRes = (c: ConfigurationPrincipal) => ({
  id: c.id,
  userId: c.userId,
  timezone: c.record.timezone,
  defaultCharityId: c.record.defaultCharityId,
});

// LazyTax UserMapper.ToRecord over the token's claims.
function recordFromToken(p: Principal): UserRecord {
  const c = p.claims ?? {};
  const username = typeof c.username === 'string' ? c.username : '';
  const email = typeof c.email === 'string' ? c.email : '';
  const emailVerified = c.email_verified === true;
  return {
    username,
    email,
    emailVerified,
    scopes: [...p.scopes],
    active: emailVerified && username.length > 0 && email.length > 0,
  };
}

// Admins read any user's rows; everyone else only the user named in the path.
const ownerFor = (p: Principal, userId: string) => (p.isAdmin ? Owner.anyone(p) : Owner.user(userId));
const uuidOr404 = (id: string, entity: string) => {
  if (!isUuid(id)) throw notFound(entity, id);
  return id;
};

export function userRoutes(users: UserService) {
  return [
    route.get('/User', {
      policy: 'admin',
      query: SearchUserQuery,
      handler: async ({ principal, query }) => (await users.search(Owner.anyone(principal), query)).map(toUserRes),
    }),
    route.get('/User/Me', {
      policy: 'registered',
      handler: ({ principal }) => new Response(principal.sub || 'none', { headers: { 'content-type': 'text/plain' } }),
    }),
    route.get('/User/Me/All', {
      policy: 'registered',
      handler: async ({ principal }) => ({
        principal: toUserRes(await users.get(Owner.user(principal.sub), principal.sub)),
      }),
    }),
    route.get('/User/username/:username', {
      policy: 'registered',
      // LazyTax answered 403 for someone else's username; layer 4 says 404, so nothing leaks.
      handler: async ({ principal, params }) => {
        const u = await users.getByUsername(Owner.system(), params.username);
        if (u.id !== principal.sub && !principal.isAdmin) throw notFound('User', params.username);
        return { principal: toUserRes(u) };
      },
    }),
    route.get('/User/:id', {
      policy: 'registered',
      subject: 'id',
      handler: async ({ principal, params }) => ({
        principal: toUserRes(await users.get(ownerFor(principal, params.id), params.id)),
      }),
    }),
    route.post('/User', {
      policy: 'registered',
      body: TokenReq,
      handler: async ({ principal }) => {
        if (!principal.sub) throw unauthenticated();
        return toUserRes(await users.create(Owner.user(principal.sub), principal.sub, recordFromToken(principal)));
      },
    }),
    route.put('/User/:id', {
      policy: 'registered',
      subject: 'id',
      body: TokenReq,
      handler: async ({ principal, params }) =>
        toUserRes(await users.update(ownerFor(principal, params.id), params.id, recordFromToken(principal))),
    }),
    route.delete('/User/Me', {
      policy: 'registered',
      handler: async ({ principal }) => {
        await users.deleteAccount(principal.sub);
      },
    }),
    route.delete('/User/:id', {
      policy: 'admin',
      handler: async ({ principal, params }) => {
        await users.deleteByAdmin(Owner.anyone(principal), params.id);
      },
    }),
  ];
}

export function configurationRoutes(configs: ConfigurationService) {
  const res = async (c: ConfigurationPrincipal) => ({ principal: toConfigRes(c), charity: null });
  return [
    route.get('/Configuration/me', {
      policy: 'registered',
      handler: async ({ principal }) => res(await configs.getForUser(Owner.user(principal.sub), principal.sub)),
    }),
    route.get('/Configuration/:userId/:id', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ principal, params }) =>
        res(await configs.get(ownerFor(principal, params.userId), uuidOr404(params.id, 'Configuration'))),
    }),
    route.get('/Configuration/:id', {
      policy: 'registered',
      handler: async ({ principal, params }) =>
        res(await configs.get(ownerFor(principal, principal.sub), uuidOr404(params.id, 'Configuration'))),
    }),
    route.post('/Configuration/:userId', {
      policy: 'registered',
      subject: 'userId',
      body: ConfigurationReq,
      handler: async ({ params, body }) =>
        toConfigRes(await configs.create(Owner.user(params.userId), params.userId, body)),
    }),
    route.post('/Configuration', {
      policy: 'registered',
      body: ConfigurationReq,
      handler: async ({ principal, body }) =>
        toConfigRes(await configs.create(Owner.user(principal.sub), principal.sub, body)),
    }),
    route.put('/Configuration/:userId/:id', {
      policy: 'registered',
      subject: 'userId',
      body: ConfigurationReq,
      handler: async ({ principal, params, body }) => ({
        ...toConfigRes(
          await configs.update(ownerFor(principal, params.userId), uuidOr404(params.id, 'Configuration'), body),
        ),
        settledChecks: [],
      }),
    }),
    route.put('/Configuration/:id', {
      policy: 'registered',
      body: ConfigurationReq,
      handler: async ({ principal, params, body }) => ({
        ...toConfigRes(await configs.update(Owner.user(principal.sub), uuidOr404(params.id, 'Configuration'), body)),
        settledChecks: [],
      }),
    }),
  ];
}
