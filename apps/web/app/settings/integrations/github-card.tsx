import type { GithubInstallationRow, GithubRepositoryRow, ProjectRow } from '@/lib/repos';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Notice,
  Pill,
  Select,
  buttonClasses,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import { disconnectGithubAction, mapGithubRepoAction } from './github-actions';

/**
 * The GitHub App: connect it, and map each repository it can reach to a SpecFix project.
 * A mapped repository's PRs are linked to that project's tickets, its default branch
 * decides which CI runs set a ticket's status, and scaffold PRs are opened in it.
 */
export function GithubCard({
  installations,
  repos,
  projects,
  isAdmin,
  ready,
}: {
  installations: GithubInstallationRow[];
  repos: GithubRepositoryRow[];
  projects: ProjectRow[];
  isAdmin: boolean;
  ready: boolean;
}) {
  const connected = installations.length > 0;
  const suspended = installations.some((i) => i.suspended_at);

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">GitHub</CardTitle>
          {!connected ? (
            <Pill tone="neutral">Not connected</Pill>
          ) : suspended ? (
            <Pill tone="warning">Suspended</Pill>
          ) : (
            <Pill tone="positive">Connected</Pill>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {connected
            ? `Installed on ${installations.map((i) => i.account_login).join(', ')}. PRs that name a ticket key get a “SpecFix acceptance” check, and a warning while the ticket is not ready.`
            : 'Link pull requests to tickets, report acceptance results as a PR check, and open PRs with approved scaffolds.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {!isAdmin ? (
          connected ? null : (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can connect GitHub.
            </p>
          )
        ) : !ready ? (
          <Notice tone="warning" title="GitHub is not configured on this server">
            Set the <code>GITHUB_APP_*</code> variables, <code>GITHUB_WEBHOOK_SECRET</code> and{' '}
            <code>TOKEN_ENCRYPTION_KEY</code> in the root <code>.env</code> (see{' '}
            <code>docs/github-app.md</code>), then restart the app.
          </Notice>
        ) : (
          <div className="flex flex-wrap gap-3">
            {/* A plain link: the route handler redirects to GitHub. */}
            <a
              href="/api/github/install"
              className={buttonClasses(connected ? 'outline' : 'default')}
            >
              {connected ? 'Add or change repositories' : 'Connect GitHub'}
            </a>
            {connected ? (
              <ConfirmSubmit
                action={disconnectGithubAction}
                fields={{}}
                label="Disconnect"
                pendingLabel="Disconnecting…"
                title="Disconnect GitHub?"
                body="SpecFix forgets the installation, its repositories, PR links and check-run records. To revoke access on GitHub too, uninstall the app under your GitHub settings → Applications."
                confirmLabel="Disconnect"
                variant="destructive"
              />
            ) : null}
          </div>
        )}

        {connected ? (
          repos.length === 0 ? (
            <EmptyNote>The app cannot reach any repository yet.</EmptyNote>
          ) : (
            <ul className="divide-y divide-rule rounded-lg border border-border">
              {repos.map((repo) => (
                <li
                  key={repo.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{repo.full_name}</span>
                    <span className="block text-xs text-muted-foreground">
                      default branch <code>{repo.default_branch}</code>
                    </span>
                  </span>
                  {isAdmin ? (
                    <form action={mapGithubRepoAction} className="flex items-center gap-2">
                      <input type="hidden" name="repositoryId" value={repo.id} />
                      <label className="sr-only" htmlFor={`project-${repo.id}`}>
                        Project for {repo.full_name}
                      </label>
                      <Select
                        id={`project-${repo.id}`}
                        name="projectId"
                        defaultValue={repo.project_id ?? ''}
                        className="w-48"
                      >
                        <option value="">Not mapped</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                      <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
                        Save
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {projects.find((p) => p.id === repo.project_id)?.name ?? 'Not mapped'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
