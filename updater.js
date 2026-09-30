// Self-update for a sideloaded Capacitor APK, published as a GitHub release asset.
// Talks to the native AppUpdater plugin (AppUpdaterPlugin.java) through the injected bridge,
// so it works without bundling @capacitor/core.

const cap = window.Capacitor;
const call = (method, options) => cap.nativePromise('AppUpdater', method, options);

export const isNativeApp = !!cap?.isNativePlatform?.();

// {versionCode, versionName} of the installed APK
export const appInfo = () => call('appInfo');

// The latest release of `owner/repo` if it's newer than the installed APK, else null.
// Its tag must end with the release's versionCode (v1.4.0-12 → 12) and it must carry an .apk asset.
export async function findUpdate(repo) {
  const { versionCode } = await appInfo();
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const release = await res.json();
  const latest = Number(release.tag_name.match(/(\d+)$/)?.[1] || 0);
  const apk = release.assets.find(a => a.name.endsWith('.apk'));
  if (latest <= versionCode || !apk) return null;
  return { version: release.tag_name.replace(/^v/, ''), url: apk.browser_download_url };
}

// Downloads the APK and opens the system install dialog. onProgress gets 0–100 (-1 if the size is unknown).
// Rejects with an Error whose message is "busy", "bad url", "download", "not an update", "permission" or "no installer".
export async function installUpdate(url, onProgress) {
  const listener = onProgress && cap.addListener('AppUpdater', 'progress', e => onProgress(e.percent));
  try {
    await call('downloadAndInstall', { url });
  } finally {
    listener?.remove();
  }
}
