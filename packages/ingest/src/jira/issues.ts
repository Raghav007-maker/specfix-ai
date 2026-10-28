/**
 * Reading Jira issues and turning them into NormalizedTicket.
 *
 * Search uses POST /rest/api/3/search/jql with nextPageToken pagination (the older
 * /search endpoint is deprecated). The page token is handed back to the caller so a
 * backfill can checkpoint it and resume after a crash instead of starting over.
 */
import { NormalizedTicketSchema, type NormalizedTicket } from '@specfix/shared';
import { adfToText, splitAcceptanceCriteria } from '../adf.ts';
import type { JiraClient } from './client.ts';
import { JiraHttpError } from './oauth.ts';

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    updated?: string;
    issuetype?: { name?: string };
    status?: { name?: string; statusCategory?: { key?: string } };
    reporter?: { accountId?: string } | null;
    assignee?: { accountId?: string } | null;
    project?: { key?: string };
  };
}

export interface JiraIssueMeta {
  issueType: string | null;
  statusName: string | null;
  statusCategory: string | null;
  reporterAccountId: string | null;
  assigneeAccountId: string | null;
}

export interface IssuePage {
  issues: JiraIssue[];
  nextPageToken: string | null;
}

const BASE_FIELDS = [
  'project',
  'summary',
  'description',
  'updated',
  'issuetype',
  'status',
  'reporter',
  'assignee',
];

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
const CUSTOM_FIELD = /^customfield_\d+$/;

/** JQL for a backfill: the project's issues updated within the window, newest first. */
export function backfillJql(projectKey: string, windowDays: number): string {
  // Keys come from Jira, but they are interpolated into a query: refuse anything odd.
  if (!PROJECT_KEY.test(projectKey)) throw new Error(`invalid Jira project key: ${projectKey}`);
  const days = Math.max(1, Math.floor(windowDays));
  return `project = "${projectKey}" AND updated >= -${days}d ORDER BY updated DESC`;
}

/**
 * JQL for reconcile: issues in any of the projects updated in the last `minutes`.
 * Relative minutes, not a timestamp, so the site's time zone never matters.
 */
export function reconcileJql(projectKeys: readonly string[], minutes: number): string {
  if (projectKeys.length === 0) throw new Error('reconcileJql needs at least one project key');
  for (const key of projectKeys) {
    if (!PROJECT_KEY.test(key)) throw new Error(`invalid Jira project key: ${key}`);
  }
  const keys = [...new Set(projectKeys)].map((k) => `"${k}"`).join(', ');
  const m = Math.max(1, Math.ceil(minutes));
  return `project IN (${keys}) AND updated >= -${m}m ORDER BY updated DESC`;
}

export async function searchIssues(
  client: JiraClient,
  input: {
    jql: string;
    acFieldId?: string | null;
    nextPageToken?: string | null;
    pageSize?: number;
  }
): Promise<IssuePage> {
  const fields = [...BASE_FIELDS];
  if (input.acFieldId) {
    if (!CUSTOM_FIELD.test(input.acFieldId)) {
      throw new Error(`invalid acceptance-criteria field id: ${input.acFieldId}`);
    }
    fields.push(input.acFieldId);
  }
  const page = await client.request<{
    issues?: JiraIssue[];
    nextPageToken?: string;
    isLast?: boolean;
  }>('POST', '/search/jql', {
    jql: input.jql,
    fields,
    maxResults: input.pageSize ?? 100,
    ...(input.nextPageToken ? { nextPageToken: input.nextPageToken } : {}),
  });
  const issues = page.issues ?? [];
  const more = page.nextPageToken && page.isLast !== true && issues.length > 0;
  return { issues, nextPageToken: more ? page.nextPageToken! : null };
}

/** One issue by id, or null when it no longer exists or this grant cannot see it. */
export async function getIssue(
  client: JiraClient,
  issueId: string,
  acFieldId?: string | null
): Promise<JiraIssue | null> {
  if (!/^\d+$/.test(issueId)) throw new Error(`invalid Jira issue id: ${issueId}`);
  const fields = [...BASE_FIELDS];
  if (acFieldId) {
    if (!CUSTOM_FIELD.test(acFieldId)) {
      throw new Error(`invalid acceptance-criteria field id: ${acFieldId}`);
    }
    fields.push(acFieldId);
  }
  try {
    return await client.get<JiraIssue>(`/issue/${issueId}`, { fields: fields.join(',') });
  } catch (error) {
    if (error instanceof JiraHttpError && (error.status === 404 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}

/**
 * One Jira issue as a NormalizedTicket plus the Jira facts kept beside it. Acceptance
 * criteria come from the configured custom field when it has content, otherwise from
 * an "Acceptance criteria" section of the description.
 */
export function normalizeJiraIssue(
  issue: JiraIssue,
  acFieldId?: string | null
): { ticket: NormalizedTicket; meta: JiraIssueMeta } {
  const fields = issue.fields;
  const acField = acFieldId ? fields[acFieldId] : undefined;
  const fieldCriteria = adfToText(acField);

  const { descriptionText, acceptanceCriteriaText } = fieldCriteria
    ? { descriptionText: adfToText(fields.description), acceptanceCriteriaText: fieldCriteria }
    : splitAcceptanceCriteria(fields.description);

  const updated = fields.updated ? new Date(fields.updated) : null;
  const ticket = NormalizedTicketSchema.parse({
    externalId: issue.id,
    externalKey: issue.key,
    title: fields.summary?.trim() || issue.key,
    descriptionText,
    acceptanceCriteriaText,
    raw: { description: fields.description ?? null, acceptanceCriteria: acField ?? null },
    sourceUpdatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
  });

  return {
    ticket,
    meta: {
      issueType: fields.issuetype?.name ?? null,
      statusName: fields.status?.name ?? null,
      statusCategory: fields.status?.statusCategory?.key ?? null,
      reporterAccountId: fields.reporter?.accountId ?? null,
      assigneeAccountId: fields.assignee?.accountId ?? null,
    },
  };
}
