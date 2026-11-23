import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountV1, ProfileDto } from '@lazytax/account-contract/v1';
import { type Logger, type Outbox, type OutboxEventInput, Owner, type UnitOfWork } from '@lazytax/kernel';
import { EmailService } from '../../src/domain/email-service';
import { formatMoney, NotificationEvents } from '../../src/domain/events';
import { EmailTemplateIds } from '../../src/domain/kinds';
import { NotificationService } from '../../src/domain/notification-service';
import { renderEmail } from '../../src/email/renderer';
import { type EmailMessage, FileEmailTransport } from '../../src/email/transport';

const COMMON = {
  BaseUrl: 'https://lazytax.club',
  UserName: 'Sarah',
  SupportEmail: 'support@lazytax.club',
  Amount: '$5.00',
  CharityName: 'Doctors Without Borders',
  HabitName: 'Morning run',
  ChargeDate: '12 July 2026',
  AttemptDate: '12 July 2026',
  Tier: 'Pro',
  NextBillingDate: '12 August 2026',
  GraceEndsDate: '19 July 2026',
  ChangeSummary: 'Pro → Free',
  EffectiveDate: '12 August 2026',
  Purpose: 'Habit stakes',
  ChangeDate: '12 July 2026',
  MemberSince: 'January 2026',
  MembershipType: 'Pro',
  Code: '482619',
};

describe('renderEmail', () => {
  it.each([...EmailTemplateIds])('should render %s with no token residue', template => {
    const { subject, html } = renderEmail(template, COMMON);
    expect(subject.length).toBeGreaterThan(0);
    expect(html).toContain('Sarah');
    expect(html).toContain('support@lazytax.club');
    expect(html).not.toContain('{{');
    expect(html).toContain('lazytax.club/images/email/logo.png');
  });

  it('should escape html in variables', () => {
    const { html } = renderEmail('penalty-charged', { ...COMMON, HabitName: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should refuse a missing variable instead of leaking a token', () => {
    expect(() => renderEmail('penalty-charged', { BaseUrl: 'b', UserName: 'u', SupportEmail: 's' })).toThrow(/missing/);
  });

  it('should not let a variable inject a token of its own', () => {
    const { html } = renderEmail('penalty-charged', { ...COMMON, HabitName: '{{Code}}' });
    expect(html).not.toContain('{{');
  });
});

describe('EmailService', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true });
  });

  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  const clock = { now: () => new Date('2026-03-01T00:00:00Z') };
  const profile = (over: Partial<ProfileDto> = {}): ProfileDto => ({
    id: 'u1',
    username: 'sarah',
    email: 'sarah@example.com',
    emailVerified: true,
    active: true,
    ...over,
  });
  const make = (p: ProfileDto | null | 'throws') => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-notif-'));
    dirs.push(dir);
    const file = join(dir, 'mail.jsonl');
    const account = {
      getProfile: async () => {
        if (p === 'throws') throw new Error('db down');
        return p;
      },
    } as unknown as AccountV1;
    const svc = new EmailService(account, new FileEmailTransport(file), clock, log, {
      baseUrl: 'https://lazytax.club',
      supportEmail: 'support@lazytax.club',
    });
    const read = (): EmailMessage[] => {
      try {
        return readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l));
      } catch {
        return [];
      }
    };
    return { svc, read };
  };

  it('should write the rendered email to the fake SMTP file', async () => {
    const { svc, read } = make(profile());
    await svc.send('evt-1', 'u1', 'welcome', {});
    const [m] = read();
    expect(m?.to).toBe('sarah@example.com');
    expect(m?.subject).toBe("Welcome to LazyTax — let's build habits that stick");
    expect(m?.html).toContain('Hi sarah');
    expect(m?.messageId).toBe('evt-1');
    expect(m?.sentAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('should write a retried delivery once', async () => {
    const { svc, read } = make(profile());
    await svc.send('evt-1', 'u1', 'welcome', {});
    await svc.send('evt-1', 'u1', 'welcome', {});
    expect(read()).toHaveLength(1);
  });

  it('should greet by "there" when the user has no username', async () => {
    const { svc, read } = make(profile({ username: ' ' }));
    await svc.send('e', 'u1', 'welcome', {});
    expect(read()[0]?.html).toContain('Hi there');
  });

  it('should skip quietly when the user has no address or no profile', async () => {
    const a = make(profile({ email: '' }));
    await a.svc.send('e', 'u1', 'welcome', {});
    const b = make(null);
    await b.svc.send('e', 'u1', 'welcome', {});
    expect(a.read()).toEqual([]);
    expect(b.read()).toEqual([]);
  });

  it('should never throw: a failed lookup or a missing variable is swallowed', async () => {
    const a = make('throws');
    await a.svc.send('e', 'u1', 'welcome', {});
    const b = make(profile());
    await b.svc.send('e', 'u1', 'penalty-charged', {});
    expect(a.read()).toEqual([]);
    expect(b.read()).toEqual([]);
  });
});

describe('NotificationService and events', () => {
  const added: OutboxEventInput[] = [];
  const outbox: Outbox = {
    add: async e => {
      added.push(e);
    },
  };
  const uow = { run: <T>(fn: () => Promise<T>) => fn() } as unknown as UnitOfWork;
  const posts: unknown[][] = [];
  const inbox = {
    post: async (...args: unknown[]) => {
      posts.push(args);
      return {};
    },
  };
  const notification = new NotificationService(inbox as never, uow, outbox);

  it('should hand an email to the outbox, not send it', async () => {
    added.length = 0;
    await notification.email('u1', 'welcome');
    expect(added).toEqual([
      { type: 'notification.emailRequested', payload: { userId: 'u1', template: 'welcome', data: {} }, userId: 'u1' },
    ]);
  });

  it('should post and email once per penalty.charged event, keyed by the event id', async () => {
    added.length = 0;
    posts.length = 0;
    const events = new NotificationEvents(notification);
    await events.onPenaltyCharged(
      'ev-9',
      {
        penaltyId: 'p1',
        userId: 'u1',
        habitId: 'h1',
        habitExecutionId: 'x1',
        charityId: 'c1',
        amountCents: 500,
        currency: 'USD',
        paymentIntentId: 'pi1',
        chargedAt: '2026-07-12T10:00:00Z',
      },
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toEqual(Owner.user('u1'));
    expect(posts[0]?.[1]).toMatchObject({ kind: 'penalty_charged', dedupeKey: 'penalty.charged:ev-9' });
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({
      template: 'penalty-charged',
      data: {
        Amount: '$5.00',
        HabitName: 'your habit',
        CharityName: 'your chosen charity',
        ChargeDate: '12 July 2026',
      },
    });
  });

  it('should format other currencies with the code', () => {
    expect(formatMoney(1250, 'SGD')).toBe('12.50 SGD');
  });
});
