/**
 * Ingestion boundary.
 *
 * Everything downstream of this interface sees only NormalizedTicket. That is what
 * lets the analysis core and the eval harness run against local fixtures. Portal tasks
 * reach the same shape through sendTaskForSpecReview.
 */
import type { NormalizedTicket, TicketSourceType } from '@specfix/shared';

export interface TicketSource {
  readonly type: TicketSourceType;
  /** Human-readable description of where these tickets came from, for logs and reports. */
  readonly origin: string;
  list(): Promise<NormalizedTicket[]>;
  get(externalId: string): Promise<NormalizedTicket | undefined>;
}

export class TicketParseError extends Error {
  constructor(
    message: string,
    readonly source: string
  ) {
    super(`${source}: ${message}`);
    this.name = 'TicketParseError';
  }
}
