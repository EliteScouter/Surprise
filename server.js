// COSMONYM server: static host, world registry, and a live event stream.
// Zero dependencies beyond Node's standard library; three.js is served from node_modules.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dnaFromName, rarityOf, worldColorHue } from './public/js/dna.js';
import { isOffensive } from './public/js/filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'worlds.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const MAX_WORLDS = 200000;
// Proxies allowed to tell us the visitor's real IP (comma-separated IPs or IPv4 CIDRs).
// Empty means trust nobody: the TCP peer address is the visitor.
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
// Extra origins allowed to POST (e.g. https://cosmonym.app). Same-host requests are always allowed.
const PUBLIC_ORIGINS = (process.env.PUBLIC_ORIGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_STREAMS_PER_IP = 6;
const MAX_STREAMS = 5000;

// ---------------------------------------------------------------- storage
let db = { worlds: Object.create(null), order: [] };
let dirty = false;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.worlds = Object.assign(Object.create(null), raw.worlds || {});
    // rarity is derived from the name, never trusted from storage or clients
    for (const w of Object.values(db.worlds)) w.rarity = rarityOf(dnaFromName(w.name)).name;
    db.order = Object.values(db.worlds).sort((a, b) => a.createdAt - b.createdAt).map(w => w.id);
    console.log(`[cosmonym] loaded ${db.order.length} worlds`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[cosmonym] failed to read db, starting fresh', e.message);
  }
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify({ worlds: db.worlds }));
    await fsp.rename(tmp, DB_FILE);
  } catch (e) {
    dirty = true;
    console.error('[cosmonym] write failed', e.message);
  }
}
setInterval(flush, 2000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await flush(); process.exit(0); });
}

// Secret pepper for hashing IP addresses. Without it, all 4 billion IPv4 hashes
// could simply be precomputed and reversed.
function loadSecret() {
  if (process.env.IP_HASH_SECRET) return process.env.IP_HASH_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}
const IP_SECRET = loadSecret();

// ---------------------------------------------------------------- helpers
export function slugify(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

const clean = str => !isOffensive(str);
// Strips control characters, angle brackets, and invisible/bidirectional characters
// that can disguise one name as another (right-to-left overrides, zero-width joiners).
const sanitizeText = (s, max) => String(s ?? '').normalize('NFC')
  .replace(/[\u0000-\u001f\u007f-\u009f<>\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, max);
// World names: Latin letters (accents fine), digits, spaces and a little punctuation.
// Blocks look-alike letters from other scripts (Cyrillic "а" posing as Latin "a").
const NAME_OK = /^[\p{Script=Latin}0-9 '’.&!-]+$/u;

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

// Every numeric DNA field and its legal range. Anything else is dropped.
const DNA_SCHEMA = {
  seedX: [-1000, 1000], seedY: [-1000, 1000], seedZ: [-1000, 1000],
  seaLevel: [0, 1], continentScale: [0.3, 4], warp: [0, 2], mountains: [0, 1], roughness: [0, 1], craters: [0, 1],
  temperature: [-1, 1], humidity: [0, 1], clouds: [0, 1], atmosphere: [0, 1], atmoHue: [0, 1],
  civ: [0, 1], rings: [0, 1], ringHue: [0, 1], moons: [0, 4], tilt: [0, 0.8], spin: [0.05, 3], hueShift: [-0.5, 0.5],
  bands: [2, 30], storm: [0, 1], radius: [0, 1], aurora: [0, 1], binary: [0, 1], megastructure: [0, 1], variant: [0, 9],
};
const TYPES = ['terran', 'ocean', 'desert', 'ice', 'lava', 'gas', 'barren', 'toxic'];

// Missing fields fall back to the name's own DNA, so a partial or hostile payload
// still yields a complete, valid world.
function sanitizeDna(input, name) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = dnaFromName(name);
  for (const [k, [lo, hi]] of Object.entries(DNA_SCHEMA)) {
    if (k in input) out[k] = clampNum(input[k], lo, hi, lo);
  }
  if (TYPES.includes(input.type)) out.type = input.type;
  out.moons = Math.round(out.moons); out.variant = Math.round(out.variant);
  return out;
}

function publicWorld(w, full = false) {
  const base = {
    id: w.id, name: w.name, discoverer: w.discoverer, createdAt: w.createdAt,
    stars: w.stars, views: w.views, type: w.dna.type, hue: w.hue, rarity: w.rarity,
  };
  if (full) { base.dna = w.dna; base.epitaph = w.epitaph; base.updatedAt = w.updatedAt; }
  return base;
}

// Fixed-window rate limiter keyed by ip+bucket.
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const key = ip + '|' + bucket;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) {
    if (hits.size > 500000) hits.clear();      // memory backstop under a flood
    h = { n: 0, reset: now + windowMs }; hits.set(key, h);
  }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();

const viewSeen = new Map(); // id -> Set(ipHash), reset hourly
setInterval(() => viewSeen.clear(), 3600000).unref();

const bareIp = a => String(a || '').replace(/^::ffff:/, '');
const ipv4ToInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
function trusted(ip) {
  return TRUSTED_PROXIES.some(rule => {
    if (!rule.includes('/')) return rule === ip;
    const [base, bits] = rule.split('/');
    if (!net.isIPv4(base) || !net.isIPv4(ip)) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
  });
}
// Forwarding headers are only believed when the TCP peer is one of our own proxies;
// otherwise anyone could send a fake X-Forwarded-For and dodge every limit.
function ipOf(req) {
  const peer = bareIp(req.socket.remoteAddress);
  if (!trusted(peer)) return peer || '?';
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (net.isIP(cf)) return cf;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(h => h.trim()).filter(Boolean);
  const last = bareIp(hops[hops.length - 1]);   // the hop our proxy itself appended
  return net.isIP(last) ? last : peer;
}
const ipHash = ip => crypto.createHmac('sha256', IP_SECRET).update(ip).digest('base64url').slice(0, 16);

// ---------------------------------------------------------------- live stream
const clients = new Set();
const streamsByIp = new Map();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let lastOnline = -1;
setInterval(() => {
  if (clients.size !== lastOnline) { lastOnline = clients.size; broadcast('online', { online: clients.size }); }
  for (const res of clients) res.write(': ping\n\n');
}, 15000).unref();

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

class BadRequest extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
async function readBody(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new BadRequest('request too large', 413); chunks.push(c); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new BadRequest('invalid JSON'); }
}

// Cross-site request forgery guard for every state-changing request. Requiring a JSON
// content type forces a CORS preflight that we never grant, and the Origin check
// catches anything that slips past it.
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = String(req.headers.origin || '').toLowerCase();
  if (!origin) return true;            // non-browser clients; still rate limited
  try {
    const o = new URL(origin);
    return o.host === String(req.headers.host || '').toLowerCase() || PUBLIC_ORIGINS.includes(o.origin);
  } catch { return false; }
}

async function serveFile(res, file, root, cache) {
  const resolved = path.resolve(root, '.' + path.sep + file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return send(res, 404, 'not found');
  if (path.basename(resolved).startsWith('.')) return send(res, 404, 'not found');
  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error('nf');
    const lm = st.mtime.toUTCString();
    if (res.req.headers['if-modified-since'] === lm) { res.writeHead(304, { 'Cache-Control': cache }); return res.end(); }
    res.writeHead(200, {
      'Last-Modified': lm,
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
    });
    fs.createReadStream(resolved).pipe(res);
  } catch { send(res, 404, 'not found'); }
}

let indexTemplate = '';
let importMapHash = '';
function loadTemplate() {
  indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const map = indexTemplate.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  // browsers hash inline scripts after normalising line endings, so we must too
  importMapHash = map ? crypto.createHash('sha256').update(map[1].replace(/\r\n?/g, '\n')).digest('base64') : '';
}
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self'${importMapHash ? ` 'sha256-${importMapHash}'` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "worker-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
function indexHtml(world) {
  if (!world) return indexTemplate;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rar = world.rarity || 'Common';
  const title = `${esc(world.name)}, ${/^[aeiou]/i.test(rar) ? 'an' : 'a'} ${esc(rar)} world on COSMONYM`;
  const desc = `Discovered by ${esc(world.discoverer)}. ${world.epitaph ? '“' + esc(world.epitaph) + '” ' : ''}Type any name and grow your own world.`;
  return indexTemplate
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${desc}`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${desc}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = ipOf(req);
  if (!indexTemplate || process.env.NODE_ENV !== 'production') loadTemplate();
  securityHeaders(res);
  if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) return send(res, 405, { error: 'method not allowed' });
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-site request refused' });
  }

  try {
    // ---- API
    if (p === '/api/health') return send(res, 200, { ok: true, worlds: db.order.length });

    if (p === '/api/stream') {
      // per-IP and global caps so nobody can exhaust connections; the online count
      // is broadcast on a timer rather than on every connect, so a connect storm can't fan out
      const open = streamsByIp.get(ip) || 0;
      if (open >= MAX_STREAMS_PER_IP || clients.size >= MAX_STREAMS) return send(res, 429, { error: 'too many live connections' });
      streamsByIp.set(ip, open + 1);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 4000\n\nevent: online\ndata: ${JSON.stringify({ online: clients.size + 1 })}\n\n`);
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        const n = (streamsByIp.get(ip) || 1) - 1;
        if (n <= 0) streamsByIp.delete(ip); else streamsByIp.set(ip, n);
      });
      return;
    }

    if (p === '/api/stats') {
      const today = Date.now() - 86400000;
      let todayCount = 0;
      for (let i = db.order.length - 1; i >= 0; i--) { if (db.worlds[db.order[i]].createdAt > today) todayCount++; else break; }
      return send(res, 200, { worlds: db.order.length, online: clients.size, today: todayCount });
    }

    if (p === '/api/worlds' && req.method === 'GET') {
      const sort = url.searchParams.get('sort') || 'new';
      const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit'))) || 40));
      const rawQ = url.searchParams.get('q') || '';
      const q = isOffensive(rawQ) ? '' : slugify(rawQ);
      if (rawQ && !q) return send(res, 200, { worlds: [] });
      let list = db.order.map(id => db.worlds[id]);
      if (q) list = list.filter(w => w.id.includes(q) || slugify(w.discoverer).includes(q));
      if (sort === 'top') list = [...list].sort((a, b) => b.stars - a.stars || b.views - a.views);
      else if (sort === 'viewed') list = [...list].sort((a, b) => b.views - a.views);
      else list = list.slice().reverse();
      return send(res, 200, { worlds: list.slice(0, limit).map(w => publicWorld(w)) });
    }

    // Compact map of every world for the galaxy: [id, name, hue, typeIndex, stars]
    if (p === '/api/map') {
      const rows = db.order.map(id => { const w = db.worlds[id]; return [w.id, w.name, Math.round(w.hue * 1000) / 1000, TYPES.indexOf(w.dna.type), w.stars]; });
      return send(res, 200, { worlds: rows }, { 'Cache-Control': 'public, max-age=5' });
    }

    let m;
    if ((m = p.match(/^\/api\/world\/([a-z0-9-]{1,32})$/))) {
      const id = m[1];
      const w = db.worlds[id];

      if (req.method === 'GET') {
        if (!w) return send(res, 200, { world: null });
        const h = ipHash(ip);
        let seen = viewSeen.get(id); if (!seen) viewSeen.set(id, seen = new Set());
        if (!seen.has(h)) { seen.add(h); w.views++; dirty = true; }
        return send(res, 200, { world: publicWorld(w, true) });
      }

      if (req.method === 'PUT') {
        if (!w) return send(res, 404, { error: 'unclaimed' });
        if (limited(ip, 'edit', 60, 3600000)) return send(res, 429, { error: 'Slow down, star-shaper. Try again later.' });
        const body = await readBody(req);
        const tokenHash = crypto.createHash('sha256').update(String(body.token || '')).digest();
        if (!crypto.timingSafeEqual(tokenHash, Buffer.from(w.tokenHash, 'hex'))) return send(res, 403, { error: 'Only the discoverer can reshape this world.' });
        const dna = sanitizeDna(body.dna, w.name);
        if (!dna) return send(res, 400, { error: 'bad dna' });
        const epitaph = sanitizeText(body.epitaph ?? w.epitaph, 140);
        if (!clean(epitaph)) return send(res, 400, { error: 'Let’s keep the cosmos friendly.' });
        Object.assign(w, { dna, epitaph, hue: worldColorHue(dna), updatedAt: Date.now() });
        dirty = true;
        broadcast('update', publicWorld(w));
        return send(res, 200, { world: publicWorld(w, true) });
      }
    }

    if (p === '/api/world' && req.method === 'POST') {
      if (limited(ip, 'claim', 12, 3600000)) return send(res, 429, { error: 'You’ve claimed a lot of worlds this hour. Give the cosmos a moment.' });
      // galaxy-wide safety valve against a distributed flood
      if (limited('*', 'claim', 3000, 3600000)) return send(res, 503, { error: 'The galaxy is very busy right now. Try again shortly.' });
      const body = await readBody(req);
      const name = sanitizeText(body.name, 24).replace(/\s+/g, ' ');
      const id = slugify(name);
      if (id.length < 2) return send(res, 400, { error: 'Names need at least two letters or numbers.' });
      if (!NAME_OK.test(name)) return send(res, 400, { error: 'Names can use letters, numbers, spaces and simple punctuation.' });
      const discoverer = sanitizeText(body.discoverer, 24) || 'Anonymous';
      const epitaph = sanitizeText(body.epitaph, 140);
      if (!clean(name)) return send(res, 400, { error: 'That name isn’t available in the cosmos.' });
      if (!clean(discoverer) || !clean(epitaph)) return send(res, 400, { error: 'Let’s keep the cosmos friendly.' });
      if (db.worlds[id]) return send(res, 409, { error: 'Someone already claimed this world.', world: publicWorld(db.worlds[id], true) });
      if (db.order.length >= MAX_WORLDS) return send(res, 503, { error: 'The galaxy is full.' });
      const dna = sanitizeDna(body.dna, name);
      if (!dna) return send(res, 400, { error: 'bad dna' });
      const token = crypto.randomBytes(24).toString('base64url');
      const w = {
        id, name, discoverer, epitaph, dna,
        hue: worldColorHue(dna), rarity: rarityOf(dnaFromName(name)).name,
        createdAt: Date.now(), updatedAt: Date.now(), stars: 0, views: 1, starHashes: [],
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      };
      db.worlds[id] = w; db.order.push(id); dirty = true;
      broadcast('world', publicWorld(w));
      return send(res, 201, { world: publicWorld(w, true), token });
    }

    if ((m = p.match(/^\/api\/world\/([a-z0-9-]{1,32})\/star$/)) && req.method === 'POST') {
      const w = db.worlds[m[1]];
      if (!w) return send(res, 404, { error: 'unclaimed' });
      if (limited(ip, 'star', 120, 3600000)) return send(res, 429, { error: 'Too many stars!' });
      const h = ipHash(ip);
      w.starHashes ||= [];
      const i = w.starHashes.indexOf(h);
      let starred;
      if (i === -1) { w.starHashes.push(h); starred = true; } else { w.starHashes.splice(i, 1); starred = false; }
      w.stars = w.starHashes.length; dirty = true;
      broadcast('star', { id: w.id, stars: w.stars });
      return send(res, 200, { stars: w.stars, starred });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'no such endpoint' });

    // ---- static
    if (p.startsWith('/vendor/three/build/') || p.startsWith('/vendor/three/examples/jsm/')) return serveFile(res, p.slice('/vendor/three/'.length), THREE_DIR, 'public, max-age=31536000, immutable');
    if (p.startsWith('/vendor/')) return send(res, 404, 'not found');

    if (p === '/' || p === '/index.html' || p === '/explore') return send(res, 200, indexHtml(null), { 'Content-Type': MIME['.html'] });
    if ((m = p.match(/^\/w\/([a-z0-9-]{1,32})\/?$/))) {
      if (isOffensive(m[1]) || isOffensive(url.searchParams.get('n') || '')) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return send(res, 200, indexHtml(db.worlds[m[1]]), { 'Content-Type': MIME['.html'] });
    }

    return serveFile(res, p, PUBLIC_DIR, 'no-cache');
  } catch (e) {
    if (e instanceof BadRequest) { if (!res.headersSent) send(res, e.status, { error: e.message }); return; }
    console.error('[cosmonym]', e);
    if (!res.headersSent) send(res, 500, { error: 'cosmic interference' });
  }
});

// Slow-client protection: drop connections that dribble headers or bodies.
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 60;

load();
server.listen(PORT, () => console.log(`[cosmonym] listening on :${PORT}`));
