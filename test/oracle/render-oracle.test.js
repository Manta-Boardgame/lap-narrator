// render-oracle（完成 PCM の別実装）の試験。
// 小さな場面の期待値は、整数の割り算の商と余りから手で計算した値をそのまま書いてある（oracle の出力から作っていない）。
// 係数の表（N=4）：T = [2494, 20228, 45308, 63042]、（N=2）：T = [9598, 55938]、（N=1）：T = [32768]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { oracleRenderTake, roundHalfEvenQ16, mulQ16, saturate16, pcmToBytes } from './render-oracle.js';
import { FADE_TABLES } from './fade-tables.js';
import { loadSession, listSessions } from './load-session.js';
import { decodeWav } from '../../testgen/lib/wav.js';
import { sha256Hex } from '../../testgen/lib/hash.js';

const pcm = (...a) => Int16Array.from(a);
const rep = (v, n) => new Array(n).fill(v);
const render = (raws, segments, fadeSamples) => oracleRenderTake({ segments, pcmOf: (r) => raws[r], fadeSamples });
// 区間の間に 1 サンプルの隙間（捨てた音）を置いて、結合部を不連続にする（連続した結合部にはフェードがかからない）。
const GAP = 5;

test('係数の表：対称、単調、端の値', () => {
  for (const [n, t] of Object.entries(FADE_TABLES)) {
    assert.equal(t.length, Number(n));
    for (let i = 0; i < t.length; i++) assert.equal(t[i] + t[t.length - 1 - i], 65536, `N=${n} i=${i}`);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1]);
  }
  assert.deepEqual(FADE_TABLES[4], [2494, 20228, 45308, 63042]);
  assert.deepEqual(FADE_TABLES[2], [9598, 55938]);
  assert.deepEqual(FADE_TABLES[1], [32768]);
  assert.equal(FADE_TABLES[384].length, 384);
  assert.equal(FADE_TABLES[384][0], 0);
  assert.equal(FADE_TABLES[384][383], 65536);
  // Python（別の数学ライブラリ）で作った値との照合：N=8
  assert.deepEqual(FADE_TABLES[8], [630, 5522, 14563, 26375, 39161, 50973, 60014, 64906]);
});

test('丸め：round-half-even（x / 65536）', () => {
  const xs = [32768, 98304, 163840, -32768, -98304, -163840, 32769, 32767, 65536, 0, -32769, -1];
  const want = [0, 2, 2, 0, -2, -2, 1, 0, 1, 0, -1, 0];
  assert.deepEqual(xs.map(roundHalfEvenQ16), want);
  assert.ok(Object.is(roundHalfEvenQ16(-32768), 0), '-0 is normalized to 0');
  // 掛け算：1 * 0.5 = 0.5 -> 0、3 * 0.5 = 1.5 -> 2、5 * 0.5 = 2.5 -> 2、-3 * 0.5 -> -2
  assert.deepEqual([1, 3, 5, -1, -3, -5].map((s) => mulQ16(s, 32768)), [0, 2, 2, 0, -2, -2]);
  // 手で計算：16384 * 2494 / 65536 = 623.5 -> 624（偶数）。10000 * 2494 / 65536 = 380.55 -> 381
  assert.equal(mulQ16(16384, 2494), 624);
  assert.equal(mulQ16(-16384, 2494), -624);
  assert.equal(mulQ16(10000, 2494), 381);
});

test('飽和', () => {
  assert.equal(saturate16(40000), 32767);
  assert.equal(saturate16(-40000), -32768);
  assert.equal(saturate16(5), 5);
  assert.equal(mulQ16(32767, 65536), 32767);
  assert.equal(mulQ16(-32768, 65536), -32768);
  assert.equal(mulQ16(32767, 70000), 32767);
  assert.equal(mulQ16(-32768, 70000), -32768);
});

test('場面 A（N=4）：2 つの区間、1 つの結合部', () => {
  const raws = { r: pcm(...rep(10000, 8), GAP, ...rep(-10000, 8)) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 8 }, { raw: 'r', start: 9, end: 17 }], 4);
  assert.deepEqual(Array.from(out), [10000, 10000, 10000, 10000, 9619, 6913, 3087, 381, -381, -3087, -6913, -9619, -10000, -10000, -10000, -10000]);
});

test('場面 B（N=4）：短い区間（N より短い）に両側のフェードが重なる（フェードは順に丸める）', () => {
  const raws = { r: pcm(...rep(10000, 4), GAP, ...rep(10000, 2), GAP, ...rep(10000, 4)) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 4 }, { raw: 'r', start: 5, end: 7 }, { raw: 'r', start: 8, end: 12 }], 4);
  assert.deepEqual(Array.from(out), [9619, 6913, 3087, 381, 118, 117, 381, 3087, 6913, 9619]);
});

test('場面 C（N=2）：3 つの区間、真ん中の区間は両側にフェード', () => {
  const raws = { r: pcm(...rep(1000, 4), GAP, ...rep(2000, 4), GAP, ...rep(3000, 4)) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 4 }, { raw: 'r', start: 5, end: 9 }, { raw: 'r', start: 10, end: 14 }], 2);
  assert.deepEqual(Array.from(out), [1000, 1000, 854, 146, 293, 1707, 1707, 293, 439, 2561, 3000, 3000]);
});

test('場面 D（N=1）：係数 0.5、半分の丸め', () => {
  const raws = { r: pcm(1001, 1001, GAP, 3, 3) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 2 }, { raw: 'r', start: 3, end: 5 }], 1);
  assert.deepEqual(Array.from(out), [1001, 500, 2, 3]);
});

test('場面 E：区間が 1 つなら、フェードをかけない（短くても、録音の端でも）', () => {
  const raws = { r: pcm(5, -6, 7) };
  assert.deepEqual(Array.from(render(raws, [{ raw: 'r', start: 0, end: 3 }], 384)), [5, -6, 7]);
});

test('場面 F：N=0 はフェードなしの連結。区間の順は与えた順（録音ファイルの順とは限らない）', () => {
  const raws = { a: pcm(1, 2, 3, 4), b: pcm(10, 20, 30) };
  const out = render(raws, [{ raw: 'b', start: 1, end: 3 }, { raw: 'a', start: 0, end: 2 }, { raw: 'a', start: 2, end: 4 }], 0);
  assert.deepEqual(Array.from(out), [20, 30, 1, 2, 3, 4]);
});

test('場面 G：既定の N=384。結合部の両側は 0 になり、遠い所は変わらない', () => {
  const raws = { r: pcm(...rep(12000, 1000), GAP, ...rep(12000, 1000)) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 1000 }, { raw: 'r', start: 1001, end: 2001 }]);
  assert.equal(out.length, 2000);
  assert.equal(out[999], 0); // T[0] = 0
  assert.equal(out[1000], 0);
  assert.equal(out[0], 12000);
  assert.equal(out[1999], 12000);
  assert.equal(out[999 - 383], mulQ16(12000, FADE_TABLES[384][383]));
  assert.equal(out[999 - 384], 12000);
  assert.equal(out[1000 + 383], mulQ16(12000, FADE_TABLES[384][383]));
  assert.equal(out[1000 + 384], 12000);
});

test('場面 H（N=4）：連続した結合部（同じ録音ファイルで 前の終わり == 次の始まり）にはフェードをかけない', () => {
  const raws = { r: pcm(...rep(10000, 4), ...rep(-10000, 4), 1, 2, 3) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 4 }, { raw: 'r', start: 4, end: 8 }], 4);
  assert.deepEqual(Array.from(out), [10000, 10000, 10000, 10000, -10000, -10000, -10000, -10000]);
  // 3 つとも連続：録音ファイルの切り出しと同じ
  const out3 = render(raws, [{ raw: 'r', start: 0, end: 2 }, { raw: 'r', start: 2, end: 6 }, { raw: 'r', start: 6, end: 11 }], 4);
  assert.deepEqual(Array.from(out3), Array.from(raws.r));
});

test('場面 I（N=4）：連続した結合部と不連続な結合部が混ざる', () => {
  // A=[0,4) と B=[4,8) は連続（フェードなし）。B と C=[9,15) の間は隙間があるので、B の終わりと C の始まりにフェード
  const raws = { r: pcm(...rep(10000, 8), GAP, ...rep(10000, 6)) };
  const out = render(raws, [{ raw: 'r', start: 0, end: 4 }, { raw: 'r', start: 4, end: 8 }, { raw: 'r', start: 9, end: 15 }], 4);
  assert.deepEqual(Array.from(out), [10000, 10000, 10000, 10000, 9619, 6913, 3087, 381, 381, 3087, 6913, 9619, 10000, 10000]);
});

test('場面 J：連続でないもの（別の録音ファイル、順が逆、重なり、隙間）はフェードをかける', () => {
  const raws = { a: pcm(...rep(10000, 4)), b: pcm(...rep(10000, 4)) };
  // 別の録音ファイル（a の終わり == b の始まりの数値が同じでも）
  const o1 = render(raws, [{ raw: 'a', start: 0, end: 4 }, { raw: 'b', start: 0, end: 4 }], 2);
  assert.equal(o1[3], mulQ16(10000, 9598), 'a の最後は T[0]');
  assert.equal(o1[4], mulQ16(10000, 9598), 'b の最初は T[0]');
  // 順が逆（次の終わり == 前の始まり）
  const r = { r: pcm(...rep(10000, 8)) };
  const o2 = render(r, [{ raw: 'r', start: 4, end: 8 }, { raw: 'r', start: 0, end: 4 }], 2);
  assert.equal(o2[3], mulQ16(10000, 9598));
  assert.equal(o2[4], mulQ16(10000, 9598));
  // 重なり（次の始まりが前の終わりより前）
  const o3 = render(r, [{ raw: 'r', start: 0, end: 6 }, { raw: 'r', start: 4, end: 8 }], 2);
  assert.equal(o3[5], mulQ16(10000, 9598));
  assert.equal(o3[6], mulQ16(10000, 9598));
});

test('見本：連続した区間だけのテイクは、録音ファイルの切り出しとビット単位で同じ（undo-ok）', () => {
  const s = loadSession('undo-ok');
  const raw = decodeWav(readFileSync(join(s.dir, 'raw/rec-000001.wav'))).samples;
  const segById = new Map(s.expected.segments.map((g) => [g.segmentId, g]));
  const take = s.expected.takes[0];
  const out = render({ 'rec-000001': raw }, take.segments.map((id) => segById.get(id)), 384);
  assert.deepEqual(Array.from(out), Array.from(raw.subarray(0, 28800)));
});

test('空の入力、1 サンプル、録音ファイルの長さを超える区間', () => {
  assert.equal(oracleRenderTake({ segments: [], pcmOf: () => pcm() }).length, 0);
  assert.deepEqual(Array.from(render({ r: pcm(7) }, [{ raw: 'r', start: 0, end: 1 }], 384)), [7]);
  assert.equal(render({ r: pcm(1, 2, 3) }, [{ raw: 'r', start: 1, end: 100 }], 4).length, 2);
});

test('対応しない設定はエラー（unsupported-fade-length、unsupported-rate）', () => {
  assert.throws(() => render({ r: pcm(1) }, [{ raw: 'r', start: 0, end: 1 }], 7), /unsupported-fade-length/);
  assert.throws(() => oracleRenderTake({ segments: [{ raw: 'r', start: 0, end: 1 }], pcmOf: () => pcm(1), rateOf: () => 44100 }), /unsupported-rate/);
});

test('入力の PCM を書き換えない。同じ入力から同じ出力', () => {
  const src = pcm(...rep(9000, 40));
  const copy = Int16Array.from(src);
  const segs = [{ raw: 'r', start: 0, end: 20 }, { raw: 'r', start: 20, end: 40 }];
  const a = render({ r: src }, segs, 8);
  const b = render({ r: src }, segs, 8);
  assert.deepEqual(Array.from(src), Array.from(copy));
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('pcmToBytes はリトルエンディアン', () => {
  assert.deepEqual(Array.from(pcmToBytes(pcm(1, -1, -32768, 32767))), [1, 0, 255, 255, 0, 128, 255, 127]);
});

// ---- 見本のセッションごとの期待値（expected.render.json）との照合 ----
for (const name of listSessions()) {
  test(`見本の完成 PCM の期待値と一致する: ${name}`, () => {
    const s = loadSession(name);
    assert.ok(s.expectedRender, 'expected.render.json exists');
    const raws = {};
    for (const r of s.manifest.rawFiles) raws[basename(r.file, '.wav')] = decodeWav(readFileSync(join(s.dir, r.file))).samples;
    const segById = new Map(s.expected.segments.map((g) => [g.segmentId, g]));
    for (const f of s.expectedRender.finals) {
      const take = s.expected.takes.find((t) => t.takeId === f.takeId);
      const out = render(raws, take.segments.map((id) => segById.get(id)), s.expectedRender.fadeSamples);
      assert.equal(out.length, f.samples);
      assert.equal(sha256Hex(pcmToBytes(out)), f.sha256);
    }
    assert.equal(s.expectedRender.finals.length + (s.expectedRender.unrenderable?.length ?? 0), Object.keys(s.expected.defaultTakes).length);
  });
}

test('tiny3-full：撮り直しで捨てた音（150 Hz）は完成に入らない', () => {
  const s = loadSession('tiny3-full');
  const raw = decodeWav(readFileSync(join(s.dir, 'raw/rec-000001.wav'))).samples;
  const segById = new Map(s.expected.segments.map((g) => [g.segmentId, g]));
  const take = s.expected.takes[0];
  const out = render({ 'rec-000001': raw }, take.segments.map((id) => segById.get(id)), 384);
  assert.equal(out.length, 19200);
  // 結合部（9600 の前後）は 0、前後の音は録音ファイルと同じ
  assert.equal(out[9599], 0);
  assert.equal(out[9600], 0);
  assert.equal(out[100], raw[100]);
  assert.equal(out[9600 + 5000], raw[14400 + 5000]);
});

// ---- 録音ファイルの長さを超える区間（CONTRACTS.md 7.7 の 6）：切る → 空になる区間は取り除く → 連続の判断は切ったあと ----
test('場面 K（N=4）：範囲を超えて空になる区間を取り除くと、前後が連続になり、フェードはかからない', () => {
  const raws = { r: pcm(...rep(10000, 6), ...rep(-10000, 4)) }; // 長さ 10
  // [0,6)、[20,30)（空になる）、[6,10)：[0,6) と [6,10) は連続
  const out = render(raws, [{ raw: 'r', start: 0, end: 6 }, { raw: 'r', start: 20, end: 30 }, { raw: 'r', start: 6, end: 10 }], 4);
  assert.deepEqual(Array.from(out), Array.from(raws.r));
});

test('場面 L（N=4）：切ったあとの値で連続を判断する（終わりがファイルの長さで切られて、次の始まりと一致する）', () => {
  const raws = { r: pcm(...rep(10000, 10)) };
  // [0,10) と [10,20)（空になる）と [0,3)：1 つ目の終わり 10 と 3 つ目の始まり 0 は連続でない → フェード
  const out = render(raws, [{ raw: 'r', start: 0, end: 10 }, { raw: 'r', start: 10, end: 20 }, { raw: 'r', start: 0, end: 3 }], 4);
  assert.deepEqual(Array.from(out), [10000, 10000, 10000, 10000, 10000, 10000, 9619, 6913, 3087, 381, 381, 3087, 6913]);
  // [0,6) と [6,20)（[6,10) に切られる）と [10,...)：切ったあと [0,6) と [6,10) は連続
  const out2 = render(raws, [{ raw: 'r', start: 0, end: 6 }, { raw: 'r', start: 6, end: 20 }], 4);
  assert.deepEqual(Array.from(out2), Array.from(raws.r));
});

test('見本 render-clamp-empty：描画は録音ファイルの先頭 48000 サンプルと同じ（空の区間の前後にフェードがかからない）', () => {
  const s = loadSession('render-clamp-empty');
  const raw = decodeWav(readFileSync(join(s.dir, 'raw/rec-000001.wav'))).samples;
  const segById = new Map(s.expected.segments.map((g) => [g.segmentId, g]));
  const out = render({ 'rec-000001': raw }, s.expected.takes[0].segments.map((id) => segById.get(id)), 384);
  assert.deepEqual(Array.from(out), Array.from(raw));
  assert.equal(s.expectedRender.finals[0].samples, 48000);
  assert.equal(s.expectedRender.finals[0].sha256, sha256Hex(pcmToBytes(raw)));
});
