/**
 * An authenticated Jira client for a tenant, shared by the web app and the worker.
 *
 * Token storage and refresh serialization are @specfix/db's (getJiraAccess); HTTP to
 * Atlassian is @specfix/ingest's. A refresh Atlassian refuses means the consent was
 * revoked, so it is recorded on the connection — the integrations page then asks for
 * a reconnect instead of every job failing with no explanation.
 */
import { JiraAuthError, JiraClient, jiraOAuthConfigFromEnv, refreshTokens } from '@specfix/ingest';
import { getJiraAccess, markJiraConnectionError, type JiraGrant } from '@specfix/db';
import { PermanentJobError } from './errors.ts';

export async function jiraAccess(tenantId: string): Promise<JiraGrant> {
  const config = jiraOAuthConfigFromEnv();
  // Configuration problems are permanent: retrying a job will not fix them.
  if (!config) throw new PermanentJobError('Jira OAuth is not configured on this server.');
  try {
    return await getJiraAccess(tenantId, 'read', (token) => refreshTokens(config, token));
  } catch (error) {
    if (error instanceof JiraAuthError) {
      await markJiraConnectionError(tenantId, 'read', error.message);
    }
    throw error;
  }
}

/** A client for the tenant's chosen site, plus that site's cloud id. */
export async function jiraClientFor(
  tenantId: string
): Promise<{ client: JiraClient; cloudId: string }> {
  const grant = await jiraAccess(tenantId);
  if (!grant.cloudId) throw new PermanentJobError('Choose a Jira site first.');
  const client = new JiraClient({
    cloudId: grant.cloudId,
    getAccessToken: async () => (await jiraAccess(tenantId)).accessToken,
  });
  return { client, cloudId: grant.cloudId };
}
