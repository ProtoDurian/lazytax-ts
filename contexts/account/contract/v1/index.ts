// account.v1: users and their settings. The only thing other contexts may import from account.
// Interfaces and DTOs only. Never rename or remove a member once merged; add new ones.
import type { Owner } from '@lazytax/kernel';

export interface ProfileDto {
  // The JWT sub.
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  active: boolean;
}

export interface UserMatchDto {
  userId: string;
  username: string;
}

export interface ConfigurationDto {
  id: string;
  userId: string;
  // IANA zone, e.g. "Asia/Singapore".
  timezone: string;
  // Local time the user's day ends, "HH:MM:SS" (LazyTax Configurations.EndOfDay; default "00:00:00").
  endOfDay: string;
  // A plain uuid for now; charity owns charities.
  defaultCharityId: string | null;
}

export interface AccountV1 {
  // The profile of Owner.user(id), or null when that user has not registered.
  // Throws for Owner.anyone (a profile belongs to one user).
  getProfile(owner: Owner): Promise<ProfileDto | null>;
  // The user's IANA timezone. Throws 404 entity_not_found when the user has no configuration.
  getTimezone(userId: string): Promise<string>;
  // "HH:MM:SS". Throws 404 when the user has no configuration.
  endOfDay(userId: string): Promise<string>;
  // null when none is set (or no configuration).
  defaultCharity(userId: string): Promise<string | null>;
  // The user's local date ("YYYY-MM-DD") right now on the kernel clock. Throws 404 with no configuration.
  today(userId: string): Promise<string>;
  // userId -> username for every registered id given (unknown ids are left out).
  usernames(userIds: string[]): Promise<Record<string, string>>;
  // Users whose username starts with prefix (case-insensitive), never excludeUserId, ordered by
  // lower(username), username, id; at most limit.
  searchUsers(prefix: string, excludeUserId: string, limit: number): Promise<UserMatchDto[]>;
}

export interface AccountUserCreated {
  userId: string;
}

export interface AccountUserDeleted {
  userId: string;
}

// The user's timezone moved (LazyTax: ConfigurationService.Update -> CheckService.MoveToTimezone).
export interface AccountTimezoneChanged {
  userId: string;
  from: string;
  to: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'account.v1': AccountV1;
  }
  interface EventRegistry {
    'account.userCreated': AccountUserCreated;
    'account.userDeleted': AccountUserDeleted;
    'account.timezoneChanged': AccountTimezoneChanged;
  }
}
