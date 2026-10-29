// Cryptography for accounts: one master key (kept in the data volume, never in the
// database) is split into purpose-specific keys with HKDF.
//   - emails are encrypted at rest (AES-256-GCM) and looked up by a keyed hash,
//     so a database dump alone reveals no addresses
//   - 2FA secrets are encrypted the same way
//   - passwords use scrypt (OWASP parameters), with a cap on concurrent hashes
//   - TOTP per RFC 6238 with replay protection handled by the caller
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let master = null;
export function initKeys(dataDir) {
  if (process.env.APP_SECRET) { master = Buffer.from(process.env.APP_SECRET, 'base64'); return; }
  const file = path.join(dataDir, 'app.key');
  try { master = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'); } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    master = crypto.randomBytes(32);
    fs.writeFileSync(file, master.toString('base64'), { mode: 0o600 });
  }
  if (master.length < 32) throw new Error('app key too short');
}
const subkey = label => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('cosmonym:' + label), 32));

// ------------------------------------------------------------------ encryption at rest
export function encrypt(text, label = 'email') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', subkey(label), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);   // version 1
}
export function decrypt(blob, label = 'email') {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  if (buf[0] !== 1) throw new Error('unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', subkey(label), buf.subarray(1, 13));
  d.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf8');
}

export const normalizeEmail = e => String(e || '').trim().toLowerCase();
export const emailIndex = e => crypto.createHmac('sha256', subkey('email-index')).update(normalizeEmail(e)).digest('hex');
export const looksLikeEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(String(e || '').trim());

// ------------------------------------------------------------------ tokens
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ passwords
// OWASP scrypt option: N=2^15, r=8, p=3 (~32 MB per hash). At most 4 run at once
// so a login flood can't exhaust the container's memory.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, maxmem: 96 * 1024 * 1024 };
let running = 0; const waiting = [];
async function slot(fn) {
  if (running >= 4) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => e ? rej(e) : res(k)));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await slot(() => scrypt(String(pw).normalize('NFKC'), salt));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
// Always does the full amount of work, even for unknown users, so response
// timing doesn't reveal which emails have accounts.
const DUMMY = 'scrypt$32768$8$3$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const derived = await slot(() => new Promise((res, rej) => crypto.scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), 32,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (e, k) => e ? rej(e) : res(k))));
  const ok = crypto.timingSafeEqual(derived, Buffer.from(key, 'base64'));
  return ok && !!stored;
}

export function passwordProblem(pw, { email, handle } = {}) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 200) return 'That password is too long.';
  const lower = s.toLowerCase();
  if (handle && lower.includes(String(handle).toLowerCase())) return 'Don’t include your name in your password.';
  if (email && lower.includes(normalizeEmail(email).split('@')[0])) return 'Don’t include your email in your password.';
  if (/^(.)\1+$/.test(s) || /^(0123456789|1234567890|password|qwertyuiop)/i.test(s)) return 'That password is too easy to guess.';
  return null;
}

// ------------------------------------------------------------------ TOTP (RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Returns the matching time step (for replay protection) or -1.
export function checkTotp(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return -1;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if (safeEqual(hotp(secret, step + d), c)) return step + d;
  return -1;
}
export const totpUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent('Cosmonym Admin:' + account)}?secret=${secret}&issuer=Cosmonym&algorithm=SHA1&digits=6&period=30`;
// exported for tests
export const _hotp = hotp;

// ------------------------------------------------------------------ signed, encrypted cookies
// Short-lived state (social sign-in flow, admin pre-login) that must not be readable
// or forgeable by the browser holding it.
export function seal(obj, ttlMs) {
  return encrypt(JSON.stringify({ ...obj, exp: Date.now() + ttlMs }), 'seal').toString('base64url');
}
export function unseal(str) {
  try {
    const obj = JSON.parse(decrypt(Buffer.from(String(str), 'base64url'), 'seal'));
    return obj.exp > Date.now() ? obj : null;
  } catch { return null; }
}
