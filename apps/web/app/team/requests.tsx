import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import type {
  JoinRequestRow,
  JoinableProjectRow,
  MyRequestRow,
  ProjectRequestRow,
  TeamHit,
} from '@/lib/repos';
import {
  decideJoinAction,
  decideProjectAction,
  requestJoinAction,
  requestProjectAction,
  requestProjectJoinAction,
} from './actions';

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

/** Search teams by name and ask to join one. Open to everyone signed in. */
export function FindTeam({
  find,
  hits,
  mine,
}: {
  find: string;
  hits: TeamHit[];
  mine: MyRequestRow[];
}) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Find a team</CardTitle>
        <p className="text-sm text-muted-foreground">
          Search a team by its name and ask to join. Its owner decides; after that a project admin
          adds you to projects.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form method="get" role="search" className="flex gap-2">
          <Input
            type="search"
            name="find"
            defaultValue={find}
            minLength={3}
            maxLength={100}
            aria-label="Team name"
            placeholder="Team name (at least 3 letters)"
            autoComplete="off"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {find ? (
          hits.length === 0 ? (
            <EmptyNote>No team matches “{find}”.</EmptyNote>
          ) : (
            <ul className="divide-y divide-rule text-sm">
              {hits.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                  {h.requested ? (
                    <span className="text-xs text-muted-foreground">Request sent</span>
                  ) : (
                    <form action={requestJoinAction}>
                      <input type="hidden" name="tenantId" value={h.id} />
                      <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                        Ask to join
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
        {mine.length > 0 ? (
          <ul className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
            {mine.map((r) => (
              <li key={r.id}>
                {r.tenant_name} · {r.status} · {WHEN.format(r.created_at)}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Decide({
  action,
  requestId,
}: {
  action: (formData: FormData) => Promise<void>;
  requestId: string;
}) {
  return (
    <div className="flex gap-2">
      {(['approve', 'reject'] as const).map((decision) => (
        <form key={decision} action={action}>
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="decision" value={decision} />
          <SubmitButton
            size="sm"
            variant={decision === 'approve' ? 'outline' : 'ghost'}
            pendingLabel="…"
          >
            {decision === 'approve' ? 'Approve' : 'Reject'}
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}

/** Owner: people asking to join this team, and admins asking for projects. */
export function OwnerRequests({
  joins,
  projects,
}: {
  joins: JoinRequestRow[];
  projects: ProjectRequestRow[];
}) {
  const pending = projects.filter((p) => p.status === 'pending');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">
          Requests{' '}
          <span className="font-normal tabular-nums text-muted-foreground">
            {joins.length + pending.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {joins.length + pending.length === 0 ? (
          <EmptyNote>Nobody is waiting for you.</EmptyNote>
        ) : (
          <ul className="divide-y divide-rule text-sm">
            {joins.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{r.email ?? 'Someone'}</span> wants to join the team
                </span>
                <Decide action={decideJoinAction} requestId={r.id} />
              </li>
            ))}
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{r.email ?? 'An admin'}</span> asks for project “
                  {r.name}”
                </span>
                <Decide action={decideProjectAction} requestId={r.id} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Admin: ask the owner for a new project, and see how earlier requests went. */
export function RequestProject({ mine }: { mine: ProjectRequestRow[] }) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Ask for a project</CardTitle>
        <p className="text-sm text-muted-foreground">
          The owner approves it; then it is created and you are its admin.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={requestProjectAction} className="flex gap-2">
          <Input
            name="name"
            required
            maxLength={100}
            aria-label="Project name"
            placeholder="Project name"
            autoComplete="off"
          />
          <SubmitButton variant="outline" pendingLabel="Sending…">
            Send to owner
          </SubmitButton>
        </form>
        {mine.length > 0 ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {mine.slice(0, 5).map((r) => (
              <li key={r.id}>
                {r.name} · {r.status}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A team member: projects of this workspace they are not in, to ask the project admin. */
export function JoinProjects({ projects }: { projects: JoinableProjectRow[] }) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Join a project</CardTitle>
        <p className="text-sm text-muted-foreground">
          Ask to join a project of this team. Its admin decides; you join as a reviewer.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-rule text-sm">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              {p.requested ? (
                <span className="text-xs text-muted-foreground">Request sent</span>
              ) : (
                <form action={requestProjectJoinAction}>
                  <input type="hidden" name="projectId" value={p.id} />
                  <SubmitButton size="sm" variant="outline" pendingLabel="Sending…">
                    Ask to join
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
