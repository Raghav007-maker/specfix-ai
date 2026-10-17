/**
 * Test scaffolds: deterministic Playwright skeletons emitted from approved scenarios.
 *
 * The gate lives here, not in the UI: `emitScaffoldForScenario` loads the scenario and
 * refuses unless its status is approved or edited. A scaffold is never generated from a
 * draft scenario, no matter what the caller asks for — that is the "nothing proceeds to
 * scaffolds without the human gate" rule from the plan, enforced in code.
 *
 * The scaffold is regenerable: the emitter is deterministic, so re-emitting replaces
 * the draft rather than accumulating duplicates, keyed by (scenario, framework).
 */
import type { PoolClient, QueryResultRow } from 'pg';
import type { ScaffoldFramework, SelectorPlaceholder, ScenarioStatus } from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';

export interface ScaffoldRow {
  id: string;
  tenant_id: string;
  scenario_id: string;
  ticket_id: string;
  ticket_version_id: string;
  framework: ScaffoldFramework;
  code: string;
  selector_placeholders: SelectorPlaceholder[];
  status: ScenarioStatus;
  created_at: Date;
}

export interface SaveScaffoldInput {
  scenarioId: string;
  ticketId: string;
  ticketVersionId: string;
  framework: ScaffoldFramework;
  code: string;
  selectorPlaceholders: readonly SelectorPlaceholder[];
}

/**
 * Persists an emitted scaffold.
 *
 * Upsert rather than insert: the emitter is deterministic, so regenerating a scaffold
 * is the normal case and must not accumulate rows. An approved scaffold is returned
 * unchanged — regenerating would discard the human's real selectors, which is the one
 * thing this table exists to hold.
 */
export async function saveScaffold(
  tenantId: TenantId,
  input: SaveScaffoldInput
): Promise<ScaffoldRow> {
  return tx(async (client) => {
    const [existing] = await rows<ScaffoldRow>(
      client,
      `${SCAFFOLD_SELECT} where tenant_id = $1 and scenario_id = $2 and framework = $3 for update`,
      [tenantId, input.scenarioId, input.framework]
    );

    if (existing && (existing.status === 'approved' || existing.status === 'edited')) {
      return existing;
    }

    const [row] = await rows<ScaffoldRow>(
      client,
      `insert into test_scaffolds (
         tenant_id, scenario_id, ticket_id, ticket_version_id, framework, code,
         selector_placeholders, status
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'draft')
       on conflict (tenant_id, scenario_id, framework) do update
         set code = excluded.code,
             selector_placeholders = excluded.selector_placeholders
       returning ${SCAFFOLD_COLUMNS}`,
      [
        tenantId,
        input.scenarioId,
        input.ticketId,
        input.ticketVersionId,
        input.framework,
        input.code,
        JSON.stringify(input.selectorPlaceholders),
      ]
    );
    if (!row) throw new Error('test_scaffolds upsert returned no row');

    // A scenario->scaffold traceability link, so coverage is a query. Written on emit,
    // the same way the requirement->scenario link is written on compile.
    await client.query(
      `insert into traceability_links (
         tenant_id, ticket_version_id, scenario_id, scaffold_id, link_type, created_by
       ) values ($1, $2, $3, $4, 'scenario_to_scaffold', 'compiler')`,
      [tenantId, input.ticketVersionId, input.scenarioId, row.id]
    );

    return row;
  });
}

export async function listScaffoldsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ScaffoldRow[]> {
  return query<ScaffoldRow>(
    `${SCAFFOLD_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and status <> 'stale'
     order by created_at`,
    [tenantId, ticketVersionId]
  );
}

export async function getScaffold(
  tenantId: TenantId,
  scaffoldId: string
): Promise<ScaffoldRow | null> {
  const [row] = await query<ScaffoldRow>(`${SCAFFOLD_SELECT} where tenant_id = $1 and id = $2`, [
    tenantId,
    scaffoldId,
  ]);
  return row ?? null;
}

/** Accept/edit/dismiss a scaffold after a human has filled in the real selectors. */
export async function decideScaffold(
  tenantId: TenantId,
  input: {
    scaffoldId: string;
    status: Extract<ScenarioStatus, 'approved' | 'edited' | 'dismissed'>;
    code?: string | undefined;
  }
): Promise<ScaffoldRow> {
  return tx(async (client) => {
    const [updated] = await rows<ScaffoldRow>(
      client,
      `update test_scaffolds set status = $3, code = coalesce($4, code)
       where tenant_id = $1 and id = $2
       returning ${SCAFFOLD_COLUMNS}`,
      [tenantId, input.scaffoldId, input.status, input.code ?? null]
    );
    if (!updated) throw new Error(`no such scaffold: ${input.scaffoldId}`);
    return updated;
  });
}

const SCAFFOLD_COLUMNS = `id, tenant_id, scenario_id, ticket_id, ticket_version_id, framework,
       code, selector_placeholders, status, created_at`;

const SCAFFOLD_SELECT = `select ${SCAFFOLD_COLUMNS} from test_scaffolds`;

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
