import type { GithubRepositoryRow, TicketPullRequestRow } from '@/lib/repos';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Pill,
  Select,
  type PillTone,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { openScaffoldPrAction } from './actions';

const CHECK_TONE: Record<NonNullable<TicketPullRequestRow['check_conclusion']>, PillTone> = {
  success: 'positive',
  failure: 'negative',
  neutral: 'neutral',
};

/**
 * Pull requests linked to this ticket, each with its own latest CI run and acceptance
 * check. PR runs are shown here, per PR; only default-branch runs feed the CI status
 * panel. Owners and admins can open a PR with the approved scaffolds.
 */
export function PullRequestPanel({
  ticketId,
  pulls,
  repos,
  approvedScaffolds,
  canOpen,
}: {
  ticketId: string;
  pulls: TicketPullRequestRow[];
  repos: GithubRepositoryRow[];
  approvedScaffolds: number;
  canOpen: boolean;
}) {
  if (pulls.length === 0 && repos.length === 0) return null;
  const openScaffoldPr = pulls.find((p) => p.source === 'specfix' && p.state === 'open');

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Pull requests</CardTitle>
          <span className="text-sm text-muted-foreground">
            Linked by the ticket key in a PR&rsquo;s branch, title or body
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {pulls.length === 0 ? (
          <EmptyNote>No pull request mentions this ticket yet.</EmptyNote>
        ) : (
          <ul className="divide-y divide-rule rounded-lg border border-border">
            {pulls.map((p) => (
              <li key={p.id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    {p.html_url ? (
                      <a
                        href={p.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline-offset-[3px] hover:underline"
                      >
                        {p.full_name}#{p.number}
                      </a>
                    ) : (
                      <span className="font-medium">
                        {p.full_name}#{p.number}
                      </span>
                    )}{' '}
                    <span className="text-muted-foreground">{p.title}</span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Pill tone={p.state === 'open' ? 'positive' : 'neutral'}>{p.state}</Pill>
                    {p.check_conclusion ? (
                      <Pill tone={CHECK_TONE[p.check_conclusion]}>
                        {p.check_title ?? p.check_conclusion}
                      </Pill>
                    ) : null}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  <code>{p.head_ref}</code> · {p.head_sha.slice(0, 7)}
                  {p.run_total !== null
                    ? ` · latest PR run ${p.run_passed}/${p.run_total} passed${p.run_failed ? `, ${p.run_failed} failed` : ''}${p.run_commit ? ` on ${p.run_commit.slice(0, 7)}` : ''}`
                    : ' · no CI run on this PR yet'}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canOpen && repos.length > 0 && !openScaffoldPr ? (
          <form action={openScaffoldPrAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="ticketId" value={ticketId} />
            {repos.length > 1 ? (
              <>
                <label className="sr-only" htmlFor="scaffold-repo">
                  Repository
                </label>
                <Select
                  id="scaffold-repo"
                  name="repositoryId"
                  className="w-56"
                  defaultValue={repos[0]!.id}
                >
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <input type="hidden" name="repositoryId" value={repos[0]!.id} />
            )}
            <SubmitButton
              size="sm"
              variant="outline"
              pendingLabel="Opening PR…"
              disabled={approvedScaffolds === 0}
            >
              Open PR with scaffolds
            </SubmitButton>
            <span className="text-xs text-muted-foreground">
              {approvedScaffolds === 0
                ? 'Approve a scaffold first.'
                : `Commits ${approvedScaffolds} approved scaffold${approvedScaffolds === 1 ? '' : 's'} to a specfix/ branch.`}
            </span>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
