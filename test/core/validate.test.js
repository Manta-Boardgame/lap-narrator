import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, validateWithSchema } from '../../core/validate.js';
import { SCHEMAS } from '../../core/schemas.js';
import { generate } from './helpers/gen-schemas.js';
import { SAMPLES, sampleManifest, sampleFinalManifest } from './helpers/samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clone = (x) => JSON.parse(JSON.stringify(x));

test('core/schemas.js は schema/*.schema.json と一致している（node test/core/helpers/gen-schemas.js で作り直す）', () => {
  const dir = join(root, 'schema');
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  assert.deepEqual(Object.keys(SCHEMAS).sort(), files.map((f) => f.replace('.schema.json', '')).sort());
  for (const f of files) {
    assert.deepEqual(SCHEMAS[f.replace('.schema.json', '')], JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
  }
  assert.equal(readFileSync(join(root, 'core', 'schemas.js'), 'utf8'), generate(), 'core/schemas.js が古い');
});

test('正しい見本はすべてのスキーマで通る', () => {
  for (const name of Object.keys(SCHEMAS)) {
    assert.ok(SAMPLES[name], `${name} の見本がある`);
    const r = validate(name, SAMPLES[name]());
    assert.deepEqual(r, { ok: true, errors: [] }, name);
  }
  assert.deepEqual(validate('manifest', sampleFinalManifest()), { ok: true, errors: [] });
});

test('未知のスキーマ名は TypeError', () => {
  assert.throws(() => validate('nope', {}), TypeError);
  assert.throws(() => validate('__proto__', {}), TypeError);
});

// ---- 壊した見本：スキーマごとに、期待するパスで失敗する
const BREAKS = [
  ['script', (s) => { delete s.projectId; }, '/'],
  ['script', (s) => { s.projectId = 'x'; }, '/projectId'],
  ['script', (s) => { s.format = 'other'; }, '/format'],
  ['script', (s) => { s.version = 2; }, '/version'],
  ['script', (s) => { s.slides = []; }, '/slides'],
  ['script', (s) => { s.slides[0].order = 0; }, '/slides/0/order'],
  ['script', (s) => { s.slides[0].order = 1.5; }, '/slides/0/order'],
  ['script', (s) => { s.slides[0].recordable = 'yes'; }, '/slides/0/recordable'],
  ['script', (s) => { s.slides[1].extra = 1; }, '/slides/1/extra'],
  ['script', (s) => { s.slides[0].textHash = 'ABC'; }, '/slides/0/textHash'],
  ['script', (s) => { s.slides[0].slideId = 'a b'; }, '/slides/0/slideId'],
  ['script', (s) => { s.title = 'x'.repeat(301); }, '/title'],
  ['script', (s) => { s.slides[0].targetSec = -1; }, '/slides/0/targetSec'],
  ['manifest', (m) => { m.kind = 'partial'; }, '/kind'],
  ['manifest', (m) => { m.volume = 0; }, '/volume'],
  ['manifest', (m) => { m.files[0].sha256 = 'zz'; }, '/files/0/sha256'],
  ['manifest', (m) => { m.rawFiles[0].sampleRate = 100; }, '/rawFiles/0/sampleRate'],
  ['manifest', (m) => { m.unknown = 1; }, '/unknown'],
  ['manifest', (m) => { delete m.createdAt; }, '/'],
  ['events', (e) => { e.type = 'bogus'; }, '/type'],
  ['events', (e) => { e.seq = -1; }, '/seq'],
  ['events', (e) => { e.eventId = '17'; }, '/eventId'],
  ['events', (e) => { e.at.raw = 'rec-1'; }, '/at/raw'],
  ['events', (e) => { e.at.extra = 1; }, '/at/extra'],
  ['events', (e) => { delete e.at.pos; }, '/at'],
  ['events', (e) => { e.takeId = 't1'; }, '/takeId'],
  ['segments', (g) => { g.segments[0].status = 'weird'; }, '/segments/0/status'],
  ['segments', (g) => { g.segments[0].order = 'x'; }, '/segments/0/order'],
  ['segments', (g) => { g.segments[0].end = 0; }, '/segments/0/end'],
  ['segments', (g) => { g.recoverable = { pos: 1 }; }, '/recoverable'],
  ['segments', (g) => { g.takes[0].status = 'pending'; }, '/takes/0/status'],
  ['segments', (g) => { g.issues[0].seq = -3; }, '/issues/0/seq'],
  ['edits', (x) => { x.editVersion = 0; }, '/editVersion'],
  ['edits', (x) => { x.limiter.ceilingDb = 3; }, '/limiter/ceilingDb'],
  ['edits', (x) => { x.joins[0].index = 0; }, '/joins/0/index'],
  ['edits', (x) => { x.joins[0].bogus = 1; }, '/joins/0/bogus'],
  ['edits', (x) => { x.fadeSamples = -1; }, '/fadeSamples'],
  ['timeline', (t) => { t.fps = 0; }, '/fps'],
  ['timeline', (t) => { t.fps = 121; }, '/fps'],
  ['timeline', (t) => { t.slides[0].audio = []; }, '/slides/0/audio'],
  ['timeline', (t) => { t.slides[0].audio = 5; }, '/slides/0/audio'],
  ['timeline', (t) => { t.slides[1].audio = ['a', 3]; }, '/slides/1/audio'],
  ['timeline', (t) => { t.slides[0].audioSamples = 0; }, '/slides/0/audioSamples'],
  ['timeline', (t) => { delete t.totalSamples; }, '/'],
  ['index', (i) => { i.zips = []; }, '/zips'],
  ['index', (i) => { i.zips[0].bytes = -1; }, '/zips/0/bytes'],
  ['boundaries', (b) => { b.audio.sha256 = 'xyz'; }, '/audio/sha256'],
  ['boundaries', (b) => { b.slides[1].status = 'maybe'; }, '/slides/1/status'],
  ['boundaries', (b) => { b.slides[0].confidence = 2; }, '/slides/0/confidence'],
  ['boundaries', (b) => { b.slides[0].startSample = 1.5; }, '/slides/0/startSample'],
  ['boundaries', (b) => { delete b.script; }, '/'],
  ['boundaries', (b) => { b.extra = 1; }, '/extra'],
  ['transcript', (t) => { t.words[0].start = -1; }, '/words/0/start'],
  ['transcript', (t) => { delete t.segments; }, '/'],
  ['transcript', (t) => { t.audio.sha256 = 'abc'; }, '/audio/sha256'],
  ['manifest', (m) => { m.recording = 'live'; }, '/recording'],
  ['index', (i) => { i.kind = 'x'; }, '/kind'],
  ['cli-result', (c) => { c.ok = 'true'; }, '/ok'],
  ['cli-result', (c) => { delete c.errors; }, '/'],
  ['cli-result', (c) => { c.warnings = [{ code: 1, message: 'm' }]; }, '/warnings/0/code'],
  ['cli-result', (c) => { c.extra = 1; }, '/extra'],
  ['cli-result', (c) => { c.result = []; }, '/result'],
];

for (const [name, brk, expectedPath] of BREAKS) {
  test(`壊した見本が失敗する：${name} ${expectedPath}（${brk.toString().slice(0, 50).replace(/\s+/g, ' ')}…）`, () => {
    const v = clone(SAMPLES[name]());
    brk(v);
    const r = validate(name, v);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 1);
    assert.ok(r.errors.some((e) => e.path === expectedPath), `期待したパス ${expectedPath} が無い：${JSON.stringify(r.errors)}`);
    for (const e of r.errors) { assert.equal(typeof e.path, 'string'); assert.equal(typeof e.message, 'string'); }
  });
}

test('根が違う型でも例外にせず errors に出す', () => {
  for (const v of [null, 5, 'x', [], undefined, true]) {
    const r = validate('script', v);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '/');
  }
});

// ---- キーワードごとの単体試験（小さなスキーマ）
const ok = (schema, v) => validateWithSchema(schema, v).ok;

test('type：integer は 1.0 を許し 1.5 を許さない。number は NaN／Infinity を許さない', () => {
  assert.ok(ok({ type: 'integer' }, 1.0));
  assert.ok(!ok({ type: 'integer' }, 1.5));
  assert.ok(!ok({ type: 'number' }, NaN));
  assert.ok(!ok({ type: 'number' }, Infinity));
  assert.ok(ok({ type: 'number' }, -2.5));
  assert.ok(!ok({ type: 'object' }, []));
  assert.ok(!ok({ type: 'object' }, null));
  assert.ok(ok({ type: 'array' }, []));
  assert.ok(ok({ type: 'null' }, null));
  assert.ok(ok({ type: 'boolean' }, false));
  assert.ok(ok({ type: ['string', 'null'] }, null));
  assert.throws(() => validateWithSchema({ type: 'weird' }, 1));
});

test('enum と const：オブジェクトや配列も深く比べる', () => {
  assert.ok(ok({ enum: [1, 'a', null, { x: [1] }] }, { x: [1] }));
  assert.ok(!ok({ enum: [1, 'a'] }, 2));
  assert.ok(ok({ const: 5 }, 5));
  assert.ok(!ok({ const: 5 }, '5'));
  assert.ok(ok({ const: 0 }, 0));
});

test('minimum と maximum：境界の値は通る', () => {
  const s = { type: 'number', minimum: 1, maximum: 3 };
  assert.ok(ok(s, 1) && ok(s, 3) && ok(s, 2.5));
  assert.ok(!ok(s, 0.999) && !ok(s, 3.001));
});

test('minLength と maxLength：コードポイントで数える（サロゲートペアは 1 文字）', () => {
  const s = { type: 'string', minLength: 2, maxLength: 3 };
  assert.ok(ok(s, '日本') && ok(s, '日本語'));
  assert.ok(!ok(s, '日') && !ok(s, '日本語語'));
  assert.ok(ok(s, '\u{1F600}\u{1F600}'));
  assert.ok(!ok({ type: 'string', maxLength: 1 }, '\u{1F600}\u{1F600}'));
});

test('pattern：検索（アンカーなし）として評価する', () => {
  assert.ok(ok({ pattern: 'ab' }, 'xxabxx'));
  assert.ok(!ok({ pattern: '^ab$' }, 'xabx'));
  assert.ok(ok({ pattern: '^[A-Za-z0-9_-]{6,64}$' }, 'abc_-123'));
  assert.ok(!ok({ pattern: '^[A-Za-z0-9_-]{6,64}$' }, 'abc'));
  assert.ok(ok({ pattern: '^t[0-9]{4}$' }, 't0001'));
  assert.ok(!ok({ pattern: '^t[0-9]{4}$' }, 't00001'));
  assert.ok(ok({ type: 'string', pattern: 'x' }, 'x'));
  assert.ok(ok({ type: 'integer', pattern: 'x' }, 5)); // 文字列でなければ pattern は適用しない
});

test('minItems、maxItems、items', () => {
  const s = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } };
  assert.ok(ok(s, [1]) && ok(s, [1, 2]));
  assert.ok(!ok(s, []) && !ok(s, [1, 2, 3]) && !ok(s, [1, 'a']));
  const r = validateWithSchema(s, [1, 'a']);
  assert.equal(r.errors[0].path, '/1');
});

test('required と additionalProperties:false と properties', () => {
  const s = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer' }, b: { type: 'string' } } };
  assert.ok(ok(s, { a: 1 }) && ok(s, { a: 1, b: 'x' }));
  assert.ok(!ok(s, {}) && !ok(s, { a: 1, c: 1 }) && !ok(s, { a: 'x' }));
  assert.ok(ok({ type: 'object', additionalProperties: true }, { z: 1 }));
  assert.ok(ok({ type: 'object' }, { z: 1 }));
  // undefined の値は無いものとして扱う
  assert.ok(!ok(s, { a: undefined }));
  assert.ok(ok(s, { a: 1, b: undefined }));
  // キー名が特殊でもパスは JSON Pointer にエスケープされる
  const r = validateWithSchema({ type: 'object', additionalProperties: false, properties: {} }, { 'a/b~c': 1 });
  assert.equal(r.errors[0].path, '/a~1b~0c');
});

test('oneOf：ちょうど 1 つに合うときだけ通る', () => {
  const s = { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] };
  assert.ok(ok(s, 3) && ok(s, null));
  assert.ok(!ok(s, 0) && !ok(s, 'x'));
  const both = { oneOf: [{ type: 'integer' }, { type: 'number' }] };
  assert.ok(!ok(both, 3)); // 両方に合う
  assert.ok(ok(both, 3.5));
});

test('$ref：同じファイルの #/$defs/... を引く。解決できない参照はエラー', () => {
  const s = { $defs: { id: { type: 'string', pattern: '^[a-z]+$' } }, type: 'object', properties: { a: { $ref: '#/$defs/id' }, b: { type: 'array', items: { $ref: '#/$defs/id' } } } };
  assert.ok(ok(s, { a: 'abc', b: ['x', 'y'] }));
  assert.ok(!ok(s, { a: 'ABC' }));
  assert.ok(!ok(s, { b: ['x', '1'] }));
  assert.throws(() => validateWithSchema({ $ref: '#/$defs/missing' }, 1));
  assert.throws(() => validateWithSchema({ $ref: 'http://example.com/x' }, 1));
});

test('実物の manifest は、finals の中の applied に何を入れても通る（additionalProperties:true の確認）', () => {
  const m = sampleFinalManifest();
  m.finals[0].applied = { gainDb: 0, anything: { nested: [1, 2] } };
  assert.ok(validate('manifest', m).ok);
  m.finals[0].parts = [];
  assert.ok(!validate('manifest', m).ok);
});

test('manifest：rawFiles の file、files の path は任意の文字列、volume は 1 以上', () => {
  const m = sampleManifest();
  m.volume = 2; m.volumes = 3;
  assert.ok(validate('manifest', m).ok);
  m.volumes = 0;
  assert.ok(!validate('manifest', m).ok);
});
