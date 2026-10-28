/**
 * The two writes SpecFix makes to a Jira issue, both at PM sign-off: a comment holding
 * the clarified acceptance criteria, and a `specfix-ready` label. The description is
 * never edited — PMs own their text, and a comment is visible, attributable and easy to
 * ignore.
 */
import type { AdfNode } from '../adf.ts';
import type { JiraClient } from './client.ts';

export const READY_LABEL = 'specfix-ready';

const text = (t: string, marks?: Array<{ type: string; attrs?: object }>): AdfNode =>
  ({ type: 'text', text: t, ...(marks ? { marks } : {}) }) as AdfNode;
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const heading = (level: number, t: string): AdfNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(t)],
});
const bullets = (items: AdfNode[][]): AdfNode => ({
  type: 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: [paragraph(...content)] })),
});

/** Lines of plain-text acceptance criteria, without list markers. */
function criteriaLines(acceptanceCriteria: string): string[] {
  return acceptanceCriteria
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

/** The sign-off comment as an ADF document. Every string goes in as a text node. */
export function signOffComment(input: {
  acceptanceCriteria: string;
  clarifications: Array<{ question: string; answer: string | null }>;
  reviewUrl?: string | null;
}): AdfNode {
  const content: AdfNode[] = [
    paragraph(text('✅ Ready for development — reviewed in SpecFix', [{ type: 'strong' }])),
  ];

  const criteria = criteriaLines(input.acceptanceCriteria);
  content.push(heading(3, 'Acceptance criteria'));
  content.push(
    criteria.length > 0
      ? bullets(criteria.map((c) => [text(c)]))
      : paragraph(text('None written in the ticket.', [{ type: 'em' }]))
  );

  if (input.clarifications.length > 0) {
    content.push(heading(3, 'Clarified during review'));
    content.push(
      bullets(
        input.clarifications.map((c) => [
          text(c.question, [{ type: 'strong' }]),
          ...(c.answer ? [text(` — ${c.answer}`)] : []),
        ])
      )
    );
  }

  if (input.reviewUrl) {
    content.push(
      paragraph(
        text('Full review: '),
        text(input.reviewUrl, [{ type: 'link', attrs: { href: input.reviewUrl } }])
      )
    );
  }
  return { type: 'doc', content, attrs: { version: 1 } } as AdfNode;
}

/** Adds a comment; returns its id. */
export async function addIssueComment(
  client: JiraClient,
  issueId: string,
  body: AdfNode
): Promise<string> {
  if (!/^\d+$/.test(issueId)) throw new Error(`invalid Jira issue id: ${issueId}`);
  const created = await client.request<{ id?: string }>('POST', `/issue/${issueId}/comment`, {
    body,
  });
  if (!created.id) throw new Error('Jira did not return the new comment id.');
  return created.id;
}

/** Adds a label, leaving the issue's other labels alone. */
export async function addIssueLabel(
  client: JiraClient,
  issueId: string,
  label: string
): Promise<void> {
  if (!/^\d+$/.test(issueId)) throw new Error(`invalid Jira issue id: ${issueId}`);
  await client.request('PUT', `/issue/${issueId}?notifyUsers=false`, {
    update: { labels: [{ add: label }] },
  });
}
