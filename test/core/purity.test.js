import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// CONTRACTS.md 2 と 1.8、PLAN.md の A：core は実行環境に依存しない純粋な ES モジュール。
const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core');

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

/** コメントを取り除く（文字列の中の // は URL の形 :// だけを避ける簡易版） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = walk(coreDir);

test('core/ の .js を見つけている', () => {
  assert.ok(files.length >= 14, `files=${files.length}`);
});

for (const file of files) {
  const rel = relative(coreDir, file).replace(/\\/g, '/');
  const code = stripComments(readFileSync(file, 'utf8'));

  test(`core/${rel}：import はすべて相対パス（node: も外部の部品も無い）`, () => {
    const specs = [...code.matchAll(/(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const dyn = [...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const s of [...specs, ...dyn]) assert.ok(s.startsWith('./') || s.startsWith('../'), `${rel}: ${s}`);
    assert.ok(!/\bnode:/.test(code), `${rel} に node: がある`);
    assert.ok(!/\brequire\s*\(/.test(code), `${rel} に require がある`);
  });

  test(`core/${rel}：Buffer、process、fs、crypto、global を使わない`, () => {
    assert.ok(!/\bBuffer\b/.test(code), `${rel}: Buffer`);
    assert.ok(!/\bprocess\s*\./.test(code), `${rel}: process`);
    assert.ok(!/\bglobalThis\.(process|Buffer)\b/.test(code), `${rel}: globalThis`);
    assert.ok(!/\bcrypto\b/.test(code), `${rel}: crypto`);
    assert.ok(!/\bfs\b/.test(code), `${rel}: fs`);
  });

  test(`core/${rel}：結果が環境で変わりうる数学関数（三角関数、exp、log、pow）と乱数を使わない`, () => {
    const m = code.match(/\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|random)\b/);
    assert.equal(m, null, `${rel}: ${m && m[0]}`);
    assert.ok(!/\bMath\.PI\b/.test(code), `${rel}: Math.PI`);
  });
}

test('時刻（Date、performance）を使ってよいのは importer.js の受領時刻だけ。結果の再現性に使わない', () => {
  for (const file of files) {
    const rel = relative(coreDir, file).replace(/\\/g, '/');
    const code = stripComments(readFileSync(file, 'utf8'));
    const uses = /\b(new Date|Date\.now|performance\.now)\b/.test(code);
    if (rel === 'importer.js') assert.ok(uses, '受領時刻に使っている'); else assert.ok(!uses, `${rel} が時刻を使っている`);
  }
});
