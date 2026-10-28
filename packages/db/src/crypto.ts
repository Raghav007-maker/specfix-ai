/**
 * Encryption at rest for third-party credentials (Jira OAuth tokens).
 *
 * AES-256-GCM with a key from TOKEN_ENCRYPTION_KEY (32 bytes, base64). Every
 * ciphertext is bound to a context string through GCM's additional authenticated
 * data — for Jira tokens, the tenant and grant kind — so a token copied from one
 * row into another fails to decrypt rather than handing one tenant another's
 * access. Layout: version byte (1) | iv (12) | auth tag (16) | ciphertext.
 *
 * This module is the only place the key is read, and nothing outside packages/db
 * imports it: decrypted tokens leave this package only as the return value of the
 * repository call that needs them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenKeyError extends Error {}

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new TokenKeyError('TOKEN_ENCRYPTION_KEY is not set.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new TokenKeyError('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded.');
  }
  return key;
}

/** A short, non-reversible fingerprint of the current key, stored beside each ciphertext. */
export function tokenKeyId(): string {
  return createHash('sha256').update(loadKey()).digest('hex').slice(0, 12);
}

export function encryptSecret(plaintext: string, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/**
 * Decrypts what encryptSecret produced under the same context. `keyId` is the
 * fingerprint stored with the row: a mismatch means TOKEN_ENCRYPTION_KEY changed
 * since the row was written, which is reported as such instead of as tampering.
 */
export function decryptSecret(sealed: Buffer, context: string, keyId: string): string {
  if (keyId !== tokenKeyId()) {
    throw new TokenKeyError(
      'Stored credentials were encrypted with a different TOKEN_ENCRYPTION_KEY. ' +
        'Restore the old key, or disconnect and reconnect the integration.'
    );
  }
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
    throw new TokenKeyError('Stored credential has an unknown format.');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
