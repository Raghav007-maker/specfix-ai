/**
 * Turning inbox notifications into email (Milestone E).
 *
 *   notify_deliver  decides each pending notification's email: sent, or skipped when the
 *                   user turned instant email off, has no address, or already got an
 *                   instant email about the same ticket within the hour (the rate limit).
 *   notify_digest   once a day per user: unread notifications plus tickets whose flags
 *                   have sat open for three days.
 *
 * Mail failures never fail the job or lose the notification — it stays in the inbox, and
 * its email is marked failed so it is not retried forever.
 */
import {
  digestContent,
  dueDigestRecipients,
  pendingEmails,
  recordDigestSent,
  setEmailStatus,
  type JobRow,
  type NotificationKind,
} from '@specfix/db';
import { appBaseUrl, escapeHtml, mailerFromEnv, type Mailer, type MailMessage } from './mail.ts';

export interface NotifyDeps {
  mailer: Mailer | null;
  baseUrl: string;
}

export const defaultNotifyDeps = (): NotifyDeps => ({
  mailer: mailerFromEnv(),
  baseUrl: appBaseUrl(),
});

const HEADLINE: Record<NotificationKind, (p: Record<string, unknown>) => string> = {
  flags_ready: (p) => `${p.flags ?? 'New'} flag(s) need your decision`,
  flags_stale: (p) =>
    `The ticket changed in Jira; ${p.staled ?? 'earlier'} decision(s) need another look`,
  signed_off: () => 'Marked ready for development',
  ci_failed: (p) => `${p.failed ?? 'Some'} acceptance scenario(s) failed in CI`,
  task_assigned: (p) => `${typeof p.by === 'string' ? p.by : 'Someone'} assigned you a task`,
  task_commented: (p) => `${typeof p.by === 'string' ? p.by : 'Someone'} commented on a task`,
  mentioned: (p) => `${typeof p.by === 'string' ? p.by : 'Someone'} mentioned you`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The in-app path of a notification: its task, its project conversation, its ticket, or the
 * inbox. Ids from the payload are checked; the ticket id is the row's own foreign key. */
export function notificationPath(ticketId: string | null, p: Record<string, unknown>): string {
  const project = typeof p.projectId === 'string' && UUID.test(p.projectId) ? p.projectId : null;
  const number = typeof p.number === 'number' && Number.isSafeInteger(p.number) ? p.number : null;
  if (project && number !== null && number > 0) return `/projects/${project}/tasks/${number}`;
  const chat =
    typeof p.chatProjectId === 'string' && UUID.test(p.chatProjectId) ? p.chatProjectId : null;
  if (chat) return `/projects/${chat}/conversation`;
  return ticketId ? `/tickets/${ticketId}` : '/inbox';
}

function ticketLabel(p: Record<string, unknown>): string {
  const key = typeof p.key === 'string' ? p.key : '';
  const title = typeof p.title === 'string' ? p.title : '';
  return [key, title].filter(Boolean).join(' · ') || 'A ticket';
}

export function instantEmail(
  input: {
    to: string;
    kind: NotificationKind;
    ticketId: string | null;
    payload: Record<string, unknown>;
  },
  baseUrl: string
): MailMessage {
  const headline = HEADLINE[input.kind](input.payload);
  const ticket = ticketLabel(input.payload);
  // A mention quotes what was written, so the email makes sense on its own.
  const quote =
    input.kind === 'mentioned' && typeof input.payload.excerpt === 'string'
      ? input.payload.excerpt
      : '';
  const link = `${baseUrl}${notificationPath(input.ticketId, input.payload)}`;
  const prefs = `${baseUrl}/inbox`;
  return {
    to: input.to,
    subject: `${ticket}: ${headline}`.slice(0, 180),
    text: `${headline}\n\n${ticket}\n${quote ? `\n"${quote}"\n` : ''}\nOpen in SpecFix: ${link}\n\nChange which emails you get: ${prefs}\n`,
    html:
      `<p style="font:600 15px system-ui">${escapeHtml(headline)}</p>` +
      `<p style="font:14px system-ui">${escapeHtml(ticket)}</p>` +
      (quote
        ? `<blockquote style="font:14px system-ui;color:#333;border-left:3px solid #ddd;margin:0 0 12px;padding-left:10px">${escapeHtml(quote)}</blockquote>`
        : '') +
      `<p><a href="${escapeHtml(link)}">Open in SpecFix</a></p>` +
      `<p style="font:12px system-ui;color:#666"><a href="${escapeHtml(prefs)}">Change which emails you get</a></p>`,
  };
}

export async function runNotifyDeliver(
  job: JobRow,
  deps: NotifyDeps = defaultNotifyDeps()
): Promise<{ sent: number; skipped: number; failed: number }> {
  const tenantId = job.tenant_id;
  const progress = { sent: 0, skipped: 0, failed: 0 };
  // Decided per notification within this run too, so two events about one ticket in the
  // same batch send one email.
  const emailedNow = new Set<string>();

  for (const n of await pendingEmails(tenantId)) {
    // One email per user per ticket, task or conversation per run (and per hour, in SQL).
    const rateKey = `${n.user_id}:${n.ticket_id ?? ''}:${String(n.payload.taskId ?? '')}:${String(n.payload.chatProjectId ?? '')}`;
    if (
      !deps.mailer ||
      !n.email ||
      !n.email_instant ||
      n.recently_emailed ||
      emailedNow.has(rateKey)
    ) {
      await setEmailStatus(tenantId, n.id, 'skipped');
      progress.skipped += 1;
      continue;
    }
    try {
      await deps.mailer.send(
        instantEmail(
          { to: n.email, kind: n.kind, ticketId: n.ticket_id, payload: n.payload },
          deps.baseUrl
        )
      );
      await setEmailStatus(tenantId, n.id, 'sent');
      emailedNow.add(rateKey);
      progress.sent += 1;
    } catch {
      await setEmailStatus(tenantId, n.id, 'failed');
      progress.failed += 1;
    }
  }
  return progress;
}

export async function runNotifyDigest(
  job: JobRow,
  deps: NotifyDeps = defaultNotifyDeps()
): Promise<{ sent: number; failed: number }> {
  const progress = { sent: 0, failed: 0 };
  if (!deps.mailer) return progress;
  const recipients = (await dueDigestRecipients()).filter((r) => r.tenant_id === job.tenant_id);

  for (const r of recipients) {
    const content = await digestContent(r.tenant_id, r.user_id);
    if (content.unread.length === 0 && content.stuck.length === 0 && content.overdue.length === 0) {
      continue;
    }
    const lines = content.unread.map(
      (u) => `${ticketLabel(u.payload)} — ${HEADLINE[u.kind](u.payload)}`
    );
    const overdue = content.overdue.map(
      (o) => `${o.task_key ?? 'TASK'}-${o.number} · ${o.title} — was due ${o.due_on}`
    );
    const stuck = content.stuck.map(
      (s) => `${s.external_key} · ${s.title} — ${s.open_flags} open flag(s) for 3+ days`
    );
    const inbox = `${deps.baseUrl}/inbox`;
    const section = (title: string, items: string[]) =>
      items.length
        ? `<p style="font:600 14px system-ui">${escapeHtml(title)}</p><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
        : '';
    try {
      await deps.mailer.send({
        to: r.email,
        subject: `SpecFix daily: ${lines.length} update(s) in ${r.tenant_name}`,
        text:
          (lines.length ? `Updates:\n${lines.map((l) => `- ${l}`).join('\n')}\n\n` : '') +
          (overdue.length
            ? `Your overdue tasks:\n${overdue.map((l) => `- ${l}`).join('\n')}\n\n`
            : '') +
          (stuck.length
            ? `Waiting on decisions:\n${stuck.map((l) => `- ${l}`).join('\n')}\n\n`
            : '') +
          `Open your inbox: ${inbox}\n`,
        html:
          section('Updates', lines) +
          section('Your overdue tasks', overdue) +
          section('Waiting on decisions', stuck) +
          `<p><a href="${escapeHtml(inbox)}">Open your inbox</a> · <a href="${escapeHtml(inbox)}">Email settings</a></p>`,
      });
      await recordDigestSent(r.tenant_id, r.user_id);
      progress.sent += 1;
    } catch {
      progress.failed += 1;
    }
  }
  return progress;
}
