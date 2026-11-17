-- ---------------------------------------------------------------------------
-- 0024 — Two-factor sign-in enforced by row level security too
--
-- The app's pages already send a user who has 2FA but has not entered the code this session
-- (an aal1 session) to /login/verify. A request made straight to Supabase's API with that
-- aal1 token skipped the check. Every tenant policy goes through specfix_member_of(), so it
-- now also requires: the session is aal2, or the user has no verified 2FA factor at all
-- (people without 2FA keep working exactly as before).
--
-- The app server itself connects as the database owner, which RLS does not apply to, so
-- nothing the app does changes. Supabase provides auth.jwt() and auth.mfa_factors.
-- ---------------------------------------------------------------------------

begin;

create or replace function specfix_mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;

create or replace function specfix_member_of(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select specfix_mfa_satisfied() and exists (
    select 1 from memberships m
    where m.tenant_id = target_tenant
      and m.user_id = auth.uid()
  );
$$;

commit;
