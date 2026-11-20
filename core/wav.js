// WAV（CONTRACTS.md 0.5, 0.6）。PCM 16 ビット、モノラル、44 バイトの標準ヘッダーだけ。

const HEADER_BYTES = 44;
const MAX_WAV_BYTES = 0xffffffff - 1; // 2^32 - 2。「2^32 - 1 バイト未満」

/**
 * 44 バイトの標準ヘッダー（RIFF、`fmt ` 16 バイト、`data`）。追加チャンクも時刻も入れない。
 * 全体（44 + samples*2）が 2^32 - 1 バイト未満でなければ RangeError。
 * @param {{sampleRate:number, samples:number}} p
 * @returns {Uint8Array}
 */
export function wavHeader(p) {
  const { sampleRate, samples } = p;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0x7fffffff) {
    throw new RangeError(`wavHeader: bad sampleRate ${sampleRate}`);
  }
  if (!Number.isInteger(samples) || samples < 0) throw new RangeError(`wavHeader: bad samples ${samples}`);
  const dataBytes = samples * 2;
  if (HEADER_BYTES + dataBytes > MAX_WAV_BYTES) {
    throw new RangeError(`wavHeader: ${samples} samples do not fit in one WAV (use planWavParts)`);
  }
  const u8 = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(u8.buffer);
  u8.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  dv.setUint32(4, 36 + dataBytes, true);
  u8.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  u8.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // モノラル
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byteRate（sampleRate <= 2^31 - 1 に制限しているので収まる）
  dv.setUint16(32, 2, true); // blockAlign
  dv.setUint16(34, 16, true);
  u8.set([0x64, 0x61, 0x74, 0x61], 36); // data
  dv.setUint32(40, dataBytes, true);
  return u8;
}

/**
 * WAV のヘッダーを読む。`fmt ` と `data` チャンクを探すので、追加チャンクのある WAV も読める（読むだけ。
 * このツールが書く WAV は標準ヘッダーだけ）。PCM（形式 1）以外は Error（`code: 'unsupported-wav'`）。
 * `u8` は先頭から `data` チャンクの見出しまでを含んでいればよい（全体でなくてよい）。
 * 戻り値の `samples` は、ヘッダーの `data` の大きさから求めた値（ファイルの実際の大きさとは照合しない）。
 * @param {Uint8Array} u8
 * @returns {{sampleRate:number, channels:number, bits:number, samples:number, dataOffset:number}}
 */
export function parseWavHeader(u8) {
  const bad = (msg) => Object.assign(new Error(`parseWavHeader: ${msg}`), { code: 'unsupported-wav' });
  if (!(u8 instanceof Uint8Array)) throw new TypeError('parseWavHeader: expected Uint8Array');
  if (u8.length < 12) throw bad('too short');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw bad('not a RIFF/WAVE file');
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= u8.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > u8.length) throw bad('bad fmt chunk');
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw bad('data chunk before fmt chunk');
      if (fmt.format !== 1) throw bad(`not PCM (format ${fmt.format})`);
      if (fmt.channels < 1 || fmt.bits < 8 || fmt.bits % 8 !== 0) throw bad('bad fmt values');
      const frameBytes = fmt.channels * (fmt.bits / 8);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bits: fmt.bits,
        samples: Math.floor(size / frameBytes),
        dataOffset: body,
      };
    }
    pos = body + size + (size & 1); // チャンクは偶数境界
  }
  throw bad(fmt ? 'no data chunk' : 'no fmt chunk');
}

/**
 * 長い音声を、WAV 1 つの大きさの上限以下の順序付きのパートに分ける（CONTRACTS.md 0.6）。
 * 先頭から上限いっぱいに詰め、最後のパートに端数を入れる。各パートの WAV の大きさ（44 + 2*サンプル数）は
 * `maxBytes` 以下、かつ 2^32 - 1 バイト未満。`totalSamples` が 0 のときは空配列（音声がないので WAV を作らない）。
 * @param {number} totalSamples
 * @param {number} maxBytes
 * @returns {number[]} 各パートのサンプル数（合計 = totalSamples）
 */
export function planWavParts(totalSamples, maxBytes) {
  if (!Number.isInteger(totalSamples) || totalSamples < 0) throw new RangeError(`planWavParts: bad totalSamples ${totalSamples}`);
  if (!Number.isFinite(maxBytes) || maxBytes < HEADER_BYTES + 2) throw new RangeError(`planWavParts: maxBytes too small (${maxBytes})`);
  const cap = Math.min(Math.floor(maxBytes), MAX_WAV_BYTES);
  const perPart = Math.floor((cap - HEADER_BYTES) / 2);
  const parts = [];
  let left = totalSamples;
  while (left > 0) {
    const n = Math.min(left, perPart);
    parts.push(n);
    left -= n;
  }
  return parts;
}
