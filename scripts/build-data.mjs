// Fetches Psalms (Miqra according to the Masorah, CC-BY-SA) from Sefaria and writes data/tehillim.json
// Usage: node scripts/build-data.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const SOURCE = 'https://www.sefaria.org/api/v3/texts/Psalms?version=hebrew|Miqra according to the Masorah';

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

function clean(html) {
  const text = html
    .replace(/<span class="mam-kq-k">.*?<\/span>/g, '')
    .replace(/<span class="mam-spi-[^"]*">.*?<\/span>/g, '')
    .replace(/<small>.*?<\/small>|<b>.*?<\/b>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&thinsp;|&nbsp;/g, ' ')
    .replace(/[\[\]()]/g, '');
  return markStress(text)
    // cantillation, meteg, rafe, paseq, upper/lower dots, inverted nun, CGJ
    .replace(/[\u0591-\u05af\u05bd\u05bf\u05c0\u05c4\u05c5\u05c6\u034f]/g, '')
    .replaceAll(PLACEHOLDER, STRESS)
    .replace(/\s+/g, ' ')
    .trim();
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const { versions } = await res.json();
const chapters = versions[0].text.map(ch => ch.map(clean));

if (chapters.length !== 150) throw new Error(`expected 150 chapters, got ${chapters.length}`);
const leftovers = chapters.flat().join('').match(/[^\u05d0-\u05ea\u05b0-\u05bc\u05be\u05c1\u05c2\u05c3\u05c7\u05ab ]/g);
if (leftovers) throw new Error(`unexpected characters: ${[...new Set(leftovers)].join(' ')}`);

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/tehillim.json', import.meta.url), JSON.stringify(chapters));
const milel = chapters.flat().join('').split(STRESS).length - 1;
console.log(`wrote ${chapters.flat().length} verses, ${milel} mil'el words marked`);
