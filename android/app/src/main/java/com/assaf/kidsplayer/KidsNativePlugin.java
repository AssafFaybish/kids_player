package com.assaf.kidsplayer;

// Kids Player — the single custom native surface, three features:
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
