// vacation.v1: the user's vacation windows. Interfaces and DTOs only. Never rename or remove a
// member once merged.

export interface VacationDto {
  id: string;
  userId: string;
  // User-local dates, "YYYY-MM-DD", inclusive.
  startDate: string;
  endDate: string;
  timezone: string;
  createdAt: string;
}

export interface VacationV1 {
  // True when a vacation window covers this user-local date ("YYYY-MM-DD").
  isAway(userId: string, date: string): Promise<boolean>;
  // The windows covering this date.
  listActive(userId: string, date: string): Promise<VacationDto[]>;
}

export interface VacationCreated {
  userId: string;
  vacationId: string;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'vacation.v1': VacationV1;
  }
  interface EventRegistry {
    'vacation.created': VacationCreated;
  }
}
