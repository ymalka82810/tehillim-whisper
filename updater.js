// Self-update for a sideloaded Capacitor APK, published as a GitHub release asset.
// Talks to the native AppUpdater plugin (AppUpdaterPlugin.java) through the injected bridge,
// so it works without bundling @capacitor/core.

const cap = window.Capacitor;
const call = (method, options) => cap.nativePromise('AppUpdater', method, options);

export const isNativeApp = !!cap?.isNativePlatform?.();

// {versionCode, versionName} of the installed APK
export const appInfo = () => call('appInfo');

// The newest release of this app in `owner/repo` if it's newer than the installed APK, else null.
// The repo publishes several apps: this one's tags are `tag` then the version (v1.0.12, chumash-v1.0.12),
// ending with the release's versionCode (v1.4.0-12 → 12). The release must carry an .apk asset.
export async function findUpdate(repo, tag) {
  const { versionCode } = await appInfo();
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ours = new RegExp(`^${tag}\\d`);
  const release = (await res.json()).find(r => !r.draft && !r.prerelease && ours.test(r.tag_name));
  if (!release) return null;
  const latest = Number(release.tag_name.match(/(\d+)$/)?.[1] || 0);
  const apk = release.assets.find(a => a.name.endsWith('.apk'));
  if (latest <= versionCode || !apk) return null;
  return { version: release.tag_name.slice(tag.length), url: apk.browser_download_url };
}

// Downloads the APK (in the system DownloadManager, so it goes on when the user leaves the app) and opens
// the system install dialog, once the app is in the foreground. onProgress gets 0–100 (-1 if the size is unknown).
// Rejects with an Error whose message is "busy", "bad url", "download", "not an update", "permission" or "no installer".
export async function installUpdate(url, onProgress) {
  const listener = onProgress && cap.addListener('AppUpdater', 'progress', e => onProgress(e.percent));
  try {
    await call('downloadAndInstall', { url });
  } finally {
    listener?.remove();
  }
}
