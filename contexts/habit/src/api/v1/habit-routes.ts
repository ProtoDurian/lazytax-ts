// /api/v1/Habit: habits CRUD, search and order. check owns complete, skip, executions and overview
// under the same prefix. Layers 1 to 3 are data on each route; layer 4 is the repository.
import { type Guard, notFound, Owner, route } from '@lazytax/kernel';
import type { HabitService } from '../../domain/habit-service';
import {
  type CreateHabitReq,
  createHabitReq,
  reorderHabitsReq,
  searchHabitQuery,
  toVersionInput,
  type UpdateHabitReq,
  updateHabitReq,
  versionRes,
} from './schemas';

// Hono regex param: only a GUID matches, so "/Habit/{userId}/executions" and ".../overview" (check's
// routes) never reach the habit id routes, as LazyTax's {id:guid} constraint.
const ID = '{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}}';
const habitIdPath = `/Habit/:userId/:id${ID}` as '/Habit/:userId/:id';

export const habitRoutes = (svc: HabitService, quotaGuard: Guard, maxStakeCents: number) => [
  route.get('/Habit/:userId', {
    policy: 'registered',
    subject: 'userId',
    query: searchHabitQuery,
    handler: async ({ params, query }) => {
      const habits = await svc.search(Owner.user(params.userId), {
        id: query.id,
        task: query.task,
        enabled: query.enabled,
        limit: query.limit ?? 20,
        skip: query.skip ?? 0,
      });
      return habits.map(versionRes);
    },
  }),
  route.post('/Habit/:userId', {
    policy: 'registered',
    subject: 'userId',
    guards: [quotaGuard],
    body: createHabitReq(maxStakeCents),
    handler: async ({ params, body }) => {
      const req = body as CreateHabitReq;
      return versionRes(await svc.create(params.userId, toVersionInput(req), req.routineId ?? null));
    },
  }),
  route.put('/Habit/:userId/order', {
    policy: 'registered',
    subject: 'userId',
    body: reorderHabitsReq,
    handler: async ({ params, body }) => ({ habitIds: await svc.reorder(Owner.user(params.userId), body.habitIds) }),
  }),
  route.get(habitIdPath, {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const id = params.id.toLowerCase();
      const found = await svc.getCurrent(Owner.user(params.userId), id);
      if (found === null) throw notFound('Habit', id);
      return versionRes(found);
    },
  }),
  route.put(habitIdPath, {
    policy: 'registered',
    subject: 'userId',
    body: updateHabitReq(maxStakeCents),
    handler: async ({ params, body }) => {
      const req = body as UpdateHabitReq;
      const id = params.id.toLowerCase();
      const updated = await svc.update(Owner.user(params.userId), id, toVersionInput(req), req.enabled);
      if (updated === null) throw notFound('Habit', id);
      return versionRes(updated);
    },
  }),
  route.delete(habitIdPath, {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const id = params.id.toLowerCase();
      if (!(await svc.delete(Owner.user(params.userId), id))) throw notFound('Habit', id);
    },
  }),
];
