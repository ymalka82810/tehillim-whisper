// Hebrew numerals and dates, shared by the app and the per-app configs (apps/<app>/config.js)

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
export function hebNum(n) {
  let s = HUNDREDS[Math.floor(n / 100)];
  n %= 100;
  if (n === 15) s += 'טו';
  else if (n === 16) s += 'טז';
  else s += TENS[Math.floor(n / 10)] + ONES[n % 10];
  return s.length > 1 ? s.slice(0, -1) + '״' + s.slice(-1) : s + '׳';
}

// A number as it is called, by the names of its letters: 119 -> "קוף יוד טית"
const LETTER_NAMES = { א: 'אָלֶף', ב: 'בֵּית', ג: 'גִּימֶל', ד: 'דָּלֶת', ה: 'הֵא', ו: 'וָו', ז: 'זַיִן', ח: 'חֵית', ט: 'טֵית',
  י: 'יוּד', כ: 'כָּף', ל: 'לָמֶד', מ: 'מֵם', נ: 'נוּן', ס: 'סָמֶךְ', ע: 'עַיִן', פ: 'פֵּא', צ: 'צָדִי', ק: 'קוּף' };
export function numberName(n) {
  return [...hebNum(n).replace(/[׳״]/g, '')].map(l => LETTER_NAMES[l]).join(' ');
}

export const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// The Hebrew date of the civil day (the app doesn't know when night falls)
export function hebrewDate(date) {
  const parts = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', year: 'numeric' }).formatToParts(date);
  const part = type => Number(parts.find(p => p.type === type).value);
  return { day: part('day'), year: part('year'), month: new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' }).format(date) };
}
export const hebrewDay = date => hebrewDate(date).day;
