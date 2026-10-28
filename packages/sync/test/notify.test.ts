/**
 * Notifications: who receives what, email delivery rules, and the digest.
 * The DB suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  closePool,
  createProject,
  createTenant,
  digestContent,
  ingestTicket,
  listNotifications,
  markNotificationsRead,
  notifyTicketEvent,
  query,
  setNotificationPrefs,
  type JobRow,
} from '@specfix/db';
import {
  instantEmail,
  mailerFromEnv,
  runNotifyDeliver,
  runNotifyDigest,
  type MailMessage,
  type Mailer,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('mail helpers', () => {
  it('is off without SMTP settings, logs when disabled, and sends via SMTP when configured', () => {
    expect(mailerFromEnv({})).toBeNull();
    expect(mailerFromEnv({ MAIL_ENABLED: '0' })?.kind).toBe('log');
    expect(
      mailerFromEnv({
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_USER: 'a@gmail.com',
        SMTP_PASS: 'abcd efgh ijkl mnop',
      })?.kind
    ).toBe('smtp');
  });

  it('escapes ticket text in the HTML body', () => {
    const mail = instantEmail(
      {
        to: 'pm@example.test',
        kind: 'flags_ready',
        ticketId: 't1',
        payload: { key: 'CART-1', title: '<script>x</script>', flags: 2 },
      },
      'https://specfix.example.com'
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('https://specfix.example.com/tickets/t1');
    expect(mail.subject).toContain('2 flag(s) need your decision');
  });
});

describe.skipIf(!hasDatabase)('notifications', () => {
  const label = `notify-${Date.now()}`;
  let tenantId: string;
  let ticketId: string;
  let otherTicketId: string;
  const users = {} as Record<'owner' | 'admin' | 'reviewer', string>;
  const sent: MailMessage[] = [];
  const mailer: Mailer = { kind: 'smtp', send: async (m) => void sent.push(m) };
  const job = (): JobRow =>
    ({ id: '0', tenant_id: tenantId, kind: 'notify_deliver', payload: {}, progress: {} }) as JobRow;

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      const [u] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${role}@example.test`]
      );
      users[role] = u!.id;
      await addMembership(tenantId, u!.id, role);
    }
    const project = await createProject(tenantId, { name: 'P', sourceType: 'file' });
    const make = async (id: string) =>
      (
        await ingestTicket(tenantId, project.id, {
          externalId: id,
          externalKey: id,
          title: `Ticket ${id}`,
          descriptionText: 'x',
          acceptanceCriteriaText: '',
          raw: null,
          sourceUpdatedAt: null,
        })
      ).ticket.id;
    ticketId = await make('N-1');
    otherTicketId = await make('N-2');
  });

  it('sends decision events to owners and admins, and sign-off to everyone but the actor', async () => {
    expect(
      await notifyTicketEvent(tenantId, { kind: 'flags_ready', ticketId, details: { flags: 3 } })
    ).toBe(2);
    expect(
      await notifyTicketEvent(tenantId, { kind: 'signed_off', ticketId, actorId: users.owner })
    ).toBe(2);
    const reviewer = await listNotifications(tenantId, users.reviewer);
    expect(reviewer.map((n) => n.kind)).toEqual(['signed_off']);
    expect(reviewer[0]!.payload).toMatchObject({ key: 'N-1', title: 'Ticket N-1' });
  });

  it('emails at most once per ticket per hour, and respects preferences', async () => {
    await setNotificationPrefs(tenantId, users.admin, {
      email_instant: false,
      email_digest: 'daily',
    });
    const progress = await runNotifyDeliver(job(), { mailer, baseUrl: 'https://s.example' });
    // owner: flags_ready sent, signed_off is the same ticket within the hour → skipped
    // admin: instant email off → both skipped; reviewer: signed_off sent
    expect(progress).toEqual({ sent: 2, skipped: 2, failed: 0 });
    expect(sent.map((m) => m.to).sort()).toEqual([
      `${label}-owner@example.test`,
      `${label}-reviewer@example.test`,
    ]);

    await notifyTicketEvent(tenantId, { kind: 'flags_ready', ticketId: otherTicketId });
    const next = await runNotifyDeliver(job(), { mailer, baseUrl: 'https://s.example' });
    expect(next.sent).toBe(1); // a different ticket is not rate-limited
  });

  it('marks email failed, never the notification lost, when the mail server refuses', async () => {
    await notifyTicketEvent(tenantId, {
      kind: 'flags_stale',
      ticketId: otherTicketId,
      details: { staled: 1 },
    });
    await query(
      `update notifications set emailed_at = now() - interval '2 hours' where tenant_id = $1`,
      [tenantId]
    );
    const broken: Mailer = {
      kind: 'smtp',
      send: async () => Promise.reject(new Error('535 auth failed')),
    };
    const progress = await runNotifyDeliver(job(), {
      mailer: broken,
      baseUrl: 'https://s.example',
    });
    expect(progress.failed).toBeGreaterThan(0);
    expect(
      (await listNotifications(tenantId, users.owner)).some((n) => n.kind === 'flags_stale')
    ).toBe(true);
  });

  it('sends one daily digest of unread updates per user', async () => {
    await markNotificationsRead(tenantId, users.reviewer, null);
    expect((await digestContent(tenantId, users.owner)).unread.length).toBeGreaterThan(0);
    sent.length = 0;
    const first = await runNotifyDigest(job(), { mailer, baseUrl: 'https://s.example' });
    expect(first.sent).toBe(2); // owner and admin have unread; the reviewer read everything
    expect(sent.every((m) => m.subject.startsWith('SpecFix daily:'))).toBe(true);
    const second = await runNotifyDigest(job(), { mailer, baseUrl: 'https://s.example' });
    expect(second.sent).toBe(0);
  });
});
