// vacation's MCP tools: same policy, subject, guards and service methods as the routes.
import { type Guard, tool, z } from '@lazytax/kernel';
import { CreateVacationReq, ownerFor, SearchVacationQuery } from '../api/v1/routes';
import { toDto, type VacationService } from '../domain/vacation-service';

export function vacationTools(svc: VacationService, allowed: Guard) {
  return [
    tool('list', {
      description: "List a user's vacation windows, newest first",
      policy: 'registered',
      subject: 'userId',
      input: SearchVacationQuery.extend({ userId: z.string() }),
      handler: async ({ principal, input }) =>
        (await svc.search(ownerFor(principal, input.userId), input.userId, input)).map(toDto),
    }),
    tool('create', {
      description: "Create a vacation window (dates are the user's local dates, inclusive)",
      policy: 'registered',
      subject: 'userId',
      guards: [allowed],
      input: CreateVacationReq.extend({ userId: z.string() }),
      handler: async ({ principal, input }) => {
        const { userId, ...rec } = input;
        return toDto(await svc.create(ownerFor(principal, userId), userId, rec));
      },
    }),
    tool('endToday', {
      description: 'End a started vacation today',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ userId: z.string(), id: z.uuid() }),
      handler: async ({ principal, input }) =>
        toDto(await svc.endToday(ownerFor(principal, input.userId), input.userId, input.id)),
    }),
  ];
}
