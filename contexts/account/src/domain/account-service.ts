// account's services (LazyTax Domain/User/Service.cs, Domain/Configuration/Service.cs) and its
// account.v1 implementation.
import type { AccountV1, ProfileDto, UserMatchDto } from '@lazytax/account-contract/v1';
import { type Clock, notFound, type Outbox, Owner, type UnitOfWork, type UserLifecycle } from '@lazytax/kernel';
import type { ConfigurationRepository } from '../data/configuration-repository';
import type { UserRepository } from '../data/user-repository';
import type { ConfigurationPrincipal, ConfigurationRecord, UserPrincipal, UserRecord, UserSearch } from './model';
import { localDate } from './time';

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly configs: ConfigurationRepository,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly lifecycle: UserLifecycle,
  ) {}

  search(owner: Owner, s: UserSearch): Promise<UserPrincipal[]> {
    return this.users.search(owner, s);
  }

  async get(owner: Owner, id: string): Promise<UserPrincipal> {
    const u = await this.users.get(owner, id);
    if (!u) throw notFound('User', id);
    return u;
  }

  async getByUsername(owner: Owner, username: string): Promise<UserPrincipal> {
    const u = await this.users.getByUsername(owner, username);
    if (!u) throw notFound('User', username);
    return u;
  }

  // The welcome email leaves through the outbox (account.userCreated), after commit.
  create(owner: Owner, id: string, rec: UserRecord): Promise<UserPrincipal> {
    return this.uow.run(async () => {
      const u = await this.users.create(owner, id, rec);
      await this.outbox.add({ type: 'account.userCreated', payload: { userId: id }, userId: id });
      return u;
    });
  }

  async update(owner: Owner, id: string, rec: UserRecord): Promise<UserPrincipal> {
    const u = await this.uow.run(() => this.users.update(owner, id, rec));
    if (!u) throw notFound('User', id);
    return u;
  }

  // Self-service deletion (LazyTax DeleteAccount): every context's deleteGuard (penalty: debt) ->
  // beforePurge outside any transaction (payment: revoke consents) -> every purgeUser in ONE unit
  // of work. Idempotent: a missing user still runs every hook, so a retry finishes a partial run.
  async deleteAccount(userId: string): Promise<void> {
    await this.lifecycle.deleteGuard(userId);
    await this.lifecycle.beforePurge(userId);
    await this.uow.run(async () => {
      await this.lifecycle.purgeUser(userId);
      await this.outbox.add({ type: 'account.userDeleted', payload: { userId }, userId });
    });
  }

  // Admin deletion (LazyTax Delete / DeleteAllRemnants): no debt gate; 404 when there is no user.
  async deleteByAdmin(owner: Owner, userId: string): Promise<void> {
    await this.uow.run(async () => {
      if (!(await this.users.get(owner, userId))) throw notFound('User', userId);
      await this.lifecycle.purgeUser(userId);
      await this.outbox.add({ type: 'account.userDeleted', payload: { userId }, userId });
    });
  }

  // account's own purge hook.
  async purgeUser(userId: string): Promise<void> {
    await this.configs.purgeUser(userId);
    await this.users.purgeUser(userId);
  }
}

export class ConfigurationService {
  constructor(
    private readonly configs: ConfigurationRepository,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
  ) {}

  async get(owner: Owner, id: string): Promise<ConfigurationPrincipal> {
    const c = await this.configs.get(owner, id);
    if (!c) throw notFound('Configuration', id);
    return c;
  }

  async getForUser(owner: Owner, userId: string): Promise<ConfigurationPrincipal> {
    const c = await this.configs.getForUser(owner, userId);
    if (!c) throw notFound('Configuration', userId);
    return c;
  }

  create(owner: Owner, userId: string, rec: ConfigurationRecord): Promise<ConfigurationPrincipal> {
    return this.uow.run(() => this.configs.create(owner, userId, rec));
  }

  // A timezone move emits account.timezoneChanged; check moves the pending checks when it lands.
  // (LazyTax did this synchronously and returned the settled checks; here SettledChecks is [].)
  update(owner: Owner, id: string, rec: ConfigurationRecord): Promise<ConfigurationPrincipal> {
    return this.uow.run(async () => {
      const before = await this.configs.get(owner, id);
      if (!before) throw notFound('Configuration', id);
      const after = await this.configs.update(owner, id, rec);
      if (!after) throw notFound('Configuration', id);
      if (before.record.timezone !== rec.timezone)
        await this.outbox.add({
          type: 'account.timezoneChanged',
          payload: { userId: after.userId, from: before.record.timezone, to: rec.timezone },
          userId: after.userId,
        });
      return after;
    });
  }
}

// account.v1. userId arguments come from trusted callers (other contexts, workers).
export class AccountApi implements AccountV1 {
  constructor(
    private readonly users: UserRepository,
    private readonly configs: ConfigurationRepository,
    private readonly clock: Clock,
  ) {}

  async getProfile(owner: Owner): Promise<ProfileDto | null> {
    if (owner.kind !== 'user') throw new Error('account.v1 getProfile needs Owner.user(id)');
    const u = await this.users.get(owner, owner.userId);
    if (!u) return null;
    const { username, email, emailVerified, active } = u.record;
    return { id: u.id, username, email, emailVerified, active };
  }

  private async config(userId: string): Promise<ConfigurationPrincipal> {
    const c = await this.configs.getForUser(Owner.user(userId), userId);
    if (!c) throw notFound('Configuration', userId);
    return c;
  }

  async getTimezone(userId: string): Promise<string> {
    return (await this.config(userId)).record.timezone;
  }

  async endOfDay(userId: string): Promise<string> {
    return (await this.config(userId)).endOfDay;
  }

  async defaultCharity(userId: string): Promise<string | null> {
    const c = await this.configs.getForUser(Owner.user(userId), userId);
    return c?.record.defaultCharityId ?? null;
  }

  async today(userId: string): Promise<string> {
    return localDate(this.clock.now(), await this.getTimezone(userId));
  }

  usernames(userIds: string[]): Promise<Record<string, string>> {
    return this.users.usernames(Owner.system(), userIds);
  }

  searchUsers(prefix: string, excludeUserId: string, limit: number): Promise<UserMatchDto[]> {
    return this.users.searchByPrefix(Owner.system(), prefix, excludeUserId, Math.max(0, Math.min(limit, 100)));
  }
}
