#!/usr/bin/env python
"""verify: measure when pictures switch and when audio starts in an MP4 and compare with timeline.json.

  .venv\\Scripts\\python.exe -I checker/video/verify.py --video <mp4> --timeline <timeline.json>
        [--method A|B] [--tolerance-audio-ms N] [--tolerance-show-ms N] [--out result.json]

Prints one JSON object (the `result` of CONTRACTS section 4) on stdout:
  { "method", "toleranceMs": {audio, show},
    "slides": [ { slideId,
                  expected: {showStart, audioStart}          (samples, as in the timeline)
                  expectedMs: {showStartMs, audioStartMs},
                  measured: {showStartMs|null, audioStartMs|null},
                  diffMs: {show|null, audio|null},            (measured - expected, + = late)
                  status: "ok"|"out-of-tolerance"|"unmeasurable",
                  detail: {show, audio}, reasons: [...],
                  audioMethod: "cue"|"xcorr"|null, corr: number|null } ],
    "totalMs", "expectedTotalMs", "totalDiffMs",
    "pass", "counts": {ok, outOfTolerance, unmeasurable},
    "video": {...}, "audio": {present, sampleRate, durationMs, gaps[], silentRuns[]} }

How it measures (no knowledge of how the video was made):
  * Picture: every frame is shrunk to 32x18 RGB (area average). Each slide's PNG is shrunk the same
    way. A frame is assigned to the nearest slide picture (mean absolute difference <= 40). A slide's
    picture start = pts of the first frame assigned to it after the previous slide's start. If two
    neighbouring slide pictures are nearly identical (< 12) the boundary is "unmeasurable".
  * Audio: each slide WAV is a tone of its own frequency (found by FFT of the WAV's first 0.2 s).
    The decoded audio is demodulated at that frequency; the onset is where the 5 ms moving-average
    envelope crosses 50 % of its plateau, minus half the window (exact for a hard onset). A WAV that
    is not a clean tone (speech, room noise) is measured with the cross-correlation below.
  * Audio, cross-correlation (audioMethod "xcorr"): the first 6 s of the slide's own WAV (timeline
    `audio`, first part) is converted to the rate of the decoded MP4 audio and slid over the decoded audio
    (mono) in expected +- 1 s (a second pass over +- 6 s if the peak sits at the edge or is weak). The
    peak of the normalized cross-correlation (parabolic interpolation, sub-sample) gives the start of the
    slide's audio in the video; `corr` is the peak value. Only the needed range is read for each slide.
    corr below XC_MIN_CORR is "unmeasurable" (reason low-correlation, or too-quiet when the WAV itself is
    almost silent). A loud WAV with digital silence in the video at its expected place is "missing".
  * A slide that should be measurable but is not found in the video is reported as "out-of-tolerance"
    with a null difference and detail "missing" (that is a failure, not an ambiguity).
  * Audio coverage: find the last audible window of each slide's WAV (including split WAVs) and check
    that the corresponding decoded interval exists and is not silent. Source silence and post-pad
    are not required to be present in the audio stream.

Tolerances (design 8.4): method B audio 20 ms, picture 1 frame; method A 50 ms (target) for both.
The numbers are never relaxed here: the measured values are reported as they are.

Exit code: 0 no slide out of tolerance, 3 some slide out of tolerance, 1 the video/timeline could not be read.
"""
import argparse
import json
import os
import sys
import wave

import numpy as np
import av

SIG_W, SIG_H = 32, 18
PIC_MATCH_MAX = 40.0      # mean abs diff (0..255) to accept "this frame shows that slide"
PIC_DISTINCT_MIN = 12.0   # neighbouring slide pictures closer than this cannot be told apart
TONE_WINDOW_S = 0.2
TONE_MIN_PURITY = 0.5
TONE_MIN_SEPARATION_HZ = 150.0
TONE_MIN_HZ = 50.0        # below this the "tone" is rumble (e.g. a boosted 15-25 Hz drift), not a cue tone: use xcorr instead
XC_REF_S = 6.0            # length of the WAV head used as the template
XC_SEARCH_S = 1.0         # first search range around the expected start
XC_MIN_CORR = 0.5         # peak normalized correlation needed to accept a position (see D-003 for why)
XC_QUIET_RMS = 1e-4       # WAV head RMS (full scale 1.0) below this is "too quiet" (about 3 LSB of 16 bit)
XC_WINDOW_FLOOR_RMS = 1e-6  # windows with less RMS than this are ignored by the correlation (divide by ~0)
XC_SILENT_RMS = 1e-5      # RMS of the video at the expected place below this (< 1 LSB of 16 bit) is digital silence
SEARCH_S = 6.0            # audio onset is searched in expected +- this many seconds
GAP_MIN_MS = 2.0
SILENCE_MIN_MS = 1000.0
SILENCE_RMS = 1e-3
TAIL_WINDOW_S = 0.04
TAIL_SEARCH_PAD_S = 0.04    # allow codec/resampling and frame alignment at the end of the slide


class VerifyError(Exception):
    pass


# ----------------------------------------------------------------------------- pictures

def signature_from_rgb(rgb, fit=False):
    """32x18 float signature of an RGB uint8 array (H, W, 3). With fit=True the picture is
    scaled to fit inside 16:9 (black bars) first, like the builders do."""
    h, w, _ = rgb.shape
    vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
    if not fit or abs(w * 9 - h * 16) <= 16:
        small = vf.reformat(width=SIG_W, height=SIG_H, format="rgb24", interpolation="AREA").to_ndarray()
        return small.astype(np.float32)
    scale = min(SIG_W / w, SIG_H / h)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    small = vf.reformat(width=nw, height=nh, format="rgb24", interpolation="AREA").to_ndarray()
    canvas = np.zeros((SIG_H, SIG_W, 3), dtype=np.uint8)
    y0 = (SIG_H - nh) // 2
    x0 = (SIG_W - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = small
    return canvas.astype(np.float32)


def load_png_signature(path):
    c = av.open(path)
    try:
        fr = next(c.decode(video=0))
        rgb = fr.to_ndarray(format="rgb24")
    finally:
        c.close()
    return signature_from_rgb(rgb, fit=True)


def sig_distance(a, b):
    return float(np.mean(np.abs(a - b)))


def source_colorspace(fr):
    """The colour matrix to decode a frame with. Untagged HD video is treated as BT.709 (what players
    do); PowerPoint writes untagged files, and decoding them as BT.601 shifts the colours."""
    cs_enum = av.video.reformatter.Colorspace
    try:
        tag = int(fr.colorspace)
    except Exception:  # noqa: BLE001
        tag = 2
    if tag in (1, 4, 5, 7, 9):
        return cs_enum(tag)
    return cs_enum.ITU709 if fr.height >= 720 else cs_enum.ITU601


def read_video_signatures(container):
    """Returns (list of (ptsMs, signature)), info dict."""
    vs = container.streams.video[0]
    try:
        vs.thread_type = "AUTO"
    except Exception:  # noqa: BLE001
        pass
    frames = []
    last_ms = None
    for fr in container.decode(vs):
        if fr.pts is None:
            continue
        ms = float(fr.pts * fr.time_base) * 1000.0
        small = fr.reformat(width=SIG_W, height=SIG_H, format="rgb24", interpolation="AREA",
                            src_colorspace=source_colorspace(fr)).to_ndarray()
        frames.append((ms, small.astype(np.float32)))
        last_ms = ms
    fps = float(vs.average_rate) if vs.average_rate else None
    info = {
        "codec": vs.codec_context.name, "width": vs.codec_context.width, "height": vs.codec_context.height,
        "pixFmt": vs.codec_context.pix_fmt, "fps": fps, "frames": len(frames),
        "startMs": (float(vs.start_time * vs.time_base) * 1000.0) if vs.start_time is not None else None,
    }
    return frames, info, last_ms


def measure_pictures(frames, refs, fps):
    """refs: list of signatures (one per slide, in order). Returns list of (startMs|None, reason|None)."""
    n = len(refs)
    out = [(None, None)] * n
    if not frames:
        return [(None, "no-video-frames")] * n
    sigs = np.stack([s for _, s in frames])            # (F, H, W, 3)
    flat = sigs.reshape(len(frames), -1)
    refflat = np.stack([r.reshape(-1) for r in refs])  # (N, D)
    # mean abs diff, frames x slides
    dist = np.empty((len(frames), n), dtype=np.float32)
    for j in range(n):
        dist[:, j] = np.mean(np.abs(flat - refflat[j]), axis=1)
    nearest = np.argmin(dist, axis=1)
    nearest_d = dist[np.arange(len(frames)), nearest]
    cls = np.where(nearest_d <= PIC_MATCH_MAX, nearest, -1)
    prev_idx = -1
    for i in range(n):
        if i > 0 and sig_distance(refs[i], refs[i - 1]) < PIC_DISTINCT_MIN:
            out[i] = (None, "same-picture-as-previous-slide")
            # keep the cursor where the previous slide's picture is still on screen
            continue
        hit = None
        for f in range(prev_idx + 1, len(frames)):
            if cls[f] == i:
                hit = f
                break
        if hit is None:
            out[i] = (None, "picture-not-found")
        else:
            out[i] = (frames[hit][0], None)
            prev_idx = hit
    return out


# ----------------------------------------------------------------------------- audio

def frame_to_mono_float(fr):
    arr = fr.to_ndarray()
    layout = fr.layout.nb_channels
    fmt = fr.format
    if fmt.is_planar:
        mono = arr.astype(np.float64).mean(axis=0) if arr.ndim == 2 else arr.astype(np.float64)
    else:
        a = arr.reshape(-1)
        mono = a.reshape(-1, layout).astype(np.float64).mean(axis=1) if layout > 1 else a.astype(np.float64)
    name = fmt.name
    if name.startswith("s16"):
        mono /= 32768.0
    elif name.startswith("s32"):
        mono /= 2147483648.0
    elif name.startswith("u8"):
        mono = (mono - 128.0) / 128.0
    return mono.astype(np.float32)


def read_audio(container):
    """Decode the first audio stream. Returns (samples float32 mono, rate, info).

    The samples are kept in decode order (sample counting). A hole is inserted only where the container's
    timestamps jump forward by more than GAP_MIN_MS (a real gap). Smaller timestamp jitter, and a steady
    stretch of the timestamps against the sample count (PowerPoint's AAC track runs about 0.1 % slow:
    packets are stamped ~1025 samples apart), are NOT turned into zeros (that would corrupt the waveform
    and the correlation); they are kept in info["_map"] = (count_index, pts_minus_count) and applied to
    the measured positions by to_pts_ms(), so positions are in the container's time (what a player syncs
    to the picture with). info["ptsDriftMs"] is how far the timestamps ran ahead of the sample count."""
    if not container.streams.audio:
        return None, None, {"present": False}
    st = container.streams.audio[0]
    rate = st.codec_context.sample_rate
    tol = GAP_MIN_MS * rate / 1000.0
    pieces = []
    gaps = []
    count = 0
    prev_end = 0                      # end of the previous frame in timestamp samples
    map_c = []
    map_o = []
    for fr in container.decode(st):
        mono = frame_to_mono_float(fr)
        if fr.pts is not None:
            idx = int(round(float(fr.pts * fr.time_base) * rate))
        else:
            idx = prev_end
        if idx < 0:
            mono = mono[-idx:]
            idx = 0
        jump = idx - prev_end
        if jump > tol:
            gaps.append({"atMs": count * 1000.0 / rate, "lengthMs": jump * 1000.0 / rate})
            pieces.append(np.zeros(jump, dtype=np.float32))
            count += jump
        map_c.append(count)
        map_o.append(idx - count)
        pieces.append(mono)
        count += len(mono)
        prev_end = max(prev_end, idx + len(mono))
    x = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    info = {
        "present": True, "sampleRate": rate, "channels": st.codec_context.layout.nb_channels,
        "codec": st.codec_context.name, "durationMs": prev_end * 1000.0 / rate, "gaps": gaps,
        "sampleCountMs": count * 1000.0 / rate,
        "ptsDriftMs": (prev_end - count) * 1000.0 / rate,
        "startMs": (float(st.start_time * st.time_base) * 1000.0) if st.start_time is not None else None,
        "_map": (np.asarray(map_c, dtype=np.float64), np.asarray(map_o, dtype=np.float64)),
    }
    return x, rate, info


def to_pts_ms(ms, rate, tsmap):
    """Convert a position measured on the sample-counted audio (ms) to the container's time (ms)."""
    if tsmap is None or len(tsmap[0]) == 0:
        return ms
    off = float(np.interp(ms * rate / 1000.0, tsmap[0], tsmap[1]))
    return ms + off * 1000.0 / rate


def from_pts_ms(ms, rate, tsmap):
    """Inverse of to_pts_ms (first order; used only to centre a search window)."""
    if tsmap is None or len(tsmap[0]) == 0:
        return ms
    off = float(np.interp(ms * rate / 1000.0, tsmap[0], tsmap[1]))
    return ms - off * 1000.0 / rate


def silent_runs(x, rate):
    hop = max(1, int(rate * 0.01))
    n = len(x) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(x[:n * hop].reshape(n, hop).astype(np.float64) ** 2, axis=1))
    quiet = rms < SILENCE_RMS
    runs = []
    start = None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        if (not q or i == n - 1) and start is not None:
            end = i + 1 if q else i
            if (end - start) * 10.0 >= SILENCE_MIN_MS:
                runs.append({"startMs": start * 10.0, "endMs": end * 10.0})
            start = None
    return runs


def wav_tone(path):
    """Return (hz, purity) of the first 0.2 s of a WAV, or (None, reason)."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            sw = w.getsampwidth()
            if sw != 2:
                return None, "wav-not-16bit"
            n = min(w.getnframes(), int(rate * TONE_WINDOW_S))
            raw = w.readframes(n)
    except (wave.Error, OSError, EOFError) as e:
        return None, "wav-unreadable: %s" % e
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if len(x) < 256 or np.max(np.abs(x)) < 100:
        return None, "wav-too-short-or-silent"
    win = np.hanning(len(x))
    spec = np.abs(np.fft.rfft(x * win)) ** 2
    spec[0] = 0.0
    k = int(np.argmax(spec))
    lo, hi = max(1, k - 3), min(len(spec), k + 4)
    purity = float(spec[lo:hi].sum() / max(spec.sum(), 1e-12))
    if purity < TONE_MIN_PURITY:
        return None, "wav-not-a-clean-tone"
    # parabolic interpolation on log magnitude
    if 1 <= k < len(spec) - 1 and spec[k - 1] > 0 and spec[k + 1] > 0:
        a, b, c = np.log(spec[k - 1]), np.log(spec[k]), np.log(spec[k + 1])
        d = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    else:
        d = 0.0
    hz = (k + d) * rate / len(x)
    if hz < TONE_MIN_HZ:
        return None, "wav-not-a-clean-tone"
    return float(hz), None


def tone_onset_ms(x, rate, hz, expected_ms):
    """Onset time (ms) of a tone of `hz` near expected_ms, or (None, reason)."""
    a = max(0, int((expected_ms / 1000.0 - SEARCH_S) * rate))
    b = min(len(x), int((expected_ms / 1000.0 + SEARCH_S) * rate))
    w = int(round(rate / 200.0))
    if b - a < 4 * w:
        return None, "audio-too-short"
    seg = x[a:b].astype(np.float64)
    n = np.arange(a, b, dtype=np.float64)
    z = seg * np.exp(-2j * np.pi * hz * n / rate)
    c = np.concatenate([[0.0 + 0.0j], np.cumsum(z)])
    e = np.abs(c[w:] - c[:-w]) / w          # e[k] = |mean of z[k .. k+w-1]|
    plateau = float(e.max())
    if plateau < 0.01:                       # a full-scale tone gives 0.5; 0.01 is about -34 dB below
        return None, "tone-not-found"
    thr = 0.5 * plateau
    k = int(np.argmax(e > thr))
    if k == 0:
        # already above threshold at the start of the window: the tone began before the window
        return None, "tone-already-playing-at-search-start"
    e0, e1 = e[k - 1], e[k]
    frac = (thr - e0) / (e1 - e0) if e1 != e0 else 0.0
    k_cross = (k - 1) + frac
    t0 = a + k_cross + w / 2.0
    return t0 * 1000.0 / rate, None


# ----------------------------------------------------------------------------- audio, cross-correlation

def read_wav_head(path, seconds):
    """First `seconds` of a WAV as mono float64 in [-1, 1], plus its rate. (None, None, reason) on failure."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            sw = w.getsampwidth()
            if sw != 2:
                return None, None, "wav-not-16bit"
            n = min(w.getnframes(), int(rate * seconds))
            raw = w.readframes(n)
    except (wave.Error, OSError, EOFError) as e:
        return None, None, "wav-unreadable: %s" % e
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, rate, None


def resample_mono(a, src, dst):
    """Convert a mono float array from `src` to `dst` Hz with libswresample (delay-compensated)."""
    if src == dst or len(a) == 0:
        return a
    rs = av.AudioResampler(format="flt", layout="mono", rate=dst)
    fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(a.astype(np.float32).reshape(1, -1)),
                                    format="flt", layout="mono")
    fr.sample_rate = src
    parts = []
    for o in rs.resample(fr):
        parts.append(o.to_ndarray().reshape(-1))
    for o in rs.resample(None):
        parts.append(o.to_ndarray().reshape(-1))
    if not parts:
        return a[:0]
    return np.concatenate(parts).astype(np.float64)


def _ncc(seg, ref):
    """Normalized cross-correlation of `ref` against every start position of `seg` (both float64).
    Returns (position (float, sub-sample), peak corr, at_edge, window RMS at the peak)."""
    n_lag = len(seg) - len(ref) + 1
    n = 1
    while n < len(seg) + len(ref):
        n <<= 1
    cc = np.fft.irfft(np.fft.rfft(seg, n) * np.conj(np.fft.rfft(ref, n)), n)[:n_lag]
    csum = np.concatenate([[0.0], np.cumsum(seg * seg)])
    energy = np.maximum(csum[len(ref):len(ref) + n_lag] - csum[:n_lag], 0.0)
    floor = (XC_WINDOW_FLOOR_RMS ** 2) * len(ref)
    denom = float(np.linalg.norm(ref)) * np.sqrt(np.maximum(energy, floor))
    corr = cc / denom
    corr[energy < floor] = 0.0
    k = int(np.argmax(corr))
    pos = float(k)
    if 0 < k < len(corr) - 1:
        c0, c1, c2 = corr[k - 1], corr[k], corr[k + 1]
        d = c0 - 2 * c1 + c2
        if d < 0:
            pos = k + 0.5 * (c0 - c2) / d
    at_edge = k <= 2 or k >= len(corr) - 3
    return pos, float(corr[k]), at_edge, float(np.sqrt(energy[k] / len(ref)))


def xcorr_onset_ms(x, arate, wav_path, expected_ms):
    """Start (ms) of the slide's WAV inside the decoded audio x (rate arate), by normalized
    cross-correlation. The WAV head is the template at the WAV's own rate; the needed window of x is
    converted to that rate (a few seconds, never the whole audio).
    Returns (ms|None, corr|None, reason|None, kind) with kind "ok" | "unmeasurable" | "missing"."""
    ref, wrate, err = read_wav_head(wav_path, XC_REF_S)
    if ref is None:
        return None, None, err, "unmeasurable"
    if len(ref) < 256:
        return None, None, "wav-too-short", "unmeasurable"
    ref_rms = float(np.sqrt(np.mean(ref * ref)))
    if ref_rms < 1e-9:
        return None, None, "too-quiet", "unmeasurable"
    best = None
    for half_s in (XC_SEARCH_S, SEARCH_S):
        # window of x (native rate) that covers start positions expected +- half_s, padded with silence
        lo = int(round((expected_ms / 1000.0 - half_s) * arate))
        hi = int(round((expected_ms / 1000.0 + half_s + len(ref) / float(wrate)) * arate))
        seg = np.zeros(hi - lo, dtype=np.float64)
        a, b = max(lo, 0), min(hi, len(x))
        if b > a:
            seg[a - lo:b - lo] = x[a:b]
        seg_w = resample_mono(seg, arate, wrate)
        if len(seg_w) < len(ref) + 8:
            continue
        pos, corr, edge, wrms = _ncc(seg_w, ref)
        t_ms = (lo / float(arate) + pos / float(wrate)) * 1000.0
        if best is None or corr > best[1]:
            best = (t_ms, corr, edge, wrms)
        if corr >= XC_MIN_CORR and not edge:
            break
    if best is None:
        return None, None, "audio-too-short", "unmeasurable"
    t_ms, corr, edge, wrms = best
    corr_r = round(corr, 4)
    if corr >= XC_MIN_CORR:
        return t_ms, corr_r, None, "ok"
    if ref_rms < XC_QUIET_RMS:
        return None, corr_r, "too-quiet", "unmeasurable"
    # a loud WAV and digital silence where it should be: the audio is not in the video
    e0 = max(0, int(round(expected_ms / 1000.0 * arate)))
    e1 = min(len(x), e0 + int(round(len(ref) / float(wrate) * arate)))
    if e1 > e0 and float(np.sqrt(np.mean(x[e0:e1].astype(np.float64) ** 2))) < XC_SILENT_RMS:
        return None, corr_r, "audio-not-found-in-video", "missing"
    return None, corr_r, "low-correlation", "unmeasurable"


def last_audible_window(paths):
    """Return the offset from slide audio start (seconds) and RMS of its last audible window."""
    parts = []
    offset = 0.0
    for path in paths:
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("wav-not-16bit")
            parts.append((path, offset))
            offset += w.getnframes() / w.getframerate()
    for path, offset in reversed(parts):
        with wave.open(path, "rb") as w:
            rate, channels, end = w.getframerate(), w.getnchannels(), w.getnframes()
            hop = max(1, round(TAIL_WINDOW_S * rate))
            while end:
                # Read at most one second, scanning backwards over trailing silence.
                start = max(0, end - 25 * hop)
                w.setpos(start)
                pcm = np.frombuffer(w.readframes(end - start), dtype="<i2")
                if pcm.size != (end - start) * channels:
                    raise ValueError("wav-truncated")
                mono = pcm.reshape(-1, channels).mean(axis=1) / 32768.0
                for hi in range(len(mono), 0, -hop):
                    lo = max(0, hi - hop)
                    rms = float(np.sqrt(np.mean(mono[lo:hi] ** 2)))
                    if rms >= SILENCE_RMS:
                        return offset + (start + (lo + hi) / 2) / rate, rms
                end = start
    return None


def check_audio_tail(x, rate, start_ms, tail):
    if tail is None:
        return None
    offset_s, source_rms = tail
    centre = (start_ms / 1000 + offset_s) * rate
    pad = round(TAIL_SEARCH_PAD_S * rate)
    if centre > len(x) + pad:
        return "audio-tail-truncated"
    lo = max(0, round(centre) - pad)
    hi = min(len(x), round(centre) + pad)
    if hi <= lo or np.sqrt(np.mean(x[lo:hi].astype(np.float64) ** 2)) < max(XC_SILENT_RMS, source_rms / 100):
        return "audio-tail-silent"
    return None


# ----------------------------------------------------------------------------- main logic

def verify(video_path, timeline_path, method="B", tol_audio_ms=None, tol_show_ms=None):
    try:
        with open(timeline_path, "r", encoding="utf-8") as f:
            tl = json.load(f)
        base = os.path.dirname(os.path.abspath(timeline_path))
        rate_tl = tl["sampleRate"]
        fps_tl = tl["fps"]
        slides = tl["slides"]
    except (OSError, KeyError, ValueError) as e:
        raise VerifyError("cannot read timeline: %s" % e)
    if method not in ("A", "B"):
        raise VerifyError("method must be A or B")
    frame_ms = 1000.0 / fps_tl
    if tol_audio_ms is None:
        tol_audio_ms = 20.0 if method == "B" else 50.0
    if tol_show_ms is None:
        tol_show_ms = frame_ms if method == "B" else 50.0

    def resolve(p):
        return p if os.path.isabs(p) else os.path.join(base, p)

    try:
        c = av.open(video_path)
    except Exception as e:  # noqa: BLE001
        raise VerifyError("cannot open video: %s" % e)
    try:
        if not c.streams.video:
            raise VerifyError("no video stream")
        frames, vinfo, last_ms = read_video_signatures(c)
    finally:
        c.close()
    c = av.open(video_path)
    try:
        x, arate, ainfo = read_audio(c)
    finally:
        c.close()
    tsmap = ainfo.pop("_map", None)

    # pictures
    refs = []
    ref_err = []
    for s in slides:
        try:
            refs.append(load_png_signature(resolve(s["image"])))
            ref_err.append(None)
        except Exception as e:  # noqa: BLE001
            refs.append(None)
            ref_err.append("image-unreadable: %s" % e)
    ok_idx = [i for i, r in enumerate(refs) if r is not None]
    pic = {}
    if ok_idx:
        res = measure_pictures(frames, [refs[i] for i in ok_idx], vinfo["fps"] or fps_tl)
        for k, i in enumerate(ok_idx):
            pic[i] = res[k]
    # tones
    tones = []
    for s in slides:
        first = s["audio"][0] if isinstance(s["audio"], list) else s["audio"]
        tones.append(wav_tone(resolve(first)))

    out_slides = []
    counts = {"ok": 0, "outOfTolerance": 0, "unmeasurable": 0}
    for i, s in enumerate(slides):
        exp_show_ms = s["showStart"] * 1000.0 / rate_tl
        exp_audio_ms = s["audioStart"] * 1000.0 / rate_tl
        reasons = []
        # picture
        show_ms = None
        show_detail = None
        if ref_err[i]:
            show_detail = "unmeasurable"
            reasons.append(ref_err[i])
        else:
            ms, why = pic[i]
            if ms is not None:
                show_ms = ms
            elif why == "picture-not-found":
                show_detail = "missing"
                reasons.append("picture-not-found")
            else:
                show_detail = "unmeasurable"
                reasons.append(why)
        # audio
        audio_ms = None
        audio_detail = None
        audio_method = None
        corr = None
        hz, why = tones[i]
        if x is None:
            audio_detail = "missing"
            reasons.append("no-audio-stream")
        elif hz is None and why in ("wav-too-short-or-silent", "wav-not-a-clean-tone"):
            audio_method = "xcorr"
            first = s["audio"][0] if isinstance(s["audio"], list) else s["audio"]
            ms, corr, why2, kind = xcorr_onset_ms(x, arate, resolve(first), from_pts_ms(exp_audio_ms, arate, tsmap))
            if ms is not None:
                audio_ms = to_pts_ms(ms, arate, tsmap)
            else:
                audio_detail = kind
                reasons.append(why2)
        elif hz is None:
            audio_detail = "unmeasurable"
            reasons.append(why)
        else:
            audio_method = "cue"
            near = [j for j in range(len(slides))
                    if j != i and tones[j][0] is not None
                    and abs(tones[j][0] - hz) < TONE_MIN_SEPARATION_HZ
                    and abs(slides[j]["audioStart"] - s["audioStart"]) / rate_tl < 4 * SEARCH_S]
            if near:
                audio_detail = "unmeasurable"
                reasons.append("tone-frequency-too-close-to-slide-%s" % slides[near[0]]["slideId"])
            else:
                ms, why2 = tone_onset_ms(x, arate, hz, from_pts_ms(exp_audio_ms, arate, tsmap))
                if ms is not None:
                    audio_ms = to_pts_ms(ms, arate, tsmap)
                elif why2 == "tone-not-found":
                    audio_detail = "missing"
                    reasons.append("audio-tone-not-found")
                else:
                    audio_detail = "unmeasurable"
                    reasons.append(why2)
        d_show = None if show_ms is None else show_ms - exp_show_ms
        d_audio = None if audio_ms is None else audio_ms - exp_audio_ms
        if show_ms is not None:
            show_detail = "ok" if abs(d_show) <= tol_show_ms + 1e-9 else "out-of-tolerance"
        if audio_ms is not None:
            audio_detail = "ok" if abs(d_audio) <= tol_audio_ms + 1e-9 else "out-of-tolerance"
        if x is not None and audio_detail != "missing":
            paths = s["audio"] if isinstance(s["audio"], list) else [s["audio"]]
            try:
                tail = last_audible_window([resolve(p) for p in paths])
            except (wave.Error, OSError, EOFError, ValueError) as e:
                if audio_detail == "ok":
                    audio_detail = "unmeasurable"
                    reasons.append("audio-tail-reference-unreadable: %s" % e)
            else:
                start_ms = from_pts_ms(audio_ms if audio_ms is not None else exp_audio_ms, arate, tsmap)
                tail_reason = check_audio_tail(x, arate, start_ms, tail)
                if tail_reason:
                    if audio_detail != "out-of-tolerance":
                        audio_detail = "missing"
                    reasons.append(tail_reason)
        details = (show_detail, audio_detail)
        if "out-of-tolerance" in details or "missing" in details:
            status = "out-of-tolerance"
        elif "unmeasurable" in details:
            status = "unmeasurable"
        else:
            status = "ok"
        counts[{"ok": "ok", "out-of-tolerance": "outOfTolerance", "unmeasurable": "unmeasurable"}[status]] += 1
        out_slides.append({
            "slideId": s["slideId"],
            "expected": {"showStart": s["showStart"], "audioStart": s["audioStart"]},
            "expectedMs": {"showStartMs": round(exp_show_ms, 3), "audioStartMs": round(exp_audio_ms, 3)},
            "measured": {"showStartMs": None if show_ms is None else round(show_ms, 3),
                         "audioStartMs": None if audio_ms is None else round(audio_ms, 3)},
            "diffMs": {"show": None if d_show is None else round(d_show, 3),
                       "audio": None if d_audio is None else round(d_audio, 3)},
            "status": status,
            "detail": {"show": show_detail, "audio": audio_detail},
            "reasons": reasons,
            "audioMethod": audio_method,
            "corr": corr,
        })

    frame_period = (1000.0 / vinfo["fps"]) if vinfo["fps"] else frame_ms
    total_ms = None if last_ms is None else last_ms + frame_period
    expected_total_ms = tl["totalSamples"] * 1000.0 / rate_tl
    audio_report = dict(ainfo)
    if x is not None:
        audio_report["silentRuns"] = silent_runs(x, arate)
        audio_report["peak"] = float(np.max(np.abs(x))) if len(x) else 0.0
    result = {
        "method": method,
        "toleranceMs": {"audio": tol_audio_ms, "show": round(tol_show_ms, 3)},
        "slides": out_slides,
        "totalMs": None if total_ms is None else round(total_ms, 3),
        "expectedTotalMs": round(expected_total_ms, 3),
        "totalDiffMs": None if total_ms is None else round(total_ms - expected_total_ms, 3),
        "pass": counts["outOfTolerance"] == 0,
        "allMeasured": counts["unmeasurable"] == 0,
        "counts": counts,
        "video": vinfo,
        "audio": audio_report,
    }
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description="Measure picture switches and audio starts in an MP4")
    ap.add_argument("--video", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--method", default="B", choices=["A", "B"])
    ap.add_argument("--tolerance-audio-ms", type=float, default=None)
    ap.add_argument("--tolerance-show-ms", type=float, default=None)
    ap.add_argument("--out", default=None, help="also write the JSON here")
    args = ap.parse_args(argv)
    try:
        result = verify(args.video, args.timeline, args.method, args.tolerance_audio_ms, args.tolerance_show_ms)
    except VerifyError as e:
        print(json.dumps({"error": {"code": "verify-failed", "message": str(e)}}, ensure_ascii=True))
        return 1
    text = json.dumps(result, ensure_ascii=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(text)
    return 0 if result["pass"] else 3


if __name__ == "__main__":
    sys.exit(main())
