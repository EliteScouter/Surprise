// Social sign-in: Google, Microsoft (OpenID Connect) and Discord (OAuth 2).
// Each provider switches on when its client ID and secret are in the stack env.
// Security: state + PKCE + nonce on every flow, tokens fetched server-to-server
// over verified TLS, and ID-token audience/issuer/expiry/nonce checked.
import crypto from 'node:crypto';
import { request, form } from './egress.js';

const PROVIDERS = {
  google: {
    label: 'Google', env: 'GOOGLE',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile', oidc: true, pkce: true,
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  },
  microsoft: {
    label: 'Microsoft', env: 'MICROSOFT',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile', oidc: true, pkce: true,
    issuerPattern: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/,
  },
  discord: {
    label: 'Discord', env: 'DISCORD',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    scope: 'identify email', oidc: false, pkce: true,
  },
};

const creds = p => ({ id: process.env[`${PROVIDERS[p].env}_CLIENT_ID`], secret: process.env[`${PROVIDERS[p].env}_CLIENT_SECRET`] });
export const enabledProviders = () => Object.keys(PROVIDERS).filter(p => { const c = creds(p); return c.id && c.secret; })
  .map(p => ({ id: p, label: PROVIDERS[p].label }));
export const isProvider = p => Object.hasOwn(PROVIDERS, p) && !!creds(p).id;

const b64url = buf => Buffer.from(buf).toString('base64url');
const redirectUri = (base, p) => `${base}/api/auth/oauth/${p}/callback`;

// Returns the provider URL plus the secrets to keep in a short-lived signed cookie.
export function startFlow(p, base) {
  const prov = PROVIDERS[p], c = creds(p);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const params = {
    client_id: c.id, redirect_uri: redirectUri(base, p), response_type: 'code', scope: prov.scope, state,
    ...(prov.oidc ? { nonce } : {}),
    ...(prov.pkce ? { code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' } : {}),
    ...(p === 'google' ? { prompt: 'select_account' } : {}),
    ...(p === 'microsoft' ? { prompt: 'select_account' } : {}),
  };
  return { url: `${prov.authorize}?${new URLSearchParams(params)}`, flow: { p, state, nonce, verifier } };
}

function decodeJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('bad id token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Exchanges the code and returns { provider, subject, email, emailVerified, name }.
export async function finishFlow(p, base, code, flow) {
  const prov = PROVIDERS[p], c = creds(p);
  const r = await request(prov.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(base, p), client_id: c.id, client_secret: c.secret,
      ...(prov.pkce ? { code_verifier: flow.verifier } : {}),
    }),
  });
  if (r.status !== 200) throw new Error(`token exchange failed (${r.status} ${r.json?.error || ''})`);

  if (prov.oidc) {
    // The ID token came straight from the provider over verified TLS (OIDC Core 3.1.3.7),
    // so its claims are checked rather than its signature.
    const t = decodeJwt(r.json.id_token);
    const now = Date.now() / 1000;
    const issOk = prov.issuers ? prov.issuers.includes(t.iss) : prov.issuerPattern.test(t.iss || '');
    if (!issOk) throw new Error('unexpected issuer');
    if (t.aud !== c.id && !(Array.isArray(t.aud) && t.aud.includes(c.id))) throw new Error('wrong audience');
    if (!t.exp || t.exp < now - 60) throw new Error('expired id token');
    if (t.nonce !== flow.nonce) throw new Error('nonce mismatch');
    if (p === 'google') {
      return { provider: p, subject: String(t.sub), email: t.email || null, emailVerified: t.email_verified === true, name: t.given_name || t.name || '' };
    }
    // Microsoft: email claims are not verified by Microsoft, so they are never trusted
    // to link to an existing account (the "nOAuth" account-takeover pattern).
    return { provider: p, subject: `${t.tid}:${t.sub}`, email: t.email || null, emailVerified: false, name: t.given_name || t.name || '' };
  }

  const me = await request(prov.userinfo, { headers: { Authorization: `Bearer ${r.json.access_token}` } });
  if (me.status !== 200 || !me.json?.id) throw new Error('profile fetch failed');
  return { provider: p, subject: String(me.json.id), email: me.json.email || null, emailVerified: me.json.verified === true, name: me.json.global_name || me.json.username || '' };
}
