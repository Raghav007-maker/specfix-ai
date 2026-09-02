import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseCsvRecords, parseMarkdownTicket, FileSource } from '../src/index.ts';

const sampleDir = fileURLToPath(new URL('../../../fixtures/tickets/sample', import.meta.url));

describe('parseCsv', () => {
  it('handles quoted fields containing commas and newlines', () => {
    const rows = parseCsv('a,b\n"x,1","line1\nline2"\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'line1\nline2'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('normalizes CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a BOM so the first header is not corrupted', () => {
    expect(parseCsvRecords('\uFEFFkey,title\nA-1,Hello')[0]).toEqual({
      key: 'A-1',
      title: 'Hello',
    });
  });

  it('throws on an unterminated quote rather than guessing', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });

  it('normalizes header names to snake_case keys', () => {
    expect(parseCsvRecords('Issue Key,Acceptance-Criteria\nA-1,x')[0]).toEqual({
      issue_key: 'A-1',
      acceptance_criteria: 'x',
    });
  });
});

describe('parseMarkdownTicket', () => {
  it('extracts the issue key out of the title', () => {
    const t = parseMarkdownTicket('# PAY-142 Allow partial refunds\n\nbody', 'fallback');
    expect(t.externalKey).toBe('PAY-142');
    expect(t.title).toBe('Allow partial refunds');
  });

  it('falls back to the given key when the title has none', () => {
    const t = parseMarkdownTicket('# Allow partial refunds\n', 'file-stem');
    expect(t.externalKey).toBe('file-stem');
    expect(t.title).toBe('Allow partial refunds');
  });

  it('splits acceptance criteria out of the description', () => {
    const t = parseMarkdownTicket(
      '# A-1 Title\n\n## Description\nDesc line\n\n## Acceptance Criteria\n- one\n- two\n',
      'A-1'
    );
    expect(t.descriptionText).toContain('Desc line');
    expect(t.descriptionText).not.toContain('- one');
    expect(t.acceptanceCriteriaText).toBe('- one\n- two');
  });

  it('leaves acceptance criteria empty when the ticket has none, rather than inventing them', () => {
    const t = parseMarkdownTicket('# A-1 Title\n\nJust a description.\n', 'A-1');
    expect(t.acceptanceCriteriaText).toBe('');
  });

  it('throws when there is no title', () => {
    expect(() => parseMarkdownTicket('no heading here', 'A-1')).toThrow(/level-1 heading/);
  });
});

describe('FileSource', () => {
  it('reads markdown, JSON arrays and CSV out of one directory', async () => {
    const tickets = await new FileSource({ dir: sampleDir }).list();
    const keys = tickets.map((t) => t.externalKey);

    // One representative per format rather than the whole inventory: adding a
    // fixture ticket should not break this test.
    expect(keys).toContain('PAY-142'); // markdown
    expect(keys).toContain('AUTH-88'); // JSON array
    expect(keys).toContain('INV-204'); // CSV export
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('normalizes every format to the same shape', async () => {
    const tickets = await new FileSource({ dir: sampleDir }).list();
    for (const ticket of tickets) {
      expect(ticket.title.length).toBeGreaterThan(0);
      expect(typeof ticket.descriptionText).toBe('string');
      expect(typeof ticket.acceptanceCriteriaText).toBe('string');
    }
  });

  it('parses the JSON summary/description aliases', async () => {
    const ticket = await new FileSource({ dir: sampleDir }).get('AUTH-88');
    expect(ticket?.title).toBe('Add "remember me" to login');
    expect(ticket?.descriptionText).toContain('log in every time');
    expect(ticket?.sourceUpdatedAt?.toISOString()).toBe('2026-08-14T09:12:00.000Z');
  });

  it('preserves multi-line CSV acceptance criteria', async () => {
    const ticket = await new FileSource({ dir: sampleDir }).get('INV-204');
    expect(ticket?.acceptanceCriteriaText.split('\n')).toHaveLength(3);
  });

  it('retains the raw payload for re-parsing', async () => {
    const ticket = await new FileSource({ dir: sampleDir }).get('PAY-142');
    expect(ticket?.raw).toMatchObject({ format: 'markdown' });
  });

  it('errors on a directory that does not exist', async () => {
    await expect(new FileSource({ dir: 'E:/specfix/does-not-exist' }).list()).rejects.toThrow(
      /not a directory/
    );
  });
});
