// Fetches Psalms (Miqra according to the Masorah, CC-BY-SA) from Sefaria and writes data/tehillim.json
// Usage: node scripts/build-data.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const SOURCE = 'https://www.sefaria.org/api/v3/texts/Psalms?version=hebrew|Miqra according to the Masorah';

function clean(html) {
  return html
    .replace(/<span class="mam-kq-k">.*?<\/span>/g, '')
    .replace(/<span class="mam-spi-[^"]*">.*?<\/span>/g, '')
    .replace(/<small>.*?<\/small>|<b>.*?<\/b>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&thinsp;|&nbsp;/g, ' ')
    .replace(/[\[\]()]/g, '')
    // cantillation, meteg, rafe, paseq, upper/lower dots, inverted nun, CGJ
    .replace(/[֑-ֽֿ֯׀ׅׄ׆͏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const { versions } = await res.json();
const chapters = versions[0].text.map(ch => ch.map(clean));

if (chapters.length !== 150) throw new Error(`expected 150 chapters, got ${chapters.length}`);
const leftovers = chapters.flat().join('').match(/[^א-תְ-ּ־ׁׂ׃ׇ ]/g);
if (leftovers) throw new Error(`unexpected characters: ${[...new Set(leftovers)].join(' ')}`);

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/tehillim.json', import.meta.url), JSON.stringify(chapters));
console.log(`wrote ${chapters.flat().length} verses`);
