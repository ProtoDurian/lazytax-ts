import { type Outbox, Owner, type UnitOfWork } from '@lazytax/kernel';
import type { EmailTemplateId, InboxNotificationDto, NotificationV1 } from '@lazytax/notification-contract/v1';
import type { InboxService } from './inbox-service';

// notification.v1: what the other contexts call.
export class NotificationService implements NotificationV1 {
  constructor(
    private readonly inbox: InboxService,
    private readonly uow: UnitOfWork,
    private readonly outbox: Outbox,
  ) {}

  post(
    userId: string,
    kind: string,
    title: string,
    body: string,
    actorUserId?: string | null,
    data?: Record<string, unknown> | null,
    dedupeKey?: string | null,
  ): Promise<InboxNotificationDto> {
    return this.inbox.post(Owner.user(userId), { kind, title, body, actorUserId, data, dedupeKey });
  }

  // The send itself leaves after the caller's unit of work commits (no network inside it).
  email(userId: string, template: EmailTemplateId, data: Record<string, string> = {}): Promise<void> {
    return this.uow.run(() =>
      this.outbox.add({ type: 'notification.emailRequested', payload: { userId, template, data }, userId }),
    );
  }

  unreadCount(userId: string): Promise<number> {
    return this.inbox.unreadCount(Owner.user(userId));
  }
}
