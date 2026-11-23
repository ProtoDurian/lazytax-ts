// vacation's model (LazyTax Domain/Vacation/Model.cs).
export interface VacationRecord {
  // User-local dates, "YYYY-MM-DD", inclusive.
  startDate: string;
  endDate: string;
  timezone: string;
}

export interface Vacation {
  id: string;
  userId: string;
  record: VacationRecord;
  createdAt: Date;
}

export interface VacationSearch {
  year?: number;
  limit: number;
  skip: number;
}
