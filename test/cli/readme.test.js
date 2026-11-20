// README.md の `narrate ...` のコマンドが、--help の usage に実在する（サブコマンドとフラグ）。新しい流れ（transcribe、align、boundary、render の新しいフラグ）も対象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, run } from './helpers/cli.js';
import { USAGE } from '../../cli/narrate.js';

const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const GLOBAL = new Set(['--workspace', '--json', '--help']);

// コードブロックの中の `narrate <sub> ...` の行（行頭、または前に空白だけ）
const lines = [];
let inFence = false;
for (const l of README.split('\n')) {
  if (l.trim().startsWith('```')) { inFence = !inFence; continue; }
  const m = inFence ? l.trim().match(/^narrate (\S+)(.*)$/) : null;
  if (m) lines.push({ sub: m[1], rest: m[2].replace(/（.*$/, ''), line: l.trim() });
}

test('README のコードブロックの narrate の行：サブコマンドとフラグが usage にある', () => {
  assert.ok(lines.length >= 15, `コマンドの行が少なすぎる: ${lines.length}`);
  for (const { sub, rest, line } of lines) {
    assert.ok(Object.hasOwn(USAGE, sub), `usage に無いサブコマンド: ${line}`);
    for (const f of rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)) assert.ok(GLOBAL.has(f[1]) || USAGE[sub].includes(f[1]), `usage に無いフラグ ${f[1]}: ${line}`);
  }
});

test('新しい流れの全コマンドが README にあり、usage にも boundary の 3 つの動詞と render の新しいフラグがある', () => {
  for (const sub of ['pack', 'import', 'status', 'transcribe', 'align', 'render', 'build', 'verify', 'boundary']) assert.ok(lines.some((l) => l.sub === sub), `README に ${sub} の例が無い`);
  for (const verb of ['boundary show', 'boundary set', 'boundary confirm']) assert.ok(README.includes(`narrate ${verb}`), verb);
  for (const f of ['--boundaries', '--allow-unconfirmed', '--no-boundaries', '--tail-margin-ms']) {
    assert.ok(USAGE.render.includes(f), `render の usage に ${f} が無い`);
    assert.ok(README.includes(f), `README に ${f} が無い`);
  }
  for (const verb of ['show', 'set', 'confirm']) assert.ok(USAGE.boundary.includes(`boundary ${verb}`), verb);
});

test('--help：workflow（新しい流れが主）と、transcribe／align／boundary の既定の出力先', async () => {
  const r = await run('--help');
  assert.equal(r.code, 0);
  assert.match(r.env.result.workflow, /transcribe -> align/);
  assert.match(r.env.result.workflowLegacy, /select/);
  for (const k of ['transcribe', 'align', 'boundary']) assert.ok(r.env.result.defaultOutputs[k], k);
  for (const k of Object.keys(r.env.result.usage)) assert.ok(r.env.result.defaultOutputs[k], `defaultOutputs に ${k} が無い`);
});
