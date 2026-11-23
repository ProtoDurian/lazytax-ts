// Pure vacation rules (LazyTax App/Modules/Vacation/VacationService.cs).
import { validationFailed } from '@lazytax/kernel';
import type { Vacation, VacationRecord } from './model';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateRange(r: VacationRecord): void {
  if (r.startDate > r.endDate)
    throw validationFailed('Invalid CreateVacationReq', {
      'StartDate/EndDate': ['StartDate must be before or equal to EndDate'],
    });
}

// A vacation uses one window, in the year it starts, even when it spans New Year.
export const windowYear = (r: VacationRecord): number => Number(r.startDate.slice(0, 4));

export function ensureNotStarted(v: Vacation, today: string): void {
  if (today >= v.record.startDate)
    throw validationFailed('Invalid DeleteVacation', { State: ['Cannot delete a vacation that has started'] });
}

// Ending today: the end moves to today when today is earlier; refused before the start.
export function endToday(v: Vacation, today: string): VacationRecord {
  if (today < v.record.startDate)
    throw validationFailed('Invalid EndVacation', { State: ["Cannot end a vacation that hasn't started"] });
  return { ...v.record, endDate: today < v.record.endDate ? today : v.record.endDate };
}
