/**
 * Operator CLI: get a workspace into a state where a reviewer can actually label.
 *
 *   npm run ops -- provision --email <email> [--password <pw>]
 *   npm run ops -- seed    --owner <email> --tenant "Acme" [--project "Checkout"]
 *                          [--dir fixtures/tickets/sample] [--limit 10] [--analyze]
 *   npm run ops -- invite  --owner <email> --tenant "Acme" --email <email> [--role reviewer]
 *   npm run ops -- metrics --tenant <uuid|name> [--owner <email>] [--prompt <version>]
 *                          [--compile-prompt <version>]
 *
 * This is the "seed fixtures" step the plan's local end-to-end verification calls for,
 * plus the two things around it that the Weeks 3-4 exit criterion needs: a reviewer who
 * is not the prompt author must be able to reach the seeded workspace, and precision +
 * recall must be readable straight from the database.
 *
 * It lives outside packages/ because it composes all of them — ingest, core, and db —
 * and nothing may depend on it. All database access goes through @specfix/db
 * repositories; there is no raw SQL here, the same rule apps/ follows.
 *
 * `seed` is idempotent: ingestTicket upserts by external id, and a ticket whose text
 * has not changed does not create a new version. `--analyze` is opt-in because it
 * spends money, and it skips any version that already has a successful run.
 * Requirement embedding runs by default when an API key is set (`--skip-embed` turns
 * it off) and likewise skips any version whose stored vector already matches.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { analyzeTicket, embedTextsTolerant, getConfig, hasOpenAiCredentials } from '@specfix/core';
import { compileScenarios, emitPlaywrightScaffold } from '@specfix/compiler';
import { FileSource, parseMarkdownTicket } from '@specfix/ingest';
import { toAnalyzable, type NormalizedTicket } from '@specfix/shared';
import {
  addMembership,
  closePool,
  createProject,
  createTenant,
  doubleLabeledVersions,
  findUserByEmail,
  ingestTicket,
  isOverTokenCap,
  latestVersion,
  listMembershipsForUser,
  listProjects,
  listRunsForTicket,
  listTicketsForProject,
  precisionCounts,
  recallCounts,
  recordAnalysis,
  recordCompilation,
  scenarioAcceptanceCounts,
  syncClauseEmbeddings,
  syncRequirementEmbeddings,
  timeToReady,
  setProUntil,
  tenantPlan,
  FREE_PROJECT_LIMIT,
  type EmbeddingSyncResult,
  type TenantId,
} from '@specfix/db';
import { formatRate, rate, scenarioAcceptance } from '@specfix/eval';

const USAGE = `
specfix ops

  provision --email <email> [--password <pw>]
      Create a Supabase account so someone can sign in. Generates a password if you
      do not supply one, and prints it once. Grant workspace access with \`invite\`.

  seed --owner <email> --tenant <name> [options]
      Create the workspace if needed, then ingest fixture tickets into it.
      --project <name>     project to ingest into (default "Fixtures")
      --dir <path>         fixture directory (default fixtures/tickets/sample)
      --limit <n>          only the first n tickets
      --analyze            also run the model on newly ingested versions (costs money)
      --prompt <name>      prompt to analyze with (default single-shot-v1)
      --skip-embed         do not embed requirement text. Otherwise, when an API key is
                           set, each ingested version without a current vector is
                           embedded (a small charge; unchanged versions cost nothing)

  invite --owner <email> --tenant <name> --email <email> [--role reviewer]
      Add an already-registered user to the workspace. They must sign up in the web
      app first, so Supabase owns their password.

  metrics --tenant <uuid|name> [--owner <email>] [--prompt <version>]
          [--compile-prompt <version>]
      Precision, recall, inter-rater coverage and time-to-ready, from the database,
      plus scenario acceptance (clean vs after-edit) from the scenario review history.
      --prompt scopes the flag rates; --compile-prompt scopes the scenario rates.

  plan --tenant <uuid|name> [--owner <email>] (--pro-until <YYYY-MM-DD> | --free)
      Put a workspace on Pro until the end of that day (India time), or back on Free.
      Free allows five projects and no resolution agent. SpecFix's own team, listed in
      SPECFIX_OWNER_EMAILS, needs neither. --owner is needed only with a name.

  compile --ticket <path> [options]
      Phase 2. Compile Gherkin scenarios from a ticket's approved acceptance criteria
      and print them. Costs money (one model call).
      --flag "<question => answer>"   a resolved clarification to feed the compiler
                                      (repeatable). The answer is what disambiguates.
      --persist            also write the run and scenarios to a workspace
      --owner <email>      owner whose workspace to persist into (with --persist)
      --tenant <name>      workspace name (with --persist)
      --scaffold           also emit and print a Playwright scaffold per scenario
      --prompt <name>      compile prompt (default compile-gherkin-v1)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'provision':
      return provision(flags);
    case 'seed':
      return seed(flags);
    case 'invite':
      return invite(flags);
    case 'metrics':
      return metrics(flags);
    case 'plan':
      return plan(flags);
    case 'compile':
      return compile(flags, rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown command "${command}"\n${USAGE}`);
      return 2;
  }
}

// --- provision ---------------------------------------------------------------

/**
 * Create an account through Supabase's admin API rather than by inserting into
 * auth.users. That distinction matters: a hand-inserted row has no password hash and
 * no identity record, so it looks like a user in the database but can never sign in.
 * Going through the API means Supabase owns the credential, as it does for anyone who
 * signs up through the web app.
 *
 * This is the only place the service-role key is used, it runs on an operator's
 * machine, and it never touches the browser bundle.
 */
async function provision(flags: Flags): Promise<number> {
  const email = required(flags, 'email');
  const supplied = flags['password'];
  // 16 random bytes, base64url: long enough that printing it once is the only handoff.
  const password = supplied || randomBytes(16).toString('base64url');

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    process.stderr.write('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n');
    return 1;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    process.stdout.write(`${email} already has an account (${existing.id}); nothing to do.\n`);
    return 0;
  }

  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
    },
    // Confirmed on creation: there is no inbox to check for an operator-created account.
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (!response.ok) {
    process.stderr.write(`Supabase refused (${response.status}): ${await response.text()}\n`);
    return 1;
  }

  const created = (await response.json()) as { id?: string };
  process.stdout.write(`created ${email} (${created.id ?? 'unknown id'})\n`);
  if (!supplied) {
    process.stdout.write(`password: ${password}\n`);
    process.stdout.write('Printed once — record it now. Change it after first sign-in.\n');
  }
  return 0;
}

// --- seed --------------------------------------------------------------------

async function seed(flags: Flags): Promise<number> {
  const ownerEmail = required(flags, 'owner');
  const tenantName = required(flags, 'tenant');
  const projectName = flags['project'] || 'Fixtures';
  const dir = resolve(flags['dir'] || 'fixtures/tickets/sample');
  const limit = numeric(flags, 'limit');
  const analyze = flags['analyze'] !== undefined;
  const promptName = flags['prompt'] || undefined;

  if (analyze && !hasOpenAiCredentials()) {
    process.stderr.write('OPENAI_API_KEY is not set, and --analyze makes real API calls.\n');
    return 1;
  }

  const owner = await findUserByEmail(ownerEmail);
  if (!owner) {
    process.stderr.write(
      `No account for ${ownerEmail}. Sign up in the web app first, then re-run.\n`
    );
    return 1;
  }

  // Resolve through the owner's memberships rather than a global name lookup, so this
  // never reveals the existence of a workspace they are not in.
  const memberships = await listMembershipsForUser(owner.id);
  let tenantId = memberships.find((m) => m.tenant_name === tenantName)?.tenant_id;

  if (!tenantId) {
    const tenant = await createTenant(tenantName);
    await addMembership(tenant.id, owner.id, 'owner');
    tenantId = tenant.id;
    process.stdout.write(`created workspace "${tenantName}" (${tenantId})\n`);
  } else {
    process.stdout.write(`using workspace "${tenantName}" (${tenantId})\n`);
  }

  const projects = await listProjects(tenantId);
  const project =
    projects.find((p) => p.name === projectName) ??
    // The operator seeds on SpecFix's behalf, so the Free project limit does not apply.
    (await createProject(tenantId, { name: projectName, sourceType: 'file' }, { unlimited: true }));
  process.stdout.write(`project "${project.name}" (${project.id})\n`);

  const source = new FileSource({ dir });
  const all = await source.list();
  const tickets = limit === undefined ? all : all.slice(0, limit);

  if (tickets.length === 0) {
    process.stderr.write(`no tickets found in ${dir}\n`);
    return 1;
  }
  process.stdout.write(`\ningesting ${tickets.length} ticket(s) from ${dir}\n`);

  let created = 0;
  let unchanged = 0;
  const pending: { ticketId: string; versionId: string; ticket: NormalizedTicket }[] = [];

  for (const ticket of tickets) {
    const result = await ingestTicket(tenantId, project.id, ticket);
    if (result.isNewVersion) {
      created += 1;
      const stale = result.staledFlagCount > 0 ? `, ${result.staledFlagCount} flag(s) stale` : '';
      process.stdout.write(`  + ${ticket.externalKey}  new version${stale}\n`);
    } else {
      unchanged += 1;
      process.stdout.write(`  = ${ticket.externalKey}  unchanged\n`);
    }
    pending.push({ ticketId: result.ticket.id, versionId: result.version.id, ticket });
  }

  process.stdout.write(`\n${created} new version(s), ${unchanged} unchanged\n`);

  // Embedding failure is reported and reflected in the exit code, but does not stop the
  // analysis below: the two are independent, and the ingested versions are committed.
  const embedStatus = await embedPending(tenantId, pending, flags['skip-embed'] !== undefined);

  if (!analyze) {
    process.stdout.write('\nNo analysis run. Re-run with --analyze to produce flags.\n');
    return embedStatus;
  }

  return Math.max(embedStatus, await analyzePending(tenantId, pending, promptName));
}

/**
 * Bring requirement vectors up to date for the versions just ingested.
 *
 * On by default when an API key is configured — embedding is the cheap end of model
 * spend, and a version without a vector is invisible to fuzzy coverage — and skipped,
 * with a notice, when one is not, so seeding still works without credentials.
 * `--skip-embed` opts out. Versions already embedded with the same text and model make
 * no API call, so re-running seed does not pay twice.
 *
 * Ingestion has already committed each ticket in its own transaction; nothing here can
 * change or roll back ticket data. A failure leaves the version without a vector,
 * which `npm run embed:backfill` picks up.
 */
async function embedPending(
  tenantId: TenantId,
  pending: readonly { versionId: string; ticket: NormalizedTicket }[],
  skip: boolean
): Promise<number> {
  if (skip) {
    process.stdout.write('\nEmbeddings skipped (--skip-embed).\n');
    return 0;
  }
  if (!hasOpenAiCredentials()) {
    process.stdout.write(
      '\nEmbeddings skipped: no API key is configured. Run `npm run embed:backfill` once one is.\n'
    );
    return 0;
  }

  const deps = { embed: embedTextsTolerant, model: getConfig().modelEmbed };
  const versionIds = pending.map((item) => item.versionId);
  const keyFor = new Map(pending.map((item) => [item.versionId, item.ticket.externalKey]));

  // Two passes, both deduplicated: the whole-requirement vector, then one per AC
  // clause (the fuzzy-coverage unit). A failure in one does not skip the other.
  process.stdout.write('\nembedding requirements\n');
  const requirements = reportSync(
    tenantId,
    await syncRequirementEmbeddings(tenantId, versionIds, deps),
    keyFor
  );
  process.stdout.write('\nembedding acceptance-criteria clauses\n');
  const clauses = reportSync(
    tenantId,
    await syncClauseEmbeddings(tenantId, versionIds, deps),
    keyFor
  );

  if (requirements + clauses > 0) {
    process.stderr.write(
      'Re-run seed, or run `npm run embed:backfill`, to retry the failed versions.\n'
    );
    return 1;
  }
  return 0;
}

/** Prints one sync's per-version outcomes and totals; returns how many failed. */
function reportSync(
  tenantId: TenantId,
  result: EmbeddingSyncResult,
  keyFor: ReadonlyMap<string, string>
): number {
  const tally = { embedded: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const { id, outcome } of result.outcomes) {
    const key = keyFor.get(id) ?? id;
    tally[outcome.status] += 1;
    if (outcome.status === 'embedded') process.stdout.write(`  + ${key}  embedded\n`);
    else if (outcome.status === 'skipped') process.stdout.write(`  - ${key}  ${outcome.reason}\n`);
    else if (outcome.status === 'failed') {
      process.stderr.write(`  ! ${key}  ${outcome.stage}: ${outcome.error}\n`);
    }
  }

  const tokens = result.calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const cost = result.calls.reduce((sum, call) => sum + call.costUsd, 0);
  process.stdout.write(
    `\n${tally.embedded} embedded, ${tally.unchanged} unchanged, ${tally.skipped} skipped, ` +
      `${tally.failed} failed — ${result.calls.length} call(s), ${tokens} tokens, $${cost.toFixed(4)}\n`
  );

  if (result.callLogError !== null && result.calls.length > 0) {
    // The only copy of these records: the database refused them.
    process.stderr.write(
      `\nllm_calls insert failed (${result.callLogError}); the vectors were not stored.\n` +
        'Unlogged embedding call records follow as JSON — keep them:\n' +
        `${JSON.stringify({ tenantId, calls: result.calls })}\n`
    );
  }
  return tally.failed;
}

/**
 * Analyze every version that has no successful run yet. Skipping already-analyzed
 * versions is what makes re-running seed cheap rather than a repeat charge, and it is
 * checked per version — an edited ticket gets a new version and so gets re-analyzed.
 */
async function analyzePending(
  tenantId: TenantId,
  pending: readonly { ticketId: string; versionId: string; ticket: NormalizedTicket }[],
  promptName: string | undefined
): Promise<number> {
  process.stdout.write('\nanalyzing\n');

  let analyzed = 0;
  let skipped = 0;
  let failed = 0;
  let costUsd = 0;
  let flagCount = 0;

  for (const item of pending) {
    const runs = await listRunsForTicket(tenantId, item.ticketId);
    const done = runs.some(
      (r) => r.ticket_version_id === item.versionId && r.status === 'succeeded'
    );
    if (done) {
      skipped += 1;
      process.stdout.write(`  = ${item.ticket.externalKey}  already analyzed\n`);
      continue;
    }
    // The workspace's monthly token cap is checked before every call, as the worker does.
    if (await isOverTokenCap(tenantId)) {
      process.stderr.write('  ! monthly token cap reached; stopping analysis\n');
      failed += 1;
      break;
    }

    try {
      const outcome = await analyzeTicket(toAnalyzable(item.ticket), {
        ...(promptName ? { promptName } : {}),
      });

      const recorded = await recordAnalysis(tenantId, {
        ticketId: item.ticketId,
        ticketVersionId: item.versionId,
        meta: {
          promptVersion: outcome.meta.promptVersion,
          model: outcome.meta.model,
          temperature: outcome.meta.temperature,
          seed: outcome.meta.seed,
          truncated: outcome.meta.truncated,
          inputTokens: outcome.meta.inputTokens,
          outputTokens: outcome.meta.outputTokens,
          costUsd: outcome.meta.costUsd,
        },
        flags: outcome.flags,
        calls: outcome.calls,
      });

      analyzed += 1;
      costUsd += outcome.meta.costUsd;
      flagCount += recorded.flagIds.length;
      const truncated = outcome.meta.truncated ? ' (truncated)' : '';
      process.stdout.write(
        `  + ${item.ticket.externalKey}  ${recorded.flagIds.length} flag(s)${truncated}\n`
      );
    } catch (error) {
      // One ticket failing must not abandon the rest of the seed; the run is reported
      // and the version simply stays unanalyzed, so a re-run picks it back up.
      failed += 1;
      process.stderr.write(
        `  ! ${item.ticket.externalKey}  ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  process.stdout.write(
    `\n${analyzed} analyzed, ${skipped} skipped, ${failed} failed — ` +
      `${flagCount} flag(s), $${costUsd.toFixed(4)}\n`
  );
  return failed > 0 ? 1 : 0;
}

// --- invite ------------------------------------------------------------------

async function invite(flags: Flags): Promise<number> {
  const ownerEmail = required(flags, 'owner');
  const tenantName = required(flags, 'tenant');
  const inviteeEmail = required(flags, 'email');
  const role = flags['role'] || 'reviewer';

  if (role !== 'owner' && role !== 'admin' && role !== 'reviewer') {
    process.stderr.write(`--role must be owner, admin, or reviewer (got "${role}")\n`);
    return 2;
  }

  const owner = await findUserByEmail(ownerEmail);
  if (!owner) {
    process.stderr.write(`No account for ${ownerEmail}.\n`);
    return 1;
  }

  const membership = (await listMembershipsForUser(owner.id)).find(
    (m) => m.tenant_name === tenantName
  );
  if (!membership) {
    process.stderr.write(`${ownerEmail} is not a member of "${tenantName}".\n`);
    return 1;
  }

  const invitee = await findUserByEmail(inviteeEmail);
  if (!invitee) {
    process.stderr.write(
      `No account for ${inviteeEmail}. They need to sign up in the web app first — ` +
        'this tool grants access, it does not create credentials.\n'
    );
    return 1;
  }

  await addMembership(membership.tenant_id, invitee.id, role);
  process.stdout.write(`${inviteeEmail} added to "${tenantName}" as ${role}\n`);
  return 0;
}

// --- plan --------------------------------------------------------------------

async function plan(flags: Flags): Promise<number> {
  const until = flags['pro-until'];
  const free = 'free' in flags;
  if (free === Boolean(until)) throw new UsageError('give exactly one of --pro-until or --free');

  let proUntil: Date | null = null;
  if (until) {
    // The end of that day in India, so "until 2027-01-31" includes the 31st.
    proUntil = /^\d{4}-\d{2}-\d{2}$/.test(until) ? new Date(`${until}T23:59:59+05:30`) : null;
    if (!proUntil || Number.isNaN(proUntil.getTime())) {
      throw new UsageError('--pro-until must be a date like 2027-01-31');
    }
  }

  const tenantId = await resolveTenant(flags);
  if (!tenantId) return 1;
  if (!(await setProUntil(tenantId, proUntil))) {
    process.stderr.write(`No workspace ${tenantId}.\n`);
    return 1;
  }
  const { projectCount } = await tenantPlan(tenantId);
  process.stdout.write(
    proUntil
      ? `workspace ${tenantId} is on Pro until ${proUntil.toISOString()} (${projectCount} projects)\n`
      : `workspace ${tenantId} is on Free (${projectCount} of ${FREE_PROJECT_LIMIT} projects)\n`
  );
  return 0;
}

// --- metrics -----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** --tenant as a uuid, or as a workspace name that --owner belongs to. Null after a message. */
async function resolveTenant(flags: Flags): Promise<TenantId | null> {
  const tenantRef = required(flags, 'tenant');
  if (UUID.test(tenantRef)) return tenantRef;
  const ownerEmail = required(flags, 'owner');
  const owner = await findUserByEmail(ownerEmail);
  if (!owner) {
    process.stderr.write(`No account for ${ownerEmail}.\n`);
    return null;
  }
  const membership = (await listMembershipsForUser(owner.id)).find(
    (m) => m.tenant_name === tenantRef
  );
  if (!membership) {
    process.stderr.write(`${ownerEmail} is not a member of "${tenantRef}".\n`);
    return null;
  }
  return membership.tenant_id;
}

async function metrics(flags: Flags): Promise<number> {
  const promptVersion = flags['prompt'] || undefined;
  const tenantId = await resolveTenant(flags);
  if (!tenantId) return 1;

  const precision = await precisionCounts(tenantId, promptVersion);
  const recall = await recallCounts(tenantId, promptVersion);
  const doubled = await doubleLabeledVersions(tenantId);
  const ready = await timeToReady(tenantId);
  // --prompt names an analysis prompt for the flag rates; scenarios have their own
  // compile prompt, so they get their own flag.
  const compilePrompt = flags['compile-prompt'] || undefined;
  const scenarioCounts = await scenarioAcceptanceCounts(tenantId, compilePrompt);
  const acceptance = scenarioAcceptance(scenarioCounts);

  const lines = [
    '',
    `tenant   ${tenantId}`,
    `prompt   ${promptVersion ?? 'all versions'}`,
    '',
    // Both rates carry their counts and a Wilson interval, because at this n a bare
    // point estimate would overstate what has actually been measured.
    `precision  ${formatRate(rate(precision.real, precision.reviewed))}`,
    `             accepted or edited, out of flags a reviewer has ruled on`,
    `recall     ${formatRate(rate(recall.matched, recall.gaps))}`,
    `             reviewer gaps the model had already caught, over completed sessions`,
    '',
    `double-labeled versions  ${doubled.length}`,
    `tickets marked ready     ${ready.length}`,
  ];

  if (ready.length > 0) {
    const real = ready.filter((r) => !r.backfilled);
    const hours = [...ready].map((r) => r.hours).sort((a, b) => a - b);
    const median = hours[Math.floor(hours.length / 2)] ?? 0;
    lines.push(
      `median time-to-ready     ${median.toFixed(1)}h` +
        (real.length === ready.length ? '' : ` (${ready.length - real.length} backfilled)`)
    );
  }

  lines.push(
    '',
    `scenarios  ${compilePrompt ?? 'all compile prompts'}`,
    // The clean rate is the headline: an accept the reviewer had to rewrite is the
    // reviewer's work, so it is reported beside the overall rate, never folded into it.
    `clean acceptance  ${formatRate(acceptance.cleanAcceptanceRate)}`,
    `                    approved as written, out of model scenarios with a verdict`,
    `acceptance        ${formatRate(acceptance.acceptanceRate)}`,
    `edit rate         ${formatRate(acceptance.editRate)}`,
    `undecided         ${scenarioCounts.undecided}` +
      (scenarioCounts.humanExcluded > 0
        ? ` (+${scenarioCounts.humanExcluded} human-written, excluded)`
        : '')
  );

  // The exit criterion is that these are computable, so say plainly when they are not
  // rather than printing a confident-looking "n/a" and leaving the reason implicit.
  if (acceptance.reviewed === 0) {
    lines.push('', 'No scenario decisions recorded yet, so acceptance is undefined.');
  }
  if (precision.reviewed === 0) {
    lines.push('', 'No flag decisions recorded yet, so precision is undefined.');
  }
  if (recall.gaps === 0) {
    lines.push(
      'No completed labeling sessions yet, so recall is undefined. Recall counts only',
      'sessions a reviewer finished, which is what freezes the denominator.'
    );
  }

  lines.push('');
  process.stdout.write(lines.join('\n'));
  return 0;
}

// --- compile (Phase 2) -------------------------------------------------------

/**
 * Compile Gherkin scenarios from a ticket file's approved acceptance criteria.
 *
 * The "approved requirement" Phase 2 compiles from is the ticket version's AC plus the
 * resolved clarifications. This CLI proves the core on a fixture before any UI exists,
 * the same order Phase 1 used — a resolved flag is fed in as `--flag "question =>
 * answer"`, where the answer is the disambiguating decision.
 *
 * `--persist` writes through the repository layer into a real workspace; without it the
 * command prints and spends nothing beyond the one model call. Persisting requires a
 * workspace and an ingested version, so it resolves them the same way `seed` does.
 */
async function compile(flags: Flags, rest: readonly string[]): Promise<number> {
  // Fall back to the first bare positional so `ops compile <path>` works even when npm
  // has stripped `--ticket` from the forwarded args (see `positionals`).
  const ticketPath = flags['ticket'] ?? positionals(rest).find((p) => p !== 'compile');
  if (ticketPath === undefined || ticketPath === '') {
    throw new UsageError('--ticket <path> is required (or pass the ticket path as a positional)');
  }

  if (!hasOpenAiCredentials()) {
    process.stderr.write('OPENAI_API_KEY is not set, and compile makes a real API call.\n');
    return 1;
  }

  const raw = await readFile(resolve(ticketPath), 'utf8');
  const parsed = parseMarkdownTicket(raw, ticketPath);
  const requirement = {
    externalKey: parsed.externalKey,
    title: parsed.title,
    acceptanceCriteriaText: parsed.acceptanceCriteriaText,
    // Indexes are assigned here as the flags are listed, so a scenario's
    // source_flag_indexes maps straight onto this array.
    resolvedFlags: flagPairs(argvFlagValues()).map((pair, index) => ({
      flagId: `flag-${index + 1}`,
      category: 'missing_info',
      questionForPm: pair.question,
      answer: pair.answer,
    })),
  };

  if (!requirement.acceptanceCriteriaText.trim()) {
    process.stderr.write(
      `${parsed.externalKey} has no acceptance criteria, so there is nothing to compile.\n`
    );
    return 1;
  }

  const promptName = flags['prompt'] || undefined;
  const outcome = await compileScenarios(requirement, promptName ? { promptName } : {});

  process.stdout.write(
    [
      '',
      `${parsed.externalKey}  ${parsed.title}`,
      `${outcome.scenarios.length} scenario(s)  ` +
        `${outcome.meta.promptVersion}  ` +
        `$${outcome.meta.costUsd.toFixed(4)}  ` +
        `${outcome.meta.inputTokens}→${outcome.meta.outputTokens} tok`,
    ].join('\n')
  );
  if (outcome.meta.unverifiedAc > 0) {
    process.stdout.write(
      `  ${outcome.meta.unverifiedAc} covers_ac value(s) did not occur in the AC and were cleared\n`
    );
  }
  if (outcome.meta.trimmed > 0) {
    process.stdout.write(`  ${outcome.meta.trimmed} scenario(s) trimmed past the 30 cap\n`);
  }

  for (const scenario of outcome.scenarios) {
    process.stdout.write(`\n${scenario.gherkin}\n`);
    if (scenario.rationale) process.stdout.write(`  rationale: ${scenario.rationale}\n`);
    if (scenario.covers_ac) process.stdout.write(`  covers AC: "${scenario.covers_ac}"\n`);
    if (flags['scaffold'] !== undefined) {
      const scaffold = emitPlaywrightScaffold({
        scenario,
        externalKey: parsed.externalKey,
        scenarioId: 'preview',
      });
      process.stdout.write(
        `\n--- scaffold (${scaffold.selectorPlaceholders.length} placeholders) ---\n`
      );
      process.stdout.write(`${scaffold.code}\n`);
    }
  }

  if (outcome.scenarios.length === 0) {
    process.stdout.write(
      '\nNo scenarios. Either the criteria are not yet testable, or the criteria were ' +
        'already fully covered by the resolved clarifications.\n'
    );
  }

  if (flags['persist'] === undefined) {
    process.stdout.write(
      '\nNot persisted. Re-run with --persist --owner <email> --tenant <name>.\n'
    );
    return 0;
  }

  return persistCompilation(flags, requirement, outcome);
}

/**
 * Writes a compilation through the repository layer.
 *
 * The ticket must already be ingested into the workspace (via `seed`) so there is a
 * ticket_version to attach to. We resolve the version the same tenant-scoped way ops
 * always does — never a global lookup — and refuse if the ticket is not present.
 */
async function persistCompilation(
  flags: Flags,
  requirement: { externalKey: string; ticketVersionId?: string },
  outcome: Awaited<ReturnType<typeof compileScenarios>>
): Promise<number> {
  const ownerEmail = required(flags, 'owner');
  const tenantName = required(flags, 'tenant');

  const owner = await findUserByEmail(ownerEmail);
  if (!owner) {
    process.stderr.write(`No account for ${ownerEmail}.\n`);
    return 1;
  }
  const membership = (await listMembershipsForUser(owner.id)).find(
    (m) => m.tenant_name === tenantName
  );
  if (!membership) {
    process.stderr.write(`${ownerEmail} is not a member of "${tenantName}".\n`);
    return 1;
  }
  const tenantId: TenantId = membership.tenant_id;

  // Resolve the version from the database, not from the fixture, so we compile against
  // exactly the AC the ticket was ingested with.
  const projects = await listProjects(tenantId);
  let target: { ticketId: string; versionId: string } | null = null;
  for (const project of projects) {
    const tickets = await listTicketsForProject(tenantId, project.id);
    const match = tickets.find((t) => t.external_key === requirement.externalKey);
    if (!match) continue;
    const version = await latestVersion(tenantId, match.id);
    if (version) target = { ticketId: match.id, versionId: version.id };
    break;
  }
  if (!target) {
    process.stderr.write(
      `Ticket ${requirement.externalKey} is not ingested in "${tenantName}". Run \`seed\` first.\n`
    );
    return 1;
  }

  const recorded = await recordCompilation(tenantId, {
    ticketId: target.ticketId,
    ticketVersionId: target.versionId,
    meta: {
      promptVersion: outcome.meta.promptVersion,
      model: outcome.meta.model,
      temperature: outcome.meta.temperature,
      seed: outcome.meta.seed,
      truncated: outcome.meta.truncated,
      inputTokens: outcome.meta.inputTokens,
      outputTokens: outcome.meta.outputTokens,
      costUsd: outcome.meta.costUsd,
    },
    // The CLI's --flag clarifications are a simulation, not real resolved flag rows, so
    // they have no database id to link to (source_flag_ids is uuid[] with an FK on
    // flags). Clear the linkage here; the real requirement->scenario trace is written by
    // the Milestone B UI flow, which compiles from actual resolved flags.
    scenarios: outcome.scenarios.map((scenario) => ({ ...scenario, sourceFlagIds: [] })),
    calls: outcome.calls.map((call) => ({
      purpose: 'compile_gherkin' as const,
      promptVersion: call.promptVersion,
      model: call.model,
      request: call.request,
      response: call.response,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
      error: call.error,
    })),
  });

  process.stdout.write(
    `\npersisted run ${recorded.run.id}: ${recorded.scenarioIds.length} scenario(s)` +
      (recorded.scenariosSkipped > 0 ? `, ${recorded.scenariosSkipped} already present` : '') +
      '\n'
  );
  return 0;
}

/**
 * `--flag "question => answer"` pairs, in order. A bare value with no `=>` is treated
 * as an answer with an auto-generated question, which is enough for a smoke compile.
 */
function flagPairs(raw: readonly string[]): { question: string; answer: string }[] {
  return raw.map((value, index) => {
    const separator = value.indexOf('=>');
    if (separator === -1) {
      return { question: `Clarification ${index + 1}`, answer: value.trim() };
    }
    return {
      question: value.slice(0, separator).trim() || `Clarification ${index + 1}`,
      answer: value.slice(separator + 2).trim(),
    };
  });
}

/** Collects every `--flag` value from argv, since the shared parser keeps only the last. */
function argvFlagValues(): string[] {
  const argv = process.argv.slice(2);
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--flag') continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.push(next);
      i += 1;
    }
  }
  return values;
}

// --- flags -------------------------------------------------------------------

type Flags = Record<string, string | undefined>;

/** `--key value` and bare `--flag`. Same shape as the eval CLI's parser. */
function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = '';
    }
  }
  return flags;
}

/**
 * The non-flag arguments, in order. The counterpart of parseFlags: it skips `--key`
 * tokens and the value each consumes, leaving the bare positionals.
 *
 * This exists because `npm run ops -- compile --ticket <path>` strips the `--flags`
 * before they reach the script (npm re-parses forwarded args as its own config), which
 * leaves the path as a bare positional. Reading it here means the natural command still
 * works; `npx tsx scripts/ops.ts compile --ticket <path>` passes the flags through
 * untouched and is the reliable form when a flag has no positional fallback.
 */
function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

class UsageError extends Error {}

function required(flags: Flags, key: string): string {
  const value = flags[key];
  if (value === undefined || value === '') {
    throw new UsageError(`--${key} is required`);
  }
  return value;
}

function numeric(flags: Flags, key: string): number | undefined {
  const value = flags[key];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${key} must be a positive integer`);
  }
  return parsed;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
