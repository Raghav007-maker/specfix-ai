import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX,
  callbackTarget,
  newPasswordProblem,
  recoveryIsFresh,
  resetEmailOk,
} from '../src/index.ts';

describe('newPasswordProblem', () => {
  it('accepts a password of 6 to 72 characters typed the same twice', () => {
    expect(newPasswordProblem('secret1', 'secret1')).toBeNull();
    expect(newPasswordProblem('x'.repeat(PASSWORD_MAX), 'x'.repeat(PASSWORD_MAX))).toBeNull();
  });

  it('refuses too short, too long, blank and mismatched passwords', () => {
    expect(newPasswordProblem('abc', 'abc')).toMatch(/at least 6/);
    expect(newPasswordProblem('x'.repeat(PASSWORD_MAX + 1), 'x'.repeat(PASSWORD_MAX + 1))).toMatch(
      /at most 72/
    );
    expect(newPasswordProblem('       ', '       ')).toMatch(/only spaces/);
    expect(newPasswordProblem('secret1', 'secret2')).toMatch(/do not match/);
  });
});

describe('resetEmailOk', () => {
  it('takes a normal address and refuses junk', () => {
    expect(resetEmailOk('pat@example.com')).toBe(true);
    expect(resetEmailOk('')).toBe(false);
    expect(resetEmailOk('no-at-sign')).toBe(false);
    expect(resetEmailOk('a b@example.com')).toBe(false);
    expect(resetEmailOk(`${'a'.repeat(250)}@x.io`)).toBe(false);
  });
});

describe('callbackTarget', () => {
  it('sends a reset link to the new-password page and everything else home', () => {
    expect(callbackTarget('reset')).toBe('/login/reset');
    expect(callbackTarget(null)).toBe('/');
    expect(callbackTarget('//evil.example')).toBe('/');
    expect(callbackTarget('https://evil.example')).toBe('/');
    expect(callbackTarget('/admin')).toBe('/');
  });
});

describe('recoveryIsFresh', () => {
  const now = 1_800_000_000;

  it('accepts a reset link opened in the last 15 minutes', () => {
    expect(recoveryIsFresh([{ method: 'recovery', timestamp: now - 60 }], now)).toBe(true);
    expect(
      recoveryIsFresh(
        [
          { method: 'password', timestamp: now - 9000 },
          { method: 'recovery', timestamp: now - 899 },
        ],
        now
      )
    ).toBe(true);
  });

  it('refuses a password sign-in, an old link, a future stamp and junk', () => {
    expect(recoveryIsFresh([{ method: 'password', timestamp: now }], now)).toBe(false);
    expect(recoveryIsFresh([{ method: 'recovery', timestamp: now - 901 }], now)).toBe(false);
    expect(recoveryIsFresh([{ method: 'recovery', timestamp: now + 3600 }], now)).toBe(false);
    expect(recoveryIsFresh(['recovery'], now)).toBe(false);
    expect(recoveryIsFresh(undefined, now)).toBe(false);
    expect(recoveryIsFresh([null, { method: 'recovery' }], now)).toBe(false);
  });
});
