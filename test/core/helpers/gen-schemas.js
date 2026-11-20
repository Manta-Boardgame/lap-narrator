// schema/*.schema.json から core/schemas.js を作る開発用スクリプト（core/ の外に置く：core は fs を使わない）。
// 使い方：node test/core/helpers/gen-schemas.js   （schema/ を変えたら動かす。test/core/validate.test.js が差を検出する）
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function generate() {
  const dir = join(root, 'schema');
  const names = readdirSync(dir).filter((f) => f.endsWith('.schema.json')).map((f) => f.replace(/\.schema\.json$/, '')).sort();
  let out = '// schema/*.schema.json の写し。生成物：node test/core/helpers/gen-schemas.js で作り直す（手で書き換えない）。\n';
  out += '// core は fs を使わないので、スキーマを JS のオブジェクトとして持つ。schema/ が正で、test/core/validate.test.js が一致を検査する。\n';
  out += 'export const SCHEMAS = {\n';
  for (const n of names) {
    const json = JSON.parse(readFileSync(join(dir, `${n}.schema.json`), 'utf8'));
    out += `  ${JSON.stringify(n)}: ${JSON.stringify(json, null, 2).replace(/\n/g, '\n  ')},\n`;
  }
  out += '};\n';
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, 'core', 'schemas.js'), generate());
  console.log('wrote core/schemas.js');
}
