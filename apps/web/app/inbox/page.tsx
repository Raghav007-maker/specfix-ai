import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  getNotificationPrefs,
  listNotifications,
  listProjects,
  type NotificationRow,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Notice,
  Pill,
  type PillTone,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { markAllReadAction, markReadAction, savePrefsAction } from './actions';

const KIND: Record<NotificationRow['kind'], { label: string; tone: PillTone }> = {
  flags_ready: { label: 'New flags', tone: 'warning' },
  flags_stale: { label: 'Changed in Jira', tone: 'accent' },
  signed_off: { label: 'Ready for dev', tone: 'positive' },
  ci_failed: { label: 'CI failed', tone: 'negative' },
};

function describe(n: NotificationRow): string {
  const p = n.payload;
  switch (n.kind) {
    case 'flags_ready':
      return `${p.flags ?? 'New'} flag(s) need a decision.`;
    case 'flags_stale':
      return `The ticket changed in Jira, so ${p.staled ?? 'earlier'} decision(s) need another look.`;
    case 'signed_off':
      return 'Marked ready for development.';
    case 'ci_failed':
      return `${p.failed ?? 'Some'} of ${p.total ?? '?'} acceptance scenario(s) failed in CI.`;
  }
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await requireUser();
  const [memberships, { saved }] = await Promise.all([currentMemberships(user.id), searchParams]);
  const tenant = await requireTenant(user.id, memberships);
  const [projects, notifications, prefs] = await Promise.all([
    listProjects(tenant.tenant_id),
    listNotifications(tenant.tenant_id, user.id),
    getNotificationPrefs(tenant.tenant_id, user.id),
  ]);
  const unread = notifications.filter((n) => !n.read_at).length;

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="inbox"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Inbox</span>
        </p>
      }
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">Inbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What changed on tickets you decide on.{' '}
          {unread > 0 ? `${unread} unread.` : 'All caught up.'}
        </p>
      </div>

      {saved ? (
        <Notice tone="success" className="mb-6">
          Email settings saved.
        </Notice>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Notifications</CardTitle>
              {unread > 0 ? (
                <form action={markAllReadAction}>
                  <SubmitButton size="sm" variant="ghost" pendingLabel="Marking…">
                    Mark all read
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </CardHeader>
          {notifications.length === 0 ? (
            <CardContent className="pt-4">
              <EmptyNote>Nothing yet. You will hear here when tickets need you.</EmptyNote>
            </CardContent>
          ) : (
            <ul className="divide-y divide-rule">
              {notifications.map((n) => {
                const key = typeof n.payload.key === 'string' ? n.payload.key : '';
                const title = typeof n.payload.title === 'string' ? n.payload.title : '';
                return (
                  <li key={n.id} className={n.read_at ? 'opacity-70' : undefined}>
                    <form action={markReadAction} className="flex items-start gap-3 px-4 py-3">
                      <input type="hidden" name="id" value={n.id} />
                      <input
                        type="hidden"
                        name="to"
                        value={n.ticket_id ? `/tickets/${n.ticket_id}` : ''}
                      />
                      <span className="mt-0.5 flex-none">
                        <Pill tone={KIND[n.kind].tone}>{KIND[n.kind].label}</Pill>
                      </span>
                      <button type="submit" className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium">
                          {key ? <span className="font-mono text-[13px]">{key}</span> : null}
                          {key && title ? ' · ' : null}
                          {title}
                        </span>
                        <span className="block text-sm text-muted-foreground">{describe(n)}</span>
                      </button>
                      <span className="flex-none text-xs tabular-nums text-muted-foreground">
                        {n.created_at.toLocaleString('en-GB', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={savePrefsAction} className="space-y-3 text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="email_instant"
                  defaultChecked={prefs.email_instant}
                  className="mt-1"
                />
                <span>
                  Email me right away
                  <span className="block text-xs text-muted-foreground">
                    At most one email per ticket per hour.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="email_digest"
                  defaultChecked={prefs.email_digest === 'daily'}
                  className="mt-1"
                />
                <span>
                  Daily summary
                  <span className="block text-xs text-muted-foreground">
                    Unread updates and tickets waiting 3+ days on a decision.
                  </span>
                </span>
              </label>
              <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
                Save
              </SubmitButton>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
