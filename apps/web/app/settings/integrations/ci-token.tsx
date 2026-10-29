'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { createCiTokenAction, revokeCiTokenAction, type CiTokenState } from './ci-actions';

/**
 * One project's CI token: create or replace it, see it once, and copy the CI step that
 * posts results. The token lives only in this component's state after creation.
 */
export function CiTokenControl({
  projectId,
  prefix,
  lastUsed,
  baseUrl,
}: {
  projectId: string;
  prefix: string | null;
  lastUsed: string | null;
  baseUrl: string;
}) {
  const [state, action] = useActionState<CiTokenState, FormData>(createCiTokenAction, {});
  const fresh = state.projectId === projectId ? state : {};

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {prefix ? (
            <>
              Token <code>{prefix}…</code> · {lastUsed ? `last used ${lastUsed}` : 'never used yet'}
            </>
          ) : (
            'No CI token yet.'
          )}
        </span>
        <form action={action}>
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton size="sm" variant="outline" pendingLabel="Creating…">
            {prefix ? 'Replace token' : 'Create token'}
          </SubmitButton>
        </form>
        {prefix ? (
          <form action={revokeCiTokenAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <SubmitButton size="sm" variant="ghost" pendingLabel="Revoking…">
              Revoke
            </SubmitButton>
          </form>
        ) : null}
      </div>

      {fresh.error ? <p className="text-xs text-negative-ink">{fresh.error}</p> : null}

      {fresh.token ? (
        <div className="space-y-2 rounded-lg border border-warning-line bg-warning-bg p-3 text-xs">
          <p className="font-medium text-warning-ink">
            Copy this token now — it will not be shown again. Store it as the CI secret{' '}
            <code>SPECFIX_CI_TOKEN</code>.
          </p>
          <code className="block select-all break-all rounded bg-sheet px-2 py-1">
            {fresh.token}
          </code>
          <p className="text-muted-foreground">
            GitHub Actions step, after Playwright runs with the JSON reporter:
          </p>
          <pre className="overflow-x-auto rounded bg-sheet p-2 text-[11px] leading-4">{`- name: Send results to SpecFix
  if: always()
  env:
    SPECFIX_CI_TOKEN: \${{ secrets.SPECFIX_CI_TOKEN }}
    SHA: \${{ github.event.pull_request.head.sha || github.sha }}
    BRANCH: \${{ github.head_ref || github.ref_name }}
    PR: \${{ github.event.pull_request.number }}
  run: |
    jq -n --arg c "$SHA" --arg b "$BRANCH" --arg p "$PR" --arg g "$GITHUB_REPOSITORY" \\
      --arg u "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \\
      --slurpfile r results.json \\
      '{commit:$c, branch:$b, pullRequest:$p, repository:$g, runUrl:$u, report:$r[0]}' |
    curl -sf --max-time 60 -X POST "${baseUrl}/api/ci/results" \\
      -H "Authorization: Bearer $SPECFIX_CI_TOKEN" \\
      -H "Content-Type: application/json" --data-binary @-`}</pre>
        </div>
      ) : null}
    </div>
  );
}
