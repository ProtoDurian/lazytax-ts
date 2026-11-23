// Request schemas and response mapping for the habit and routine routes. A bad body or query is a
// 400 validation_error from the kernel.
import type { HabitVersionDto } from '@lazytax/habit-contract/v1';
import { z } from '@lazytax/kernel';
import { DEFAULT_STAKE_CURRENCY, FULL_RATIO_BPS, type VersionInput } from '../../domain/model';
import {
  canonicalDay,
  deadlineOrDefault,
  formatMoney,
  formatRatio,
  hasMoneyStake,
  isTime,
  isTimezone,
  parseStakeCents,
} from '../../domain/rules';

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

export const guid = z
  .string()
  .regex(GUID, 'Must be a GUID')
  .transform(s => s.toLowerCase());
const time = z.string().refine(isTime, 'TimeOnly must be in the format of HH:mm:ss');

// The fields a create and an update share. `maxStakeCents` comes from the context's config.
const versionFields = (maxStakeCents: number) => ({
  task: z.string().min(1, 'Task must not be empty').max(256),
  daysOfWeek: z
    .array(z.string())
    .min(1, 'DaysOfWeek must not be empty')
    .refine(
      days => days.every(d => canonicalDay(d) !== null),
      'DaysOfWeek must contain valid day names (e.g., Monday, Tuesday).',
    ),
  notificationTime: time,
  stake: z
    .string()
    .min(1, 'Stake must not be empty')
    .superRefine((s, ctx) => {
      const cents = parseStakeCents(s);
      if (cents === null)
        ctx.addIssue({
          code: 'custom',
          message: 'Stake must be a non-negative decimal with at most 2 decimal places.',
        });
      else if (cents > maxStakeCents)
        ctx.addIssue({ code: 'custom', message: `Stake must be at most ${formatMoney(maxStakeCents)}.` });
    }),
  // Needed only when stake > 0; null, absent or the empty guid: no charity.
  charityId: z.union([guid, z.null()]).optional(),
  timezone: z
    .string()
    .refine(isTimezone, "Timezone must be a valid timezone identifier (e.g. 'Asia/Singapore', 'America/New_York')"),
  // The day's check deadline; defaults to 23:59:00.
  deadlineTime: time.nullish(),
});

type Fields = z.output<z.ZodObject<ReturnType<typeof versionFields>>>;

const needsCharity = (v: Fields, ctx: z.RefinementCtx) => {
  if (hasMoneyStake(v.stake) && (v.charityId == null || v.charityId === EMPTY_GUID))
    ctx.addIssue({ code: 'custom', path: ['charityId'], message: 'A habit with a stake needs a charity.' });
};

export const createHabitReq = (maxStakeCents: number) =>
  z
    .object({ ...versionFields(maxStakeCents), routineId: z.union([guid, z.null()]).optional() })
    .superRefine(needsCharity);

export const updateHabitReq = (maxStakeCents: number) =>
  z.object({ ...versionFields(maxStakeCents), enabled: z.boolean() }).superRefine(needsCharity);

export type CreateHabitReq = z.output<ReturnType<typeof createHabitReq>>;
export type UpdateHabitReq = z.output<ReturnType<typeof updateHabitReq>>;

// A validated request as the version it writes. Ratio is fixed at 100%: all the stake goes to the
// charity (LazyTax). Currency is USD.
export function toVersionInput(req: Fields): VersionInput {
  const days = [...new Set(req.daysOfWeek.map(d => canonicalDay(d) as string))];
  return {
    task: req.task,
    daysOfWeek: days,
    notificationTime: req.notificationTime,
    deadlineTime: deadlineOrDefault(req.deadlineTime),
    stakeCents: parseStakeCents(req.stake) as number,
    currency: DEFAULT_STAKE_CURRENCY,
    ratioBps: FULL_RATIO_BPS,
    charityId: req.charityId == null || req.charityId === EMPTY_GUID ? null : req.charityId,
    timezone: req.timezone,
  };
}

export const reorderHabitsReq = z.object({ habitIds: z.array(guid) });

const intParam = (min: number, max: number, what: string) =>
  z
    .string()
    .regex(/^\d+$/, `${what} must be a number`)
    .transform(Number)
    .refine(n => n >= min && n <= max, `${what} has to be between ${min} and ${max}`);

const limit = intParam(0, 100, 'Limit');
const skip = intParam(0, Number.MAX_SAFE_INTEGER, 'Skip');

export const searchHabitQuery = z.object({
  id: guid.optional(),
  // Accepted for compatibility; the path's userId always wins.
  userId: z.string().max(128).optional(),
  task: z.string().max(256).optional(),
  enabled: z
    .enum(['true', 'false'])
    .transform(v => v === 'true')
    .optional(),
  limit: limit.optional(),
  skip: skip.optional(),
});

export const createRoutineReq = z.object({ name: z.string().min(1, 'Name must not be empty').max(256) });

export const searchRoutineQuery = z.object({
  name: z.string().optional(),
  limit: limit.optional(),
  skip: skip.optional(),
});

// ── responses ──────────────────────────────────────────────────────────────────────────────────

export const versionRes = (v: HabitVersionDto) => ({
  id: v.id,
  habitId: v.habitId,
  version: v.version,
  task: v.task,
  daysOfWeek: v.daysOfWeek,
  notificationTime: v.notificationTime,
  stake: formatMoney(v.stakeCents),
  ratio: formatRatio(v.ratioBps),
  charityId: v.charityId,
  timezone: v.timezone,
  deadlineTime: v.deadlineTime,
});

export const routineRes = (r: { id: string; userId: string; name: string }) => ({
  id: r.id,
  userId: r.userId,
  name: r.name,
});
