package com.skilldrills.pro;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = this.bridge.getWebView();
        // Ignore the device's system font-size/display-size setting and
        // pinch-zoom so the app always renders at the scale it was designed
        // for, instead of looking "zoomed in" on phones with larger text set.
        webView.getSettings().setTextZoom(100);
        webView.getSettings().setSupportZoom(false);
        webView.getSettings().setBuiltInZoomControls(false);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        // Only takes effect while the status bar is actually hidden (drills
        // that call StatusBar.hide() — see DividedAttentionClient.js), so it
        // has no effect on normal screens where the bar is always shown.
        // Without this, swiping the hidden bar back into view leaves it
        // visible until the player taps elsewhere; this makes it auto-hide
        // itself again after a moment, like a native fullscreen game.
        WindowInsetsControllerCompat insetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        insetsController.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
