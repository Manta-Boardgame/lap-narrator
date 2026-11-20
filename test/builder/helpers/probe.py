"""Prints stream properties of an MP4 as one JSON line (owner: D).
  .venv/Scripts/python.exe -I test/builder/helpers/probe.py <mp4>
"""
import json
import sys

import av

c = av.open(sys.argv[1])
out = {"format": c.format.name}
v = c.streams.video[0]
cc = v.codec_context
out["video"] = {
    "codec": cc.name, "profile": cc.profile, "pixFmt": cc.pix_fmt, "width": cc.width, "height": cc.height,
    "fps": float(v.average_rate), "startMs": float(v.start_time * v.time_base) * 1000 if v.start_time is not None else None,
}
pts = []
for f in c.decode(v):
    pts.append(f.pts)
out["video"]["frames"] = len(pts)
d = [pts[i + 1] - pts[i] for i in range(len(pts) - 1)]
out["video"]["constantFrameInterval"] = len(set(d)) == 1
if c.streams.audio:
    a = c.streams.audio[0]
    ac = a.codec_context
    out["audio"] = {"codec": ac.name, "sampleRate": ac.sample_rate, "channels": ac.layout.nb_channels,
                    "startMs": float(a.start_time * a.time_base) * 1000 if a.start_time is not None else None}
print(json.dumps(out))
