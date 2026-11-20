# examples（架空の見本）

すべて自作の架空の素材です。実在の人、組織、発表の内容は含みません。大きなファイルは入れていません（`examples/` 全体で約 3.5MB）。
作り直すコマンド（音は出ません）：

```
node testgen/cli.js examples
```

同じ指定から、いつも同じバイト列ができます（`test/oracle/testgen.test.js` が確かめます）。試験：`npm run test:oracle`。

| 場所 | 中身 |
|---|---|
| `packs/<名前>.zip` | 台本パック（`script.json` と `slides/NNNN.png`。CONTRACTS.md 1.1）。`tiny3`（3 枚）、`tiny3h`（非表示と空のノートを含む 4 枚）、`jp15`（日本語 15 枚）、`edge`（意地の悪い 12 枚）、`en`（英語 8 枚） |
| `pptx/<名前>.pptx` | 上の台本パックに対応する pptx（pptxgenjs。ノート欄に読む文。非表示スライドと空のノートを含む）。台本パックの slideId は `s0001` 形式。pptx から `pack` で作ると `s256` 形式になる |
| `sessions/<場面>/` | 録音セッションの見本（27 場面）。CONTRACTS.md 1.2 の形（`manifest.json`、`script.json`、`events.jsonl`、`segments.json`、`edits.json`、`raw/rec-NNNNNN.wav`、`README.txt`）に、期待値を足したもの |
| `sessions/index.json` | 場面の一覧（名前、説明、期待される問題の種類） |

## 録音セッションの見本

- `expected.segments.json`：**手で導いた期待値**（`schema/segments.schema.json` の形）。CONTRACTS.md 1.5 を 1 行ずつ読んで人が導いた。コードからは作っていない（`testgen/sessions/scenes.js`）。`segments.json` は同じ内容の写し。
- `expected.render.json`：完成した音声の期待値（スライドごとの既定のテイクの PCM の SHA-256）。第 1 波の範囲（周波数の変換なし、gain 0、リミッターなし、フェード 384 サンプル。連続した結合部にはかけない）。
- 録音ファイルは 48000 Hz、16 ビット、モノラル、標準の 44 バイトのヘッダー、1 つ 1 秒。中身は合成音（`tiny3-full` は、スライドごとの固有の周波数の音で、撮り直しで捨てた部分は別の音）。
- すべての操作は `at: {raw, sample, pos}` が整合している。意図した不整合は `position-mismatch`、`beyond-raw-length`、`unknown-raw` の場面だけ。

| 場面 | 見るところ |
|---|---|
| `basic` | 1 枚を録って OK、一時停止、次のスライドへ（長さ 0 の断片を捨てる） |
| `retake` / `retake-twice` / `retake-null` | 直前の OK 点へ戻る／2 回連続／テイクの最初まで戻る |
| `undo-ok` / `undo-retake` / `redo-retake` / `undo-nav` | 取り消しと、やり直し |
| `file-rotate` | OK 点をまたいで録音ファイルが切り替わる |
| `pause-resume` | end == 次の start の断片をまとめない。空の断片を置き換える |
| `goto-slide` / `goto-while-recording` | 別のスライドの録り直し（候補 2 つ、既定は新しい方）／録音中の移動 |
| `recovered` / `recovered-after-ok` / `recovered-retake` | OK なしで強制終了／OK のあとで強制終了／復旧のあと撮り直し |
| `orphan-audio` / `next-while-recording` | next-slide のあとも録音が続く（間に音がある：問題を出す）/ 同じ位置で rec-start（出さない） |
| `bad-undo-target` / `position-mismatch` / `beyond-raw-length` / `unknown-raw` / `seq-gap` | 問題の報告 |
| `empty-fragment` | 長さ 0 の断片 |
| `public-sample` | 設計書 6.3 の公開見本：録音ファイルが分かれ、撮り直しを取り消した例 |
| `durable-many` | durable が多数並んでも、採用と破棄は変わらない |
| `marks-misc` | mark、test-rec、export |
| `tiny3-full` | 3 枚（`tiny3`）を録った全記録 |

## 作業用（git の対象外、`work/E/`）

```
node testgen/cli.js voices                       # 入っている音声合成の声の一覧
node testgen/cli.js tts tiny3                    # スライドごとの WAV（work/E/tts/tiny3）。ファイルにだけ書く。日本語は ja-JP、英語は en-US の声
node testgen/cli.js degrade work/E/tts/tiny3/s0001.wav   # 音質を悪くした WAV（雑音 白色・ピンク・50Hz × SNR 30/20/10/0、音割れ、小音量、8k/16k/44.1k、途切れ、直流、長い無音）
node testgen/cli.js cues                         # スライドごとの確認音
node testgen/cli.js pptx --out work/E/pptx --name "日本語の 題名 with space"   # 日本語と空白を含むファイル名の pptx
```
