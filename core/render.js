// 完成した音声の作成（CONTRACTS.md 1.8、設計書 6.4）。第 1 波の範囲：
//   採用の区間を order の順に、結合部ごとのフェードでつなぐ → 音量の倍率（整数演算）→ 16 ビットに丸めて飽和。
//   周波数の変換、リミッター、目標音量の自動調整は第 2 波（renderSpec.version: 2）。入力と出力の周波数が違えば unsupported-rate。
// 同じ入力 PCM、同じ編集の記録、同じ renderSpec から、同じ出力（ビット単位）。chunkSamples を変えても 1 サンプルも変わらない。
// 実行時に三角関数と pow を呼ばない。浮動小数点は整数の値の四則演算（2^53 未満で正確）と floor にだけ使う。

import { FADE_Q16, FADE_LENGTHS, GAIN_Q20, GAIN_DB_MIN, GAIN_DB_MAX } from './render/tables.js';
import { DEFAULT_SAMPLE_RATE, DEFAULT_FADE_SAMPLES, DEFAULT_CEILING_DB } from './constants.js';

/** 音声の作成で起きるエラー。`code`：'unsupported-rate'、'unsupported-spec'、'bad-args'、'short-read' など */
export class RenderError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`render: ${message}`);
    this.name = 'RenderError';
    this.code = code;
  }
}

const DEFAULT_CHUNK = 1 << 16;

/**
 * 既定のレンダー仕様（第 1 波）。リミッターと目標音量と周波数の変換は無し（DECISIONS.md）。
 * @returns {{version:number, sampleRate:number, fadeSamples:number, fadeShape:string, resampler:string, targetLufs:number|null, ceilingDb:number, limiter:string, rounding:string, dither:string}}
 */
export function defaultRenderSpec() {
  return {
    version: 1,
    sampleRate: DEFAULT_SAMPLE_RATE,
    fadeSamples: DEFAULT_FADE_SAMPLES,
    fadeShape: 'raised-cosine',
    resampler: 'none',
    targetLufs: null,
    ceilingDb: DEFAULT_CEILING_DB,
    limiter: 'none',
    rounding: 'round-half-even',
    dither: 'none',
  };
}

// ---------------------------------------------------------------- 整数の演算

/** round-half-even(x / 2^bits)。x は整数（符号付き。|x| < 2^53） */
function roundShiftHalfEven(x, bits) {
  const d = 2 ** bits;
  const q = Math.floor(x / d); // 2 のべきでの割り算は正確
  const r = x - q * d; // 0 <= r < d
  const half = d / 2;
  if (r > half) return q + 1;
  if (r < half) return q;
  return q % 2 === 0 ? q : q + 1; // 負の q でも偶奇は q % 2 で判定できる（-3 % 2 === -1）
}

/**
 * フェードの係数（CONTRACTS.md 7.2）。長さ n の表の i 番目。2^16 を 1 とする固定小数。i = 0 が結合部に最も近いサンプル。
 * n は FADE_LENGTHS のどれか。それ以外は RenderError('unsupported-fade-length')。
 * @param {number} i @param {number} n
 */
export function fadeCoef(i, n) {
  const t = FADE_Q16[n];
  if (!t) throw new RenderError('unsupported-fade-length', `fade length ${n} is not supported (use one of ${FADE_LENGTHS.join(', ')} or 0)`);
  return t[i];
}

// ---------------------------------------------------------------- 計画

/**
 * 区間と編集の記録から、音声の作成の計画を立てる（読み込みも計算もしない）。
 * `renderTake` が内部で使う。完成版の manifest の `applied` に入れる値（`gainDb`、`limiter`、`fadeSamples`、`joinAdjust`）も返す。
 *
 * 編集の適用（CONTRACTS.md 1.7）：`edits.joins` のうち、この区間たちの `takeId` のものを使う。`index` は 1 から数える結合部
 * （order = index の区間と index + 1 の区間の間）。`trimPrevEnd`（前の区間の終わりの移動）、`shiftNextStart`（次の区間の始まりの移動）。
 * 結果は、録音ファイルの範囲 [0, rawLengths[raw]] と、隣の区間（`allSegments` の中の、同じ録音ファイルの他の区間。採用でも破棄でも）を
 * 越えない範囲、かつ長さ 1 以上に切り詰める。破棄の区間の音を採用に戻すことはできない（`allSegments` に破棄の区間を含めること）。
 * 同じ（takeId、index）が複数あれば後のものを使う。範囲外の index は無視する。
 *
 * 結合部のフェード：前の区間の終わりと次の区間の始まりが、同じ録音ファイルで連続している（終わり == 始まり）ときは、
 * 音が途切れていないので何もしない（隣り合う OK 点の区間をまとめても分けても結果が同じになる）。
 * preserveFileRotations が真の場合、file-rotate でつながったファイルの境目も、編集後に同じ位置でつながればフェードしない。
 * 連続していないときは、前の区間の最後の min(N, 前の長さ) サンプルをフェードアウト、次の区間の最初の min(N, 次の長さ) サンプルをフェードイン（N = fadeSamples。7.2）。
 * 係数は結合部からの距離で決まる（表を縮めない）。N は 7.2 の対応する長さと 0 だけ（他は unsupported-fade-length）。
 * テイクの最初と最後にはフェードをかけない。
 *
 * @param {{segments: import('./types.js').Segment[], rawRates: Record<string,number>, edits?: any, spec?: any,
 *          gainDb?: number, rawLengths?: Record<string,number>, allSegments?: import('./types.js').Segment[]}} args
 * @returns {{sampleRate:number, totalSamples:number, fadeSamples:number, gainDb:number,
 *            pieces:{raw:string, start:number, end:number, length:number, offset:number, fadeIn:number, fadeOut:number}[],
 *            applied:{gainDb:number, limiter:string, fadeSamples:number, joinAdjust:{index:number, trimPrevEnd:number, shiftNextStart:number}[]}}}
 */
export function planRender(args) {
  if (!args || typeof args !== 'object') throw new RenderError('bad-args', 'args is required');
  const spec = { ...defaultRenderSpec(), ...(args.spec || {}) };
  const edits = args.edits || {};
  if (spec.version !== 1) throw new RenderError('unsupported-spec', `renderSpec.version ${spec.version} is not supported (1 only)`);
  if (spec.fadeShape !== 'raised-cosine') throw new RenderError('unsupported-spec', `fadeShape ${spec.fadeShape}`);
  if (spec.rounding !== 'round-half-even') throw new RenderError('unsupported-spec', `rounding ${spec.rounding}`);
  if (spec.dither !== 'none') throw new RenderError('unsupported-spec', `dither ${spec.dither}`);
  if (spec.limiter !== 'none') throw new RenderError('unsupported-spec', `limiter ${spec.limiter} (not available in renderSpec version 1)`);
  if (spec.targetLufs !== null && spec.targetLufs !== undefined) throw new RenderError('unsupported-spec', 'targetLufs is not available in renderSpec version 1');
  const sampleRate = spec.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new RenderError('unsupported-spec', `sampleRate ${sampleRate}`);

  const fadeSamples = edits.fadeSamples !== undefined ? edits.fadeSamples : spec.fadeSamples;
  if (!Number.isInteger(fadeSamples) || fadeSamples < 0) throw new RenderError('bad-args', `fadeSamples ${fadeSamples}`);
  if (fadeSamples !== 0 && !FADE_Q16[fadeSamples]) fadeCoef(0, fadeSamples); // unsupported-fade-length

  const gainDbIn = args.gainDb === undefined ? 0 : args.gainDb;
  if (typeof gainDbIn !== 'number' || !Number.isFinite(gainDbIn)) throw new RenderError('bad-args', `gainDb ${gainDbIn}`);
  const gainIdx = Math.round(gainDbIn * 10); // 0.1 dB 刻みに丸める
  if (gainIdx < GAIN_DB_MIN * 10 || gainIdx > GAIN_DB_MAX * 10) throw new RenderError('bad-args', `gainDb ${gainDbIn} is outside ${GAIN_DB_MIN}..${GAIN_DB_MAX}`);

  // 採用の区間を order の順に
  const segs = (Array.isArray(args.segments) ? args.segments : [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s && (s.status === undefined || s.status === 'kept') && s.order !== null)
    .sort((a, b) => ((a.s.order ?? a.i + 1) - (b.s.order ?? b.i + 1)) || (a.i - b.i))
    .map(({ s }) => s);

  const rates = args.rawRates || {};
  for (const s of segs) {
    const rate = rates[s.raw];
    if (rate === undefined) throw new RenderError('unknown-rate', `no sample rate for ${s.raw}`);
    if (rate !== sampleRate) throw new RenderError('unsupported-rate', `${rate} Hz -> ${sampleRate} Hz is not available in renderSpec version 1 (${s.raw})`);
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start) throw new RenderError('bad-args', `bad segment range ${s.raw} [${s.start}, ${s.end})`);
  }

  // 録音ファイルの長さを超える区間は、ファイルの終わりで切る（7.2 の 6）。空になる区間は使わない
  const lens0 = args.rawLengths || {};
  for (let i = segs.length - 1; i >= 0; i--) {
    const len = lens0[segs[i].raw];
    if (len !== undefined && segs[i].start >= len) segs.splice(i, 1);
  }

  // 編集：結合部の移動
  const cur = segs.map((s) => ({ raw: s.raw, start: s.start, end: lens0[s.raw] !== undefined ? Math.min(s.end, lens0[s.raw]) : s.end }));
  const adjust = [];
  if (segs.length >= 2 && Array.isArray(edits.joins)) {
    const takeId = segs[0].takeId;
    const all = Array.isArray(args.allSegments) ? args.allSegments : segs;
    const lens = args.rawLengths || {};
    const joins = new Map();
    for (const j of edits.joins) {
      if (!j || (takeId !== undefined && j.takeId !== takeId) || !Number.isInteger(j.index)) continue;
      if (j.index < 1 || j.index >= segs.length) continue;
      joins.set(j.index, j); // 後のものが勝つ
    }
    const same = (o, s) => o === s || (o.segmentId !== undefined && o.segmentId === s.segmentId);
    const upper = (s) => { // 終わりを伸ばせる上限
      let u = lens[s.raw] !== undefined ? lens[s.raw] : Infinity;
      for (const o of all) if (!same(o, s) && o.raw === s.raw && o.start >= s.end && o.start < u) u = o.start;
      return u;
    };
    const lower = (s) => { // 始まりを前へ動かせる下限
      let l = 0;
      for (const o of all) if (!same(o, s) && o.raw === s.raw && o.end <= s.start && o.end > l) l = o.end;
      return l;
    };
    for (const index of [...joins.keys()].sort((a, b) => a - b)) {
      const j = joins.get(index);
      const pi = index - 1;
      const ni = index;
      const trim = Number.isInteger(j.trimPrevEnd) ? j.trimPrevEnd : 0;
      const shift = Number.isInteger(j.shiftNextStart) ? j.shiftNextStart : 0;
      const prevEnd0 = cur[pi].end;
      const nextStart0 = cur[ni].start;
      cur[pi].end = Math.max(cur[pi].start + 1, Math.min(upper(segs[pi]), cur[pi].end + trim));
      cur[ni].start = Math.min(cur[ni].end - 1, Math.max(lower(segs[ni]), cur[ni].start + shift));
      adjust.push({ index, trimPrevEnd: cur[pi].end - prevEnd0, shiftNextStart: cur[ni].start - nextStart0 });
    }
  }

  // 結合部のフェードの長さ
  const pieces = cur.map((c, i) => ({ raw: c.raw, start: c.start, end: c.end, length: c.end - c.start, offset: 0, fadeIn: 0, fadeOut: 0 }));
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    pieces[i].offset = offset;
    offset += pieces[i].length;
    if (i > 0) {
      const a = pieces[i - 1];
      const b = pieces[i];
      const rotation = segs[i].rotationFrom;
      const contiguous = (a.raw === b.raw && a.end === b.start) ||
        (spec.preserveFileRotations === true && rotation?.raw === a.raw && rotation.end === a.end &&
          a.raw !== b.raw && b.start === 0);
      a.fadeOut = contiguous ? 0 : Math.min(fadeSamples, a.length);
      b.fadeIn = contiguous ? 0 : Math.min(fadeSamples, b.length);
    }
  }
  return {
    sampleRate,
    totalSamples: offset,
    fadeSamples,
    gainDb: gainIdx / 10,
    pieces,
    applied: { gainDb: gainIdx / 10, limiter: 'none', fadeSamples, joinAdjust: adjust },
  };
}

// ---------------------------------------------------------------- 実行

/**
 * 完成した音声の作成（CONTRACTS.md 1.8）。出力は `chunkSamples`（既定 65536）によらず同じ。
 * 引数の誤り（`unsupported-rate` など）は、この関数を呼んだときに RenderError を投げる。
 * `readSamples(raw, start, end)` は `[start, end)` のサンプルを返す（短ければ RenderError('short-read')）。
 * 追加の任意の引数：`gainDb`（その話す人の倍率。0.1 dB 刻みに丸める。-60..+24）、`rawLengths`、`allSegments`（`planRender` を見よ）。
 * @param {{segments: import('./types.js').Segment[], rawRates: Record<string,number>,
 *          readSamples:(raw:string,start:number,end:number)=>Promise<Int16Array>,
 *          edits?:any, spec?:any, chunkSamples?:number, gainDb?:number, rawLengths?:Record<string,number>, allSegments?:import('./types.js').Segment[]}} args
 * @returns {AsyncIterable<Int16Array>}
 */
export function renderTake(args) {
  const plan = planRender(args);
  const chunk = args.chunkSamples === undefined ? DEFAULT_CHUNK : args.chunkSamples;
  if (!Number.isInteger(chunk) || chunk < 1) throw new RenderError('bad-args', `chunkSamples ${chunk}`);
  if (typeof args.readSamples !== 'function') throw new RenderError('bad-args', 'readSamples is required');
  return generate(plan, args.readSamples, chunk);
}

async function* generate(plan, readSamples, chunk) {
  const { pieces, totalSamples } = plan;
  const gainQ20 = GAIN_Q20[Math.round(plan.gainDb * 10) + 600];
  const applyGain = gainQ20 !== 1 << 20;
  const fadeTable = plan.fadeSamples > 0 ? FADE_Q16[plan.fadeSamples] : [];
  let pi = 0;
  for (let out0 = 0; out0 < totalSamples; out0 += chunk) {
    const n = Math.min(chunk, totalSamples - out0);
    const buf = new Int16Array(n);
    while (pieces[pi].offset + pieces[pi].length <= out0) pi++;
    let written = 0;
    let p = pi;
    while (written < n) {
      const piece = pieces[p];
      const local0 = out0 + written - piece.offset; // この断片の中の位置
      const take = Math.min(n - written, piece.length - local0);
      const src = await readSamples(piece.raw, piece.start + local0, piece.start + local0 + take);
      if (!src || src.length !== take) throw new RenderError('short-read', `${piece.raw} [${piece.start + local0}, ${piece.start + local0 + take}) returned ${src ? src.length : 'nothing'} samples`);
      for (let t = 0; t < take; t++) {
        const local = local0 + t;
        let v = src[t];
        // フェードイン、次にフェードアウトを、それぞれ丸めながら順にかける（7.2 の 4）。係数は結合部からの距離で決まる
        if (local < piece.fadeIn) v = roundShiftHalfEven(v * fadeTable[local], 16);
        const dist = piece.length - 1 - local;
        if (dist < piece.fadeOut) v = roundShiftHalfEven(v * fadeTable[dist], 16);
        if (applyGain) {
          v = roundShiftHalfEven(v * gainQ20, 20);
          if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        }
        buf[written + t] = v;
      }
      written += take;
      if (written < n) p++;
    }
    yield buf;
  }
}
