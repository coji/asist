# いまの状態: macOS に依存しているところ

2026-09-27 の main(`5d7c5d6`)を調べた結果です。ソースとテストは TypeScript で約12万行あり、Windows 向けのコードは一つもありません。行番号はこのコミットのものです。

## そのまま Windows で動くもの

- GPT-Live と Gemini Live のエンジン(`src/main/services/live/`)。main から WebSocket でつなぐだけで、ネイティブや Python に頼っていません。
- 会話のモデルの呼び出し(`src/main/services/llm/`)、メール(`node:sqlite`、IMAP、SMTP)、天気、カードの取得。
- renderer の中で動くもの。ブラウザの中の Whisper(Transformers.js、WebGPU と WASM)、Silero VAD、DeepFilterNet、Web Speech のシステムの声。
- API キーの暗号化。safeStorage を差し込む形で使っていて、キーチェーンを直接呼んでいません。Windows では DPAPI が使われます。
- 単一インスタンスのロック、`powerMonitor`、`shell.trashItem`。

## 直せば動くもの(Mac で書いてテストできます)

| 場所 | いまの状態 | Windows で起きること |
|---|---|---|
| `src/main/services/file-preview.ts:21` `allowedPath` | `/` で始まらないパスを拒む | ファイルのカード、`asist-file://`、「フォルダで表示」がすべて動かない |
| `src/main/services/file-protocol.ts:18,96-109` | URL を `/` で分けて組み立てる | `C:\x\y.png` がホスト名として扱われ、読めない |
| `src/shared/agent-stream.ts:242` `artifactPaths` | `/` で始まるパスだけを残す | ジョブの成果物がすべて消える |
| `src/main/services/brain/job-tools.ts:183` `ABSOLUTE_PATH` | POSIX のパスだけに合う | 記憶からプロジェクトを選べない |
| `src/shared/files.ts:78,101`、`src/shared/project-index.ts:29,73`、`src/main/services/project-index.ts:77`、`panel-fetchers.ts:246` | `/` で名前を切り出す | 名前と種類の判定を誤る。プロジェクトが重複する |
| renderer の `JobLog.tsx:12-14,35`、`JobArtifacts.tsx:43,81`、`panels/builtin/agent-job.tsx:181-182`、`viewers/CodeViewer.tsx:114`、`viewers/PptxViewer.tsx:31,34` | `/` で分ける | 表示が崩れる(pptx の中のパスは `/` で正しい) |
| `src/main/services/settings.ts:57,60` | `~/Desktop` などを自分で組み立てる | OneDrive にデスクトップを移したマシンで違うフォルダを見る |
| 置き換えの書き込み8か所(`atomic-json.ts:39,52`、`encrypted-secrets.ts:92-94`、`settings.ts:106-108`、`store.ts:22`、`timers.ts:87-89`、`mail-drafts.ts:86-87`、`notes.ts:93-95`、`onnx-runtime.ts:137`) | 一時ファイルからリネームで置き換える | ウイルス対策や検索のインデックスが対象を開いていると、EPERM や EBUSY でときどき失敗する |
| `src/main/services/child-env.ts:13-16`、`git.ts:30-34` | 環境変数の名前を大文字小文字を区別して消す | `Anthropic_Api_Key` のような書き方のキーがすり抜ける |
| `src/main/services/git.ts:33` | `GIT_CONFIG_GLOBAL=/dev/null` | `os.devNull` にすれば確実になる |
| `src/main/services/uv.ts:23-25`、`mlx-runtime.ts:47`、`vap.ts:168`、`onnx-runtime.ts:41` | `uv/uv`、venv の `bin/python` | Windows では `uv.exe`、`Scripts\python.exe` |
| `resources/vap_worker.py:215` | `os.nice(5)` を呼び、`OSError` だけを捕まえる | Windows には `os.nice` が無く、`AttributeError` で worker が起動前に落ちる |
| Python の worker 全部 | 標準入出力の文字コードを決めていない | Windows ではパイプが cp932 になり、日本語を読み違える(`PYTHONUTF8=1` が要る) |
| `resources/*-requirements.txt` | `aarch64-apple-darwin` 向けにコンパイルしている | Windows では colorama のハッシュが無く、インストールが止まる(それ以外のハッシュは同じだった) |
| 画面の文言 | 「この Mac」「Finder」「⌥Space」「~/Library」など82件(英語で数えた。11言語で同じ数) | Windows の人には意味が通らない |
| `src/main/ipc.ts:204,429` | `x-apple.systempreferences:` を開く | 何も起きない |
| `src/renderer/src/assets/main.css:22,35`、`themes/pop/theme.css:58,60` | Avenir Next、Hiragino、SF Mono を並べる | Windows では既定のフォントに落ちる |

## Windows の実機でないと作れないもの

- **エージェントのプロセス。** `agent-process.ts:108` は `/bin/sh` を起動用のシェルにして、プロセスグループを作ります。`agent-process-lifetime.ts` は `process.kill(-pid)` でグループに信号を送ります。`agent-process-identity.ts` は `/bin/ps` でグループの全員を調べ、`ps eww` で環境変数のトークンを照合します。Windows にはどれもありません。CLI を探す処理(`agent-process.ts:29-81`)も、`/opt/homebrew` と `zsh -lc whence` だけです。
- **同梱する git。** `scripts/build-git.sh` がソースから Mac 用にコンパイルします。Windows では MinGit を使いますが、フック、長いパス、改行、worktree の削除時のロック、`C:/` と `C:\` のパスの比較は、実機で確かめる必要があります。
- **ウィンドウ。** `index.ts:53-54` の `titleBarStyle: 'hiddenInset'` は、Windows では閉じるボタンなどのないウィンドウになります。トレイのアイコン(`os-integration.ts:24-26`)は黒一色のテンプレート画像で、暗いタスクバーでは見えません。`Alt+Space`(`os-integration.ts:95-97`)は Windows のウィンドウメニューと PowerToys Run が使っています。通知に要る AppUserModelID を設定していません。
- **エコーキャンセル。** 詳しくは [design/05-speech.md](design/05-speech.md) にあります。

## 別のものに置き換えないと動かないもの

- **MLX の音声認識と Qwen3-TTS。** `mlx-runtime.ts:37-39` が darwin と arm64 に限っています。lock ファイルに `mlx` と `mlx-metal` が入っています。
- **Swift の補助プログラム。** マイク(`resources/native/asist-mic.swift`、macOS の voice processing)とカレンダー(`resources/native/asist-calendar.swift`、EventKit)です。

## ビルドと CI

- `package.json` の `predev`、`prebuild`、`pretest` は `sh scripts/*.sh` を並べています。4つのスクリプトは、Mac 以外では何もせずに `exit 0` で終わります。GitHub の Windows の runner には Git Bash の `sh` があるので、スクリプトは動き、git も uv も入らないまま成功します。
- `electron-builder.yml` の `extraResources` に、Mac のバイナリ(`asist-mic`、`asist-calendar`)と `build/lproj` が入っています。`win:` の設定はありません。
- CI(`.github/workflows/ci.yml`)の job は、アプリについてはすべて `macos-latest` で動きます。`.github/actions/setup-app` のキャッシュの場所は `~/Library/Caches` です。
- `.gitattributes` がありません。いまのファイルはすべて LF です。Git for Windows の既定の `core.autocrlf=true` で clone すると CRLF になり、`scripts/i18n.mjs` の行の処理や、ソースを読むテストが壊れます。
- `.claude/skills` と `.agents/skills` は `skills/` へのシンボリックリンク(mode 120000)です。Windows で普通に clone すると `../skills` と書かれたテキストファイルになり、Claude Code と Codex はスキルを1つも読めません。

## Windows で `npm test` を動かしたときの見込み

約1,890件のうち約190件(18ファイル)が失敗する見込みです。

- **約150件は、同梱の git が無いことだけが原因です。** `git-service`、`agent-worktree`、`agent-crash-recovery`、`memory-store`、`memory-service`、`memory-curation-service` などです。
- **POSIX に固有のことを確かめるテスト。**
  - `#!/bin/sh` のフックを置くもの(`git-service.test.ts:83,98,137,357,528,541`、`agent-worktree.test.ts:294`)
  - `process.kill(-pid)` を使うもの(`agent-process-lifetime.test.ts:110,137`、`agent-crash-recovery.test.ts`)
  - `mkfifo` を使うもの(`memory-store.test.ts:211`、`memory-service.test.ts:97`)
  - シンボリックリンクを作るもの(`file-protocol.test.ts:52`、`file-preview.test.ts:73,81,110`、`panel-fetchers.test.ts:191`、`memory-curation-service.test.ts:133`、`git-service.test.ts:719-726`)
- **ファイルの権限の値を確かめるテスト。** `0o600` を確かめます(`api-key-secrets.test.ts:74`、`mail-secrets.test.ts:37`、`store.test.ts:18,23`、`conversation-log.test.ts:49`、`app-log.test.ts:53`)。Windows では `0o666` と報告されます。
- **パスの区切りを前提にした期待値。** `uv-env.test.ts:26-27` は `'/data/python'` を期待していますが、`path.join` は `\data\python` を返します。
- **一時フォルダのパスを使うテスト。** `file-preview.test.ts` の約7件と `file-protocol.test.ts` の3件は、`C:\` で始まる一時フォルダのパスを `allowedPath` と `fileUrl` に渡すので失敗します。
- **すでに OS で分けてあるテスト。** `calendar-helper.test.ts:36` と `mlx-model-download.test.ts:73` は `describe.runIf(process.platform === 'darwin')` です。
