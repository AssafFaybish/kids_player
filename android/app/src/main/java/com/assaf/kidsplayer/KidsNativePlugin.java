package com.assaf.kidsplayer;

// Kids Player — the single custom native surface, five features:
//   1) keepAwake/allowSleep (F7): window-level FLAG_KEEP_SCREEN_ON. Needs NO permission
//      (not even WAKE_LOCK), survives the fullscreen custom-view swap, and is auto-scoped
//      to window visibility so background/resume need zero handling.
//   2) Share-intent inbox (F12b): MainActivity.handleShareIntent() enqueues into a STATIC
//      inbox (a share can arrive during super.onCreate(), long before JS boots), then
//      notifyListeners with retainUntilConsumed=true. JS boot order: addListener FIRST,
//      then getPendingShares() to drain. Double delivery is harmless (key dedupe in JS).
//   3) APK self-update installer (F14): FileProvider URI + ACTION_VIEW. Deliberately no
//      resolveActivity() — API 30+ package visibility returns null without <queries>,
//      a phantom failure.
//   4) exitApp (v1.0.4): finishAndRemoveTask + delayed process kill — App.exitApp()
//      only finish()es, which reads as "minimize" on real devices.
//   5) shareText (v1.0.5): the OS share sheet (ACTION_SEND chooser) — used by the
//      parent screen's "share the app" button; no plugin dependency needed.
//
// Canonical copy: native-reference/KidsNativePlugin.java — keep both in sync.

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.WindowManager;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.ArrayDeque;

@CapacitorPlugin(name = "KidsNative")
public class KidsNativePlugin extends Plugin {

    /* ---------------- keep screen on (F7) ---------------- */

    @PluginMethod
    public void keepAwake(PluginCall call) { setKeepScreenOn(true); call.resolve(); }

    @PluginMethod
    public void allowSleep(PluginCall call) { setKeepScreenOn(false); call.resolve(); }

    private void setKeepScreenOn(boolean on) {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /* ---------------- TV detection (v1.0.9) ---------------- */

    /** Are we on Android TV / Google TV? Drives the 10-foot layout + D-pad focus mode. */
    @PluginMethod
    public void isTv(PluginCall call) {
        android.app.UiModeManager ui =
                (android.app.UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        boolean tv = ui != null
                && ui.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
        JSObject ret = new JSObject();
        ret.put("value", tv);
        call.resolve(ret);
    }

    /* ---------------- exit lock via screen pinning (v1.0.11) ---------------- */
    // Android does NOT let apps intercept the HOME button — the sanctioned kiosk
    // mechanism is lock-task ("screen pinning"): home/recents/back are contained by
    // the OS. Without device-owner provisioning the FIRST startLockTask shows a
    // one-time system confirmation; our own stopLockTask() (parent-PIN gated in JS)
    // exits it without device credentials.

    @PluginMethod
    public void lockTask(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        a.runOnUiThread(() -> {
            try { a.startLockTask(); call.resolve(); }
            catch (Exception e) { call.reject("lock-failed: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void unlockTask(PluginCall call) {
        Activity a = getActivity();
        if (a == null) { call.reject("no-activity"); return; }
        a.runOnUiThread(() -> {
            try { a.stopLockTask(); } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void isTaskLocked(PluginCall call) {
        boolean locked = false;
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            locked = am != null
                    && am.getLockTaskModeState() != android.app.ActivityManager.LOCK_TASK_MODE_NONE;
        } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        ret.put("value", locked);
        call.resolve(ret);
    }

    /* ---------------- real exit (v1.0.4) ---------------- */

    /**
     * App.exitApp() only calls activity.finish(): the task stays in recents and on some
     * launchers the app just minimizes. finishAndRemoveTask() removes the whole task;
     * the delayed System.exit ensures the process dies even if a plugin holds it alive.
     */
    @PluginMethod
    public void exitApp(PluginCall call) {
        call.resolve(); // resolve first — the webview is about to die
        Activity a = getActivity();
        if (a == null) { System.exit(0); return; }
        a.runOnUiThread(() -> {
            try { a.stopLockTask(); } catch (Exception ignored) {} // pinned task can't finish
            a.finishAndRemoveTask();
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(() -> System.exit(0), 250);
        });
    }

    /* ---------------- share sheet (v1.0.5) ---------------- */

    /** Opens the system share chooser with plain text (link + explanation). */
    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) { call.reject("no-text"); return; }
        String subject = call.getString("subject");
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            if (subject != null && !subject.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, subject);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("share-failed: " + e.getMessage());
        }
    }

    /* ---------------- share-intent inbox (F12b) ---------------- */

    private static final ArrayDeque<JSObject> INBOX = new ArrayDeque<>();
    private static KidsNativePlugin instance;

    @Override
    public void load() { instance = this; }

    /** Called from MainActivity for both cold-start and warm onNewIntent deliveries. */
    public static void enqueueShare(String text, String subject) {
        JSObject o = new JSObject();
        o.put("text", text == null ? "" : text);
        o.put("subject", subject == null ? "" : subject);
        o.put("at", System.currentTimeMillis());
        synchronized (INBOX) {
            while (INBOX.size() >= 20) INBOX.pollFirst();
            INBOX.addLast(o);
        }
        KidsNativePlugin p = instance;
        if (p != null) p.notifyListeners("shareReceived", o, true); // retained until consumed
    }

    @PluginMethod
    public void getPendingShares(PluginCall call) {
        JSArray shares = new JSArray();
        synchronized (INBOX) {
            while (!INBOX.isEmpty()) shares.put(INBOX.pollFirst());
        }
        JSObject ret = new JSObject();
        ret.put("shares", shares);
        call.resolve(ret);
    }

    /* ---------------- APK self-update installer (F14) ---------------- */

    /** Advisory only — returns stale false in-process right after the user grants it. */
    @PluginMethod
    public void canInstallPackages(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < 26
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("value", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("no-settings");
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("no-path"); return; }
        Context ctx = getContext();
        try {
            File apk = new File(path);
            if (!apk.exists()) { call.reject("file-missing"); return; }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW); // ACTION_INSTALL_PACKAGE is deprecated since API 29
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject("fileprovider-path-not-configured"); // the #1 misconfig — name it clearly
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("no-installer");
        } catch (Exception e) {
            call.reject("install-failed: " + e.getMessage());
        }
    }
}
