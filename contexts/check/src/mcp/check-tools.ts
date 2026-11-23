// MCP tools: the same policy, subject, guards and service methods as the routes.
import { type Guard, Owner, tool, z } from '@lazytax/kernel';
import { executionQuery, executionRes, overviewQuery } from '../api/v1/schemas';
import type { CheckService } from '../domain/check-service';
import type { OverviewService } from '../domain/overview';

const versionInput = z.object({
  userId: z.string(),
  habitVersionId: z.uuid(),
  notes: z.string().max(4096).nullish(),
});

export const checkTools = (svc: CheckService, overview: OverviewService, skipsAllowed: Guard, now: () => Date) => [
  tool('complete', {
    description: "Complete today's check of a habit (by habit version id) for a user",
    policy: 'registered',
    subject: 'userId',
    input: versionInput,
    handler: async ({ input }) =>
      executionRes(
        await svc.complete(Owner.user(input.userId), input.habitVersionId.toLowerCase(), input.notes ?? null),
      ),
  }),
  tool('skip', {
    description: "Skip today's check of a habit (by habit version id), within the user's monthly skips",
    policy: 'registered',
    subject: 'userId',
    guards: [skipsAllowed],
    input: versionInput,
    handler: async ({ input }) =>
      executionRes(await svc.skip(Owner.user(input.userId), input.habitVersionId.toLowerCase(), input.notes ?? null)),
  }),
  tool('executions', {
    description: "Search a user's habit executions (filter by habit id and dd-MM-yyyy date)",
    policy: 'registered',
    subject: 'userId',
    input: executionQuery.extend({ userId: z.string() }),
    handler: async ({ input }) =>
      (
        await svc.searchExecutions(Owner.user(input.userId), {
          habitId: input.id?.toLowerCase(),
          date: input.date,
          limit: input.limit ?? 20,
          skip: input.skip ?? 0,
        })
      ).map(executionRes),
  }),
  tool('overview', {
    description: "A user's habits with streaks, this week's days, today's deadline, debt and skips used",
    policy: 'registered',
    subject: 'userId',
    input: overviewQuery.extend({ userId: z.string() }),
    handler: ({ input }) => overview.get(Owner.user(input.userId), input.limit ?? 20, input.skip ?? 0),
  }),
  tool('tick', {
    description: 'Admin: run one scheduler tick (open upcoming checks, settle overdue ones)',
    policy: 'admin',
    input: z.object({}),
    handler: async () => ({ totalMarked: await svc.tick(now()) }),
  }),
];
