/**
 * Atlassian Document Format (ADF) → plain text.
 *
 * Jira Cloud returns rich-text fields (description, paragraph custom fields) as an ADF
 * JSON tree. The analyzer reads plain text, so this flattens the tree into readable
 * lines: paragraphs and headings on their own lines, list items as "- " / "1. ",
 * table rows as "a | b", mentions and links as their visible text. Unknown node types
 * are not dropped — their children are still walked — because silently losing a
 * sentence of a requirement is worse than rendering it plainly.
 *
 * splitAcceptanceCriteria pulls an "Acceptance criteria" section out of a description,
 * matching how the Markdown parser treats an AC heading: everything under it, up to
 * the next heading of the same or a higher level, is acceptance criteria. A paragraph
 * that is only "Acceptance criteria:" (often bold) counts as a heading, since that is
 * how many teams write it in Jira. With no such section, acceptance criteria are empty
 * — an absence the analyzer is allowed to flag.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const AC_LABEL = /^\s*(acceptance[\s-]*criteria|ac)\s*:?\s*$/i;

/** Plain text of an ADF document, a node, a plain string, or nothing. */
export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (!isNode(value)) return '';
  return tidy(blocks(value.type === 'doc' ? (value.content ?? []) : [value]).join('\n'));
}

export function splitAcceptanceCriteria(value: unknown): {
  descriptionText: string;
  acceptanceCriteriaText: string;
} {
  if (!isNode(value)) {
    return { descriptionText: adfToText(value), acceptanceCriteriaText: '' };
  }
  const nodes = value.type === 'doc' ? (value.content ?? []) : [value];
  const description: AdfNode[] = [];
  const criteria: AdfNode[] = [];
  let acLevel: number | null = null;

  for (const node of nodes) {
    const level = headingLevel(node);
    if (level !== null) {
      if (AC_LABEL.test(inline(node.content ?? []))) {
        acLevel = level;
        continue;
      }
      if (acLevel !== null && level <= acLevel) acLevel = null;
    }
    (acLevel !== null ? criteria : description).push(node);
  }

  return {
    descriptionText: tidy(blocks(description).join('\n')),
    acceptanceCriteriaText: tidy(blocks(criteria).join('\n')),
  };
}

/**
 * A heading's level; a paragraph that is only an AC label is treated as a level-6
 * heading, so the section it opens ends at the next real heading.
 */
function headingLevel(node: AdfNode): number | null {
  if (node.type === 'heading') return Number(node.attrs?.level ?? 1);
  if (node.type === 'paragraph' && AC_LABEL.test(inline(node.content ?? []))) return 6;
  return null;
}

function blocks(nodes: AdfNode[], indent = ''): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        lines.push(indent + inline(node.content ?? []));
        break;
      case 'bulletList':
      case 'orderedList': {
        let n = Number(node.attrs?.order ?? 1);
        for (const item of node.content ?? []) {
          const marker = node.type === 'bulletList' ? '- ' : `${n++}. `;
          const [first = '', ...rest] = blocks(item.content ?? [], indent + '  ');
          lines.push(indent + marker + first.trimStart(), ...rest);
        }
        break;
      }
      case 'taskList':
        for (const item of node.content ?? []) {
          const done = item.attrs?.state === 'DONE' ? 'x' : ' ';
          lines.push(`${indent}- [${done}] ${inline(item.content ?? [])}`);
        }
        break;
      case 'codeBlock':
        lines.push(
          ...inline(node.content ?? [])
            .split('\n')
            .map((l) => indent + l)
        );
        break;
      case 'blockquote':
      case 'panel':
      case 'expand':
      case 'nestedExpand':
        if (typeof node.attrs?.title === 'string') lines.push(indent + node.attrs.title);
        lines.push(...blocks(node.content ?? [], indent));
        break;
      case 'table':
        for (const row of node.content ?? []) {
          lines.push(
            indent +
              (row.content ?? [])
                .map((cell) =>
                  blocks(cell.content ?? [])
                    .join(' ')
                    .trim()
                )
                .join(' | ')
          );
        }
        break;
      case 'rule':
        lines.push('');
        break;
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        // Attachments carry no text the analyzer can read.
        break;
      default:
        if (node.content) lines.push(...blocks(node.content, indent));
        else if (node.text) lines.push(indent + node.text);
    }
  }
  return lines;
}

function inline(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text ?? '';
        case 'hardBreak':
          return '\n';
        case 'mention':
        case 'status':
        case 'emoji':
          return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
        case 'inlineCard':
        case 'blockCard':
          return String(node.attrs?.url ?? '');
        case 'date': {
          const ts = Number(node.attrs?.timestamp);
          return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
        }
        default:
          return node.content ? inline(node.content) : (node.text ?? '');
      }
    })
    .join('');
}

/** Trims line ends and collapses runs of blank lines to one. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && typeof (value as AdfNode).type === 'string';
}
