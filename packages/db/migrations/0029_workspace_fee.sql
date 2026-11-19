-- ---------------------------------------------------------------------------
-- 0029 — A new workspace opens after a one-time fee
--
--   tenants.activated_at   when the workspace opened. Every existing workspace is open (filled
--                          with now()); a workspace created from onboarding by someone outside
--                          SpecFix's team starts null and opens when its fee is paid.
--   payments.period        'workspace' is the one-time fee, beside Pro's 'monthly'/'annual'.
--
-- The seat limits (Free 5, Pro 10 admins and reviewers) need no schema: they count memberships.
-- ---------------------------------------------------------------------------

begin;

alter table tenants add column activated_at timestamptz default now();

alter table payments drop constraint payments_period_check;
alter table payments add constraint payments_period_check
  check (period in ('monthly', 'annual', 'workspace'));

commit;
