/**
 * Atlassian OAuth helpers and the Jira REST client, against a stubbed fetch.
 * No network: every response is constructed here.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  JIRA_READ_SCOPES,
  JiraAuthError,
  JiraClient,
  JiraHttpError,
  accessibleResources,
  authorizeUrl,
  createState,
  exchangeCode,
  jiraOAuthConfigFromEnv,
  listJiraProjects,
  listJiraTextFields,
  refreshTokens,
  verifyState,
} from '../src/index.ts';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/jira/callback',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch that answers from a queue and records what it was asked. */
function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('config', () => {
  it('is null until all three values are set', () => {
    expect(jiraOAuthConfigFromEnv({ JIRA_CLIENT_ID: 'a', JIRA_CLIENT_SECRET: 'b' })).toBeNull();
    expect(
      jiraOAuthConfigFromEnv({
        JIRA_CLIENT_ID: ' a ',
        JIRA_CLIENT_SECRET: 'b',
        JIRA_REDIRECT_URI: 'http://x/cb',
      })
    ).toEqual({ clientId: 'a', clientSecret: 'b', redirectUri: 'http://x/cb' });
  });
});

describe('authorizeUrl', () => {
  it('asks for read scopes, offline access and consent', () => {
    const url = new URL(authorizeUrl(config, { state: 'abc' }));
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('scope')).toBe(JIRA_READ_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).not.toContain('write:jira-work');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('token requests', () => {
  it('exchanges a code', async () => {
    const { fetchImpl, calls } = stubFetch(
      json(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'read:jira-work offline_access',
      })
    );
    const before = Date.now();
    const tokens = await exchangeCode(config, 'the-code', fetchImpl);
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.scopes).toEqual(['read:jira-work', 'offline_access']);
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
  });

  it('keeps the rotated refresh token, or the old one if none is returned', async () => {
    const rotated = stubFetch(
      json(200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 })
    );
    expect((await refreshTokens(config, 'rt1', rotated.fetchImpl)).refreshToken).toBe('rt2');

    const same = stubFetch(json(200, { access_token: 'at2', expires_in: 3600 }));
    expect((await refreshTokens(config, 'rt1', same.fetchImpl)).refreshToken).toBe('rt1');
  });

  it('treats a refused grant as an auth error without echoing secrets', async () => {
    const { fetchImpl } = stubFetch(
      json(403, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' })
    );
    const failure = refreshTokens(config, 'super-secret-refresh', fetchImpl);
    await expect(failure).rejects.toBeInstanceOf(JiraAuthError);
    await failure.catch((error: Error) => {
      expect(error.message).toContain('invalid_grant');
      expect(error.message).not.toContain('super-secret-refresh');
      expect(error.message).not.toContain('client-secret');
    });
  });

  it('treats a server error as retryable, not as revoked consent', async () => {
    const { fetchImpl } = stubFetch(json(502, {}));
    await expect(refreshTokens(config, 'rt', fetchImpl)).rejects.toBeInstanceOf(JiraHttpError);
  });
});

describe('accessibleResources', () => {
  it('keeps Jira sites and drops Confluence-only ones', async () => {
    const { fetchImpl, calls } = stubFetch(
      json(200, [
        { id: 'c1', name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] },
        { id: 'c2', name: 'Wiki', url: 'https://wiki.atlassian.net', scopes: ['read:confluence'] },
      ])
    );
    const sites = await accessibleResources('at', fetchImpl);
    expect(sites).toEqual([
      {
        cloudId: 'c1',
        name: 'Acme',
        url: 'https://acme.atlassian.net',
        scopes: ['read:jira-work'],
      },
    ]);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer at');
  });
});

describe('OAuth state', () => {
  const key = randomBytes(32);

  it('verifies what it signed', () => {
    const token = createState({ tenantId: 't1', userId: 'u1' }, key);
    expect(verifyState(token, key)).toMatchObject({ tenantId: 't1', userId: 'u1' });
  });

  it('rejects a state signed with another key', () => {
    const token = createState({ tenantId: 't1', userId: 'u1' }, randomBytes(32));
    expect(verifyState(token, key)).toBeNull();
  });

  it('rejects an edited tenant', () => {
    const token = createState({ tenantId: 't1', userId: 'u1' }, key);
    const [payload, signature] = token.split('.');
    const state = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    state.tenantId = 't2';
    const forged = `${Buffer.from(JSON.stringify(state)).toString('base64url')}.${signature}`;
    expect(verifyState(forged, key)).toBeNull();
  });

  it('expires after ten minutes', () => {
    const now = Date.now();
    const token = createState({ tenantId: 't1', userId: 'u1' }, key, now);
    expect(verifyState(token, key, now + 9 * 60_000)).not.toBeNull();
    expect(verifyState(token, key, now + 11 * 60_000)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyState('', key)).toBeNull();
    expect(verifyState('a.b.c', key)).toBeNull();
    expect(verifyState('not-a-state', key)).toBeNull();
  });
});

describe('JiraClient', () => {
  const noSleep = async () => {};

  it('calls the site through api.atlassian.com with a fresh token', async () => {
    const { fetchImpl, calls } = stubFetch(json(200, { ok: true }));
    const client = new JiraClient({
      cloudId: 'cloud-1',
      getAccessToken: async () => 'tok',
      fetch: fetchImpl,
    });
    await client.get('/myself', { expand: 'groups' });
    expect(calls[0]!.url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself?expand=groups'
    );
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('waits out a 429 using Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const { fetchImpl } = stubFetch(json(429, {}, { 'retry-after': '2' }), json(200, { value: 1 }));
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(client.get('/x')).resolves.toEqual({ value: 1 });
    expect(waits).toEqual([2000]);
  });

  it('gives up after maxRetries', async () => {
    const { fetchImpl } = stubFetch(json(429, {}), json(429, {}), json(429, {}));
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: fetchImpl,
      maxRetries: 2,
      sleep: noSleep,
    });
    await expect(client.get('/x')).rejects.toMatchObject({ status: 429 });
  });

  it('maps 401 to an auth error and surfaces Jira error messages', async () => {
    const unauthorized = stubFetch(json(401, {}));
    await expect(
      new JiraClient({
        cloudId: 'c',
        getAccessToken: async () => 't',
        fetch: unauthorized.fetchImpl,
      }).get('/x')
    ).rejects.toBeInstanceOf(JiraAuthError);

    const missing = stubFetch(json(404, { errorMessages: ['No project could be found.'] }));
    await expect(
      new JiraClient({
        cloudId: 'c',
        getAccessToken: async () => 't',
        fetch: missing.fetchImpl,
      }).get('/project/NOPE')
    ).rejects.toThrow(/No project could be found/);
  });
});

describe('setup reads', () => {
  it('follows project pagination to the last page', async () => {
    const { fetchImpl, calls } = stubFetch(
      json(200, { values: [{ id: '1', key: 'CART', name: 'Cart', extra: 1 }], isLast: false }),
      json(200, { values: [{ id: '2', key: 'PAY', name: 'Payments' }], isLast: true })
    );
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: fetchImpl,
    });
    expect(await listJiraProjects(client)).toEqual([
      { id: '1', key: 'CART', name: 'Cart' },
      { id: '2', key: 'PAY', name: 'Payments' },
    ]);
    expect(calls[1]!.url).toContain('startAt=1');
  });

  it('lists only custom text fields, sorted', async () => {
    const { fetchImpl } = stubFetch(
      json(200, [
        { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
        { id: 'customfield_2', name: 'Story points', custom: true, schema: { type: 'number' } },
        {
          id: 'customfield_3',
          name: 'Acceptance criteria',
          custom: true,
          schema: { type: 'string' },
        },
        { id: 'customfield_1', name: 'Notes', custom: true, schema: { type: 'string' } },
      ])
    );
    const client = new JiraClient({
      cloudId: 'c',
      getAccessToken: async () => 't',
      fetch: fetchImpl,
    });
    expect(await listJiraTextFields(client)).toEqual([
      { id: 'customfield_3', name: 'Acceptance criteria' },
      { id: 'customfield_1', name: 'Notes' },
    ]);
  });
});
