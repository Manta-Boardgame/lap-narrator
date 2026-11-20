lap-narrator example session: render-clamp-empty
sessionId: ex-render-clamp-empty   projectId: tiny3_demo

A segment beyond the raw file length becomes empty (dropped when rendering) and its neighbours become continuous: no fade, the output equals the raw file.
録音ファイルの長さを超えて空になる区間（描画では取り除く）と、その前後が連続になる区間：描画ではフェードがかからず、録音ファイルの先頭 48000 サンプルと同じになる。

This is synthetic test material (fictional, not a real recording). Raw audio is made of tones.
expected.segments.json was derived by hand from dev/CONTRACTS.md 1.5. It is not generated from code.
segments.json is a copy of it. If segments.json and events.jsonl disagree, events.jsonl is the source of truth.
