import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseJsonl, stringifyJsonl } from '../../core/json.js';
import { runPython, hasPython } from './helpers/python.js';

test('canonicalJson: キーは辞書順、空白なし', () => {
  assert.equal(canonicalJson({ b: 1, a: 2, c: [3, { z: 1, y: 2 }] }), '{"a":2,"b":1,"c":[3,{"y":2,"z":1}]}');
});

test('canonicalJson: 順序の違う同じ内容は同じ文字列', () => {
  assert.equal(canonicalJson({ x: 1, y: { q: 1, p: 2 } }), canonicalJson({ y: { p: 2, q: 1 }, x: 1 }));
});

test('canonicalJson: 日本語はそのまま、制御文字と " と \\ だけエスケープ', () => {
  assert.equal(canonicalJson('日本語"\\\n\t\u0001\u001f'), '"日本語\\"\\\\\\n\\t\\u0001\\u001f"');
  assert.equal(canonicalJson('\u007f/'), '"\u007f/"');
});

test('canonicalJson: undefined のキーは出さない、配列の undefined は null', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([1, undefined]), '[1,null]');
});

test('canonicalJson: 数の書き方は JSON.stringify と同じ', () => {
  for (const n of [0, -0, 1, -1.5, 1e21, 1e-7, 123456789012345, 0.1 + 0.2, 2 ** 53]) {
    assert.equal(canonicalJson(n), JSON.stringify(n));
  }
  assert.equal(canonicalJson(-0), '0');
});

test('canonicalJson: NaN、無限大、BigInt、循環、関数はエラー', () => {
  assert.throws(() => canonicalJson(NaN), TypeError);
  assert.throws(() => canonicalJson({ a: Infinity }), TypeError);
  assert.throws(() => canonicalJson([-Infinity]), TypeError);
  assert.throws(() => canonicalJson(10n), TypeError);
  assert.throws(() => canonicalJson(() => 1), TypeError);
  assert.throws(() => canonicalJson(undefined), TypeError);
  const a = {}; a.self = a;
  assert.throws(() => canonicalJson(a), TypeError);
  assert.throws(() => canonicalJson(new Map()), TypeError);
  assert.throws(() => canonicalJson(new Uint8Array(2)), TypeError);
});

test('canonicalJson: キーの順は UTF-16 のコード単位順（サロゲートは U+FF00 より前）', () => {
  const astral = '\u{1F600}'; // 先頭のコード単位 0xD83D
  const fullwidth = 'Ａ';  // 0xFF21
  assert.equal(canonicalJson({ [fullwidth]: 1, [astral]: 2 }), `{"${astral}":2,"${fullwidth}":1}`);
});

test('canonicalJson: toJSON を使う（Date）、共有された（循環でない）参照は可', () => {
  assert.equal(canonicalJson({ d: new Date(Date.UTC(2026, 10, 16)) }), '{"d":"2026-11-16T00:00:00.000Z"}');
  const shared = { k: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
});

test('canonicalJson: 既知のハッシュ入力（スライドの文の形）', () => {
  assert.equal(
    canonicalJson({ slideId: 's256', text: 'こんにちは', recordable: true }),
    '{"recordable":true,"slideId":"s256","text":"こんにちは"}',
  );
});

test('canonicalJson: Python の json.dumps(sort_keys) と一致（BMP のみの乱数入力）', { skip: !hasPython }, () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const strs = ['', 'a', 'あいう', 'x"y', 'a\\b', 'line\nbreak', '\u0000\u0001\u001f\u007f', 'éあＡ', '/slash'];
  const gen = (depth) => {
    const t = rnd() % (depth > 3 ? 5 : 8);
    if (t === 0) return null;
    if (t === 1) return rnd() % 2 === 0;
    if (t === 2) return (rnd() % 20001) - 10000;
    if (t === 3) return ((rnd() % 100000) - 50000) / 8; // 2 進で正確な小数
    if (t === 4) return strs[rnd() % strs.length];
    if (t === 5 || t === 6) { const n = rnd() % 4; return Array.from({ length: n }, () => gen(depth + 1)); }
    const o = {}; const n = rnd() % 5;
    for (let i = 0; i < n; i++) o[strs[rnd() % strs.length] + (rnd() % 3)] = gen(depth + 1);
    return o;
  };
  const cases = Array.from({ length: 60 }, () => gen(0));
  const input = JSON.stringify(cases);
  const r = runPython(
    'import sys,json\ncs=json.loads(sys.stdin.buffer.read().decode("utf-8"))\nprint(json.dumps([json.dumps(c,sort_keys=True,ensure_ascii=False,separators=(",",":")) for c in cs],ensure_ascii=True))',
    [], input,
  );
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(r.stdout);
  assert.deepEqual(cases.map(canonicalJson), expected);
});

test('parseJsonl: 1 行 1 JSON、空行は無視、CRLF 可', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\r\n   \n[3]\n'), [{ a: 1 }, { b: 2 }, [3]]);
  assert.deepEqual(parseJsonl(''), []);
  assert.deepEqual(parseJsonl('\n\n'), []);
  assert.deepEqual(parseJsonl('﻿{"a":1}'), [{ a: 1 }]);
});

test('parseJsonl: 最終行に改行がなくても読める', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
});

test('parseJsonl: 読めない行は SyntaxError（行番号つき）', () => {
  assert.throws(() => parseJsonl('{"a":1}\n{"a":\n'), (e) => e instanceof SyntaxError && e.line === 2);
  assert.throws(() => parseJsonl('{"a":1}\nxx\n{"a":2}\n', { tolerateTruncated: true }), (e) => e.line === 2);
});

test('parseJsonl: tolerateTruncated は最後の行だけを捨て、捨てた数を dropped に入れる', () => {
  const r = parseJsonl('{"seq":0}\n{"seq":1}\n{"seq":2,"ty', { tolerateTruncated: true });
  assert.deepEqual(r, [{ seq: 0 }, { seq: 1 }]);
  assert.equal(r.dropped, 1);
  const r2 = parseJsonl('{"seq":0}\n{"seq":1}\n', { tolerateTruncated: true });
  assert.equal(r2.dropped, 0);
  assert.equal(r2.length, 2);
  // 切れた行の後ろに改行や空行があっても、最後の空でない行として扱う
  const r3 = parseJsonl('{"seq":0}\n{"seq":1,\n\n', { tolerateTruncated: true });
  assert.deepEqual(r3, [{ seq: 0 }]);
  assert.equal(r3.dropped, 1);
  // 既定では dropped は 0
  assert.equal(parseJsonl('{"a":1}').dropped, 0);
  // 列挙されない（deepEqual に影響しない）
  assert.deepEqual(Object.keys(r), ['0', '1']);
});

test('parseJsonl: すべての切り方で、途中で切れた記録から完全な行だけが戻る', () => {
  const items = [{ seq: 0, type: 'session-start', note: '日本語' }, { seq: 1, type: 'ok' }, { seq: 2, type: 'mark', note: 'a"b' }];
  const text = stringifyJsonl(items);
  for (let cut = 0; cut <= text.length; cut++) {
    const part = text.slice(0, cut);
    const r = parseJsonl(part, { tolerateTruncated: true });
    // 切れた位置より前に完結している行の数
    const complete = part.split('\n').slice(0, -1).length;
    const lastLineLen = part.length - (part.lastIndexOf('\n') + 1);
    // 末尾が改行で終わっていなくても、行として読める場合（次の行の先頭が欠けていない）は残る
    const expected = items.slice(0, complete);
    if (lastLineLen > 0 && cut === text.length - 1) { /* 最後の改行だけ欠けた：行は完結している */ }
    const tail = part.slice(part.lastIndexOf('\n') + 1);
    let tailOk = false;
    try { if (tail.trim() !== '') { JSON.parse(tail); tailOk = true; } } catch { /* 切れている */ }
    assert.deepEqual(r, tailOk ? items.slice(0, complete + 1) : expected, `cut=${cut}`);
  }
});

test('stringifyJsonl: 各行は canonicalJson、最後に LF、空は空文字列', () => {
  assert.equal(stringifyJsonl([{ b: 1, a: 2 }, [1]]), '{"a":2,"b":1}\n[1]\n');
  assert.equal(stringifyJsonl([]), '');
});

test('stringifyJsonl と parseJsonl は往復する', () => {
  const items = [{ seq: 0, s: 'a\nb' }, { seq: 1, n: null, arr: [1, 2] }];
  assert.deepEqual(parseJsonl(stringifyJsonl(items)), items);
});
