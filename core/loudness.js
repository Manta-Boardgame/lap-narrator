// Mono, 48 kHz. K weighting and gating follow Annex 1 of ITU-R BS.1770-5.
// The four-phase interpolator follows Annex 2 (coefficients in Q13).
// https://www.itu.int/rec/R-REC-BS.1770-5-202311-I
const SHELF = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const HIGH_PASS = [1, -2, 1, -1.99004745483398, 0.99007225036621];
const PHASE_0 = [14, 90, -161, 272, -487, 1125, 7964, -838, 390, -218, 122, -68];
const PHASE_1 = [-239, 240, -424, 730, -1364, 3810, 6388, -1641, 832, -477, 271, -155];
const STEP = 4800;
const PCM_SCALE = 32768;
const CALIBRATION = -0.691;
const ABSOLUTE_GATE = 1.1724653045822981e-7; // linear power at -70 LUFS
const LOG10_2 = 0.3010299956639812;
const TWO_OVER_LN10 = 0.8685889638065036;

// Reduce to [1, 2) before using the atanh series, where |z| <= 1/3.
// A fixed number of terms gives sub-nanodecibel error over the meter's range.
function log10(value) {
  if (value === 0) return -Infinity;
  let exponent = 0;
  while (value < 1) { value *= 2; exponent--; }
  while (value >= 2) { value /= 2; exponent++; }
  const z = (value - 1) / (value + 1);
  const z2 = z * z;
  let term = z;
  let sum = z;
  for (let i = 3; i <= 31; i += 2) {
    term *= z2;
    sum += term / i;
  }
  return exponent * LOG10_2 + sum * TWO_OVER_LN10;
}

function biquad([b0, b1, b2, a1, a2]) {
  let z1 = 0;
  let z2 = 0;
  return (sample) => {
    const y = b0 * sample + z1;
    z1 = b1 * sample - a1 * y + z2;
    z2 = b2 * sample - a2 * y;
    return y;
  };
}

/** @param {number} sampleRate @returns {{push(i16: Int16Array): void, integratedLufs(): number, truePeakDb(): number}} */
export function createLoudnessMeter(sampleRate) {
  if (sampleRate !== 48000) throw new RangeError('loudness measurement requires 48000 Hz mono PCM');
  const shelf = biquad(SHELF);
  const highPass = biquad(HIGH_PASS);
  const stepEnergies = new Float64Array(4);
  const blocks = [];
  let partialEnergy = 0;
  let partialLength = 0;
  let steps = 0;

  // Mirrored ring so both FIR directions read contiguous values without modulo in the tap loop.
  const pcm = new Int16Array(24);
  let cursor = 0;
  let peak = 0;
  function oversampledPeak(at, window) {
    let a = 0;
    let b = 0;
    let c = 0;
    let d = 0;
    for (let i = 0; i < 12; i++) {
      const x = window[at + i];
      a += x * PHASE_0[i];
      b += x * PHASE_1[i];
      c += x * PHASE_1[11 - i];
      d += x * PHASE_0[11 - i];
    }
    return Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) / 8192;
  }
  return {
    push(i16) {
      for (const x of i16) {
        const filtered = highPass(shelf(x / PCM_SCALE));
        partialEnergy += filtered * filtered;
        if (++partialLength === STEP) {
          stepEnergies[steps++ % 4] = partialEnergy;
          if (steps >= 4) blocks.push((stepEnergies[0] + stepEnergies[1] + stepEnergies[2] + stepEnergies[3]) / (4 * STEP));
          partialEnergy = 0;
          partialLength = 0;
        }
        pcm[cursor] = pcm[cursor + 12] = x;
        cursor = (cursor + 1) % 12;
        peak = Math.max(peak, Math.abs(x), oversampledPeak(cursor, pcm));
      }
    },
    integratedLufs() {
      const gatedMean = (gate) => {
        let energy = 0;
        let count = 0;
        for (const block of blocks) {
          if (block > gate) { energy += block; count++; }
        }
        return count ? energy / count : 0;
      };
      const relativeGate = gatedMean(ABSOLUTE_GATE) / 10;
      return CALIBRATION + 10 * log10(gatedMean(Math.max(ABSOLUTE_GATE, relativeGate)));
    },
    truePeakDb() {
      // Flush the FIR tail on a copy so this observation never changes later streaming results.
      const tail = pcm.slice();
      let at = cursor;
      let max = peak;
      for (let i = 0; i < 11; i++) {
        tail[at] = tail[at + 12] = 0;
        at = (at + 1) % 12;
        max = Math.max(max, oversampledPeak(at, tail));
      }
      return 20 * log10(max / PCM_SCALE);
    },
  };
}
