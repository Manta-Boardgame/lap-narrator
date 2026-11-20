// 試験用：架空の録音セッションから、全記録と完成版の ZIP（巻に分けたもの）を作る。core の関数（reduce、render、zip、wav、sha256）を使う。
import { createZipWriter } from '../../../core/zip.js';
import { sha256Hex } from '../../../core/sha256.js';
import { wavHeader, planWavParts } from '../../../core/wav.js';
import { reduceEvents } from '../../../core/reduce.js';
import { renderTake, defaultRenderSpec } from '../../../core/render.js';
import { stringifyJsonl } from '../../../core/json.js';
import { build } from './events.js';
import { sampleScript } from './samples.js';

const enc = new TextEncoder();
const json = (v) => enc.encode(JSON.stringify(v, null, 2) + '\n');

function pcm(n, seed) {
  const a = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = ((s >>> 16) & 0xffff) - 32768; }
  return a;
}
function wavFile(samples, sampleRate = 48000) {
  const h = wavHeader({ sampleRate, samples: samples.length });
  const out = new Uint8Array(44 + samples.length * 2);
  out.set(h, 0);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return out;
}

export const RAW_INFO = [
  { name: 'rec-000001', sampleRate: 48000, samples: 30000 },
  { name: 'rec-000002', sampleRate: 48000, samples: 20000 },
];

/** 架空のセッション。seed を変えると録音ファイルの中身が変わる（別の版の録音ファイルを作るため） */
export function makeSession({ sessionId = 'sess-0001', seed = 1, extraTail = false, script = sampleScript(), rawSamples = [30000, 20000] } = {}) {
  const raws = RAW_INFO.map((r, i) => ({ ...r, samples: rawSamples[i] }));
  const list = [
    ['session-start', { sessionId, projectId: script.projectId, scriptHash: script.scriptHash, sampleRate: 48000, appVersion: '0.0.0' }],
    ['rec-start', { slideId: 's256', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, 10000] }],
    ['durable', { at: [1, 12000] }],
    ['retake', { toCheckpoint: 'c0001', at: [1, 13000] }],
    ['resume', { at: [1, 14000] }],
    ['ok', { checkpointId: 'c0002', at: [1, 20000] }],
    ['next-slide', { checkpointId: 'c0003', at: [1, 25000], nextSlideId: 's258' }],
    ['rec-start', { slideId: 's258', takeId: 't0002', at: [2, 0] }],
    ['ok', { checkpointId: 'c0004', at: [2, 15000] }],
    ['next-slide', { checkpointId: 'c0005', at: [2, 18000], nextSlideId: 's259' }],
  ];
  if (extraTail) list.push(['rec-start', { slideId: 's258', takeId: 't0003', at: [2, 18500] }], ['ok', { checkpointId: 'c0006', at: [2, 19500] }]);
  const events = build(list, raws);
  const rawData = { 'rec-000001': pcm(rawSamples[0], seed), 'rec-000002': pcm(rawSamples[1], seed + 100) };
  const result = reduceEvents(events, raws);
  const { state, ...segmentsJson } = result;
  return { sessionId, script, raws, events, rawData, result, segmentsJson };
}

async function zipOf(files) {
  const chunks = [];
  const w = createZipWriter({ write: (u) => { chunks.push(u.slice()); } });
  for (const [name, data] of files) await w.addFile(name, data);
  await w.finish();
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** 巻に振り分ける：先頭の巻に records、残りの files を順に詰める（1 つが上限より大きければ単独の巻） */
function planVolumes(records, rest, volumeMaxBytes) {
  const vols = [{ files: [...records], bytes: records.reduce((n, f) => n + f.data.length, 0) }];
  for (const f of rest) {
    const cur = vols[vols.length - 1];
    if (cur.bytes + f.data.length > volumeMaxBytes && cur.files.length > 0) vols.push({ files: [f], bytes: f.data.length });
    else { cur.files.push(f); cur.bytes += f.data.length; }
  }
  return vols;
}

function indexOf({ exportId, kind, projectId, sessionId, zips }) {
  return { format: 'lap-narrator/index', version: 1, exportId, kind, projectId, sessionId, volumes: zips.length, zips };
}

/** 全記録の書き出し。volumeMaxBytes を小さくすると巻に分かれる。overrides.edits で編集の記録を変えられる */
export async function exportFull(session, { exportId = 'exp-full-01', volumeMaxBytes = 1_000_000_000, editVersion = 1, createdAt = '2026-11-16T07:50:00.000Z', edits, events = session.events, segmentsJson = session.segmentsJson, rawData = session.rawData, manifestExtra = {} } = {}) {
  const { sessionId, script, raws } = session;
  const editsJson = edits ?? { format: 'lap-narrator/edits', version: 1, sessionId, editVersion, joins: [], fadeSamples: 384 };
  const records = [
    { path: 'README.txt', data: enc.encode('lap-narrator full export (test)\n') },
    { path: 'script.json', data: json(script) },
    { path: 'events.jsonl', data: enc.encode(stringifyJsonl(events)) },
    { path: 'segments.json', data: json(segmentsJson) },
    { path: 'edits.json', data: json(editsJson) },
  ];
  const rawFiles = raws.map((r) => ({ name: r.name, data: wavFile(rawData[r.name], r.sampleRate), info: r }));
  const rest = rawFiles.map((r) => ({ path: `raw/${r.name}.wav`, data: r.data, raw: r }));
  const vols = planVolumes(records, rest, volumeMaxBytes);
  const zips = [];
  for (let i = 0; i < vols.length; i++) {
    const v = vols[i];
    const manifest = {
      format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: script.projectId, scriptHash: script.scriptHash,
      sessionId, exportId, volume: i + 1, volumes: vols.length, appVersion: '0.0.0', mic: { requested: {}, actual: {} }, ...manifestExtra,
      rawFiles: v.files.filter((f) => f.raw).map((f) => ({ file: f.raw.name, sampleRate: f.raw.info.sampleRate, samples: f.raw.info.samples, sha256: sha256Hex(f.data), durableSamples: f.raw.info.samples })),
      files: v.files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256Hex(f.data) })),
      createdAt,
    };
    const bytes = await zipOf([...v.files.map((f) => [f.path, f.data]), ['manifest.json', json(manifest)]]);
    zips.push({ volume: i + 1, file: `${script.projectId}_${sessionId}_full_v${String(i + 1).padStart(3, '0')}.zip`, bytes, sha256: sha256Hex(bytes) });
  }
  const index = indexOf({ exportId, kind: 'full', projectId: script.projectId, sessionId, zips: zips.map((z) => ({ volume: z.volume, file: z.file, bytes: z.bytes.length, sha256: z.sha256 })) });
  return { exportId, zips, index };
}

/** 完成版の書き出し。session.result の採用の区間から renderTake で音声を作る。partMaxBytes で音声を分割できる */
export async function exportFinal(session, { exportId = 'exp-final-01', editVersion = 1, volumeMaxBytes = 1_000_000_000, partMaxBytes = 2 * 1024 * 1024 * 1024 - 1048576, createdAt = '2026-11-16T08:00:00.000Z', legacyEditVersion = false, manifestExtra = {} } = {}) {
  const { sessionId, script, result, rawData } = session;
  const rawRates = Object.fromEntries(session.raws.map((r) => [r.name, r.sampleRate]));
  const readSamples = async (raw, s, e) => rawData[raw].slice(s, e);
  const spec = { ...defaultRenderSpec() };
  const fileList = [{ path: 'script.json', data: json(script) }];
  const finals = [];
  for (const take of result.takes.filter((t) => t.candidate && result.defaultTakes[t.slideId] === t.takeId)) {
    const segs = result.segments.filter((s) => s.takeId === take.takeId && s.status === 'kept');
    const chunks = [];
    for await (const c of renderTake({ segments: segs, rawRates, readSamples, spec, allSegments: result.segments })) chunks.push(c);
    let n = 0; for (const c of chunks) n += c.length;
    const all = new Int16Array(n); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const plan = planWavParts(all.length, partMaxBytes);
    const parts = [];
    let pos = 0;
    plan.forEach((len, i) => {
      const file = plan.length === 1 ? `final/${take.slideId}.wav` : `final/${take.slideId}.p${String(i + 1).padStart(3, '0')}.wav`;
      const data = wavFile(all.subarray(pos, pos + len), 48000);
      pos += len;
      fileList.push({ path: file, data });
      parts.push({ file, samples: len, sha256: sha256Hex(data) });
    });
    finals.push({ slideId: take.slideId, takeId: take.takeId, parts, samples: all.length, sampleRate: 48000, applied: { gainDb: 0, limiter: 'none', fadeSamples: 384, joinAdjust: [] } });
  }
  const rest = fileList.slice(1);
  const vols = planVolumes([fileList[0]], rest, volumeMaxBytes);
  const zips = [];
  for (let i = 0; i < vols.length; i++) {
    const v = vols[i];
    const manifest = {
      format: 'lap-narrator/manifest', version: 1, kind: 'final', projectId: script.projectId, scriptHash: script.scriptHash,
      sessionId, exportId, volume: i + 1, volumes: vols.length, appVersion: '0.0.0', ...manifestExtra,
      renderSpec: legacyEditVersion ? { ...spec, editVersion } : { ...spec }, ...(legacyEditVersion ? {} : { editVersion }), finals,
      files: v.files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256Hex(f.data) })),
      createdAt,
    };
    const bytes = await zipOf([...v.files.map((f) => [f.path, f.data]), ['manifest.json', json(manifest)]]);
    zips.push({ volume: i + 1, file: `${script.projectId}_${sessionId}_final_v${String(i + 1).padStart(3, '0')}.zip`, bytes, sha256: sha256Hex(bytes) });
  }
  const index = indexOf({ exportId, kind: 'final', projectId: script.projectId, sessionId, zips: zips.map((z) => ({ volume: z.volume, file: z.file, bytes: z.bytes.length, sha256: z.sha256 })) });
  return { exportId, zips, index, finals };
}

export const asVolume = (z) => ({ name: z.file, size: z.bytes.length, read: async (s, e) => z.bytes.slice(s, e) });
export { zipOf, json, wavFile };
