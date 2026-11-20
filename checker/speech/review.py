#!/usr/bin/env python
"""review: material for checking EVERY slide boundary (not only the undecided ones), for an LLM or a person.

  .venv\\Scripts\\python.exe -I checker/speech/review.py --boundaries <boundaries.json> --transcript <transcript.json>
        --script <script.json|pack.zip> --audio <wav> [--context-sec 15] [--max-chars 450]

Prints {"ok":true,"review":{summary, cuts[]},"markdown":"..."}.
For each cut (end of slide i): the position, confidence, status, the transcript around it (marked with the cut), the script
end/start, where the alignment found the last sentence of slide i and the first of slide i+1 (and how much of them matched),
the quiet stretches around, the next-best candidates, and flags that tell what looks suspicious. The alignment is recomputed
from the transcript and the script (it does not depend on the positions stored in boundaries.json, which may have been moved
by hand); the positions shown are the ones stored in boundaries.json.
"""
import argparse
import json
import os
import re
import sys
import types

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import align as A  # noqa: E402
from speech_common import SpeechError, emit, fail, progress, read_wav_info, setup_stdio  # noqa: E402
from speech_norm import normalize  # noqa: E402
from speech_silence import analyze  # noqa: E402

LOW_CONF = 0.9
MARK_EVERY_S = 5
SENT_RE = re.compile(r"[^。！？!?]*[。！？!?]|[^。！？!?]+$")


def split_sentences(text):
    return [m.group(0).strip() for m in SENT_RE.finditer(text) if m.group(0).strip()]


def sentence_ranges(slide_text, slide_norm):
    """[(raw sentence, start, end)] in offsets of the slide's normalised text."""
    sents = split_sentences(slide_text)
    norms = [normalize(x) for x in sents]
    if "".join(norms) != slide_norm:
        return [(slide_text.strip(), 0, len(slide_norm))] if slide_norm else []
    out, o = [], 0
    for raw, nz in zip(sents, norms):
        if nz:
            out.append((raw, o, o + len(nz)))
        o += len(nz)
    return out


def locate(ctx, abs_a, abs_b):
    """Where the script chars [abs_a, abs_b) were found in the transcript: (start_sec, end_sec, match ratio) or None."""
    words, aligned, match, Tw = ctx["words"], ctx["aligned"], ctx["match"], ctx["Tw"]
    al = aligned[abs_a:abs_b]
    idx = np.nonzero(al >= 0)[0]
    L = abs_b - abs_a
    if L <= 0:
        return None
    ratio = float(match[abs_a:abs_b].sum()) / L
    if not len(idx):
        return {"found": False, "ratio": 0.0, "startSec": None, "endSec": None}
    t0, t1 = int(al[idx[0]]), int(al[idx[-1]])
    return {"found": True, "ratio": round(ratio, 3), "startSec": words[int(Tw[t0])]["start"], "endSec": words[int(Tw[t1])]["end"]}


def repeat_peaks(ng, norm_sent, lo_pos, hi_pos):
    """Separate peaks (>= 0.6, with a dip between) of 'this sentence ends here' in T[lo_pos:hi_pos]. Returns [(pos, score)]."""
    if len(norm_sent) < 6 or ng.M == 0:
        return []
    pos = np.arange(ng.M + 1)
    sc = ng.window_inter(norm_sent, pos - (len(norm_sent) + 3), pos)
    lo, hi = max(0, lo_pos), min(ng.M, hi_pos)
    if hi <= lo:
        return []
    sub = sc[lo:hi + 1]
    top = float(sub.max())
    if top < 0.6:
        return []
    order = np.argsort(-sub, kind="stable")
    peaks = []
    gap = max(8, len(norm_sent) // 2)
    for k in order[:300]:
        p = lo + int(k)
        if sc[p] < max(0.6, 0.75 * top):
            break
        ok = True
        for q, _ in peaks:
            a_, b_ = min(p, q), max(p, q)
            if b_ - a_ < gap or sc[a_:b_ + 1].min() > min(sc[p], sc[q]) - 0.1:
                ok = False
                break
        if ok:
            peaks.append((p, float(sc[p])))
    return sorted(peaks)


def time_of_pos(ctx, pos):
    words, Tw = ctx["words"], ctx["Tw"]
    M = len(Tw)
    if M == 0:
        return 0.0
    if pos <= 0:
        return words[int(Tw[0])]["start"]
    if pos >= M:
        return words[int(Tw[M - 1])]["end"]
    return (words[int(Tw[pos - 1])]["end"] + words[int(Tw[pos])]["start"]) / 2.0


def context_text(words, sec, ctx_sec):
    """Transcript text around `sec`: before ▮ after, with ⟨N⟩ marks every 5 s (N = seconds from the start of the audio)."""
    def side(ws):
        out, last = [], None
        for w in ws:
            mid = (w["start"] + w["end"]) / 2.0
            k = int(mid // MARK_EVERY_S)
            if last is None or k != last:
                if last is not None or True:
                    out.append("⟨%d⟩" % (k * MARK_EVERY_S))
                last = k
            out.append(w["w"])
        return "".join(out)
    before = [w for w in words if (w["start"] + w["end"]) / 2.0 < sec and (w["start"] + w["end"]) / 2.0 >= sec - ctx_sec]
    after = [w for w in words if (w["start"] + w["end"]) / 2.0 >= sec and (w["start"] + w["end"]) / 2.0 < sec + ctx_sec]
    return side(before), side(after)


def build(a):
    with open(a.boundaries, "r", encoding="utf-8") as f:
        bnd = json.load(f)
    if bnd.get("format") != "lap-narrator/boundaries":
        raise SpeechError("bad-boundaries", "not a boundaries.json")
    ns = types.SimpleNamespace(transcript=a.transcript, script=a.script, audio=a.audio, threshold=0.8, audio_label="", transcript_label="",
                               skip_hash=True, want_ctx=True)
    res = A.run(ns)
    ctx = res["_ctx"]
    slides, info_s, starts, rate = ctx["slides"], ctx["info_s"], ctx["starts"], ctx["rate"]
    ids = [s["slideId"] for s in slides]
    bslides = bnd["slides"]
    if [s["slideId"] for s in bslides] != ids:
        raise SpeechError("slides-mismatch", "the slides of boundaries.json differ from the recordable slides of the script")
    if bnd["audio"]["samples"] != ctx["total"] or bnd["sampleRate"] != rate:
        raise SpeechError("audio-mismatch", "boundaries.json was made for another audio (length or sampling rate differs)")
    words, ng, audio_path, ainfo = ctx["words"], ctx["ng"], ctx["audio_path"], ctx["audio_info"]
    n = len(slides)
    rng_sents = [sentence_ranges(s.get("text", ""), info_s[i]["norm"]) for i, s in enumerate(slides)]
    cuts = []
    for i in range(n - 1):
        bs = bslides[i]
        sec = bs["endSample"] / rate
        A_, B_ = info_s[i], info_s[i + 1]
        flags = []

        def flag(code, msg, sev="warn"):
            flags.append({"code": code, "severity": sev, "message": msg})

        # sentences of the two slides: where the alignment found them
        found = {}
        for tag, si in (("A", i), ("B", i + 1)):
            lst = []
            for k, (raw, o0, o1) in enumerate(rng_sents[si]):
                loc = locate(ctx, int(starts[si]) + o0, int(starts[si]) + o1)
                lst.append({"k": k + 1, "text": raw, "norm": info_s[si]["norm"][o0:o1], **(loc or {"found": False, "ratio": 0.0, "startSec": None, "endSec": None})})
            found[tag] = lst
        lastA = found["A"][-1] if found["A"] else None
        firstB = found["B"][0] if found["B"] else None

        def brief(x):
            if not x:
                return None
            return {"sentence": x["k"], "text": x["text"][:24], "found": x["found"], "atSec": None if x["startSec"] is None else round((x["startSec"] + x["endSec"]) / 2, 2),
                    "startSec": x["startSec"], "endSec": x["endSec"], "match": x["ratio"]}

        # --- flags
        if bs["status"] == "needs-decision":
            flag("needs-decision", "aligner not confident (%.2f)" % bs.get("confidence", 0))
        if bs.get("method") == "interpolated" or not A_["found"] or not B_["found"]:
            flag("slide-not-found", "%s or %s not found in the audio (or script empty): position interpolated" % (ids[i], ids[i + 1]))
        for tag, si, pick in (("A", i, found["A"][-1:]), ("B", i + 1, found["B"][:1])):   # only the sentences that touch this cut
            for x in pick:
                if not x["found"] or x["ratio"] < 0.3:
                    flag("skipped-sentence", "sentence %d of %s (\"%s…\") not in the transcript (%d%%): skipped or misrecognised" % (x["k"], ids[si], x["text"][:10], round(100 * x["ratio"])))
        if lastA and lastA["found"] and 0.3 <= lastA["ratio"] < 0.6:
            flag("weak-edge-match", "last sentence of %s matches only %d%%" % (ids[i], round(100 * lastA["ratio"])))
        if firstB and firstB["found"] and 0.3 <= firstB["ratio"] < 0.6:
            flag("weak-edge-match", "first sentence of %s matches only %d%%" % (ids[i + 1], round(100 * firstB["ratio"])))
        ins = 0
        if A_["found"] and B_["found"] and B_["first_t"] > A_["last_t"]:
            ins = int((~ctx["claimed"][A_["last_t"] + 1:B_["first_t"]]).sum())
        if ins >= 3:
            flag("extra-words", "%d transcript chars between the slides fit no script sentence (ad-lib, filler, repeat?)" % ins)
        # repeated sentences: the alignment uses one copy of a sentence; the other copy is left over (unclaimed transcript chars).
        # A leftover run near the cut that matches a sentence of the two slides is a repeat (or a re-take of the sentence).
        Tn, claimed, Tw = ctx["T"], ctx["claimed"], ctx["Tw"]
        near = [p for p in range(len(Tn)) if sec - 30.0 <= words[int(Tw[p])]["start"] <= sec + 30.0]
        if near and ng.M:
            runs_, p = [], near[0]
            while p <= near[-1]:
                if not claimed[p]:
                    q = p
                    while q + 1 <= near[-1] and (not claimed[q + 1] or (q + 2 <= near[-1] and not claimed[q + 2])):
                        q += 1
                    runs_.append((p, q + 1))
                    p = q + 1
                else:
                    p += 1
            runs_ = [(x, y) for x, y in runs_ if y - x >= 6]
            seen = set()
            for tag, si in (("A", i), ("B", i + 1)):
                for x in found[tag]:
                    if len(x["norm"]) < 6:
                        continue
                    for (r0, r1) in runs_:
                        rec = float(ng.window_inter(x["norm"], np.array([r0]), np.array([r1]))[0])
                        if rec >= 0.4 and (ids[si], x["k"]) not in seen:
                            seen.add((ids[si], x["k"]))
                            flag("repeat-suspected", "sentence %d of %s (\"%s…\") said twice? a second copy at ~%.1f s" % (x["k"], ids[si], x["text"][:10], time_of_pos(ctx, r0)))
        # silence around the cut
        r = analyze(audio_path, ainfo, sec - 3.0, sec + 3.0)
        runs = [(s_, e_) for s_, e_ in r["runs"] if e_ - s_ >= 0.15]
        runs.sort(key=lambda x: min(abs(x[0] - sec), abs(x[1] - sec)) if not (x[0] <= sec <= x[1]) else 0)
        runs = runs[:3]
        at_run = next(((s_, e_) for s_, e_ in runs if s_ - 0.03 <= sec <= e_ + 0.03), None)
        if at_run is None:
            flag("no-silence-at-cut", "cut is not inside a quiet stretch (>=0.15 s): may fall in speech")
        elif at_run[1] - at_run[0] < 0.4:
            flag("short-silence", "quiet stretch at the cut only %.2f s" % (at_run[1] - at_run[0]))
        # next-best candidates (n-gram score of 'end of slide i' + 'start of slide i+1')
        cands = []
        topscore = 0.0
        if len(A_["norm"]) >= 3 and len(B_["norm"]) >= 3 and ng.M:
            sc = ng.boundary_scores(A_["norm"][-A.NGRAM_SIDE:], B_["norm"][:A.NGRAM_SIDE])
            lo_p = A_["last_t"] + 1 if A_["found"] else 0
            hi_p = max(lo_p, B_["first_t"]) if B_["found"] else lo_p
            main_pos = lo_p + int(np.argmax(sc[lo_p:hi_p + 1])) if hi_p >= lo_p else lo_p
            topscore = float(sc[lo_p:hi_p + 1].max()) if hi_p >= lo_p else 0.0
            for pos in np.argsort(-sc, kind="stable")[:400]:
                if len(cands) >= 2 or sc[pos] < 0.3:
                    break
                if lo_p - 3 <= pos <= hi_p + 3:
                    continue
                seg = sc[min(pos, main_pos):max(pos, main_pos) + 1]
                if seg.min() > sc[pos] - 0.04:
                    continue
                t = time_of_pos(ctx, int(pos))
                if any(abs(t - c["sec"]) < 1.0 for c in cands) or abs(t - sec) < 1.0:
                    continue
                cands.append({"sec": round(t, 2), "score": round(float(sc[pos]), 2)})
            if cands and cands[0]["score"] >= 0.5 and cands[0]["score"] >= 0.8 * topscore:
                flag("competing-candidate", "%.1f s fits the two script edges as well (%.2f vs %.2f)" % (cands[0]["sec"], cands[0]["score"], topscore))
        # ASR confidence of the words around
        around = [w["p"] for w in words if sec - 2.0 <= w["start"] <= sec + 2.0]
        if len(around) >= 3 and sum(around) / len(around) < 0.6:
            flag("low-asr-confidence", "ASR probability near the cut is low (mean %.2f)" % (sum(around) / len(around)))
        if bs.get("confidence", 1) < LOW_CONF and bs["status"] != "needs-decision" and bs.get("method") != "manual":
            flag("low-confidence", "confidence %.2f is below %.2f" % (bs.get("confidence", 0), LOW_CONF), "info")
        if bs.get("method") == "manual":
            flag("moved-by-hand", "this boundary was set by hand" + (" (before: %.2f s)" % (bs["previous"]["endSample"] / rate) if bs.get("previous") else ""), "info")
        auto = ctx["cuts"][i]
        if bs.get("method") != "manual" and abs(sec - auto["cut_s"]) > 1.0:
            flag("differs-from-aligner", "the stored position (%.2f s) is %.1f s away from where the alignment puts it (%.2f s)" % (sec, abs(sec - auto["cut_s"]), auto["cut_s"]))
        cut = {
            "index": i + 1, "slideId": ids[i], "nextSlideId": ids[i + 1], "sec": round(sec, 3), "sample": bs["endSample"],
            "confidence": bs.get("confidence"), "status": bs["status"], "method": bs.get("method"),
            "alignerSec": round(auto["cut_s"], 3), "alignerConfidence": round(auto["conf"], 3),
            "flags": flags,
            "script": {"end": slides[i].get("text", "").strip()[-60:], "nextStart": slides[i + 1].get("text", "").strip()[:60]},
            "match": {"lastSentenceOfSlide": brief(lastA), "firstSentenceOfNext": brief(firstB), "insertedChars": ins},
            "silence": [{"start": round(s_, 2), "end": round(e_, 2), "len": round(e_ - s_, 2), "atCut": (s_ - 0.03 <= sec <= e_ + 0.03)} for s_, e_ in sorted(runs)],
            "candidates": cands,
        }
        if bs.get("previous"):
            cut["previous"] = bs["previous"]
        cuts.append(cut)
        progress("review", i + 1, n - 1)
    return bnd, ctx, cuts


def render(cuts, bnd, ctx, ctx_sec, max_chars):
    """One block per cut, at most max_chars when possible: first the transcript context is shortened (down to 4 s),
    then the script edges (60 -> 40 -> 30 chars) and the flag messages."""
    words = ctx["words"]
    blocks = []
    steps = []
    cs = ctx_sec
    while True:
        steps.append((cs, 60, 110))
        if cs <= 4:
            break
        cs = max(4, cs - 2)
    steps += [(4, 40, 80), (4, 30, 50)]
    for c in cuts:
        for k, (cs, sl, fl) in enumerate(steps):
            before, after = context_text(words, c["sec"], cs)
            c["transcript"] = {"before": before, "after": after, "contextSec": cs}
            blk = render_cut(c, sl, fl)
            if len(blk) <= max_chars or k == len(steps) - 1:
                blocks.append(blk)
                break
    return blocks


def fmt_sec(x):
    return "%.2f" % x


def render_cut(c, script_len=60, flag_len=110):
    tight = script_len <= 30
    flags = [f for f in c["flags"]]
    warn = [f["code"] for f in flags if f["severity"] == "warn"]
    head = "## %d. %s→%s @%ss %s %.2f%s" % (c["index"], c["slideId"], c["nextSlideId"], fmt_sec(c["sec"]), c["status"], c["confidence"] if c["confidence"] is not None else 0,
                                           ("  ⚑" + ",".join(dict.fromkeys(warn))) if warn else "")
    t = c["transcript"]
    lines = [head, "…" + t["before"] + "▮" + t["after"] + "…",
             "台本 末「%s」 次頭「%s」" % (c["script"]["end"][-script_len:], c["script"]["nextStart"][:script_len])]
    m = c["match"]
    parts = []
    for tag, key in (("末文", "lastSentenceOfSlide"), ("次頭文", "firstSentenceOfNext")):
        x = m[key]
        parts.append("%s %s" % (tag, ("%ss %d%%" % (fmt_sec(x["atSec"]), round(100 * x["match"]))) if x and x["found"] and x["atSec"] is not None else "なし"))
    sil = " ".join("%s–%s%s" % (fmt_sec(s["start"]), fmt_sec(s["end"]), "*" if s["atCut"] else "") for s in (sorted(sorted(c["silence"], key=lambda x: not x["atCut"])[:2], key=lambda x: x["start"]) if tight else c["silence"])) or "なし"
    cand = " ".join("%ss(%.2f)" % (fmt_sec(x["sec"]), x["score"]) for x in (c["candidates"][:1] if tight else c["candidates"])) or "なし"
    lines.append("照合 %s | 無音 %s | 次点 %s" % (" / ".join(parts), sil, cand))
    notes = [f for f in flags if f["severity"] == "warn" or f["code"] == "moved-by-hand"]
    for k, f in enumerate(notes):
        lines.append(("⚑ %s: %s" % (f["code"], f["message"][:flag_len])) if k < 2 else "⚑ %s" % f["code"])
    return "\n".join(lines)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--boundaries", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--context-sec", type=float, default=15.0)
    ap.add_argument("--max-chars", type=int, default=450)
    a = ap.parse_args(argv)
    for p, what in ((a.boundaries, "boundaries"), (a.transcript, "transcript"), (a.script, "script"), (a.audio, "audio")):
        if not os.path.exists(p):
            return fail("cannot-read", "no such %s file: %s" % (what, p))
    A.progress = lambda *x, **k: None
    bnd, ctx, cuts = build(a)
    blocks = render(cuts, bnd, ctx, a.context_sec, a.max_chars)
    counts = {"auto": 0, "confirmed": 0, "needs-decision": 0}
    for s in bnd["slides"][:-1]:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    flagged = [c for c in cuts if any(f["severity"] == "warn" for f in c["flags"])]
    head = ["# 切れ目の見直し：%d 件（auto %d、confirmed %d、needs-decision %d）、⚑ のある切れ目 %d 件" % (len(cuts), counts["auto"], counts["confirmed"], counts["needs-decision"], len(flagged)),
            "▮＝切れ目の位置、⟨N⟩＝N 秒の目印。前後の文字起こしと台本の端が合っているかを見る。違えば `narrate boundary set --slide <id> --at <秒>`、または `--at-text \"この語句の直後\"`（文字起こしの語句）で直す。",
            ""]
    md = "\n".join(head) + "\n" + "\n\n".join(blocks) + "\n"
    summary = {"cuts": len(cuts), **{k.replace("-", "_"): v for k, v in counts.items()}, "flagged": len(flagged),
               "flaggedSlides": [c["slideId"] for c in flagged], "lowConfidence": [c["slideId"] for c in cuts if (c["confidence"] or 0) < LOW_CONF],
               "markdownChars": len(md), "maxCutChars": max((len(b) for b in blocks), default=0)}
    emit({"ok": True, "review": {"format": "lap-narrator/boundary-review", "version": 1, "summary": summary, "cuts": cuts}, "markdown": md})
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
        import traceback
        sys.stderr.write(traceback.format_exc())
        sys.exit(fail("internal-error", "%s: %s" % (type(e).__name__, e)))
