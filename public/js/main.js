import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Planet } from './planet.js';
import { Galaxy } from './galaxy.js';
import { Space } from './space.js';
import { Ambience } from './audio.js';
import { isOffensive } from './filter.js';
import {
  dnaFromName, slugify, profile, rarityOf, rarityPercentile, formatPop, worldColorHue, TYPE_INFO, TYPES, RARITY, ANOMALIES,
  PALETTES, GAS_PALETTES, randomName, civStage,
} from './dna.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('worldseed.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('worldseed.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// ------------------------------------------------------------------ renderer
const isMobile = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const quality = isMobile ? 'low' : (navigator.hardwareConcurrency || 4) <= 4 ? 'mid' : 'high';
const canvas = $('#gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  document.body.innerHTML = '<div class="noscript">COSMONYM needs WebGL to grow worlds. Try a newer browser or enable hardware acceleration.</div>';
  throw e;
}
let pixelRatio = Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const galaxy = new Galaxy({ quality });
const galaxyCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000);
galaxyCam.position.set(0, 150, 250);
const galaxyControls = new OrbitControls(galaxyCam, canvas);
galaxyControls.enableDamping = true; galaxyControls.dampingFactor = 0.06;
galaxyControls.minDistance = 12; galaxyControls.maxDistance = 520; galaxyControls.enabled = false;
galaxyControls.maxPolarAngle = Math.PI * 0.92;

const planetScene = new THREE.Scene();
const planet = new Planet(renderer, { quality });
const space = new Space({ quality });
planetScene.add(space.group, planet.group);
const planetCam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 3000);
planetCam.position.set(0, 0.5, 3.6);
const planetControls = new OrbitControls(planetCam, canvas);
planetControls.enableDamping = true; planetControls.dampingFactor = 0.06;
planetControls.minDistance = 1.45; planetControls.maxDistance = 22; planetControls.enablePan = false;
planetControls.autoRotate = true; planetControls.autoRotateSpeed = 0.25; planetControls.enabled = false;
planetControls.rotateSpeed = 0.6; planetControls.zoomSpeed = 0.7;

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(galaxy.scene, galaxyCam);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.0, 0.6, 0.7);
composer.addPass(renderPass);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const audio = new Ambience();

// ------------------------------------------------------------------ state
const S = {
  mode: 'boot',        // home | explore | world
  flight: null,
  world: null,         // { id, name, dna, origin, record, owner, dirty }
  worldsById: new Map(),
  tokens: store.get('tokens', {}),
  starred: new Set(store.get('starred', [])),
  homeAngle: 0,
  capture: null,
  hover: null,
  stats: { worlds: 0, online: 1, today: 0 },
};

function setMode(mode) {
  S.mode = mode;
  $$('.screen').forEach(el => el.classList.toggle('active', el.id === mode));
  const inGalaxy = mode !== 'world';
  renderPass.scene = inGalaxy ? galaxy.scene : planetScene;
  renderPass.camera = inGalaxy ? galaxyCam : planetCam;
  galaxyControls.enabled = mode === 'explore';
  planetControls.enabled = mode === 'world';
  bloom.strength = inGalaxy ? 1.05 : 0.6;
  bloom.threshold = inGalaxy ? 0.55 : 0.9;
  bloom.radius = inGalaxy ? 0.7 : 0.55;
  $('#navExplore').style.visibility = mode === 'explore' ? 'hidden' : 'visible';
  $('#navLeaders').style.visibility = mode === 'leaders' ? 'hidden' : 'visible';
  if (mode !== 'explore') { $('#hoverLabel').classList.remove('on'); galaxy.setHover(null); }
  if (inGalaxy) audio.setMood('galaxy');
  updateViewOffset();
}

function flash() {
  const f = $('#flash');
  f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

// ------------------------------------------------------------------ api
const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status, body: await r.json().catch(() => ({})) }); return r.json(); },
  async send(method, url, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'http ' + r.status), { status: r.status, body: data });
    return data;
  },
};

// ------------------------------------------------------------------ routing
function navigate(path, replace = false) {
  if (location.pathname + location.search === path) return route();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}
window.addEventListener('popstate', () => route());
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});

async function route() {
  const p = location.pathname;
  const m = p.match(/^\/w\/([a-z0-9-]{1,32})/);
  if (m) {
    const name = new URLSearchParams(location.search).get('n');
    if (isOffensive(m[1]) || isOffensive(name || '')) {
      toast('That name isn’t available in the cosmos.');
      return navigate('/', true);
    }
    return openWorld(m[1], name, { fly: S.mode === 'home' || S.mode === 'explore' });
  }
  const u = p.match(/^\/u\/([a-z0-9-]{1,32})/);
  if (u) return showProfile(u[1]);
  if (p === '/leaderboards') return showLeaders();
  const target = p === '/explore' ? 'explore' : 'home';
  if (S.mode === 'world') await returnToGalaxy(target);
  else if (S.mode !== target) enterGalaxyMode(target);
  const t = new URLSearchParams(location.search).get('t');
  if (p === '/account') { if (S.me) openAccount(); else openAuth('signin', 'Sign in to manage your account.'); }
  if (p === '/auth/verify') { history.replaceState({}, '', '/'); verifyEmail(t); }
  if (p === '/auth/reset') { history.replaceState({}, '', '/'); S.resetToken = t; openAuth('reset'); }
}

// ------------------------------------------------------------------ galaxy modes
function enterGalaxyMode(target) {
  const prev = S.mode;
  setMode(target);
  if (target === 'explore') {
    loadList();
    if (prev === 'home' || prev === 'boot') flyGalaxy(new THREE.Vector3(0, 120, 190), new THREE.Vector3(0, 0, 0), 2.2);
  } else {
    galaxy.showReticle(slugify($('#seedInput').value));
    $('#seedInput').focus({ preventScroll: true });
  }
}

function flyGalaxy(toPos, toTarget, dur, onDone) {
  S.flight = { cam: galaxyCam, from: galaxyCam.position.clone(), to: toPos.clone(), fromT: galaxyControls.target.clone(), toT: toTarget.clone(), t: 0, dur, onDone };
}

function homeCameraPos(angle, out = new THREE.Vector3()) {
  const r = 255;
  return out.set(Math.sin(angle) * r * 0.85, 118, Math.cos(angle) * r);
}

async function returnToGalaxy(target) {
  const id = S.world?.id;
  flash();
  audio.whoosh();
  await sleep(380);
  setMode(target);
  hideForge();
  const p = id ? galaxy.positionOf(id) : new THREE.Vector3();
  galaxyCam.position.copy(p).add(new THREE.Vector3(4, 3, 8));
  galaxyControls.target.copy(p);
  galaxyCam.lookAt(p);
  if (target === 'explore') { loadList(); flyGalaxy(new THREE.Vector3(p.x * 0.6, 70, p.z * 0.6 + 120), new THREE.Vector3(p.x * 0.3, 0, p.z * 0.3), 2.6); }
  else flyGalaxy(homeCameraPos(S.homeAngle), new THREE.Vector3(), 2.8);
  galaxy.setSelected(id);
}

// ------------------------------------------------------------------ world
async function resolveWorld(id, nameHint) {
  let record = null;
  try { record = (await api.get('/api/world/' + id)).world; } catch (e) { if (e.status !== 404) console.warn(e); }
  if (record) S.worldsById.set(id, record);
  const name = record?.name || nameHint || id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const origin = dnaFromName(name);
  const dna = record ? { ...origin, ...record.dna } : origin;
  return { id, name, dna, origin, record, owner: ownsRecord(record), dirty: false };
}

async function openWorld(id, nameHint, { fly = false } = {}) {
  const worldPromise = resolveWorld(id, nameHint);
  if (fly && S.mode !== 'world') {
    // swoop into the galaxy toward this name's star
    galaxyControls.enabled = false;
    $$('.screen').forEach(el => el.classList.remove('active'));
    $('#hoverLabel').classList.remove('on');
    galaxy.showReticle(id);
    const p = galaxy.positionOf(id);
    const dir = p.clone().sub(galaxyCam.position).normalize();
    audio.whoosh();
    await new Promise(res => flyGalaxy(p.clone().sub(dir.multiplyScalar(6)).add(new THREE.Vector3(0, 1.5, 0)), p, 2.1, res));
    flash();
    await sleep(380);
  } else if (S.mode === 'world') {
    flash();
    await sleep(380);
  }
  const w = await worldPromise;
  S.world = w;
  galaxy.showReticle(null);
  setMode('world');
  hideForge();
  applyWorld(true);
  planetCam.position.set(0, 1.2, 11);
  planetControls.target.set(0, 0, 0);
  S.flight = { cam: planetCam, controls: planetControls, from: planetCam.position.clone(), to: new THREE.Vector3(0.7, 0.55, w.dna.rings > 0.01 ? 6.4 : 4.6).multiplyScalar(Math.max(1, 0.8 / planetCam.aspect)), fromT: new THREE.Vector3(), toT: new THREE.Vector3(), t: 0, dur: 5.5 };
  runFormingCaptions(w.dna);
  if (w.owner && w.record && !w.record.hasCard) setTimeout(() => { if (S.world === w) uploadCard(); }, 7000);
  setTimeout(() => audio.chime('form'), 950);
  document.title = `${w.name} · COSMONYM`;
}

function applyWorld(genesis = false, preview = false) {
  const w = S.world;
  planet.setDNA(w.dna, { genesis, preview });
  space.configure(w.dna, planet.sunDir, planet.sun2Dir, worldColorHue(w.dna));
  if (!preview) audio.setMood(w.dna.type, w.dna.civ);
  renderDossier(genesis);
  renderActions();
}

const CAPTIONS = {
  default: ['Accreting stellar dust', 'Igniting the core', 'Cooling the crust', 'Filling the oceans', 'Breathing the first air'],
  gas: ['Accreting stellar dust', 'Gathering hydrogen', 'Spinning up the storms', 'Painting the bands'],
  barren: ['Accreting stellar dust', 'Igniting the core', 'Cooling the crust', 'Billions of years of impacts'],
  lava: ['Accreting stellar dust', 'Igniting the core', 'Keeping it molten', 'Venting the sky'],
};
async function runFormingCaptions(dna) {
  const el = $('#forming'), txt = $('#formingText');
  const list = CAPTIONS[dna.type] || CAPTIONS.default;
  const token = Symbol();
  runFormingCaptions.token = token;
  el.classList.add('on');
  $('#dossier').style.opacity = '0'; $('#actionbar').style.opacity = '0';
  for (const c of list) {
    if (runFormingCaptions.token !== token) return;
    txt.textContent = c + '…';
    await sleep(1150);
  }
  el.classList.remove('on');
  $('#dossier').style.opacity = ''; $('#actionbar').style.opacity = '';
  typeLore();
}

// ------------------------------------------------------------------ dossier
function renderDossier(retype) {
  const w = S.world, d = w.dna;
  const pr = profile(w.name, d);
  // rarity belongs to the name itself; forging a world can't make it rarer
  const rar = rarityOf(w.origin);
  const pct = rarityPercentile(w.origin);
  const r = $('#dRarity');
  r.style.setProperty('--rc', rar.color);
  r.className = 'rarity ' + rar.name.toLowerCase();
  // a 4,000-name sample can't resolve the top tiers, so those show their odds instead
  const note = rar.name === 'Anomaly' ? 'one in a million' : rar.odds >= 95 ? `about 1 in ${rar.odds.toLocaleString()} worlds` : `rarer than ${(pct * 100).toFixed(0)}% of worlds`;
  r.innerHTML = `✦ ${rar.name} <span class="pct">· ${note}</span>`;
  $('#dName').textContent = w.name;
  const anom = ANOMALIES[w.origin.anomaly || 0];
  $('#dClass').textContent = `${TYPE_INFO[d.type].glyph}  ${anom ? anom.label : TYPE_INFO[d.type].label} · ${pr.designation}`;
  const disc = $('#dDisc');
  if (w.record) {
    const who = w.record.ownerSlug ? `<a href="/u/${esc(w.record.ownerSlug)}" data-link><b>${esc(w.record.discoverer)}</b></a>` : `<b>${esc(w.record.discoverer)}</b>`;
    disc.innerHTML = `<span class="badge">${w.owner ? 'Yours' : 'Claimed'}</span> Discovered by ${who} · ${ago(w.record.createdAt)}`;
  } else {
    disc.innerHTML = `<span class="badge free">Unclaimed</span> No one has discovered this world yet.`;
  }
  $('#dEpitaph').textContent = w.record?.epitaph ? `“${w.record.epitaph}”` : '';
  const isGas = d.type === 'gas';
  const hab = Math.round(pr.habitability * 100);
  $('#dStats').innerHTML = [
    ['Radius', `${pr.radiusKm.toLocaleString()} <small>km</small>`],
    ['Gravity', `${pr.gravity.toFixed(2)} <small>g</small>`],
    ['Surface', `${pr.tempC > 0 ? '+' : ''}${pr.tempC} <small>°C</small>`],
    ['Day', `${pr.dayHours.toFixed(1)} <small>hours</small>`],
    ['Year', `${pr.yearDays} <small>days</small>`],
    ['Moons', `${Math.round(d.moons)}${d.rings > 0.01 ? ' <small>+ rings</small>' : ''}`],
    ['Water', isGas ? '<small>n/a</small>' : `${Math.round((d.type === 'lava' || d.type === 'barren' ? 0 : d.seaLevel) * 100)}<small>%</small>`],
    ['Population', pr.population ? `${formatPop(pr.population)}` : '<small>None detected</small>'],
    ['Atmosphere', `<small>${pr.atmo}</small>`, true],
    ['Habitability', `${hab}<small>%</small><div class="bar"><i style="width:${hab}%; background-position:${-300 + hab * 3}px 0"></i></div>`, true],
  ].map(([k, v, wide]) => `<div class="stat${wide ? ' wide' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')
    + (pr.species ? `<div class="stat wide"><div class="k">Dominant species</div><div class="v">The ${esc(pr.species)}</div></div>` : '')
    + (civStage(d) && d.type !== 'gas' ? `<div class="stat wide"><div class="k">Civilisation</div><div class="v">${esc(civStage(d).label)} <small>· Kardashev ${esc(civStage(d).kardashev)}</small><div class="bar"><i style="width:${Math.round(d.civ * 100)}%; background:linear-gradient(90deg, #ffb36b, #8fd3ff, #c79bff)"></i></div></div></div>` : '');
  S.lore = pr.lore;
  if (!retype) $('#dLore').textContent = pr.lore;
  else $('#dLore').textContent = '';
}

async function typeLore() {
  const el = $('#dLore');
  const text = S.lore || '';
  const token = Symbol(); typeLore.token = token;
  el.innerHTML = '';
  const span = document.createElement('span'); const cur = document.createElement('i'); cur.className = 'cursor';
  el.append(span, cur);
  for (let i = 0; i <= text.length; i += 2) {
    if (typeLore.token !== token) return;
    span.textContent = text.slice(0, i);
    await sleep(14);
  }
  span.textContent = text;
  await sleep(1400);
  cur.remove();
}

function renderActions() {
  const w = S.world;
  const claim = $('#claimBtn');
  claim.className = 'act claim';
  if (!w.record) claim.querySelector('span').textContent = 'Claim this world';
  else if (w.owner) { claim.classList.add('owned'); claim.querySelector('span').textContent = w.dirty ? 'Save changes' : 'You discovered this'; }
  else { claim.classList.add('taken'); claim.querySelector('span').textContent = `Claimed by ${w.record.discoverer}`; }
  const star = $('#starBtn');
  star.classList.toggle('on', S.starred.has(w.id));
  $('#starCount').textContent = w.record ? w.record.stars : '0';
  star.title = w.record ? 'Star this world' : 'Claim this world to collect stars';
}

// ------------------------------------------------------------------ forge
const SLIDERS = {
  terrain: [
    ['seaLevel', 'Ocean level', 0, 1, 0.005], ['continentScale', 'Continent scale', 0.4, 3.5, 0.01], ['warp', 'Coastline chaos', 0, 2, 0.01],
    ['mountains', 'Mountains', 0, 1, 0.01], ['roughness', 'Roughness', 0, 1, 0.01], ['craters', 'Craters', 0, 1, 0.01],
  ],
  gas: [['bands', 'Bands', 2, 30, 0.1], ['storm', 'Great storm', 0, 1, 0.01]],
  climate: [
    ['temperature', 'Temperature', -1, 1, 0.01], ['humidity', 'Humidity', 0, 1, 0.01], ['clouds', 'Cloud cover', 0, 1, 0.01],
    ['atmosphere', 'Atmosphere', 0, 1, 0.01], ['atmoHue', 'Sky hue', 0, 1, 0.005],
  ],
  orbit: [
    ['civ', 'Civilization', 0, 1, 0.01], ['rings', 'Rings', 0, 1, 0.01], ['ringHue', 'Ring hue', 0, 1, 0.005], ['moons', 'Moons', 0, 4, 1],
    ['tilt', 'Axial tilt', 0, 0.8, 0.01], ['spin', 'Spin', 0.05, 3, 0.01], ['variant', 'Palette', 0, 5, 1], ['hueShift', 'Palette shift', -0.5, 0.5, 0.005],
  ],
};
const BAKE_KEYS = new Set(['continentScale', 'warp', 'mountains', 'roughness', 'craters']);

function canEdit() { const w = S.world; return !w.record || w.owner; }

function renderForge() {
  const w = S.world, d = w.dna;
  const body = $('#forgeBody');
  const isGas = d.type === 'gas';
  const nVariants = isGas ? GAS_PALETTES.length : (PALETTES[d.type] || []).length;
  const sl = ([k, label, lo, hi, step]) => {
    const max = k === 'variant' ? nVariants - 1 : hi;
    if (k === 'variant' && max < 1) return '';
    return `<div class="slider"><label for="f-${k}">${label}</label><output id="o-${k}"></output><input type="range" id="f-${k}" data-k="${k}" min="${lo}" max="${max}" step="${step}" value="${d[k]}"></div>`;
  };
  body.innerHTML = `
    <div class="fgroup">Archetype</div>
    <div class="types">${TYPES.map(t => `<button data-type="${t}" class="${t === d.type ? 'active' : ''}"><span>${TYPE_INFO[t].glyph}</span>${TYPE_INFO[t].short}</button>`).join('')}</div>
    ${isGas ? `<div class="fgroup">Bands</div>${SLIDERS.gas.map(sl).join('')}` : `<div class="fgroup">Terrain</div>${SLIDERS.terrain.map(sl).join('')}`}
    <div class="fgroup">Climate</div>${SLIDERS.climate.filter(s => !isGas || !['temperature', 'humidity', 'clouds'].includes(s[0])).map(sl).join('')}
    <div class="fgroup">Life & orbit</div>${SLIDERS.orbit.filter(s => !isGas || s[0] !== 'civ').map(sl).join('')}
    <div class="fgroup">Phenomena</div>
    <div class="toggles">
      <button data-t="aurora" class="${d.aurora ? 'on' : ''}">Aurora</button>
      <button data-t="binary" class="${d.binary ? 'on' : ''}">Binary suns</button>
      ${isGas ? '' : `<button data-t="megastructure" class="${d.megastructure ? 'on' : ''}">Orbital ring</button>`}
    </div>`;
  body.classList.toggle('locked', !canEdit());
  $('#forgeNote').textContent = canEdit()
    ? (w.record ? 'You discovered this world, so you can reshape it. Save when you’re happy.' : 'Reshape this world before you claim it. Its name decides where it begins. You decide where it ends up.')
    : `Discovered by ${w.record.discoverer}. Only they can reshape it. Grow your own world from any name.`;
  $$('#forgeBody input[type=range]').forEach(syncSlider);
}

function syncSlider(inp) {
  const k = inp.dataset.k, v = +inp.value;
  const p = (v - inp.min) / (inp.max - inp.min) * 100;
  inp.style.setProperty('--p', p + '%');
  const o = $('#o-' + k);
  if (o) o.textContent = k === 'temperature' ? `${Math.round(v * 70 + 14)}°C` : k === 'moons' || k === 'variant' ? String(v) : k === 'tilt' ? `${Math.round(v * 57.3)}°` : `${Math.round(p)}%`;
}

function markDirty() { S.world.dirty = true; renderActions(); }

$('#forgeBody').addEventListener('input', e => {
  const inp = e.target.closest('input[type=range]');
  if (!inp || !canEdit()) return;
  S.world.dna[inp.dataset.k] = +inp.value;
  syncSlider(inp);
  applyWorld(false, BAKE_KEYS.has(inp.dataset.k));
  markDirty();
});
$('#forgeBody').addEventListener('change', e => {
  const inp = e.target.closest('input[type=range]');
  if (!inp || !canEdit()) return;
  if (BAKE_KEYS.has(inp.dataset.k)) applyWorld(false, false);
});
$('#forgeBody').addEventListener('click', e => {
  if (!canEdit()) return;
  const tb = e.target.closest('[data-type]');
  if (tb) {
    const w = S.world;
    const fresh = dnaFromName(w.name, ':' + tb.dataset.type, tb.dataset.type);
    w.dna = { ...fresh, seedX: w.dna.seedX, seedY: w.dna.seedY, seedZ: w.dna.seedZ };
    applyWorld(false); renderForge(); markDirty();
    return;
  }
  const tg = e.target.closest('[data-t]');
  if (tg) { const k = tg.dataset.t; S.world.dna[k] = S.world.dna[k] ? 0 : 1; tg.classList.toggle('on'); applyWorld(false); markDirty(); }
});

function openForge() { renderForge(); $('#forge').classList.add('open'); $('#forge').setAttribute('aria-hidden', 'false'); $('#forgeBtn').classList.add('on'); updateViewOffset(); }
function hideForge() { $('#forge').classList.remove('open'); $('#forge').setAttribute('aria-hidden', 'true'); $('#forgeBtn').classList.remove('on'); updateViewOffset(); }
$('#forgeBtn').onclick = () => $('#forge').classList.contains('open') ? hideForge() : openForge();
$('#forgeClose').onclick = hideForge;
$('#mutateBtn').onclick = () => {
  if (!canEdit()) return;
  const w = S.world;
  const m = dnaFromName(w.name, ':' + Math.random(), w.dna.type);
  w.dna = { ...w.dna, seedX: m.seedX, seedY: m.seedY, seedZ: m.seedZ, continentScale: m.continentScale, warp: m.warp, mountains: m.mountains, ringHue: m.ringHue, bands: m.bands, storm: m.storm };
  applyWorld(false); renderForge(); markDirty();
};
$('#resetBtn').onclick = () => {
  if (!canEdit()) return;
  const w = S.world;
  w.dna = w.record ? { ...w.origin, ...w.record.dna } : { ...w.origin };
  w.dirty = false;
  applyWorld(false); renderForge(); renderActions();
};
$('#dossierToggle').onclick = () => { $('#dossier').classList.toggle('collapsed'); updateViewOffset(); };

// ------------------------------------------------------------------ claim / star / share
$('#claimBtn').onclick = async () => {
  const w = S.world;
  if (!w.record) return requireAccount('Sign in to claim this world. It’s free, and it’s how the galaxy knows it’s yours.', openClaim);
  if (w.owner && w.dirty) {
    try {
      const res = await api.send('PUT', '/api/world/' + w.id, { token: S.tokens[w.id], dna: w.dna });
      w.record = res.world; w.dirty = false; renderActions(); renderDossier(false);
      toast('✦ Changes saved to the galaxy');
      setTimeout(uploadCard, 600);
      audio.chime('star');
    } catch (e) { toast(esc(e.message)); }
  }
};

function openClaim() {
  const w = S.world;
  $('#claimName').textContent = w.name;
  $('#claimOrb').className = 'modal-orb orb';
  $('#claimOrb').style.setProperty('--h', Math.round(worldColorHue(w.dna) * 360));
  $('#claimBy').value = store.get('discoverer', '');
  $('#claimError').textContent = '';
  // signed in: the discoverer is the account's name
  $('#claimAs').classList.toggle('hidden', !S.me);
  $('#claimByWrap').classList.toggle('hidden', !!S.me);
  $('#claimBy').required = !S.me;
  if (S.me) $('#claimAs').innerHTML = `Discovered by <b>${esc(S.me.handle)}</b>`;
  $('#claimModal').classList.add('open');
  setTimeout(() => (S.me || $('#claimBy').value ? $('#claimMsg') : $('#claimBy')).focus(), 200);
}
const closeClaim = () => $('#claimModal').classList.remove('open');
$('#claimCancel').onclick = closeClaim;
$('#claimModal').addEventListener('click', e => { if (e.target.id === 'claimModal') closeClaim(); });
$('#claimForm').addEventListener('submit', async e => {
  e.preventDefault();
  const w = S.world;
  const btn = $('#claimSubmit');
  btn.disabled = true;
  try {
    const discoverer = S.me ? S.me.handle : $('#claimBy').value.trim();
    if (isOffensive(discoverer) || isOffensive($('#claimMsg').value)) throw new Error('Let’s keep the cosmos friendly.');
    if (!S.me) store.set('discoverer', discoverer);
    const res = await api.send('POST', '/api/world', {
      name: w.name, discoverer, epitaph: $('#claimMsg').value.trim(), dna: w.dna,
    });
    if (res.token) { S.tokens[res.world.id] = res.token; store.set('tokens', S.tokens); }
    w.record = res.world; w.owner = true; w.dirty = false; w.id = res.world.id;
    S.worldsById.set(w.id, res.world);
    galaxy.addWorld(res.world);
    closeClaim();
    renderDossier(false); renderActions();
    if ($('#forge').classList.contains('open')) renderForge();
    history.replaceState({}, '', '/w/' + w.id);
    audio.chime('claim');
    planet.pulse();
    toast(`✦ <b>${esc(w.name)}</b> is yours. It now shines in the galaxy for everyone.`, 4800);
    setTimeout(uploadCard, 1800);
  } catch (err) {
    if (err.status === 409 && err.body?.world) {
      closeClaim();
      toast('Someone just beat you to it! Showing their world.');
      openWorld(w.id, w.name);
    } else if (err.status === 401 && err.body?.needAuth) {
      closeClaim(); S.me = null; renderAccount();
      requireAccount('Your session ended. Sign in again to claim.', openClaim);
    } else $('#claimError').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#starBtn').onclick = async () => {
  const w = S.world;
  if (!w.record) return toast('Claim this world first, then it can collect stars.');
  if (S.accounts && !S.me) return requireAccount('Sign in to star worlds you love.', () => $('#starBtn').click());
  try {
    const res = await api.send('POST', `/api/world/${w.id}/star`);
    w.record.stars = res.stars;
    if (res.starred) S.starred.add(w.id); else S.starred.delete(w.id);
    store.set('starred', [...S.starred]);
    renderActions();
    if (res.starred) { const b = $('#starBtn'); b.classList.remove('burst'); void b.offsetWidth; b.classList.add('burst'); audio.chime('star'); }
  } catch (e) { toast(esc(e.message)); }
};

function shareUrl() {
  const w = S.world;
  return location.origin + '/w/' + w.id + (w.record ? '' : '?n=' + encodeURIComponent(w.name));
}
const SHARE_TARGETS = [
  ['x', 'X', (u, t) => `https://x.com/intent/post?text=${t}&url=${u}`],
  ['facebook', 'Facebook', u => `https://www.facebook.com/sharer/sharer.php?u=${u}`],
  ['reddit', 'Reddit', (u, t, title) => `https://www.reddit.com/submit?url=${u}&title=${title}`],
  ['whatsapp', 'WhatsApp', (u, t) => `https://wa.me/?text=${t}%20${u}`],
  ['telegram', 'Telegram', (u, t) => `https://t.me/share/url?url=${u}&text=${t}`],
  ['bluesky', 'Bluesky', (u, t) => `https://bsky.app/intent/compose?text=${t}%20${u}`],
  ['threads', 'Threads', (u, t) => `https://www.threads.net/intent/post?text=${t}%20${u}`],
  ['linkedin', 'LinkedIn', u => `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
  ['email', 'Email', (u, t, title) => `mailto:?subject=${title}&body=${t}%0A%0A${u}`],
];
const SHARE_ICON = {
  x: '<path d="M17.5 3h3.1l-6.8 7.8L21.8 21h-6.2l-4.9-6.4L5 21H1.9l7.3-8.3L1.6 3H8l4.4 5.8L17.5 3zm-1.1 16.2h1.7L7.2 4.7H5.4l11 14.5z"/>',
  facebook: '<path d="M14 8.5V6.6c0-.9.6-1.1 1-1.1h2.6V1.6L14 1.6c-3.9 0-4.8 2.9-4.8 4.8v2.1H6.9v4h2.3V22H14v-9.5h3.2l.4-4H14z"/>',
  reddit: '<path d="M22 12.1a2.2 2.2 0 0 0-3.8-1.5 10.8 10.8 0 0 0-5.8-1.8l1-4.6 3.2.7a1.6 1.6 0 1 0 .2-.9l-3.6-.8a.5.5 0 0 0-.6.4l-1.1 5.2a10.8 10.8 0 0 0-5.9 1.8A2.2 2.2 0 1 0 3.2 14a4.3 4.3 0 0 0 0 .7c0 3.5 4 6.3 8.9 6.3s8.9-2.8 8.9-6.3a4.3 4.3 0 0 0 0-.7 2.2 2.2 0 0 0 1-1.9zM7.1 13.6a1.6 1.6 0 1 1 1.6 1.6 1.6 1.6 0 0 1-1.6-1.6zm9 4.2a5.9 5.9 0 0 1-4.1 1.2 5.9 5.9 0 0 1-4.1-1.2.4.4 0 0 1 .6-.6 5.1 5.1 0 0 0 3.5 1 5.1 5.1 0 0 0 3.5-1 .4.4 0 0 1 .6.6zm-.3-2.6a1.6 1.6 0 1 1 1.6-1.6 1.6 1.6 0 0 1-1.6 1.6z"/>',
  whatsapp: '<path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8 8 0 0 1-2.4-1.5 9 9 0 0 1-1.6-2c-.2-.3 0-.5.1-.6l.4-.5.3-.5a.5.5 0 0 0 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.1 1.1 0 0 0-.8.4 3.4 3.4 0 0 0-1.1 2.5 5.9 5.9 0 0 0 1.2 3.1 13.4 13.4 0 0 0 5.2 4.6c1.9.8 2.7.9 3.6.7a3.1 3.1 0 0 0 2-1.4 2.5 2.5 0 0 0 .2-1.4c-.1-.1-.3-.2-.6-.3zM12 21.8a9.8 9.8 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.8 9.8 0 1 1 12 21.8zm8.4-18.2A11.8 11.8 0 0 0 1.8 17.8L.1 24l6.4-1.7a11.8 11.8 0 0 0 5.6 1.4 11.8 11.8 0 0 0 8.3-20.1z"/>',
  telegram: '<path d="M21.9 3.6 18.7 19c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.3 12.6 1.5 11.1c-1-.3-1-1 .2-1.5L20.6 2.3c.9-.3 1.6.2 1.3 1.3z"/>',
  bluesky: '<path d="M5.2 3.3C7.7 5.2 10.4 9 11.4 11c1-2 3.7-5.8 6.2-7.7 1.8-1.4 4.7-2.4 4.7.9 0 .7-.4 5.5-.6 6.3-.8 2.8-3.6 3.5-6.1 3 4.4.8 5.5 3.2 3.1 5.7-4.6 4.7-6.6-1.2-7.1-2.7l-.2-.5-.2.5c-.5 1.5-2.5 7.4-7.1 2.7-2.4-2.5-1.3-4.9 3.1-5.7-2.5.5-5.3-.2-6.1-3C1.1 9.7.7 4.9.7 4.2c0-3.3 2.9-2.3 4.5-.9z"/>',
  threads: '<path d="M17.4 11.1l-.4-.2c-.2-3.7-2.2-5.8-5.6-5.8-2 0-3.7.9-4.7 2.4l1.9 1.3c.7-1.1 1.9-1.4 2.8-1.4 1.1 0 2 .3 2.5.9.4.5.7 1.1.8 1.9a14 14 0 0 0-3.2-.2c-3.2.2-5.2 2-5.1 4.5.1 1.3.7 2.4 1.8 3.1a5.5 5.5 0 0 0 3.3.8 4.9 4.9 0 0 0 3.8-1.8 6.9 6.9 0 0 0 1.3-3.3 4 4 0 0 1 1.7 1.8 4.6 4.6 0 0 1-1.1 5.1c-1.4 1.4-3.1 2-5.6 2-2.8 0-4.9-.9-6.3-2.7-1.3-1.6-1.9-4-2-7 0-3 .7-5.4 2-7C6.9 3.9 9 3 11.8 3s5 .9 6.4 2.7c.7.9 1.2 2 1.6 3.3l2.2-.6c-.5-1.6-1.2-3-2.1-4.1C18 2 15.3.8 11.8.8 8.3.8 5.6 2 3.8 4.3 2.2 6.3 1.4 9.1 1.4 12.5s.8 6.3 2.4 8.3c1.8 2.3 4.5 3.4 8 3.4 3.1 0 5.3-.8 7.1-2.6a6.9 6.9 0 0 0 1.6-7.6 6.1 6.1 0 0 0-3.1-2.9zm-5.1 6.4c-1.3.1-2.6-.5-2.7-1.6-.1-.8.6-1.8 2.8-1.9h.7a10 10 0 0 1 2.1.2c-.2 3-1.6 3.2-2.9 3.3z"/>',
  linkedin: '<path d="M20.4 20.5h-3.6v-5.6c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9v5.7H9.4V9h3.4v1.6c.5-.9 1.6-1.8 3.4-1.8 3.6 0 4.3 2.4 4.3 5.5v6.2zM5.3 7.4a2.1 2.1 0 1 1 2.1-2.1 2.1 2.1 0 0 1-2.1 2.1zm1.8 13.1H3.6V9h3.6v11.5zM22.2 0H1.8A1.8 1.8 0 0 0 0 1.7v20.6A1.8 1.8 0 0 0 1.8 24h20.4a1.8 1.8 0 0 0 1.8-1.7V1.7A1.8 1.8 0 0 0 22.2 0z"/>',
  email: '<path d="M2 5h20v14H2z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m2 6 10 7 10-7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};

function shareText() {
  const w = S.world;
  const rar = rarityOf(w.origin).name;
  return w.record && w.owner
    ? `I discovered ${w.name}, ${/^[AEIOU]/.test(rar) ? 'an' : 'a'} ${rar} ${TYPE_INFO[w.dna.type].label.toLowerCase()} on COSMONYM. What does your name grow into?`
    : `I found ${w.name}, ${/^[AEIOU]/.test(rar) ? 'an' : 'a'} ${rar} ${TYPE_INFO[w.dna.type].label.toLowerCase()} on COSMONYM. What does your name grow into?`;
}

$('#shareBtn').onclick = async () => {
  const w = S.world;
  const url = shareUrl(), text = shareText();
  const eu = encodeURIComponent(url), et = encodeURIComponent(text), etitle = encodeURIComponent(`${w.name} · COSMONYM`);
  $('#shareTargets').innerHTML = SHARE_TARGETS.map(([id, label, fn]) =>
    `<a class="share-btn s-${id}" href="${esc(fn(eu, et, etitle))}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" fill="currentColor">${SHARE_ICON[id]}</svg><span>${label}</span></a>`).join('');
  $('#shareUrl').value = url;
  $('#shareNative').classList.toggle('hidden', !navigator.share);
  $('#sharePreview').classList.add('loading');
  $('#shareModal').classList.add('open');
  const card = await makeCard(1200, 630);
  $('#sharePreview').src = card.toDataURL('image/png');
  $('#sharePreview').classList.remove('loading');
};
$('#shareCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(`${shareText()} ${shareUrl()}`); toast('✦ Link copied. Send it to someone!'); }
  catch { $('#shareUrl').select(); }
};
$('#shareNative').onclick = async () => { try { await navigator.share({ title: S.world.name, text: shareText(), url: shareUrl() }); } catch { /* cancelled */ } };
$('#shareDownload').onclick = () => $('#postcardBtn').click();

// ------------------------------------------------------------------ postcard
function captureFrame() { return new Promise(res => { S.capture = res; }); }
// Renders the current view of the world as a branded card (any size, 16:9-ish).
async function makeCard(W, H) {
  const w = S.world, d = w.dna;
  const shot = await captureFrame();
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = shot; });
  const f = H / 900;                                   // layout was designed at 1600x900
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#04050b'; g.fillRect(0, 0, W, H);
  const s = Math.max(W / img.width, H / img.height);
  const iw = img.width * s, ih = img.height * s;
  g.drawImage(img, (W - iw) / 2 + 160 * f, (H - ih) / 2, iw, ih);
  const grd = g.createLinearGradient(0, 0, W * 0.7, 0);
  grd.addColorStop(0, 'rgba(4,5,11,0.92)'); grd.addColorStop(0.55, 'rgba(4,5,11,0.55)'); grd.addColorStop(1, 'rgba(4,5,11,0)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  await document.fonts.ready;
  const rar = rarityOf(w.origin), pr = profile(w.name, d);
  const px = n => Math.round(n * f);
  g.fillStyle = '#8fd3ff'; g.font = `500 ${px(22)}px Unbounded`; g.letterSpacing = `${px(8)}px`;
  g.fillText('COSMONYM', px(90), px(110));
  g.letterSpacing = '0px';
  g.fillStyle = rar.color; g.font = `500 ${px(22)}px "JetBrains Mono"`;
  g.fillText(`✦ ${rar.name.toUpperCase()} · ${TYPE_INFO[d.type].label.toUpperCase()}`, px(90), px(330));
  g.fillStyle = '#ffffff';
  let size = px(104); g.font = `500 ${size}px Unbounded`;
  while (g.measureText(w.name).width > W * 0.48 && size > px(40)) { size -= 2; g.font = `500 ${size}px Unbounded`; }
  g.fillText(w.name, px(84), px(330) + size + px(10));
  g.fillStyle = '#b8bfd8'; g.font = `400 ${px(26)}px Inter`;
  const by = w.record ? `Discovered by ${w.record.discoverer}` : 'Unclaimed, waiting for a discoverer';
  g.fillText(by, px(90), px(330) + size + px(70));
  g.font = `400 ${px(20)}px "JetBrains Mono"`; g.fillStyle = '#7d86a3';
  const facts = [`${pr.radiusKm.toLocaleString()} km`, `${pr.tempC}°C`, `${Math.round(d.moons)} moon${Math.round(d.moons) === 1 ? '' : 's'}`, pr.species ? `home of the ${pr.species}` : null].filter(Boolean).join('   ·   ');
  g.fillText(facts, px(90), px(330) + size + px(120));
  g.fillStyle = '#eef1ff'; g.font = `400 ${px(22)}px Inter`;
  g.fillText('What does your name grow into?', px(90), H - px(120));
  g.fillStyle = '#8fd3ff'; g.font = `500 ${px(22)}px "JetBrains Mono"`;
  g.fillText(shareUrl().replace(/^https?:\/\//, ''), px(90), H - px(84));
  return c;
}

$('#postcardBtn').onclick = async () => {
  toast('Developing your postcard…', 1500);
  const c = await makeCard(1600, 900);
  const a = document.createElement('a');
  a.download = `${S.world.id}-cosmonym.png`;
  a.href = c.toDataURL('image/png');
  a.click();
};

// The link-preview image for a claimed world, uploaded by its owner's browser.
async function uploadCard() {
  const w = S.world;
  if (!S.me || !w?.record || !w.owner) return;
  try {
    const c = await makeCard(1200, 630);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    const r = await fetch(`/api/world/${w.id}/card`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (r.ok) w.record.hasCard = true;
  } catch { /* previews are a nice-to-have */ }
}

// photo mode
function togglePhoto(force) {
  const on = force ?? !document.body.classList.contains('photo');
  document.body.classList.toggle('photo', on);
  planetControls.autoRotate = !on;
  updateViewOffset();
}
$('#photoBtn').onclick = () => togglePhoto(true);
canvas.addEventListener('dblclick', () => { if (document.body.classList.contains('photo')) togglePhoto(false); });
$('#backBtn').onclick = () => navigate(S.cameFromExplore ? '/explore' : '/');

// ------------------------------------------------------------------ home
const TYPER = ['your name', 'your dog’s name', 'your crush', 'your company', 'your hometown', 'your favourite song', 'your gamer tag', 'a word you love'];
(async function typer() {
  const el = $('#typer');
  for (let i = 0; ; i = (i + 1) % TYPER.length) {
    const word = 'Type ' + TYPER[i] + '…';
    for (let k = 0; k <= word.length; k++) { el.textContent = word.slice(0, k); await sleep(55); }
    await sleep(1700);
    for (let k = word.length; k >= 5; k--) { el.textContent = word.slice(0, k); await sleep(22); }
  }
})();

const seedInput = $('#seedInput');
seedInput.addEventListener('input', () => {
  $('.seed-input').classList.toggle('has-value', !!seedInput.value);
  clearTimeout(seedInput.t);
  seedInput.t = setTimeout(updatePreview, 90);
});
function updatePreview() {
  const name = seedInput.value.trim();
  const id = slugify(name);
  const el = $('#preview');
  if (isOffensive(name)) {
    galaxy.showReticle(null);
    el.innerHTML = '<span class="chip">That name isn’t available in the cosmos</span>';
    return;
  }
  galaxy.showReticle(id.length >= 2 ? id : null);
  if (id.length < 2) { el.innerHTML = ''; return; }
  const claimed = galaxy.index.has(id) ? galaxy.worlds[galaxy.index.get(id)] : null;
  const d = dnaFromName(name);
  const type = claimed ? claimed.type : d.type;
  const rar = rarityOf(d);
  el.innerHTML = claimed
    ? `<span class="chip">${TYPE_INFO[type].glyph} ${TYPE_INFO[type].label}</span><span class="chip claimed">★ Already claimed, visit it</span>`
    : `<span class="chip">${TYPE_INFO[type].glyph} ${TYPE_INFO[type].label}</span><span class="chip r" style="--rc:${rar.color}">✦ ${rar.name}</span><span class="chip">Unclaimed</span>`;
}
$('#seedForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = seedInput.value.trim().replace(/\s+/g, ' ');
  if (slugify(name).length < 2) { seedInput.focus(); toast('Type a name with at least two letters'); return; }
  if (isOffensive(name)) { seedInput.focus(); toast('That name isn’t available in the cosmos. Try another!'); return; }
  audio.ensure();
  S.cameFromExplore = false;
  navigate('/w/' + slugify(name) + '?n=' + encodeURIComponent(name));
});
$('#surpriseBtn').onclick = () => {
  const n = randomName();
  seedInput.value = ''; $('.seed-input').classList.add('has-value');
  let i = 0;
  const step = () => { seedInput.value = n.slice(0, ++i); updatePreview(); if (i < n.length) setTimeout(step, 45); else setTimeout(() => $('#seedForm').requestSubmit(), 450); };
  step();
};

function renderTicker(worlds) {
  const track = $('#tickerTrack');
  if (!worlds.length) {
    track.innerHTML = `<span class="tick">✦ The galaxy is waiting for its first discoverer. It could be you.</span>`;
    return;
  }
  const items = worlds.slice(0, 24).map(w => `<span class="tick" data-id="${esc(w.id)}"><i class="orb" style="--h:${Math.round(w.hue * 360)}"></i><b>${esc(w.name)}</b> discovered by ${esc(w.discoverer)} <time>${ago(w.createdAt)}</time></span>`).join('');
  track.innerHTML = items;
  track.style.animationDuration = Math.max(30, worlds.length * 6) + 's';
}
$('#ticker').addEventListener('click', e => { const t = e.target.closest('[data-id]'); if (t) { S.cameFromExplore = false; navigate('/w/' + t.dataset.id); } });

function renderCounts() {
  const n = S.stats.worlds;
  $('#heroCount').textContent = n ? `${n.toLocaleString()} world${n === 1 ? '' : 's'} discovered${S.stats.today ? ` · ${S.stats.today} today` : ''}` : 'A living galaxy, waiting for you';
  $('#onlineCount').textContent = S.stats.online;
  $('#exploreSub').textContent = n ? `${n.toLocaleString()} worlds. Every light is one someone claimed.` : 'No worlds yet. Be the first light.';
}

// ------------------------------------------------------------------ explore
let listSort = 'new';
async function loadList() {
  const typed = $('#searchInput').value.trim();
  const q = isOffensive(typed) ? '' : typed;
  if (typed && !q) { $('#worldList').innerHTML = '<li class="empty">Nothing found.</li>'; return; }
  try {
    const { worlds } = await api.get(`/api/worlds?sort=${listSort}&limit=80${q ? '&q=' + encodeURIComponent(q) : ''}`);
    const ul = $('#worldList');
    if (!worlds.length) {
      ul.innerHTML = q ? `<li class="empty">Nothing found for “${esc(q)}”.<br/>It’s unclaimed. <a href="/w/${esc(slugify(q))}?n=${encodeURIComponent(q)}" data-link style="color:var(--accent)">grow it now →</a></li>`
        : `<li class="empty">No worlds have been claimed yet. Head home, type a name, and become the first discoverer.</li>`;
      return;
    }
    ul.innerHTML = worlds.map(w => `<li data-id="${esc(w.id)}"><i class="orb" style="--h:${Math.round(w.hue * 360)}"></i><div class="meta"><div class="nm">${esc(w.name)}</div><div class="by">${TYPE_INFO[w.type]?.label || ''} · by ${esc(w.discoverer)}</div></div><span class="st">★ ${w.stars}</span></li>`).join('');
  } catch (e) { console.warn(e); }
}
$$('.tab').forEach(t => t.onclick = () => { $$('.tab').forEach(x => x.classList.toggle('active', x === t)); listSort = t.dataset.sort; loadList(); });
$('#searchInput').addEventListener('input', () => { clearTimeout(loadList.t); loadList.t = setTimeout(loadList, 200); });
$('#worldList').addEventListener('click', e => { const li = e.target.closest('[data-id]'); if (li) { S.cameFromExplore = true; navigate('/w/' + li.dataset.id); } });
$('#worldList').addEventListener('mouseover', e => {
  const li = e.target.closest('[data-id]');
  galaxy.setHover(li ? li.dataset.id : null);
});
$('#randomWorldBtn').onclick = () => {
  if (!galaxy.worlds.length) return toast('No worlds yet. Be the first!');
  const w = galaxy.worlds[Math.floor(Math.random() * galaxy.worlds.length)];
  S.cameFromExplore = true;
  navigate('/w/' + w.id);
};

const ndc = new THREE.Vector2();
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointermove', e => {
  if (S.mode !== 'explore' || S.flight) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const hit = galaxy.pick(ndc, galaxyCam);
  S.hover = hit;
  galaxy.setHover(hit?.id);
  const lab = $('#hoverLabel');
  if (hit) {
    lab.innerHTML = `<b>${esc(hit.name)}</b><span>${TYPE_INFO[hit.type]?.label || ''} · ★ ${hit.stars}</span>`;
    lab.style.left = e.clientX + 'px'; lab.style.top = e.clientY + 'px';
    lab.classList.add('on');
    canvas.style.cursor = 'pointer';
  } else { lab.classList.remove('on'); canvas.style.cursor = ''; }
});
canvas.addEventListener('pointerup', e => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 6) return;
  if (S.mode === 'explore') {
    ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    const hit = galaxy.pick(ndc, galaxyCam);
    if (hit) { S.cameFromExplore = true; navigate('/w/' + hit.id); }
  } else if (S.mode === 'world' && document.body.classList.contains('photo') && isMobile) togglePhoto(false);
});

// ------------------------------------------------------------------ live stream
function connectStream() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('online', e => { S.stats.online = JSON.parse(e.data).online; renderCounts(); });
  es.addEventListener('world', e => {
    const w = JSON.parse(e.data);
    if (galaxy.index.has(w.id)) return;
    galaxy.addWorld(w);
    S.stats.worlds++; S.stats.today++; renderCounts();
    S.recent.unshift(w); renderTicker(S.recent);
    if (S.mode !== 'world' && !(S.world && S.world.id === w.id)) toast(`✦ <b>${esc(w.name)}</b> was just discovered by ${esc(w.discoverer)}`);
    if (S.mode === 'explore') loadList();
  });
  es.addEventListener('star', e => {
    const { id, stars } = JSON.parse(e.data);
    galaxy.setStars(id, stars);
    if (S.world?.id === id && S.world.record) { S.world.record.stars = stars; renderActions(); }
  });
  es.addEventListener('remove', e => {
    const { id } = JSON.parse(e.data);
    galaxy.removeWorld(id);
    S.stats.worlds = Math.max(0, S.stats.worlds - 1); renderCounts();
    S.recent = S.recent.filter(w => w.id !== id); renderTicker(S.recent);
    if (S.mode === 'explore') loadList();
  });
  es.addEventListener('update', e => {
    const w = JSON.parse(e.data);
    const row = galaxy.index.has(w.id) && galaxy.worlds[galaxy.index.get(w.id)];
    if (row) { row.type = w.type; row.hue = w.hue; galaxy.rebuildMarkers(); }
  });
}

// ------------------------------------------------------------------ accounts
const PROVIDER_ICON = {
  google: '<svg viewBox="0 0 24 24"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.3 6.6 2.3 12s4.3 9.8 9.7 9.8c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z"/></svg>',
  microsoft: '<svg viewBox="0 0 24 24"><path fill="#F25022" d="M3 3h8.5v8.5H3z"/><path fill="#7FBA00" d="M12.5 3H21v8.5h-8.5z"/><path fill="#00A4EF" d="M3 12.5h8.5V21H3z"/><path fill="#FFB900" d="M12.5 12.5H21V21h-8.5z"/></svg>',
  discord: '<svg viewBox="0 0 24 24"><path fill="#5865F2" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.6 19.6 0 0 0-4.9 1.5C.6 9.1-.3 13.7.2 18.2a19.8 19.8 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14.1 14.1 0 0 0 12.1 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.7 19.7 0 0 0 6-3c.6-5.2-.9-9.8-3.6-13.8zM8.3 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm7.4 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>',
};

function ownsRecord(record) {
  return !!(record && (S.tokens[record.id] || (S.me && record.ownerSlug && record.ownerSlug === S.me.slug)));
}

async function loadMe() {
  try {
    const r = await api.get('/api/auth/me');
    S.accounts = true; S.me = r.user; S.providers = r.providers || []; S.mail = r.mail;
  } catch { S.accounts = false; S.me = null; S.providers = []; }
  renderAccount();
}

function renderAccount() {
  const b = $('#accountBtn');
  b.classList.toggle('hidden', !S.accounts);
  b.innerHTML = S.me ? `<span class="av">${esc(S.me.handle[0].toUpperCase())}</span> <span class="label">${esc(S.me.handle)}</span>` : 'Sign in';
  $('#menuProfile').setAttribute('href', S.me ? `/u/${S.me.slug}` : '/');
  $('#menuAdmin').classList.toggle('hidden', !S.me?.adminPath);
  if (S.me?.adminPath) $('#menuAdmin').setAttribute('href', S.me.adminPath);
  if (S.world?.record) { S.world.owner = ownsRecord(S.world.record); if (S.mode === 'world') { renderDossier(false); renderActions(); } }
}

$('#accountBtn').onclick = e => {
  e.stopPropagation();
  if (!S.me) return openAuth('signin');
  $('#accountMenu').classList.toggle('open');
};
document.addEventListener('click', e => { if (!e.target.closest('.account-wrap')) $('#accountMenu').classList.remove('open'); });
$('#accountMenu').addEventListener('click', () => $('#accountMenu').classList.remove('open'));
$('#menuSignOut').onclick = async () => {
  await api.send('POST', '/api/auth/logout').catch(() => {});
  S.me = null; renderAccount(); toast('Signed out. See you among the stars.');
};

// Runs `then` right away if signed in, otherwise after signing in.
function requireAccount(reason, then) {
  if (!S.accounts || S.me) return then();
  openAuth('signin', reason, then);
}

const AUTH_COPY = {
  signin: ['Welcome back', 'Sign in'], signup: ['Join the galaxy', 'Create account'],
  forgot: ['Reset your password', 'Email me a link'], reset: ['Choose a new password', 'Save password'],
};
function openAuth(mode, reason = '', then = null) {
  S.afterAuth = then;
  setAuthMode(mode, reason);
  $('#socialBtns').innerHTML = S.providers.map(p =>
    `<a href="/api/auth/oauth/${p.id}/start?return=${encodeURIComponent(location.pathname)}">${PROVIDER_ICON[p.id] || ''} Continue with ${esc(p.label)}</a>`).join('');
  $('#authModal').classList.add('open');
  setTimeout(() => (mode === 'signup' ? $('#authHandle') : mode === 'reset' ? $('#authPassword') : $('#authEmail')).focus(), 200);
}
function setAuthMode(mode, reason) {
  const f = $('#authForm');
  f.dataset.mode = mode;
  $('#authTitle').textContent = AUTH_COPY[mode][0];
  $('#authSubmit').textContent = AUTH_COPY[mode][1];
  if (reason != null) $('#authSub').textContent = reason || (mode === 'forgot' ? 'We’ll email you a link to choose a new password.' : '');
  $('#authError').textContent = '';
  $('#authPassword').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
}
const closeAuth = () => { $('#authModal').classList.remove('open'); $('#authPassword').value = ''; };
$('#authForm').addEventListener('click', e => {
  const a = e.target.closest('[data-auth]');
  if (a) { e.preventDefault(); setAuthMode(a.dataset.auth, a.dataset.auth === 'signup' ? 'One account for every world you discover.' : ''); }
});
const closeModal = m => { m.classList.remove('open'); if (m.id === 'accountModal' && location.pathname === '/account') history.replaceState({}, '', '/'); };
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.closest('.modal'))));
$$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m); }));

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const mode = $('#authForm').dataset.mode;
  const btn = $('#authSubmit'); btn.disabled = true; $('#authError').textContent = '';
  const email = $('#authEmail').value.trim(), password = $('#authPassword').value, handle = $('#authHandle').value.trim();
  try {
    if (mode === 'forgot') {
      const r = await api.send('POST', '/api/auth/forgot', { email });
      $('#authSub').textContent = r.mail ? 'If that email has an account, a reset link is on its way. Check your inbox.' : 'Email isn’t set up yet, so resets aren’t available. Try signing in with Google, Microsoft or Discord.';
      return;
    }
    if (mode === 'signup' && isOffensive(handle)) throw new Error('That name isn’t available.');
    const r = mode === 'reset' ? await api.send('POST', '/api/auth/reset', { token: S.resetToken, password })
      : await api.send('POST', `/api/auth/${mode === 'signup' ? 'signup' : 'login'}`, { email, password, handle });
    await loadMe();
    closeAuth();
    toast(mode === 'signup' ? `✦ Welcome to the galaxy, <b>${esc(S.me.handle)}</b>${S.mail ? '. Check your email to confirm your address.' : ''}` : mode === 'reset' ? 'Password changed. You’re signed in.' : `✦ Welcome back, <b>${esc(S.me.handle)}</b>`, 4200);
    attachLegacyWorlds();
    const next = S.afterAuth; S.afterAuth = null;
    if (next) setTimeout(next, 300);
    void r;
  } catch (err) {
    $('#authError').textContent = err.message;
  } finally { btn.disabled = false; }
});

// Worlds claimed before accounts existed (owned by a token in this browser) join the account.
async function attachLegacyWorlds() {
  const claims = Object.entries(S.tokens).map(([id, token]) => ({ id, token }));
  if (!S.me || !claims.length) return;
  try {
    const { attached } = await api.send('POST', '/api/account/attach', { claims });
    if (attached.length) toast(`✦ ${attached.length} world${attached.length === 1 ? '' : 's'} you discovered earlier ${attached.length === 1 ? 'is' : 'are'} now on your account`, 4500);
  } catch { /* not critical */ }
}

async function verifyEmail(token) {
  try { await api.send('POST', '/api/auth/verify', { token }); toast('✦ Email confirmed. Thanks!'); await loadMe(); }
  catch (e) { toast(esc(e.message)); }
}

function openAccount() {
  const me = S.me;
  $('#acctHandle').value = me.handle;
  $('#verifyNote').classList.toggle('hidden', me.emailVerified || !S.mail);
  $('#curPwWrap').classList.toggle('hidden', !me.hasPassword);
  $('#newPwLabel').textContent = me.hasPassword ? 'New password' : 'Set a password (optional)';
  $('#pwSubmit').textContent = me.hasPassword ? 'Change password' : 'Set password';
  $('#delPassword').classList.toggle('hidden', !me.hasPassword);
  $('#acctProviders').textContent = me.providers?.length ? `Signed in with: ${me.providers.map(p => p[0].toUpperCase() + p.slice(1)).join(', ')}` : '';
  $('#acctError').textContent = '';
  $('#accountModal').classList.add('open');
}
const acctErr = e => { $('#acctError').textContent = e.message; };
$('#handleForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api.send('POST', '/api/account/handle', { handle: $('#acctHandle').value.trim() }); await loadMe(); toast('✦ Name updated across your worlds'); }
  catch (err) { acctErr(err); }
});
$('#passwordForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api.send('POST', '/api/account/password', { current: $('#acctCurrent').value, password: $('#acctNew').value });
    $('#acctCurrent').value = $('#acctNew').value = ''; await loadMe(); openAccount(); toast('Password saved. Other devices were signed out.');
  } catch (err) { acctErr(err); }
});
$('#resendVerify').onclick = async e => {
  e.preventDefault();
  try { await api.send('POST', '/api/auth/resend-verify'); toast('Sent! Check your inbox.'); } catch (err) { acctErr(err); }
};
$('#deleteForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api.send('POST', '/api/account/delete', { confirm: $('#delConfirm').value.trim(), password: $('#delPassword').value });
    $('#accountModal').classList.remove('open'); S.me = null; renderAccount(); toast('Your account was deleted.');
  } catch (err) { acctErr(err); }
});

// ------------------------------------------------------------------ profiles
async function showProfile(slug) {
  if (S.mode === 'world') await returnToGalaxy('profile'); else setMode('profile');
  $('#pName').textContent = '…'; $('#pWorlds').innerHTML = ''; $('#pStats').innerHTML = ''; $('#pMeta').textContent = '';
  try {
    const { user, worlds, stars } = await api.get('/api/users/' + slug);
    document.title = `${user.handle} · COSMONYM`;
    $('#pAvatar').textContent = user.handle[0].toUpperCase();
    $('#pName').textContent = user.handle;
    $('#pMeta').textContent = `Explorer since ${new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
    const order = ['Anomaly', 'Mythic', 'Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
    const best = worlds.map(w => w.rarity).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    $('#pStats').innerHTML = `<div><b>${worlds.length}</b><span>worlds</span></div><div><b>${stars}</b><span>stars</span></div><div><b>${esc(best || '—')}</b><span>rarest</span></div>`;
    const color = r => (RARITY.find(x => x.name === r) || RARITY[0]).color;
    $('#pWorlds').innerHTML = worlds.length ? worlds.map(w => `
      <div class="pcard glass" data-id="${esc(w.id)}">
        <i class="orb" style="--h:${Math.round(w.hue * 360)}"></i>
        <h4>${esc(w.name)}</h4>
        <div class="rar" style="color:${color(w.rarity)}">✦ ${esc(w.rarity)} · ${esc(TYPE_INFO[w.type]?.label || '')}</div>
        <div class="meta"><span>${ago(w.createdAt)}</span><span>★ ${w.stars}</span></div>
      </div>`).join('')
      : `<div class="pempty glass">${S.me?.slug === slug ? 'You haven’t claimed a world yet. Type a name on the home page and make one yours.' : 'No worlds discovered yet.'}</div>`;
  } catch {
    $('#pName').textContent = 'Explorer not found';
    $('#pWorlds').innerHTML = '<div class="pempty glass">No explorer goes by that name.</div>';
  }
}
$('#pWorlds').addEventListener('click', e => { const c = e.target.closest('[data-id]'); if (c) navigate('/w/' + c.dataset.id); });

// ------------------------------------------------------------------ leaderboards
const RANK_ORDER = ['Anomaly', 'Mythic', 'Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
const rarityColor = r => (RARITY.find(x => x.name === r) || RARITY[0]).color;
const by = w => w.ownerSlug ? `<a href="/u/${esc(w.ownerSlug)}" data-link>${esc(w.discoverer)}</a>` : esc(w.discoverer);

function lbWorldRow(w, i, value) {
  return `<li data-world="${esc(w.id)}"><span class="rank">${i + 1}</span><i class="orb" style="--h:${Math.round(w.hue * 360)}"></i>
    <div class="who"><b>${esc(w.name)}</b><span><em style="color:${rarityColor(w.rarity)}">${esc(w.rarity)}</em> · by ${by(w)}</span></div><span class="val">${value}</span></li>`;
}
function lbExplorerRow(e, i, value) {
  return `<li data-user="${esc(e.slug)}"><span class="rank">${i + 1}</span><span class="av">${esc(e.handle[0].toUpperCase())}</span>
    <div class="who"><b>${esc(e.handle)}</b><span>${e.worlds} world${e.worlds === 1 ? '' : 's'} · best: <em style="color:${RARITY[e.best].color}">${RARITY[e.best].name}</em></span></div><span class="val">${value}</span></li>`;
}
const empty = msg => `<li class="lb-empty">${msg}</li>`;

function renderLbLists() {
  const lb = S.lb; if (!lb) return;
  const starsMode = $('[data-group="stars"] .active').dataset.v;
  const list = starsMode === 'week' ? lb.weekStars : lb.topStars;
  $('#lbStars').innerHTML = list.length ? list.map((w, i) => lbWorldRow(w, i, `★ ${starsMode === 'week' ? w.n : w.stars}`)).join('')
    : empty(starsMode === 'week' ? 'No stars given this week yet. Find a world you love and star it.' : 'No stars yet.');
  const ex = $('[data-group="explorers"] .active').dataset.v;
  const people = lb.explorers[ex];
  $('#lbExplorers').innerHTML = people.length ? people.map((e, i) => lbExplorerRow(e, i, ex === 'worlds' ? `${e.worlds}` : ex === 'stars' ? `★ ${e.stars}` : `${e.rare}`)).join('')
    : empty('Nobody here yet.');
}

async function showLeaders() {
  if (S.mode === 'world') await returnToGalaxy('leaders'); else setMode('leaders');
  document.title = 'Leaderboards · COSMONYM';
  try {
    const lb = S.lb = await api.get('/api/leaderboards');
    $('#lbTotal').textContent = lb.total ? `${lb.total.toLocaleString()} world${lb.total === 1 ? '' : 's'} discovered so far` : 'The galaxy is waiting for its first discoverer';
    $('#lbCensus').innerHTML = RANK_ORDER.map(r => {
      const n = lb.census[r] || 0;
      return `<div class="census-chip" style="--rc:${rarityColor(r)}"><b>${n.toLocaleString()}</b><span>${r}</span></div>`;
    }).join('');
    const ever = lb.firsts.ever;
    $('#lbFirstEver').innerHTML = ever ? `<div class="first-hero" data-world="${esc(ever.id)}"><i class="orb" style="--h:${Math.round(ever.hue * 360)}"></i>
        <div><span class="tag-first">First world ever claimed</span><h4>${esc(ever.name)}</h4><p>Discovered by ${by(ever)} · ${new Date(ever.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}</p></div></div>`
      : '<div class="first-hero empty">No world has been claimed yet. The very first spot in history is open.</div>';
    $('#lbFirstRarity').innerHTML = ['Anomaly', 'Mythic', 'Legendary', 'Epic', 'Rare'].map(r => {
      const w = lb.firsts.rarity[r];
      return `<div class="first-card${w ? '' : ' open'}" style="--rc:${rarityColor(r)}" ${w ? `data-world="${esc(w.id)}"` : ''}>
        <span class="tag-first">First ${r}</span>${w ? `<b>${esc(w.name)}</b><span>by ${by(w)}</span>` : '<b>Unclaimed</b><span>Could be yours</span>'}</div>`;
    }).join('');
    $('#lbFirstType').innerHTML = TYPES.map(t => {
      const w = lb.firsts.type[t];
      return `<div class="first-type${w ? '' : ' open'}" ${w ? `data-world="${esc(w.id)}"` : ''} title="First ${TYPE_INFO[t].label}"><span>${TYPE_INFO[t].glyph}</span><b>${w ? esc(w.name) : '—'}</b><em>${TYPE_INFO[t].short}</em></div>`;
    }).join('');
    $('#lbRarest').innerHTML = lb.rarest.length ? lb.rarest.map((w, i) => lbWorldRow(w, i, `★ ${w.stars}`)).join('') : empty('No worlds yet.');
    renderLbLists();
  } catch {
    $('#lbTotal').textContent = 'Leaderboards are taking a breather. Try again shortly.';
  }
}
$$('.mini-tabs').forEach(g => g.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  g.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  renderLbLists();
}));
$('#leaders').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const w = e.target.closest('[data-world]'); if (w) return navigate('/w/' + w.dataset.world);
  const u = e.target.closest('[data-user]'); if (u) return navigate('/u/' + u.dataset.user);
});

// ------------------------------------------------------------------ reports
$('#reportBtn').onclick = () => {
  if (!S.world.record) return toast('Only claimed worlds can be reported.');
  if (!S.accounts) return toast('Reporting isn’t available right now.');
  $('#reportForm').reset();
  $('#reportModal').classList.add('open');
};
$('#reportForm').addEventListener('submit', async e => {
  e.preventDefault();
  const reason = new FormData($('#reportForm')).get('reason');
  try {
    await api.send('POST', `/api/world/${S.world.id}/report`, { reason, note: $('#reportNote').value.trim() });
    $('#reportModal').classList.remove('open');
    toast('Thanks. A moderator will take a look.');
  } catch (err) { toast(esc(err.message)); }
});

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') {
    if ($('#claimModal').classList.contains('open')) return closeClaim();
    if (document.body.classList.contains('photo')) return togglePhoto(false);
    if (S.mode === 'world') return $('#backBtn').click();
    if (S.mode === 'explore') return navigate('/');
  }
  if (S.mode !== 'world') return;
  const k = e.key.toLowerCase();
  if (k === 'h') togglePhoto();
  if (k === 'f') $('#forgeBtn').click();
  if (k === 'm') $('#soundBtn').click();
  if (k === 'r' && $('#forge').classList.contains('open')) $('#mutateBtn').click();
});
$('#soundBtn').onclick = async () => {
  const on = await audio.toggle();
  $('#soundBtn').classList.toggle('on', on);
  if (on && S.mode === 'world') audio.setMood(S.world.dna.type, S.world.dna.civ);
  store.set('sound', on);
};

// ------------------------------------------------------------------ layout
function updateViewOffset() {
  const w = innerWidth, h = innerHeight;
  let shift = 0;
  if (S.mode === 'world' && w > 900 && !document.body.classList.contains('photo')) {
    const left = $('#dossier').classList.contains('collapsed') ? 0 : 396;
    const right = $('#forge').classList.contains('open') ? 354 : 0;
    shift = (left - right) / 2;
  }
  let vshift = 0;
  if (S.mode === 'world' && w <= 900 && !document.body.classList.contains('photo')) vshift = $('#dossier').classList.contains('collapsed') ? 30 : h * 0.2;
  S.viewShift = S.viewShift || { x: 0, y: 0 };
  S.viewShiftTarget = { x: shift, y: vshift };
}
function applyViewOffset(dt) {
  const s = S.viewShift, t = S.viewShiftTarget || { x: 0, y: 0 };
  s.x += (t.x - s.x) * Math.min(1, dt * 5);
  s.y += (t.y - s.y) * Math.min(1, dt * 5);
  if (Math.abs(s.x) < 0.5 && Math.abs(s.y) < 0.5 && !t.x && !t.y) planetCam.clearViewOffset();
  else planetCam.setViewOffset(innerWidth, innerHeight, -s.x, s.y, innerWidth, innerHeight);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  for (const c of [galaxyCam, planetCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
  updateViewOffset();
});

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let fpsAcc = 0, fpsFrames = 0, fpsChecks = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());

  if (S.flight) {
    const f = S.flight;
    f.t += dt / f.dur;
    const k = easeInOut(Math.min(1, f.t));
    f.cam.position.lerpVectors(f.from, f.to, k);
    const ctrl = f.cam === galaxyCam ? galaxyControls : planetControls;
    ctrl.target.lerpVectors(f.fromT, f.toT, k);
    f.cam.lookAt(ctrl.target);
    if (f.t >= 1) { S.flight = null; f.onDone?.(); }
  }

  if (S.mode === 'world') {
    planet.update(dt);
    space.update(dt, planetCam);
    if (!S.flight) planetControls.update(dt);
    applyViewOffset(dt);
  } else {
    galaxy.update(dt);
    if ((S.mode === 'home' || S.mode === 'profile' || S.mode === 'leaders') && !S.flight) {
      S.homeAngle += dt * 0.025;
      homeCameraPos(S.homeAngle, galaxyCam.position);
      galaxyControls.target.set(0, -10, 0);
      galaxyCam.lookAt(galaxyControls.target);
    } else if (S.mode === 'explore' && !S.flight) galaxyControls.update(dt);
  }

  if (innerWidth > 0 && innerHeight > 0) composer.render(dt);

  if (S.capture) { const cb = S.capture; S.capture = null; cb(canvas.toDataURL('image/png')); }

  // adaptive resolution: if we're struggling, drop pixel ratio a notch
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 2.5) {
    const fps = fpsFrames / fpsAcc;
    fpsAcc = 0; fpsFrames = 0;
    if (fps < 38 && pixelRatio > 0.8 && fpsChecks < 6) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio); composer.setPixelRatio(pixelRatio);
      fpsChecks++;
    }
  }
  if (DEBUG_TICK) setTimeout(frame, 33); else requestAnimationFrame(frame);
}
const DEBUG_TICK = new URLSearchParams(location.search).has('tick');

// ------------------------------------------------------------------ boot
async function boot() {
  S.recent = [];
  const tasks = [
    api.get('/api/map').then(r => galaxy.setWorlds(r.worlds)).catch(() => galaxy.setWorlds([])),
    api.get('/api/stats').then(r => { S.stats = r; }).catch(() => {}),
    api.get('/api/worlds?sort=new&limit=30').then(r => { S.recent = r.worlds; }).catch(() => {}),
  ];
  tasks.push(loadMe());
  await Promise.all(tasks);
  const authFlag = new URLSearchParams(location.search).get('auth');
  if (authFlag) {
    const q = new URLSearchParams(location.search); q.delete('auth');
    history.replaceState({}, '', location.pathname + (q.toString() ? '?' + q : ''));
    const msg = { ok: S.me ? `✦ Welcome, <b>${esc(S.me.handle)}</b>` : '', failed: 'Sign-in didn’t work. Please try again.', cancelled: 'Sign-in cancelled.', expired: 'That sign-in took too long. Please try again.', banned: 'This account has been suspended.' }[authFlag];
    if (msg) setTimeout(() => toast(msg, 4200), 900);
    if (authFlag === 'ok') attachLegacyWorlds();
  }
  renderCounts();
  renderTicker(S.recent);
  connectStream();
  // warm the shaders so the first genesis doesn't hitch
  planet.setDNA(dnaFromName('worldseed'));
  renderer.compile(planetScene, planetCam);
  renderer.compile(galaxy.scene, galaxyCam);
  homeCameraPos(0, galaxyCam.position); galaxyCam.lookAt(0, -10, 0);
  requestAnimationFrame(frame);
  await route();
  if (S.mode === 'boot') enterGalaxyMode('home');
  setTimeout(() => document.body.classList.remove('boot'), 250);
  if (store.get('sound', false)) {
    const resume = async () => { const on = await audio.toggle(true); $('#soundBtn').classList.toggle('on', on); removeEventListener('pointerdown', resume); removeEventListener('keydown', resume); };
    addEventListener('pointerdown', resume); addEventListener('keydown', resume);
  }
}
boot();
if (DEBUG_TICK) window.__ws = { planet, planetCam, planetControls, S, applyWorld };
