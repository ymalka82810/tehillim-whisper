// Copies one app's static web app into www/ for Capacitor (the repo root is also served as-is by GitHub Pages, as Tehillim)
// Usage: node scripts/build-www.mjs [tehillim|chumash|tanya]
import { cp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';

const app = process.argv[2] || 'tehillim';
const root = new URL('../', import.meta.url);
const out = new URL('../www/', import.meta.url);
const { meta } = await import(new URL(`apps/${app}/config.js`, root));

const SHARED = ['index.html', 'style.css', 'app.js', 'updater.js', 'hebrew.js', 'sw.js'];
const exists = url => access(url).then(() => true, () => false);
// An app's own icon and manifest are in apps/<app>/; Tehillim's are the ones at the root
const own = async name => (await exists(new URL(`apps/${app}/${name}`, root))) ? `apps/${app}/${name}` : name;

await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const f of SHARED) await cp(new URL(f, root), new URL(f, out));
await cp(new URL(`apps/${app}/`, root), new URL(`apps/${app}/`, out), { recursive: true });
await cp(new URL(meta.data, root), new URL(meta.data, out));
for (const f of ['icon.svg', 'manifest.webmanifest']) await cp(new URL(await own(f), root), new URL(f, out));
await writeFile(new URL('app-config.js', out), `export * from './apps/${app}/config.js';\n`);

// The name shows on the splash before the app's script runs, so it goes into the page itself
const tehillim = (await import(new URL('apps/tehillim/config.js', root))).meta;
const page = await readFile(new URL('index.html', out), 'utf8');
await writeFile(new URL('index.html', out), page.replaceAll(tehillim.name, meta.name).replaceAll(tehillim.tagline, meta.tagline));

const index = JSON.parse(await readFile(new URL(`${meta.audio}index.json`, root), 'utf8').catch(() => 'null'));
if (index) {
  index.bundled = meta.bundled;
  for (const [voice, { chapters }] of Object.entries(index.voices)) {
    await mkdir(new URL(`${meta.audio}${voice}/`, out), { recursive: true });
    for (const c of meta.bundled.filter(c => chapters[c])) {
      const name = `${meta.audio}${voice}/${String(c).padStart(3, '0')}.bin`;
      await cp(new URL(name, root), new URL(name, out));
    }
  }
  await writeFile(new URL(`${meta.audio}index.json`, out), JSON.stringify(index));
}
console.log(`www/ ready: ${meta.name}`);
