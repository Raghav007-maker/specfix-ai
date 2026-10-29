/**
 * The GitHub App itself: its configuration, the RS256 JWT that authenticates as the app,
 * and the exchanges that turn that JWT into an installation access token, or an
 * installation's OAuth code into proof of who installed it.
 *
 * No storage lives here (packages/db caches installation tokens, encrypted) and nothing
 * here logs a token. Error messages carry the endpoint and HTTP status only — never a
 * request or response body, which may contain a token.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export const GITHUB_API = 'https://api.github.com';
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface GithubAppConfig {
  appId: string;
  /** The app's URL name: https://github.com/apps/<slug>. */
  slug: string;
  privateKey: KeyObject;
  /** OAuth credentials of the app, used to confirm who completed an installation. */
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

/** The credentials were refused (bad JWT, revoked installation, expired token). */
export class GithubAuthError extends Error {}

/** Any other failed call to GitHub. */
export class GithubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * The app configured in the environment, or null when any part is missing. The private
 * key may be the PEM itself (with real or `\n`-escaped newlines) or the PEM base64-encoded,
 * which survives `.env` files and secret stores that mangle newlines.
 */
export function githubAppConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!appId || !slug || !rawKey || !clientId || !clientSecret || !webhookSecret) return null;
  if (!/^\d+$/.test(appId) || !/^[a-z0-9-]+$/i.test(slug)) return null;
  const privateKey = parsePrivateKey(rawKey);
  if (!privateKey) return null;
  return { appId, slug, privateKey, clientId, clientSecret, webhookSecret };
}

function parsePrivateKey(raw: string): KeyObject | null {
  const pem = raw.includes('BEGIN')
    ? raw.replace(/\\n/g, '\n')
    : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch {
    return null;
  }
}

/**
 * A JWT that authenticates as the app, valid for at most 10 minutes (GitHub's limit).
 * `iat` is backdated a minute to absorb clock drift between this server and GitHub.
 */
export function appJwt(
  config: Pick<GithubAppConfig, 'appId' | 'privateKey'>,
  now: number = Date.now()
): string {
  const seconds = Math.floor(now / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const body = enc({ iat: seconds - 60, exp: seconds + 540, iss: config.appId });
  const signature = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(config.privateKey)
    .toString('base64url');
  return `${head}.${body}.${signature}`;
}

export const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'SpecFix',
} as const;

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/** Exchanges the app JWT for a one-hour token of one installation. */
export async function createInstallationToken(
  config: Pick<GithubAppConfig, 'appId' | 'privateKey'>,
  installationId: number,
  fetchImpl: typeof fetch = fetch
): Promise<InstallationToken> {
  const response = await fetchImpl(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    { method: 'POST', headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${appJwt(config)}` } }
  );
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GithubAuthError(
      `GitHub refused an installation token (HTTP ${response.status}). Is the app still installed?`
    );
  }
  if (!response.ok) {
    throw new GithubHttpError(
      `GitHub installation token request failed (HTTP ${response.status}).`,
      response.status
    );
  }
  const json = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    expires_at?: unknown;
  };
  const expiresAt = typeof json.expires_at === 'string' ? new Date(json.expires_at) : null;
  if (typeof json.token !== 'string' || !json.token || !expiresAt || isNaN(expiresAt.getTime())) {
    throw new GithubHttpError('GitHub installation token response was incomplete.', 502);
  }
  return { token: json.token, expiresAt };
}

export interface GithubInstallationInfo {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
}

/** What the app knows about one of its installations (authenticated as the app). */
export async function getInstallation(
  config: Pick<GithubAppConfig, 'appId' | 'privateKey'>,
  installationId: number,
  fetchImpl: typeof fetch = fetch
): Promise<GithubInstallationInfo> {
  const response = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${appJwt(config)}` },
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GithubAuthError('GitHub does not know this installation of the app.');
  }
  if (!response.ok) {
    throw new GithubHttpError(
      `Reading the GitHub installation failed (HTTP ${response.status}).`,
      response.status
    );
  }
  const json = (await response.json().catch(() => ({}))) as {
    id?: unknown;
    account?: { login?: unknown; type?: unknown } | null;
    repository_selection?: unknown;
  };
  if (json.id !== installationId || typeof json.account?.login !== 'string') {
    throw new GithubHttpError('GitHub installation response was incomplete.', 502);
  }
  return {
    installationId,
    accountLogin: json.account.login.slice(0, 100),
    accountType: typeof json.account.type === 'string' ? json.account.type.slice(0, 40) : 'User',
    repositorySelection:
      json.repository_selection === 'all'
        ? 'all'
        : ('selected' as GithubInstallationInfo['repositorySelection']),
  };
}

/**
 * Confirms that the person who completed the installation can actually see it.
 *
 * The installation id in the setup redirect is a plain query parameter: anyone could
 * paste another organisation's id into it. With "Request user authorization (OAuth)
 * during installation" enabled, GitHub adds a one-time `code`; exchanging it gives a
 * user token, and only an installation listed under /user/installations for that user
 * is accepted. The user token is used for this one check and then dropped.
 */
export async function userCanAccessInstallation(
  config: Pick<GithubAppConfig, 'clientId' | 'clientSecret'>,
  code: string,
  installationId: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const tokenResponse = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  if (!tokenResponse.ok) {
    throw new GithubHttpError(
      `GitHub OAuth code exchange failed (HTTP ${tokenResponse.status}).`,
      tokenResponse.status
    );
  }
  const tokenJson = (await tokenResponse.json().catch(() => ({}))) as { access_token?: unknown };
  // GitHub answers a bad or reused code with 200 and an `error` field.
  if (typeof tokenJson.access_token !== 'string' || !tokenJson.access_token) {
    throw new GithubAuthError('GitHub did not accept the authorization code.');
  }

  // A person sees at most a few hundred installations; stop after 10 pages either way.
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!response.ok) {
      throw new GithubHttpError(
        `Listing the user's GitHub installations failed (HTTP ${response.status}).`,
        response.status
      );
    }
    const json = (await response.json().catch(() => ({}))) as {
      installations?: Array<{ id?: unknown }>;
    };
    const list = Array.isArray(json.installations) ? json.installations : [];
    if (list.some((i) => i.id === installationId)) return true;
    if (list.length < 100) return false;
  }
  return false;
}
