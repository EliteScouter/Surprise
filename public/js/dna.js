// The genome of a world. Every name deterministically hashes to one DNA,
// which drives the shaders, the dossier, the lore, and the rarity tier.

export const TYPES = ['terran', 'ocean', 'desert', 'ice', 'lava', 'gas', 'barren', 'toxic'];

export const TYPE_INFO = {
  terran: { label: 'Garden World', short: 'Terran', glyph: '🜃' },
  ocean: { label: 'Ocean World', short: 'Oceanic', glyph: '🜄' },
  desert: { label: 'Desert World', short: 'Arid', glyph: '☉' },
  ice: { label: 'Frozen World', short: 'Glacial', glyph: '❄' },
  lava: { label: 'Molten World', short: 'Volcanic', glyph: '🜂' },
  gas: { label: 'Gas Giant', short: 'Jovian', glyph: '♃' },
  barren: { label: 'Barren Rock', short: 'Lithic', glyph: '☾' },
  toxic: { label: 'Xeno World', short: 'Exotic', glyph: '⚘' },
};

// ------------------------------------------------------------------ hashing
export function slugify(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export function rngFrom(str) {
  let [a, b, c, d] = cyrb128(str);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
    weighted: entries => {
      const total = entries.reduce((s, e) => s + e[1], 0);
      let x = next() * total;
      for (const [v, w] of entries) { if ((x -= w) <= 0) return v; }
      return entries[entries.length - 1][0];
    },
  };
  return r;
}

// ------------------------------------------------------------------ palettes
// Each surface palette: deep, shallow, beach, lush, dry, rock, snow
export const PALETTES = {
  terran: [
    ['#06204d', '#1b6aa5', '#d6c595', '#2c6a2a', '#a58b56', '#5d5247', '#f3f6fa'],
    ['#071f40', '#1d7a9e', '#e0cfa0', '#7a5a22', '#b5763a', '#5a4a40', '#f7f3ee'], // autumn flora
    ['#04253e', '#1690a0', '#d8d0a8', '#1f6d5c', '#8fa060', '#4e5459', '#eef6fb'], // teal flora
  ],
  ocean: [
    ['#031338', '#139cb8', '#efe2b5', '#3b8f49', '#93a35f', '#4b4a48', '#ffffff'],
    ['#020c2a', '#2a70d8', '#f2e8c8', '#2d7a5a', '#7a9a6a', '#3e4652', '#f6fbff'],
  ],
  desert: [
    ['#123f5c', '#3b9c9a', '#e2c38a', '#b98a4a', '#d99b5e', '#8a5636', '#f1e6d6'],
    ['#2a1a3a', '#5a7a8a', '#e8b0a0', '#c46a50', '#e08a60', '#7a3a2a', '#f8e0d0'], // rust world
  ],
  ice: [
    ['#0b2742', '#3f8aac', '#c6d8e2', '#93b5c6', '#bfd0da', '#66788a', '#f5fbff'],
    ['#140f3a', '#5a6ac8', '#d8d0f0', '#a8a0d8', '#c8c4e8', '#6a6488', '#fbf8ff'],
  ],
  lava: [
    ['#ff3b00', '#ffae00', '#2a1913', '#1b1310', '#2b1d18', '#3c2b25', '#4b3b35'],
    ['#ff0060', '#ff8a30', '#1a1428', '#130f1c', '#221a30', '#30273e', '#45384f'], // magenta magma
  ],
  barren: [
    ['#3a3a3a', '#4a4a4a', '#7a7a72', '#5e5d5a', '#6e6b64', '#454341', '#a4a29c'],
    ['#3a2c24', '#4a3a30', '#8a705e', '#6a5244', '#7e604c', '#46322a', '#b8a898'],
  ],
  toxic: [
    ['#170838', '#36f7ad', '#4a3a6a', '#8a28aa', '#4c6c2a', '#3a2a4a', '#c9f2e1'],
    ['#2a0a10', '#f0e040', '#5a2a3a', '#d03a6a', '#6a8a2a', '#3a1a2a', '#ffe8f0'],
    ['#06142a', '#ff40c0', '#2a3a5a', '#20c0d0', '#3a5a9a', '#20263a', '#e0f8ff'],
  ],
};
// Gas giant band palettes: c1..c4
export const GAS_PALETTES = [
  ['#d9b98f', '#a8693a', '#f2e3c9', '#7d4426'], // jovian
  ['#5cb2d9', '#2f6fae', '#a6e3f2', '#1f4f8a'], // ice giant
  ['#e6d49c', '#c0a060', '#f8f0d0', '#9a7a40'], // saturnine
  ['#cc6ab3', '#6b3a9b', '#f2c2e3', '#3b1a5b'], // exotic
  ['#e07a50', '#a03a2a', '#f8c8a0', '#601a1a'], // infernal
  ['#8ad0a0', '#3a8a6a', '#d0f0d8', '#1a4a3a'], // verdant
];

// ------------------------------------------------------------------ genome
export function dnaFromName(name, salt = '', forcedType = null) {
  const r = rngFrom(slugify(name) + salt);
  const rolled = r.weighted([
    ['terran', 22], ['ocean', 13], ['desert', 13], ['ice', 11], ['lava', 9], ['gas', 14], ['barren', 8], ['toxic', 10],
  ]);
  const type = forcedType || rolled;
  const d = {
    type,
    seedX: r.range(-500, 500), seedY: r.range(-500, 500), seedZ: r.range(-500, 500),
    seaLevel: 0.5, continentScale: r.range(0.7, 2.2), warp: r.range(0.2, 1.1), mountains: r.range(0.3, 0.9),
    roughness: r.range(0.3, 0.8), craters: 0, temperature: 0, humidity: r.range(0.35, 0.7),
    clouds: r.range(0.3, 0.7), atmosphere: r.range(0.5, 0.9), atmoHue: 0.58,
    civ: 0, rings: 0, ringHue: r.next(), moons: r.weighted([[0, 3], [1, 4], [2, 2], [3, 1], [4, 0.5]]),
    tilt: r.range(0, 0.45), spin: r.range(0.3, 1.4), hueShift: 0, bands: r.range(8, 22), storm: r.range(0, 1),
    radius: r.next(), aurora: 0, binary: 0, megastructure: 0, variant: 0,
  };
  const nPal = (PALETTES[type] || GAS_PALETTES).length;
  d.variant = type === 'gas' ? r.int(0, GAS_PALETTES.length - 1) : r.int(0, nPal - 1);

  switch (type) {
    case 'terran':
      d.seaLevel = r.range(0.45, 0.58); d.temperature = r.range(-0.2, 0.25); d.atmoHue = r.range(0.55, 0.62);
      d.civ = r.chance(0.55) ? r.range(0.15, 1) : 0; d.hueShift = r.range(-0.04, 0.04); break;
    case 'ocean':
      d.seaLevel = r.range(0.6, 0.72); d.temperature = r.range(-0.1, 0.35); d.clouds = r.range(0.45, 0.85);
      d.atmoHue = r.range(0.52, 0.6); d.civ = r.chance(0.35) ? r.range(0.1, 0.8) : 0; d.humidity = r.range(0.6, 0.9); break;
    case 'desert':
      d.seaLevel = r.range(0.12, 0.34); d.temperature = r.range(0.3, 0.75); d.humidity = r.range(0.05, 0.3);
      d.clouds = r.range(0.0, 0.25); d.atmoHue = r.range(0.03, 0.11); d.craters = r.range(0, 0.3);
      d.civ = r.chance(0.25) ? r.range(0.1, 0.7) : 0; break;
    case 'ice':
      d.seaLevel = r.range(0.4, 0.6); d.temperature = r.range(-1, -0.55); d.clouds = r.range(0.2, 0.6);
      d.atmoHue = r.range(0.5, 0.66); d.civ = r.chance(0.15) ? r.range(0.05, 0.4) : 0; break;
    case 'lava':
      d.seaLevel = r.range(0.28, 0.44); d.temperature = 1; d.clouds = r.range(0.1, 0.5); d.atmoHue = r.range(0.0, 0.07);
      d.atmosphere = r.range(0.4, 0.9); d.mountains = r.range(0.5, 1); d.craters = r.range(0, 0.4); break;
    case 'gas':
      d.seaLevel = 0; d.clouds = 0; d.atmosphere = r.range(0.4, 0.8);
      d.atmoHue = [0.08, 0.55, 0.12, 0.82, 0.03, 0.4][d.variant]; d.rings = r.chance(0.55) ? r.range(0.3, 1) : 0;
      d.moons = r.weighted([[1, 2], [2, 3], [3, 3], [4, 2]]); d.temperature = -0.6; break;
    case 'barren':
      d.seaLevel = 0; d.clouds = 0; d.atmosphere = r.range(0, 0.25); d.craters = r.range(0.5, 1);
      d.mountains = r.range(0.1, 0.5); d.atmoHue = r.range(0, 1); d.temperature = r.range(-0.6, 0.4); break;
    case 'toxic':
      d.seaLevel = r.range(0.38, 0.6); d.temperature = r.range(0, 0.5); d.atmoHue = r.pick([0.22, 0.3, 0.8, 0.88]);
      d.clouds = r.range(0.3, 0.7); d.civ = r.chance(0.45) ? r.range(0.2, 1) : 0; break;
  }
  if (type !== 'gas' && r.chance(0.12)) d.rings = r.range(0.2, 0.8);
  if (d.atmosphere > 0.35 && type !== 'barren' && r.chance(0.13)) d.aurora = 1;
  if (r.chance(0.06)) d.binary = 1;
  if (d.civ > 0.72 && r.chance(0.3)) d.megastructure = 1;
  return d;
}

// ------------------------------------------------------------------ derived traits
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

export function worldColorHue(dna) {
  const pal = paletteFor(dna);
  const c = dna.type === 'gas' ? pal[0] : (dna.seaLevel > 0.45 ? pal[1] : pal[3]);
  const [h] = hexToHsl(c);
  return ((h + dna.hueShift) % 1 + 1) % 1;
}

export function paletteFor(dna) {
  if (dna.type === 'gas') return GAS_PALETTES[Math.round(dna.variant) % GAS_PALETTES.length];
  const set = PALETTES[dna.type] || PALETTES.terran;
  return set[Math.round(dna.variant) % set.length];
}

export function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

export const RARITY = [
  { name: 'Common', color: '#9aa7b8', min: 0 },
  { name: 'Uncommon', color: '#5fe0a0', min: 2.2 },
  { name: 'Rare', color: '#4fb4ff', min: 3.6 },
  { name: 'Epic', color: '#b878ff', min: 5.2 },
  { name: 'Legendary', color: '#ffb340', min: 7 },
  { name: 'Mythic', color: '#ff4f8a', min: 9 },
];

export function rarityScore(d) {
  const typeW = { terran: 1, ocean: 1.2, desert: 0.6, ice: 0.7, lava: 1.5, gas: 0.9, barren: 0.3, toxic: 1.8 }[d.type];
  let s = typeW;
  if (d.civ > 0) s += 0.8 + d.civ * 1.6;
  if (d.rings > 0) s += d.type === 'gas' ? 0.6 : 1.8;
  if (d.moons >= 3) s += 0.7;
  if (d.aurora) s += 1.8;
  if (d.binary) s += 2.4;
  if (d.megastructure) s += 3.5;
  if (d.type === 'ocean' && d.seaLevel > 0.69) s += 0.6;
  if (d.type === 'gas' && d.storm > 0.85) s += 0.8;
  return s;
}

export function rarityOf(d) {
  const s = rarityScore(d);
  let tier = RARITY[0];
  for (const t of RARITY) if (s >= t.min) tier = t;
  return { ...tier, score: s };
}

// Empirical rarity percentile from a fixed sample of random names (computed once, deterministic).
let sample = null;
export function rarityPercentile(d) {
  if (!sample) {
    sample = [];
    for (let i = 0; i < 4000; i++) sample.push(rarityScore(dnaFromName('sample-' + i)));
    sample.sort((a, b) => a - b);
  }
  const s = rarityScore(d);
  let lo = 0, hi = sample.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sample[mid] < s) lo = mid + 1; else hi = mid; }
  return lo / sample.length;
}

// ------------------------------------------------------------------ names & lore
const SYL_A = ['va', 'ka', 'tor', 'el', 'ny', 'or', 'su', 'ze', 'qua', 'mi', 'ash', 'ul', 'yr', 'the', 'lo', 'ra', 'vi', 'xo', 'im', 'dra', 'ke', 'sa', 'fe', 'no'];
const SYL_B = ['en', 'ri', 'th', 'ma', 'lun', 'si', 'da', 'ko', 'vel', 'ar', 'ix', 'o', 'ae', 'ul', 'in', 'ys', 'ek', 'an'];
const SYL_C = ['i', 'ri', 'th', 'ans', 'ari', 'oi', 'eth', 'ux', 'ai', 'un', 'esh', 'ii', 'or', 'ae'];

export function speciesName(r) {
  let s = r.pick(SYL_A) + r.pick(SYL_B);
  if (r.chance(0.5)) s += "'";
  s += r.pick(SYL_C);
  return s[0].toUpperCase() + s.slice(1);
}

const STAR_CLASSES = [
  ['a pale yellow G-type', 'G2V'], ['a smouldering red dwarf', 'M4V'], ['a blue-white giant', 'B7III'],
  ['an orange K-type', 'K1V'], ['a dying white dwarf', 'DA3'], ['a young F-type', 'F5V'], ['a variable carbon star', 'C6'],
];

const LORE = {
  terran: [
    'Rivers braid across its continents like silver thread, and storm fronts roll over forests older than memory.',
    'Its seasons are long and gentle; whole migrations of flying herds follow the warmth from pole to pole.',
    'From orbit it looks almost familiar, with blue seas and green coasts, which is exactly what makes it unsettling.',
    'Ancient mountain chains wall off its continents, so every valley evolved its own impossible ecosystem.',
  ],
  ocean: [
    'A single planetary ocean covers almost everything, broken only by archipelagos of drifting coral cities.',
    'Waves here can circle the entire world without touching land, building into swells the height of towers.',
    'Bioluminescent tides turn the night side into a slow, breathing aurora of blue light.',
    'Its seafloor sings: tectonic vents hum at frequencies that carry for thousands of kilometres.',
  ],
  desert: [
    'Dunes the size of mountain ranges crawl across its surface a few metres every year.',
    'What little water it has hides in deep canyon oases, guarded by sand-glass storms that can strip paint from steel.',
    'Its twin moons drag dust tides across the plains, and the sky is the colour of old copper.',
    'Fossilised sea beds hint that oceans once covered it, before its star grew hungry.',
  ],
  ice: [
    'Beneath kilometres of glacier, a dark ocean keeps warm against the planet’s slowly cooling heart.',
    'Ice geysers erupt at the equator, freezing mid-air into glittering arches that ring like bells.',
    'Its snowfields are so pure they reflect starlight bright enough to read by.',
    'Every century a thaw opens the ice shelves, and something vast moves underneath.',
  ],
  lava: [
    'Its crust is a cracked shell floating on a sea of magma; the night side glows like a forge.',
    'Rivers of molten rock carve new continents every few decades, and the rain is made of glass.',
    'Tidal forces from its star knead the planet like dough, keeping it endlessly, violently young.',
    'Volcanoes here are taller than any mountain in the sector, and some vent straight into space.',
  ],
  gas: [
    'Storms larger than whole planets churn in its bands, some of them older than human history.',
    'Deep in its atmosphere, pressure turns hydrogen to metal and rains diamonds into the dark.',
    'Its banded clouds move at different speeds, shearing into vortices that bloom like ink in water.',
    'Floating gas-whales have been reported in its upper layers, though no probe has survived to confirm it.',
  ],
  barren: [
    'Billions of years of impacts have written its history in craters, a stone diary left out in the rain of space.',
    'There is no wind here, so footprints would last longer than the stars that witness them.',
    'Its surface is scarred, silent and beautiful, a museum of every collision in the system’s past.',
    'Ancient lava tubes honeycomb its crust, perfect shelter for anyone daring enough to stay.',
  ],
  toxic: [
    'Its forests are violet and its seas glow with chemistry that would dissolve an unprotected hand.',
    'Life here runs on sulfur instead of sunlight, building towering fungal reefs along the shores.',
    'The air is thick, sweet and deadly; the native flora sing to each other in ultraviolet.',
    'Evolution took a sharp left turn on this world, and never looked back.',
  ],
};

const LIFE = [
  civ => `It is home to the ${civ}, a ${['curious', 'ancient', 'peaceful', 'restless', 'brilliant', 'secretive'][Math.abs(civ.length) % 6]} species whose cities trace glowing filigree across the night side.`,
  civ => `The ${civ} have built a civilisation here; their lights are visible from orbit, mapping every coastline.`,
  civ => `Its dominant species, the ${civ}, communicate through colour and have never known war. Or so they claim.`,
];
const MICRO = [
  'Spectrographs hint at microbial life in its shallows, the first stirring of something bigger.',
  'No intelligent life has been detected, yet its atmosphere shows signs that something is breathing.',
  'Life here is simple and stubborn: lichens, mats, and the occasional thing that moves when nobody is watching.',
];
const DEAD = [
  'No life has been detected. Only the wind remembers anything here.',
  'It is lifeless, for now. Planets are patient.',
  'Sterile and silent, it waits for someone to give it a story.',
];

export function profile(name, dna) {
  const r = rngFrom('lore:' + slugify(name));
  const [starDesc, starCode] = r.pick(STAR_CLASSES);
  const civName = speciesName(r);
  const isGas = dna.type === 'gas';
  const radiusKm = Math.round(isGas ? 38000 + dna.radius * 52000 : 2200 + dna.radius * 10500);
  const density = isGas ? 0.25 + r.next() * 0.3 : dna.type === 'lava' ? 1.2 : dna.type === 'ice' ? 0.7 : 0.95 + r.next() * 0.2;
  const gravity = (radiusKm / 6371) * density;
  const tempC = dna.type === 'lava' ? Math.round(420 + dna.temperature * 600 + r.next() * 200)
    : isGas ? Math.round(-180 + r.next() * 60) : Math.round(dna.temperature * 70 + 14);
  const dayHours = (24 / Math.max(0.05, dna.spin)) * (0.7 + r.next() * 0.6);
  const yearDays = Math.round(80 + r.next() * 900);
  const lyFromCore = Math.round(8000 + r.next() * 40000);
  const water = isGas || dna.type === 'barren' || dna.type === 'lava' ? 0 : dna.seaLevel;
  let habit = 0;
  if (!isGas && dna.type !== 'lava' && dna.type !== 'barren') {
    const t = 1 - Math.min(1, Math.abs(dna.temperature) * 1.3);
    habit = t * 0.5 + Math.min(1, water * 1.6) * 0.3 + dna.atmosphere * 0.2;
    if (dna.type === 'toxic') habit *= 0.55;
  }
  const pop = dna.civ > 0.12 ? dna.civ ** 3 * 24e9 + 2e6 : 0;
  const atmo = {
    terran: 'N₂ 77% · O₂ 21% · Ar 1%', ocean: 'N₂ 71% · O₂ 26% · H₂O 3%', desert: 'CO₂ 62% · N₂ 33% · Ar 5%',
    ice: 'N₂ 88% · CH₄ 8% · Ne 4%', lava: 'SO₂ 54% · CO₂ 40% · H₂S 6%', gas: 'H₂ 86% · He 13% · CH₄ 1%',
    barren: dna.atmosphere > 0.1 ? 'Ar 60% · Ne 30% · trace' : 'Vacuum · trace exosphere', toxic: 'Cl₂ 31% · NH₃ 44% · N₂ 25%',
  }[dna.type];

  const parts = [];
  parts.push(`Orbiting ${starDesc} star ${lyFromCore.toLocaleString()} light-years from the galactic core, ${name} is ${/^[aeiou]/i.test(TYPE_INFO[dna.type].label) ? 'an' : 'a'} ${TYPE_INFO[dna.type].label.toLowerCase()}.`);
  parts.push(r.pick(LORE[dna.type]));
  if (dna.civ > 0.12) parts.push(r.pick(LIFE)(civName));
  else if (habit > 0.35) parts.push(r.pick(MICRO));
  else parts.push(r.pick(DEAD));
  if (dna.megastructure) parts.push(`An artificial ring encircles its equator, a megastructure the ${civName} refuse to explain.`);
  if (dna.binary) parts.push('Two suns rise over its horizon, casting doubled shadows across the land.');
  if (dna.aurora) parts.push('Its poles burn with auroras so bright they can be seen from neighbouring systems.');
  if (dna.rings > 0 && !isGas) parts.push('A ring of shattered ice arcs across its sky, the remains of a moon that came too close.');

  const designation = `${starCode}-${r.int(100, 999)} ${ROMAN[r.int(0, 6)]}`;
  return {
    designation, radiusKm, gravity, tempC, dayHours, yearDays, lyFromCore, atmo,
    habitability: Math.max(0, Math.min(1, habit)), population: pop, species: dna.civ > 0.12 ? civName : null,
    lore: parts.join(' '),
  };
}

export function formatPop(n) {
  if (!n) return 'None detected';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' billion';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' million';
  return Math.round(n).toLocaleString();
}

// Deterministic position in the galaxy disc for any world id: every name already has a home.
export function galaxyPosition(id) {
  const r = rngFrom('pos:' + id);
  const arms = 4;
  const arm = r.int(0, arms - 1);
  const t = Math.pow(r.next(), 0.7);
  const radius = 18 + t * 150;
  const angle = arm * (Math.PI * 2 / arms) + radius * 0.028 + (r.next() - 0.5) * 0.5;
  const spread = 4 + t * 8;
  return [
    Math.cos(angle) * radius + (r.next() - 0.5) * spread,
    (r.next() - 0.5) * (5 - t * 3),
    Math.sin(angle) * radius + (r.next() - 0.5) * spread,
  ];
}

const FIRST = ['Astra', 'Veyra', 'Nyx', 'Calder', 'Orinth', 'Solenne', 'Kepler', 'Thessaly', 'Ondine', 'Zephyra', 'Marrow', 'Halcyon', 'Ixion', 'Lumen', 'Vesper', 'Cinder', 'Aurelia', 'Tidewell', 'Morrow', 'Quillon', 'Elysia', 'Pyre', 'Saffron', 'Brume', 'Ophira', 'Taliesin', 'Wren', 'Corvus', 'Isolde', 'Rhea'];
const SECOND = ['', '', '', ' Prime', ' Minor', ' Major', ' Reach', ' Deep', "'s Rest", ' Verge', ' Hollow', ' Drift', ' IX', ' Nova'];
export function randomName() {
  const f = FIRST[Math.floor(Math.random() * FIRST.length)];
  const s = SECOND[Math.floor(Math.random() * SECOND.length)];
  return Math.random() < 0.25 ? f + '-' + Math.floor(Math.random() * 900 + 100) : f + s;
}
