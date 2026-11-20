// 通しの切り出し（render --boundaries）の別実装による照合。
// Python（.venv、-I、標準ライブラリの zipfile／wave／hashlib だけ）が、書き出しの zip の録音ファイルから通しの音声を作り直し、切れ目で切って、
// スライドごとの SHA-256 を求める。CLI が書いた WAV（Python の wave で読む）と、予定表と、一致するかを見る。lap-narrator のコードは Python 側で一切使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasPython, pythonPath } from '../core/helpers/python.js';
import { run, tmpDir, cleanup, runProcessForTest, ROOT } from './helpers/cli.js';
import { continuousMaterial, continuousSession, fullExportFiles, makeBoundaries, wavSha256, pcmSha256 } from './helpers/continuous.js';

const T = { timeout: 120000 };
const PACK = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
const SCRIPT = path.join(ROOT, 'test', 'cli', 'helpers', 'continuous_slices.py');

test('render --boundaries の切り出しは、Python の独立な実装（zipfile／wave）で求めた SHA-256 と一致する（撮り直しで捨てた区間を除いた通しの音声から）', { ...T, skip: !hasPython && '.venv の Python が無い' }, async () => {
  const dir = await tmpDir('cont-oracle');
  try {
    const material = continuousMaterial({ retake: true });
    const session = continuousSession({ material });
    const ex = await fullExportFiles(path.join(dir, 'ex'), session);
    const ws = path.join(dir, 'ws');
    assert.equal((await run('import', ...ex.zips, '--script', PACK, '--workspace', ws)).code, 0);
    const script = JSON.parse(readFileSync(path.join(ws, 'script.json'), 'utf8'));
    const b = makeBoundaries({ script, material });
    const bp = path.join(dir, 'boundaries.json');
    await fsp.writeFile(bp, JSON.stringify(b));
    const r = await run('render', '--workspace', ws, '--boundaries', bp, '--tail-margin-ms', '0');
    assert.equal(r.code, 0, r.stdout);

    const p = await runProcessForTest(pythonPath(), ['-I', SCRIPT, '--zip', ex.zips[0], '--raw', 'rec-000001', '--keep', `0:${material.a}`, '--keep', `${material.b}:END`, '--boundaries', bp, '--out', path.join(ws, 'out')]);
    assert.equal(p.code, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.deepEqual(o.problems, []);
    assert.equal(o.continuousSamples, material.all.length);
    assert.equal(o.continuousWavSha256, wavSha256(material.all), 'Python が作り直した通しの音声の SHA-256 は、boundaries.audio.sha256 と JS 側の値に一致');
    assert.equal(o.concatenationMatches, true);
    assert.equal(o.slides.length, 3);
    for (const s of o.slides) {
      assert.equal(s.match, true, JSON.stringify(s));
      assert.equal(s.timelineMatch, true, JSON.stringify(s));
    }
    // CLI が報告した parts[].sha256（ファイルのハッシュ）も、Python が求めた WAV のハッシュと一致する
    const res = r.env.result;
    res.finals.forEach((f, i) => assert.equal(f.parts[0].sha256, o.slides[i].expectedWavSha256, f.slideId));
    // 念のため、JS 側の正解の区間とも一致
    o.slides.forEach((s, i) => assert.equal(s.expectedPcmSha256, pcmSha256(material.all.slice(material.bounds[i], material.bounds[i + 1]))));
  } finally { await cleanup(dir); }
});

test('既定の余裕（終わりを 100 ms 切り落とす）でも、Python の独立な実装が求めた SHA-256 と一致する', { ...T, skip: !hasPython && '.venv の Python が無い' }, async () => {
  const dir = await tmpDir('cont-oracle2');
  try {
    const material = continuousMaterial({ retake: true });
    const ex = await fullExportFiles(path.join(dir, 'ex'), continuousSession({ material }));
    const ws = path.join(dir, 'ws');
    assert.equal((await run('import', ...ex.zips, '--script', PACK, '--workspace', ws)).code, 0);
    const script = JSON.parse(readFileSync(path.join(ws, 'script.json'), 'utf8'));
    const bp = path.join(dir, 'boundaries.json');
    await fsp.writeFile(bp, JSON.stringify(makeBoundaries({ script, material })));
    const r = await run('render', '--workspace', ws, '--boundaries', bp);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.env.result.tailMarginSamples, 4800);
    const p = await runProcessForTest(pythonPath(), ['-I', SCRIPT, '--zip', ex.zips[0], '--raw', 'rec-000001', '--keep', `0:${material.a}`, '--keep', `${material.b}:END`, '--boundaries', bp, '--out', path.join(ws, 'out'), '--tail-samples', '4800']);
    assert.equal(p.code, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.deepEqual(o.problems, []);
    for (const s of o.slides) { assert.equal(s.match, true, JSON.stringify(s)); assert.equal(s.timelineMatch, true, JSON.stringify(s)); }
    r.env.result.finals.forEach((f, i) => assert.equal(f.parts[0].sha256, o.slides[i].expectedWavSha256));
  } finally { await cleanup(dir); }
});
