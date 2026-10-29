// COSMONYM server: static host, world registry, and a live event stream.
// Zero dependencies beyond Node's standard library; three.js is served from node_modules.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'worlds.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const MAX_WORLDS = 200000;

// ---------------------------------------------------------------- storage
let db = { worlds: {}, order: [] };
let dirty = false;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.worlds = raw.worlds || {};
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

// ---------------------------------------------------------------- helpers
export function slugify(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

const BLOCK = ['nigger', 'nigga', 'faggot', 'retard', 'rape', 'nazi', 'hitler', 'kike', 'chink', 'spic', 'tranny', 'cunt', 'pedo', 'porn', 'cock', 'pussy', 'whore', 'slut', 'fuck', 'shit'];
function clean(str) {
  const flat = String(str).toLowerCase().replace(/[^a-z]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e');
  return !BLOCK.some(w => flat.includes(w));
}
const sanitizeText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

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

function sanitizeDna(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(DNA_SCHEMA)) {
    if (k in input) out[k] = clampNum(input[k], lo, hi, lo);
  }
  out.type = TYPES.includes(input.type) ? input.type : 'terran';
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
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();

const viewSeen = new Map(); // id -> Set(ipHash), reset hourly
setInterval(() => viewSeen.clear(), 3600000).unref();

const ipOf = req => (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
const ipHash = ip => crypto.createHash('sha256').update('ws:' + ip).digest('base64url').slice(0, 16);

// ---------------------------------------------------------------- live stream
const clients = new Set();
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

async function readBody(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveFile(res, file, root, cache) {
  const resolved = path.resolve(root, '.' + path.sep + file);
  if (!resolved.startsWith(path.resolve(root))) return send(res, 403, 'forbidden');
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
function indexHtml(world) {
  if (!indexTemplate || process.env.NODE_ENV !== 'production') indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    // ---- API
    if (p === '/api/health') return send(res, 200, { ok: true, worlds: db.order.length });

    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 4000\n\n`);
      clients.add(res);
      broadcast('online', { online: clients.size });
      req.on('close', () => { clients.delete(res); broadcast('online', { online: clients.size }); });
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
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 40);
      const q = slugify(url.searchParams.get('q') || '');
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
        const tokenHash = crypto.createHash('sha256').update(String(body.token || '')).digest('hex');
        if (tokenHash !== w.tokenHash) return send(res, 403, { error: 'Only the discoverer can reshape this world.' });
        const dna = sanitizeDna(body.dna);
        if (!dna) return send(res, 400, { error: 'bad dna' });
        const epitaph = sanitizeText(body.epitaph ?? w.epitaph, 140);
        if (!clean(epitaph)) return send(res, 400, { error: 'Let’s keep the cosmos friendly.' });
        Object.assign(w, { dna, epitaph, hue: clampNum(body.hue, 0, 1, w.hue), rarity: sanitizeText(body.rarity, 16) || w.rarity, updatedAt: Date.now() });
        dirty = true;
        broadcast('update', publicWorld(w));
        return send(res, 200, { world: publicWorld(w, true) });
      }
    }

    if (p === '/api/world' && req.method === 'POST') {
      if (limited(ip, 'claim', 12, 3600000)) return send(res, 429, { error: 'You’ve claimed a lot of worlds this hour. Give the cosmos a moment.' });
      const body = await readBody(req);
      const name = sanitizeText(body.name, 24).replace(/\s+/g, ' ');
      const id = slugify(name);
      if (id.length < 2) return send(res, 400, { error: 'Names need at least two letters or numbers.' });
      const discoverer = sanitizeText(body.discoverer, 24) || 'Anonymous';
      const epitaph = sanitizeText(body.epitaph, 140);
      if (!clean(name) || !clean(discoverer) || !clean(epitaph)) return send(res, 400, { error: 'Let’s keep the cosmos friendly.' });
      if (db.worlds[id]) return send(res, 409, { error: 'Someone already claimed this world.', world: publicWorld(db.worlds[id], true) });
      if (db.order.length >= MAX_WORLDS) return send(res, 503, { error: 'The galaxy is full.' });
      const dna = sanitizeDna(body.dna);
      if (!dna) return send(res, 400, { error: 'bad dna' });
      const token = crypto.randomBytes(24).toString('base64url');
      const w = {
        id, name, discoverer, epitaph, dna,
        hue: clampNum(body.hue, 0, 1, 0.5), rarity: sanitizeText(body.rarity, 16) || 'Common',
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
    if (p.startsWith('/vendor/three/')) return serveFile(res, p.slice('/vendor/three/'.length), THREE_DIR, 'public, max-age=31536000, immutable');

    if (p === '/' || p === '/index.html' || p === '/explore') return send(res, 200, indexHtml(null), { 'Content-Type': MIME['.html'] });
    if ((m = p.match(/^\/w\/([a-z0-9-]{1,32})\/?$/))) return send(res, 200, indexHtml(db.worlds[m[1]]), { 'Content-Type': MIME['.html'] });

    return serveFile(res, p, PUBLIC_DIR, 'no-cache');
  } catch (e) {
    console.error('[cosmonym]', e);
    if (!res.headersSent) send(res, 500, { error: 'cosmic interference' });
  }
});

load();
server.listen(PORT, () => console.log(`[cosmonym] listening on :${PORT}`));
