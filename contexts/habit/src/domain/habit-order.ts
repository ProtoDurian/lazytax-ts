// The user's new habit order: the requested ids first, in the given order, then the ones not
// requested in their current order. Every requested id must be one of the user's live habits,
// at most once (LazyTax Domain/Habit/HabitOrder.cs).
import { validationFailed } from '@lazytax/kernel';

const ORDER_FIELD = 'habitIds';

export function mergeOrder(current: readonly string[], requested: readonly string[]): string[] {
  const currentSet = new Set(current);
  const requestedSet = new Set<string>();
  for (const id of requested) {
    if (requestedSet.has(id)) throw invalid(`Habit ${id} is listed more than once`);
    // Another user's, a deleted and an unknown habit get the same answer.
    if (!currentSet.has(id)) throw invalid(`Habit ${id} is not one of your habits`);
    requestedSet.add(id);
  }
  return [...requested, ...current.filter(id => !requestedSet.has(id))];
}

const invalid = (message: string) => validationFailed(message, { [ORDER_FIELD]: [message] });
