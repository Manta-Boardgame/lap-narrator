// --lead-in-sec の計算（cli/lib/lead-in.js）：合成の通しの音声（雑音の床の上の「話し」の塊）で、正解の話し始めを知ったうえで確かめる。CLI は動かさない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceStream } from '../../core/boundaries.js';
import { sha256Hex } from '../../core/sha256.js';
import { detectOnset, fillRoomTone, findQuietestBlock, leadInChunks, leadInOptions, planLeadIns } from '../../cli/lib/lead-in.js';

const RATE = 48000;
const SIGMA = 20; // 雑音の床の標準偏差（16 ビットの値）
const sec = (s) => Math.round(s * RATE);

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; }; }
/** 雑音の床：3 つの一様乱数の和（標準偏差 SIGMA、最大 3 SIGMA 相当）。固定の種 */
function floorNoise(n, seed) {
  const r = lcg(seed);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((r() + r() + r()) * SIGMA);
  return out;
}
/** 話しの代わり：ローパスをかけた雑音 × 音節の強さ。立ち上がり・立ち下がり 5 ms。雑音の床も重ねる */
function speech(n, seed, amp = 8000) {
  const r = lcg(seed);
  const out = new Int16Array(n);
  const ramp = sec(0.005);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.35 * (r() - lp);
    const syll = 0.4 + 0.6 * Math.abs(Math.sin((Math.PI * 4 * i) / RATE + seed));
    const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    out[i] = Math.round(lp * 2.2 * amp * syll * env);
  }
  return out;
}
const cat = (parts) => { const o = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const mix = (a, b) => { const o = Int16Array.from(a); for (let i = 0; i < b.length; i++) o[i] += b[i]; return o; };
const asyncChunks = (pcm, size = 65536) => (async function* g() { for (let o = 0; o < pcm.length; o += size) yield pcm.subarray(o, Math.min(pcm.length, o + size)); })();

/**
 * 通しの合成素材。スライドごとに [雑音 pre][話し][雑音 post]。話し始めの正解は pre の終わり。
 * s1：pre 0.6 s（lead-in より短い）、s2：pre 3.0 s（lead-in より長い）、s3：pre 0.2 s（短くて自分の雑音が足りない）
 */
function material(specs = [{ pre: 0.6, talk: 1.0, post: 0.4 }, { pre: 3.0, talk: 0.8, post: 0.5 }, { pre: 0.2, talk: 1.2, post: 0.3 }]) {
  const parts = [];
  const slices = [];
  let at = 0;
  specs.forEach((sp, i) => {
    const pre = floorNoise(sec(sp.pre), 100 + i);
    const talk = mix(floorNoise(sec(sp.talk), 200 + i), speech(sec(sp.talk), 300 + i));
    const post = floorNoise(sec(sp.post), 400 + i);
    const seg = cat([pre, talk, post]);
    slices.push({ slideId: `s${i + 1}`, start: at, end: at + seg.length, samples: seg.length, trueOnset: pre.length, trueEnd: pre.length + talk.length });
    parts.push(seg);
    at += seg.length;
  });
  return { all: cat(parts), slices };
}

const ctxOf = () => { const warnings = []; return { warnings, warn: (code, message, detail) => warnings.push({ code, message, detail }) }; };

async function plan(m, { leadSec = 1.5, keepMs = 250, ctx = ctxOf(), words } = {}) {
  const plans = await planLeadIns({ chunks: () => asyncChunks(m.all, 40000), slices: m.slices, rate: RATE, sliceStream, leadSec, keepMs, words, ctx });
  return { plans, ctx };
}
async function assemble(m, plans) {
  const outs = [];
  for (let i = 0; i < m.slices.length; i++) {
    const sl = m.slices[i];
    const frag = m.all.subarray(sl.start, sl.end);
    const parts = [];
    for await (const c of leadInChunks(asyncChunks(frag, 30000), plans[i])) parts.push(Int16Array.from(c));
    outs.push(cat(parts));
  }
  return outs;
}
const rmsOf = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const maxStep = (x) => { let m = 0; for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
const peakOf = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('(a)(b) 話し始めが lead-in の長さにそろう：短い無音には足し、長い無音は切り詰める。検出は正解の話し始めの手前 40 ms 以内、遅れは 10 ms 以内', async () => {
  const m = material();
  const { plans, ctx } = await plan(m);
  const outs = await assemble(m, plans);
  assert.equal(ctx.warnings.length, 0, JSON.stringify(ctx.warnings));
  const L = sec(1.5);
  m.slices.forEach((sl, i) => {
    const p = plans[i];
    assert.equal(p.found, true, sl.slideId);
    assert.ok(p.onset <= sl.trueOnset + sec(0.01), `${sl.slideId}: onset ${p.onset} is later than the true start ${sl.trueOnset}`);
    assert.ok(p.onset >= sl.trueOnset - sec(0.04), `${sl.slideId}: onset ${p.onset} is too early (true ${sl.trueOnset})`);
    // 出力の長さ = 足した分 + 切り詰めた残り
    assert.equal(outs[i].length, p.pad + sl.samples - p.start, sl.slideId);
    // 正解の話し始めは、出力の先頭から lead-in（検出の誤差の範囲）
    const trueInOut = p.pad + (sl.trueOnset - p.start);
    assert.ok(Math.abs(trueInOut - L) <= sec(0.04), `${sl.slideId}: speech starts ${trueInOut / RATE} s after the start, expected 1.5`);
    // 出力のその位置に、実際に話しが始まっている（前は雑音の床、後は大きな音）
    assert.ok(peakOf(outs[i].subarray(0, trueInOut - sec(0.01))) <= 6 * SIGMA, `${sl.slideId}: loud sound before the speech`);
    assert.ok(peakOf(outs[i].subarray(trueInOut, trueInOut + sec(0.2))) > 1000, `${sl.slideId}: no speech at the expected place`);
  });
  // s1：pre 0.6 s < 1.5 s → 足す（先頭を捨てる分は 0.6 - 0.25 = 0.35 s 以内）
  assert.ok(plans[0].pad > 0 && plans[0].roomToneFrom === 'own', JSON.stringify({ ...plans[0], tone: 0, seam: 0 }));
  assert.ok(plans[0].start <= sec(0.36) && plans[0].start >= sec(0.3), `start ${plans[0].start}`);
  // s2：pre 3.0 s > 1.5 s → 足さず、onset の手前を lead-in だけ残す
  assert.equal(plans[1].pad, 0);
  assert.equal(plans[1].roomToneFrom, null);
  assert.equal(plans[1].onset - plans[1].start, L);
  assert.ok(outs[1].length < m.slices[1].samples, '長い無音は切り詰められる');
  // s3：pre 0.2 s は自分の雑音が足りない（200 ms 未満）→ 録音全体で最も静かな 1 秒
  assert.equal(plans[2].roomToneFrom, 'quietest');
  assert.equal(plans[2].start, 0);
});

test('(c) 話し始めが見つからないとき（雑音だけ、先頭から話している）は、警告 lead-in-onset-not-found（スライド ID つき）。onset は先頭、足す長さは lead-in まるごと', async () => {
  const noiseOnly = floorNoise(sec(2.0), 7);
  const talkFirst = mix(floorNoise(sec(1.5), 8), speech(sec(1.5), 9));
  const normal = cat([floorNoise(sec(0.5), 10), mix(floorNoise(sec(1), 11), speech(sec(1), 12)), floorNoise(sec(0.3), 13)]);
  const all = cat([normal, noiseOnly, talkFirst]);
  const lens = [normal.length, noiseOnly.length, talkFirst.length];
  const slices = [];
  let at = 0;
  ['a1', 'a2', 'a3'].forEach((id, i) => { slices.push({ slideId: id, start: at, end: at + lens[i], samples: lens[i] }); at += lens[i]; });
  const ctx = ctxOf();
  const plans = await planLeadIns({ chunks: () => asyncChunks(all), slices, rate: RATE, sliceStream, leadSec: 1.5, keepMs: 250, ctx });
  assert.deepEqual(ctx.warnings.map((w) => [w.code, w.detail.slideId]), [['lead-in-onset-not-found', 'a2'], ['lead-in-onset-not-found', 'a3']]);
  assert.equal(plans[0].found, true);
  for (const p of [plans[1], plans[2]]) {
    assert.equal(p.found, false);
    assert.equal(p.onset, 0);
    assert.equal(p.start, 0);
    assert.equal(p.pad, sec(1.5));
    assert.equal(p.roomToneFrom, 'quietest');
  }
  assert.equal(plans[1].onsetSource, 'none');
  assert.ok(['head', 'none'].includes(plans[2].onsetSource), plans[2].onsetSource);
});

test('先頭に短い声（60 ms）があり、そのあと無音を置いてから本題が始まる断片：先頭の声を捨てない（先頭から話している扱い。警告）', async () => {
  const frag = cat([mix(floorNoise(sec(0.06), 1), speech(sec(0.06), 2)), floorNoise(sec(0.9), 3), mix(floorNoise(sec(1), 4), speech(sec(1), 5)), floorNoise(sec(0.3), 6)]);
  const slices = [{ slideId: 'h1', start: 0, end: frag.length, samples: frag.length }];
  const ctx = ctxOf();
  const [p] = await planLeadIns({ chunks: () => asyncChunks(frag), slices, rate: RATE, sliceStream, leadSec: 1.5, keepMs: 250, ctx });
  assert.equal(p.found, false);
  assert.equal(p.start, 0, 'nothing is dropped');
  assert.equal(ctx.warnings[0].code, 'lead-in-onset-not-found');
  // 先頭から 0.2 s の所に短い息があって、そのあと本題：息のほうを話し始めとする（捨てる側に音を残さない）
  const frag2 = cat([floorNoise(sec(0.2), 7), mix(floorNoise(sec(0.08), 8), speech(sec(0.08), 9, 4000)), floorNoise(sec(2.0), 10), mix(floorNoise(sec(1), 11), speech(sec(1), 12)), floorNoise(sec(0.3), 13)]);
  const d = detectOnset(frag2, RATE);
  assert.equal(d.found, true);
  assert.equal(d.source, 'burst');
  assert.ok(Math.abs(d.onset - sec(0.2)) <= sec(0.04), `onset ${d.onset}`);
});

test('(d) room tone は完全なゼロではなく、継ぎ目（繰り返しのつなぎ目、断片とのつなぎ目）にクリックがない：隣り合うサンプルの差の最大が、雑音の床の標準偏差の数倍以内', async () => {
  // lead-in を 6 s にして、自分の雑音（0.4 s 余り）を何度も繰り返す
  const m = material([{ pre: 0.5, talk: 1.0, post: 0.3 }, { pre: 0.5, talk: 1.0, post: 0.3 }]);
  for (const leadSec of [1.0, 6.0]) {
    const { plans } = await plan(m, { leadSec });
    const outs = await assemble(m, plans);
    plans.forEach((p, i) => {
      const trueInOut = p.pad + (m.slices[i].trueOnset - p.start);
      const head = outs[i].subarray(0, trueInOut - sec(0.01)); // 話しの直前まで（room tone、つなぎ目、断片の雑音）
      assert.ok(head.length >= sec(0.9));
      assert.ok(rmsOf(head) > 0.7 * SIGMA, `room tone is too quiet (rms ${rmsOf(head)})`);
      assert.ok(rmsOf(head) < 1.4 * SIGMA, `room tone is too loud (rms ${rmsOf(head)})`);
      assert.ok(maxStep(head) <= 8 * SIGMA, `click: max step ${maxStep(head)} (sigma ${SIGMA})`);
      // 足した部分に 0 が長く続かない
      let run = 0; let worst = 0;
      for (const v of outs[i].subarray(0, p.pad)) { run = v === 0 ? run + 1 : 0; worst = Math.max(worst, run); }
      assert.ok(worst < 16, `zero run of ${worst} samples`);
    });
  }
  // 繰り返しの素材そのものも：n が素材より長いとき、継ぎ目の段差がない
  const src = floorNoise(sec(0.3), 55);
  const fill = fillRoomTone(src, sec(5), RATE);
  assert.equal(fill.length, sec(5));
  assert.ok(maxStep(fill) <= 8 * SIGMA);
  assert.ok(Math.abs(rmsOf(fill) - rmsOf(src)) < 0.15 * rmsOf(src), `level ${rmsOf(fill)} vs ${rmsOf(src)}`);
});

test('(e) 同じ入力から同じ出力：SHA-256 が一致する（乱数なし）。かたまりの大きさが違っても同じ', async () => {
  const m = material();
  const hash = async (chunk) => {
    const plans = (await planLeadIns({ chunks: () => asyncChunks(m.all, chunk), slices: m.slices, rate: RATE, sliceStream, leadSec: 2.0, keepMs: 250, ctx: ctxOf() }));
    const outs = await assemble(m, plans);
    return outs.map((o) => sha256Hex(new Uint8Array(o.buffer, o.byteOffset, o.byteLength)));
  };
  const a = await hash(65536);
  assert.deepEqual(await hash(65536), a);
  assert.deepEqual(await hash(12345), a);
  assert.equal(new Set(a).size, 3);
});

test('(g) 切り落とされた先頭に話し声が入っていない：捨てた部分は雑音の床だけ。--lead-keep-ms を変えても。onset の手前の残す長さは keep（足すとき）', async () => {
  const m = material();
  for (const keepMs of [0, 100, 250, 1000]) {
    const { plans } = await plan(m, { keepMs });
    plans.forEach((p, i) => {
      const sl = m.slices[i];
      const dropped = m.all.subarray(sl.start, sl.start + p.start);
      assert.ok(p.start <= sl.trueOnset, `${sl.slideId} keep=${keepMs}: dropped ${p.start} samples, speech starts at ${sl.trueOnset}`);
      assert.ok(peakOf(dropped) <= 6 * SIGMA, `${sl.slideId} keep=${keepMs}: speech in the dropped head (peak ${peakOf(dropped)})`);
      if (p.pad > 0) {
        const kept = p.onset - p.start;
        assert.ok(kept === Math.min(sec(keepMs / 1000), p.onset), `${sl.slideId} keep=${keepMs}: kept ${kept}`);
      }
    });
  }
});

test('lead-in が元の無音より短い（または等しい）とき：足さず、onset の手前を lead-in だけ残す。lead-in が小さくても話しは削れない', async () => {
  const m = material();
  const { plans } = await plan(m, { leadSec: 0.3, keepMs: 250 });
  plans.forEach((p, i) => {
    assert.equal(p.onset - p.start >= 0 && p.pad >= 0, true);
    const sl = m.slices[i];
    assert.ok(p.start <= sl.trueOnset);
    assert.equal(p.pad + (p.onset - p.start), sec(0.3), `${sl.slideId}: head length`);
  });
  assert.equal(plans[1].pad, 0);
});

test('文字起こしの最初の語が onset より早くても、その手前に音が立ち上がっていなければ onset は動かない（語の時刻だけは信じない）。音があれば、そこまで早める', () => {
  const pre = floorNoise(sec(1.0), 1);
  const early = mix(floorNoise(sec(0.12), 2), speech(sec(0.12), 3, 3000)); // 0.5 s に小さな声（息）
  const talk = mix(floorNoise(sec(1.0), 4), speech(sec(1.0), 5));
  const frag = cat([pre.subarray(0, sec(0.5)), early, pre.subarray(0, sec(0.5)), talk, floorNoise(sec(0.3), 6)]);
  const silentFrag = cat([pre, talk, floorNoise(sec(0.3), 6)]);
  const trueTalk = sec(1.0);
  const a = detectOnset(silentFrag, RATE, { wordStartSec: 0.2 });
  assert.equal(a.found, true);
  assert.equal(a.source, 'audio', 'nothing sounds at 0.2 s: the word time is not trusted');
  assert.ok(Math.abs(a.onset - trueTalk) <= sec(0.04));
  const b = detectOnset(frag, RATE, { wordStartSec: 0.45 });
  assert.equal(b.found, true);
  assert.ok(b.onset < sec(0.62), `onset ${b.onset}`);
});

test('findQuietestBlock：録音全体で最も静かな 1 秒（デジタルの無音を含む窓より、雑音のある窓を選ぶ）。同点は先頭', async () => {
  const loud = mix(floorNoise(sec(2), 1), speech(sec(2), 2));
  const quiet = floorNoise(sec(1.5), 3).map((v) => Math.round(v / 2));
  const zeros = new Int16Array(sec(1.2));
  const all = cat([loud, zeros, loud, quiet, loud]);
  const q = await findQuietestBlock(asyncChunks(all, 33333), RATE);
  assert.equal(q.silent, false);
  assert.ok(q.start >= loud.length + zeros.length + loud.length - sec(0.01) && q.start + q.length <= loud.length * 2 + zeros.length + quiet.length + sec(0.01), `start ${q.start / RATE}`);
  assert.equal(q.length, RATE);
  assert.ok(q.rms > 5 && q.rms < SIGMA, `rms ${q.rms}`);
  const onlyZeros = await findQuietestBlock(asyncChunks(new Int16Array(sec(2))), RATE);
  assert.equal(onlyZeros.silent, true);
  assert.equal((await findQuietestBlock(asyncChunks(all, 33333), RATE)).start, q.start);
});

test('leadInOptions：0〜30 の数。0 や未指定は null。範囲の外・数でないものは使い方の誤り（終了コード 2）。--lead-keep-ms は 0〜1000 の整数', () => {
  assert.equal(leadInOptions({}), null);
  assert.equal(leadInOptions({ 'lead-in-sec': '0' }), null);
  assert.deepEqual(leadInOptions({ 'lead-in-sec': '4' }), { sec: 4, keepMs: 250 });
  assert.deepEqual(leadInOptions({ 'lead-in-sec': '3.5', 'lead-keep-ms': '100' }), { sec: 3.5, keepMs: 100 });
  for (const bad of ['-1', '30.5', 'abc', '', ' ', 'NaN', 'Infinity']) {
    assert.throws(() => leadInOptions({ 'lead-in-sec': bad }), (e) => e.exit === 2, bad);
  }
  for (const bad of ['-1', '1001', '1.5', 'x']) {
    assert.throws(() => leadInOptions({ 'lead-in-sec': '4', 'lead-keep-ms': bad }), (e) => e.exit === 2, bad);
  }
  assert.deepEqual(leadInOptions({ 'lead-in-sec': '30', 'lead-keep-ms': '1000' }), { sec: 30, keepMs: 1000 });
});
