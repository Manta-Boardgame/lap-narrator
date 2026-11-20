package io.github.lapnarrator;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * マイク型のフォアグラウンドサービス。画面を消している間や、ほかのアプリが前面にある間も、アプリのプロセスと
 * WebView のマイク（getUserMedia）を生かしておくためだけの入れ物。音は取らず、書かない（取得と保存は WebView 側のまま）。
 * 通知を出し、CPU が眠らないよう部分的なウェイクロックを持つ。
 */
public class RecorderService extends Service {
    static final String ACTION_START = "io.github.lapnarrator.action.START";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    private static final String CHANNEL_ID = "lap_recording";
    private static final int NOTIFICATION_ID = 4101;
    // 録音の長さに上限は設けない。ウェイクロックは長めの期限を付け、サービスの開始のたびに取り直す。
    private static final long WAKELOCK_TIMEOUT_MS = 24L * 60 * 60 * 1000;

    private static volatile boolean running = false;
    private static volatile String lastError = null;

    // 見張りは録音中だけ動く。心拍は WebView が音声と位置の保存を確認した後に届く。
    static final String EXTRA_STALL_TITLE = "stalledTitle";
    static final String EXTRA_STALL_TEXT = "stalledText";
    private static final String ALERT_CHANNEL_ID = "lap_alert";
    private static final int ALERT_ID = 4102;
    static final long STALL_MS = 2500;
    private static final long START_GRACE_MS = 1000;
    private static final long CHECK_MS = 500;
    private static final long REALERT_MS = 20000;
    private static volatile long lastBeatAt = 0;
    private static volatile long monitoringSince = 0;
    private static volatile boolean stalled = false;
    private static volatile int stallCount = 0;
    private static volatile long stalledSince = 0;

    private PowerManager.WakeLock wakeLock;
    private final android.os.Handler watchHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private String normalTitle = "";
    private String normalText = "";
    private String stallTitle = "Recording has stopped";
    private String stallText = "Saved recording progress has stalled. Open the app to check the recording.";
    private long lastAlertAt = 0;
    private final Runnable watch = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            long now = android.os.SystemClock.elapsedRealtime();
            long since = monitoringSince;
            long ref = lastBeatAt == 0 ? since + START_GRACE_MS : lastBeatAt;
            boolean dead = since != 0 && now - ref >= STALL_MS;
            if (dead && !stalled) {
                stalled = true;
                stallCount++;
                stalledSince = now;
                alert(now);
            } else if (dead && now - lastAlertAt >= REALERT_MS) {
                alert(now);
            } else if (!dead && stalled) {
                stalled = false;
                clearAlert();
            }
            watchHandler.postDelayed(this, CHECK_MS);
        }
    };

    static boolean isRunning() { return running; }
    static String lastError() { return lastError; }
    static void monitorRecording(boolean active) {
        lastBeatAt = 0;
        monitoringSince = active && running ? android.os.SystemClock.elapsedRealtime() : 0;
    }

    /** WebView が録音データの保存を確認した心拍。 */
    static void heartbeat() {
        if (monitoringSince != 0) lastBeatAt = android.os.SystemClock.elapsedRealtime();
    }
    static boolean isStalled() { return stalled; }
    static int stallCount() { return stallCount; }
    static long lastBeatAgeMs() { return lastBeatAt == 0 ? -1 : android.os.SystemClock.elapsedRealtime() - lastBeatAt; }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null ? intent.getStringExtra(EXTRA_TITLE) : getString(R.string.app_name);
        String text = intent != null && intent.getStringExtra(EXTRA_TEXT) != null ? intent.getStringExtra(EXTRA_TEXT) : "";
        normalTitle = title;
        normalText = text;
        if (intent != null && intent.getStringExtra(EXTRA_STALL_TITLE) != null) stallTitle = intent.getStringExtra(EXTRA_STALL_TITLE);
        if (intent != null && intent.getStringExtra(EXTRA_STALL_TEXT) != null) stallText = intent.getStringExtra(EXTRA_STALL_TEXT);
        try {
            ensureChannel();
            Notification n = buildNotification(title, text);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // 型を渡せるのは Android 11（API 30）から。10 以前にはマイクの背景制限がなく、型なしで足りる。
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            acquireWakeLock();
            lastError = null;
            running = true;
            monitorRecording(false);
            stalled = false;
            watchHandler.removeCallbacks(watch);
            watchHandler.postDelayed(watch, CHECK_MS);
        } catch (RuntimeException e) {
            // 権限がない、背景から始めようとした、など。アプリごと落ちないよう、理由を残して止まる。
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
            running = false;
            stopSelf();
        }
        // プロセスが落ちたあとに、WebView のない状態で勝手に再開しない。
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 最近使ったアプリから消された（WebView も消える）。通知だけが残らないよう止める。
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        monitorRecording(false);
        watchHandler.removeCallbacks(watch);
        stalled = false;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(ALERT_ID);
        releaseWakeLock();
        super.onDestroy();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, getString(R.string.recording_channel_name), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(getString(R.string.recording_channel_description));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    /** 止まったことを、音と振動で知らせる（重要度の高い通知の経路。許可が無いと見えないが、前面の通知は書き換える）。20 秒おきに繰り返す。 */
    private void alert(long now) {
        lastAlertAt = now;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(ALERT_CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(ALERT_CHANNEL_ID, getString(R.string.alert_channel_name), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(getString(R.string.alert_channel_description));
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[] { 0, 400, 200, 400, 200, 800 });
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        try { nm.notify(NOTIFICATION_ID, buildNotification(stallTitle, stallText)); } catch (RuntimeException e) { /* 無視 */ }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle(stallTitle)
            .setContentText(stallText)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(stallText))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVibrate(new long[] { 0, 400, 200, 400, 200, 800 })
            .setDefaults(NotificationCompat.DEFAULT_SOUND)
            .setOnlyAlertOnce(false)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        try { nm.notify(ALERT_ID, n); } catch (RuntimeException e) { /* 通知の許可がない */ }
    }

    private void clearAlert() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try { nm.cancel(ALERT_ID); nm.notify(NOTIFICATION_ID, buildNotification(normalTitle, normalText)); } catch (RuntimeException e) { /* 無視 */ }
    }

    private Notification buildNotification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .build();
    }

    private void acquireWakeLock() {
        releaseWakeLock();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lap-narrator:recording");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
