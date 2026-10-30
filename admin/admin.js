// Cosmonym control panel. All data is rendered with textContent / escaped HTML;
// nothing user-supplied is ever inserted as markup.
(() => {
  const BASE = document.body.dataset.base;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = t => t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const ago = t => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); };

  async function api(path, opts = {}) {
    const r = await fetch(BASE + '/api' + path, {
      method: opts.body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.signedOut) { showLogin(); throw new Error('signed out'); }
    if (r.status === 401 && data.needSudo) { if (await sudo()) return api(path, opts); throw new Error('cancelled'); }
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------------------------------------------------------------- sign in
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#loginForm').classList.remove('hidden'); $('#totpForm').classList.add('hidden'); }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#loginError').textContent = '';
    try {
      const d = await api('/login', { body: { email: $('#email').value, password: $('#password').value } });
      $('#password').value = '';
      $('#loginForm').classList.add('hidden'); $('#totpForm').classList.remove('hidden');
      const enroll = d.stage === 'enroll';
      $('#enroll').classList.toggle('hidden', !enroll);
      $('#totpTitle').textContent = enroll ? 'Set up two-factor sign-in' : 'Two-factor code';
      if (enroll) { $('#qr').src = d.qr; $('#secret').textContent = d.secret.replace(/(.{4})/g, '$1 ').trim(); }
      $('#code').focus();
    } catch (err) { $('#loginError').textContent = err.message; }
  });
  $('#totpForm').addEventListener('submit', async e => {
    e.preventDefault(); $('#totpError').textContent = '';
    try { await api('/totp', { body: { code: $('#code').value } }); $('#code').value = ''; start(); }
    catch (err) { $('#totpError').textContent = err.message; }
  });

  // re-confirm with 2FA before destructive actions
  function sudo() {
    return new Promise(resolve => {
      const d = $('#sudoDialog'); $('#sudoCode').value = ''; $('#sudoError').textContent = '';
      d.showModal(); $('#sudoCode').focus();
      $('#sudoOk').onclick = async e => {
        e.preventDefault();
        try { const r = await api('/sudo', { body: { code: $('#sudoCode').value } }); d.close(); setSudo(r.sudoUntil); resolve(true); }
        catch (err) { $('#sudoError').textContent = err.message; }
      };
      d.onclose = () => resolve(false);
    });
  }
  function setSudo(until) {
    const p = $('#sudo'); clearInterval(setSudo.t);
    const tick = () => { const left = until - Date.now(); p.classList.toggle('on', left > 0); p.textContent = left > 0 ? `verified · ${Math.ceil(left / 60000)} min` : 'not verified'; };
    tick(); setSudo.t = setInterval(tick, 20000);
  }

  function confirmBox({ title, text, extra, danger = 'Confirm' }) {
    return new Promise(resolve => {
      const d = $('#confirmDialog');
      $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmReason').value = '';
      $('#extraWrap').classList.toggle('hidden', !extra); $('#extraText').textContent = extra || ''; $('#confirmExtra').checked = false;
      $('#confirmOk').textContent = danger;
      d.onclose = () => resolve(d.returnValue === 'ok' ? { reason: $('#confirmReason').value, extra: $('#confirmExtra').checked } : null);
      d.showModal();
    });
  }

  // ---------------------------------------------------------------- tabs
  const loaders = {};
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hidden', s.id !== name));
    loaders[name]?.();
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('#logout').onclick = async () => { await api('/logout', { body: {} }).catch(() => {}); showLogin(); };

  // ---------------------------------------------------------------- overview
  loaders.overview = async () => {
    const s = await api('/stats');
    $('#reportBadge').textContent = s.openReports || '';
    const card = (k, v, d, alert) => `<div class="card stat${alert ? ' alert' : ''}"><div class="k">${k}</div><div class="v">${Number(v).toLocaleString()}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
    $('#cards').innerHTML = card('Worlds', s.worlds, `+${s.worldsToday} today · +${s.worldsWeek} this week`) + card('Explorers', s.users, `+${s.usersToday} today`)
      + card('Stars given', s.stars) + card('Open reports', s.openReports, '', s.openReports > 0) + card('Banned', s.banned);
    const bars = (el, series) => {
      const day = 86400000, today = Math.floor(Date.now() / day);
      const byDay = new Map(series.map(r => [Math.floor(r.day / day), r.n]));
      const vals = Array.from({ length: 14 }, (_, i) => byDay.get(today - 13 + i) || 0);
      const max = Math.max(1, ...vals);
      el.innerHTML = vals.map(v => `<div style="height:${(v / max) * 100}%" title="${v}"><span>${v || ''}</span></div>`).join('');
    };
    bars($('#claimsChart'), s.claimsByDay); bars($('#usersChart'), s.usersByDay);
    const kv = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('') || '<span class="muted">No data yet</span>';
    $('#rarityList').innerHTML = kv(s.rarity); $('#typeList').innerHTML = kv(s.types);

    // growth: the server keeps only per-day totals keyed by UTC date
    const { days } = await api('/metrics');
    const dayKey = i => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const sum = (k, n) => { let t = 0; for (let i = 0; i < n; i++) t += days[dayKey(i)]?.[k] || 0; return t; };
    const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
    const gcard = (k, v, d) => `<div class="card stat"><div class="k">${k}</div><div class="v">${typeof v === 'number' ? v.toLocaleString() : esc(v)}</div>${d ? `<div class="d">${esc(d)}</div>` : ''}</div>`;
    $('#growthCards').innerHTML =
      gcard('Visitors today', sum('visitors', 1), `${sum('visitors', 7).toLocaleString()} this week`)
      + gcard('Worlds grown today', sum('grow', 1), `${sum('grow', 7).toLocaleString()} this week`)
      + gcard('Shares today', sum('share', 1), `${sum('share', 7).toLocaleString()} this week`)
      + gcard('Grown → claimed', pct(sum('claim', 7), sum('grow', 7)), 'last 7 days')
      + gcard('Arrived on a world → grew their own', pct(sum('cta', 7), sum('land:world', 7)), 'last 7 days');
    const series = k => Array.from({ length: 14 }, (_, i) => ({ day: Date.parse(dayKey(13 - i)), n: days[dayKey(13 - i)]?.[k] || 0 }));
    bars($('#visitorsChart'), series('visitors')); bars($('#growsChart'), series('grow'));
    const byPrefix = prefix => {
      const out = {};
      for (let i = 0; i < 14; i++) for (const [k, n] of Object.entries(days[dayKey(i)] || {})) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = (out[k.slice(prefix.length)] || 0) + n;
      return out;
    };
    const sources = byPrefix('ref:');
    for (const [k, n] of Object.entries(byPrefix('src:'))) sources['shared link: ' + k] = n;
    $('#sourceList').innerHTML = kv(sources); $('#shareList').innerHTML = kv(byPrefix('share:'));
  };

  // ---------------------------------------------------------------- reports
  loaders.reports = async () => {
    const { reports } = await api('/reports?status=' + $('#reportStatus').value);
    const el = $('#reportList');
    if (!reports.length) { el.innerHTML = '<div class="empty">Nothing to review. The cosmos is calm.</div>'; return; }
    el.innerHTML = reports.map(r => `
      <div class="card report" data-id="${r.id}" data-world="${esc(r.worldId)}">
        <div>
          <h4>${r.worldName ? `<a href="/w/${esc(r.worldId)}" target="_blank" rel="noopener">${esc(r.worldName)}</a>` : `<span class="muted">${esc(r.worldId)} (already removed)</span>`}</h4>
          <span class="tag bad">${esc(r.reason)}</span><span class="tag">by ${esc(r.reporter)}</span><span class="tag">${ago(r.createdAt)}</span><span class="tag">discoverer: ${esc(r.discoverer || '—')}</span>
          ${r.note ? `<p class="muted">Reporter: “${esc(r.note)}”</p>` : ''}
          ${r.epitaph ? `<blockquote>${esc(r.epitaph)}</blockquote>` : ''}
        </div>
        ${r.status === 'open' ? `<div class="actions">
          <button class="small" data-act="dismiss">Dismiss</button>
          ${r.epitaph ? '<button class="small" data-act="clear">Clear message</button>' : ''}
          ${r.worldName ? '<button class="small danger" data-act="delete">Delete world</button>' : ''}
        </div>` : '<span class="tag">closed</span>'}
      </div>`).join('');
  };
  $('#reportStatus').onchange = () => loaders.reports();
  $('#reportList').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const card = b.closest('.report');
    try {
      if (b.dataset.act === 'dismiss') await api(`/reports/${card.dataset.id}/dismiss`, { body: {} });
      if (b.dataset.act === 'clear') await api(`/worlds/${card.dataset.world}/edit`, { body: { epitaph: '' } });
      if (b.dataset.act === 'delete') await deleteWorld(card.dataset.world);
      toast('Done'); loaders.reports(); loaders.overview();
    } catch (err) { if (err.message !== 'cancelled') toast(err.message); }
  });

  // ---------------------------------------------------------------- worlds
  let worldPage = 0;
  async function loadWorlds(append) {
    worldPage = append ? worldPage + 1 : 0;
    const { worlds } = await api(`/worlds?q=${encodeURIComponent($('#worldQ').value)}&sort=${$('#worldSort').value}&page=${worldPage}`);
    const rows = worlds.map(w => `<tr data-id="${esc(w.id)}" class="${w.openReports ? 'flag' : ''}">
      <td><a href="/w/${esc(w.id)}" target="_blank" rel="noopener">${esc(w.name)}</a><div class="muted small">${esc(w.type)}${w.openReports ? ` · <span style="color:var(--danger)">${w.openReports} report(s)</span>` : ''}</div></td>
      <td>${esc(w.discoverer)}${w.ownerHandle ? '' : '<div class="muted small">no account</div>'}</td>
      <td class="msg">${esc(w.epitaph)}</td><td>${esc(w.rarity)}</td><td>${w.stars}</td><td>${w.views}</td><td title="${when(w.createdAt)}">${ago(w.createdAt)}</td>
      <td><div class="actions">${w.epitaph ? '<button class="small" data-act="clear">Clear msg</button>' : ''}<button class="small danger" data-act="delete">Delete</button></div></td></tr>`).join('');
    if (append) $('#worldRows').insertAdjacentHTML('beforeend', rows); else $('#worldRows').innerHTML = rows || '<tr><td colspan="8" class="empty">No worlds found</td></tr>';
    $('#worldMore').classList.toggle('hidden', worlds.length < 50);
  }
  loaders.worlds = () => loadWorlds(false);
  $('#worldQ').addEventListener('input', () => { clearTimeout(loadWorlds.t); loadWorlds.t = setTimeout(() => loadWorlds(false), 250); });
  $('#worldSort').onchange = () => loadWorlds(false);
  $('#worldMore').onclick = () => loadWorlds(true);
  async function deleteWorld(id) {
    const c = await confirmBox({ title: `Delete “${id}”?`, text: 'The world disappears from the galaxy for everyone and its name becomes free to claim again. This can’t be undone.', danger: 'Delete world' });
    if (!c) throw new Error('cancelled');
    await api(`/worlds/${id}/delete`, { body: { reason: c.reason } });
  }
  $('#worldRows').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    try {
      if (b.dataset.act === 'delete') await deleteWorld(id);
      if (b.dataset.act === 'clear') await api(`/worlds/${id}/edit`, { body: { epitaph: '' } });
      toast('Done'); loadWorlds(false);
    } catch (err) { if (err.message !== 'cancelled') toast(err.message); }
  });

  // ---------------------------------------------------------------- users
  let userPage = 0;
  async function loadUsers(append) {
    userPage = append ? userPage + 1 : 0;
    const { users } = await api(`/users?q=${encodeURIComponent($('#userQ').value)}&page=${userPage}`);
    const rows = users.map(u => `<tr data-id="${u.id}" data-handle="${esc(u.handle)}">
      <td><a href="/u/${esc(u.slug)}" target="_blank" rel="noopener">${esc(u.handle)}</a>${u.role === 'admin' ? ' <span class="tag">admin</span>' : ''}${u.twoFactor ? ' <span class="tag">2FA</span>' : ''}</td>
      <td>${esc(u.email || '—')}${u.email ? (u.emailVerified ? ' <span class="tag">verified</span>' : ' <span class="tag">unverified</span>') : ''}</td>
      <td>${[u.hasPassword ? 'password' : '', ...u.providers].filter(Boolean).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</td>
      <td>${u.worlds}</td><td title="${when(u.createdAt)}">${ago(u.createdAt)}</td><td>${ago(u.lastLoginAt)}</td>
      <td>${u.banned ? `<span class="tag bad">banned</span><div class="muted small">${esc(u.banReason)}</div>` : '<span class="tag">active</span>'}</td>
      <td><div class="actions">${u.role === 'admin' ? '' : u.banned ? '<button class="small" data-act="unban">Unban</button>' : '<button class="small danger" data-act="ban">Ban</button>'}</div></td></tr>`).join('');
    if (append) $('#userRows').insertAdjacentHTML('beforeend', rows); else $('#userRows').innerHTML = rows || '<tr><td colspan="8" class="empty">No explorers found</td></tr>';
    $('#userMore').classList.toggle('hidden', users.length < 50);
  }
  loaders.users = () => loadUsers(false);
  $('#userQ').addEventListener('input', () => { clearTimeout(loadUsers.t); loadUsers.t = setTimeout(() => loadUsers(false), 250); });
  $('#userMore').onclick = () => loadUsers(true);
  $('#userRows').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const tr = b.closest('tr');
    try {
      if (b.dataset.act === 'ban') {
        const c = await confirmBox({ title: `Ban ${tr.dataset.handle}?`, text: 'They’re signed out everywhere and can’t sign in, claim or star.', extra: 'Also delete all of their worlds', danger: 'Ban' });
        if (!c) return;
        const r = await api(`/users/${tr.dataset.id}/ban`, { body: { reason: c.reason, deleteWorlds: c.extra } });
        toast(r.removed ? `Banned, ${r.removed} worlds removed` : 'Banned');
      } else { await api(`/users/${tr.dataset.id}/unban`, { body: {} }); toast('Unbanned'); }
      loadUsers(false);
    } catch (err) { if (err.message !== 'cancelled') toast(err.message); }
  });

  // ---------------------------------------------------------------- audit
  loaders.audit = async () => {
    const { audit } = await api('/audit');
    $('#auditRows').innerHTML = audit.map(a => `<tr><td title="${when(a.at)}">${ago(a.at)}</td><td>${esc(a.admin)}</td><td><span class="tag${/failed|banned|deleted/.test(a.action) ? ' bad' : ''}">${esc(a.action)}</span></td><td>${esc(a.target)}</td><td class="msg">${esc(a.detail)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Nothing yet</td></tr>';
  };

  // ---------------------------------------------------------------- boot
  async function start() {
    try {
      const me = await api('/me');
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#who').textContent = me.handle; setSudo(me.sudoUntil);
      showTab('overview');
      api('/stats').then(s => { $('#reportBadge').textContent = s.openReports || ''; }).catch(() => {});
    } catch { showLogin(); }
  }
  start();
})();
