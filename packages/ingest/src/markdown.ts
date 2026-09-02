/**
 * Markdown ticket format, for hand-written fixtures and for pasting a ticket out
 * of Jira quickly.
 *
 *   # PAY-142 Allow partial refunds
 *
 *   ## Description
 *   A support agent should be able to refund part of an order.
 *
 *   ## Acceptance Criteria
 *   - Agent can enter an amount
 *
 * Any level-2 heading matching /acceptance criteria|ac\b/i becomes the acceptance
 * criteria block; everything else under the title becomes the description. When
 * there is no acceptance-criteria heading, acceptanceCriteriaText is empty — and
 * that absence is a real signal the analyzer is allowed to flag, so it is
 * preserved rather than papered over.
 */
import { TicketParseError } from './types.ts';

export interface ParsedMarkdownTicket {
  externalKey: string;
  title: string;
  descriptionText: string;
  acceptanceCriteriaText: string;
}

const AC_HEADING = /^(acceptance criteria|acceptance-criteria|ac)$/i;
// Leading issue key, e.g. "PAY-142 " or "PAY-142: ".
const KEY_PREFIX = /^([A-Z][A-Z0-9]+-\d+)\s*[:—-]?\s*/;

export function parseMarkdownTicket(content: string, fallbackKey: string): ParsedMarkdownTicket {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');

  let title = '';
  let externalKey = fallbackKey;
  const descriptionParts: string[] = [];
  const acParts: string[] = [];
  let current: 'none' | 'description' | 'ac' = 'none';

  for (const line of lines) {
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1 && title === '') {
      const raw = (h1[1] ?? '').trim();
      const keyMatch = KEY_PREFIX.exec(raw);
      if (keyMatch?.[1]) {
        externalKey = keyMatch[1];
        title = raw.slice(keyMatch[0].length).trim();
      } else {
        title = raw;
      }
      current = 'description';
      continue;
    }

    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      current = AC_HEADING.test((h2[1] ?? '').trim()) ? 'ac' : 'description';
      // A non-AC heading is content, so keep it in the description body.
      if (current === 'description') descriptionParts.push(line);
      continue;
    }

    if (current === 'ac') acParts.push(line);
    else if (current === 'description') descriptionParts.push(line);
  }

  if (title === '') {
    throw new TicketParseError('no level-1 heading found', fallbackKey);
  }

  return {
    externalKey,
    title,
    descriptionText: descriptionParts.join('\n').trim(),
    acceptanceCriteriaText: acParts.join('\n').trim(),
  };
}
