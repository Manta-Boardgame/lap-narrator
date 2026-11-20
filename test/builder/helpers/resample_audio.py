"""Re-encodes the audio of an MP4 as stereo AAC at another sample rate and copies the video stream
(owner: D, test helper). Used to check that verify works on a 44.1 kHz stereo track like PowerPoint's.
  .venv/Scripts/python.exe -I test/builder/helpers/resample_audio.py <in.mp4> <out.mp4> <rate>
      [--truncate-at <seconds> | --mute-after <seconds>]
"""
import argparse
from fractions import Fraction

import av

parser = argparse.ArgumentParser()
parser.add_argument("src")
parser.add_argument("dst")
parser.add_argument("rate", type=int)
cut = parser.add_mutually_exclusive_group()
cut.add_argument("--truncate-at", type=float)
cut.add_argument("--mute-after", type=float)
args = parser.parse_args()

src = av.open(args.src)
rate = args.rate
dst = av.open(args.dst, "w")
vin = src.streams.video[0]
vout = dst.add_stream_from_template(vin)
ain = src.streams.audio[0]
aout = dst.add_stream("aac", rate=rate, layout="stereo")
aout.bit_rate = 128000
rs = av.AudioResampler(format="fltp", layout="stereo", rate=rate)


pos = 0


def write(frames):
    global pos
    for f in frames:
        if args.truncate_at is not None:
            keep = round(args.truncate_at * rate) - pos
            if keep <= 0:
                break
            if keep < f.samples:
                f = av.AudioFrame.from_ndarray(f.to_ndarray()[:, :keep].copy(), format="fltp", layout="stereo")
        if args.mute_after is not None:
            keep = max(0, round(args.mute_after * rate) - pos)
            if keep < f.samples:
                samples = f.to_ndarray()
                samples[:, keep:] = 0
                f = av.AudioFrame.from_ndarray(samples, format="fltp", layout="stereo")
        f.pts = pos                       # explicit pts, as build_b.py does
        f.time_base = Fraction(1, rate)
        f.sample_rate = rate
        pos += f.samples
        for p in aout.encode(f):
            dst.mux(p)


for packet in src.demux(vin, ain):
    if packet.dts is None:
        continue
    if packet.stream.type == "video":
        packet.stream = vout
        dst.mux(packet)
    else:
        for fr in packet.decode():
            write(rs.resample(fr))
write(rs.resample(None))
for p in aout.encode(None):
    dst.mux(p)
dst.close()
src.close()
print("ok")
