import type { EventRegistry } from '@lazytax/kernel';
import type { NotificationV1 } from '@lazytax/notification-contract/v1';
import { InboxKinds } from './kinds';

// The penalty context owns these payloads (declared in its contract; the registry is global, so
// notification reads them without importing it). notification does not need charity or habit, so
// the emails use LazyTax's fallback names ("your habit", "your chosen charity").
type PenaltyCharged = EventRegistry['penalty.charged'];
type PenaltyFailed = EventRegistry['penalty.failed'];

const HABIT = 'your habit';
const CHARITY = 'your chosen charity';

export const formatMoney = (cents: number, currency: string): string => {
  const amount = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
};

const formatDate = (iso: string, fallback: Date): string => {
  const parsed = new Date(iso);
  const d = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    d,
  );
};

// Reacts to other contexts' events with an inbox row plus an email, in the subscriber's own unit
// of work, so each happens exactly once per event.
export class NotificationEvents {
  constructor(private readonly notification: NotificationV1) {}

  async onPenaltyCharged(eventId: string, e: PenaltyCharged, now: Date): Promise<void> {
    const amount = formatMoney(e.amountCents, e.currency);
    await this.notification.post(
      e.userId,
      InboxKinds.PenaltyCharged,
      'Habit stake charged',
      `You missed ${HABIT}: ${amount} was charged.`,
      null,
      { habitId: e.habitId, habitExecutionId: e.habitExecutionId },
      `penalty.charged:${eventId}`,
    );
    await this.notification.email(e.userId, 'penalty-charged', {
      Amount: amount,
      CharityName: CHARITY,
      HabitName: HABIT,
      ChargeDate: formatDate(e.chargedAt, now),
    });
  }

  async onPenaltyFailed(eventId: string, e: PenaltyFailed, now: Date): Promise<void> {
    const amount = formatMoney(e.amountCents, e.currency);
    await this.notification.post(
      e.userId,
      InboxKinds.PenaltyFailed,
      "We couldn't process your stake",
      `You missed ${HABIT}, but ${amount} could not be charged.`,
      null,
      { habitId: e.habitId, habitExecutionId: e.habitExecutionId },
      `penalty.failed:${eventId}`,
    );
    await this.notification.email(e.userId, 'penalty-payment-failed', {
      Amount: amount,
      CharityName: CHARITY,
      HabitName: HABIT,
      AttemptDate: formatDate(e.attemptedAt, now),
    });
  }

  onUserCreated(userId: string): Promise<void> {
    return this.notification.email(userId, 'welcome', {});
  }
}
