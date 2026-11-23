// Pins the frozen kernel surface: if this file stops type-checking, the surface changed.
import { describe, expect, it } from 'bun:test';
import '@lazytax/account-contract/v1';
import '@lazytax/plan-contract/v1';
import '@lazytax/vacation-contract/v1';
import {
  defineContext,
  guard,
  notFound,
  Owner,
  Problem,
  route,
  subscribe,
  tool,
  z,
  type ContextParts,
  type Principal,
} from '@lazytax/kernel';

const admin: Principal = { sub: 'adm', authenticated: true, scopes: ['admin'], roles: [], isAdmin: true };
const user: Principal = { sub: 'u1', authenticated: true, scopes: [], roles: [], isAdmin: false };

describe('kernel surface', () => {
  it('should type a whole context with deps, routes, tools, hooks, subscribers and workers', () => {
    // Arrange
    const def = defineContext({
      config: z.object({ limit: z.number().default(3) }),
      migrations: 'src/data/migrations',
      build: ({ deps, uow, outbox, config }): ContextParts => {
        const plan = deps.get('plan.v1');
        const account = deps.get('account.v1');
        const allowed = guard('plan:vacationWindows', async ({ userId }) => {
          const q = await plan.quota(userId, 'vacationWindows');
          if (q.limit <= 0) throw new Problem({ kind: 'validation', id: 'tier_insufficient', title: 't', detail: 'd' });
        });
        return {
          provides: {
            'vacation.v1': { isAway: async () => false, listActive: async () => [] },
          },
          http: [
            route.post('/:userId/:id/end-today', {
              policy: 'registered',
              subject: 'userId',
              guards: [allowed],
              body: z.object({ note: z.string() }),
              handler: async ({ params, body }) => {
                const owner = Owner.user(params.userId);
                await uow.run(async () => {
                  await uow.lockUser(params.userId);
                  await outbox.add({
                    type: 'vacation.created',
                    payload: { userId: params.userId, vacationId: params.id },
                  });
                });
                return {
                  owner: owner.kind,
                  note: body.note,
                  limit: config.limit,
                  tz: await account.getTimezone(params.userId),
                };
              },
            }),
          ],
          mcp: [
            tool('endToday', {
              description: 'End a vacation today',
              policy: 'registered',
              subject: 'userId',
              input: z.object({ userId: z.string(), id: z.string() }),
              handler: async ({ input }) => input.id,
            }),
          ],
          users: { purgeUser: async () => undefined, deleteGuard: async () => undefined },
          subscribers: [subscribe('account.userDeleted', async e => void e.payload.userId)],
          workers: [{ name: 'sweep', everyMs: 60_000, tick: async () => undefined }],
        };
      },
    });

    // Act
    const kind = def.kind;

    // Assert
    expect(kind).toBe('lazytax.context');
  });

  it('should refuse Owner.anyone for a non-admin principal', () => {
    // Arrange
    const call = () => Owner.anyone(user);

    // Act + Assert
    expect(call).toThrow(Problem);
    expect(Owner.anyone(admin).kind).toBe('anyone');
  });

  it('should map a not-found problem to 404', () => {
    // Arrange
    const p = notFound('Vacation', 'x');

    // Act
    const status = p.status;

    // Assert
    expect(status).toBe(404);
  });
});
