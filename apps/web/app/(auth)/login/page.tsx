import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/session';
import { PublicSignIn } from '@/components/public-pages';

export const metadata: Metadata = { title: 'Sign in · SpecFix' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; mode?: string }>;
}) {
  // A signed-in user has no business on the login page.
  if (await getUser()) redirect('/');

  const { error, message, mode } = await searchParams;

  return (
    <PublicSignIn
      error={error}
      message={message}
      initialMode={mode === 'sign-up' ? 'sign-up' : 'sign-in'}
    />
  );
}
