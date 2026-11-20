#!/usr/bin/env python
"""Evaluation of `narrate boundary review` on the continuous recordings of work/Q (real faster-whisper transcripts, truth/located.json).

  .venv\\Scripts\\python.exe -I checker/speech/eval/review-eval.py [--q work/Q] [--out work/G1/eval/review-eval.json]

For each session (check1/check2 of work/Q): copies the audio, transcript and script into a scratch workspace, runs the real
`narrate align`, then `narrate boundary review`, and reports
  * size of the review (characters, per cut and total) and how many cuts have flags;
  * the real recordings contain a skipped sentence, a repeated sentence and an ad-lib (truth/located.json `specials`): were the
    cuts they touch flagged? were the correct, uneventful cuts left unflagged (false alarms)?
  * injected faults on the real transcript, one at a time per cut: (1) the stored position moved by 1.5 s / 4 s (a wrong auto cut),
    (2) the words of the last sentence of the slide replaced by random kana (misrecognition), (3) those words deleted,
    and which warnings were already present, which appear after the change, and which new warnings
    address the type of fault injected.
"""
import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SPEECH = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(SPEECH, "..", ".."))
sys.path.insert(0, SPEECH)
import review as R  # noqa: E402

R.A.progress = lambda *a, **k: None
R.progress = lambda *a, **k: None
KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
POSITION_FLAGS = {"differs-from-aligner", "no-silence-at-cut", "short-silence"}
TRANSCRIPT_FLAGS = {"skipped-sentence", "weak-edge-match", "slide-not-found"}


def jload(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def jdump(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(o, f, ensure_ascii=False)


def narrate(args):
    p = subprocess.run(["node", os.path.join(REPO, "cli", "narrate.js")] + args, capture_output=True, text=True, encoding="utf-8", cwd=REPO)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1])


def warn_flags(cut):
    return [f["code"] for f in cut["flags"] if f["severity"] == "warn"]


def run_review(ws, boundaries, transcript, script, audio):
    a = types.SimpleNamespace(boundaries=boundaries, transcript=transcript, script=script, audio=audio, context_sec=15.0, max_chars=450)
    bnd, ctx, cuts = R.build(a)
    blocks = R.render(cuts, bnd, ctx, 15.0, 450)
    return cuts, blocks, ctx


def summarize_injections(trials, baseline_by_slide, relevant_codes):
    """Count cuts with a warning, using a warning code at most once per cut."""
    fields = ("baseline", "afterFault", "newAfterFault", "newRelevantAfterFault")
    counts = {field: 0 for field in fields}
    codes = {field: {} for field in fields}
    missed = []
    unchanged = []
    for trial in trials:
        sid = trial["slideId"]
        if not trial["changed"]:
            unchanged.append(sid)
            continue
        baseline = set(baseline_by_slide[sid])
        after = set(trial["flags"])
        new = after - baseline
        relevant = new & relevant_codes
        for field, observed in zip(fields, (baseline, after, new, relevant)):
            counts[field] += bool(observed)
            for code in sorted(observed):
                codes[field][code] = codes[field].get(code, 0) + 1
        if not relevant:
            missed.append(sid)
    return {"attempted": len(trials), "changed": len(trials) - len(unchanged), "unchanged": unchanged,
            "flaggedCuts": counts, "codes": codes, "missedNewRelevant": missed}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", default=os.path.join(REPO, "work", "Q"))
    ap.add_argument("--out", default=os.path.join(REPO, "work", "G1", "eval", "review-eval.json"))
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="lap-narrator-review-eval-") as scratch:
        return evaluate(a, scratch)


def evaluate(a, scratch):
    report = {"sessions": []}
    for k in (1, 2):
        src = os.path.join(a.q, "check%d" % k)
        truth = jload(os.path.join(a.q, "session%d" % k, "truth", "located.json"))
        ws = os.path.join(scratch, "wsq%d" % k)
        os.makedirs(os.path.join(ws, "final"))
        for f in ("transcript.json", "script.json"):
            shutil.copyfile(os.path.join(src, f), os.path.join(ws, f))
        shutil.copyfile(os.path.join(src, "final", "all.wav"), os.path.join(ws, "final", "all.wav"))
        code, env = narrate(["align", "--workspace", ws])
        assert env["result"] and "slides" in env["result"], env
        bpath = os.path.join(ws, "boundaries.json")
        bnd = jload(bpath)
        rate = bnd["sampleRate"]
        gaps = {b["slideId"]: (b["loSec"], b["hiSec"]) for b in truth["boundaries"]}
        audio = os.path.join(ws, "final", "all.wav")
        tpath = os.path.join(ws, "transcript.json")
        spath = os.path.join(ws, "script.json")
        code2, renv = narrate(["boundary", "review", "--workspace", ws])
        cli_summary = renv["result"]["summary"]
        cuts, blocks, ctx = run_review(ws, bpath, tpath, spath, audio)
        sizes = [len(b) for b in blocks]
        md_chars = sum(sizes)
        rows = []
        for c in cuts:
            lo, hi = gaps[c["slideId"]]
            correct = lo - 0.05 <= c["sec"] <= hi + 0.05
            rows.append({"slideId": c["slideId"], "sec": c["sec"], "status": c["status"], "confidence": c["confidence"], "correct": correct,
                         "flags": warn_flags(c), "chars": len(blocks[c["index"] - 1])})
        specials = truth.get("specials", {})
        # which cuts do the specials touch?
        touched = {}
        ids = [c["slideId"] for c in cuts]
        for sk in specials.get("skipped", []):
            si = ids.index(sk["slideId"]) if sk["slideId"] in ids else None
            if si is not None:
                touched.setdefault("skipped", []).extend(([ids[si - 1]] if si > 0 else []) + ([ids[si]] if si < len(ids) - 1 else []))
        for key in ("repeated", "adlib"):
            for sp in specials.get(key, []):
                if sp["slideId"] in ids:
                    si = ids.index(sp["slideId"])
                    touched.setdefault(key, []).extend(([ids[si - 1]] if si > 0 else []) + ([ids[si]] if si < len(ids) - 1 else []))
        # --- injected faults
        tr0 = jload(tpath)
        rnd = random.Random(7)
        inj = {"shift1.5": [], "shift4": [], "garble": [], "delete": []}
        for ci, c in enumerate(cuts):
            sid = c["slideId"]
            # (1) wrong position
            for name, d in (("shift1.5", 1.5), ("shift4", 4.0)):
                b2 = json.loads(json.dumps(bnd))
                old = b2["slides"][ci]["endSample"]
                new = old + int(d * rate)
                if new >= b2["slides"][ci + 1]["endSample"]:
                    new = old - int(d * rate)
                if new <= b2["slides"][ci]["startSample"]:
                    inj[name].append({"slideId": sid, "changed": False})
                    continue
                b2["slides"][ci]["endSample"] = new
                b2["slides"][ci + 1]["startSample"] = new
                jdump(os.path.join(ws, "b-shift.json"), b2)
                cs, _, _ = run_review(ws, os.path.join(ws, "b-shift.json"), tpath, spath, audio)
                inj[name].append({"slideId": sid, "changed": True, "flags": warn_flags(cs[ci])})
            # (2)(3) the words of the last sentence of the slide (the ~4 s before the cut) garbled / deleted
            for name in ("garble", "delete"):
                tr = json.loads(json.dumps(tr0))
                t1 = c["sec"] - 0.4
                t0 = t1 - 4.0
                ws_ = []
                for w in tr["words"]:
                    if t0 <= w["start"] and w["end"] <= t1:
                        if name == "delete":
                            continue
                        w = {**w, "w": "".join(rnd.choice(KANA) for _ in w["w"])}
                    ws_.append(w)
                if ws_ == tr0["words"]:
                    inj[name].append({"slideId": sid, "changed": False})
                    continue
                tr["words"] = ws_
                jdump(os.path.join(ws, "t-fault.json"), tr)
                cs, _, _ = run_review(ws, bpath, os.path.join(ws, "t-fault.json"), spath, audio)
                inj[name].append({"slideId": sid, "changed": True, "flags": warn_flags(cs[ci])})
        baseline = {r["slideId"]: r["flags"] for r in rows}
        sess = {
            "session": k, "audioSec": round(bnd["audio"]["samples"] / rate, 1), "cuts": len(cuts),
            "reviewChars": cli_summary["markdownChars"], "cliSummary": cli_summary, "perCutChars": {"min": min(sizes), "max": max(sizes), "mean": round(sum(sizes) / len(sizes))},
            "statusCounts": {s: sum(1 for r in rows if r["status"] == s) for s in ("auto", "confirmed", "needs-decision")},
            "cutsCorrect": sum(1 for r in rows if r["correct"]), "cutsWrong": [r["slideId"] for r in rows if not r["correct"]],
            "flagged": [r["slideId"] for r in rows if r["flags"]],
            "flaggedCorrect": [r["slideId"] for r in rows if r["flags"] and r["correct"]],
            "correctNotFlagged": sum(1 for r in rows if r["correct"] and not r["flags"]),
            "specialsTouch": touched, "rows": rows,
            "injected": {name: summarize_injections(trials, baseline, POSITION_FLAGS if name.startswith("shift") else TRANSCRIPT_FLAGS)
                         for name, trials in inj.items()},
        }
        report["sessions"].append(sess)
        print(json.dumps({x: sess[x] for x in sess if x != "rows"}, ensure_ascii=False))
        for r in rows:
            print("  ", r["slideId"], r["status"], r["confidence"], "OK " if r["correct"] else "BAD", r["chars"], r["flags"])
    jdump(a.out, report)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
