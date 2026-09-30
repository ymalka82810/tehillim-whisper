// Everything that makes the shared app (app.js) the Chumash app
import { hebNum, numberName } from '../../hebrew.js';
import { BOOKS, READINGS, CALENDAR } from './torah.js';

// Static details, read by the build (scripts/build-www.mjs) as well as by the app
export const meta = {
  id: 'chumash',
  name: 'חומש בדרך',
  tagline: 'פסוק אחר פסוק, בכל מקום',
  data: 'data/chumash.json', // the chapters of the five books one after another (scripts/build-data.mjs chumash)
  dataSize: 1270000, // approximate, for the splash progress when there's no Content-Length
  audio: 'audio-chumash/', // the recorded voices (render.py --app chumash), served by GitHub Pages
  audioCache: 'chumash-audio',
  // Recorded chapters shipped inside the APK: the first chapter of each book
  bundled: BOOKS.map(b => b.first),
  releaseTag: 'chumash-v', // GitHub release tags chumash-v1.0.<build>
  testVerse: [1, 1],
  credit: 'טקסט: <a href="https://he.wikisource.org/wiki/מקרא_על_פי_המסורה" target="_blank" rel="noopener">מקרא על פי המסורה</a> (CC-BY-SA) דרך Sefaria · פרשות ועליות: <a href="https://www.hebcal.com" target="_blank" rel="noopener">Hebcal</a>',
};

const ALIYOT = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי'];

// The book of a chapter (numbered through the five books) and the chapter's number in it
const bookOf = c => BOOKS.findLast(b => b.first <= c);
const inBook = c => c - bookOf(c).first + 1;

// Readings as the parsha pickers list them: in the Torah's order, a joined reading after its first part
const PICK_ORDER = READINGS.map((r, i) => i).sort((a, b) =>
  READINGS[a].aliyot[0][0] - READINGS[b].aliyot[0][0] || READINGS[a].aliyot[0][1] - READINGS[b].aliyot[0][1] || a - b);

// The reading of the week: the first one read today or later (Sunday to Shabbat read the coming Shabbat's parsha;
// when that Shabbat is a festival, the next parsha that will be read)
function weekReading(calendar) {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000;
  const table = CALENDAR[calendar] || CALENDAR.il;
  for (let i = 0, day = 0; i < table.length; i += 2) {
    day += table[i];
    if (day >= today) return table[i + 1];
  }
  return 0; // past the end of the calendar (scripts/build-data.mjs CALENDAR_YEARS)
}

// Parsha names as they're spoken, compared without matres lectionis and spaces: פנחס = פינחס, תצווה = תצוה
const loose = s => s.replace(/[-־ ]/g, '').replace(/(?<=.)[וי]/g, ''); // a first ו stays: וישלח isn't שלח
const SPOKEN_READINGS = { 'שלח לך': 'שלח', 'אחרי': 'אחרי מות', 'הברכה': 'וזאת הברכה', 'זאת הברכה': 'וזאת הברכה' };
const findReading = s => READINGS.findIndex(r => loose(r.name) === loose(SPOKEN_READINGS[s] || s));

// Names of chapters and the daily readings. chapters: the data file, [chapter][verse] -> text. store: saved settings.
export function content(chapters, store) {
  const range = (fromCh, toCh, fromV = 1, toV = chapters[toCh - 1].length) => ({ start: [fromCh, fromV - 1], end: [toCh, toV - 1] });
  const unit = c => `${bookOf(c).name} ${hebNum(inBook(c))}`;
  const units = (a, b) => a === b ? unit(a) : bookOf(a) === bookOf(b) ? `${unit(a)}–${hebNum(inBook(b))}` : `${unit(a)} – ${unit(b)}`;
  const mark = (d, today) => d === today ? ' (היום)' : '';
  const calendar = () => store.get('calendar', 'il');

  const reading = i => READINGS[i];
  const readingSegment = i => {
    const { aliyot, name } = reading(i);
    return { ...range(aliyot[0][0], aliyot[6][2], aliyot[0][1], aliyot[6][3]), label: `פרשת ${name}` };
  };
  const aliyahSegment = d => {
    const i = weekReading(calendar());
    const [a, av, b, bv] = reading(i).aliyot[d];
    return { ...range(a, b, av, bv), label: `פרשת ${reading(i).name} · ${ALIYOT[d]}` };
  };
  const unitSegment = (a, b = a) => ({ ...range(a, b), label: units(a, b) });

  return {
    unit,
    units,
    unitOption: unit,
    unitGroup: c => bookOf(c).name,
    unitSegment,
    where: (c, v) => `${bookOf(c).name} פרק ${hebNum(inBook(c))} · פסוק ${hebNum(v + 1)}`,
    mediaTitle: (c, v) => `${unit(c)}:${hebNum(v + 1)}`,
    announcement: c => `${bookOf(c).name} פרק ${numberName(inBook(c))}`, // for the phone's voice; the recorded voices have their own
    settings: [
      {
        key: 'calendar', label: 'פרשת השבוע לפי', default: 'il',
        choices: [{ value: 'il', label: 'ארץ ישראל' }, { value: 'diaspora', label: 'חוץ לארץ' }],
        hint: 'בחלק מהשנים קוראים בחוץ לארץ פרשה אחרת מבארץ ישראל במשך כמה שבועות.',
      },
    ],
    // The daily readings, each a button that reads today's part and a picker for another.
    // The ids are stored in the reader's sequence, so they stay as they are.
    dailies: [
      {
        id: 'aliyah', button: 'חומש יומי', pick: 'בחירת יום בשבוע', chain: 'חומש יומי (העלייה של היום)',
        today: () => new Date().getDay(),
        // Each weekday reads its aliyah: Sunday the first, ... Shabbat the seventh
        options: today => ALIYOT.map((name, d) => ({ value: d, label: `${reading(weekReading(calendar())).name} · ${name}${mark(d, today)}` })),
        segment: aliyahSegment,
      },
      {
        id: 'parsha', button: 'פרשת השבוע', pick: 'בחירת פרשה', chain: 'פרשת השבוע כולה',
        today: () => weekReading(calendar()),
        options: today => PICK_ORDER.map(i => ({ value: i, label: `${reading(i).name}${mark(i, today)}` })),
        segment: readingSegment,
      },
    ],
    // Voice commands: what comes after "עבור ל…", as {chapter} or {segment}. number: a spoken number, or null.
    // "בראשית פרק ג" / "בראשית ג", "פרק ג" (in the current book), "פרשת נח" / "נח"
    goTo(rest, number, pos) {
      // "לבראשית" is ל + בראשית, but "לך לך" is the parsha itself: try the words as heard first
      for (const s of [rest, rest.replace(/^(?:אל |ל ?)/, '')]) {
        const r = findReading(s.replace(/^פרשת /, ''));
        if (r >= 0) return { segment: readingSegment(r) };
        const m = s.match(/^(?:ספר )?(\S+) (?:פרק )?(.+)$/);
        const b = m && (m[1] === 'פרק' ? bookOf(pos?.[0] || 1) : BOOKS.find(b => b.name === m[1]));
        const n = b && number(m[2]);
        if (n >= 1 && n <= b.chapters) return { chapter: b.first + n - 1 };
      }
      return null;
    },
    commandExample: 'אמרו למשל "עבור לפרשת נח" או "פסוק הבא"',
    commandsHelp: `
      <p><b>"עבור לפרשת נח"</b> — הפרשה כולה, מתחילתה. אפשר גם בלי המילה "פרשת".</p>
      <p><b>"עבור לבראשית פרק ג"</b> — מעבר לפרק בספר. אפשר גם "עבור לבראשית ג", או "עבור לפרק ג" בספר שקוראים בו עכשיו.</p>
      <p>את מספר הפרק אפשר לומר באותיות ("כג"), בשמות האותיות ("כף גימל") או במספר ("עשרים ושלוש").</p>`,
  };
}
