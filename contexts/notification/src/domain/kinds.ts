import type { EmailTemplateId, InboxKind } from '@lazytax/notification-contract/v1';

export const InboxKinds = {
  FriendRequest: 'friend_request',
  FriendAccepted: 'friend_accepted',
  FriendMissed: 'friend_missed',
  PenaltyCharged: 'penalty_charged',
  PenaltyFailed: 'penalty_failed',
} as const satisfies Record<string, InboxKind>;

export const EmailTemplateIds = [
  'penalty-charged',
  'penalty-payment-failed',
  'subscription-receipt',
  'subscription-payment-failed',
  'subscription-cancelled',
  'welcome',
  'payment-consent-changed',
  'member-thank-you',
  'verification-code',
] as const satisfies readonly EmailTemplateId[];
