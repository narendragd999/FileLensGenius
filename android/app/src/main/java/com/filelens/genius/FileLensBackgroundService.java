package com.filelens.genius;

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
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground Service with PARTIAL_WAKE_LOCK for uninterrupted background indexing & OCR.
 */
public class FileLensBackgroundService extends Service {

    public static final String CHANNEL_ID = "filelens_background_ocr_channel";
    public static final int NOTIFICATION_ID = 4102;
    public static final String ACTION_START = "com.filelens.genius.ACTION_BG_START";
    public static final String ACTION_UPDATE = "com.filelens.genius.ACTION_BG_UPDATE";
    public static final String ACTION_STOP = "com.filelens.genius.ACTION_BG_STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_PROGRESS = "progress";
    public static final String EXTRA_MAX = "max";

    private PowerManager.WakeLock wakeLock = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            releaseWakeLock();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            stopSelf();
            return START_NOT_STICKY;
        }

        String title = intent != null && intent.hasExtra(EXTRA_TITLE)
            ? intent.getStringExtra(EXTRA_TITLE)
            : "FileLens Genius";
        String body = intent != null && intent.hasExtra(EXTRA_BODY)
            ? intent.getStringExtra(EXTRA_BODY)
            : "Indexing & OCR running in background…";
        int progress = intent != null ? intent.getIntExtra(EXTRA_PROGRESS, 0) : 0;
        int max = intent != null ? intent.getIntExtra(EXTRA_MAX, 0) : 0;

        acquireWakeLock();
        Notification notif = buildNotification(title, body, progress, max);

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, notif);
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notif);
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FileLensGenius::BgIndexWakeLock");
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(30 * 60 * 1000L);
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Background Indexing & OCR",
                NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Keeps device indexing and OCR active when screen is off");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String title, String body, int progress, int max) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this,
            0,
            launch,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT
        );
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi);
        if (max > 0) {
            b.setProgress(max, Math.min(progress, max), false);
        } else {
            b.setProgress(0, 0, true);
        }
        return b.build();
    }
}
