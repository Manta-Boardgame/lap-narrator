#!/usr/bin/env python
"""transcribe: faster-whisper transcript with word timestamps (PLAN2 transcript.json).

  .venv\\Scripts\\python.exe -I checker/speech/transcribe.py --audio <wav> --out <transcript.json>
        [--audio-label <name stored in the file>] [--model small] [--models-dir <dir>]
        [--vad on|off] [--threads N] [--force]

Prints one JSON object on stdout: {"ok":true,"cached":bool,"out":path,"model":...,"audioSec":..,"wordCount":..,"timing":{..}}
or {"ok":false,"error":{"code","message"}} (exit 1). Progress lines go to stderr as {"progress":{...}}.

No download, no install: the model must already be under --models-dir (local_files_only=True).
The audio is never read whole by this script (SHA-256 and the sample count are streamed; faster-whisper
decodes it with PyAV and windows it internally).
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_common import SpeechError, emit, fail, progress, read_wav_info, setup_stdio, sha256_file  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
TRANSCRIPT_VERSION = 1
# Parameters that change the result; part of the cache key together with the audio hash and the model.
DECODE_PARAMS = {"beam": 5, "conditionOnPreviousText": False, "wordTimestamps": True, "computeType": "int8", "language": "ja"}


def cache_key_matches(existing, sha, model, vad):
    try:
        return (existing.get("format") == "lap-narrator/transcript" and existing.get("version") == TRANSCRIPT_VERSION
                and existing["audio"]["sha256"] == sha and existing.get("model") == model
                and existing.get("params", {}).get("vad") == vad
                and existing.get("params", {}).get("decode") == DECODE_PARAMS)
    except Exception:
        return False


def peak_mem_mb():
    """Peak working set of this process in MB (Windows only; None elsewhere)."""
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        if ctypes.windll.psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return round(pmc.PeakWorkingSetSize / (1024 * 1024))
    except Exception:
        pass
    return None


def decode_16k(path):
    """Decode to mono 16 kHz float32 with PyAV. (faster_whisper.decode_audio passes `metadata_errors` to av.open, which
    PyAV 19 rejects, so the decoding is done here; transcribe() accepts the resulting array.)"""
    import av
    import numpy as np
    parts = []
    with av.open(path, mode="r") as container:
        stream = container.streams.audio[0]
        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in container.decode(stream):
            for f in resampler.resample(frame):
                parts.append(f.to_ndarray().reshape(-1))
        for f in resampler.resample(None):
            parts.append(f.to_ndarray().reshape(-1))
    if not parts:
        return np.zeros(0, dtype=np.float32)
    a = np.concatenate(parts).astype(np.float32)
    del parts
    return a / 32768.0


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--audio-label", default=None)
    ap.add_argument("--model", default="small")
    ap.add_argument("--models-dir", default=os.path.join(REPO, "models"))
    ap.add_argument("--vad", default="on", choices=["on", "off"])
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)

    if not os.path.exists(a.audio):
        return fail("cannot-read", "no such audio file: %s" % a.audio)
    info = read_wav_info(a.audio)
    audio_sec = info["samples"] / info["sampleRate"]
    progress("hash", 0, 1)
    sha = sha256_file(a.audio)
    progress("hash", 1, 1)
    vad = a.vad == "on"

    if not a.force and os.path.exists(a.out):
        try:
            with open(a.out, "r", encoding="utf-8") as f:
                ex = json.load(f)
            if cache_key_matches(ex, sha, a.model, vad):
                emit({"ok": True, "cached": True, "out": a.out, "model": a.model, "audioSec": round(audio_sec, 3),
                      "wordCount": len(ex.get("words", [])), "timing": ex.get("timing")})
                return 0
        except Exception:
            pass  # unreadable cache: recompute

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        import faster_whisper  # noqa: F401
        from faster_whisper import WhisperModel
    except Exception as e:  # not installed
        return fail("speech-unavailable", "faster-whisper cannot be imported (%s: %s)" % (type(e).__name__, e))

    t0 = time.time()
    progress("load-model", 0, 1)
    try:
        model = WhisperModel(a.model, device="cpu", compute_type="int8", download_root=a.models_dir,
                             local_files_only=True, cpu_threads=a.threads)
    except Exception as e:
        return fail("speech-unavailable", "whisper model '%s' is not available under %s and will not be downloaded (%s: %s)"
                    % (a.model, a.models_dir, type(e).__name__, str(e)[:300]))
    load_sec = time.time() - t0
    progress("load-model", 1, 1)

    t1 = time.time()
    try:
        progress("decode", 0, 1)
        audio16 = decode_16k(a.audio)
        progress("decode", 1, 1)
        seg_iter, tinfo = model.transcribe(
            audio16, language="ja", beam_size=DECODE_PARAMS["beam"], word_timestamps=True,
            vad_filter=vad, condition_on_previous_text=DECODE_PARAMS["conditionOnPreviousText"])
        words, segments = [], []
        total = round(audio_sec, 1)
        for seg in seg_iter:
            segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()})
            for w in (seg.words or []):
                txt = w.word.strip()
                if not txt:
                    continue
                words.append({"w": txt, "start": round(w.start, 3), "end": round(w.end, 3), "p": round(float(w.probability), 3)})
            progress("transcribe", min(round(seg.end, 1), total), total)
    except SpeechError as e:
        return fail(e.code, e.message)
    except Exception as e:
        return fail("transcribe-failed", "%s: %s" % (type(e).__name__, str(e)[:400]))
    trans_sec = time.time() - t1

    label = a.audio_label if a.audio_label is not None else os.path.basename(a.audio)
    doc = {
        "format": "lap-narrator/transcript", "version": TRANSCRIPT_VERSION,
        "audio": {"file": label, "sha256": sha, "sampleRate": info["sampleRate"], "samples": info["samples"]},
        "model": a.model, "language": "ja",
        "engine": {"name": "faster-whisper", "version": getattr(faster_whisper, "__version__", None), "computeType": "int8", "device": "cpu"},
        "params": {"vad": vad, "decode": DECODE_PARAMS},
        "words": words, "segments": segments,
        "timing": {"loadSec": round(load_sec, 3), "transcribeSec": round(trans_sec, 3), "audioSec": round(audio_sec, 3),
                   "rtf": round(trans_sec / audio_sec, 3) if audio_sec else None, "peakMemMB": peak_mem_mb()},
    }
    out_dir = os.path.dirname(os.path.abspath(a.out))
    os.makedirs(out_dir, exist_ok=True)
    tmp = a.out + ".tmp-%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, a.out)
    emit({"ok": True, "cached": False, "out": a.out, "model": a.model, "audioSec": round(audio_sec, 3),
          "wordCount": len(words), "timing": doc["timing"]})
    return 0


if __name__ == "__main__":
    setup_stdio()
    try:
        sys.exit(main(sys.argv[1:]))
    except SpeechError as e:
        sys.exit(fail(e.code, e.message, e.detail))
    except SystemExit:
        raise
    except Exception as e:  # last resort: still one JSON object
        sys.exit(fail("internal-error", "%s: %s" % (type(e).__name__, e)))
