import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveVolume, receiveIndex, commitIfComplete, ImportError } from '../../core/importer.js';
import { sha256Hex } from '../../core/sha256.js';
import { parseJsonl } from '../../core/json.js';
import { createMemStore, snapshot } from './helpers/memstore.js';
import { makeSession, exportFull, exportFinal, asVolume, zipOf, json } from './helpers/exports.js';
import { sampleScript } from './helpers/samples.js';

const NOW = () => '2026-11-16T09:00:00.000Z';
const recv = (store, z) => receiveVolume(store, asVolume(z), { now: NOW });
const dec = new TextDecoder();

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => { for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

/** items: [{exportId, z}] を順に取り込み、そのたびに commitIfComplete を呼ぶ */
async function importAll(store, items) {
  const committed = [];
  for (const { z, exportId } of items) {
    await recv(store, z);
    const r = await commitIfComplete(store, exportId);
    if (r.committed) committed.push(exportId);
  }
  return committed;
}

test('全記録（1 巻）を取り込む：中身がそのまま sessions/ に入り、staging は消える', async () => {
  const session = makeSession();
  const full = await exportFull(session);
  const store = createMemStore();
  const r = await recv(store, full.zips[0]);
  assert.deepEqual(r, { status: 'received', exportId: 'exp-full-01', volume: 1, volumes: 1 });
  assert.ok((await store.list('staging/exp-full-01/v001/')).length >= 7);
  const c = await commitIfComplete(store, 'exp-full-01');
  assert.deepEqual(c, { committed: true, sessionId: 'sess-0001', missing: [] });
  assert.deepEqual(await store.list('staging/'), []);
  const files = (await store.list('sessions/sess-0001/')).map((p) => p.slice('sessions/sess-0001/'.length));
  assert.deepEqual(files, ['edits.json', 'events.jsonl', 'raw/rec-000001.wav', 'raw/rec-000002.wav', 'script.json', 'segments.json', 'session.json']);
  // 中身は書き出したとおり
  assert.equal(store.files.get('sessions/sess-0001/raw/rec-000001.wav').length, 44 + 30000 * 2);
  assert.equal(parseJsonl(dec.decode(store.files.get('sessions/sess-0001/events.jsonl'))).length, session.events.length);
  const s = await store.readJson('sessions/sess-0001/session.json');
  assert.equal(s.format, 'lap-narrator/session');
  assert.equal(s.sessionId, 'sess-0001');
  assert.deepEqual(s.exports.map((e) => [e.exportId, e.kind, e.volumes, e.editVersion]), [['exp-full-01', 'full', 1, 1]]);
  assert.deepEqual(s.rawFiles.map((r2) => [r2.file, r2.samples]), [['rec-000001', 30000], ['rec-000002', 20000]]);
  assert.equal(s.events.count, session.events.length);
  assert.equal(s.edits.editVersion, 1);
  assert.deepEqual(s.variants, {});
  assert.equal(s.staleSlides, null);
  // receipts
  const receipts = await store.readJson('receipts.json');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].zipSha256, full.zips[0].sha256);
  assert.equal(receipts[0].receivedAt, '2026-11-16T09:00:00.000Z');
});

test('同じ zip の二重：何もしない（duplicate）。統合のあとでも', async () => {
  const full = await exportFull(makeSession());
  const store = createMemStore();
  await recv(store, full.zips[0]);
  const before = snapshot(store, '');
  assert.equal((await recv(store, full.zips[0])).status, 'duplicate');
  assert.deepEqual(snapshot(store, ''), before);
  await commitIfComplete(store, 'exp-full-01');
  const after = snapshot(store, '');
  assert.equal((await recv(store, full.zips[0])).status, 'duplicate');
  assert.deepEqual(snapshot(store, ''), after);
  // 二度目の commitIfComplete も何も変えない
  assert.deepEqual(await commitIfComplete(store, 'exp-full-01'), { committed: true, sessionId: 'sess-0001', missing: [] });
  assert.deepEqual(snapshot(store, ''), after);
});

test('巻が欠けている：待つ（missing）。届いた順は問わず、そろえば統合される', async () => {
  const full = await exportFull(makeSession(), { volumeMaxBytes: 50000 });
  assert.equal(full.zips.length, 3);
  const store = createMemStore();
  await recv(store, full.zips[2]);
  assert.deepEqual(await commitIfComplete(store, 'exp-full-01'), { committed: false, missing: [1, 2] });
  await recv(store, full.zips[0]);
  assert.deepEqual(await commitIfComplete(store, 'exp-full-01'), { committed: false, missing: [2] });
  assert.equal(await store.exists('sessions/sess-0001/session.json'), false);
  await recv(store, full.zips[1]);
  assert.deepEqual(await commitIfComplete(store, 'exp-full-01'), { committed: true, sessionId: 'sess-0001', missing: [] });
  assert.deepEqual(await commitIfComplete(store, 'no-such-export'), { committed: false, missing: [] });
});

test('巻の順不同・再送・二重：どの順でも sessions/ の状態は同じ（全記録 3 巻のすべての並べ替え、再送つき）', async () => {
  const full = await exportFull(makeSession(), { volumeMaxBytes: 50000 });
  let baseline = null;
  for (const perm of permutations([0, 1, 2])) {
    for (const resend of [false, true]) {
      const store = createMemStore();
      const items = perm.map((i) => ({ z: full.zips[i], exportId: 'exp-full-01' }));
      if (resend) items.splice(1, 0, items[0], items[0]); // 再送と二重
      await importAll(store, items);
      const snap = snapshot(store, 'sessions/');
      if (baseline === null) baseline = snap; else assert.deepEqual(snap, baseline, `perm=${perm} resend=${resend}`);
      assert.deepEqual(await store.list('staging/'), []);
    }
  }
  assert.ok(Object.keys(baseline).length >= 7);
});

test('完成版と全記録を逆の順に取り込む：sessions/ の状態は同じ。編集の版が同じ完成版は verify-only', async () => {
  const session = makeSession();
  const full = await exportFull(session, { volumeMaxBytes: 50000, editVersion: 1 });
  const fin = await exportFinal(session, { editVersion: 1 });
  const finParts = await exportFinal(session, { exportId: 'exp-final-02', editVersion: 2, partMaxBytes: 20000, volumeMaxBytes: 30000 });
  assert.ok(finParts.finals.some((f) => f.parts.length > 1), '分割した音声を含む');
  const items = [
    ...full.zips.map((z) => ({ z, exportId: full.exportId })),
    ...fin.zips.map((z) => ({ z, exportId: fin.exportId })),
    ...finParts.zips.map((z) => ({ z, exportId: finParts.exportId })),
  ];
  assert.ok(items.length >= 5);
  const orders = [
    items.map((_, i) => i),
    [...items.map((_, i) => i)].reverse(),
    [3, 0, 4, 1, 5, 2, ...items.map((_, i) => i).filter((i) => i > 5)],
  ];
  let baseline = null;
  for (const order of orders) {
    const store = createMemStore();
    const seq = order.filter((i, k) => order.indexOf(i) === k && i < items.length).map((i) => items[i]);
    const committed = await importAll(store, seq);
    assert.deepEqual([...committed].sort(), ['exp-final-01', 'exp-final-02', 'exp-full-01']);
    const snap = snapshot(store, 'sessions/');
    if (baseline === null) baseline = snap; else assert.deepEqual(snap, baseline, `order=${order}`);
    const s = await store.readJson('sessions/sess-0001/session.json');
    assert.deepEqual(s.finals.map((f) => [f.exportId, f.role]), [['exp-final-01', 'verify-only'], ['exp-final-02', 'candidate']]);
    assert.deepEqual(s.exports.map((e) => e.exportId), ['exp-final-01', 'exp-final-02', 'exp-full-01']);
    // 完成版の音声が残っている（分割した部分も）
    const f2 = s.finals[1].slides.find((x) => x.parts.length > 1);
    assert.ok(f2);
    for (const p of f2.parts) {
      const bytes = store.files.get(`sessions/sess-0001/finals/exp-final-02/${p.file}`);
      assert.equal(sha256Hex(bytes), p.sha256);
    }
    assert.deepEqual(await store.list('staging/'), []);
  }
});

test('完成版だけを取り込んだ場合は、すべて候補（candidate）。あとから全記録が来ると、同じ版が verify-only になる', async () => {
  const session = makeSession();
  const fin = await exportFinal(session, { editVersion: 1 });
  const full = await exportFull(session, { editVersion: 1 });
  const store = createMemStore();
  await importAll(store, fin.zips.map((z) => ({ z, exportId: fin.exportId })));
  let s = await store.readJson('sessions/sess-0001/session.json');
  assert.deepEqual(s.finals.map((f) => f.role), ['candidate']);
  assert.equal(s.edits, null);
  assert.equal(await store.exists('sessions/sess-0001/events.jsonl'), false);
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  s = await store.readJson('sessions/sess-0001/session.json');
  assert.deepEqual(s.finals.map((f) => f.role), ['verify-only']);
  assert.ok(await store.exists('sessions/sess-0001/events.jsonl')); // 履歴と録音ファイルが補われた
  assert.ok(await store.exists('sessions/sess-0001/raw/rec-000001.wav'));
});

test('同じセッションの、行数が多い（あとの）全記録が勝つ。どの順でも同じ。負けた版は variants に残る', async () => {
  const early = makeSession();
  const later = makeSession({ extraTail: true });
  const a = await exportFull(early, { exportId: 'exp-aaaa-01', editVersion: 1, createdAt: '2026-11-16T07:00:00.000Z' });
  const b = await exportFull(later, { exportId: 'exp-bbbb-01', editVersion: 2, createdAt: '2026-11-16T08:00:00.000Z' });
  const snaps = [];
  for (const order of [[a, b], [b, a]]) {
    const store = createMemStore();
    for (const x of order) await importAll(store, x.zips.map((z) => ({ z, exportId: x.exportId })));
    snaps.push(snapshot(store, 'sessions/'));
    const s = await store.readJson('sessions/sess-0001/session.json');
    assert.equal(s.events.count, later.events.length);
    assert.equal(s.edits.editVersion, 2);
    assert.equal(s.variants.events.length, 2);
    assert.equal(s.variants.edits.length, 2);
    assert.equal(parseJsonl(dec.decode(store.files.get('sessions/sess-0001/events.jsonl'))).length, later.events.length);
  }
  assert.deepEqual(snaps[0], snaps[1]);
});

test('同じ名前で中身の違う録音ファイル：サンプル数が多い方が勝つ（順によらない）', async () => {
  const s1 = makeSession({ seed: 1 });
  const s2 = makeSession({ seed: 2, rawSamples: [30000, 20000] }); // 同じ長さで中身が違う → SHA-256 の小さい方
  const s3 = makeSession({ seed: 3, rawSamples: [30000, 25000] });
  const exps = [
    await exportFull(s1, { exportId: 'exp-0000-01' }),
    await exportFull(s2, { exportId: 'exp-0000-02' }),
    await exportFull(s3, { exportId: 'exp-0000-03' }),
  ];
  let baseline = null;
  for (const perm of permutations([0, 1, 2])) {
    const store = createMemStore();
    for (const i of perm) await importAll(store, exps[i].zips.map((z) => ({ z, exportId: exps[i].exportId })));
    const snap = snapshot(store, 'sessions/');
    if (baseline === null) baseline = snap; else assert.deepEqual(snap, baseline, `perm=${perm}`);
    const s = await store.readJson('sessions/sess-0001/session.json');
    assert.equal(s.rawFiles.find((r) => r.file === 'rec-000002').samples, 25000);
    assert.equal(s.variants.raw['rec-000001'].length, 3);
  }
});

test('ハッシュの不一致：manifest の SHA-256 と中身が合わない巻は bad-volume で拒否し、何も残さない', async () => {
  const session = makeSession();
  const good = await exportFull(session);
  // manifest の SHA-256 をわざと間違える（CRC は正しい）
  const files = [
    ['README.txt', new TextEncoder().encode('x')],
    ['script.json', json(session.script)],
  ];
  const manifest = {
    format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: 'proj-001', scriptHash: session.script.scriptHash,
    sessionId: 'sess-0001', exportId: 'exp-bad-01', volume: 1, volumes: 1, appVersion: '0.0.0',
    files: [{ path: 'README.txt', bytes: 1, sha256: sha256Hex(files[0][1]) }, { path: 'script.json', bytes: files[1][1].length, sha256: '0'.repeat(64) }],
    createdAt: '2026-11-16T07:50:00.000Z',
  };
  const bytes = await zipOf([...files, ['manifest.json', json(manifest)]]);
  const store = createMemStore();
  await assert.rejects(receiveVolume(store, { name: 'bad.zip', size: bytes.length, read: async (s, e) => bytes.slice(s, e) }), (e) => e instanceof ImportError && e.code === 'bad-volume' && /SHA-256/.test(e.message));
  assert.deepEqual([...store.files.keys()], []);
  // 大きさの不一致
  manifest.files[1].sha256 = sha256Hex(files[1][1]);
  manifest.files[1].bytes += 1;
  const bytes2 = await zipOf([...files, ['manifest.json', json(manifest)]]);
  await assert.rejects(receiveVolume(store, { name: 'bad2.zip', size: bytes2.length, read: async (s, e) => bytes2.slice(s, e) }), { code: 'bad-volume' });
  assert.deepEqual([...store.files.keys()], []);
  // 正しい巻は入る
  assert.equal((await recv(store, good.zips[0])).status, 'received');
});

test('壊れた巻：ZIP でない、途中で切れた、manifest が無い／壊れている、列挙されていないファイル、危険な名前', async () => {
  const session = makeSession();
  const good = await exportFull(session);
  const store = createMemStore();
  const vol = (bytes) => ({ name: 'x.zip', size: bytes.length, read: async (s, e) => bytes.slice(s, e) });
  const reject = async (bytes, re) => {
    await assert.rejects(receiveVolume(store, vol(bytes)), (e) => e instanceof ImportError && e.code === 'bad-volume' && (!re || re.test(e.message)), String(re));
    assert.deepEqual([...store.files.keys()], [], String(re));
  };
  await reject(new Uint8Array(0), /ZIP/);
  await reject(new TextEncoder().encode('this is not a zip file at all, just text'), /ZIP/);
  await reject(good.zips[0].bytes.slice(0, good.zips[0].bytes.length - 30), /ZIP/);
  await reject(await zipOf([['a.txt', new TextEncoder().encode('x')]]), /manifest\.json is missing/);
  await reject(await zipOf([['manifest.json', new TextEncoder().encode('{not json')]]), /manifest\.json is not readable/);
  await reject(await zipOf([['manifest.json', json({ format: 'lap-narrator/manifest' })]]), /invalid/);
  // 列挙されていないファイル
  const m = { format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: 'proj-001', scriptHash: 'a'.repeat(64), sessionId: 'sess-0001', exportId: 'exp-bad-02', volume: 1, volumes: 1, appVersion: '0', files: [], createdAt: 'x' };
  await reject(await zipOf([['extra.txt', new TextEncoder().encode('x')], ['manifest.json', json(m)]]), /not listed/);
  // 列挙されているのに無い
  await reject(await zipOf([['manifest.json', json({ ...m, files: [{ path: 'gone.txt', bytes: 1, sha256: 'a'.repeat(64) }] })]]), /missing from the ZIP/);
  // 危険な名前（zip-slip）
  for (const name of ['../evil.txt', '/abs.txt', 'a/../../b.txt', 'C:/x.txt', 'a\\b.txt']) {
    const data = new TextEncoder().encode('x');
    const mm = { ...m, files: [{ path: name, bytes: 1, sha256: sha256Hex(data) }] };
    await reject(await zipOf([[name, data], ['manifest.json', json(mm)]]), /unsafe|bad path/);
  }
  assert.deepEqual([...store.files.keys()], []);
});

test('同じ (exportId, 巻) で中身が違う zip は conflicting-volume。最初のものは残る', async () => {
  const session = makeSession();
  const a = await exportFull(session, { exportId: 'exp-same-01', createdAt: '2026-11-16T07:50:00.000Z' });
  const b = await exportFull(session, { exportId: 'exp-same-01', createdAt: '2026-11-16T07:51:00.000Z' });
  assert.notEqual(a.zips[0].sha256, b.zips[0].sha256);
  const store = createMemStore();
  await recv(store, a.zips[0]);
  const before = snapshot(store, '');
  await assert.rejects(recv(store, b.zips[0]), (e) => e instanceof ImportError && e.code === 'conflicting-volume');
  assert.deepEqual(snapshot(store, ''), before);
  assert.deepEqual(await commitIfComplete(store, 'exp-same-01'), { committed: true, sessionId: 'sess-0001', missing: [] });
});

test('同じ書き出しの巻どうしで項目が食い違う巻は拒否（別のセッションの巻が混ざった場合）', async () => {
  const a = await exportFull(makeSession({ sessionId: 'sess-0001' }), { exportId: 'exp-mix-01', volumeMaxBytes: 50000 });
  const b = await exportFull(makeSession({ sessionId: 'sess-0002' }), { exportId: 'exp-mix-01', volumeMaxBytes: 50000 });
  const store = createMemStore();
  await recv(store, a.zips[0]);
  await assert.rejects(recv(store, b.zips[1]), (e) => e.code === 'bad-volume' && /sessionId/.test(e.message));
});

test('索引 <exportId>_index.json：合えば取り込め、合わなければ拒否。先でも後でもよい', async () => {
  const full = await exportFull(makeSession(), { volumeMaxBytes: 50000 });
  // 索引が先に届く
  let store = createMemStore();
  assert.equal((await receiveIndex(store, full.index)).status, 'stored');
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  assert.ok(await store.exists('sessions/sess-0001/session.json'));
  assert.equal((await receiveIndex(store, full.index)).status, 'ignored'); // 統合済み
  // 索引が後
  store = createMemStore();
  for (const z of full.zips) await recv(store, z);
  assert.equal((await receiveIndex(store, full.index)).status, 'stored');
  assert.equal((await commitIfComplete(store, full.exportId)).committed, true);
  // 索引の SHA-256 が違う：先に届いた索引と巻が合わない
  const wrong = JSON.parse(JSON.stringify(full.index));
  wrong.zips[1].sha256 = 'f'.repeat(64);
  store = createMemStore();
  await receiveIndex(store, wrong);
  await recv(store, full.zips[0]);
  await assert.rejects(recv(store, full.zips[1]), (e) => e.code === 'bad-volume' && /index/.test(e.message));
  assert.ok(!(await store.exists('staging/exp-full-01/v002/manifest.json')));
  // 巻が先で、あとから合わない索引
  store = createMemStore();
  for (const z of full.zips) await recv(store, z);
  await assert.rejects(receiveIndex(store, wrong), (e) => e instanceof ImportError && e.code === 'index-mismatch');
  assert.equal((await commitIfComplete(store, full.exportId)).committed, true); // 索引は置かれていないので統合できる
  // 索引そのものが不正
  await assert.rejects(receiveIndex(createMemStore(), { format: 'x' }), { code: 'index-mismatch' });
});

test('必要なファイルが無い全記録（events.jsonl が無い）は統合せず inconsistent-export', async () => {
  const session = makeSession();
  const script = session.script;
  const files = [['script.json', json(script)], ['edits.json', json({ editVersion: 1 })], ['segments.json', json({})]];
  const manifest = {
    format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: script.projectId, scriptHash: script.scriptHash,
    sessionId: 'sess-0001', exportId: 'exp-lack-01', volume: 1, volumes: 1, appVersion: '0',
    files: files.map(([p, d]) => ({ path: p, bytes: d.length, sha256: sha256Hex(d) })), createdAt: 'x',
  };
  const bytes = await zipOf([...files, ['manifest.json', json(manifest)]]);
  const store = createMemStore();
  await receiveVolume(store, { name: 'x', size: bytes.length, read: async (s, e) => bytes.slice(s, e) });
  await assert.rejects(commitIfComplete(store, 'exp-lack-01'), (e) => e instanceof ImportError && e.code === 'inconsistent-export' && /events\.jsonl/.test(e.message));
  assert.equal(await store.exists('sessions/sess-0001/session.json'), false);
});

test('作業場の台本があり、scriptHash が違えば staleSlides を記録する（textHash が違うスライド）', async () => {
  const session = makeSession();
  const full = await exportFull(session);
  const changed = sampleScript();
  changed.slides[2].text = '書き換えた文';
  const { textHash, scriptHash } = await import('../../core/script.js');
  changed.slides[2].textHash = textHash(changed.slides[2]);
  changed.scriptHash = scriptHash(changed.slides);
  assert.notEqual(changed.scriptHash, session.script.scriptHash);
  let store = createMemStore();
  await store.writeJson('script.json', changed);
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  let s = await store.readJson('sessions/sess-0001/session.json');
  assert.deepEqual(s.staleSlides, ['s258']);
  // 同じ台本なら空
  store = createMemStore();
  await store.writeJson('script.json', session.script);
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  s = await store.readJson('sessions/sess-0001/session.json');
  assert.deepEqual(s.staleSlides, []);
});

test('別のセッションの書き出しは別の sessions/<id>/ に入る。複数セッションの取り込みの順も結果に影響しない', async () => {
  const sa = makeSession({ sessionId: 'sess-aaaa' });
  const sb = makeSession({ sessionId: 'sess-bbbb', seed: 9 });
  const fa = await exportFull(sa, { exportId: 'exp-a-0001', volumeMaxBytes: 50000 });
  const fb = await exportFull(sb, { exportId: 'exp-b-0001', volumeMaxBytes: 50000 });
  const all = [...fa.zips.map((z) => ({ z, exportId: fa.exportId })), ...fb.zips.map((z) => ({ z, exportId: fb.exportId }))];
  let baseline = null;
  for (const order of [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [3, 0, 4, 1, 5, 2]]) {
    const store = createMemStore();
    await importAll(store, order.map((i) => all[i]));
    const snap = snapshot(store, 'sessions/');
    if (baseline === null) baseline = snap; else assert.deepEqual(snap, baseline);
  }
  assert.ok(Object.keys(baseline).some((k) => k.startsWith('sessions/sess-aaaa/')));
  assert.ok(Object.keys(baseline).some((k) => k.startsWith('sessions/sess-bbbb/')));
});

test('session.json は挿入順によらず同じバイト列（キーが辞書順）', async () => {
  const full = await exportFull(makeSession());
  const store = createMemStore();
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  const text = dec.decode(store.files.get('sessions/sess-0001/session.json'));
  const parsed = JSON.parse(text);
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort());
});

test('取り込んだ録音ファイルは、書き出した WAV と同じバイト列', async () => {
  const session = makeSession();
  const full = await exportFull(session, { volumeMaxBytes: 50000 });
  const store = createMemStore();
  await importAll(store, full.zips.map((z) => ({ z, exportId: full.exportId })));
  const { wavFile } = await import('./helpers/exports.js');
  for (const r of session.raws) {
    assert.deepEqual(store.files.get(`sessions/sess-0001/raw/${r.name}.wav`), wavFile(session.rawData[r.name], r.sampleRate));
  }
});

test('完成版の編集の版：manifest.editVersion を読む。無ければ renderSpec.editVersion（古い書き出し）。どちらも同じ結果', async () => {
  const session = makeSession();
  const full = await exportFull(session, { editVersion: 3 });
  const roles = [];
  for (const legacy of [false, true]) {
    const fin = await exportFinal(session, { editVersion: 3, legacyEditVersion: legacy });
    const m = JSON.parse(new TextDecoder().decode((await (async () => {
      const { readZipDirectory, readZipEntry } = await import('../../core/zip.js');
      const z = fin.zips[0].bytes;
      const rd = async (s, e) => z.slice(s, e);
      const dir = await readZipDirectory(rd, z.length);
      const chunks = [];
      for await (const c of readZipEntry(rd, dir.find((x) => x.name === 'manifest.json'))) chunks.push(c);
      return chunks[0];
    })())));
    assert.equal(legacy ? m.editVersion : m.editVersion, legacy ? undefined : 3);
    const store = createMemStore();
    await importAll(store, [...full.zips.map((z) => ({ z, exportId: full.exportId })), ...fin.zips.map((z) => ({ z, exportId: fin.exportId }))]);
    const s = await store.readJson('sessions/sess-0001/session.json');
    assert.equal(s.finals[0].editVersion, 3);
    roles.push(s.finals[0].role);
  }
  assert.deepEqual(roles, ['verify-only', 'verify-only']);
});
