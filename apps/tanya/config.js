// Everything that makes the shared app (app.js) the Tanya app
import { hebNum, numberName } from '../../hebrew.js';
import { SECTIONS, YOMI } from './yomi.js';

// Static details, read by the build (scripts/build-www.mjs) as well as by the app
export const meta = {
  id: 'tanya',
  name: 'תניא בדרך',
  tagline: 'משפט אחר משפט, בכל מקום',
  data: 'data/tanya.json', // units (chapters) of sentences, parts 1–3 (scripts/build-tanya.mjs)
  dataSize: 810000, // approximate, for the splash progress when there's no Content-Length
  audio: 'audio-tanya/', // the recorded voices (render.py --app tanya), served by GitHub Pages
  audioCache: 'tanya-audio',
  // Recorded units shipped inside the APK: the first of each section
  bundled: SECTIONS.map(s => s.first),
  releaseTag: 'tanya-v', // GitHub release tags tanya-v1.0.<build>
  testVerse: [4, 1],
  credit: 'טקסט: <a href="https://he.wikisource.org/wiki/תניא_מנוקד" target="_blank" rel="noopener">תניא מנוקד בוויקיטקסט</a> (CC BY-SA) · תניא יומי: <a href="https://github.com/imush/hebrewcalendar-data" target="_blank" rel="noopener">hebrewcalendar-data</a>',
};

// ---------- Units: the sections' chapters, numbered through the book ----------
const sectionOf = c => SECTIONS.findLast(s => s.first <= c);
const inSection = c => c - sectionOf(c).first + 1;
const unit = c => {
  const s = sectionOf(c);
  return s.units === 1 ? s.name : `${s.name} פרק ${hebNum(inSection(c))}`;
};
// The chapter pickers group the units by the book's parts
const PARTS = [['ליקוטי אמרים', 1], ['שער היחוד והאמונה', SECTIONS.find(s => s.name === 'חינוך קטן').first], ['אגרת התשובה', SECTIONS.at(-1).first]];

// ---------- Tanya Yomi, by the Hebrew date ----------
// The table's months: Nisan is 1, Adar (Adar I in a leap year) 12, Adar II 13
const MONTHS = { Nisan: 1, Iyar: 2, Sivan: 3, Tamuz: 4, Av: 5, Elul: 6, Tishri: 7, Heshvan: 8, Kislev: 9, Tevet: 10, Shevat: 11, Adar: 12, 'Adar I': 12, 'Adar II': 13 };
const MONTH_NAMES = ['', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול', 'תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'אדר ב׳'];
const isLeap = year => (7 * year + 1) % 19 < 7;
const hebrewParts = date => {
  const parts = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(date);
  const part = type => parts.find(p => p.type === type).value;
  return { day: Number(part('day')), month: MONTHS[part('month')], year: Number(part('year')) };
};
// The yearly cycle starts on 19 Kislev: its track (leap or ordinary) is the one of the year its Adar is in
function cycle(date = new Date()) {
  const { month, day, year } = hebrewParts(date);
  const before = month === 7 || month === 8 || (month === 9 && day < 19);
  const track = isLeap(before ? year - 1 : year) ? 'leap' : 'ordinary';
  return { track, days: Object.keys(YOMI[track]) }; // "month-day" in the order they're learned
}
const monthName = (m, track) => (m === 12 && track === 'leap' ? 'אדר א׳' : MONTH_NAMES[m]);
const dayLabel = (key, track) => {
  const [m, d] = key.split('-').map(Number);
  return `${hebNum(d)} ב${monthName(m, track)}`;
};
// A day's value in the picker: its index in the year's lessons, +1000 for the 29th of a short Cheshvan or Kislev,
// which learns the 30th's lesson too
const SHORT = 1000;
const shortMonthDay = key => key === '8-29' || key === '9-29';

// Names of chapters and the daily reading. chapters: the data file, [unit][sentence] -> text
export function content(chapters) {
  const range = (fromC, toC, fromS = 0, toS = chapters[toC - 1].length - 1) => ({ start: [fromC, fromS], end: [toC, toS] });
  const units = (a, b) => {
    if (a === b) return unit(a);
    const s = sectionOf(a);
    return s === sectionOf(b) ? `${s.name} פרקים ${hebNum(inSection(a))}–${hebNum(inSection(b))}` : `${unit(a)} – ${unit(b)}`;
  };
  const unitSegment = (a, b = a) => ({ ...range(a, b), label: units(a, b) });
  const lessonName = lesson => (typeof lesson === 'string' ? `${lesson} (עוד לא באפליקציה)` : units(lesson[0], lesson[2]));

  function today() {
    const now = new Date();
    const { days } = cycle(now);
    const { month, day } = hebrewParts(now);
    const key = `${month}-${day}`;
    const i = days.indexOf(key);
    return shortMonthDay(key) && hebrewParts(new Date(now.getTime() + 86400000)).day === 1 ? i + SHORT : i;
  }

  function yomiSegment(value) {
    const { track, days } = cycle();
    const i = value % SHORT;
    const lessons = [YOMI[track][days[i]], ...(value >= SHORT ? [YOMI[track][days[i + 1]]] : [])];
    const available = lessons.filter(l => typeof l !== 'string');
    const label = `תניא יומי · ${dayLabel(days[i], track)}${value >= SHORT ? ' (חודש חסר)' : ''}`;
    if (!available.length) {
      // Parts 4–5 aren't in the app yet: the day says what its lesson is (app.js shows `missing` instead of reading)
      return { ...range(1, 1, 0, 0), label, missing: `${label}: ${lessons.join(', ')} — החלק הזה עוד לא באפליקציה` };
    }
    const [a, as] = available[0], [, , b, bs] = available.at(-1);
    return { ...range(a, b, as, bs), label: `${label} · ${lessonName(available[0])}` };
  }

  return {
    unit,
    units,
    unitOption: c => (sectionOf(c).units === 1 ? sectionOf(c).name : `פרק ${hebNum(inSection(c))}`),
    unitGroup: c => PARTS.findLast(([, first]) => first <= c)[0],
    unitSegment,
    where: (c, s) => `${unit(c)} · משפט ${hebNum(s + 1)}`,
    mediaTitle: c => `תניא · ${unit(c)}`,
    // for the phone's voice; the recorded voices have their own (render.py tanya_announcement)
    announcement: c => (sectionOf(c).units === 1 ? sectionOf(c).name : `${sectionOf(c).name} פרק ${numberName(inSection(c))}`),
    // The daily reading: a button that reads today's lesson and a picker for another day of this year's cycle.
    // The id is stored in the reader's sequence, so it stays as it is.
    dailies: [
      {
        id: 'yomi', button: 'תניא יומי', pick: 'בחירת יום', chain: 'תניא יומי',
        today,
        options: t => {
          const { track, days } = cycle();
          return days.flatMap((key, i) => {
            const mark = v => (v === t ? ' (היום)' : '');
            const option = { value: i, label: `${dayLabel(key, track)} · ${lessonName(YOMI[track][key])}${mark(i)}` };
            if (!shortMonthDay(key)) return [option];
            return [option, { value: i + SHORT, label: `${dayLabel(key, track)} (חודש חסר, עם ל׳)${mark(i + SHORT)}` }];
          });
        },
        segment: yomiSegment,
      },
    ],
    // Voice commands: what comes after "עבור ל…", as {chapter} or {segment}. number: a spoken number, or null.
    // "ליקוטי אמרים פרק לב" / "ליקוטי אמרים לב", "פרק לב" (in the current section), "הקדמה", "חינוך קטן"
    goTo(rest, number, pos) {
      for (const s of [rest, rest.replace(/^(?:אל |ל ?)/, '')]) {
        const t = s.replace(/[׳״'"]/g, '');
        for (const [names, section] of SPOKEN_SECTIONS) {
          const name = names.find(n => t === n || t.startsWith(n + ' '));
          if (!name) continue;
          const sec = SECTIONS.find(x => x.name === section);
          const after = t.slice(name.length).replace(/^ (?:פרק )?/, '');
          if (!after) return { chapter: sec.first };
          const n = number(after);
          if (n >= 1 && n <= sec.units) return { chapter: sec.first + n - 1 };
        }
        const m = t.match(/^פרק (.+)$/);
        const sec = sectionOf(pos?.[0] || SECTIONS.find(x => x.units > 1).first);
        const n = m && number(m[1]);
        if (n >= 1 && n <= sec.units) return { chapter: sec.first + n - 1 };
      }
      return null;
    },
    commandExample: 'אמרו למשל "עבור לפרק לב" או "פסוק הבא"',
    commandsHelp: `
      <p><b>"עבור לליקוטי אמרים פרק לב"</b> — מעבר לפרק. אפשר גם "עבור לפרק לב" בחלק שקוראים בו עכשיו,
      וגם "עבור לשער היחוד והאמונה פרק ג", "עבור לאגרת התשובה פרק ה", "עבור להקדמה" או "עבור לחינוך קטן".</p>
      <p>את מספר הפרק אפשר לומר באותיות ("לב"), בשמות האותיות ("למד בית") או במספר ("שלושים ושתיים").</p>`,
  };
}

// The sections by the names they may be called
const SPOKEN_SECTIONS = [
  [['ליקוטי אמרים', 'לקוטי אמרים', 'תניא'], 'ליקוטי אמרים'],
  [['שער היחוד והאמונה', 'שער היחוד'], 'שער היחוד והאמונה'],
  [['אגרת התשובה', 'איגרת התשובה'], 'אגרת התשובה'],
  [['הקדמת המלקט', 'הקדמה'], 'הקדמת המלקט'],
  [['חינוך קטן', 'חנוך קטן'], 'חינוך קטן'],
  [['הסכמות'], 'הסכמות'],
  [['שער הספר'], 'שער הספר'],
];
