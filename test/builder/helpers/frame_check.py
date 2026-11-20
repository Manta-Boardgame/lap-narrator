"""Checks build_b.frame_of against an exact rational reference (owner: D). Prints one JSON line.
  .venv/Scripts/python.exe -I test/builder/helpers/frame_check.py <path to builder/build_b.py>
"""
import importlib.util
import json
import math
import random
import sys
from fractions import Fraction

spec = importlib.util.spec_from_file_location("build_b", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

checked = 0
for rate, fps in ((48000, 30), (48000, 25), (44100, 30), (16000, 60), (48000, 24)):
    cases = list(range(0, 4000)) + [random.Random(7).randrange(0, 10 ** 10) for _ in range(5000)]
    cases += [rate * 3600 * 24 + k for k in range(5)]
    for s in cases:
        want = math.floor(Fraction(s * fps, rate) + Fraction(1, 2))
        got = mod.frame_of(s, fps, rate)
        if got != want:
            print(json.dumps({"ok": False, "sample": s, "rate": rate, "fps": fps, "got": got, "want": want}))
            sys.exit(1)
        # rounding never drifts: the frame edge is always within half a frame of the sample position
        assert abs(Fraction(got * rate, fps) - s) <= Fraction(rate, 2 * fps)
        checked += 1

# the half-way case rounds up, e.g. 0.5 frame -> 1
assert mod.frame_of(800, 30, 48000) == 1   # 800 samples = 0.5 frame at 48k/30fps
assert mod.frame_of(799, 30, 48000) == 0

# 3600 slides of 7.0123 s: boundaries from cumulative samples never accumulate error
cum = 0
worst = Fraction(0)
rng = random.Random(3)
for _ in range(3600):
    cum += 336590 + rng.randrange(-2000, 2000)
    f = mod.frame_of(cum, 30, 48000)
    worst = max(worst, abs(Fraction(f * 48000, 30) - cum))
assert worst <= 800, worst
print(json.dumps({"ok": True, "checked": checked, "worstSamplesOver3600Slides": int(worst)}))
