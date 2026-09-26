# 設計の方針とディレクトリ構成

## 方針

1. **OS による違いは、責務ごとに1か所で決める。**
   - `if (process.platform === 'win32')` を呼び出し側に散らしません。
   - 同じ責務を OS ごとに実装するときは、共通の型を1つ決め、OS ごとの実装を別のファイルに置きます。どちらを使うかは、起動時に1回だけ選びます。例として、エージェントのプロセスでは `posix.ts` と `windows.ts` を分けます。
   - いまの `process.platform` の判定は7か所にあります。これらは、使える機能を決めるモジュールにまとめます。
2. **「使えない」と「失敗した」を分ける。**
   - その OS で使えない機能は、画面にもモデルのツールにも出しません。
   - 使えるはずの機能が失敗したときは、エラーとして見せます。
   - 使えない機能を別の機能で黙って置き換えること(fallback)はしません。AGENTS.md の「fallback を足さない」と同じ考えです。
3. **使える機能は main が決め、renderer に渡す。**
   - いまの renderer は OS を知りません(preload と IPC に `process.platform` を出していません)。
   - renderer に OS の名前を渡すのではなく、「カレンダーが使えるか」「ローカルの音声認識がどの実行環境で動くか」のような、機能の単位の値を渡します。
   - 表示の文言が OS で変わるところ(「Finder で表示」と「エクスプローラーで表示」など)だけは、OS の種類も渡します。
4. **パスは OS の書き方のまま扱う。**
   - main では `node:path` の関数だけを使い、`/` で分ける処理を書きません。
   - renderer と shared では `node:path` を使えません。そのため、両方の書き方を扱う小さな関数を `src/shared/file-path.ts` に1つだけ用意します。
   - テストは `path.posix` と `path.win32` の両方で書き、Mac の上でも Windows の書き方を確かめられるようにします。
5. **保存するファイルの形は OS で変えない。**
   - 設定に OS に固有の値を書かないようにします。例えば音声認識のモデルは、「Qwen3-ASR 1.7B」のように OS に依らない名前で保存します。MLX で動かすか CUDA で動かすかは、実行時に導きます。
   - 形を変えるときは、AGENTS.md のとおり `StoredFormat` のバージョンを上げ、前のバージョンからの移行と `tests/fixtures/stored/` の見本を足します。
6. **ネイティブの補助プログラムは、その OS の標準の道具で作る。**
   - macOS は Swift(swiftc)のまま、Windows は C(MSVC の cl.exe)で書きます。
   - どちらも「標準入出力で1つの仕事をする小さなプログラム」という、いまの Swift の補助プログラムと同じ形にします。
7. **Windows で確かめられない部分を、Mac で先に作り込みすぎない。**
   - Mac で書くのは、純粋なロジック、型、テスト、設定、スクリプトまでにします。
   - Win32 API に触れる部分と実測が要る部分は、Windows の実機で作ります。

## ディレクトリ構成

いまの構成を大きくは変えません。増えるのは、OS ごとの実装を並べる場所と、準備のスクリプトです。

```
asist/
├── .gitattributes                           新規。* text=auto eol=lf
├── .github/
│   ├── actions/setup-app/action.yml         変更。Electron のキャッシュの場所を OS ごとにする
│   └── workflows/ci.yml                     変更。test-windows と build-windows を足し、result の needs に入れる
├── AGENTS.md                                変更。Windows で clone するときの注意(シンボリックリンク)
├── docs/
│   ├── adr/                                 新規の ADR と 0006、0007 の追記(05-adr-drafts.md)
│   └── development.md                       変更。Windows で起動する、ビルドする、確かめる、の手順
├── electron-builder.yml                     変更。Mac だけの extraResources を mac: に移し、win: を足す
├── package.json                             変更。pre スクリプトを node に替え、dist:win を足す
├── resources/
│   ├── native/
│   │   ├── macos/                           移動。asist-mic.swift、asist-calendar.swift、calendar-info.plist
│   │   └── windows/
│   │       └── asist-agent-launcher.c       新規。Job Object の中で CLI を起動する
│   ├── cuda_asr_worker.py                   新規。Qwen3-ASR を torch と CUDA で動かす worker
│   ├── cuda-speech-requirements.txt         新規。Windows の CUDA の実行環境の lock
│   ├── mlx_asr_worker.py ほか                既存のまま
│   ├── git/                                 生成物。Mac はソースからのビルド、Windows は MinGit
│   └── uv/                                  生成物。Mac は uv、Windows は uv.exe
├── scripts/
│   ├── prepare-resources.mjs                新規。predev、prebuild、pretest から呼ぶ入口。OS と CPU で処理を選び、対応していない組み合わせでは失敗する
│   ├── resources/                           新規
│   │   ├── git-macos.mjs                    build-git.sh を移したもの
│   │   ├── git-windows.mjs                  MinGit の取得、ハッシュの確認、展開
│   │   ├── uv.mjs                           OS ごとの uv の取得(バージョンとハッシュの表を1つにする)
│   │   ├── native-macos.mjs                 build-native-mic.sh と build-native-calendar.sh を移したもの
│   │   └── native-windows.mjs               cl.exe で asist-agent-launcher.exe を作る
│   ├── build-git.sh ほか4つの .sh             削除
│   ├── cdp/cdp.mjs                          変更。Windows の Chrome の場所
│   └── wrangler.mjs                         変更。node から wrangler の JS を起動する
├── skills/
│   ├── install-windows-app/                 新規。Windows 用の install-mac-app
│   └── worktree-delegation/scripts/         変更。cp -c をやめる
├── src/
│   ├── main/
│   │   ├── index.ts                         変更。ウィンドウの設定を window-chrome.ts から受け取る
│   │   ├── window-chrome.ts                 新規。タイトルバーとアプリのメニューを OS ごとに決める
│   │   ├── os-integration.ts                変更。トレイのアイコン、ショートカット、通知の AUMID を OS ごとにする
│   │   └── services/
│   │       ├── agent-process/               新規のフォルダ。いまの agent-process*.ts を移す
│   │       │   ├── index.ts                 起動と出力の解析。OS ごとの実装を選ぶ
│   │       │   ├── cli-locator.ts           claude と codex の実行ファイルを探す
│   │       │   ├── posix.ts                 /bin/sh の起動、プロセスグループ、ps(いまの lifetime と identity)
│   │       │   └── windows.ts               asist-agent-launcher.exe と Job Object
│   │       ├── platform.ts                  新規。その OS で使える機能を決めて IPC で渡す
│   │       ├── gpu.ts                       新規。nvidia-smi で NVIDIA の GPU、VRAM、ドライバーを調べる
│   │       ├── speech-runtime.ts            改名。mlx-runtime.ts を、MLX と CUDA の2つの実行環境を扱える形にする
│   │       ├── local-asr.ts                 改名。mlx-asr.ts を、実行環境に依らない形にする
│   │       ├── asr-transcriptions.ts        改名。mlx-asr-transcriptions.ts(中身はもともと MLX に依らない)
│   │       ├── atomic-json.ts               変更。8か所の置き換えの書き込みをここに集める
│   │       ├── uv.ts                        変更。uv.exe と venv の Python の場所を返す関数を持つ
│   │       └── git.ts                       変更。git.exe の場所、MSYSTEM、core.longpaths
│   ├── shared/
│   │   ├── platform.ts                      新規。PlatformCapabilities の型と、値から機能を決める純粋な関数
│   │   ├── file-path.ts                     新規。POSIX と Windows の両方のパスを扱う関数(renderer と shared 用)
│   │   ├── asr-models.ts                    変更。OS に依らないモデルの名前と、実行環境ごとの固定したモデル
│   │   └── i18n/messages/*.ts               変更。Mac を前提にした文言
│   └── renderer/src/
│       ├── ui/setup/、ui/settings/           変更。capabilities で出し分ける
│       └── assets/main.css ほか              変更。Windows のフォントを並べる
└── tests/
    ├── fixtures/stored/settings.v4.json     新規。音声認識のモデルの名前を変えたあとの見本
    └── *.test.ts                            変更。POSIX に固有のテストを OS で分ける、Windows のパスのテストを足す
```

## 置き場所を決めた理由

- **`agent-process/` をフォルダにする理由。**
  - いまの3ファイル(`agent-process.ts`、`-lifetime.ts`、`-identity.ts`)に、Windows の実装と CLI を探す処理が加わり、同じ責務のファイルが5つになります。
  - `brain/`、`llm/`、`live/` と同じく、フォルダにまとめたほうが境界が読みやすくなります。
  - いまの lifetime と identity は、どちらも POSIX のプロセスグループの扱いなので、`posix.ts` に1つにまとめます。
- **`speech-runtime.ts` にまとめる理由。**
  - `mlx-runtime.ts` は、次の3つの仕事をしています。
    - uv で Python の環境を作る
    - Hugging Face から固定したリビジョンのモデルを取得する
    - JSON lines の worker を起動して見張る
  - どれも MLX に固有ではありません。MLX 固有なのは、lock ファイル、環境のフォルダの名前、動く条件だけです。
  - CUDA の実行環境が加わると、同じ責務の実装が2つになります。「2つの実装が同じ責務を持ち、中身に意味のある違いがあるときに共通化する」という AGENTS.md の条件を満たすので、実行環境の違いを値として渡す形にまとめます。
- **`local-asr.ts` にまとめる理由。**
  - `asr.ts` は、もともと `mlx-asr.ts` を包む薄い層です。
  - `mlx-asr-transcriptions.ts` の順番待ちと時間切れの処理は、MLX に依りません。
  - Windows の worker も同じやりとり(WAV のパスと言語を受け取り、文字を返す)にします。そうすれば、違うのは worker のスクリプトとモデルだけになります。
- **`resources/native/macos/` と `windows/` に分ける理由。**
  - Swift のソースとビルドしたバイナリが `resources/native/` の直下に並んでいて、Windows の C のソースを足すと、どれがどの OS のものか分からなくなります。
  - アプリに入れるときの名前(`asist-mic`、`asist-calendar`、`asist-agent-launcher.exe`)は変えません。
- **`scripts/prepare-resources.mjs` にする理由。**
  - いまの `.sh` は、Windows の `cmd.exe` では動きません。Git Bash では動きますが、何もせずに成功します。
  - Node にすれば、1つの入口で OS と CPU を見て、対応していない組み合わせでは止められます。
  - MinGit と uv のダウンロードとハッシュの確認は、Mac からでも試せます。
