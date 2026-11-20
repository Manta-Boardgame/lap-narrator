#!/usr/bin/env python
"""Evaluation of transcribe + align on recordings with a known truth (checker/speech/eval).

  .venv\\Scripts\\python.exe -I checker/speech/eval/evaluate.py base    --session 1 [--threshold 0.8] [--vad on|off] [--force]
  .venv\\Scripts\\python.exe -I checker/speech/eval/evaluate.py degrade --session 1 [--threshold 0.8]
  .venv\\Scripts\\python.exe -I checker/speech/eval/evaluate.py tune    --session 1 --session 2

Material (made by make-material.js): work/G1/eval/session<N>/all.wav + truth-cuts.json (cut = the seam where the per-slide
final audios were concatenated; slides[].speechStart/End = where the slide is really spoken; sentences[]).
`base` runs the real CLI (narrate transcribe -> narrate align, real faster-whisper) and reports the errors against the truth.
`degrade` re-uses the cached transcript and breaks the script / the audio+transcript (skip, repeat, ad-lib, notation, empty
slides, ASR damage) to see whether a wrong boundary can still become "auto".

A boundary is WRONG when the detected cut is outside the truth gap [end of slide i's speech, start of slide i+1's speech]
(+-50 ms) -- a cut inside the gap never cuts speech. The task's stricter measure, |cut - seam| > 500 ms, is reported as well.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SPEECH = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(SPEECH, "..", ".."))
sys.path.insert(0, SPEECH)
import align as A  # noqa: E402
A.progress = lambda *a, **k: None  # no progress lines while evaluating
from speech_common import read_wav_info  # noqa: E402
from speech_norm import normalize  # noqa: E402

EVAL = os.path.join(REPO, "work", "G1", "eval")
PACK = os.path.join(REPO, "examples", "packs", "jp15.zip")
GAP_TOL_S = 0.05


def jload(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def jdump(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(o, f, ensure_ascii=False, indent=1)
        f.write("\n")


def pct(a, q):
    a = sorted(a)
    if not a:
        return None
    k = (len(a) - 1) * q / 100.0
    lo, hi = int(np.floor(k)), int(np.ceil(k))
    return a[lo] + (a[hi] - a[lo]) * (k - lo)


def levenshtein(a, b):
    if not a:
        return len(b)
    if not b:
        return len(a)
    A_ = np.array([ord(c) for c in a])
    B_ = np.array([ord(c) for c in b])
    prev = np.arange(len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = np.empty_like(prev)
        cur[0] = i
        sub = prev[:-1] + (B_ != A_[i - 1])
        dele = prev[1:] + 1
        t = np.minimum(sub, dele)
        # insertion: cur[j] = min(t[j-1], cur[j-1]+1) -> running
        cur[1:] = t
        for j in range(1, len(b) + 1):
            if cur[j - 1] + 1 < cur[j]:
                cur[j] = cur[j - 1] + 1
        prev = cur
    return int(prev[-1])


# ---- cases -----------------------------------------------------------------------------------------------------------------

class Case:
    """audio file + transcript + script + truth (speech extents per slide, in samples of the audio)."""

    def __init__(self, name, wav, transcript, script, slides_truth, seams=None, rate=48000):
        self.name, self.wav, self.transcript, self.script = name, wav, transcript, script
        self.slides_truth = slides_truth      # list of {slideId, speechStart, speechEnd} for recordable slides (order)
        self.seams = seams
        self.rate = rate


def base_case(session, transcript_path, wav=None):
    d = os.path.join(EVAL, "session%d" % session)
    truth = jload(os.path.join(d, "truth-cuts.json"))
    return Case("session%d" % session, wav or os.path.join(d, "all.wav"), jload(transcript_path), jload_pack(),
                [{"slideId": s["slideId"], "speechStart": s["speechStart"], "speechEnd": s["speechEnd"]} for s in truth["slides"]],
                seams=truth["cuts"], rate=truth["sampleRate"]), truth


def jload_pack():
    import zipfile
    with zipfile.ZipFile(PACK) as z:
        return json.loads(z.read("script.json").decode("utf-8"))


def run_align(case, threshold, script=None, transcript=None):
    a = types.SimpleNamespace(transcript=None, script=None, audio=case.wav, threshold=threshold, audio_label="all.wav",
                              transcript_label="transcript.json", skip_hash=True,
                              transcript_obj=transcript or case.transcript, script_obj=script or case.script)
    try:
        return A.run(a)
    except A.SpeechError as e:
        return {"error": e.code + ": " + e.message}


def judge(case, res, only_slides=None):
    """Per cut: detected sample, status, wrong (outside the truth gap)."""
    if "error" in res:
        return {"error": res["error"], "cuts": [], "wrongAuto": None, "auto": 0, "needs": 0, "wrong": 0}
    b = res["boundaries"]["slides"]
    rate = res["boundaries"]["sampleRate"]
    cuts = []
    ids = [s["slideId"] for s in b]
    truth = {t["slideId"]: t for t in case.slides_truth}
    for i in range(len(b) - 1):
        d = b[i]["endSample"]
        t0, t1 = truth.get(ids[i]), truth.get(ids[i + 1])
        gap = None
        if t0 and t1 and t0["speechEnd"] is not None and t1["speechStart"] is not None:
            gap = (t0["speechEnd"], t1["speechStart"])
        inside = gap is not None and gap[0] - GAP_TOL_S * rate <= d <= gap[1] + GAP_TOL_S * rate
        fac = None
        if "report" in res and i < len(res["report"]["cuts"]):
            fac = res["report"]["cuts"][i]
        row = {"after": ids[i], "factors": fac["factors"] if fac else None, "kind": fac["kind"] if fac else None, "runLen": fac["runLen"] if fac else None, "sample": d, "status": b[i]["status"], "method": b[i]["method"], "confidence": b[i]["confidence"],
               "inGap": bool(inside)}
        if case.seams is not None and i < len(case.seams):
            row["errMs"] = (d - case.seams[i]) * 1000.0 / rate
        cuts.append(row)
    auto = [c for c in cuts if c["status"] == "auto"]
    return {"cuts": cuts, "auto": len(auto), "needs": sum(1 for c in cuts if c["status"] != "auto"),
            "wrongAuto": sum(1 for c in auto if not c["inGap"]), "wrong": sum(1 for c in cuts if not c["inGap"])}


# ---- base: the real CLI ------------------------------------------------------------------------------------------------

def narrate(args, timeout=1800):
    t0 = time.time()
    p = subprocess.run(["node", os.path.join(REPO, "cli", "narrate.js")] + args, capture_output=True, text=True, encoding="utf-8", timeout=timeout, cwd=REPO)
    env = json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else None
    return p.returncode, env, time.time() - t0


def edge_margin(case, j):
    """distance (ms) from each cut to the nearest speech of the two slides around it (>= 0 when the cut is inside the gap)"""
    truth = {t["slideId"]: t for t in case.slides_truth}
    ms = []
    for c in j["cuts"]:
        ids = [t["slideId"] for t in case.slides_truth]
        i = ids.index(c["after"])
        a, b = case.slides_truth[i], case.slides_truth[i + 1]
        ms.append(min(c["sample"] - a["speechEnd"], b["speechStart"] - c["sample"]) * 1000.0 / case.rate)
    return {"min": min(ms), "median": pct(ms, 50)}


def cmd_base(session, threshold, vad, force):
    d = os.path.join(EVAL, "session%d" % session)
    ws = os.path.join(REPO, "work", "G1", "ws%d" % session)
    os.makedirs(os.path.join(ws, "final"), exist_ok=True)
    import shutil
    shutil.copyfile(os.path.join(d, "all.wav"), os.path.join(ws, "final", "all.wav"))
    code, env, wall = narrate(["transcribe", "--workspace", ws, "--vad", vad] + (["--force"] if force else []))
    if code != 0:
        print(json.dumps(env, ensure_ascii=False)[:800])
        return 1
    tres = env["result"]
    code, env, awall = narrate(["align", "--workspace", ws, "--script", PACK, "--threshold", str(threshold), "--force"])
    if env is None or "result" not in env or "slides" not in env["result"]:
        print(json.dumps(env, ensure_ascii=False)[:800])
        return 1
    truth = jload(os.path.join(d, "truth-cuts.json"))
    b = jload(os.path.join(ws, "boundaries.json"))
    tr = jload(os.path.join(ws, "transcript.json"))
    case = Case("session%d" % session, os.path.join(ws, "final", "all.wav"), tr, jload_pack(),
                [{"slideId": s["slideId"], "speechStart": s["speechStart"], "speechEnd": s["speechEnd"]} for s in truth["slides"]],
                seams=truth["cuts"], rate=truth["sampleRate"])
    res = {"boundaries": b, "needsDecision": env["result"]["needsDecision"]}
    j = judge(case, res)
    errs = [abs(c["errMs"]) for c in j["cuts"]]
    wrong500 = [c for c in j["cuts"] if abs(c["errMs"]) > 500]
    # character error rate of the transcript against the sentences that are really in the audio (normalised both sides)
    ref = normalize("".join(s["text"] for s in truth["sentences"]))
    hyp = normalize("".join(w["w"] for w in tr["words"]))
    lev = levenshtein(ref, hyp)
    out = {
        "session": session, "audioSec": tres["audioSec"], "model": tres["model"], "vad": vad, "threshold": threshold,
        "cuts": len(j["cuts"]), "errMs": {"median": pct(errs, 50), "p95": pct(errs, 95), "max": max(errs) if errs else None},
        "autoCount": j["auto"], "needsDecision": j["needs"], "wrongAuto500": sum(1 for c in wrong500 if c["status"] == "auto"),
        "wrongAutoInGap": j["wrongAuto"], "wrong500": len(wrong500),
        "edgeMarginMs": edge_margin(case, j),
        "cerNormalised": round(lev / max(1, len(ref)), 3), "refChars": len(ref), "hypChars": len(hyp),
        "transcribe": {"cached": tres["cached"], "transcribeSec": tres["timing"]["transcribeSec"], "loadSec": tres["timing"]["loadSec"], "rtf": tres["rtf"]},
        "alignWallSec": round(awall, 2), "alignInternalSec": env["result"]["report"]["alignSec"],
        "cutsDetail": j["cuts"],
    }
    jdump(os.path.join(EVAL, "base-session%d.json" % session), out)
    print(json.dumps({k: v for k, v in out.items() if k != "cutsDetail"}, ensure_ascii=False))
    return 0


# ---- degrade ---------------------------------------------------------------------------------------------------------------

def write_wav(path, samples, rate):
    import struct
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = samples.astype("<i2").tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)))
        f.write(data)


def read_all(path):
    info = read_wav_info(path)
    return np.fromfile(path, dtype="<i2", offset=info["dataOffset"], count=info["samples"]), info["sampleRate"]


def splice(base_audio, rate, words, sentences, pieces, name):
    """pieces: list of ('old', a, b) | ('dup', a, b) | ('sil', n) | ('foreign', samples, words, tag).
    Returns (wav path, transcript words, sentence list [{slideId, start, end}] in the new time)."""
    out, nw, ns = [], [], []
    pos = 0
    for p in pieces:
        if p[0] in ("old", "dup"):
            a, b = p[1], p[2]
            out.append(base_audio[a:b])
            for w in words:
                if w["start"] * rate >= a - 1 and w["end"] * rate <= b + 1:
                    nw.append({**w, "start": round(w["start"] + (pos - a) / rate, 3), "end": round(w["end"] + (pos - a) / rate, 3)})
            for s in sentences:
                if s["start"] >= a and s["end"] <= b:
                    ns.append({"slideId": s["slideId"], "start": s["start"] + pos - a, "end": s["end"] + pos - a, "text": s.get("text", "")})
            pos += b - a
        elif p[0] == "sil":
            out.append(np.zeros(p[1], dtype=np.int16))
            pos += p[1]
        elif p[0] == "foreign":
            out.append(p[1])
            for w in p[2]:
                nw.append({**w, "start": round(w["start"] + pos / rate, 3), "end": round(w["end"] + pos / rate, 3)})
            pos += len(p[1])
    audio = np.concatenate(out) if out else np.zeros(0, dtype=np.int16)
    path = os.path.join(EVAL, "variants", name, "all.wav")
    write_wav(path, audio, rate)
    return path, nw, ns, len(audio)


def truth_from_sentences(ns, order_ids):
    t = []
    for sid in order_ids:
        ss = [s for s in ns if s["slideId"] == sid]
        t.append({"slideId": sid, "speechStart": min(s["start"] for s in ss) if ss else None, "speechEnd": max(s["end"] for s in ss) if ss else None})
    return t


def mk_transcript(base_tr, words, samples, rate):
    tr = json.loads(json.dumps(base_tr))
    tr["words"] = words
    tr["audio"] = {**tr["audio"], "samples": samples, "sampleRate": rate}
    return tr


def scenario_rows(cases, threshold):
    rows = []
    for name, case, extra in cases:
        res = run_align(case, threshold, script=extra.get("script"), transcript=extra.get("transcript"))
        j = judge(case, res)
        rows.append({"scenario": name, "cuts": len(j["cuts"]), "auto": j["auto"], "needs": j["needs"], "wrongAuto": j["wrongAuto"], "wrongAll": j["wrong"],
                     "error": j.get("error"), "allCuts": j["cuts"], "detail": [c for c in j["cuts"] if (c["status"] == "auto" and not c["inGap"]) or not c["inGap"]],
                     "flagged": extra.get("expectFlag") and [c["after"] for c in j["cuts"] if c["status"] != "auto"]})
    return rows


def build_degrade_cases(session, threshold):
    d = os.path.join(EVAL, "session%d" % session)
    truth = jload(os.path.join(d, "truth-cuts.json"))
    base_tr = jload(os.path.join(REPO, "work", "G1", "ws%d" % session, "transcript.json"))
    rate = truth["sampleRate"]
    audio, _ = read_all(os.path.join(d, "all.wav"))
    words = base_tr["words"]
    sents = truth["sentences"]
    script = jload_pack()
    order = [s["slideId"] for s in truth["slides"]]
    total = len(audio)
    seam = {s["slideId"]: s["endSample"] for s in truth["slides"]}
    by_slide = {sid: [s for s in sents if s["slideId"] == sid] for sid in order}
    cases = []

    def variant(name, pieces, expect_flag=False):
        wav, nw, ns, n = splice(audio, rate, words, sents, pieces, "s%d-%s" % (session, name))
        c = Case(name, wav, mk_transcript(base_tr, nw, n, rate), script, truth_from_sentences(ns, order), rate=rate)
        cases.append((name, c, {"expectFlag": expect_flag}))

    def pieces_without(ranges, repl=None):
        """audio minus the (a, b) ranges, in order"""
        ps, cur = [], 0
        for a, b in sorted(ranges):
            if a > cur:
                ps.append(("old", cur, a))
            cur = b
        ps.append(("old", cur, total))
        return ps

    # (a) skipped sentences: first / last sentence of each multi-sentence slide, and a whole slide
    for sid in order:
        ss = by_slide[sid]
        if len(ss) >= 2:
            variant("a-skip-first-%s" % sid, pieces_without([(ss[0]["start"], ss[0]["end"])]))
            variant("a-skip-last-%s" % sid, pieces_without([(ss[-1]["start"], ss[-1]["end"])]))
    for sid in (order[2], order[7]):
        ss = by_slide[sid]
        variant("a-skip-slide-%s" % sid, pieces_without([(ss[0]["start"], ss[-1]["end"])]), True)
    # (b) a sentence said twice: the last sentence of a slide repeated right after it / the first sentence repeated
    for sid in order[:-1]:
        ss = by_slide[sid]
        last = ss[-1]
        variant("b-repeat-last-%s" % sid, [("old", 0, last["end"]), ("sil", int(0.7 * rate)), ("dup", last["start"], last["end"]), ("old", last["end"], total)])
        first = ss[0]
        variant("b-repeat-first-%s" % sid, [("old", 0, first["end"]), ("sil", int(0.7 * rate)), ("dup", first["start"], first["end"]), ("old", first["end"], total)])
    # (c) ad-lib (10 s of foreign speech) at slide boundaries and inside a slide
    other = 2 if session == 1 else 1
    od = os.path.join(EVAL, "session%d" % other)
    oaudio, _ = read_all(os.path.join(od, "all.wav"))
    otr = jload(os.path.join(REPO, "work", "G1", "ws%d" % other, "transcript.json"))
    ow = otr["words"]
    w0 = next(i for i, w in enumerate(ow) if w["start"] > 20.0)
    w1 = next(i for i in range(w0, len(ow)) if ow[i]["end"] - ow[w0]["start"] >= 10.0)
    fa, fb = int(ow[w0]["start"] * rate), int(ow[w1]["end"] * rate)
    foreign = oaudio[fa:fb].copy()
    fwords = [{**w, "start": round(w["start"] - ow[w0]["start"], 3), "end": round(w["end"] - ow[w0]["start"], 3)} for w in ow[w0:w1 + 1]]
    for k in range(0, len(order) - 1, 2):
        sid = order[k]
        cut = seam[sid]
        variant("c-adlib-after-%s" % sid, [("old", 0, cut), ("sil", int(0.5 * rate)), ("foreign", foreign, fwords, "x"), ("sil", int(0.5 * rate)), ("old", cut, total)], True)
    mid = by_slide[order[3]][0]["end"] if len(by_slide[order[3]]) else seam[order[3]]
    variant("c-adlib-inside-%s" % order[3], [("old", 0, mid), ("sil", int(0.5 * rate)), ("foreign", foreign, fwords, "x"), ("sil", int(0.5 * rate)), ("old", mid, total)])
    return cases, script, base_tr, truth


def notation_scripts(script, session_slides):
    rules = [("七時から八時", "19:00〜20:00"), ("約八万円", "約80,000円"), ("四人", "4名"), ("ろうそく風の電灯", "キャンドル風のLED"), ("年間で十二回", "年12回"),
             ("おはなしの部屋", "「Story Room」"), ("進行役", "MC"), ("四歳", "4歳"), ("三冊", "3冊"), ("約五十分", "約50分"), ("小学校", "しょうがっこう"), ("図書館", "ライブラリ")]
    out = {}
    s1 = json.loads(json.dumps(script))
    for s in s1["slides"]:
        for a, b in rules:
            s["text"] = s["text"].replace(a, b)
    out["d1-notation-phrases"] = s1
    s2 = json.loads(json.dumps(script))
    for s in s2["slides"]:
        if s.get("text"):
            s["text"] = s["text"][:-10] + "END.OF.SLIDE"
    out["d2-notation-slide-ends"] = s2
    s3 = json.loads(json.dumps(script))
    for s in s3["slides"]:
        if s.get("text"):
            s["text"] = "START-OF-SLIDE " + s["text"][8:]
    out["d3-notation-slide-starts"] = s3
    s4 = json.loads(json.dumps(script))
    for s in s4["slides"]:
        if s.get("text"):
            t = s["text"]
            s["text"] = "".join(chr(ord(c) - 0x60) if "ぁ" <= c <= "ん" and False else c for c in t)
    return out


def empty_scripts(script, ids_sets):
    out = {}
    for name, ids in ids_sets.items():
        s = json.loads(json.dumps(script))
        for x in s["slides"]:
            if x["slideId"] in ids:
                x["text"] = ""
        out[name] = s
    return out


def asr_damage(base_tr, seed, drop, sub):
    rnd = random.Random(seed)
    tr = json.loads(json.dumps(base_tr))
    kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
    ws = []
    for w in tr["words"]:
        if rnd.random() < drop:
            continue
        if rnd.random() < sub:
            w = {**w, "w": "".join(rnd.choice(kana) for _ in w["w"])}
        ws.append(w)
    tr["words"] = ws
    return tr


def cmd_degrade(session, threshold):
    cases, script, base_tr, truth = build_degrade_cases(session, threshold)
    order = [s["slideId"] for s in truth["slides"]]
    d = os.path.join(EVAL, "session%d" % session)
    base_c = Case("base", os.path.join(d, "all.wav"), base_tr, script,
                  [{"slideId": s["slideId"], "speechStart": s["speechStart"], "speechEnd": s["speechEnd"]} for s in truth["slides"]], seams=truth["cuts"], rate=truth["sampleRate"])
    allc = [("base", base_c, {})]
    allc += cases
    for name, sc in notation_scripts(script, order).items():
        allc.append((name, base_c, {"script": sc}))
    esets = {"e1-empty-two-adjacent": {order[6], order[7]}, "e2-empty-three-separate": {order[2], order[5], order[9]},
             "e3-empty-first": {order[0]}, "e4-empty-last": {order[-1]}, "e5-empty-first-and-last": {order[0], order[-1]}}
    for name, sc in empty_scripts(script, esets).items():
        allc.append((name, base_c, {"script": sc, "expectFlag": True}))
    for seed in range(8):
        for drop, sub in ((0.15, 0.1), (0.3, 0.2)):
            allc.append(("f-asr-damage-drop%d-sub%d-seed%d" % (drop * 100, sub * 100, seed), base_c, {"transcript": asr_damage(base_tr, seed, drop, sub)}))
    rows = scenario_rows(allc, threshold)
    jdump(os.path.join(EVAL, "degrade-session%d.json" % session), {"session": session, "threshold": threshold, "rows": rows})
    return rows


def summarize(rows):
    groups = {}
    for r in rows:
        g = r["scenario"].split("-")[0] if r["scenario"] != "base" else "base"
        a = groups.setdefault(g, {"n": 0, "cuts": 0, "auto": 0, "needs": 0, "wrongAuto": 0, "wrongAll": 0, "errors": 0})
        a["n"] += 1
        a["cuts"] += r["cuts"]; a["auto"] += r["auto"]; a["needs"] += r["needs"]
        a["wrongAuto"] += r["wrongAuto"] or 0; a["wrongAll"] += r["wrongAll"] or 0
        a["errors"] += 1 if r.get("error") else 0
    return groups


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["base", "degrade", "tune"])
    ap.add_argument("--session", type=int, action="append", required=True)
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument("--vad", default="on")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "base":
        rc = 0
        for s in a.session:
            rc |= cmd_base(s, a.threshold, a.vad, a.force)
        return rc
    for s in a.session:
        rows = cmd_degrade(s, a.threshold)
        print("session", s, "threshold", a.threshold)
        for g, v in sorted(summarize(rows).items()):
            print("  ", g, v)
        if a.verbose:
            for r in rows:
                if r["wrongAuto"] or r.get("error"):
                    print("   WRONG-AUTO", r["scenario"], r["wrongAuto"], r.get("error"), [c for c in r["detail"] if c["status"] == "auto"])
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
