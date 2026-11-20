import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { reduceEvents } from '../../core/reduce.js';
import { parseJsonl } from '../../core/json.js';
import { renderTake, defaultRenderSpec } from '../../core/render.js';
import { parseWavHeader } from '../../core/wav.js';
import { validate } from '../../core/validate.js';

// examples/sessions/*/expected.* は担当 E が手で導いた期待値。ここでは読むだけで、書き換えない。
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sessions');
const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const base = (n) => n.replace(/^.*[\/]/, '').replace(/.[^.]*$/, '');
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('examples/sessions に見本がある', () => assert.ok(dirs.length >= 20, `dirs=${dirs.length}`));

for (const name of dirs) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'expected.segments.json'))) continue;
  const manifest = rj(join(dir, 'manifest.json'));
  const events = parseJsonl(readFileSync(join(dir, 'events.jsonl'), 'utf8'));
  const rawFiles = (manifest.rawFiles || []).map((r) => ({ name: r.file, sampleRate: r.sampleRate, samples: r.samples, durableSamples: r.durableSamples }));
  const expected = rj(join(dir, 'expected.segments.json'));

  test(`見本 ${name}：reduceEvents が期待値（expected.segments.json）と一致`, () => {
    const { state, ...got } = reduceEvents(events, rawFiles);
    const order = (a, b) => ((a.seq ?? -1) - (b.seq ?? -1)) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    const strip = (r) => ({ ...r, issues: r.issues.map((i) => ({ code: i.code, seq: i.seq })).sort(order) });
    assert.deepEqual(strip(got), strip(expected));
    assert.deepEqual(validate('segments', got), { ok: true, errors: [] });
  });

  const er = join(dir, 'expected.render.json');
  if (existsSync(er)) {
    test(`見本 ${name}：既定の採用のテイクの完成 PCM の SHA-256 が期待値と一致`, async () => {
      const exp = rj(er);
      const result = reduceEvents(events, rawFiles);
      const raws = {};
      for (const r of rawFiles) {
        const buf = readFileSync(join(dir, 'raw', `${r.name.replace(/^.*[\/]/, '').replace(/\.[^.]*$/, '')}.wav`));
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const h = parseWavHeader(u8);
        raws[base(r.name)] = new Int16Array(u8.slice(h.dataOffset, h.dataOffset + h.samples * 2).buffer);
      }
      const rates = Object.fromEntries(rawFiles.map((r) => [base(r.name), r.sampleRate]));
      const readSamples = async (raw, s, e) => raws[raw].slice(s, e);
      const finals = [];
      const unrenderable = [];
      for (const [slideId, takeId] of Object.entries(result.defaultTakes)) {
        const segs = result.segments.filter((s) => s.takeId === takeId && s.status === 'kept');
        if (segs.some((x) => !raws[x.raw])) { unrenderable.push({ slideId, takeId }); continue; } // 録音ファイルが見本に無い
        const h = createHash('sha256');
        let n = 0;
        for await (const c of renderTake({ segments: segs, rawRates: rates, readSamples, spec: { ...defaultRenderSpec(), sampleRate: exp.sampleRate, fadeSamples: exp.fadeSamples }, allSegments: result.segments, rawLengths: Object.fromEntries(rawFiles.map((r) => [base(r.name), r.samples])) })) {
          h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
          n += c.length;
        }
        finals.push({ slideId, takeId, samples: n, sha256: h.digest('hex') });
      }
      assert.deepEqual(finals, exp.finals);
      assert.deepEqual(unrenderable, (exp.unrenderable || []).map((u) => ({ slideId: u.slideId, takeId: u.takeId })));
    });
  }
}
