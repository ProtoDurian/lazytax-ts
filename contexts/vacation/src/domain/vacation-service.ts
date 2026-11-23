// vacation's service (LazyTax App/Modules/Vacation/VacationService.cs) and vacation.v1.
//
// The reference for layer 5: a cheap plan read as a route guard first (see api/v1/routes.ts),
// then in ONE unit of work: lock the user, count, check the quota, write, add the outbox event.
import type { AccountV1 } from '@lazytax/account-contract/v1';
import { notFound, type Outbox, Owner, type UnitOfWork, validationFailed } from '@lazytax/kernel';
import type { PlanV1 } from '@lazytax/plan-contract/v1';
import type { VacationDto, VacationV1 } from '@lazytax/vacation-contract/v1';
import type { VacationRepository } from '../data/vacation-repository';
import type { Vacation, VacationRecord, VacationSearch } from './model';
import { endToday, ensureNotStarted, validateRange, windowYear } from './rules';

export const toDto = (v: Vacation): VacationDto => ({
  id: v.id,
  userId: v.userId,
  startDate: v.record.startDate,
  endDate: v.record.endDate,
  timezone: v.record.timezone,
  createdAt: v.createdAt.toISOString(),
});

export class VacationService implements VacationV1 {
  constructor(
    private readonly repo: VacationRepository,
    private readonly plan: PlanV1,
    private readonly account: AccountV1,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
  ) {}

  create(owner: Owner, userId: string, rec: VacationRecord): Promise<Vacation> {
    validateRange(rec);
    return this.uow.run(async () => {
      await this.uow.lockUser(userId);
      if (await this.repo.hasOverlap(owner, userId, rec.startDate, rec.endDate))
        throw validationFailed('Invalid CreateVacationReq', {
          Range: ['Vacation window overlaps with an existing one'],
        });
      const used = await this.repo.countWindowsForYear(owner, userId, windowYear(rec));
      this.plan.ensureWithin(await this.plan.quota(userId, 'vacationWindows'), used);
      const v = await this.repo.create(owner, userId, rec);
      await this.outbox.add({ type: 'vacation.created', payload: { userId, vacationId: v.id }, userId });
      return v;
    });
  }

  search(owner: Owner, userId: string, s: VacationSearch): Promise<Vacation[]> {
    return this.repo.search(owner, userId, s);
  }

  // The first read is owner-scoped; a vacation of someone else is 404 (never 403).
  private async mine(owner: Owner, userId: string, id: string): Promise<Vacation> {
    const v = await this.repo.get(owner, id);
    if (!v || v.userId !== userId) throw notFound('Vacation', id);
    return v;
  }

  async delete(owner: Owner, userId: string, id: string): Promise<void> {
    const v = await this.mine(owner, userId, id);
    ensureNotStarted(v, await this.account.today(userId));
    await this.uow.run(() => this.repo.delete(owner, id));
  }

  async endToday(owner: Owner, userId: string, id: string): Promise<Vacation> {
    const v = await this.mine(owner, userId, id);
    const next = endToday(v, await this.account.today(userId));
    const updated = await this.uow.run(() => this.repo.update(owner, id, next));
    if (!updated) throw notFound('Vacation', id);
    return updated;
  }

  purgeUser(userId: string): Promise<void> {
    return this.repo.purgeUser(userId);
  }

  // ── vacation.v1 (trusted callers: check settle) ────────────────────────────────────────────
  async isAway(userId: string, date: string): Promise<boolean> {
    return (await this.repo.listActive(Owner.user(userId), userId, date)).length > 0;
  }

  async listActive(userId: string, date: string): Promise<VacationDto[]> {
    return (await this.repo.listActive(Owner.user(userId), userId, date)).map(toDto);
  }
}
