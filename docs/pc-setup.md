# 個人利用の準備と最初の動画

## 今の PC で開く

成果物の「lap-narrator PC」ショートカット、または lap-narrator のフォルダーを開いてアドレス欄に `powershell` と入力し、PowerShell を開きます。次の 2 行で PC 側の準備を確認できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\check-pc.ps1
.\narrate.cmd --help
```

準備チェックは Node.js、Python のライブラリ、動画エンコーダー、音声認識モデルの読み込みを確認します。インストールは行わず、モデルはローカルから読みます。スライド区切りモードだけを使うなら 1 行目の末尾に `-PerSlide` を付けると、音声認識の確認を省けます。Python を別の場所に用意した場合は、その実行ファイルを環境変数 `NARRATE_PYTHON` に指定できます。

## Android アプリを入れる・更新する

成果物の `lap-narrator-personal.apk` を Android に転送し、「ファイル」から開きます。Android が確認を表示したら、開いたアプリからのインストールを許可して進みます。既に lap-narrator が入っている場合は、録音の ZIP と索引を PC に控えてから、アプリを残したまま「更新」を選びます。この個人版は以前の開発用 APK と同じ署名で作っています。署名の違いなどで更新できないと表示されたら、既存のアプリはそのままにしてください。

## 日本語の発表を通しで録る

PowerPoint の各スライドのノートに読み上げる文を書き、発表ファイルを保存します。開いているプレゼンテーションを閉じ、PowerShell で台本パックを作ります。以下の `deck.pptx` は実際のファイル名に置き換えてください。

```powershell
.\narrate.cmd pack --from-pptx ".\deck.pptx" --out ".\script-pack.zip"
```

1. Android アプリ **lap-narrator** を開き、マイクの使用を許可します。録音中の通知を見たい場合は、通知も許可します。
2. `script-pack.zip` をスマホに転送し、アプリのホームから読み込みます。「この台本を表示して録音を始める」で録音画面を開き、「録音」を押します。録音は通しで進むので、スライドの切り替えは不要です。
3. 終わったら「OK」で採用する範囲を確定し、「一時停止」してホームへ戻ります。録音の行の「書き出し」を押します。初回は「全記録」を選び、ZIP のすべての巻と索引 JSON を同じローカルフォルダー（例では `phone-export`）に保存して PC へ移します。ZIP は展開せず、同じ台本パックを PC に残します。
4. PC で取り込んで文字起こしし、切れ目を確認します。以下は発表ごとに新しい作業フォルダー `ws` を使う例です。

```powershell
.\narrate.cmd import ".\phone-export" --script ".\script-pack.zip" --workspace ".\ws"
.\narrate.cmd status --workspace ".\ws"
.\narrate.cmd transcribe --workspace ".\ws"
.\narrate.cmd align --workspace ".\ws"
.\narrate.cmd boundary review --workspace ".\ws" --out ".\ws\review.md"
```

`align` が終了コード 4 を返した場合は切れ目の判断が必要です。`review.md` で台本と文字起こしを比べ、迷う箇所は音声を聞き、位置を修正または確定します。終了コード 0 でも全箇所の切れ目を見直します。操作は [切れ目の見直し](../README.md#全部の切れ目を見直すboundary-review) を参照してください。

```powershell
.\narrate.cmd render --workspace ".\ws"
.\narrate.cmd build --method B --workspace ".\ws"
.\narrate.cmd verify --workspace ".\ws" --report ".\ws\verify.json"
```

`ws\out\video.mp4` を再生して、スライドと読み上げの切り替えを確認します。方式 B はスライドの静止画を使います。PowerPoint の画面切り替えやアニメーションを含めたい場合は方式 A を使い、元の PowerPoint と出力動画の両方で再生を確認します。出力ファイル名は `build` の JSON に表示されます。PowerPoint で他の資料を開いていると、方式 A と `pack --from-pptx` は `powerpoint-busy` で止まります。

日本語以外を録る場合は、スマホで「スライド区切りモード」を選んで、録音中にスライドを切り替えます。PC では `transcribe`、`align`、`boundary` を省き、`render`、`build`、`verify` を実行します。

## 別の Windows PC の準備

Node.js 22 以上、64 ビット Python 3.12、lap-narrator のフォルダーを用意します。この手順は現在の Windows 11 PC を基準にしています。スライドを PowerPoint から取り出す場合や、方式 A を使う場合はWindows 版 PowerPoint も用意します。既存の環境が準備チェックを通る場合、この節の導入作業は不要です。

新しく環境を作る場合は、次のコマンドを順に実行します。インストール先は lap-narrator フォルダー内の `.venv` です。パッケージやモデルの取得にはインターネット接続が必要です。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-speech.txt
.\.venv\Scripts\hf.exe download Systran/faster-whisper-small --cache-dir models --revision 536b0662742c02347bc0e980a01041f333bce120
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\check-pc.ps1
```

スライド区切りモードだけを使う場合は `requirements-pc.txt` を指定し、モデルは取得せずに `check-pc.ps1 -PerSlide` で確認します。CLI を使うための npm パッケージのインストールは不要です。

## 録音データの扱い

録音は最初にアプリ内に保存されます。保存画面では端末内のフォルダーを選べます。アプリのデータ削除や再インストールに備えて、録り終えたら書き出して PC に控えを残してください。書き出し先にクラウドに同期するフォルダーを選ぶと、そのサービスにデータが渡る場合があります。録音・動画・文字起こしは、PC の処理と検証だけなら外部サービスに送る必要はありません。AI に作業を依頼する場合は、その AI がファイルや台本をどこで処理するかを確認してください。
