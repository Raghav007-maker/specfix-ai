/**
 * A small Jira Cloud REST v3 client for one site, reached through api.atlassian.com
 * with an OAuth access token.
 *
 * The token comes from a callback rather than a field, so the caller can refresh it
 * (packages/db `getJiraAccess`) without this client knowing about storage. Rate
 * limiting is handled here, once: 429 and 503 are retried after Retry-After (or an
 * exponential backoff with jitter), so callers never write their own retry loops.
 */
import { JiraAuthError, JiraHttpError } from './oauth.ts';

export interface JiraClientOptions {
  cloudId: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_WAIT_MS = 30_000;

export class JiraClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: JiraClientOptions) {
    this.base = `https://api.atlassian.com/ex/jira/${encodeURIComponent(options.cloudId)}/rest/api/3`;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const search = params
      ? `?${new URLSearchParams(
          Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])
        ).toString()}`
      : '';
    return this.request<T>('GET', `${path}${search}`);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.options.getAccessToken()}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
        await this.sleep(waitMs(response.headers.get('retry-after'), attempt));
        continue;
      }
      if (response.status === 401) {
        throw new JiraAuthError('Jira rejected the access token. Reconnect Jira.');
      }
      if (!response.ok) {
        throw new JiraHttpError(
          `Jira ${method} ${path.split('?')[0]} failed (HTTP ${response.status})${await errorDetail(response)}.`,
          response.status
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }
}

function waitMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  const backoff = 1000 * 2 ** attempt;
  return Math.min(backoff + Math.random() * backoff * 0.25, MAX_WAIT_MS);
}

/** Jira's own error messages (safe to show: they describe the request, not secrets). */
async function errorDetail(response: Response): Promise<string> {
  const json = (await response.json().catch(() => null)) as {
    errorMessages?: string[];
  } | null;
  const first = json?.errorMessages?.[0];
  return first ? `: ${first.slice(0, 200)}` : '';
}
