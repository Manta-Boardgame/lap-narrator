"""Test material generator for the builder / verify tests (owner: D).

Creates, under --out:
  final/<slideId>.wav      mono 16-bit 48 kHz WAV (44-byte header). Each slide holds a
                           continuous tone of its own frequency that starts at WAV sample 0
                           (hard onset), so the tone onset in a video == timeline audioStart.
  slides/NNNN.png          1920x1080 PNG, one solid background colour per slide plus a big
                           seven-segment digit (synthetic stand-in for exported slides).
  timeline.json            lap-narrator/timeline (CONTRACTS 1.10), 3 slides.

Only numpy and the standard library are used. Run with the venv python in isolated mode:
  .venv\\Scripts\\python.exe -I test/builder/helpers/make_fixture.py --out work/D/fixture/synth
"""
import argparse
import json
import os
import struct
import zlib

import numpy as np

SAMPLE_RATE = 48000
FPS = 30
PRE_PAD = 14400   # 0.3 s
POST_PAD = 24000  # 0.5 s

# slideId, audio samples (deliberately not frame aligned), tone Hz (multiples of 200 Hz), bg colour
SLIDES = [
    ("s256", 74544, 1000, (220, 40, 40)),
    ("s257", 59000, 1600, (40, 160, 60)),
    ("s258", 86400, 2200, (40, 70, 220)),
]

SEGMENTS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
}


def wav_bytes(pcm):
    data = pcm.astype("<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    return header + data


def tone(samples, hz, amp=0.5, fade_out=480):
    n = np.arange(samples, dtype=np.float64)
    x = np.sin(2.0 * np.pi * hz * n / SAMPLE_RATE) * amp
    if fade_out > 0:
        x[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)
    return np.round(x * 32767.0).astype(np.int16)


def speech_like(samples, seed, amp=0.3):
    """Speech-like test signal (deterministic): noise band-limited to 300-3400 Hz, multiplied by a syllable
    envelope (about 4 Hz) that is gated into 'words' with short pauses, plus a faint room noise."""
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(samples)
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(samples, 1.0 / SAMPLE_RATE)
    spec[(freqs < 300.0) | (freqs > 3400.0)] = 0.0
    band = np.fft.irfft(spec, samples)
    band /= max(float(np.max(np.abs(band))), 1e-9)
    t = np.arange(samples) / SAMPLE_RATE
    syll = (0.5 + 0.5 * np.sin(2.0 * np.pi * (3.5 + 1.5 * rng.random()) * t + 6.28 * rng.random())) ** 2
    gate_noise = np.fft.irfft(np.where(freqs < 2.0, np.fft.rfft(rng.standard_normal(samples)), 0.0), samples)
    gate_noise /= max(float(np.std(gate_noise)), 1e-9)
    gate = 1.0 / (1.0 + np.exp(-6.0 * (gate_noise + 0.6)))
    room = 0.002 * rng.standard_normal(samples)
    x = amp * band * syll * gate + room
    return np.round(np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16)


def draw_digit(img, digit, color):
    h, w, _ = img.shape
    dw, dh, t = 520, 760, 90
    x0 = (w - dw) // 2
    y0 = (h - dh) // 2
    rects = {
        "a": (x0 + t, y0, dw - 2 * t, t),
        "b": (x0 + dw - t, y0 + t, t, dh // 2 - t - t // 2),
        "c": (x0 + dw - t, y0 + dh // 2 + t // 2, t, dh // 2 - t - t // 2),
        "d": (x0 + t, y0 + dh - t, dw - 2 * t, t),
        "e": (x0, y0 + dh // 2 + t // 2, t, dh // 2 - t - t // 2),
        "f": (x0, y0 + t, t, dh // 2 - t - t // 2),
        "g": (x0 + t, y0 + dh // 2 - t // 2, dw - 2 * t, t),
    }
    for seg in SEGMENTS[str(digit)]:
        x, y, rw, rh = rects[seg]
        img[y:y + rh, x:x + rw] = color


def png_bytes(img):
    h, w, _ = img.shape
    raw = np.concatenate([np.zeros((h, 1), dtype=np.uint8), img.reshape(h, w * 3)], axis=1).tobytes()

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--ids", default=None, help="comma separated slideIds to use instead of s256,s257,s258")
    ap.add_argument("--same-colour", action="store_true",
                    help="give slide 2 the same picture as slide 1 (verify must say unmeasurable)")
    ap.add_argument("--speech", action="store_true",
                    help="speech-like WAVs (band-limited noise with a syllable envelope) instead of tones")
    ap.add_argument("--slide-seconds", type=float, default=0,
                    help="give every slide a WAV of this many seconds (default: the short built-in lengths)")
    ap.add_argument("--silent-slide", type=int, default=0,
                    help="1-based slide whose WAV is digital silence")
    args = ap.parse_args()
    out = args.out
    ids = args.ids.split(",") if args.ids else [s[0] for s in SLIDES]
    if len(ids) != len(SLIDES):
        raise SystemExit("--ids needs %d ids" % len(SLIDES))
    os.makedirs(os.path.join(out, "final"), exist_ok=True)
    os.makedirs(os.path.join(out, "slides"), exist_ok=True)

    slides = []
    cursor = 0
    for i, (_sid, samples, hz, color) in enumerate(SLIDES, start=1):
        if args.slide_seconds > 0:
            samples = int(round(args.slide_seconds * SAMPLE_RATE)) + 37 * i   # not frame aligned
        sid = ids[i - 1]
        if args.same_colour and i == 2:
            color = SLIDES[0][3]
        if args.silent_slide == i:
            pcm = np.zeros(samples, dtype=np.int16)
        elif args.speech:
            pcm = speech_like(samples, 1000 + i)
        else:
            pcm = tone(samples, hz)
        with open(os.path.join(out, "final", sid + ".wav"), "wb") as f:
            f.write(wav_bytes(pcm))
        img = np.empty((1080, 1920, 3), dtype=np.uint8)
        img[:, :] = color
        draw_digit(img, i, (255, 255, 255))
        png = "slides/%04d.png" % i
        with open(os.path.join(out, png), "wb") as f:
            f.write(png_bytes(img))
        show_start = cursor
        audio_start = show_start + PRE_PAD
        audio_end = audio_start + samples
        show_end = audio_end + POST_PAD
        slides.append({
            "slideId": sid, "order": i, "image": png, "audio": "final/%s.wav" % sid,
            "audioSamples": samples, "showStart": show_start, "audioStart": audio_start,
            "audioEnd": audio_end, "showEnd": show_end,
        })
        cursor = show_end
    timeline = {
        "format": "lap-narrator/timeline", "version": 1, "sampleRate": SAMPLE_RATE, "fps": FPS,
        "prePadSamples": PRE_PAD, "postPadSamples": POST_PAD, "slides": slides, "totalSamples": cursor,
    }
    with open(os.path.join(out, "timeline.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(timeline, f, indent=2)
        f.write("\n")
    print(json.dumps({"out": out, "totalSamples": cursor, "tones": {ids[k]: SLIDES[k][2] for k in range(len(SLIDES))}}))


if __name__ == "__main__":
    main()
