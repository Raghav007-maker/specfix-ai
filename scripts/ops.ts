/**
 * Operator CLI: get a workspace into a state where a reviewer can actually label.
 *
 *   npm run ops -- provision --email <email> [--password <pw>]
 *   npm run ops -- seed    --owner <email> --tenant "Acme" [--project "Checkout"]
 *                          [--dir fixtures/tickets/sample] [--limit 10] [--analyze]
 *   npm run ops -- invite  --owner <email> --tenant "Acme" --email <email> [--role reviewer]
 *   npm run ops -- metrics --tenant <uuid|name> [--owner <email>] [--prompt <version>]
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
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { analyzeTicket, hasOpenAiCredentials } from '@specfix/core';
import { FileSource } from '@specfix/ingest';
import { toAnalyzable, type NormalizedTicket } from '@specfix/shared';
import {
  addMembership,
  closePool,
  createProject,
  createTenant,
  doubleLabeledVersions,
  findUserByEmail,
  ingestTicket,
  listMembershipsForUser,
  listProjects,
  listRunsForTicket,
  precisionCounts,
  recallCounts,
  recordAnalysis,
  timeToReady,
  type TenantId,
} from '@specfix/db';
import { formatRate, rate } from '@specfix/eval';

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

  invite --owner <email> --tenant <name> --email <email> [--role reviewer]
      Add an already-registered user to the workspace. They must sign up in the web
      app first, so Supabase owns their password.

  metrics --tenant <uuid|name> [--owner <email>] [--prompt <version>]
      Precision, recall, inter-rater coverage and time-to-ready, from the database.
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
    (await createProject(tenantId, { name: projectName, sourceType: 'file' }));
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

  if (!analyze) {
    process.stdout.write('\nNo analysis run. Re-run with --analyze to produce flags.\n');
    return 0;
  }

  return analyzePending(tenantId, pending, promptName);
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

// --- metrics -----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function metrics(flags: Flags): Promise<number> {
  const tenantRef = required(flags, 'tenant');
  const promptVersion = flags['prompt'] || undefined;

  let tenantId: TenantId;
  if (UUID.test(tenantRef)) {
    tenantId = tenantRef;
  } else {
    const ownerEmail = required(flags, 'owner');
    const owner = await findUserByEmail(ownerEmail);
    if (!owner) {
      process.stderr.write(`No account for ${ownerEmail}.\n`);
      return 1;
    }
    const membership = (await listMembershipsForUser(owner.id)).find(
      (m) => m.tenant_name === tenantRef
    );
    if (!membership) {
      process.stderr.write(`${ownerEmail} is not a member of "${tenantRef}".\n`);
      return 1;
    }
    tenantId = membership.tenant_id;
  }

  const precision = await precisionCounts(tenantId, promptVersion);
  const recall = await recallCounts(tenantId, promptVersion);
  const doubled = await doubleLabeledVersions(tenantId);
  const ready = await timeToReady(tenantId);

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

  // The exit criterion is that these are computable, so say plainly when they are not
  // rather than printing a confident-looking "n/a" and leaving the reason implicit.
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
