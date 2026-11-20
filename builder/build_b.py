#!/usr/bin/env python
"""Method B: build an MP4 straight from timeline.json (slide PNGs + WAVs) with PyAV.

  .venv\\Scripts\\python.exe -I builder/build_b.py --timeline <timeline.json> --out <dir>

Output (CONTRACTS section 4):
  <dir>/video.mp4          H.264 (yuv420p, BT.709), 30 fps constant (timeline fps), AAC mono
  <dir>/build-report.json  {method:"B", elapsedMs, fps, width, height, notes[], ...}
The report is also printed to stdout as one JSON object. Exit code 0 on success, 1 on failure
(then stdout is {"ok": false, "errors": [{"code", "message"}]}).

Timing rules (design 8.3):
  * Each slide boundary is rounded to a frame from the cumulative sample position:
        frame(sample) = floor((sample * fps + rate / 2) / rate)       (integer arithmetic)
    so rounding errors never accumulate.
  * Each slide WAV is written at its timeline audioStart sample position (sample accurate).
  * Frames are stamped in 1/fps units, audio in 1/rate units.

Test-only options (used to make a deliberately shifted video that verify must catch):
  --debug-audio-shift-ms N       move all audio N ms later (negative = earlier)
  --debug-video-shift-frames N   move all slide boundaries N frames later
"""
import argparse
import json
import os
import struct
import sys
import time
from fractions import Fraction

import numpy as np
import av

WIDTH_DEFAULT = 1920
HEIGHT_DEFAULT = 1080


class BuildError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def frame_of(sample, fps, rate):
    """frame(sample) = floor((sample * fps + rate / 2) / rate) using integers only."""
    return (2 * sample * fps + rate) // (2 * rate)


# ---------------------------------------------------------------- WAV (44-byte or chunked header)

def open_wav(path, expect_rate):
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise BuildError("bad-wav", "not a RIFF/WAVE file: %s" % path)
        fmt = None
        data_off = None
        data_len = None
        while True:
            h = f.read(8)
            if len(h) < 8:
                break
            tag = h[0:4]
            size = struct.unpack("<I", h[4:8])[0]
            if tag == b"fmt ":
                fmt = struct.unpack("<HHIIHH", f.read(16))
                if size > 16:
                    f.seek(size - 16, 1)
            elif tag == b"data":
                data_off = f.tell()
                data_len = min(size, os.path.getsize(path) - data_off)
                break
            else:
                f.seek(size + (size & 1), 1)
    if fmt is None or data_off is None:
        raise BuildError("bad-wav", "missing fmt/data chunk: %s" % path)
    audio_format, channels, rate, _byte_rate, _align, bits = fmt
    if audio_format != 1 or channels != 1 or bits != 16:
        raise BuildError("bad-wav", "need PCM 16-bit mono: %s" % path)
    if rate != expect_rate:
        raise BuildError("bad-wav", "WAV rate %d != timeline rate %d: %s" % (rate, expect_rate, path))
    n = data_len // 2
    mm = np.memmap(path, dtype="<i2", mode="r", offset=data_off, shape=(n,)) if n > 0 else np.zeros(0, "<i2")
    return mm


class SlideAudio:
    """Virtual concatenation of one or more WAV parts."""

    def __init__(self, paths, expect_rate):
        self.parts = [open_wav(p, expect_rate) for p in paths]
        self.length = sum(len(p) for p in self.parts)

    def read(self, a, b):
        """int16 samples [a, b) of the slide audio (a, b already clipped to [0, length])."""
        out = np.empty(b - a, dtype=np.int16)
        pos = 0
        for part in self.parts:
            lo = max(a, pos)
            hi = min(b, pos + len(part))
            if lo < hi:
                out[lo - a:hi - a] = part[lo - pos:hi - pos]
            pos += len(part)
        return out


# ---------------------------------------------------------------- pictures

def load_picture(path, width, height):
    """Decode a PNG and return an RGB canvas width x height (aspect kept, black bars)."""
    try:
        c = av.open(path)
        fr = next(c.decode(video=0))
        c.close()
    except Exception as e:  # noqa: BLE001
        raise BuildError("bad-image", "cannot decode %s: %s" % (path, e))
    w, h = fr.width, fr.height
    if (w, h) == (width, height):
        return fr.to_ndarray(format="rgb24"), False
    scale = min(width / w, height / h)
    nw = max(2, int(round(w * scale)))
    nh = max(2, int(round(h * scale)))
    small = fr.reformat(width=nw, height=nh, format="rgb24").to_ndarray()
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    x0 = (width - nw) // 2
    y0 = (height - nh) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = small
    return canvas, True


def to_yuv(rgb):
    vf = av.VideoFrame.from_ndarray(rgb, format="rgb24")
    try:
        return vf.reformat(format="yuv420p", dst_colorspace=av.video.reformatter.Colorspace.ITU709)
    except Exception:  # noqa: BLE001  (other PyAV versions spell this differently)
        return vf.reformat(format="yuv420p")


# ---------------------------------------------------------------- main build

def load_timeline(path):
    with open(path, "r", encoding="utf-8") as f:
        tl = json.load(f)
    if tl.get("format") != "lap-narrator/timeline" or tl.get("version") != 1:
        raise BuildError("bad-timeline", "not a lap-narrator/timeline version 1 file")
    slides = tl.get("slides") or []
    if not slides:
        raise BuildError("bad-timeline", "timeline has no slides")
    rate = tl["sampleRate"]
    fps = tl["fps"]
    if slides[0]["showStart"] != 0:
        raise BuildError("bad-timeline", "first showStart must be 0")
    for i, s in enumerate(slides):
        if s["audioStart"] != s["showStart"] + tl["prePadSamples"] or \
                s["audioEnd"] != s["audioStart"] + s["audioSamples"] or \
                s["showEnd"] != s["audioEnd"] + tl["postPadSamples"]:
            raise BuildError("bad-timeline", "slide %s: showStart/audioStart/audioEnd/showEnd are inconsistent" % s["slideId"])
        if i + 1 < len(slides) and slides[i + 1]["showStart"] != s["showEnd"]:
            raise BuildError("bad-timeline", "slide %s: next showStart != showEnd" % s["slideId"])
    if tl["totalSamples"] != slides[-1]["showEnd"]:
        raise BuildError("bad-timeline", "totalSamples != last showEnd")
    return tl, rate, fps


def build(timeline_path, out_dir, width=WIDTH_DEFAULT, height=HEIGHT_DEFAULT, crf=18, preset="veryfast",
          audio_shift_ms=0, video_shift_frames=0, video_name="video.mp4"):
    t_begin = time.perf_counter()
    notes = []
    tl, rate, fps = load_timeline(timeline_path)
    base = os.path.dirname(os.path.abspath(timeline_path))
    slides = tl["slides"]
    total = tl["totalSamples"]
    if rate != 48000:
        notes.append("audio sample rate is %d Hz (design default is 48000); encoded as is" % rate)

    def resolve(p):
        return p if os.path.isabs(p) else os.path.join(base, p)

    # frame boundaries (from cumulative sample positions, never from summed durations)
    starts = [0] + [frame_of(s["showStart"], fps, rate) + video_shift_frames for s in slides[1:]]
    n_frames = frame_of(total, fps, rate)
    bounds = starts + [n_frames]
    for i in range(len(slides)):
        if bounds[i + 1] <= bounds[i]:
            notes.append("slide %s is shorter than one frame and is dropped from the picture" % slides[i]["slideId"])

    audio_shift = int(round(audio_shift_ms * rate / 1000.0))
    audio_len = total + max(0, audio_shift)
    if audio_shift:
        notes.append("DEBUG: audio shifted by %d ms" % audio_shift_ms)
    if video_shift_frames:
        notes.append("DEBUG: slide boundaries shifted by %d frames" % video_shift_frames)

    audios = []
    for s in slides:
        paths = s["audio"] if isinstance(s["audio"], list) else [s["audio"]]
        sa = SlideAudio([resolve(p) for p in paths], rate)
        if sa.length != s["audioSamples"]:
            raise BuildError("audio-length-mismatch",
                             "slide %s: WAV has %d samples, timeline says %d" % (s["slideId"], sa.length, s["audioSamples"]))
        audios.append(sa)

    os.makedirs(out_dir, exist_ok=True)
    video_path = os.path.join(out_dir, video_name)
    container = av.open(video_path, "w", options={"movflags": "+faststart"})
    vs = container.add_stream("libx264", rate=fps)
    vs.width = width
    vs.height = height
    vs.pix_fmt = "yuv420p"
    vs.time_base = Fraction(1, fps)
    vs.options = {"crf": str(crf), "preset": preset, "tune": "stillimage", "bf": "0", "g": str(fps * 2)}
    try:
        cc = vs.codec_context
        cc.colorspace = 1      # BT.709
        cc.color_primaries = 1
        cc.color_trc = 1
        cc.color_range = 1     # MPEG (limited)
    except Exception as e:  # noqa: BLE001
        notes.append("could not tag colour space: %s" % e)
    aus = container.add_stream("aac", rate=rate)
    aus.layout = "mono"
    aus.bit_rate = 128000
    atb = Fraction(1, rate)
    vtb = Fraction(1, fps)

    def mux(packets):
        for p in packets:
            container.mux(p)

    # pre-load pictures lazily, keep one at a time
    cur_slide = -1
    cur_frame = None
    letterboxed = []

    def picture_for(i):
        rgb, boxed = load_picture(resolve(slides[i]["image"]), width, height)
        if boxed:
            letterboxed.append(slides[i]["slideId"])
        return to_yuv(rgb)

    audio_pos = 0
    frame_idx = 0
    chunk_frames = fps
    slide_i = 0
    while frame_idx < n_frames or audio_pos < audio_len:
        # video: next chunk_frames frames
        hi = min(frame_idx + chunk_frames, n_frames)
        while frame_idx < hi:
            while slide_i + 1 < len(slides) and frame_idx >= bounds[slide_i + 1]:
                slide_i += 1
            if slide_i != cur_slide:
                cur_frame = picture_for(slide_i)
                cur_slide = slide_i
            vf = cur_frame.reformat()  # cheap new frame object sharing nothing mutable
            vf.pts = frame_idx
            vf.time_base = vtb
            mux(vs.encode(vf))
            frame_idx += 1
        # audio: the same time span
        a_hi = min(audio_pos + rate, audio_len)
        if a_hi > audio_pos:
            block = np.zeros(a_hi - audio_pos, dtype=np.int16)
            for i, s in enumerate(slides):
                a0 = s["audioStart"] + audio_shift
                a1 = a0 + s["audioSamples"]
                lo = max(a0, audio_pos)
                hi2 = min(a1, a_hi)
                if lo < hi2:
                    block[lo - audio_pos:hi2 - audio_pos] = audios[i].read(lo - a0, hi2 - a0)
            af = av.AudioFrame.from_ndarray(block.reshape(1, -1), format="s16", layout="mono")
            af.sample_rate = rate
            af.pts = audio_pos
            af.time_base = atb
            mux(aus.encode(af))
            audio_pos = a_hi
    mux(vs.encode(None))
    mux(aus.encode(None))
    container.close()

    if letterboxed:
        notes.append("pictures not 16:9 1920x1080 were letterboxed: %s" % ",".join(letterboxed))
    report = {
        "ok": True,
        "method": "B",
        "elapsedMs": int(round((time.perf_counter() - t_begin) * 1000)),
        "fps": fps,
        "width": width,
        "height": height,
        "notes": notes,
        "video": video_name,
        "frames": n_frames,
        "durationMs": round(n_frames * 1000.0 / fps, 3),
        "slideStartFrames": {s["slideId"]: bounds[i] for i, s in enumerate(slides)},
    }
    with open(os.path.join(out_dir, "build-report.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=2, ensure_ascii=True)
        f.write("\n")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Method B video builder (PyAV)")
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=WIDTH_DEFAULT)
    ap.add_argument("--height", type=int, default=HEIGHT_DEFAULT)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="veryfast")
    ap.add_argument("--video-name", default="video.mp4")
    ap.add_argument("--debug-audio-shift-ms", type=float, default=0)
    ap.add_argument("--debug-video-shift-frames", type=int, default=0)
    args = ap.parse_args(argv)
    try:
        report = build(args.timeline, args.out, args.width, args.height, args.crf, args.preset,
                       args.debug_audio_shift_ms, args.debug_video_shift_frames, args.video_name)
    except BuildError as e:
        print(json.dumps({"ok": False, "errors": [{"code": e.code, "message": e.message}]}, ensure_ascii=True))
        return 1
    except (OSError, KeyError, ValueError, av.error.FFmpegError) as e:
        print(json.dumps({"ok": False, "errors": [{"code": "build-failed", "message": "%s: %s" % (type(e).__name__, e)}]},
                         ensure_ascii=True))
        return 1
    print(json.dumps(report, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
