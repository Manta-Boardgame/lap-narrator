// 起動。外部の CDN、フォント、解析は使わない。接続先は自分のオリジンだけ（CSP は index.html）。
// 「no-release の begin／end」の目印の行で囲んだ部分は、配る版（native/scripts/prepare-www.mjs --release）では写しから取り除かれる。

import { readConfig } from './config.js';
import { App } from './app.js';
import { initUi } from './ui.js';
// @no-release:begin
import { installDevApi } from './dev-api.js';
// @no-release:end
import { setLang, detectLang, applyI18n } from './strings.js';

const config = readConfig();
// 言語：URL の ?lang= > 前回選んだ言語（localStorage の lap.lang）> 既定の英語。
let savedLang = null;
try { savedLang = localStorage.getItem('lap.lang'); } catch { /* 読めなくてもよい */ }
setLang(detectLang(config.lang || savedLang, navigator.language));

const app = new App(config);
const ui = initUi(app);
applyI18n(document);
app.init().catch(console.error);
// @no-release:begin
if (config.dev) installDevApi(app).ui = ui;

if ('serviceWorker' in navigator && !config.noSw) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
}
// @no-release:end
