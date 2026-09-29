const $ = id => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// ---------- Splash ----------
// The shown percentage chases the real loading progress, but never runs faster than MIN_MS,
// so a fast (cached) start still reads as a smooth 0→100 rather than a flash.
const splash = (() => {
  const MIN_MS = 1200;
  const started = performance.now();
  let target = 0, shown = 0, finished;
  const done = new Promise(r => { finished = r; });
  const frame = () => {
    const cap = (performance.now() - started) / MIN_MS * 100;
    shown = Math.min(target, cap, shown + Math.max(0.4, (Math.min(target, cap) - shown) * 0.12));
    const pct = Math.floor(shown);
    $('splashBar').style.width = `${shown}%`;
    $('splashPct').textContent = `${pct}%`;
    $('splash').setAttribute('aria-valuenow', pct);
    if (shown < 100) return requestAnimationFrame(frame);
    setTimeout(() => {
      $('splash').classList.add('done');
      document.querySelector('meta[name=theme-color]').content = '#14161b';
      setTimeout(() => { $('splash').remove(); finished(); }, 450);
    }, 250);
  };
  requestAnimationFrame(frame);
  // Never trap the user behind the splash if something fails while loading
  setTimeout(() => { target = 100; }, 8000);
  return { set: p => { target = Math.max(target, p); }, done };
})();

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  const total = Number(res.headers.get('content-length')) || 330000; // no header → the data file's approximate size
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  return JSON.parse(await new Blob(parts).text());
}

const chapters = await fetchWithProgress('data/tehillim.json', f => splash.set(f * 70));
splash.set(75);

// In the Android app, the WebView has no speechSynthesis, so speech goes through the native plugin.
// @capacitor/core isn't bundled, so call the plugin through the injected native bridge directly.
const native = window.Capacitor?.isNativePlatform?.()
  ? new Proxy({}, { get: (_, method) => options => window.Capacitor.nativePromise('NativeSpeech', method, options) })
  : null;
document.body.classList.add(native ? 'is-native' : 'is-web');

// ---------- Hebrew numerals ----------
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
function hebNum(n) {
  let s = HUNDREDS[Math.floor(n / 100)];
  n %= 100;
  if (n === 15) s += 'טו';
  else if (n === 16) s += 'טז';
  else s += TENS[Math.floor(n / 10)] + ONES[n % 10];
  return s.length > 1 ? s.slice(0, -1) + '״' + s.slice(-1) : s + '׳';
}

// ---------- Daily divisions ----------
// [fromChapter, fromVerse(1-based), toChapter, toVerse]
const MONTH = [
  [1, 1, 9], [10, 1, 17], [18, 1, 22], [23, 1, 28], [29, 1, 34], [35, 1, 38], [39, 1, 43], [44, 1, 48],
  [49, 1, 54], [55, 1, 59], [60, 1, 65], [66, 1, 68], [69, 1, 71], [72, 1, 76], [77, 1, 78], [79, 1, 82],
  [83, 1, 87], [88, 1, 89], [90, 1, 96], [97, 1, 103], [104, 1, 105], [106, 1, 107], [108, 1, 112],
  [113, 1, 118], [119, 1, 119, 96], [119, 97, 119], [120, 1, 134], [135, 1, 139], [140, 1, 144], [145, 1, 150],
];
const WEEK = [[1, 29], [30, 50], [51, 72], [73, 89], [90, 106], [107, 119], [120, 150]];
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function makeRange(fromCh, toCh, fromV = 1, toV = chapters[toCh - 1].length) {
  return { start: [fromCh, fromV - 1], end: [toCh, toV - 1] };
}

const chaptersLabel = (a, b) => a === b ? `פרק ${hebNum(a)}` : `פרקים ${hebNum(a)}–${hebNum(b)}`;

// A segment is a range to read with its name; a reading plan is segments read one after another
function chapterSegment(from, to = from) {
  return { ...makeRange(from, to), label: chaptersLabel(from, to) };
}

// day: 1–30, or 0 for the 29th of a short month, which also reads the 30th's chapters
function monthSegment(day) {
  if (!day) return { ...makeRange(140, 150), month: 0, label: 'יום כ״ט (חודש חסר) · פרקים קמ–קנ' };
  const [a, av, b, bv] = MONTH[day - 1];
  const label = a === b ? `פרק ${hebNum(a)} פסוקים ${hebNum(av)}–${hebNum(bv ?? chapters[b - 1].length)}` : chaptersLabel(a, b);
  return { ...makeRange(a, b, av, bv), month: day, label: `יום ${hebNum(day)} בחודש · ${label}` };
}

function weekSegment(d) {
  const [a, b] = WEEK[d];
  return { ...makeRange(a, b), week: d, label: `יום ${WEEKDAYS[d]} · ${chaptersLabel(a, b)}` };
}

// The Hebrew date of the civil day (the app doesn't know when night falls)
function hebrewDate(date) {
  const parts = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', year: 'numeric' }).formatToParts(date);
  const part = type => Number(parts.find(p => p.type === type).value);
  return { day: part('day'), year: part('year'), month: new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' }).format(date) };
}
const hebrewDay = date => hebrewDate(date).day;

function todayMonth() {
  const now = new Date();
  const day = hebrewDay(now);
  const shortMonthEnd = day === 29 && hebrewDay(new Date(now.getTime() + 86400000)) === 1;
  return monthSegment(shortMonthEnd ? 0 : day);
}
const todayWeek = () => weekSegment(new Date().getDay());

function todayText() {
  const now = new Date();
  const { day, month, year } = hebrewDate(now);
  return `יום ${WEEKDAYS[now.getDay()]} · ${hebNum(day)} ב${month} ${hebNum(year % 1000)} · ${now.getDate()}.${now.getMonth() + 1}.${now.getFullYear()}`;
}

// ---------- Stress ----------
// The data marks the stressed letter of mil'el words (taken from the te'amim) with U+05AB.
// Speech engines ignore marks in plain text, but follow an IPA transcription given in SSML <phoneme>.
const STRESS = '֫';
const CONSONANTS = {
  'א': '', 'ב': 'v', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z', 'ח': 'χ', 'ט': 't', 'י': 'j', 'כ': 'χ', 'ך': 'χ',
  'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': '', 'פ': 'f', 'ף': 'f', 'צ': 'ts', 'ץ': 'ts', 'ק': 'k',
  'ר': 'ʁ', 'ש': 'ʃ', 'ת': 't',
};
const WITH_DAGESH = { 'ב': 'b', 'כ': 'k', 'ך': 'k', 'פ': 'p', 'ף': 'p' };
const VOWELS = {
  'ֱ': 'e', 'ֲ': 'a', 'ֳ': 'o', 'ִ': 'i', 'ֵ': 'e', 'ֶ': 'e', 'ַ': 'a', 'ָ': 'a',
  'ֹ': 'o', 'ֺ': 'o', 'ֻ': 'u', 'ׇ': 'o',
};
const FINAL_FORMS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Pointed word -> IPA with the stress mark (modern Israeli pronunciation)
function ipa(word) {
  const letters = word.match(/[א-ת][^א-ת]*/g) || [];
  const last = letters.length - 1;
  const vowel = c => [...c].map(m => VOWELS[m]).find(Boolean) || '';
  const has = (c, mark) => c.includes(mark);
  const shuruk = i => letters[i][0] === 'ו' && has(letters[i], 'ּ') && !vowel(letters[i]) && (i === 0 || !vowel(letters[i - 1]));
  const holamMale = i => letters[i][0] === 'ו' && /[ֹֺ]/.test(letters[i]) && i > 0 && !vowel(letters[i - 1]);
  const bare = i => !/[ְ-ׇֻ]/.test(letters[i]);
  let silentSheva = false;
  const sounds = letters.map((c, i) => {
    const L = c[0], prev = letters[i - 1] || '';
    if (shuruk(i)) return ['', 'u'];
    if (holamMale(i)) return ['', 'o'];
    let cons = (has(c, 'ּ') && WITH_DAGESH[L]) || (L === 'ש' && has(c, 'ׂ') ? 's' : CONSONANTS[L]);
    let v = vowel(c);
    if (L === 'י' && bare(i) && (/[ie]$/.test(vowel(prev)) || (i < last && letters[i + 1] === 'ו' && i + 1 === last))) cons = '';
    if (L === 'ה' && i === last && !has(c, 'ּ')) cons = '';
    if (i === last && i > 0 && v === 'a' && /[חע]|ה.*ּ/.test(c) && (/[iou]/.test(vowel(prev)) || has(prev, 'ֵ') || shuruk(i - 1) || holamMale(i - 1) || (/[יו]/.test(prev[0]) && bare(i - 1)))) {
      return ['a' + cons, '']; // furtive patach
    }
    if (has(c, 'ְ')) {
      const next = letters[i + 1];
      const vocal = i < last && (i === 0 || silentSheva || (has(c, 'ּ') && vowel(prev))
        || (FINAL_FORMS[next[0]] || next[0]) === L);
      silentSheva = !vocal;
      v = vocal ? 'e' : '';
    } else silentSheva = false;
    return [cons, v];
  });
  const s = letters.findIndex(c => has(c, STRESS));
  const onset = s > 0 && !sounds[s][0] && (shuruk(s) || holamMale(s)) ? s - 1 : s;
  return sounds.map(([c, v], i) => (i === onset ? 'ˈ' : '') + c + v).join('');
}

// ---------- Speech text ----------
const MARKS = /[ְ-ׇ]/g;
function speakable(text, withNikud) {
  let t = text.replace(/׃/g, '').replace(/־/g, ' ');
  // Browsers don't pass SSML to the engine (Chrome and Edge read the tags aloud), so this is for the app only
  const stressed = native && settings.stressSpeech && t.includes(STRESS);
  t = t.split(' ').map(word => {
    if (stressed && word.includes(STRESS)) {
      const shown = word.replaceAll(STRESS, '');
      return `<phoneme alphabet="ipa" ph="${ipa(word)}">${withNikud ? shown : shown.replace(MARKS, '')}</phoneme>`;
    }
    word = word.replaceAll(STRESS, '');
    const letters = word.replace(MARKS, '');
    const m = letters.match(/^([ובלכמשה]{0,2})יהוה$/);
    if (!m) return word;
    const prefix = word.match(/^(.*?)י[ְ-ׇ]*ה[ְ-ׇ]*ו/)[1];
    const elohim = /ִ/.test(word.slice(word.lastIndexOf('ו')));
    return prefix + (elohim ? 'אֱלֹהִים' : 'אֲדֹנָי');
  }).join(' ');
  t = t.replace(/ׇ/g, 'ֹ');
  if (!withNikud) t = t.replace(MARKS, '');
  return stressed ? `<speak>${t}</speak>` : t;
}

// ---------- Settings ----------
const settings = {
  voice: store.get('voice', store.get('gender', 'female') === 'male' ? 'omer' : 'liat'), // a recorded voice, or 'device'
  voiceURI: store.get('voiceURI', null),
  gender: store.get('gender', 'female'),
  rate: store.get('rate', 0.9),
  pause: store.get('pause', 1),
  nikudSpeech: store.get('nikudSpeech', true),
  stressSpeech: store.get('stressSpeech', false),
  announce: store.get('announce', true),
  chain: store.get('chain', []), // the reader's own sequence: [{ type: 'month' | 'week' } | { type: 'chapters', from, to }]
};

let voices = []; // [{ id, label, male }]
const MALE_VOICE = /\b(avri|asaf|male)\b/i; // known male Hebrew voices (Microsoft); Android voices don't expose gender
const MALE_PITCH = 0.7; // no real male voice on the device: lower the pitch instead
let voiceHealth = null;

async function loadVoices() {
  if (native) {
    voiceHealth = await native.status();
    voices = voiceHealth.voices
      .filter(v => v.installed || v.network)
      .map((v, i) => ({ id: v.name, label: `קול ${i + 1}${v.network ? ' (דורש אינטרנט)' : ''}` }));
  } else {
    voices = speechSynthesis.getVoices()
      .filter(v => /^(he|iw)/i.test(v.lang))
      .map(v => {
        const male = MALE_VOICE.test(v.name) && !/female/i.test(v.name);
        return { id: v.voiceURI, label: `${v.name}${male ? ' (גבר)' : ''}${v.localService ? '' : ' (דורש אינטרנט)'}`, voice: v, male };
      });
  }
  const sel = $('voiceSel');
  sel.innerHTML = '';
  for (const v of voices) sel.add(new Option(v.label, v.id));
  if (!voices.length) sel.add(new Option('לא נמצא קול עברי', ''));
  if (currentVoice()) sel.value = currentVoice().id;
  renderVoiceHealth();
}
const currentVoice = () => voices.find(v => v.id === settings.voiceURI)
  || voices.find(v => !!v.male === (settings.gender === 'male')) || voices[0] || null;
const currentPitch = () => settings.gender === 'male' && !currentVoice()?.male ? MALE_PITCH : 1;

function voiceProblem() {
  if (!native) return !voices.length && speechSynthesis.getVoices().length
    ? 'לא נמצא קול עברי במכשיר. ההוראות להתקנה מופיעות בהגדרות.' : '';
  if (!voiceHealth?.ready) return 'מנוע הדיבור של הטלפון לא זמין. פתחו את הגדרות ההקראה ובחרו מנוע.';
  const google = voiceHealth.engine === 'com.google.android.tts';
  if (voiceHealth.hebrew === 'unsupported') {
    if (!voiceHealth.hasGoogle) return 'מנוע הדיבור בטלפון לא תומך בעברית. התקינו את מנוע הדיבור של Google.';
    if (!google) return 'בחרו ב-Google כ"מנוע מועדף" בהגדרות ההקראה של הטלפון.';
    return 'עברית לא זמינה. לחצו "התקנת קול עברי".';
  }
  if (voiceHealth.hebrew === 'missing' || !voices.length) return 'צריך להוריד את הקול העברי. לחצו "התקנת קול עברי" ובחרו עברית.';
  return '';
}

function showVoiceKind() {
  $('voiceKind').value = recordedVoice() || 'device';
  $('deviceVoice').hidden = !!recordedVoice();
  renderDownloads();
  renderVoiceHealth();
}

function renderVoiceHealth() {
  const problem = recordedVoice() ? '' : voiceProblem();
  $('voiceHealth').textContent = problem || '✓ קול עברי מותקן ומוכן';
  $('voiceHealth').classList.toggle('bad', !!problem);
  $('googleTtsBtn').hidden = !native || voiceHealth?.hasGoogle !== false;
  if (problem && !playing) setStatus(problem);
}

function bindSettings() {
  const rate = $('rate'), pause = $('pause');
  rate.value = settings.rate;
  pause.value = settings.pause;
  $('nikudSpeech').checked = settings.nikudSpeech;
  $('stressSpeech').checked = settings.stressSpeech;
  $('announce').checked = settings.announce;
  $('gender').value = settings.gender;
  const show = () => {
    $('rateOut').textContent = `×${Number(settings.rate).toFixed(2)}`;
    $('pauseOut').textContent = Number(settings.pause) === 0 ? 'ללא' : `×${Number(settings.pause).toFixed(1)}`;
  };
  show();
  const save = (key, value) => { settings[key] = value; store.set(key, value); show(); };
  rate.oninput = () => save('rate', Number(rate.value));
  pause.oninput = () => save('pause', Number(pause.value));
  $('nikudSpeech').onchange = e => save('nikudSpeech', e.target.checked);
  $('stressSpeech').onchange = e => save('stressSpeech', e.target.checked);
  $('announce').onchange = e => save('announce', e.target.checked);
  $('voiceSel').onchange = e => save('voiceURI', e.target.value);
  $('gender').onchange = e => {
    save('gender', e.target.value);
    // Switch to a real voice of the chosen gender when the device has one
    const male = settings.gender === 'male';
    const match = voices.find(v => !!v.male === male);
    if (match && !!currentVoice()?.male !== male) {
      save('voiceURI', match.id);
      $('voiceSel').value = match.id;
    }
  };
  $('settingsBtn').onclick = () => $('settings').showModal();
  $('testVoice').onclick = () => { cancelSpeech(); say(23, 1); };
  $('voiceKind').onchange = e => {
    save('voice', e.target.value);
    showVoiceKind();
    downloadInBackground();
  };
  if (native) {
    $('installVoiceBtn').onclick = () => native.installVoice();
    $('ttsSettingsBtn').onclick = () => native.openTtsSettings();
    $('googleTtsBtn').onclick = () => native.installGoogleEngine();
  }
}

// ---------- My sequence ----------
const CHAIN_TYPES = { month: 'תהילים יומי לפי החודש', week: 'תהילים יומי לפי השבוע' };
const chainItemLabel = item => CHAIN_TYPES[item.type] || chaptersLabel(item.from, item.to);
const chainPlan = () => settings.chain.map(item =>
  item.type === 'month' ? todayMonth() : item.type === 'week' ? todayWeek() : chapterSegment(item.from, item.to));
const chainStatus = () => `הרצף שלי · ${settings.chain.length} חלקים`;

function saveChain(chain) {
  settings.chain = chain;
  store.set('chain', chain);
  renderChain();
  downloadInBackground();
}

function renderChain() {
  const list = $('chainList');
  list.innerHTML = '';
  settings.chain.forEach((item, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = chainItemLabel(item);
    li.append(name);
    const move = to => {
      const chain = [...settings.chain];
      chain.splice(to, 0, ...chain.splice(i, 1));
      saveChain(chain);
    };
    for (const [text, label, action, disabled] of [
      ['▲', 'הזזה למעלה', () => move(i - 1), i === 0],
      ['▼', 'הזזה למטה', () => move(i + 1), i === settings.chain.length - 1],
      ['✕', 'הסרה', () => saveChain(settings.chain.filter((_, j) => j !== i))],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.disabled = !!disabled;
      b.onclick = action;
      li.append(b);
    }
    list.append(li);
  });
  $('chainEmpty').hidden = settings.chain.length > 0;
  $('chainBtn').hidden = !settings.chain.length;
}

function bindChain() {
  const type = $('chainType'), from = $('chainFrom'), to = $('chainTo');
  const showType = () => { $('chainChapters').hidden = type.value !== 'chapters'; };
  type.onchange = showType;
  from.onchange = () => { to.value = from.value; };
  to.onchange = () => { if (Number(to.value) < Number(from.value)) from.value = to.value; };
  $('chainAdd').onclick = () => {
    const item = type.value === 'chapters' ? { type: 'chapters', from: Number(from.value), to: Number(to.value) } : { type: type.value };
    saveChain([...settings.chain, item]);
  };
  showType();
  renderChain();
}

// ---------- Recorded voices ----------
// Every verse is pre-rendered (scripts/audio/render.py) with its stress taken from the te'amim.
// A chapter is one file, its clips back to back (clip 0 announces the chapter); audio/index.json has their lengths.
// The APK ships a few chapters (index.bundled); the rest download in the background and stay in the Cache API.
const AUDIO_REMOTE = native ? 'https://ymalka82810.github.io/tehillim-whisper/audio/' : 'audio/';
const AUDIO_CACHE = 'tehillim-audio';
const RECORDED = { liat: 'ליאת (אישה)', omer: 'עומר (גבר)' };
const canPlayOpus = !!new Audio().canPlayType('audio/ogg; codecs=opus');
const audio = { index: null, shipped: null, stored: {}, memo: new Map(), inflight: new Map(), downloading: false };
const pad3 = c => String(c).padStart(3, '0');
const recordedVoice = () => canPlayOpus && audio.index?.voices[settings.voice] ? settings.voice : null;

async function cachedJson(cache, url) {
  const hit = await cache.match(url);
  return hit ? hit.json() : null;
}

async function loadAudioIndex() {
  if (!canPlayOpus || !('caches' in window)) return;
  const cache = await caches.open(AUDIO_CACHE);
  if (native) audio.shipped = await fetch('audio/index.json').then(r => r.json()).catch(() => null);
  const url = `${AUDIO_REMOTE}index.json`;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) }); // don't hold up the splash
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    audio.index = await res.clone().json();
    await cache.put(url, res);
  } catch {
    audio.index = await cachedJson(cache, url) || audio.shipped; // offline: what was downloaded before
  }
  if (!audio.index) return;
  // Chapters downloaded for an older rendering can't be sliced with the new lengths: drop them
  const current = `.bin?v=${audio.index.version}`;
  for (const voice of Object.keys(audio.index.voices)) audio.stored[voice] = new Set();
  for (const req of await cache.keys()) {
    if (!req.url.includes('.bin?')) continue;
    const m = req.url.match(/\/(\w+)\/(\d{3})\.bin\?/);
    if (!req.url.endsWith(current) || !audio.stored[m?.[1]]) await cache.delete(req);
    else audio.stored[m[1]].add(Number(m[2]));
  }
}

const isShipped = (voice, c) => !!audio.shipped?.bundled?.includes(c) && !!audio.shipped.voices[voice]?.chapters[c];
const hasChapter = (voice, c) => isShipped(voice, c) || !!audio.stored[voice]?.has(c);

function slice(bin, lengths) {
  let at = 0;
  return lengths.map(n => bin.slice(at, at += n, 'audio/ogg'));
}

// The player and the background download may ask for the same chapter at once: share one request
function downloadChapter(voice, c) {
  const url = `${AUDIO_REMOTE}${voice}/${pad3(c)}.bin?v=${audio.index.version}`;
  if (!audio.inflight.has(url)) {
    audio.inflight.set(url, (async () => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bin = await res.blob();
      await (await caches.open(AUDIO_CACHE)).put(url, new Response(bin));
      audio.stored[voice].add(c);
      renderDownloads();
      return bin;
    })().finally(() => audio.inflight.delete(url)));
  }
  return audio.inflight.get(url);
}

// The clips of a chapter, or null when it isn't available (not rendered, or not downloaded and offline)
async function chapterClips(voice, c) {
  const key = `${voice}/${c}`;
  if (audio.memo.has(key)) return audio.memo.get(key);
  let clips = null;
  try {
    if (isShipped(voice, c)) {
      clips = slice(await (await fetch(`audio/${voice}/${pad3(c)}.bin`)).blob(), audio.shipped.voices[voice].chapters[c]);
    } else if (audio.index.voices[voice]?.chapters[c]) {
      const url = `${AUDIO_REMOTE}${voice}/${pad3(c)}.bin?v=${audio.index.version}`;
      const hit = await (await caches.open(AUDIO_CACHE)).match(url);
      const bin = hit ? await hit.blob() : await downloadChapter(voice, c);
      clips = slice(bin, audio.index.voices[voice].chapters[c]);
    }
  } catch {}
  if (clips) {
    audio.memo.clear(); // one chapter in memory is enough
    audio.memo.set(key, clips);
  }
  return clips;
}

const chaptersOf = r => Array.from({ length: r.end[0] - r.start[0] + 1 }, (_, i) => r.start[0] + i);

// The ranges the reader picked, newest first: each new pick jumps to the head of the queue
let picked = [];
function prioritize(p) {
  picked = [...new Set([...p.flatMap(chaptersOf), ...picked])];
  downloadInBackground();
}

// The chosen plan from where the reader is, then earlier picks, the reader's sequence, today's readings, and the rest in order
function downloadOrder() {
  const first = pos ? [...chaptersOf({ start: pos, end: plan[seg].end }), ...plan.slice(seg + 1).flatMap(chaptersOf)] : [];
  first.push(...picked, ...chainPlan().flatMap(chaptersOf), ...chaptersOf(todayMonth()), ...chaptersOf(todayWeek()));
  if (pos) first.push(...Array.from({ length: 150 - pos[0] + 1 }, (_, i) => pos[0] + i));
  return [...new Set([...first, ...Array.from({ length: 150 }, (_, i) => i + 1)])];
}

async function downloadInBackground() {
  if (audio.downloading) return;
  audio.downloading = true;
  try {
    for (;;) {
      const voice = recordedVoice();
      const next = voice && downloadOrder().find(c => audio.index.voices[voice].chapters[c] && !hasChapter(voice, c));
      if (!next) break;
      try {
        await downloadChapter(voice, next);
      } catch {
        break; // offline or failing: try again when the connection is back
      }
    }
  } finally {
    audio.downloading = false;
    renderDownloads();
  }
}
window.addEventListener('online', downloadInBackground);

function renderDownloads() {
  const voice = recordedVoice();
  const el = $('downloadStatus');
  el.hidden = !voice;
  if (!voice) return;
  const total = Object.keys(audio.index.voices[voice].chapters).length;
  const have = Object.keys(audio.index.voices[voice].chapters).filter(c => hasChapter(voice, Number(c))).length;
  el.textContent = have >= total ? `✓ כל ${total} הפרקים זמינים גם בלי אינטרנט`
    : `הורדו ${have} מתוך ${total} פרקים${audio.downloading ? ' · ממשיך להוריד ברקע' : ' · ההורדה תמשיך כשיהיה חיבור'}`;
}

// ---------- Speech ----------
const clipPlayer = new Audio();
let endClip = null;
function playClip(blob) {
  const url = URL.createObjectURL(blob);
  const started = performance.now();
  return new Promise(resolve => {
    endClip = () => {
      endClip = null;
      clipPlayer.onended = clipPlayer.onerror = null;
      URL.revokeObjectURL(url);
      resolve((performance.now() - started) / 1000);
    };
    clipPlayer.onended = clipPlayer.onerror = endClip;
    clipPlayer.src = url;
    clipPlayer.defaultPlaybackRate = clipPlayer.playbackRate = settings.rate; // a new src resets playbackRate
    clipPlayer.play().catch(() => endClip?.());
  });
}

// Plays clip `i` of chapter `c` (0 = the announcement, else the verse), or falls back to the phone's voice
async function say(c, i) {
  const voice = recordedVoice();
  const clips = voice && await chapterClips(voice, c);
  if (clips?.[i]) return playClip(clips[i]);
  return speak(i ? speakable(chapters[c - 1][i - 1], settings.nikudSpeech) : `פרק ${chapterName(c)}`);
}

// The chapter as it is called, by the names of its letters: 119 -> "קוף יוד טית"
const LETTER_NAMES = { א: 'אָלֶף', ב: 'בֵּית', ג: 'גִּימֶל', ד: 'דָּלֶת', ה: 'הֵא', ו: 'וָו', ז: 'זַיִן', ח: 'חֵית', ט: 'טֵית',
  י: 'יוּד', כ: 'כָּף', ל: 'לָמֶד', מ: 'מֵם', נ: 'נוּן', ס: 'סָמֶךְ', ע: 'עַיִן', פ: 'פֵּא', צ: 'צָדִי', ק: 'קוּף' };
function chapterName(c) {
  return [...hebNum(c).replace(/[׳״]/g, '')].map(l => LETTER_NAMES[l]).join(' ');
}

let liveUtterance = null; // keep a reference: Chrome drops events of garbage-collected utterances
async function speak(text) {
  if (native) {
    const started = performance.now();
    try {
      await native.speak({ text, rate: settings.rate, pitch: currentPitch(), voice: currentVoice()?.id || '' });
    } catch {
      renderVoiceHealth();
      await new Promise(r => setTimeout(r, 1000));
    }
    return (performance.now() - started) / 1000;
  }
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL';
    const voice = currentVoice()?.voice;
    if (voice) u.voice = voice;
    u.rate = settings.rate;
    u.pitch = currentPitch();
    let started = performance.now();
    u.onstart = () => { started = performance.now(); };
    u.onend = u.onerror = () => resolve((performance.now() - started) / 1000);
    liveUtterance = u;
    speechSynthesis.speak(u);
  });
}

function cancelSpeech() {
  clipPlayer.pause();
  endClip?.();
  if (native) native.stop();
  else speechSynthesis.cancel();
}

const sleep = (s, token) => new Promise(resolve => {
  const end = Date.now() + s * 1000;
  const tick = () => (token !== runToken || Date.now() >= end) ? resolve() : setTimeout(tick, 100);
  tick();
});

// ---------- Player state ----------
let plan = []; // segments read one after another: [{ start, end, label }]
let seg = 0; // the segment being read
let pos = null; // [chapter(1-based), verse(0-based)]
let playing = false;
let runToken = 0;

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
function step(p, dir) {
  let [c, v] = p;
  v += dir;
  if (v >= chapters[c - 1].length) { c++; v = 0; }
  if (v < 0) { c--; if (c < 1) return null; v = chapters[c - 1].length - 1; }
  if (c > 150) return null;
  return [c, v];
}
// The next verse in the plan: through the segment, then on to the next one
function advance(dir) {
  const next = step(pos, dir);
  const r = plan[seg];
  if (next && cmp(next, r.start) >= 0 && cmp(next, r.end) <= 0) return { seg, pos: next };
  const s = seg + dir;
  if (s < 0 || s >= plan.length) return null;
  return { seg: s, pos: [...(dir > 0 ? plan[s].start : plan[s].end)] };
}
function flatIndex(p) {
  let n = p[1];
  for (let c = 1; c < p[0]; c++) n += chapters[c - 1].length;
  return n;
}

function setStatus(text) { $('status').textContent = text; }

function render() {
  if (!pos) return;
  const [c, v] = pos;
  $('where').textContent = `פרק ${hebNum(c)} · פסוק ${hebNum(v + 1)}`;
  $('verse').textContent = chapters[c - 1][v].replaceAll(STRESS, '');
  const r = plan[seg];
  const sizes = plan.map(s => flatIndex(s.end) - flatIndex(s.start) + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  const done = sizes.slice(0, seg).reduce((a, b) => a + b, 0) + flatIndex(pos) - flatIndex(r.start);
  $('bar').style.width = `${(done / total) * 100}%`;
  $('segment').hidden = plan.length < 2;
  $('segment').textContent = `חלק ${seg + 1} מתוך ${plan.length} · ${r.label}`;
  $('fromSel').value = r.start[0];
  $('toSel').value = r.end[0];
  $('monthSel').value = 'month' in r ? r.month : '';
  $('weekSel').value = 'week' in r ? r.week : '';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `תהילים ${hebNum(c)}:${hebNum(v + 1)}`,
      artist: 'תהילים בדרך',
      artwork: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  }
  store.set('session', { plan, seg, pos });
}

function setPlan(p, label = p.length === 1 ? p[0].label : '') {
  stop();
  plan = p;
  seg = 0;
  pos = [...p[0].start];
  render();
  setStatus(label);
  $('resumeBtn').hidden = true;
  prioritize(p);
}

async function run() {
  const token = ++runToken;
  let lastChapter = null;
  while (playing && token === runToken) {
    render();
    const [c, v] = pos;
    const chapter = `${seg}:${c}`; // a chapter that comes again later in the plan is announced again
    if (settings.announce && v === 0 && lastChapter !== chapter) {
      setStatus('מכריז על הפרק');
      await say(c, 0);
      if (token !== runToken) return;
      await sleep(0.4, token);
    }
    lastChapter = chapter;
    setStatus('מקריא…');
    const duration = await say(c, v + 1);
    if (token !== runToken) return;
    const pause = settings.pause > 0 ? duration * settings.pause + 0.5 : 0.3;
    if (settings.pause > 0) setStatus('תורך לומר…');
    await sleep(pause, token);
    if (token !== runToken) return;
    const next = advance(1);
    if (!next) {
      stop();
      setStatus('סיימת. תזכו למצוות!');
      $('bar').style.width = '100%';
      return;
    }
    ({ seg, pos } = next);
  }
}

// Silent looping audio keeps the media session alive so lock-screen and car (Bluetooth) buttons work
const silence = native ? null : new Audio(URL.createObjectURL(silentWav()));
if (silence) silence.loop = true;
function silentWav() {
  const rate = 8000, n = rate;
  const buf = new DataView(new ArrayBuffer(44 + n));
  const str = (o, s) => [...s].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate, true); buf.setUint16(32, 1, true); buf.setUint16(34, 8, true);
  str(36, 'data'); buf.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf.setUint8(44 + i, 128);
  return new Blob([buf], { type: 'audio/wav' });
}

let wakeLock = null;
async function keepAwake(on) {
  if (native) return native.keepAwake({ on });
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (playing) keepAwake(true);
  else if (native) loadVoices(); // returning from the phone's speech settings
});

function updatePlayButton() {
  $('playBtn').classList.toggle('playing', playing);
  $('playBtn').setAttribute('aria-label', playing ? 'השהה' : 'נגן');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function play() {
  if (!pos) return;
  if (!voices.length) loadVoices();
  playing = true;
  updatePlayButton();
  silence?.play().catch(() => {});
  keepAwake(true);
  run();
}

function stop() {
  playing = false;
  runToken++;
  cancelSpeech();
  silence?.pause();
  keepAwake(false);
  updatePlayButton();
  if (pos) setStatus('מושהה');
}

function jump(dir) {
  if (!pos) return;
  const next = advance(dir);
  if (!next) return;
  ({ seg, pos } = next);
  runToken++;
  cancelSpeech();
  render();
  if (playing) run();
}

// ---------- Voice commands ----------
// "עבור / החלף / חזור ל(פרק) <chapter>", "פסוק הבא", "פסוק קודם". The chapter may come back from the
// recognizer as digits (121), letters (קכ"א), letter names (קוף כף אלף) or number words (מאה עשרים ואחת).
const GEMATRIA = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60,
  ע: 70, פ: 80, צ: 90, ק: 100 };
const SPOKEN_LETTERS = { אלף: 'א', בית: 'ב', גימל: 'ג', דלת: 'ד', הא: 'ה', הי: 'ה', היי: 'ה', וו: 'ו', ואו: 'ו', זין: 'ז',
  זיין: 'ז', חית: 'ח', חת: 'ח', טית: 'ט', טת: 'ט', יוד: 'י', כף: 'כ', כאף: 'כ', למד: 'ל', מם: 'מ', נון: 'נ', סמך: 'ס',
  עין: 'ע', עיין: 'ע', פא: 'פ', פה: 'פ', פי: 'פ', צדי: 'צ', צדיק: 'צ', קוף: 'ק' };
const NUMBER_WORDS = { אחד: 1, אחת: 1, שניים: 2, שנים: 2, שתיים: 2, שתים: 2, שני: 2, שתי: 2, שלוש: 3, שלושה: 3, שלש: 3,
  שלשה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, חמשה: 5, שש: 6, שישה: 6, ששה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9,
  תשעה: 9, עשר: 10, עשרה: 10, עשרים: 20, שלושים: 30, שלשים: 30, ארבעים: 40, חמישים: 50, חמשים: 50, שישים: 60, ששים: 60,
  שבעים: 70, שמונים: 80, תשעים: 90, מאה: 100 };

// Hebrew letters as a chapter number, only in their usual spelling (so a stray word isn't read as a number)
function lettersToNumber(s) {
  const letters = [...s.replace(/[ךםןףץ]/g, l => FINAL_FORMS[l])];
  if (!letters.length || letters.some(l => !GEMATRIA[l])) return null;
  const n = letters.reduce((sum, l) => sum + GEMATRIA[l], 0);
  return hebNum(n).replace(/[׳״]/g, '') === letters.join('') ? n : null;
}

function spokenChapter(s) {
  const words = s.split(' ').filter(Boolean);
  let n = null;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (words.length === 1) n = lettersToNumber(s);
  if (!n && words.every(w => SPOKEN_LETTERS[w])) n = lettersToNumber(words.map(w => SPOKEN_LETTERS[w]).join(''));
  // Hebrew cardinals are a plain sum: מאה עשרים ואחת = 100 + 20 + 1, חמש עשרה = 5 + 10
  const values = words.map(w => NUMBER_WORDS[w] ?? NUMBER_WORDS[w.replace(/^ו/, '')]);
  if (!n && values.every(Boolean)) n = values.reduce((a, b) => a + b, 0);
  return n >= 1 && n <= 150 ? n : null;
}

function parseCommand(heard) {
  const t = heard.replace(/["'״׳.,!?]/g, '').replace(/[-־]/g, ' ').replace(/\s+/g, ' ').trim();
  const verse = t.match(/פסוק (ה?בא|ה?קודם)/);
  if (verse) return { dir: verse[1].endsWith('בא') ? 1 : -1 };
  const go = t.match(/(?:^| )(?:ת|ל)?(?:עבור|חזור|החלף|החליף|חליף) (.+)$/);
  if (!go) return null;
  const rest = go[1].replace(/^(?:אל |ל ?)?פרק /, '');
  // "לקכא" is ל + קכא, but "למד" is the chapter itself: try the words as heard first
  const chapter = spokenChapter(rest) || spokenChapter(rest.replace(/^(?:אל |ל ?)/, ''));
  return chapter ? { chapter } : null;
}

// Within the plan when the chapter is in it (the current segment first), otherwise just that chapter
function goToChapter(c) {
  const has = i => c >= plan[i].start[0] && c <= plan[i].end[0];
  const at = has(seg) ? seg : plan.findIndex((_, i) => has(i));
  if (at >= 0) {
    stop();
    seg = at;
    pos = c === plan[at].start[0] ? [...plan[at].start] : [c, 0];
    render();
  } else {
    setPlan([chapterSegment(c)]);
  }
  setStatus(`פרק ${hebNum(c)}`);
}

const WebRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const canListen = !!native || !!WebRecognition;

// What the reader said, as the recognizer's guesses (best first)
function recognize() {
  if (native) return native.listen().then(r => r.matches || []);
  return new Promise((resolve, reject) => {
    const r = new WebRecognition();
    r.lang = 'he-IL';
    r.maxAlternatives = 5;
    let heard = [];
    r.onresult = e => { heard = [...e.results[0]].map(a => a.transcript); };
    r.onerror = e => reject(new Error(/not-allowed/.test(e.error) ? 'permission' : e.error));
    r.onend = () => resolve(heard);
    r.start();
  });
}

let listening = false;
async function listenForCommand() {
  if (listening || !pos) return;
  const resume = playing;
  stop(); // the recognizer would hear the reading
  listening = true;
  $('micBtn').classList.add('listening');
  setStatus('מקשיב… אמרו למשל "עבור לפרק כג" או "פסוק הבא"');
  let heard = [];
  try {
    heard = await recognize();
  } catch (e) {
    setStatus(e.message === 'permission' ? 'צריך לאשר גישה למיקרופון כדי לתת פקודות קוליות'
      : /network/.test(e.message) ? 'זיהוי הדיבור דורש חיבור לאינטרנט' : 'זיהוי הדיבור לא זמין');
    heard = null;
  } finally {
    listening = false;
    $('micBtn').classList.remove('listening');
  }
  const command = heard?.map(parseCommand).find(Boolean);
  if (command?.chapter) goToChapter(command.chapter);
  else if (command) jump(command.dir);
  else if (heard) setStatus(heard.length ? `לא הבנתי: "${heard[0]}"` : 'לא נשמעה פקודה');
  if (resume) play();
}

// ---------- Wiring ----------
for (const id of ['fromSel', 'toSel', 'chainFrom', 'chainTo']) {
  const sel = $(id);
  for (let c = 1; c <= 150; c++) sel.add(new Option(`${hebNum(c)} (${c})`, c));
}
$('fromSel').onchange = () => {
  const from = Number($('fromSel').value);
  const to = Math.max(from, Number($('toSel').value));
  setPlan([chapterSegment(from, to)]);
};
$('toSel').onchange = () => {
  const to = Number($('toSel').value);
  const from = Math.min(to, Number($('fromSel').value));
  setPlan([chapterSegment(from, to)]);
};
$('monthSel').onchange = e => { if (e.target.value !== '') setPlan([monthSegment(Number(e.target.value))]); };
$('weekSel').onchange = e => { if (e.target.value !== '') setPlan([weekSegment(Number(e.target.value))]); };
$('todayMonthBtn').onclick = () => setPlan([todayMonth()]);
$('todayWeekBtn').onclick = () => setPlan([todayWeek()]);
$('chainBtn').onclick = () => setPlan(chainPlan(), chainStatus());

// The date line and the "(היום)" marks follow the calendar while the app stays open
let shownDate = '';
function refreshToday() {
  const text = todayText();
  if (text === shownDate) return;
  shownDate = text;
  $('today').textContent = text;
  const today = todayMonth().month, weekday = new Date().getDay();
  const mark = (d, t) => d === t ? ' (היום)' : '';
  const month = $('monthSel'), week = $('weekSel');
  month.innerHTML = '';
  week.innerHTML = '';
  month.add(new Option('בחרו יום', ''));
  week.add(new Option('בחרו יום', ''));
  for (let d = 1; d <= 30; d++) {
    month.add(new Option(`${hebNum(d)} בחודש${mark(d, today)}`, d));
    if (d === 29) month.add(new Option(`כ״ט בחודש חסר${mark(0, today)}`, 0));
  }
  WEEKDAYS.forEach((name, d) => week.add(new Option(`יום ${name}${mark(d, weekday)}`, d)));
  if (pos) render();
}
refreshToday();
setInterval(refreshToday, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshToday(); });
$('playBtn').onclick = () => (playing ? stop() : play());
$('nextBtn').onclick = () => jump(1);
$('prevBtn').onclick = () => jump(-1);
$('micBtn').hidden = !canListen;
$('micBtn').onclick = listenForCommand;

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', stop);
  navigator.mediaSession.setActionHandler('nexttrack', () => jump(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => jump(-1));
}

if (!native) speechSynthesis.onvoiceschanged = loadVoices;
bindSettings();
bindChain();

const saved = store.get('session', null);
const savedPlan = saved?.plan || (saved?.range && [saved.range]); // older versions saved a single range
if (savedPlan && saved?.pos) {
  $('resumeBtn').hidden = false;
  $('resumeBtn').textContent = `המשך מפרק ${hebNum(saved.pos[0])} פסוק ${hebNum(saved.pos[1] + 1)}`;
  $('resumeBtn').onclick = () => {
    stop();
    plan = savedPlan;
    seg = saved.seg || 0;
    pos = saved.pos;
    render();
    setStatus('');
    $('resumeBtn').hidden = true;
    prioritize(plan);
  };
}
{
  // Open on the reader's sequence when there is one, otherwise on today's reading by the month
  plan = settings.chain.length ? chainPlan() : [todayMonth()];
  pos = [...plan[0].start];
  render();
  setStatus(settings.chain.length ? chainStatus() : plan[0].label);
  if (saved) store.set('session', saved);
}

splash.set(80);
await loadAudioIndex();
splash.set(90);
await loadVoices();
{
  const kind = $('voiceKind');
  for (const [id, label] of Object.entries(RECORDED)) if (audio.index?.voices[id] && canPlayOpus) kind.add(new Option(label, id), kind.options[kind.options.length - 1]);
  showVoiceKind();
}
splash.set(100);
await splash.done;
if (native && !recordedVoice() && voiceProblem()) $('settings').showModal();
downloadInBackground();

// ---------- App updates (APK only) ----------
const RELEASES_API = 'https://api.github.com/repos/ymalka82810/tehillim-whisper/releases/latest';
async function checkForUpdate(manual = false) {
  const { versionCode, versionName } = await native.appInfo();
  $('versionText').textContent = `גרסה ${versionName}`;
  try {
    const res = await fetch(RELEASES_API, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    const latest = Number(release.tag_name.match(/(\d+)$/)?.[1] || 0);
    const apk = release.assets.find(a => a.name.endsWith('.apk'));
    if (latest > versionCode && apk) {
      $('updateText').textContent = `גרסה חדשה זמינה (${release.tag_name.replace(/^v/, '')})`;
      $('updateBtn').onclick = () => native.openUrl({ url: apk.browser_download_url });
      $('updateBanner').hidden = false;
      if (manual) $('settings').close();
    } else if (manual) {
      $('versionText').textContent = `גרסה ${versionName} · זו הגרסה העדכנית`;
    }
  } catch {
    if (manual) $('versionText').textContent = `גרסה ${versionName} · אין חיבור לבדיקת עדכונים`;
  }
}
if (native) {
  $('checkUpdateBtn').onclick = () => checkForUpdate(true);
  checkForUpdate();
}

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
