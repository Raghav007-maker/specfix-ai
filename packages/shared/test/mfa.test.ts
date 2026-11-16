import { describe, expect, it } from 'vitest';
import { needsSecondFactor, normalizeTotpCode } from '../src/index.ts';

describe('needsSecondFactor', () => {
  const verified = [{ status: 'verified' }];

  it('asks for the code only when a verified factor exists and the session is not aal2', () => {
    expect(needsSecondFactor('aal1', verified)).toBe(true);
    expect(needsSecondFactor('aal2', verified)).toBe(false);
    expect(needsSecondFactor('aal1', [])).toBe(false);
    expect(needsSecondFactor('aal1', undefined)).toBe(false);
  });

  it('ignores a factor that was never confirmed', () => {
    expect(needsSecondFactor('aal1', [{ status: 'unverified' }])).toBe(false);
  });

  it('treats a missing or odd aal claim as not verified', () => {
    expect(needsSecondFactor(undefined, verified)).toBe(true);
    expect(needsSecondFactor('AAL2', verified)).toBe(true);
    expect(needsSecondFactor(2, verified)).toBe(true);
  });
});

describe('normalizeTotpCode', () => {
  it('accepts six digits with spaces or a dash', () => {
    expect(normalizeTotpCode('123456')).toBe('123456');
    expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
    expect(normalizeTotpCode('123-456')).toBe('123456');
  });

  it('refuses anything else', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '12345a', '', null, 123456]) {
      expect(normalizeTotpCode(bad)).toBeNull();
    }
  });
});
