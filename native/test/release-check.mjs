// 配る版（release）に、開発・試験用のものが入っていないことの試験（担当 B2。dev/proposals/B-003.md）。
//   A  prepare-www.mjs --release の出力（native/www の release 版）：
//      - 写さないはずのファイル（dev-api.js、devsource.js、sw.js、manifest.webmanifest、icons/、PC 側だけの core/ の部品、空のフォルダー）が無い
//      - 目印（@no-release）と、開発用のコード（installDevApi、createDevSource、window.__lap、window.lapNative、serviceWorker の登録）が残っていない
//      - build-info.js が release:true、読み込み（import）の行き先がすべて存在する、入口の HTML が manifest/アイコンを読まず、入口に URL パラメーターが付かない
//      - debug 版は今まで通り、すべて残っている（実機・エミュレーターの試験の道具が使う）
//   B  PC の Chrome で動かす：release 版は ?lapdev=1&devinput=1 などを付けても window.__lap も window.lapNative も無く、SW も登録されない。debug 版は有る（対照）。
//      release 版の画面でボタンを押すと、クリップボードに「Prompt version: <versionName>」のプロンプトが入る。
//   C  release APK（android/app/build/outputs/apk/release/app-release-unsigned.apk、または --apk <path>）を zip として開き、assets/ に除外したものが無い。
//      APK が無ければこの段だけ skip（APK は npm run build:android -- --release で作る）。中身が今の release 版と違えば警告（古い APK）。
// 使い方：node native/test/release-check.mjs [--apk <path>]      （node:test ではない。npm run test:native が bridge-check.mjs に続けて動かす）
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareWww, RELEASE_EXCLUDED_APP, importTargets } from '../scripts/prepare-www.mjs';
import { readZipDirectory } from '../../core/zip.js';
import { startStaticServer } from '../../test/app/helpers/static-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const work = join(root, 'work', 'B2', 'release-check');
const argv = process.argv.slice(2);
const apkArg = argv.indexOf('--apk') >= 0 ? argv[argv.indexOf('--apk') + 1] : null;
const apkPath = resolve(apkArg || join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'));

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + String(detail).split('\n').map((x) => x.trim()).filter(Boolean).join(' / ') : ''}`); };
const warn = (m) => console.log(`warn ${m}`);
const skip = (m) => console.log(`skip ${m}`);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (base, p) => relative(base, p).split(sep).join('/');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- A．出力の中身

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const rel$ = prepareWww({ release: true, out: join(work, 'www-release'), log: () => {} });
const dbg$ = prepareWww({ release: false, out: join(work, 'www-debug'), log: () => {} });
const R = rel$.www; const D = dbg$.www;
const relFiles = rel$.files; const dbgFiles = dbg$.files;

// 写さないはずのもの
const mustBeAbsent = [
  ...RELEASE_EXCLUDED_APP.map((p) => `app/${p}`), // 'app/icons' はフォルダー
  'core/importer.js', 'core/index.js', 'core/loudness.js', 'core/timeline.js', // PC 側（CLI）だけの部品。app は読み込まない
];
for (const p of mustBeAbsent) {
  const present = relFiles.filter((f) => f === p || f.startsWith(`${p}/`));
  check(`release に無い：${p}`, present.length === 0, present.join(', '));
}
check('release に空のフォルダー（app/i18n、app/organizer）が無い', !existsSync(join(R, 'app', 'i18n')) && !existsSync(join(R, 'app', 'organizer')));
check('release に試験・見本・開発の名前のファイルが無い', relFiles.filter((f) => /(^|\/)(tests?|examples?|fixtures?|samples?|demos?|mocks?|testgen|dev)(\/|[.-]|$)|dev-api|devsource/i.test(f)).length === 0,
  relFiles.filter((f) => /(^|\/)(tests?|examples?|fixtures?|samples?|demos?|mocks?|testgen|dev)(\/|[.-]|$)|dev-api|devsource/i.test(f)).join(', '));
check('release に残すべきものがある（画面、台本の読み込み、書き出し、プロンプト、橋渡し）',
  ['app/index.html', 'app/styles.css', 'app/src/main.js', 'app/src/export-ui.js', 'app/src/script-pack.js', 'app/src/ai-prompt.js', 'app/prompts/video-prompt.md', 'app/src/native-bridge.js',
    'app/src/worker/recorder-worker.js', 'app/src/worklet/capture-processor.js', 'core/zip.js', 'core/validate.js', 'index.html'].every((p) => relFiles.includes(p)),
  ['app/index.html', 'app/prompts/video-prompt.md', 'core/zip.js'].filter((p) => !relFiles.includes(p)).join(', '));

// 見本の台本（jp15 の「ほしぞら町図書館」「夜の読み聞かせ会」など）・見本の名前が、製品に入っていない
const SAMPLE_WORDS = new RegExp(['ほしぞら', 'ホシゾラ', '星空', '読み聞かせ', '図書館', 'tiny3', 'jp15', '見本', '(^|[^a-z])demo([^a-z]|$)', 'デモ'].join('|'), 'i');
const sampleHits = relFiles.filter((f) => /[.](js|html|css|md)$/.test(f)).filter((f) => SAMPLE_WORDS.test(fs.readFileSync(join(R, f), 'utf8')));
check('release のファイルに、見本の台本・見本の名前（ほしぞら、読み聞かせ、図書館、tiny3、jp15、demo など）が無い', sampleHits.length === 0, sampleHits.join(', '));

// コードの中身
const textOf = (base, f) => readFileSync(join(base, f), 'utf8');
const code = relFiles.filter((f) => /\.(js|html)$/.test(f));
const bad = [];
for (const f of code) {
  const s = textOf(R, f);
  if (/@no-release/.test(s)) bad.push(`${f}: @no-release の目印が残っている`);
  for (const [re, what] of [
    [/\binstallDevApi\b/, 'installDevApi'], [/\bcreateDevSource\b/, 'createDevSource'], [/window\.__lap\b/, 'window.__lap'], [/window\.lapNative\b/, 'window.lapNative'],
    [/__lapNativeTune/, '__lapNativeTune'], [/serviceWorker\s*\.\s*register/, 'serviceWorker.register'], [/['"]\.?\/?(?:src\/)?(?:dev-api|devsource)\.js['"]/, 'dev-api／devsource の読み込み'],
  ]) if (re.test(s)) bad.push(`${f}: ${what}`);
}
check('release のコードに、開発用の入口・目印・SW の登録が残っていない', bad.length === 0, bad.join(' | '));
check('release の build-info.js は release:true', /release:\s*true/.test(textOf(R, 'app/src/build-info.js')) && /versionName:\s*"[^"]+"/.test(textOf(R, 'app/src/build-info.js')), textOf(R, 'app/src/build-info.js').trim().split('\n').pop());
const indexHtml = textOf(R, 'app/index.html');
check('release の画面の HTML は manifest・アイコンを読まない', !/manifest|apple-touch-icon|icons\//.test(indexHtml.replace(/manifest-src 'self'; /, '')));
check('release の入口（index.html）に URL パラメーター（?nosw=1 など）が付かない', !/\?/.test(textOf(R, 'index.html').match(/url=([^"]+)"/)[1]), textOf(R, 'index.html').match(/url=([^"]+)"/)[1]);
check('debug の入口は ?nosw=1 のまま', /url=app\/index\.html\?nosw=1/.test(textOf(D, 'index.html')));

// 読み込みの行き先がすべて存在する
const dangling = [];
for (const f of relFiles.filter((x) => x.endsWith('.js'))) {
  for (const t of importTargets(join(R, f), textOf(R, f))) if (!existsSync(t)) dangling.push(`${f} → ${rel(R, t)}`);
}
check('release の import の行き先がすべて存在する', dangling.length === 0, dangling.join(' | '));
// worker／worklet は URL で読む
for (const [from, re] of [['app/src/backend.js', /new URL\('\.\/(worker\/recorder-worker\.js)'/], ['app/src/capture.js', /addModule\([^)]*?(worklet\/capture-processor\.js)/]]) {
  const m = re.exec(textOf(R, from));
  check(`release に ${from} が読む部品がある`, !m || relFiles.includes(`app/src/${m[1]}`), m ? m[1] : '(参照の書き方が変わった：試験を直す)');
}

// debug は今まで通り（すべて残る）
for (const p of ['app/src/dev-api.js', 'app/src/devsource.js', 'app/sw.js', 'app/manifest.webmanifest', 'app/icons/icon.svg', 'core/index.js', 'core/importer.js']) check(`debug に有る：${p}`, dbgFiles.includes(p));
check('debug は橋渡しの診断用の入口（window.lapNative）と main.js の開発用の入口を残す', /window\.lapNative\b/.test(textOf(D, 'app/src/native-bridge.js')) && /installDevApi/.test(textOf(D, 'app/src/main.js')) && /release:\s*false/.test(textOf(D, 'app/src/build-info.js')));
check('debug の画面の HTML は manifest を読む', /manifest\.webmanifest/.test(textOf(D, 'app/index.html')));

// release の config.js は、URL パラメーターをすべて無視する
{
  const mod = await import(pathToFileURL(join(R, 'app', 'src', 'config.js')).href);
  const c = mod.readConfig('?devinput=1&lapdev=1&nosw=1&rawMax=100&volumeMax=10&finalMax=60&testMs=200&countdown=0&durableMs=20&hook=after-audio&hookAt=5&devRate=44100&lang=en');
  const def = mod.readConfig('');
  check('release の readConfig は、開発・試験用のパラメーターをすべて無視する', JSON.stringify(c) === JSON.stringify(def) && c.dev === false && c.devinput === false && c.hook === null && c.noSw === false && c.lang === null, JSON.stringify(c));
  const mod2 = await import(pathToFileURL(join(D, 'app', 'src', 'config.js')).href);
  const c2 = mod2.readConfig('?lapdev=1&testMs=200');
  check('debug の readConfig は今まで通り効く', c2.dev === true && c2.testMs === 200);
}

// ---------------------------------------------------------------- B．PC の Chrome

const profile = join(root, 'work', 'B2', 'chrome-profile');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
let ctx = null;
const servers = [];
try {
  const srvR = await startStaticServer({ root: R, port: 8118 }); servers.push(srvR);
  const srvD = await startStaticServer({ root: D, port: 8119 }); servers.push(srvD);
  ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check', '--mute-audio'] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srvR.origin });
  // ネイティブの WebView を模す（橋渡しが働く）。試験用の待ち時間の指定も置く。release は無視するはず
  await ctx.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, nativePromise: () => Promise.resolve({}) };
    window.__lapNativeTune = { noKeepAlive: true };
  });
  const open = async (srv, query) => {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/[/]favicon[.]ico$/.test(m.location().url || '')) errors.push(`console: ${m.text()} ${m.location().url || ''}`); }); // 画面の HTML はアイコンを読まない。ブラウザが自分で取りに行く /favicon.ico の 404 だけ除く
    const bad404 = [];
    page.on('response', (r) => { if (r.status() >= 400) bad404.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.goto(`${srv.origin}/app/index.html${query}`);
    await page.waitForSelector('#view-home:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(500);
    return { page, errors, bad404 };
  };
  const probe = (page) => page.evaluate(async () => ({
    lap: typeof window.__lap, lapNative: typeof window.lapNative, saveBlob: typeof window.lapSaveBlob,
    acWrapped: Object.getPrototypeOf(window.AudioContext).name === 'AudioContext', // 橋渡しが AudioContext を包んでいる（noKeepAlive を無視している）
    sw: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1,
  }));

  const q = '?lapdev=1&devinput=1&countdown=0&rawMax=1000&testMs=100&hook=after-audio&nosw=0';
  const relPage = await open(srvR, q);
  const rp = await probe(relPage.page);
  check('release：?lapdev=1&devinput=1 … を付けても window.__lap が無い', rp.lap === 'undefined', JSON.stringify(rp));
  check('release：橋渡しの診断用の入口（window.lapNative）が無い', rp.lapNative === 'undefined');
  check('release：書き出し画面が保存結果を受け取る入口がある', rp.saveBlob === 'function');
  check('release：試験用の指定（__lapNativeTune の noKeepAlive）を無視する', rp.acWrapped === true);
  check('release：Service Worker を登録しない', rp.sw === 0, `登録数 ${rp.sw}`);
  check('release：画面が出て、エラーも 404 もない', relPage.errors.length === 0 && relPage.bad404.length === 0, [...relPage.errors, ...relPage.bad404].join(' | '));
  const swGet = await fetch(`${srvR.origin}/app/sw.js`); const devGet = await fetch(`${srvR.origin}/app/src/dev-api.js`);
  check('release：sw.js と dev-api.js は配られない（404）', swGet.status === 404 && devGet.status === 404, `${swGet.status} ${devGet.status}`);

  // release の画面でボタンを押すと、クリップボードにプロンプトが入る（versionName が入る）
  await relPage.page.click('#ai-prompt-copy');
  await relPage.page.waitForFunction(() => /コピーしました|Copied/.test(document.getElementById('ai-prompt-msg').textContent), null, { timeout: 15000 });
  const clip = (await relPage.page.evaluate(() => navigator.clipboard.readText())).split('\r\n').join('\n'); // Windows のクリップボードは改行を CRLF にする
  check('release：ボタンで「Prompt version: <versionName>」のプロンプトがコピーされる', new RegExp(`^# .*\\n\\nPrompt version: ${rel$.versionName.replace(/[.]/g, '\\.')}\\n`).test(clip) && clip.includes('Respond to the user in the user\'s own language'), clip.slice(0, 120));
  await relPage.page.close();

  const dbg = await open(srvD, '?lapdev=1&countdown=0');
  const dp = await probe(dbg.page);
  check('debug（対照）：?lapdev=1 で window.__lap が有り、window.lapNative も有り、noKeepAlive が効く', dp.lap === 'object' && dp.lapNative === 'object' && dp.acWrapped === false, JSON.stringify(dp));
  check('debug（対照）：画面が出て、エラーがない', dbg.errors.length === 0, dbg.errors.join(' | '));
  await dbg.page.close();
} catch (e) {
  check('PC の Chrome での確認が最後まで動いた', false, String((e && e.stack) || e).split('\n').slice(0, 4).join(' / '));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
}

// ---------------------------------------------------------------- C．release APK の中身

if (!existsSync(apkPath)) {
  skip(`release APK がない（${apkPath}）。npm run build:android -- --release で作ってから動かす`);
} else {
  const buf = readFileSync(apkPath);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const read = async (s, e) => u8.slice(s, e);
  const dir = await readZipDirectory(read, u8.length);
  const names = dir.map((e) => e.name);
  const assets = names.filter((n) => n.startsWith('assets/public/'));
  const pub = assets.map((n) => n.slice('assets/public/'.length));
  console.log(`info APK：${apkPath}（${statSync(apkPath).size} バイト、${names.length} エントリ、assets/public/ は ${pub.length} 件）`);
  check('APK：assets/public/ に app/ と core/ の release 版がある', pub.includes('app/index.html') && pub.includes('app/src/main.js') && pub.includes('core/zip.js'));
  for (const p of mustBeAbsent) {
    const present = pub.filter((f) => f === p || f.startsWith(`${p}/`));
    check(`APK に無い：${p}`, present.length === 0, present.join(', '));
  }
  const odd = names.filter((n) => /(^|\/)(dev-api|devsource)\.js$|(^|\/)(sw\.js|manifest\.webmanifest)$|(^|\/)(tests?|examples?|fixtures?|samples?|demos?|mocks?|testgen)\//i.test(n) && !/^(res\/|META-INF\/|kotlin\/|org\/apache\/cordova\/)/.test(n));
  check('APK の assets/ などに、試験・見本・開発の名前のものが無い', odd.length === 0, odd.join(', '));
  // assets/ の中の、アプリのファイルが release 版の出力と同じ集合か
  const extra = pub.filter((f) => !relFiles.includes(f) && !['cordova.js', 'cordova_plugins.js'].includes(f));
  const missing = relFiles.filter((f) => !pub.includes(f));
  check('APK の assets/public/ は、今の release 版の出力と同じファイルの集合（cordova の空の部品を除く）', extra.length === 0 && missing.length === 0, `余分：${extra.join(', ') || 'なし'} / 足りない：${missing.join(', ') || 'なし'}`);
  const byName = new Map(dir.map((e) => [e.name, e]));
  // core/zip.js は無圧縮の ZIP だけ読めるので、APK（deflate）はここで展開する
  const readAll = async (name) => {
    const e = byName.get(name);
    const o = e.offset;
    const start = o + 30 + (u8[o + 26] | (u8[o + 27] << 8)) + (u8[o + 28] | (u8[o + 29] << 8));
    const raw = Buffer.from(u8.subarray(start, start + e.compressedSize));
    return e.method === 0 ? raw : inflateRawSync(raw);
  };
  const apkSample = [];
  for (const n of assets.filter((x) => /[.](js|html|css|md|json)$/.test(x))) if (SAMPLE_WORDS.test((await readAll(n)).toString('utf8'))) apkSample.push(n);
  check('APK の assets に、見本の台本・見本の名前が無い', apkSample.length === 0, apkSample.join(', '));
  const info = (await readAll('assets/public/app/src/build-info.js')).toString('utf8');
  check('APK の build-info.js は release:true', /release:\s*true/.test(info), info.trim().split('\n').pop());
  const stale = [];
  for (const f of relFiles) if (pub.includes(f) && sha(await readAll(`assets/public/${f}`)) !== sha(readFileSync(join(R, f)))) stale.push(f);
  if (stale.length) warn(`APK の中身が今の release 版と違う（古い APK）：${stale.slice(0, 6).join(', ')}${stale.length > 6 ? ` ほか ${stale.length - 6} 件` : ''}。npm run build:android -- --release でやり直す`);
  else console.log('info APK の assets/public/ は、今の release 版の出力とバイト単位で同じ');
  // マニフェスト（debuggable でない）
  const bt = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'build-tools');
  const ver = existsSync(bt) ? readdirSync(bt).sort().pop() : null;
  const aapt2 = ver ? join(bt, ver, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2') : null;
  if (aapt2 && existsSync(aapt2)) {
    const r = spawnSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' });
    check('APK は debuggable ではない（aapt2 dump badging）', r.status === 0 && !/debuggable/i.test(r.stdout), r.status === 0 ? '' : r.stderr.slice(0, 100));
  } else skip('aapt2 が見つからないので、debuggable の確認は skip');
}

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通った');
process.exit(failed ? 1 : 0);
