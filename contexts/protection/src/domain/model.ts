export interface ProtectionRow {
  userId: string;
  freezeCurrent: number;
  maxStreak: number;
}

export interface SettledDayRow {
  habitId: string;
  date: string;
  status: string;
}

export interface SettledDayInput {
  executionId: string;
  habitId: string;
  date: string;
  status: string;
}
