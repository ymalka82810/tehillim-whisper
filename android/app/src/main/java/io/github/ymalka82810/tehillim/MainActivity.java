package io.github.ymalka82810.tehillim;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
