package io.github.lapnarrator;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * ネイティブ版の橋渡し（Web 側は native/web/native-bridge.js）。役割は 2 つだけ。
 *  1. マイク型フォアグラウンドサービスの開始・停止・状態（音の取得と保存は WebView のまま。設計書 4.9、提案 K-001）。
 *  2. 書き出した ZIP などを、システムの保存画面（ACTION_CREATE_DOCUMENT）で端末に保存する。共有（ACTION_SEND）も呼べる。
 * 通信はしない。
 */
@CapacitorPlugin(
    name = "LapRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class LapRecorderPlugin extends Plugin {

    private static final long START_WAIT_MS = 2500;
    private static final long POLL_MS = 50;

    private final Handler main = new Handler(Looper.getMainLooper());

    /** 保存画面で選ばれた出力先。書き終えるか、取りやめるまで開けておく。 */
    private static final class SaveSession {
        final Uri uri;
        final OutputStream out;
        long bytes = 0;
        SaveSession(Uri uri, OutputStream out) { this.uri = uri; this.out = out; }
    }

    private final Map<String, SaveSession> saves = new HashMap<>();

    /** 保存画面が開いている間は真。Capacitor は startActivityForResult の呼び出しを 1 つしか覚えないので、重ねて開かせない。 */
    private volatile boolean pickerPending = false;
    private volatile long pickerSince = 0;
    private static final long PICKER_STALE_MS = 10 * 60 * 1000;

    // ------------------------------------------------------------ フォアグラウンドサービス

    @PluginMethod
    public void startService(final PluginCall call) {
        Context ctx = getContext();
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            // マイク型のサービスは、RECORD_AUDIO が許可されていないと始められない（Android 14 以降は例外で落ちる）。
            call.reject("RECORD_AUDIO is not granted", "mic-permission-denied");
            return;
        }
        Intent i = new Intent(ctx, RecorderService.class)
            .setAction(RecorderService.ACTION_START)
            .putExtra(RecorderService.EXTRA_TITLE, call.getString("title", ctx.getString(R.string.app_name)))
            .putExtra(RecorderService.EXTRA_TEXT, call.getString("text", ""))
            .putExtra(RecorderService.EXTRA_STALL_TITLE, call.getString("stalledTitle"))
            .putExtra(RecorderService.EXTRA_STALL_TEXT, call.getString("stalledText"));
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (RuntimeException e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "start-failed");
            return;
        }
        // 実際に前面のサービスになったかを、短く待って確かめてから答える。
        final long deadline = System.currentTimeMillis() + START_WAIT_MS;
        main.post(new Runnable() {
            @Override
            public void run() {
                if (RecorderService.isRunning()) {
                    call.resolve(status());
                } else if (System.currentTimeMillis() >= deadline) {
                    String why = RecorderService.lastError();
                    call.reject(why != null ? why : "the service did not start in time", "service-not-running");
                } else {
                    main.postDelayed(this, POLL_MS);
                }
            }
        });
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, RecorderService.class));
        call.resolve();
    }

    @PluginMethod
    public void monitorRecording(PluginCall call) {
        RecorderService.monitorRecording(Boolean.TRUE.equals(call.getBoolean("active", false)));
        call.resolve();
    }

    /** WebView が録音データの保存を確認した心拍。 */
    @PluginMethod
    public void heartbeat(PluginCall call) {
        RecorderService.heartbeat();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        Context ctx = getContext();
        JSObject o = new JSObject();
        o.put("running", RecorderService.isRunning());
        o.put("lastServiceError", RecorderService.lastError());
        o.put("stalled", RecorderService.isStalled());
        o.put("stallCount", RecorderService.stallCount());
        o.put("lastBeatAgeMs", RecorderService.lastBeatAgeMs());
        o.put("microphone", getPermissionState("microphone").toString());
        o.put("notifications", notificationState().toString());
        o.put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        o.put("batteryOptimizationIgnored", pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        o.put("sdk", Build.VERSION.SDK_INT);
        return o;
    }

    private PermissionState notificationState() {
        // Android 12 以前には通知の実行時権限がなく、常に許可と同じ。
        if (Build.VERSION.SDK_INT < 33) return PermissionState.GRANTED;
        return getPermissionState("notifications");
    }

    /** 通知の許可（Android 13 以降）を、まだなら求める。断られても録音はできる（通知が見えないだけ）。 */
    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        if (notificationState() == PermissionState.GRANTED) {
            JSObject o = new JSObject();
            o.put("notifications", "granted");
            call.resolve(o);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject o = new JSObject();
        o.put("notifications", notificationState().toString());
        call.resolve(o);
    }

    // ------------------------------------------------------------ 端末への保存（システムの保存画面）

    @PluginMethod
    public void saveBegin(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\")) {
            call.reject("bad file name", "bad-name");
            return;
        }
        if (pickerPending && System.currentTimeMillis() - pickerSince < PICKER_STALE_MS) {
            call.reject("another save screen is open", "busy");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        pickerPending = true;
        pickerSince = System.currentTimeMillis();
        try {
            startActivityForResult(call, intent, "saveBeginResult");
        } catch (RuntimeException e) {
            pickerPending = false;
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "picker-failed");
        }
    }

    /** 保存画面から戻ったのに結果が来なかったとき（Activity の作り直しなど）に、橋渡しが呼ぶ。次の保存を受け付けられるようにする。 */
    @PluginMethod
    public void saveResetPending(PluginCall call) {
        pickerPending = false;
        call.resolve();
    }

    @ActivityCallback
    private void saveBeginResult(PluginCall call, ActivityResult result) {
        pickerPending = false;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled", "cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            // "wt"：同じ名前を選んで上書きになったとき、前の中身の尻尾が残らないように切り詰める。
            OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt");
            if (out == null) throw new IOException("cannot open the chosen location");
            String handle = UUID.randomUUID().toString();
            synchronized (saves) { saves.put(handle, new SaveSession(uri, out)); }
            JSObject o = new JSObject();
            o.put("handle", handle);
            o.put("uri", uri.toString());
            call.resolve(o);
        } catch (IOException | RuntimeException e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "open-failed");
        }
    }

    @PluginMethod
    public void saveWrite(PluginCall call) {
        SaveSession s = session(call.getString("handle"));
        String data = call.getString("data");
        if (s == null || data == null) { call.reject("unknown handle or no data", "bad-handle"); return; }
        try {
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            s.out.write(bytes);
            s.bytes += bytes.length;
            JSObject o = new JSObject();
            o.put("bytes", s.bytes);
            call.resolve(o);
        } catch (IOException | IllegalArgumentException e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "write-failed");
        }
    }

    @PluginMethod
    public void saveEnd(PluginCall call) {
        String handle = call.getString("handle");
        SaveSession s = session(handle);
        if (s == null) { call.reject("unknown handle", "bad-handle"); return; }
        try {
            s.out.flush();
            s.out.close();
            JSObject o = new JSObject();
            o.put("bytes", s.bytes);
            o.put("uri", s.uri.toString());
            call.resolve(o);
        } catch (IOException e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "close-failed");
        } finally {
            synchronized (saves) { saves.remove(handle); }
        }
    }

    /** 書きかけを取りやめる。作ってしまった空（または途中）のファイルは消す。 */
    @PluginMethod
    public void saveAbort(PluginCall call) {
        String handle = call.getString("handle");
        SaveSession s = session(handle);
        if (s != null) {
            try { s.out.close(); } catch (IOException ignored) { /* 無視 */ }
            try { DocumentsContract.deleteDocument(getContext().getContentResolver(), s.uri); } catch (Exception ignored) { /* 消せなくてもよい */ }
            synchronized (saves) { saves.remove(handle); }
        }
        call.resolve();
    }

    /** 保存したファイルの共有（ACTION_SEND）。saveEnd が返した uri を渡す。 */
    @PluginMethod
    public void share(PluginCall call) {
        String uriText = call.getString("uri");
        if (uriText == null) { call.reject("no uri", "bad-uri"); return; }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(call.getString("mimeType", "application/octet-stream"));
        send.putExtra(Intent.EXTRA_STREAM, Uri.parse(uriText));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, call.getString("title", null));
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(chooser);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage(), "share-failed");
        }
    }

    private SaveSession session(String handle) {
        if (handle == null) return null;
        synchronized (saves) { return saves.get(handle); }
    }

    // ------------------------------------------------------------ 画面（Activity）が閉じるとき

    @Override
    protected void handleOnDestroy() {
        // WebView が無くなると録音はできない。通知だけが残らないよう、サービスも止める。開いたままの保存先も閉じる。
        synchronized (saves) {
            for (SaveSession s : saves.values()) {
                try { s.out.close(); } catch (IOException ignored) { /* 無視 */ }
            }
            saves.clear();
        }
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, RecorderService.class));
        super.handleOnDestroy();
    }
}
