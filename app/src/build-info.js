// ビルドの情報。リポジトリの中の値は release:false（開発・試験用の入口が使える）。
// native/scripts/prepare-www.mjs が、native/www/ の写しだけを書き換える（release のときは release:true。この値が true のとき、URL パラメーターはすべて無視する）。
// versionName は、ネイティブ版のアプリの版（android/app/build.gradle の versionName）。リポジトリの中では null で、APP_VERSION（config.js）を使う。
export const BUILD = Object.freeze({ release: false, versionName: null });
