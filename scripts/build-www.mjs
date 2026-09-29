// Copies the static web app into www/ for Capacitor (the repo root is also served as-is by GitHub Pages)
import { cp, rm, mkdir } from 'node:fs/promises';

const FILES = ['index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'data'];
const out = new URL('../www/', import.meta.url);

await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const f of FILES) await cp(new URL(`../${f}`, import.meta.url), new URL(f, out), { recursive: true });
console.log('www/ ready');
