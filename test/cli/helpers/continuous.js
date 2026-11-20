// 試験の道具：通しで録った書き出し（台本が 1 枚だけ）の合成素材と、切れ目 boundaries.json。架空の内容。
// 録音ファイル rec-000001 の並び（48000 Hz）：
//   [前 0.1 秒 無音][スライド 1 の声 1.0 秒][無音 A 0.15 秒] | [捨てる区間 0.4 秒（撮り直し）] | [無音 B 0.15 秒][スライド 2 の声 1.2 秒][雑音の隙間 0.3 秒][スライド 3 の声 0.8 秒][後 0.1 秒]
//   操作：rec-start、ok（A の終わり）、retake（捨てる区間の終わり、直前の OK まで戻る）、resume、ok（最後）。
//   無音 A・B は 0 のサンプルだけ。結合部のフェード（384 サンプル）は 0 にかかるだけなので、通しの音声 = 録音の [0, a) + [b, 終わり) とサンプル単位で一致する。
//   切れ目は無音の中（スライド 1 と 2 の間：無音 A と B の境、2 と 3 の間：雑音の隙間の中点）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { assembleScript } from '../../../cli/lib/scriptpack.js';
import { reduceEvents } from '../../../core/reduce.js';
import { sha256Hex } from '../../../core/sha256.js';
import { wavHeader } from '../../../core/wav.js';
import { build } from '../../core/helpers/events.js';
import { exportFull, exportFinal } from '../../core/helpers/exports.js';

export const RATE = 48000;
const sec = (s) => Math.round(s * RATE);

/**
 * 声の代わり：音節の速さ（4 Hz 前後）で強さが変わる、ローパスをかけた雑音。純音ではないので、verify は相互相関で音の始まりを測る
 * （本物の声と同じ扱い。純音だと verify は「音そのものの始まり」を測り、スライドの音声の先頭の無音を数えない）。f0 が違えば雑音の種も違う。
 */
function voice(n, f0, f1, amp = 12000) {
  const out = new Int16Array(n);
  let s = (Math.round(f0) * 2654435761) >>> 0;
  let lp = 0;
  const rate = 4 + (f1 % 3);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = ((s >>> 8) / 8388608) - 1; // -1..1
    lp += 0.35 * (white - lp);
    const syll = 0.35 + 0.65 * Math.abs(Math.sin((Math.PI * rate * i) / RATE + f0));
    const env = Math.min(1, i / 480, (n - 1 - i) / 480);
    out[i] = Math.round(Math.max(-1, Math.min(1, lp * 2.2)) * amp * syll * env);
  }
  return out;
}
function noise(n, seed, amp = 30) {
  const out = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = ((s >>> 16) % (2 * amp + 1)) - amp; }
  return out;
}
const zeros = (n) => new Int16Array(n);
function cat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Int16Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 通しの合成素材：録音ファイルの PCM と、通しの完成音声（捨てた区間を除いたもの）、正解の切れ目 */
export function continuousMaterial({ retake = true } = {}) {
  const lead = zeros(sec(0.1));
  const v1 = voice(sec(1.0), 300, 500);
  const gapA = zeros(sec(0.15));
  const junk = cat([voice(sec(0.4), 1800, 2000, 20000)]);
  const gapB = zeros(sec(0.15));
  const v2 = voice(sec(1.2), 700, 1100);
  const mid = noise(sec(0.3), 7);
  const v3 = voice(sec(0.8), 1500, 1300);
  const tail = zeros(sec(0.1));
  const head = cat([lead, v1, gapA]);
  const rest = cat([gapB, v2, mid, v3, tail]);
  const raw = retake ? cat([head, junk, rest]) : cat([head, rest]);
  const a = head.length; // OK の位置（撮り直しで戻る位置）
  const b = retake ? head.length + junk.length : head.length; // 撮り直しの終わり = 続きの始まり
  const all = cat([head, rest]); // 通しの完成音声
  const b1 = lead.length + v1.length + gapA.length; // 切れ目 1：無音 A と B の境
  const b2 = lead.length + v1.length + gapA.length + gapB.length + v2.length + sec(0.15); // 切れ目 2：雑音の隙間の中点
  return { raw, all, a, b, bounds: [0, b1, b2, all.length], voices: [v1, v2, v3] };
}

const wavBytes = (pcm, rate = RATE) => {
  const out = new Uint8Array(44 + pcm.length * 2);
  out.set(wavHeader({ sampleRate: rate, samples: pcm.length }), 0);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
};
export const wavSha256 = (pcm, rate = RATE) => sha256Hex(wavBytes(pcm, rate));
export const pcmSha256 = (pcm) => sha256Hex(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));

/** 台本が 1 枚だけの台本（slideId は free） */
export function freeScript(projectId = 'proj-free-0001') {
  return assembleScript({ title: 'free talk', projectId, slides: [{ slideId: 'free', title: 'free', text: 'free talk', recordable: true }] }).script;
}

/** 通しの全記録のセッション（core の reduce を通した結果つき） */
export function continuousSession({ sessionId = 'cont-sess-001', retake = true, material = continuousMaterial({ retake }), script = freeScript() } = {}) {
  const raws = [{ name: 'rec-000001', sampleRate: RATE, samples: material.raw.length }];
  const list = [
    ['session-start', { sessionId, projectId: script.projectId, scriptHash: script.scriptHash, sampleRate: RATE, appVersion: '0.0.0' }],
    ['rec-start', { slideId: 'free', takeId: 't0001', at: [1, 0] }],
    ['ok', { checkpointId: 'c0001', at: [1, material.a] }],
  ];
  if (retake) list.push(['retake', { toCheckpoint: 'c0001', at: [1, material.b] }], ['resume', { at: [1, material.b] }]);
  list.push(['ok', { checkpointId: 'c0002', at: [1, material.raw.length] }]);
  const events = build(list, raws);
  const result = reduceEvents(events, raws);
  const { state, ...segmentsJson } = result;
  return { sessionId, script, raws, events, rawData: { 'rec-000001': material.raw }, result, segmentsJson, material };
}

/** 書き出しの zip をフォルダに書く。{zips:[path], index:path} */
export async function writeExport(dir, ex) {
  await fsp.mkdir(dir, { recursive: true });
  const zips = [];
  for (const z of ex.zips) { const p = path.join(dir, z.file); await fsp.writeFile(p, z.bytes); zips.push(p); }
  const index = path.join(dir, `${ex.exportId}_index.json`);
  await fsp.writeFile(index, JSON.stringify(ex.index, null, 2));
  return { zips, index };
}

export async function fullExportFiles(dir, session, opts) { return writeExport(dir, await exportFull(session, opts)); }
export async function finalExportFiles(dir, session, opts) { return writeExport(dir, await exportFinal(session, opts)); }

/** 正解の切れ目（台本の録音の対象のスライドの slideId を渡す）。status などは上書きできる */
export function makeBoundaries({ script, material, slideIds, rate = RATE, overrides = {}, scriptHash = script.scriptHash, sha256 } = {}) {
  const ids = slideIds || script.slides.filter((s) => s.recordable).map((s) => s.slideId);
  if (ids.length + 1 !== material.bounds.length) throw new Error(`the material has ${material.bounds.length - 1} slides, the script ${ids.length}`);
  return {
    format: 'lap-narrator/boundaries', version: 1, sampleRate: rate,
    audio: { file: 'final/all.wav', sha256: sha256 ?? wavSha256(material.all, rate), samples: material.all.length },
    transcript: { file: 'transcript.json', sha256: 'a'.repeat(64), model: 'small' },
    script: { scriptHash },
    slides: ids.map((slideId, i) => ({
      slideId, order: i + 1, startSample: material.bounds[i], endSample: material.bounds[i + 1], confidence: 0.97, method: 'asr-align', status: 'auto',
      candidates: [{ sample: material.bounds[i + 1], score: 0.97 }], ...(overrides[slideId] || {}),
    })),
  };
}
