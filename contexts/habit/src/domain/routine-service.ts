// Routines (LazyTax RoutineService + RoutineRepository.Delete). Deleting a routine soft deletes
// every live habit in it, in the same unit of work.
import type { Clock, Outbox, UnitOfWork } from '@lazytax/kernel';
import { Owner } from '@lazytax/kernel';
import type { HabitRepository } from '../data/habit-repository';
import type { RoutineRepository } from '../data/routine-repository';
import type { Routine, RoutineSearch } from './model';

export class RoutineService {
  constructor(
    private readonly routines: RoutineRepository,
    private readonly habits: HabitRepository,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  get(owner: Owner, id: string): Promise<Routine | null> {
    return this.routines.get(owner, id);
  }

  search(owner: Owner, search: RoutineSearch): Promise<Routine[]> {
    return this.routines.search(owner, search);
  }

  create(userId: string, name: string): Promise<Routine> {
    return this.routines.create(Owner.user(userId), name);
  }

  // null when it is not the owner's live routine (404).
  rename(owner: Owner, id: string, name: string): Promise<Routine | null> {
    return this.routines.rename(owner, id, name);
  }

  // false when it is not the owner's live routine (404).
  async delete(owner: Owner, id: string): Promise<boolean> {
    return this.uow.run(async () => {
      const routine = await this.routines.get(owner, id);
      if (routine === null) return false;
      const now = this.clock.now();
      if (!(await this.routines.delete(owner, id, now))) return false;
      const habitIds = await this.habits.deleteHabitsOfRoutine(Owner.user(routine.userId), id, now);
      if (habitIds.length > 0) {
        const payload = { userId: routine.userId, habitIds };
        await this.outbox.add({ type: 'habit.changed', payload, userId: routine.userId });
        await this.outbox.add({ type: 'habit.deleted', payload, userId: routine.userId });
      }
      return true;
    });
  }
}
