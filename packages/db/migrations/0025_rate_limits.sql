-- ---------------------------------------------------------------------------
-- 0025 — Rate limits shared by every app server
--
-- Sign-in, sign-up, 2FA codes and team messages were limited in each server's memory, so
-- with two servers an attacker got twice the attempts, and a restart reset them. One row per
-- limited thing, counted with an upsert, so every server sees the same count.
--
--   key   sha256 of "<bucket>:<ip, email or user id>" — never the raw IP or email.
--
-- No tenant_id, deliberately: sign-in and sign-up are limited before anyone has a workspace.
-- RLS is on with no policy, so Supabase's API roles cannot read or reset the counters; the
-- app server connects as the owner.
-- ---------------------------------------------------------------------------

begin;

create table rate_limits (
  key           text        primary key check (key ~ '^[0-9a-f]{64}$'),
  window_start  timestamptz not null default now(),
  hits          integer     not null default 0
);

create index rate_limits_window_idx on rate_limits (window_start);

alter table rate_limits enable row level security;

commit;
