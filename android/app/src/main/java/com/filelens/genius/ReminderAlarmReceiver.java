package com.filelens.genius;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Fires automatic high-priority reminder notifications for Second Brain scheduled tasks.
 */
public class ReminderAlarmReceiver extends BroadcastReceiver {

    public static final String CHANNEL_ID = "filelens_auto_reminders_v1";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_NOTIF_ID = "notif_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        String title = intent.getStringExtra(EXTRA_TITLE);
        String body = intent.getStringExtra(EXTRA_BODY);
        int notifId = intent.getIntExtra(EXTRA_NOTIF_ID, (int) (System.currentTimeMillis() & 0x7FFFFFFF));

        if (title == null || title.trim().isEmpty()) title = "FileLens Reminder";
        if (body == null || body.trim().isEmpty()) body = "Scheduled task reminder";

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Task & Schedule Alerts",
                NotificationManager.IMPORTANCE_HIGH
            );
            ch.setDescription("Automatic alerts for scheduled Second Brain plans");
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 500, 250, 500});
            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (soundUri == null) soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            ch.setSound(soundUri, attrs);
            nm.createNotificationChannel(ch);
        }

        Intent launch = new Intent(context, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            context,
            notifId,
            launch,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                : PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notif = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build();

        nm.notify(notifId, notif);
    }
}
