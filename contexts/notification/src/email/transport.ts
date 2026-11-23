// The SMTP adapter. LazyTax sends through MailKit; this model has no network, so the only
// adapter appends one JSON line per message to a file (dev and tests read it back).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EmailMessage {
  // Stable per outbox event, so a retried delivery is recognisable.
  messageId: string;
  userId: string;
  to: string;
  subject: string;
  html: string;
  template: string;
  sentAt: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export class FileEmailTransport implements EmailTransport {
  private readonly sent = new Set<string>();

  constructor(private readonly file: string) {}

  async send(message: EmailMessage): Promise<void> {
    if (this.sent.has(message.messageId)) return;
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(message)}\n`);
    this.sent.add(message.messageId);
  }
}
