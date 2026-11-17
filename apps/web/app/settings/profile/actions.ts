'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { forgetUser, requireUser } from '@/lib/session';

/**
 * Profile settings: the display name and photo shown to the team. Both live on the user's own
 * Supabase account (user metadata), so these actions only ever change the signed-in user.
 */

function back(outcome: { error: string } | { notice: string }): never {
  redirect(`/settings/profile?${new URLSearchParams(outcome).toString()}`);
}

/** Saves the display name: 1–60 characters, spaces collapsed; empty clears it. */
export async function saveNameAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const raw = formData.get('name');
  const name = (typeof raw === 'string' ? raw : '').trim().replace(/\s+/g, ' ');
  if (name.length > 60) back({ error: 'A name can be at most 60 characters.' });
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { full_name: name || null, name: name || null },
  });
  if (error) back({ error: 'Could not save your name. Please try again.' });
  forgetUser(user.id);
  back({ notice: name ? 'Name saved.' : 'Name cleared.' });
}

/** Called after the photo changes in the browser, so the next page shows the new one. */
export async function photoChangedAction(): Promise<void> {
  const user = await requireUser();
  forgetUser(user.id);
}
