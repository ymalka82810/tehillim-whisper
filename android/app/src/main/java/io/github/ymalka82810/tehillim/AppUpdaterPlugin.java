package io.github.ymalka82810.tehillim;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update for a sideloaded APK: downloads the new APK inside the app and opens the system
 * install dialog, so the user only taps "Update" (no hunting for the file in Downloads).
 *
 * Needs in AndroidManifest.xml: the REQUEST_INSTALL_PACKAGES permission and a FileProvider with
 * authority "${applicationId}.fileprovider" whose paths include <cache-path name="..." path="." />.
 * Register it in MainActivity: registerPlugin(AppUpdaterPlugin.class) before super.onCreate().
 *
 * JS: appInfo() -> {versionCode, versionName}
 *     downloadAndInstall({url}) -> resolves once the install dialog is shown; rejects with
 *       "busy", "bad url", "download", "not an update" or "permission"
 *     event "progress" -> {percent} while downloading (-1 when the size is unknown)
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String DIR = "app-update";
    private volatile boolean busy = false;

    @Override
    public void load() {
        // An APK left from an earlier update is no longer needed once we're running
        deleteDir(updateDir());
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
                File apk = download(url);
                if (!isUpdateOfThisApp(apk)) {
                    apk.delete();
                    call.reject("not an update");
                    return;
                }
                getActivity().runOnUiThread(() -> installOrAskPermission(call, apk));
            } catch (IOException e) {
                call.reject("download", e);
            } finally {
                busy = false;
            }
        }).start();
    }

    private File download(String url) throws IOException {
        File dir = updateDir();
        deleteDir(dir);
        if (!dir.mkdirs()) throw new IOException("cannot create " + dir);
        File apk = new File(dir, "update.apk");

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true); // GitHub release assets redirect to their CDN
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        try {
            if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + conn.getResponseCode());
            long total = conn.getContentLengthLong();
            long done = 0;
            int lastPercent = -2;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                for (int n; (n = in.read(buf)) != -1; ) {
                    out.write(buf, 0, n);
                    done += n;
                    int percent = total > 0 ? (int) (done * 100 / total) : -1;
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        JSObject ev = new JSObject();
                        ev.put("percent", percent);
                        notifyListeners("progress", ev);
                    }
                }
            }
            if (total > 0 && done != total) throw new IOException("incomplete download");
            return apk;
        } finally {
            conn.disconnect();
        }
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
        File apk = new File(updateDir(), "update.apk");
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
        return new File(getContext().getCacheDir(), DIR);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static void deleteDir(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        dir.delete();
    }
}
