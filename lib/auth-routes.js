// Account endpoints: sign-up, sign-in, sessions, social sign-in, email verification,
// password reset, account settings, public profiles and world reports.
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, passwordProblem, looksLikeEmail, normalizeEmail, emailIndex, seal, unseal, sha256 } from './crypto.js';
import { publicUser, handleSlug } from './accounts.js';
import { enabledProviders, isProvider, startFlow, finishFlow } from './oauth.js';
import { mailEnabled, mailVerify, mailReset } from './mailer.js';
import { request } from './egress.js';

const RESERVED = new Set(['admin', 'administrator', 'cosmonym', 'support', 'moderator', 'mod', 'system', 'anonymous', 'root', 'staff', 'official', 'help', 'security', 'noreply', 'null', 'undefined']);
const HANDLE_OK = /^[\p{Script=Latin}0-9 _.-]{3,20}$/u;
const REPORT_REASONS = new Set(['offensive', 'hateful', 'sexual', 'spam', 'impersonation', 'other']);

// ------------------------------------------------------------------ cookies
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export const cookieName = (base, secure) => (secure ? '__Host-' : '') + base;
export function setCookie(res, name, value, { secure, maxAge, sameSite = 'Lax' }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

// Per-account lockout after repeated failures (in addition to per-IP limits).
const failures = new Map();
const LOCK_AFTER = 8, LOCK_MS = 15 * 60 * 1000;
function lockedOut(key) { const f = failures.get(key); return f && f.n >= LOCK_AFTER && Date.now() < f.until; }
function recordFailure(key) {
  const f = failures.get(key) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + LOCK_MS; failures.set(key, f);
  if (failures.size > 100000) failures.clear();
}
setInterval(() => { const now = Date.now(); for (const [k, f] of failures) if (now > f.until) failures.delete(k); }, 60000).unref();

// Checks a password against the Have I Been Pwned range API (k-anonymity: only the
// first 5 hex chars of its SHA-1 ever leave the server). Fails open if unreachable.
async function breached(pw) {
  try {
    const h = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
    const r = await request(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, timeout: 4000 });
    if (r.status !== 200) return false;
    return r.text.split('\n').some(line => { const [suffix, count] = line.trim().split(':'); return suffix === h.slice(5) && Number(count) > 0; });
  } catch { return false; }
}

export function createAuthRoutes(ctx) {
  const { accounts, store, send, readBody, sanitizeText, isOffensive, limited, publicWorld, publicUrl } = ctx;

  function handleProblem(handle) {
    if (!HANDLE_OK.test(handle)) return 'Names are 3–20 letters, numbers, spaces, dots, dashes or underscores.';
    if (handleSlug(handle).length < 3) return 'Names need at least three letters or numbers.';
    if (RESERVED.has(handleSlug(handle).replace(/-/g, ''))) return 'That name is reserved.';
    if (isOffensive(handle)) return 'That name isn’t available.';
    return null;
  }

  async function currentUser(req, secure) {
    const token = parseCookies(req)[cookieName('cn_s', secure)];
    if (!token || !store.ready) return null;
    const s = await accounts.getSession(token, 'user');
    return s ? { ...s, token } : null;
  }

  async function startSession(res, user, ipHash, secure) {
    const { token, expires } = await accounts.createSession(user.id, 'user', ipHash);
    await accounts.touchLogin(user.id);
    setCookie(res, cookieName('cn_s', secure), token, { secure, maxAge: (expires - Date.now()) / 1000 });
  }

  async function sendVerification(user) {
    if (!mailEnabled() || !user.email || user.emailVerified) return;
    const token = await accounts.createEmailToken(user.id, 'verify', 24 * 3600 * 1000);
    mailVerify(user.email, user.handle, `${publicUrl}/auth/verify?t=${token}`).catch(e => console.error('[cosmonym] verify email failed:', e.message));
  }

  const safeReturn = r => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.includes('\\') && r.length < 200) ? r : '/';

  // Returns true if it handled the request.
  async function handle(req, res, { url, p, ip, ipHash, secure }) {
    if (!p.startsWith('/api/auth/') && !p.startsWith('/api/account/') && !p.startsWith('/api/users/') && !/^\/api\/world\/[a-z0-9-]{1,32}\/report$/.test(p)) return false;

    if (p === '/api/auth/me' && req.method === 'GET') {
      const s = await currentUser(req, secure);
      const providers = s ? await accounts.providersOf(s.user.id) : [];
      return send(res, 200, { user: s ? { ...publicUser(s.user), providers, ...(s.user.role === 'admin' && process.env.ADMIN_PATH ? { adminPath: '/' + process.env.ADMIN_PATH } : {}) } : null, providers: enabledProviders(), mail: mailEnabled() }), true;
    }

    // ---------------------------------------------------------------- email + password
    if (p === '/api/auth/signup' && req.method === 'POST') {
      if (limited(ip, 'signup', 6, 3600000)) return send(res, 429, { error: 'Too many sign-ups from here. Try again later.' }), true;
      const body = await readBody(req);
      const handle = sanitizeText(body.handle, 20).replace(/\s+/g, ' ');
      const email = normalizeEmail(sanitizeText(body.email, 254));
      const password = String(body.password || '');
      const hp = handleProblem(handle); if (hp) return send(res, 400, { error: hp, field: 'handle' }), true;
      if (!looksLikeEmail(email)) return send(res, 400, { error: 'That doesn’t look like an email address.', field: 'email' }), true;
      const pp = passwordProblem(password, { email, handle }); if (pp) return send(res, 400, { error: pp, field: 'password' }), true;
      if (await breached(password)) return send(res, 400, { error: 'That password has appeared in a data breach. Please choose another.', field: 'password' }), true;
      if (await accounts.handleTaken(handle)) return send(res, 409, { error: 'That name is taken.', field: 'handle' }), true;
      if (await accounts.findByEmail(email)) return send(res, 409, { error: 'An account with that email already exists. Try signing in.', field: 'email' }), true;
      const user = await accounts.createUser({ handle, email, passwordHash: await hashPassword(password) });
      await startSession(res, user, ipHash, secure);
      sendVerification(user);
      return send(res, 201, { user: { ...publicUser(user), providers: [] } }), true;
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      if (limited(ip, 'login', 20, 15 * 60000)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' }), true;
      const body = await readBody(req);
      const email = normalizeEmail(sanitizeText(body.email, 254));
      const key = emailIndex(email);
      if (lockedOut(key)) return send(res, 429, { error: 'Too many failed attempts on this account. Try again in 15 minutes, or reset your password.' }), true;
      const user = looksLikeEmail(email) ? await accounts.findByEmail(email) : null;
      const ok = await verifyPassword(String(body.password || ''), user?.passwordHash);   // runs even with no user
      if (!user || !ok) { recordFailure(key); return send(res, 401, { error: 'Email or password is incorrect.' }), true; }
      if (user.banned) return send(res, 403, { error: 'This account has been suspended.' }), true;
      failures.delete(key);
      await startSession(res, user, ipHash, secure);
      return send(res, 200, { user: { ...publicUser(user), providers: await accounts.providersOf(user.id) } }), true;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const s = await currentUser(req, secure);
      if (s) await accounts.endSession(s.token);
      setCookie(res, cookieName('cn_s', secure), '', { secure, maxAge: 0 });
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/auth/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const user = await accounts.consumeEmailToken(String(body.token || ''), 'verify');
      if (!user) return send(res, 400, { error: 'This link has expired or was already used.' }), true;
      await accounts.setVerified(user.id);
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/auth/resend-verify' && req.method === 'POST') {
      const s = await currentUser(req, secure);
      if (!s) return send(res, 401, { error: 'Sign in first.' }), true;
      if (limited(String(s.user.id), 'resend', 3, 3600000)) return send(res, 429, { error: 'We just sent one. Check your inbox (and spam).' }), true;
      await sendVerification(s.user);
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/auth/forgot' && req.method === 'POST') {
      if (limited(ip, 'forgot', 8, 3600000)) return send(res, 429, { error: 'Too many requests. Try again later.' }), true;
      const body = await readBody(req);
      const email = normalizeEmail(sanitizeText(body.email, 254));
      // Same answer whether or not the account exists, so this can't be used to find accounts.
      const user = looksLikeEmail(email) ? await accounts.findByEmail(email) : null;
      if (user && !user.banned && mailEnabled() && !limited(emailIndex(email), 'reset-mail', 3, 3600000)) {
        const token = await accounts.createEmailToken(user.id, 'reset', 3600 * 1000);
        mailReset(user.email, user.handle, `${publicUrl}/auth/reset?t=${token}`).catch(e => console.error('[cosmonym] reset email failed:', e.message));
      }
      return send(res, 200, { ok: true, mail: mailEnabled() }), true;
    }

    if (p === '/api/auth/reset' && req.method === 'POST') {
      if (limited(ip, 'reset', 10, 3600000)) return send(res, 429, { error: 'Too many attempts. Try again later.' }), true;
      const body = await readBody(req);
      const password = String(body.password || '');
      const pp = passwordProblem(password); if (pp) return send(res, 400, { error: pp, field: 'password' }), true;
      if (await breached(password)) return send(res, 400, { error: 'That password has appeared in a data breach. Please choose another.', field: 'password' }), true;
      const user = await accounts.consumeEmailToken(String(body.token || ''), 'reset');
      if (!user) return send(res, 400, { error: 'This link has expired or was already used.' }), true;
      await accounts.setPassword(user.id, await hashPassword(password));
      await accounts.setVerified(user.id);           // they proved they own the inbox
      await accounts.endAllSessions(user.id);        // sign out everywhere else
      failures.delete(emailIndex(user.email));
      await startSession(res, user, ipHash, secure);
      return send(res, 200, { ok: true }), true;
    }

    // ---------------------------------------------------------------- social sign-in
    let m;
    if ((m = p.match(/^\/api\/auth\/oauth\/([a-z]+)\/start$/)) && req.method === 'GET') {
      if (!isProvider(m[1])) return send(res, 404, { error: 'unknown provider' }), true;
      if (limited(ip, 'oauth', 30, 3600000)) return send(res, 429, { error: 'Too many attempts.' }), true;
      const { url: target, flow } = startFlow(m[1], publicUrl);
      setCookie(res, 'cn_o', seal({ ...flow, ret: safeReturn(url.searchParams.get('return')) }, 10 * 60000), { secure, maxAge: 600 });
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      return res.end(), true;
    }

    if ((m = p.match(/^\/api\/auth\/oauth\/([a-z]+)\/callback$/)) && req.method === 'GET') {
      const back = (path, flag) => { setCookie(res, 'cn_o', '', { secure, maxAge: 0 }); res.writeHead(302, { Location: `${path}${path.includes('?') ? '&' : '?'}auth=${flag}`, 'Cache-Control': 'no-store' }); res.end(); return true; };
      const flow = unseal(parseCookies(req).cn_o);
      const state = url.searchParams.get('state');
      if (!flow || flow.p !== m[1] || !state || !crypto.timingSafeEqual(Buffer.from(sha256(state)), Buffer.from(sha256(flow.state)))) return back('/', 'expired');
      if (url.searchParams.get('error')) return back(flow.ret, 'cancelled');
      let prof;
      try { prof = await finishFlow(m[1], publicUrl, String(url.searchParams.get('code') || ''), flow); }
      catch (e) { console.error('[cosmonym] sign-in failed:', m[1], e.message); return back(flow.ret, 'failed'); }

      let user = await accounts.findIdentity(prof.provider, prof.subject);
      const signedIn = await currentUser(req, secure);
      if (!user && signedIn) { await accounts.linkIdentity(signedIn.user.id, prof.provider, prof.subject); user = signedIn.user; }
      if (!user && prof.email && prof.emailVerified) {
        // only a provider-verified address may join an existing account
        const existing = await accounts.findByEmail(prof.email);
        if (existing) {
          if (!existing.emailVerified) {
            // Someone registered this address without proving they own it. The real,
            // provider-verified owner takes the account over: drop the unproven
            // password and sign out every session (prevents account pre-hijacking).
            await accounts.setPassword(existing.id, null);
            await accounts.endAllSessions(existing.id);
            await accounts.setVerified(existing.id);
          }
          await accounts.linkIdentity(existing.id, prof.provider, prof.subject);
          user = await accounts.getUser(existing.id);
        }
      }
      if (!user) {
        let wish = prof.name || (prof.email ? prof.email.split('@')[0] : '');
        if (isOffensive(wish)) wish = 'Explorer';
        const email = prof.email && !(await accounts.findByEmail(prof.email)) ? prof.email : null;
        user = await accounts.createUser({ handle: await accounts.freeHandle(wish), email, emailVerified: !!(email && prof.emailVerified) });
        await accounts.linkIdentity(user.id, prof.provider, prof.subject);
      }
      if (user.banned) return back('/', 'banned');
      if (!signedIn || signedIn.user.id !== user.id) await startSession(res, user, ipHash, secure);
      return back(flow.ret, 'ok');
    }

    // ---------------------------------------------------------------- account settings
    if (p.startsWith('/api/account/')) {
      const s = await currentUser(req, secure);
      if (!s) return send(res, 401, { error: 'Sign in first.', needAuth: true }), true;
      if (p === '/api/account/export' && req.method === 'GET') {
        if (limited(String(s.user.id), 'export', 10, 3600000)) return send(res, 429, { error: 'Try again later.' }), true;
        const data = await accounts.exportData(s.user.id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="cosmonym-${s.user.handleSlug}.json"`, 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data, null, 2)), true;
      }
      const body = req.method === 'POST' ? await readBody(req) : {};

      if (p === '/api/account/handle' && req.method === 'POST') {
        if (limited(String(s.user.id), 'rename', 5, 86400000)) return send(res, 429, { error: 'You can change your name a few times a day.' }), true;
        const handle = sanitizeText(body.handle, 20).replace(/\s+/g, ' ');
        const hp = handleProblem(handle); if (hp) return send(res, 400, { error: hp }), true;
        const taken = await accounts.findByHandle(handle);
        if (taken && taken.id !== s.user.id) return send(res, 409, { error: 'That name is taken.' }), true;
        await accounts.setHandle(s.user.id, handle);
        await store.renameDiscoverer(s.user.id, handle);
        return send(res, 200, { user: publicUser(await accounts.getUser(s.user.id)) }), true;
      }

      if (p === '/api/account/password' && req.method === 'POST') {
        if (s.user.hasPassword && !(await verifyPassword(String(body.current || ''), s.user.passwordHash))) return send(res, 403, { error: 'Your current password is incorrect.' }), true;
        const password = String(body.password || '');
        const pp = passwordProblem(password, { email: s.user.email, handle: s.user.handle }); if (pp) return send(res, 400, { error: pp }), true;
        if (await breached(password)) return send(res, 400, { error: 'That password has appeared in a data breach. Please choose another.' }), true;
        await accounts.setPassword(s.user.id, await hashPassword(password));
        await accounts.endAllSessions(s.user.id);
        await startSession(res, s.user, ipHash, secure);
        return send(res, 200, { ok: true }), true;
      }

      // worlds claimed with the old browser-held tokens join this account
      if (p === '/api/account/attach' && req.method === 'POST') {
        const claims = Array.isArray(body.claims) ? body.claims.slice(0, 50) : [];
        const attached = [];
        for (const c of claims) {
          const w = typeof c?.id === 'string' && /^[a-z0-9-]{1,32}$/.test(c.id) ? await store.get(c.id) : null;
          if (!w || w.ownerId) continue;
          const h = crypto.createHash('sha256').update(String(c.token || '')).digest();
          if (crypto.timingSafeEqual(h, Buffer.from(w.tokenHash, 'hex'))) { await store.setOwner(w.id, s.user.id, s.user.handle); attached.push(w.id); }
        }
        return send(res, 200, { attached }), true;
      }

      if (p === '/api/account/delete' && req.method === 'POST') {
        if (body.confirm !== 'DELETE') return send(res, 400, { error: 'Type DELETE to confirm.' }), true;
        if (s.user.hasPassword && !(await verifyPassword(String(body.password || ''), s.user.passwordHash))) return send(res, 403, { error: 'Your password is incorrect.' }), true;
        await store.renameDiscoverer(s.user.id, 'Anonymous');   // their worlds stay, unattributed
        await accounts.deleteUser(s.user.id);
        setCookie(res, cookieName('cn_s', secure), '', { secure, maxAge: 0 });
        return send(res, 200, { ok: true }), true;
      }
      return send(res, 404, { error: 'no such endpoint' }), true;
    }

    // ---------------------------------------------------------------- profiles
    if ((m = p.match(/^\/api\/users\/([a-z0-9-]{1,32})$/)) && req.method === 'GET') {
      const prof = await accounts.profile(m[1]);
      if (!prof) return send(res, 404, { error: 'No explorer by that name.' }), true;
      const worlds = prof.worlds.map(w => publicWorld(w));
      const stars = worlds.reduce((n, w) => n + w.stars, 0);
      return send(res, 200, { user: { handle: prof.user.handle, slug: prof.user.handleSlug, createdAt: prof.user.createdAt }, worlds, stars }), true;
    }

    // ---------------------------------------------------------------- reports
    if ((m = p.match(/^\/api\/world\/([a-z0-9-]{1,32})\/report$/)) && req.method === 'POST') {
      if (limited(ip, 'report', 10, 3600000)) return send(res, 429, { error: 'Thanks, we have your reports. Give us a moment.' }), true;
      const w = await store.get(m[1]);
      if (!w) return send(res, 404, { error: 'unclaimed' }), true;
      const body = await readBody(req);
      const reason = REPORT_REASONS.has(body.reason) ? body.reason : 'other';
      if (await accounts.hasOpenReport(w.id, ipHash)) return send(res, 200, { ok: true }), true;
      const s = await currentUser(req, secure);
      await accounts.addReport({ worldId: w.id, reporterId: s?.user.id ?? null, reporterIp: ipHash, reason, note: sanitizeText(body.note, 400) });
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }

  return { handle, currentUser };
}
