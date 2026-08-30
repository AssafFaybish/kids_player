package com.assaf.kidsplayer;

// Kids Player — v1.0.63: KEEP PLAYING WHEN THE SCREEN GOES OFF (user request).
//
// This is the app's FIRST service, and it takes the manifest from two permissions to five.
// That cost is the whole reason the feature is opt-in, per profile, and OFF unless a parent
// turns it on: a family that never opens the setting gains no service and no notification.
//
// WHY A FOREGROUND SERVICE AT ALL. Android stops a backgrounded app's media unless it is
// tied to a foreground service of type mediaPlayback. There is no lighter mechanism — a
// wake lock keeps the CPU awake but does not stop the WebView being frozen.
//
// ⚠️ IT IS STARTED WHILE THE APP IS STILL FOREGROUND, NEVER FROM onAppPause. Since API 31
// an app in the background may not start a foreground service at all (ForegroundService-
// StartNotAllowedException), and `onAppPause` is already too late on some OEMs. So JS starts
// it when an eligible video BEGINS PLAYING — which is also why the notification appears
// during ordinary viewing: it is the control, and every media app behaves this way.
//
// ⚠️ THE NOTIFICATION IS A SURFACE A CHILD CAN REACH FROM THE LOCK SCREEN, including on a
// kiosk-locked tablet. It carries exactly three actions — previous, play/pause, next — and
// no way to open the app or leave it. Adding a content intent here would be a hole in the
// containment lock (v1.0.56), which is why there deliberately is none.
//
// Canonical copy: native-reference/PlaybackService.java — keep both in sync.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class PlaybackService extends Service {

    public static final String ACTION_START = "com.assaf.kidsplayer.PLAYBACK_START";
    public static final String ACTION_STOP  = "com.assaf.kidsplayer.PLAYBACK_STOP";
    public static final String ACTION_PREV  = "com.assaf.kidsplayer.PLAYBACK_PREV";
    public static final String ACTION_TOGGLE = "com.assaf.kidsplayer.PLAYBACK_TOGGLE";
    public static final String ACTION_NEXT  = "com.assaf.kidsplayer.PLAYBACK_NEXT";

    private static final String CHANNEL_ID = "kids_playback";
    private static final int NOTIFICATION_ID = 4711;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        // A button on the notification: hand it to JS, which owns every playback decision
        // (which video is next, whether it is a gift, whether the folder has run out). The
        // service deliberately knows none of that — one answer, in one place.
        if (ACTION_PREV.equals(action) || ACTION_TOGGLE.equals(action) || ACTION_NEXT.equals(action)) {
            String cmd = ACTION_PREV.equals(action) ? "prev" : ACTION_NEXT.equals(action) ? "next" : "toggle";
            KidsNativePlugin.emitPlaybackCommand(cmd);
            return START_NOT_STICKY;
        }
        String title = intent == null ? null : intent.getStringExtra("title");
        boolean playing = intent == null || intent.getBooleanExtra("playing", true);
        startForegroundCompat(buildNotification(title, playing));
        // NOT sticky: a service the SYSTEM restarts after killing the app would resume a
        // notification for a video no longer playing, with a JS side that no longer exists.
        return START_NOT_STICKY;
    }

    private void startForegroundCompat(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable ignored) {
            // API 31+ can refuse the start outright, and API 33+ can have POST_NOTIFICATIONS
            // denied. Never crash the app over a convenience: the video simply pauses on
            // background as it did before this feature existed.
        }
    }

    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) {}
    }

    private PendingIntent commandIntent(String action, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, requestCode, i, flags);
    }

    private Notification buildNotification(String title, boolean playing) {
        ensureChannel();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        b.setContentTitle(title == null || title.isEmpty() ? getString(R.string.app_name) : title)
         .setContentText(getString(R.string.app_name))
         .setSmallIcon(android.R.drawable.ic_media_play)
         .setOngoing(true)
         .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= 21) b.setVisibility(Notification.VISIBILITY_PUBLIC);
        // ⚠️ NO setContentIntent: tapping the notification must not open (or re-open) the
        // app. Under a containment lock that would be a way out of a locked folder, and on
        // a kiosk tablet a way back into a session the parent ended.
        b.addAction(new Notification.Action.Builder(
                iconOf(android.R.drawable.ic_media_previous), "הקודם", commandIntent(ACTION_PREV, 1)).build());
        b.addAction(new Notification.Action.Builder(
                iconOf(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play),
                playing ? "השהיה" : "ניגון", commandIntent(ACTION_TOGGLE, 2)).build());
        b.addAction(new Notification.Action.Builder(
                iconOf(android.R.drawable.ic_media_next), "הבא", commandIntent(ACTION_NEXT, 3)).build());
        if (Build.VERSION.SDK_INT >= 21) {
            Notification.MediaStyle style = new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2);
            b.setStyle(style);
        }
        return b.build();
    }

    /** Notification.Action.Builder takes an Icon on API 23+ and an int below it. */
    private android.graphics.drawable.Icon iconOf(int res) {
        return Build.VERSION.SDK_INT >= 23 ? android.graphics.drawable.Icon.createWithResource(this, res) : null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // IMPORTANCE_LOW: the control must be reachable, but a media notification that
        // makes a sound or vibrates every time a song changes is a tablet that wakes a
        // sleeping child up.
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "ניגון", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }
}
