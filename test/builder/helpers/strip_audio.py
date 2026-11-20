"""Copies the video stream of an MP4 into a new MP4 without audio (owner: D, test helper).
  .venv/Scripts/python.exe -I test/builder/helpers/strip_audio.py <in.mp4> <out.mp4>
"""
import sys

import av

src = av.open(sys.argv[1])
dst = av.open(sys.argv[2], "w")
vin = src.streams.video[0]
vout = dst.add_stream_from_template(vin)
for packet in src.demux(vin):
    if packet.dts is None:
        continue
    packet.stream = vout
    dst.mux(packet)
dst.close()
src.close()
print("ok")
