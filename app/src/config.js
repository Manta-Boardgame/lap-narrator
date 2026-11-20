// URL パラメータからの設定。試験のために小さな値へ変えられる（既定値は CONTRACTS.md 0.6 などに従う）。
import { RAW_MAX_BYTES, VOLUME_MAX_BYTES, FINAL_MAX_BYTES, DEFAULT_SAMPLE_RATE } from '../../core/constants.js';
import { BUILD } from './build-info.js';

export const APP_VERSION = '0.1.0-wave1';

/** アプリの版の表示（ネイティブ版では versionName、そうでなければ APP_VERSION）。 */
export function appVersionName() { return BUILD.versionName || APP_VERSION; }

// release のビルドでは、URL パラメーターをすべて無視する（試験用の入口、小さな値への変更、強制終了の狙いなどは、配る版では使えない）。
export function readConfig(search = (typeof location !== 'undefined' ? location.search : ''), release = BUILD.release) {
  const p = new URLSearchParams(release ? '' : search);
  const num = (key, dflt) => {
    const raw = p.get(key);
    if (raw === null || raw === '') return dflt;
    const n = Number(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const devinput = p.get('devinput') === '1';
  const dev = devinput || p.get('lapdev') === '1';
  // rawMaxBytes は 1 サンプル（2 バイト）の倍数にする。
  const rawMaxBytes = Math.max(2, Math.floor(num('rawMax', RAW_MAX_BYTES) / 2) * 2);
  return {
    devinput,
    dev,
    rawMaxBytes,
    volumeMaxBytes: Math.max(1, num('volumeMax', VOLUME_MAX_BYTES)),
    // 完成した音声の 1 ファイルの上限（これを超えると final/<slideId>.p001.wav… に分ける）
    finalMaxBytes: Math.max(46, num('finalMax', FINAL_MAX_BYTES)),
    // 試し録りの長さ（ミリ秒）。既定 10 秒
    testMs: Math.max(100, num('testMs', 10000)),
    // 録音の開始・再開のカウントダウンは無い（押したらすぐ始まる）。URL パラメーター countdown は、残っていても無視する。
    // 「保存位置の記録」を書く間隔（音声の時間のミリ秒）。既定 1000。
    durableMs: Math.max(10, num('durableMs', 1000)),
    // 試験用のフック（強制終了の位置を狙う）。?hook=after-audio|mid-event|before-rotate&hookAt=<通しの位置のサンプル>
    hook: p.get('hook') || null,
    hookAt: Math.max(0, num('hookAt', 0)),
    // 開発用の入力の標準のサンプリング周波数
    devSampleRate: num('devRate', DEFAULT_SAMPLE_RATE),
    lang: p.get('lang') || null,
    noSw: p.get('nosw') === '1',
  };
}
