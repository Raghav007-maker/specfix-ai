/**
 * Reads tickets from a local directory. First TicketSource implementation, and the
 * one the eval harness runs against.
 *
 * Supported per-file formats:
 *   *.json  one ticket object, or an array of them
 *   *.csv   one ticket per row, header row required
 *   *.md    one ticket, see markdown.ts
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import type { NormalizedTicket } from '@specfix/shared';
import { NormalizedTicketSchema } from '@specfix/shared';
import { parseCsvRecords } from './csv.ts';
import { parseMarkdownTicket } from './markdown.ts';
import { TicketParseError, type TicketSource } from './types.ts';

/**
 * Field aliases accepted in JSON and CSV. Real exports disagree about naming, and
 * silently reading `undefined` into a required field is how you end up analyzing
 * empty tickets and blaming the prompt.
 */
const JsonTicketSchema = z
  .object({
    externalId: z.string().optional(),
    external_id: z.string().optional(),
    id: z.string().optional(),
    key: z.string().optional(),
    externalKey: z.string().optional(),
    external_key: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    descriptionText: z.string().optional(),
    description_text: z.string().optional(),
    acceptanceCriteria: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    acceptanceCriteriaText: z.string().optional(),
    updatedAt: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export interface FileSourceOptions {
  /** Directory to read. Not recursive. */
  dir: string;
}

export class FileSource implements TicketSource {
  readonly type = 'file' as const;
  readonly origin: string;

  private cache: NormalizedTicket[] | undefined;

  constructor(private readonly options: FileSourceOptions) {
    this.origin = `file:${options.dir}`;
  }

  async list(): Promise<NormalizedTicket[]> {
    if (this.cache) return this.cache;

    const dirStat = await stat(this.options.dir).catch(() => undefined);
    if (!dirStat?.isDirectory()) {
      throw new TicketParseError('not a directory', this.options.dir);
    }

    const entries = (await readdir(this.options.dir))
      .filter((name) => ['.json', '.csv', '.md'].includes(extname(name).toLowerCase()))
      .sort();

    const tickets: NormalizedTicket[] = [];
    for (const name of entries) {
      tickets.push(...(await this.readFileTickets(name)));
    }

    const seen = new Set<string>();
    for (const ticket of tickets) {
      if (seen.has(ticket.externalId)) {
        throw new TicketParseError(`duplicate externalId "${ticket.externalId}"`, this.origin);
      }
      seen.add(ticket.externalId);
    }

    this.cache = tickets;
    return tickets;
  }

  async get(externalId: string): Promise<NormalizedTicket | undefined> {
    return (await this.list()).find((t) => t.externalId === externalId);
  }

  private async readFileTickets(name: string): Promise<NormalizedTicket[]> {
    const path = join(this.options.dir, name);
    const raw = await readFile(path, 'utf8');
    const stem = basename(name, extname(name));

    switch (extname(name).toLowerCase()) {
      case '.json': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new TicketParseError(
            `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            name
          );
        }
        const items = Array.isArray(parsed) ? parsed : [parsed];
        return items.map((item, index) =>
          normalizeRecord(item, items.length > 1 ? `${stem}-${index + 1}` : stem, name)
        );
      }
      case '.csv': {
        const records = parseCsvRecords(raw);
        return records.map((record, index) =>
          normalizeRecord(record, record['key'] || record['id'] || `${stem}-${index + 1}`, name)
        );
      }
      case '.md': {
        const parsed = parseMarkdownTicket(raw, stem);
        return [
          NormalizedTicketSchema.parse({
            externalId: stem,
            externalKey: parsed.externalKey,
            title: parsed.title,
            descriptionText: parsed.descriptionText,
            acceptanceCriteriaText: parsed.acceptanceCriteriaText,
            raw: { format: 'markdown', content: raw },
            sourceUpdatedAt: null,
          }),
        ];
      }
      default:
        return [];
    }
  }
}

function normalizeRecord(input: unknown, fallbackId: string, sourceName: string): NormalizedTicket {
  const parsed = JsonTicketSchema.safeParse(input);
  if (!parsed.success) {
    throw new TicketParseError(`unrecognized ticket shape: ${parsed.error.message}`, sourceName);
  }
  const r = parsed.data;

  const externalId = r.externalId ?? r.external_id ?? r.id ?? r.key ?? fallbackId;
  const externalKey = r.externalKey ?? r.external_key ?? r.key ?? externalId;
  const title = r.title ?? r.summary ?? '';
  const descriptionText = r.descriptionText ?? r.description_text ?? r.description ?? '';
  const acceptanceCriteriaText =
    r.acceptanceCriteriaText ?? r.acceptanceCriteria ?? r.acceptance_criteria ?? '';
  const updatedRaw = r.updatedAt ?? r.updated_at;

  if (title.trim() === '') {
    throw new TicketParseError(`ticket "${externalId}" has no title or summary`, sourceName);
  }

  let sourceUpdatedAt: Date | null = null;
  if (updatedRaw) {
    const date = new Date(updatedRaw);
    if (Number.isNaN(date.getTime())) {
      throw new TicketParseError(`ticket "${externalId}" has an invalid date`, sourceName);
    }
    sourceUpdatedAt = date;
  }

  return NormalizedTicketSchema.parse({
    externalId,
    externalKey,
    title,
    descriptionText,
    acceptanceCriteriaText,
    raw: input,
    sourceUpdatedAt,
  });
}
