// Optional PC output processing, kept separate from the bit-exact version 1 render.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createLoudnessMeter, createSha256, parseWavHeader } from '../../core/index.js';
import { CliError, usageError } from './errors.js';
import { openAtomicWrite, readRange } from './fsutil.js';
import { createLookaheadProfile } from './lookahead-limiter.js';

const RATE = 48000;
const PCM_SCALE = 32768;
const toNumber = (value) => Number.isFinite(value) ? value : null;

export function levelOptions(opts) {
  function parse(name, min, max) {
    if (opts[name] === undefined) return null;
    const n = Number(opts[name]);
    if (!opts[name].trim() || !Number.isFinite(n) || n < min || n > max) {
      throw usageError(`--${name} needs a number from ${min} to ${max}`);
    }
    return n;
  }
  const targetLufs = parse('target-lufs', -40, -5);
  const ceilingDb = parse('ceiling-db', -20, -0.1);
  const lookaheadLimiter = opts['lookahead-limiter'] === true;
  return targetLufs === null && ceilingDb === null && !lookaheadLimiter
    ? null : { targetLufs, ceilingDb: ceilingDb ?? -1.5, lookaheadLimiter };
}

async function readPcm(file, part, onPcm, onHeader = async () => {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const header = await readRange(fh, 0, Math.min(4096, size));
    const info = parseWavHeader(header);
    const end = info.dataOffset + info.samples * 2;
    if (info.sampleRate !== RATE || info.channels !== 1 || info.bits !== 16 || part.samples !== info.samples || end > size) {
      throw new CliError('level-unsupported-audio', `cannot level ${part.file}: expected intact 48 kHz mono PCM16`);
    }
    await onHeader(header.subarray(0, info.dataOffset));
    for (let from = info.dataOffset; from < end; from += 128 * 1024) {
      const bytes = await readRange(fh, from, Math.min(end, from + 128 * 1024));
      await onPcm(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
    }
    // Preserve optional RIFF chunks after PCM instead of shifting or removing them.
    if (end < size) {
      for (let from = end; from < size; from += 128 * 1024) {
        await onHeader(await readRange(fh, from, Math.min(size, from + 128 * 1024)));
      }
    }
  } finally { await fh.close(); }
}

async function measure(outDir, finals, profile = null) {
  const meter = createLoudnessMeter(RATE);
  let clipPeakDb = -Infinity;
  for (const f of finals) {
    const clipMeter = finals.length > 1 ? createLoudnessMeter(RATE) : null;
    for (const part of f.parts) {
      await readPcm(path.join(outDir, part.file), part, (pcm) => {
        meter.push(pcm);
        clipMeter?.push(pcm);
        profile?.push(pcm);
      });
    }
    if (clipMeter) clipPeakDb = Math.max(clipPeakDb, clipMeter.truePeakDb());
  }
  return { lufs: meter.integratedLufs(), truePeakDb: Math.max(clipPeakDb, meter.truePeakDb()) };
}

async function rewritePart(file, part, transform) {
  const writer = await openAtomicWrite(file);
  const hash = createSha256();
  const write = async (bytes) => { hash.update(bytes); await writer.write(bytes); };
  try {
    await readPcm(file, part, async (pcm) => {
      transform(pcm);
      await write(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }, write);
    await writer.commit();
    part.sha256 = hash.digestHex();
  } catch (e) {
    await writer.abort();
    throw e;
  }
}

async function applyTransform(outDir, finals, transform) {
  for (const f of finals) {
    for (const part of f.parts) await rewritePart(path.join(outDir, part.file), part, transform);
  }
}

function constantGain(gainDb) {
  const gain = 10 ** (gainDb / 20);
  return (pcm) => {
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(pcm[i] * gain);
  };
}

export async function levelOutput({ ctx, outDir, finals, options, continuous = false }) {
  const { targetLufs, ceilingDb, lookaheadLimiter } = options;
  const results = [];
  for (const group of continuous ? [finals] : finals.map((f) => [f])) {
    const slideIds = group.map((f) => f.slideId);
    ctx.progress('measure-loudness', results.length, continuous ? 1 : finals.length);
    const profile = lookaheadLimiter ? createLookaheadProfile() : null;
    const input = await measure(outDir, group, profile);
    const targetGainDb = targetLufs !== null && Number.isFinite(input.lufs) ? targetLufs - input.lufs : 0;
    // Reserve two PCM steps for rounding error through the oversampling filter.
    const peakBound = 20 * Math.log10(10 ** (ceilingDb / 20) - 2 / PCM_SCALE);
    const gainDb = lookaheadLimiter ? targetGainDb : Math.min(targetGainDb, peakBound - input.truePeakDb);
    let output = input;
    let peakLimited = gainDb < targetGainDb;
    let limiter;
    if (profile) {
      const curve = profile.gainCurve(peakBound, targetGainDb);
      const minimumGainDb = 20 * Math.log10(curve.minimum);
      let postGainDb = 0;
      peakLimited = minimumGainDb < targetGainDb - 1e-9;
      if (peakLimited || targetGainDb !== 0) {
        await applyTransform(outDir, group, curve.apply);
        output = await measure(outDir, group);
      }
      // Time-varying gain can change inter-sample peaks. Verify the quantized
      // output and apply a constant safety trim if a reconstructed peak crossed.
      if (output.truePeakDb > ceilingDb) {
        postGainDb = peakBound - output.truePeakDb;
        await applyTransform(outDir, group, constantGain(postGainDb));
        output = await measure(outDir, group);
        peakLimited = true;
      }
      limiter = { mode: 'lookahead', minimumGainDb, postGainDb };
    } else if (gainDb !== 0) {
      await applyTransform(outDir, group, constantGain(gainDb));
      output = await measure(outDir, group);
    }
    if (targetLufs !== null && (!Number.isFinite(output.lufs) || Math.abs(output.lufs - targetLufs) > 0.2)) {
      ctx.warn('loudness-target-unmet', 'the rendered audio did not reach the requested loudness', {
        slides: slideIds, targetLufs, measuredLufs: toNumber(output.lufs), peakLimited,
      });
    }
    if (output.truePeakDb > ceilingDb) {
      throw new CliError('true-peak-ceiling-exceeded', 'the leveled PCM exceeds the requested true-peak ceiling', {
        detail: { slides: slideIds, ceilingDb, truePeakDb: output.truePeakDb },
      });
    }
    results.push({
      slideIds, targetLufs, ceilingDb, gainDb, peakLimited,
      ...(limiter ? { limiter } : {}),
      inputLufs: toNumber(input.lufs), inputTruePeakDb: toNumber(input.truePeakDb),
      lufs: toNumber(output.lufs), truePeakDb: toNumber(output.truePeakDb),
    });
  }
  ctx.progress('measure-loudness', results.length, results.length);
  return results;
}
