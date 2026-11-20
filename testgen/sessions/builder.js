// 録音セッションの見本を作る道具。操作の列（短い書き方）から、整合した events.jsonl と、録音ファイル（raw）を作る。
// 期待値（expected）は、場面ごとのファイルに「手で導いた値」をそのまま書く。ここでは作らない。
import { makeRng } from '../lib/rng.js';

export const RATE = 48000;
export const APP_VERSION = '0.0.0-testgen';
export const BASE_WALL_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

const pad = (n, w) => String(n).padStart(w, '0');
export const rawName = (idx) => 'rec-' + pad(idx, 6);
export const sid = (n) => 's' + pad(n, 4);
export const tid = (n) => 't' + pad(n, 4);
export const cid = (n) => 'c' + pad(n, 4);

// ---- 操作の短い書き方 ----
// 位置は [録音ファイルの番号(1 から), ファイル内のサンプル, {pos: 上書き}] 。
export const SS = () => ['session-start', {}];
export const TESTREC = (ms) => ['test-rec', { durationMs: ms }];
export const RS = (slide, take, f, s, o) => ['rec-start', { slideId: sid(slide), takeId: tid(take) }, [f, s, o]];
export const DUR = (f, s, o) => ['durable', {}, [f, s, o]];
export const OK = (cp, f, s, o) => ['ok', { checkpointId: cid(cp) }, [f, s, o]];
export const PAUSE = (f, s, reason = 'user', o) => ['pause', { reason }, [f, s, o]];
export const RESUME = (f, s, o) => ['resume', {}, [f, s, o]];
export const RETAKE = (cp, f, s, o) => ['retake', { toCheckpoint: cp === null ? null : cid(cp) }, [f, s, o]];
export const NEXT = (cp, f, s, nextSlide, o) => ['next-slide', { checkpointId: cid(cp), nextSlideId: sid(nextSlide) }, [f, s, o]];
export const GOTO = (slide) => ['goto-slide', { slideId: sid(slide) }];
export const ROT = (from, to, s) => ['file-rotate', { from, to }, [from, s]];
export const UNDO = (targetSeq) => ['undo', { target: targetSeq }];
export const REDO = (targetSeq) => ['redo', { target: targetSeq }];
export const MARK = (f, s, note) => ['mark', note === undefined ? {} : { note }, [f, s]];
export const RECOVERED = (cp, f, s, notes) => ['recovered', { lastCheckpointId: cp === null ? null : cid(cp), notes }, [f, s]];
export const EXPORT = (exportId, kind, volumes) => ['export', { exportId, kind, volumes }];
/** seq を飛ばす（欠番の場面用）。次の操作の seq を指定する。 */
export const SEQ = (n, ev) => {
  const e = [...ev];
  e[1] = { ...e[1], seq: n };
  return e;
};

/**
 * @param {{name:string, sessionId:string, projectId:string, scriptHash:string, rawFiles:number[], events:any[]}} scene
 * @returns {object[]} events.jsonl の行になるオブジェクトの配列
 */
export function buildEvents(scene) {
  const files = scene.rawFiles;
  const offsets = [];
  let acc = 0;
  for (const n of files) {
    offsets.push(acc);
    acc += n;
  }
  const mkAt = (spec) => {
    const [f, sample, o] = spec;
    const raw = rawName(f);
    const pos = o?.pos !== undefined ? o.pos : (offsets[f - 1] ?? 0) + sample;
    return { raw, sample, pos };
  };
  const out = [];
  let seq = 0;
  let ms = 1000;
  for (const spec of scene.events) {
    const [type, fields0, atSpec] = spec;
    const fields = { ...fields0 };
    if (fields.seq !== undefined) {
      seq = fields.seq;
      delete fields.seq;
    }
    const ev = { seq, eventId: 'e' + seq, type, wall: '', mono: 0 };
    let at = null;
    if (atSpec) at = mkAt(atSpec);
    if (type === 'session-start') {
      Object.assign(ev, {
        sessionId: scene.sessionId,
        projectId: scene.projectId,
        scriptHash: scene.scriptHash,
        sampleRate: RATE,
        appVersion: APP_VERSION,
      });
    } else if (type === 'file-rotate') {
      ev.from = rawName(fields.from);
      ev.to = rawName(fields.to);
      ev.at = at;
      ev.toAt = mkAt([fields.to, 0]);
    } else if (type === 'undo' || type === 'redo') {
      ev.target = 'e' + fields.target;
    } else {
      if (at) ev.at = at;
      Object.assign(ev, fields);
    }
    // 経過時間（記録だけ）：位置があればその時刻に合わせ、常に増える
    ms = at ? Math.max(ms + 1, 1000 + Math.floor(at.pos / 48)) : ms + 5;
    ev.mono = ms;
    ev.wall = new Date(BASE_WALL_MS + ms).toISOString();
    out.push(ev);
    seq += 1;
  }
  return out;
}

/** 録音ファイルごとの「保存できたサンプル数」（durable と file-rotate から求める。場面で上書きできる） */
export function deriveDurableSamples(scene, events) {
  const res = scene.rawFiles.map(() => 0);
  for (const ev of events) {
    if (ev.type === 'durable' || ev.type === 'file-rotate') {
      const idx = parseInt(ev.at.raw.slice(4), 10) - 1;
      if (idx >= 0 && idx < res.length) res[idx] = Math.max(res[idx], ev.at.sample);
    }
  }
  return res;
}

// ---- 録音ファイルの中身（既知の合成音）----

/** 周波数 freq の正弦波 + 小さな雑音。一様乱数は種から決まる。 */
export function toneInto(buf, from, to, freq, amp, rng) {
  for (let i = from; i < to; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / RATE) * amp + (rng ? (rng.float() - 0.5) * 400 : 0);
    buf[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
}

/**
 * 既定の中身：録音ファイルごとに違う周波数の音 + 雑音。どのサンプルも位置から決まる。
 * @returns {Int16Array}
 */
export function defaultRawAudio(sceneName, fileIdx, samples) {
  const buf = new Int16Array(samples);
  const rng = makeRng(`raw:${sceneName}:${fileIdx}`);
  toneInto(buf, 0, samples, 180 + 55 * fileIdx, 7000, rng);
  return buf;
}
