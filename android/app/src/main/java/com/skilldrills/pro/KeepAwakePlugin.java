package com.skilldrills.pro;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the screen on while a drill is being played.
 *
 * Android's WebView does not implement the web Screen Wake Lock API
 * (navigator.wakeLock is undefined inside the packaged app), so the drills'
 * long touch-free stretches let the display time out and lock mid-run.
 * FLAG_KEEP_SCREEN_ON is the native equivalent: it needs no permission and
 * Android clears it for us if the activity goes away, so a crash or a
 * force-stop can never strand the screen on.
 *
 * Paired with lib/keepAwake.js, which ref-counts the callers.
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    @PluginMethod
    public void keepAwake(PluginCall call) {
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        );
        call.resolve();
    }

    @PluginMethod
    public void allowSleep(PluginCall call) {
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        );
        call.resolve();
    }
}
