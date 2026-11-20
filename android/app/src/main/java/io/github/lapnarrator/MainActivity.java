package io.github.lapnarrator;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "LapDiag";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自作のプラグインは、super.onCreate の前に登録する（Capacitor の決まり）。
        registerPlugin(LapRecorderPlugin.class);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
        applyDebugExtras(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyDebugExtras(intent);
    }

    /**
     * 診断用（デバッグ APK のときだけ。リリースの APK では何もしない）。実機の自動試験が、利用者の操作なしでロックと前面化を繰り返せるよう、
     * intent の extra で切り替える。
     *   lap_show_when_locked (boolean) 真：キーガードの上に出て、画面を点ける（setShowWhenLocked / setTurnScreenOn）
     *   lap_renderer_priority  (string) "important"：WebView のレンダラーを「画面が隠れても重要」のままにする（setRendererPriorityPolicy(IMPORTANT, false)）
     *                                   "default"：既定（IMPORTANT, waivedWhenNotVisible=true）に戻す
     */
    private void applyDebugExtras(Intent i) {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable || i == null) return;
        if (i.hasExtra("lap_show_when_locked")) {
            boolean on = i.getBooleanExtra("lap_show_when_locked", false);
            setShowWhenLocked(on);
            setTurnScreenOn(on);
            Log.i(TAG, "showWhenLocked/turnScreenOn=" + on);
        }
        String rp = i.getStringExtra("lap_renderer_priority");
        if (rp != null && getBridge() != null) {
            WebView wv = getBridge().getWebView();
            if (wv != null) {
                if ("important".equals(rp)) wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                else wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
                Log.i(TAG, "rendererPriority=" + rp + " -> policy=" + wv.getRendererRequestedPriority() + " waived=" + wv.getRendererPriorityWaivedWhenNotVisible());
            }
        }
    }
}
