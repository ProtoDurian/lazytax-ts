import type { AccountV1 } from '@lazytax/account-contract/v1';
import { type Clock, type Logger, Owner } from '@lazytax/kernel';
import type { EmailTemplateId } from '@lazytax/notification-contract/v1';
import { renderEmail } from '../email/renderer';
import type { EmailTransport } from '../email/transport';

export interface EmailConfig {
  baseUrl: string;
  supportEmail: string;
}

// Resolve recipient, render, send: entirely best effort. Never throws (LazyTax SendSafe): an
// email can never fail the money event whose success it reports.
export class EmailService {
  constructor(
    private readonly account: AccountV1,
    private readonly transport: EmailTransport,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly config: EmailConfig,
  ) {}

  async send(eventId: string, userId: string, template: EmailTemplateId, data: Record<string, string>): Promise<void> {
    try {
      const profile = await this.account.getProfile(Owner.user(userId));
      if (!profile || profile.email.trim() === '') {
        this.log.warn('email skipped: no recipient address', { template, userId });
        return;
      }
      const { subject, html } = renderEmail(template, {
        BaseUrl: this.config.baseUrl,
        SupportEmail: this.config.supportEmail,
        UserName: profile.username.trim() === '' ? 'there' : profile.username,
        ...data,
      });
      await this.transport.send({
        messageId: eventId,
        userId,
        to: profile.email,
        subject,
        html,
        template,
        sentAt: this.clock.now().toISOString(),
      });
      this.log.info('email sent', { template, userId });
    } catch (err) {
      this.log.error('email send failed', { template, userId, error: String(err) });
    }
  }
}
