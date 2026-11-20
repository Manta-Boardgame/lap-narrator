import { createLoudnessMeter } from '../../core/loudness.js';

const RATE = 48000;
const BLOCK = 240;
const HALO = 11; // Next/previous input samples that can share a 12-tap interpolation window.
const RELEASE = 1 - Math.exp(-BLOCK / (RATE * 0.05));

export function createLookaheadProfile() {
  let previous = new Int16Array(0);
  let current = null;
  let pending = new Int16Array(BLOCK);
  let count = 0;
  const peaks = [];

  function measure(block, following) {
    const meter = createLoudnessMeter(RATE);
    meter.push(previous);
    meter.push(block);
    meter.push(following.subarray(0, HALO));
    peaks.push(meter.truePeakDb());
    previous = block.subarray(Math.max(0, block.length - HALO));
  }

  return {
    push(pcm) {
      for (let offset = 0; offset < pcm.length;) {
        const n = Math.min(BLOCK - count, pcm.length - offset);
        pending.set(pcm.subarray(offset, offset + n), count);
        count += n;
        offset += n;
        if (count === BLOCK) {
          if (current) measure(current, pending);
          current = pending;
          pending = new Int16Array(BLOCK);
          count = 0;
        }
      }
    },
    gainCurve(peakBoundDb, requestedGainDb) {
      const tail = pending.subarray(0, count);
      if (current) measure(current, tail);
      if (count) measure(tail, pending.subarray(0, 0));
      const desired = 10 ** (requestedGainDb / 20);
      const limits = peaks.map((peakDb) => 10 ** (Math.min(requestedGainDb, peakBoundDb - peakDb) / 20));
      let minimum = desired;
      for (const limit of limits) minimum = Math.min(minimum, limit);

      let block = 0;
      let position = 0;
      let start = limits[0] ?? desired;
      let end = start;
      const setEnd = () => {
        const released = start + (desired - start) * RELEASE;
        end = Math.min(limits[block] ?? desired, limits[block + 1] ?? desired, released);
      };
      setEnd();
      return {
        minimum,
        apply(pcm) {
          for (let i = 0; i < pcm.length; i++) {
            pcm[i] = Math.round(pcm[i] * (start + (end - start) * position / BLOCK));
            if (++position === BLOCK) {
              position = 0;
              block++;
              start = end;
              setEnd();
            }
          }
        },
      };
    },
  };
}
