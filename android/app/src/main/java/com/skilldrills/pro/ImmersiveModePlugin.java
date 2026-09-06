package com.skilldrills.pro;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * True edge-to-edge full screen for drills.
 *
 * @capacitor/status-bar can hide the STATUS bar and the drills already do, but
 * nothing was hiding the NAVIGATION bar — so every drill ran with the gesture
 * pill / 3-button bar still occupying the bottom of the display and the board
 * squeezed into what was left. That is the "not using the full screen"
 * complaint, and there is no Capacitor plugin for it.
 *
 * setDecorFitsSystemWindows(false) first, so the window keeps its full size and
 * the bars overlay it rather than the WebView being resized when they go and
 * come back. Without that, every transient swipe-reveal would resize the
 * viewport under a running drill — see the countdown-shake note in
 * DrillWrapper.
 *
 * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE means a swipe from an edge brings the
 * bars back over the top for a moment and they retreat on their own, exactly
 * like a native fullscreen game. The player is never trapped: Android's back
 * gesture still works.
 *
 * Paired with lib/immersive.js, which ref-counts the callers.
 */
@CapacitorPlugin(name = "ImmersiveMode")
public class ImmersiveModePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WindowCompat.setDecorFitsSystemWindows(getActivity().getWindow(), false);
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(
                getActivity().getWindow(), getActivity().getWindow().getDecorView());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        });
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(
                getActivity().getWindow(), getActivity().getWindow().getDecorView());
            c.show(WindowInsetsCompat.Type.systemBars());
            WindowCompat.setDecorFitsSystemWindows(getActivity().getWindow(), true);
        });
        call.resolve();
    }
}
