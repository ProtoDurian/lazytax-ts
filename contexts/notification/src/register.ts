import '@lazytax/notification-contract/v1';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContext, subscribe, z } from '@lazytax/kernel';
import { inboxRoutes } from './api/v1/inbox-routes';
import { InboxRepository } from './data/inbox-repository';
import { EmailService } from './domain/email-service';
import { NotificationEvents } from './domain/events';
import { InboxService } from './domain/inbox-service';
import { NotificationService } from './domain/notification-service';
import { FileEmailTransport } from './email/transport';
import { inboxTools } from './mcp/inbox-tools';

// Override with env LAZYTAX_NOTIFICATION_CONFIG='{"smtp":{"file":"/tmp/mail.jsonl"}}'.
const NotificationConfig = z.object({
  baseUrl: z.string().default('https://lazytax.club'),
  supportEmail: z.string().default('support@lazytax.club'),
  // The fake SMTP adapter appends one JSON line per email here.
  smtp: z.object({ file: z.string().default(join(tmpdir(), 'lazytax-emails.jsonl')) }).prefault({}),
});

export default defineContext({
  config: NotificationConfig,
  migrations: 'src/data/migrations',
  build: ({ deps, uow, outbox, log, config, clock }) => {
    const repo = new InboxRepository(uow);
    const inbox = new InboxService(repo, clock);
    const notification = new NotificationService(inbox, uow, outbox);
    const emails = new EmailService(
      deps.get('account.v1'),
      new FileEmailTransport(config.smtp.file),
      clock,
      log,
      config,
    );
    const events = new NotificationEvents(notification);

    return {
      provides: { 'notification.v1': notification },
      http: inboxRoutes(inbox),
      mcp: inboxTools(inbox),
      users: { purgeUser: userId => repo.purgeUser(userId) },
      subscribers: [
        subscribe('penalty.charged', e => events.onPenaltyCharged(e.id, e.payload, clock.now())),
        subscribe('penalty.failed', e => events.onPenaltyFailed(e.id, e.payload, clock.now())),
        subscribe('account.userCreated', e => events.onUserCreated(e.payload.userId)),
        // Outside a unit of work (a real adapter would use the network); at least once, so the
        // transport is idempotent by event id.
        subscribe(
          'notification.emailRequested',
          e => emails.send(e.id, e.payload.userId, e.payload.template, e.payload.data),
          { tx: false },
        ),
      ],
      workers: [],
    };
  },
});
