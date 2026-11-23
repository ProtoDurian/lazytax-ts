import type { EmailTemplateId } from '@lazytax/notification-contract/v1';
import { LAYOUT, TEMPLATES } from './templates';

export interface RenderedEmail {
  subject: string;
  html: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ESCAPES[c] as string);

const fill = (text: string, vars: Record<string, string>): string =>
  text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`email template variable ${name} is missing`);
    return escapeHtml(v);
  });

// Throws when a template id is unknown or a variable is missing: no `{{` ever reaches a user.
export function renderEmail(template: EmailTemplateId, vars: Record<string, string>): RenderedEmail {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown email template ${template}`);
  const body = fill(t.body, vars);
  const html = fill(
    LAYOUT.replace('{{Body}}', () => body.replaceAll('{{', '&#123;&#123;')),
    vars,
  );
  return { subject: t.subject, html };
}
