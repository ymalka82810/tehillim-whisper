// Records a voice prompt for cloning (scripts/audio/render.py --clone) and hands it back as a WAV file.
// Everything stays in the browser: the samples are captured raw and encoded here, nothing is uploaded.
const $ = id => document.getElementById(id);
const STRESS = '֫';
const MIN_S = 12, MAX_S = 30; // the cloner uses the first 20 seconds

const chapters = await fetch('data/tehillim.json').then(r => r.json());
$('script').textContent = chapters[22].map(v => v.replaceAll(STRESS, '')).join(' '); // Psalm 23

$('consent').onchange = () => { $('recBtn').disabled = !$('consent').checked; };

// Raw samples come from a small worklet; MediaRecorder would give WebM/Opus, which the Python side can't read
const WORKLET = `registerProcessor('tap', class extends AudioWorkletProcessor {
  process([input]) { if (input[0]) this.port.postMessage(input[0].slice()); return true; }
});`;

let session;

async function start() {
  note('');
  let stream;
  try {
    // No browser clean-up: noise suppression and gain control color the voice the model should copy
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    return note('אין גישה למיקרופון. אשרו לדפדפן להשתמש במיקרופון ונסו שוב.', true);
  }
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const tap = new AudioWorkletNode(ctx, 'tap');
  const chunks = [];
  let peak = 0;
  tap.port.onmessage = ({ data }) => {
    chunks.push(data);
    for (const s of data) peak = Math.max(peak, Math.abs(s));
  };
  ctx.createMediaStreamSource(stream).connect(tap);
  const started = performance.now();
  session = { stream, ctx, chunks, started };
  const tick = () => {
    if (!session) return;
    const s = (performance.now() - started) / 1000;
    $('timer').textContent = `0:${String(Math.floor(s)).padStart(2, '0')}`;
    $('level').style.width = `${Math.min(100, peak * 140)}%`;
    $('level').classList.toggle('loud', peak > 0.97);
    peak *= 0.85;
    if (s >= MAX_S) return stop();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  $('recBtn').hidden = true;
  $('stopBtn').hidden = false;
  $('result').hidden = true;
}

function stop() {
  const { stream, ctx, chunks, started } = session;
  session = null;
  stream.getTracks().forEach(t => t.stop());
  ctx.close();
  $('recBtn').hidden = false;
  $('recBtn').textContent = '⏺ הקלטה מחדש';
  $('stopBtn').hidden = true;
  $('level').style.width = '0';

  const seconds = (performance.now() - started) / 1000;
  const samples = trim(concat(chunks), ctx.sampleRate);
  const top = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  if (seconds < MIN_S) return note(`ההקלטה קצרה מדי (${Math.round(seconds)} שניות). צריך לפחות ${MIN_S}, עדיף 20.`, true);
  if (top < 0.05) return note('כמעט לא נשמע קול. קרבו את המיקרופון ונסו שוב.', true);
  if (top > 0.99) note('ההקלטה חזקה מדי ונשמעת צורמת. אפשר להתרחק מעט מהמיקרופון ולהקליט שוב.', true);
  else note('ההקלטה מוכנה. האזינו לה, ואם היא נשמעת טוב שמרו את הקובץ.');

  const wav = encodeWav(samples.map(s => s * 0.9 / top), ctx.sampleRate);
  const name = `voice-${new Date().toISOString().slice(0, 10)}.wav`;
  const url = URL.createObjectURL(wav);
  $('player').src = url;
  $('saveBtn').href = url;
  $('saveBtn').download = name;
  const file = new File([wav], name, { type: 'audio/wav' });
  $('shareBtn').hidden = !navigator.canShare?.({ files: [file] });
  $('shareBtn').onclick = () => navigator.share({ files: [file], title: 'הקלטת קול' }).catch(() => {});
  $('result').hidden = false;
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Drops the silence before the first word and after the last, as trim() in render.py
function trim(samples, rate, threshold = 0.02, margin = 0.15) {
  const first = samples.findIndex(s => Math.abs(s) > threshold);
  if (first < 0) return samples;
  let last = samples.length - 1;
  while (Math.abs(samples[last]) <= threshold) last--;
  const pad = Math.round(margin * rate);
  return samples.slice(Math.max(0, first - pad), last + pad);
}

// 16-bit mono PCM, which render.py reads without extra codecs
function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([view], { type: 'audio/wav' });
}

function note(text, bad = false) {
  $('note').textContent = text;
  $('note').classList.toggle('bad', bad);
}

$('recBtn').onclick = start;
$('stopBtn').onclick = stop;
