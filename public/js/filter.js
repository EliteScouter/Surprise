// Offensive-name filter shared by the browser and the server.
//
// Text is normalised before matching so the usual evasions collapse back to the
// plain word: accents and look-alike letters from other scripts, number and
// symbol substitutions (n1gg3r, $h!t), spacing and punctuation (n i g g e r,
// n.i.g.g.e.r), and stretched letters (niiiigger).
//
// Two kinds of terms:
//   ANYWHERE  long or unambiguous terms, matched even inside other text. Innocent
//             words that happen to contain one (grape, Scunthorpe, peacock) are
//             listed in ALLOWED and removed before matching.
//   WORDS     short terms that are only offensive on their own, so they are
//             matched as whole words (spice and Spicer stay fine).

const LEET = {
  0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
  '!': 'i', '|': 'i', '¡': 'i', '@': 'a', '$': 's', '+': 't', '€': 'e', '£': 'l', '(': 'c', '¢': 'c',
};

// Letters from other scripts that look identical to Latin ones.
const CONFUSABLE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ѕ: 's', ɡ: 'g', ı: 'i', ł: 'l', ø: 'o', đ: 'd', ß: 'ss',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
};

const ANYWHERE = [
  // racial and ethnic slurs
  'nigg', 'niga', 'nigah', 'nigur', 'niglet', 'negro', 'kneegrow', 'nignog', 'jigaboo', 'jiggaboo',
  'porchmonkey', 'junglebunny', 'spearchucker', 'sandnig', 'wetback', 'raghead', 'towelhead', 'zipperhead',
  'chinaman', 'slanteye', 'gookboy', 'beaner', 'kikes', 'coonass', 'spook', 'darkie', 'darky',
  // homophobic, transphobic, ableist
  'faggot', 'faggit', 'fagot', 'fagg', 'tranny', 'trannie', 'shemale', 'retard', 'mongoloid',
  // hate groups and slogans
  'hitler', 'heilhitler', 'siegheil', 'kkk', 'kukluxklan', 'whitepower', 'whitesupremacy', 'aryannation',
  'neonazi', 'gasthejews', 'killalljews', 'holohoax', 'thirdreich',
  // sexual violence and abuse
  'rape', 'rapist', 'pedo', 'paedo', 'pedophil', 'paedophil', 'molest', 'childporn', 'incest', 'bestiality',
  'zoophil', 'necrophil', 'lolicon', 'shotacon',
  // explicit
  'fuck', 'fuk', 'phuck', 'phuk', 'fvck', 'motherf', 'shit', 'cunt', 'cock', 'pussy', 'whore', 'slut',
  'bitch', 'asshole', 'arsehole', 'dumbass', 'jackass', 'asswipe', 'dickhead', 'porn', 'hentai', 'blowjob',
  'handjob', 'rimjob', 'cumshot', 'jizz', 'dildo', 'buttplug', 'milf', 'orgasm', 'masturbat', 'ejaculat',
  'erection', 'clitoris', 'nutsack', 'ballsack', 'bukkake', 'gangbang', 'creampie', 'deepthroat', 'xxx',
  // self-harm
  'killyourself', 'killurself', 'kysfaggot',
];

const WORDS = [
  'spic', 'spics', 'kike', 'chink', 'chinks', 'gook', 'gooks', 'coon', 'coons', 'paki', 'pakis', 'jap', 'japs',
  'wop', 'wops', 'dago', 'dagos', 'gypo', 'golliwog', 'wog', 'wogs', 'injun',
  'fag', 'fags', 'dyke', 'dykes', 'homo', 'homos', 'nazi', 'nazis',
  'fck', 'fcuk', 'fuq', 'fuc', 'cum', 'cums', 'tits', 'titty', 'titties', 'boob', 'boobs', 'anal', 'anus',
  'penis', 'penises', 'vagina', 'boner', 'twat', 'wank', 'wanker', 'prick', 'pricks', 'dick', 'dicks',
  'kys', 'nig', 'nigs', 'sex', 'sexy', 'nude', 'nudes', 'naked', 'horny', 'cuck', 'hoes', 'thot',
];

// Innocent words containing an ANYWHERE term. Removed before matching.
const ALLOWED = [
  'snigger', 'montenegr', 'negroni', 'retardant', 'grape', 'drape', 'scrape', 'trapeze', 'rapeseed', 'therapist',
  'torpedo', 'pedometer', 'pedology', 'speedo', 'scunthorpe', 'peacock', 'hancock',
  'hitchcock', 'cockpit', 'cocktail', 'cockatoo', 'cockatiel', 'cockroach', 'cockney', 'woodcock', 'shuttlecock',
  'gamecock', 'cockle', 'cocker', 'babcock', 'alcock', 'cockburn', 'cockerel', 'pussycat', 'pussywillow',
  'shitake', 'shiitake', 'shitzu', 'shihtzu', 'spooky', 'spooked', 'spookier', 'spookiest',
  'fuku', 'mishit', 'xxxl', 'niigata', 'parapet', 'yoshit', 'hoshit', 'milford', 'milfoil',
].sort((a, b) => b.length - a.length);

function normalise(text) {
  let out = '';
  // Standalone numbers ("Saffron-166") are numbers, not disguised letters; only
  // digits mixed into a word ("n1gger") are read as letters.
  const cleaned = String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/(^|[^\p{L}\d])\d{2,}(?=[^\p{L}\d]|$)/gu, '$1 ');
  for (const ch of cleaned) {
    out += LEET[ch] ?? CONFUSABLE[ch] ?? ch;
  }
  return out;
}

// "nigger" -> /n+i+g+g+e+r+/ so stretched letters still match.
const stretch = w => new RegExp(w.split('').map(c => c + '+').join(''));
const ANYWHERE_RE = ANYWHERE.map(stretch);
const WORD_SET = new Set(WORDS);
// Spelling variants people use to dodge filters: l/i, q/g, y/i, ph/f, v/u, ck/k.
// Safe words go through the same transform so they still match afterwards.
const VARIANTS = [
  s => s,
  s => s.replace(/l/g, 'i'),
  s => s.replace(/q/g, 'g').replace(/y/g, 'i'),
  s => s.replace(/ph/g, 'f').replace(/v/g, 'u').replace(/ck/g, 'k'),
].map(fn => ({ fn, allowed: ALLOWED.map(w => new RegExp(stretch(fn(w)).source, 'g')) }));

// Joins runs of single letters back together: "n i g g e r" -> "nigger".
function tokens(s) {
  const raw = s.split(/[^a-z]+/).filter(Boolean);
  const out = [];
  let run = '';
  for (const t of raw) {
    if (t.length === 1) { run += t; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

export function isOffensive(text) {
  if (!text) return false;
  if (/1488|14\s*words/i.test(text)) return true;
  const base = normalise(text);
  for (const { fn, allowed } of VARIANTS) {
    const v = fn(base);
    let squashed = v.replace(/[^a-z]/g, '');
    for (const re of allowed) squashed = squashed.replace(re, '');
    if (ANYWHERE_RE.some(re => re.test(squashed))) return true;
    const words = tokens(v);
    // repeated letters collapsed too, so "fagggg" and "spiccc" are caught
    if (words.some(w => WORD_SET.has(w) || WORD_SET.has(w.replace(/(.)\1+/g, '$1')))) return true;
  }
  return false;
}
