/**
 * Ingestion boundary.
 *
 * Everything downstream of this interface sees only NormalizedTicket. That is what
 * lets the analysis core and the eval harness run against local fixtures in week 1
 * while the Jira adapter — OAuth 3LO, ADF flattening, webhook verification — is
 * still weeks away. JiraSource will implement this same interface and nothing else
 * will change.
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
