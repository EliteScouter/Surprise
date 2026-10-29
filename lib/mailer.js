// Email through Microsoft Graph (app-only), sending as a single shared mailbox.
// Configure in the stack env: MAIL_TENANT_ID, MAIL_CLIENT_ID, MAIL_CLIENT_SECRET, MAIL_FROM.
// If unset, emails are skipped (and logged without their links).
import { request, form } from './egress.js';

const cfg = () => ({
  tenant: process.env.MAIL_TENANT_ID, client: process.env.MAIL_CLIENT_ID,
  secret: process.env.MAIL_CLIENT_SECRET, from: process.env.MAIL_FROM || 'noreply@cosmonym.app',
});
export const mailEnabled = () => { const c = cfg(); return !!(c.tenant && c.client && c.secret); };

let cached = { token: null, until: 0 };
async function graphToken() {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const c = cfg();
  const r = await request(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: c.client, client_secret: c.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`graph token failed (${r.status} ${r.json?.error || ''})`);
  cached = { token: r.json.access_token, until: Date.now() + (Number(r.json.expires_in || 3600) - 120) * 1000 };
  return cached.token;
}

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function layout(title, intro, cta, link, outro) {
  return `<!doctype html><html><body style="margin:0;background:#04050b;font-family:Inter,Segoe UI,Arial,sans-serif;color:#eef1ff">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#04050b;padding:40px 16px"><tr><td align="center">
  <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0c0f1e;border:1px solid #1e2440;border-radius:20px;padding:36px">
  <tr><td style="font-size:12px;letter-spacing:6px;color:#8fd3ff;font-weight:600">COSMONYM</td></tr>
  <tr><td style="padding-top:22px;font-size:24px;font-weight:600;color:#ffffff">${esc(title)}</td></tr>
  <tr><td style="padding-top:12px;font-size:15px;line-height:1.6;color:#b8bfd8">${esc(intro)}</td></tr>
  <tr><td style="padding-top:26px"><a href="${esc(link)}" style="display:inline-block;background:#9fd8ff;color:#070a1a;text-decoration:none;font-weight:600;padding:13px 24px;border-radius:999px">${esc(cta)}</a></td></tr>
  <tr><td style="padding-top:26px;font-size:13px;line-height:1.6;color:#7d86a3">${esc(outro)}</td></tr>
  </table></td></tr></table></body></html>`;
}

export async function sendMail(to, subject, html, text) {
  if (!mailEnabled()) { console.log(`[cosmonym] email not configured; skipped "${subject}"`); return false; }
  const c = cfg();
  const token = await graphToken();
  const r = await request(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.from)}/sendMail`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false },
  });
  if (r.status !== 202) throw new Error(`graph sendMail failed (${r.status} ${r.json?.error?.code || ''})`);
  return true;
}

export const mailVerify = (to, handle, link) => sendMail(to, 'Confirm your Cosmonym account',
  layout(`Welcome aboard, ${handle}`, 'Confirm your email address to finish setting up your account.', 'Confirm email', link,
    'This link works once and expires in 24 hours. If you didn’t create an account, you can ignore this email.'),
  `Confirm your Cosmonym account: ${link}`);

export const mailReset = (to, handle, link) => sendMail(to, 'Reset your Cosmonym password',
  layout('Reset your password', `Someone asked to reset the password for ${handle}. If that was you, choose a new one below.`, 'Choose a new password', link,
    'This link works once and expires in 1 hour. If you didn’t ask for this, ignore this email and your password stays the same.'),
  `Reset your Cosmonym password: ${link}`);
