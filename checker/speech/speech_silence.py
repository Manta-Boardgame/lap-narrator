"""Silence finding on a short region of a WAV (RMS in 10 ms frames, adaptive threshold).

Faster-whisper word times are only good to some tens of milliseconds (and it often stretches a word's end over the
following pause), so a slide boundary is placed in the middle of an actual quiet run found in the waveform.
Only a small region around the asked time is read, never the whole file.
"""
import sys
import os

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_common import read_samples  # noqa: E402

FRAME_S = 0.010
MIN_RUN_S = 0.05
MIN_CONTRAST_DB = 10.0
SMOOTH_FRAMES = 5      # moving average of the power over 50 ms: noisy backgrounds (SNR ~12 dB) otherwise break one pause into pieces
THR_FRAC = 0.4


def analyze(path, info, t0, t1, ctx=4.0):
    """Quiet runs overlapping [t0, t1] (seconds). The noise floor and speech level are estimated on [t0-ctx, t1+ctx].
    Returns {"runs": [(start, end), ...], "thr": dB, "floor": dB, "peak": dB}. No runs when speech and background are
    not clearly different (contrast < 10 dB)."""
    rate = info["sampleRate"]
    dur = info["samples"] / rate
    a = max(0.0, t0 - ctx)
    b = min(dur, t1 + ctx)
    if b <= a:
        return {"runs": [], "thr": None, "floor": None, "peak": None}
    x = read_samples(path, info, int(a * rate), int((b - a) * rate))
    hop = max(1, int(round(rate * FRAME_S)))
    n = len(x) // hop
    if n < 10:
        return {"runs": [], "thr": None, "floor": None, "peak": None}
    f = x[: n * hop].astype(np.float32).reshape(n, hop)
    pw = (f * f).mean(axis=1)
    k = SMOOTH_FRAMES
    pw = np.convolve(np.pad(pw, (k // 2, k // 2), mode="edge"), np.ones(k) / k, mode="valid")[:n]
    rms = np.sqrt(pw)
    db = 20.0 * np.log10(rms / 32768.0 + 1e-6)
    floor = max(float(np.percentile(db, 5)), -90.0)
    peak = float(np.percentile(db, 95))
    if peak - floor < MIN_CONTRAST_DB:
        return {"runs": [], "thr": None, "floor": floor, "peak": peak}
    thr = floor + max(5.0, THR_FRAC * (peak - floor))
    quiet = db < thr
    runs = []
    i = 0
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            s, e = a + i * FRAME_S, a + j * FRAME_S
            if e - s >= MIN_RUN_S and e > t0 and s < t1:
                runs.append((s, e))
            i = j
        else:
            i += 1
    return {"runs": runs, "thr": thr, "floor": floor, "peak": peak}


def pick_cut(path, info, win0, win1, gap_lo, gap_hi, min_silence=0.2):
    """Choose the cut time inside [win0, win1]. Longest quiet run overlapping the window -> its midpoint
    (kind "silence"); if that run is shorter than min_silence (or there is none) -> the middle of the gap between the
    neighbouring words, [gap_lo, gap_hi] (kind "gap"). Returns (cut_sec, run_len_sec, kind)."""
    r = analyze(path, info, win0, win1)
    best = None
    for s, e in r["runs"]:
        if best is None or (e - s) > (best[1] - best[0]):
            best = (s, e)
    if best is not None and best[1] - best[0] >= min_silence:
        return (best[0] + best[1]) / 2.0, best[1] - best[0], "silence"
    lo, hi = gap_lo, gap_hi
    mid = (lo + hi) / 2.0
    run_len = (best[1] - best[0]) if best is not None else 0.0
    if best is not None and best[0] <= mid <= best[1]:
        mid = (best[0] + best[1]) / 2.0
    return mid, run_len, "gap"


def snap_point(path, info, at_sec, radius=1.0, min_silence=0.2):
    """For `boundary set`: the midpoint of the quiet run nearest to at_sec within +-radius (kind "silence"),
    or at_sec itself (kind "none") when there is no quiet run of at least min_silence there."""
    r = analyze(path, info, at_sec - radius, at_sec + radius)
    best = None
    bd = None
    for s, e in r["runs"]:
        if e - s < min_silence:
            continue
        d = 0.0 if s <= at_sec <= e else min(abs(at_sec - s), abs(at_sec - e))
        if d <= radius and (bd is None or d < bd):
            best, bd = (s, e), d
    if best is None:
        return at_sec, 0.0, "none"
    return (best[0] + best[1]) / 2.0, best[1] - best[0], "silence"


def snap_directional(path, info, t, direction, max_dist=1.5, min_silence=0.2):
    """For `boundary set --at-text`: the first quiet run (>= min_silence) after t (direction "after": a run that ends after t-0.15
    and starts before t+max_dist) or before t (direction "before"). Returns (sec, run_len, kind) with kind "silence" or "none"
    (then sec is t itself)."""
    if direction == "after":
        r = analyze(path, info, t - 0.5, t + max_dist)
        for s, e in sorted(r["runs"]):
            if e - s >= min_silence and e > t - 0.15 and s < t + max_dist:
                return (s + e) / 2.0, e - s, "silence"
    else:
        r = analyze(path, info, t - max_dist, t + 0.5)
        for s, e in sorted(r["runs"], reverse=True):
            if e - s >= min_silence and s < t + 0.15 and e > t - max_dist:
                return (s + e) / 2.0, e - s, "silence"
    return t, 0.0, "none"
