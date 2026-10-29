// Accounts, sessions, sign-in identities, email tokens, reports and the admin audit
// log. MariaDB only. Same SQL rules as store.js: placeholders for every value.
import { encrypt, decrypt, emailIndex, normalizeEmail, randomToken, sha256 } from './crypto.js';

const slug = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
export const handleSlug = slug;

const USER_DAYS = 30;
const ADMIN_IDLE_MS = 30 * 60 * 1000;
const ADMIN_MAX_MS = 8 * 3600 * 1000;

function rowToUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id), handle: r.handle, handleSlug: r.handle_slug,
    email: r.email_enc ? decrypt(r.email_enc) : null, emailVerified: !!r.email_verified,
    hasPassword: !!r.password_hash, passwordHash: r.password_hash, role: r.role,
    totpEnc: r.totp_enc, totpLastStep: Number(r.totp_last_step || 0),
    banned: !!r.banned, banReason: r.ban_reason, createdAt: Number(r.created_at), lastLoginAt: Number(r.last_login_at),
  };
}
export const publicUser = u => u && ({ handle: u.handle, slug: u.handleSlug, role: u.role, emailVerified: u.emailVerified, hasPassword: u.hasPassword, createdAt: u.createdAt });

export class Accounts {
  constructor(store) { this.store = store; }
  get pool() { this.store.guard(); return this.store.pool; }

  // ---------------------------------------------------------------- users
  async getUser(id) {
    const [r] = await this.pool.execute('SELECT * FROM users WHERE id = ?', [id]);
    return rowToUser(r[0]);
  }
  async findByEmail(email) {
    const [r] = await this.pool.execute('SELECT * FROM users WHERE email_idx = ?', [emailIndex(email)]);
    return rowToUser(r[0]);
  }
  async findByHandle(handle) {
    const [r] = await this.pool.execute('SELECT * FROM users WHERE handle_slug = ?', [slug(handle)]);
    return rowToUser(r[0]);
  }
  async handleTaken(handle) { return !!(await this.findByHandle(handle)); }

  // A free handle based on a wish ("Sam" -> "Sam", "Sam2", "Sam3"...)
  async freeHandle(wish) {
    const base = String(wish || 'Explorer').replace(/[^\p{Script=Latin}0-9 _.-]/gu, '').trim().slice(0, 18) || 'Explorer';
    for (let i = 0; i < 50; i++) {
      const h = i === 0 ? base : `${base}${i + 1}`;
      if (slug(h).length >= 2 && !(await this.handleTaken(h))) return h;
    }
    return `Explorer${randomToken(4).replace(/[^a-z0-9]/gi, '').slice(0, 5)}`;
  }

  async createUser({ handle, email, passwordHash = null, emailVerified = false }) {
    const now = Date.now();
    const [r] = await this.pool.execute(
      `INSERT INTO users (handle, handle_slug, email_enc, email_idx, email_verified, password_hash, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [handle, slug(handle), email ? encrypt(normalizeEmail(email)) : null, email ? emailIndex(email) : null, emailVerified ? 1 : 0, passwordHash, now, now]);
    return this.getUser(r.insertId);
  }

  async setPassword(id, hash) { await this.pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]); }
  async setVerified(id) { await this.pool.execute('UPDATE users SET email_verified = 1 WHERE id = ?', [id]); }
  async setHandle(id, handle) { await this.pool.execute('UPDATE users SET handle = ?, handle_slug = ? WHERE id = ?', [handle, slug(handle), id]); }
  async touchLogin(id) { await this.pool.execute('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), id]); }
  async setRole(id, role) { await this.pool.execute('UPDATE users SET role = ? WHERE id = ?', [role === 'admin' ? 'admin' : 'user', id]); }
  async setTotp(id, encSecret) { await this.pool.execute('UPDATE users SET totp_enc = ?, totp_last_step = 0 WHERE id = ?', [encSecret, id]); }
  // Atomically records a used TOTP step; false if it (or a later one) was already used.
  async useTotpStep(id, step) {
    const [r] = await this.pool.execute('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [step, id, step]);
    return r.affectedRows === 1;
  }
  async setBanned(id, banned, reason = '') {
    await this.pool.execute('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?', [banned ? 1 : 0, reason.slice(0, 200), id]);
    if (banned) await this.endAllSessions(id);
  }
  async deleteUser(id) { await this.pool.execute('DELETE FROM users WHERE id = ?', [id]); }

  // ---------------------------------------------------------------- identities (social sign-in)
  async findIdentity(provider, subject) {
    const [r] = await this.pool.execute('SELECT user_id FROM identities WHERE provider = ? AND subject = ?', [provider, subject]);
    return r[0] ? this.getUser(r[0].user_id) : null;
  }
  async linkIdentity(userId, provider, subject) {
    await this.pool.execute('INSERT IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)', [provider, subject, userId, Date.now()]);
  }
  async providersOf(userId) {
    const [r] = await this.pool.execute('SELECT provider FROM identities WHERE user_id = ?', [userId]);
    return r.map(x => x.provider);
  }

  // ---------------------------------------------------------------- sessions
  async createSession(userId, kind, ipHash, { mfa = false } = {}) {
    const token = randomToken(32);
    const now = Date.now();
    const expires = kind === 'admin' ? now + ADMIN_MAX_MS : now + USER_DAYS * 86400000;
    await this.pool.execute('INSERT INTO sessions (id_hash, user_id, kind, created_at, expires_at, last_seen_at, mfa_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sha256(token), userId, kind, now, expires, now, mfa ? now : 0, ipHash]);
    return { token, expires };
  }

  async getSession(token, kind) {
    if (!token || token.length > 100) return null;
    const [r] = await this.pool.execute('SELECT * FROM sessions WHERE id_hash = ? AND kind = ?', [sha256(token), kind]);
    const s = r[0];
    if (!s) return null;
    const now = Date.now();
    const idle = kind === 'admin' && now - Number(s.last_seen_at) > ADMIN_IDLE_MS;
    if (Number(s.expires_at) < now || idle) { await this.endSession(token); return null; }
    const user = await this.getUser(s.user_id);
    if (!user || user.banned) { await this.endSession(token); return null; }
    if (kind === 'admin' && user.role !== 'admin') { await this.endSession(token); return null; }
    if (now - Number(s.last_seen_at) > 60000) {
      // sliding expiry for regular users; admins only extend their idle window
      const nextExpiry = kind === 'user' ? now + USER_DAYS * 86400000 : Number(s.expires_at);
      await this.pool.execute('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [now, nextExpiry, s.id_hash]);
    }
    return { user, mfaAt: Number(s.mfa_at), idHash: s.id_hash };
  }

  async markMfa(token) { await this.pool.execute('UPDATE sessions SET mfa_at = ? WHERE id_hash = ?', [Date.now(), sha256(token)]); }
  async endSession(token) { await this.pool.execute('DELETE FROM sessions WHERE id_hash = ?', [sha256(token)]); }
  async endAllSessions(userId) { await this.pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]); }
  async purgeExpired() { await this.pool.execute('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]); await this.pool.execute('DELETE FROM email_tokens WHERE expires_at < ?', [Date.now()]); }

  // ---------------------------------------------------------------- email tokens
  async createEmailToken(userId, purpose, ttlMs) {
    const token = randomToken(32);
    await this.pool.execute('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', [userId, purpose]);
    await this.pool.execute('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, purpose, Date.now() + ttlMs]);
    return token;
  }
  // Single use: deleting the row is what makes it valid, so two racing requests can't both win.
  async consumeEmailToken(token, purpose) {
    if (!token || token.length > 100) return null;
    const h = sha256(token);
    const [r] = await this.pool.execute('SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ? AND purpose = ?', [h, purpose]);
    if (!r[0]) return null;
    const [d] = await this.pool.execute('DELETE FROM email_tokens WHERE token_hash = ?', [h]);
    if (d.affectedRows !== 1 || Number(r[0].expires_at) < Date.now()) return null;
    return this.getUser(r[0].user_id);
  }

  // ---------------------------------------------------------------- profiles
  async profile(handle) {
    const u = await this.findByHandle(handle);
    if (!u || u.banned) return null;
    const worlds = await this.store.listByOwner(u.id);
    return { user: u, worlds };
  }

  // ---------------------------------------------------------------- data export (GDPR)
  async exportData(userId) {
    const u = await this.getUser(userId);
    const [stars] = await this.pool.execute('SELECT s.world_id, s.created_at FROM stars s WHERE s.voter = ? ORDER BY s.created_at', ['u' + userId]);
    const [reports] = await this.pool.execute('SELECT world_id, reason, note, status, created_at FROM reports WHERE reporter_id = ? ORDER BY created_at', [userId]);
    return {
      account: { explorerName: u.handle, email: u.email, emailVerified: u.emailVerified, passwordSet: u.hasPassword,
        signInProviders: await this.providersOf(userId), createdAt: new Date(u.createdAt).toISOString(), lastSignIn: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null },
      worlds: (await this.store.listByOwner(userId)).map(w => ({ id: w.id, name: w.name, message: w.epitaph, stars: w.stars, views: w.views, claimedAt: new Date(w.createdAt).toISOString(), dna: w.dna })),
      starsGiven: stars.map(s => ({ world: s.world_id, at: new Date(Number(s.created_at)).toISOString() })),
      reportsFiled: reports.map(r => ({ world: r.world_id, reason: r.reason, note: r.note, status: r.status, at: new Date(Number(r.created_at)).toISOString() })),
      exportedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- reports
  async addReport({ worldId, reporterId, reporterIp, reason, note }) {
    await this.pool.execute('INSERT INTO reports (world_id, reporter_id, reporter_ip, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [worldId, reporterId, reporterIp, reason, note, Date.now()]);
  }
  async hasOpenReport(worldId, reporterIp) {
    const [r] = await this.pool.execute("SELECT 1 FROM reports WHERE world_id = ? AND reporter_ip = ? AND status = 'open' LIMIT 1", [worldId, reporterIp]);
    return r.length > 0;
  }

  // ---------------------------------------------------------------- audit
  async audit(adminId, action, target = '', detail = '', ipHash = '') {
    await this.pool.execute('INSERT INTO audit_log (admin_id, action, target, detail, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, action, String(target).slice(0, 64), String(detail).slice(0, 600), ipHash, Date.now()]);
  }

  // ---------------------------------------------------------------- leaderboards
  async leaderboards() {
    const q = this.pool;
    const week = Date.now() - 7 * 86400000;
    const W = r => ({ id: r.id, name: r.name, discoverer: r.discoverer, ownerId: r.owner_id == null ? null : Number(r.owner_id),
      hue: Number(r.hue), stars: Number(r.stars), views: Number(r.views), createdAt: Number(r.created_at), dna: { type: r.type }, n: r.n == null ? undefined : Number(r.n) });
    const E = r => ({ handle: r.handle, slug: r.handle_slug, worlds: Number(r.worlds), stars: Number(r.stars || 0), rare: Number(r.rare || 0), best: Number(r.best || 0) });
    const [rarest, topStars, weekStars, byWorlds, byStars, byRare, firstEver, firstRarity, firstType, census] = await Promise.all([
      q.execute('SELECT * FROM worlds ORDER BY rarity_rank DESC, stars DESC, created_at ASC LIMIT 10'),
      q.execute('SELECT * FROM worlds WHERE stars > 0 ORDER BY stars DESC, created_at ASC LIMIT 10'),
      q.execute('SELECT w.*, COUNT(*) AS n FROM stars s JOIN worlds w ON w.id = s.world_id WHERE s.created_at > ? GROUP BY w.id ORDER BY n DESC, w.created_at ASC LIMIT 10', [week]),
      q.execute(`SELECT u.handle, u.handle_slug, COUNT(w.id) AS worlds, SUM(w.stars) AS stars, SUM(w.rarity_rank >= 4) AS rare, MAX(w.rarity_rank) AS best
                 FROM users u JOIN worlds w ON w.owner_id = u.id WHERE u.banned = 0 GROUP BY u.id ORDER BY worlds DESC, stars DESC LIMIT 10`),
      q.execute(`SELECT u.handle, u.handle_slug, COUNT(w.id) AS worlds, SUM(w.stars) AS stars, SUM(w.rarity_rank >= 4) AS rare, MAX(w.rarity_rank) AS best
                 FROM users u JOIN worlds w ON w.owner_id = u.id WHERE u.banned = 0 GROUP BY u.id HAVING stars > 0 ORDER BY stars DESC, worlds DESC LIMIT 10`),
      q.execute(`SELECT u.handle, u.handle_slug, COUNT(w.id) AS worlds, SUM(w.stars) AS stars, SUM(w.rarity_rank >= 2) AS rare, MAX(w.rarity_rank) AS best
                 FROM users u JOIN worlds w ON w.owner_id = u.id WHERE u.banned = 0 GROUP BY u.id HAVING rare > 0 ORDER BY best DESC, rare DESC LIMIT 10`),
      q.execute('SELECT * FROM worlds ORDER BY created_at ASC LIMIT 1'),
      q.execute('SELECT w.* FROM worlds w JOIN (SELECT rarity, MIN(created_at) AS m FROM worlds GROUP BY rarity) f ON f.rarity = w.rarity AND f.m = w.created_at'),
      q.execute('SELECT w.* FROM worlds w JOIN (SELECT type, MIN(created_at) AS m FROM worlds GROUP BY type) f ON f.type = w.type AND f.m = w.created_at'),
      q.execute('SELECT rarity, COUNT(*) AS n FROM worlds GROUP BY rarity'),
    ]);
    return {
      rarest: rarest[0].map(W), topStars: topStars[0].map(W), weekStars: weekStars[0].map(W),
      explorers: { worlds: byWorlds[0].map(E), stars: byStars[0].map(E), rare: byRare[0].map(E) },
      firsts: {
        ever: firstEver[0][0] ? W(firstEver[0][0]) : null,
        rarity: Object.fromEntries(firstRarity[0].map(r => [r.rarity, W(r)])),
        type: Object.fromEntries(firstType[0].map(r => [r.type, W(r)])),
      },
      census: Object.fromEntries(census[0].map(r => [r.rarity, Number(r.n)])),
    };
  }

  // ---------------------------------------------------------------- admin views
  async adminStats() {
    const day = 86400000, now = Date.now();
    const n = r => Number(Object.values(r[0][0])[0]);
    const q = this.pool;
    const counts = await Promise.all([
      q.execute('SELECT COUNT(*) FROM worlds'),
      q.execute('SELECT COUNT(*) FROM worlds WHERE created_at > ?', [now - day]),
      q.execute('SELECT COUNT(*) FROM worlds WHERE created_at > ?', [now - 7 * day]),
      q.execute('SELECT COUNT(*) FROM users'),
      q.execute('SELECT COUNT(*) FROM users WHERE created_at > ?', [now - day]),
      q.execute('SELECT COUNT(*) FROM users WHERE banned = 1'),
      q.execute("SELECT COUNT(*) FROM reports WHERE status = 'open'"),
      q.execute('SELECT COUNT(*) FROM stars'),
    ]);
    const [series] = await this.pool.execute(
      'SELECT FLOOR(created_at / ?) AS d, COUNT(*) AS n FROM worlds WHERE created_at > ? GROUP BY d ORDER BY d', [day, now - 14 * day]);
    const [userSeries] = await this.pool.execute(
      'SELECT FLOOR(created_at / ?) AS d, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY d ORDER BY d', [day, now - 14 * day]);
    const [rarity] = await this.pool.execute('SELECT rarity, COUNT(*) AS n FROM worlds GROUP BY rarity');
    const [types] = await this.pool.execute('SELECT type, COUNT(*) AS n FROM worlds GROUP BY type');
    return {
      worlds: n(counts[0]), worldsToday: n(counts[1]), worldsWeek: n(counts[2]),
      users: n(counts[3]), usersToday: n(counts[4]), banned: n(counts[5]),
      openReports: n(counts[6]), stars: n(counts[7]),
      claimsByDay: series.map(r => ({ day: Number(r.d) * day, n: Number(r.n) })),
      usersByDay: userSeries.map(r => ({ day: Number(r.d) * day, n: Number(r.n) })),
      rarity: Object.fromEntries(rarity.map(r => [r.rarity, Number(r.n)])),
      types: Object.fromEntries(types.map(r => [r.type, Number(r.n)])),
    };
  }

  async adminWorlds({ q = '', sort = 'new', page = 0 }) {
    const order = { new: 'w.created_at DESC', old: 'w.created_at ASC', stars: 'w.stars DESC', views: 'w.views DESC' }[sort] || 'w.created_at DESC';
    const offset = Math.max(0, Math.floor(page)) * 50;
    const like = '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%';
    const [r] = await this.pool.query(
      `SELECT w.id, w.name, w.discoverer, w.epitaph, w.type, w.rarity, w.stars, w.views, w.created_at, w.owner_id, u.handle AS owner_handle,
              (SELECT COUNT(*) FROM reports rp WHERE rp.world_id = w.id AND rp.status = 'open') AS open_reports
       FROM worlds w LEFT JOIN users u ON u.id = w.owner_id
       WHERE (? = '' OR w.id LIKE ? OR w.name LIKE ? OR w.discoverer LIKE ? OR w.epitaph LIKE ?)
       ORDER BY ${order} LIMIT 50 OFFSET ?`, [q, like, like, like, like, offset]);
    return r.map(x => ({ id: x.id, name: x.name, discoverer: x.discoverer, epitaph: x.epitaph, type: x.type, rarity: x.rarity,
      stars: Number(x.stars), views: Number(x.views), createdAt: Number(x.created_at), ownerId: x.owner_id == null ? null : Number(x.owner_id),
      ownerHandle: x.owner_handle, openReports: Number(x.open_reports) }));
  }

  async adminUsers({ q = '', page = 0 }) {
    const offset = Math.max(0, Math.floor(page)) * 50;
    const like = '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%';
    const exact = q && q.includes('@') ? emailIndex(q) : '';
    const [r] = await this.pool.query(
      `SELECT u.*, (SELECT COUNT(*) FROM worlds w WHERE w.owner_id = u.id) AS world_count,
              (SELECT GROUP_CONCAT(provider) FROM identities i WHERE i.user_id = u.id) AS providers
       FROM users u WHERE (? = '' OR u.handle LIKE ? OR u.email_idx = ?)
       ORDER BY u.created_at DESC LIMIT 50 OFFSET ?`, [q, like, exact, offset]);
    return r.map(x => ({ ...publicUser(rowToUser(x)), id: Number(x.id), email: x.email_enc ? decrypt(x.email_enc) : null,
      banned: !!x.banned, banReason: x.ban_reason, lastLoginAt: Number(x.last_login_at), worlds: Number(x.world_count),
      providers: x.providers ? String(x.providers).split(',') : [], twoFactor: !!x.totp_enc }));
  }

  async adminReports(status = 'open') {
    const [r] = await this.pool.query(
      `SELECT rp.*, w.name AS world_name, w.discoverer, w.epitaph, u.handle AS reporter_handle
       FROM reports rp LEFT JOIN worlds w ON w.id = rp.world_id LEFT JOIN users u ON u.id = rp.reporter_id
       WHERE rp.status = ? ORDER BY rp.created_at DESC LIMIT 200`, [status === 'closed' ? 'closed' : 'open']);
    return r.map(x => ({ id: Number(x.id), worldId: x.world_id, worldName: x.world_name, discoverer: x.discoverer, epitaph: x.epitaph,
      reason: x.reason, note: x.note, reporter: x.reporter_handle || 'anonymous', createdAt: Number(x.created_at), status: x.status }));
  }

  async resolveReports(worldId, adminId) {
    await this.pool.execute("UPDATE reports SET status = 'closed', resolved_by = ?, resolved_at = ? WHERE world_id = ? AND status = 'open'", [adminId, Date.now(), worldId]);
  }
  async resolveReport(id, adminId) {
    await this.pool.execute("UPDATE reports SET status = 'closed', resolved_by = ?, resolved_at = ? WHERE id = ?", [adminId, Date.now(), id]);
  }

  async adminAudit() {
    const [r] = await this.pool.query(
      'SELECT a.*, u.handle FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC LIMIT 300');
    return r.map(x => ({ at: Number(x.created_at), admin: x.handle || '(system)', action: x.action, target: x.target, detail: x.detail }));
  }

  async editWorld(id, { epitaph, discoverer }) {
    if (epitaph != null) await this.pool.execute('UPDATE worlds SET epitaph = ? WHERE id = ?', [epitaph, id]);
    if (discoverer != null) await this.pool.execute('UPDATE worlds SET discoverer = ?, discoverer_slug = ? WHERE id = ?', [discoverer, slug(discoverer), id]);
  }
}
