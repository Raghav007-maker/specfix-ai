/**
 * Ticket and ticket-version persistence.
 *
 * The version behaviour is the interesting part. Ingesting a ticket whose
 * analyzable text has not changed is a no-op that returns the existing version,
 * which is how a Jira webhook firing on an assignee change avoids burning an
 * analysis run. When the text *has* changed, a new version is created and the
 * previous version's unresolved and resolved flags are marked stale — they were
 * decided against text that no longer exists.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { ticketContentHash, type NormalizedTicket } from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';

export interface TicketRow {
  id: string;
  tenant_id: string;
  project_id: string;
  external_id: string;
  external_key: string;
  content_hash: string;
}

export interface TicketVersionRow {
  id: string;
  ticket_id: string;
  content_hash: string;
}

export interface IngestResult {
  ticket: TicketRow;
  version: TicketVersionRow;
  /** False when the incoming text matched the current version. */
  isNewVersion: boolean;
  /** Flags marked stale because a newer version superseded them. */
  staledFlagCount: number;
}

export async function ingestTicket(
  tenantId: TenantId,
  projectId: string,
  ticket: NormalizedTicket
): Promise<IngestResult> {
  const contentHash = ticketContentHash({
    externalKey: ticket.externalKey,
    title: ticket.title,
    descriptionText: ticket.descriptionText,
    acceptanceCriteriaText: ticket.acceptanceCriteriaText,
  });

  return tx(async (client) => {
    const [ticketRow] = await rows<TicketRow>(
      client,
      `insert into tickets (
         tenant_id, project_id, external_id, external_key, title,
         description_text, description_raw, acceptance_criteria_text,
         content_hash, source_updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (tenant_id, project_id, external_id) do update set
         external_key = excluded.external_key,
         title = excluded.title,
         description_text = excluded.description_text,
         description_raw = excluded.description_raw,
         acceptance_criteria_text = excluded.acceptance_criteria_text,
         content_hash = excluded.content_hash,
         source_updated_at = excluded.source_updated_at,
         updated_at = now()
       returning id, tenant_id, project_id, external_id, external_key, content_hash`,
      [
        tenantId,
        projectId,
        ticket.externalId,
        ticket.externalKey,
        ticket.title,
        ticket.descriptionText,
        ticket.raw === undefined ? null : JSON.stringify(ticket.raw),
        ticket.acceptanceCriteriaText,
        contentHash,
        ticket.sourceUpdatedAt,
      ]
    );

    if (!ticketRow) {
      throw new Error(`ticket upsert returned no row for ${ticket.externalId}`);
    }

    const existing = await rows<TicketVersionRow>(
      client,
      `select id, ticket_id, content_hash from ticket_versions
       where tenant_id = $1 and ticket_id = $2 and content_hash = $3`,
      [tenantId, ticketRow.id, contentHash]
    );

    if (existing[0]) {
      return {
        ticket: ticketRow,
        version: existing[0],
        isNewVersion: false,
        staledFlagCount: 0,
      };
    }

    const [version] = await rows<TicketVersionRow>(
      client,
      `insert into ticket_versions (
         tenant_id, ticket_id, content_hash, title, description_text, acceptance_criteria_text
       ) values ($1, $2, $3, $4, $5, $6)
       returning id, ticket_id, content_hash`,
      [
        tenantId,
        ticketRow.id,
        contentHash,
        ticket.title,
        ticket.descriptionText,
        ticket.acceptanceCriteriaText,
      ]
    );

    if (!version) {
      throw new Error(`version insert returned no row for ${ticket.externalId}`);
    }

    // Everything decided against an older version is now stale. Dismissed flags
    // stay dismissed: a reviewer's "this is noise" verdict is still evidence for
    // the precision metric and must not be overwritten.
    const staled = await rows<{ id: string }>(
      client,
      `update flags set status = 'stale'
       where tenant_id = $1
         and ticket_id = $2
         and ticket_version_id <> $3
         and status in ('open', 'accepted', 'edited')
       returning id`,
      [tenantId, ticketRow.id, version.id]
    );

    await client.query(
      `insert into readiness_events (tenant_id, ticket_id, ticket_version_id, event)
       values ($1, $2, $3, 'ticket_ingested')`,
      [tenantId, ticketRow.id, version.id]
    );

    return {
      ticket: ticketRow,
      version,
      isNewVersion: true,
      staledFlagCount: staled.length,
    };
  });
}

export async function listTicketsForProject(
  tenantId: TenantId,
  projectId: string
): Promise<TicketRow[]> {
  return query<TicketRow>(
    `select id, tenant_id, project_id, external_id, external_key, content_hash
     from tickets
     where tenant_id = $1 and project_id = $2
     order by external_key`,
    [tenantId, projectId]
  );
}

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
