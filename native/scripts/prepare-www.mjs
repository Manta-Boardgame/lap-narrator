// ネイティブ版（Capacitor）の WebView に載せる静的ファイルを native/www/ に作る。
// - app/（PWA）と core/ を、リポジトリと同じ相対配置（/app/…、/core/…）で写す。app/ の中身は変えない（写しにだけ手を入れる）。
// - 写しの app/index.html に、ネイティブの橋渡し（native/web/native-bridge.js）を読む <script> を 1 行足す。
//   橋渡しは app/ の変更案（dev/proposals/K-001.md）が採用されるまでの暫定で、app/ のコードを書き換えずに動く形にしてある。
// native/www/ は生成物（.gitignore）。依存なし（Node.js の標準だけ）。
//
// 使い方：node native/scripts/prepare-www.mjs [--release] [--out <dir>]
//   既定（debug）：開発・試験用のファイルも写す（実機・エミュレーターの試験の道具が使う）。
//   --release    ：配る版。開発・試験用のものを写さず、読み込みも外す（dev/proposals/B-003.md の棚卸し）。
//     - 写さないもの：app/src/dev-api.js（window.__lap）、app/src/devsource.js（偽の入力）、app/sw.js と app/manifest.webmanifest と app/icons/（ネイティブ版では使わない）、
//       空のフォルダー（app/i18n、app/organizer）、core/ のうち app が読み込まないもの（PC 側だけの部品）。
//     - 取り除くコード：`@no-release:begin` から `@no-release:end` までの行（.js と .html。main.js の開発用の入口と SW の登録、app.js の偽の入力、native-bridge.js の診断用の入口）。
//     - 書き換えるもの：app/src/build-info.js（release:true。以後、URL パラメーターはすべて無視される）、入口の index.html の ?nosw=1（付けない）。
//   --out <dir>  ：出力先（既定 native/www）。リポジトリの中の、リポジトリ直下ではない場所だけ。
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/** 配る版で写さない app/ のファイル（app/ からの相対パス。/ 区切り）。 */
export const RELEASE_EXCLUDED_APP = Object.freeze(['src/dev-api.js', 'src/devsource.js', 'sw.js', 'manifest.webmanifest', 'icons']);

/** `@no-release:begin` … `@no-release:end` の行（目印の行も含む）を取り除く。目印が揃っていなければ例外。 */
export function stripNoRelease(text, label = '') {
  const lines = text.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const begin = /@no-release:begin/.test(line);
    const end = /@no-release:end/.test(line);
    if (begin) { if (inside) throw new Error(`${label}: @no-release:begin が入れ子になっている`); inside = true; continue; }
    if (end) { if (!inside) throw new Error(`${label}: @no-release:end に対応する begin がない`); inside = false; continue; }
    if (!inside) out.push(line);
  }
  if (inside) throw new Error(`${label}: @no-release:begin に対応する end がない`);
  return out.join('\n');
}

/** import／import() の相対パスの行き先を集める。 */
export function importTargets(file, text) {
  const out = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) out.push(resolve(dirname(file), m[2]));
  return out;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function versionNameOf() {
  const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
  const m = /versionName\s+"([^"]+)"/.exec(gradle);
  if (!m) throw new Error('android/app/build.gradle に versionName が見つからない');
  return m[1];
}

export function prepareWww({ release = false, out = join(root, 'native', 'www'), log = console.log } = {}) {
  const www = resolve(out);
  const rel = relative(root, www);
  if (!rel || rel.startsWith('..') || resolve(rel) === rel) throw new Error(`--out はリポジトリの中の、直下ではない場所だけ（${www}）`);

  // appStartPath は先頭が / でないと、起動 URL が https://localhostapp/… になり、Capacitor の橋渡しが付かない（K-001 10.1）
  const cfg = JSON.parse(readFileSync(join(root, 'native', 'capacitor.config.json'), 'utf8'));
  const startPath = cfg.server && cfg.server.appStartPath;
  if (startPath && !startPath.startsWith('/')) throw new Error(`native/capacitor.config.json: server.appStartPath は / で始める（${startPath}）`);

  rmSync(www, { recursive: true, force: true });
  mkdirSync(www, { recursive: true });

  const appSrc = join(root, 'app');
  const appDst = join(www, 'app');
  const excluded = new Set(release ? RELEASE_EXCLUDED_APP.map((p) => join(appSrc, ...p.split('/'))) : []);
  cpSync(appSrc, appDst, { recursive: true, filter: (src) => !excluded.has(src) });

  // 中身が空のフォルダー（app/i18n、app/organizer）は、配る版では写さない
  if (release) {
    const pruneEmpty = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
      if (readdirSync(dir).length === 0 && dir !== appDst) rmSync(dir, { recursive: true });
    };
    pruneEmpty(appDst);
  }

  cpSync(join(root, 'native', 'web', 'native-bridge.js'), join(appDst, 'src', 'native-bridge.js'));

  // ビルドの情報（アプリの版は、ネイティブ版の versionName）
  const versionName = versionNameOf();
  writeFileSync(join(appDst, 'src', 'build-info.js'),
    '// native/scripts/prepare-www.mjs が作った写し（元は app/src/build-info.js）。\n' +
    `export const BUILD = Object.freeze({ release: ${release ? 'true' : 'false'}, versionName: ${JSON.stringify(versionName)} });\n`);

  // 配る版：目印で囲んだ開発用のコードを取り除く
  if (release) {
    for (const f of walk(appDst)) {
      if (!/\.(js|html)$/.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      if (!/@no-release:/.test(text)) continue;
      writeFileSync(f, stripNoRelease(text, relative(root, f)));
    }
  }

  // core/：配る版では、app が読み込むものだけ
  const coreSrc = join(root, 'core');
  if (release) {
    const appFiles = walk(appDst).filter((f) => f.endsWith('.js'));
    // app の写しの中の `../../core/…` は www の中の core/ を指すので、元の core/ の位置で解く
    const need = new Set();
    const queue = [];
    for (const f of appFiles) {
      for (const t of importTargets(f, readFileSync(f, 'utf8'))) {
        const asRepo = join(root, relative(www, t));
        if (asRepo.startsWith(coreSrc + sep)) { need.add(asRepo); queue.push(asRepo); }
      }
    }
    while (queue.length) {
      const f = queue.pop();
      for (const t of importTargets(f, readFileSync(f, 'utf8'))) if (t.startsWith(coreSrc + sep) && !need.has(t)) { need.add(t); queue.push(t); }
    }
    for (const f of need) {
      if (!existsSync(f)) throw new Error(`app が読み込む core のファイルがない: ${relative(root, f)}`);
      const dst = join(www, 'core', relative(coreSrc, f));
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(f, dst);
    }
  } else {
    cpSync(coreSrc, join(www, 'core'), { recursive: true });
  }

  // Capacitor は www/index.html を前提にするので、app/ へ移すだけの入口を置く（起動のパスは appStartPath でも指定する）。
  // debug は ?nosw=1（SW を登録しない）。配る版は URL パラメーターを一切使わない。
  const target = release ? 'app/index.html' : 'app/index.html?nosw=1';
  writeFileSync(join(www, 'index.html'),
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>lap-narrator</title>' +
    `<meta http-equiv="refresh" content="0;url=${target}"></head><body></body></html>\n`);

  const indexPath = join(appDst, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  const marker = '<script type="module" src="src/main.js"></script>';
  if (!html.includes(marker)) throw new Error('app/index.html に main.js の <script> が見つからない。prepare-www.mjs を直す必要がある');
  html = html.replace(marker, '<script src="src/native-bridge.js"></script>\n' + marker);
  writeFileSync(indexPath, html);

  if (!existsSync(join(www, 'core', release ? 'zip.js' : 'index.js'))) throw new Error('core/ のファイルがない');
  const files = walk(www).map((f) => posix.normalize(relative(www, f).split(sep).join('/'))).sort();
  log(`native/www を作った（${release ? 'release' : 'debug'}、versionName ${versionName}、${files.length} ファイル、${www}）`);
  return { www, release, versionName, files };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !out) { console.error('--out には出力先が要る'); process.exit(2); }
  try {
    prepareWww({ release: argv.includes('--release'), ...(out ? { out } : {}) });
  } catch (e) {
    console.error(String(e && e.message || e));
    process.exit(1);
  }
}
