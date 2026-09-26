# ADR にする判断

リポジトリの `docs/adr/` に入れる予定の記録です。形は `adr` スキルに従い、判断を入れる PR と同じコミットで書きます。ここに書くのは、その下書きと、どの PR で入れるかだけです。「見送った案」には、設計として比べた選択肢だけを入れます。

## 新しい記録

### Windows では x64 と NVIDIA の GPU を前提にし、ローカルの音声認識は CUDA の torch で動かす

- **入れる PR。** M5 の CUDA の実行環境の PR。
- **決めたこと。**
  - Windows で対象にするのは x64 だけです。
  - ローカルの音声認識は、NVIDIA の GPU がある場合にだけ提供し、Qwen3-ASR を torch と CUDA で動かします。
  - GPU が無いマシンでは、ローカルの音声認識の選択肢を出さず、理由を表示します。ブラウザの中の Whisper と live のエンジンは使えます。
- **理由。**
  - macOS で使っている Qwen3-ASR を同じモデルで使えば、日本語の聞き取りの質が OS で変わりません。
  - Qwen3-ASR の公式の実装は、torch の上で動きます。
  - CPU では、話している途中の結果が間に合わないと見込んでいます(M5 で実測して、この記録に数字を書きます)。
- **見送った案。**
  - sherpa-onnx の日本語のモデル(ReazonSpeech の zipformer)で、CPU で動かす。GPU が要らない利点はありますが、macOS と違うモデルになり、聞き取りの質を別に調整することになります。
  - faster-whisper(CTranslate2)。Whisper は、macOS でも Qwen3-ASR より下の選択肢として置いています。
  - Arm64 の Windows も対象にする。CUDA の torch と CTranslate2 の wheel がありません。
- **分かっている制約。**
  - 実行環境(CUDA の torch)のダウンロードは数 GB になります(M5 で実測して書きます)。
  - GPU のドライバーが古いと動きません。

### その OS で使えない機能は、画面にもモデルのツールにも出さない

- **入れる PR。** M1 の capabilities の PR。
- **決めたこと。**
  - main が起動時に、その OS とマシンで使える機能を決めます。renderer とモデルのツールは、その値だけを見ます。
  - 使えない機能は出しません。使えるはずの機能が失敗したときは、エラーとして見せます。
- **理由。** 出しておいて押すと失敗する形では、Windows の初回セットアップで、失敗を3回見てからでないと先に進めません。
- **見送った案。**
  - renderer に OS の名前を渡し、画面ごとに判定する。判定が画面の数だけ散らばり、モデルのツールの一覧と画面がずれます。

### Windows ではエージェントの CLI を、Job Object を持つ起動用のプログラムから動かす

- **入れる PR。** M4 の launcher の PR。
- **決めたこと。**
  - `asist-agent-launcher.exe` が、トークンの名前の Job Object を作ります。
  - CLI を止めた状態で起動して Job に入れてから、再開します。
  - 止めるとき、CLI が自分で終わったとき、ASIST が落ちたときのどれでも、Job が空になってから launcher が終わります。
  - 再起動のあとは、Job の名前で見つけて止めます。
- **理由。**
  - Windows には、プロセスグループと、グループへの信号がありません。
  - 親子のつながりをたどるだけでは、親が先に終わった孫を取りこぼします。
  - PID はすぐ再利用されるので、PID と時刻では自分のプロセスだと確かめられません。
- **見送った案。**
  - `taskkill /T /F`。
  - main から FFI で Job Object を扱う。
  - PowerShell の `Get-CimInstance Win32_Process` で調べる。
  - 理由は [design/03-agent-process.md](design/03-agent-process.md) にあります。
- **分かっている制約。**
  - SIGTERM にあたるものが無いので、CLI に片づけの時間を与えずに止めます。
  - `.cmd` の CLI(npm で入れたもの)は使えません。

## 今ある記録への追記

### 0007(uv と git はアプリに同梱する)

- **入れる PR。** M2 の準備のスクリプトの PR。
- **追記すること。**
  - Windows では、Git for Windows が配っている MinGit を同梱します。
  - Windows には、システムの git がありません。
  - Windows で git をソースからビルドするには MSYS2 の環境が要り、Git for Windows が同じものをアプリに入れるための形(MinGit)で配っています。
  - uv は、Windows でも同じく同梱します。
- **制約に足すこと。**
  - MinGit には、git のほかに MSYS2 の実行時ライブラリと sh が入っています。
  - 配布するときのソースの提供は、Git for Windows の同じタグと、MSYS2 のパッケージのソースも対象になります。
  - macOS と Windows で、git のバージョンが少しずれることがあります。

### 0006(API キーは暗号化して保存し、子プロセスに渡さない)

- **入れる PR。** M3 の Windows で起動できるようにする PR。
- **制約に足すこと。**
  - Windows の safeStorage は DPAPI です。同じ利用者で動くプロセスからは、鍵を取り出せます。
  - プロンプトインジェクションを受けたジョブが自分でキーのファイルを読みに行くことは、Windows では防げません。
  - Windows では、開発中のアプリとインストールしたアプリが同じ鍵を使います。どちらも userData が `%APPDATA%\asist` で、DPAPI で守った鍵はその中の `Local State` にあるためです。そのため、一方で保存したキーをもう一方でも読めます。

### 0010、0014、0016(ジョブのコミットと取り込み)

- **入れる PR。** M4 で MinGit での挙動を確かめたとき。
- **追記すること。** Windows で挙動が変わると分かったときだけ、制約を足します。確かめるのは次の点です。
  - フックが MinGit の sh で動くこと
  - `core.longpaths`
  - 改行
  - `core.symlinks` と `core.fileMode` を git が自動で判定すること
