// testgen（試験の素材を作る道具）の試験：同じ指定から同じ素材ができること、形式が正しいこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { imageSize } from 'image-size';
import { REPO_ROOT } from './load-session.js';
import { canonicalJson, sha256Hex, textHash, scriptHash } from '../../testgen/lib/hash.js';
import { makeRng } from '../../testgen/lib/rng.js';
import { encodeWav, decodeWav, normalizeWav } from '../../testgen/lib/wav.js';
import { renderSlidePng, slideColors } from '../../testgen/lib/png.js';
import { writeZip } from '../../testgen/lib/zip.js';
import { buildScriptPack, loadSpec } from '../../testgen/script-pack.js';
import { buildPptx } from '../../testgen/make-pptx.js';
import { writeAllSessions } from '../../testgen/sessions/make-sessions.js';
import { slideCue, detectCue, goertzelPower } from '../../testgen/cue.js';
import { addNoise, clipping, lowVolume, dropouts, dcOffset, longSilence, convertRate, degrade, DEGRADATIONS, rms } from '../../testgen/degrade.js';
import { validateSchema } from '../../testgen/lib/mini-schema.js';

const SPEC_DIR = join(REPO_ROOT, 'testgen', 'specs');
const spec = (n) => loadSpec(join(SPEC_DIR, n + '.json'));
const WORK = join(REPO_ROOT, 'work', 'E', 'test-tmp');

// ---- ハッシュの規則（CONTRACTS.md 0.4）----

test('canonicalJson：キーの順、空白なし、日本語はそのまま、undefined は出さない', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalJson({ t: '日本語"\\\n' }), '{"t":"日本語\\"\\\\\\n"}');
  assert.equal(canonicalJson({ é: 1, a: 2, Z: 3 }), '{"Z":3,"a":2,"é":1}');
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.throws(() => canonicalJson({ a: Infinity }));
});

test('textHash と scriptHash は、Python（別の実装）で計算した値と一致する', () => {
  // Python: json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False) の SHA-256
  const tiny = buildScriptPack(spec('tiny3')).script;
  assert.equal(tiny.scriptHash, 'fbbece90d93738c95d24ebe9e79e920d21446272dd7e9071a99b935e08755076');
  const edge = buildScriptPack(spec('edge')).script;
  assert.equal(edge.scriptHash, '3454e1a4819970cb2f1b88e51c59ed671c0acaf69b6ae98fe349e8101be7f05a');
  // 定義どおり：全スライドの textHash を order の昇順に "\n" でつないだものの SHA-256
  assert.equal(tiny.scriptHash, sha256Hex(tiny.slides.map((s) => textHash(s)).join('\n')));
  assert.equal(scriptHash([...tiny.slides].reverse()), tiny.scriptHash, 'order の昇順に並べ直す');
});

test('題名、担当、目安の秒数、絵を変えても scriptHash は変わらない。文を変えるとそのスライドの textHash だけが変わる', () => {
  const base = buildScriptPack(spec('tiny3')).script;
  const s2 = spec('tiny3');
  s2.title = '別の題名';
  s2.slides[0].speaker = '別の人';
  s2.slides[0].targetSec = 99;
  s2.slides[1].title = 'x';
  const changed = buildScriptPack(s2).script;
  assert.equal(changed.scriptHash, base.scriptHash);
  const s3 = spec('tiny3');
  s3.slides[1].text += '。';
  const c3 = buildScriptPack(s3).script;
  assert.notEqual(c3.scriptHash, base.scriptHash);
  assert.deepEqual(c3.slides.map((s, i) => s.textHash === base.slides[i].textHash), [true, false, true]);
});

// ---- 台本パック ----

for (const n of ['tiny3', 'tiny3h', 'jp15', 'edge', 'en']) {
  test(`台本パック ${n}：同じ指定から同じバイト列。形式に適合し、ハッシュが合う`, async () => {
    const a = buildScriptPack(spec(n));
    const b = buildScriptPack(spec(n));
    assert.equal(a.zipSha256, b.zipSha256);
    assert.deepEqual(validateSchema(JSON.parse(readFileSync(join(REPO_ROOT, 'schema', 'script.schema.json'), 'utf8')), a.script), []);
    // zip を別の実装（JSZip、CRC 検査つき）で読む
    const zip = await JSZip.loadAsync(a.zip, { checkCRC32: true });
    const script = JSON.parse(await zip.file('script.json').async('string'));
    assert.deepEqual(script, a.script);
    for (const s of script.slides) {
      const png = await zip.file(s.image).async('nodebuffer');
      assert.equal(sha256Hex(png), s.imageSha256);
      assert.equal(s.textHash, textHash(s));
    }
    assert.equal(script.scriptHash, scriptHash(script.slides));
    assert.equal(Object.keys(zip.files).length, 1 + script.slides.length);
    // examples/packs に置いたものと同じ
    const committed = join(REPO_ROOT, 'examples', 'packs', n + '.zip');
    assert.ok(existsSync(committed));
    assert.equal(sha256Hex(readFileSync(committed)), a.zipSha256, 'examples/packs is up to date (run: node testgen/cli.js examples)');
  });
}

test('台本パックの固定のハッシュ（同じ指定から同じ素材）', () => {
  const pins = {
    tiny3: 'd4bef0430788c44c98525082e3ad7a5280067185ded88068ebebf17c1c592282',
    tiny3h: '170de8ca4ab09d74afaa20c10075cacd9070c0ba49dac5b87f64f462bd92ed23',
    jp15: 'f7c64733e9e328c7d78b73b6ecb662cdf1202b027b521ecd21a3101ec2426d90',
    edge: '136b89172bbc77022618fd23f54c38844927f286bd11c33e4ec4da796c0dfe85',
    en: '935dde71132d2e8270fb254748654725161d802985d89283c15c98c8200cd5e7',
  };
  for (const [n, h] of Object.entries(pins)) assert.equal(buildScriptPack(spec(n)).zipSha256, h, n);
});

test('edge の台本：recordable false、空の文、長い文、絵文字、空白の題名を含む', () => {
  const s = buildScriptPack(spec('edge')).script.slides;
  assert.ok(s.some((x) => !x.recordable));
  assert.ok(s.some((x) => x.text === ''));
  assert.ok(s.some((x) => x.text.length > 400));
  assert.ok(s.some((x) => /🐼/u.test(x.text)));
  assert.ok(s.some((x) => /日本語.*\s.*spaces/u.test(x.title)));
  assert.ok(s.some((x) => x.text.trim() === '' && x.text !== ''));
});

test('スライドの絵：PNG として読め、寸法が合い、スライドごとに背景色が違う', () => {
  const colors = new Set();
  for (let n = 1; n <= 200; n++) colors.add(slideColors(n).bg.join(','));
  assert.ok(colors.size >= 150, `distinct colors: ${colors.size}`);
  for (let n = 1; n <= 15; n++) {
    const png = renderSlidePng(n);
    const dim = imageSize(png);
    assert.equal(dim.width, 320);
    assert.equal(dim.height, 180);
    assert.equal(dim.type, 'png');
  }
  const a = renderSlidePng(7, { width: 640, height: 360 });
  assert.equal(imageSize(a).width, 640);
  assert.equal(sha256Hex(renderSlidePng(7)), sha256Hex(renderSlidePng(7)));
  assert.notEqual(sha256Hex(renderSlidePng(7)), sha256Hex(renderSlidePng(8)));
});

// ---- pptx ----

test('pptx：同じ指定から同じバイト列。ノートに文が入り、非表示スライドを含む', async () => {
  for (const n of ['tiny3', 'tiny3h', 'jp15', 'edge', 'en']) {
    const a = await buildPptx(spec(n));
    const b = await buildPptx(spec(n));
    assert.equal(sha256Hex(a), sha256Hex(b), n);
    assert.ok(a.length < 100000, `${n} is small`);
    const zip = await JSZip.loadAsync(a, { checkCRC32: true });
    const sp = spec(n);
    for (let i = 0; i < sp.slides.length; i++) {
      const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`).async('string');
      assert.equal(/show="0"/.test(xml), Boolean(sp.slides[i].hidden), `${n} slide ${i + 1} hidden`);
    }
    const notes1 = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
    assert.ok(notes1.includes(sp.slides[0].text.slice(0, 8)));
    assert.ok(existsSync(join(REPO_ROOT, 'examples', 'pptx', n + '.pptx')));
    assert.equal(sha256Hex(readFileSync(join(REPO_ROOT, 'examples', 'pptx', n + '.pptx'))), sha256Hex(a), `${n}.pptx in examples is up to date`);
  }
  // 非表示スライドと空のノートを含むもの
  assert.ok(spec('jp15').slides.some((s) => s.hidden));
  assert.ok(spec('jp15').slides.some((s) => s.text === ''));
  assert.ok(spec('edge').slides.some((s) => s.hidden) && spec('edge').slides.some((s) => s.text === ''));
});

// ---- 見本のセッション ----

test('見本のセッションを作り直すと、examples/sessions と同じ内容になる', async () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const out = join(WORK, 'sessions');
  await writeAllSessions(out, { specDir: SPEC_DIR, freezeRender: true });
  const list = (dir) => {
    const res = [];
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else res.push(relative(dir, p).replaceAll('\\', '/'));
      }
    };
    walk(dir);
    return res.sort();
  };
  const committed = join(REPO_ROOT, 'examples', 'sessions');
  const a = list(out);
  const b = list(committed);
  assert.deepEqual(a, b);
  for (const f of a) assert.equal(sha256Hex(readFileSync(join(out, f))), sha256Hex(readFileSync(join(committed, f))), f);
  rmSync(WORK, { recursive: true, force: true });
});

// ---- WAV、ZIP、乱数 ----

test('WAV：44 バイトの標準ヘッダー、往復、18 バイトの fmt を持つ WAV（音声合成の出力）も読める', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
  const w = encodeWav(pcm, 48000);
  assert.equal(w.length, 44 + 10);
  assert.deepEqual(Array.from(decodeWav(w).samples), Array.from(pcm));
  // fmt が 18 バイトの WAV を作る
  const b = Buffer.alloc(38 + 10);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(18, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.writeUInt16LE(0, 36);
  b.write('data', 38 - 0, 'ascii');
  // data チャンクの見出し分の位置を直す
  const full = Buffer.concat([b.subarray(0, 38), Buffer.alloc(8), Buffer.alloc(10)]);
  full.write('data', 38, 'ascii');
  full.writeUInt32LE(10, 42);
  for (let i = 0; i < 5; i++) full.writeInt16LE(pcm[i], 46 + i * 2);
  full.writeUInt32LE(full.length - 8, 4);
  const n = normalizeWav(new Uint8Array(full));
  assert.equal(n.bytes.length, 54);
  assert.deepEqual(Array.from(decodeWav(n.bytes).samples), Array.from(pcm));
});

test('ZIP：無圧縮、UTF-8 のファイル名、固定の日付、同じ内容から同じバイト列', async () => {
  const entries = [{ name: '日本語/a.txt', data: new Uint8Array([1, 2, 3]) }, { name: 'b.bin', data: new Uint8Array(0) }];
  const z = writeZip(entries);
  assert.equal(sha256Hex(z), sha256Hex(writeZip(entries)));
  const zip = await JSZip.loadAsync(z, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['b.bin', '日本語/a.txt'].sort());
  assert.deepEqual(Array.from(await zip.file('日本語/a.txt').async('uint8array')), [1, 2, 3]);
  const b = Buffer.from(z);
  assert.equal(b.readUInt16LE(8), 0, 'method 0');
  assert.equal(b.readUInt16LE(6) & 0x0800, 0x0800, 'UTF-8 flag');
  assert.equal(b.readUInt16LE(12), 0x0021, '1980-01-01');
});

test('乱数：同じ種から同じ列、違う種から違う列', () => {
  const a = makeRng('x');
  const b = makeRng('x');
  const c = makeRng('y');
  const sa = Array.from({ length: 5 }, () => a.nextU32());
  assert.deepEqual(sa, Array.from({ length: 5 }, () => b.nextU32()));
  assert.notDeepEqual(sa, Array.from({ length: 5 }, () => c.nextU32()));
});

// ---- 確認音 ----

test('確認音：スライドごとに固有、録音から番号を読み取れる（雑音があっても）', () => {
  const hashes = new Set();
  for (let n = 1; n <= 15; n++) {
    const cue = slideCue(n);
    hashes.add(sha256Hex(new Uint8Array(cue.buffer)));
    assert.equal(detectCue(cue, 48000, 20), n);
    const noisy = addNoise(cue, { kind: 'white', snrDb: 10, seed: 'cue' + n });
    assert.equal(detectCue(noisy, 48000, 20), n, `noisy ${n}`);
  }
  assert.equal(hashes.size, 15);
});

// ---- 音質の劣化 ----

const speechLike = () => {
  const x = new Int16Array(48000);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000) + 3000 * Math.sin((2 * Math.PI * 1234 * i) / 48000));
  return x;
};

test('劣化：雑音の信号対雑音比が指定どおり（±0.2 dB）。同じ種から同じ出力。入力は変えない', () => {
  const x = speechLike();
  const before = Int16Array.from(x);
  for (const kind of ['white', 'pink', 'hum50']) {
    for (const snr of [30, 20, 10, 0]) {
      const y = addNoise(x, { kind, snrDb: snr, seed: 's' });
      const noise = new Int16Array(x.length);
      for (let i = 0; i < x.length; i++) noise[i] = y[i] - x[i];
      const measured = 20 * Math.log10(rms(x) / rms(noise));
      assert.ok(Math.abs(measured - snr) < 0.2, `${kind} ${snr}: ${measured}`);
      assert.deepEqual(Array.from(y), Array.from(addNoise(x, { kind, snrDb: snr, seed: 's' })));
    }
  }
  assert.deepEqual(Array.from(x), Array.from(before));
  assert.notDeepEqual(Array.from(addNoise(x, { kind: 'white', snrDb: 20, seed: 'a' })), Array.from(addNoise(x, { kind: 'white', snrDb: 20, seed: 'b' })));
});

test('劣化：50Hz のうなりは 50 Hz に強い成分を持つ。ピンクは低域が強い', () => {
  const z = new Int16Array(48000);
  const h = addNoise(z.fill(0), { kind: 'hum50', snrDb: 0, seed: 'h' });
  assert.equal(rms(h), 0, 'silent input has silent noise (SNR is relative)');
  const x = speechLike();
  const hum = addNoise(x, { kind: 'hum50', snrDb: 10, seed: 'h' });
  const d = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) d[i] = hum[i] - x[i];
  assert.ok(goertzelPower(d, 50, 48000) > 100 * goertzelPower(d, 777, 48000));
});

test('劣化：音割れ、小さい音量、途切れ、直流、長い無音', () => {
  const x = speechLike();
  const c = clipping(x, { gain: 4 });
  assert.ok(c.filter((v) => v === 32767 || v === -32768 || v === -32767).length > 1000);
  const q = lowVolume(x, { gainDb: -40 });
  assert.ok(Math.abs(20 * Math.log10(rms(q) / rms(x)) + 40) < 0.2);
  const d = dropouts(x, { count: 3, lengthMs: 80, seed: 'd' });
  let zeros = 0;
  for (let i = 0; i < d.length; i++) if (d[i] === 0 && x[i] !== 0) zeros++;
  assert.ok(zeros >= 3 * 3800 - 3 * 100 && zeros <= 3 * 3840, `zeros ${zeros}`);
  const dc = dcOffset(x, { offset: 3000 });
  let mean = 0;
  for (const v of dc) mean += v;
  assert.ok(Math.abs(mean / dc.length - 3000) < 5);
  const ls = longSilence(x, { atSample: 1000, silenceMs: 5000 });
  assert.equal(ls.length, x.length + 240000);
  assert.ok(ls.subarray(1000, 241000).every((v) => v === 0));
});

test('劣化：周波数の変換（8k／16k／44.1k）で長さと音の高さが保たれる', () => {
  const x = new Int16Array(48000);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(10000 * Math.sin((2 * Math.PI * 1000 * i) / 48000));
  for (const rate of [8000, 16000, 44100]) {
    const y = convertRate(x, 48000, rate);
    assert.equal(y.length, Math.floor((48000 * rate) / 48000));
    const mid = y.subarray(Math.floor(rate * 0.1), Math.floor(rate * 0.9));
    const on = goertzelPower(mid, 1000, rate);
    assert.ok(on > 50 * goertzelPower(mid, 1500, rate), `${rate}`);
    assert.ok(Math.abs(rms(mid) - 10000 / Math.SQRT2) < 300, `${rate} level ${rms(mid)}`);
  }
  const same = convertRate(x, 48000, 48000);
  assert.deepEqual(Array.from(same), Array.from(x));
});

test('劣化：名前の一覧がすべて動き、出力の周波数が正しい', () => {
  const x = speechLike().subarray(0, 8000);
  assert.equal(DEGRADATIONS.length, 12 + 8);
  for (const name of DEGRADATIONS) {
    const r = degrade(x, 48000, name, 'seed');
    assert.ok(r.pcm instanceof Int16Array && r.pcm.length > 0, name);
    const m = /^rate(\d+)$/.exec(name);
    assert.equal(r.sampleRate, m ? Number(m[1]) : 48000, name);
  }
  assert.throws(() => degrade(x, 48000, 'nope'));
});

// ---- 音声合成（声の有無に依存するので、LAP_TESTGEN_TTS=1 のときだけ動かす）----

test('音声合成の powershell は、ファイル出力だけを使う（スピーカーに出さない）。BOM 付き UTF-8', () => {
  const p = join(REPO_ROOT, 'testgen', 'tts', 'synth.ps1');
  const b = readFileSync(p);
  assert.deepEqual(Array.from(b.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
  const t = b.toString('utf8');
  assert.ok(t.includes('SetOutputToWaveFile'));
  assert.ok(!/SetOutputToDefaultAudioDevice/.test(t.replace(/#.*$/gm, '')), 'must not output to the default audio device');
  assert.ok(!/&&|\?\?/.test(t.replace(/#.*$/gm, '')), 'PowerShell 5.1 syntax');
});

test('音声合成：同じ文から同じ WAV（LAP_TESTGEN_TTS=1 のときだけ）', { skip: process.env.LAP_TESTGEN_TTS !== '1' }, async () => {
  const { synthesizeSpec } = await import('../../testgen/tts.js');
  const sp = { lang: 'en', slides: [{ title: 'a', text: 'Hello world.', recordable: true }] };
  const a = synthesizeSpec(sp, join(WORK, 'tts-a'), join(WORK, 'tmp'));
  const b = synthesizeSpec(sp, join(WORK, 'tts-b'), join(WORK, 'tmp'));
  assert.ok(a.ok && b.ok);
  assert.equal(a.entries[0].sha256, b.entries[0].sha256);
  assert.equal(a.entries[0].sampleRate, 48000);
  rmSync(WORK, { recursive: true, force: true });
});
