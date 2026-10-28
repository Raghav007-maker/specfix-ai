/**
 * Jira dynamic webhooks for an OAuth 2.0 (3LO) app: registering, refreshing, deleting,
 * and verifying what Jira sends.
 *
 * Facts from Atlassian's docs that shape this module:
 *   - An OAuth app gets at most 5 webhooks per user per site, so SpecFix registers ONE
 *     webhook per tenant whose JQL lists all of the tenant's projects
 *     (`project IN (...)`), and re-registers it when the project list changes.
 *   - Only `project`, `issuetype`, `status`, ... with `=`, `!=`, `IN`, `NOT IN` are
 *     allowed in the JQL filter.
 *   - Webhooks expire 30 days after creation or refresh.
 *   - Deliveries carry `Authorization: Bearer <JWT>` signed with the app's client
 *     secret. The docs do not name the algorithm; Atlassian signs app JWTs with HS256,
 *     and anything else is rejected here rather than guessed at.
 *   - Delivery is the URL Jira is given, which must be public HTTPS — a localhost
 *     development server cannot receive webhooks and relies on reconcile polling.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JiraClient } from './client.ts';

export const JIRA_WEBHOOK_EVENTS = [
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
] as const;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;

/** JQL for a tenant's single webhook: every project it syncs. */
export function webhookJql(projectKeys: readonly string[]): string {
  if (projectKeys.length === 0) throw new Error('webhookJql needs at least one project key');
  for (const key of projectKeys) {
    if (!PROJECT_KEY.test(key)) throw new Error(`invalid Jira project key: ${key}`);
  }
  return `project IN (${[...new Set(projectKeys)].map((k) => `"${k}"`).join(', ')})`;
}

/** Registers one webhook; returns its id. */
export async function registerWebhook(
  client: JiraClient,
  input: { url: string; jql: string }
): Promise<number> {
  const result = await client.request<{
    webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }>;
  }>('POST', '/webhook', {
    url: input.url,
    webhooks: [{ events: [...JIRA_WEBHOOK_EVENTS], jqlFilter: input.jql }],
  });
  const first = result.webhookRegistrationResult?.[0];
  if (!first?.createdWebhookId) {
    throw new Error(
      `Jira refused the webhook: ${(first?.errors ?? ['no reason given']).join('; ')}`
    );
  }
  return first.createdWebhookId;
}

/** Extends the listed webhooks by another 30 days; returns the new expiry. */
export async function refreshWebhooks(client: JiraClient, ids: readonly number[]): Promise<Date> {
  const result = await client.request<{ expirationDate?: string }>('PUT', '/webhook/refresh', {
    webhookIds: ids,
  });
  const expires = result.expirationDate ? new Date(result.expirationDate) : null;
  return expires && !Number.isNaN(expires.getTime())
    ? expires
    : new Date(Date.now() + 30 * 86_400_000);
}

export async function deleteWebhooks(client: JiraClient, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await client.request('DELETE', '/webhook', { webhookIds: ids });
}

/**
 * Verifies a delivery's `Authorization` header. Returns the JWT claims if the token is
 * an HS256 JWT signed with `secret` and not expired, otherwise null.
 */
export function verifyWebhookAuthorization(
  header: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Record<string, unknown> | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  const parts = match[1].split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  let jwtHeader: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    jwtHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (jwtHeader.alg !== 'HS256') return null;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url')
  );
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  if (typeof claims.exp === 'number' && claims.exp < nowSeconds - 60) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 60) return null;
  return claims;
}

export interface JiraWebhookDelivery {
  webhookEvent: string;
  issueId: string | null;
  issueKey: string | null;
  /** The site the issue lives on, from `issue.self` (e.g. https://acme.atlassian.net). */
  siteOrigin: string | null;
}

/** The parts of a delivery SpecFix uses. Everything else is re-read from the API. */
export function parseWebhookDelivery(body: unknown): JiraWebhookDelivery | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    webhookEvent?: unknown;
    issue?: { id?: unknown; key?: unknown; self?: unknown };
  };
  if (typeof b.webhookEvent !== 'string') return null;
  const issueId = b.issue?.id !== undefined ? String(b.issue.id) : null;
  let siteOrigin: string | null = null;
  if (typeof b.issue?.self === 'string') {
    try {
      siteOrigin = new URL(b.issue.self).origin;
    } catch {
      siteOrigin = null;
    }
  }
  return {
    webhookEvent: b.webhookEvent,
    issueId: issueId && /^\d+$/.test(issueId) ? issueId : null,
    issueKey: typeof b.issue?.key === 'string' ? b.issue.key : null,
    siteOrigin,
  };
}
