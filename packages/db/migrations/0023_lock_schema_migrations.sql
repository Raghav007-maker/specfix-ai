-- ---------------------------------------------------------------------------
-- 0023 — Lock the migration ledger
--
-- schema_migrations (created by packages/db/scripts/migrate.ts) is the only table in the
-- public schema without row level security. Supabase exposes the public schema through its
-- API with the anon key, so anyone could have read or rewritten the ledger and made a later
-- `npm run db:migrate` re-run or skip migrations. RLS with no policy denies every API role;
-- the migration runner connects as the table owner, which RLS does not apply to.
-- ---------------------------------------------------------------------------

begin;

alter table schema_migrations enable row level security;

commit;
