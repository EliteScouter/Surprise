// Admin panel. Lives under a secret path (ADMIN_PATH); every other path, and the
// panel itself when ADMIN_PATH is unset, is indistinguishable from a normal 404.
//
// Sign-in: email + password + authenticator app (TOTP), always. Only verified
// addresses listed in ADMIN_EMAILS may enroll. Sessions expire after 30 idle
// minutes or 8 hours. Destructive actions need a 2FA code from the last 15 minutes.
// Every action is written to the audit log.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode-svg';
import { verifyPassword, normalizeEmail, looksLikeEmail, newTotpSecret, checkTotp, totpUri, encrypt, decrypt, seal, unseal } from './crypto.js';
import { parseCookies, cookieName, setCookie } from './auth-routes.js';

const SUDO_MS = 15 * 60 * 1000;
const STATIC = { 'admin.js': 'text/javascript; charset=utf-8', 'admin.css': 'text/css; charset=utf-8' };

export function createAdminRoutes(ctx) {
  const { accounts, store, send, readBody, sanitizeText, isOffensive, limited, broadcast, adminDir, invalidateMap } = ctx;
  const ADMIN_PATH = String(process.env.ADMIN_PATH || '');
  const enabled = /^[A-Za-z0-9_-]{20,64}$/.test(ADMIN_PATH);
  const base = '/' + ADMIN_PATH;
  const allowedEmails = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean));
  const allowIps = String(process.env.ADMIN_ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const totpTries = new Map();

  if (process.env.ADMIN_PATH && !enabled) console.error('[cosmonym] ADMIN_PATH must be 20-64 letters, digits, _ or -; admin panel disabled');

  async function adminSession(req, secure) {
    const token = parseCookies(req)[cookieName('cn_a', secure)];
    if (!token) return null;
    const s = await accounts.getSession(token, 'admin');
    return s ? { ...s, token } : null;
  }

  const tooManyTotp = uid => {
    const t = totpTries.get(uid) || { n: 0, until: Date.now() + 15 * 60000 };
    if (Date.now() > t.until) { t.n = 0; t.until = Date.now() + 15 * 60000; }
    t.n++; totpTries.set(uid, t);
    return t.n > 6;
  };

  async function handle(req, res, { url, p, ip, ipHash, secure }) {
    if (!enabled || (p !== base && !p.startsWith(base + '/'))) return false;
    if (allowIps.length && !allowIps.includes(ip)) return false;     // looks like any other 404
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    const sub = p.slice(base.length) || '/';

    // ---------------------------------------------------------------- static panel
    if (req.method === 'GET' && (sub === '/' || sub === '')) {
      const html = fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8').replaceAll('__BASE__', base);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html), true;
    }
    if (req.method === 'GET' && STATIC[sub.slice(1)]) {
      res.writeHead(200, { 'Content-Type': STATIC[sub.slice(1)] });
      return res.end(fs.readFileSync(path.join(adminDir, sub.slice(1)))), true;
    }
    if (!sub.startsWith('/api/')) return send(res, 404, 'not found'), true;
    const api = sub.slice(4);
    const audit = (adminId, action, target, detail) => accounts.audit(adminId, action, target, detail, ipHash).catch(() => {});

    // ---------------------------------------------------------------- sign-in
    if (api === '/login' && req.method === 'POST') {
      if (limited(ip, 'admin-login', 8, 15 * 60000)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' }), true;
      const body = await readBody(req);
      const email = normalizeEmail(sanitizeText(body.email, 254));
      const user = looksLikeEmail(email) ? await accounts.findByEmail(email) : null;
      const ok = await verifyPassword(String(body.password || ''), user?.passwordHash);
      const eligible = user && ok && !user.banned && (user.role === 'admin' || (allowedEmails.has(email) && user.emailVerified));
      if (!eligible) {
        if (user) audit(user.id, 'admin-login-failed', email, ok ? 'not eligible' : 'bad password');
        return send(res, 401, { error: 'Those details don’t open this door.' }), true;
      }
      if (user.totpEnc) {
        setCookie(res, 'cn_ap', seal({ uid: user.id, stage: 'totp' }, 5 * 60000), { secure, sameSite: 'Strict', maxAge: 300 });
        return send(res, 200, { stage: 'totp' }), true;
      }
      const secret = newTotpSecret();
      setCookie(res, 'cn_ap', seal({ uid: user.id, stage: 'enroll', secret }, 10 * 60000), { secure, sameSite: 'Strict', maxAge: 600 });
      const svg = new QRCode({ content: totpUri(secret, user.email), padding: 2, width: 220, height: 220, color: '#04050b', background: '#ffffff', ecl: 'M' }).svg();
      return send(res, 200, { stage: 'enroll', secret, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }), true;
    }

    if (api === '/totp' && req.method === 'POST') {
      const pre = unseal(parseCookies(req).cn_ap);
      if (!pre) return send(res, 401, { error: 'That took too long. Sign in again.' }), true;
      if (tooManyTotp(pre.uid)) return send(res, 429, { error: 'Too many codes. Wait 15 minutes.' }), true;
      const user = await accounts.getUser(pre.uid);
      if (!user || user.banned) return send(res, 401, { error: 'Sign in again.' }), true;
      const body = await readBody(req);
      const secret = pre.stage === 'enroll' ? pre.secret : decrypt(user.totpEnc, 'totp');
      const step = checkTotp(secret, body.code);
      if (step < 0) { audit(user.id, 'admin-2fa-failed', '', pre.stage); return send(res, 401, { error: 'That code didn’t match. Check your authenticator’s time.' }), true; }
      if (pre.stage === 'enroll') { await accounts.setTotp(user.id, encrypt(secret, 'totp')); await accounts.setRole(user.id, 'admin'); audit(user.id, 'admin-2fa-enrolled'); }
      if (!(await accounts.useTotpStep(user.id, step))) return send(res, 401, { error: 'That code was already used. Wait for the next one.' }), true;
      totpTries.delete(pre.uid);
      const { token } = await accounts.createSession(user.id, 'admin', ipHash, { mfa: true });
      setCookie(res, 'cn_ap', '', { secure, sameSite: 'Strict', maxAge: 0 });
      setCookie(res, cookieName('cn_a', secure), token, { secure, sameSite: 'Strict', maxAge: 8 * 3600 });
      audit(user.id, 'admin-login');
      return send(res, 200, { ok: true }), true;
    }

    // ---------------------------------------------------------------- everything below needs a session
    const s = await adminSession(req, secure);
    if (!s) return send(res, 401, { error: 'Signed out.', signedOut: true }), true;
    const me = s.user;

    if (api === '/logout' && req.method === 'POST') {
      await accounts.endSession(s.token);
      setCookie(res, cookieName('cn_a', secure), '', { secure, sameSite: 'Strict', maxAge: 0 });
      audit(me.id, 'admin-logout');
      return send(res, 200, { ok: true }), true;
    }
    if (api === '/me') return send(res, 200, { handle: me.handle, email: me.email, sudoUntil: s.mfaAt + SUDO_MS }), true;

    if (api === '/sudo' && req.method === 'POST') {
      if (tooManyTotp(me.id)) return send(res, 429, { error: 'Too many codes. Wait 15 minutes.' }), true;
      const body = await readBody(req);
      const step = checkTotp(decrypt(me.totpEnc, 'totp'), body.code);
      if (step < 0 || !(await accounts.useTotpStep(me.id, step))) { audit(me.id, 'admin-2fa-failed', '', 'sudo'); return send(res, 401, { error: 'That code didn’t work.' }), true; }
      totpTries.delete(me.id);
      await accounts.markMfa(s.token);
      return send(res, 200, { sudoUntil: Date.now() + SUDO_MS }), true;
    }

    if (req.method === 'GET') {
      if (api === '/stats') return send(res, 200, await accounts.adminStats()), true;
      if (api === '/worlds') return send(res, 200, { worlds: await accounts.adminWorlds({ q: sanitizeText(url.searchParams.get('q'), 64), sort: url.searchParams.get('sort'), page: Number(url.searchParams.get('page')) || 0 }) }), true;
      if (api === '/users') return send(res, 200, { users: await accounts.adminUsers({ q: sanitizeText(url.searchParams.get('q'), 254), page: Number(url.searchParams.get('page')) || 0 }) }), true;
      if (api === '/reports') return send(res, 200, { reports: await accounts.adminReports(url.searchParams.get('status')) }), true;
      if (api === '/audit') return send(res, 200, { audit: await accounts.adminAudit() }), true;
      return send(res, 404, { error: 'no such endpoint' }), true;
    }

    // ---------------------------------------------------------------- actions (need recent 2FA)
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }), true;
    const body = await readBody(req);
    let m;

    if ((m = api.match(/^\/reports\/(\d+)\/dismiss$/))) {
      await accounts.resolveReport(Number(m[1]), me.id);
      audit(me.id, 'report-dismissed', m[1]);
      return send(res, 200, { ok: true }), true;
    }

    if (Date.now() - s.mfaAt > SUDO_MS) return send(res, 401, { error: 'Confirm with a 2FA code first.', needSudo: true }), true;

    if ((m = api.match(/^\/worlds\/([a-z0-9-]{1,32})\/delete$/))) {
      const w = await store.get(m[1]);
      if (!w) return send(res, 404, { error: 'No such world.' }), true;
      await store.remove(w.id);
      await accounts.resolveReports(w.id, me.id);
      invalidateMap();
      broadcast('remove', { id: w.id });
      audit(me.id, 'world-deleted', w.id, `${w.name} by ${w.discoverer}: ${sanitizeText(body.reason, 200)}`);
      return send(res, 200, { ok: true }), true;
    }

    if ((m = api.match(/^\/worlds\/([a-z0-9-]{1,32})\/edit$/))) {
      const w = await store.get(m[1]);
      if (!w) return send(res, 404, { error: 'No such world.' }), true;
      const epitaph = body.epitaph == null ? null : sanitizeText(body.epitaph, 140);
      if (epitaph && isOffensive(epitaph)) return send(res, 400, { error: 'That message would be blocked for users too.' }), true;
      await accounts.editWorld(w.id, { epitaph });
      await accounts.resolveReports(w.id, me.id);
      audit(me.id, 'world-edited', w.id, `message: "${w.epitaph}" -> "${epitaph ?? w.epitaph}"`);
      return send(res, 200, { ok: true }), true;
    }

    if ((m = api.match(/^\/users\/(\d+)\/(ban|unban)$/))) {
      const target = await accounts.getUser(Number(m[1]));
      if (!target) return send(res, 404, { error: 'No such user.' }), true;
      if (target.id === me.id) return send(res, 400, { error: 'You can’t ban yourself.' }), true;
      if (target.role === 'admin') return send(res, 400, { error: 'Admins can’t be banned here.' }), true;
      const ban = m[2] === 'ban';
      await accounts.setBanned(target.id, ban, sanitizeText(body.reason, 200));
      let removed = 0;
      if (ban && body.deleteWorlds) {
        for (const w of await store.listByOwner(target.id)) { await store.remove(w.id); await accounts.resolveReports(w.id, me.id); broadcast('remove', { id: w.id }); removed++; }
        invalidateMap();
      }
      audit(me.id, ban ? 'user-banned' : 'user-unbanned', target.handle, `${sanitizeText(body.reason, 200)}${removed ? ` (${removed} worlds removed)` : ''}`);
      return send(res, 200, { ok: true, removed }), true;
    }

    return send(res, 404, { error: 'no such endpoint' }), true;
  }

  return { handle, enabled };
}
