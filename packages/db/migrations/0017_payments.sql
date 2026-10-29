-- ---------------------------------------------------------------------------
-- 0017 — Payments (pricing, Step 3: UPI)
--
-- A workspace owner or admin pays the Pro price to SpecFix's UPI ID by QR, then submits the
-- payment's 12-digit UTR. SpecFix's team checks the UTR in their bank app and approves or
-- rejects it; approving extends tenants.pro_until by the period paid for.
--
--   payments   one row per submitted payment. The amount is the server's price for the
--              period, never a posted value. A UTR is accepted once, ever, across all
--              workspaces; a workspace has at most one claim waiting at a time.
-- ---------------------------------------------------------------------------

begin;

create table payments (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  created_by    uuid        references auth.users (id) on delete set null,
  method        text        not null check (method in ('upi')),
  period        text        not null check (period in ('monthly', 'annual')),
  amount_paise  integer     not null check (amount_paise > 0),
  utr           text        not null check (utr ~ '^[0-9]{12}$'),
  status        text        not null default 'pending'
                  check (status in ('pending', 'paid', 'rejected')),
  decided_by    uuid        references auth.users (id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create unique index payments_utr on payments (utr);
create unique index payments_one_pending on payments (tenant_id) where status = 'pending';
create index payments_tenant on payments (tenant_id, created_at desc);
create index payments_by_status on payments (status, created_at desc);

alter table payments enable row level security;

create policy payments_tenant_read on payments for select using (specfix_member_of(tenant_id));

commit;
