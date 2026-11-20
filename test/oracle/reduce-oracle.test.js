// 操作記録の解釈の、別実装（reduce-oracle.js）と、手で導いた期待値（examples/sessions/*/expected.segments.json）の照合。
// 期待値は、CONTRACTS.md 1.5 を 1 行ずつ読んで人が導いた。oracle が食い違うときは、どちらが規則に忠実かを考え直す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oracleReduce } from './reduce-oracle.js';
import { loadSession, listSessions, SESSIONS_DIR, REPO_ROOT } from './load-session.js';
import { compareReduceResult } from './compare.js';
import { validateSchema } from '../../testgen/lib/mini-schema.js';
import { decodeWav } from '../../testgen/lib/wav.js';
import { sha256Hex } from '../../testgen/lib/hash.js';

const schema = (n) => JSON.parse(readFileSync(join(REPO_ROOT, 'schema', n + '.schema.json'), 'utf8'));
const names = listSessions();

test('見本の場面が 16 以上ある', () => {
  assert.ok(names.length >= 16, `scenes: ${names.length}`);
  // 指示にある場面がそろっている
  const must = [
    'basic', 'retake', 'retake-twice', 'retake-null', 'undo-ok', 'undo-retake', 'redo-retake', 'file-rotate', 'pause-resume', 'goto-slide',
    'recovered', 'orphan-audio', 'bad-undo-target', 'position-mismatch', 'beyond-raw-length', 'empty-fragment', 'public-sample', 'durable-many', 'seq-gap',
  ];
  for (const m of must) assert.ok(names.includes(m), `missing scene ${m}`);
});

for (const name of names) {
  test(`oracle が期待値と一致する: ${name}`, () => {
    const s = loadSession(name);
    const result = oracleReduce(s.events, s.rawFiles);
    const diffs = compareReduceResult(result, s.expected);
    assert.deepEqual(diffs, [], diffs.join('\n'));
  });
}

test('比較関数は食い違いを見つける（試験が空振りしていない）', () => {
  const s = loadSession('retake');
  const base = oracleReduce(s.events, s.rawFiles);
  assert.deepEqual(compareReduceResult(base, s.expected), []);
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(base));
    fn(copy);
    return compareReduceResult(copy, s.expected);
  };
  assert.notDeepEqual(mutate((r) => (r.segments[1].status = 'kept')), []);
  assert.notDeepEqual(mutate((r) => (r.segments[0].end += 1)), []);
  assert.notDeepEqual(mutate((r) => (r.takes[0].samples += 1)), []);
  assert.notDeepEqual(mutate((r) => (r.recoverable.pos += 1)), []);
  assert.notDeepEqual(mutate((r) => r.issues.push({ code: 'seq-gap', seq: 1, message: 'x' })), []);
  assert.notDeepEqual(mutate((r) => (r.defaultTakes.s0001 = 't0009')), []);
  assert.notDeepEqual(mutate((r) => r.segments.pop()), []);
  assert.notDeepEqual(mutate((r) => (r.segments[0].reason = 'x')), []);
});

for (const name of names) {
  test(`形式に適合する（schema）: ${name}`, () => {
    const s = loadSession(name);
    const d = s.dir;
    assert.deepEqual(validateSchema(schema('segments'), s.expected), [], 'expected.segments.json');
    assert.deepEqual(validateSchema(schema('manifest'), s.manifest), [], 'manifest.json');
    assert.deepEqual(validateSchema(schema('script'), JSON.parse(readFileSync(join(d, 'script.json'), 'utf8'))), [], 'script.json');
    assert.deepEqual(validateSchema(schema('edits'), JSON.parse(readFileSync(join(d, 'edits.json'), 'utf8'))), [], 'edits.json');
    s.events.forEach((ev, i) => assert.deepEqual(validateSchema(schema('events'), ev), [], `events.jsonl line ${i + 1}`));
  });

  test(`events.jsonl の seq は 0 から（欠番の場面を除く）、eventId は e<seq>、時刻は単調: ${name}`, () => {
    const s = loadSession(name);
    const hasGap = s.expected.issues.some((i) => i.code === 'seq-gap');
    let prevSeq = -1;
    let prevMono = -1;
    for (const ev of s.events) {
      if (!s.expected.issues.some((i) => i.code === 'bad-event')) assert.equal(ev.eventId, 'e' + ev.seq);
      if (!hasGap) assert.equal(ev.seq, prevSeq + 1);
      else assert.ok(ev.seq > prevSeq);
      assert.ok(ev.mono >= prevMono, 'mono is non-decreasing');
      prevSeq = ev.seq;
      prevMono = ev.mono;
    }
    assert.equal(s.events[0].type, 'session-start');
  });

  test(`at は {raw, sample, pos} で整合している（意図した不整合の場面を除く）: ${name}`, () => {
    const s = loadSession(name);
    const intended = new Set(s.expected.issues.map((i) => i.code));
    const byName = new Map(s.rawFiles.map((f) => [f.name, f]));
    const offset = (raw) => {
      const n = parseInt(raw.slice(4), 10);
      return s.rawFiles.filter((f) => parseInt(f.name.slice(4), 10) < n).reduce((a, f) => a + f.samples, 0);
    };
    for (const ev of s.events) {
      for (const at of [ev.at, ev.toAt]) {
        if (!at) continue;
        assert.match(at.raw, /^rec-[0-9]{6}$/);
        if (!byName.has(at.raw)) {
          assert.ok(intended.has('unknown-raw'), `unexpected unknown raw at seq ${ev.seq}`);
          continue;
        }
        if (at.sample > byName.get(at.raw).samples) assert.ok(intended.has('beyond-raw-length'), `unexpected beyond-raw-length at seq ${ev.seq}`);
        if (at.pos !== offset(at.raw) + at.sample) assert.ok(intended.has('position-mismatch'), `unexpected position-mismatch at seq ${ev.seq}`);
      }
    }
  });

  test(`manifest と録音ファイルが一致する（大きさ、SHA-256、WAV の形）: ${name}`, () => {
    const s = loadSession(name);
    for (const f of s.manifest.files) {
      const bytes = readFileSync(join(s.dir, f.path));
      assert.equal(bytes.length, f.bytes, f.path);
      assert.equal(sha256Hex(bytes), f.sha256, f.path);
    }
    for (const r of s.manifest.rawFiles) {
      const bytes = readFileSync(join(s.dir, r.file));
      assert.equal(bytes.length, 44 + r.samples * 2);
      assert.equal(bytes.readUInt32LE(16), 16, 'fmt chunk is 16 bytes');
      assert.equal(bytes.toString('ascii', 36, 40), 'data', 'standard 44-byte header');
      const w = decodeWav(bytes);
      assert.equal(w.sampleRate, r.sampleRate);
      assert.equal(w.samples.length, r.samples);
      assert.equal(w.channels, 1);
      assert.equal(w.bits, 16);
      assert.equal(sha256Hex(bytes), r.sha256);
      assert.ok(r.samples >= 48000 && r.samples <= 3 * 48000, 'each raw file is 1 to 3 seconds');
      assert.ok(r.durableSamples <= r.samples);
    }
    // segments.json は期待値の写し
    assert.equal(readFileSync(join(s.dir, 'segments.json'), 'utf8'), readFileSync(join(s.dir, 'expected.segments.json'), 'utf8'));
  });
}

test('見本の全体の大きさが 5MB 以内', () => {
  let total = 0;
  for (const name of names) {
    const s = loadSession(name);
    for (const f of s.manifest.files) total += readFileSync(join(s.dir, f.path)).length;
  }
  assert.ok(total <= 5 * 1024 * 1024, `total ${total}`);
});

// ---- 性質の試験 ----

test('性質：同じ入力から、いつも同じ出力（入力を書き換えない）', () => {
  for (const name of names) {
    const s = loadSession(name);
    const before = JSON.stringify([s.events, s.rawFiles]);
    const a = oracleReduce(s.events, s.rawFiles);
    const b = oracleReduce(JSON.parse(JSON.stringify(s.events)), JSON.parse(JSON.stringify(s.rawFiles)));
    assert.equal(JSON.stringify(a), JSON.stringify(b), name);
    assert.equal(JSON.stringify([s.events, s.rawFiles]), before, 'inputs unchanged');
  }
});

test('性質：durable を全部取り除いても、採用／破棄は変わらない（durable-many ほか）', () => {
  for (const name of ['durable-many', 'retake', 'file-rotate', 'tiny3-full', 'basic']) {
    const s = loadSession(name);
    const full = oracleReduce(s.events, s.rawFiles);
    const kept = s.events.filter((e) => e.type !== 'durable');
    const newId = new Map(kept.map((e, i) => [e.eventId, 'e' + i]));
    const stripped = kept.map((e, i) => ({ ...e, seq: i, eventId: 'e' + i, ...(e.target ? { target: newId.get(e.target) } : {}) }));
    const r = oracleReduce(stripped, s.rawFiles);
    // 区間の範囲、状態、order は同じ。seq（startSeq、endSeq）は付け直しで変わるので比べない
    const strip = (x) => x.segments.map((g) => [g.segmentId, g.takeId, g.slideId, g.raw, g.start, g.end, g.status, g.reason, g.order]);
    assert.deepEqual(strip(r), strip(full), name);
    assert.deepEqual(r.takes.map((t) => [t.takeId, t.segments, t.samples, t.candidate]), full.takes.map((t) => [t.takeId, t.segments, t.samples, t.candidate]), name);
    assert.deepEqual(r.defaultTakes, full.defaultTakes, name);
  }
});

test('性質：採用の区間は、同じテイクの中で重ならない／採用と破棄は同じ範囲を二重に持たない', () => {
  for (const name of names) {
    const s = loadSession(name);
    const r = oracleReduce(s.events, s.rawFiles);
    const byRaw = new Map();
    for (const g of r.segments) {
      if (g.status === 'uncommitted') continue;
      if (!byRaw.has(g.raw)) byRaw.set(g.raw, []);
      byRaw.get(g.raw).push(g);
    }
    for (const [raw, list] of byRaw) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, `${name} ${raw}: segments overlap`);
    }
    // 長さ 0 の区間はない。segmentId は g00001 から連番
    r.segments.forEach((g, i) => {
      assert.ok(g.end > g.start, `${name}: empty segment ${g.segmentId}`);
      assert.equal(g.segmentId, 'g' + String(i + 1).padStart(5, '0'));
    });
  }
});

test('性質：撮り直しで捨てた範囲は、そのテイクの採用の区間と重ならない', () => {
  for (const name of names) {
    const s = loadSession(name);
    const r = oracleReduce(s.events, s.rawFiles);
    const kept = r.segments.filter((g) => g.status === 'kept');
    for (const d of r.segments.filter((g) => g.status === 'discarded')) {
      for (const k of kept) {
        if (k.raw !== d.raw) continue;
        assert.ok(k.end <= d.start || k.start >= d.end, `${name}: ${d.segmentId} overlaps ${k.segmentId}`);
      }
    }
  }
});

test('空の入力でも例外にならない', () => {
  const r = oracleReduce([], []);
  assert.deepEqual(r.segments, []);
  assert.deepEqual(r.takes, []);
  assert.deepEqual(r.defaultTakes, {});
  assert.equal(r.recoverable, null);
  const r2 = oracleReduce([{ seq: 0, eventId: 'e0', type: 'session-start', sessionId: 'abcdef', wall: 'x', mono: 0 }], []);
  assert.equal(r2.sessionId, 'abcdef');
});

test('見本の場面の数と index.json', () => {
  const idx = JSON.parse(readFileSync(join(SESSIONS_DIR, 'index.json'), 'utf8'));
  assert.deepEqual(idx.map((x) => x.name).sort(), names);
});

// ---- orphan-audio の規則（CONTRACTS.md 1.5、7 章）：手で導いた期待値 ----
{
  const RAW = [{ name: 'rec-000001', sampleRate: 48000, samples: 48000, durableSamples: 48000 }];
  const at = (s) => ({ raw: 'rec-000001', sample: s, pos: s });
  let n = 0;
  const E = (type, o = {}) => ({ seq: n, eventId: 'e' + n++, type, wall: 'w', mono: 0, ...o });
  const run = (list) => {
    n = 0;
    const evs = list.map((f) => f());
    return oracleReduce(evs, RAW).issues.map((i) => `${i.code}@${i.seq}`);
  };
  const head = [
    () => E('session-start', { sessionId: 'abcdef' }),
    () => E('rec-start', { slideId: 's0001', takeId: 't0001', at: at(0) }),
  ];
  const next = () => E('next-slide', { checkpointId: 'c0001', at: at(9600), nextSlideId: 's0002' });

  test('orphan-audio：次が位置を持たない goto-slide なら出さない', () => {
    assert.deepEqual(run([...head, next, () => E('goto-slide', { slideId: 's0003' })]), ['goto-while-recording@3']);
  });
  test('orphan-audio：イベントがもう無く recording が真なら出す（seq は next-slide）', () => {
    assert.deepEqual(run([...head, next]), ['orphan-audio@2']);
    assert.deepEqual(run([...head, next, () => E('durable', { at: at(12000) })]), ['orphan-audio@2']);
  });
  test('orphan-audio：次の pause の pos が大きければ出し、同じ pos なら出さない', () => {
    assert.deepEqual(run([...head, next, () => E('pause', { reason: 'user', at: at(12000) })]), ['orphan-audio@2']);
    assert.deepEqual(run([...head, next, () => E('pause', { reason: 'user', at: at(9600) })]), []);
  });
  test('orphan-audio：間にある durable は判定の対象にしない。取り消した next-slide は存在しない', () => {
    assert.deepEqual(run([...head, next, () => E('durable', { at: at(9700) }), () => E('rec-start', { slideId: 's0002', takeId: 't0002', at: at(9600) })]), []);
    assert.deepEqual(run([...head, next, () => E('undo', { target: 'e2' }), () => E('durable', { at: at(12000) })]), []);
  });
}

// ---- 不正なイベント（CONTRACTS.md 7.7 の 7）と、未来を指す undo：手で導いた期待値 ----
{
  const RAW = [{ name: 'rec-000001', sampleRate: 48000, samples: 48000, durableSamples: 48000 }];
  const at = (s) => ({ raw: 'rec-000001', sample: s, pos: s });
  const base = () => [
    { seq: 0, eventId: 'e0', type: 'session-start', sessionId: 'abcdef', wall: 'w', mono: 0 },
    { seq: 1, eventId: 'e1', type: 'rec-start', slideId: 's0001', takeId: 't0001', at: at(0), wall: 'w', mono: 1 },
    { seq: 2, eventId: 'e2', type: 'ok', checkpointId: 'c0001', at: at(1000), wall: 'w', mono: 2 },
  ];
  test('不正なイベント：seq が整数でないものは bad-event で無視する（課題の seq は並びの番号）', () => {
    const evs = base();
    evs.push({ seq: 2.5, eventId: 'e2.5', type: 'ok', checkpointId: 'c0002', at: at(2000), wall: 'w', mono: 3 });
    const r = oracleReduce(evs, RAW);
    assert.deepEqual(r.issues.map((i) => `${i.code}@${i.seq}`), ['bad-event@3']);
    assert.deepEqual(r.segments.map((g) => [g.start, g.end]), [[0, 1000]]);
  });
  test('不正なイベント：retake の toCheckpoint が明示的な null のときだけテイクの最初まで戻る', () => {
    const withNull = [...base(), { seq: 3, eventId: 'e3', type: 'retake', toCheckpoint: null, at: at(2000), wall: 'w', mono: 3 }];
    const r1 = oracleReduce(withNull, RAW);
    assert.deepEqual(r1.issues, []);
    assert.equal(r1.segments[0].status, 'discarded');
    const noKey = [...base(), { seq: 3, eventId: 'e3', type: 'retake', at: at(2000), wall: 'w', mono: 3 }];
    const r2 = oracleReduce(noKey, RAW);
    assert.deepEqual(r2.issues.map((i) => `${i.code}@${i.seq}`), ['bad-event@3']);
    assert.equal(r2.segments[0].status, 'kept');
  });
  test('不正なイベントは取り消しの対象にならない／欠番にも数えない', () => {
    const evs = [...base(), { seq: 3, eventId: 'e9', type: 'mark', at: at(1500), wall: 'w', mono: 3 }, { seq: 4, eventId: 'e4', type: 'undo', target: 'e9', wall: 'w', mono: 4 }];
    const r = oracleReduce(evs, RAW);
    assert.deepEqual(r.issues.map((i) => `${i.code}@${i.seq}`).sort(), ['bad-event@3', 'bad-undo-target@4']);
  });
  test('undo／redo：自分自身を指す、未来を指す → bad-undo-target。過去の mark は取り消せる', () => {
    const evs = [
      ...base(),
      { seq: 3, eventId: 'e3', type: 'undo', target: 'e3', wall: 'w', mono: 3 },
      { seq: 4, eventId: 'e4', type: 'mark', at: at(1200), wall: 'w', mono: 4 },
      { seq: 5, eventId: 'e5', type: 'undo', target: 'e4', wall: 'w', mono: 5 },
      { seq: 6, eventId: 'e6', type: 'redo', target: 'e7', wall: 'w', mono: 6 },
      { seq: 7, eventId: 'e7', type: 'mark', at: at(1300), wall: 'w', mono: 7 },
    ];
    const r = oracleReduce(evs, RAW);
    assert.deepEqual(r.issues.map((i) => `${i.code}@${i.seq}`), ['bad-undo-target@3', 'bad-undo-target@6']);
    assert.deepEqual(r.marks.map((m) => m.seq), [7]);
  });
}

test('schema/*.json が使うキーワードは、testgen の検査器（mini-schema）が扱うものだけ（見本の検査が抜けていない）', () => {
  const supported = new Set(['$schema', '$id', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'oneOf']);
  for (const f of ['script', 'segments', 'manifest', 'edits', 'events', 'index', 'timeline', 'cli-result']) {
    const walk = (node, inProps) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, false));
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (inProps) walk(v, false); // properties の下は、項目名なので検査しない
        else {
          assert.ok(supported.has(k), `${f}: unsupported keyword ${k}`);
          if (k === 'properties') for (const pv of Object.values(v)) walk(pv, false);
          else if (k !== 'enum' && k !== 'const') walk(v, false);
        }
      }
    };
    walk(schema(f), false);
  }
});
