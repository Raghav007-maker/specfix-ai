/**
 * The Jira reads the connection setup needs: the projects on the site, and the custom
 * fields an admin might keep acceptance criteria in.
 */
import type { JiraClient } from './client.ts';

export interface JiraProjectSummary {
  id: string;
  key: string;
  name: string;
}

export interface JiraFieldSummary {
  id: string;
  name: string;
}

/** Every project the grant can see, following Jira's pagination to the end. */
export async function listJiraProjects(client: JiraClient): Promise<JiraProjectSummary[]> {
  const projects: JiraProjectSummary[] = [];
  for (let startAt = 0; ;) {
    const page = await client.get<{
      values: Array<{ id: string; key: string; name: string }>;
      isLast?: boolean;
      total?: number;
    }>('/project/search', { startAt, maxResults: 50, orderBy: 'name' });
    projects.push(...page.values.map(({ id, key, name }) => ({ id, key, name })));
    startAt += page.values.length;
    if (page.isLast || page.values.length === 0) return projects;
  }
}

/**
 * Custom text fields, the only kind acceptance criteria can live in. Paragraph fields
 * report schema type "string" too, so this one filter covers both.
 */
export async function listJiraTextFields(client: JiraClient): Promise<JiraFieldSummary[]> {
  const fields =
    await client.get<
      Array<{ id: string; name: string; custom?: boolean; schema?: { type?: string } }>
    >('/field');
  return fields
    .filter((f) => f.custom && f.schema?.type === 'string')
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
