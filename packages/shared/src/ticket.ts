/**
 * The normalized ticket shape. Every TicketSource produces this, so nothing
 * downstream of ingestion knows or cares whether a ticket came from a file or
 * from Jira.
 */
import { z } from 'zod';

export const TICKET_SOURCE_TYPES = ['file', 'jira'] as const;
export const TicketSourceTypeSchema = z.enum(TICKET_SOURCE_TYPES);
export type TicketSourceType = z.infer<typeof TicketSourceTypeSchema>;

export const NormalizedTicketSchema = z.object({
  /** Stable identifier in the source system. For files, the filename stem. */
  externalId: z.string().min(1),
  /** Human-facing key, e.g. "PAY-142". Falls back to externalId. */
  externalKey: z.string().min(1),
  title: z.string().min(1),
  /** Plain text. Jira's ADF JSON is flattened to this by packages/ingest/src/adf.ts. */
  descriptionText: z.string(),
  /**
   * Acceptance criteria pulled out separately when the source distinguishes
   * them. Empty string when the source does not — that absence is itself a
   * signal the analyzer is allowed to flag.
   */
  acceptanceCriteriaText: z.string(),
  /** Original payload, retained verbatim for audit and re-parsing. */
  raw: z.unknown(),
  sourceUpdatedAt: z.date().nullable(),
});
export type NormalizedTicket = z.infer<typeof NormalizedTicketSchema>;

/** The subset of a ticket the analyzer is allowed to read. */
export interface AnalyzableTicket {
  externalKey: string;
  title: string;
  descriptionText: string;
  acceptanceCriteriaText: string;
}

export function toAnalyzable(ticket: NormalizedTicket): AnalyzableTicket {
  return {
    externalKey: ticket.externalKey,
    title: ticket.title,
    descriptionText: ticket.descriptionText,
    acceptanceCriteriaText: ticket.acceptanceCriteriaText,
  };
}
