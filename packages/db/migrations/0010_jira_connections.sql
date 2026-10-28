-- ---------------------------------------------------------------------------
-- 0010 — Jira Cloud connection (Jira integration plan, Milestone A)
--
--   1. jira_connections — one OAuth 2.0 (3LO) grant per (tenant, grant kind). The
--      read grant is what "Connect Jira" creates; the write grant is a separate,
--      later consent used only by PM sign-off (plan D3). One row per grant, not per
--      Jira site: Atlassian rotates refresh tokens, so two rows holding copies of
--      one grant would invalidate each other on the first refresh. The site the
--      tenant works in is a column, chosen after consent (cloud_id is null until
--      then). shortcut: one Jira site per tenant.
--   2. Tokens are AES-256-GCM ciphertext produced by packages/db/src/crypto.ts,
--      bound to (tenant_id, grant_kind) so a ciphertext cannot be replayed into
--      another row. key_id fingerprints the key that wrote them, so a changed
--      TOKEN_ENCRYPTION_KEY fails loudly instead of decrypting garbage.
--   3. projects learn which connection they sync through, an optional custom field
--      that holds acceptance criteria, and their sync state (used from Milestone B).
--
-- RLS: jira_connections has RLS enabled and NO policy, so no user JWT can read a
-- token row at all — only the service-role connection the repositories use.
-- ---------------------------------------------------------------------------

begin;

create table jira_connections (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  grant_kind         text        not null check (grant_kind in ('read', 'write')),
  scopes             text[]      not null,
  access_token_enc   bytea       not null,
  refresh_token_enc  bytea       not null,
  key_id             text        not null,
  expires_at         timestamptz not null,
  cloud_id           text,
  site_url           text,
  site_name          text,
  status             text        not null default 'active'
                       check (status in ('active', 'error')),
  last_error         text,
  connected_by       uuid        references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, grant_kind),
  constraint jira_connections_site_complete
    check ((cloud_id is null) = (site_url is null))
);

alter table projects
  add column jira_connection_id uuid references jira_connections (id) on delete set null,
  -- e.g. customfield_10042. Null: acceptance criteria are parsed out of the description.
  add column ac_field_id        text,
  add column last_synced_at     timestamptz,
  add column sync_status        text not null default 'idle'
    check (sync_status in ('idle', 'backfilling', 'live', 'error'));

-- A Jira project is added to a workspace at most once.
create unique index projects_jira_key_unique
  on projects (tenant_id, jira_cloud_id, jira_project_key)
  where source_type = 'jira';

alter table jira_connections enable row level security;

commit;
