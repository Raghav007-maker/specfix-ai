/**
 * GitHub App pure logic: the RS256 app JWT, config parsing, webhook signature checks,
 * delivery parsing, Jira-key linking, the acceptance verdict, the PR comment, and the
 * REST client's input validation and error hygiene (against a fake fetch).
 */
import { describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  GithubAuthError,
  GithubClient,
  GithubHttpError,
  NOT_READY_MARKER,
  appJwt,
  createInstallationToken,
  githubAppConfigFromEnv,
  isGithubDeliveryId,
  isRepoFullName,
  isSafeBranchName,
  jiraKeysInPullRequest,
  notReadyComment,
  parseGithubDelivery,
  safeRefSegment,
  signGithubBody,
  summarizeAcceptance,
  userCanAccessInstallation,
  verifyGithubSignature,
} from '@specfix/ingest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const env = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_SLUG: 'specfix-test',
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_CLIENT_ID: 'Iv1.abc',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITHUB_WEBHOOK_SECRET: 'whsec',
};

type Call = { url: string; method: string; body: unknown; auth: string | null };
function fakeFetch(respond: (call: Call) => { status: number; body?: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get('authorization'),
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('githubAppConfigFromEnv', () => {
  it('reads a PEM, an escaped-newline PEM and a base64 PEM', () => {
    expect(githubAppConfigFromEnv(env)?.appId).toBe('123456');
    expect(
      githubAppConfigFromEnv({ ...env, GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') })
    ).not.toBeNull();
    expect(
      githubAppConfigFromEnv({
        ...env,
        GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64'),
      })
    ).not.toBeNull();
  });

  it.each([
    ['missing secret', { GITHUB_WEBHOOK_SECRET: '' }],
    ['garbage key', { GITHUB_APP_PRIVATE_KEY: 'not a key' }],
    ['non-numeric app id', { GITHUB_APP_ID: '12; rm -rf' }],
    ['slug with a slash', { GITHUB_APP_SLUG: 'evil/../x' }],
  ])('is null for %s', (_n, patch) => {
    expect(githubAppConfigFromEnv({ ...env, ...patch })).toBeNull();
  });
});

describe('appJwt', () => {
  it('is an RS256 JWT the public key verifies, issued by the app, valid under 10 minutes', () => {
    const now = Date.UTC(2026, 9, 28, 12);
    const jwt = appJwt({ appId: '123456', privateKey }, now);
    const [head, body, sig] = jwt.split('.');
    const verify = createVerify('RSA-SHA256').update(`${head}.${body}`);
    expect(verify.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    expect(claims.iss).toBe('123456');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(now / 1000);
  });
});

describe('verifyGithubSignature', () => {
  const body = new TextEncoder().encode('{"action":"opened"}');
  const good = signGithubBody(body, 'whsec');

  it('accepts the exact signature', () => {
    expect(verifyGithubSignature(body, good, 'whsec')).toBe(true);
  });

  it.each([
    ['no header', null],
    ['empty', ''],
    ['wrong secret', signGithubBody(body, 'other')],
    ['sha1 scheme', good.replace('sha256=', 'sha1=')],
    ['truncated', good.slice(0, -2)],
    ['uppercase hex', good.toUpperCase()],
    ['extra suffix', `${good}00`],
  ])('rejects %s', (_n, header) => {
    expect(verifyGithubSignature(body, header, 'whsec')).toBe(false);
  });

  it('rejects a body changed by one byte, and an empty secret', () => {
    const tampered = new TextEncoder().encode('{"action":"opened "}');
    expect(verifyGithubSignature(tampered, good, 'whsec')).toBe(false);
    expect(verifyGithubSignature(body, signGithubBody(body, ''), '')).toBe(false);
  });
});

describe('parseGithubDelivery', () => {
  const pr = (patch: Record<string, unknown> = {}) => ({
    action: 'opened',
    number: 7,
    installation: { id: 42 },
    repository: { id: 99 },
    ...patch,
  });

  it('reads a pull_request delivery', () => {
    expect(parseGithubDelivery('pull_request', pr())).toEqual({
      event: 'pull_request',
      action: 'opened',
      installationId: 42,
      repoId: 99,
      number: 7,
    });
  });

  it.each([
    ['an ignored action', pr({ action: 'labeled' })],
    ['no installation', pr({ installation: null })],
    ['string ids', pr({ number: '7' })],
    ['a negative number', pr({ number: -1 })],
    ['a huge number', pr({ number: 2 ** 40 })],
    ['an array body', []],
  ])('ignores %s', (_n, body) => {
    expect(parseGithubDelivery('pull_request', body)).toBeNull();
  });

  it('reads installation events and ignores unknown events', () => {
    expect(
      parseGithubDelivery('installation', { action: 'deleted', installation: { id: 1 } })
    ).toEqual({ event: 'installation', action: 'deleted', installationId: 1 });
    expect(
      parseGithubDelivery('installation', { action: 'created', installation: { id: 1 } })
    ).toMatchObject({ action: 'other' });
    expect(parseGithubDelivery('push', pr())).toBeNull();
    expect(parseGithubDelivery('ping', null)).toEqual({ event: 'ping' });
  });

  it('accepts only GUID-like delivery ids', () => {
    expect(isGithubDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
    expect(isGithubDeliveryId("x'; drop table")).toBe(false);
    expect(isGithubDeliveryId('a'.repeat(65))).toBe(false);
    expect(isGithubDeliveryId(null)).toBe(false);
  });
});

describe('jiraKeysInPullRequest', () => {
  it('finds keys in branch (any case), title and body (upper case), first source wins', () => {
    expect(
      jiraKeysInPullRequest({
        branch: 'feature/cart-12-limit',
        title: 'CART-12 and CART-13: limit quantity',
        body: 'Also fixes PAY-7. Not utf-8 or iso-8859.',
      })
    ).toEqual([
      { key: 'CART-12', source: 'branch' },
      { key: 'CART-13', source: 'title' },
      { key: 'PAY-7', source: 'body' },
    ]);
  });

  it('normalizes leading zeros and ignores keys glued to other words', () => {
    expect(
      jiraKeysInPullRequest({ branch: 'specfix/CART-007', title: 'xCART-1 CART-2x', body: null })
    ).toEqual([{ key: 'CART-7', source: 'branch' }]);
  });

  it('stops at 20 keys and scans only the start of a long body', () => {
    const many = Array.from({ length: 100 }, (_, i) => `KK-${i + 1}`).join(' ');
    expect(jiraKeysInPullRequest({ branch: 'x', title: '', body: many })).toHaveLength(20);
    const late = `${'a '.repeat(20_000)} CART-1`;
    expect(jiraKeysInPullRequest({ branch: 'x', title: '', body: late })).toEqual([]);
  });
});

describe('summarizeAcceptance', () => {
  const t = (...statuses: Array<'passed' | 'failed' | 'flaky' | 'skipped' | null>) => ({
    key: 'CART-1',
    scenarios: statuses.map((status) => ({ status })),
  });

  it('is success only when every scenario passed (flaky counts as passing)', () => {
    expect(summarizeAcceptance({ tickets: [t('passed', 'flaky')] })).toMatchObject({
      conclusion: 'success',
      title: '2/2 scenarios passing',
    });
  });

  it('is failure when any failed, e.g. "4/5 scenarios passing"', () => {
    expect(
      summarizeAcceptance({ tickets: [t('passed', 'passed', 'passed', 'passed', 'failed')] })
    ).toMatchObject({ conclusion: 'failure', title: '4/5 scenarios passing' });
  });

  it('is neutral with nothing to judge or with unreported scenarios', () => {
    expect(summarizeAcceptance({ tickets: [] }).conclusion).toBe('neutral');
    expect(summarizeAcceptance({ tickets: [t(null, null)] }).conclusion).toBe('neutral');
    expect(summarizeAcceptance({ tickets: [t('passed', null)] })).toMatchObject({
      conclusion: 'neutral',
      title: '1/2 scenarios passing',
    });
  });
});

describe('notReadyComment', () => {
  it('names keys only, with the marker, and has a resolved form', () => {
    const body = notReadyComment({
      notReady: [{ key: 'CART-1', url: 'https://specfix.example/tickets/x' }],
      ready: ['CART-2'],
    });
    expect(body.startsWith(NOT_READY_MARKER)).toBe(true);
    expect(body).toContain('[CART-1](https://specfix.example/tickets/x)');
    expect(notReadyComment({ notReady: [], ready: ['CART-1'] })).toContain('now ready');
    const two = notReadyComment({
      notReady: [
        { key: 'CART-1', url: null },
        { key: 'CART-2', url: null },
      ],
      ready: [],
    });
    expect(two).toContain('these tickets are');
    expect(two).toContain('Their open questions');
  });
});

describe('names that end up in URLs and refs', () => {
  it.each(['acme/web', 'a.b/c-d_e'])('accepts repo %s', (n) =>
    expect(isRepoFullName(n)).toBe(true)
  );
  it.each(['acme', 'acme/web/x', '../x', 'acme/..', 'ac me/web', 'acme/web?x=1'])(
    'refuses repo %s',
    (n) => expect(isRepoFullName(n)).toBe(false)
  );
  it.each(['main', 'specfix/CART-1', 'release/1.2'])('accepts branch %s', (b) =>
    expect(isSafeBranchName(b)).toBe(true)
  );
  it.each(['', 'a..b', '/x', 'x/', 'a//b', 'x.lock', 'a b', 'a~1', 'x\n'])(
    'refuses branch %j',
    (b) => expect(isSafeBranchName(b)).toBe(false)
  );
  it('makes ticket keys safe ref segments', () => {
    expect(safeRefSegment('CART-1')).toBe('CART-1');
    expect(safeRefSegment('../evil key')).toBe('evil-key');
    expect(safeRefSegment('...')).toBe('ticket');
  });
});

describe('GithubClient and token exchange (fake fetch)', () => {
  it('refuses an invalid repository name before any request', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }));
    await expect(new GithubClient('t', fetch).getPullRequest('../../x', 1)).rejects.toThrow(
      GithubHttpError
    );
    expect(calls).toHaveLength(0);
  });

  it('encodes branch segments and reports 404 as "no branch"', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 404 }));
    expect(
      await new GithubClient('t', fetch).getBranchSha('acme/web', 'specfix/CART-1')
    ).toBeNull();
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/acme/web/git/ref/heads/specfix/CART-1'
    );
    await expect(new GithubClient('t', fetch).getBranchSha('acme/web', 'x?y=1#')).rejects.toThrow(
      /Invalid branch/
    );
  });

  it('never puts a response body into an error message', async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: { message: 'ghp_secrettoken' } }));
    const error = await new GithubClient('t', fetch)
      .createIssueComment('acme/web', 1, 'x')
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(GithubHttpError);
    expect((error as Error).message).not.toContain('ghp_');
  });

  it('maps 401 to GithubAuthError', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401 }));
    await expect(new GithubClient('t', fetch).listInstallationRepos()).rejects.toThrow(
      GithubAuthError
    );
  });

  it('exchanges the app JWT for an installation token', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 201,
      body: { token: 'ghs_x', expires_at: '2030-01-01T00:00:00Z' },
    }));
    const token = await createInstallationToken({ appId: '1', privateKey }, 42, fetch);
    expect(token.token).toBe('ghs_x');
    expect(calls[0]!.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(calls[0]!.auth).toMatch(/^Bearer ey/);
  });

  it('confirms installation access through the user, across pages', async () => {
    const page = (ids: number[]) => ({ installations: ids.map((id) => ({ id })) });
    const { fetch } = fakeFetch((c) =>
      c.url.includes('oauth')
        ? { status: 200, body: { access_token: 'ghu_x' } }
        : c.url.endsWith('&page=1')
          ? { status: 200, body: page(Array.from({ length: 100 }, (_, i) => i + 1000)) }
          : { status: 200, body: page([42]) }
    );
    const config = { clientId: 'c', clientSecret: 's' };
    expect(await userCanAccessInstallation(config, 'code', 42, fetch)).toBe(true);
    expect(await userCanAccessInstallation(config, 'code', 43, fetch)).toBe(false);
  });

  it('rejects a bad OAuth code (GitHub answers 200 with an error)', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { error: 'bad_verification_code' } }));
    await expect(
      userCanAccessInstallation({ clientId: 'c', clientSecret: 's' }, 'x', 42, fetch)
    ).rejects.toThrow(GithubAuthError);
  });
});
