// MCP tools: the same policy, subject, guards and service methods as the routes.
import { type Guard, notFound, Owner, tool, z } from '@lazytax/kernel';
import type { HabitService } from '../domain/habit-service';
import type { RoutineService } from '../domain/routine-service';
import { guid, routineRes, toVersionInput, versionRes } from '../api/v1/schemas';
import { createHabitReq, updateHabitReq } from '../api/v1/schemas';

const user = { userId: z.string() };

export const habitTools = (
  habits: HabitService,
  routines: RoutineService,
  quotaGuard: Guard,
  maxStakeCents: number,
) => {
  const createShape = createHabitReq(maxStakeCents);
  const updateShape = updateHabitReq(maxStakeCents);
  return [
    tool('list', {
      description:
        "List a user's habits (current versions) in their order. Optional filters: task text, enabled, limit (max 100), skip",
      policy: 'registered',
      subject: 'userId',
      input: z.object({
        ...user,
        task: z.string().max(256).optional(),
        enabled: z.boolean().optional(),
        limit: z.number().int().min(0).max(100).optional(),
        skip: z.number().int().min(0).optional(),
      }),
      handler: async ({ input }) =>
        (
          await habits.search(Owner.user(input.userId), {
            task: input.task,
            enabled: input.enabled,
            limit: input.limit ?? 20,
            skip: input.skip ?? 0,
          })
        ).map(versionRes),
    }),
    tool('get', {
      description: 'Get the current version of one habit by habit id',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, habitId: guid }),
      handler: async ({ input }) => {
        const found = await habits.getCurrent(Owner.user(input.userId), input.habitId);
        if (found === null) throw notFound('Habit', input.habitId);
        return versionRes(found);
      },
    }),
    tool('create', {
      description:
        'Create a habit. daysOfWeek are weekday names; times are HH:mm:ss; stake is a decimal string such as "10.50" and needs a charityId when above 0',
      policy: 'registered',
      subject: 'userId',
      guards: [quotaGuard],
      input: z.object({ ...user, habit: createShape }),
      handler: async ({ input }) =>
        versionRes(await habits.create(input.userId, toVersionInput(input.habit), input.habit.routineId ?? null)),
    }),
    tool('update', {
      description: 'Replace a habit with a new version; enabled switches it on or off',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, habitId: guid, habit: updateShape }),
      handler: async ({ input }) => {
        const updated = await habits.update(
          Owner.user(input.userId),
          input.habitId,
          toVersionInput(input.habit),
          input.habit.enabled,
        );
        if (updated === null) throw notFound('Habit', input.habitId);
        return versionRes(updated);
      },
    }),
    tool('delete', {
      description: 'Delete a habit',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, habitId: guid }),
      handler: async ({ input }) => {
        if (!(await habits.delete(Owner.user(input.userId), input.habitId))) throw notFound('Habit', input.habitId);
        return { deleted: true };
      },
    }),
    tool('reorder', {
      description: "Move the listed habits to the top in the given order; returns the user's full habit order",
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, habitIds: z.array(guid) }),
      handler: async ({ input }) => ({ habitIds: await habits.reorder(Owner.user(input.userId), input.habitIds) }),
    }),
    tool('listRoutines', {
      description: "List a user's routines",
      policy: 'registered',
      subject: 'userId',
      input: z.object({
        ...user,
        name: z.string().optional(),
        limit: z.number().int().min(0).max(100).optional(),
        skip: z.number().int().min(0).optional(),
      }),
      handler: async ({ input }) =>
        (
          await routines.search(Owner.user(input.userId), {
            name: input.name,
            limit: input.limit ?? 20,
            skip: input.skip ?? 0,
          })
        ).map(routineRes),
    }),
    tool('createRoutine', {
      description: 'Create a routine, a named group of habits',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, name: z.string().min(1).max(256) }),
      handler: async ({ input }) => routineRes(await routines.create(input.userId, input.name)),
    }),
    tool('renameRoutine', {
      description: 'Rename a routine',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, routineId: guid, name: z.string().min(1).max(256) }),
      handler: async ({ input }) => {
        const updated = await routines.rename(Owner.user(input.userId), input.routineId, input.name);
        if (updated === null) throw notFound('Routine', input.routineId);
        return routineRes(updated);
      },
    }),
    tool('deleteRoutine', {
      description: 'Delete a routine and every habit in it',
      policy: 'registered',
      subject: 'userId',
      input: z.object({ ...user, routineId: guid }),
      handler: async ({ input }) => {
        if (!(await routines.delete(Owner.user(input.userId), input.routineId)))
          throw notFound('Routine', input.routineId);
        return { deleted: true };
      },
    }),
  ];
};
