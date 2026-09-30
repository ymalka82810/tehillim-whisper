// Fetches an app's text (Miqra according to the Masorah, CC-BY-SA) from Sefaria and writes data/<app>.json
// Usage: node scripts/build-data.mjs [tehillim|chumash]
//   tehillim: data/tehillim.json, the 150 chapters of Psalms
//   chumash: data/chumash.json, the 187 chapters of the five books one after another; data/chumash-speech.json, the same
//     with pauses for the recorded voices (see clean); and apps/chumash/torah.js
//     with the books, the parshiyot with their aliyot, and a calendar of the weekly parsha (from hebcal, so the app
//     knows the parsha without a network)
import { writeFile, mkdir } from 'node:fs/promises';
import { HebrewCalendar, HDate, Locale, months, parshiot } from '@hebcal/core';
import { getLeyningForParsha } from '@hebcal/leyning';

const app = process.argv[2] || 'tehillim';
const source = book => `https://www.sefaria.org/api/v3/texts/${book}?version=hebrew|Miqra according to the Masorah`;

// Words stressed before the last syllable (mil'el) keep a U+05AB (ole) on their stressed letter, taken from the te'amim
const STRESS = '\u05ab';
const PLACEHOLDER = '\ue000'; // the source has real ole accents, which are stripped with the other te'amim
const FULL_VOWEL = /[\u05b4-\u05bb\u05c7]/; // hiriq..qubuts, qamats qatan (not sheva or hataf)
const ACCENT = /[\u0591-\u05af]/;
const DEHI = '\u05ad'; // prepositive: always on the first letter, whatever the stress
const TSINNOR = '\u05ae'; // postpositive: always on the last letter

// Index of the stressed letter if the word is mil'el, else -1 (milra, or stress unknown)
function milelIndex(letters, verseEnd) {
  const last = letters.length - 1;
  // holam male, or shuruk (a dageshed vav right after a vowel is a doubled consonant)
  const vowelVav = (c, prev = '') => c[0] === '\u05d5' && (/[\u05b9\u05ba]/.test(c)
    || (c.includes('\u05bc') && !FULL_VOWEL.test(c) && !/[\u05b1-\u05bb\u05c7]/.test(prev)));
  const mater = c => /^[\u05d5\u05d9][^\u05b0-\u05c7]*$/.test(c);
  const furtive = i => i === last && i > 0 && /^([\u05d7\u05e2]|\u05d4.*\u05bc)/.test(letters[i]) && letters[i].includes('\u05b7')
    && (/[\u05b4\u05b5\u05b9\u05bb]/.test(letters[i - 1]) || vowelVav(letters[i - 1], letters[i - 2]) || mater(letters[i - 1]));
  const nucleus = i => (FULL_VOWEL.test(letters[i]) || vowelVav(letters[i], letters[i - 1])) && !furtive(i);

  // silluq looks like a meteg, so a meteg counts only on the verse's last word
  let accents = letters.map((c, i) => ACCENT.test(c) || (verseEnd && c.includes('\u05bd')) ? i : -1).filter(i => i >= 0);
  const positionalOnly = i => ((i === 0 && letters[i].includes(DEHI)) || (i === last && letters[i].includes(TSINNOR)))
    && !ACCENT.test(letters[i].replace(DEHI, '').replace(TSINNOR, ''));
  accents = accents.filter(i => !positionalOnly(i));
  if (!accents.length) return -1;

  // with several accents (e.g. ole veyored, revia mugrash) the last one is on the stressed syllable
  const a = accents.at(-1);
  let s = nucleus(a) ? a : a < last && vowelVav(letters[a + 1], letters[a]) ? a + 1 : -1;
  for (let j = a; s < 0 && j >= 0; j--) if (nucleus(j)) s = j;
  return s >= 0 && letters.some((_, j) => j > s && nucleus(j)) ? s : -1;
}

function markStress(text) {
  const parts = text.split(/([\s\u05be]+)/);
  const lastWord = parts.findLastIndex(p => /[\u05d0-\u05ea]/.test(p));
  return parts.map((part, k) => {
    const letters = k % 2 ? null : part.match(/[\u05d0-\u05ea][^\u05d0-\u05ea]*/g);
    if (!letters) return part;
    const lead = part.slice(0, part.indexOf(letters[0]));
    const s = milelIndex(letters, k === lastWord);
    if (s >= 0) letters[s] += PLACEHOLDER;
    return lead + letters.join('');
  }).join('');
}

// The main pausing accents: etnachta, segolta, zakef katan, zakef gadol. A clause that is still long between them
// also pauses at the lesser ones: tipcha, revia, pashta, tevir.
const PAUSING = /[\u0591\u0592\u0594\u0595]/;
const LESSER_PAUSING = /[\u0596\u0597\u0599\u059b]/;
const LONG_CLAUSE = 40; // letters

const letters = words => words.join("").replace(/[^\u05d0-\u05ea]/g, "").length;

function addPauses(text) {
  const words = text.split(/\s+/);
  const clauses = [[]];
  words.forEach((w, i) => {
    clauses.at(-1).push(w);
    if (PAUSING.test(w) && i < words.length - 1) clauses.push([]);
  });
  return clauses.map(clause => clause.map((w, i) => i < clause.length - 1
    && (PAUSING.test(w) || (letters(clause) > LONG_CLAUSE && LESSER_PAUSING.test(w))) ? `${w},` : w).join(' ')).join(', ');
}

// withPauses: a comma after each word with a pausing accent. Only for the recorded voices (data/<app>-speech.json):
// the speech model splits long verses at punctuation, and without any it may skip words.
function clean(html, withPauses = false) {
  const text = html
    .replace(/<span class="mam-kq-k">.*?<\/span>/g, '')
    .replace(/<span class="mam-spi-[^"]*">.*?<\/span>/g, '')
    .replace(/<sup class="footnote-marker">.*?<\/sup><i class="footnote">.*?<\/i>/g, '') // other manuscripts' readings
    .replace(/<small>.*?<\/small>|<b>.*?<\/b>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&thinsp;|&nbsp;/g, ' ')
    .replace(/[\[\]()]/g, '');
  const marked = markStress(text);
  return (withPauses ? addPauses(marked.trim()) : marked)
    // cantillation, meteg, rafe, paseq, upper/lower dots, inverted nun, CGJ
    .replace(/[\u0591-\u05af\u05bd\u05bf\u05c0\u05c4\u05c5\u05c6\u034f]/g, '')
    .replaceAll(PLACEHOLDER, STRESS)
    .replace(/\s+/g, ' ')
    .trim();
}

// The book's chapters as Sefaria's HTML, [chapter][verse]
async function fetchBook(book) {
  const res = await fetch(source(book));
  if (!res.ok) throw new Error(`${book}: HTTP ${res.status}`);
  return (await res.json()).versions[0].text;
}
const cleanAll = (chapters, withPauses) => chapters.map(ch => ch.map(html => clean(html, withPauses)));

async function write(name, chapters, expected, extra = '') {
  if (chapters.length !== expected) throw new Error(`expected ${expected} chapters, got ${chapters.length}`);
  const leftovers = chapters.flat().join('').match(new RegExp(`[^\\u05d0-\\u05ea\\u05b0-\\u05bc\\u05be\\u05c1\\u05c2\\u05c3\\u05c7\\u05ab ${extra}]`, 'g'));
  if (leftovers) throw new Error(`unexpected characters: ${[...new Set(leftovers)].join(' ')}`);
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../data/${name}.json`, import.meta.url), JSON.stringify(chapters));
  const milel = chapters.flat().join('').split(STRESS).length - 1;
  console.log(`${name}: wrote ${chapters.flat().length} verses, ${milel} mil'el words marked`);
}

// ---------- Chumash: books, parshiyot and the weekly calendar ----------
const BOOKS = [['Genesis', 'בראשית'], ['Exodus', 'שמות'], ['Leviticus', 'ויקרא'], ['Numbers', 'במדבר'], ['Deuteronomy', 'דברים']];
const CALENDAR_YEARS = [2025, 2045]; // the civil years the parsha calendar covers
const JOINED = [['Vayakhel', 'Pekudei'], ['Tazria', 'Metzora'], ['Achrei Mot', 'Kedoshim'], ['Behar', 'Bechukotai'],
  ['Chukat', 'Balak'], ['Matot', 'Masei'], ['Nitzavim', 'Vayeilech']];
// The names as they're usually written (hebcal has some in the Torah's own spelling)
const SPELLING = { 'לך־לך': 'לך לך', 'מצרע': 'מצורע', 'קדשים': 'קדושים', 'בחקתי': 'בחוקותי', 'בהעלתך': 'בהעלותך', 'שלח־לך': 'שלח',
  'קורח': 'קרח', 'כי־תצא': 'כי תצא', 'כי־תבוא': 'כי תבוא' };

async function buildChumash() {
  const books = [];
  const html = [];
  for (const [en, name] of BOOKS) {
    const text = await fetchBook(en);
    books.push({ en, name, first: html.length + 1, chapters: text.length });
    html.push(...text);
  }
  const chapters = cleanAll(html);
  await write('chumash', chapters, 187);
  await write('chumash-speech', cleanAll(html, true), 187, ',');

  // A verse as [chapter, verse]: chapters numbered through the five books, verses from 1
  const at = (en, ref) => {
    const b = books.find(b => b.en === en);
    const [c, v] = ref.split(':').map(Number);
    if (!b || c > b.chapters || v < 1 || v > chapters[b.first + c - 2].length) throw new Error(`bad ref ${en} ${ref}`);
    return [b.first + c - 1, v];
  };
  const readings = [...parshiot.map(p => [p]), ...JOINED].map(parts => {
    const { fullkriyah } = getLeyningForParsha(parts.length > 1 ? parts : parts[0]);
    const aliyot = [1, 2, 3, 4, 5, 6, 7].map(n => [...at(fullkriyah[n].k, fullkriyah[n].b), ...at(fullkriyah[n].k, fullkriyah[n].e)]);
    const name = parts.map(p => Locale.gettext(p, 'he-x-NoNikud')).map(n => SPELLING[n] || n).join('-');
    if (/[a-z]/i.test(name)) throw new Error(`no Hebrew name for ${parts}`);
    return { key: parts.join('-'), name, aliyot };
  });
  const index = parsha => {
    const i = readings.findIndex(r => r.key === parsha.join('-'));
    if (i < 0) throw new Error(`unknown reading ${parsha}`);
    return i;
  };

  // The readings in order, each on its day: every Shabbat that isn't a festival, and Simchat Torah
  // (Vezot Haberakhah, the 22nd of Tishrei in Israel and the 23rd abroad)
  const dayNumber = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  const calendar = {};
  for (const [id, il] of [['il', true], ['diaspora', false]]) {
    const events = [];
    const to = new Date(CALENDAR_YEARS[1] + 1, 0, 1);
    for (let d = new Date(CALENDAR_YEARS[0], 0, 1); d < to; d.setDate(d.getDate() + 1)) {
      const hd = new HDate(d);
      if (d.getDay() === 6) {
        const r = HebrewCalendar.getSedra(hd.getFullYear(), il).lookup(hd);
        if (!r.chag) events.push([dayNumber(d), index(r.parsha)]);
      }
      if (hd.getMonth() === months.TISHREI && hd.getDate() === (il ? 22 : 23)) events.push([dayNumber(d), index(['Vezot Haberakhah'])]);
    }
    // [first day, first reading, days to the next, its reading, ...]
    calendar[id] = events.flatMap(([day, r], i) => [i ? day - events[i - 1][0] : day, r]);
  }

  const module = `// Generated by scripts/build-data.mjs chumash, from hebcal (@hebcal/core, @hebcal/leyning). Don't edit.

// The five books: their first chapter in data/chumash.json and how many chapters they have
export const BOOKS = ${JSON.stringify(books.map(({ name, first, chapters }) => ({ name, first, chapters })))};

// The weekly readings: the 54 parshiyot, then the joined ones. Each has its 7 aliyot as
// [fromChapter, fromVerse, toChapter, toVerse], chapters numbered as in data/chumash.json and verses from 1.
export const READINGS = [
${readings.map(r => `  ${JSON.stringify({ name: r.name, aliyot: r.aliyot })},`).join('\n')}
];

// When each reading is read, ${CALENDAR_YEARS.join('\u2013')}, in Israel and abroad: pairs of [day, index in READINGS], where the
// first day is in days since 1970-01-01 and every other is in days since the one before. A Shabbat that is a festival
// has no reading, and Simchat Torah reads Vezot Haberakhah.
export const CALENDAR = {
${Object.entries(calendar).map(([id, flat]) => `  ${id}: ${JSON.stringify(flat)},`).join('\n')}
};
`;
  await writeFile(new URL('../apps/chumash/torah.js', import.meta.url), module);
  console.log(`chumash: ${readings.length} readings, parsha calendar ${CALENDAR_YEARS.join('\u2013')}`);
}

if (app === 'tehillim') await write('tehillim', cleanAll(await fetchBook('Psalms')), 150);
else if (app === 'chumash') await buildChumash();
else throw new Error(`unknown app ${app}`);
