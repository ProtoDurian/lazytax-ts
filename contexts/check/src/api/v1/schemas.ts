// Request schemas and response shapes, as LazyTax's HabitModel.cs / HabitValidator.cs.
import { z } from '@lazytax/kernel';
import type { ExecutionRow } from '../../domain/model';
import { dayStatus } from '../../domain/streak';
import { fromStandardDate, toStandardDate } from '../../domain/window';

// CompleteHabitReq / SkipHabitReq.
export const notesReq = z.object({ notes: z.string().max(4096).nullish() });

const limit = z.coerce.number().int().min(0, 'Limit has to be between 0 to 100').max(100).optional();
const skip = z.coerce.number().int().min(0, 'Skip has to be larger than or equal to 0').optional();

// SearchHabitExecutionQuery: date is "dd-MM-yyyy".
export const executionQuery = z.object({
  id: z.uuid().optional(),
  date: z
    .string()
    .optional()
    .transform((d, ctx) => {
      if (d === undefined) return undefined;
      const iso = fromStandardDate(d);
      if (iso === null) {
        ctx.addIssue({ code: 'custom', message: 'DateOnly must be in the format of dd-MM-yyyy' });
        return z.NEVER;
      }
      return iso;
    }),
  limit,
  skip,
});

export const overviewQuery = z.object({ limit, skip });

// HabitExecutionRes.
export const executionRes = (e: ExecutionRow) => ({
  id: e.id,
  habitVersionId: e.habitVersionId,
  date: toStandardDate(e.date),
  status: dayStatus(e.status),
  completedAt: e.completedAt?.toISOString() ?? null,
  notes: e.notes,
  paymentProcessed: e.paymentProcessed,
});
