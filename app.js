const $ = id => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const chapters = await (await fetch('data/tehillim.json')).json();

// ---------- Hebrew numerals ----------
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
function hebNum(n) {
  let s = n >= 100 ? 'ק' : '';
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

function hebrewDay(date) {
  return Number(new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric' }).format(date));
}

function monthRange() {
  const now = new Date();
  const day = hebrewDay(now);
  const tomorrow = new Date(now.getTime() + 86400000);
  const shortMonthEnd = day === 29 && hebrewDay(tomorrow) === 1;
  const [a, av, b, bv] = MONTH[day - 1];
  if (shortMonthEnd) return { range: makeRange(140, 150), label: `יום כ״ט (חודש חסר) · פרקים קמ–קנ` };
  const range = makeRange(a, b, av, bv);
  const label = a === b ? `פרק ${hebNum(a)} פסוקים ${hebNum(av)}–${hebNum(bv ?? chapters[b - 1].length)}` : `פרקים ${hebNum(a)}–${hebNum(b)}`;
  return { range, label: `יום ${hebNum(day)} בחודש · ${label}` };
}

function weekRange() {
  const d = new Date().getDay();
  const [a, b] = WEEK[d];
  return { range: makeRange(a, b), label: `יום ${WEEKDAYS[d]} · פרקים ${hebNum(a)}–${hebNum(b)}` };
}

// ---------- Speech text ----------
const MARKS = /[ְ-ׇ]/g;
function speakable(text, withNikud) {
  let t = text.replace(/׃/g, '').replace(/־/g, ' ');
  t = t.split(' ').map(word => {
    const letters = word.replace(MARKS, '');
    const m = letters.match(/^([ובלכמשה]{0,2})יהוה$/);
    if (!m) return word;
    const prefix = word.match(/^(.*?)י[ְ-ׇ]*ה[ְ-ׇ]*ו/)[1];
    const elohim = /ִ/.test(word.slice(word.lastIndexOf('ו')));
    return prefix + (elohim ? 'אֱלֹהִים' : 'אֲדֹנָי');
  }).join(' ');
  t = t.replace(/ׇ/g, 'ֹ');
  return withNikud ? t : t.replace(MARKS, '');
}

// ---------- Settings ----------
const settings = {
  voiceURI: store.get('voiceURI', null),
  rate: store.get('rate', 0.9),
  pause: store.get('pause', 1),
  nikudSpeech: store.get('nikudSpeech', true),
  announce: store.get('announce', true),
};

let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices().filter(v => /^(he|iw)/i.test(v.lang));
  const sel = $('voiceSel');
  sel.innerHTML = '';
  for (const v of voices) sel.add(new Option(`${v.name}${v.localService ? '' : ' (אונליין)'}`, v.voiceURI));
  if (!voices.length) sel.add(new Option('לא נמצא קול עברי', ''));
  if (settings.voiceURI && voices.some(v => v.voiceURI === settings.voiceURI)) sel.value = settings.voiceURI;
  if (!voices.length && speechSynthesis.getVoices().length) {
    setStatus('לא נמצא קול עברי במכשיר. יש להתקין קול עברי בהגדרות ההקראה (Text-to-speech) של הטלפון.');
  }
}
const currentVoice = () => voices.find(v => v.voiceURI === settings.voiceURI) || voices[0] || null;

function bindSettings() {
  const rate = $('rate'), pause = $('pause');
  rate.value = settings.rate;
  pause.value = settings.pause;
  $('nikudSpeech').checked = settings.nikudSpeech;
  $('announce').checked = settings.announce;
  const show = () => {
    $('rateOut').textContent = `×${Number(settings.rate).toFixed(2)}`;
    $('pauseOut').textContent = Number(settings.pause) === 0 ? 'ללא' : `×${Number(settings.pause).toFixed(1)}`;
  };
  show();
  const save = (key, value) => { settings[key] = value; store.set(key, value); show(); };
  rate.oninput = () => save('rate', Number(rate.value));
  pause.oninput = () => save('pause', Number(pause.value));
  $('nikudSpeech').onchange = e => save('nikudSpeech', e.target.checked);
  $('announce').onchange = e => save('announce', e.target.checked);
  $('voiceSel').onchange = e => save('voiceURI', e.target.value);
  $('settingsBtn').onclick = () => $('settings').showModal();
  $('testVoice').onclick = () => { speechSynthesis.cancel(); speak(speakable(chapters[22][0], settings.nikudSpeech)); };
}

// ---------- Speech ----------
let liveUtterance = null; // keep a reference: Chrome drops events of garbage-collected utterances
function speak(text) {
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL';
    const voice = currentVoice();
    if (voice) u.voice = voice;
    u.rate = settings.rate;
    let started = performance.now();
    u.onstart = () => { started = performance.now(); };
    u.onend = u.onerror = () => resolve((performance.now() - started) / 1000);
    liveUtterance = u;
    speechSynthesis.speak(u);
  });
}

const sleep = (s, token) => new Promise(resolve => {
  const end = Date.now() + s * 1000;
  const tick = () => (token !== runToken || Date.now() >= end) ? resolve() : setTimeout(tick, 100);
  tick();
});

// ---------- Player state ----------
let range = null;
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
  $('verse').textContent = chapters[c - 1][v];
  const total = flatIndex(range.end) - flatIndex(range.start) + 1;
  const done = flatIndex(pos) - flatIndex(range.start);
  $('bar').style.width = `${(done / total) * 100}%`;
  $('fromSel').value = range.start[0];
  $('toSel').value = range.end[0];
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `תהילים ${hebNum(c)}:${hebNum(v + 1)}`,
      artist: 'תהילים בדרך',
      artwork: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  }
  store.set('session', { range, pos });
}

function setRange(r, label) {
  stop();
  range = r;
  pos = [...r.start];
  render();
  setStatus(label || '');
  $('resumeBtn').hidden = true;
}

async function run() {
  const token = ++runToken;
  let lastChapter = null;
  while (playing && token === runToken) {
    render();
    const [c, v] = pos;
    if (settings.announce && v === 0 && lastChapter !== c) {
      setStatus('מכריז על הפרק');
      await speak(`פרק ${c}`);
      if (token !== runToken) return;
      await sleep(0.4, token);
    }
    lastChapter = c;
    setStatus('מקריא…');
    const duration = await speak(speakable(chapters[c - 1][v], settings.nikudSpeech));
    if (token !== runToken) return;
    const pause = settings.pause > 0 ? duration * settings.pause + 0.5 : 0.3;
    if (settings.pause > 0) setStatus('תורך לומר…');
    await sleep(pause, token);
    if (token !== runToken) return;
    const next = step(pos, 1);
    if (!next || cmp(next, range.end) > 0) {
      playing = false;
      updatePlayButton();
      setStatus('סיימת. תזכו למצוות!');
      $('bar').style.width = '100%';
      return;
    }
    pos = next;
  }
}

// Silent looping audio keeps the media session alive so lock-screen and car (Bluetooth) buttons work
const silence = new Audio(URL.createObjectURL(silentWav()));
silence.loop = true;
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
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (playing && document.visibilityState === 'visible') keepAwake(true); });

function updatePlayButton() {
  $('playBtn').textContent = playing ? '⏸' : '▶';
  $('playBtn').setAttribute('aria-label', playing ? 'השהה' : 'נגן');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function play() {
  if (!pos) return;
  if (!voices.length) loadVoices();
  playing = true;
  updatePlayButton();
  silence.play().catch(() => {});
  keepAwake(true);
  run();
}

function stop() {
  playing = false;
  runToken++;
  speechSynthesis.cancel();
  silence.pause();
  keepAwake(false);
  updatePlayButton();
  if (pos) setStatus('מושהה');
}

function jump(dir) {
  if (!pos) return;
  const next = step(pos, dir);
  if (!next || cmp(next, range.start) < 0 || cmp(next, range.end) > 0) return;
  pos = next;
  runToken++;
  speechSynthesis.cancel();
  render();
  if (playing) run();
}

// ---------- Wiring ----------
for (const id of ['fromSel', 'toSel']) {
  const sel = $(id);
  for (let c = 1; c <= 150; c++) sel.add(new Option(`${hebNum(c)} (${c})`, c));
}
$('fromSel').onchange = () => {
  const from = Number($('fromSel').value);
  const to = Math.max(from, Number($('toSel').value));
  setRange(makeRange(from, to));
};
$('toSel').onchange = () => {
  const to = Number($('toSel').value);
  const from = Math.min(to, Number($('fromSel').value));
  setRange(makeRange(from, to));
};
$('todayMonthBtn').onclick = () => { const { range, label } = monthRange(); setRange(range, label); };
$('todayWeekBtn').onclick = () => { const { range, label } = weekRange(); setRange(range, label); };
$('playBtn').onclick = () => (playing ? stop() : play());
$('nextBtn').onclick = () => jump(1);
$('prevBtn').onclick = () => jump(-1);

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', stop);
  navigator.mediaSession.setActionHandler('nexttrack', () => jump(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => jump(-1));
}

speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();
bindSettings();

const saved = store.get('session', null);
if (saved?.range && saved?.pos) {
  $('resumeBtn').hidden = false;
  $('resumeBtn').textContent = `המשך מפרק ${hebNum(saved.pos[0])} פסוק ${hebNum(saved.pos[1] + 1)}`;
  $('resumeBtn').onclick = () => {
    stop();
    range = saved.range;
    pos = saved.pos;
    render();
    setStatus('');
    $('resumeBtn').hidden = true;
  };
}
{
  const { range: r, label } = monthRange();
  range = r;
  pos = [...r.start];
  render();
  setStatus(label);
  if (saved) store.set('session', saved);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
