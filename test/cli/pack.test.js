// pack：Markdown／JSON／pptx から台本パックを作る（CONTRACTS.md 1.1、3.2）。pptx は偽の取り出しスクリプトで、引数と終了コードの扱いだけを試す（PowerPoint は動かさない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkScript } from '../../core/script.js';
import { readZipDirectory, readZipEntry } from '../../core/zip.js';
import { sha256Hex } from '../../core/sha256.js';
import { renderSlidePng } from '../../testgen/lib/png.js';
import { run, tmpDir, cleanup, writeTinySource, ROOT } from './helpers/cli.js';

const T = { timeout: 120000 };
const BOM = '﻿';

async function readPack(file) {
  const buf = new Uint8Array(await fsp.readFile(file));
  const read = async (s, e) => buf.slice(s, e);
  const entries = await readZipDirectory(read, buf.length);
  const out = new Map();
  for (const e of entries) {
    const parts = [];
    for await (const c of readZipEntry(read, e)) parts.push(c);
    out.set(e.name, Buffer.concat(parts));
  }
  return { names: entries.map((e) => e.name), files: out, script: JSON.parse(out.get('script.json').toString('utf8')), bytes: buf };
}

test('pack --from-json：台本パックができる。ハッシュは core の規則どおり、見本の台本パックと同じバイト列', T, async () => {
  const dir = await tmpDir('pack');
  try {
    await writeTinySource(path.join(dir, 'src'));
    const out = path.join(dir, 'p.zip');
    const r = await run('pack', '--from-json', path.join(dir, 'src'), '--out', out);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.env.ok, true);
    assert.equal(r.env.result.projectId, 'tiny3_demo');
    assert.equal(r.env.result.slideCount, 3);
    const pack = await readPack(out);
    assert.deepEqual(pack.names, ['script.json', 'slides/0001.png', 'slides/0002.png', 'slides/0003.png']);
    assert.deepEqual(checkScript(pack.script), { ok: true, errors: [] });
    assert.equal(r.env.result.scriptHash, pack.script.scriptHash);
    assert.equal(pack.script.slides[0].imageSha256, sha256Hex(new Uint8Array(pack.files.get('slides/0001.png'))));
    // 担当 E の見本（examples/packs/tiny3.zip）と、スライドの文・ID が同じなので、同じ台本のハッシュ、同じバイト列になる
    const ex = new Uint8Array(await fsp.readFile(path.join(ROOT, 'examples', 'packs', 'tiny3.zip')));
    assert.equal(r.env.result.sha256, sha256Hex(ex));
    assert.equal(sha256Hex(new Uint8Array(pack.bytes)), sha256Hex(ex));
    // 進み具合は標準エラー出力に 1 行 1 JSON
    assert.ok(r.progress.length >= 1 && r.progress.every((p) => p.progress && typeof p.progress.stage === 'string'));
  } finally { await cleanup(dir); }
});

test('pack --from-json：projectId の指定がなければ内容から決まる（同じ内容なら同じ。違えば違う）。指定すればそれを使う', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const src = path.join(dir, 'src');
    await writeTinySource(src);
    const doc = JSON.parse(await fsp.readFile(path.join(src, 'script.json'), 'utf8'));
    delete doc.projectId;
    await fsp.writeFile(path.join(src, 'script.json'), JSON.stringify(doc));
    const a = await run('pack', '--from-json', src, '--out', path.join(dir, 'a.zip'));
    const b = await run('pack', '--from-json', src, '--out', path.join(dir, 'b.zip'));
    assert.match(a.env.result.projectId, /^proj-[0-9a-f]{12}$/);
    assert.equal(a.env.result.projectId, b.env.result.projectId);
    assert.equal(a.env.result.sha256, b.env.result.sha256);
    doc.slides[0].text += 'あ';
    await fsp.writeFile(path.join(src, 'script.json'), JSON.stringify(doc));
    const c = await run('pack', '--from-json', src, '--out', path.join(dir, 'c.zip'));
    assert.notEqual(c.env.result.projectId, a.env.result.projectId);
    const d = await run('pack', '--from-json', src, '--out', path.join(dir, 'd.zip'), '--project-id', 'my_project-1');
    assert.equal(d.env.result.projectId, 'my_project-1');
    const bad = await run('pack', '--from-json', src, '--out', path.join(dir, 'e.zip'), '--project-id', 'x y');
    assert.equal(bad.code, 1);
    assert.equal(bad.env.errors[0].code, 'bad-input');
  } finally { await cleanup(dir); }
});

test('pack --from-json：slideId・recordable の既定、画像の探し方（番号、slideId、明示）、画像がないときの警告', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const src = path.join(dir, 'src');
    await fsp.mkdir(path.join(src, 'pics'), { recursive: true });
    await fsp.writeFile(path.join(src, 'script.json'), JSON.stringify({
      title: '三枚', slides: [
        { text: '一枚目。', image: 'pics/first.png' },
        { text: '', title: '仕切り' },
        { slideId: 'intro', text: '最後。', speaker: '話者A', targetSec: 3.5 },
      ],
    }));
    await fsp.writeFile(path.join(src, 'pics', 'first.png'), renderSlidePng(1, { width: 64, height: 36 }));
    await fsp.writeFile(path.join(src, '0002.png'), renderSlidePng(2, { width: 64, height: 36 }));
    // 3 枚目の画像はない
    const r = await run('pack', '--from-json', path.join(src, 'script.json'), '--out', path.join(dir, 'p.zip'));
    assert.equal(r.code, 0, r.stdout);
    const pack = await readPack(path.join(dir, 'p.zip'));
    assert.deepEqual(pack.script.slides.map((s) => [s.slideId, s.order, s.recordable, s.image ?? null]), [
      ['s0001', 1, true, 'slides/0001.png'], ['s0002', 2, false, 'slides/0002.png'], ['intro', 3, true, null],
    ]);
    assert.equal(pack.script.slides[2].speaker, '話者A');
    assert.equal(pack.script.slides[2].targetSec, 3.5);
    assert.deepEqual(r.env.warnings.map((w) => w.code), ['image-missing']);
    assert.deepEqual(checkScript(pack.script), { ok: true, errors: [] });
  } finally { await cleanup(dir); }
});

test('pack --from-json：入力の不備は終了コード 1（空の slides、重複する slideId、PNG でない画像、フォルダの外を指す画像）', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const src = path.join(dir, 'src');
    await fsp.mkdir(src, { recursive: true });
    const go = async (doc) => { await fsp.writeFile(path.join(src, 'script.json'), JSON.stringify(doc)); return run('pack', '--from-json', src, '--out', path.join(dir, 'p.zip')); };
    let r = await go({ title: 'x', slides: [] });
    assert.equal(r.code, 1);
    r = await go({ title: 'x', slides: [{ slideId: 'a', text: 'あ' }, { slideId: 'a', text: 'い' }] });
    assert.equal(r.code, 1);
    assert.match(r.env.errors[0].message, /duplicate slideId/);
    await fsp.writeFile(path.join(src, '0001.png'), 'not a png');
    r = await go({ title: 'x', slides: [{ text: 'あ' }] });
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'unsupported-image');
    r = await go({ title: 'x', slides: [{ text: 'あ', image: '../outside.png' }] });
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'bad-image-path');
    r = await run('pack', '--from-json', path.join(dir, 'nonexistent'), '--out', path.join(dir, 'p.zip'));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
    await assert.rejects(fsp.stat(path.join(dir, 'p.zip'))); // 失敗したときは出力を作らない
    r = await run('pack', '--from-json', src, '--from-markdown', 'x.md', '--out', 'y.zip');
    assert.equal(r.code, 2);
  } finally { await cleanup(dir); }
});

test('pack --from-markdown --images：## ごとに 1 枚、<!-- --> で話者などを指定', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const imgs = path.join(dir, 'imgs');
    await fsp.mkdir(imgs);
    await fsp.writeFile(path.join(imgs, '0001.png'), renderSlidePng(1, { width: 64, height: 36 }));
    await fsp.writeFile(path.join(imgs, '2.png'), renderSlidePng(2, { width: 64, height: 36 }));
    await fsp.writeFile(path.join(imgs, 'extra.png'), renderSlidePng(3, { width: 64, height: 36 }));
    const md = [
      '# 夜の会', '', '前置きは無視される。', '',
      '## はじめに', '<!-- speaker: 話者A; targetSec: 12 -->', 'こんばんは。', '', '', '', '今日は本の紹介です。', '',
      '## 補足', '<!-- id: sup1 -->', '<!-- recordable: false -->', '録音しない文。', '',
      '## おわりに', '<!-- image: extra.png -->', 'ありがとうございました。', '',
    ].join('\r\n');
    await fsp.writeFile(path.join(dir, 'talk.md'), md);
    const r = await run('pack', '--from-markdown', path.join(dir, 'talk.md'), '--images', imgs, '--out', path.join(dir, 'p.zip'));
    assert.equal(r.code, 0, r.stdout);
    const pack = await readPack(path.join(dir, 'p.zip'));
    assert.equal(pack.script.title, '夜の会');
    assert.deepEqual(pack.script.slides.map((s) => [s.slideId, s.title, s.recordable, s.speaker ?? null, s.targetSec ?? null]), [
      ['s0001', 'はじめに', true, '話者A', 12], ['sup1', '補足', false, null, null], ['s0003', 'おわりに', true, null, null],
    ]);
    assert.equal(pack.script.slides[0].text, 'こんばんは。\n\n今日は本の紹介です。');
    assert.deepEqual(pack.names, ['script.json', 'slides/0001.png', 'slides/0002.png', 'slides/0003.png']);
    assert.deepEqual(checkScript(pack.script), { ok: true, errors: [] });
    assert.deepEqual(r.env.warnings, []);
    // 見出しがない
    await fsp.writeFile(path.join(dir, 'empty.md'), '# 題名だけ\n');
    const bad = await run('pack', '--from-markdown', path.join(dir, 'empty.md'), '--images', imgs, '--out', path.join(dir, 'q.zip'));
    assert.equal(bad.code, 1);
    // --images は --from-markdown と一緒にだけ
    const misuse = await run('pack', '--from-json', imgs, '--images', imgs, '--out', path.join(dir, 'q.zip'));
    assert.equal(misuse.code, 2);
  } finally { await cleanup(dir); }
});

// ---------------------------------------------------------------- pptx（偽の取り出しスクリプト）

const FAKE_EXPORT_PS1 = `param([string]$Pptx, [string]$OutDir, [int]$TimeoutSec = 300)
$log = $env:FAKE_LOG
$ErrorActionPreference = 'Stop'
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha256.ComputeHash([IO.File]::ReadAllBytes($Pptx))).Replace('-', '').ToLowerInvariant() }
finally { $sha256.Dispose() }
Set-Content -LiteralPath $log -Value ($Pptx + '|' + $OutDir + '|' + $hash) -Encoding ASCII
if ($env:FAKE_EXIT) { exit [int]$env:FAKE_EXIT }
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'slides') | Out-Null
Copy-Item -LiteralPath $env:FAKE_SLIDES_JSON -Destination (Join-Path $OutDir 'slides.json')
Copy-Item -LiteralPath $env:FAKE_PNG -Destination (Join-Path $OutDir 'slides\\0001.png')
Copy-Item -LiteralPath $env:FAKE_PNG -Destination (Join-Path $OutDir 'slides\\0002.png')
Copy-Item -LiteralPath $env:FAKE_PNG -Destination (Join-Path $OutDir 'slides\\0003.png')
exit 0
`;

async function fakeBuilder(dir) {
  const b = path.join(dir, 'fakebuilder');
  await fsp.mkdir(b, { recursive: true });
  await fsp.writeFile(path.join(b, 'export-slides.ps1'), BOM + FAKE_EXPORT_PS1.replace(/\n/g, '\r\n'));
  await fsp.writeFile(path.join(dir, 'slide.png'), renderSlidePng(1, { width: 64, height: 36 }));
  await fsp.writeFile(path.join(dir, 'slides-export.json'), JSON.stringify({
    format: 'lap-narrator/slides-export', version: 1, pptx: 'deck.pptx', width: 1920, height: 1080,
    slides: [
      { index: 1, slideId: 256, image: 'slides/0001.png', title: 'はじめに', notes: '最初の文です。\r\n二行目。', hidden: false, mediaShapes: 0, clickEffects: 0 },
      { index: 2, slideId: 257, image: 'slides/0002.png', title: '補足', notes: '非表示だが文はある。', hidden: true, mediaShapes: 1, clickEffects: 0 },
      { index: 3, slideId: 260, image: 'slides/0003.png', title: '図だけ', notes: '', hidden: false, mediaShapes: 0, clickEffects: 2 },
    ],
    warnings: [{ code: 'not-16x9', message: 'Slide size is not 16:9' }],
  }));
  await fsp.writeFile(path.join(dir, 'deck.pptx'), 'pretend pptx bytes');
  return b;
}

test('pack --from-pptx：export-slides.ps1 にコピーを渡し、slides.json から台本を作る（slideId は s<SlideID>、非表示・空のノートは録音しない）', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const b = await fakeBuilder(dir);
    const env = { NARRATE_BUILDER_DIR: b, FAKE_LOG: path.join(dir, 'log.txt'), FAKE_SLIDES_JSON: path.join(dir, 'slides-export.json'), FAKE_PNG: path.join(dir, 'slide.png') };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let r;
    try { r = await run('pack', '--from-pptx', path.join(dir, 'deck.pptx'), '--out', path.join(dir, 'p.zip'), '--title', '試験の発表'); } finally {
      for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    assert.equal(r.code, 0, r.stdout);
    const [pptxArg, outDirArg, hash] = (await fsp.readFile(path.join(dir, 'log.txt'), 'utf8')).trim().split('|');
    assert.notEqual(path.resolve(pptxArg), path.resolve(dir, 'deck.pptx'), '元の pptx ではなく、コピーを渡す');
    assert.match(pptxArg, /deck\.pptx$/);
    assert.equal(hash, sha256Hex(new TextEncoder().encode('pretend pptx bytes')), 'コピーの中身は元と同じ');
    assert.ok(outDirArg.endsWith('export'));
    await assert.rejects(fsp.stat(path.dirname(pptxArg)), 'temporary work folder is removed');
    const pack = await readPack(path.join(dir, 'p.zip'));
    assert.equal(pack.script.title, '試験の発表');
    assert.deepEqual(pack.script.slides.map((s) => [s.slideId, s.recordable, s.title, s.text]), [
      ['s256', true, 'はじめに', '最初の文です。\n二行目。'], ['s257', false, '補足', '非表示だが文はある。'], ['s260', false, '図だけ', ''],
    ]);
    assert.deepEqual(checkScript(pack.script), { ok: true, errors: [] });
    const codes = r.env.warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, ['click-effects', 'hidden-slides', 'media-shapes', 'not-16x9']);
  } finally { await cleanup(dir); }
});

test('pack --from-pptx：終了コード 10 は powerpoint-busy、11 は powerpoint-timeout、その他は export-failed。出力は作らない', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const b = await fakeBuilder(dir);
    const base = { NARRATE_BUILDER_DIR: b, FAKE_LOG: path.join(dir, 'log.txt'), FAKE_SLIDES_JSON: path.join(dir, 'slides-export.json'), FAKE_PNG: path.join(dir, 'slide.png') };
    const saved = { ...process.env };
    try {
      for (const [exit, code] of [['10', 'powerpoint-busy'], ['11', 'powerpoint-timeout'], ['1', 'export-failed']]) {
        Object.assign(process.env, base, { FAKE_EXIT: exit });
        const r = await run('pack', '--from-pptx', path.join(dir, 'deck.pptx'), '--out', path.join(dir, 'p.zip'));
        assert.equal(r.code, 1, exit);
        assert.equal(r.env.errors[0].code, code, exit);
        assert.equal(r.env.errors[0].detail.exitCode, Number(exit));
        await assert.rejects(fsp.stat(path.join(dir, 'p.zip')));
      }
    } finally {
      for (const k of [...Object.keys(base), 'FAKE_EXIT']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    const r2 = await run('pack', '--from-pptx', path.join(dir, 'nothere.pptx'), '--out', path.join(dir, 'p.zip'));
    assert.equal(r2.code, 1);
    assert.equal(r2.env.errors[0].code, 'cannot-read');
  } finally { await cleanup(dir); }
});

test('台本の元データを読む：BOM 付きの JSON でもよい', T, async () => {
  const dir = await tmpDir('pack');
  try {
    const src = path.join(dir, 'src');
    await writeTinySource(src);
    const text = readFileSync(path.join(src, 'script.json'), 'utf8');
    await fsp.writeFile(path.join(src, 'script.json'), BOM + text);
    const r = await run('pack', '--from-json', src, '--out', path.join(dir, 'p.zip'));
    assert.equal(r.code, 0);
  } finally { await cleanup(dir); }
});
