'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, UserRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import s from './playground.module.css';

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The profile photo, with a way to change it: click the avatar, pick an image, and it is stored
 * in the `avatars` bucket under the user's own folder and saved as their `avatar_url`. Without a
 * photo it shows the neutral avatar. The bucket's rules only let a user write their own folder.
 */
export function AvatarEditor({ url }: { url: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [preview, setPreview] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // A new URL from the server replaces the local preview.
  useEffect(() => {
    setPreview(null);
    setBroken(false);
  }, [url]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const shown = preview ?? (broken ? null : url);

  const upload = async (file: File) => {
    if (!TYPES.includes(file.type)) {
      setStatus({ tone: 'error', text: 'Choose a PNG, JPEG, WebP or GIF image.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ tone: 'error', text: 'That image is over 2 MB. Choose a smaller one.' });
      return;
    }
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    setStatus(null);
    try {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const user = auth.user;
      if (!user) throw new Error('Your session has ended. Sign in again to change your photo.');
      // One fixed name, so a new photo of another type replaces the old file instead of
      // leaving it behind; the stored content type tells browsers what it is.
      const path = `${user.id}/avatar`;
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
      // The query string makes browsers fetch the new image rather than a cached old one.
      const { error: metaErr } = await supabase.auth.updateUser({
        data: { avatar_url: `${pub.publicUrl}?v=${Date.now()}` },
      });
      if (metaErr) throw new Error(metaErr.message);
      setStatus({ tone: 'ok', text: 'Photo updated.' });
      router.refresh();
    } catch (err) {
      setPreview(null);
      setStatus({
        tone: 'error',
        text:
          err instanceof Error
            ? `Could not save the photo: ${err.message}`
            : 'Could not save the photo.',
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ data: { avatar_url: null } });
      if (error) throw new Error(error.message);
      setPreview(null);
      setStatus({ tone: 'ok', text: 'Photo removed.' });
      router.refresh();
    } catch (err) {
      setStatus({
        tone: 'error',
        text:
          err instanceof Error
            ? `Could not remove the photo: ${err.message}`
            : 'Could not remove the photo.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.avatarEdit}>
      <button
        type="button"
        className={s.avatar}
        data-empty={shown ? undefined : 'true'}
        aria-describedby={`${id}-status`}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => input.current?.click()}
        title="Change your photo"
      >
        {shown ? (
          // A plain img: the photo lives in Supabase Storage, which is not in next/image config.
          <img src={shown} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        ) : (
          <UserRound aria-hidden strokeWidth={1.5} />
        )}
        <span className={s.avatarCam} aria-hidden="true">
          {busy ? <span className={s.spin} /> : <Camera />}
        </span>
        <span className={s.srOnly}>{shown ? 'Change your photo' : 'Add a photo'}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={TYPES.join(',')}
        className={s.srOnly}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
      {url && !busy ? (
        <button type="button" className={s.avatarRemove} onClick={() => void remove()}>
          Remove photo
        </button>
      ) : null}
      <p
        id={`${id}-status`}
        className={s.avatarStatus}
        data-tone={status?.tone}
        role={status?.tone === 'error' ? 'alert' : 'status'}
      >
        {busy ? 'Saving your photo…' : (status?.text ?? '')}
      </p>
    </div>
  );
}
