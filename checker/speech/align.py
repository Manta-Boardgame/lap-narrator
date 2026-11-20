#!/usr/bin/env python
"""align: decide the slide boundaries of one continuous recording from its transcript and the script (PLAN2).

  .venv\\Scripts\\python.exe -I checker/speech/align.py --transcript <transcript.json> --script <script.json|script-pack.zip>
        --audio <wav> [--threshold 0.8] [--audio-label final/all.wav] [--transcript-label transcript.json]
        [--debug]

Prints one JSON object: {"ok":true,"boundaries":{...boundaries.json...},"needsDecision":[...],"report":{...}}.
The Node side (cli/cmd/align.js) writes boundaries.json and turns needsDecision into exit code 4.

Method (see dev/proposals/G-001.md):
  1. normalise script and transcript (speech_norm.py); no reading conversion.
  2. a monotone dynamic programme (semi-global edit alignment, numpy) lays the script chars (in slide order) over the
     transcript chars; omissions, repeats, ad-libs and ASR errors become gaps / substitutions.
  3. for each cut between slide k and k+1: the words of the last aligned char of k and of the first aligned char of k+1
     give a window; the cut is the middle of the longest quiet run in that window (waveform RMS), or the middle of the
     word gap when the run is shorter than 0.2 s.
  4. confidence from: exact-match share of the 15 script chars on each side of the cut, transcript chars between the
     two slides that belong to no script char (ad-lib / repeat), the margin to the next-best candidate (character
     2-/3-gram match of the script tail and head around every position), silence length, ASR word probability,
     and the slide's overall coverage. Below the threshold: needs-decision.
"""
import argparse
import json
import re
import math
import os
import sys
import time
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speech_common import SpeechError, emit, fail, progress, read_wav_info, setup_stdio, sha256_file  # noqa: E402
from speech_norm import normalize, normalize_pairs  # noqa: E402
from speech_silence import analyze, pick_cut  # noqa: E402

MATCH, MIS, GAP_S, GAP_T = 20, -15, -10, -6    # DP scores x10 (ints): script char skipped = GAP_S, transcript char skipped = GAP_T
MAX_CELLS = 400_000_000
ANCHOR_CHARS = 15
MIN_FOUND_COVERAGE = 0.30
MIN_FOUND_MATCHES = 4
CAND_SEPARATION_S = 1.0
NGRAM_SIDE = 24
MIN_SEP_S = 0.05


# ---- inputs -----------------------------------------------------------------------------------------------------------

_NOTE_MARKER = re.compile(r"^\s*[【\[［]\s*約?\s*[0-9０-９]+\s*(?:秒|分|sec|s|min)[^】\]］]{0,12}[】\]］]\s*")


def strip_note_markers(text):
    """Remove a leading timing hint like 【約15秒】 / [約1分] from the script text of a slide (it is a note for the speaker, not speech)."""
    return _NOTE_MARKER.sub("", text or "", count=1)


def load_script(path):
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            with z.open("script.json") as f:
                return json.loads(f.read().decode("utf-8"))
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---- dynamic programme --------------------------------------------------------------------------------------------------

def align_dp(S, T):
    """S, T: int32 arrays of code points. Returns (aligned_t[len S] (-1 = skipped), is_match[len S])."""
    N, M = len(S), len(T)
    if N * (M + 1) > MAX_CELLS:
        raise SpeechError("too-long", "audio/script too long for the in-memory alignment (%d x %d chars); split the recording" % (N, M))
    NEG = -10 ** 8
    idx = np.arange(M + 1, dtype=np.int64)
    H = np.zeros(M + 1, dtype=np.int64)
    ptr = np.zeros((N + 1, M + 1), dtype=np.uint8)
    for i in range(1, N + 1):
        diag = np.full(M + 1, NEG, dtype=np.int64)
        diag[1:] = H[:-1] + np.where(T == S[i - 1], MATCH, MIS)
        up = H + GAP_S
        c = np.maximum(diag, up)
        Hn = np.maximum.accumulate(c - GAP_T * idx) + GAP_T * idx
        p = np.full(M + 1, 2, dtype=np.uint8)
        p[Hn == up] = 1
        p[Hn == diag] = 0
        ptr[i] = p
        H = Hn
        if i % 64 == 0:
            progress("align", i, N)
    j = int(np.argmax(H))
    aligned = np.full(N, -1, dtype=np.int64)
    match = np.zeros(N, dtype=bool)
    i = N
    while i > 0:
        p = ptr[i][j]
        if j == 0:
            p = 1
        if p == 0:
            aligned[i - 1] = j - 1
            match[i - 1] = bool(S[i - 1] == T[j - 1])
            i -= 1
            j -= 1
        elif p == 1:
            i -= 1
        else:
            j -= 1
    return aligned, match


# ---- character n-gram boundary score ----------------------------------------------------------------------------------

def _gram_counts(s, n):
    d = {}
    for k in range(len(s) - n + 1):
        g = s[k:k + n]
        d[g] = d.get(g, 0) + 1
    return d


class NgramIndex:
    """Prefix counts of the character 2-/3-grams of T, to score 'script text X ends / starts exactly at position pos'."""

    def __init__(self, T):
        self.T = T
        self.M = len(T)
        self.arr = np.array([ord(c) for c in T], dtype=np.int32)
        self.cache = {}

    def prefix(self, g):
        p = self.cache.get(g)
        if p is None:
            n = len(g)
            if self.M - n + 1 > 0:
                occ = np.ones(self.M - n + 1, dtype=np.int32)
                for k, ch in enumerate(g):
                    occ &= (self.arr[k:self.M - n + 1 + k] == ord(ch)).astype(np.int32)
            else:
                occ = np.zeros(0, dtype=np.int32)
            p = np.concatenate([[0], np.cumsum(occ)]).astype(np.int32)
            self.cache[g] = p
        return p

    def window_inter(self, text, lo, hi):
        """sum_g min(count_text(g), count of g inside T[lo:hi]) for arrays lo, hi (one value per position)."""
        total = np.zeros(len(lo), dtype=np.float64)
        denom = 0
        for n in (2, 3):
            counts = _gram_counts(text, n)
            denom += max(0, len(text) - n + 1)
            for g, cnt in counts.items():
                p = self.prefix(g)
                ns = len(p) - 1
                a = np.clip(lo, 0, ns)
                b = np.clip(hi - n + 1, 0, ns)
                b = np.maximum(b, a)
                total += np.minimum(p[b] - p[a], cnt)
        return total / denom if denom else total

    def boundary_scores(self, tail, head):
        """S[pos] for pos = 0..M: how well the script `tail` sits just before pos and `head` just after."""
        pos = np.arange(self.M + 1)
        left = self.window_inter(tail, pos - (len(tail) + 4), pos) if len(tail) >= 3 else np.zeros(len(pos))
        right = self.window_inter(head, pos, pos + (len(head) + 4)) if len(head) >= 3 else np.zeros(len(pos))
        return (left + right) / 2.0


# ---- main -------------------------------------------------------------------------------------------------------------------

def run(a):
    t_start = time.time()
    tr = getattr(a, "transcript_obj", None)
    if tr is None:
        with open(a.transcript, "r", encoding="utf-8") as f:
            tr = json.load(f)
    if tr.get("format") != "lap-narrator/transcript":
        raise SpeechError("bad-transcript", "not a transcript.json")
    words = tr["words"]
    audio_path = a.audio
    info = read_wav_info(audio_path)
    rate = info["sampleRate"]
    total = info["samples"]
    if info["sampleRate"] != tr["audio"]["sampleRate"] or total != tr["audio"]["samples"]:
        raise SpeechError("transcript-mismatch", "the transcript was made from a different audio (rate/length differ)", {"transcript": tr["audio"], "audio": {"sampleRate": rate, "samples": total}})
    if not a.skip_hash:
        progress("hash", 0, 1)
        sha = sha256_file(audio_path)
        if sha != tr["audio"]["sha256"]:
            raise SpeechError("transcript-mismatch", "the transcript was made from a different audio (SHA-256 differs)")
        progress("hash", 1, 1)

    script = getattr(a, "script_obj", None) or load_script(a.script)
    slides = sorted([dict(s) for s in script["slides"] if s.get("recordable", True)], key=lambda s: s["order"])
    for _s in slides:  # speaker-note timing hints such as "【約15秒】" are not spoken: drop them before matching
        _s["text"] = strip_note_markers(_s.get("text", ""))
    n = len(slides)
    if n == 0:
        raise SpeechError("no-slides", "the script has no recordable slide")

    # transcript: chars with word index
    pairs = []
    for wi, w in enumerate(words):
        for ch in w["w"]:
            pairs.append((ch, wi))
    tnorm = normalize_pairs(pairs)
    T = "".join(c for c, _ in tnorm)
    Tw = np.array([w for _, w in tnorm], dtype=np.int64)
    M = len(T)

    # script: chars with slide index
    S_parts = []
    for si, s in enumerate(slides):
        s["_norm"] = normalize(s.get("text", ""))
        S_parts.append(s["_norm"])
    S = "".join(S_parts)
    starts = np.cumsum([0] + [len(p) for p in S_parts])
    N = len(S)

    dur = total / rate
    dp_sec = 0.0
    if N and M:
        t0 = time.time()
        aligned, match = align_dp(np.array([ord(c) for c in S], dtype=np.int32), np.array([ord(c) for c in T], dtype=np.int32))
        dp_sec = time.time() - t0
    else:
        aligned, match = np.full(N, -1, dtype=np.int64), np.zeros(N, dtype=bool)
    claimed = np.zeros(M, dtype=bool)
    for t in aligned:
        if t >= 0:
            claimed[t] = True

    # per slide statistics
    info_s = []
    for si in range(n):
        a0, a1 = int(starts[si]), int(starts[si + 1])
        L = a1 - a0
        al = aligned[a0:a1]
        mt = match[a0:a1]
        idxs = np.nonzero(al >= 0)[0]
        exact = int(mt.sum())
        cov = exact / L if L else 0.0
        found = L > 0 and cov >= MIN_FOUND_COVERAGE and exact >= min(MIN_FOUND_MATCHES, L)
        k = min(ANCHOR_CHARS, L)
        head_q = float(mt[:k].sum()) / k if k else 0.0
        tail_q = float(mt[L - k:].sum()) / k if k else 0.0
        first_t = int(al[idxs[0]]) if len(idxs) else -1
        last_t = int(al[idxs[-1]]) if len(idxs) else -1
        info_s.append({"len": L, "exact": exact, "cov": cov, "found": found, "head_q": head_q, "tail_q": tail_q,
                       "first_t": first_t, "last_t": last_t, "mt": mt, "text": slides[si].get("text", ""), "norm": slides[si]["_norm"]})

    def wtime(widx, which):
        w = words[int(widx)]
        return w[which]

    def word_of(tidx):
        return int(Tw[tidx])

    def mean_p(widxs):
        ps = [words[i]["p"] for i in widxs if 0 <= i < len(words)]
        return sum(ps) / len(ps) if ps else 0.5

    ng = NgramIndex(T) if M else None

    cuts = [None] * max(0, n - 1)   # dict per cut

    # ---- cuts between two found slides
    def make_found_cut(k):
        A, B = info_s[k], info_s[k + 1]
        wlo, whi = word_of(A["last_t"]), word_of(B["first_t"])
        if whi < wlo:
            whi = wlo
        win0 = wtime(wlo, "start")
        win1 = wtime(whi, "end")
        gap_lo = wtime(wlo, "end")
        gap_hi = wtime(whi, "start")
        cut_s, run_len, kind = pick_cut(audio_path, info, win0, win1, gap_lo, gap_hi)
        ins = int((~claimed[A["last_t"] + 1:B["first_t"]]).sum()) if B["first_t"] > A["last_t"] else 0
        # candidates by n-gram score
        tail = A["norm"][-NGRAM_SIDE:]
        head = B["norm"][:NGRAM_SIDE]
        sc = ng.boundary_scores(tail, head)
        lo_pos, hi_pos = A["last_t"] + 1, max(A["last_t"] + 1, B["first_t"])
        dp_score = float(sc[lo_pos:hi_pos + 1].max()) if hi_pos >= lo_pos else float(sc[lo_pos])
        cands = [{"sample": int(round(cut_s * rate)), "score": round(dp_score, 3), "_t": cut_s}]
        main_pos = lo_pos + int(np.argmax(sc[lo_pos:hi_pos + 1])) if hi_pos >= lo_pos else lo_pos
        order = np.argsort(-sc, kind="stable")
        for pos in order[:400]:
            if len(cands) >= 3 or sc[pos] < 0.3:
                break
            if lo_pos - 3 <= pos <= hi_pos + 3:
                continue
            # a separate peak, not the shoulder of the main one: the score must dip between them
            seg = sc[min(pos, main_pos):max(pos, main_pos) + 1]
            if seg.min() > sc[pos] - 0.04:
                continue
            wa = word_of(pos - 1) if pos > 0 else word_of(0)
            wb = word_of(pos) if pos < M else word_of(M - 1)
            c_s, _, _ = pick_cut(audio_path, info, wtime(wa, "start"), wtime(wb, "end"), wtime(wa, "end"), wtime(wb, "start"))
            if any(abs(c_s - c["_t"]) < CAND_SEPARATION_S for c in cands):
                continue
            cands.append({"sample": int(round(c_s * rate)), "score": round(float(sc[pos]), 3), "_t": c_s})
        other = max([c["score"] for c in cands[1:]], default=0.0)
        margin = max(0.0, dp_score - other)
        ps = mean_p(list(range(wlo - 2, wlo + 1)) + list(range(whi, whi + 3)))
        cov_f = 0.8 + 0.2 * min(1.0, min(A["cov"], B["cov"]) / 0.8)
        anchor = min(A["tail_q"], B["head_q"])
        ka, kb = min(30, A["len"]), min(30, B["len"])
        q30 = (float(A["mt"][A["len"] - ka:].sum()) + float(B["mt"][:kb].sum())) / max(1, ka + kb)
        ins_f = 1.0 if ins <= 2 else max(0.0, 1.0 - 0.12 * (ins - 2))
        margin_f = min(1.0, margin / 0.25)
        if kind == "silence":
            sil_f = 1.0 if run_len >= 0.4 else 0.85 + 0.15 * (run_len - 0.2) / 0.2
        else:
            sil_f = 0.6
        quality = 0.5 * anchor + 0.5 * q30
        q_f = min(1.0, max(0.0, (quality - 0.35) / 0.40))
        margin_f2 = 0.25 + 0.75 * margin_f
        dp_f = 0.5 + 0.5 * min(1.0, dp_score / 0.55)
        conf = q_f * margin_f2 * dp_f * ins_f * sil_f * (0.75 + 0.25 * ps) * cov_f
        # rescale so a clean boundary (all factors near 1) reaches ~1
        conf = max(0.0, min(1.0, conf))
        return {"cut_s": cut_s, "conf": conf, "method": "asr-align", "kind": kind, "runLen": run_len, "ins": ins,
                "anchor": anchor, "margin": margin, "p": ps, "cands": cands,
                "factors": {"q30": round(q30, 3), "covA": round(A["cov"], 3), "covB": round(B["cov"], 3), "tailQ": round(A["tail_q"], 3), "headQ": round(B["head_q"], 3), "anchor": round(anchor, 3), "ins": ins, "insF": round(ins_f, 3), "dpScore": round(dp_score, 3), "other": round(other, 3), "margin": round(margin, 3), "silF": round(sil_f, 3), "p": round(ps, 3), "covF": round(cov_f, 3)}}

    # ---- runs of slides that were not found: cuts spread inside the interval between the neighbouring found slides
    k = 0
    while k < n:
        if info_s[k]["found"]:
            k += 1
            continue
        j = k
        while j < n and not info_s[j]["found"]:
            j += 1
        # unfound slides k..j-1; found neighbours: k-1 (or none) and j (or none)
        left = k - 1 if k > 0 else None
        right = j if j < n else None
        tA = wtime(word_of(info_s[left]["last_t"]), "end") if left is not None else 0.0
        tB = wtime(word_of(info_s[right]["first_t"]), "start") if right is not None else dur
        weights = [max(info_s[x]["len"], 8) for x in range(k, j)]
        tot_w = float(sum(weights))
        cut_ids, tgt = [], []
        if left is not None:
            cut_ids.append(k - 1)
            tgt.append(tA)
        acc = 0.0
        for x in range(k, j - 1):
            acc += weights[x - k]
            cut_ids.append(x)
            tgt.append(tA + (tB - tA) * acc / tot_w)
        if right is not None:
            cut_ids.append(j - 1)
            tgt.append(tB)
        for cid, t in zip(cut_ids, tgt):
            r = analyze(audio_path, info, max(0.0, t - 0.75), min(dur, t + 0.75))
            best = None
            bd = None
            for s_, e_ in r["runs"]:
                if e_ - s_ < 0.2:
                    continue
                d = 0.0 if s_ <= t <= e_ else min(abs(t - s_), abs(t - e_))
                if bd is None or d < bd:
                    best, bd = (s_, e_), d
            cs = (best[0] + best[1]) / 2.0 if best else t
            cuts[cid] = {"cut_s": cs, "conf": 0.3, "method": "interpolated", "kind": "interpolated", "runLen": 0.0, "ins": 0,
                         "anchor": 0.0, "margin": 0.0, "p": 0.0, "cands": [{"sample": int(round(cs * rate)), "score": 0.0, "_t": cs}], "factors": {}}
        k = j

    for c in range(n - 1):
        if cuts[c] is None:
            cuts[c] = make_found_cut(c)
            progress("cuts", c + 1, n - 1)

    # ---- samples: strictly increasing, inside (0, total)
    cs = [int(round(c["cut_s"] * rate)) for c in cuts]
    min_sep = max(1, int(round(MIN_SEP_S * rate)))
    prev = 0
    for i, v in enumerate(cs):
        v = max(v, prev + min_sep)
        cs[i] = v
        prev = v
    over = total - 1
    for i in range(len(cs) - 1, -1, -1):
        if cs[i] > over:
            cs[i] = over
        over = cs[i] - 1
    if cs and (cs[0] <= 0 or any(cs[i] >= cs[i + 1] for i in range(len(cs) - 1))):
        # degenerate (more slides than room): even spacing
        cs = [int(total * (i + 1) / n) for i in range(n - 1)]

    bounds = [0] + cs + [total]
    thr = a.threshold
    out_slides = []
    need = []
    for i, s in enumerate(slides):
        st = info_s[i]
        if i < n - 1:
            c = cuts[i]
            conf = round(float(c["conf"]), 3)
            method = c["method"]
        else:
            # the end of the last slide is the end of the audio; its confidence is that of the slide itself
            c = None
            conf = round(float(min(1.0, st["cov"] / 0.8)) if st["found"] else 0.0, 3)
            method = "asr-align" if st["found"] else "interpolated"
        # a slide that was not found makes the cut that starts it undecided as well
        status = "auto" if (conf >= thr and method == "asr-align") else "needs-decision"
        if n == 1:
            conf, method, status = 1.0, "asr-align", "auto"
        cands = []
        if c:
            cands = [{"sample": int(round(x["sample"])), "score": x["score"]} for x in c["cands"]]
            cands[0]["sample"] = bounds[i + 1]
        out_slides.append({"slideId": s["slideId"], "order": s["order"], "startSample": bounds[i], "endSample": bounds[i + 1],
                           "confidence": conf, "method": method, "status": status, "candidates": cands})
    # the cut into an unfound slide is undecided too
    for i in range(1, n):
        if not info_s[i]["found"] and n > 1 and out_slides[i - 1]["status"] == "auto":
            out_slides[i - 1]["status"] = "needs-decision"
            out_slides[i - 1]["method"] = "interpolated"
    for i in range(n):
        if not info_s[i]["found"] and out_slides[i]["status"] == "auto":
            out_slides[i]["status"] = "needs-decision"
            out_slides[i]["method"] = "interpolated"

    def words_text(t0s, t1s):
        return "".join(w["w"] for w in words if w["end"] > t0s and w["start"] < t1s)

    for i, s in enumerate(out_slides):
        if s["status"] != "needs-decision":
            continue
        at = s["endSample"] / rate
        entry = {"slideId": s["slideId"], "order": s["order"], "boundaryAfter": round(at, 3),
                 "confidence": s["confidence"], "method": s["method"],
                 "candidates": [{"sample": x["sample"], "sec": round(x["sample"] / rate, 3), "score": x["score"]} for x in s["candidates"]],
                 "context": {"before": words_text(at - 20.0, at), "after": words_text(at, at + 20.0)},
                 "scriptEnd": info_s[i]["text"].strip()[-40:],
                 "nextScriptStart": info_s[i + 1]["text"].strip()[:40] if i + 1 < n else "",
                 "reason": []}
        if not info_s[i]["found"]:
            entry["reason"].append("slide-not-found-in-audio" if info_s[i]["len"] else "empty-script")
        if i > 0 and not info_s[i - 1]["found"]:
            entry["reason"].append("previous-slide-not-found")
        if i + 1 < n and not info_s[i + 1]["found"]:
            entry["reason"].append("next-slide-not-found")
        if i < n - 1 and cuts[i]["method"] == "asr-align":
            f = cuts[i]["factors"]
            entry["factors"] = f
            if f["anchor"] < 0.7: entry["reason"].append("weak-text-match-at-boundary")
            if f["ins"] > 2: entry["reason"].append("extra-words-between-slides")
            if f["margin"] < 0.1: entry["reason"].append("ambiguous-candidates")
            if f["silF"] < 0.85: entry["reason"].append("short-silence")
        need.append(entry)

    script_hash = script.get("scriptHash")
    doc = {
        "format": "lap-narrator/boundaries", "version": 1, "sampleRate": rate,
        "audio": {"file": a.audio_label, "sha256": tr["audio"]["sha256"], "samples": total},
        "transcript": {"file": a.transcript_label, "sha256": None, "model": tr.get("model")},
        "script": {"scriptHash": script_hash},
        "slides": out_slides,
    }
    report = {
        "threshold": thr, "scriptChars": N, "transcriptChars": M, "dpSec": round(dp_sec, 3), "alignSec": round(time.time() - t_start, 3),
        "slides": [{"slideId": slides[i]["slideId"], "found": info_s[i]["found"], "coverage": round(info_s[i]["cov"], 3),
                    "headQ": round(info_s[i]["head_q"], 3), "tailQ": round(info_s[i]["tail_q"], 3)} for i in range(n)],
        "cuts": [{"after": slides[i]["slideId"], "cutSec": round(cuts[i]["cut_s"], 3), "confidence": round(cuts[i]["conf"], 3),
                  "kind": cuts[i]["kind"], "runLen": round(cuts[i]["runLen"], 3), "factors": cuts[i]["factors"]} for i in range(n - 1)],
    }
    res = {"ok": True, "boundaries": doc, "needsDecision": need, "report": report}
    if getattr(a, "want_ctx", False):   # for review.py: the internals of this alignment
        res["_ctx"] = {"words": words, "slides": slides, "info_s": info_s, "starts": starts, "S": S, "T": T, "Tw": Tw, "aligned": aligned,
                       "match": match, "claimed": claimed, "ng": ng, "cuts": cuts, "rate": rate, "total": total, "audio_info": info,
                       "audio_path": audio_path, "tr": tr, "script": script}
    return res


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--script", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument("--audio-label", default=None)
    ap.add_argument("--transcript-label", default=None)
    ap.add_argument("--skip-hash", action="store_true")
    a = ap.parse_args(argv)
    for p, what in ((a.transcript, "transcript"), (a.script, "script"), (a.audio, "audio")):
        if not os.path.exists(p):
            return fail("cannot-read", "no such %s file: %s" % (what, p))
    if a.audio_label is None:
        a.audio_label = os.path.basename(a.audio)
    if a.transcript_label is None:
        a.transcript_label = os.path.basename(a.transcript)
    res = run(a)
    res["boundaries"]["transcript"]["sha256"] = sha256_file(a.transcript)
    emit(res)
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
