-- Profile photos.
--
-- A public `avatars` bucket in Supabase Storage: anyone can read a photo by its URL (it is shown
-- in <img>), but a signed-in user can only write inside their own folder, avatars/<user id>/.
-- The photo's URL is kept on the user's own auth metadata (avatar_url), set by the user through
-- Supabase Auth; no table here changes.
--
-- Wrapped in a check so it is a no-op on databases without Supabase Storage (local test
-- databases), where the storage schema does not exist.

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; skipping avatars bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'avatars',
    'avatars',
    true,
    2097152,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  )
  on conflict (id) do nothing;

  execute 'drop policy if exists "avatars: read own" on storage.objects';
  execute 'drop policy if exists "avatars: upload own" on storage.objects';
  execute 'drop policy if exists "avatars: update own" on storage.objects';
  execute 'drop policy if exists "avatars: delete own" on storage.objects';

  -- Reading through the public URL needs no policy; this one lets the owner list and upsert.
  execute $p$
    create policy "avatars: read own" on storage.objects for select to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
  execute $p$
    create policy "avatars: upload own" on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
  execute $p$
    create policy "avatars: update own" on storage.objects for update to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
  execute $p$
    create policy "avatars: delete own" on storage.objects for delete to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  $p$;
end
$$;
