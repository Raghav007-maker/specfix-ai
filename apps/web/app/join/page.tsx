import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships } from '@/lib/tenant';
import { listMyJoinRequests, searchTeams } from '@/lib/repos';
import { Notice } from '@/components/ui';
import { FindTeam } from '../team/requests';

export const metadata: Metadata = { title: 'Join a team · SpecFix' };

/**
 * "Continue as a reviewer": find a workspace by its name and ask to join, free of charge. Its
 * owner approves; the person joins as a reviewer and can then ask to join its projects. Needs no
 * workspace of its own, so it never sends anyone to onboarding.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ find?: string; error?: string; notice?: string }>;
}) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const find = (params.find ?? '').trim().slice(0, 100);
  const [memberships, hits, mine] = await Promise.all([
    currentMemberships(user.id),
    searchTeams(user.id, find),
    listMyJoinRequests(user.id),
  ]);
  const inOpenTeam = memberships.some((m) => m.open);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Join a team as a reviewer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          No charge. Find your team by its name and ask to join; its owner approves. Then ask to
          join its projects from your dashboard, or a project admin adds you.
        </p>
      </div>
      {params.error ? <Notice tone="error">{params.error}</Notice> : null}
      {params.notice ? <Notice tone="success">{params.notice}</Notice> : null}
      <FindTeam find={find} hits={hits} mine={mine} from="join" />
      <p className="text-sm text-muted-foreground">
        {inOpenTeam ? (
          <Link href="/" className="underline underline-offset-2">
            Go to your dashboard
          </Link>
        ) : (
          <>
            Running a team yourself?{' '}
            <Link href="/onboarding?new=1" className="underline underline-offset-2">
              Create a workspace
            </Link>{' '}
            (₹25, once).
          </>
        )}
      </p>
    </main>
  );
}
