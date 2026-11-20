// 録音セッションの見本（examples/sessions/<名前>/）を作る。同じ場面の定義から、いつも同じバイト列ができる。
//
// 1 つのセッションの中身（CONTRACTS.md 1.2 と同じ形に、手で導いた期待値を足したもの）：
//   README.txt  manifest.json  script.json  events.jsonl  segments.json  edits.json  raw/rec-NNNNNN.wav
//   expected.segments.json   … 手で導いた期待値（segments.json と同じ中身）
//   expected.render.json     … 完成した音声の期待値（render-oracle の出力のハッシュ。freezeRender を指定したときだけ）
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sha256Hex } from '../lib/hash.js';
import { encodeWav } from '../lib/wav.js';
import { buildScriptPack, loadSpec } from '../script-pack.js';
import { scenes } from './scenes.js';
import { RATE, APP_VERSION, buildEvents, deriveDurableSamples, defaultRawAudio, rawName } from './builder.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const json = (v) => JSON.stringify(v, null, 2) + '\n';

/**
 * @param {object} scene
 * @param {{script:object, scriptJson:string}} pack 使う台本（tiny3）
 * @returns {{files: Map<string, Uint8Array>, events: object[], rawFiles: object[], expected: object}}
 */
export function buildSession(scene, pack) {
  const sessionId = 'ex-' + scene.name;
  const projectId = pack.script.projectId;
  const events = buildEvents({ ...scene, sessionId, projectId, scriptHash: pack.script.scriptHash });
  const durable = scene.durableSamples ?? deriveDurableSamples(scene, events);

  const files = new Map();
  // 録音ファイル
  const rawFiles = [];
  scene.rawFiles.forEach((samples, i) => {
    const idx = i + 1;
    const pcm = scene.audio ? scene.audio(idx, samples) : defaultRawAudio(scene.name, idx, samples);
    const wav = encodeWav(pcm, RATE);
    const path = `raw/${rawName(idx)}.wav`;
    files.set(path, wav);
    rawFiles.push({ file: path, sampleRate: RATE, samples, sha256: sha256Hex(wav), durableSamples: durable[i] });
  });

  const expected = {
    format: 'lap-narrator/segments',
    version: 1,
    sessionId,
    segments: scene.expected.segments,
    takes: scene.expected.takes,
    defaultTakes: scene.expected.defaultTakes,
    recoverable: scene.expected.recoverable ?? null,
    marks: scene.expected.marks ?? [],
    issues: scene.expected.issues ?? [],
  };

  files.set('events.jsonl', enc(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  files.set('script.json', enc(pack.scriptJson));
  files.set('segments.json', enc(json(expected)));
  files.set('expected.segments.json', enc(json(expected)));
  files.set('edits.json', enc(json({ format: 'lap-narrator/edits', version: 1, sessionId, editVersion: 1, fadeSamples: 384 })));
  files.set(
    'README.txt',
    enc(
      [
        `lap-narrator example session: ${scene.name}`,
        `sessionId: ${sessionId}   projectId: ${projectId}`,
        '',
        scene.en,
        scene.ja,
        '',
        'This is synthetic test material (fictional, not a real recording). Raw audio is made of tones.',
        'expected.segments.json was derived by hand from dev/CONTRACTS.md 1.5. It is not generated from code.',
        'segments.json is a copy of it. If segments.json and events.jsonl disagree, events.jsonl is the source of truth.',
        '',
      ].join('\n'),
    ),
  );

  // manifest.json（manifest.files は manifest 自身を除く、同じ巻に入っているファイルの一覧）
  const listed = ['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', ...rawFiles.map((r) => r.file)];
  const manifest = {
    format: 'lap-narrator/manifest',
    version: 1,
    kind: 'full',
    projectId,
    scriptHash: pack.script.scriptHash,
    sessionId,
    exportId: 'exp-' + scene.name,
    volume: 1,
    volumes: 1,
    appVersion: APP_VERSION,
    speaker: 'Speaker A',
    device: { kind: 'testgen', note: 'synthetic example, no real device' },
    mic: {
      requested: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
      actual: { sampleRate: RATE, note: 'synthetic' },
    },
    rawFiles,
    files: listed.map((p) => ({ path: p, bytes: files.get(p).length, sha256: sha256Hex(files.get(p)) })),
    createdAt: CREATED_AT,
  };
  files.set('manifest.json', enc(json(manifest)));
  return { files, events, rawFiles, expected, manifest };
}

/** 台本 tiny3 を作って返す */
export function loadTiny3(specDir) {
  return buildScriptPack(loadSpec(join(specDir, 'tiny3.json')));
}

/**
 * すべての場面を outDir に書く。
 * @param {string} outDir
 * @param {{specDir:string, freezeRender?:boolean}} opt
 */
export async function writeAllSessions(outDir, opt) {
  const pack = loadTiny3(opt.specDir);
  let freeze = null;
  if (opt.freezeRender) freeze = await import('../freeze-render.js');
  if (existsSync(outDir)) {
    for (const s of scenes) rmSync(join(outDir, s.name), { recursive: true, force: true });
  }
  const index = [];
  for (const scene of scenes) {
    const built = buildSession(scene, pack);
    if (freeze) built.files.set('expected.render.json', enc(json(freeze.frozenRender(built))));
    for (const [rel, data] of built.files) {
      const p = join(outDir, scene.name, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
    index.push({
      name: scene.name,
      sessionId: 'ex-' + scene.name,
      en: scene.en,
      ja: scene.ja,
      slides: 'tiny3',
      rawFiles: scene.rawFiles,
      events: built.events.length,
      issues: (scene.expected.issues ?? []).map((i) => i.code),
    });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.json'), json(index));
  return index;
}
