import { Suspense, cache } from 'react';
import {
  JiraAuthError,
  JiraHttpError,
  accessibleResources,
  listJiraProjects,
  listJiraTextFields,
  type JiraFieldSummary,
  type JiraProjectSummary,
  type JiraSite,
} from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  countAnalysisCandidates,
  getJiraConnection,
  getTenantWebhook,
  latestCiRuns,
  listGithubInstallations,
  listGithubRepositories,
  latestProjectJobs,
  listCiTokens,
  listProjects,
  tenantTokenBudget,
  type JiraConnectionRow,
  type JobRow,
  type TenantWebhookRow,
} from '@/lib/repos';
import { analyzeBatchLimit, estimateAnalysisCost, type CostEstimate } from '@specfix/sync';
import { AutoRefresh } from '@/components/auto-refresh';
import { ProjectSync } from './project-sync';
import { CiTokenControl } from './ci-token';
import { GithubCard } from './github-card';
import { githubReady } from '@/lib/github';
import { jiraAccess, jiraClientFor, jiraReady } from '@/lib/jira';
import { AppShell } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Label,
  Notice,
  Pill,
  Select,
  buttonClasses,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import { addJiraProjectAction, chooseSiteAction, disconnectJiraAction } from './actions';

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
  const [projects, connection] = await Promise.all([
    listProjects(tenant.tenant_id),
    getJiraConnection(tenant.tenant_id),
  ]);

  const isAdmin = tenant.role === 'owner' || tenant.role === 'admin';
  const jiraProjects = projects.filter((p) => p.source_type === 'jira');
  const batchLimit = analyzeBatchLimit();
  // Everything below needs only the tenant, its projects and the connection, so it is read in
  // one parallel round (it was four rounds, one after another).
  const [
    [webhook, writeGrant],
    [jobs, budget, counts, ciTokens, ciRuns, githubInstallations, githubRepos],
    estimate,
  ] = await Promise.all([
    connection
      ? Promise.all([
          getTenantWebhook(tenant.tenant_id),
          getJiraConnection(tenant.tenant_id, 'write'),
        ])
      : Promise.resolve([null, null] as const),
    Promise.all([
      latestProjectJobs(tenant.tenant_id),
      tenantTokenBudget(tenant.tenant_id),
      Promise.all(jiraProjects.map((p) => countAnalysisCandidates(tenant.tenant_id, p.id))),
      listCiTokens(tenant.tenant_id),
      latestCiRuns(tenant.tenant_id),
      listGithubInstallations(tenant.tenant_id),
      listGithubRepositories(tenant.tenant_id),
    ]),
    analysisEstimate(tenant.tenant_id, batchLimit),
  ]);
  // Live Jira reads only for the people who can act on them. They call Atlassian, so they
  // stream in under Suspense instead of holding up the rest of the page.
  const liveConnection = isAdmin ? connection : null;
  const baseUrl = (process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );
  const candidates = new Map(jiraProjects.map((p, i) => [p.id, counts[i] ?? 0]));
  const jobFor = (projectId: string, kind: JobRow['kind']) =>
    jobs.find((j) => j.project_id === projectId && j.kind === kind);
  const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');

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
          Connect the tools your team already uses, so tickets reach SpecFix without exports.
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
          <Card>
            <CardHeader className="border-b">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-base">Jira Cloud</CardTitle>
                <ConnectionPill connection={connection} />
              </div>
              <ConnectionSummary connection={connection} />
              {connection?.cloud_id ? <LiveSyncLine webhook={webhook} /> : null}
              {connection?.cloud_id ? (
                <WritebackLine grant={writeGrant} canManage={isAdmin && jiraReady()} />
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {!isAdmin ? (
                <p className="text-sm text-muted-foreground">
                  Only owners and admins can connect Jira or add Jira projects.
                </p>
              ) : !jiraReady() ? (
                <Notice tone="warning" title="Jira is not configured on this server">
                  Set <code>JIRA_CLIENT_ID</code>, <code>JIRA_CLIENT_SECRET</code>,{' '}
                  <code>JIRA_REDIRECT_URI</code> and <code>TOKEN_ENCRYPTION_KEY</code> in the root{' '}
                  <code>.env</code>, then restart the app.
                </Notice>
              ) : (
                <>
                  {liveConnection ? (
                    <Suspense fallback={null}>
                      <LiveError tenantId={tenant.tenant_id} connection={liveConnection} />
                    </Suspense>
                  ) : null}
                  <div className="flex flex-wrap gap-3">
                    {/* A plain link: the route handler redirects off-site, so no prefetch. */}
                    <a
                      href="/api/jira/connect"
                      className={buttonClasses(connection ? 'outline' : 'default')}
                    >
                      {connection ? 'Reconnect Jira' : 'Connect Jira'}
                    </a>
                    {connection ? (
                      <ConfirmSubmit
                        action={disconnectJiraAction}
                        fields={{}}
                        label="Disconnect"
                        pendingLabel="Disconnecting…"
                        title="Disconnect Jira?"
                        body="SpecFix deletes its stored Jira access. Jira projects and their tickets stay in the workspace but stop syncing until you connect again. To revoke access on Atlassian's side too, remove SpecFix under Connected apps in your Atlassian account."
                        confirmLabel="Disconnect"
                        variant="destructive"
                      />
                    ) : null}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {liveConnection && !liveConnection.cloud_id ? (
            <Suspense fallback={null}>
              <LiveSitePicker tenantId={tenant.tenant_id} connection={liveConnection} />
            </Suspense>
          ) : null}

          {connection?.cloud_id ? (
            <Card>
              <CardHeader className="border-b">
                <CardTitle className="text-base">
                  Jira projects{' '}
                  <span className="font-normal text-muted-foreground">({jiraProjects.length})</span>
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  AI usage this month:{' '}
                  <span className="font-medium tabular-nums text-text">
                    {budget.used.toLocaleString('en-US')}
                  </span>{' '}
                  of {budget.cap.toLocaleString('en-US')} tokens. Importing never uses AI; analysis
                  starts only when an admin asks.
                </p>
                {busy ? <AutoRefresh /> : null}
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                {jiraProjects.length === 0 ? (
                  <EmptyNote>No Jira projects in this workspace yet.</EmptyNote>
                ) : (
                  <ul className="divide-y divide-rule rounded-lg border border-border">
                    {jiraProjects.map((p) => (
                      <ProjectSync
                        key={p.id}
                        project={p}
                        backfill={jobFor(p.id, 'jira_backfill')}
                        analysis={jobFor(p.id, 'analyze_batch')}
                        candidates={candidates.get(p.id) ?? 0}
                        batchLimit={batchLimit}
                        estimate={estimate}
                        isAdmin={isAdmin}
                      />
                    ))}
                  </ul>
                )}
                {liveConnection ? (
                  <Suspense
                    fallback={
                      <p className="text-sm text-muted-foreground">Loading Jira projects…</p>
                    }
                  >
                    <LiveAddProject
                      tenantId={tenant.tenant_id}
                      connection={liveConnection}
                      existingKeys={jiraProjects.map((p) => p.jira_project_key)}
                    />
                  </Suspense>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

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
            <CardTitle className="text-base">How the Jira connection works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>SpecFix asks Jira for read access only: issues, users and webhooks.</p>
            <p>
              It never edits a Jira issue on its own. Writing clarified acceptance criteria back is
              a separate permission, used only when a PM signs a ticket off.
            </p>
            <p>Access tokens are stored encrypted and are never shown in the app.</p>
            <p>
              Import copies issues updated in the last 180 days. It never runs AI analysis: an admin
              starts that separately, sees the estimated cost first, and each batch is capped.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

interface LiveJira {
  sites?: JiraSite[];
  jiraProjects?: JiraProjectSummary[];
  fields?: JiraFieldSummary[];
  error?: string;
}

/** What Jira says right now. Failures become a message on the page, not a crash.
 * cache() so the three Suspense sections below share one set of Jira calls per request. */
const loadLive = cache(async function loadLive(
  tenantId: string,
  connection: JiraConnectionRow
): Promise<LiveJira> {
  try {
    if (!connection.cloud_id) {
      const { accessToken } = await jiraAccess(tenantId);
      return { sites: await accessibleResources(accessToken) };
    }
    const client = await jiraClientFor(tenantId);
    const [jiraProjects, fields] = await Promise.all([
      listJiraProjects(client),
      listJiraTextFields(client),
    ]);
    return { jiraProjects, fields };
  } catch (error) {
    if (error instanceof JiraAuthError) {
      return { error: 'Jira no longer accepts this connection. Reconnect Jira to continue.' };
    }
    if (error instanceof JiraHttpError) return { error: error.message };
    console.error('loading Jira settings failed', error);
    return { error: 'Could not reach Jira just now. Refresh to try again.' };
  }
});

interface LiveProps {
  tenantId: string;
  connection: JiraConnectionRow;
}

async function LiveError({ tenantId, connection }: LiveProps) {
  const live = await loadLive(tenantId, connection);
  return live.error ? <Notice tone="error">{live.error}</Notice> : null;
}

async function LiveSitePicker({ tenantId, connection }: LiveProps) {
  const live = await loadLive(tenantId, connection);
  return live.sites ? <SitePicker sites={live.sites} /> : null;
}

async function LiveAddProject({
  tenantId,
  connection,
  existingKeys,
}: LiveProps & { existingKeys: (string | null)[] }) {
  const live = await loadLive(tenantId, connection);
  if (!live.jiraProjects) return null;
  return (
    <AddProject
      projects={live.jiraProjects.filter((p) => !existingKeys.includes(p.key))}
      fields={live.fields ?? []}
    />
  );
}

function ConnectionPill({ connection }: { connection: JiraConnectionRow | null }) {
  if (!connection) return <Pill tone="neutral">Not connected</Pill>;
  if (connection.status === 'error') return <Pill tone="negative">Needs reconnect</Pill>;
  if (!connection.cloud_id) return <Pill tone="warning">Choose a site</Pill>;
  return <Pill tone="positive">Connected</Pill>;
}

function ConnectionSummary({ connection }: { connection: JiraConnectionRow | null }) {
  if (!connection) {
    return (
      <p className="text-sm text-muted-foreground">
        Bring Jira tickets into SpecFix automatically instead of uploading exports.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {connection.site_url ? (
        <>
          Site{' '}
          <a
            href={connection.site_url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-text underline-offset-[3px] hover:underline"
          >
            {connection.site_name ?? connection.site_url}
          </a>
        </>
      ) : (
        'No site chosen yet'
      )}
      {connection.connected_by_email ? <> · connected by {connection.connected_by_email}</> : null}
    </p>
  );
}

function SitePicker({ sites }: { sites: JiraSite[] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-base">Choose a Jira site</CardTitle>
        <p className="text-sm text-muted-foreground">
          This Atlassian account can reach more than one site. SpecFix syncs from one.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {sites.length === 0 ? (
          <EmptyNote>This Atlassian account cannot see any Jira site.</EmptyNote>
        ) : (
          <form action={chooseSiteAction} className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="sr-only">Jira site</legend>
              {sites.map((site, i) => (
                <label
                  key={site.cloudId}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm hover:border-field"
                >
                  <input
                    type="radio"
                    name="cloudId"
                    value={site.cloudId}
                    defaultChecked={i === 0}
                    required
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{site.name}</span>
                    <span className="block truncate text-muted-foreground">{site.url}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <SubmitButton pendingLabel="Saving…">Use this site</SubmitButton>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function AddProject({
  projects,
  fields,
}: {
  projects: JiraProjectSummary[];
  fields: JiraFieldSummary[];
}) {
  if (projects.length === 0) {
    return <EmptyNote>Every Jira project this connection can see is already added.</EmptyNote>;
  }
  return (
    <form action={addJiraProjectAction} className="space-y-3 border-t border-rule pt-4">
      <p className="text-sm font-medium">Add a Jira project</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="projectKey">Project</Label>
          <Select id="projectKey" name="projectKey" required defaultValue="">
            <option value="" disabled>
              Choose a project
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} · {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acFieldId">Acceptance criteria field</Label>
          <Select id="acFieldId" name="acFieldId" defaultValue="">
            <option value="">Inside the description</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        If your team keeps acceptance criteria in their own Jira field, choose it. Otherwise SpecFix
        reads them from an &ldquo;Acceptance criteria&rdquo; heading in the description.
      </p>
      <SubmitButton pendingLabel="Adding…">Add project</SubmitButton>
    </form>
  );
}

/** The cost of a full batch, or null when no analysis model is configured on this server. */
async function analysisEstimate(tenantId: string, tickets: number): Promise<CostEstimate | null> {
  try {
    return await estimateAnalysisCost(tenantId, tickets);
  } catch {
    return null;
  }
}

/** How changes in Jira reach SpecFix after the first import. */
function LiveSyncLine({ webhook }: { webhook: TenantWebhookRow | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      {webhook
        ? `Live sync: Jira sends changes instantly (webhook active until ${webhook.expires_at.toLocaleDateString('en-GB')}, renewed automatically).`
        : 'Live sync: SpecFix checks Jira for changes every few minutes. Instant updates need a public HTTPS address (PUBLIC_BASE_URL).'}
    </p>
  );
}

/** Whether PM sign-off writes back to Jira, and the one-time consent that enables it. */
function WritebackLine({
  grant,
  canManage,
}: {
  grant: JiraConnectionRow | null;
  canManage: boolean;
}) {
  if (grant && grant.status === 'active') {
    return (
      <p className="text-xs text-muted-foreground">
        Write-back: on. When a PM marks a ticket ready, SpecFix adds a comment with the clarified
        acceptance criteria and a <code>specfix-ready</code> label to the Jira issue.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>
        {grant
          ? 'Write-back: Jira no longer accepts the write permission.'
          : 'Write-back: off. Sign-off stays inside SpecFix.'}
      </span>
      {canManage ? (
        // A plain link: the route handler redirects to Atlassian's consent screen.
        <a href="/api/jira/connect?grant=write" className={buttonClasses('outline', 'sm')}>
          {grant ? 'Reconnect write-back' : 'Enable write-back'}
        </a>
      ) : null}
    </div>
  );
}
