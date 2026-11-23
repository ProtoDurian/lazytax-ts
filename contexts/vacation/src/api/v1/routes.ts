// LazyTax App/Modules/Vacation/API/V1/VacationController.cs, under /api/v1/Vacation.
import { type Guard, guard, notFound, Owner, type Principal, route, z } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import { isDate } from '../../domain/rules';
import { toDto, type VacationService } from '../../domain/vacation-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = z.string().refine(isDate, 'must be a date YYYY-MM-DD');
const timezone = z
  .string()
  .min(1)
  .refine(tz => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA timezone');

export const CreateVacationReq = z.object({ startDate: date, endDate: date, timezone });
export const SearchVacationQuery = z.object({
  year: z.coerce.number().int().min(1900).max(3000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

// Layer 5, step 1: a cheap plan read. A plan with no vacation windows stops here, before any lock.
export const vacationAllowed = (plan: PlanV1): Guard =>
  guard('plan:vacationWindows', async ({ userId }) => {
    plan.ensureWithin(await plan.quota(userId, 'vacationWindows'), 0);
  });

export const ownerFor = (p: Principal, userId: string) => (p.isAdmin ? Owner.anyone(p) : Owner.user(userId));
const uuidOr404 = (id: string) => {
  if (!UUID.test(id)) throw notFound('Vacation', id);
  return id;
};

export function vacationRoutes(svc: VacationService, allowed: Guard) {
  return [
    route.post('/:userId', {
      policy: 'registered',
      subject: 'userId',
      guards: [allowed],
      body: CreateVacationReq,
      handler: async ({ principal, params, body }) =>
        toDto(await svc.create(ownerFor(principal, params.userId), params.userId, body)),
    }),
    route.get('/:userId', {
      policy: 'registered',
      subject: 'userId',
      query: SearchVacationQuery,
      handler: async ({ principal, params, query }) =>
        (await svc.search(ownerFor(principal, params.userId), params.userId, query)).map(toDto),
    }),
    route.delete('/:userId/:id', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ principal, params }) => {
        await svc.delete(ownerFor(principal, params.userId), params.userId, uuidOr404(params.id));
      },
    }),
    route.patch('/:userId/:id/end-today', {
      policy: 'registered',
      subject: 'userId',
      handler: async ({ principal, params }) =>
        toDto(await svc.endToday(ownerFor(principal, params.userId), params.userId, uuidOr404(params.id))),
    }),
  ];
}
