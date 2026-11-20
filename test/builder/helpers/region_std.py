"""Standard deviation of a pixel region of the video frame nearest to time t (owner: D, test helper).
A plain background region has std near 0; a speaker icon makes it large.
  .venv/Scripts/python.exe -I test/builder/helpers/region_std.py <mp4> <t seconds> <x0> <y0> <x1> <y1>
"""
import json
import sys

import av
import numpy as np

video, t = sys.argv[1], float(sys.argv[2])
x0, y0, x1, y1 = (int(v) for v in sys.argv[3:7])
c = av.open(video)
best = None
for f in c.decode(video=0):
    ft = float(f.pts * f.time_base)
    if best is None or abs(ft - t) < abs(best[0] - t):
        best = (ft, f)
a = best[1].to_ndarray(format="rgb24")[y0:y1, x0:x1].astype(np.float64).reshape(-1, 3)
print(json.dumps({"frameSec": best[0], "std": float(a.std(axis=0).max()), "mean": [float(v) for v in a.mean(axis=0)]}))
