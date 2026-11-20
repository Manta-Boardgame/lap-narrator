// 共通の決まり（CONTRACTS.md 3.1）：封筒、進み具合、終了コード、使い方の誤り、ワークスペースの保存先（store）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validate } from '../../core/validate.js';
import { createFsStore } from '../../cli/lib/store.js';
import { parseArgs } from '../../cli/lib/args.js';
import { run, spawnCli, tmpDir, cleanup } from './helpers/cli.js';

const T = { timeout: 60000 };

test('引数なし：使い方の誤り（終了コード 2）。封筒は schema/cli-result に通る', T, async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.equal(r.env.ok, false);
  assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] });
  assert.equal(r.env.errors[0].code, 'usage');
});

test('未知のコマンド・未知の引数・値の欠け・workspace の欠け：すべて終了コード 2', T, async () => {
  for (const argv of [['frobnicate'], ['status', '--bogus'], ['select', '--slide'], ['status'], ['render'], ['import'], ['pack'], ['validate'], ['build', '--method', 'C', '--workspace', 'x']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'usage', JSON.stringify(argv));
    assert.deepEqual(validate('cli-result', r.env), { ok: true, errors: [] }, JSON.stringify(argv));
  }
});

test('--help は使い方を result に出して終了コード 0', T, async () => {
  const r = await run(['status', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.env.result.usage, /status/);
});

test('本物のプロセス：標準出力は 1 つの JSON だけ、終了コードが OS に伝わる（--json の有無にかかわらず）', T, async () => {
  for (const extra of [[], ['--json']]) {
    const r = await spawnCli(['status', ...extra]);
    assert.equal(r.code, 2);
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).command, 'status');
  }
});

test('parseArgs：--name value、--name=value、真偽、--、繰り返し', () => {
  const spec = { out: 'string', keep: 'boolean', tag: 'list' };
  const r = parseArgs(['a.zip', '--out', 'x', '--keep', '--tag=1', '--tag', '2', '--', '--weird', 'b'], spec);
  assert.deepEqual(r.opts, { out: 'x', keep: true, tag: ['1', '2'] });
  assert.deepEqual(r.positionals, ['a.zip', '--weird', 'b']);
  assert.throws(() => parseArgs(['--out'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--out', '--keep'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--nope'], spec), /unknown option/);
});

test('store：書いて読む、list、remove、空のフォルダの片付け、一時ファイルは見えない', T, async () => {
  const dir = await tmpDir('store');
  try {
    const s = createFsStore(path.join(dir, 'ws'));
    assert.equal(await s.readJson('a.json'), null);
    await s.writeJson('x/y/a.json', { a: 1 });
    assert.deepEqual(await s.readJson('x/y/a.json'), { a: 1 });
    assert.equal(await s.exists('x/y/a.json'), true);
    assert.equal(await s.exists('x/y/b.json'), false);
    const w = await s.openWrite('x/raw/one.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.write(new Uint8Array([4, 5]));
    // 閉じるまでは本来の名前に現れない（一時ファイルに書いている）
    assert.equal(await s.exists('x/raw/one.bin'), false);
    assert.deepEqual(await s.list('x/'), ['x/y/a.json']);
    await w.close();
    assert.deepEqual(await s.list('x/'), ['x/raw/one.bin', 'x/y/a.json']);
    assert.deepEqual(await s.list('x/r'), ['x/raw/one.bin']);
    assert.deepEqual(await s.list(''), ['x/raw/one.bin', 'x/y/a.json']);
    const r = await s.openRead('x/raw/one.bin');
    assert.equal(r.size, 5);
    assert.deepEqual([...(await r.read(1, 4))], [2, 3, 4]);
    await s.remove('x/raw/one.bin');
    await s.remove('x/raw/one.bin'); // 無くてもよい
    assert.deepEqual(await s.list(''), ['x/y/a.json']);
    await s.remove('x/y/a.json');
    // 空になったフォルダは消える（ルートは残る）
    assert.deepEqual(await fsp.readdir(path.join(dir, 'ws')), []);
  } finally { await cleanup(dir); }
});

test('store：書き込みの途中で abort すると、何も残らない。上書きは名前の変更で行う', T, async () => {
  const dir = await tmpDir('store');
  try {
    const s = createFsStore(path.join(dir, 'ws'));
    await s.writeJson('a.json', { v: 1 });
    const w = await s.openWrite('a.json');
    await w.write(new TextEncoder().encode('{"v":'));
    assert.deepEqual(await s.readJson('a.json'), { v: 1 }); // 書きかけは見えない
    await w.abort();
    assert.deepEqual(await s.readJson('a.json'), { v: 1 });
    assert.deepEqual(await fsp.readdir(path.join(dir, 'ws')), ['a.json']);
    await s.writeJson('a.json', { v: 2 });
    assert.deepEqual(await s.readJson('a.json'), { v: 2 });
  } finally { await cleanup(dir); }
});

test('store：ワークスペースの外への書き込みを拒否する', T, async () => {
  const dir = await tmpDir('store');
  try {
    const s = createFsStore(path.join(dir, 'ws'));
    const bad = ['../evil.json', 'a/../../evil.json', '/abs.json', 'C:/evil.json', 'a\\b.json', 'a//b.json', './a.json', '', 'a/\0b'];
    for (const p of bad) {
      await assert.rejects(() => s.writeJson(p, {}), { code: 'bad-path' }, JSON.stringify(p));
      await assert.rejects(() => s.openWrite(p), { code: 'bad-path' }, JSON.stringify(p));
      await assert.rejects(() => s.readJson(p), { code: 'bad-path' }, JSON.stringify(p));
      await assert.rejects(() => s.remove(p), { code: 'bad-path' }, JSON.stringify(p));
    }
    await assert.rejects(() => s.list('../'), { code: 'bad-path' });
    assert.deepEqual(await fsp.readdir(dir), []); // 外には何も作られていない
  } finally { await cleanup(dir); }
});

test('store：シンボリックリンクで外へ出る書き込みも拒否する（リンクを作れない環境では飛ばす）', T, async (t) => {
  const dir = await tmpDir('store');
  try {
    const outside = path.join(dir, 'outside');
    await fsp.mkdir(outside);
    await fsp.mkdir(path.join(dir, 'ws'));
    try { await fsp.symlink(outside, path.join(dir, 'ws', 'link'), 'junction'); } catch { t.skip('cannot create a link here'); return; }
    const s = createFsStore(path.join(dir, 'ws'));
    await assert.rejects(() => s.writeJson('link/evil.json', {}), { code: 'bad-path' });
    assert.deepEqual(await fsp.readdir(outside), []);
  } finally { await cleanup(dir); }
});

test('store：壊れた JSON は bad-json', T, async () => {
  const dir = await tmpDir('store');
  try {
    await fsp.mkdir(path.join(dir, 'ws'));
    await fsp.writeFile(path.join(dir, 'ws', 'a.json'), '{nope');
    await assert.rejects(() => createFsStore(path.join(dir, 'ws')).readJson('a.json'), { code: 'bad-json' });
  } finally { await cleanup(dir); }
});
