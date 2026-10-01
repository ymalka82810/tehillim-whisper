package io.github.ymalka82810.tehillim;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;

/**
 * Self-update for a sideloaded APK: downloads the new APK and opens the system install dialog,
 * so the user only taps "Update" (no hunting for the file in Downloads).
 *
 * The download runs in the system DownloadManager, so it carries on (with a progress notification)
 * when the user leaves the app. Android won't let a background app open the installer, so if the
 * download finishes while we're in the background, the install dialog opens when the app returns.
 * If the app was closed altogether, the next downloadAndInstall for the same url picks up the
 * running or finished download instead of starting over.
 *
 * Needs in AndroidManifest.xml: the REQUEST_INSTALL_PACKAGES permission and a FileProvider with
 * authority "${applicationId}.fileprovider" whose paths include <external-files-path path="app-update/" />.
 * Register it in MainActivity: registerPlugin(AppUpdaterPlugin.class) before super.onCreate().
 *
 * JS: appInfo() -> {versionCode, versionName}
 *     downloadAndInstall({url}) -> resolves once the install dialog is shown; rejects with
 *       "busy", "bad url", "download", "not an update", "permission" or "no installer"
 *     event "progress" -> {percent} while downloading (-1 when the size is unknown)
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String DIR = "app-update";
    private static final String APK = "update.apk";
    private static final String PREFS = "app-updater";
    private volatile boolean busy = false;
    private Runnable onResume; // the install dialog, waiting for the app to come back to the foreground

    @Override
    public void load() {
        // Earlier versions downloaded into the cache
        deleteDir(new File(getContext().getCacheDir(), DIR));
        // An APK left from an earlier update is no longer needed once we're running it,
        // but keep a download that is still running or that finished while the app was closed
        File apk = apkFile();
        if (runningDownload() == -1 && !(apk.exists() && isUpdateOfThisApp(apk))) {
            deleteDir(updateDir());
            prefs().edit().clear().apply();
        }
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            ret.put("versionCode", versionCode(info));
            ret.put("versionName", info.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            ret.put("versionCode", 0);
            ret.put("versionName", "");
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith("https://")) {
            call.reject("bad url");
            return;
        }
        if (busy) {
            call.reject("busy");
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                File apk = apkFile();
                boolean sameUrl = url.equals(prefs().getString("url", null));
                if (!(sameUrl && apk.exists() && isUpdateOfThisApp(apk))) {
                    long id = sameUrl ? runningDownload() : -1;
                    if (id == -1) id = enqueue(url);
                    waitFor(id);
                }
                if (!isUpdateOfThisApp(apk)) {
                    apk.delete();
                    call.reject("not an update");
                    return;
                }
                getActivity().runOnUiThread(() -> whenInForeground(() -> installOrAskPermission(call, apk)));
            } catch (IOException e) {
                call.reject("download");
            } finally {
                busy = false;
            }
        }).start();
    }

    // Starts a fresh download of url into updateDir(), remembering it across app restarts
    private long enqueue(String url) throws IOException {
        DownloadManager dm = downloadManager();
        long old = prefs().getLong("id", -1);
        if (old != -1) dm.remove(old);
        deleteDir(updateDir());
        if (updateDir() == null) throw new IOException("no external storage");

        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
            .setTitle(getContext().getApplicationInfo().loadLabel(getContext().getPackageManager()))
            .setDescription("מוריד עדכון")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(getContext(), DIR, APK);
        long id = dm.enqueue(req);
        prefs().edit().putLong("id", id).putString("url", url).apply();
        return id;
    }

    // Reports progress until the download finishes; throws if it fails or the user cancels it
    private void waitFor(long id) throws IOException {
        DownloadManager dm = downloadManager();
        int lastPercent = -2;
        while (true) {
            int status;
            long done, total;
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
                if (c == null || !c.moveToFirst()) throw new IOException("download cancelled");
                status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            }
            if (status == DownloadManager.STATUS_SUCCESSFUL) return;
            if (status == DownloadManager.STATUS_FAILED) {
                dm.remove(id);
                prefs().edit().clear().apply();
                throw new IOException("download failed");
            }
            int percent = total > 0 ? (int) (done * 100 / total) : -1;
            if (percent != lastPercent) {
                lastPercent = percent;
                JSObject ev = new JSObject();
                ev.put("percent", percent);
                notifyListeners("progress", ev);
            }
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                throw new IOException("interrupted");
            }
        }
    }

    // The id of our download if the DownloadManager is still working on it, else -1
    private long runningDownload() {
        long id = prefs().getLong("id", -1);
        if (id == -1) return -1;
        try (Cursor c = downloadManager().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return -1;
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return status == DownloadManager.STATUS_SUCCESSFUL || status == DownloadManager.STATUS_FAILED ? -1 : id;
        }
    }

    // Android blocks starting activities from the background, so hold the installer until we're back
    private void whenInForeground(Runnable action) {
        if (getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) action.run();
        else onResume = action;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Runnable action = onResume;
        onResume = null;
        if (action != null) action.run();
    }

    // Same package and a newer version; otherwise the installer would fail with a vaguer message
    private boolean isUpdateOfThisApp(File apk) {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo downloaded = pm.getPackageArchiveInfo(apk.getPath(), 0);
        if (downloaded == null || !getContext().getPackageName().equals(downloaded.packageName)) return false;
        try {
            return versionCode(downloaded) > versionCode(pm.getPackageInfo(getContext().getPackageName(), 0));
        } catch (PackageManager.NameNotFoundException e) {
            return true;
        }
    }

    private void installOrAskPermission(PluginCall call, File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // One-time "allow installs from this app" switch; we continue in installPermissionResult
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, intent, "installPermissionResult");
            return;
        }
        install(call, apk);
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        File apk = apkFile();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("permission");
        } else if (!apk.exists()) {
            call.reject("download");
        } else {
            install(call, apk);
        }
    }

    private void install(PluginCall call, File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no installer");
        }
    }


    private File updateDir() {
        File files = getContext().getExternalFilesDir(null);
        return files == null ? null : new File(files, DIR);
    }

    private File apkFile() {
        File dir = updateDir();
        return new File(dir == null ? getContext().getCacheDir() : dir, APK);
    }

    private DownloadManager downloadManager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static void deleteDir(File dir) {
        if (dir == null) return;
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        dir.delete();
    }
}
