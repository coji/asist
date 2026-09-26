# 決めていないこと、確かめていないこと

## 決めること

| 問い | いまの案 | 決める時期 |
|---|---|---|
| Windows でカレンダーをどう作るか(CalDAV、Google Calendar API、Microsoft Graph、作らない) | 最初は出さない | 第2段階の前 |
| 署名と配布(署名しない、個人向けの証明書、Microsoft Store) | 当分は署名しない。SmartScreen の警告をドキュメントに書く | 配布の前 |
| 紹介動画を作り直すか | 公開済みの動画はそのままにし、必要なら Windows の告知の短い動画を別に作る | M6 |
| macOS で、ネイティブのマイクが動いている最中に落ちたとき、getUserMedia に切り替える動きを残すか(AGENTS.md の「fallback を足さない」とぶつかる) | Windows の対応とは別の PR で決める | いつでも |
| 文字が収まるかを OS ごとに測らずに済ませるため、フォントを同梱して macOS と Windows で同じフォントで描くか(Noto Sans JP など OFL のもの。日本語は太さ1つで数 MB、ヒンディー語や韓国語もそろえるならさらに増え、Mac の見た目は Hiragino から変わる) | いまは考えない。Windows のフォントの違いが問題になったら検討する | M3-7 |

## 実機で確かめること

| 問い | どこで確かめるか | 結果によって変わること |
|---|---|---|
| Chromium のエコーキャンセルで、スピーカーの読み上げを拾い直さないか。`echoCancellation: "all"` が Electron 43 で効くか | M5-7 | Windows のマイクの既定。システムの声を選べるか |
| MLX の CUDA のバックエンドが Windows で動くか | M5-5 | 聞き取りの実装(MLX のまま、か transformers か) |
| Qwen3-ASR の VRAM と遅延(1.7B と 0.6B) | M5-5 | モデルの推奨のしきい値 |
| RTX 20(fp16)で Qwen3-ASR の精度が崩れないか | M5-5 | 対象の GPU を RTX 30 以降に絞るか |
| transformers の `apply_transcription_request` が、`sampling_rate` なしの配列を 16kHz として扱うか | M5-3(Mac でも確かめられる) | worker の書き方 |
| MaAI が x64 の CPU で 80ms のフレームに間に合うか | M5-9 | MaAI を Windows で出すか |
| huggingface_hub がシンボリックリンクを作れないときの、ダウンロードの進み具合の数え方 | M5-6 | 進み具合の表示 |
| VOICEVOX と AivisSpeech の Windows のインストール先 | M5-10 | 自動起動の候補 |
| claude の記憶の整理で、PowerShell のツールのときに許すコマンドをどう書くか | M4-6 | 整理のジョブの引数 |
| codex の Windows の sandbox が、書き込みを worktree に限り、ネットワークを閉じるか | M4-6 | codex で記憶の整理と読むだけのジョブを動かせるか |
| MinGit で、フックが動くか、worktree の削除がロックで失敗しないか | M4-7 | 削除の再試行 |
| MinGit から Git Credential Manager などを消しても、ASIST の使う git の操作が全部動くか | M2-2、M3-1 | 同梱する大きさ |
| windows-latest の runner に日本語のフォント(Yu Gothic)があるか | M2-9 | `demo:fit` を Windows の CI で動かせるか |
| windows-latest の runner でシンボリックリンクを作れるか | M2-10 | シンボリックリンクのテストの扱い |
| 署名の無い Windows のアプリで、electron-updater の更新がどう振る舞うか | M6-7 | 自動更新 |
| npm の Codex CLI の中にある本物の `codex.exe` の場所 | M4-2 | 案内の文(いまの案では使わない) |
| 許可したフォルダの中に、別のサーバーの共有フォルダ(`\\server\share`)を指すシンボリックリンクやジャンクションがあるとき、`allowedPath` の `realpath` がそのサーバーに接続して、利用者の資格情報を送るか。いまは、書かれたパスのドライブか共有フォルダが、許可したフォルダのどれとも違うときにだけ、ディスクに問い合わせる前に拒んでいる | M3 | `realPath` を作り直して、リンクの行き先を1段ずつ確かめてから進むか |
| 共有フォルダとネットワークドライブの中のファイルを、ファイルのカードで開けるか。`asist-file://` はホストのある URL を拒み、`allowedPath` は書かれたままの許可したフォルダと同じドライブか共有フォルダしか通さないので、`Z:` が `realpath` で `\\server\share` に変わると開けない見込み | M3 | 共有フォルダのファイルを URL でどう表すか、ドライブをどう比べるか |
