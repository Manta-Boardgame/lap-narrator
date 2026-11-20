"""Independent check of `narrate render --boundaries` (standard library only: zipfile, wave, hashlib, json, struct).

  python -I continuous_slices.py --zip <full export zip> --raw rec-000001 --keep 0:A --keep B:END
         --boundaries <boundaries.json> --out <render out dir>

It does NOT use any lap-narrator code. It rebuilds the continuous audio from the raw recording in the export
(the kept ranges are given by the caller: everything the player did not retake), cuts it at the boundaries,
and computes, per slide, the SHA-256 of the PCM bytes and of the WAV file a standard 44-byte writer would produce.
Then it reads the WAV files the tool wrote (with the `wave` module) and compares. Prints one JSON object.
"""
import argparse
import hashlib
import io
import json
import os
import struct
import sys
import wave
import zipfile


def wav_bytes(pcm, rate):
    n = len(pcm)
    head = b"RIFF" + struct.pack("<I", 36 + n) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", n)
    return head + pcm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--keep", action="append", required=True)
    ap.add_argument("--boundaries", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tail-samples", type=int, default=0, help="samples cut off the end of every slide (the tail margin); the timeline then has postPadSamples = this")
    a = ap.parse_args()

    with zipfile.ZipFile(a.zip) as z:
        data = z.read("raw/%s.wav" % a.raw)
    with wave.open(io.BytesIO(data)) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    pieces = []
    for k in a.keep:
        s, e = k.split(":")
        s = int(s)
        e = len(raw) // 2 if e == "END" else int(e)
        pieces.append(raw[s * 2:e * 2])
    cont = b"".join(pieces)
    total = len(cont) // 2

    with open(a.boundaries, encoding="utf-8") as f:
        b = json.load(f)
    result = {"rate": rate, "continuousSamples": total, "continuousWavSha256": hashlib.sha256(wav_bytes(cont, rate)).hexdigest(), "slides": [], "problems": []}
    if b["audio"]["sha256"] != result["continuousWavSha256"]:
        result["problems"].append("boundaries.audio.sha256 differs from the independently built continuous WAV")
    if b["audio"]["samples"] != total:
        result["problems"].append("boundaries.audio.samples differs")

    with open(os.path.join(a.out, "timeline.json"), encoding="utf-8") as f:
        tl = json.load(f)
    tl_by = {s["slideId"]: s for s in tl["slides"]}
    if tl["prePadSamples"] != 0 or tl["postPadSamples"] != a.tail_samples:
        result["problems"].append("timeline pads are not (0, %d)" % a.tail_samples)
    if tl["totalSamples"] != total:
        result["problems"].append("timeline.totalSamples differs")

    joined = b""
    for s in b["slides"]:
        full = cont[s["startSample"] * 2:s["endSample"] * 2]
        joined += full
        want = full[:len(full) - a.tail_samples * 2]
        path = os.path.join(a.out, "final", s["slideId"] + ".wav")
        row = {"slideId": s["slideId"], "samples": len(want) // 2, "expectedPcmSha256": hashlib.sha256(want).hexdigest(), "expectedWavSha256": hashlib.sha256(wav_bytes(want, rate)).hexdigest()}
        with wave.open(path) as w:
            got = w.readframes(w.getnframes())
            row["gotSamples"] = w.getnframes()
            row["gotRate"] = w.getframerate()
        row["gotPcmSha256"] = hashlib.sha256(got).hexdigest()
        with open(path, "rb") as f:
            row["gotWavSha256"] = hashlib.sha256(f.read()).hexdigest()
        row["match"] = row["gotPcmSha256"] == row["expectedPcmSha256"] and row["gotWavSha256"] == row["expectedWavSha256"] and row["gotSamples"] == row["samples"] and row["gotRate"] == rate
        t = tl_by.get(s["slideId"])
        row["timelineMatch"] = bool(t) and t["showStart"] == s["startSample"] == t["audioStart"] and t["showEnd"] == s["endSample"] == t["audioEnd"] + a.tail_samples and t["audioSamples"] == row["samples"]
        result["slides"].append(row)
    result["concatenationMatches"] = joined == cont
    print(json.dumps(result))
    return 0


sys.exit(main())
