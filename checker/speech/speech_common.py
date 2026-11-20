"""Shared helpers for checker/speech (WAV reading in chunks, hashing, JSON output, progress).

Everything here uses only the standard library and numpy. Audio is never loaded as a whole:
WAV data is read in chunks with offsets (np.fromfile).
"""
import hashlib
import json
import os
import struct
import sys

import numpy as np


class SpeechError(Exception):
    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def setup_stdio():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", newline="\n")
        except Exception:
            pass


def progress(stage, done, total):
    """One JSON line on stderr (CONTRACTS 3.1)."""
    sys.stderr.write(json.dumps({"progress": {"stage": stage, "done": done, "total": total}}) + "\n")
    sys.stderr.flush()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(code, message, detail=None, exit_code=1):
    err = {"code": code, "message": message}
    if detail is not None:
        err["detail"] = detail
    emit({"ok": False, "error": err})
    return exit_code


def sha256_file(path, chunk=1 << 22):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def read_wav_info(path):
    """Parse RIFF chunks. 16-bit PCM only. Returns dict(sampleRate, channels, samples, dataOffset)."""
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise SpeechError("bad-audio", "not a RIFF/WAVE file: %s" % path)
        fmt = None
        size_total = os.path.getsize(path)
        while True:
            h = f.read(8)
            if len(h) < 8:
                raise SpeechError("bad-audio", "no data chunk in %s" % path)
            cid, size = h[0:4], struct.unpack("<I", h[4:8])[0]
            body = f.tell()
            if cid == b"fmt ":
                d = f.read(min(size, 16))
                tag, ch, rate, _br, _ba, bits = struct.unpack("<HHIIHH", d[:16])
                fmt = (tag, ch, rate, bits)
            elif cid == b"data":
                if fmt is None:
                    raise SpeechError("bad-audio", "data before fmt in %s" % path)
                tag, ch, rate, bits = fmt
                if tag != 1 or bits != 16:
                    raise SpeechError("bad-audio", "only 16-bit PCM WAV is supported (%s)" % path)
                size = min(size, size_total - body)
                return {"sampleRate": rate, "channels": ch, "samples": size // (2 * ch), "dataOffset": body}
            f.seek(body + size + (size & 1))


def read_samples(path, info, start, count):
    """Read `count` samples (first channel) from sample `start`; short reads are padded by truncation."""
    start = max(0, int(start))
    count = max(0, min(int(count), info["samples"] - start))
    if count == 0:
        return np.zeros(0, dtype=np.int16)
    ch = info["channels"]
    off = info["dataOffset"] + start * 2 * ch
    a = np.fromfile(path, dtype="<i2", count=count * ch, offset=off)
    if ch > 1:
        a = a[::ch]
    return a


def iter_chunks(path, info, chunk_samples):
    pos = 0
    while pos < info["samples"]:
        n = min(chunk_samples, info["samples"] - pos)
        yield pos, read_samples(path, info, pos, n)
        pos += n
