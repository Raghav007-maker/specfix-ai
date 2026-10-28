/**
 * Atlassian OAuth 2.0 (3LO): building the consent URL, exchanging the code, refreshing,
 * and discovering which Jira sites a grant can reach.
 *
 * No storage lives here. Callers persist the returned token set (packages/db encrypts
 * it) and pass a refresh callback back in when a token expires. Atlassian rotates
 * refresh tokens: every refresh returns a new one and the old one stops working, so
 * the returned refreshToken must always replace the stored one.
 *
 * Error messages carry Atlassian's error code and description only — never a request
 * or response body, which may contain a token.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

/** What "Connect Jira" asks for. Write access is a separate consent (plan D3). */
export const JIRA_READ_SCOPES = [
  'read:jira-work',
  'read:jira-user',
  'manage:jira-webhook',
  'offline_access',
] as const;

/** The separate write consent, used only by PM sign-off (plan D3). */
export const JIRA_WRITE_SCOPES = [...JIRA_READ_SCOPES, 'write:jira-work'] as const;

export interface JiraOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export interface JiraSite {
  cloudId: string;
  name: string;
  url: string;
  scopes: string[];
}

/** The grant was refused or revoked: reconnecting is the only fix. */
export class JiraAuthError extends Error {}

/** Any other failed call to Atlassian. */
export class JiraHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The OAuth app configured in the environment, or null when it is not set up yet. */
export function jiraOAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): JiraOAuthConfig | null {
  const clientId = env.JIRA_CLIENT_ID?.trim();
  const clientSecret = env.JIRA_CLIENT_SECRET?.trim();
  const redirectUri = env.JIRA_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(
  config: JiraOAuthConfig,
  input: { state: string; scopes?: readonly string[] }
): string {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: config.clientId,
    scope: (input.scopes ?? JIRA_READ_SCOPES).join(' '),
    redirect_uri: config.redirectUri,
    state: input.state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(
  config: JiraOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokenSet> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    },
    null,
    fetchImpl
  );
}

export async function refreshTokens(
  config: JiraOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokenSet> {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    refreshToken,
    fetchImpl
  );
}

/** The Jira sites this grant can reach. Confluence-only resources are left out. */
export async function accessibleResources(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<JiraSite[]> {
  const response = await fetchImpl(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403) {
    throw new JiraAuthError('Atlassian refused the Jira access token.');
  }
  if (!response.ok) {
    throw new JiraHttpError(
      `Listing Jira sites failed (HTTP ${response.status}).`,
      response.status
    );
  }
  const body = (await response.json()) as Array<{
    id?: string;
    name?: string;
    url?: string;
    scopes?: string[];
  }>;
  return body
    .filter((r) => r.id && r.url && (r.scopes ?? []).some((s) => s.includes('jira')))
    .map((r) => ({ cloudId: r.id!, name: r.name ?? r.url!, url: r.url!, scopes: r.scopes ?? [] }));
}

async function tokenRequest(
  body: Record<string, string>,
  previousRefreshToken: string | null,
  fetchImpl: typeof fetch
): Promise<OAuthTokenSet> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    const reason = [json.error, json.error_description].filter(Boolean).join(': ');
    const message = `Atlassian token request failed (HTTP ${response.status}${reason ? `, ${reason}` : ''}).`;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new JiraAuthError(message);
    }
    throw new JiraHttpError(message, response.status);
  }
  const refreshToken = json.refresh_token ?? previousRefreshToken;
  if (!json.access_token || !refreshToken || typeof json.expires_in !== 'number') {
    throw new JiraHttpError(
      'Atlassian token response was missing a token. Is offline_access requested?',
      response.status
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scopes: (json.scope ?? '').split(' ').filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// OAuth `state`
//
// Signed with a server key and also stored in an httpOnly cookie by the caller. The
// callback accepts a state only if it equals the cookie, verifies, and has not
// expired — so a consent started in one browser (or by an attacker) cannot complete
// in another, and the tenant it names cannot be edited in transit.
// ---------------------------------------------------------------------------

export interface OAuthState {
  tenantId: string;
  userId: string;
  /** Which grant this consent is for. Absent in states made before write-back existed. */
  grantKind?: 'read' | 'write';
  nonce: string;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60_000;

export function createState(
  input: { tenantId: string; userId: string; grantKind?: 'read' | 'write' },
  key: Buffer,
  now: number = Date.now()
): string {
  const state: OAuthState = {
    tenantId: input.tenantId,
    userId: input.userId,
    grantKind: input.grantKind ?? 'read',
    nonce: randomBytes(16).toString('base64url'),
    expiresAt: now + STATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** The state if it is authentic and unexpired, otherwise null. */
export function verifyState(
  token: string,
  key: Buffer,
  now: number = Date.now()
): OAuthState | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
    if (typeof state.expiresAt !== 'number' || state.expiresAt < now) return null;
    if (typeof state.tenantId !== 'string' || typeof state.userId !== 'string') return null;
    if (
      state.grantKind !== undefined &&
      state.grantKind !== 'read' &&
      state.grantKind !== 'write'
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
