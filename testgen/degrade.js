// 音質を悪くする関数。乱数は種で決まる。入力は 16 ビットの PCM（Int16Array）。出力は新しい配列（入力は書き換えない）。
import { makeRng } from './lib/rng.js';

const clip16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
function roundHalfEven(x) {
  const f = Math.floor(x);
  const r = x - f;
  if (r < 0.5) return f;
  if (r > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
export const rms = (pcm) => {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
};

/** 雑音の波形（Float64Array、実効値 1 に正規化）。kind：white | pink | hum50 */
export function noiseUnit(kind, n, sampleRate, seed) {
  const rng = makeRng(seed);
  const x = new Float64Array(n);
  if (kind === 'white') {
    for (let i = 0; i < n; i++) x[i] = rng.gauss();
  } else if (kind === 'pink') {
    // Paul Kellet の近似（四則演算だけ）
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.gauss();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else if (kind === 'hum50') {
    // 50 Hz とその倍音（100、150 Hz）。位相は種で決まる
    const ph = rng.float() * 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / sampleRate;
      x[i] = Math.sin(50 * t + ph) + 0.5 * Math.sin(100 * t + 2 * ph) + 0.25 * Math.sin(150 * t + 3 * ph);
    }
  } else throw new Error('unknown noise kind ' + kind);
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  const r = Math.sqrt(s / (n || 1)) || 1;
  for (let i = 0; i < n; i++) x[i] /= r;
  return x;
}

/** 信号対雑音比（dB）が snrDb になるように雑音を足す。 */
export function addNoise(pcm, { kind = 'white', snrDb = 20, sampleRate = 48000, seed = 'noise' } = {}) {
  const sigRms = rms(pcm);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const nz = noiseUnit(kind, pcm.length, sampleRate, `${seed}:${kind}`);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clip16(roundHalfEven(pcm[i] + nz[i] * noiseRms));
  return out;
}

/** 音割れ：gain 倍して、±threshold で切る（硬い切り取り）。 */
export function clipping(pcm, { gain = 4, threshold = 32767 } = {}) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] * gain;
    out[i] = clip16(v > threshold ? threshold : v < -threshold ? -threshold : roundHalfEven(v));
  }
  return out;
}

/** 小さい音量：gainDb（負）だけ下げる。 */
export function lowVolume(pcm, { gainDb = -40 } = {}) {
  const g = Math.pow(10, gainDb / 20);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clip16(roundHalfEven(pcm[i] * g));
  return out;
}

/** 途切れ：長さ lengthMs の無音の穴を count 個、種で決まる位置に開ける。 */
export function dropouts(pcm, { count = 3, lengthMs = 80, sampleRate = 48000, seed = 'dropout' } = {}) {
  const rng = makeRng(seed);
  const out = Int16Array.from(pcm);
  const len = Math.round((sampleRate * lengthMs) / 1000);
  for (let k = 0; k < count; k++) {
    // 穴が重ならないように、全体を count 個の枠に分けて、枠の中のどこかに開ける
    const slot = Math.floor(pcm.length / count);
    const start = k * slot + rng.int(0, Math.max(1, slot - len));
    out.fill(0, start, Math.min(pcm.length, start + len));
  }
  return out;
}

/** 直流のずれ */
export function dcOffset(pcm, { offset = 3000 } = {}) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clip16(pcm[i] + offset);
  return out;
}

/** 長い無音を、atSample の位置に silenceMs だけ挿入する。 */
export function longSilence(pcm, { atSample = Math.floor(pcm.length / 2), silenceMs = 5000, sampleRate = 48000 } = {}) {
  const n = Math.round((sampleRate * silenceMs) / 1000);
  const out = new Int16Array(pcm.length + n);
  out.set(pcm.subarray(0, atSample), 0);
  out.set(pcm.subarray(atSample), atSample + n);
  return out;
}

const bessel0 = (x) => {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
  }
  return sum;
};

/** 周波数の変換（窓付き sinc、Kaiser 窓、試験の素材用。core の仕様の表とは無関係）。 */
export function convertRate(pcm, fromRate, toRate, { halfTaps = 24, beta = 8.6 } = {}) {
  if (fromRate === toRate) return Int16Array.from(pcm);
  const ratio = toRate / fromRate;
  const cutoff = Math.min(1, ratio) * 0.97; // 折り返しを避ける
  const outLen = Math.floor(pcm.length * ratio);
  const out = new Int16Array(outLen);
  const i0 = bessel0(beta);
  for (let j = 0; j < outLen; j++) {
    const t = j / ratio; // 入力の位置
    const c = Math.floor(t);
    let acc = 0;
    for (let k = c - halfTaps + 1; k <= c + halfTaps; k++) {
      if (k < 0 || k >= pcm.length) continue;
      const d = t - k;
      const x = d * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = d / halfTaps;
      if (u <= -1 || u >= 1) continue;
      const w = bessel0(beta * Math.sqrt(1 - u * u)) / i0;
      acc += pcm[k] * sinc * w * cutoff;
    }
    out[j] = clip16(roundHalfEven(acc));
  }
  return out;
}

/**
 * 劣化の名前から、劣化させた音を返す。
 * 名前：white-snr30 / pink-snr20 / hum50-snr10 / white-snr0、clip、quiet、rate8000 / rate16000 / rate44100、dropout、dc、longsilence
 * @returns {{pcm:Int16Array, sampleRate:number}}
 */
export function degrade(pcm, sampleRate, name, seed = 'degrade') {
  let m;
  if ((m = /^(white|pink|hum50)-snr(\d+)$/.exec(name))) return { pcm: addNoise(pcm, { kind: m[1], snrDb: Number(m[2]), sampleRate, seed }), sampleRate };
  if ((m = /^rate(\d+)$/.exec(name))) return { pcm: convertRate(pcm, sampleRate, Number(m[1])), sampleRate: Number(m[1]) };
  switch (name) {
    case 'clip': return { pcm: clipping(pcm), sampleRate };
    case 'quiet': return { pcm: lowVolume(pcm), sampleRate };
    case 'dropout': return { pcm: dropouts(pcm, { sampleRate, seed }), sampleRate };
    case 'dc': return { pcm: dcOffset(pcm), sampleRate };
    case 'longsilence': return { pcm: longSilence(pcm, { sampleRate }), sampleRate };
    default: throw new Error('unknown degradation ' + name);
  }
}

export const DEGRADATIONS = [
  ...['white', 'pink', 'hum50'].flatMap((k) => [30, 20, 10, 0].map((s) => `${k}-snr${s}`)),
  'clip', 'quiet', 'rate8000', 'rate16000', 'rate44100', 'dropout', 'dc', 'longsilence',
];

/** こもった音：1 次のローパスを段重ねにする（既定 2500Hz、4 段）。DEGRADATIONS の一覧には入れない（実際の部屋の音の見本用）。 */
export function muffle(pcm, { cutoffHz = 2500, stages = 4, sampleRate = 48000 } = {}) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const x = Float64Array.from(pcm);
  for (let s = 0; s < stages; s++) {
    let y = 0;
    for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  }
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < out.length; i++) out[i] = clip16(roundHalfEven(x[i]));
  return out;
}

/**
 * 話している部分（ranges：[start,end) のサンプル）の実効値に対して、信号対雑音比が snrDb になるように、ピンクノイズと 50Hz のうなりを足す。
 * 雑音の電力の 90% がピンクノイズ、10% がうなり。
 */
export function addRoomNoise(pcm, ranges, { snrDb = 12, sampleRate = 48000, seed = 'room' } = {}) {
  let s = 0;
  let n = 0;
  for (const [a, b] of ranges) for (let i = a; i < b && i < pcm.length; i++) { s += pcm[i] * pcm[i]; n++; }
  const sigRms = Math.sqrt(s / (n || 1));
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const pink = noiseUnit('pink', pcm.length, sampleRate, `${seed}:pink`);
  const hum = noiseUnit('hum50', pcm.length, sampleRate, `${seed}:hum`);
  const gp = Math.sqrt(0.9) * noiseRms;
  const gh = Math.sqrt(0.1) * noiseRms;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = clip16(roundHalfEven(pcm[i] + pink[i] * gp + hum[i] * gh));
  return { pcm: out, sigRms, noiseRms };
}
