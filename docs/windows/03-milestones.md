# マイルストーンとタスク

## 見方

- **タスクの番号。** `M<マイルストーン>-<番号>` です。
- **「場所」。** そのタスクをどこで進めるかです。
  - Mac: この Mac で書き、テストも Mac で通します。
  - CI: GitHub Actions の windows-latest で確かめます。
  - Win: Windows の実機が要ります。
- **「PR」。** どのタスクを1つの PR にまとめるかです。1つの PR は、AGENTS.md のとおり1つのまとまりにします。
- **進み具合。** issue #48 のチェックリストで追います。このファイルにはチェックを付けません。
- **終わりの条件。** どのタスクも、`npm run typecheck` と `npm test` が Mac で通ることが前提です。M2 の最後からは、windows-latest でも通ることが前提です。

## 全体の順序

```
M0 下地 ─┬─ M1 OS に依らないコード ─┐
         └─ M2 同梱物・ビルド・CI ──┴─ M3 Windows で起動 ─┬─ M4 エージェントと git ─┐
                                                          └─ M5 音声 ───────────────┴─ M6 仕上げ
M5 の Mac の部分(M5-1〜M5-4)は M2 のあとすぐ始められる
```

- M1 と M2 は、互いに触るファイルがほとんど重ならないので、並行して進められます。
- M1 の中の PR 同士も、ほぼ並行して進められます(依存は表に書きます)。
- Windows のセッションを始めるのは、M1 と M2 が終わってからです。

---

## M0 リポジトリの下地(Mac)

Windows で clone して開発を始められる状態にします。

| # | タスク | 触るファイル | 終わりの条件 | 場所 |
|---|---|---|---|---|
| M0-1 | `.gitattributes` に `* text=auto eol=lf` を書き、画像、音声、フォント、PDF、zip などを `binary` にする | `.gitattributes` | `git add --renormalize .` で差分が出ない | Mac |
| M0-2 | Windows で clone するときの手順を書く(開発者モード、`core.symlinks`、`core.longpaths`、リンクの確かめ方) | `AGENTS.md`(短く)、`docs/development.md` | | Mac |
| M0-3 | `worktree-delegation` のスクリプトの `cp -cR`(APFS の複製)を、OS を見て選ぶ形にする。スクリプトを Node にする | `skills/worktree-delegation/scripts/*`、`SKILL.md`、`references/*.md` | Mac で worktree を用意でき、`cp -c` の速さが変わらない | Mac |
| M0-4 | `scripts/cdp/cdp.mjs` の Chrome の場所を、OS ごとの既定の場所から探す(`CHROME_BIN` の上書きは残す) | `scripts/cdp/cdp.mjs` | Mac で `npm run demo:cards` が動く | Mac |
| M0-5 | `scripts/wrangler.mjs` が、`.bin/wrangler` ではなく `process.execPath` で wrangler の JS を起動する | `scripts/wrangler.mjs` | Mac で `npm run cf -- whoami` が動く | Mac |

**PR:** M0 をまとめて1つにします(開発の環境の整備)。

---

## M1 OS に依らないコード(Mac)

Windows の書き方のパスと、OS ごとに使える機能を、Mac の上で正しく扱えるようにします。設計は [design/02](design/02-platform-capabilities.md)、[design/06](design/06-os-integration.md)、[design/07](design/07-files-and-paths.md) にあります。

| # | タスク | 触るファイル | 終わりの条件 | 場所 | PR |
|---|---|---|---|---|---|
| M1-1 | `src/shared/file-path.ts`(`isAbsolutePath`、`baseName`、`dirName`、`trimTrailingSeparator`)を作る | `src/shared/file-path.ts`、テスト | POSIX と Windows の両方の書き方のテストが通る | Mac | A |
| M1-2 | `allowedPath` と `realPath` を `path` の関数で書き直す。Windows では大文字小文字を区別せずに比べ、代替データストリームを拒む | `file-preview.ts`、テスト | `path.win32` を使ったテストで、Windows のパスの許可と拒否が正しい | Mac | A |
| M1-3 | `asist-file://` の URL を `pathToFileURL` と `fileURLToPath` の規則にする | `file-protocol.ts`、`src/shared/app-page.ts`、テスト | `{ windows: true }` のテストで、ドライブレターのパスが往復する | Mac | A |
| M1-4 | `artifactPaths`、`ABSOLUTE_PATH`、`shared/files.ts`、`shared/project-index.ts`、`services/project-index.ts`、`panel-fetchers.ts` を M1-1 の関数に替える | 各ファイル、テスト | Windows のパスの成果物が残る。プロジェクトが重複しない | Mac | A |
| M1-5 | renderer のパスの処理(`JobLog.tsx`、`JobArtifacts.tsx`、`agent-job.tsx`、`CodeViewer.tsx`)を M1-1 の関数に替える | 各ファイル | Windows のパスのジョブのログと成果物が、demo で正しく出る | Mac | A |
| M1-6 | git から受け取るパスを `path.resolve` と `realpathSync.native` で整える(`memory-store.ts:78`、`agent.ts:386`、`git.ts:128-136`) | `git.ts`、`memory-store.ts`、`agent.ts` | Mac のテストがそのまま通る(Windows での効果は M4 で確かめる) | Mac | A |
| M1-7 | 置き換えの書き込みを `atomic-json.ts` の1つの関数にまとめ、8か所をそれに替える。一時ファイルの名前を書き込みごとに変える。Windows では EPERM、EBUSY、EACCES のときに約2秒まで再試行する | `atomic-json.ts` ほか8ファイル、テスト | 再試行のテスト(`fs.rename` を差し替えて、何回目で成功するか、上限で投げるか)が通る | Mac | B |
| M1-8 | 記憶のページの名前で、Windows の予約名を拒む。Windows ではシンボリックリンクを `lstat` と `ino` の比較で拒む | `shared/memory-page.ts`、`memory-store.ts`、テスト | 予約名のテストが通る | Mac | B |
| M1-9 | 既定のフォルダを `app.getPath` から取る | `settings.ts` | | Mac | B |
| M1-10 | `childEnv` と `gitEnv` で、Windows では環境変数の名前を大文字小文字を区別せずに消す | `child-env.ts`、`git.ts`、テスト | 差し替えた環境で `Anthropic_Api_Key` も消えるテストが通る | Mac | B |
| M1-11 | すべての `spawn` と `execFile` に `windowsHide: true` を付ける | `git.ts`、`uv.ts`、`mlx-runtime.ts`、`vap.ts`、`onnx-worker.ts`、`tts.ts`、`native-mic.ts`、`calendar.ts` ほか | 付け忘れを見つけるテスト(ソースを読んで、`spawn(` と `execFile` の呼び出しに `windowsHide` があるか)を足すかは、AGENTS.md の「形だけを確かめるテストを書かない」との兼ね合いで決める | Mac | B |
| M1-12 | `src/shared/platform.ts` の型と決め方の関数、`src/main/services/platform.ts`、`gpu.ts`(nvidia-smi)、IPC の `GetPlatformCapabilities` を作る | 新規3ファイル、`shared/ipc.ts`、preload、テスト | OS、CPU、GPU の組み合わせのテストが通る | Mac | C |
| M1-13 | main の中の OS の判定7か所を、capabilities を読む形に替える | `ipc.ts`、`mlx-runtime.ts`、`vap.ts`、`onnx-runtime.ts`、`native-mic.ts`、`calendar.ts` | テストで OS を差し替える書き方が無くなる | Mac | C |
| M1-14 | capabilities で画面とツールを出し分ける(カレンダーのツール、カード、設定、要約、ネイティブのマイクのスイッチ、ローカルの音声認識の選択肢、追加の準備) | `brain/tools.ts`、`brain/mini-app-tools.ts`、`brain/prompt.ts`、`panels/registry.tsx`、`SetupWizard.tsx`、`setup/*`、`settings/pages/*` | demo に Windows の capabilities を渡すと、使えない機能が出ない。demo のフィクスチャに Windows の場合を足す | Mac | C |
| M1-15 | マイクの許可の確かめ方と、設定を開くリンクを OS ごとにする | `ipc.ts:204,225-230` | | Mac(Windows の動きは M3) | C |
| M1-16 | ショートカットの値を capabilities の `hotkey` にし、表記を値から作る。登録の失敗を設定の画面に出す | `os-integration.ts`、`settings-voice.ts`、`VoicePage.tsx` | Mac の動きが変わらない。失敗が画面に出る | Mac | C |
| M1-17 | Mac を前提にした文言82件を、OS に依らない言い方か OS ごとのキーにする(11言語) | `src/shared/i18n/messages/*`、`brain/prompt.ts`、使う側 | `npm run i18n -- check`、`npm run demo:fit` が通る | Mac | D |
| M1-18 | フォントの並びに Windows のフォントを足す | `main.css`、`themes/pop/theme.css` | Mac の見た目が変わらない(`demo:fit` と撮影で確かめる) | Mac | D |
| M1-19 | `ui-text` スキルに、OS の部品の名前を出す文は OS ごとのキーにする、という決まりを足す。M1-17 で変えた文言を引用しているドキュメントのページを、日本語と英語で直す | `skills/ui-text/SKILL.md`、`website/src/content/docs/**` | `npm run website:build` が通る | Mac | D |
| M1-20 | AGENTS.md に、capabilities の決まり、パスの決まり、`windowsHide` の決まりを足す | `AGENTS.md` | | Mac | A、B、C のそれぞれ |

**PR:**
- **A** パスの扱い(M1-1〜M1-6)
- **B** ファイルの書き込みとプロセスの起動(M1-7〜M1-11)
- **C** OS ごとに使える機能(M1-12〜M1-16)。ADR「その OS で使えない機能は出さない」を入れる
- **D** 文言とフォント(M1-17、M1-18)。C のあとに進める。OS ごとのキーを選ぶのに capabilities の `os` を使うため

A、B、C は並行して進められます。

---

## M2 同梱物、ビルド、CI(Mac と CI)

Windows で `npm ci`、`npm test`、`npm run dist:win:dir` が動く状態を、CI で確かめられるようにします。設計は [design/04](design/04-bundled-tools.md) と [design/08](design/08-build-ci-tests.md) にあります。

| # | タスク | 触るファイル | 終わりの条件 | 場所 | PR |
|---|---|---|---|---|---|
| M2-1 | `scripts/prepare-resources.mjs` と `scripts/resources/*` を作り、4つの `.sh` を置き換える。`package.json` の `predev`、`prebuild`、`pretest` をこれに替える。Swift のソースを `resources/native/macos/` に移す | `scripts/*`、`package.json`、`resources/native/*`、`.gitignore` | Mac で `npm run build` と `npm test` がいまと同じに動く。対応していない OS で止まる | Mac | E |
| M2-2 | `git-windows.mjs`(MinGit の取得、ハッシュの確認、展開、使わない部分の削除)と、`uv.mjs` の Windows の表を作る | `scripts/resources/*` | Mac の上で、Windows 向けの取得と展開を試せる(`--platform win32` のような確認用の引数を用意する) | Mac | E |
| M2-3 | `gitPath()`、`uvPath()`、`venvPython()` を OS ごとにし、`gitEnv()` に Windows の設定(`MSYSTEM` を消す、`GIT_ATTR_NOSYSTEM`、`core.longpaths`)を足す。`GIT_CONFIG_GLOBAL` は両方の OS で `/dev/null` のままにする | `git.ts`、`uv.ts`、`mlx-runtime.ts`、`vap.ts`、`onnx-runtime.ts`、テスト | `uv-env.test.ts` が `path.join` の期待値で通る | Mac | E |
| M2-4 | ADR 0007 に Windows の理由と制約を書き足す | `docs/adr/0007-*.md` | | Mac | E |
| M2-5 | `native-windows.mjs` と `resources/native/windows/asist-agent-launcher.c` の最初の形を作る(`--version` と、Job Object を作って子を起動し、終わるのを待つだけ) | `scripts/resources/native-windows.mjs`、`resources/native/windows/*` | CI の windows-latest でビルドでき、`--version` が動く | Mac と CI | E |
| M2-6 | Python の worker に `PYTHONUTF8=1` を渡す。`vap_worker.py` の `os.nice` を分ける | `onnx-worker.ts`、`vap.ts`、`mlx-runtime.ts`、`resources/vap_worker.py` | | Mac | F |
| M2-7 | CPU の worker の lock を、両方の OS で使える形にコンパイルし直す(`--universal` か OS ごとのファイル) | `resources/*-requirements*.txt`、`uv.ts` の呼び出し側 | Mac で環境を作り直して、記憶の検索と MaAI が動く | Mac | F |
| M2-8 | `electron-builder.yml` を `mac:` と `win:` に分け、`dist:win`、`dist:win:dir` を足す。`third-party-notices.mjs` の文を OS ごとにする | `electron-builder.yml`、`package.json`、`scripts/third-party-notices.mjs` | Mac では `npm run dist:win:dir` が理由を出して止まる。Windows 用の git と uv を指す設定の写しで作った `win-unpacked` の中身の並びが設計どおり。Mac のアプリの `Contents/Resources` がいまと同じ | Mac | G |
| M2-9 | `.github/actions/setup-app` のキャッシュの場所と、`ci.yml` の `test-windows` と `build-windows` を足す。キャッシュのキーを `scripts/resources/**` にする | `.github/*` | windows-latest で2つの job が最後まで動く(この時点では失敗があってよい) | CI | H |
| M2-10 | POSIX に固有のテストを OS で分け、Windows で動かすように直すテストを直す | `tests/*` | windows-latest の `test-windows` が緑になる。落ちたままのテストがあれば、その原因を M3 のタスクにする | CI | H |
| M2-11 | `test-windows` と `build-windows` を `result` の `needs` に入れて必須にする | `ci.yml` | | CI | H |
| M2-12 | `docs/development.md` に、Windows で起動する、テストする、ビルドする手順を書く | `docs/development.md` | | Mac | H |

**PR:**
- **E** 準備のスクリプトと同梱の道具(M2-1〜M2-5)
- **F** Python の worker(M2-6、M2-7)
- **G** electron-builder(M2-8)
- **H** Windows の CI(M2-9〜M2-12)。E、F、G と M1 の A、B のあとに進める

---

## M3 Windows で起動できる(Win)

ここから Windows の Claude Code のセッションで進めます。最初に [04-windows-dev-setup.md](04-windows-dev-setup.md) を済ませます。

| # | タスク | 終わりの条件 |
|---|---|---|
| M3-1 | `npm ci`、`npm run typecheck`、`npm test`、`npm run dev` を通す。落ちたものを直す | Windows の実機でも CI と同じく緑になる。ウィンドウが開く |
| M3-2 | `window-chrome.ts` を作り、タイトルバーを `titleBarOverlay` にする。テーマの色を renderer から送る。左の余白をなくし右に取る。アプリのメニューをなくす | 3つのテーマで、ボタンの色がテーマに合う。ドラッグで動かせる |
| M3-3 | トレイの `.ico` を作り、OS ごとに使い分ける | 明るいタスクバーと暗いタスクバーで見える |
| M3-4 | ショートカットの既定の値を決める。他のアプリとぶつからないことを確かめる | 登録でき、押すとウィンドウとマイクが出る |
| M3-5 | 通知の AUMID を設定する | インストールしたアプリでメールとタイマーの通知が出る |
| M3-6 | マイクの許可を Windows の設定から読む | 設定でマイクを拒否すると、画面に理由と設定を開くボタンが出る |
| M3-7 | Windows のフォントで `demo:fit` を動かし、はみ出しを直す | 11言語で収まる |
| M3-8 | `npm run dist:win` で作ったインストーラーで入れ、起動する。ASAR の検査を有効にしたまま起動することを確かめる | `%LOCALAPPDATA%\Programs\asist\ASIST.exe` が起動し、ログが `%APPDATA%\asist\logs` に出る |
| M3-9 | `skills/install-windows-app` を作る(ビルド、インストール、ログ付きの起動、CDP での確認、終了)。AGENTS.md のスキルの一覧と、`pull-request` スキルの install-mac-app を指す2か所を直す | 別のセッションがスキルだけを読んで、入れて確かめて終了できる |
| M3-11 | `theme` スキルに、タイトルバーのボタンの色のトークンを足す(M3-2 と同じ PR)。`panel-card-design` の `shell-contract.md` に、Windows のウィンドウの高さの実測を足す(M3-7 と同じ PR) | |
| M3-10 | ADR 0006 に Windows の制約を書き足す | |

**PR:**
- M3-1 は、見つかった原因ごとに PR を分けます。
- M3-2〜M3-6 は、1つの PR にまとめます(ウィンドウと OS の連携)。
- M3-7 は、1つの PR にします(フォント)。
- M3-8〜M3-10 は、1つの PR にまとめます(インストールと確認の手順)。

---

## M4 エージェントと git(Win)

設計は [design/03-agent-process.md](design/03-agent-process.md) にあります。

| # | タスク | 終わりの条件 |
|---|---|---|
| M4-1 | `agent-process/` のフォルダを作り、いまの3ファイルを `index.ts` と `posix.ts` に移す(Mac でもできる。中身は変えない) | Mac のテストがそのまま通る |
| M4-2 | `cli-locator.ts` を作り、Windows の候補と PATH の探し方を足す。`.cmd` を拒む | `path.win32` のテストが通る。実機で claude.exe と codex.exe が見つかる |
| M4-3 | `asist-agent-launcher.c` を仕上げる(名前付きの Job、制御のパイプ、`start` を待つ、引数の引用、`--inspect`、`--stop`) | 子孫を残して終わる CLI の役のプログラムで、launcher の終了のあとに子孫がいない。ASIST の役のプロセスを止めると Job が止まる |
| M4-4 | `windows.ts` を作り、起動、止める、回復を launcher で行う | `agent-crash-recovery` の Windows 用のテストが通る |
| M4-5 | 書き込むジョブを実機で動かす(開始、継続、取り込み、破棄、確認の画面、キャンセル) | development.md の「Agent」の確認の項目がすべて Windows で通る |
| M4-6 | 記憶の整理のジョブの閉じ込め方を、claude と codex のそれぞれで確かめる(許すコマンドの書き方、sandbox の書き込みの範囲、ネットワーク) | 確かめられたエンジンだけで整理が動き、確かめられないエンジンでは始まらずにエラーになる |
| M4-7 | MinGit で、フック、長いパス、改行、`core.symlinks` の自動判定、worktree の削除のときのロックを確かめ、必要なら直す | `git-service` と `agent-worktree` のテストが Windows で通る。実機で長いパスのリポジトリの worktree を作って消せる |
| M4-8 | ADR「Windows ではエージェントを Job Object の中で動かす」と、0010、0014、0016 への追記(変わった点があれば) | |

**PR:**
- M4-1 と M4-2 で1つにします。M4-1 は Mac で先に出してもかまいません。
- M4-3 と M4-4 で1つにし、M4-8 の ADR もここに入れます。
- M4-6 で1つにします。
- M4-7 で1つにします。

---

## M5 音声(Mac で下書き、Win で仕上げ)

設計は [design/05-speech.md](design/05-speech.md) にあります。

| # | タスク | 場所 | 終わりの条件 |
|---|---|---|---|
| M5-1 | `mlx-runtime.ts` を `speech-runtime.ts` に、`mlx-asr.ts` を `local-asr.ts` に、`mlx-asr-transcriptions.ts` を `asr-transcriptions.ts` にし、実行環境(MLX と CUDA)を値として渡す形にする。この時点の中身は MLX だけ | Mac | Mac の音声認識と Qwen3-TTS が、いまと同じに動く(実機で確かめる) |
| M5-2 | 設定の `asrModel` を OS に依らない名前にし、`settings.json` を v4 にする(移行と見本を足す)。実行環境ごとのモデルの表を `asr-models.ts` に置く | Mac | v3 の見本から v4 へ移すテストが通る |
| M5-3 | `resources/cuda_asr_worker.py`(transformers 5.17.0 のネイティブの Qwen3-ASR)と `resources/cuda-speech-requirements.txt`(torch 2.14.0+cu130 をハッシュ付きの URL で固定)を作る。worker は Mac の CPU で `Qwen/Qwen3-ASR-0.6B-hf` を動かして、やりとりの形と日本語の結果を確かめる。lock は `--python-platform x86_64-pc-windows-msvc` の `--dry-run` で入ることを確かめる | Mac | Mac の CPU で、いまの MLX の worker と同じ要求に同じ形で答える |
| M5-4 | `gpu.ts` の nvidia-smi の出力の読み取りと、ドライバー(580 以上)、compute capability(7.5 以上)、VRAM から使えるかどうかと勧めるモデルを決める関数を作る | Mac | 出力の見本を使ったテストが通る |
| M5-5 | Windows で、最初に MLX の CUDA(`mlx-cuda-13` と `mlx-audio`)で Mac の worker がそのまま動くかを1時間だけ試す。次に CUDA の実行環境(transformers)を作り、Qwen3-ASR の 1.7B と 0.6B を動かす。遅延(話し終わりから文字が出るまで、話している途中の結果の間隔)、VRAM、インストールしたあとの大きさを測る。RTX 20(fp16)で精度が崩れないかを見る | Win | どちらの方法にするかと、実測の値が ADR に入る |
| M5-6 | CUDA の実行環境を `speech-runtime.ts` に入れ、セットアップと設定から準備できるようにする。GPU が無いとき、ドライバーが古いときは理由を出す | Win | 初回セットアップで Qwen3-ASR を準備して、声で会話できる |
| M5-7 | エコーキャンセルを実測する(スピーカーで、VOICEVOX、live のエンジン、システムの声それぞれ、`echoCancellation` が `true` と `"all"` のとき)。結果から Windows の既定を決める | Win | 読み上げ中に自分の声を拾い直さない設定が決まる |
| M5-8 | Windows のマイクの取り込みを、getUserMedia を正式な経路とする形にする(ネイティブのヘルパーが無いことを fallback として扱わない) | Mac と Win | Windows で、ネイティブのヘルパーの失敗の記録が出ない |
| M5-9 | 記憶の検索、相槌の分類器、MaAI を Windows の CPU で動かす。MaAI の1フレームあたりの時間を測る | Win | 追加の準備が Windows で終わり、MaAI の CPU の時間が 80ms のフレームに収まる |
| M5-10 | VOICEVOX と AivisSpeech の Windows のインストール先を、自動起動の候補に足す。Windows 用の文言は、いまは「自分で起動してもらう」形なので、`setup.tts.engines.voicevox.detail`、`setup.tts.engines.aivisspeech.detail`、`setup.tts.howtoInstall`、`setup.tts.howtoVerify`、`setup.tts.connectFailed`、`setup.guide.tts.notConnected` の Windows 用を書き直す | Win | 入れてあれば自動で起動する |
| M5-11 | ADR「Windows では x64 と NVIDIA の GPU を前提にし、CUDA の torch で動かす」を実測の値とともに入れる | Win | |

**PR:**
- M5-1 で1つにします(リファクタリング)。
- M5-2 で1つにします(設定の移行)。
- M5-3 と M5-4 は、M5-5 と M5-6 と合わせて1つにします。Mac の下書きは、ブランチに積んでおきます。
- M5-7 と M5-8 で1つにします。
- M5-9 で1つにします。
- M5-10 で1つにします。

---

## M6 仕上げ(Win と Mac)

何をどう直すかは [design/09-docs-site-skills.md](design/09-docs-site-skills.md) にあります。

| # | タスク | 終わりの条件 |
|---|---|---|
| M6-1 | development.md の「実機での確認」に、Windows で確かめる項目を足す(カレンダーを除く全項目と、Windows だけの項目: タイトルバー、トレイ、通知、Job Object、GPU) | |
| M6-2 | M6-1 の項目を、インストールしたアプリで全部確かめる | 結果を作業の報告に残す |
| M6-3 | ドキュメントの約20ページを、日本語と英語で直す。OS ごとに手順が違うページは Starlight の `Tabs`(`syncKey="os"`)にする。`troubleshooting` に Windows の項目を足す。`website` スキルに、OS ごとの手順の書き方を足す | `npm run website:build` が通る(リンクと画像の確かめを含む) |
| M6-4 | 紹介ページの11言語の文、動く環境の表記、ダウンロードの案内を直す。OG の画像を作り直す | 11言語で表示を確かめる |
| M6-5 | README.md と README.ja.md の説明、バッジ、必要なもの、データの置き場所、キーの暗号化の行を直す | |
| M6-6 | サイトを公開する(`npm run website:deploy`)。公開してよいかは、issue #48 の確認待ちで聞く | |
| M6-7 | PR #1 がマージされていれば、`scripts/release.mjs` で Windows のインストーラーも作って Release に載せる。署名の無い更新で electron-updater がどう振る舞うかを確かめる | Windows のアプリが次のバージョンに自分で更新される |
| M6-8 | このフォルダ(`docs/windows/`)を消す。残す判断が ADR に、手順が `docs/development.md` と skills に移っていることを確かめてから | AGENTS.md からこのフォルダへの言及も消える |

**PR:**
- M6-1 と M6-2 で1つにします。
- M6-3、M6-4、M6-5 で1つにします(利用者向けの文書)。
- M6-7 で1つにします。
- M6-8 で1つにします。

---

## 第2段階(このマイルストーンの外)

- Qwen3-TTS を CUDA で動かします(`resources/qwen_tts_worker.py` と同じやりとりの worker を足します)。
- 必要なら、ネイティブのエコーキャンセルの補助プログラムを作ります(M5-7 の結果しだい)。
- カレンダーの方法を決めて作ります。
- 署名と配布を整えます(証明書か Microsoft Store か)。
- live のエンジンを初回セットアップで選べるようにします。これは Mac でも同じです。
