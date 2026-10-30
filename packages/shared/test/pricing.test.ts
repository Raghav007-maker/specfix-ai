import { describe, expect, it } from 'vitest';
import {
  PRO_PRICES,
  isBillingPeriod,
  isUpiId,
  normalizePayerCode,
  payerCode,
  normalizeUtr,
  paymentRef,
  upiPayLink,
} from '../src/index.ts';

describe('pricing helpers', () => {
  it('derives a payer code from the account id and reads it back loosely', () => {
    const code = payerCode('0a1b2c3d-4e5f-6789-abcd-ef0123456789');
    expect(code).toBe('P-0A1B2C3D');
    expect(normalizePayerCode(' p-0a1b 2c3d ')).toBe(code);
    for (const bad of [
      undefined,
      42,
      '',
      'W-0A1B2C',
      'P-0A1B2C3G',
      'P-0A1B2C3D9',
      'x'.repeat(41),
    ]) {
      expect(normalizePayerCode(bad)).toBeNull();
    }
  });

  it('prices annual below twelve months of monthly', () => {
    expect(PRO_PRICES.monthly).toEqual({ paise: 1500, days: 30 });
    expect(PRO_PRICES.annual).toEqual({ paise: 15000, days: 365 });
    expect(PRO_PRICES.annual.paise).toBeLessThan(PRO_PRICES.monthly.paise * 12);
  });

  it('accepts only the two billing periods', () => {
    expect(isBillingPeriod('monthly')).toBe(true);
    expect(isBillingPeriod('annual')).toBe(true);
    expect(isBillingPeriod('weekly')).toBe(false);
    expect(isBillingPeriod(null)).toBe(false);
  });

  it('reads a 12-digit UTR as people paste it', () => {
    expect(normalizeUtr('412345678901')).toBe('412345678901');
    expect(normalizeUtr(' 4123 4567 8901 ')).toBe('412345678901');
    expect(normalizeUtr('4123-4567-8901')).toBe('412345678901');
    expect(normalizeUtr('41234567890')).toBeNull();
    expect(normalizeUtr('4123456789012')).toBeNull();
    expect(normalizeUtr('41234567890a')).toBeNull();
    expect(normalizeUtr("412345678901' or 1=1")).toBeNull();
    expect(normalizeUtr('1'.repeat(41))).toBeNull();
    expect(normalizeUtr(412345678901)).toBeNull();
  });

  it('accepts a plausible UPI ID only', () => {
    expect(isUpiId('specfix@okaxis')).toBe(true);
    expect(isUpiId('first.last-1@ybl')).toBe(true);
    expect(isUpiId('')).toBe(false);
    expect(isUpiId('no-at-sign')).toBe(false);
    expect(isUpiId('a@b&am=1')).toBe(false);
    expect(isUpiId('x y@okaxis')).toBe(false);
  });

  it('gives each workspace a stable, short payment code', () => {
    const id = '3f2a9c1e-0b4d-4c5e-9f00-112233445566';
    expect(paymentRef(id)).toBe('W-3F2A9C');
    expect(paymentRef(id)).toBe(paymentRef(id));
    expect(paymentRef('aaaaaa00-0000-0000-0000-000000000000')).not.toBe(paymentRef(id));
  });

  it('builds a upi:// link whose fields cannot inject parameters', () => {
    const link = upiPayLink({
      payee: 'specfix@okaxis',
      payeeName: 'Spec&Fix am=1',
      paise: 1500,
      note: 'SpecFix Pro monthly',
    });
    expect(link.startsWith('upi://pay?')).toBe(true);
    const params = new URLSearchParams(link.slice('upi://pay?'.length));
    expect(params.get('pa')).toBe('specfix@okaxis');
    expect(params.get('pn')).toBe('Spec&Fix am=1');
    expect(params.get('am')).toBe('15.00');
    expect(params.get('cu')).toBe('INR');
    expect(params.getAll('am')).toHaveLength(1);
  });
});
