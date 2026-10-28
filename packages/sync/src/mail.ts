/**
 * Outgoing email, behind one small interface so the transport can change (Gmail SMTP
 * today; Postmark/SES/Workspace relay later) without touching any caller.
 *
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS   Gmail: smtp.gmail.com, 465, the sender
 *                                                   address, a Google App Password
 *   MAIL_FROM                                       "SpecFix <sender@gmail.com>"
 *   MAIL_ENABLED=0                                  log instead of sending (dev, CI)
 *
 * Only the worker sends mail. A missing configuration is not an error: notifications
 * still land in the inbox, and email is simply skipped.
 */
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly kind: 'smtp' | 'log';
  send(message: MailMessage): Promise<void>;
}

export function mailerFromEnv(
  env: Record<string, string | undefined> = process.env
): Mailer | null {
  if (env.MAIL_ENABLED === '0') {
    return {
      kind: 'log',
      send: async (m) =>
        console.log(`[mail disabled] to=${m.to} subject=${JSON.stringify(m.subject)}`),
    };
  }
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.replace(/\s+/g, '');
  if (!host || !user || !pass) return null;
  const port = Number(env.SMTP_PORT ?? 465);
  const from = env.MAIL_FROM?.trim() || `SpecFix <${user}>`;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    // Never follow file paths or URLs from message content.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    kind: 'smtp',
    send: async (m) => {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

/** Where links in emails point. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (
    env.PUBLIC_BASE_URL?.trim() ||
    env.APP_BASE_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
