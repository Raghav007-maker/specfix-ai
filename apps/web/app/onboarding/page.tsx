import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentTenant } from '@/lib/tenant';
import { createTenantAndProject } from './actions';
import Link from 'next/link';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  buttonClasses,
} from '@/components/ui';
import { profileOf } from '@/lib/dashboard';
import { WORKSPACE_FEE_PAISE } from '@specfix/shared';
import { isAppOwner } from '@/lib/plan';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; new?: string }>;
}) {
  const user = await requireUser();
  const { error, new: another } = await searchParams;
  // Already in a workspace? Nothing to onboard, unless they asked to create another.
  if (another !== '1' && (await currentTenant(user.id))) redirect('/');
  // SpecFix's own team creates workspaces free of charge.
  const fee = isAppOwner(user) ? 0 : WORKSPACE_FEE_PAISE / 100;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Create your workspace</CardTitle>
          <p className="text-sm text-muted-foreground">
            A workspace holds your projects, tickets, and review history. You&rsquo;ll be its owner.
          </p>
          {fee ? (
            <p className="mt-2 rounded-md bg-raised px-3 py-2 text-sm">
              <strong>Payment applied if you make a new workspace:</strong> ₹{fee}, once. It then
              starts on the Free plan.
            </p>
          ) : null}
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
              {fee ? `Create workspace (₹${fee})` : 'Create workspace'}
            </Button>
          </form>
          <div className="mt-4 border-t border-border pt-4 text-center">
            <Link href="/join" className={`${buttonClasses('outline')} w-full`}>
              Continue as a reviewer
            </Link>
            <p className="mt-2 text-xs text-muted-foreground">
              No charge. Join your team&rsquo;s workspace; its owner approves you.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
