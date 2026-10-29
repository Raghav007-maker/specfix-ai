-- ---------------------------------------------------------------------------
-- 0018 — Razorpay payments (pricing, Step 4)
--
-- A Razorpay payment starts as an order the server creates at the price for the period
-- ('created'), and becomes 'paid' once Razorpay's signature for it checks out: from the
-- browser Checkout, or from a signed webhook, whichever comes first. A 'created' order that
-- is never paid stays as it is and blocks nothing.
--
--   payments.utr                 now only for UPI payments
--   payments.razorpay_order_id   the order; one row per order, ever
--   payments.razorpay_payment_id the payment that paid it; accepted once, ever
-- ---------------------------------------------------------------------------

begin;

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('upi', 'razorpay'));

alter table payments drop constraint payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('created', 'pending', 'paid', 'rejected'));

alter table payments alter column utr drop not null;

alter table payments add column razorpay_order_id text;
alter table payments add column razorpay_payment_id text;

alter table payments add constraint payments_method_fields check (
  (method = 'upi' and utr is not null and razorpay_order_id is null)
  or (method = 'razorpay' and utr is null and razorpay_order_id is not null)
);

create unique index payments_razorpay_order on payments (razorpay_order_id)
  where razorpay_order_id is not null;
create unique index payments_razorpay_payment on payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

commit;
