package io.github.ymalka82810.tehillim;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileWriter;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Synthesizes each test case to a WAV file with every Hebrew voice, to see how the engine handles SSML. */
@RunWith(AndroidJUnit4.class)
public class TtsSsmlTest {
    private static final String TAG = "TtsSsmlTest";
    private final JSONObject report = new JSONObject();
    private File outDir;

    @Test
    public void synthesizeCases() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        outDir = new File(ctx.getFilesDir(), "tts");
        outDir.mkdirs();

        InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("tts-cases.json");
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
        JSONObject cases = new JSONObject(buf.toString("UTF-8"));

        for (String engine : new String[] { "com.google.android.tts", null }) {
            try {
                runEngine(ctx, engine, cases);
            } catch (Throwable t) {
                report.put("error_" + engine, t.toString());
            }
            save();
        }
    }

    private void runEngine(Context ctx, String engine, JSONObject cases) throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        int[] status = { -99 };
        TextToSpeech tts = engine == null
            ? new TextToSpeech(ctx, s -> { status[0] = s; ready.countDown(); })
            : new TextToSpeech(ctx, s -> { status[0] = s; ready.countDown(); }, engine);
        ready.await(60, TimeUnit.SECONDS);
        String key = engine == null ? "default" : engine;
        JSONObject info = new JSONObject();
        report.put(key, info);
        info.put("initStatus", status[0]);
        info.put("defaultEngine", tts.getDefaultEngine());
        JSONArray engines = new JSONArray();
        for (TextToSpeech.EngineInfo e : tts.getEngines()) engines.put(e.name);
        info.put("engines", engines);
        if (status[0] != TextToSpeech.SUCCESS) return;

        Locale he = new Locale("he", "IL");
        info.put("setLanguage", tts.setLanguage(he));

        // Wait for an installed (offline) Hebrew voice; the engine may download it in the background
        List<Voice> hebrew = new ArrayList<>();
        long deadline = System.currentTimeMillis() + 8 * 60 * 1000;
        while (true) {
            hebrew.clear();
            boolean installedLocal = false;
            if (tts.getVoices() != null) for (Voice v : tts.getVoices()) {
                String lang = v.getLocale().getLanguage();
                if (!lang.equals("he") && !lang.equals("iw")) continue;
                hebrew.add(v);
                if (!v.isNetworkConnectionRequired() && !v.getFeatures().contains("notInstalled")) installedLocal = true;
            }
            if (installedLocal || System.currentTimeMillis() > deadline) break;
            Thread.sleep(15000);
        }
        JSONArray voices = new JSONArray();
        for (Voice v : hebrew) {
            voices.put(new JSONObject()
                .put("name", v.getName())
                .put("network", v.isNetworkConnectionRequired())
                .put("features", v.getFeatures().toString()));
        }
        info.put("hebrewVoices", voices);
        save();

        JSONObject results = new JSONObject();
        info.put("results", results);
        for (Voice v : hebrew) {
            if (v.getFeatures().contains("notInstalled")) continue;
            tts.setVoice(v);
            JSONObject perVoice = new JSONObject();
            results.put(v.getName(), perVoice);
            Iterator<String> ids = cases.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                File wav = new File(outDir, key.replace('.', '_') + "__" + v.getName() + "__" + id + ".wav");
                perVoice.put(id, synthesize(tts, cases.getString(id), wav));
                save();
            }
        }
        tts.shutdown();
    }

    private String synthesize(TextToSpeech tts, String text, File wav) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        String[] outcome = { "timeout" };
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { outcome[0] = "done"; done.countDown(); }
            @Override public void onError(String id) { outcome[0] = "error"; done.countDown(); }
            @Override public void onError(String id, int code) { outcome[0] = "error " + code; done.countDown(); }
        });
        int r = tts.synthesizeToFile(text, new Bundle(), wav, wav.getName());
        if (r != TextToSpeech.SUCCESS) return "synthesizeToFile returned " + r;
        done.await(90, TimeUnit.SECONDS);
        return outcome[0] + " " + wav.length();
    }

    private void save() throws Exception {
        try (FileWriter w = new FileWriter(new File(outDir, "report.json"))) {
            w.write(report.toString(1));
        }
        Log.i(TAG, report.toString());
    }
}
