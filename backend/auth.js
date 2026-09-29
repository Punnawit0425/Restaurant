// ---------------------------------------------------------------------------
// Authentication helpers
// ---------------------------------------------------------------------------
// Everything here is built on Node's built-in `node:crypto`, so the backend
// gains real password hashing and signed session tokens with no extra npm
// dependencies to audit or keep patched.
//
//   * Passwords are hashed with scrypt (memory-hard, salted, per-password).
//   * Sessions are stateless HMAC-signed tokens — no server-side session store
//     to leak or run out of memory, and they survive a restart as long as
//     AUTH_SECRET is stable.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

// --- Server secret ----------------------------------------------------------
// Used to sign session tokens. MUST be stable across restarts (set AUTH_SECRET
// in backend/.env), otherwise every existing session is invalidated on reboot.
// If it is missing we generate an ephemeral one so the app still runs in dev,
// but we shout about it because it is not safe for anything real.
let SECRET = (process.env.AUTH_SECRET || '').trim();
if (!SECRET) {
  // In production a missing secret is a misconfiguration, not something to
  // paper over. The old behaviour — warn, then carry on with a random one — was
  // almost invisible: the app came up healthy and simply signed everyone out on
  // every deploy, which reads as "the login is flaky" for days before anyone
  // traces it back to an unset variable. Refusing to start says it once, at the
  // moment it can still be fixed, in the deploy log the operator is watching.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[auth] FATAL: AUTH_SECRET is not set.\n' +
      '       Session tokens are signed with it, so without a stable value every\n' +
      '       deploy logs out all staff. Set it once and never change it:\n' +
      '         openssl rand -hex 32\n' +
      '       then add it to the service variables (Railway: app service → Variables).'
    );
    process.exit(1);
  }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[auth] AUTH_SECRET is not set — generated a temporary one for local dev. ' +
    'Staff will be logged out on every restart. Add a long random AUTH_SECRET ' +
    'to backend/.env (e.g. `openssl rand -hex 32`).'
  );
}

// --- Password hashing (scrypt) ----------------------------------------------
// Stored format: scrypt$<saltHex>$<hashHex>. Self-describing so a future
// algorithm change can coexist with old hashes.
const SCRYPT_KEYLEN = 64;

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = crypto.scryptSync(String(plain), salt, expected.length);
  // Constant-time compare; lengths already match by construction.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// A value looks already-hashed if it carries our scheme prefix. Lets the server
// tell a freshly-typed plaintext password apart from a stored hash.
export function isHashed(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

// --- Session tokens (HMAC-signed, stateless) --------------------------------
// Token = base64url(payloadJSON).base64url(HMAC_SHA256(payloadJSON)).
// The payload carries the username and an expiry; the signature makes it
// tamper-proof without a database lookup.
const DEFAULT_TTL_SEC = 12 * 60 * 60; // a work shift

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(dataB64) {
  return crypto.createHmac('sha256', SECRET).update(dataB64).digest('base64url');
}

export function signToken(payload, ttlSec = DEFAULT_TTL_SEC) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const dataB64 = b64url(JSON.stringify(body));
  return `${dataB64}.${sign(dataB64)}`;
}

// Returns the payload if the token is well-formed, correctly signed and
// unexpired; otherwise null. Never throws.
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [dataB64, sig] = token.split('.');
  if (!dataB64 || !sig) return null;

  const expected = sign(dataB64);
  // Constant-time signature check.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
