-- ---------------------------------------------------------------------------
-- 0031 — Files attached to tasks
--
--   work_item_attachments   one row per file: which task, who added it, its stored name, type
--                           and size, and where it lives in Storage. Deleting the task deletes
--                           the rows; the app removes the stored files.
--   task-attachments bucket private: no policy grants browsers anything. The app server reads
--                           and writes it with the service role, after checking the person's
--                           project role in packages/db, and hands out short-lived signed
--                           download links. 10 MB per file, and only the listed types.
--
-- The bucket part is skipped on databases without Supabase Storage (local test databases).
-- ---------------------------------------------------------------------------

begin;

create table work_item_attachments (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        not null references projects (id) on delete cascade,
  work_item_id  uuid        not null references work_items (id) on delete cascade,
  uploaded_by   uuid        references auth.users (id) on delete set null,
  file_name     text        not null check (char_length(file_name) between 1 and 120),
  content_type  text        not null check (char_length(content_type) <= 100),
  size_bytes    integer     not null check (size_bytes between 1 and 10485760),
  storage_path  text        not null unique check (char_length(storage_path) <= 300),
  created_at    timestamptz not null default now()
);

create index work_item_attachments_item_idx
  on work_item_attachments (tenant_id, work_item_id, created_at);

alter table work_item_attachments enable row level security;

create policy work_item_attachments_tenant_all on work_item_attachments for all
  using (specfix_member_of(tenant_id))
  with check (specfix_member_of(tenant_id));

commit;

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; skipping task-attachments bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'task-attachments',
    'task-attachments',
    false,
    10485760,
    array[
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
      'text/markdown', 'text/csv', 'application/json', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
  )
  on conflict (id) do nothing;
end $$;
