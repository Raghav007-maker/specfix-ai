import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/session';
import { SignIn } from '@/components/auth/sign-in';

export const metadata: Metadata = { title: 'Sign in · SpecFix' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  // A signed-in user has no business on the login page.
  if (await getUser()) redirect('/');

  const { error, message } = await searchParams;

  return <SignIn error={error} message={message} />;
}
