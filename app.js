import { appInfo, findUpdate, installUpdate } from './updater.js';
import { hebNum, WEEKDAYS, hebrewDate } from './hebrew.js';
import { meta, content } from './app-config.js';

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
  const total = Number(res.headers.get('content-length')) || meta.dataSize; // no header → the data file's approximate size
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

const chapters = await fetchWithProgress(meta.data, f => splash.set(f * 70));
const book = content(chapters, store);
const UNITS = chapters.length;
splash.set(75);

// In the Android app, the WebView has no speechSynthesis, so speech goes through the native plugin.
// @capacitor/core isn't bundled, so call the plugin through the injected native bridge directly.
const native = window.Capacitor?.isNativePlatform?.()
  ? new Proxy({}, { get: (_, method) => options => window.Capacitor.nativePromise('NativeSpeech', method, options) })
  : null;
document.body.classList.add(native ? 'is-native' : 'is-web');

// ---------- Daily readings ----------
// A segment is a range to read with its name ({ start, end, label }); a reading plan is segments read one after another.
// The daily readings come from the app's config; a daily segment also carries which reading and day it is.
// A config may mark a day whose part isn't in the app yet with { missing: text }: it's shown, not read.
const dailySegment = (d, value) => ({ ...d.segment(value), daily: d.id, value });
const todaySegment = d => dailySegment(d, d.today());
const readable = s => !s.missing;
function openDaily(s) {
  if (s.missing) setStatus(s.missing);
  else setPlan([s]);
}

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
  chain: store.get('chain', []), // the reader's own sequence: [{ type: <daily id> } | { type: 'chapters', from, to }]
  noDownload: store.get('noDownload', []), // recorded voices the reader deleted: not kept offline until turned back on
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
  $('testVoice').onclick = () => { cancelSpeech(); say(...meta.testVerse); };
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
const dailyOf = item => book.dailies.find(d => d.id === item.type);
const chainItemLabel = item => dailyOf(item)?.chain || book.units(item.from, item.to);
// A daily reading the app no longer has is left out
const chainPlan = () => settings.chain.flatMap(item =>
  item.type === 'chapters' ? [book.unitSegment(item.from, item.to)] : dailyOf(item) ? [todaySegment(dailyOf(item))].filter(readable) : []);
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
  for (const d of book.dailies) type.add(new Option(d.chain, d.id), type.options[type.options.length - 1]);
  type.value = type.options[0].value;
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
// A chapter is one file, its clips back to back (clip 0 announces the chapter); <audio>/index.json has their lengths.
// The APK ships a few chapters (index.bundled); the rest download in the background and stay in the Cache API.
const AUDIO_REMOTE = native ? `https://ymalka82810.github.io/tehillim-whisper/${meta.audio}` : meta.audio;
const AUDIO_CACHE = meta.audioCache;
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
  if (native) audio.shipped = await fetch(`${meta.audio}index.json`).then(r => r.json()).catch(() => null);
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
      if (!settings.noDownload.includes(voice)) {
        await (await caches.open(AUDIO_CACHE)).put(url, new Response(bin));
        audio.stored[voice].add(c);
        renderDownloads();
      }
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
      clips = slice(await (await fetch(`${meta.audio}${voice}/${pad3(c)}.bin`)).blob(), audio.shipped.voices[voice].chapters[c]);
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
  first.push(...picked, ...chainPlan().flatMap(chaptersOf), ...book.dailies.map(todaySegment).filter(readable).flatMap(chaptersOf));
  if (pos) first.push(...Array.from({ length: UNITS - pos[0] + 1 }, (_, i) => pos[0] + i));
  return [...new Set([...first, ...Array.from({ length: UNITS }, (_, i) => i + 1)])];
}

async function downloadInBackground() {
  if (audio.downloading) return;
  audio.downloading = true;
  try {
    for (;;) {
      const voice = recordedVoice();
      const next = voice && !settings.noDownload.includes(voice) && downloadOrder().find(c => audio.index.voices[voice].chapters[c] && !hasChapter(voice, c));
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
  renderVoiceFiles();
  const voice = recordedVoice();
  const el = $('downloadStatus');
  el.hidden = !voice;
  if (!voice) return;
  if (settings.noDownload.includes(voice)) {
    el.textContent = 'ההורדה כבויה לקול הזה: כל פרק יורד מהאינטרנט בזמן ההקראה ולא נשמר';
    return;
  }
  const total = Object.keys(audio.index.voices[voice].chapters).length;
  const have = Object.keys(audio.index.voices[voice].chapters).filter(c => hasChapter(voice, Number(c))).length;
  el.textContent = have >= total ? `✓ כל ${total} הפרקים זמינים גם בלי אינטרנט`
    : `הורדו ${have} מתוך ${total} פרקים${audio.downloading ? ' · ממשיך להוריד ברקע' : ' · ההורדה תמשיך כשיהיה חיבור'}`;
}

function setNoDownload(voice, off) {
  settings.noDownload = off ? [...new Set([...settings.noDownload, voice])] : settings.noDownload.filter(v => v !== voice);
  store.set('noDownload', settings.noDownload);
}

// Chapters shipped inside the APK can't be removed; everything downloaded goes
async function deleteVoice(voice) {
  if (!confirm(`למחוק את קבצי הקול של ${RECORDED[voice]}? הקול לא יורד שוב עד שתפעילו את ההורדה מחדש.`)) return;
  setNoDownload(voice, true);
  const cache = await caches.open(AUDIO_CACHE);
  for (const req of await cache.keys()) if (req.url.includes(`/${voice}/`)) await cache.delete(req);
  audio.stored[voice] = new Set();
  audio.memo.clear();
  renderDownloads();
}

function renderVoiceFiles() {
  const ids = Object.keys(RECORDED).filter(id => canPlayOpus && audio.index?.voices[id]);
  $('voiceFiles').hidden = !ids.length;
  const list = $('voiceFilesList');
  list.innerHTML = '';
  for (const id of ids) {
    const off = settings.noDownload.includes(id);
    const count = audio.stored[id]?.size || 0;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${RECORDED[id]} · ${off ? 'ההורדה כבויה' : `${count} פרקים שמורים`}`;
    const b = document.createElement('button');
    b.type = 'button';
    if (off) {
      b.textContent = 'הפעלת הורדה';
      b.onclick = () => { setNoDownload(id, false); renderDownloads(); downloadInBackground(); };
    } else {
      b.textContent = 'מחיקה';
      b.disabled = !count;
      b.onclick = () => deleteVoice(id);
    }
    li.append(name, b);
    list.append(li);
  }
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
  return speak(i ? speakable(chapters[c - 1][i - 1], settings.nikudSpeech) : book.announcement(c));
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
  if (c > UNITS) return null;
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
  $('where').textContent = book.where(c, v);
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
  if (r.daily && $(`${r.daily}Sel`)) $(`${r.daily}Sel`).value = r.value;
  syncDaily(r);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.mediaTitle(c, v),
      artist: meta.name,
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

function spokenNumber(s) {
  const words = s.split(' ').filter(Boolean);
  let n = null;
  if (/^\d+$/.test(s)) n = Number(s);
  else if (words.length === 1) n = lettersToNumber(s);
  if (!n && words.every(w => SPOKEN_LETTERS[w])) n = lettersToNumber(words.map(w => SPOKEN_LETTERS[w]).join(''));
  // Hebrew cardinals are a plain sum: מאה עשרים ואחת = 100 + 20 + 1, חמש עשרה = 5 + 10
  const values = words.map(w => NUMBER_WORDS[w] ?? NUMBER_WORDS[w.replace(/^ו/, '')]);
  if (!n && values.every(Boolean)) n = values.reduce((a, b) => a + b, 0);
  return n || null;
}
const spokenChapter = s => {
  const n = spokenNumber(s);
  return n >= 1 && n <= UNITS ? n : null;
};

// Where "עבור ל…" goes, as { chapter } or { segment }. An app's config may name its own places (book.goTo).
function goToTarget(rest) {
  if (book.goTo) return book.goTo(rest, spokenNumber, pos);
  rest = rest.replace(/^(?:אל |ל ?)?פרק /, '');
  // "לקכא" is ל + קכא, but "למד" is the chapter itself: try the words as heard first
  const chapter = spokenChapter(rest) || spokenChapter(rest.replace(/^(?:אל |ל ?)/, ''));
  return chapter ? { chapter } : null;
}

function parseCommand(heard) {
  const t = heard.replace(/["'״׳.,!?]/g, '').replace(/[-־]/g, ' ').replace(/\s+/g, ' ').trim();
  const verse = t.match(/פסוק (ה?בא|ה?קודם)/);
  if (verse) return { dir: verse[1].endsWith('בא') ? 1 : -1 };
  const go = t.match(/(?:^| )(?:ת|ל)?(?:עבור|חזור|החלף|החליף|חליף) (.+)$/);
  return go ? goToTarget(go[1]) : null;
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
    setPlan([book.unitSegment(c)]);
  }
  setStatus(book.unit(c));
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
  setStatus(`מקשיב… ${book.commandExample || 'אמרו למשל "עבור לפרק כג" או "פסוק הבא"'}`);
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
  else if (command?.segment) setPlan([command.segment]);
  else if (command) jump(command.dir);
  else if (heard) setStatus(`${heard.length ? `לא הבנתי: "${heard[0]}"` : 'לא נשמעה פקודה'} · רשימת הפקודות בהגדרות`);
  if (resume) play();
}

// ---------- Wiring ----------
$('bundledNote').textContent = `כמה פרקים (${meta.bundled.map(c => book.unit(c).replace(/^פרק /, '').replace(/[׳״]/g, '')).join(', ')}) ארוזים בתוך האפליקציה ולא נמחקים, כך שאפשר להקריא אותם גם בלי אינטרנט.`;
$('commandRange').textContent = `אפשר מ${book.unit(1)} עד ${book.unit(UNITS)}.`;
if (book.commandsHelp) $('gotoHelp').innerHTML = book.commandsHelp;
$('textCredit').innerHTML = meta.credit;
// Grouped when the app's units belong to books (book.unitGroup)
for (const id of ['fromSel', 'toSel', 'chainFrom', 'chainTo']) {
  const sel = $(id);
  let group = null;
  for (let c = 1; c <= UNITS; c++) {
    const name = book.unitGroup?.(c);
    if (name && name !== group?.label) sel.append(group = Object.assign(document.createElement('optgroup'), { label: name }));
    (group || sel).append(new Option(book.unitOption(c), c));
  }
}
$('fromSel').onchange = () => {
  const from = Number($('fromSel').value);
  const to = Math.max(from, Number($('toSel').value));
  setPlan([book.unitSegment(from, to)]);
};
$('toSel').onchange = () => {
  const to = Number($('toSel').value);
  const from = Math.min(to, Number($('fromSel').value));
  setPlan([book.unitSegment(from, to)]);
};

// Each daily button reads the day shown under it: today, unless another was picked with its pencil
const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2zm15.7-8.9a1 1 0 0 0 0-1.4l-2.6-2.6a1 1 0 0 0-1.4 0l-2 2 4 4 2-2z"/></svg>';
for (const d of book.dailies) {
  const item = document.createElement('div');
  item.className = 'daily-item';
  item.innerHTML = `<button id="${d.id}Btn" type="button"></button><label class="edit" title="בחירת יום אחר">${PENCIL}<select id="${d.id}Sel"></select></label>`;
  $('daily').append(item);
  const btn = $(`${d.id}Btn`), sel = $(`${d.id}Sel`);
  btn.append(`${d.button} `, Object.assign(document.createElement('small'), { id: `${d.id}Day` }));
  sel.setAttribute('aria-label', d.pick);
  btn.onclick = sel.onchange = () => openDaily(dailySegment(d, Number(sel.value)));
}
function syncDaily(r = pos && plan[seg]) {
  for (const d of book.dailies) {
    $(`${d.id}Day`).textContent = $(`${d.id}Sel`).selectedOptions[0]?.text ?? '';
    $(`${d.id}Btn`).classList.toggle('active', !!r && plan.length === 1 && r.daily === d.id);
  }
}
$('chainBtn').onclick = () => {
  const p = chainPlan();
  if (p.length) setPlan(p, chainStatus());
  else setStatus(book.dailies.map(todaySegment).find(s => s.missing)?.missing || '');
};

// The date line and the "(היום)" marks follow the calendar while the app stays open
let shownDate = '';
function refreshToday(force = false) {
  const text = todayText();
  if (text === shownDate && !force) return;
  shownDate = text;
  $('today').textContent = text;
  for (const d of book.dailies) {
    const sel = $(`${d.id}Sel`), today = d.today();
    sel.innerHTML = '';
    for (const { value, label } of d.options(today)) sel.add(new Option(label, value));
    sel.value = today;
  }
  if (pos) render();
  else syncDaily();
}
refreshToday();
setInterval(refreshToday, 60000);

// The app's own settings (book.settings), such as which calendar the weekly parsha follows. They change the daily readings.
for (const s of book.settings || []) {
  const label = document.createElement('label');
  const sel = document.createElement('select');
  for (const { value, label: text } of s.choices) sel.add(new Option(text, value));
  sel.value = store.get(s.key, s.default);
  label.append(`${s.label} `, sel);
  $('appSettings').append(label);
  if (s.hint) $('appSettings').append(Object.assign(document.createElement('p'), { className: 'hint', textContent: s.hint }));
  sel.onchange = () => {
    // A daily reading being shown follows the new setting: today's stays today's, another day stays that day
    const r = plan[seg];
    const d = plan.length === 1 && r?.daily && dailyOf({ type: r.daily });
    const wasToday = d && r.value === d.today();
    store.set(s.key, sel.value);
    refreshToday(true);
    if (d) openDaily(wasToday ? todaySegment(d) : dailySegment(d, r.value));
    else downloadInBackground();
  };
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshToday(); });
$('playBtn').onclick = () => (playing ? stop() : play());
$('nextBtn').onclick = () => jump(1);
$('prevBtn').onclick = () => jump(-1);
$('micBtn').hidden = !canListen;
$('commandsHelp').hidden = !canListen;
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
{
  // Open on the reader's sequence when there is one, otherwise on the first daily reading of today
  // (or, when today's part isn't in the app, on the first unit, saying so)
  const chain = chainPlan();
  const today = todaySegment(book.dailies[0]);
  plan = chain.length ? chain : [readable(today) ? today : book.unitSegment(1)];
  pos = [...plan[0].start];
  render();
  setStatus(chain.length ? chainStatus() : today.missing || plan[0].label);
  if (saved) store.set('session', saved);
}
// Offer to resume only when it would land somewhere other than where the app just opened
const sameAsOpening = JSON.stringify([savedPlan, saved?.seg || 0, saved?.pos]) === JSON.stringify([plan, seg, pos]);
if (savedPlan && saved?.pos && !sameAsOpening) {
  $('resumeBtn').hidden = false;
  $('resumeBtn').textContent = `המשך מ${book.where(...saved.pos).replace(' · ', ' ')}`;
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
// The APK downloads inside the app and the system install dialog opens, so updating is one tap
const UPDATE_ERRORS = {
  permission: 'כדי לעדכן, יש לאשר לאפליקציה להתקין עדכונים',
  'not an update': 'הקובץ שהורד אינו גרסה חדשה של האפליקציה',
  'no installer': 'לא נמצא במכשיר רכיב התקנה',
};
async function checkForUpdate(manual = false) {
  const { versionName } = await appInfo();
  $('versionText').textContent = `גרסה ${versionName}`;
  try {
    const update = await findUpdate('ymalka82810/tehillim-whisper', meta.releaseTag);
    if (update) {
      $('updateText').textContent = `גרסה חדשה זמינה (${update.version})`;
      $('updateBtn').onclick = () => startUpdate(update);
      $('updateBanner').hidden = false;
      if (manual) $('settings').close();
    } else if (manual) {
      $('versionText').textContent = `גרסה ${versionName} · זו הגרסה העדכנית`;
    }
  } catch {
    if (manual) $('versionText').textContent = `גרסה ${versionName} · אין חיבור לבדיקת עדכונים`;
  }
}
async function startUpdate(update) {
  const btn = $('updateBtn');
  btn.disabled = true;
  $('updateText').textContent = 'מוריד את העדכון…';
  try {
    await installUpdate(update.url, percent => {
      if (percent >= 0) $('updateText').textContent = `מוריד את העדכון… ${percent}%`;
    });
    $('updateText').textContent = `גרסה חדשה זמינה (${update.version})`;
  } catch (e) {
    $('updateText').textContent = UPDATE_ERRORS[e.message] || 'ההורדה נכשלה, נסו שוב';
  }
  btn.disabled = false;
}
if (native) {
  $('checkUpdateBtn').onclick = () => checkForUpdate(true);
  checkForUpdate();
}

if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
