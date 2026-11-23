// The proof domain (LazyTax Domain/Proof/Model.cs). No SQL, no HTTP.
import type { ProofEventDto } from '@lazytax/proof-contract/v1';

// What a proof plugin tells the registry, the bind API and the app about itself.
// alwaysBound plugins (manual, nfc) are available on every habit without a binding.
// minTier null means every tier may bind it.
export interface PluginManifest {
  key: string;
  name: string;
  version: number;
  platforms: string[];
  settingsSchema: string;
  minTier: string | null;
  alwaysBound: boolean;
}

// One proof per habit (v1). Targets such as "5 km" live in settings, never in the habit.
export interface ProofBinding {
  id: string;
  habitId: string;
  userId: string;
  pluginKey: string;
  pluginVersion: number;
  // JSON object as text, normalized by the plugin when bound.
  settings: string;
}

export interface BindingRecord {
  pluginKey: string;
  pluginVersion: number;
  settings: string;
}

// Every source (app call, webhook, poll) builds one.
export interface ProofEvent {
  pluginKey: string;
  userId: string;
  externalId: string;
  occurredAt: Date;
  habitId?: string;
  payload?: unknown;
  notes?: string;
}

export const toEvent = (e: ProofEventDto): ProofEvent => ({
  pluginKey: e.pluginKey,
  userId: e.userId,
  externalId: e.externalId,
  occurredAt: new Date(e.occurredAt),
  habitId: e.habitId,
  payload: e.payload,
  notes: e.notes,
});

// The pending check the event falls in, so a plugin can re-read the whole day from its source
// instead of the core storing partial progress.
export interface ProofWindow {
  localDate: string;
  timezone: string;
  opensAt: Date;
  deadline: Date;
}

// A plugin's decision for one check. data is a summary stake plugins can show, stored as evidence.
export interface Verdict {
  verdict: 'passed' | 'failed';
  data?: unknown;
}

export interface Outcome {
  habitId: string;
  executionId: string | null;
}

export interface NfcTag {
  id: string;
  userId: string;
  habitId: string;
  claimedAt: Date;
}

// The ports the domain needs from other contexts. register.ts adapts the real contracts to these,
// so a contract change touches one file.
export interface HabitPort {
  // True when the habit exists, is not deleted and belongs to the user.
  owns(userId: string, habitId: string): Promise<boolean>;
  // The habit's current version; null when the habit is not Owner's.
  current(userId: string, habitId: string): Promise<HabitVersionView | null>;
}

export interface HabitVersionView {
  id: string;
  habitId: string;
  // Opaque to proof: handed back to the app as is.
  version: unknown;
}

export interface CheckPort {
  // The pending check the instant falls in; null when the day is settled, unscheduled or over.
  pendingCheckAt(userId: string, habitId: string, at: Date, now: Date): Promise<ProofWindow | null>;
  // Reports evidence; returns the execution it recorded, or null when nothing changed.
  report(
    userId: string,
    habitId: string,
    evidence: {
      proofKey: string;
      externalId: string;
      verdict: 'passed' | 'failed';
      occurredAt: Date;
      data: string | null;
      notes: string | null;
    },
    now: Date,
  ): Promise<string | null>;
  // The latest execution of the habit on the user-local date; null when not acted on that day.
  executionForDate(userId: string, habitId: string, date: string): Promise<unknown | null>;
}

export interface PlanPort {
  ensureTier(userId: string, minTier: string): Promise<void>;
}

export interface AccountPort {
  today(userId: string): Promise<string>;
}
