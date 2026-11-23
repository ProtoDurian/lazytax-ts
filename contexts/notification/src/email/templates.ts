// The email templates (LazyTax App/Templates/Email, rendered there from React to Handlebars).
// Here each is a small HTML body with {{Token}} holes inside one shared layout. Subjects match
// LazyTax's EmailTemplates.cs.
import type { EmailTemplateId } from '@lazytax/notification-contract/v1';

export interface EmailTemplate {
  subject: string;
  // HTML between the header and the footer. {{Token}} is HTML-escaped when filled.
  body: string;
  // Variables the caller supplies (BaseUrl, UserName and SupportEmail are always filled in).
  vars: readonly string[];
}

export const TEMPLATES: Record<EmailTemplateId, EmailTemplate> = {
  'penalty-charged': {
    subject: 'Your LazyTax habit stake receipt',
    vars: ['Amount', 'CharityName', 'HabitName', 'ChargeDate'],
    body: '<p>You missed <b>{{HabitName}}</b>, so your stake of <b>{{Amount}}</b> was charged on {{ChargeDate}} and goes to {{CharityName}}.</p>',
  },
  'penalty-payment-failed': {
    subject: "We couldn't process your stake",
    vars: ['Amount', 'CharityName', 'HabitName', 'AttemptDate'],
    body: "<p>You missed <b>{{HabitName}}</b>, but we couldn't charge your stake of <b>{{Amount}}</b> for {{CharityName}} on {{AttemptDate}}. Check your payment method.</p>",
  },
  'subscription-receipt': {
    subject: 'Your LazyTax receipt',
    vars: ['Tier', 'Amount', 'ChargeDate', 'NextBillingDate'],
    body: '<p>Thanks! We charged {{Amount}} for your <b>{{Tier}}</b> plan on {{ChargeDate}}. Your next billing date is {{NextBillingDate}}.</p>',
  },
  'subscription-payment-failed': {
    subject: 'Payment failed — your plan needs attention',
    vars: ['Tier', 'Amount', 'GraceEndsDate'],
    body: "<p>We couldn't collect {{Amount}} for your <b>{{Tier}}</b> plan. Update your payment method before {{GraceEndsDate}} to keep it.</p>",
  },
  'subscription-cancelled': {
    subject: 'Your subscription change is confirmed',
    vars: ['ChangeSummary', 'EffectiveDate'],
    body: '<p>Your subscription change ({{ChangeSummary}}) takes effect on {{EffectiveDate}}.</p>',
  },
  welcome: {
    subject: "Welcome to LazyTax — let's build habits that stick",
    vars: [],
    body: '<p>Welcome to LazyTax! Pick a habit, set a stake, and let us keep you honest.</p>',
  },
  'payment-consent-changed': {
    subject: 'Your payment method changed',
    vars: ['ChangeSummary', 'Purpose', 'ChangeDate'],
    body: '<p>{{ChangeSummary}} for <b>{{Purpose}}</b> on {{ChangeDate}}.</p>',
  },
  'member-thank-you': {
    subject: 'Thank you for being a LazyTax member',
    vars: ['MemberSince', 'MembershipType'],
    body: '<p>Thank you for being a {{MembershipType}} member since {{MemberSince}}.</p>',
  },
  'verification-code': {
    subject: 'Your LazyTax verification code',
    vars: ['Code'],
    body: '<p>Your verification code is <b>{{Code}}</b>.</p>',
  },
};

export const LAYOUT = `<!doctype html><html><body>
<img src="{{BaseUrl}}/images/email/logo.png" alt="LazyTax" width="120">
<p>Hi {{UserName}},</p>
{{Body}}
<p>Questions? Write to <a href="mailto:{{SupportEmail}}">{{SupportEmail}}</a>.</p>
</body></html>`;
