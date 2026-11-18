import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentTenant } from '@/lib/tenant';
import { createTenantAndProject } from './actions';
import Link from 'next/link';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { profileOf } from '@/lib/dashboard';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  // Already in a tenant? Nothing to onboard.
  if (await currentTenant(user.id)) redirect('/');

  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Create your workspace</CardTitle>
          <p className="text-sm text-muted-foreground">
            A workspace holds your projects, tickets, and review history. You&rsquo;ll be its owner.
          </p>
        </CardHeader>
        <CardContent>
          <form action={createTenantAndProject} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="personName">Your name</Label>
              <Input
                id="personName"
                name="personName"
                maxLength={60}
                autoComplete="name"
                defaultValue={profileOf(user, null).name ?? ''}
                placeholder="How your team will find you"
              />
              <p className="text-xs text-muted-foreground">
                Optional. You can set it later, with a profile photo, in{' '}
                <Link href="/settings/profile" className="underline underline-offset-2">
                  Settings → Profile
                </Link>
                .
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tenant">Workspace name</Label>
              <Input id="tenant" name="tenant" placeholder="Acme Product" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project">First project</Label>
              <Input id="project" name="project" placeholder="Default project" />
            </div>

            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" className="w-full">
              Create workspace
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
