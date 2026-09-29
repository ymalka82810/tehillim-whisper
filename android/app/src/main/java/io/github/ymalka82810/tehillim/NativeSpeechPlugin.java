package io.github.ymalka82810.tehillim;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "NativeSpeech")
public class NativeSpeechPlugin extends Plugin {
    private static final Locale HEBREW = Locale.forLanguageTag("he-IL");
    private static final String GOOGLE_TTS = "com.google.android.tts";

    private TextToSpeech tts;
    private volatile boolean ready = false;
    private boolean reinitOnResume = false;
    private final List<PluginCall> waitingForInit = new ArrayList<>();
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();

    @Override
    public void load() {
        initTts();
    }

    @Override
    protected void handleOnResume() {
        // The user may have installed a voice or switched engine in the system settings we opened
        if (reinitOnResume) {
            reinitOnResume = false;
            shutdownTts();
            initTts();
        }
    }

    @Override
    protected void handleOnDestroy() {
        shutdownTts();
    }

    private synchronized void initTts() {
        ready = false;
        tts = new TextToSpeech(getContext(), status -> {
            synchronized (this) {
                ready = status == TextToSpeech.SUCCESS;
                if (ready && tts != null) tts.setOnUtteranceProgressListener(listener);
                for (PluginCall call : waitingForInit) call.resolve(buildStatus());
                waitingForInit.clear();
            }
        });
    }

    private synchronized void shutdownTts() {
        finishAll(true);
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        ready = false;
    }

    private final UtteranceProgressListener listener = new UtteranceProgressListener() {
        @Override public void onStart(String id) {}
        @Override public void onDone(String id) { finish(id, false); }
        @Override public void onError(String id) { finish(id, false); }
        @Override public void onStop(String id, boolean interrupted) { finish(id, true); }
    };

    private void finish(String id, boolean interrupted) {
        PluginCall call = speaking.remove(id);
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("interrupted", interrupted);
        call.resolve(ret);
    }

    private void finishAll(boolean interrupted) {
        for (String id : new ArrayList<>(speaking.keySet())) finish(id, interrupted);
    }

    private JSObject buildStatus() {
        JSObject ret = new JSObject();
        ret.put("ready", ready);
        JSArray voices = new JSArray();
        String hebrew = "unsupported";
        String engine = "";
        boolean hasGoogle = false;
        if (ready && tts != null) {
            int avail = tts.isLanguageAvailable(HEBREW);
            if (avail >= TextToSpeech.LANG_AVAILABLE) hebrew = "ok";
            else if (avail == TextToSpeech.LANG_MISSING_DATA) hebrew = "missing";
            engine = tts.getDefaultEngine();
            for (TextToSpeech.EngineInfo info : tts.getEngines()) {
                if (GOOGLE_TTS.equals(info.name)) hasGoogle = true;
            }
            Set<Voice> all = null;
            try { all = tts.getVoices(); } catch (Exception ignored) {}
            if (all != null) {
                for (Voice v : all) {
                    String lang = v.getLocale().getLanguage();
                    if (!"he".equals(lang) && !"iw".equals(lang)) continue;
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("installed", !v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                    o.put("network", v.isNetworkConnectionRequired());
                    voices.put(o);
                }
            }
        }
        ret.put("hebrew", hebrew);
        ret.put("engine", engine);
        ret.put("hasGoogle", hasGoogle);
        ret.put("voices", voices);
        return ret;
    }

    @PluginMethod
    public synchronized void status(PluginCall call) {
        if (tts != null && !ready) waitingForInit.add(call);
        else call.resolve(buildStatus());
    }

    @PluginMethod
    public void speak(PluginCall call) {
        if (!ready || tts == null) {
            call.reject("TTS not ready");
            return;
        }
        String text = call.getString("text", "");
        float rate = call.getFloat("rate", 1f);
        String voiceName = call.getString("voice", "");

        boolean voiceSet = false;
        if (voiceName != null && !voiceName.isEmpty() && tts.getVoices() != null) {
            for (Voice v : tts.getVoices()) {
                if (v.getName().equals(voiceName)) {
                    voiceSet = tts.setVoice(v) == TextToSpeech.SUCCESS;
                    break;
                }
            }
        }
        if (!voiceSet) tts.setLanguage(HEBREW);
        tts.setSpeechRate(rate);

        String id = UUID.randomUUID().toString();
        speaking.put(id, call);
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id) == TextToSpeech.ERROR) {
            speaking.remove(id);
            call.reject("speak failed");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        finishAll(true);
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        if (!tryStart(new Intent("com.android.settings.TTS_SETTINGS"))) {
            tryStart(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        }
        call.resolve();
    }

    @PluginMethod
    public void installVoice(PluginCall call) {
        Intent intent = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
        if (tts != null && tts.getDefaultEngine() != null) intent.setPackage(tts.getDefaultEngine());
        if (!tryStart(intent) && !tryStart(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA))) {
            tryStart(new Intent("com.android.settings.TTS_SETTINGS"));
        }
        call.resolve();
    }

    @PluginMethod
    public void installGoogleEngine(PluginCall call) {
        if (!tryStart(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + GOOGLE_TTS)))) {
            tryStart(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + GOOGLE_TTS)));
        }
        call.resolve();
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            ret.put("versionCode", code);
            ret.put("versionName", info.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            ret.put("versionCode", 0);
            ret.put("versionName", "");
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith("https://github.com/")) {
            call.reject("unsupported url");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no browser");
        }
    }

    private boolean tryStart(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            reinitOnResume = true;
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            return false;
        }
    }
}
