// proof.v1: proof plugins (manual, nfc, strava) and how a proof event becomes check evidence
// (LazyTax Domain/Proof). Interfaces and DTOs only. Never rename or remove a member once merged.
import type { Owner } from '@lazytax/kernel';

// What a plugin says about itself. The app renders a binding form from settingsSchema.
export interface PluginManifestDto {
  key: string;
  name: string;
  version: number;
  platforms: string[];
  // JSON Schema as text.
  settingsSchema: string;
  // null: every tier may bind it.
  minTier: string | null;
  // Available on every habit without a binding (manual).
  alwaysBound: boolean;
}

// One proof per habit. A habit with no row reports the manual proof.
export interface ProofBindingDto {
  habitId: string;
  pluginKey: string;
  pluginVersion: number;
  // A JSON object as text; its shape is the plugin's settingsSchema.
  settings: string;
}

// Every source (app call, webhook, poll) builds one. habitId targets one habit (the Complete
// button, an NFC tap); without it the router evaluates every habit of the user bound to the
// plugin (a Strava activity). (habit, plugin, externalId) is idempotent.
export interface ProofEventDto {
  pluginKey: string;
  userId: string;
  externalId: string;
  // ISO 8601 instant.
  occurredAt: string;
  habitId?: string;
  // The plugin's own event body (a parsed JSON object).
  payload?: unknown;
  notes?: string;
}

// What routing one event did to one habit. executionId is null when the plugin had no verdict
// or nothing changed (replay, already settled, too late).
export interface ProofOutcomeDto {
  habitId: string;
  executionId: string | null;
}

export interface NfcTagDto {
  id: string;
  userId: string;
  habitId: string;
  claimedAt: string;
}

export interface ProofV1 {
  // The one way in for every proof source: evaluates the event for each habit it can prove and
  // reports each verdict to check as evidence. Runs inside the caller's unit of work.
  route(event: ProofEventDto): Promise<ProofOutcomeDto[]>;
  listPlugins(): PluginManifestDto[];
  // null when the habit only has the always-bound proofs. 404 when the habit is not Owner's.
  getBinding(owner: Owner, habitId: string): Promise<ProofBindingDto | null>;
  // habitId -> bound plugin key, for the owner's habits that have a binding.
  listPluginKeys(owner: Owner): Promise<Record<string, string>>;
  // Habit ids of the owner that have at least one NFC tag linked.
  listTaggedHabits(owner: Owner): Promise<string[]>;
}

// An activity (or its evidence) is gone at the source (Strava delete, disconnect, deauthorize).
// check removes the evidence row; the day it proved stays done. externalId null = all evidence of
// that proof for the user.
export interface ProofEvidenceRevoked {
  userId: string;
  proofKey: string;
  externalId: string | null;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'proof.v1': ProofV1;
  }
  interface EventRegistry {
    'proof.evidenceRevoked': ProofEvidenceRevoked;
  }
}
