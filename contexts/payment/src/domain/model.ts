// Payment's own model (LazyTax Domain/Payment/Model.cs). No SQL, no HTTP.

import { validationFailed } from '@lazytax/kernel';
import type { ChargeStatus, ConsentPurpose, ConsentStatus } from '@lazytax/payment-contract/v1';

export const PURPOSES: readonly ConsentPurpose[] = ['penalty', 'subscription'];

export interface ConsentRow {
  purpose: ConsentPurpose;
  consentId: string;
  status: ConsentStatus | null;
}

export interface CustomerRow {
  id: string;
  userId: string;
  airwallexCustomerId: string;
  consents: ConsentRow[];
  createdAt: string;
  updatedAt: string;
}

// The charge row's status: "processing" while a claim holds it, else the contract's ChargeStatus.
export type ChargeRowStatus = 'processing' | ChargeStatus;

export interface ChargeRow {
  requestId: string;
  userId: string;
  amountCents: number;
  currency: string;
  purpose: ConsentPurpose;
  description: string;
  status: ChargeRowStatus;
  attempt: number;
  intentId: string | null;
  detail: string | null;
}

export const consentFor = (c: CustomerRow, purpose: ConsentPurpose): ConsentRow | undefined =>
  c.consents.find(x => x.purpose === purpose);

export const hasVerified = (c: CustomerRow, purpose: ConsentPurpose): boolean =>
  consentFor(c, purpose)?.status === 'Verified';

// LazyTax ParsePurpose: null, "" or "penalty" -> penalty; "subscription"; anything else is a 400.
export function parsePurpose(raw: string | undefined | null): ConsentPurpose {
  const p = (raw ?? '').toLowerCase();
  if (p === '' || p === 'penalty') return 'penalty';
  if (p === 'subscription') return 'subscription';
  throw validationFailed('Invalid purpose', { purpose: ["must be 'penalty' or 'subscription'"] });
}

// LazyTax AirwallexWebhookService.PurposeLabel.
export const purposeLabel = (p: ConsentPurpose): string => (p === 'subscription' ? 'Subscription' : 'Habit stakes');

// LazyTax AirwallexEventAdapter: the Airwallex status string -> the enum (unknown -> null).
export function parseConsentStatus(s: string | undefined): ConsentStatus | null {
  switch (s) {
    case 'VERIFIED':
      return 'Verified';
    case 'REQUIRES_PAYMENT_METHOD':
      return 'RequiresPaymentMethod';
    case 'REQUIRES_CUSTOMER_ACTION':
      return 'RequiresCustomerAction';
    default:
      return null;
  }
}

// LazyTax CreatePaymentIntentReqValidator's currency list.
const CURRENCIES = [
  'USD',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CAD',
  'CHF',
  'CNY',
  'SEK',
  'NZD',
  'MXN',
  'SGD',
  'HKD',
  'NOK',
  'ZAR',
  'TRY',
  'BRL',
  'INR',
  'KRW',
  'PLN',
] as const;

export const isCurrency = (c: string): boolean => (CURRENCIES as readonly string[]).includes(c.toUpperCase());
