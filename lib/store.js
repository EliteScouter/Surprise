// World storage. Two interchangeable backends behind one async interface:
//   FileStore   a JSON file in the data volume (local development, fallback)
//   MariaStore  MariaDB / Galera (production)
//
// SQL rules for MariaStore (enforced by test/sql-safety.test.mjs):
//   - every value goes through a ? placeholder, never string building
//   - sort orders come from the fixed SORTS table, never from the request
//   - LIKE patterns are escaped with likeEscape()
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class DuplicateError extends Error {}
export class UnavailableError extends Error {}

export const RARITY_RANK = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythic: 5 };

const SORTS = {
  new: 'created_at DESC',
  top: 'stars DESC, views DESC',
  viewed: 'views DESC',
};

const likeEscape = s => s.replace(/[\\%_]/g, c => '\\' + c);
const slug = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ------------------------------------------------------------------ file
export class FileStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'worlds.json');
    this.worlds = Object.create(null);   // null prototype: "constructor" is just a name
    this.order = [];
    this.dirty = false;
    this.kind = 'file';
  }

  async init() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      Object.assign(this.worlds, raw.worlds || {});
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.order = Object.values(this.worlds).sort((a, b) => a.createdAt - b.createdAt).map(w => w.id);
    setInterval(() => this.flush(), 2000).unref();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = this.file + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify({ worlds: this.worlds }));
      await fsp.rename(tmp, this.file);
    } catch (e) { this.dirty = true; console.error('[cosmonym] write failed', e.message); }
  }

  get ready() { return true; }
  async close() { await this.flush(); }
  async count() { return this.order.length; }
  async countSince(ts) {
    let n = 0;
    for (let i = this.order.length - 1; i >= 0 && this.worlds[this.order[i]].createdAt > ts; i--) n++;
    return n;
  }
  async get(id) { return this.worlds[id] || null; }

  async create(w) {
    if (this.worlds[w.id]) throw new DuplicateError();
    this.worlds[w.id] = { ...w, starHashes: [] };
    this.order.push(w.id);
    this.dirty = true;
    return this.worlds[w.id];
  }

  async update(id, fields) {
    const w = this.worlds[id];
    if (!w) return null;
    Object.assign(w, fields);
    this.dirty = true;
    return w;
  }

  async addView(id) { const w = this.worlds[id]; if (w) { w.views++; this.dirty = true; } }

  async toggleStar(id, voter) {
    const w = this.worlds[id];
    if (!w) return null;
    w.starHashes ||= [];
    const i = w.starHashes.indexOf(voter);
    const starred = i === -1;
    if (starred) w.starHashes.push(voter); else w.starHashes.splice(i, 1);
    w.stars = w.starHashes.length;
    this.dirty = true;
    return { stars: w.stars, starred };
  }

  async list({ sort = 'new', limit = 40, q = '' }) {
    let list = this.order.map(id => this.worlds[id]);
    if (q) list = list.filter(w => w.id.includes(q) || slug(w.discoverer).includes(q));
    if (sort === 'top') list = [...list].sort((a, b) => b.stars - a.stars || b.views - a.views);
    else if (sort === 'viewed') list = [...list].sort((a, b) => b.views - a.views);
    else list = list.slice().reverse();
    return list.slice(0, limit);
  }

  async map() { return this.order.map(id => this.worlds[id]); }

  // bring stored tiers in line with the current rarity rules
  async retier(tierOf) {
    let n = 0;
    for (const w of Object.values(this.worlds)) {
      const t = tierOf(w.name);
      if (w.rarity !== t) { w.rarity = t; n++; }
    }
    if (n) this.dirty = true;
    return n;
  }

  // every record, with its star voters, for importing into another store
  async exportAll() { return this.order.map(id => this.worlds[id]); }
}

// ------------------------------------------------------------------ MariaDB
const MIGRATIONS = [
  // 1: worlds and stars
  [
    `CREATE TABLE IF NOT EXISTS worlds (
      id              VARCHAR(32)  NOT NULL,
      name            VARCHAR(64)  NOT NULL,
      discoverer      VARCHAR(64)  NOT NULL,
      discoverer_slug VARCHAR(64)  NOT NULL,
      epitaph         VARCHAR(320) NOT NULL DEFAULT '',
      dna             TEXT         NOT NULL,
      type            VARCHAR(12)  NOT NULL,
      hue             FLOAT        NOT NULL,
      rarity          VARCHAR(16)  NOT NULL,
      token_hash      CHAR(64)     NOT NULL,
      stars           INT UNSIGNED NOT NULL DEFAULT 0,
      views           INT UNSIGNED NOT NULL DEFAULT 0,
      created_at      BIGINT       NOT NULL,
      updated_at      BIGINT       NOT NULL,
      PRIMARY KEY (id),
      KEY idx_created (created_at),
      KEY idx_stars (stars),
      KEY idx_views (views),
      KEY idx_discoverer (discoverer_slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS stars (
      world_id   VARCHAR(32) NOT NULL,
      voter      VARCHAR(32) NOT NULL,
      created_at BIGINT      NOT NULL,
      PRIMARY KEY (world_id, voter),
      CONSTRAINT fk_stars_world FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ],
  // 2: accounts, sign-in identities, sessions, email tokens, reports, admin audit log
  [
    `CREATE TABLE IF NOT EXISTS users (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      handle          VARCHAR(24)  NOT NULL,
      handle_slug     VARCHAR(32)  NOT NULL,
      email_enc       VARBINARY(400) NULL,
      email_idx       CHAR(64)     NULL,
      email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
      password_hash   VARCHAR(160) NULL,
      role            VARCHAR(8)   NOT NULL DEFAULT 'user',
      totp_enc        VARBINARY(200) NULL,
      totp_last_step  BIGINT       NOT NULL DEFAULT 0,
      banned          TINYINT(1)   NOT NULL DEFAULT 0,
      ban_reason      VARCHAR(200) NOT NULL DEFAULT '',
      created_at      BIGINT       NOT NULL,
      last_login_at   BIGINT       NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY uq_handle (handle_slug),
      UNIQUE KEY uq_email (email_idx)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS identities (
      provider   VARCHAR(16)  NOT NULL,
      subject    VARCHAR(191) NOT NULL,
      user_id    BIGINT UNSIGNED NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (provider, subject),
      KEY idx_user (user_id),
      CONSTRAINT fk_ident_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id_hash      CHAR(64)   NOT NULL,
      user_id      BIGINT UNSIGNED NOT NULL,
      kind         VARCHAR(8) NOT NULL,
      created_at   BIGINT     NOT NULL,
      expires_at   BIGINT     NOT NULL,
      last_seen_at BIGINT     NOT NULL,
      mfa_at       BIGINT     NOT NULL DEFAULT 0,
      ip_hash      VARCHAR(32) NOT NULL DEFAULT '',
      PRIMARY KEY (id_hash),
      KEY idx_user (user_id),
      KEY idx_expires (expires_at),
      CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS email_tokens (
      token_hash CHAR(64)   NOT NULL,
      user_id    BIGINT UNSIGNED NOT NULL,
      purpose    VARCHAR(8) NOT NULL,
      expires_at BIGINT     NOT NULL,
      PRIMARY KEY (token_hash),
      KEY idx_user (user_id),
      CONSTRAINT fk_tok_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS reports (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      world_id    VARCHAR(32)  NOT NULL,
      reporter_id BIGINT UNSIGNED NULL,
      reporter_ip VARCHAR(32)  NOT NULL,
      reason      VARCHAR(24)  NOT NULL,
      note        VARCHAR(400) NOT NULL DEFAULT '',
      status      VARCHAR(10)  NOT NULL DEFAULT 'open',
      created_at  BIGINT       NOT NULL,
      resolved_by BIGINT UNSIGNED NULL,
      resolved_at BIGINT       NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_status (status, created_at),
      KEY idx_world (world_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      admin_id   BIGINT UNSIGNED NULL,
      action     VARCHAR(32)  NOT NULL,
      target     VARCHAR(64)  NOT NULL DEFAULT '',
      detail     VARCHAR(600) NOT NULL DEFAULT '',
      ip_hash    VARCHAR(32)  NOT NULL DEFAULT '',
      created_at BIGINT       NOT NULL,
      PRIMARY KEY (id),
      KEY idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `ALTER TABLE worlds ADD COLUMN owner_id BIGINT UNSIGNED NULL AFTER discoverer_slug, ADD KEY idx_owner (owner_id),
      ADD CONSTRAINT fk_world_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE SET NULL`,
  ],
  // 3: rarity rank for leaderboards (0 Common .. 5 Mythic), backfilled from the stored tier
  [
    `ALTER TABLE worlds ADD COLUMN rarity_rank TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER rarity, ADD KEY idx_rarity (rarity_rank, created_at)`,
    `UPDATE worlds SET rarity_rank = CASE rarity WHEN 'Uncommon' THEN 1 WHEN 'Rare' THEN 2 WHEN 'Epic' THEN 3 WHEN 'Legendary' THEN 4 WHEN 'Mythic' THEN 5 ELSE 0 END`,
    `ALTER TABLE stars ADD KEY idx_created (created_at)`,
  ],
];

const STRICT_MODE = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

function rowToWorld(r) {
  return {
    id: r.id, name: r.name, discoverer: r.discoverer, epitaph: r.epitaph,
    dna: typeof r.dna === 'string' ? JSON.parse(r.dna) : r.dna,
    hue: Number(r.hue), rarity: r.rarity, tokenHash: r.token_hash, ownerId: r.owner_id == null ? null : Number(r.owner_id),
    stars: Number(r.stars), views: Number(r.views), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

// Galera can reject a commit that raced another node; a retry almost always wins.
async function retry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt < 3 && (e.errno === 1213 || e.errno === 1205)) { await new Promise(r => setTimeout(r, 30 * (attempt + 1))); continue; }
      throw e;
    }
  }
}

export class MariaStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'mariadb';
    this.pool = null;
    this.ok = false;
  }

  async init({ importFrom } = {}) {
    const mysql = await import('mysql2/promise');
    const common = {
      host: this.cfg.host, port: this.cfg.port, database: this.cfg.database,
      ssl: this.cfg.ssl ? { rejectUnauthorized: this.cfg.sslVerify } : undefined,
      charset: 'utf8mb4_unicode_ci', supportBigNumbers: true, bigNumberStrings: false, dateStrings: true,
      connectTimeout: 5000, multipleStatements: false,
    };

    // keep trying until the database is reachable (the relay may still be starting)
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.cfg.migrateUser) await this.migrate(mysql, common);
        this.pool = mysql.createPool({ ...common, user: this.cfg.user, password: this.cfg.password, connectionLimit: 10, waitForConnections: true, queueLimit: 200, enableKeepAlive: true });
        this.pool.on('connection', conn => conn.query('SET SESSION sql_mode = ?', [STRICT_MODE]));
        await this.pool.query('SELECT 1 FROM worlds LIMIT 1');
        break;
      } catch (e) {
        await this.pool?.end().catch(() => {});
        this.pool = null;
        const wait = Math.min(30, attempt * 2);
        console.error(`[cosmonym] database not ready (${e.code || e.message}); retrying in ${wait}s`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    }
    this.ok = true;
    console.log(`[cosmonym] using MariaDB at ${this.cfg.host}:${this.cfg.port}/${this.cfg.database}`);
    if (importFrom) await this.importFrom(importFrom);
    // track availability so requests fail fast with 503 instead of hanging
    setInterval(async () => {
      try { await this.pool.query('SELECT 1'); this.ok = true; } catch { this.ok = false; }
    }, 10000).unref();
  }

  async migrate(mysql, common) {
    const conn = await mysql.createConnection({ ...common, user: this.cfg.migrateUser, password: this.cfg.migratePassword });
    try {
      await conn.query('SET SESSION sql_mode = ?', [STRICT_MODE]);
      await conn.query(`CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL PRIMARY KEY, applied_at BIGINT NOT NULL) ENGINE=InnoDB`);
      const [rows] = await conn.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
      for (let v = rows[0].v; v < MIGRATIONS.length; v++) {
        for (const stmt of MIGRATIONS[v]) await conn.query(stmt);
        await conn.execute('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [v + 1, Date.now()]);
        console.log(`[cosmonym] applied schema migration ${v + 1}`);
      }
    } finally { await conn.end(); }
  }

  // One-time move of worlds from the old JSON file. Skips anything already present.
  async importFrom(fileStore) {
    const all = await fileStore.exportAll();
    if (!all.length) return;
    let added = 0;
    for (const w of all) {
      try {
        await this.create(w);
        for (const voter of w.starHashes || []) await this.toggleStar(w.id, voter);
        await this.pool.execute('UPDATE worlds SET views = ? WHERE id = ?', [w.views || 0, w.id]);
        added++;
      } catch (e) { if (!(e instanceof DuplicateError)) throw e; }
    }
    console.log(`[cosmonym] imported ${added} of ${all.length} worlds from ${fileStore.file}`);
    await fsp.rename(fileStore.file, fileStore.file + ".imported").catch(() => {});
  }

  get ready() { return this.ok && !!this.pool; }
  guard() { if (!this.ready) throw new UnavailableError('database unavailable'); }
  async close() { await this.pool?.end(); }

  async count() {
    this.guard();
    const [r] = await this.pool.execute('SELECT COUNT(*) AS n FROM worlds');
    return Number(r[0].n);
  }

  async countSince(ts) {
    this.guard();
    const [r] = await this.pool.execute('SELECT COUNT(*) AS n FROM worlds WHERE created_at > ?', [ts]);
    return Number(r[0].n);
  }

  async get(id) {
    this.guard();
    const [r] = await this.pool.execute('SELECT * FROM worlds WHERE id = ?', [id]);
    return r.length ? rowToWorld(r[0]) : null;
  }

  async create(w) {
    this.guard();
    try {
      await this.pool.execute(
        `INSERT INTO worlds (id, name, discoverer, discoverer_slug, owner_id, epitaph, dna, type, hue, rarity, rarity_rank, token_hash, stars, views, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [w.id, w.name, w.discoverer, slug(w.discoverer), w.ownerId ?? null, w.epitaph || '', JSON.stringify(w.dna), w.dna.type, w.hue, w.rarity, RARITY_RANK[w.rarity] ?? 0, w.tokenHash, w.views ?? 1, w.createdAt, w.updatedAt]);
    } catch (e) {
      if (e.errno === 1062) throw new DuplicateError();
      throw e;
    }
    return this.get(w.id);
  }

  async update(id, { dna, epitaph, hue, updatedAt }) {
    this.guard();
    await this.pool.execute('UPDATE worlds SET dna = ?, type = ?, epitaph = ?, hue = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(dna), dna.type, epitaph, hue, updatedAt, id]);
    return this.get(id);
  }

  async addView(id) {
    this.guard();
    await this.pool.execute('UPDATE worlds SET views = views + 1 WHERE id = ?', [id]);
  }

  async toggleStar(id, voter) {
    this.guard();
    return retry(async () => {
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        const [w] = await conn.execute('SELECT id FROM worlds WHERE id = ? FOR UPDATE', [id]);
        if (!w.length) { await conn.rollback(); return null; }
        const [ins] = await conn.execute('INSERT IGNORE INTO stars (world_id, voter, created_at) VALUES (?, ?, ?)', [id, voter, Date.now()]);
        const starred = ins.affectedRows === 1;
        if (!starred) await conn.execute('DELETE FROM stars WHERE world_id = ? AND voter = ?', [id, voter]);
        await conn.execute('UPDATE worlds SET stars = (SELECT COUNT(*) FROM stars WHERE world_id = ?) WHERE id = ?', [id, id]);
        const [s] = await conn.execute('SELECT stars FROM worlds WHERE id = ?', [id]);
        await conn.commit();
        return { stars: Number(s[0].stars), starred };
      } catch (e) { await conn.rollback().catch(() => {}); throw e; }
      finally { conn.release(); }
    });
  }

  async list({ sort = 'new', limit = 40, q = '' }) {
    this.guard();
    const order = SORTS[sort] || SORTS.new;
    const n = Math.max(1, Math.min(200, Math.floor(limit) || 40));
    // query() (not execute) because MariaDB's binary protocol rejects LIMIT as a
    // prepared parameter; values are still escaped through the placeholders.
    if (q) {
      const like = '%' + likeEscape(q) + '%';
      const [r] = await this.pool.query(`SELECT * FROM worlds WHERE id LIKE ? OR discoverer_slug LIKE ? ORDER BY ${order} LIMIT ?`, [like, like, n]);
      return r.map(rowToWorld);
    }
    const [r] = await this.pool.query(`SELECT * FROM worlds ORDER BY ${order} LIMIT ?`, [n]);
    return r.map(rowToWorld);
  }

  async listByOwner(ownerId) {
    this.guard();
    const [r] = await this.pool.execute('SELECT * FROM worlds WHERE owner_id = ? ORDER BY created_at DESC', [ownerId]);
    return r.map(rowToWorld);
  }

  // bring stored tiers in line with the current rarity rules (runs at boot; a no-op once settled)
  async retier(tierOf) {
    this.guard();
    const [rows] = await this.pool.execute('SELECT id, name, rarity FROM worlds');
    let n = 0;
    for (const r of rows) {
      const t = tierOf(r.name);
      if (r.rarity === t) continue;
      await this.pool.execute('UPDATE worlds SET rarity = ?, rarity_rank = ? WHERE id = ?', [t, RARITY_RANK[t] ?? 0, r.id]);
      n++;
    }
    return n;
  }

  async setOwner(id, ownerId, discoverer) {
    this.guard();
    await this.pool.execute('UPDATE worlds SET owner_id = ?, discoverer = ?, discoverer_slug = ? WHERE id = ? AND owner_id IS NULL', [ownerId, discoverer, slug(discoverer), id]);
  }

  async renameDiscoverer(ownerId, discoverer) {
    this.guard();
    await this.pool.execute('UPDATE worlds SET discoverer = ?, discoverer_slug = ? WHERE owner_id = ?', [discoverer, slug(discoverer), ownerId]);
  }

  async remove(id) {
    this.guard();
    const [r] = await this.pool.execute('DELETE FROM worlds WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }

  async map() {
    this.guard();
    const [r] = await this.pool.query('SELECT id, name, hue, type, stars FROM worlds ORDER BY created_at');
    return r.map(x => ({ id: x.id, name: x.name, hue: Number(x.hue), dna: { type: x.type }, stars: Number(x.stars) }));
  }
}

export function createStore(env, dataDir) {
  if (env.DB_PASSWORD) {
    return new MariaStore({
      host: env.DB_HOST || 'gate', port: Number(env.DB_PORT || 3306), database: env.DB_NAME || 'cosmonym',
      user: env.DB_USER || 'cosmonym', password: env.DB_PASSWORD,
      migrateUser: env.DB_MIGRATE_PASSWORD ? (env.DB_MIGRATE_USER || 'cosmonym_migrate') : null,
      migratePassword: env.DB_MIGRATE_PASSWORD,
      ssl: env.DB_TLS === 'on' || env.DB_TLS === 'verify', sslVerify: env.DB_TLS === 'verify',
    });
  }
  return new FileStore(dataDir);
}

export function hasLegacyFile(dataDir) {
  return fs.existsSync(path.join(dataDir, 'worlds.json'));
}
