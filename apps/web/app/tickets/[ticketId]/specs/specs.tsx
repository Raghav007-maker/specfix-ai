import {
  FLAG_CATEGORY_LABELS,
  driftVerdict,
  type ClauseCoverageRow,
  type ClauseCoverageStatus,
  type DriftVerdict,
} from '@specfix/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from '@/components/ui';
import type {
  CoverageCounts,
  DriftedScenario,
  ScaffoldRow,
  ScenarioRow,
  ScenarioReviewDetailRow,
  UntestedFlag,
} from '@/lib/repos';
import {
  decideScaffoldAction,
  decideScenarioAction,
  emitScaffoldAction,
  generateScenarios,
} from './actions';

/**
 * The generate control. It is only a button: generation is gated server-side on the
 * version being marked ready, and this surfaces that gate rather than re-checking it.
 */
export function GenerationPanel({
  ticketId,
  ready,
  hasScenarios,
  resolvedFlagCount,
}: {
  ticketId: string;
  ready: boolean;
  hasScenarios: boolean;
  resolvedFlagCount: number;
}) {
  if (!ready) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Not ready to generate</CardTitle>
          <p className="text-sm text-muted-foreground">
            Scenarios are compiled from the approved requirement. Resolve every flag and mark this
            ticket ready for development on the Review tab first — generation keys off that
            sign-off, not off the raw ticket.
          </p>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {hasScenarios ? 'Generate more scenarios' : 'Generate scenarios'}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Compiles Gherkin from the acceptance criteria and {resolvedFlagCount} resolved{' '}
          {resolvedFlagCount === 1 ? 'clarification' : 'clarifications'}. Every scenario is a draft
          until you accept it — nothing becomes a test on its own.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <form action={generateScenarios}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <Button type="submit">{hasScenarios ? 'Generate again' : 'Generate scenarios'}</Button>
        </form>
        {hasScenarios ? (
          <p className="text-xs text-muted-foreground">
            Re-running keeps scenarios you have already decided; only new ones are added.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ScenarioList({
  ticketId,
  scenarios,
  editingScenarioId,
  scaffolds,
  editingScaffoldId,
}: {
  ticketId: string;
  scenarios: ScenarioRow[];
  editingScenarioId: string | undefined;
  scaffolds: ScaffoldRow[];
  editingScaffoldId: string | undefined;
}) {
  const live = scenarios.filter((s) => s.status !== 'stale');
  const staleCount = scenarios.length - live.length;
  const undecided = live.filter((s) => s.status === 'draft').length;
  const scaffoldByScenario = new Map(scaffolds.map((s) => [s.scenario_id, s]));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">
            Scenarios <span className="font-normal text-muted-foreground">({live.length})</span>
          </CardTitle>
          {live.length === 0 ? null : undecided > 0 ? (
            <Badge tone="warning">{undecided} to review</Badge>
          ) : (
            <Badge tone="success">All reviewed</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Accept the scenarios that describe real, testable behaviour; edit the wording where it is
          close; dismiss the rest. Accepted scenarios are what a scaffold can be emitted from.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {live.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No scenarios yet. Generate them from the approved requirement above.
          </p>
        ) : (
          live.map((scenario) => (
            <ScenarioCard
              key={scenario.id}
              ticketId={ticketId}
              scenario={scenario}
              editing={editingScenarioId === scenario.id}
              scaffold={scaffoldByScenario.get(scenario.id)}
              editingScaffold={
                editingScaffoldId !== undefined &&
                editingScaffoldId === scaffoldByScenario.get(scenario.id)?.id
              }
            />
          ))
        )}
        {staleCount > 0 ? (
          <p className="pt-2 text-xs text-muted-foreground">
            {staleCount} scenario{staleCount === 1 ? '' : 's'} from an earlier version of this
            ticket
            {staleCount === 1 ? ' is' : ' are'} hidden as stale.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScenarioCard({
  ticketId,
  scenario,
  editing,
  scaffold,
  editingScaffold,
}: {
  ticketId: string;
  scenario: ScenarioRow;
  editing: boolean;
  scaffold: ScaffoldRow | undefined;
  editingScaffold: boolean;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(scenario.status)}>{scenario.status}</Badge>
        {scenario.origin === 'human' ? <Badge tone="muted">human-authored</Badge> : null}
      </div>

      <p className="font-medium leading-snug">{scenario.title}</p>
      {scenario.rationale ? (
        <p className="mt-1 text-sm text-muted-foreground">{scenario.rationale}</p>
      ) : null}

      {editing ? (
        <form action={decideScenarioAction} className="mt-3 space-y-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="scenarioId" value={scenario.id} />
          <input type="hidden" name="decision" value="edited" />
          <Textarea
            name="editedText"
            required
            rows={8}
            defaultValue={scenario.gherkin_raw}
            className="font-mono text-xs"
            aria-label="Rewrite the Gherkin scenario"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save edit and accept
            </Button>
            <a
              href={`/tickets/${ticketId}/specs`}
              className="text-sm text-muted-foreground underline"
            >
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">
            {scenario.gherkin_raw}
          </pre>
          {scenario.covers_ac ? (
            <blockquote className="mt-3 border-l-2 border-border pl-3 text-xs text-muted-foreground">
              covers AC: {scenario.covers_ac}
            </blockquote>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {scenario.status === 'draft' ? (
              <>
                <DecisionButton
                  ticketId={ticketId}
                  scenarioId={scenario.id}
                  decision="approved"
                  label="Accept"
                />
                <a
                  href={`/tickets/${ticketId}/specs?edit=${scenario.id}`}
                  className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
                >
                  Edit
                </a>
                <DecisionButton
                  ticketId={ticketId}
                  scenarioId={scenario.id}
                  decision="dismissed"
                  label="Dismiss"
                  variant="ghost"
                />
              </>
            ) : (
              <DecisionButton
                ticketId={ticketId}
                scenarioId={scenario.id}
                decision="reopened"
                label="Reopen"
                variant="outline"
              />
            )}
          </div>
          {scenario.status === 'approved' || scenario.status === 'edited' ? (
            <ScaffoldSection
              ticketId={ticketId}
              scenarioId={scenario.id}
              scaffold={scaffold}
              editing={editingScaffold}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function DecisionButton({
  ticketId,
  scenarioId,
  decision,
  label,
  variant = 'secondary',
}: {
  ticketId: string;
  scenarioId: string;
  decision: string;
  label: string;
  variant?: 'default' | 'secondary' | 'outline' | 'ghost';
}) {
  return (
    <form action={decideScenarioAction}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="scenarioId" value={scenarioId} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" size="sm" variant={variant}>
        {label}
      </Button>
    </form>
  );
}

/**
 * The scaffold for one accepted scenario: emit it, review it, fill in the real
 * selectors, download it. Rendered under the scenario it belongs to. Placeholder
 * selectors are listed explicitly as a checklist of what a human still has to replace.
 */
function ScaffoldSection({
  ticketId,
  scenarioId,
  scaffold,
  editing,
}: {
  ticketId: string;
  scenarioId: string;
  scaffold: ScaffoldRow | undefined;
  editing: boolean;
}) {
  if (!scaffold) {
    return (
      <div className="mt-4 border-t pt-3">
        <form action={emitScaffoldAction}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="scenarioId" value={scenarioId} />
          <Button type="submit" size="sm" variant="outline">
            Emit Playwright scaffold
          </Button>
        </form>
        <p className="mt-1 text-xs text-muted-foreground">
          A deterministic skeleton with placeholder selectors — you fill in the real locators before
          it runs.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Playwright scaffold
        </span>
        <Badge tone={statusTone(scaffold.status)}>{scaffold.status}</Badge>
        <span className="flex-1" />
        <a
          href={`/tickets/${ticketId}/specs/download/${scaffold.id}`}
          className="text-xs text-muted-foreground underline"
        >
          Download .spec.ts
        </a>
      </div>

      {editing ? (
        <form action={decideScaffoldAction} className="space-y-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="scaffoldId" value={scaffold.id} />
          <input type="hidden" name="status" value="edited" />
          <Textarea
            name="code"
            required
            rows={14}
            defaultValue={scaffold.code}
            className="font-mono text-xs"
            aria-label="Fill in the real selectors"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save filled-in scaffold
            </Button>
            <a
              href={`/tickets/${ticketId}/specs`}
              className="text-sm text-muted-foreground underline"
            >
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">
            {scaffold.code}
          </pre>

          {scaffold.selector_placeholders.length > 0 ? (
            <div>
              <p className="text-xs font-medium">
                Selectors to fill in ({scaffold.selector_placeholders.length})
              </p>
              <ul className="mt-1 space-y-1">
                {scaffold.selector_placeholders.map((p) => (
                  <li key={p.name} className="text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{p.name}</span> — {p.description}
                    {p.suggestion ? (
                      <span className="block pl-3 font-mono">try: {p.suggestion}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No selectors to fill in.</p>
          )}

          <div className="flex flex-wrap gap-2">
            {scaffold.status === 'draft' ? (
              <>
                <ScaffoldButton
                  ticketId={ticketId}
                  scaffoldId={scaffold.id}
                  status="approved"
                  label="Accept scaffold"
                />
                <a
                  href={`/tickets/${ticketId}/specs?editScaffold=${scaffold.id}`}
                  className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
                >
                  Fill in selectors
                </a>
                <ScaffoldButton
                  ticketId={ticketId}
                  scaffoldId={scaffold.id}
                  status="dismissed"
                  label="Dismiss"
                  variant="ghost"
                />
              </>
            ) : scaffold.status === 'dismissed' ? (
              <form action={emitScaffoldAction}>
                <input type="hidden" name="ticketId" value={ticketId} />
                <input type="hidden" name="scenarioId" value={scenarioId} />
                <Button type="submit" size="sm" variant="outline">
                  Re-emit scaffold
                </Button>
              </form>
            ) : (
              <span className="text-xs text-muted-foreground">
                Accepted — download it and commit it to your test suite.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ScaffoldButton({
  ticketId,
  scaffoldId,
  status,
  label,
  variant = 'secondary',
}: {
  ticketId: string;
  scaffoldId: string;
  status: string;
  label: string;
  variant?: 'default' | 'secondary' | 'outline' | 'ghost';
}) {
  return (
    <form action={decideScaffoldAction}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="scaffoldId" value={scaffoldId} />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" size="sm" variant={variant}>
        {label}
      </Button>
    </form>
  );
}

/** The scenario review audit trail — the counterpart of the flag decision history. */
export function SpecsAuditTrail({ reviews }: { reviews: ScenarioReviewDetailRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scenario review history</CardTitle>
      </CardHeader>
      <CardContent>
        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scenario decisions recorded yet.</p>
        ) : (
          <ul className="space-y-3">
            {reviews.map((r) => (
              <li key={r.id} className="border-l-2 border-border pl-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={decisionTone(r.decision)}>{r.decision}</Badge>
                  <span className="text-muted-foreground">{r.user_email ?? 'unknown user'}</span>
                  <span className="text-xs text-muted-foreground">{stamp(r.created_at)}</span>
                </div>
                <p className="mt-1 text-muted-foreground">{truncate(r.scenario_title, 120)}</p>
                {r.edited_text ? (
                  <p className="mt-1 whitespace-pre-wrap rounded bg-muted/60 px-2 py-1 font-mono text-xs">
                    {truncate(r.edited_text, 300)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Coverage: which resolved flags are backed by an accepted scenario, and which
 * accepted scenarios have a scaffold. Only accepted artifacts count — a draft scenario
 * is not coverage. The untested list is the actionable half: resolved questions with no
 * scenario yet.
 */
/**
 * Whether embedding-based suggestions can be shown. `schema_missing`: migration 0006 is
 * not applied. `not_embedded`: it is, but this version has no clause vectors yet.
 * `error`: the query failed (logged server-side); exact coverage still renders.
 */
export type SemanticState = 'ready' | 'schema_missing' | 'not_embedded' | 'error';

const SEMANTIC_NOTES: Record<Exclude<SemanticState, 'ready'>, string> = {
  schema_missing:
    'Similarity suggestions are off: the clause-embedding table (migration 0006) is not in this database yet.',
  not_embedded:
    'Similarity suggestions appear once this version’s clauses are embedded — re-ingest the ticket or run the embedding backfill.',
  error: 'Similarity suggestions could not be loaded just now. Exact coverage above is unaffected.',
};

export function CoveragePanel({
  counts,
  untested,
  clauses,
  semanticState,
}: {
  counts: CoverageCounts;
  untested: UntestedFlag[];
  clauses: ClauseCoverageRow[];
  semanticState: SemanticState;
}) {
  const coveredClauses = clauses.filter((row) => row.status === 'covered').length;
  const suggested = clauses.filter((row) => row.status === 'likely').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Coverage</CardTitle>
        <p className="text-sm text-muted-foreground">
          How much of the approved requirement is backed by downstream artifacts. Only accepted
          scenarios and emitted scaffolds count toward these numbers.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="AC clauses with a scenario" value={`${coveredClauses}/${clauses.length}`} />
          <Stat
            label="Resolved flags with a scenario"
            value={`${counts.flagsWithScenario}/${counts.resolvedFlags}`}
          />
          <Stat
            label="Scenarios with a scaffold"
            value={`${counts.scenariosWithScaffold}/${counts.acceptedScenarios}`}
          />
        </dl>

        {clauses.length > 0 ? (
          <div>
            <p className="text-xs font-medium">Acceptance criteria, clause by clause</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A clause counts as covered only when an accepted scenario quotes it. Similarity
              suggestions{suggested > 0 ? ` (${suggested} likely)` : ''} are hints to confirm, not
              coverage.
            </p>
            <ul className="mt-2 space-y-1.5">
              {clauses.map((row) => (
                <li key={row.index} className="flex items-start gap-2 text-xs">
                  <Badge tone={clauseTone(row.status)}>{clauseLabel(row.status)}</Badge>
                  <span className="flex-1">
                    <span>{truncate(row.clause, 140)}</span>
                    {row.scenario ? (
                      <span className="block text-muted-foreground">
                        {row.status === 'covered' ? 'Covered by ' : 'Closest scenario: '}
                        {truncate(row.scenario.title, 80)}
                        {row.similarity !== null ? ` · ${percent(row.similarity)} similar` : ''}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {semanticState !== 'ready' ? (
              <p className="mt-2 text-xs text-muted-foreground">{SEMANTIC_NOTES[semanticState]}</p>
            ) : null}
          </div>
        ) : null}
        {untested.length > 0 ? (
          <div>
            <p className="text-xs font-medium">
              Resolved flags with no accepted scenario ({untested.length})
            </p>
            <ul className="mt-1 space-y-1">
              {untested.map((flag) => (
                <li
                  key={flag.flagId}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <Badge tone="muted">{categoryLabel(flag.category)}</Badge>
                  <span className="flex-1">{truncate(flag.question, 100)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : counts.resolvedFlags > 0 ? (
          <p className="text-xs text-muted-foreground">
            Every resolved flag has at least one accepted scenario.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The drift signal: scenarios a reviewer accepted on an earlier version that went stale
 * when the ticket changed, each set against the closest clause of the current text. It
 * prioritizes re-review; it does not re-approve anything — a stale scenario stays stale
 * until it is regenerated and reviewed again.
 */
export function DriftPanel({ drifted }: { drifted: DriftedScenario[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Drift: approved specs on an older version</CardTitle>
        <p className="text-sm text-muted-foreground">
          These scenarios were accepted before the requirement changed. Each is compared with the
          closest clause of the current text, so you can see which still fit and which may test
          something that is gone.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {drifted.map((item) => {
            const verdict = driftVerdict(item.similarity);
            return (
              <li key={item.scenarioId} className="flex items-start gap-2 text-xs">
                <Badge tone={driftTone(verdict)}>{driftLabel(verdict)}</Badge>
                <span className="flex-1">
                  <span className="font-medium">{truncate(item.title, 100)}</span>
                  <span className="block text-muted-foreground">
                    {item.clauseContent !== null && item.similarity !== null
                      ? `Closest current clause: “${truncate(item.clauseContent, 100)}” · ${percent(item.similarity)} similar`
                      : 'No embedding to compare yet — re-review it against the current text.'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function clauseLabel(status: ClauseCoverageStatus): string {
  if (status === 'covered') return 'Covered';
  if (status === 'likely') return 'Likely';
  if (status === 'possible') return 'Possible';
  return 'No scenario';
}

function clauseTone(status: ClauseCoverageStatus): 'success' | 'primary' | 'warning' | 'danger' {
  if (status === 'covered') return 'success';
  if (status === 'likely') return 'primary';
  if (status === 'possible') return 'warning';
  return 'danger';
}

function driftLabel(verdict: DriftVerdict): string {
  if (verdict === 'likely_holds') return 'Likely still fits';
  if (verdict === 'suspect') return 'Suspect';
  return 'Unknown';
}

function driftTone(verdict: DriftVerdict): 'success' | 'danger' | 'muted' {
  if (verdict === 'likely_holds') return 'success';
  if (verdict === 'suspect') return 'danger';
  return 'muted';
}

function percent(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function categoryLabel(category: string): string {
  return (FLAG_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

function statusTone(status: string): 'neutral' | 'success' | 'primary' | 'muted' {
  if (status === 'approved') return 'success';
  if (status === 'edited') return 'primary';
  if (status === 'draft') return 'neutral';
  return 'muted';
}

function decisionTone(decision: string): 'success' | 'primary' | 'muted' | 'neutral' {
  if (decision === 'approved') return 'success';
  if (decision === 'edited') return 'primary';
  if (decision === 'dismissed') return 'muted';
  return 'neutral';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** UTC, unambiguous — an audit trail read across timezones must not be guessable. */
function stamp(value: Date | string): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
