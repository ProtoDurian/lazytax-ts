// account's domain model (LazyTax Domain/User/Model.cs, Domain/Configuration/Model.cs).
export interface UserRecord {
  username: string;
  email: string;
  emailVerified: boolean;
  active: boolean;
  scopes: string[];
}

export interface UserPrincipal {
  id: string;
  record: UserRecord;
}

export interface UserSearch {
  id?: string;
  username?: string;
  email?: string;
  emailVerified?: boolean;
  active?: boolean;
  limit: number;
  skip: number;
}

export interface ConfigurationRecord {
  timezone: string;
  defaultCharityId: string | null;
}

export interface ConfigurationPrincipal {
  id: string;
  userId: string;
  endOfDay: string;
  record: ConfigurationRecord;
}
