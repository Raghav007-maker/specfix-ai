-- ---------------------------------------------------------------------------
-- 0014 — Notifications (Jira integration plan, Milestone E)
--
-- SpecFix is a separate site from Jira, so people have to be called back to it when
-- something needs them. Every notification is an inbox row; email is a delivery of
-- that row, decided by the recipient's preferences and a rate limit.
--
--   notifications        one row per (recipient, event). email_status records what
--                        happened to its email: pending → sent | skipped | failed.
--                        'skipped' covers both "this user only wants the digest" and
--                        the rate limit (one instant email per ticket per hour).
--   notification_prefs   per user and workspace; absent means the defaults below.
--   digest_runs          the last digest sent to each user, so it goes out once a day.
-- ---------------------------------------------------------------------------

begin;

create table notifications (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  kind          text        not null check (kind in (
                  'flags_ready', 'flags_stale', 'signed_off', 'ci_failed')),
  ticket_id     uuid        references tickets (id) on delete cascade,
  -- Short display data (ticket key, title, counts). Never ticket body text.
  payload       jsonb       not null default '{}',
  read_at       timestamptz,
  email_status  text        not null default 'pending'
                  check (email_status in ('pending', 'sent', 'skipped', 'failed')),
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index notifications_inbox on notifications (tenant_id, user_id, created_at desc);
create index notifications_email_pending on notifications (created_at) where email_status = 'pending';

create table notification_prefs (
  tenant_id      uuid    not null references tenants (id) on delete cascade,
  user_id        uuid    not null references auth.users (id) on delete cascade,
  email_instant  boolean not null default true,
  email_digest   text    not null default 'daily' check (email_digest in ('off', 'daily')),
  primary key (tenant_id, user_id)
);

create table digest_runs (
  tenant_id  uuid        not null references tenants (id) on delete cascade,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in (
  'jira_backfill', 'analyze_batch', 'jira_issue_sync', 'jira_reconcile', 'jira_webhook_sync',
  'notify_deliver', 'notify_digest'
));

alter table notifications      enable row level security;
alter table notification_prefs enable row level security;
alter table digest_runs        enable row level security;

create policy notifications_own on notifications
  for all using (user_id = auth.uid() and specfix_member_of(tenant_id))
  with check (user_id = auth.uid() and specfix_member_of(tenant_id));

create policy notification_prefs_own on notification_prefs
  for all using (user_id = auth.uid() and specfix_member_of(tenant_id))
  with check (user_id = auth.uid() and specfix_member_of(tenant_id));

commit;
