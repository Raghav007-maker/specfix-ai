import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  EVERYONE_HANDLES,
  MAX_MESSAGE_LENGTH,
  chatTablesAvailable,
  handleOf,
  listMembers,
  listProjectMessages,
  listProjects,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { AutoRefresh } from '@/components/auto-refresh';
import { Card, CardContent, EmptyNote, Label, Notice, Textarea } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { cn } from '@/lib/cn';
import { safeAvatarUrl } from '@/lib/avatar';
import { postMessageAction } from '../../actions';
import { ProjectHeader } from '../../work-ui';

const stamp = (d: Date) =>
  new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** The first letter of an email, for the round avatar. */
const initial = (email: string | null) => (email?.trim()[0] ?? '?').toUpperCase();

/** Message text with each @mention of a member picked out; everything else stays plain text. */
function withMentions(
  body: string,
  handles: ReadonlySet<string>,
  mine: string | null
): ReactNode[] {
  return body.split(/(@[a-z0-9._%+-]+(?:@[a-z0-9.-]+\.[a-z]{2,})?)/gi).map((part, i) => {
    const handle = part.startsWith('@')
      ? part
          .slice(1)
          .replace(/[._%+-]+$/, '')
          .toLowerCase()
      : '';
    const known = handle && (handles.has(handle) || handles.has(handle.split('@')[0] ?? ''));
    if (!known) return part;
    const me = mine !== null && (handle === mine || handle.split('@')[0] === mine);
    return (
      <span
        key={i}
        className={cn(
          'rounded px-0.5 font-medium',
          me ? 'bg-warning-bg text-warning-ink' : 'bg-raised text-text'
        )}
      >
        {part}
      </span>
    );
  });
}

/**
 * A project's team conversation: everyone in the workspace can read and post. Writing
 * @name (the part of a member's email before the @) notifies that member in their inbox and
 * by email. The page refreshes itself every few seconds while open.
 */
export default async function ProjectConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [{ projectId }, { error, notice }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, ready] = await Promise.all([listProjects(t), chatTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  if (!sidebarProject) notFound();

  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      projectView="conversation"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Conversation"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="conversation"
        canManage={tenant.role !== 'reviewer'}
      />
      {children}
    </AppShell>
  );
  if (!ready) {
    return shell(
      <Notice tone="warning" title="Team conversations are not set up on this database yet">
        An admin needs to apply the latest database migration (<code>npm run db:migrate</code>).
      </Notice>
    );
  }

  const [messages, members] = await Promise.all([
    listProjectMessages(t, projectId),
    listMembers(t),
  ]);
  const handles = new Set([
    ...EVERYONE_HANDLES,
    ...members.map((m) => handleOf(m.email)).filter((h): h is string => !!h),
  ]);
  const photoOf = new Map(members.map((m) => [m.user_id, safeAvatarUrl(m.avatar_url)]));
  const avatar = (userId: string | null, email: string | null, size: string, dark: boolean) => {
    const photo = userId ? photoOf.get(userId) : null;
    return photo ? (
      <img
        src={photo}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(size, 'flex-none rounded-full object-cover')}
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          size,
          'flex flex-none items-center justify-center rounded-full text-xs font-semibold',
          dark ? 'bg-text text-sheet' : 'bg-raised text-text'
        )}
      >
        {initial(email)}
      </span>
    );
  };
  const mine = handleOf(user.email ?? null);

  return shell(
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <AutoRefresh ms={8000} />
      <div className="min-w-0 space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}

        <Card>
          <CardContent className="pt-5">
            {messages.length === 0 ? (
              <EmptyNote>
                No messages yet. Start the conversation for {sidebarProject.name} below.
              </EmptyNote>
            ) : (
              <ol className="space-y-4" aria-label="Messages">
                {messages.map((m) => {
                  const own = m.author_id === user.id;
                  return (
                    <li key={m.id} className="flex gap-3">
                      {avatar(m.author_id, m.author_email, 'h-8 w-8', own)}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-text">
                            {m.author_email ?? 'Former member'}
                            {own ? ' (you)' : ''}
                          </span>{' '}
                          ·{' '}
                          <time dateTime={new Date(m.created_at).toISOString()}>
                            {stamp(m.created_at)}
                          </time>
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5">
                          {withMentions(m.body, handles, mine)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        <form action={postMessageAction} className="space-y-2">
          <input type="hidden" name="projectId" value={projectId} />
          <Label htmlFor="message-body">Message</Label>
          <Textarea
            id="message-body"
            name="body"
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            required
            placeholder="Write to the team. @name emails that person; @all tells everyone in their inbox."
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Everyone in {tenant.tenant_name} can read this conversation.
            </p>
            <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
          </div>
        </form>
      </div>

      <Card className="h-fit">
        <CardContent className="space-y-3 pt-5">
          <h2 className="text-sm font-semibold">Team</h2>
          <p className="text-xs text-muted-foreground">
            @name in a message or task comment emails that person. @all reaches the whole team in
            their inbox only, never by email, so nobody gets spammed.
          </p>
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-2 text-sm">
                {avatar(m.user_id, m.email, 'h-7 w-7', false)}
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[13px]">
                    @{handleOf(m.email) ?? 'member'}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {m.email ?? 'Member'} · {m.role}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
