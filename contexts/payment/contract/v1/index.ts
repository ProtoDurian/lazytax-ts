// payment.v1: the user's Airwallex customer, their purpose-scoped consents, and merchant-initiated
// charges against a stored consent (LazyTax Domain/Payment). Interfaces and DTOs only. Never
// rename or remove a member once merged; add new ones.
import type { Owner } from '@lazytax/kernel';

// Which charging relationship a consent authorises (LazyTax ConsentPurpose):
//   penalty      -> unscheduled merchant-initiated (habit stakes)
//   subscription -> recurring merchant-initiated (plan billing)
export type ConsentPurpose = 'penalty' | 'subscription';

// LazyTax PaymentConsentStatus, same spelling as its JSON.
export type ConsentStatus = 'Verified' | 'RequiresPaymentMethod' | 'RequiresCustomerAction';

export interface ConsentDto {
  purpose: ConsentPurpose;
  consentId: string | null;
  status: ConsentStatus | null;
  // True only when the consent is Verified.
  hasPaymentConsent: boolean;
}

// What one call to charge() left behind:
//   succeeded  -> money moved (exactly once per requestId; later calls return this again).
//   pending    -> the gateway has not settled it yet, or the call failed in a way that may still
//                 have moved money. Call charge() again later with the SAME requestId: it
//                 reconciles the same gateway intent, never a new one.
//   declined   -> the gateway definitively refused the first send of this attempt; no money moved.
//                 A later charge() with the same requestId starts a fresh attempt.
//   no_consent -> the user has no verified consent for this purpose; nothing was sent (LazyTax:
//                 the penalty is marked Skipped).
export type ChargeStatus = 'succeeded' | 'pending' | 'declined' | 'no_consent';

export interface ChargeResultDto {
  requestId: string;
  userId: string;
  amountCents: number;
  currency: string;
  purpose: ConsentPurpose;
  status: ChargeStatus;
  // The gateway payment intent, once one exists.
  intentId: string | null;
  // 1 on the first send; a declined attempt is followed by attempt + 1.
  attempt: number;
  // The last gateway status or error text, for logs. Never shown to users.
  detail: string | null;
}

export interface PaymentV1 {
  // True when the user holds a VERIFIED consent for this purpose (default 'penalty').
  hasConsent(userId: string, purpose?: ConsentPurpose): Promise<boolean>;

  // Charges the user's stored consent, merchant-initiated, in 3 phases (nitroso
  // Domain/Withdrawal/Service.cs Approve): (1) claim the charge row in a unit of work, (2) call
  // the gateway OUTSIDE any unit with idempotency key "<requestId>-<attempt>", (3) write the
  // result back only if the claim still holds, and emit payment.completed / payment.failed.
  // `requestId` is the caller's stable id for this logical charge (e.g. the penalty id); every
  // retry must reuse it. Must be called OUTSIDE a unit of work (throws inside one).
  // amountCents > 0; currency is a 3-letter ISO code.
  charge(
    requestId: string,
    userId: string,
    amountCents: number,
    currency: string,
    purpose: ConsentPurpose,
    description?: string,
  ): Promise<ChargeResultDto>;

  // Account deletion: revokes every consent the user still holds at the gateway, trying every
  // purpose even when one fails, then throws the first failure. Missing customer = no-op.
  // Calls the gateway, so it must run OUTSIDE a unit of work (the kernel's beforePurge hook).
  revokeAll(userId: string): Promise<void>;

  // The user's consent for a purpose (404 when the user has no payment customer).
  getConsent(owner: Owner, purpose: ConsentPurpose): Promise<ConsentDto>;

  // The last known state of a charge, or null when this requestId was never charged.
  getCharge(requestId: string): Promise<ChargeResultDto | null>;
}

// A charge settled (sync from charge(), exactly once per requestId). kind = the consent purpose.
export interface PaymentCompleted {
  requestId: string;
  userId: string;
  kind: ConsentPurpose;
  intentId: string;
  amountCents: number;
  currency: string;
}

// A charge attempt was definitively declined by the gateway (once per attempt).
export interface PaymentFailed {
  requestId: string;
  userId: string;
  kind: ConsentPurpose;
  attempt: number;
  reason: string;
}

// A consent was linked (webhook: verified) or unlinked (user revoke, or account deletion).
// LazyTax set the Logto claim has_payment_consent here; account may subscribe to do the same.
export interface PaymentConsentChanged {
  userId: string;
  purpose: ConsentPurpose;
  linked: boolean;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'payment.v1': PaymentV1;
  }
  interface EventRegistry {
    'payment.completed': PaymentCompleted;
    'payment.failed': PaymentFailed;
    'payment.consentChanged': PaymentConsentChanged;
  }
}
