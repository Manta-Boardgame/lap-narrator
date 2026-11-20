import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../core/sha256.js';
import { cleanup, ROOT, run, tmpDir } from './helpers/cli.js';
import { continuousMaterial, continuousSession, fullExportFiles, makeBoundaries, wavSha256 } from './helpers/continuous.js';

test('render levels a continuous narration without altering its source or timing', { timeout: 90000 }, async () => {
  const dir = await tmpDir('cont-level');
  try {
    const workspace = path.join(dir, 'ws');
    const out = path.join(workspace, 'out');
    const material = continuousMaterial();
    const session = continuousSession({ material });
    const ex = await fullExportFiles(path.join(dir, 'ex'), session);
    const pack = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
    const imported = await run('import', ...ex.zips, '--script', pack, '--workspace', workspace);
    assert.equal(imported.code, 0, imported.stdout);
    const script = JSON.parse(await fsp.readFile(path.join(workspace, 'script.json'), 'utf8'));
    await fsp.writeFile(path.join(workspace, 'boundaries.json'), JSON.stringify(makeBoundaries({ material, script })));

    const r = await run('render', '--workspace', workspace, '--tail-margin-ms', '0', '--target-lufs', '-20');
    assert.equal(r.code, 0, r.stdout);
    const [matched] = r.env.result.leveling;
    assert.equal(matched.peakLimited, false);
    assert.ok(Math.abs(matched.lufs - (-20)) < 0.1, JSON.stringify(matched));
    assert.equal(r.env.result.continuous.sha256, wavSha256(material.all));
    const timeline = await fsp.readFile(path.join(out, 'timeline.json'), 'utf8');

    const limited = await run('render', '--workspace', workspace, '--tail-margin-ms', '0', '--target-lufs', '-5', '--ceiling-db', '-8');
    assert.equal(limited.code, 0, limited.stdout);
    const [level] = limited.env.result.leveling;
    assert.equal(level.peakLimited, true);
    assert.ok(level.truePeakDb <= -8 && level.truePeakDb > -8.02, JSON.stringify(level));
    assert.ok(limited.env.warnings.some((w) => w.code === 'loudness-target-unmet'));
    assert.equal(await fsp.readFile(path.join(out, 'timeline.json'), 'utf8'), timeline);
    assert.equal(sha256Hex(await fsp.readFile(path.join(workspace, 'final', 'all.wav'))), wavSha256(material.all));
    for (const f of limited.env.result.finals) {
      for (const p of f.parts) assert.equal(sha256Hex(await fsp.readFile(path.join(out, p.file))), p.sha256);
    }

    const restore = await run('render', '--workspace', workspace, '--tail-margin-ms', '0');
    assert.equal(restore.code, 0, restore.stdout);
    assert.equal(restore.env.result.leveling, undefined);
    for (const f of restore.env.result.finals) {
      assert.equal(f.parts[0].sha256, wavSha256(material.all.subarray(f.startSample, f.endSample)));
    }
  } finally {
    await cleanup(dir);
  }
});

test('lookahead lowers an inter-sample transient, survives WAV part boundaries, and leaves distant quiet audio alone', { timeout: 90000 }, async () => {
  const dir = await tmpDir('cont-lookahead');
  try {
    const workspace = path.join(dir, 'ws');
    const out = path.join(workspace, 'out');
    const material = continuousMaterial({ retake: false });
    const transientStart = 240 * 125 + 6;
    for (let i = 0; i < material.all.length; i++) {
      material.all[i] = Math.round(3000 * Math.sin(2 * Math.PI * 997 * i / 48000));
    }
    for (let i = 0; i < 96; i++) {
      material.all[transientStart + i] = Math.round(22000 * Math.sin(Math.PI * i / 2 + Math.PI / 4));
    }
    material.raw.set(material.all);
    const session = continuousSession({ material, retake: false });
    const ex = await fullExportFiles(path.join(dir, 'ex'), session);
    const pack = path.join(ROOT, 'examples', 'packs', 'tiny3.zip');
    const imported = await run('import', ...ex.zips, '--script', pack, '--workspace', workspace);
    assert.equal(imported.code, 0, imported.stdout);
    const script = JSON.parse(await fsp.readFile(path.join(workspace, 'script.json'), 'utf8'));
    await fsp.writeFile(path.join(workspace, 'boundaries.json'), JSON.stringify(makeBoundaries({ material, script })));

    const args = ['render', '--workspace', workspace, '--tail-margin-ms', '0', '--lookahead-limiter', '--ceiling-db', '-6'];
    const unsplit = await run(...args);
    assert.equal(unsplit.code, 0, unsplit.stdout);
    const [level] = unsplit.env.result.leveling;
    assert.equal(level.limiter.mode, 'lookahead');
    assert.equal(level.peakLimited, true);
    assert.ok(level.inputTruePeakDb > -5, JSON.stringify(level));
    assert.ok(level.truePeakDb <= -6 && level.truePeakDb > -6.8, JSON.stringify(level));
    assert.ok(20 * Math.log10(15557 / 32768) < -6, 'raw sample peak does not trigger the ceiling');
    const unsplitFiles = await Promise.all(unsplit.env.result.finals.map((f) => fsp.readFile(path.join(out, f.parts[0].file))));
    const [file] = unsplitFiles;
    const gainOf = (i) => file.readInt16LE(44 + 2 * i) / material.all[i];
    const prePeak = transientStart - 40;
    assert.ok(gainOf(prePeak) < 0.9, 'attenuation begins before the transient');
    assert.ok(Math.abs(gainOf(2401) - 1) < 0.001, 'distant quiet audio is not attenuated');
    assert.ok(gainOf(transientStart + 9601) > 0.99, 'gain recovers gradually after the transient');

    const split = await run(...args, '--final-max-bytes', String(44 + transientStart * 2));
    assert.equal(split.code, 0, split.stdout);
    assert.deepEqual(split.env.result.leveling, unsplit.env.result.leveling);
    for (let i = 0; i < split.env.result.finals.length; i++) {
      const f = split.env.result.finals[i];
      const pieces = [];
      for (const p of f.parts) pieces.push((await fsp.readFile(path.join(out, p.file))).subarray(44));
      assert.equal(sha256Hex(Buffer.concat(pieces)), sha256Hex(unsplitFiles[i].subarray(44)));
    }
  } finally {
    await cleanup(dir);
  }
});
