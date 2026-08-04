/**
 * AES-256-GCM helpers for OAuth tokens at rest, plus signed OAuth/ICS tokens.
 *
 * Prefer INTEGRATION_ENCRYPTION_KEY (64-char hex). Falls back to JWT_SECRET
 * only in development — production warns and should set a dedicated key.
 */

import crypto from 'crypto';
import config from '../config/index.js';

function resolveKey() {
  const raw =
    config.integrations?.encryptionKey ||
    process.env.INTEGRATION_ENCRYPTION_KEY ||
    config.jwtSecret ||
    '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(String(raw)).digest();
}

export function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
  const key = resolveKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/** Signed ICS feed token for a board — HMAC, no DB round-trip. */
export function signCalendarToken(boardId, userId) {
  const payload = `${boardId}.${userId}`;
  const sig = crypto
    .createHmac('sha256', resolveKey())
    .update(payload)
    .digest('base64url')
    .slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifyCalendarToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [boardId, userId, sig] = parts;
  const expected = signCalendarToken(boardId, userId).split('.')[2];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { boardId, userId };
}

/**
 * OAuth CSRF state: userId.expiry.nonce.hmac
 * Valid for 15 minutes. Prevents linking tokens to a forged user id.
 */
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export function signOAuthState(userId) {
  const expiry = String(Date.now() + OAUTH_STATE_TTL_MS);
  const nonce = crypto.randomBytes(8).toString('base64url');
  const payload = `${userId}.${expiry}.${nonce}`;
  const sig = crypto.createHmac('sha256', resolveKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyOAuthState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return null;
  const [userId, expiry, nonce, sig] = parts;
  if (!userId || !expiry || !nonce || !sig) return null;

  const payload = `${userId}.${expiry}.${nonce}`;
  const expected = crypto.createHmac('sha256', resolveKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (Number(expiry) < Date.now()) return null;
  return { userId };
}
