import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { textHash, scriptHash, checkScript } from '../../core/script.js';
import { canonicalJson } from '../../core/json.js';
import { sampleScript } from './helpers/samples.js';
import { runPython, hasPython } from './helpers/python.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('textHash：sha256(utf8(canonicalJson({slideId, text, recordable}))) を node:crypto で独立に計算した値と一致', () => {
  const slide = { slideId: 's256', text: 'これは見本の文です。', recordable: true };
  assert.equal(textHash(slide), sha('{"recordable":true,"slideId":"s256","text":"これは見本の文です。"}'));
  // 余計な項目（題名、担当、画像）はハッシュに影響しない
  assert.equal(textHash({ ...slide, title: 'x', speaker: 'y', image: 'z', order: 9, targetSec: 3 }), textHash(slide));
});

test('textHash：slideId、text、recordable のどれが変わっても変わる', () => {
  const base = { slideId: 's1', text: 'a', recordable: true };
  const h = textHash(base);
  assert.notEqual(textHash({ ...base, slideId: 's2' }), h);
  assert.notEqual(textHash({ ...base, text: 'a ' }), h);
  assert.notEqual(textHash({ ...base, recordable: false }), h);
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('textHash：型が違えば TypeError', () => {
  assert.throws(() => textHash({ slideId: 's1', text: 'a', recordable: 'true' }), TypeError);
  assert.throws(() => textHash({ slideId: 1, text: 'a', recordable: true }), TypeError);
  assert.throws(() => textHash({ slideId: 's', text: null, recordable: true }), TypeError);
  assert.throws(() => textHash(null), TypeError);
});

test('textHash：改行や引用符を含む文でも Python の json.dumps(sort_keys) から独立に計算した値と一致', { skip: !hasPython }, () => {
  const slides = [
    { slideId: 's1', text: 'Second "quoted" text\nwith newline.\t\u0001', recordable: false },
    { slideId: 's256', text: '日本語\\と/スラッシュ', recordable: true },
  ];
  const r = runPython(
    'import sys,json,hashlib\nfor s in json.loads(sys.stdin.buffer.read().decode("utf-8")):\n    j=json.dumps(s,sort_keys=True,ensure_ascii=False,separators=(",",":"))\n    print(hashlib.sha256(j.encode("utf-8")).hexdigest())',
    [], JSON.stringify(slides),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(slides.map(textHash), r.stdout.trim().split(/\r?\n/));
});

test('scriptHash：order の昇順に textHash を "\\n" でつないだ文字列の SHA-256（全スライドを含む）', () => {
  const script = sampleScript();
  const byOrder = [...script.slides].sort((a, b) => a.order - b.order).map((s) => s.textHash).join('\n');
  assert.equal(script.scriptHash, sha(byOrder));
  assert.equal(scriptHash(script.slides), sha(byOrder));
});

test('scriptHash：渡す順番によらない（order で並べる）。題名・担当・秒数・絵は影響しない', () => {
  const s = sampleScript();
  const shuffled = [s.slides[2], s.slides[0], s.slides[1]];
  assert.equal(scriptHash(shuffled), scriptHash(s.slides));
  const edited = s.slides.map((x) => ({ ...x, title: 'changed', speaker: 'z', targetSec: 99, image: 'other.png', imageSha256: 'f'.repeat(64) }));
  assert.equal(scriptHash(edited), scriptHash(s.slides));
});

test('scriptHash：文が 1 つ変わると変わる。textHash が無いスライドは中身から求める', () => {
  const s = sampleScript();
  const h = scriptHash(s.slides);
  const changed = s.slides.map((x, i) => (i === 2 ? { ...x, text: x.text + '!', textHash: undefined } : x));
  assert.notEqual(scriptHash(changed), h);
  const noHash = s.slides.map((x) => ({ slideId: x.slideId, order: x.order, text: x.text, recordable: x.recordable }));
  assert.equal(scriptHash(noHash), h);
});

test('scriptHash：0 件は空文字列の SHA-256、1 件は区切りなし', () => {
  assert.equal(scriptHash([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const one = [{ order: 1, textHash: 'a'.repeat(64) }];
  assert.equal(scriptHash(one), sha('a'.repeat(64)));
  assert.throws(() => scriptHash(null), TypeError);
});

test('checkScript：正しい台本は ok', () => {
  assert.deepEqual(checkScript(sampleScript()), { ok: true, errors: [] });
});

test('checkScript：textHash が違う、scriptHash が違う、スキーマ違反、重複を報告', () => {
  let s = sampleScript();
  s.slides[1].textHash = '0'.repeat(64);
  let r = checkScript(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('/slides/1/textHash')));

  s = sampleScript();
  s.scriptHash = '1'.repeat(64);
  r = checkScript(s);
  assert.ok(r.errors.some((e) => e.startsWith('/scriptHash')));

  s = sampleScript();
  s.slides[0].text = '書き換えた文'; // textHash を更新しない
  r = checkScript(s);
  assert.ok(r.errors.some((e) => e.startsWith('/slides/0/textHash')));

  s = sampleScript();
  s.slides[2].slideId = 's256';
  r = checkScript(s);
  assert.ok(r.errors.some((e) => e.includes('duplicate slideId')));

  s = sampleScript();
  s.slides[2].order = 1;
  r = checkScript(s);
  assert.ok(r.errors.some((e) => e.includes('duplicate order')));

  s = sampleScript();
  delete s.projectId;
  r = checkScript(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('projectId')));
});

test('checkScript：台本でない入力でも例外にしない', () => {
  for (const v of [null, undefined, 5, 'x', [], {}, { slides: 'x' }, { slides: [null, 5] }]) {
    const r = checkScript(v);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});

test('canonicalJson を通した台本の往復でハッシュが変わらない（キー順の違い）', () => {
  const s = sampleScript();
  const reordered = JSON.parse(canonicalJson(s));
  assert.deepEqual(checkScript(reordered), { ok: true, errors: [] });
});
