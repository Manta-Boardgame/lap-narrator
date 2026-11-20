// 切れ目 boundaries.json（dev/PLAN2.md の取り決め）の検証と、通しの音声を切れ目で切る計算。実行環境に依存しない（fs、Buffer、crypto、process を使わない）。
//   形式：{ format:"lap-narrator/boundaries", version:1, sampleRate, audio:{file?, sha256, samples}, transcript?:{…}, script:{scriptHash},
//          slides:[{slideId, order, startSample, endSample, confidence?, method?, status, candidates?}] }
//   区間は連続・半開 [startSample, endSample)：slides[0].startSample = 0、slides[i].endSample = slides[i+1].startSample、最後の endSample = audio.samples。長さ 0 は許さない。
//   status：auto（自動で確定）／confirmed（人または LLM が決めた）／needs-decision（自信が足りない。render は書かずに止まる）。
import { buildTimeline } from './timeline.js';

export const BOUNDARIES_FORMAT = 'lap-narrator/boundaries';
export const BOUNDARY_STATUSES = Object.freeze(['auto', 'confirmed', 'needs-decision']);
export const BOUNDARY_METHODS = Object.freeze(['asr-align', 'manual', 'interpolated']);

const HEX64 = /^[0-9a-f]{64}$/;
const SLIDE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * 切れ目の検査。構造、連続・半開、台本（`script`）との照合、音声（`audio`）との照合。見つけたものをすべて返す（最初の 1 つで止めない）。
 * 誤りの `code`：`bad-boundaries`（形式・型）、`not-contiguous`（区間が連続・半開でない）、`script-mismatch`（scriptHash が違う）、
 * `slides-mismatch`（録音の対象のスライドの並びと合わない）、`audio-mismatch`（音声の SHA-256・長さ・周波数が合わない）。
 * 構造の誤り（`bad-boundaries`）があるときは、あとの検査はしない。
 * @param {any} b boundaries.json の中身
 * @param {{script?: any, audio?: {sha256?: string, samples?: number, sampleRate?: number}}} [ctx] script は台本（script.json）、audio は実際の音声
 * @returns {{ok: boolean, errors: {code: string, message: string, detail?: any}[]}}
 */
export function checkBoundaries(b, ctx = {}) {
  const errors = [];
  const bad = (message, detail) => errors.push({ code: 'bad-boundaries', message, ...(detail !== undefined ? { detail } : {}) });
  if (!isObj(b)) { bad('boundaries must be a JSON object'); return { ok: false, errors }; }
  if (b.format !== BOUNDARIES_FORMAT) bad(`format must be "${BOUNDARIES_FORMAT}"`);
  if (b.version !== 1) bad('version must be 1');
  if (!(Number.isSafeInteger(b.sampleRate) && b.sampleRate >= 8000)) bad('sampleRate must be an integer >= 8000');
  if (!isObj(b.audio)) bad('audio must be an object');
  else {
    if (typeof b.audio.sha256 !== 'string' || !HEX64.test(b.audio.sha256)) bad('audio.sha256 must be 64 lowercase hex characters');
    if (!(Number.isSafeInteger(b.audio.samples) && b.audio.samples >= 1)) bad('audio.samples must be an integer >= 1');
    if (b.audio.file !== undefined && typeof b.audio.file !== 'string') bad('audio.file must be a string');
  }
  if (!isObj(b.script) || typeof b.script.scriptHash !== 'string' || !HEX64.test(b.script.scriptHash)) bad('script.scriptHash must be 64 lowercase hex characters');
  if (!Array.isArray(b.slides) || b.slides.length === 0) bad('slides must be a non-empty array');
  else {
    b.slides.forEach((s, i) => {
      const at = `slides[${i}]`;
      if (!isObj(s)) { bad(`${at} must be an object`); return; }
      if (typeof s.slideId !== 'string' || !SLIDE_ID.test(s.slideId)) bad(`${at}.slideId is not a valid slideId`);
      if (!(Number.isSafeInteger(s.order) && s.order >= 1)) bad(`${at}.order must be an integer >= 1`);
      if (!isUint(s.startSample)) bad(`${at}.startSample must be a non-negative integer`);
      if (!isUint(s.endSample)) bad(`${at}.endSample must be a non-negative integer`);
      if (!BOUNDARY_STATUSES.includes(s.status)) bad(`${at}.status must be one of ${BOUNDARY_STATUSES.join(', ')}`);
      if (s.method !== undefined && !BOUNDARY_METHODS.includes(s.method)) bad(`${at}.method must be one of ${BOUNDARY_METHODS.join(', ')}`);
      if (s.confidence !== undefined && !(typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1)) bad(`${at}.confidence must be a number from 0 to 1`);
      if (s.candidates !== undefined && !(Array.isArray(s.candidates) && s.candidates.every((c) => isObj(c) && isUint(c.sample)))) bad(`${at}.candidates must be a list of {sample, score?}`);
    });
  }
  if (errors.length) return { ok: false, errors };

  // 連続・半開
  const slides = b.slides;
  const seen = new Set();
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (seen.has(s.slideId)) errors.push({ code: 'not-contiguous', message: `slide ${s.slideId} appears more than once`, detail: { slideId: s.slideId } });
    seen.add(s.slideId);
    if (i > 0 && !(s.order > slides[i - 1].order)) errors.push({ code: 'not-contiguous', message: `slides[${i}].order must be larger than the previous one`, detail: { slideId: s.slideId } });
    if (!(s.endSample > s.startSample)) errors.push({ code: 'not-contiguous', message: `slide ${s.slideId}: endSample (${s.endSample}) must be larger than startSample (${s.startSample})`, detail: { slideId: s.slideId, startSample: s.startSample, endSample: s.endSample } });
  }
  if (slides[0].startSample !== 0) errors.push({ code: 'not-contiguous', message: `the first slide must start at sample 0 (it starts at ${slides[0].startSample})`, detail: { slideId: slides[0].slideId } });
  for (let i = 0; i + 1 < slides.length; i++) {
    if (slides[i].endSample !== slides[i + 1].startSample) {
      errors.push({ code: 'not-contiguous', message: `slide ${slides[i].slideId} ends at ${slides[i].endSample} but slide ${slides[i + 1].slideId} starts at ${slides[i + 1].startSample} (gap or overlap)`, detail: { after: slides[i].slideId, before: slides[i + 1].slideId } });
    }
  }
  const last = slides[slides.length - 1];
  if (last.endSample !== b.audio.samples) errors.push({ code: 'not-contiguous', message: `the last slide ends at ${last.endSample} but audio.samples is ${b.audio.samples}`, detail: { slideId: last.slideId } });

  // 台本
  const { script, audio } = ctx;
  if (script) {
    if (b.script.scriptHash !== script.scriptHash) {
      errors.push({ code: 'script-mismatch', message: 'boundaries.json was made for a different script (scriptHash differs)', detail: { boundaries: b.script.scriptHash, workspace: script.scriptHash } });
    } else {
      const want = recordableOrder(script).map((s) => s.slideId);
      const have = slides.map((s) => s.slideId);
      if (want.length !== have.length || want.some((id, i) => id !== have[i])) {
        errors.push({
          code: 'slides-mismatch', message: 'boundaries.slides must list exactly the recordable slides of the script, in order',
          detail: { missing: want.filter((id) => !have.includes(id)), extra: have.filter((id) => !want.includes(id)), expected: want, actual: have },
        });
      }
    }
  }
  // 音声
  if (audio) {
    const diffs = [];
    if (audio.sha256 !== undefined && audio.sha256 !== b.audio.sha256) diffs.push('sha256');
    if (audio.samples !== undefined && audio.samples !== b.audio.samples) diffs.push('samples');
    if (audio.sampleRate !== undefined && audio.sampleRate !== b.sampleRate) diffs.push('sampleRate');
    if (diffs.length) {
      errors.push({
        code: 'audio-mismatch', message: `the audio in the workspace is not the audio these boundaries were made for (${diffs.join(', ')} differ)`,
        detail: { differs: diffs, boundaries: { sha256: b.audio.sha256, samples: b.audio.samples, sampleRate: b.sampleRate }, workspace: audio },
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 台本の、録音の対象のスライド（order の昇順。同じ order は台本の並びの順） */
export function recordableOrder(script) {
  return script.slides.map((s, i) => ({ s, i })).filter((x) => x.s.recordable === true)
    .sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i)).map((x) => x.s);
}

/** スライドごとの切り出しの計画：[{slideId, order, start, end, samples, status, confidence?, method?}]（`checkBoundaries` を通ったものを渡す） */
export function planSlices(b) {
  return b.slides.map((s) => ({
    slideId: s.slideId, order: s.order, start: s.startSample, end: s.endSample, samples: s.endSample - s.startSample,
    status: s.status, ...(s.confidence !== undefined ? { confidence: s.confidence } : {}), ...(s.method !== undefined ? { method: s.method } : {}),
  }));
}

/** 判断待ちのスライド（`status: "needs-decision"`、または `method: "interpolated"` で確定していないもの） */
export function undecidedSlides(b) {
  return b.slides.filter((s) => s.status === 'needs-decision');
}

/**
 * 通しの音声を切れ目で切ったときの予定表。スライドの切り替えの時刻は切れ目の位置（サンプル）そのもの：
 * `prePadSamples = 0`、`postPadSamples = tailMarginSamples`（既定 0）、`showStart = audioStart = startSample`、`showEnd = endSample`、`audioEnd = endSample - tailMarginSamples`。
 * （既存の予定表の規則 `audioStart = showStart + prePad`、`showEnd = audioEnd + postPad`、`showStart[i+1] = showEnd[i]` のまま。
 * 切れ目は無音の中にあるので、音声の前に間を足さない。`tailMarginSamples` は、各スライドの音声の終わりを切れ目より手前に置く余裕で、
 * 呼ぶ側が、切り出した音声の終わりをその分だけ短くして渡す。PowerPoint（方式 A）は、音声がスライドの時間いっぱいだと
 * スライドを音声の終わりまで延ばす（累積のずれになる）ので、約 75 ms 以上の余裕が要る。方式 B には要らない。）自己検査をして、食い違えば RangeError。
 * @param {{script: any, boundaries: any, finals: {slideId: string, samples: number, sampleRate?: number, parts: {file: string, samples: number}[]}[], fps?: number, tailMarginSamples?: number}} a
 */
export function buildContinuousTimeline(a) {
  const { script, boundaries, finals } = a;
  const margin = a.tailMarginSamples === undefined ? 0 : a.tailMarginSamples;
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError(`buildContinuousTimeline: bad tailMarginSamples ${margin}`);
  const tl = buildTimeline({ script, finals, sampleRate: boundaries.sampleRate, fps: a.fps, prePadSamples: 0, postPadSamples: margin });
  if (tl.slides.length !== boundaries.slides.length) throw new RangeError('buildContinuousTimeline: the timeline does not list every slide of the boundaries');
  tl.slides.forEach((s, i) => {
    const b = boundaries.slides[i];
    if (s.slideId !== b.slideId || s.showStart !== b.startSample || s.showEnd !== b.endSample || s.audioStart !== b.startSample || s.audioEnd !== b.endSample - margin) {
      throw new RangeError(`buildContinuousTimeline: slide ${b.slideId} does not sit on its boundaries (${s.showStart}..${s.showEnd} vs ${b.startSample}..${b.endSample})`);
    }
  });
  if (tl.totalSamples !== boundaries.audio.samples) throw new RangeError('buildContinuousTimeline: totalSamples differs from audio.samples');
  return tl;
}

/**
 * 通しの音声（`Int16Array` のかたまりの列。同期でも非同期でもよい）を、長さ `lengths` の区間に順に切る。
 * 区間ごとに `{index, length, chunks}` を出す。`chunks` は、その区間のかたまりの非同期の列（呼ぶ側は、次の区間に進む前に使い切るか、捨てる）。
 * かたまりは元のバッファの一部（subarray）なので、すぐに書き出すこと。合計が元の長さと違えば RangeError（`code: 'source-length'`）。
 * @param {AsyncIterable<Int16Array>|Iterable<Int16Array>} source
 * @param {number[]} lengths 正の整数
 * @returns {AsyncGenerator<{index: number, length: number, chunks: AsyncGenerator<Int16Array>}>}
 */
export async function* sliceStream(source, lengths) {
  const it = source[Symbol.asyncIterator] ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let buf = null;
  let off = 0;
  const lenErr = (msg) => Object.assign(new RangeError(`sliceStream: ${msg}`), { code: 'source-length' });
  const pull = async (n) => {
    while (buf === null || off >= buf.length) {
      const r = await it.next();
      if (r.done) return null;
      buf = r.value;
      off = 0;
    }
    const take = Math.min(n, buf.length - off);
    const out = buf.subarray(off, off + take);
    off += take;
    return out;
  };
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (!Number.isSafeInteger(length) || length < 1) throw new RangeError(`sliceStream: bad length ${length}`);
    let left = length;
    const inner = (async function* innerChunks() {
      while (left > 0) {
        const c = await pull(left);
        if (c === null) throw lenErr(`the audio ended ${left} samples before the end of slice ${index}`);
        left -= c.length;
        yield c;
      }
    })();
    yield { index, length, chunks: inner };
    while (left > 0) { // 使われなかった分は読み捨てる
      const c = await pull(left);
      if (c === null) throw lenErr(`the audio ended ${left} samples before the end of slice ${index}`);
      left -= c.length;
    }
  }
  if (await pull(1) !== null) throw lenErr('the audio is longer than the slices');
}
