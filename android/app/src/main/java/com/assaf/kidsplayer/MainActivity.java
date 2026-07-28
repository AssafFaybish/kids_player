package com.assaf.kidsplayer;

// Kids Player — native tweaks.
// Copy this over android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java AFTER
// `npx cap add android`. Keep the package line above matching your appId.
//
// It does two things Capacitor does NOT do out of the box:
//   1) Swallows navigations to youtube.com / youtu.be so the app NEVER leaves to YouTube
//      (the embed loads from youtube-nocookie.com as a subframe and still plays).
//      Without this, Capacitor's default behavior LAUNCHES the external browser on the
//      YouTube logo / "Watch on YouTube" tap.
//   2) Installs a WebChromeClient that makes HTML5 fullscreen actually work (Capacitor's
//      onShowCustomView is a no-op) and blocks pop-up windows.

import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();
        webView.getSettings().setSupportMultipleWindows(false);
        webView.setWebViewClient(new KidsWebViewClient(bridge));
        webView.setWebChromeClient(new KidsWebChromeClient(bridge));
    }

    /** Blocks any navigation whose host is YouTube; everything else keeps Capacitor's behavior. */
    private class KidsWebViewClient extends BridgeWebViewClient {
        KidsWebViewClient(Bridge bridge) { super(bridge); }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url != null ? url.getHost() : null;
            if (host != null) {
                if (host.endsWith("youtube-nocookie.com")) {
                    return false; // allow the privacy-enhanced embed
                }
                if (host.endsWith("youtube.com") || host.endsWith("youtu.be")) {
                    return true;  // swallow: no external browser, WebView stays put
                }
            }
            return super.shouldOverrideUrlLoading(view, request);
        }
    }

    /** Real fullscreen support + block new windows/pop-ups. */
    private class KidsWebChromeClient extends BridgeWebChromeClient {
        private View customView;
        private CustomViewCallback customCallback;

        KidsWebChromeClient(Bridge bridge) { super(bridge); }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customCallback = callback;
            Window window = getWindow();
            ViewGroup decor = (ViewGroup) window.getDecorView();
            decor.addView(customView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            getBridge().getWebView().setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            Window window = getWindow();
            ViewGroup decor = (ViewGroup) window.getDecorView();
            decor.removeView(customView);
            customView = null;
            getBridge().getWebView().setVisibility(View.VISIBLE);
            if (customCallback != null) {
                customCallback.onCustomViewHidden();
                customCallback = null;
            }
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            return false; // block "open in new window" (e.g. the YouTube logo)
        }
    }
}
