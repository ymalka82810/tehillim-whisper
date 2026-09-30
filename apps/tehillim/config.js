// Everything that makes the shared app (app.js) the Tehillim app
import { hebNum, numberName, WEEKDAYS, hebrewDay } from '../../hebrew.js';

// Static details, read by the build (scripts/build-www.mjs) as well as by the app
export const meta = {
  id: 'tehillim',
  name: 'תהילים בדרך',
  tagline: 'פסוק אחר פסוק, בכל מקום',
  data: 'data/tehillim.json',
  dataSize: 330000, // approximate, for the splash progress when there's no Content-Length
  audio: 'audio/', // the recorded voices (render.py): a folder in the repo, served by GitHub Pages
  audioCache: 'tehillim-audio',
  // Recorded chapters shipped inside the APK, so reading can start before anything downloads:
  // the first chapter of each weekday's reading and of each of the five books. The rest download in the background.
  bundled: [1, 30, 42, 51, 73, 90, 107, 120],
  releaseTag: 'v', // GitHub release tags v1.0.<build>
  testVerse: [23, 1],
  credit: 'טקסט: <a href="https://he.wikisource.org/wiki/מקרא_על_פי_המסורה" target="_blank" rel="noopener">מקרא על פי המסורה</a> (CC-BY-SA) דרך Sefaria',
};

// [fromChapter, fromVerse(1-based), toChapter, toVerse]
const MONTH = [
  [1, 1, 9], [10, 1, 17], [18, 1, 22], [23, 1, 28], [29, 1, 34], [35, 1, 38], [39, 1, 43], [44, 1, 48],
  [49, 1, 54], [55, 1, 59], [60, 1, 65], [66, 1, 68], [69, 1, 71], [72, 1, 76], [77, 1, 78], [79, 1, 82],
  [83, 1, 87], [88, 1, 89], [90, 1, 96], [97, 1, 103], [104, 1, 105], [106, 1, 107], [108, 1, 112],
  [113, 1, 118], [119, 1, 119, 96], [119, 97, 119], [120, 1, 134], [135, 1, 139], [140, 1, 144], [145, 1, 150],
];
const WEEK = [[1, 29], [30, 50], [51, 72], [73, 89], [90, 106], [107, 119], [120, 150]];

// Names of chapters and the daily readings. chapters: the data file, [chapter][verse] -> text
export function content(chapters) {
  const range = (fromCh, toCh, fromV = 1, toV = chapters[toCh - 1].length) => ({ start: [fromCh, fromV - 1], end: [toCh, toV - 1] });
  const unit = c => `פרק ${hebNum(c)}`;
  const units = (a, b) => a === b ? unit(a) : `פרקים ${hebNum(a)}–${hebNum(b)}`;
  const mark = (d, today) => d === today ? ' (היום)' : '';

  // day: 1–30, or 0 for the 29th of a short month, which also reads the 30th's chapters
  function monthSegment(day) {
    if (!day) return { ...range(140, 150), label: 'יום כ״ט (חודש חסר) · פרקים קמ–קנ' };
    const [a, av, b, bv] = MONTH[day - 1];
    const label = a === b ? `פרק ${hebNum(a)} פסוקים ${hebNum(av)}–${hebNum(bv ?? chapters[b - 1].length)}` : units(a, b);
    return { ...range(a, b, av, bv), label: `יום ${hebNum(day)} בחודש · ${label}` };
  }
  function todayMonth() {
    const now = new Date();
    const day = hebrewDay(now);
    return day === 29 && hebrewDay(new Date(now.getTime() + 86400000)) === 1 ? 0 : day;
  }

  return {
    unit,
    units,
    unitOption: c => `${hebNum(c)} (${c})`,
    unitSegment: (a, b = a) => ({ ...range(a, b), label: units(a, b) }),
    where: (c, v) => `פרק ${hebNum(c)} · פסוק ${hebNum(v + 1)}`,
    mediaTitle: (c, v) => `תהילים ${hebNum(c)}:${hebNum(v + 1)}`,
    announcement: c => `פרק ${numberName(c)}`, // for the phone's voice; the recorded voices have their own
    // The daily readings, each a button that reads today's part and a picker for another day.
    // The ids are stored in the reader's sequence, so they stay as they are.
    dailies: [
      {
        id: 'month', button: 'יומי לפי החודש', pick: 'בחירת יום בחודש', chain: 'תהילים יומי לפי החודש',
        today: todayMonth,
        options: today => Array.from({ length: 30 }, (_, i) => i + 1).flatMap(d => [
          { value: d, label: `${hebNum(d)} בחודש${mark(d, today)}` },
          ...(d === 29 ? [{ value: 0, label: `כ״ט בחודש חסר${mark(0, today)}` }] : []),
        ]),
        segment: monthSegment,
      },
      {
        id: 'week', button: 'יומי לפי השבוע', pick: 'בחירת יום בשבוע', chain: 'תהילים יומי לפי השבוע',
        today: () => new Date().getDay(),
        options: today => WEEKDAYS.map((name, d) => ({ value: d, label: `יום ${name}${mark(d, today)}` })),
        segment: d => ({ ...range(...WEEK[d]), label: `יום ${WEEKDAYS[d]} · ${units(...WEEK[d])}` }),
      },
    ],
  };
}
