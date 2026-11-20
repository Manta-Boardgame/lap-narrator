// 台本のノートの時間の目安（【約15秒】など）は、話さないので、照合の前に取り除く（checker/speech/align.py の strip_note_markers）。
// 日本語は引数ではなく標準入力（UTF-8）で渡す（Windows の引数のコードページに左右されないため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

function strip(text) {
  const code = [
    'import sys, json',
    'sys.path.insert(0, sys.argv[1])',
    'import align',
    'text = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'sys.stdout.buffer.write(json.dumps(align.strip_note_markers(text), ensure_ascii=True).encode("ascii"))',
  ].join('\n');
  const r = spawnSync(PY, ['-I', '-c', code, path.join(ROOT, 'checker', 'speech')], { input: Buffer.from(JSON.stringify(text), 'utf8') });
  assert.equal(r.status, 0, String(r.stderr));
  return JSON.parse(r.stdout.toString('ascii'));
}

test('先頭の時間の目安を取り除く', () => {
  assert.equal(strip('【約15秒】ほしぞらゼミの発表を始めます。'), 'ほしぞらゼミの発表を始めます。');
  assert.equal(strip('【約1分30秒】はじめに全体像です。'), 'はじめに全体像です。');
  assert.equal(strip('[約40秒] 背景です。'), '背景です。');
});

test('文の途中の括弧や、時間でない先頭の括弧は取り除かない', () => {
  assert.equal(strip('提言です。【約15秒】ほか'), '提言です。【約15秒】ほか');
  assert.equal(strip('【注】あとで確認'), '【注】あとで確認');
  assert.equal(strip(''), '');
});
