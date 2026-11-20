"""Copy or resample a mono PCM WAV into a 48 kHz continuous narration."""
import json
import sys
import wave

import av
import numpy as np


RATE = 48000


def convert(source, output):
    with wave.open(source, "rb") as src:
        rate = src.getframerate()
        frames = src.getnframes()
        if src.getsampwidth() != 2 or src.getnchannels() != 1 or rate not in (8000, 16000, 44100, RATE):
            raise ValueError("expected mono 16-bit PCM WAV at 8000, 16000, 44100 or 48000 Hz")
        if frames < 32:
            raise ValueError("the WAV has fewer than 32 samples")
        expected = (frames * RATE + rate // 2) // rate
        if 44 + 2 * expected > 1_000_000_000:
            raise ValueError("the converted narration exceeds the single-file intake limit")
        remaining = expected
        written = 0
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE) if rate != RATE else None
        with wave.open(output, "wb") as dst:
            dst.setparams((1, 2, RATE, expected, "NONE", "not compressed"))

            def write_pcm(pcm):
                nonlocal remaining
                data = pcm[:remaining * 2]
                dst.writeframesraw(data)
                remaining -= len(data) // 2

            while written < frames:
                pcm = src.readframes(min(32768, frames - written))
                if not pcm or len(pcm) % 2:
                    raise ValueError("the WAV data is truncated")
                written += len(pcm) // 2
                if resampler is None:
                    write_pcm(pcm)
                else:
                    array = np.frombuffer(pcm, dtype="<i2").reshape(1, -1)
                    frame = av.AudioFrame.from_ndarray(array, format="s16", layout="mono")
                    frame.sample_rate = rate
                    for converted in resampler.resample(frame):
                        write_pcm(converted.to_ndarray().tobytes())
            if resampler is not None:
                for converted in resampler.resample(None):
                    write_pcm(converted.to_ndarray().tobytes())
            if remaining:
                if remaining > 1:
                    raise ValueError(f"the resampler is short by {remaining} samples")
                write_pcm(bytes(2))
    return {"inputSampleRate": rate, "inputSamples": frames, "sampleRate": RATE, "samples": expected}


if __name__ == "__main__":
    try:
        print(json.dumps(convert(*sys.argv[1:])))
    except (ValueError, OSError, EOFError, wave.Error, av.FFmpegError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
