'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui';
import { photoChangedAction } from './actions';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Upload or remove the signed-in user's profile photo. The file goes to the `avatars` bucket
 * under the user's own folder (the bucket's rules allow nothing else) and its URL is saved on
 * their account, so it shows in the top bar, on People and in conversations.
 */
export function ProfilePhoto({ url, initials }: { url: string | null; initials: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const shown = preview ?? url;

  const upload = async (file: File) => {
    if (!TYPES.includes(file.type)) {
      setStatus({ ok: false, text: 'Choose a PNG, JPEG or WebP image.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ ok: false, text: 'That image is over 2 MB. Choose a smaller one.' });
      return;
    }
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    setStatus(null);
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error('Your session has ended. Sign in again.');
      // One fixed name, so a new photo replaces the old file instead of piling up.
      const path = `${data.user.id}/avatar`;
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
      // The query string makes browsers fetch the new image rather than a cached one.
      const { error: metaErr } = await supabase.auth.updateUser({
        data: { avatar_url: `${pub.publicUrl}?v=${Date.now()}` },
      });
      if (metaErr) throw new Error(metaErr.message);
      setStatus({ ok: true, text: 'Photo updated.' });
      await photoChangedAction();
      router.refresh();
    } catch (err) {
      setPreview(null);
      setStatus({
        ok: false,
        text: `Could not save the photo${err instanceof Error ? `: ${err.message}` : '.'}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const { error } = await createClient().auth.updateUser({ data: { avatar_url: null } });
      if (error) throw new Error(error.message);
      setPreview(null);
      setStatus({ ok: true, text: 'Photo removed.' });
      await photoChangedAction();
      router.refresh();
    } catch (err) {
      setStatus({
        ok: false,
        text: `Could not remove the photo${err instanceof Error ? `: ${err.message}` : '.'}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-5">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-describedby={statusId}
        aria-busy={busy || undefined}
        title="Change your photo"
        className="group relative h-24 w-24 flex-none overflow-hidden rounded-full bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2"
      >
        {shown ? (
          <img
            src={shown}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center text-2xl font-semibold"
          >
            {initials}
          </span>
        )}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-center bg-text/60 text-sheet opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Camera size={16} />
        </span>
        <span className="sr-only">{shown ? 'Change your photo' : 'Add a photo'}</span>
      </button>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Saving…' : shown ? 'Change photo' : 'Upload photo'}
          </Button>
          {url ? (
            <Button type="button" variant="outline" onClick={remove} disabled={busy}>
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 2 MB.</p>
        <p
          id={statusId}
          role="status"
          className={
            status ? (status.ok ? 'text-sm text-positive' : 'text-sm text-negative') : 'sr-only'
          }
        >
          {status?.text ?? ''}
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept={TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
