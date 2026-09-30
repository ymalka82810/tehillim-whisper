// Copies the static web app into www/ for Capacitor (the repo root is also served as-is by GitHub Pages)
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';

const FILES = ['index.html', 'style.css', 'app.js', 'updater.js', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'data'];
// Recorded chapters shipped inside the APK, so reading can start before anything downloads:
// the first chapter of each weekday's reading and of each of the five books. The rest download in the background.
const BUNDLED = [1, 30, 42, 51, 73, 90, 107, 120];
const root = new URL('../', import.meta.url);
const out = new URL('../www/', import.meta.url);

await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const f of FILES) await cp(new URL(f, root), new URL(f, out), { recursive: true });

const index = JSON.parse(await readFile(new URL('audio/index.json', root), 'utf8').catch(() => 'null'));
if (index) {
  index.bundled = BUNDLED;
  for (const [voice, { chapters }] of Object.entries(index.voices)) {
    await mkdir(new URL(`audio/${voice}/`, out), { recursive: true });
    for (const c of BUNDLED.filter(c => chapters[c])) {
      const name = `audio/${voice}/${String(c).padStart(3, '0')}.bin`;
      await cp(new URL(name, root), new URL(name, out));
    }
  }
  await writeFile(new URL('audio/index.json', out), JSON.stringify(index));
}
console.log('www/ ready');
