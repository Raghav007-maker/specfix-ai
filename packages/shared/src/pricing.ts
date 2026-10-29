/**
 * Pro prices, in one place for the pricing page, the UPI QR and the payment records. Amounts
 * are in paise so nothing is ever rounded; the server always takes the amount from here,
 * never from a form.
 */
export type BillingPeriod = 'monthly' | 'annual';

/** Projects a Free workspace may have. */
export const FREE_PROJECT_LIMIT = 5;

export const PRO_PRICES: Record<BillingPeriod, { paise: number; days: number }> = {
  monthly: { paise: 1500, days: 30 },
  annual: { paise: 15000, days: 365 },
};

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return value === 'monthly' || value === 'annual';
}

/** A UPI transaction reference (UTR) as people paste it: 12 digits, spaces or dashes allowed. */
export function normalizeUtr(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{12}$/.test(digits) ? digits : null;
}

/**
 * A short code for a workspace, put in the UPI payment note. The team approves a UTR only when
 * the note in their bank app shows this workspace's code, so a UTR copied from someone else's
 * receipt cannot buy Pro for another workspace.
 */
export function paymentRef(tenantId: string): string {
  return `W-${tenantId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/**
 * The payer's hidden code: derived from their account id, carried only inside the UPI QR's
 * note, never shown in the app. The team approves a UPI claim only when the code in the bank
 * note matches the account that claimed it, so a UTR copied from someone else's receipt fails.
 */
export function payerCode(userId: string): string {
  return `P-${userId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** A code typed by the team from the bank note, normalised for comparison; null if not one. */
export function normalizePayerCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const code = input.replace(/\s/g, '').toUpperCase();
  return /^P-[0-9A-F]{8}$/.test(code) ? code : null;
}

/** A UPI ID such as name@bank. */
export function isUpiId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(value);
}

/**
 * The upi://pay link a UPI app opens (and the QR encodes). Every field is URL-encoded, so a
 * payee name or note cannot add parameters of its own.
 */
export function upiPayLink(input: {
  payee: string;
  payeeName: string;
  paise: number;
  note: string;
}): string {
  const params = new URLSearchParams({
    pa: input.payee,
    pn: input.payeeName,
    am: (input.paise / 100).toFixed(2),
    cu: 'INR',
    tn: input.note,
  });
  return `upi://pay?${params.toString()}`;
}
