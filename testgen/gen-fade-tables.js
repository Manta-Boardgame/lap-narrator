// フェード係数の表（raised-cosine、Q16 固定小数）を作って、test/oracle/fade-tables.js に直書きする。
// 実行時に三角関数を呼ばないようにするため、表は 1 度だけここで作る。
//
//   T[i] = round_half_even( 65536 * (1 - cos(pi * (i + 0.5) / N)) / 2 ),  i = 0 .. N-1
//
// T[0] が最も小さく（つなぎ目に最も近い端）、T[N-1] が最も大きい。T[i] + T[N-1-i] = 65536。
// 使い方：node testgen/gen-fade-tables.js
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FADE_LENGTHS = [1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 480];

function roundHalfEven(x) {
  const f = Math.floor(x);
  const r = x - f;
  if (r < 0.5) return f;
  if (r > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function makeTable(n) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const x = (65536 * (1 - Math.cos((Math.PI * (i + 0.5)) / n))) / 2;
    const frac = x - Math.floor(x);
    if (Math.abs(frac - 0.5) < 1e-6) throw new Error(`table N=${n} i=${i}: too close to a tie (${x})`);
    t.push(roundHalfEven(x));
  }
  for (let i = 0; i < n; i++) if (t[i] + t[n - 1 - i] !== 65536) throw new Error(`table N=${n}: not symmetric at ${i}`);
  for (let i = 1; i < n; i++) if (t[i] < t[i - 1]) throw new Error(`table N=${n}: not monotonic at ${i}`);
  return t;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = [];
  lines.push('// 自動生成：testgen/gen-fade-tables.js（手で書き換えない）。');
  lines.push('// フェード係数の表（raised-cosine、Q16 固定小数）。');
  lines.push('//   T[i] = round_half_even( 65536 * (1 - cos(pi * (i + 0.5) / N)) / 2 ),  i = 0 .. N-1');
  lines.push('// T[0] が最も小さく、つなぎ目に最も近い端のサンプルにかける。T[i] + T[N-1-i] = 65536。');
  lines.push('export const FADE_TABLES = {');
  for (const n of FADE_LENGTHS) {
    const t = makeTable(n);
    lines.push(`  ${n}: [`);
    for (let i = 0; i < t.length; i += 16) lines.push('    ' + t.slice(i, i + 16).join(', ') + ',');
    lines.push('  ],');
  }
  lines.push('};');
  lines.push('');
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'oracle', 'fade-tables.js');
  writeFileSync(out, lines.join('\n'));
  console.log('wrote', out);
}
