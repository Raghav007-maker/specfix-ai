import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import { listProjects } from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Notice,
  RoleBadge,
  linkClasses,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { initialsOf, safeAvatarUrl } from '@/lib/avatar';
import { saveNameAction } from './actions';
import { ProfilePhoto } from './photo';

/** The signed-in user's profile: photo, display name, and the projects of their workspace. */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [user, { error, notice }] = await Promise.all([requireUser(), searchParams]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const projects = await listProjects(tenant.tenant_id);

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta.name === 'string' && meta.name.trim()) ||
    '';
  const photo = safeAvatarUrl(
    (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
      (typeof meta.picture === 'string' && meta.picture) ||
      null
  );

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      breadcrumb={<p className="text-sm text-muted-foreground">Profile</p>}
    >
      <h1 className="mb-1 text-2xl font-semibold tracking-[-0.012em]">Profile</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        How you appear to your team: in the top bar, on People and in conversations.
      </p>
      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      <div className="grid max-w-4xl gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Photo</CardTitle>
            </CardHeader>
            <CardContent>
              <ProfilePhoto url={photo} initials={initialsOf(name || user.email)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Name</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={saveNameAction} className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="profile-name">Display name</Label>
                  <Input
                    id="profile-name"
                    name="name"
                    defaultValue={name}
                    maxLength={60}
                    autoComplete="name"
                    placeholder="Your name"
                  />
                </div>
                <SubmitButton pendingLabel="Saving…">Save name</SubmitButton>
              </form>
              <p className="mt-2 text-xs text-muted-foreground">
                Email: {user.email} · People mention you as @{(user.email ?? '').split('@')[0]}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              My projects{' '}
              <span className="font-normal tabular-nums text-muted-foreground">
                {projects.length}
              </span>
            </CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {tenant.tenant_name} <RoleBadge role={tenant.role} />
            </div>
          </CardHeader>
          <CardContent>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">No projects yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link href={`/projects/${p.id}`} className={linkClasses}>
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
