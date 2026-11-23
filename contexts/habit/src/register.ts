import '@lazytax/habit-contract/v1';
import { defineContext, guard, z } from '@lazytax/kernel';
import { habitRoutes } from './api/v1/habit-routes';
import { routineRoutes } from './api/v1/routine-routes';
import { HabitRepository } from './data/habit-repository';
import { RoutineRepository } from './data/routine-repository';
import { HabitService } from './domain/habit-service';
import { RoutineService } from './domain/routine-service';
import { habitTools } from './mcp/habit-tools';

export default defineContext({
  // LazyTax HabitOption.MaxStakeCents. Override with env LAZYTAX_HABIT_CONFIG='{"maxStakeCents":50000}'.
  config: z.object({ maxStakeCents: z.number().int().min(0).default(1_000_000) }),
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, config, clock }) => {
    const plan = deps.get('plan.v1');
    const habitRepo = new HabitRepository(uow);
    const habits = new HabitService(habitRepo, plan, deps.get('charity.v1'), uow, outbox, clock);
    const routines = new RoutineService(new RoutineRepository(uow), habitRepo, uow, outbox, clock);
    // Layer 5, step 1: a plan with 0 habits refuses before any lock. The count itself runs under the lock.
    const habitsAllowed = guard('plan:habits', async ({ userId }) => {
      plan.ensureWithin(await plan.quota(userId, 'habits'), 0);
    });
    return {
      provides: { 'habit.v1': habits },
      http: [...habitRoutes(habits, habitsAllowed, config.maxStakeCents), ...routineRoutes(routines)],
      mcp: habitTools(habits, routines, habitsAllowed, config.maxStakeCents),
      users: { purgeUser: userId => habitRepo.purgeUser(userId) },
      subscribers: [],
      workers: [],
    };
  },
});
