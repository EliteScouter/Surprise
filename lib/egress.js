// Outbound HTTPS for the sealed app container. Requests go to the gate's egress
// port with the real hostname as SNI; the gate forwards only allow-listed hosts.
// TLS is end to end: the certificate is verified against the real hostname.
import https from 'node:https';

const GATE = process.env.EGRESS_HOST || 'gate';
const PORT = Number(process.env.EGRESS_PORT || 8443);
const DIRECT = process.env.EGRESS_DIRECT === '1';   // local development without a gate

export function request(url, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.reject(new Error('egress is https only'));
  const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: DIRECT ? u.hostname : GATE, port: DIRECT ? 443 : PORT, servername: u.hostname,
      path: u.pathname + u.search, method,
      headers: { Host: u.hostname, 'User-Agent': 'Cosmonym/1.0', Accept: 'application/json', ...headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout,
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 1_000_000) req.destroy(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('egress timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)).toString();
