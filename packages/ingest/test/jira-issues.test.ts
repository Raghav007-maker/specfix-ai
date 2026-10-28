/**
 * ADF flattening and Jira issue normalization. Pure functions plus a stubbed fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  JiraClient,
  adfToText,
  backfillJql,
  normalizeJiraIssue,
  searchIssues,
  splitAcceptanceCriteria,
  type AdfNode,
} from '../src/index.ts';

const text = (t: string, marks?: unknown): AdfNode =>
  ({ type: 'text', text: t, ...(marks ? { marks } : {}) }) as AdfNode;
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const h = (level: number, t: string): AdfNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(t)],
});
const bullets = (...items: string[]): AdfNode => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [p(text(i))] })),
});
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });

describe('adfToText', () => {
  it('flattens paragraphs, lists, tables and inline nodes', () => {
    const value = doc(
      p(
        text('Checkout must be fast for '),
        { type: 'mention', attrs: { text: '@Asha' } },
        text('.')
      ),
      bullets('Card payments', 'UPI'),
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [{ type: 'listItem', content: [p(text('Third'))] }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(text('Qty'))] },
              { type: 'tableHeader', content: [p(text('Max'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(text('items'))] },
              { type: 'tableCell', content: [p(text('99'))] },
            ],
          },
        ],
      },
      p(text('line one'), { type: 'hardBreak' }, text('line two')),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      { type: 'someFutureNode', content: [p(text('kept, not dropped'))] }
    );
    expect(adfToText(value)).toBe(
      [
        'Checkout must be fast for @Asha.',
        '- Card payments',
        '- UPI',
        '3. Third',
        'Qty | Max',
        'items | 99',
        'line one',
        'line two',
        'kept, not dropped',
      ].join('\n')
    );
  });

  it('nests list items', () => {
    const nested = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p(text('Parent')), bullets('Child')],
        },
      ],
    });
    expect(adfToText(nested)).toBe('- Parent\n  - Child');
  });

  it('accepts plain strings and nothing', () => {
    expect(adfToText('  plain  ')).toBe('plain');
    expect(adfToText(null)).toBe('');
    expect(adfToText({ not: 'adf' })).toBe('');
  });
});

describe('splitAcceptanceCriteria', () => {
  it('takes the section under an AC heading, up to the next heading of the same level', () => {
    const value = doc(
      p(text('Shoppers can add items to the cart.')),
      h(2, 'Acceptance Criteria'),
      bullets('Max 99 per item', 'Show an error at 100'),
      h(3, 'Edge cases'),
      p(text('Negative quantities are rejected.')),
      h(2, 'Notes'),
      p(text('Design in Figma.'))
    );
    expect(splitAcceptanceCriteria(value)).toEqual({
      descriptionText: 'Shoppers can add items to the cart.\nNotes\nDesign in Figma.',
      acceptanceCriteriaText:
        '- Max 99 per item\n- Show an error at 100\nEdge cases\nNegative quantities are rejected.',
    });
  });

  it('treats a lone "Acceptance criteria:" paragraph as the heading', () => {
    const value = doc(
      p(text('Refund part of an order.')),
      p(text('Acceptance criteria:', [{ type: 'strong' }])),
      bullets('Agent enters an amount')
    );
    expect(splitAcceptanceCriteria(value)).toEqual({
      descriptionText: 'Refund part of an order.',
      acceptanceCriteriaText: '- Agent enters an amount',
    });
  });

  it('leaves AC empty when there is no section', () => {
    expect(splitAcceptanceCriteria(doc(p(text('Just a story.'))))).toEqual({
      descriptionText: 'Just a story.',
      acceptanceCriteriaText: '',
    });
  });
});

describe('backfillJql', () => {
  it('scopes to the project and window', () => {
    expect(backfillJql('CART', 180)).toBe(
      'project = "CART" AND updated >= -180d ORDER BY updated DESC'
    );
  });

  it('refuses a key that could alter the query', () => {
    expect(() => backfillJql('CART" OR project = "PAY', 30)).toThrow(/invalid Jira project key/);
    expect(() => backfillJql('cart', 30)).toThrow();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('searchIssues', () => {
  it('posts the JQL with the fields it needs and passes the page token through', async () => {
    const calls: RequestInit[] = [];
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: (async (_url: string, init?: RequestInit) => {
        calls.push(init!);
        return json({ issues: [{ id: '1', key: 'CART-1', fields: {} }], nextPageToken: 'n2' });
      }) as typeof fetch,
    });
    const page = await searchIssues(client, {
      jql: 'project = "CART"',
      acFieldId: 'customfield_10042',
      nextPageToken: 'n1',
    });
    expect(page.nextPageToken).toBe('n2');
    const body = JSON.parse(String(calls[0]!.body));
    expect(calls[0]!.method).toBe('POST');
    expect(body.nextPageToken).toBe('n1');
    expect(body.fields).toContain('customfield_10042');
    expect(body.fields).toContain('status');
  });

  it('stops on the last page and rejects an odd field id', async () => {
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: (async () => json({ issues: [], nextPageToken: 'x', isLast: true })) as typeof fetch,
    });
    expect((await searchIssues(client, { jql: 'x' })).nextPageToken).toBeNull();
    await expect(searchIssues(client, { jql: 'x', acFieldId: 'summary' })).rejects.toThrow();
  });
});

describe('normalizeJiraIssue', () => {
  const base = {
    id: '10001',
    key: 'CART-8',
    fields: {
      summary: 'Max 99 items per cart line',
      updated: '2026-10-20T10:00:00.000+0000',
      issuetype: { name: 'Story' },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      reporter: { accountId: 'acc-pm' },
      assignee: null,
      description: doc(
        p(text('Limit quantity.')),
        h(2, 'Acceptance criteria'),
        bullets('Reject 100')
      ),
    },
  };

  it('splits AC out of the description and keeps Jira facts aside', () => {
    const { ticket, meta } = normalizeJiraIssue(base);
    expect(ticket).toMatchObject({
      externalId: '10001',
      externalKey: 'CART-8',
      title: 'Max 99 items per cart line',
      descriptionText: 'Limit quantity.',
      acceptanceCriteriaText: '- Reject 100',
    });
    expect(ticket.sourceUpdatedAt?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(meta).toEqual({
      issueType: 'Story',
      statusName: 'In Progress',
      statusCategory: 'indeterminate',
      reporterAccountId: 'acc-pm',
      assigneeAccountId: null,
    });
  });

  it('prefers the configured AC field when it has content', () => {
    const issue = {
      ...base,
      fields: { ...base.fields, customfield_10042: doc(bullets('From the field')) },
    };
    const { ticket } = normalizeJiraIssue(issue, 'customfield_10042');
    expect(ticket.acceptanceCriteriaText).toBe('- From the field');
    // The whole description stays description when AC lives in its own field.
    expect(ticket.descriptionText).toContain('Reject 100');
  });

  it('falls back to the key when the summary is empty', () => {
    const { ticket } = normalizeJiraIssue({ id: '2', key: 'CART-9', fields: { summary: ' ' } });
    expect(ticket.title).toBe('CART-9');
    expect(ticket.descriptionText).toBe('');
  });
});
