/**
 * Webhook JWT verification, delivery parsing and the webhook JQL. Pure functions.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  parseWebhookDelivery,
  reconcileJql,
  verifyWebhookAuthorization,
  webhookJql,
} from '../src/index.ts';

const secret = 'client-secret';

function jwt(claims: Record<string, unknown>, opts: { alg?: string; key?: string } = {}): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = enc({ alg: opts.alg ?? 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const sig = createHmac('sha256', opts.key ?? secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${sig}`;
}

describe('verifyWebhookAuthorization', () => {
  const now = 1_800_000_000;

  it('accepts an HS256 token signed with the client secret', () => {
    const claims = verifyWebhookAuthorization(
      `Bearer ${jwt({ exp: now + 60, iss: 'jira' })}`,
      secret,
      now
    );
    expect(claims).toMatchObject({ iss: 'jira' });
  });

  it('rejects a missing header, a wrong key, an expired token and other algorithms', () => {
    expect(verifyWebhookAuthorization(null, secret, now)).toBeNull();
    expect(verifyWebhookAuthorization('Basic abc', secret, now)).toBeNull();
    expect(
      verifyWebhookAuthorization(`Bearer ${jwt({}, { key: 'other' })}`, secret, now)
    ).toBeNull();
    expect(verifyWebhookAuthorization(`Bearer ${jwt({ exp: now - 600 })}`, secret, now)).toBeNull();
    expect(
      verifyWebhookAuthorization(`Bearer ${jwt({}, { alg: 'none' })}`, secret, now)
    ).toBeNull();
    expect(verifyWebhookAuthorization('Bearer a.b', secret, now)).toBeNull();
  });

  it('rejects a token whose claims were edited after signing', () => {
    const token = jwt({ exp: now + 60, sub: 'a' });
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ exp: now + 60, sub: 'b' })).toString('base64url')}.${s}`;
    expect(verifyWebhookAuthorization(`Bearer ${forged}`, secret, now)).toBeNull();
  });
});

describe('parseWebhookDelivery', () => {
  it('keeps only the event, issue id, key and site', () => {
    expect(
      parseWebhookDelivery({
        webhookEvent: 'jira:issue_updated',
        issue: {
          id: '10042',
          key: 'CART-1',
          self: 'https://specfiz.atlassian.net/rest/api/3/issue/10042',
          fields: { summary: 'ignored' },
        },
      })
    ).toEqual({
      webhookEvent: 'jira:issue_updated',
      issueId: '10042',
      issueKey: 'CART-1',
      siteOrigin: 'https://specfiz.atlassian.net',
    });
  });

  it('drops a non-numeric issue id and rejects junk', () => {
    expect(
      parseWebhookDelivery({ webhookEvent: 'x', issue: { id: '1 OR 1' } })?.issueId
    ).toBeNull();
    expect(parseWebhookDelivery('nope')).toBeNull();
    expect(parseWebhookDelivery({})).toBeNull();
  });
});

describe('JQL builders', () => {
  it('lists every project once, quoted', () => {
    expect(webhookJql(['CART', 'PAY', 'CART'])).toBe('project IN ("CART", "PAY")');
    expect(reconcileJql(['CART'], 7.2)).toBe(
      'project IN ("CART") AND updated >= -8m ORDER BY updated DESC'
    );
  });

  it('refuses keys that could change the query', () => {
    expect(() => webhookJql(['CART") OR (project = "X'])).toThrow();
    expect(() => webhookJql([])).toThrow();
  });
});
