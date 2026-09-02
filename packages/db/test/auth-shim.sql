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
  email text unique
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('specfix.test_user_id', true), '')::uuid;
$$;
