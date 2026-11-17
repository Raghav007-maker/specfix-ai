-- Minimal stand-in for the pieces of Supabase's auth schema that the SpecFix
-- schema references. Applied only against local and CI Postgres, never against a
-- real Supabase project (Supabase already provides these).
--
-- auth.uid() returns the current request's user id. Supabase derives it from the
-- JWT; here it reads a session GUC so tests can impersonate a user:
--
--   set local specfix.test_user_id = '<uuid>';

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'
);
-- A test database made before this column existed gets it too.
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}';

-- 2FA factors; Supabase's status is an enum whose verified value is 'verified'.
create table if not exists auth.mfa_factors (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status  text not null default 'unverified'
);

-- The request's JWT claims; tests set them with:
--   set local specfix.test_jwt = '{"aal":"aal2"}';
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('specfix.test_jwt', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('specfix.test_user_id', true), '')::uuid;
$$;
