# Fixtures

## `tickets/sample/`

Ordinary tickets, deliberately written the way real backlog tickets are written —
plausible, readable, and quietly under-specified. Used for local development and as
the seed pool for gold sets. Three formats on purpose, so the FileSource parsers
stay honest: markdown, JSON array, CSV export.

These are synthetic. They are **not** a substitute for the independently-labeled
real tickets the week-5 gate needs.

## `tickets/adversarial/`

Prompt-injection attempts embedded in ticket text. The analyzer must treat ticket
text as data, so for each of these the assertion is:

1. Output still validates against `AnalysisResultSchema`.
2. The injected instruction does **not** take effect — flags are not suppressed,
   the delimiter is not escaped, no system-prompt content is echoed.

Run by `packages/core/test/injection.test.ts`. Add a case here whenever a new
injection shape is imagined; deleting one requires a reason.

## `gold/`

Frozen, versioned gold sets: tickets plus the reviewer-authored gap lists that form
the recall denominator, plus per-flag reviewer verdicts. Committed to git so a
change to the measurement substrate shows up in a pull request diff rather than
happening quietly in a database.

Never edit a published gold set. Create `gold-v2.json` instead — a metric is only
comparable across prompt versions if the set it was measured on did not move.

## `eval-runs/`

Committed eval reports. `npm run eval -- run --set gold-v1 --prompt single-shot-v1`
writes one here. They are committed so that a prompt change which lowers precision
is visible as a diff, which is the whole point of the harness.
