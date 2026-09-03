'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/** Sign in with email + password. On failure, bounce back to /login with the reason. */
export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect('/');
}

/**
 * Create an account. Whether a session is returned depends on the Supabase project's
 * email-confirmation setting: with confirmations on, the user must click a link
 * before they can sign in, so we send them back with a notice rather than to a
 * dashboard they cannot yet load.
 */
export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  if (!data.session) {
    redirect(
      '/login?message=' +
        encodeURIComponent('Account created — check your email to confirm, then sign in.')
    );
  }
  redirect('/');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
