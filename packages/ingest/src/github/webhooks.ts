/**
 * GitHub webhook deliveries: verifying `X-Hub-Signature-256` and reading the few fields
 * SpecFix acts on.
 *
 * The signature is an HMAC-SHA256 of the exact request bytes with the app's webhook
 * secret, so it is checked over the raw body before anything parses it. The body is then
 * authentic but still untrusted text (PR titles and bodies are written by anyone with
 * push access), so only ids and enumerated values are taken from it; the worker re-reads
 * the pull request through the API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** True only for a well-formed `sha256=<64 hex>` header that matches the body. */
export function verifyGithubSignature(
  body: Uint8Array,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!header || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(match[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Signs a body the way GitHub does. For tests and local tooling. */
export function signGithubBody(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** X-GitHub-Delivery is a GUID; anything else is refused rather than stored. */
export function isGithubDeliveryId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);
}

export const GITHUB_EVENTS = [
  'ping',
  'pull_request',
  'installation',
  'installation_repositories',
] as const;
export type GithubEvent = (typeof GITHUB_EVENTS)[number];

/** The pull_request actions that can change links, warnings or the head commit. */
const PR_ACTIONS = new Set([
  'opened',
  'edited',
  'reopened',
  'synchronize',
  'closed',
  'ready_for_review',
]);

export type GithubDelivery =
  | { event: 'ping' }
  | {
      event: 'pull_request';
      action: string;
      installationId: number;
      repoId: number;
      number: number;
    }
  | {
      event: 'installation';
      action: 'deleted' | 'suspend' | 'unsuspend' | 'other';
      installationId: number;
    }
  | { event: 'installation_repositories'; action: string; installationId: number };

const positiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;

/**
 * The parts of a delivery SpecFix acts on, or null for an event it ignores (an unknown
 * event, an uninteresting action, or a body missing the ids).
 */
export function parseGithubDelivery(event: string | null, body: unknown): GithubDelivery | null {
  if (event === 'ping') return { event: 'ping' };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const action = typeof b.action === 'string' ? b.action.slice(0, 40) : '';
  const installationId = positiveInt((b.installation as { id?: unknown } | null)?.id);
  if (!installationId) return null;

  if (event === 'pull_request') {
    if (!PR_ACTIONS.has(action)) return null;
    const repoId = positiveInt((b.repository as { id?: unknown } | null)?.id);
    const number =
      positiveInt(b.number) ?? positiveInt((b.pull_request as { number?: unknown } | null)?.number);
    if (!repoId || !number || number > 2_147_483_647) return null;
    return { event, action, installationId, repoId, number };
  }
  if (event === 'installation') {
    const known = action === 'deleted' || action === 'suspend' || action === 'unsuspend';
    return { event, action: known ? action : 'other', installationId };
  }
  if (event === 'installation_repositories') {
    return { event, action, installationId };
  }
  return null;
}
