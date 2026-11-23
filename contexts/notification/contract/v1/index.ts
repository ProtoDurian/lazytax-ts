// notification.v1: the in-app inbox and transactional email. Interfaces and DTOs only. Never
// rename or remove a member once merged; add new ones.

// What a notification is about; the app picks its icon and tap action from this. The values
// the notification context itself posts are in its src/domain/kinds.ts.
export type InboxKind = 'friend_request' | 'friend_accepted' | 'friend_missed' | 'penalty_charged' | 'penalty_failed';

// The email templates (LazyTax App/Modules/Notification/EmailTemplates.cs).
export type EmailTemplateId =
  | 'penalty-charged'
  | 'penalty-payment-failed'
  | 'subscription-receipt'
  | 'subscription-payment-failed'
  | 'subscription-cancelled'
  | 'welcome'
  | 'payment-consent-changed'
  | 'member-thank-you'
  | 'verification-code';

// Same shape as LazyTax's InboxNotificationRes.
export interface InboxNotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  // The user who caused it, or null for a system notification. Deleting their account deletes it.
  actorUserId: string | null;
  // JSON text the app uses for the tap action, e.g. '{"habitId":"...","date":"2026-01-05"}'.
  data: string | null;
  // ISO 8601 instants.
  createdAtUtc: string;
  readAtUtc: string | null;
}

export interface NotificationV1 {
  // Puts a notification in the user's inbox. Title 1..256 chars, body 1..1024 (else 400).
  // `data` is stored as JSON text. Posting the same `dedupeKey` to the same user twice records it
  // once and returns the first (outbox retries). Joins the caller's unit of work when one is open.
  post(
    userId: string,
    kind: string,
    title: string,
    body: string,
    actorUserId?: string | null,
    data?: Record<string, unknown> | null,
    dedupeKey?: string | null,
  ): Promise<InboxNotificationDto>;

  // Asks for an email to the user's registered address. Never throws for a delivery problem: the
  // email leaves through the outbox after the caller's unit of work commits, and a missing
  // address or a failed send is logged. `data` holds the template's variables as strings.
  email(userId: string, template: EmailTemplateId, data?: Record<string, string>): Promise<void>;

  // How many inbox notifications the user has not read.
  unreadCount(userId: string): Promise<number>;
}

// An email waiting to leave (the outbox row notification.email() writes).
export interface NotificationEmailRequested {
  userId: string;
  template: EmailTemplateId;
  data: Record<string, string>;
}

declare module '@lazytax/kernel' {
  interface ContractRegistry {
    'notification.v1': NotificationV1;
  }
  interface EventRegistry {
    'notification.emailRequested': NotificationEmailRequested;
  }
}
