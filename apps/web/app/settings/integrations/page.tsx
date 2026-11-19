import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  latestCiRuns,
  listCiTokens,
  listGithubInstallations,
  listGithubRepositories,
  listProjects,
} from '@/lib/repos';
import { CiTokenControl } from './ci-token';
import { GithubCard } from './github-card';
import { githubReady } from '@/lib/github';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle, EmptyNote, Notice, Pill } from '@/components/ui';

/**
 * The workspace's connections to its code: the GitHub App (pull requests linked to tasks and
 * spec tickets, the "SpecFix acceptance" check) and CI tokens (test results back from CI).
 * Tickets are written in SpecFix itself, so there is no ticket import here.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const [memberships, { error, notice }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const isAdmin = tenant.role === 'owner' || tenant.role === 'admin';
  const [projects, ciTokens, ciRuns, githubInstallations, githubRepos] = await Promise.all([
    listProjects(tenant.tenant_id, user.id),
    listCiTokens(tenant.tenant_id),
    latestCiRuns(tenant.tenant_id),
    listGithubInstallations(tenant.tenant_id),
    listGithubRepositories(tenant.tenant_id),
  ]);
  const baseUrl = (process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="integrations"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Integrations</span>
        </p>
      }
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your code: pull requests link to tasks, and CI reports which acceptance tests
          pass.
        </p>
      </div>

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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <GithubCard
            installations={githubInstallations}
            repos={githubRepos}
            projects={projects}
            isAdmin={isAdmin}
            ready={githubReady()}
          />

          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-base">CI test results</CardTitle>
              <p className="text-sm text-muted-foreground">
                Your CI posts its Playwright report, and each scenario shows whether its test
                passed. Tests are matched by the <code>@sf-…</code> tag in the generated scaffolds.
              </p>
            </CardHeader>
            <CardContent className="pt-4">
              {projects.length === 0 ? (
                <EmptyNote>No projects yet.</EmptyNote>
              ) : (
                <ul className="divide-y divide-rule rounded-lg border border-border">
                  {projects.map((p) => {
                    const token = ciTokens.find((t) => t.project_id === p.id);
                    const run = ciRuns.find((r) => r.project_id === p.id);
                    return (
                      <li key={p.id} className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium">{p.name}</span>
                          {run ? (
                            <Pill tone={run.failed > 0 ? 'negative' : 'positive'}>
                              {run.passed}/{run.total} passed
                              {run.commit_sha ? ` · ${run.commit_sha.slice(0, 7)}` : ''}
                            </Pill>
                          ) : (
                            <Pill tone="neutral">No runs yet</Pill>
                          )}
                        </div>
                        {isAdmin ? (
                          <CiTokenControl
                            projectId={p.id}
                            prefix={token?.token_prefix ?? null}
                            lastUsed={
                              token?.last_used_at
                                ? token.last_used_at.toLocaleString('en-GB')
                                : null
                            }
                            baseUrl={baseUrl}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">How it fits together</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Tasks are written here. A story or task with acceptance criteria can be sent for spec
              review from its page.
            </p>
            <p>
              A pull request links to a task when its branch, title or description names the
              task&rsquo;s key, such as <code>CART-12</code>.
            </p>
            <p>
              CI sends its Playwright report with the project&rsquo;s token. Results on the default
              branch set the ticket&rsquo;s CI status; pull-request runs show on the pull request.
            </p>
            <p>Tokens are stored hashed and are shown once, when created.</p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
