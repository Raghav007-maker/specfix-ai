/**
 * PM sign-off write-back: the ONLY code that loads the Jira write grant (plan D3, §9).
 *
 * It is called from the web app's "Mark ready for development" action, after markReady
 * succeeds, and from that page's retry button — never from the worker or a webhook. A
 * test (writeback-isolation) fails if any worker module imports this file.
 *
 * Each of the two writes (comment, label) claims its own (version, kind) slot first, so
 * a double click or a retry writes each at most once; a failed write can be retried and
 * a finished one never repeats.
 */
import {
  claimWriteback,
  finishWriteback,
  getJiraAccess,
  getJiraConnection,
  markJiraConnectionError,
  signOffContent,
} from '@specfix/db';
import {
  JiraAuthError,
  JiraClient,
  READY_LABEL,
  addIssueComment,
  addIssueLabel,
  jiraOAuthConfigFromEnv,
  refreshTokens,
  signOffComment,
} from '@specfix/ingest';

export type WritebackOutcome =
  | { status: 'written'; commentId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface WritebackDeps {
  /** A client authenticated with the WRITE grant for `cloudId`. */
  writeClient: (tenantId: string, cloudId: string) => Promise<JiraClient>;
  reviewUrl: (ticketId: string) => string | null;
}

async function defaultWriteClient(tenantId: string, cloudId: string): Promise<JiraClient> {
  const config = jiraOAuthConfigFromEnv();
  if (!config) throw new Error('Jira OAuth is not configured on this server.');
  const access = async () => {
    try {
      return await getJiraAccess(tenantId, 'write', (token) => refreshTokens(config, token));
    } catch (error) {
      if (error instanceof JiraAuthError) {
        await markJiraConnectionError(tenantId, 'write', error.message);
      }
      throw error;
    }
  };
  return new JiraClient({ cloudId, getAccessToken: async () => (await access()).accessToken });
}

export const defaultWritebackDeps = (): WritebackDeps => ({
  writeClient: defaultWriteClient,
  reviewUrl: (ticketId) => {
    const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
    return base ? `${base}/tickets/${ticketId}` : null;
  },
});

export async function writeBackSignOff(
  tenantId: string,
  input: { ticketId: string; userId: string },
  deps: WritebackDeps = defaultWritebackDeps()
): Promise<WritebackOutcome> {
  const content = await signOffContent(tenantId, input.ticketId);
  if (!content || content.source_type !== 'jira' || !content.jira_cloud_id) {
    return { status: 'skipped', reason: 'not a Jira ticket' };
  }
  const grant = await getJiraConnection(tenantId, 'write');
  if (!grant) return { status: 'skipped', reason: 'Jira write-back is not enabled' };
  if (grant.status === 'error') {
    return { status: 'failed', error: 'Jira write access needs to be reconnected.' };
  }

  let client: JiraClient;
  try {
    client = await deps.writeClient(tenantId, content.jira_cloud_id);
  } catch (error) {
    return { status: 'failed', error: message(error) };
  }

  const slot = { ticketId: content.ticket_id, versionId: content.version_id, userId: input.userId };
  let commentId: string | null = null;

  if (await claimWriteback(tenantId, { ...slot, kind: 'comment' })) {
    try {
      commentId = await addIssueComment(
        client,
        content.external_id,
        signOffComment({
          acceptanceCriteria: content.acceptance_criteria_text,
          clarifications: content.clarifications,
          reviewUrl: deps.reviewUrl(content.ticket_id),
        })
      );
      await finishWriteback(tenantId, {
        versionId: content.version_id,
        kind: 'comment',
        jiraRef: commentId,
      });
    } catch (error) {
      await finishWriteback(tenantId, {
        versionId: content.version_id,
        kind: 'comment',
        error: message(error),
      });
      return { status: 'failed', error: message(error) };
    }
  }

  if (await claimWriteback(tenantId, { ...slot, kind: 'label' })) {
    try {
      await addIssueLabel(client, content.external_id, READY_LABEL);
      await finishWriteback(tenantId, {
        versionId: content.version_id,
        kind: 'label',
        jiraRef: READY_LABEL,
      });
    } catch (error) {
      await finishWriteback(tenantId, {
        versionId: content.version_id,
        kind: 'label',
        error: message(error),
      });
      return { status: 'failed', error: message(error) };
    }
  }

  return { status: 'written', commentId };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error);
}
