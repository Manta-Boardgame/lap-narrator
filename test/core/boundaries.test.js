// 切れ目 boundaries.json の検証、通しの音声の切り出し（サンプル単位）、切れ目から作る予定表（core/boundaries.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBoundaries, planSlices, undecidedSlides, buildContinuousTimeline, sliceStream, recordableOrder, scriptHash, textHash, validate, frameOf } from '../../core/index.js';

const H = (c) => c.repeat(64);

function script3(extra = []) {
  const slides = [
    { slideId: 's0001', order: 1, title: 'a', text: 'one', recordable: true, image: 'slides/0001.png' },
    { slideId: 's0002', order: 2, title: 'b', text: 'skip me', recordable: false, image: 'slides/0002.png' },
    { slideId: 's0003', order: 3, title: 'c', text: 'two', recordable: true, image: 'slides/0003.png' },
    { slideId: 's0004', order: 4, title: 'd', text: 'three', recordable: true, image: 'slides/0004.png' },
    ...extra,
  ];
  for (const s of slides) s.textHash = textHash(s);
  return { format: 'lap-narrator/script', version: 1, projectId: 'proj-test-01', title: 't', scriptHash: scriptHash(slides), slides };
}

function good(script = script3()) {
  return {
    format: 'lap-narrator/boundaries', version: 1, sampleRate: 48000,
    audio: { file: 'final/all.wav', sha256: H('a'), samples: 300000 },
    transcript: { file: 'transcript.json', sha256: H('b'), model: 'small' },
    script: { scriptHash: script.scriptHash },
    slides: [
      { slideId: 's0001', order: 1, startSample: 0, endSample: 100000, confidence: 0.97, method: 'asr-align', status: 'auto', candidates: [{ sample: 100000, score: 0.97 }] },
      { slideId: 's0003', order: 3, startSample: 100000, endSample: 180001, confidence: 0.5, method: 'asr-align', status: 'needs-decision', candidates: [{ sample: 180001, score: 0.5 }, { sample: 170000, score: 0.4 }] },
      { slideId: 's0004', order: 4, startSample: 180001, endSample: 300000, confidence: 1, method: 'manual', status: 'confirmed' },
    ],
  };
}
const codes = (r) => r.errors.map((e) => e.code);
const clone = (v) => JSON.parse(JSON.stringify(v));

test('正しい切れ目は通る（台本と音声の照合つき）', () => {
  const s = script3();
  const b = good(s);
  assert.deepEqual(checkBoundaries(b), { ok: true, errors: [] });
  assert.deepEqual(checkBoundaries(b, { script: s, audio: { sha256: H('a'), samples: 300000, sampleRate: 48000 } }), { ok: true, errors: [] });
  assert.deepEqual(recordableOrder(s).map((x) => x.slideId), ['s0001', 's0003', 's0004']);
});

test('構造の誤り：bad-boundaries（形式、版、型、列挙）。構造の誤りがあるときは、あとの検査をしない', () => {
  const s = script3();
  const cases = {
    'not an object': null,
    format: { ...good(s), format: 'x' },
    version: { ...good(s), version: 2 },
    sampleRate: { ...good(s), sampleRate: 100 },
    'audio.sha256': { ...good(s), audio: { samples: 10, sha256: 'xyz' } },
    'audio.samples': { ...good(s), audio: { sha256: H('a'), samples: 0 } },
    'script.scriptHash': { ...good(s), script: {} },
    'slides empty': { ...good(s), slides: [] },
  };
  for (const [name, b] of Object.entries(cases)) {
    const r = checkBoundaries(b, { script: s });
    assert.equal(r.ok, false, name);
    assert.deepEqual([...new Set(codes(r))], ['bad-boundaries'], name);
  }
  for (const [name, mut] of Object.entries({
    slideId: (x) => { x.slides[0].slideId = 'a b'; },
    order: (x) => { x.slides[0].order = 0; },
    startSample: (x) => { x.slides[0].startSample = 1.5; },
    endSample: (x) => { x.slides[0].endSample = -1; },
    status: (x) => { x.slides[0].status = 'maybe'; },
    method: (x) => { x.slides[0].method = 'guess'; },
    confidence: (x) => { x.slides[0].confidence = 1.5; },
    candidates: (x) => { x.slides[0].candidates = [{ score: 1 }]; },
  })) {
    const b = good(s);
    mut(b);
    const r = checkBoundaries(b, { script: s });
    assert.equal(r.ok, false, name);
    assert.equal(r.errors[0].code, 'bad-boundaries', name);
    assert.match(r.errors[0].message, new RegExp(name === 'slideId' ? 'slideId' : name), name);
  }
});

test('区間が連続・半開でない：not-contiguous（始まりが 0 でない、隙間、重なり、長さ 0、終わりが音声の長さと違う、同じスライドが 2 回、order が増えない）', () => {
  const s = script3();
  const mutations = {
    'first not 0': (b) => { b.slides[0].startSample = 5; },
    gap: (b) => { b.slides[1].startSample = 100001; },
    overlap: (b) => { b.slides[1].startSample = 99999; },
    'zero length': (b) => { b.slides[0].endSample = 0; b.slides[1].startSample = 0; },
    'negative length': (b) => { b.slides[0].endSample = 100000; b.slides[0].startSample = 100000; },
    'last end differs': (b) => { b.slides[2].endSample = 299999; },
    'last end beyond': (b) => { b.audio.samples = 299999; },
    duplicate: (b) => { b.slides[2].slideId = 's0003'; },
    'order not increasing': (b) => { b.slides[2].order = 3; },
  };
  for (const [name, mut] of Object.entries(mutations)) {
    const b = good(s);
    mut(b);
    const r = checkBoundaries(b, { script: s });
    assert.equal(r.ok, false, name);
    assert.ok(codes(r).includes('not-contiguous'), `${name}: ${JSON.stringify(r.errors)}`);
  }
});

test('台本との照合：script-mismatch（scriptHash）、slides-mismatch（録音の対象のスライドと合わない）', () => {
  const s = script3();
  const b = good(s);
  const r1 = checkBoundaries({ ...b, script: { scriptHash: H('9') } }, { script: s });
  assert.deepEqual(codes(r1), ['script-mismatch']);
  assert.equal(r1.errors[0].detail.workspace, s.scriptHash);
  // 録音の対象でないスライド（s0002）が入っている
  const b2 = good(s);
  b2.slides.splice(1, 0, { slideId: 's0002', order: 2, startSample: 100000, endSample: 100001, status: 'auto' });
  b2.slides[2].startSample = 100001;
  const r2 = checkBoundaries(b2, { script: s });
  assert.deepEqual(codes(r2), ['slides-mismatch']);
  assert.deepEqual(r2.errors[0].detail.extra, ['s0002']);
  // 足りない
  const b3 = good(s);
  b3.slides.pop();
  b3.audio.samples = 180001;
  const r3 = checkBoundaries(b3, { script: s });
  assert.deepEqual(codes(r3), ['slides-mismatch']);
  assert.deepEqual(r3.errors[0].detail.missing, ['s0004']);
  // 順番が違う
  const b4 = good(s);
  [b4.slides[0].slideId, b4.slides[1].slideId] = [b4.slides[1].slideId, b4.slides[0].slideId];
  assert.deepEqual(codes(checkBoundaries(b4, { script: s })), ['slides-mismatch']);
});

test('音声との照合：audio-mismatch（SHA-256、長さ、周波数）', () => {
  const s = script3();
  const b = good(s);
  const r = checkBoundaries(b, { script: s, audio: { sha256: H('c'), samples: 300000, sampleRate: 48000 } });
  assert.deepEqual(codes(r), ['audio-mismatch']);
  assert.deepEqual(r.errors[0].detail.differs, ['sha256']);
  const r2 = checkBoundaries(b, { script: s, audio: { sha256: H('a'), samples: 299999, sampleRate: 44100 } });
  assert.deepEqual(r2.errors[0].detail.differs, ['samples', 'sampleRate']);
  // 照合する項目だけを渡せる
  assert.equal(checkBoundaries(b, { audio: { samples: 300000 } }).ok, true);
});

test('判断待ちのスライドと、切り出しの計画', () => {
  const b = good();
  assert.deepEqual(undecidedSlides(b).map((x) => x.slideId), ['s0003']);
  const plan = planSlices(b);
  assert.deepEqual(plan.map((p) => [p.slideId, p.start, p.end, p.samples]), [['s0001', 0, 100000, 100000], ['s0003', 100000, 180001, 80001], ['s0004', 180001, 300000, 119999]]);
  assert.equal(plan.reduce((n, p) => n + p.samples, 0), b.audio.samples);
  assert.equal(plan[1].status, 'needs-decision');
});

// ---------------------------------------------------------------- 切り出し

function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; }
async function collect(gen) { const out = []; for await (const c of gen) out.push(Int16Array.from(c)); return out; }
const flat = (chunks) => { let n = 0; for (const c of chunks) n += c.length; const o = new Int16Array(n); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; };

test('sliceStream：切り出した区間をつなぐと元の音声にサンプル単位で戻る（かたまりの大きさ、区間の長さをいろいろに変えて）', async () => {
  const rnd = prng(12345);
  for (let trial = 0; trial < 40; trial++) {
    const nSlices = 1 + (rnd() % 6);
    const lengths = Array.from({ length: nSlices }, () => 1 + (rnd() % 5000));
    const total = lengths.reduce((a, b) => a + b, 0);
    const whole = new Int16Array(total);
    for (let i = 0; i < total; i++) whole[i] = (rnd() >>> 16) - 32768;
    const chunkSize = 1 + (rnd() % 3000);
    const source = (async function* () { for (let o = 0; o < total; o += chunkSize) yield whole.subarray(o, Math.min(total, o + chunkSize)); })();
    const pieces = [];
    for await (const p of sliceStream(source, lengths)) pieces.push({ index: p.index, length: p.length, data: flat(await collect(p.chunks)) });
    assert.equal(pieces.length, nSlices);
    let off = 0;
    pieces.forEach((p, i) => {
      assert.equal(p.index, i);
      assert.equal(p.data.length, lengths[i]);
      assert.deepEqual(p.data, whole.slice(off, off + lengths[i]), `trial ${trial} slice ${i}`);
      off += lengths[i];
    });
    assert.deepEqual(flat(pieces.map((p) => p.data)), whole, `trial ${trial}: concatenation`);
  }
});

test('sliceStream：同期の列でもよい。使わずに次へ進んだ区間は読み捨てて、位置はずれない。長さが合わなければ source-length', async () => {
  const whole = Int16Array.from({ length: 1000 }, (_, i) => i - 500);
  const lengths = [300, 300, 400];
  const seen = [];
  for await (const p of sliceStream([whole.subarray(0, 450), whole.subarray(450)], lengths)) {
    if (p.index === 1) continue; // 使わない
    seen.push(flat(await collect(p.chunks)));
  }
  assert.deepEqual(seen[0], whole.slice(0, 300));
  assert.deepEqual(seen[1], whole.slice(600, 1000));

  const run = async (src, lens) => { for await (const p of sliceStream(src, lens)) await collect(p.chunks); };
  await assert.rejects(run([whole], [600, 600]), (e) => e.code === 'source-length' && /ended/.test(e.message));
  await assert.rejects(run([whole], [500, 400]), (e) => e.code === 'source-length' && /longer/.test(e.message));
  await assert.rejects(run([whole], [1000, 0]), /bad length/);
  await run([whole], [1000]); // ちょうどなら通る
});

// ---------------------------------------------------------------- 予定表

test('buildContinuousTimeline：スライドの切り替えの時刻は切れ目の位置そのもの（余白は 0）。既存の予定表の規則と schema に通る', () => {
  const s = script3();
  const b = good(s);
  const finals = planSlices(b).map((p) => ({ slideId: p.slideId, samples: p.samples, sampleRate: 48000, parts: [{ file: `final/${p.slideId}.wav`, samples: p.samples }] }));
  const tl = buildContinuousTimeline({ script: s, boundaries: b, finals });
  assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
  assert.equal(tl.prePadSamples, 0);
  assert.equal(tl.postPadSamples, 0);
  assert.equal(tl.totalSamples, b.audio.samples);
  tl.slides.forEach((x, i) => {
    assert.equal(x.showStart, b.slides[i].startSample);
    assert.equal(x.audioStart, b.slides[i].startSample);
    assert.equal(x.audioEnd, b.slides[i].endSample);
    assert.equal(x.showEnd, b.slides[i].endSample);
    assert.equal(x.audioSamples, b.slides[i].endSample - b.slides[i].startSample);
    assert.equal(x.audio, `final/${b.slides[i].slideId}.wav`);
    // 既存の規則（CONTRACTS.md 1.10）
    assert.equal(x.audioStart, x.showStart + tl.prePadSamples);
    assert.equal(x.showEnd, x.audioEnd + tl.postPadSamples);
    if (i + 1 < tl.slides.length) assert.equal(tl.slides[i + 1].showStart, x.showEnd);
  });
  assert.deepEqual(tl.slides.map((x) => x.order), [1, 3, 4], '録音の対象でない s0002 は入らない');
  // フレームへの丸め（方式 B）は、切れ目のサンプルから
  assert.equal(frameOf(100000, 30, 48000), 63);
  assert.equal(frameOf(180001, 30, 48000), 113);
});

test('buildContinuousTimeline：音声のパートが複数のスライドは、順序付きの配列になる。切れ目と合わない完成版は RangeError', () => {
  const s = script3();
  const b = good(s);
  const plan = planSlices(b);
  const finals = plan.map((p) => ({ slideId: p.slideId, samples: p.samples, sampleRate: 48000, parts: p.slideId === 's0003' ? [{ file: 'final/s0003.p001.wav', samples: 40000 }, { file: 'final/s0003.p002.wav', samples: p.samples - 40000 }] : [{ file: `final/${p.slideId}.wav`, samples: p.samples }] }));
  const tl = buildContinuousTimeline({ script: s, boundaries: b, finals });
  assert.deepEqual(tl.slides[1].audio, ['final/s0003.p001.wav', 'final/s0003.p002.wav']);
  const wrong = finals.map((f) => (f.slideId === 's0003' ? { ...f, samples: f.samples - 1, parts: [{ file: 'final/s0003.wav', samples: f.samples - 1 }] } : f));
  assert.throws(() => buildContinuousTimeline({ script: s, boundaries: b, finals: wrong }), RangeError);
  assert.throws(() => buildContinuousTimeline({ script: s, boundaries: b, finals: finals.slice(0, 2) }), RangeError);
});

test('buildContinuousTimeline：tailMarginSamples（各スライドの音声の終わりを切れ目より手前に置く余裕）は postPadSamples になり、切り替えの時刻は切れ目のまま', () => {
  const s = script3();
  const b = good(s);
  const M = 4800;
  const finals = planSlices(b).map((p) => ({ slideId: p.slideId, samples: p.samples - M, sampleRate: 48000, parts: [{ file: `final/${p.slideId}.wav`, samples: p.samples - M }] }));
  const tl = buildContinuousTimeline({ script: s, boundaries: b, finals, tailMarginSamples: M });
  assert.deepEqual(validate('timeline', tl), { ok: true, errors: [] });
  assert.equal(tl.prePadSamples, 0);
  assert.equal(tl.postPadSamples, M);
  tl.slides.forEach((x, i) => {
    assert.equal(x.showStart, b.slides[i].startSample);
    assert.equal(x.audioEnd, b.slides[i].endSample - M);
    assert.equal(x.showEnd, b.slides[i].endSample);
    assert.equal(x.audioStart + x.audioSamples + tl.postPadSamples, x.showEnd);
  });
  assert.equal(tl.totalSamples, b.audio.samples);
  // 余裕の宣言と音声の長さが合わなければ RangeError
  assert.throws(() => buildContinuousTimeline({ script: s, boundaries: b, finals, tailMarginSamples: 0 }), RangeError);
  assert.throws(() => buildContinuousTimeline({ script: s, boundaries: b, finals, tailMarginSamples: -1 }), RangeError);
});
