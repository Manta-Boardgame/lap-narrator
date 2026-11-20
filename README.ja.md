# lap-narrator

[English](README.md) | 日本語

Android アプリと Windows の PC コマンドを使います。開発用の PC での起動方法、最初の録音から動画化までの操作、別の PC の準備は [個人利用の準備と最初の動画](docs/pc-setup.md) にまとめています。

スライド（pptx）のノートを台本にして、スマホで読み上げを**通しで 1 本録音**し、PC で録音を文字起こしして台本と照合し、スライドごとの切れ目を決めて、動画（MP4）にするための道具です。
流れは「pack → スマホで通しで録音（OK と撮り直しだけ）→ import → status → transcribe → align → render → build → verify」です。録音中に「次のスライドへ」を押す必要はありません。
操作は、Android の録音アプリと、PC のコマンド `narrate`（`cli/narrate.js`）で行います。人にも LLM にも使えるよう、`narrate` は質問をせず、結果を JSON で標準出力に 1 つだけ返します。自信のない切れ目だけは、終了コード 4 で止まって人（または LLM）の判断を待ちます。

設計は `docs/design.md` にあります。

## 必要なもの

- Windows 11（開発に使った PC で動かして確かめています。ほかの環境は未確認）
- Node.js（確認したのは 24.19.0。`package.json` は 22 以上）。`narrate` 自体は Node の標準ライブラリだけで動きます（`npm install` は不要。ネットワークを使うコードは `cli/` と `core/` にありません）
- Python の仮想環境 `.venv`（方式 B や `verify` に使う PyAV・NumPy と、通し録音の日本語の文字起こしに使う faster-whisper）。[PC の準備手順](docs/pc-setup.md#別の-windows-pc-の準備)
- 音声認識のモデル small（`models/` にあります。約 460MB）。`transcribe` は `models/` にあるモデルだけを使い、取りに行きません。無いときは `speech-unavailable` で止まります
- 方式 A で動画を作るとき、または `pack --from-pptx` を使うときだけ：PowerPoint（開発用の PC では 16.0）

開発用の PC で必要なものがそろっているかは `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\check-pc.ps1` で確認できます。スライド区切りモードを使う場合は末尾に `-PerSlide` を付けられます。別の PC への新規導入は未確認です。

## 最初の手順（新しい流れ：通しの録音）

PowerShell での呼び方は `.\narrate.cmd <コマンド> ...` または `node cli/narrate.js <コマンド> ...` です（以下では `narrate` と略します）。作業場（`--workspace`）は、取り込んだ録音と作った音声を置くフォルダで、無ければ作られます。
下の例は、15 枚の合成音声の通しの録音（書き出し）、`slides.pptx`、`script-pack.zip` を使って、方式 B（PowerPoint を使わない）で最初から最後まで実際に動かしたものです（その素材はこのリポジトリには入っていません。自分の録音のフォルダーに読み替えてください）。作業場は `ws`。

### 1. pack：台本パックを作る

pptx のノートが台本になります。台本パックは、スマホに渡す zip（台本と各スライドの絵）です。

```
narrate pack --from-pptx deck.pptx --out script-pack.zip
narrate pack --from-json <script.json と slides/ のあるフォルダ> --out script-pack.zip
narrate pack --from-markdown deck.md --images <画像のフォルダ> --out script-pack.zip
```

- `--from-pptx` は PowerPoint が要ります。PowerPoint が無い（または使えない）ときは、`--from-json` か `--from-markdown` を使います。
- 出力：`--out` の zip と、結果の JSON（`result.projectId`、`scriptHash`、`slides`）。
- 台本で録音の対象でない（`recordable: false`、非表示、ノートが空など）スライドは、切れ目にも動画にも入りません。`status`、`render`、`build` の結果の `skippedSlides`（`slideId`、`order`、`title`、`reason: "not-recordable"`）に出ます（`skippedSlideIds` は ID だけの配列）。
- 確認済みの入力は `--from-json`、`--from-markdown`、合成素材の `--from-pptx` です。

### 2. スマホで通しで録音する

Android の録音アプリで、台本を読みながら最初から最後まで通しで録ります。使うのは**保存（OK）と撮り直し**だけです。台本パックの読み込みは任意です（無くても録れますが、画面に台本を出したいときは読み込みます）。録り終えたら書き出して、zip（と `*_index.json`）を PC に移します。
この手順（スマホ側の操作）は、この README では確かめていません。以降は、`<書き出しのフォルダー>` にある書き出し（全記録 `full` と完成版 `final`）で進めます。

### 3. import：取り込む

```
narrate import <書き出しのフォルダー> --workspace ws
```

- 入力：書き出しの zip（複数の巻、`*_index.json`、フォルダでもよい）。台本パックは、フォルダの中にあれば自動で読みます。別に渡すときは `--script <script-pack.zip>` を付けます（フォルダにも台本パックがあるときは、`--script` を付けずにフォルダだけを渡してください。両方渡すと「台本パックが 2 つ」で失敗します）。
- 出力：`ws/sessions/<セッション>/`、`ws/script.json`、`ws/slides/`。通しの録音のときは、完成した 1 本の音声を `ws/final/all.wav` にも書き、警告 `continuous-recording` を出します（これは異常ではなく、「通しの録音として扱う」という知らせです）。
- 同じ zip をもう一度渡しても、何も起きません（`duplicates`）。

別の録音機器で録った通しの WAV も取り込めます。台本パックと合わせ、発表用の新しい作業フォルダーを指定します。

```powershell
.\narrate.cmd import --audio ".\recording.wav" --script ".\script-pack.zip" --workspace ".\ws"
```

入力は 8、16、44.1、48 kHz の 16 ビット・モノラル PCM WAV です。元ファイルを保ち、取り込み用に 48 kHz へ変換します。変換後の WAV が 1 GB を超える音声には対応していません。

### 4. status：状態を見る

```
narrate status --workspace ws
```

- 出力：標準出力だけ（何も書きません）。通しの録音は `result.continuous`、切れ目の状態は `result.boundaries.state` に出ます：`waiting-for-boundaries`（まだ切れ目が無い。次は transcribe と align）、`needs-decision`（判断待ち）、`ready`（render できる）、`invalid`（壊れている）、`none`。

### 5. transcribe：文字起こしをする

```
narrate transcribe --workspace ws
```

- `ws/final/all.wav` を faster-whisper（モデル small、CPU）で文字起こしし、語ごとの時刻を `ws/transcript.json` に書きます。音声認識の言語は日本語です。
- 同じ音声（SHA-256）・同じモデルなら、前の結果を使い回します（`result.cached`）。作り直すには `--force`。
- かかる時間：開発用の PC で、115 秒の音声が約 16 秒でした（音声の約 0.14 倍。モデルの読み込み 1 秒を含めて、コマンド全体で約 18 秒）。開発時の実測では 0.15〜0.21 倍が多く、別の処理が動いていた回は 0.52 倍でした。「音声の 0.2 倍前後、多くて 0.5 倍」と見てください。長い録音（30 分以上）の時間とメモリは未確認です。

### 6. align：台本と照合して、切れ目を決める

```
narrate align --workspace ws
```

- 台本のスライドごとの文と文字起こしを照合して、`ws/boundaries.json`（スライドごとの開始・終了の位置と、確かさ）を書きます。確かさが閾値（既定 0.8）以上の切れ目だけが `auto` になります。
- 自信の足りない切れ目があると、`boundaries.json` は書いたうえで**終了コード 4**（`errors[0].code = "decision-required"`）で止まります。次の「判断が要るとき」へ。全部 `auto` なら終了コード 0 で、そのまま render に進めます。
- 人または LLM が決めた切れ目（`confirmed`）がある `boundaries.json` は、`--force` なしでは上書きしません（`would-overwrite-decisions`）。

### 7. render：切れ目で音声を切る

```
narrate render --workspace ws
```

- `ws/boundaries.json` があれば自動で、通しの音声を切れ目で切ります。出力：`ws/out/final/<slideId>.wav`、`ws/out/timeline.json`（予定表）、`ws/out/slides/*.png`。
- 判断待ち（`needs-decision`）が残っていると、何も書かずに終了コード 4 で止まります。`--allow-unconfirmed` を付けたときだけ、候補のまま進みます（警告 `unconfirmed-boundaries`。確かめていない切れ目が入るので、通常は使いません）。
- **各スライドの終わりに 100 ms の余白**が入ります（`--tail-margin-ms`、既定 100、0 で余白なし）。各スライドの音声を、切れ目より 100 ms 手前で終わらせるだけです。理由：方式 A では、音声がスライドの時間いっぱいだと PowerPoint がスライドを音声の終わりまで延ばし、スライドごとに約 50 ms ずれが積もります（開発時の実測。余白 75 ms 以上で最大 16 ms に収まりました）。方式 B には要りませんが、同じ予定表を使うので既定で入ります。小さい声の語尾を残すため、切り落とせるのは 16 ビット PCM のピークが 32（約 -60 dBFS）以下の場合か、最大 100 ms の余白に対して同じ録音の文字起こしに発話がなく、波形も直前と同じ程度の安定した低い環境音を示す場合です。判断できない場合やスライドが短い場合は、余白なしで作り直し、警告 `tail-margin-skipped` を出します。その場合は方式 A でスライドごとにずれが積もることがあります。
- 別の場所の切れ目を使うには `--boundaries <boundaries.json>`。切れ目を使わず、従来のスライドごとの経路にするには `--no-boundaries`。
- **スライドが切り替わってから話し始めるまでの時間をそろえる**には `--lead-in-sec <秒>`（0〜30。既定 0 で従来どおり。通しの経路だけ。それ以外では警告 `lead-in-ignored` で無視）。各スライドの音声から話し始めを検出し、その 0.25 秒手前（`--lead-keep-ms`、0〜1000）より前を捨て、足りない長さに録音自身の部屋の雑音（無音ではない）を足します。元の無音が長いときは、足さずに切り詰めます。足したぶんだけ動画は長くなります（予定表の長さにも入る）。`--target-lufs` などの音量の処理は、足したあとの音声にかかります。話し始めが見つからないスライドは警告 `lead-in-onset-not-found`。結果の `finals[].leadIn` に、検出した位置、捨てた長さ、足した長さが出ます。

### 8. build：動画を作る

```
narrate build --method B --workspace ws
```

- 出力：`ws/out/video.mp4` と `build-report.json`。`--out <別のフォルダ>` を付けても、予定表は `--timeline` の指定、`<out>/timeline.json`、`<workspace>/out/timeline.json` の順に探します（見つけた場所は `result.timeline`）。
- 成功すると `ws/last-build.json` に動画と予定表の場所を書きます。次の `verify` が読みます。
- 方式 A（PowerPoint が動画を書き出す）は、`narrate build --method A --pptx <元の pptx> --workspace ws`。下の「方式 A と方式 B」を見てください。

### 9. verify：動画のずれを測る

```
narrate verify --workspace ws
```

- 動画と予定表の探し方：`--video` と `--timeline` を渡せば、それを使います。渡さないときは、動画は `--out <build の出力先>` の下、なければ `ws/last-build.json` の場所、それも無ければ `ws/out/video.mp4` です。予定表は `--out` の下に無ければ `last-build.json` の場所、`ws/out/timeline.json` の順です（`build --out` は動画だけを `--out` に置き、予定表は `ws/out/` のままなので、`verify --workspace ws --out <build の出力先>` で通ります）。`--out` を付けたときは、`last-build.json` より `--out` を優先します。`verify --workspace ws` だけでも通ります。
- 結果の書き出しは標準出力だけです。ファイルに残すには `--report <file.json>` を付けます。
- 各スライドで、絵の切り替えと音声の始まりを予定表と比べます（許容値は既定で絵 33.3ms、音声 20ms。方式 A は 50ms。`--tolerance-show-ms`、`--tolerance-audio-ms` で変えられます）。結果には、ずれの最大値 `result.maxAbsDiffMs`（`show`、`audio`。ミリ秒の絶対値）と、そのスライド `result.worst` が入ります。
- 許容値の外が 1 つでもあれば終了コード 3（`errors[0].code = "out-of-tolerance"`）。
- 音声を測れなかったスライド（測定不能）が 1 つでもあっても終了コード 3（`errors[0].code = "unmeasurable"`、`result.pass` は `false`）。測れた分だけの合否は `result.passMeasuredOnly` にあります。測れた分だけで決めてよいときは `--allow-unmeasurable` を付けます（警告 `unmeasurable` が出ます）。
- 上の例（`<書き出しのフォルダー>`、方式 B、13 枚）では、全部測れて `pass: true`、終了コード 0 でした。最大のずれは、絵が 13.3ms（s0004）、音声が 0ms でした。

## 判断が要るとき（終了コード 4：align と render）

`align` が終了コード 4 で止まったら、`result.needsDecision` に、決めてほしい切れ目の一覧が出ます。`<書き出しのフォルダー>` では、s0007 の切れ目が止まりました（確かさ 0.00。ほかの 12 の切れ目は `auto`）。1 件の中身は次のとおりです。

| 項目 | 意味 |
|---|---|
| `slideId`、`order` | 終わり（＝次のスライドの始まり）を決めたいスライド。切れ目は「このスライドの終わり」です |
| `boundaryAfter` | いまの候補の位置（秒） |
| `candidates` | 候補の位置（`sample`、`sec`）と得点 |
| `confidence`、`reason`、`factors` | 確かさと、低い理由（例：`weak-text-match-at-boundary`＝境目の前後の文字が台本と合わない） |
| `context.before`／`context.after` | 候補の位置の前と後の**文字起こし** |
| `scriptEnd`／`nextScriptStart` | 台本の、このスライドの終わりの文と、次のスライドの始めの文 |
| `howToSet` | 決めるコマンド |

LLM（または人）は、次の順で決めます。

1. `context.before` の終わりが `scriptEnd` に、`context.after` の始まりが `nextScriptStart` に、それぞれ合っているかを読みます。台本とは違って読んだ（読み飛ばし、言い直し、アドリブ、読み間違い）所があると、確かさは下がります。
2. 位置が合っていれば、候補のまま確定します。

   ```
   narrate boundary confirm --slide s0007 --workspace ws
   ```
3. 位置がずれていれば、正しい位置を秒で指定します。指定した時刻に最も近い無音（0.2 秒以上）の中点に吸着します。そのままの時刻にするには `--exact` を付けます。

   ```
   narrate boundary show --workspace ws
   narrate boundary set --slide s0007 --at 47.28 --workspace ws
   ```

   `boundary show` は、全スライドの切れ目の表（開始・終了の秒、確かさ、`status`）を出します。`set` は `status: "confirmed"`、`method: "manual"` になり、隣の切れ目と逆転・重なるときは終了コード 2（`boundary-order`）で断ります。最後のスライドの終わり（＝音声の終わり）は動かせません。
4. `result.remainingNeedsDecision` が空になったら、`render` に進みます（空でなければ、残りを同じ手順で決めます）。

**間違いやすい点**：自信の低い切れ目を、前後の文字起こしを確かめずに `confirm` しないでください。`confirm` は「候補が正しい」と言い切るコマンドで、間違った位置を確定すると、スライドの切り替えが話の途中に来ます。自動（`auto`）の切れ目より、判断待ちのほうが安全です。`--allow-unconfirmed` も同じ理由で、確かめずに使わないでください。

`<書き出しのフォルダー>` の s0007 では、`context.before` が台本の「…お話の部屋です。」で終わり、`context.after` が次のスライドの冒頭「絵本は職員が選び…」で始まっていました（台本の `scriptEnd` の後半「床にじゅうたんを敷いて…」は読み飛ばされていたため、確かさが 0 になった）。そこで `boundary set --slide s0007 --at 47.28` と `boundary confirm --slide s0007` のどちらでも通せることを、別々の作業場で確かめました（`set` の作業場は、続けて `render`、`build`、`verify` まで通りました。`confirm` の作業場は `render` まで確かめました）。別の書き出し では s0007 と s0013 が止まりました（こちらは `render` まで進めていません）。

## 全部の切れ目を見直す（boundary review）

`align` は、自信の高い切れ目を `auto` にします。ただし faster-whisper は聞き間違えることがあり（同音異義、言い間違いの書き起こし、読み飛ばし）、**確かさが高くても、切れ目が正しいとは限りません**。判断待ちだけでなく**すべての切れ目**を、AI（LLM）または人が、文字起こしと台本を見比べて検算できるように、材料を 1 回で出すコマンドがあります。`align` が終了コード 0 でも、`result.reviewHint` が「確かさが 0.9 未満の切れ目が n 件あります。見直してください」と案内します。

```
narrate boundary review --workspace ws                         （Markdown を標準出力の JSON の result.markdown に）
narrate boundary review --workspace ws --out ws/review.md     （ファイルに書く。.json なら JSON）
narrate boundary review --workspace ws --format json           （result.cuts に構造化した形）
```

- 出力は切れ目ごと（スライド i の終わり）に約 400 字（上限 `--max-chars`、既定 450。15 枚で約 6000 字）。含むもの：位置（秒）・確かさ・状態（`auto`／`confirmed`／`needs-decision`）、**前後の約 15 秒の文字起こし**（切れ目の位置が `▮`、5 秒ごとに `⟨秒⟩` の目印。`--context-sec` で変えられます）、台本のスライド i の末尾 60 字と次のスライドの先頭 60 字、台本の「スライド i の最後の文」と「次のスライドの最初の文」が文字起こしのどこに当たったか（時刻と一致度）、近くの無音の範囲（`*` が切れ目のある無音）、次点の候補、**怪しさの印（`⚑` と `flags`）**。
- 怪しさの印：`skipped-sentence`（端の文が文字起こしに無い＝読み飛ばしか、聞き間違いがひどい）、`repeat-suspected`（同じ文が 2 回ある疑い）、`extra-words`（スライドの間に台本にない言葉）、`weak-edge-match`（端の文の一致が低い）、`short-silence`／`no-silence-at-cut`（切れ目の無音が短い／無い）、`competing-candidate`（同じくらい合う別の場所がある）、`differs-from-aligner`（記録されている位置が、照合の推定と 1 秒以上違う）、`low-asr-confidence`、`slide-not-found`、`needs-decision`。印が付かなかった切れ目が正しいとは限りません（印は目安です）。**聞き間違いは、印が付かなくても、前後の文字起こしと台本の端が合っているかを読んで確かめてください。**
- 違うと思った切れ目は、`auto` のものも直せます。秒数で指定するか、文字起こしの語句で指定します（`review` に出ている文字起こしからそのまま写してください。`⟨25⟩` や `▮`、句読点、かなの種類、漢数字の違いは無視されます）。

  ```
  narrate boundary set --slide s0003 --at 24.2 --workspace ws
  narrate boundary set --slide s0003 --at-text "この会の目的です" --workspace ws       （その語句の直後の無音の中点）
  narrate boundary set --slide s0003 --before-text "対象は4歳から" --workspace ws      （その語句の直前の無音の中点）
  ```

  `--at-text` が、そのスライドと次のスライドの範囲で複数の場所に当たると、候補（文脈つき）を出して終了コード 2（`errors[0].code = "ambiguous-text"`）で止まります。`--nth N` で選ぶか、もっと長い語句にします。見つからないときは `text-not-found`（終了コード 2）。直した切れ目は `status: "confirmed"`、`method: "manual"`、前の値が `slides[].previous` に残ります（監査用。もう一度直すと入れ子で履歴が残ります）。
- 確かめたもの：合成音声の書き出し の 2 本（実際の faster-whisper の文字起こし）で、レビューは約 4700〜4900 字（12 の切れ目）でした。意図的に入れた誤り（位置を 1.5 秒／4 秒ずらす、直前 4 秒の語を別のかなに置き換える、その語を削除する）は、各種類 24 件（2 本 × 12 の切れ目）すべてに印が付きました。実際の人の声、長い録音は未確認です。

## 終了コード

| 値 | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 処理の失敗（入力の不備、壊れた ZIP、ファイルが無い、外部プログラムの失敗、音声認識のモデルが無い、など）。`errors[0].code` を見てください |
| 2 | 使い方の誤り（引数が足りない、知らない引数、`boundary set` が隣と逆転する） |
| 3 | 検証の不一致（ハッシュや台本・切れ目の食い違い、`verify` の許容値の外・測定不能） |
| 4 | 人の判断が要る（`align`／`render` の自信の低い切れ目 → `boundary set` か `boundary confirm`。従来の方式で候補が複数 → `select`） |

標準出力は 1 つの JSON `{ok, command, result, warnings, errors}` です。進み具合は標準エラー出力に 1 行 1 つの JSON（`{"progress":{...}}`）で出ます。`narrate --help` で、手順の順番（`workflow`）と各コマンドの既定の出力先（`defaultOutputs`）が見られます。

## 音量補正（任意）

録音の音量を整えるときは、`render` に目標値を指定します。

```powershell
.\narrate.cmd render --workspace ws --target-lufs -16 --ceiling-db -1.5
```

- 通しの録音では全スライドに共通の倍率を、スライド区切りモードではスライドごとの倍率を使います。元の録音と切れ目の位置を保ち、動画用の WAV だけを補正します。
- ITU-R BS.1770 の方法で 48 kHz モノラル PCM の音量と true peak を測ります。目標音量とピークの上限が両立しない場合は、全体の倍率を抑えてピークを優先します。JSON の `result.leveling` に補正前後の実測値と倍率が入り、目標に届かなければ `loudness-target-unmet` が出ます。
- `--target-lufs` を付けたときの既定の上限は −1.5 dBTP です。`--ceiling-db` だけを指定すると、ピークが高い音声だけを下げます。ピークは動画に入れる前の WAV についての測定です。

- 短いピークのために全体の音量が目標に届かない場合は、`--lookahead-limiter` を追加すると、ピークの前後で局所的に音量を下げます。結果の音量と true peak は `result.leveling` で確認できます。

## 方式 A と方式 B

| | 方式 A | 方式 B |
|---|---|---|
| 動画の作り方 | PowerPoint が書き出す（`--method A --pptx <元の pptx>`） | `.venv` の Python（PyAV）が作る（`--method B`） |
| 必要なもの | PowerPoint | PowerPoint は不要 |
| 速さ（3 枚、開発用の PC） | 約 2.4〜3.1 秒 | 約 0.5 秒（開発時の実測。短い動画のみ） |
| 音声の周波数 | 44.1kHz | 48kHz |

- **開発用の PC での実測**：方式 A の MP4 は、音声が 44.1kHz でした（`verify` で測った結果）。PowerPoint の仕様かどうかは未確認です。方式 B は元の音声のまま 48kHz です。
- 方式 A は、PowerPoint に別の資料が開いているときは何も触らずに終了コード 1（`powerpoint-busy`）で止まります。
- 通し録音から作った方式 A の動画は、合成素材で検証しました。

## 従来の方式（スライドごとの書き出し）

録音中に「次のスライドへ」を押して録った、スライドごとの書き出しも、従来どおり `render` で動きます（`boundaries.json` を使わない経路）。

```
narrate import <zip|*_index.json|フォルダ> --script script-pack.zip --workspace ws
narrate status --workspace ws
narrate render --workspace ws
narrate build --method B --workspace ws
narrate verify --workspace ws
```

- `status` の `state` は、スライドごとに `missing`（録音なし）、`single`（候補 1 つ）、`multiple`（候補が複数。判断が要る）、`stale`（台本の文が変わった）。
- 録音対象のスライドに使える録音がない場合（未収録、台本の変更、レンダリング不能など）は、`render` が `missing-slides`（終了コード 1）で止まります。録音を補って取り込むか、省略した状態の動画を意図して作るときだけ `render` と `build` の両方に `--allow-missing` を付けます。通しの録音では全スライド分の切れ目が必要です。
- 同じスライドに、別のセッションの録音（または編集の版が違う完成版）が 2 つ以上あると、`render` は終了コード 4（`decision-required`）で止まります。`result.needsDecision` に候補が出るので、選びます。

  ```
  narrate select --slide s0002 --session <セッションの ID> --take <テイクの ID> --workspace ws
  narrate select --slide s0002 --clear --workspace ws        （選びを消す）
  ```

  完成版のほうを選ぶときは `--export <exportId>` を足します。選びは `ws/selections.json` に残り、そのあと `render` をやり直します。同じセッションの中の撮り直しは候補に数えません。
- 作業場に `boundaries.json` があると `render` は切れ目の経路になるので、従来の経路にしたいときは `--no-boundaries` を付けます。
- 確かめたもの：`examples/` の素材（`examples/packs/tiny3.zip`）で、import → status → render → build → verify を実行しました（前の版の README を書いたとき）。このあとの変更の確認は `npm test` の試験（`test/cli/`）によります。`select` の例は、実際に 2 つの候補で終了コード 4 になる流れを、この README の例では動かしていません（`test/cli/render.test.js` が確かめています）。

## 録音アプリの録り方（通し、台本の表示、スライド区切りモード）

- **既定は通し**：ホームの「台本なしで録音を始める」で、台本を読み込まなくても、すぐ録音を始められます。録音は最初から最後まで 1 本で、使うのは「OK」と「撮り直し」だけです（取り消し、やり直し、一時停止、印、直前を聞く、試し録り、復旧もこれまでどおり）。「次のスライドへ」のボタンもキー（Enter）も、スライドの一覧もありません。書き出しの `manifest.json` の `recording` は `"continuous"`、台本（`script.json`）は 1 枚（slideId `free`、題名「通し録音」、文は空）です。
- **台本の表示**：台本パック（または貼り付けた内容）を読み込んであるときは、「この台本を表示して録音を始める」で、全スライドの文が、スライドの区切りなしの 1 本の連続した文章として、スクロールできる形で録音の画面に出ます。「台本を隠す／台本を出す」のボタンで切り替えられ、切り替えは次回起動時も覚えます。文字の大きさは A−／A＋。台本は表示だけに使い、録音のセッションの台本（free）には影響しません（読み込んだ台本の projectId は書き出しのファイル名に、題名は AI 用プロンプトの穴埋めに使います）。台本が無いときは、台本の欄は出ません。
- **スライド区切りモード（任意。高精度で作りたい人向け）**：ホームの「スライド区切りモード」にチェックを入れたときだけ、従来の録り方（台本パックの読み込み、「次のスライドへ」のボタンとキー、スライドの移動、未収録へ移動）になります。`next-slide`／`goto-slide` を書き、`manifest.json` の `recording` は `"per-slide"` です（台本が 1 枚でも通しとはみなしません）。台本パックが無いと入れられません（読み込みを促す文が出ます）。選択は次回起動時も覚え、既定は常に通しです。PC 側の手順は、下の「従来の方式」です。
- **確かめたこと**：PC の Chrome で、通しの録音（next なし）、台本の表示／非表示と記憶、スライド区切りモードの切り替えと従来の操作、強制終了からの復旧、書き出し（`recording` の値）、`import` → `status` → `render` → `build`（方式 B）→ `verify` を通しました（`test/app/pipeline.test.js`、`test/e2e/continuous.test.js`、`test/e2e/ai-prompt.test.js`）。ネイティブ版は、エミュレーター（実機ではない）で、台本の表示／非表示、台本なしで録音を始める、録音 → 書き出し → システムの保存画面での保存を確かめました（`npm run test:native-emulator:app`）。実機では未確認です。

## AI に動画作成を頼む（アプリの「AI 用の動画作成プロンプトをコピー」ボタン）

録音アプリ（`app/`）には、PC の AI（ファイルを読み書きし、コマンドを実行できるもの）に渡す説明文を、クリップボードへコピーするボタンがあります。AI は、この README の手順（通しの録音なら import → status → transcribe → align → render → build → verify。スライド区切りで録ったものなら「従来の方式」）を、説明文に従って進めます。

- **場所**：ホームの「AI で動画を作る」の欄と、書き出しが終わった画面（巻の保存と索引のあと）。
- **文言**：日本語「AI 用の動画作成プロンプトをコピー」、英語「Copy AI video-making prompt」（アプリの表示言語で切り替わります）。
- **押すと**：クリップボードへコピーして「コピーしました」を出します。コピーできなかったとき（権限がない、など）は、本文を画面に出すので、選んでコピーしてください。
- **中身**：README 形式（Markdown）の**英語**の説明文です（元は `app/prompts/video-prompt.md`。1 つのファイル）。
  - 冒頭に「利用者の言語で答える」規則があります（AI は、利用者が書いてくる言語で答える。分からなければ言語のヒントを使い、ヒントが空なら利用者に聞く。コマンド、ファイル名、コード、エラーコードは訳さない）。言語のヒントには、端末の言語（`navigator.language`）とアプリの表示言語が入ります。
  - アプリの版（`versionName`）、利用者が AI に渡すファイル、道具の場所（`<path to the lap-narrator folder>`。利用者が AI に教える）、実際に動くコマンド、方式 A（Windows と PowerPoint が要る）と方式 B、終了コード、**`align` が終了コード 0 でも、必ず `boundary review` で全部の切れ目を読み、台本の端と文字起こしの前後が合っているかを確かめ、合わなければ `boundary set --at-text` で直す**手順（同音異義の聞き間違いには機械の印が付かないので、AI が文面から見つける）、判断待ち（4）のときの `boundary show`／`set`／`confirm`（**前後の文字起こしを確かめずに `confirm` しない**）、不一致（3）と測定不能のときの扱い、禁止（入力ファイルを書き換えない、インストールや外部への送信をしない、ほかの PowerPoint の資料に触らない、推測で台本や録音を変えない）、完了の報告の形（動画の場所、検証の数値、問題点）が書いてあります。
  - この端末で書き出した項目があれば、そのファイル名、exportId、録り方（`continuous`／`per-slide`）、スライドの数、撮り直しの数が入ります（ホームでは端末内の操作記録から。書き出しが終わった画面では、いま書き出した項目）。なければ一般形の文になります。
  - **音量**：スマホの録音はとても小さいことが多い（実際の録音で、話し声が約 −56 dBFS）ので、`render` に `--target-lufs -16 --ceiling-db -1.5 --lookahead-limiter` を付けて音量をそろえるよう書いてあります（付けないと動画の音が聞こえないほど小さくなります）。雑音の床も一緒に上がるので、マイクを口に近づけて録ると良いこと、警告 `loudness-target-unmet` を読むことも書いてあります。
  - **スライドが切り替わってから話し始めるまでの 4 秒**：`render` に `--lead-in-sec 4` を付けるよう書いてあります（別の秒数を望む利用者なら、その値にします）。
- **確かめたこと**：エミュレーター（実機ではない）で、ボタンを押して「コピーしました」が出ること、貼り付けのキーでクリップボードの中身が入っていること（18,749 字）を確かめました。PC の Chrome でボタンを押して、クリップボードの中身を読みました（`test/e2e/ai-prompt.test.js`：書き出しなしのホーム、言語の切り替え、コピー失敗時の本文の表示、書き出しの画面と書き出したあとのホーム、通しと区切りモードの違い）。プロンプトの中の `narrate` のコマンドとフラグが、`node cli/narrate.js --help` の usage とこの README に実在すること、手順の順番がこの README の最初の手順と同じことは、`test/app/ai-prompt.test.js` が確かめます（実在しないものがあれば落ちます）。
- **確かめていないこと**：実機でのクリップボード、実際の AI にこの説明文を渡しての動作です（どちらも未確認）。

## Android の release ビルド

`npm run build:android -- --release` の release APK には、開発・試験用のもの（`window.__lap` の入口、偽の入力、URL パラメーターによる試験用の設定、Service Worker と manifest とアイコン、PC 側だけの `core/` の部品など）を入れません。release のときは URL パラメーターを一切使いません。中身は `npm run test:native`（`native/test/release-check.mjs`）が、APK を zip として開いて確かめます。debug APK には開発・試験用の機能も入ります。生成した release APK は署名前のビルドです。

## まだできないこと・確かめていないこと

- **実際の人の声**：文字起こしと切れ目の決定は、合成音声でしか確かめていません。人の声（雑音、言い淀み、方言）で、切れ目の自信がどう出るかは未確認です。閾値 0.8 は合成音声の評価で決めたものです。
- 旧形式の ZIP に含まれる 48 kHz 以外の音声は `render` で変換できません。通しの単独 WAV は `import --audio` で変換できます。
- 書き出しの `edits.json` の `limiter` は適用されず、`limiter-not-applied` が出ます。PC で先読みリミッターを使う場合は `render --lookahead-limiter` で指定します。
- `check`（音声の点検）コマンドは、まだありません。
- 長い録音：30 分以上の録音の文字起こしの時間とメモリは未確認です。スマホの長時間（60 分）の録音も未確認です。凍結対策を入れた前の開発版では、充電した Android 実機で 10 分の画面ロックを 1 回通過しました。最新の実機版、電池のみでの長時間試験は未確認です。
- 同じ作業場を複数の `narrate` から同時には使わないでください。`build` が `stale-timeline` を返したら、`render` をやり直して成功してから `build` を再実行します。
- 最新版を実機の Android で起動し、PowerPoint から作ったパックの読み込み、録音、PC への読み込みまでを一続きで確認する試験は未実施です。

## 試験

```
npm test            （PowerPoint は動かしません）
npm run test:cli    （CLI だけ）
npm run test:app    （録音アプリ。PC の Chrome を使います）
npm run test:e2e    （通しの試験。Chrome と .venv を使います。PowerPoint の段を飛ばすには環境変数 LAP_SKIP_POWERPOINT=1）
npm run test:native （ネイティブ版の橋渡しと、release の写し・APK の中身の検査）
```

方式 A を含む試験（`npm run test:builder`、`npm run test:all`）は PowerPoint を動かします。
