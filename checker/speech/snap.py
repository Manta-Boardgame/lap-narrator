#!/usr/bin/env python
"""snap: move a time to the middle of the nearest quiet run (used by `narrate boundary set`).

  .venv\\Scripts\\python.exe -I checker/speech/snap.py --audio <wav> --at <seconds> [--radius 1.0] [--min-silence 0.2]

Prints {"ok":true,"sec":..,"silenceSec":..,"kind":"silence"|"none","sample":..}; kind "none" = no quiet run of at least
min-silence within +-radius, `sec` is the asked time unchanged.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_common import SpeechError, emit, fail, read_wav_info, setup_stdio  # noqa: E402
from speech_silence import snap_point  # noqa: E402


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--at", type=float, required=True)
    ap.add_argument("--radius", type=float, default=1.0)
    ap.add_argument("--min-silence", type=float, default=0.2)
    a = ap.parse_args(argv)
    if not os.path.exists(a.audio):
        return fail("cannot-read", "no such audio file: %s" % a.audio)
    info = read_wav_info(a.audio)
    sec, run, kind = snap_point(a.audio, info, a.at, a.radius, a.min_silence)
    emit({"ok": True, "sec": sec, "silenceSec": run, "kind": kind, "sample": int(round(sec * info["sampleRate"])),
          "sampleRate": info["sampleRate"], "samples": info["samples"]})
    return 0


if __name__ == "__main__":
    setup_stdio()
    try:
        sys.exit(main(sys.argv[1:]))
    except SpeechError as e:
        sys.exit(fail(e.code, e.message, e.detail))
    except SystemExit:
        raise
    except Exception as e:
        sys.exit(fail("internal-error", "%s: %s" % (type(e).__name__, e)))
