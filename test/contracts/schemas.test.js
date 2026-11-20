import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');
// CONTRACTS.md 2.1: core/validate.js が実装する部分集合
const ALLOWED = new Set([
  '$schema', '$id', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'oneOf', '$ref', '$defs',
]);
const PROPERTY_MAPS = new Set(['properties', '$defs']);

function walk(node, path, problems) {
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`, problems)); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (!ALLOWED.has(k) && !PROPERTY_MAPS.has(path.split('/').pop())) {
      // 直前が properties / $defs のときのキーはプロパティ名なので検査しない
      const parentKey = path.split('/').slice(-1)[0];
      if (!PROPERTY_MAPS.has(parentKey)) problems.push(`${path}: 使えないキーワード ${k}`);
    }
    if (k === '$ref' && !(typeof v === 'string' && v.startsWith('#/$defs/'))) problems.push(`${path}: $ref は同じファイル内の #/$defs/ だけ`);
    if (k === 'additionalProperties' && typeof v !== 'boolean') problems.push(`${path}: additionalProperties は真偽のみ`);
    walk(v, `${path}/${k}`, problems);
  }
}

const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));

test('schema/ にスキーマがある', () => {
  assert.ok(files.length >= 8, `見つかった数: ${files.length}`);
});

for (const f of files) {
  test(`${f}: JSON として読め、使えるキーワードだけを使う`, () => {
    const schema = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.ok(schema.$id && schema.$id.startsWith('lap-narrator/'), '$id が lap-narrator/ で始まる');
    const problems = [];
    walk(schema, f, problems);
    assert.deepEqual(problems, []);
  });
}
