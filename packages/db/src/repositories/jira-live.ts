/**
 * Live Jira sync: the tenant's webhook, delivery de-duplication, the projects a tenant
 * syncs, archiving issues that left Jira, and the scheduler's "what is due" queries.
 *
 * connectionForWebhook and the two `due*` queries are the cross-tenant reads here: the
 * webhook receiver learns the tenant from the connection id in its URL, and the
 * scheduler serves every tenant. Each returns tenant ids for the caller to scope by.
 */
import { query, type TenantId } from '../client.ts';

export interface LiveProjectRow {
  id: string;
  name: string;
  jira_project_key: string;
  ac_field_id: string | null;
}

/** The tenant's Jira projects on its currently connected site. */
export async function liveJiraProjects(tenantId: TenantId): Promise<LiveProjectRow[]> {
  return query<LiveProjectRow>(
    `select p.id, p.name, p.jira_project_key, p.ac_field_id
     from projects p
     join jira_connections c
       on c.tenant_id = p.tenant_id and c.grant_kind = 'read' and c.cloud_id = p.jira_cloud_id
     where p.tenant_id = $1 and p.source_type = 'jira'
     order by p.jira_project_key`,
    [tenantId]
  );
}

export interface WebhookConnectionRow {
  id: string;
  tenant_id: string;
  site_url: string | null;
  status: 'active' | 'error';
}

/** The connection a webhook delivery was addressed to (by the id in its URL). */
export async function connectionForWebhook(
  connectionId: string
): Promise<WebhookConnectionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const [row] = await query<WebhookConnectionRow>(
    `select id, tenant_id, site_url, status from jira_connections
     where id = $1 and grant_kind = 'read'`,
    [connectionId]
  );
  return row ?? null;
}

/**
 * Records a delivery by Jira's X-Atlassian-Webhook-Identifier. False when it was
 * already recorded — a retry of something already accepted.
 */
export async function recordWebhookDelivery(
  tenantId: TenantId,
  input: { deliveryId: string; event: string; issueId: string | null }
): Promise<boolean> {
  const rows = await query(
    `insert into jira_webhook_deliveries (tenant_id, delivery_id, event, issue_id)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning 1`,
    [tenantId, input.deliveryId.slice(0, 200), input.event.slice(0, 100), input.issueId]
  );
  return rows.length > 0;
}

/** Drops delivery ids older than Jira's retry window could ever reach. */
export async function pruneWebhookDeliveries(olderThanDays = 7): Promise<void> {
  await query(
    `delete from jira_webhook_deliveries
     where received_at < now() - make_interval(days => $1)`,
    [olderThanDays]
  );
}

export interface TenantWebhookRow {
  connection_id: string;
  jira_webhook_id: string;
  jql: string;
  url: string;
  expires_at: Date;
}

export async function getTenantWebhook(tenantId: TenantId): Promise<TenantWebhookRow | null> {
  const [row] = await query<TenantWebhookRow>(
    `select w.connection_id, w.jira_webhook_id::text, w.jql, w.url, w.expires_at
     from jira_webhooks w
     join jira_connections c on c.id = w.connection_id and c.grant_kind = 'read'
     where w.tenant_id = $1`,
    [tenantId]
  );
  return row ?? null;
}

export async function saveTenantWebhook(
  tenantId: TenantId,
  input: { connectionId: string; jiraWebhookId: number; jql: string; url: string; expiresAt: Date }
): Promise<void> {
  await query(
    `insert into jira_webhooks (tenant_id, connection_id, jira_webhook_id, jql, url, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, connection_id) do update set
       jira_webhook_id = excluded.jira_webhook_id, jql = excluded.jql, url = excluded.url,
       expires_at = excluded.expires_at, refreshed_at = now()`,
    [tenantId, input.connectionId, input.jiraWebhookId, input.jql, input.url, input.expiresAt]
  );
}

export async function setTenantWebhookExpiry(tenantId: TenantId, expiresAt: Date): Promise<void> {
  await query(
    `update jira_webhooks set expires_at = $2, refreshed_at = now() where tenant_id = $1`,
    [tenantId, expiresAt]
  );
}

export async function deleteTenantWebhookRow(tenantId: TenantId): Promise<void> {
  await query(`delete from jira_webhooks where tenant_id = $1`, [tenantId]);
}

/**
 * Marks the tenant's tickets for a Jira issue as gone from the project (deleted in
 * Jira, or moved somewhere SpecFix does not sync). They keep their history; they just
 * stop counting as live work. Returns how many tickets were archived.
 */
export async function archiveJiraTicket(tenantId: TenantId, externalId: string): Promise<number> {
  const rows = await query(
    `update tickets t set archived_at = coalesce(t.archived_at, now())
     from projects p
     where t.tenant_id = $1 and t.external_id = $2
       and p.id = t.project_id and p.tenant_id = t.tenant_id and p.source_type = 'jira'
       and t.archived_at is null
     returning 1`,
    [tenantId, externalId]
  );
  return rows.length;
}

/** The read connection's id and when it last reconciled. */
export async function getReconcileState(
  tenantId: TenantId
): Promise<{ connection_id: string; last_reconciled_at: Date | null } | null> {
  const [row] = await query<{ connection_id: string; last_reconciled_at: Date | null }>(
    `select id as connection_id, last_reconciled_at from jira_connections
     where tenant_id = $1 and grant_kind = 'read'`,
    [tenantId]
  );
  return row ?? null;
}

export async function markReconciled(tenantId: TenantId, at: Date): Promise<void> {
  await query(
    `update jira_connections set last_reconciled_at = $2
     where tenant_id = $1 and grant_kind = 'read'`,
    [tenantId, at]
  );
}

/** Tenants with a working Jira connection and at least one Jira project. */
const SYNCING_TENANTS = `
  select c.tenant_id, c.last_reconciled_at
  from jira_connections c
  where c.grant_kind = 'read' and c.status = 'active' and c.cloud_id is not null
    and exists (select 1 from projects p
                where p.tenant_id = c.tenant_id and p.source_type = 'jira'
                  and p.jira_cloud_id = c.cloud_id)`;

/** Tenants whose last reconcile is older than `intervalMinutes` (or never ran). */
export async function tenantsDueForReconcile(intervalMinutes: number): Promise<string[]> {
  const rows = await query<{ tenant_id: string }>(
    `select tenant_id from (${SYNCING_TENANTS}) s
     where s.last_reconciled_at is null
        or s.last_reconciled_at < now() - make_interval(mins => $1)`,
    [intervalMinutes]
  );
  return rows.map((r) => r.tenant_id);
}

/** Tenants with no webhook yet, or one that expires within a week. */
export async function tenantsDueForWebhookSync(): Promise<string[]> {
  const rows = await query<{ tenant_id: string }>(
    `select s.tenant_id from (${SYNCING_TENANTS}) s
     left join jira_webhooks w on w.tenant_id = s.tenant_id
     where w.tenant_id is null or w.expires_at < now() + interval '7 days'`
  );
  return rows.map((r) => r.tenant_id);
}
