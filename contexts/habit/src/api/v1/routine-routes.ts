// /api/v1/Routine (LazyTax RoutineController). A routine groups habits; deleting one soft deletes
// its habits too.
import { notFound, Owner, route } from '@lazytax/kernel';
import type { RoutineService } from '../../domain/routine-service';
import { createRoutineReq, routineRes, searchRoutineQuery } from './schemas';

const ID = '{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}}';
const routineIdPath = `/Routine/:userId/:id${ID}` as '/Routine/:userId/:id';

export const routineRoutes = (svc: RoutineService) => [
  route.get('/Routine/:userId', {
    policy: 'registered',
    subject: 'userId',
    query: searchRoutineQuery,
    handler: async ({ params, query }) => {
      const routines = await svc.search(Owner.user(params.userId), {
        name: query.name,
        limit: query.limit ?? 20,
        skip: query.skip ?? 0,
      });
      return routines.map(routineRes);
    },
  }),
  route.get(routineIdPath, {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const id = params.id.toLowerCase();
      const found = await svc.get(Owner.user(params.userId), id);
      if (found === null) throw notFound('Routine', id);
      return routineRes(found);
    },
  }),
  route.post('/Routine/:userId', {
    policy: 'registered',
    subject: 'userId',
    body: createRoutineReq,
    handler: async ({ params, body }) => routineRes(await svc.create(params.userId, body.name)),
  }),
  route.put(routineIdPath, {
    policy: 'registered',
    subject: 'userId',
    body: createRoutineReq,
    handler: async ({ params, body }) => {
      const id = params.id.toLowerCase();
      const updated = await svc.rename(Owner.user(params.userId), id, body.name);
      if (updated === null) throw notFound('Routine', id);
      return routineRes(updated);
    },
  }),
  route.delete(routineIdPath, {
    policy: 'registered',
    subject: 'userId',
    handler: async ({ params }) => {
      const id = params.id.toLowerCase();
      if (!(await svc.delete(Owner.user(params.userId), id))) throw notFound('Routine', id);
    },
  }),
];
