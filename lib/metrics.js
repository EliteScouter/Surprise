// Anonymous usage counts. Only per-day totals are ever stored (for example
// "grow 2026-10-29 = 412"): no IPs, no cookies, nothing per person. Unique
// visitors are counted with an in-memory set of today's IP hashes that is
// dropped at midnight UTC and never written anywhere.
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_KEYS_PER_DAY = 500;          // so junk referrers can't bloat the table
const MAX_VISITORS_TRACKED = 200_000;

export const CLIENT_EVENTS = new Set(['visit', 'grow', 'view', 'share-open', 'share', 'nudge-share', 'cta']);
export const SHARE_VIA = new Set(['x', 'facebook', 'reddit', 'whatsapp', 'telegram', 'bluesky', 'threads', 'linkedin', 'email', 'copy', 'native', 'download']);

const today = () => new Date().toISOString().slice(0, 10);

export function createMetrics({ store, dataDir }) {
  let buffer = new Map();               // "day|key" -> n, not yet written
  const keysToday = { day: today(), keys: new Set() };
  const visitors = { day: today(), seen: new Set() };
  const file = path.join(dataDir, 'metrics.json');
  let fileData = null;                  // file mode only: { day: { key: n } }

  function count(key, n = 1) {
    const day = today();
    if (keysToday.day !== day) { keysToday.day = day; keysToday.keys.clear(); }
    if (!keysToday.keys.has(key)) {
      if (keysToday.keys.size >= MAX_KEYS_PER_DAY) key = key.split(':')[0] + ':other';
      keysToday.keys.add(key);
    }
    const b = day + '|' + key;
    buffer.set(b, (buffer.get(b) || 0) + n);
  }

  function visitor(ipHash) {
    const day = today();
    if (visitors.day !== day) { visitors.day = day; visitors.seen.clear(); }
    if (visitors.seen.has(ipHash) || visitors.seen.size >= MAX_VISITORS_TRACKED) return;
    visitors.seen.add(ipHash);
    count('visitors');
  }

  async function loadFile() {
    if (fileData) return fileData;
    try { fileData = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { fileData = {}; }
    return fileData;
  }

  async function flush() {
    if (!buffer.size) return;
    const batch = buffer; buffer = new Map();
    try {
      if (store.kind === 'mariadb') {
        if (!store.ready) throw new Error('database unavailable');
        const rows = [...batch].map(([b, n]) => { const [day, k] = b.split('|'); return [day, k, n]; });
        await store.pool.query('INSERT INTO metrics (day, k, n) VALUES ? ON DUPLICATE KEY UPDATE n = n + VALUES(n)', [rows]);
      } else {
        const data = await loadFile();
        for (const [b, n] of batch) { const [day, k] = b.split('|'); (data[day] ||= {})[k] = (data[day][k] || 0) + n; }
        await fsp.writeFile(file + '.tmp', JSON.stringify(data));
        await fsp.rename(file + '.tmp', file);
      }
    } catch (e) {
      for (const [b, n] of batch) buffer.set(b, (buffer.get(b) || 0) + n);   // try again next time
      console.error('[cosmonym] metrics flush failed:', e.code || e.message);
    }
  }
  setInterval(flush, 30_000).unref();

  // Totals per day for the last `days` days, including anything not yet flushed.
  async function recent(days = 30) {
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const out = {};
    const add = (day, k, n) => { (out[day] ||= {})[k] = (out[day][k] || 0) + Number(n); };
    if (store.kind === 'mariadb') {
      const [rows] = await store.pool.execute('SELECT day, k, n FROM metrics WHERE day >= ?', [since]);
      for (const r of rows) add(String(r.day).slice(0, 10), r.k, r.n);
    } else {
      const data = await loadFile();
      for (const [day, ks] of Object.entries(data)) if (day >= since) for (const [k, n] of Object.entries(ks)) add(day, k, n);
    }
    for (const [b, n] of buffer) { const [day, k] = b.split('|'); if (day >= since) add(day, k, n); }
    return out;
  }

  return { count, visitor, flush, recent };
}

// "www.reddit.com" -> "reddit.com"; anything that isn't a plain hostname -> null
export function cleanHost(h) {
  h = String(h || '').toLowerCase().trim().replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && h.length <= 60 ? h : null;
}
