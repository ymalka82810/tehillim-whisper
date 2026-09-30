// Builds the Tanya app's text: data/tanya.json, data/tanya-speech.json, data/tanya-announce.json and apps/tanya/yomi.js
// Usage: node scripts/build-tanya.mjs [--refresh] [--words]
//
// Text: the pointed edition on Hebrew Wikisource (https://he.wikisource.org/wiki/תניא_מנוקד, CC BY-SA),
// parts 1–3 for now. Parts 4–5 there were pasted in 2023 without a source and look copied from Kehot's
// edition, so they're left out until there's a licensed source (the daily reading says they aren't in the app yet).
// Pages are cached in scripts/.cache/tanya/ (Wikisource limits the request rate); --refresh fetches them again.
// --words lists the pointed acronyms (רַזַ״ל, תַּרְיַ״ג...), to review which ones should be spelled out.
//
// What's done to the text:
//   - wiki markup, footnote markers and the source references at the end of each page are removed;
//   - the abbreviations Wikisource left (ה׳, וכו׳, רַזַ״ל...) are spelled out from PHRASES and WORDS below, and the
//     build fails on any unpointed word that isn't there or a numeral, so new ones get reviewed by hand;
//   - each paragraph is split into sentences (the app's segments), and also wherever a day's Tanya Yomi lesson starts;
//   - mil'el words get a U+05AB on the stressed letter, as in the other apps (there are no te'amim here, so it's
//     from a word list and patterns, see markStress).
// data/tanya-speech.json is the same segments as the recorded voices read them (render.py --app tanya):
// numerals by the names of their letters (דַּף רל״א -> דַּף רֵישׁ לָמֶד אָלֶף), without brackets and quotes.
//
// Daily reading: Chabad's yearly Tanya Yomi (from 19 Kislev), from schedules/tanya.json in
// https://github.com/imush/hebrewcalendar-data (BSD-3-Clause), which has each day's first and last words,
// for ordinary and leap years. Each lesson's start is found in the text here, so the app only needs positions.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { hebNum } from '../hebrew.js';

const refresh = process.argv.includes('--refresh');
const CACHE = new URL('./.cache/tanya/', import.meta.url);
const WIKI = 'תניא מנוקד';
const SCHEDULE = 'https://raw.githubusercontent.com/imush/hebrewcalendar-data/main/schedules/tanya.json';

// ---------- Units: the app's chapters, in order ----------
// section and chapter: the schedule's names for it (chapter 0 when the section is one piece)
const letters = n => hebNum(n).replace(/[׳״]/g, '');
const range = n => Array.from({ length: n }, (_, i) => i + 1);
const SECTIONS = [
  { key: 'TITLE_PAGE', name: 'שער הספר', said: 'שַׁ֫עַר הַסֵּ֫פֶר' },
  { key: 'APPROBATION', name: 'הסכמות', said: 'הַסְכָּמוֹת' },
  { key: 'COMPILERS_FOREWORD', name: 'הקדמת המלקט', said: 'הַקְדָּמַת הַמְּלַקֵּט' },
  { key: 'LIKKUTEI_AMARIM', name: 'ליקוטי אמרים', said: 'לִקּוּטֵי אֲמָרִים', chapters: 53 },
  { key: 'CHINUKH_KATAN', name: 'חינוך קטן', said: 'חִנּוּךְ קָטָן' },
  { key: 'SHAAR_HAYICHUD_VEHAEMUNAH', name: 'שער היחוד והאמונה', said: 'שַׁ֫עַר הַיִּחוּד וְהָאֱמוּנָה', chapters: 12 },
  { key: 'IGGERET_HATESHUVAH', name: 'אגרת התשובה', said: 'אִגֶּ֫רֶת הַתְּשׁוּבָה', chapters: 12 },
  // not in the app yet
  { key: 'IGGERET_HAKODESH', name: 'אגרת הקודש', missing: true },
  { key: 'KUNTRES_ACHARON', name: 'קונטרס אחרון', missing: true },
];
const PAGES = {
  TITLE_PAGE: () => 'חלק א', APPROBATION: () => 'חלק א', COMPILERS_FOREWORD: () => 'חלק א/הקדמה',
  LIKKUTEI_AMARIM: n => `חלק א/פרק ${letters(n)}`, CHINUKH_KATAN: () => 'חלק ב/חנוך לנער',
  SHAAR_HAYICHUD_VEHAEMUNAH: n => `חלק ב/פרק ${letters(n)}`, IGGERET_HATESHUVAH: n => `חלק ג/${letters(n)}`,
};
const UNITS = SECTIONS.filter(s => !s.missing).flatMap(s => (s.chapters ? range(s.chapters) : [0])
  .map(chapter => ({ section: s.key, chapter, page: PAGES[s.key](chapter) })));

// ---------- Fetching ----------
async function cached(name, get) {
  const file = new URL(name, CACHE);
  if (!refresh) try { return await readFile(file, 'utf8'); } catch {}
  const text = await get();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, text);
  console.log(`fetched ${name}`);
  return text;
}

const wikitext = page => cached(page.replaceAll('/', '_') + '.txt', async () => {
  const u = new URL('https://he.wikisource.org/w/api.php');
  Object.entries({ action: 'parse', page: `${WIKI}/${page}`, prop: 'wikitext', format: 'json', formatversion: '2' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  for (let attempt = 0; ; attempt++) {
    await new Promise(r => setTimeout(r, attempt ? 20000 * attempt : 4000)); // Wikisource answers "too many requests" to bursts
    const body = await fetch(u, { headers: { 'User-Agent': 'tanya-bederech-build/1.0 (github.com/ymalka82810/tehillim-whisper)' } })
      .then(res => res.text(), e => e.message);
    if (body.startsWith('{')) {
      const { parse, error } = JSON.parse(body);
      if (error) throw new Error(`${page}: ${error.info}`);
      return parse.wikitext;
    }
    if (attempt === 4) throw new Error(`${page}: ${body.slice(0, 100)}`);
  }
});

// ---------- Wiki markup -> paragraphs ----------
function paragraphs(wiki, section) {
  let t = wiki;
  // Part 1's main page: the title page, the approbations, then the foreword's title and the contents (dropped)
  if (section === 'TITLE_PAGE') {
    t = t.slice(t.indexOf('{{מרכז|{{גדול|סֵפֶר}}}}'), t.indexOf('==הַסְכָּמוֹת=='))
      .replace(/<div[^>]*>\s*\{\{מרכז\|מַהֲדוּרָה[\s\S]*?<\/div>/, ''); // the edition's own credits
  }
  if (section === 'APPROBATION') t = t.slice(t.indexOf('==הַסְכָּמוֹת=='), t.indexOf('==הקדמה==')).replace(/^===[^=]+===$/gm, '');
  t = t.split(/^==\s*(?:מראי מקומות|תוכן)/m)[0];
  // Innermost templates first: formatting keeps its text ({{מרכז|{{גדול|סֵפֶר}}}}), the rest goes
  // (footnote markers, navigation, status templates)
  for (;;) {
    const formatted = t.replace(/\{\{(?:מרכז|גדול|כו|קטן|מודגש)\|([^{}]*)\}\}/g, '$1').replace(/\{\{ש\}\}/g, '\n');
    if (formatted !== t) { t = formatted; continue; }
    const stripped = t.replace(/\{\{[^{}]*\}\}/g, '');
    if (stripped === t) break;
    t = stripped;
  }
  return t
    .replace(/\{\{\{[^{}]*\}\}\}/g, '')
    .replace(/<ref[\s\S]*?<\/ref>|<[^>]+>/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?|\*/g, '')
    .replace(/^=+[^=\n]*=+\s*$/gm, '') // headings: the unit's name comes from the app
    .replace(/^[:*#]+/gm, '')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map(p => p.replace(/\s+/g, ' ').replace(/\s+([,.:;?!)\]])/g, '$1').replace(/([(\[])\s+/g, '$1').trim())
    .filter(p => /[א-ת]/.test(p));
}

// Sentences: after . : ; ? ! (and any closing quote or bracket), when more text follows
const sentences = p => p.split(/(?<=[.:;?!]["”״')\]]*)\s+(?=\S)/).map(s => s.trim()).filter(Boolean);

// ---------- Abbreviations ----------
// Wikisource's edition already spells out most abbreviations (חַס וְשָׁלוֹם). What's left is here, reviewed by hand.
// Phrases are replaced first: several words, or words that depend on their neighbors
const PHRASES = [
  // the title page and the approbations' signatures, which aren't pointed
  ['מאת כ"ק אדמו"ר רבי שניאור זלמן מליאדי נבג"מ זיע"א', 'מֵאֵת כְּבוֹד קְדֻשַּׁת אֲדוֹנֵנוּ מוֹרֵנוּ וְרַבֵּנוּ רַבִּי שְׁנֵיאוֹר זַלְמָן מִלְּיַאדִי, נִשְׁמָתוֹ בְּגִנְזֵי מְרוֹמִים, זְכוּתוֹ יָגֵן עָלֵינוּ אָמֵן'],
  ['משולם זוסיל מאניפאלי', 'מְשֻׁלָּם זוּסִיל מֵאַנִּיפּוֹלִי'],
  ['יהודא ליב הכהן', 'יְהוּדָא לֵיבּ הַכֹּהֵן'],
  ['דוב בער', 'דֹּב בֶּער'],
  ['חיים אברהם', 'חַיִּים אַבְרָהָם'],
  ['נְאוּם משה', 'נְאוּם מֹשֶׁה'],
  ['בא"א מו"ר', 'בֶּן אֲדוֹנִי אָבִי מוֹרִי וְרַבִּי'],
  ['הגאון החסיד קדוש ישראל', 'הַגָּאוֹן הֶחָסִיד קְדוֹשׁ יִשְׂרָאֵל'],
  ['הגאון החסיד', 'הַגָּאוֹן הֶחָסִיד'],
  ['מרנא ורבנא', 'מָרָנָא וְרַבָּנָא'],
  ['שניאור זלמן', 'שְׁנֵיאוֹר זַלְמָן'],
  // an unpointed parenthesis in Shaar HaYichud VehaEmunah, and unpointed references
  ['(וכמו שנתבאר לעיל, שהוא מקור השפעת שם הוי"ה, ונרמז בקוצו של יו"ד)', '(וּכְמוֹ שֶׁנִּתְבָּאֵר לְעֵיל, שֶׁהוּא מְקוֹר הַשְׁפָּעַת שֵׁם הֲוָיָ"ה, וְנִרְמָז בְּקוֹצוֹ שֶׁל יוּ"ד)'],
  ['[בזהר פ\' בלק]', '[בַּזֹּהַר פָּרָשַׁת בָּלָק]'],
  ['[בעץ חיים שער כ"ו]', '[בְּעֵץ חַיִּים שַׁעַר כ"ו]'],
  ['(כה,א-ב)', '(דַּף כ"ה עַמּוּד א\' וּב\')'],
  // the side of a page after its number: דַּף ל"א ע"ב
  [/(ד[ּ]?ַף [א-ת]+["']?[א-ת]?) ע"([אב])/g, "$1 עַמּוּד $2'"],
  // the edition's corrections: the printed word in parentheses, then the right one in brackets. Only the right one is read.
  [/\([^()ְ-ׇ]+\)\s*(?=\[)/g, ''],
];
// Single words, without their punctuation
const WORDS = {
  "ה'": 'הַשֵּׁם', 'ה‘': 'הַשֵּׁם',
  "כו'": 'כּוּלֵּי', "כוּ'": 'כּוּלֵּי', "וכו'": 'וְכוּלֵּי', "וְכו'": 'וְכוּלֵּי', "וְכוּ'": 'וְכוּלֵּי',
  "וגו'": 'וְגוֹמֵר', "וְגו'": 'וְגוֹמֵר', "וְגוֹ'": 'וְגוֹמֵר',
  'הגהה': 'הַגָּהָה', 'הגה"ה': 'הַגָּהָה',
  'ז"ל': 'זִכְרוֹנוֹ לִבְרָכָה', 'זַ"ל': 'זִכְרוֹנוֹ לִבְרָכָה', 'זצ"ל': 'זֵכֶר צַדִּיק לִבְרָכָה', 'נבג"מ': 'נִשְׁמָתוֹ בְּגִנְזֵי מְרוֹמִים',
  'רַזַ"ל': 'רַבּוֹתֵינוּ זִכְרוֹנָם לִבְרָכָה',
  'כַּנַּ"ל': 'כַּנִּזְכָּר לְעֵיל', 'וְכַנַּ"ל': 'וְכַנִּזְכָּר לְעֵיל',
  'מוֹהֲרַ"ר': 'מוֹרֵנוּ הָרַב רַבִּי', 'בְּמוֹהֲרַ"ר': 'בֶּן מוֹרֵנוּ הָרַב רַבִּי',
  'ה"ה': 'הֲלֹא הֵם', 'וה"ה': 'וַהֲלֹא הוּא',
  'הקב"ה': 'הַקָּדוֹשׁ בָּרוּךְ הוּא',
  'פרק': 'פֶּרֶק', 'זו': 'זוֹ', 'דחגיגה': 'דַּחֲגִיגָה',
  // acronyms that are read as words, pointed as they're read
  'הרמ"ז': 'הָרְמַ"ז', 'ב"ן': 'בַּ"ן', 'י"ה': 'יָ"הּ', 'אחה"ע': 'אֲחָהַ"ע', 'מנצפ"ך': 'מְנַצְפַּ"ךְ',
  'ו"ה': 'וָא"ו הֵ"א',
  'הַנַּ"ל': 'הַנִּזְכָּר לְעֵיל', 'חֲזַ"ל': 'חֲכָמֵינוּ זִכְרוֹנָם לִבְרָכָה', 'הַגָּהָ"ה': 'הַגָּהָה',
};

// Hebrew numerals (ג׳, רל״א, וכ״א, or bare after פרק and the like), kept as they're written and read by their letters
const VALUE = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
const NUMBERED = /^[ובלכמשהד]?(?:פרק|פרקים|שער|חלק|דף|סימן|תיקון|תקון)$/; // words a bare numeral follows (without points)
// The Name after a prefix: לַה׳ -> לַשֵּׁם, מֵה׳ -> מֵהַשֵּׁם (but הַה׳ is "the five", a numeral)
function prefixedName(word) {
  const m = word.match(/^((?:[ובלכמשד][ְ-ׇ]*){1,3})ה['׳‘]$/);
  if (!m) return null;
  const p = m[1];
  if (/[בכל][ַּ]+$/.test(p)) return p + 'שֵּׁם'; // the article is in the prefix
  return p.replace(/^וַ$/, 'וְ') + 'הַשֵּׁם';
}
// A numeral, maybe with prefixes (וכ״א, לְד׳, שֶׁבְּז׳): what's shown, its prefix and its letters
function numeral(word, prev, prefix = '') {
  const m = word.match(/^([א-ת]+)(['"׳״‘])?([א-ת])?$/);
  const digits = m ? m[1] + (m[3] || '') : '';
  const values = [...digits].map(l => VALUE[l]);
  if (m && (m[2] || (!prefix && NUMBERED.test(prev.replace(/[֑-ׇ]/g, '')))) && /["״]/.test(m[2] || '') === Boolean(m[3])
    && values.every((v, i) => v && (!i || v <= values[i - 1] || digits === 'חי'))) {
    return { shown: prefix + (digits.length > 1 ? digits.slice(0, -1) + '״' + digits.slice(-1) : digits + '׳'), prefix, digits };
  }
  // or after a prefix letter
  const p = word.match(/^([ובלכמשהד][ְ-ׇ]*)(.+)$/);
  return p && prefix.length < 6 ? numeral(p[2], prev, prefix + (p[1] === 'ו' ? 'וְ' : p[1])) : null;
}
const LETTER_NAMES = { א: 'אָ֫לֶף', ב: 'בֵּית', ג: 'גִּ֫ימֶל', ד: 'דָּ֫לֶת', ה: 'הֵא', ו: 'וָו', ז: 'זַ֫יִן', ח: 'חֵית', ט: 'טֵית',
  י: 'יוּד', כ: 'כָּף', ל: 'לָ֫מֶד', מ: 'מֵם', נ: 'נוּן', ס: 'סָ֫מֶךְ', ע: 'עַ֫יִן', פ: 'פֵּא', צ: 'צָ֫דִי', ק: 'קוּף', ר: 'רֵישׁ',
  ש: 'שִׁין', ת: 'תָּו' };

// ---------- Stress ----------
// There are no te'amim, and Phonikud reads a pointed word without a stress mark as milra, so mil'el words get
// U+05AB on their stressed letter here: from the word list, or from the patterns in milelIndex.
const STRESS = '֫';
// With the stress mark after the stressed letter's points. Found also after prefixes: וּלְמַעְלָה
const MILEL = ['אֵ֫לֶּה', 'לְמַ֫עְלָה', 'לְמַ֫טָּה', 'מִלְּמַ֫עְלָה', 'מִלְּמַ֫טָּה', 'מַ֫עְלָה', 'לַ֫יְלָה', 'הֵ֫מָּה', 'הֵ֫נָּה', 'לָ֫מָּה',
  'אֶ֫לָּא', 'כָּ֫כָה', 'אָנֹ֫כִי', 'לְעֵ֫ילָּא', 'לְתַ֫תָּא', 'עֵ֫ילָּא', 'תַּ֫תָּא', 'מַ֫לְכָּא', 'קוּ֫דְשָׁא', 'עָ֫לְמָא', 'סִ֫טְרָא'];
const skeleton = w => w.normalize('NFC').replace(/[֑-ּֽֿׅ֯ׄ]/g, ''); // compared without dagesh, meteg and accents, points in one order
// Milra, although the patterns in milelIndex would say otherwise
const MILRA = new Set(['מַחֲשַׁבְתִּי', 'בִּלְתִּי', 'תִּקְּנוּ'].map(w => skeleton(w)));
const MILEL_WORDS = new Map(MILEL.map(w => {
  const ls = w.match(/[א-ת][^א-ת]*/g);
  return [skeleton(w), ls.findIndex(c => c.includes(STRESS))];
}));

const FULL_VOWEL = /[ִ-ׇֻ]/; // hiriq..qubuts, qamats qatan
function milelIndex(ls) {
  const last = ls.length - 1;
  const has = (i, re) => i >= 0 && i <= last && re.test(ls[i]);
  const vowelVav = i => has(i, /^ו/) && (/[ֹֺ]/.test(ls[i]) || (ls[i].includes('ּ') && !FULL_VOWEL.test(ls[i]) && !has(i - 1, /[ֱ-ׇֻ]/)));
  const nucleus = i => FULL_VOWEL.test(ls[i]) || vowelVav(i);
  const mater = i => /^[אויה]$/.test(ls[i]);
  // the nearest vowel before letter i, over bare letters and sheva; -1 if it's a hataf
  const before = i => {
    for (let j = i - 1; j >= 0; j--) {
      if (nucleus(j)) return j;
      if (has(j, /[ֱ-ֳ]/)) return -1;
    }
    return -1;
  };
  const closes = c => /^([^הויא]|ה.*ּ)/.test(c) && !/[ֱ-ׇֻ]/.test(c); // a consonant that ends the syllable
  if (last < 1) return -1;
  // ...נוּ, ...הוּ: אֱלֹהֵ֫ינוּ, לָ֫נוּ, אֲנַ֫חְנוּ, אֵלִיָּ֫הוּ
  if (vowelVav(last) && ls[last].includes('\u05bc') && /^[נה]$/.test(ls[last - 1]) && (ls[last - 1] === 'נ' || nucleus(last - 2))) return before(last - 1);
  // ...ֶיךָ, ...ֶיהָ: עָלֶ֫יהָ, דְּרָכֶ֫יךָ
  if (last >= 2 && has(last, /^[כךה]/) && ls[last].includes('ָ') && ls[last - 1] === 'י' && ls[last - 2].includes('ֶ')) return last - 2;
  // past tense ...ְתִּי, ...ְתָּ: אָמַ֫רְתִּי, וְאָהַ֫בְתָּ
  const t = ls[last] === 'י' ? last - 1 : last;
  if (t >= 2 && has(t, /^ת/) && ls[t].includes('ּ') && ls[t].includes(t === last ? 'ָ' : 'ִ') && ls[t - 1].includes('ְ')) return before(t - 1);
  // Aramaic ...וּתָא, ...יתָא: אִתְעָרוּ֫תָא, דְּאוֹרַ֫יְיתָא
  if (last >= 3 && ls[last] === 'א' && has(last - 1, /^ת/) && ls[last - 1].includes('ָ')) {
    if (vowelVav(last - 2)) return last - 2;
    if (ls[last - 2] === 'י') return before(last - 2);
  }
  // ...ַיִם, ...ַיִת, ...ַיִן: מַ֫יִם, בַּ֫יִת, אַ֫יִן
  if (last >= 2 && /^יִ$/.test(ls[last - 1]) && closes(ls[last]) && ls[last - 2].includes('ַ')) return last - 2;
  // segolates: פֶּ֫רֶק, סֵ֫פֶר, קֹ֫דֶשׁ, וַיֹּ֫אמֶר, מְקַבֶּ֫לֶת, נַ֫עַר, זֶ֫רַע, נֵ֫צַח. The vowel before is right before the
  // last syllable (not אֶתְכֶם), or with a silent letter between (וַיֹּאמֶר)
  if (closes(ls[last].replace('ְ', ''))) {
    const p = before(last - 1);
    if (p < 0 || !(p === last - 2 || (p === last - 3 && mater(last - 2)))) return -1;
    const l2 = ls[last - 1];
    // not the suffixes ...ֵיהֶם, ...ֵיכֶם (עֲלֵיהֶם, אֱלֹהֵיכֶם; but בָּ֫הֶם), ...תֶם (וִהְיִיתֶם), nor וָעֶד (a prefix and a word)
    if ((/^[הכ]/.test(l2) && ls[last - 2] === 'י') || (/^ת/.test(l2) && /^[םן]/.test(ls[last])) || (p === 0 && /^ו/.test(ls[0]))) return -1;
    if (l2.includes('\u05b6') && !/[\u05b0-\u05b5\u05b7-\u05bb\u05c7]/.test(l2)) return p;
    const guttural = /^[חעהא]/.test(l2) || /^[חע]/.test(ls[last]);
    // with patach only after tsere, segol or patach, and not after a prefix: not verbs like יָדַע, שִׁלַּח, יֵרַע,
    // nor participles like נוֹדַע, nor אַחַר, אַחַת, nor מֵרַע, לֵידַע, שֶׁאַף (but שֶׁ֫בַע)
    if (l2.includes('\u05b7') && guttural && !l2.includes('\u05bc') && has(p, /[\u05b5\u05b6\u05b7]/) && !vowelVav(p)
      && !has(p, /^א/) && !/^א/.test(l2) && !(p === 0 && (/^[מלבכהי]/.test(ls[0]) || (/^ש/.test(ls[0]) && /^[חעהא]/.test(l2))))) return p;
  }
  return -1;
}
function markStress(word) {
  if (word.includes(STRESS) || /["״]/.test(word)) return word;
  const ls = word.match(/[א-ת][^א-ת]*/g);
  if (!ls || ls.length < 2) return word;
  const lead = word.slice(0, word.indexOf(ls[0]));
  const tail = word.slice(lead.length + ls.join('').length);
  let s;
  // the lists, as it is or after up to 3 prefix letters
  for (let i = 0; i < 4 && s === undefined; i++) {
    if (i && !/^[ובכלמשהד]/.test(ls[i - 1])) break;
    const w = skeleton(ls.slice(i).join(''));
    if (MILRA.has(w)) s = -1;
    else if (MILEL_WORDS.has(w)) s = i + MILEL_WORDS.get(w);
  }
  if (s === undefined) s = milelIndex(ls);
  if (s >= 0) ls[s] += STRESS;
  return lead + ls.join('') + tail;
}

// ---------- Words: spelled out, numerals, stress; and how they're spoken ----------
const unknown = new Map();
const acronyms = new Map();
function expand(sentence, where) {
  for (const [from, to] of PHRASES) sentence = typeof from === 'string' ? sentence.replaceAll(from, to) : sentence.replace(from, to);
  const shown = [], spoken = [];
  let prev = '';
  for (const word of sentence.split(' ')) {
    let [, lead, core, trail] = word.match(/^([("“\['‘]*)(.*?)([),.:;?!"”\]]*)$/);
    core = core.replace(/^([ובלכמשהד][ְ-ׇ]*)'(?=[א-ת])/, '$1'); // וְ'חָסִיד': a quote after the prefix
    const name = prefixedName(core);
    let num = numeral(core, prev);
    if (/['’]$/.test(core) && !name && !num && !WORDS[core] && /[ְ-ׇ]/.test(core)) {
      trail = core.slice(-1) + trail; // a closing quote ('עוֹבֵד'), not a geresh
      core = core.slice(0, -1);
      num = null;
    }
    const add = (show, speak = show) => { shown.push(lead + show + trail); spoken.push(lead + speak + trail); };
    if (name) {
      add(name);
    } else if (WORDS[core]) {
      const w = WORDS[core].split(' ').map(markStress).join(' ');
      add(w.replace(/"/g, '״'), w.replace(/"/g, ''));
    } else if (num) {
      add(num.shown, num.prefix + [...num.digits].map(l => LETTER_NAMES[l]).join(' '));
    } else if (/[א-ת]/.test(core) && !/[ְ-ׇּׁׂ]/.test(core)) {
      unknown.set(core, `${where}: ${sentence.slice(0, 100)}`);
      add(core);
    } else {
      if (/[א-ת][ְ-ׇ]*"[א-ת]/.test(core)) acronyms.set(core, (acronyms.get(core) || 0) + 1);
      // a quote right after a prefix, before a whole word, opens a quotation: וְ"לֹא. Otherwise it's an acronym: תַּרְיַ״ג
      const w = markStress(core.replace(/(?<=[א-ת][ְ-ׇ]*)"(?=[א-ת])/g, (q, at) =>
        /^(?:[ובלכמשהד][ְ-ׇ]*){1,3}$/.test(core.slice(0, at)) && (core.slice(at).match(/[א-ת]/g) || []).length > 1 ? '"' : '״'));
      add(w, w.replace(/[״׳']/g, ''));
    }
    prev = core;
  }
  return {
    shown: shown.join(' '),
    // what the recorded voices read: without brackets and quotes
    spoken: spoken.join(' ').replace(/[\[\]()"“”'‘’]/g, '').replace(/\s+/g, ' ').trim(),
  };
}

// ---------- Tanya Yomi: where each day's lesson starts ----------
// Words compared without points, punctuation and matres lectionis, and final letters as others
const FINAL = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const tokens = s => s.replace(/[־–-]/g, ' ').replace(/[֑-ׇ]/g, '').replace(/[^א-ת ]/g, '')
  .replace(/[ךםןףץ]/g, c => FINAL[c]).replace(/[וי]/g, '').split(' ').filter(Boolean);

// The best place for a lesson that starts with `phrase`, at or after token `from`: -1 if none.
// A place right after the words the lesson before ends with (`prevEnd`) is preferred, since openings repeat in a chapter.
function findStart(unitTokens, phrase, from, prevEnd) {
  const p = tokens(phrase).slice(0, 4);
  let best = -1, bestScore = 0, enough = 0;
  for (let i = from; i < unitTokens.length; i++) {
    const k = unitTokens[i].tok === p[0] ? 0 : unitTokens[i].tok === p[1] ? 1 : -1;
    if (k < 0) continue;
    // the phrase's other words anywhere in the next few (the edition may spell a word out: ב׳ בחינות, שְׁתֵּי בְּחִינוֹת)
    const near = unitTokens.slice(i + 1, i + 6).map(t => t.tok);
    const words = (k ? 0.5 : 1) + p.slice(k + 1).filter(t => near.includes(t)).length;
    const score = words + (prevEnd && endsLike(unitTokens, i, prevEnd) ? 2 : 0);
    if (score > bestScore) { best = i; bestScore = score; enough = words >= Math.min(2, p.length); }
  }
  return enough ? best : -1;
}

// The position of a lesson's first word among all the unit's words
const wordAt = (u, l) => raw[u].slice(0, l.seg).reduce((n, words) => n + words.length, 0) + l.word;

// Do the words before `at` end like `phrase`? (to check the lesson before)
// The schedule spells out some abbreviations that Wikisource sometimes keeps, so a phrase is tried both ways
const SCHEDULE_ABBREVIATIONS = [['כנזכר לעיל', 'כנ"ל'], ['זכרונו לברכה', 'ז"ל'], ['משה זכות', 'הרמ"ז']];
function endsLike(unitTokens, at, phrase) {
  const short = SCHEDULE_ABBREVIATIONS.reduce((s, [long, abbr]) => s.replaceAll(long, abbr), phrase);
  const before = unitTokens.slice(Math.max(0, at - 5), at).map(t => t.tok);
  return [phrase, short].some(ph => {
    const p = tokens(ph).slice(-3);
    return p.filter(t => before.includes(t)).length >= Math.min(2, p.length);
  });
}

// ---------- Build ----------
const raw = [];
for (const u of UNITS) {
  let wiki = await wikitext(u.page);
  if (u.section === 'CHINUKH_KATAN') { // it starts with part 2's title, which is on part 2's main page
    const lines = (await wikitext('חלק ב')).split('\n');
    const from = lines.findIndex(l => l.replace(/[֑-ׇ]/g, '').startsWith('{{מרכז|לקוטי אמרים חלק'));
    const to = lines.findIndex(l => l.startsWith('==תוכן'));
    if (from < 0 || to < from) throw new Error("part 2's title not found");
    wiki = lines.slice(from, to).join('\n') + '\n' + wiki;
  }
  raw.push(paragraphs(wiki, u.section).flatMap(sentences).map(s => s.split(' ')));
}

const schedule = JSON.parse(await cached('schedule.json', () => fetch(SCHEDULE).then(r => {
  if (!r.ok) throw new Error(`schedule: HTTP ${r.status}`);
  return r.text();
})));
// A year's lessons in the order they're learned: from 19 Kislev (month 9; Nisan is 1) to 18 Kislev
const order = leap => {
  const months = leap ? [9, 10, 11, 12, 13, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const days = schedule.filter(d => d.leap === leap);
  return months.flatMap((m, i) => days.filter(d => d.month === m && (m !== 9 || (i ? d.day < 19 : d.day >= 19))).sort((a, b) => a.day - b.day));
};

const unitTokens = raw.map(segs => segs.flatMap((words, seg) => words.flatMap((w, word) => tokens(w).map(tok => ({ tok, seg, word })))));
const unitOf = d => UNITS.findIndex(u => u.section === d.section && u.chapter === d.chapter);
const splits = raw.map(() => new Set()); // per unit: "seg:word" where a lesson starts inside a sentence
const tracks = {};
const problems = [];
for (const [track, leap] of [['ordinary', false], ['leap', true]]) {
  const lessons = order(leap);
  if (lessons.length !== (leap ? 385 : 355)) throw new Error(`${track}: ${lessons.length} days`);
  let last = { unit: -1, token: -1 };
  tracks[track] = lessons.map((d, i) => {
    const unit = unitOf(d);
    if (unit < 0) {
      if (!SECTIONS.find(s => s.key === d.section)?.missing) throw new Error(`unknown section ${d.section} ${d.chapter}`);
      return { d, missing: true };
    }
    const same = unit === last.unit;
    let token = findStart(unitTokens[unit], d.start, same ? last.token + 1 : 0, same && lessons[i - 1].end);
    if (token < 0) {
      problems.push(`${track} ${d.month}/${d.day}: "${d.start}" not found in ${UNITS[unit].page}`);
      token = same ? last.token + 1 : 0;
    }
    // a few words into a sentence: the edition has words the schedule's doesn't (וּבֵאוּר הָעִנְיָן, כִּי...), so the sentence
    if (unitTokens[unit][token]?.word <= 3) {
      const seg = unitTokens[unit][token].seg;
      token = unitTokens[unit].findIndex(t => t.seg === seg);
    }
    last = { unit, token };
    const { seg, word } = unitTokens[unit][token] || { seg: 0, word: 0 };
    if (word) splits[unit].add(`${seg}:${word}`);
    return { d, unit, seg, word, token };
  });
}

// Segments: the sentences, split where lessons start
const segIndex = raw.map(() => new Map()); // "seg:word" -> the new segment's index
const units = raw.map((segs, u) => segs.flatMap((words, seg) => {
  const cuts = [0, ...[...splits[u]].filter(k => k.startsWith(`${seg}:`)).map(k => +k.split(':')[1]).sort((a, b) => a - b)];
  return cuts.map((c, i) => {
    segIndex[u].set(`${seg}:${c}`, segIndex[u].size);
    return words.slice(c, cuts[i + 1]).join(' ');
  });
}));

// Each day: [fromUnit, fromSegment, toUnit, toSegment] with units from 1 and segments from 0, or the missing part's name.
// A lesson ends where the next one starts. The last one before the missing parts ends with its unit.
const yomi = {};
for (const [track, lessons] of Object.entries(tracks)) {
  yomi[track] = {};
  lessons.forEach((l, i) => {
    const key = `${l.d.month}-${l.d.day}`;
    if (l.missing) {
      const name = SECTIONS.find(s => s.key === l.d.section).name;
      yomi[track][key] = `${name}${l.d.chapter ? ' ' + hebNum(l.d.chapter) : ''}`;
      return;
    }
    const start = segIndex[l.unit].get(`${l.seg}:${l.word}`);
    const next = lessons[i + 1];
    let end;
    if (next && !next.missing && next.unit === l.unit) {
      end = [l.unit, segIndex[next.unit].get(`${next.seg}:${next.word}`) - 1];
      if (!endsLike(unitTokens[l.unit], next.token, l.d.end)) problems.push(`${track} ${key}: the lesson doesn't end with "${l.d.end}" but "${raw[l.unit].flat().slice(Math.max(0, wordAt(l.unit, next) - 6), wordAt(l.unit, next)).join(' ')}"`);
    } else if (next && !next.missing && next.unit > l.unit + 1 && next.seg === 0 && next.word === 0) {
      // the next lesson is past a unit: this one takes it if it ends there (the approbations in a leap year)
      const between = next.unit - 1;
      const endsThere = endsLike(unitTokens[between], unitTokens[between].length, l.d.end);
      end = endsThere ? [between, units[between].length - 1] : [l.unit, units[l.unit].length - 1];
    } else {
      end = [l.unit, units[l.unit].length - 1];
    }
    yomi[track][key] = [l.unit + 1, start, end[0] + 1, end[1]];
  });
}

// ---------- Text ----------
const shown = [], spoken = [];
units.forEach((segs, u) => {
  const out = segs.map(s => expand(s, UNITS[u].page));
  shown.push(out.map(o => o.shown));
  spoken.push(out.map(o => o.spoken));
});

if (process.argv.includes('--words')) {
  console.log([...acronyms].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join(' '));
}
if (problems.length) console.warn(`Tanya Yomi, check these:\n  ${problems.join('\n  ')}`);
if (unknown.size) {
  throw new Error(`unpointed words that aren't in PHRASES or WORDS:\n${[...unknown].map(([w, where]) => `  ${w}  (${where})`).join('\n')}`);
}
const odd = shown.flat().join(' ').split(' ').filter(w => /[^א-תְ-ּ־ׇׁׂ֫,.:;?!()\[\]"“”'‘’׳״–-]/.test(w));
if (odd.length) throw new Error(`unexpected characters in: ${[...new Set(odd)].join(' ')}`);

await writeFile(new URL('../data/tanya.json', import.meta.url), JSON.stringify(shown));
await writeFile(new URL('../data/tanya-speech.json', import.meta.url), JSON.stringify(spoken));
// Each unit's spoken title, which the recordings open with (render.py tanya_announcement): "לִקּוּטֵי אֲמָרִים, פֶּ֫רֶק אָ֫לֶף"
const announce = UNITS.map(u => {
  const { said } = SECTIONS.find(s => s.key === u.section);
  return u.chapter ? `${said}, פֶּ֫רֶק ${[...letters(u.chapter)].map(l => LETTER_NAMES[l]).join(' ')}` : said;
});
await writeFile(new URL('../data/tanya-announce.json', import.meta.url), JSON.stringify(announce));
await mkdir(new URL('../apps/tanya/', import.meta.url), { recursive: true });
const firsts = [];
UNITS.forEach((u, i) => { if (!firsts.some(f => f.key === u.section)) firsts.push({ key: u.section, first: i + 1 }); });
await writeFile(new URL('../apps/tanya/yomi.js', import.meta.url), `// Generated by scripts/build-tanya.mjs. Don't edit.

// The sections in the app, in order: their first unit in data/tanya.json (units from 1) and how many units they have
export const SECTIONS = ${JSON.stringify(firsts.map((f, i) => ({
  name: SECTIONS.find(s => s.key === f.key).name, first: f.first, units: (firsts[i + 1]?.first ?? UNITS.length + 1) - f.first,
})))};

// Chabad's yearly Tanya Yomi (from github.com/imush/hebrewcalendar-data, BSD-3-Clause), for ordinary and leap years,
// by "month-day" with Nisan as month 1 (Adar I is 12 and Adar II 13 in a leap year). Each day is
// [fromUnit, fromSegment, toUnit, toSegment], units from 1 and segments from 0, or the name of a part that isn't in the app yet.
// When Cheshvan or Kislev has 29 days, the 30th's lesson is learned on the 29th too.
export const YOMI = {
${Object.entries(yomi).map(([t, days]) => `  ${t}: ${JSON.stringify(days)},`).join('\n')}
};
`);
const milel = shown.flat().join('').split(STRESS).length - 1;
console.log(`tanya: ${UNITS.length} units, ${shown.flat().length} segments, ${milel} mil'el words marked; Tanya Yomi ${Object.keys(yomi.ordinary).length}/${Object.keys(yomi.leap).length} days`);
