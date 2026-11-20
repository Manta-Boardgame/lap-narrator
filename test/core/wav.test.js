import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { wavHeader, parseWavHeader, planWavParts } from '../../core/wav.js';
import { runPython, hasPython, WORK_A } from './helpers/python.js';

test('wavHeader: 44 バイトの標準ヘッダーのバイト列（48000 Hz、4 サンプル）', () => {
  const h = wavHeader({ sampleRate: 48000, samples: 4 });
  const expected = [
    0x52, 0x49, 0x46, 0x46, 44, 0, 0, 0, // RIFF, 36 + 8
    0x57, 0x41, 0x56, 0x45,
    0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0,
    1, 0, 1, 0, // PCM, mono
    0x80, 0xbb, 0, 0, // 48000
    0x00, 0x77, 0x01, 0, // 96000 bytes/s
    2, 0, 16, 0,
    0x64, 0x61, 0x74, 0x61, 8, 0, 0, 0,
  ];
  assert.deepEqual([...h], expected);
  assert.equal(h.length, 44);
});

test('wavHeader: 0 サンプルも作れる、同じ入力は同じバイト列', () => {
  const h = wavHeader({ sampleRate: 44100, samples: 0 });
  assert.equal(h.length, 44);
  assert.deepEqual(parseWavHeader(h), { sampleRate: 44100, channels: 1, bits: 16, samples: 0, dataOffset: 44 });
  assert.deepEqual(wavHeader({ sampleRate: 44100, samples: 7 }), wavHeader({ sampleRate: 44100, samples: 7 }));
});

test('wavHeader: 大きさの限界（2^32 - 1 バイト未満）', () => {
  const maxSamples = (0xffffffff - 1 - 44) / 2; // 偶数にならない場合は切り捨て
  const ok = Math.floor(maxSamples);
  const h = wavHeader({ sampleRate: 48000, samples: ok });
  const dv = new DataView(h.buffer);
  assert.equal(dv.getUint32(40, true), ok * 2);
  assert.equal(dv.getUint32(4, true), 36 + ok * 2);
  assert.ok(44 + ok * 2 < 0xffffffff);
  assert.throws(() => wavHeader({ sampleRate: 48000, samples: ok + 1 }), RangeError);
  assert.throws(() => wavHeader({ sampleRate: 48000, samples: -1 }), RangeError);
  assert.throws(() => wavHeader({ sampleRate: 48000, samples: 1.5 }), RangeError);
  assert.throws(() => wavHeader({ sampleRate: 0, samples: 1 }), RangeError);
});

test('parseWavHeader: wavHeader の往復（いろいろな周波数と長さ）', () => {
  for (const sampleRate of [8000, 16000, 44100, 48000, 96000]) {
    for (const samples of [0, 1, 2, 12345, 2 ** 30]) {
      assert.deepEqual(parseWavHeader(wavHeader({ sampleRate, samples })), { sampleRate, channels: 1, bits: 16, samples, dataOffset: 44 });
    }
  }
});

test('parseWavHeader: 追加チャンク（LIST）つきの WAV も読める。奇数長チャンクの詰め物を飛ばす', () => {
  const fmt = wavHeader({ sampleRate: 22050, samples: 3 }).slice(12, 36); // "fmt " チャンク全体
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // LIST 3 バイト + 詰め物 1
  const data = new Uint8Array([0x64, 0x61, 0x74, 0x61, 6, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
  const body = [...fmt, ...list, ...data];
  const u8 = new Uint8Array([0x52, 0x49, 0x46, 0x46, body.length + 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...body]);
  assert.deepEqual(parseWavHeader(u8), { sampleRate: 22050, channels: 1, bits: 16, samples: 3, dataOffset: 12 + 24 + 12 + 8 });
});

test('parseWavHeader: 壊れた入力は Error（unsupported-wav）、例外の型を保つ', () => {
  assert.throws(() => parseWavHeader(new Uint8Array(0)), { code: 'unsupported-wav' });
  assert.throws(() => parseWavHeader(new Uint8Array(44)), { code: 'unsupported-wav' });
  const h = wavHeader({ sampleRate: 48000, samples: 1 });
  assert.throws(() => parseWavHeader(h.slice(0, 40)), { code: 'unsupported-wav' }); // data の見出しが切れている
  const notPcm = h.slice();
  notPcm[20] = 3; // IEEE float
  assert.throws(() => parseWavHeader(notPcm), { code: 'unsupported-wav' });
  assert.throws(() => parseWavHeader('x'), TypeError);
});

test('Python の wave モジュールで読める（独立した読み手）', { skip: !hasPython }, () => {
  mkdirSync(WORK_A, { recursive: true });
  const dir = join(WORK_A, 'wav-test');
  mkdirSync(dir, { recursive: true });
  try {
    const samples = 1000;
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = ((i * 37) % 65536) - 32768;
    const header = wavHeader({ sampleRate: 44100, samples });
    const file = new Uint8Array(44 + samples * 2);
    file.set(header, 0);
    file.set(new Uint8Array(pcm.buffer), 44);
    const path = join(dir, 'a.wav');
    writeFileSync(path, file);
    const r = runPython(
      'import sys,wave,json,struct\nw=wave.open(sys.argv[1],"rb")\nfr=w.readframes(w.getnframes())\nprint(json.dumps([w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes(),list(struct.unpack("<%dh"%w.getnframes(),fr))[:5]]))',
      [path],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [1, 2, 44100, samples, [...pcm.slice(0, 5)]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Python の wave で書いた WAV を parseWavHeader で読める', { skip: !hasPython }, () => {
  const r = runPython(
    'import wave,io,sys\nb=io.BytesIO()\nw=wave.open(b,"wb")\nw.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)\nw.writeframes(b"\\x01\\x00"*500)\nw.close()\nsys.stdout.write(b.getvalue().hex())',
  );
  assert.equal(r.status, 0, r.stderr);
  const bytes = Uint8Array.from(Buffer.from(r.stdout, 'hex'));
  assert.deepEqual(parseWavHeader(bytes), { sampleRate: 16000, channels: 1, bits: 16, samples: 500, dataOffset: 44 });
  // Python の標準ヘッダーとバイト単位で同じ
  assert.deepEqual(wavHeader({ sampleRate: 16000, samples: 500 }), bytes.slice(0, 44));
});

test('planWavParts: 合計が保たれ、各 WAV が maxBytes 以下', () => {
  const max = 1000;
  for (const total of [1, 2, 477, 478, 479, 478 * 3, 478 * 3 + 1, 100000]) {
    const parts = planWavParts(total, max);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `total=${total}`);
    for (const p of parts) { assert.ok(p >= 1); assert.ok(44 + p * 2 <= max); }
    // 先頭から詰める：最後以外は上限いっぱい
    for (let i = 0; i < parts.length - 1; i++) assert.equal(parts[i], 478);
  }
});

test('planWavParts: 0 サンプルは空配列、境界の値', () => {
  assert.deepEqual(planWavParts(0, 1000), []);
  assert.deepEqual(planWavParts(478, 1000), [478]);
  assert.deepEqual(planWavParts(479, 1000), [478, 1]);
  assert.deepEqual(planWavParts(5, 46), [1, 1, 1, 1, 1]); // 44 + 2 = 46 バイトで 1 サンプル
});

test('planWavParts: 既定の finalMaxBytes（2GiB - 1MiB）で 12 時間級の音声を分割', () => {
  const finalMax = 2 * 1024 * 1024 * 1024 - 1024 * 1024;
  const total = 48000 * 3600 * 24; // 24 時間
  const parts = planWavParts(total, finalMax);
  assert.equal(parts.reduce((a, b) => a + b, 0), total);
  for (const p of parts) assert.ok(44 + p * 2 <= finalMax);
  assert.ok(parts.length >= 4);
});

test('planWavParts: 4GiB を超える maxBytes を渡しても WAV の限界（2^32 - 1 未満）で切る', () => {
  const parts = planWavParts(3_000_000_000, 10 * 1024 * 1024 * 1024);
  for (const p of parts) assert.ok(44 + p * 2 < 0xffffffff);
  assert.equal(parts.reduce((a, b) => a + b, 0), 3_000_000_000);
  assert.ok(parts.length >= 2);
});

test('planWavParts: 不正な引数は RangeError', () => {
  assert.throws(() => planWavParts(-1, 1000), RangeError);
  assert.throws(() => planWavParts(1.5, 1000), RangeError);
  assert.throws(() => planWavParts(10, 45), RangeError);
  assert.throws(() => planWavParts(10, NaN), RangeError);
});
