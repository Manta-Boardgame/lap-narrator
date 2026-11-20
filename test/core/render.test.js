import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderTake, planRender, defaultRenderSpec, fadeCoef, RenderError } from '../../core/render.js';
import { FADE_Q16, FADE_LENGTHS, GAIN_Q20 } from '../../core/render/tables.js';
import { generate as generateTables } from './helpers/gen-render-tables.js';
import { runPython, hasPython } from './helpers/python.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 試験用の素材：決まった擬似乱数の PCM
function makeRaw(n, seed) {
  const a = new Int16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = ((s >>> 16) & 0xffff) - 32768; }
  return a;
}
const RAWS = { 'rec-000001': makeRaw(100000, 1), 'rec-000002': makeRaw(60000, 2) };
const RATES = { 'rec-000001': 48000, 'rec-000002': 48000 };
const LENS = { 'rec-000001': 100000, 'rec-000002': 60000 };
const readSamples = async (raw, s, e) => RAWS[raw].slice(s, e);

let sid = 0;
const seg = (raw, start, end, order, extra = {}) => ({ segmentId: `g${String(++sid).padStart(5, '0')}`, takeId: 't0001', slideId: 's1', raw, start, end, status: 'kept', order, ...extra });

async function collect(it) {
  const parts = [];
  for await (const c of it) parts.push(c);
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { out, chunks: parts.map((p) => p.length) };
}
const render = async (segments, extra = {}) => (await collect(renderTake({ segments, rawRates: RATES, readSamples, rawLengths: LENS, ...extra }))).out;

// 丸め（round-half-even）を BigInt で
function rshe(x, bits) { // x: bigint
  const d = 1n << BigInt(bits);
  let q = x / d; let r = x % d;
  if (r < 0n) { q -= 1n; r += d; }
  const half = d >> 1n;
  if (r > half) return q + 1n;
  if (r < half) return q;
  return q % 2n === 0n ? q : q + 1n;
}
const mulQ16 = (v, c) => Number(rshe(BigInt(v) * BigInt(c), 16));

// ---------------------------------------------------------------- 表と係数

test('既定のレンダー仕様（第 1 波）：DECISIONS.md のとおり limiter:"none"、targetLufs:null、周波数の変換なし', () => {
  const d = defaultRenderSpec();
  assert.deepEqual(d, {
    version: 1, sampleRate: 48000, fadeSamples: 384, fadeShape: 'raised-cosine', resampler: 'none', targetLufs: null,
    ceilingDb: -1.5, limiter: 'none', rounding: 'round-half-even', dither: 'none',
  });
  assert.notEqual(defaultRenderSpec(), defaultRenderSpec()); // 毎回別のオブジェクト
});

test('core/render/tables.js は生成スクリプトの出力と一致している', () => {
  assert.equal(readFileSync(join(root, 'core', 'render', 'tables.js'), 'utf8'), generateTables());
});

test('表の検算：Python（別の実装）の cos と pow から、同じ値になる', { skip: !hasPython }, () => {
  const py = `
import math, json
def rhe(x):
    f = math.floor(x); d = x - f
    if d > 0.5: return f + 1
    if d < 0.5: return f
    return f if f % 2 == 0 else f + 1
fades = {str(n): [rhe(65536 * (1 - math.cos(math.pi * (i + 0.5) / n)) / 2) for i in range(n)] for n in json.loads(input())}
gain = [rhe((2**20) * 10 ** (((i - 600) / 10) / 20)) for i in range(841)]
print(json.dumps([fades, gain]))
`;
  const r = runPython(py, [], JSON.stringify(FADE_LENGTHS) + '\n');
  assert.equal(r.status, 0, r.stderr);
  const [fades, gain] = JSON.parse(r.stdout);
  for (const n of FADE_LENGTHS) assert.deepEqual([...FADE_Q16[n]], fades[String(n)], `N=${n}`);
  assert.deepEqual([...GAIN_Q20], gain);
});

test('表の性質（7.2）：値は 0..65536、単調増加、T[i] + T[N-1-i] = 65536、倍率 0 dB は 2^20', () => {
  assert.deepEqual([...FADE_LENGTHS], [1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 480]);
  for (const n of FADE_LENGTHS) {
    const t = FADE_Q16[n];
    assert.equal(t.length, n);
    for (let i = 0; i < n; i++) {
      assert.ok(t[i] >= 0 && t[i] <= 65536);
      if (i > 0) assert.ok(t[i] >= t[i - 1], `単調 N=${n} i=${i}`);
      assert.equal(t[i] + t[n - 1 - i], 65536, `対称 N=${n} i=${i}`);
    }
  }
  assert.equal(FADE_Q16[1][0], 32768);
  assert.equal(GAIN_Q20[600], 2 ** 20);
  for (let i = 1; i < GAIN_Q20.length; i++) assert.ok(GAIN_Q20[i] > GAIN_Q20[i - 1]);
});

test('フェードの係数：理想の立ち上がりコサインとの差が 0.5 + 丸めの余裕以内。対応しない長さは unsupported-fade-length', () => {
  for (const n of FADE_LENGTHS) {
    for (let i = 0; i < n; i++) {
      const ideal = (65536 * (1 - Math.cos((Math.PI * (i + 0.5)) / n))) / 2;
      assert.ok(Math.abs(fadeCoef(i, n) - ideal) <= 0.5 + 1e-6, `n=${n} i=${i}`);
    }
  }
  for (const bad of [7, 10, 100, 384.5, 481, 1000]) assert.throws(() => fadeCoef(0, bad), { code: 'unsupported-fade-length' });
});

test('n = 384 の係数表の固定（回帰の検出。値を変えるときは仕様の版を上げる）', () => {
  const coefs = [...FADE_Q16[384]];
  assert.deepEqual(coefs.slice(0, 5), [0, 2, 7, 13, 22]);
  assert.deepEqual(coefs.slice(-3), [65529, 65534, 65536]);
  const h = createHash('sha256').update(coefs.join(',')).digest('hex');
  assert.equal(h, 'b4ce8a8b7af4ac4fb796a6bfaec97944e3fbf78f430ec90757f660fb5441f99c');
});

// ---------------------------------------------------------------- 音声の作成

test('1 つの区間：入力の切り出しと完全に一致（フェードも倍率もなし）', async () => {
  const out = await render([seg('rec-000001', 1000, 6000, 1)]);
  assert.deepEqual(out, RAWS['rec-000001'].slice(1000, 6000));
});

test('空の入力：何も返さない。採用でない区間と order が null の区間は使わない', async () => {
  assert.equal((await render([])).length, 0);
  const plan = planRender({ segments: [seg('rec-000001', 0, 100, null, { status: 'discarded' }), seg('rec-000001', 100, 200, null)], rawRates: RATES });
  assert.equal(plan.totalSamples, 0);
  assert.deepEqual(plan.pieces, []);
  const out = await render([seg('rec-000001', 0, 100, null, { status: 'discarded' }), seg('rec-000001', 100, 200, 1, { status: 'uncommitted' })]);
  assert.equal(out.length, 0);
});

test('1 サンプルの区間', async () => {
  const out = await render([seg('rec-000001', 5, 6, 1)]);
  assert.deepEqual([...out], [RAWS['rec-000001'][5]]);
});

test('連続した区間（隣り合う OK 点）には、フェードをかけない：まとめた 1 区間と同じ出力', async () => {
  const merged = await render([seg('rec-000001', 1000, 4000, 1)]);
  const split = await render([seg('rec-000001', 1000, 2000, 1), seg('rec-000001', 2000, 3500, 2), seg('rec-000001', 3500, 4000, 3)]);
  assert.deepEqual(split, merged);
});

test('離れた区間：結合部だけにフェード。前の終わりはフェードアウト、次の始まりはフェードイン、重ねない', async () => {
  const a = seg('rec-000001', 1000, 3000, 1);
  const b = seg('rec-000001', 5000, 8000, 2);
  const out = await render([a, b]);
  const src = RAWS['rec-000001'];
  assert.equal(out.length, 5000);
  const F = 384;
  for (let i = 0; i < 5000; i++) {
    let expected;
    if (i < 2000) {
      const t = i;
      const dist = 2000 - 1 - t; // 結合部からの距離。結合部に最も近いサンプルが T[0]
      expected = dist < F ? mulQ16(src[1000 + t], fadeCoef(dist, F)) : src[1000 + t];
    } else {
      const t = i - 2000;
      expected = t < F ? mulQ16(src[5000 + t], fadeCoef(t, F)) : src[5000 + t];
    }
    assert.equal(out[i], expected, `i=${i}`);
  }
  // テイクの最初と最後には、フェードをかけない
  assert.equal(out[0], src[1000]);
  assert.equal(out[4999], src[7999]);
  // 結合部の前後の隣り合うサンプルは小さい
  assert.ok(Math.abs(out[1999]) <= Math.abs(src[2999]) / 100 + 1);
});

test('別の録音ファイルにまたがる区間も、連続していなければフェード', async () => {
  const out = await render([seg('rec-000001', 90000, 100000, 1), seg('rec-000002', 0, 5000, 2)]);
  const plan = planRender({ segments: [seg('rec-000001', 90000, 100000, 1), seg('rec-000002', 0, 5000, 2)], rawRates: RATES });
  assert.equal(plan.pieces[0].fadeOut, 384);
  assert.equal(plan.pieces[1].fadeIn, 384);
  assert.equal(out.length, 15000);
  assert.equal(out[14999], RAWS['rec-000002'][4999]);
  assert.equal(out[10000], mulQ16(RAWS['rec-000002'][0], fadeCoef(0, 384)));
});

test('短い区間：かける長さは min(N, 区間の長さ)。表は縮めず、結合部からの距離で係数を決める。前後が重なれば、フェードインのあとにフェードアウトを順に丸めてかける', async () => {
  const a = seg('rec-000001', 0, 100, 1);
  const b = seg('rec-000001', 500, 540, 2);   // 40 サンプル：前後のフェードが全体に重なる
  const c = seg('rec-000001', 1000, 2000, 3);
  const plan = planRender({ segments: [a, b, c], rawRates: RATES });
  assert.deepEqual(plan.pieces.map((p) => [p.length, p.fadeIn, p.fadeOut]), [[100, 0, 100], [40, 40, 40], [1000, 384, 0]]);
  const out = await render([a, b, c]);
  const src = RAWS['rec-000001'];
  for (let t = 0; t < 40; t++) {
    const v1 = mulQ16(src[500 + t], fadeCoef(t, 384));          // フェードイン（前の結合部からの距離 t）
    const v2 = mulQ16(v1, fadeCoef(40 - 1 - t, 384));            // フェードアウト（次の結合部からの距離）
    assert.equal(out[100 + t], v2, `t=${t}`);
  }
  for (let t = 0; t < 100; t++) assert.equal(out[t], mulQ16(src[t], fadeCoef(99 - t, 384)), `a t=${t}`);
});

test('fadeSamples の指定（edits が優先）と 0（フェードなし）', async () => {
  const a = seg('rec-000001', 1000, 3000, 1);
  const b = seg('rec-000001', 5000, 8000, 2);
  const none = await render([a, b], { edits: { fadeSamples: 0 } });
  const src = RAWS['rec-000001'];
  assert.deepEqual(none, Int16Array.from([...src.slice(1000, 3000), ...src.slice(5000, 8000)]));
  const plan = planRender({ segments: [a, b], rawRates: RATES, spec: { fadeSamples: 96 } });
  assert.equal(plan.fadeSamples, 96);
  assert.equal(plan.pieces[0].fadeOut, 96);
  assert.equal(planRender({ segments: [a, b], rawRates: RATES, spec: { fadeSamples: 96 }, edits: { fadeSamples: 48 } }).pieces[0].fadeOut, 48);
  for (const bad of [100, 7, 481]) assert.throws(() => planRender({ segments: [a, b], rawRates: RATES, edits: { fadeSamples: bad } }), { code: 'unsupported-fade-length' });
});

test('order の順に並べる（渡す順によらない）', async () => {
  const a = seg('rec-000001', 1000, 2000, 1);
  const b = seg('rec-000002', 100, 700, 2);
  assert.deepEqual(await render([b, a]), await render([a, b]));
});

test('かたまりの大きさ（chunkSamples）を変えても、出力は 1 サンプルも変わらない', async () => {
  const segs = [seg('rec-000001', 1000, 3000, 1), seg('rec-000001', 5000, 5300, 2), seg('rec-000002', 100, 2600, 3), seg('rec-000002', 2600, 2700, 4), seg('rec-000001', 20000, 20007, 5)];
  const base = await render(segs, { gainDb: 3.7, chunkSamples: 65536 });
  const total = base.length;
  assert.equal(total, 2000 + 300 + 2500 + 100 + 7);
  for (const chunk of [1, 2, 3, 7, 64, 383, 384, 385, 1000, 2999, total - 1, total, total + 1, 1_000_000]) {
    const { out, chunks } = await collect(renderTake({ segments: segs, rawRates: RATES, readSamples, gainDb: 3.7, chunkSamples: chunk }));
    assert.deepEqual(out, base, `chunk=${chunk}`);
    assert.ok(chunks.every((c, i) => c === Math.min(chunk, total) || i === chunks.length - 1), `chunk 長 chunk=${chunk}`);
    assert.equal(chunks.reduce((a, b) => a + b, 0), total);
  }
});

test('同じ入力から同じ出力（繰り返し）', async () => {
  const segs = [seg('rec-000001', 1000, 3000, 1), seg('rec-000002', 100, 2600, 2)];
  const a = await render(segs, { gainDb: -2.2 });
  const b = await render(segs, { gainDb: -2.2 });
  assert.deepEqual(a, b);
});

// ---- 倍率

test('倍率 0 dB は入力と同じ。+6 dB と -6 dB は理想値との差が 1 以内。0.1 dB 刻みに丸める', async () => {
  const segs = [seg('rec-000001', 2000, 6000, 1)];
  const src = RAWS['rec-000001'].slice(2000, 6000);
  assert.deepEqual(await render(segs, { gainDb: 0 }), src);
  for (const db of [6, -6, 1.5, -20, 12]) {
    const out = await render(segs, { gainDb: db });
    const g = Math.pow(10, db / 20);
    for (let i = 0; i < src.length; i++) {
      const ideal = Math.max(-32768, Math.min(32767, src[i] * g));
      assert.ok(Math.abs(out[i] - ideal) <= 1.01, `db=${db} i=${i} out=${out[i]} ideal=${ideal}`);
    }
  }
  // 0.1 dB 刻みの丸め：1.54 → 1.5、1.56 → 1.6
  assert.deepEqual(await render(segs, { gainDb: 1.54 }), await render(segs, { gainDb: 1.5 }));
  assert.deepEqual(await render(segs, { gainDb: 1.56 }), await render(segs, { gainDb: 1.6 }));
  assert.equal(planRender({ segments: segs, rawRates: RATES, gainDb: 1.54 }).applied.gainDb, 1.5);
});

test('倍率：BigInt の厳密な計算と一致。飽和（−32768〜32767）', async () => {
  const src = Int16Array.from([32767, -32768, 1, -1, 0, 12345, -12345, 3]);
  const raws = { 'rec-000001': src };
  const rs = async (r, s, e) => raws[r].slice(s, e);
  for (const db of [24, 6, 0.1, -0.1, -60, -3.3]) {
    const { out } = await collect(renderTake({ segments: [seg('rec-000001', 0, 8, 1)], rawRates: RATES, readSamples: rs, gainDb: db }));
    const g = BigInt(GAIN_Q20[Math.round(db * 10) + 600]);
    const expected = [...src].map((v) => { const x = Number(rshe(BigInt(v) * g, 20)); return Math.max(-32768, Math.min(32767, x)); });
    assert.deepEqual([...out], expected, `db=${db}`);
  }
  const { out } = await collect(renderTake({ segments: [seg('rec-000001', 0, 8, 1)], rawRates: RATES, readSamples: rs, gainDb: 24 }));
  assert.equal(out[0], 32767);
  assert.equal(out[1], -32768);
});

test('倍率の範囲外は RenderError', () => {
  const segs = [seg('rec-000001', 0, 8, 1)];
  assert.throws(() => planRender({ segments: segs, rawRates: RATES, gainDb: 24.1 }), { code: 'bad-args' });
  assert.throws(() => planRender({ segments: segs, rawRates: RATES, gainDb: -60.1 }), { code: 'bad-args' });
  assert.throws(() => planRender({ segments: segs, rawRates: RATES, gainDb: NaN }), { code: 'bad-args' });
});

// ---- 仕様の検査

test('周波数が違えば unsupported-rate（renderTake を呼んだとき）', () => {
  const segs = [seg('rec-000001', 0, 100, 1)];
  assert.throws(() => renderTake({ segments: segs, rawRates: { 'rec-000001': 44100 }, readSamples }), (e) => e instanceof RenderError && e.code === 'unsupported-rate');
  assert.throws(() => renderTake({ segments: segs, rawRates: {}, readSamples }), { code: 'unknown-rate' });
  // 出力の周波数を録音に合わせれば通る
  const it = renderTake({ segments: segs, rawRates: { 'rec-000001': 44100 }, readSamples, spec: { sampleRate: 44100 } });
  assert.ok(it[Symbol.asyncIterator]);
});

test('第 2 波の機能（リミッター、目標音量）、未知の形は unsupported-spec', () => {
  const segs = [seg('rec-000001', 0, 100, 1)];
  const bad = (spec) => assert.throws(() => renderTake({ segments: segs, rawRates: RATES, readSamples, spec }), { code: 'unsupported-spec' });
  bad({ limiter: 'lookahead-v1' });
  bad({ targetLufs: -16 });
  bad({ version: 2 });
  bad({ fadeShape: 'linear' });
  bad({ rounding: 'floor' });
  bad({ dither: 'tpdf' });
});

test('不正な引数：区間の範囲、chunkSamples、readSamples', () => {
  assert.throws(() => planRender({ segments: [seg('rec-000001', 10, 10, 1)], rawRates: RATES }), { code: 'bad-args' });
  assert.throws(() => planRender({ segments: [seg('rec-000001', -1, 10, 1)], rawRates: RATES }), { code: 'bad-args' });
  assert.throws(() => renderTake({ segments: [], rawRates: RATES, readSamples, chunkSamples: 0 }), { code: 'bad-args' });
  assert.throws(() => renderTake({ segments: [seg('rec-000001', 0, 10, 1)], rawRates: RATES }), { code: 'bad-args' });
  assert.throws(() => planRender(null), { code: 'bad-args' });
  assert.throws(() => planRender({ segments: [], rawRates: RATES, edits: { fadeSamples: -1 } }), { code: 'bad-args' });
});

test('読み込みが短ければ short-read', async () => {
  const it = renderTake({ segments: [seg('rec-000001', 0, 100, 1)], rawRates: RATES, readSamples: async (r, s, e) => RAWS[r].slice(s, e - 1) });
  await assert.rejects(collect(it), { code: 'short-read' });
});

// ---------------------------------------------------------------- 編集（結合部の移動）

test('edits.joins：trimPrevEnd と shiftNextStart を適用し、実際に動いた量を applied.joinAdjust に出す', async () => {
  const a = seg('rec-000001', 1000, 2000, 1);
  const b = seg('rec-000001', 5000, 6000, 2);
  const edits = { joins: [{ takeId: 't0001', index: 1, trimPrevEnd: -100, shiftNextStart: 50 }] };
  const plan = planRender({ segments: [a, b], rawRates: RATES, edits, rawLengths: LENS });
  assert.deepEqual(plan.pieces.map((p) => [p.start, p.end]), [[1000, 1900], [5050, 6000]]);
  assert.equal(plan.totalSamples, 900 + 950);
  assert.deepEqual(plan.applied.joinAdjust, [{ index: 1, trimPrevEnd: -100, shiftNextStart: 50 }]);
  const out = await render([a, b], { edits });
  assert.equal(out.length, 1850);
  assert.equal(out[0], RAWS['rec-000001'][1000]);
  assert.equal(out[1849], RAWS['rec-000001'][5999]);
});

test('edits.joins：隣の区間（破棄の区間を含む）と録音ファイルの範囲を越えない。長さ 1 以上', () => {
  const a = seg('rec-000001', 1000, 2000, 1);
  const b = seg('rec-000001', 5000, 6000, 2);
  const dBetween1 = seg('rec-000001', 2000, 2500, null, { status: 'discarded' }); // a のすぐ後ろ
  const dBetween2 = seg('rec-000001', 4500, 5000, null, { status: 'discarded' }); // b のすぐ前
  const all = [a, b, dBetween1, dBetween2];
  const plan = (j, extra = {}) => planRender({ segments: [a, b], allSegments: all, rawRates: RATES, rawLengths: LENS, edits: { joins: [{ takeId: 't0001', index: 1, ...j }] }, ...extra });
  // 破棄の区間へは伸ばせない
  let p = plan({ trimPrevEnd: 400, shiftNextStart: -400 });
  assert.deepEqual(p.pieces.map((x) => [x.start, x.end]), [[1000, 2000], [5000, 6000]]);
  assert.deepEqual(p.applied.joinAdjust, [{ index: 1, trimPrevEnd: 0, shiftNextStart: 0 }]);
  // 破棄の区間が無ければ（採用の区間だけを渡すと）伸ばせる範囲は隣の採用の区間まで
  p = planRender({ segments: [a, b], rawRates: RATES, rawLengths: LENS, edits: { joins: [{ takeId: 't0001', index: 1, trimPrevEnd: 400, shiftNextStart: -400 }] } });
  assert.deepEqual(p.pieces.map((x) => [x.start, x.end]), [[1000, 2400], [4600, 6000]]);
  // 縮めすぎても長さ 1 は残る
  p = plan({ trimPrevEnd: -5000, shiftNextStart: 5000 });
  assert.deepEqual(p.pieces.map((x) => [x.start, x.end]), [[1000, 1001], [5999, 6000]]);
  // 録音ファイルの範囲
  const c = seg('rec-000002', 100, 59000, 1);
  const d = seg('rec-000002', 59500, 59900, 2);
  const q = planRender({ segments: [c, d], rawRates: RATES, rawLengths: LENS, edits: { joins: [{ takeId: 't0001', index: 1, trimPrevEnd: 0, shiftNextStart: 10 ** 9 }] } });
  assert.deepEqual(q.pieces.map((x) => [x.start, x.end]), [[100, 59000], [59899, 59900]]);
  const e = seg('rec-000002', 0, 100, 1);
  const f = seg('rec-000002', 59000, 59990, 2);
  const q2 = planRender({ segments: [e, f], rawRates: RATES, rawLengths: LENS, edits: { joins: [{ takeId: 't0001', index: 1, trimPrevEnd: 10 ** 9, shiftNextStart: 0 }] } });
  assert.deepEqual(q2.pieces.map((x) => [x.start, x.end]), [[0, 59000], [59000, 59990]]); // 次の区間の始まりで止まる
});

test('edits.joins：別のテイク、範囲外の index は無視。同じ index は後のものが勝つ。移動で結合部が連続でなくなればフェードが付く', () => {
  const a = seg('rec-000001', 1000, 2000, 1);
  const b = seg('rec-000001', 2000, 3000, 2); // 連続
  assert.equal(planRender({ segments: [a, b], rawRates: RATES }).pieces[0].fadeOut, 0);
  const edits = {
    joins: [
      { takeId: 't9999', index: 1, trimPrevEnd: -300 },       // 別のテイク
      { takeId: 't0001', index: 0, trimPrevEnd: -300 },       // 範囲外
      { takeId: 't0001', index: 2, trimPrevEnd: -300 },       // 範囲外（区間は 2 つなので結合部は 1 つ）
      { takeId: 't0001', index: 1, trimPrevEnd: -999 },
      { takeId: 't0001', index: 1, trimPrevEnd: -240, shiftNextStart: 240 },
    ],
  };
  const p = planRender({ segments: [a, b], rawRates: RATES, edits, rawLengths: LENS });
  assert.deepEqual(p.pieces.map((x) => [x.start, x.end, x.fadeIn, x.fadeOut]), [[1000, 1760, 0, 384], [2240, 3000, 384, 0]]);
  assert.deepEqual(p.applied.joinAdjust, [{ index: 1, trimPrevEnd: -240, shiftNextStart: 240 }]);
});

test('edits：joins が無い、空、gainDb などの他の項目があってもよい', () => {
  const a = seg('rec-000001', 1000, 2000, 1);
  for (const edits of [undefined, {}, { joins: [] }, { gainDb: { x: 1 }, selections: {}, limiter: { ceilingDb: -1.5 } }]) {
    assert.equal(planRender({ segments: [a], rawRates: RATES, edits }).totalSamples, 1000);
  }
});

test('大きな入力（5 分）でもかたまりごとに読む：メモリに全体を載せない', async () => {
  const big = new Int16Array(48000 * 300);
  for (let i = 0; i < big.length; i += 97) big[i] = (i % 30000) - 15000;
  let maxRead = 0;
  const rs = async (r, s, e) => { maxRead = Math.max(maxRead, e - s); return big.slice(s, e); };
  let total = 0;
  for await (const c of renderTake({ segments: [seg('x', 0, 48000 * 100, 1), seg('x', 48000 * 150, 48000 * 250, 2)], rawRates: { x: 48000 }, readSamples: rs, chunkSamples: 48000 })) total += c.length;
  assert.equal(total, 48000 * 200);
  assert.ok(maxRead <= 48000, `maxRead=${maxRead}`);
});

test('録音ファイルの長さを超える区間は、ファイルの終わりで切る（7.2 の 6）。ファイルの外にある区間は使わない', async () => {
  const a = seg('rec-000002', 59000, 61000, 1); // rec-000002 は 60000 サンプル
  const b = seg('rec-000002', 70000, 71000, 2); // 全部外
  const plan = planRender({ segments: [a, b], rawRates: RATES, rawLengths: LENS });
  assert.deepEqual(plan.pieces.map((p) => [p.start, p.end]), [[59000, 60000]]);
  assert.equal(plan.totalSamples, 1000);
  assert.deepEqual(await render([a, b]), RAWS['rec-000002'].slice(59000, 60000));
});
