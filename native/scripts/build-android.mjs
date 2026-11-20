// ネイティブ版（Android）のデバッグ APK を作る。npm run build:android から呼ぶ。
//   1. native/www を作る（prepare-www.mjs。--release のときは --release を付け、開発・試験用のものを除く）
//   2. cap sync android（native/www → android/app/src/main/assets/public）
//   3. android/gradlew.bat assembleDebug
// 環境変数は、このコマンドの子プロセスにだけ渡す（システムの設定は変えない）。
//   JAVA_HOME     既定：Android Studio 同梱の JDK（C:\Program Files\Android\Android Studio\jbr）
//   ANDROID_HOME  既定：%LOCALAPPDATA%\Android\Sdk
//   Gradle の作業場所、Android の利用者設定、JVM の user.home は、リポジトリの中（work/K/）にする（PC の利用者フォルダへ書かない。AGP の利用状況の記録も ~/.android に出ないようにする）。
// 追加の導入はしない。足りない SDK の部品があれば、android/gradle.properties の android.builder.sdkDownload=false で失敗する。
// 使い方：node native/scripts/build-android.mjs [--no-stop] [--release]    （--no-stop：終わっても Gradle のデーモンを止めない。--release：署名なしの release APK）
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const nativeDir = join(root, 'native');
const androidDir = join(root, 'android');
const isWin = process.platform === 'win32';

const javaHome = process.env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr';
const sdk = process.env.ANDROID_HOME || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const work = process.env.LAP_NATIVE_WORK || join(root, 'work', 'K');
const gradleHome = join(work, 'gradle-home');
const androidUserHome = join(work, 'android-user-home');
const fakeHome = join(work, 'home'); // Gradle の JVM の user.home。AGP の利用状況の記録（~/.android/metrics）が PC の利用者フォルダへ書かれないようにする
mkdirSync(gradleHome, { recursive: true });
mkdirSync(androidUserHome, { recursive: true });
mkdirSync(fakeHome, { recursive: true });

for (const [name, p] of [['JAVA_HOME', javaHome], ['ANDROID_HOME', sdk]]) {
  if (!p || !existsSync(p)) { console.error(`${name} が見つからない: ${p || '(未設定)'}`); process.exit(2); }
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  GRADLE_USER_HOME: gradleHome,
  ANDROID_USER_HOME: androidUserHome,
  JAVA_TOOL_OPTIONS: `-Duser.home="${fakeHome}"`,
  CI: 'true', // Capacitor CLI の利用状況の送信と質問を止める
};

function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  console.log(`\n== ${label}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], env, shell: false, ...opts });
  console.log(`== ${label}: exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
  return r.status ?? 1;
}

const noStop = process.argv.includes('--no-stop');
const release = process.argv.includes('--release'); // 署名なしの release APK（android/app/build/outputs/apk/release/app-release-unsigned.apk）。署名鍵は作らない
const node = process.execPath;
const gradlew = isWin ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew');
const gradleCmd = isWin ? 'cmd.exe' : gradlew;
const gradleArgs = (a) => (isWin ? ['/c', gradlew, ...a] : a);

// release のときは、開発・試験用のものを写さない版を作る（prepare-www.mjs --release）。debug は今まで通り、すべて写す。
let status = run(release ? 'prepare-www (release)' : 'prepare-www', node, [join(here, 'prepare-www.mjs'), ...(release ? ['--release'] : [])]);
if (status === 0) status = run('cap sync android', node, [join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], { cwd: nativeDir });
if (status === 0) status = run(release ? 'gradle assembleRelease' : 'gradle assembleDebug', gradleCmd, gradleArgs([release ? 'assembleRelease' : 'assembleDebug', '--console=plain']), { cwd: androidDir });
if (!noStop) run('gradle --stop', gradleCmd, gradleArgs(['--stop', '--console=plain']), { cwd: androidDir });

if (status === 0) {
  const apk = release ? join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk') : join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (existsSync(apk)) console.log(`\nAPK: ${apk} (${statSync(apk).size} バイト)`);
}
process.exit(status);
