import 'server-only';
import { hkdfSync } from 'node:crypto';
import { githubAppConfigFromEnv, type GithubAppConfig } from '@specfix/ingest';

/**
 * The web app's side of the GitHub App: its configuration and the key that signs the
 * install `state`. Installation tokens and every GitHub call are @specfix/sync's, shared
 * with the worker.
 */

export const GITHUB_STATE_COOKIE = 'specfix_github_install';

export function githubConfig(): GithubAppConfig | null {
  return githubAppConfigFromEnv();
}

/**
 * The install state signing key, derived from TOKEN_ENCRYPTION_KEY with its own HKDF
 * label, so it is independent of both the token key and the Jira state key.
 */
export function githubStateKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set.');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(raw, 'base64'),
      Buffer.alloc(0),
      'specfix-github-install-state',
      32
    )
  );
}

/** Whether the server has everything a GitHub connection needs. */
export function githubReady(): boolean {
  return githubConfig() !== null && Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}
