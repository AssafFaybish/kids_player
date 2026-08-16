package com.assaf.kidsplayer;

// KidsWebPlugin (v1.0.45) — the RESTRICTED SITE VIEWER.
//
// A native WebView laid over the bridge, used to show a child a website the parent
// approved. It exists because nothing else can enforce where the child may go:
//   • an <iframe> cannot be navigation-controlled from the parent document (same-origin
//     policy) and a large share of the web refuses to be framed at all (X-Frame-Options),
//   • Chrome Custom Tabs is a real browser with no hooks whatsoever.
// `shouldOverrideUrlLoading` below is the ONLY enforcement point in the whole feature.
//
// WHERE THE RULES COME FROM: already canonical, from JS (weblock.canonicalSitePrefix) —
// host lower-cased with a leading `www.` stripped, port defaulted to 443, path split into
// DECODED segments. This file must not re-parse or re-normalize a prefix; the hard part
// lives in one tested place, and a second implementation here would drift from it. All
// that happens here is a comparison of pre-normalized parts, plus the same decode-then-
// refuse rule for `.`/`..` (Uri.getPathSegments decodes on its own, so `%2e%2e` arrives
// as `..` and must be refused at that point or it climbs out of the allowed section).
//
// A VIEW, NOT AN ACTIVITY: added to the decor view of MainActivity. A second activity
// would fight lock-task (the kiosk exit lock) and would need its own immersive handling;
// this way both come for free.

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.util.TypedValue;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "KidsWeb")
public class KidsWebPlugin extends Plugin {

    /** One approved prefix, already canonical. Never built from a raw string here. */
    private static class Rule {
        String host = "";
        int port = 443;
        final List<String> segments = new ArrayList<>();
        boolean allowExternal = false;
    }

    private static KidsWebPlugin instance;

    private FrameLayout overlay;
    private WebView web;
    private TextView titleView;
    private final List<Rule> rules = new ArrayList<>();
    private boolean parentMode = false;
    private long lastActivityPing = 0L;
    /** The page the child was refused, so the parent's approval knows what it is approving. */
    private String lastBlockedUrl = "";

    @Override
    public void load() { instance = this; }

    /* ---------------- lifecycle hooks called by MainActivity ---------------- */

    static boolean overlayVisible() { return instance != null && instance.overlay != null; }

    /** Hardware back: walk the site's own history first, then close. */
    static boolean handleBack() {
        if (instance == null || instance.overlay == null) return false;
        if (instance.web != null && instance.web.canGoBack()) { instance.web.goBack(); return true; }
        instance.closeOverlay();
        return true;
    }

    /**
     * v1.0.32 replayed: Android does NOT pause a WebView when the activity leaves the
     * foreground, so a site playing audio kept its soundtrack running behind a dark
     * screen — the exact field report the player fix exists for. pauseTimers() also stops
     * JS timers and animation, which is what makes the pause real rather than cosmetic.
     * The cookie flush is here too: without it a login the parent typed is lost whenever
     * the process is killed, and "enter the password once" quietly becomes "every time".
     */
    static void onActivityPause() {
        if (instance == null || instance.web == null) return;
        instance.web.onPause();
        instance.web.pauseTimers();
        flushCookies();
    }

    static void onActivityResume() {
        if (instance == null || instance.web == null) return;
        instance.web.resumeTimers();
        instance.web.onResume();
    }

    private static void flushCookies() {
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
    }

    /* ---------------- plugin API ---------------- */

    @PluginMethod
    public void open(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("bad-url"); return; }
        final boolean parent = Boolean.TRUE.equals(call.getBoolean("parentMode", false));
        final String title = call.getString("title", "");
        final List<Rule> parsed = readRules(call.getArray("rules"));

        a.runOnUiThread(() -> {
            try {
                rules.clear();
                rules.addAll(parsed);
                parentMode = parent;
                if (overlay == null) buildOverlay(a);
                if (titleView != null) titleView.setText(title == null || title.isEmpty() ? hostOf(url) : title);
                web.loadUrl(url);
                overlay.setVisibility(View.VISIBLE);
                call.resolve();
            } catch (Exception e) {
                call.reject("open-failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        a.runOnUiThread(() -> { closeOverlay(); call.resolve(); });
    }

    @PluginMethod
    public void isOpen(PluginCall call) {
        JSObject o = new JSObject();
        o.put("value", overlay != null && overlay.getVisibility() == View.VISIBLE);
        call.resolve(o);
    }

    /**
     * Sign out of ONE site. Android's CookieManager has no per-host removal, so the
     * cookies are expired by name against that host — which is what a real sign-out does
     * — and the shared DOM/Web storage is cleared alongside. Resolves either way: failing
     * to find a cookie is an ordinary outcome, not an error (the canDeviceAuth rule).
     */
    @PluginMethod
    public void clearSiteData(PluginCall call) {
        final String host = call.getString("host");
        Activity a = getActivity();
        if (a == null || host == null || host.isEmpty()) { call.resolve(); return; }
        a.runOnUiThread(() -> {
            try {
                CookieManager cm = CookieManager.getInstance();
                for (String base : new String[] { "https://" + host, "https://." + host, "https://www." + host }) {
                    String raw = cm.getCookie(base);
                    if (raw == null) continue;
                    for (String pair : raw.split(";")) {
                        String name = pair.split("=")[0].trim();
                        if (name.isEmpty()) continue;
                        cm.setCookie(base, name + "=; Max-Age=0; Path=/");
                    }
                }
                cm.flush();
                WebStorage.getInstance().deleteAllData();
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /* ---------------- the overlay ---------------- */

    @SuppressLint("SetJavaScriptEnabled")
    private void buildOverlay(Activity a) {
        overlay = new FrameLayout(a);
        overlay.setBackgroundColor(Color.WHITE);
        // Consume touches so nothing reaches the app's own WebView underneath.
        overlay.setClickable(true);

        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        // parent mode is deliberately UNMISTAKABLE: it navigates without restriction, and
        // nobody should be in any doubt about which mode the tablet is in.
        bar.setBackgroundColor(parentMode ? Color.parseColor("#8a6d00") : Color.parseColor("#6c63ff"));
        int pad = dp(a, 10);
        // The app runs edge-to-edge in immersive mode, so the bar pads itself down past a
        // transiently-revealed status bar instead of hiding under it.
        bar.setPadding(pad, pad + statusBarInset(a), pad, pad);

        Button back = new Button(a);
        back.setText("← חזרה");
        back.setAllCaps(false);
        back.setTextColor(Color.WHITE);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setOnClickListener(v -> closeOverlay());
        bar.addView(back);

        titleView = new TextView(a);
        titleView.setTextColor(Color.WHITE);
        titleView.setSingleLine(true);
        titleView.setPadding(dp(a, 8), 0, 0, 0);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(titleView, tp);

        if (parentMode) {
            TextView tag = new TextView(a);
            tag.setText("מצב הורה");
            tag.setTextColor(Color.WHITE);
            bar.addView(tag);
        }
        col.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // A SUBCLASS, so the text-selection ActionMode can be refused: selecting a word
        // offers "Web search" and "Translate", and both launch another app — the same
        // class of escape as the long-press menu, reached by a different gesture.
        web = new WebView(a) {
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback) { return null; }
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback, int type) { return null; }
        };
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // Persisted on purpose: the parent signs in ONCE, in parent mode, and the child
        // inherits that session. Modern sites keep the session in DOM storage as often as
        // in a cookie, so both are enabled or "once" is a lie.
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // Everything below is a door closed.
        s.setSupportMultipleWindows(false);                 // target=_blank / window.open
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);                        // file:// browsing
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); // no http inside https
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false); // trackers

        // A long press offers "open in new tab" / "copy link" / "download image" — three
        // ways out of the allowed set, in one gesture a child finds by accident.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(v -> true);

        web.setWebViewClient(new RestrictedClient());
        web.setWebChromeClient(new RestrictedChromeClient());
        // A download is how a child ends up with an APK. There is nothing to download here.
        web.setDownloadListener((u, ua, cd, mt, len) -> notifyBlocked(u));

        col.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        overlay.addView(col, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ViewGroup decor = (ViewGroup) a.getWindow().getDecorView();
        decor.addView(overlay, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void closeOverlay() {
        if (overlay == null) return;
        try {
            flushCookies();                 // the login must survive the close
            web.stopLoading();
            web.loadUrl("about:blank");     // stops any audio still playing
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) parent.removeView(overlay);
            web.destroy();
        } catch (Exception ignored) {}
        overlay = null;
        web = null;
        titleView = null;
        notifyListeners("webClosed", new JSObject());
    }

    /* ---------------- enforcement ---------------- */

    private class RestrictedClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            // The blocked page's own "הורים" link. Checked BEFORE anything else, because
            // it is not https and every other branch would (correctly) refuse it.
            if (u != null && "kidsweb".equals(u.getScheme())) {
                requestParentAdd(lastBlockedUrl);
                return true;
            }
            if (parentMode) return false; // the parent's own browsing, behind the PIN
            if (allowed(u)) return false;
            // TRUE = we handled it, i.e. the navigation does NOT happen. Everything that
            // is not an approved https page lands here, including intent:// market://
            // tel: and mailto:, each of which would otherwise open ANOTHER APP.
            lastBlockedUrl = u.toString();
            notifyBlocked(lastBlockedUrl);
            showBlockedPage(view);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (parentMode) return null;
            if (subresourceAllowed(request.getUrl())) return null;
            // An empty 200 rather than an error: a blocked ad slot should leave a hole in
            // the page, not a broken-image icon or a JS exception the site reacts to.
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pingActivity();
        }
    }

    private class RestrictedChromeClient extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            return false; // pop-ups never open
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            request.deny(); // camera / microphone / midi — never, and never a prompt
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback cb) {
            cb.invoke(origin, false, false);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (titleView != null && title != null && !title.isEmpty()) titleView.setText(title);
        }
    }

    /** THE navigation decision. Pre-normalized parts only — no prefix parsing here. */
    private boolean allowed(Uri u) {
        if (u == null) return false;
        if (!"https".equals(u.getScheme())) return false;
        if (u.getUserInfo() != null) return false;          // https://good.com@evil.com/
        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.startsWith("www.")) host = host.substring(4);
        int port = u.getPort();
        if (port == -1) port = 443;

        List<String> segs = u.getPathSegments();            // already percent-decoded
        for (String seg : segs) {
            if (".".equals(seg) || "..".equals(seg)) return false; // %2e%2e arrives as ".."
        }
        for (Rule r : rules) {
            if (!r.host.equals(host) || r.port != port) continue;
            if (r.segments.size() > segs.size()) continue;
            boolean ok = true;
            for (int i = 0; i < r.segments.size(); i++) {
                if (!r.segments.get(i).equals(segs.get(i))) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    /** The rule governing a page, longest match — so a narrow rule keeps its own policy. */
    private Rule governing(Uri u) {
        Rule best = null;
        if (u == null) return null;
        String host = u.getHost();
        if (host == null) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("www.")) host = host.substring(4);
        List<String> segs = u.getPathSegments();
        for (Rule r : rules) {
            if (!r.host.equals(host)) continue;
            if (r.segments.size() > segs.size()) continue;
            boolean ok = true;
            for (int i = 0; i < r.segments.size(); i++) {
                if (!r.segments.get(i).equals(segs.get(i))) { ok = false; break; }
            }
            if (ok && (best == null || r.segments.size() > best.segments.size())) best = r;
        }
        return best;
    }

    /**
     * Subresources: the prefix rule governs NAVIGATION only, and everything a page embeds
     * arrives without the child tapping anything — ad inventory, trackers, third-party
     * players. Strict by default: the page's own host and its subdomains (where a site's
     * CDN lives), plus any approved rule's host. The parent can open one rule up.
     */
    private boolean subresourceAllowed(Uri u) {
        if (u == null) return true;
        String scheme = u.getScheme();
        if (scheme == null) return true;
        if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) return true;
        if (!"https".equals(scheme)) return false;

        Uri page = web != null && web.getUrl() != null ? Uri.parse(web.getUrl()) : null;
        Rule gov = governing(page);
        if (gov != null && gov.allowExternal) return true;

        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.startsWith("www.")) host = host.substring(4);

        List<String> allow = new ArrayList<>();
        if (page != null && page.getHost() != null) {
            String h = page.getHost().toLowerCase(Locale.ROOT);
            allow.add(h.startsWith("www.") ? h.substring(4) : h);
        }
        for (Rule r : rules) allow.add(r.host);
        for (String h : allow) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        return false;
    }

    /**
     * What the CHILD sees when a link is refused: a calm sentence, never a dead tap. The
     * "הורים" button asks JS to take over — the parent code is checked THERE, because
     * verifying a PIN in Java would be a second implementation of the one check that
     * guards the entire parent surface.
     */
    private void showBlockedPage(WebView view) {
        String html = "<!doctype html><html dir='rtl' lang='he'><head><meta charset='utf-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{font-family:sans-serif;background:#fdf6e3;color:#2b2b3a;display:flex;"
            + "flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}"
            + "h1{font-size:22px}p{color:#6b6b80}"
            + "a{margin-top:28px;font-size:12px;opacity:.55;color:#6b6b80;text-decoration:underline}</style></head>"
            + "<body><div style='font-size:56px'>🚧</div><h1>הדף הזה לא זמין</h1>"
            + "<p>אפשר לחזור אחורה ולהמשיך לשחק</p>"
            + "<a href='kidsweb://ask'>הורים</a></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void notifyBlocked(String url) {
        JSObject o = new JSObject();
        o.put("url", url);
        notifyListeners("webBlocked", o);
    }

    /**
     * Touches inside a native WebView never reach the app's own window, so the JS capture
     * listeners that feed the idle timer are blind while a site is open. Without this ping
     * the screen-off timer would fire on a child who is actively browsing. Throttled — it
     * is a heartbeat, not an event stream.
     */
    private void pingActivity() {
        long now = System.currentTimeMillis();
        if (now - lastActivityPing < 5000) return;
        lastActivityPing = now;
        notifyListeners("webActivity", new JSObject());
    }

    /* ---------------- helpers ---------------- */

    private List<Rule> readRules(JSArray arr) {
        List<Rule> out = new ArrayList<>();
        if (arr == null) return out;
        try {
            for (Object item : arr.toList()) {
                if (!(item instanceof org.json.JSONObject)) continue;
                org.json.JSONObject o = (org.json.JSONObject) item;
                Rule r = new Rule();
                r.host = o.optString("host", "").toLowerCase(Locale.ROOT);
                if (r.host.isEmpty()) continue;
                r.port = o.optInt("port", 443);
                r.allowExternal = o.optBoolean("allowExternal", false);
                org.json.JSONArray segs = o.optJSONArray("segments");
                if (segs != null) {
                    for (int i = 0; i < segs.length(); i++) r.segments.add(segs.optString(i, ""));
                }
                out.add(r);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static String hostOf(String url) {
        try { return Uri.parse(url).getHost(); } catch (Exception e) { return ""; }
    }

    private static int dp(Activity a, int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, a.getResources().getDisplayMetrics());
    }

    private static int statusBarInset(Activity a) {
        int id = a.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? a.getResources().getDimensionPixelSize(id) : 0;
    }

    /** The blocked page's "הורים" link, routed to JS. Called from RestrictedClient. */
    void requestParentAdd(String url) {
        JSObject o = new JSObject();
        o.put("url", url);
        notifyListeners("webAddRequest", o);
    }
}
