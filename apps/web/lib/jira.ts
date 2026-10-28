import 'server-only';
import { hkdfSync } from 'node:crypto';
import { jiraOAuthConfigFromEnv, type JiraClient, type JiraOAuthConfig } from '@specfix/ingest';
import { jiraClientFor as syncJiraClientFor } from '@specfix/sync';

/**
 * The web app's side of the Jira connection: OAuth config and the key that signs the
 * OAuth `state`. The authenticated client (token refresh, revoked-consent handling) is
 * @specfix/sync's, shared with the worker.
 */

export { jiraAccess } from '@specfix/sync';

export const JIRA_STATE_COOKIE = 'specfix_jira_oauth';

export function jiraConfig(): JiraOAuthConfig | null {
  return jiraOAuthConfigFromEnv();
}

/**
 * The OAuth state signing key, derived from TOKEN_ENCRYPTION_KEY so there is no
 * second secret to manage. HKDF with its own label keeps it independent of the key
 * that encrypts tokens.
 */
export function stateKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set.');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(raw, 'base64'), Buffer.alloc(0), 'specfix-jira-oauth-state', 32)
  );
}

/** Whether the server has everything a Jira connection needs. */
export function jiraReady(): boolean {
  return jiraConfig() !== null && Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

/** A client for the tenant's chosen site; throws if no site has been chosen yet. */
export async function jiraClientFor(tenantId: string): Promise<JiraClient> {
  return (await syncJiraClientFor(tenantId)).client;
}
