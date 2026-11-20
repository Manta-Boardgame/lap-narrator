#!/usr/bin/env python
"""locate: find a phrase of the TRANSCRIPT and the quiet stretch right after (or before) it (`narrate boundary set --at-text`).

  .venv\\Scripts\\python.exe -I checker/speech/locate.py --transcript <transcript.json> --audio <wav> --text "..." --lo <sec> --hi <sec>
        [--mode after|before] [--nth N]

The phrase is normalised like the matching (speech_norm: NFKC, kana, numerals, no punctuation), so kanji numerals / punctuation /
the review's markers (▮ ⟨25⟩ …) do not matter. Only occurrences inside [lo, hi] seconds are considered.
Prints {"ok":true,"occurrences":[{startSec,endSec,context}],"chosen":{sec,sample,kind,silenceSec,occurrence}|null}:
`chosen` is set when there is exactly one occurrence (or --nth picks one). No occurrence: error text-not-found.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_common import SpeechError, emit, fail, read_wav_info, setup_stdio  # noqa: E402
from speech_norm import normalize, normalize_pairs  # noqa: E402
from speech_silence import snap_directional  # noqa: E402

STRIP = re.compile(r"⟨\d+⟩|▮|…|\.\.\.")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--lo", type=float, required=True)
    ap.add_argument("--hi", type=float, required=True)
    ap.add_argument("--mode", default="after", choices=["after", "before"])
    ap.add_argument("--nth", type=int, default=0)
    a = ap.parse_args(argv)
    with open(a.transcript, "r", encoding="utf-8") as f:
        tr = json.load(f)
    words = tr["words"]
    needle = normalize(STRIP.sub("", a.text))
    if len(needle) < 2:
        raise SpeechError("bad-text", "the text is empty (or a single character) after normalisation: give a longer phrase from the transcript")
    pairs = [(ch, wi) for wi, w in enumerate(words) for ch in w["w"]]
    tn = normalize_pairs(pairs)
    T = "".join(c for c, _ in tn)
    Tw = [w for _, w in tn]
    occ = []
    k = T.find(needle)
    while k >= 0:
        w0, w1 = Tw[k], Tw[k + len(needle) - 1]
        s, e = words[w0]["start"], words[w1]["end"]
        if e >= a.lo - 0.3 and s <= a.hi + 0.3:
            ctx_a, ctx_b = max(0, w0 - 6), min(len(words), w1 + 7)
            occ.append({"startSec": round(s, 3), "endSec": round(e, 3),
                        "context": "".join(w["w"] for w in words[ctx_a:w0]) + "【" + "".join(w["w"] for w in words[w0:w1 + 1]) + "】" + "".join(w["w"] for w in words[w1 + 1:ctx_b])})
        k = T.find(needle, k + 1)
    if not occ:
        raise SpeechError("text-not-found", "the phrase was not found in the transcript between %.1f s and %.1f s (matching ignores punctuation, kana type and kanji numerals, but not other kanji/kana differences: copy the phrase exactly as the transcript shows it)" % (a.lo, a.hi))
    chosen = None
    pick = None
    if a.nth:
        if not (1 <= a.nth <= len(occ)):
            raise SpeechError("bad-nth", "--nth %d: there are %d occurrence(s)" % (a.nth, len(occ)))
        pick = occ[a.nth - 1]
    elif len(occ) == 1:
        pick = occ[0]
    if pick is not None:
        info = read_wav_info(a.audio)
        t = pick["endSec"] if a.mode == "after" else pick["startSec"]
        sec, run, kind = snap_directional(a.audio, info, t, a.mode)
        chosen = {"sec": sec, "sample": int(round(sec * info["sampleRate"])), "kind": kind, "silenceSec": run, "phraseSec": t, "occurrence": occ.index(pick) + 1}
    emit({"ok": True, "occurrences": occ, "chosen": chosen})
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
