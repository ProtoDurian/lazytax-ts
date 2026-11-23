// The check routes under /api/v1: complete, skip, executions and overview at LazyTax's
// /Habit/{userId}/... paths (habit owns the rest of /Habit), and the admin tick at /habit-cron.
// Layers 1 to 3 are data on each route; layer 4 is the repository; layer 5 the guard and service.
import { type Guard, Owner, route } from '@lazytax/kernel';
import type { CheckService } from '../../domain/check-service';
import type { OverviewService } from '../../domain/overview';
import { executionQuery, executionRes, notesReq, overviewQuery } from './schemas';

// Hono regex param: only a GUID matches, as LazyTax's {habitVersionId:guid}.
const ID = '{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}}';
const completePath = `/Habit/:userId/:habitVersionId${ID}/executions` as '/Habit/:userId/:habitVersionId/executions';
const skipPath =
  `/Habit/:userId/:habitVersionId${ID}/executions/skip` as '/Habit/:userId/:habitVersionId/executions/skip';

export const checkRoutes = (svc: CheckService, overview: OverviewService, skipsAllowed: Guard, now: () => Date) => [
  route.post(completePath, {
    policy: 'registered',
    subject: 'userId',
    body: notesReq,
    handler: async ({ params, body }) =>
      executionRes(
        await svc.complete(Owner.user(params.userId), params.habitVersionId.toLowerCase(), body.notes ?? null),
      ),
  }),
  route.post(skipPath, {
    policy: 'registered',
    subject: 'userId',
    guards: [skipsAllowed],
    body: notesReq,
    handler: async ({ params, body }) =>
      executionRes(await svc.skip(Owner.user(params.userId), params.habitVersionId.toLowerCase(), body.notes ?? null)),
  }),
  route.get('/Habit/:userId/executions', {
    policy: 'registered',
    subject: 'userId',
    query: executionQuery,
    handler: async ({ params, query }) =>
      (
        await svc.searchExecutions(Owner.user(params.userId), {
          habitId: query.id?.toLowerCase(),
          date: query.date,
          limit: query.limit ?? 20,
          skip: query.skip ?? 0,
        })
      ).map(executionRes),
  }),
  route.get('/Habit/:userId/overview', {
    policy: 'registered',
    subject: 'userId',
    query: overviewQuery,
    handler: ({ params, query }) => overview.get(Owner.user(params.userId), query.limit ?? 20, query.skip ?? 0),
  }),
  // Admin-only manual trigger for one scheduler tick: opens upcoming checks and settles checks
  // past their deadline (vacation, freeze, then missed).
  route.post('/habit-cron/mark-daily-failures', {
    policy: 'admin',
    handler: async () => ({ totalMarked: await svc.tick(now()) }),
  }),
];
