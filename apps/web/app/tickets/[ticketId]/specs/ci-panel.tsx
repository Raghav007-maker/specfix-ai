import type { ScenarioCiRow, ScenarioRow } from '@/lib/repos';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Pill,
  type PillTone,
} from '@/components/ui';

const TONE: Record<ScenarioCiRow['status'], PillTone> = {
  passed: 'positive',
  failed: 'negative',
  flaky: 'warning',
  skipped: 'neutral',
};

/**
 * The latest CI outcome of each approved scenario's test: the end of the loop from
 * clarified requirement to running code. Scenarios whose test never reported (no
 * `@sf-` tag in CI yet) say so rather than counting as passed.
 */
export function CiPanel({ scenarios, rows }: { scenarios: ScenarioRow[]; rows: ScenarioCiRow[] }) {
  const approved = scenarios.filter((s) => s.status === 'approved' || s.status === 'edited');
  if (approved.length === 0) return null;
  const byScenario = new Map(rows.map((r) => [r.scenario_id, r]));
  const reported = approved.filter((s) => byScenario.has(s.id));
  const passed = reported.filter((s) => byScenario.get(s.id)!.status === 'passed').length;
  const latest = rows.reduce<ScenarioCiRow | null>(
    (a, r) => (!a || r.received_at > a.received_at ? r : a),
    null
  );

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">CI status</CardTitle>
          <span className="text-sm text-muted-foreground">
            {passed} of {approved.length} acceptance scenario(s) passing
          </span>
        </div>
        {latest ? (
          <p className="text-xs text-muted-foreground">
            Latest run {latest.received_at.toLocaleString('en-GB')}
            {latest.commit_sha ? ` · ${latest.commit_sha.slice(0, 7)}` : ''}
            {latest.branch ? ` on ${latest.branch}` : ''}
            {latest.run_url ? (
              <>
                {' · '}
                <a
                  href={latest.run_url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-[3px] hover:underline"
                >
                  open run
                </a>{' '}
                <span>({hostOf(latest.run_url)})</span>
              </>
            ) : null}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="pt-4">
        {rows.length === 0 ? (
          <EmptyNote>
            No CI results yet. Create a CI token in Settings → Integrations and post your Playwright
            report.
          </EmptyNote>
        ) : (
          <ul className="space-y-2">
            {approved.map((s) => {
              const r = byScenario.get(s.id);
              return (
                <li key={s.id} className="text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">{s.title}</span>
                    {r ? (
                      <Pill tone={TONE[r.status]}>{r.status}</Pill>
                    ) : (
                      <Pill tone="neutral">not reported</Pill>
                    )}
                  </div>
                  {r?.status === 'failed' && r.error ? (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-raised px-2 py-1 text-xs text-negative-ink">
                      {r.error}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The link's host, shown beside it so a run link to an unexpected site is visible. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}
