# 開発

Electron、React、TypeScript、electron-vite、Vitest を使っています。開発のときの決まりは [AGENTS.md](../AGENTS.md) に、文字列をどこに書くかは [ui-text skill](../skills/ui-text/SKILL.md) に、設計の判断とその理由は [docs/adr](adr/) にあります。

```bash
npm run typecheck
npm test
npm run build
```

`npm test` は、最初に同梱用の git を用意し(macOS ではコンパイルし、Windows では MinGit を取得します)、同梱用の uv とテストが使う Electron を取得します。

記憶の整理の確認のスクリプト(`resources/skills/` の Python)のテストは、整理の Agent と同じく同梱の uv で `uv run --no-project` として動かし、そのコンピュータにある Python を使います。uv に Python を取得させないので、Python が見つからなければテストは失敗します。CI の `test` と `test-windows` は、下の Python 3.12 を使います。

`tests/vap-worker.test.ts` は MaAI のワーカー(`resources/vap_worker.py`)を実際に動かすので、numpy の入った Python を使います。環境変数 `ASIST_VAP_PYTHON` があればその Python を、なければ PATH の `python3` か `python` を使います。手元で見つからないときはこのテストを飛ばし、CI で見つからないときは失敗にします。CI の `test` と `test-windows` は、アプリの環境と同じ Python 3.12 と numpy 2.5.2 を入れてから `npm test` を実行します。

## Windows で clone する

Windows 11(x64)で作業するときは、clone の前に、次のことを済ませます。

- 「設定」→「システム」→「開発者向け」で、開発者モードを有効にします。
- Git for Windows で、シンボリックリンクと長いパスを有効にします。

```powershell
git config --global core.symlinks true
git config --global core.longpaths true
git clone git@github.com:nyosegawa/asist.git
```

`.claude/skills` と `.agents/skills` は `skills/` へのシンボリックリンクです。開発者モードと `core.symlinks=true` のどちらかが欠けると、2つとも `../skills` と書かれたテキストファイルになり、Claude Code と Codex はスキルを1つも読めません。`dir .claude` で `<SYMLINKD>` と出れば、リンクになっています。テキストファイルになっていたら、開発者モードを有効にして `git config core.symlinks true` を実行し、`git checkout -- .claude/skills .agents/skills` で作り直します。

改行は、リポジトリの `.gitattributes` で、どの OS でも LF にそろえます。Git for Windows の改行の設定(`core.autocrlf`)を変える必要はありません。

## ソースから起動する

Node.js、npm、Xcode Command Line Tools が要ります。マイクのネイティブのヘルパーと git をコンパイルし、uv を取得して、アプリに同梱します。

```bash
npm install
npm run dev
```

Windows 11(x64)では、Node.js 22、上の「Windows で clone する」のとおりに設定した Git for Windows、Visual Studio の「C++ によるデスクトップ開発」が要ります。Visual Studio は Build Tools だけでもかまいません。準備のスクリプトは、git の代わりに MinGit を取得し、エージェントの CLI を動かす `asist-agent-launcher.exe` と、マイクを Windows のエコーキャンセルを通して取り込む `asist-mic.exe` を、`vswhere` で見つけた Visual Studio の `cl.exe` でコンパイルします。Visual Studio Community 2017 と、CI(windows-latest)の Visual Studio 2026 で確かめました。コマンドは macOS と同じです。アプリは、設定と記憶を `%APPDATA%\asist` に、ログを `%APPDATA%\asist\logs` に書きます。Windows は、スタートメニューのショートカットと同じ AppUserModelID を持つアプリの通知しか出しません。`npm run dev` のアプリにはショートカットが無いので、通知はインストールしたアプリで確かめます。

Windows では、npm のスクリプトは `cmd.exe` で動き、Claude Code の Bash のツールは Git Bash で動きます。Python は入れません。同梱した uv が、決まったバージョンの Python を取得します。Windows のマシンで ASIST の動きまで確かめるときは、次のものも入れておきます。

- **GPU のドライバー。** ローカルの音声認識と Qwen3-TTS は Vulkan で動き、単体の GPU が要ります。`resources\speech-worker\speech-worker.exe --devices` で、ASIST が見る GPU の名前、種類、メモリを確かめます。GPU のドライバーを更新したあとの最初の起動では、Vulkan のシェーダーを組み立てるので、準備に数十秒かかります。
- **Claude Code。** 公式のネイティブのインストーラー(`irm https://claude.ai/install.ps1 | iex`)で入れ、入った `%USERPROFILE%\.local\bin` を利用者の PATH に足します。npm で入れた claude は `.cmd` しか無いので ASIST からは起動できず、残っているとターミナルでも先に見つかるので、`npm uninstall -g @anthropic-ai/claude-code` で消します。`Get-Command claude -All` にネイティブのものだけが出ることを確かめます。
- **Codex CLI。** PowerShell 7(`winget install --id Microsoft.PowerShell --exact`)を入れ、そこから公式のインストーラー(`irm https://chatgpt.com/codex/install.ps1 | iex`)で入れます。`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` に入ります。2026-09-27 には、Windows に最初からある PowerShell 5.1 ではインストーラーが `OSArchitecture` を読めずに止まり、winget の `OpenAI.Codex`(0.157.1)はリンクから起動されると `the CLI package does not match this platform or executable` で止まりました。入れたら、ターミナルで `codex` を一度起動して、Windows の sandbox を準備します。準備が済むまで、ASIST は codex のジョブを始めません。
- **GitHub CLI。** `gh auth login` で、git の方式に SSH を選び、ブラウザで認証します。SSH の鍵だけでは gh の API を使えません。
- **Google Chrome。** `scripts/cdp` の撮影と計測に使います。

`npm run dev` のようにパッケージにしていないアプリは、起動したときの実行ディレクトリの `.env` を読みます。親プロセスから受け取った環境変数は、`.env` より優先されます。パッケージにしたアプリは、どこから起動しても `.env` を読みません。環境変数に `ELECTRON_RENDERER_URL` があっても、パッケージの中のページを開きます。

API キーは、環境変数(パッケージにしていないアプリでは、実行ディレクトリの `.env` を含む)にあればそれを使い、なければ設定で保存したキーを使います。環境変数にある provider のキーは、設定では保存できません。設定で保存したキーは、Electron の safeStorage で暗号化し、平文では書きません。暗号化の鍵は、macOS ではキーチェーンに、Windows では DPAPI で守って userData の `Local State` に置かれます。暗号化が使えないときは保存せず、エラーにします。macOS では、開発版とインストールしたアプリで鍵が違うので、一方で保存したキーはもう一方では読めません。読めないときはエラーになるので、設定で入れ直します。Windows では、開発版とインストールしたアプリが同じ userData と同じ鍵を使うので、一方で保存したキーをもう一方でも読めます。

地図のカードには、Google の Maps Embed API のキーが要ります。キーはビルドのときに埋め込みます。Google Cloud で Maps Embed API を有効にしてキーを作り、リポジトリ直下の `.env` に書いてから `npm run dev` や `npm run dist:mac` を実行します。

```bash
RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY=...
```

このキーは iframe の URL に載るので、配布したアプリから取り出せます。キーの「API の制限」で Maps Embed API だけを許可し、同じプロジェクトでほかの有料の API を有効にしないでください。本番のアプリは `file://` から開くので Referer が送られず、ウェブサイトによる制限は使えません。Google の規約で地図の帰属表示を変えられないため、カードの地図には色のフィルターをかけていません。

### Google カレンダーにつなぐ

カレンダーは、macOS でも Windows でも Google Calendar API で読み書きします。ログインに使う OAuth のクライアントは、ビルドのときにアプリへ埋め込みます。リポジトリから動かすときは、Google Cloud のプロジェクト(issue #81 の手順で作ったもの)のデスクトップ アプリのクライアントの値を、リポジトリ直下の `.env` に書きます。

```bash
ASIST_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
ASIST_GOOGLE_CLIENT_SECRET=...
```

`npm run dev` で起動し、設定の「カレンダーとメール」の「カレンダー」で「Google でログイン」を押します。ブラウザで同意の画面が開くので、権限の 2 つの項目の両方にチェックを入れます。ログインしたら、カレンダー連携をオンにし、表示するカレンダーと新規予定の保存先を選びます。

クライアント ID とシークレットは、`electron.vite.config.ts` がビルドのときに main プロセスへ埋め込みます。`npm run dev` では起動するときの `.env` を、`npm run dist:mac` などでは実行したシェルの環境変数か `.env` を読みます。CI では、アプリを作る `build` と `build-windows` の job にだけ、リポジトリの secret から同じ名前で渡します。クライアントがないままビルドしたアプリも起動し、カレンダーの画面も出ますが、カレンダーを最初に使ったとき(設定のカレンダーの項目を開いたときなど)に、クライアントがないことを伝えるエラーになります。配布するアプリは、`npm run release` と Windows のリリースのワークフローが、クライアントがあることを確かめてからビルドします。

ログインの refresh token は、API キーと同じく safeStorage で暗号化して `userData/google-calendar.json` に保存します。macOS では、開発版とインストールしたアプリで鍵が違うので、一方でログインしたものはもう一方では読めません。設定には読めないことが出るので、ログインし直すか、ログアウトします。

## CI

GitHub Actions(`.github/workflows/ci.yml`)が、main への push と pull request のたびに、次の job を同時に動かします。アプリの job は、Apple Silicon の macOS と x64 の Windows で動きます。

| job | 確かめること |
| --- | --- |
| `test` | `npm run typecheck`、`npm run i18n -- check`、`npm test`、そのあとに `npm run demo:viewer-budgets -- --time-factor 3`。最後のものは、ファイルのカードの各ビューアーが大きなファイルを決めた時間とメモリの中で表示できることを確かめます。共有の runner は遅いので、時間だけを 3 倍まで許します。macOS の runner をもう 1 台使わないように、この job の中で動かします |
| `fit` | `npm run demo:fit`。11 の言語とすべてのテーマで、カードと画面の文字が収まっていること。テーマを 2 台に分けて(`--shard 1/2` と `2/2`)同時に調べます |
| `build` | `npm run dist:mac:unsigned` でネイティブのヘルパー、git、uv を含めて署名なしのアプリまで作り、アプリの中の git と uv が動くこと |
| `test-windows` | Windows で `npm run typecheck` と `npm test`。辞書は OS に依らないので、`test` だけで確かめます |
| `build-windows` | `npm run dist:win:dir` で Windows のアプリを作り、アプリの中の git、uv、`asist-agent-launcher.exe`、`asist-mic.exe` が動くこと、`ASIST.exe` が ASAR の検査を通って起動すること |
| `website` | Ubuntu でサイト(`website/`)をビルドし、全ページのリンクと画像の行き先 |
| `result` | ほかの job に、失敗したものも取り消されたものもないこと |

main の ruleset がマージの条件にしているのは `result` だけです。`website/` の中だけを変えたときは、アプリの job をスキップします。スキップした job は失敗として数えないので、プルリクエストはそのままマージできます。

プルリクエストに新しいコミットを push すると、前のコミットでまだ動いている実行は取り消します。main への push は取り消さず、続けてマージしてもコミットごとに最後まで確かめます。失敗したときに、どのコミットで壊れたかがわかるようにするためです。

CodeQL(`.github/workflows/codeql.yml`)は、main への push のたびと毎週 1 回、アプリに入る部分の JavaScript/TypeScript、Python、Actions を解析します。プルリクエストでは動きません。開発のときだけ使う `scripts/`、`tests/`、`website/`、`promotions/`、`skills/` は、解析の対象から外しています(`.github/codeql/codeql-config.yml`)。

同梱する git と uv は、それを用意する `scripts/resources/` の git と uv のモジュールの内容をキーにしてキャッシュします。`VERSION` のファイルにはそのモジュールのハッシュを記録していて、準備のスクリプトは中身が合えば、キャッシュから戻したものをそのまま使います。`npm audit --omit=dev` は、main への push のたびと、毎週火曜の朝 6 時(日本時間)に別のジョブで動きます。依存関係の脆弱性は、コードを変えなくても後から公開されるからです。署名付きのビルドと公証は、まだ CI に入れていません。

## 画面をブラウザで確かめる

画面だけを確かめるときは、Electron を起動せずに demo を配信します。本体のコンポーネントに固定のデータ(`src/renderer/src/demo/fixtures/`)を流して見ます。

```bash
npm run demo
```

| URL | 見えるもの |
|---|---|
| `http://localhost:5174/` | 見本の一覧のついたフレーム。左で画面やカードを選び、上で言語とウィンドウの大きさを選びます。 |
| `/screens/setup?size=l` | 初回セットアップを、本体のウィンドウの大きさ(l / m / s)で見ます。`calendar`、`settings/voice`、`boot/error` なども同じです。名前は `src/renderer/src/demo/screens.ts` にあります。 |
| `/cards/files-pdf` | カードの見本 1 件を s / m / l / focus で並べて見ます。`/cards` で全部です。 |
| `/app?say=ドル円のレートを教えて` | フレームのないアプリ。文字で話しかけて使います。`say=` の文と、出るカードの対応は `src/renderer/src/demo/sayings.ts` にあります。 |
| `/i18n?group=settingsVoice` | 画面の文言の一覧。`?q=` で絞り込み、`?langs=ja-JP,en-US` で言語を選びます。 |

どの URL にも `?lang=de-DE` のように言語を付けられます。フレームの URL に `/preview` を付けたものが枠の中身で、撮影のスクリプトはここを直接開きます。

見た目の確認と計測は、headless Chrome を CDP で動かす `scripts/cdp/` のスクリプトで行います。スクリプトは実行のたびに、置かれている作業ツリーの demo と Chrome を、OS が選んだ空いているポートで自分で起動し、終わると閉じます。先に `npm run demo` を起動しておく必要はなく、worktree ごとに同時に動かしてもぶつかりません。手順は[見た目のデバッグ](../skills/visual-debugging/SKILL.md)に、カードの設計は[パネルカードの手順](../skills/panel-card-design/SKILL.md)にあります。

| コマンド | すること |
|---|---|
| `npm run demo:drive -- --launch <手順>` | 手順を並べて操作、計測、撮影します。`--port 9222` にすると、[インストールの手順](../skills/install-mac-app/SKILL.md)の `--launch --cdp` で起動したアプリ本体にも同じ手順を使えます。 |
| `npm run demo:open` | demo と Chrome を開いたままにし、Chrome のポートを表示します。画面を直しながら `demo:drive -- --port <そのポート>` で何度も測るときに使います。 |
| `npm run demo:cards`、`npm run demo:gallery` | カードを 3 つの大きさで撮ります。一覧を 1 枚に撮ります。 |
| `npm run demo:setup` | 初回セットアップを最初から最後まで歩いて撮ります。 |
| `npm run demo:docs-shots` | README とドキュメントに載せる画面を、日本語と英語で `website/public/screens/` に撮り直します。 |
| `npm run demo:fit` | 全言語で、カードと画面の文言が収まるかを調べます。1 分ほどかかります。 |
| `npm run demo:viewer-budgets` | 大きな PDF、Office のファイル、音声などを一時フォルダに作り、ファイルのカードとその拡大表示で開いて最後までスクロールし、表示までの時間、メイン スレッドが止まった最長の時間、レンダラーのメモリを測ります。`scripts/cdp/scenes/viewer-budgets/` の case に書いた上限を超えると終了コード 2 で終わります。ビューアーが中身の代わりにエラーや「大きすぎる」の表示を出したとき、拡大表示をスクロールした先の中身が出てこないとき、ページかその中のフレームが落ちたときも失敗です。`--measure all` は上限なしで全部のファイルを測ります。メモリは `ps` で読むので、Windows では測れずにエラーで止まります。MP3 を作るには `lame` が、m4a を作るには macOS の `afconvert` が要ります。 |

実際のサービスを使うセルフテストは、API キーと音声のサービスを用意し、ビルドのあとに実行します。

```bash
ASIST_SELFTEST=1 npx electron .
```

## 同梱している素材の作り直し

- **Irodori-TTS と Qwen3-TTS の相槌の音声。** アプリは実行時に合成せず、`resources/aizuchi/<エンジン>/<声>/` に同梱したものを使います。どの相槌も、音声認識と耳で確かめてから入れるためです。相槌の文言(`src/shared/aizuchi-bank.ts`)を変えたときや、声を足したときは、`node scripts/aizuchi-clips/build.mjs <irodori か qwen3tts> <声> [候補の数] [文…]` で作ります。Qwen3-TTS は短い一言だけを読ませると数秒しゃべり続けることがあるので、スクリプトは相槌を続きの文の前に付けて何度か読ませ、続きの文が音声認識でそのまま聞こえる間で相槌を切り出します。Irodori-TTS は相槌を単独で読ませ、前後の無音と最後の短い雑音を詰めます。どちらも、相槌の文言を音声認識で確かめて、いちばん典型的な長さの候補をクリップにし、上位の候補を `.aizuchi-candidates/`(Git の対象外)に残します。合格の印(manifest の `reviewed`)が付いた相槌は、文を名指ししない限り作り直しません。読み上げと音声認識には、同梱する speech-worker と llama-server(`node scripts/prepare-resources.mjs dev`)を使い、アプリで準備した Irodori-TTS か Qwen3-TTS 0.6B と、Qwen3-ASR 1.7B のファイルを読みます。ほかの場所にあるファイルを使うときは、`ASIST_SPEECH_MODELS` でそのフォルダを指定します。相槌は 0.6B で作り、読み上げを 1.7B にしたときも同じものを鳴らします。
  - 作ったら、`npm run demo` の http://localhost:5174/aizuchi で全部を聞いて決めます。候補から選んで「合格」にすると、そのクリップに合格の印が付きます。「だめ」にした相槌は、左の「だめな N 件を作り直す」で作り直せます。全部が合格になってから、コミットします。
- **Irodori-TTS の声。** `resources/irodori-voices/<声>.voice.gguf` は、speech-bench が作った参照の音声(`~/speech-bench-data/references/voice-<声>.wav`)を、speech.cpp の tools の `irodori-tts --make-voice` で CPU を使って変換したものです。声のファイルはコーデックの版を名指しするので、Irodori-TTS のコーデックの固定を変えたときは `node scripts/irodori-voices.mjs [参照のフォルダ]` で作り直します。スクリプトは、固定した版の tools を取得し、アプリで準備した Irodori-TTS のファイル(または `ASIST_SPEECH_MODELS` のフォルダ)を読みます。声を足すときは、短い相槌でも言葉を足さないかを確かめてから選びます(理由は ADR 0031)。
- **live の声の見本。** `npm run gen:live-voices` が、provider の TTS に同じ文を読ませて `src/renderer/src/assets/live-voices/` に置きます。
- **Irodori-TTS と Qwen3-TTS の声の見本。** `node scripts/gen-tts-voices.mjs` が、まだない見本を作り、`src/renderer/src/assets/tts-voices/<エンジン>/<言語>/<声>.mp3` に置きます。Irodori-TTS は日本語だけ、Qwen3-TTS は会話の言語になる 8 つの言語で、文は `src/shared/voice-samples.ts` にあります。音声認識で文のとおりに聞こえた読みだけを使います。相槌と同じく、同梱する speech-worker と llama-server、アプリで準備したモデルを使います。エンジン、言語、声を引数に渡すと、その分だけを作り直します。
- **アイコン。** 元の画像と生成プロンプトは `resources/artwork/` にあり、`python3 scripts/gen-icon.py` で作り直せます(Pillow が要ります)。
- **天気の画像。** 47 都道府県の風景と 5 種類の空模様を、別々の画像として重ねています。生成プロンプトは `src/renderer/src/assets/weather/` の各 `prompts.json` にあり、`python3 scripts/check-weather-alpha.py` で PNG のアルファを検査します。取得と対応表の更新は[天気の仕様](../src/main/services/weather/SPEC.md)にあります。
- **macOS の許可のダイアログの文。** `scripts/macos/permission-texts.mjs` が、ビルドの前に 11 言語分を書き出します。macOS は、アプリの設定ではなく、システムの言語でこの文を選びます。

## サイトと紹介動画

紹介ページとドキュメントは [website/](../website/) にあり、https://asist-agent.com で公開しています。Astro と Starlight で作る、アプリとは別の npm のプロジェクトです。YouTube と X に投稿する紹介動画とそのサムネイルは [promotions/launch-video/](../promotions/launch-video/) にあります。どちらもアプリには含まれません。

```bash
npm --prefix website install # サイトの依存を入れます(最初に一度だけ)
npm run website              # http://localhost:5194 で開きます
npm --prefix website test    # ページを Markdown に変換する処理のテストを実行します
npm run website:build        # website/dist に書き出し、全ページのリンクと画像を確かめます
npm run website:deploy       # asist-agent.com に公開します(main から)
npm run promo:video          # 紹介動画を promotions/launch-video/out/asist-launch-video.mp4 に作ります
npm run promo:thumbnail      # YouTube のサムネイルを promotions/launch-video/out/youtube-thumbnail.png に作ります
```

ドキュメントを書く場所、訳し方、公開の手順は [website のスキル](../skills/website/SKILL.md)にあります。

## macOS のアプリをビルドする

署名の証明書を指定して実行します。アプリは `dist/` に出ます。

```bash
CSC_NAME="<氏名> (<Team ID>)" npm run dist:mac
```

証明書には、配布するバージョンと同じ Developer ID Application を使います。macOS はマイクの許可を署名に結び付けるので、別の証明書で署名したアプリに入れ替えると、許可がやり直しになります。アプリはライブラリの検証を有効にしているので、自己署名の証明書で署名すると、アプリ本体と Electron Framework の Team ID が一致せず、起動した直後に終了します。`CSC_NAME` には、`security find-identity -v -p codesigning` に出る名前から「Developer ID Application: 」を除いた部分を渡します。前置きを付けると electron-builder は止まり、付けなければ Developer ID Application の証明書を自分で選びます。`CSC_NAME` を省くと electron-builder がキーチェーンから証明書を選ぶので、自己署名の証明書があるときは必ず指定します。

このビルドは dmg も zip も作らないので、自動更新の設定(`app-update.yml`)を持たず、リリースから自分を更新しません。

`npm run build` のあとには `scripts/third-party-notices.mjs` が動き、バンドルに入った npm のパッケージと、app.asar に入る本番用の依存パッケージのライセンスを集めて `build/THIRD_PARTY_NOTICES.txt` に書きます。アプリの `Contents/Resources` には、これと ASIST の `LICENSE.txt`、Electron と Chromium のライセンスが入り、「このアプリについて」から開けます。ライセンスを書いていないパッケージがあると、ビルドはそこで止まります。

署名なしでビルドするには `npm run dist:mac:unsigned` を使います。署名なしでは、マイクの許可が再起動のあとに残らないことがあるので、音声の実機確認には署名付きのアプリを使います。配布の前には `npm audit --omit=dev` で依存関係も確かめます。

ビルドしたアプリは、Electron の fuse(`electron-builder.yml` の `electronFuses`)で `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect` を受け付けず、`app.asar` 以外からアプリのコードを読み込まず、`app.asar` の中身が変わっていれば起動しません。どれも、ほかのプロセスが ASIST の署名のまま、ユーザーが許可したマイクを使うことを防ぐためです。ビルドのあとに `npx @electron/fuses read --app dist/mac-arm64/ASIST.app` で値を確かめられます。`--remote-debugging-port` は fuse では止まらないので、CDP でアプリを動かすときだけ付けて起動します。

開発機の `/Applications` に入れて確かめるまでの手順は、[インストールの手順](../skills/install-mac-app/SKILL.md)にあります。

## Windows のアプリをビルドする

Windows 11 の x64 のマシンで実行します。準備のスクリプトはビルドするマシンのための git、uv、ネイティブのヘルパーを用意するので、ほかの OS では `npm run build` のあとで止まります。

```powershell
npm run dist:win       # インストーラーを dist\ASIST-Setup-x64.exe に作ります
npm run dist:win:dir   # インストールせずに動かせるアプリを dist\win-unpacked に作ります
```

証明書はまだ設定していないので、署名はしません。インストーラーは、管理者の権限を求めずに、使う人ごとに `%LOCALAPPDATA%\Programs\asist` に入れます。`electron-builder.yml` は Windows に GitHub の公開の設定を持たせていないので、このインストーラーは自動更新の設定(`app-update.yml`)を持たず、リリースから自分を更新しません。Electron の fuse は macOS と同じです。`app.asar` の中身が変わっていれば、`ASIST.exe` は起動してすぐに終了します。`ELECTRON_ENABLE_LOGGING=1` を付けて起動すると、そのときは `Integrity check failed for asar archive` と出ます。

Windows のマシンで、インストールして確かめ、終了するまでの手順は、[Windows のインストールの手順](../skills/install-windows-app/SKILL.md)にあります。

## リリースする

配布する Mac のアプリはこの Mac で署名と公証をし、Windows のインストーラーは GitHub Actions で署名せずにビルドして、同じ GitHub の Release に置きます。利用者のアプリは、Mac でも Windows でも、起動したときと 6 時間ごとに新しいバージョンを確かめ、裏で取得して、次に終了したときに入れ替えます。「このアプリについて」の「今すぐ再起動」で、すぐに入れ替えることもできます。Windows では、インストーラーが画面を出さずに入れ替え、「今すぐ再起動」のときは入れ替えたあとで ASIST を開きます。Electron の準備ができたあとで起動に失敗したアプリは、エラーを閉じると終了し、更新だけをする起動(`--update-after-failed-start`)をし直します。この起動はウィンドウもサービスも開かずに新しいバージョンを確かめ、あれば取得して入れ替え、ASIST を開きます。

最初に一度だけ、Developer ID Application の証明書をキーチェーンに入れ(Xcode の Settings → Accounts → Manage Certificates)、公証に使う Apple ID を notarytool に保存します。App 用パスワードは account.apple.com で作ります。

```bash
xcrun notarytool store-credentials asist-notary --apple-id <Apple ID> --team-id <Team ID>
```

リリースのたびに、`package.json` の `version` を上げるプルリクエストをマージしてから、main で実行します。

```bash
npm run release
```

`npm run release` は、main が origin/main と同じで変更が無いことと、そのバージョンがまだ出ていないことを確かめます。次に、地図のキーと Google の OAuth クライアント(`RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY`、`ASIST_GOOGLE_CLIENT_ID`、`ASIST_GOOGLE_CLIENT_SECRET`)があることと `npm audit --omit=dev` を確かめてから、dmg と zip をビルドして署名と公証をし、Gatekeeper が受け付けることを確かめます。そのうえで、dmg(`ASIST-arm64.dmg`。名前にバージョンを含めないので、`releases/latest/download/ASIST-arm64.dmg` がいつも最新を指します)、zip、`latest-mac.yml`、同梱した git のソース(`scripts/resources/git-macos.mjs` のバージョンの tarball)を Release に置きます。証明書を選ぶ `CSC_NAME` と、notarytool のプロファイルを選ぶ `APPLE_KEYCHAIN_PROFILE`(省くと `asist-notary`)で、どちらも変えられます。

Mac のファイルを置いた Release は、まだ下書きのままです。`npm run release` は次に、`.github/workflows/windows-release.yml` をタグとコミットを渡して動かし、`gh run watch --exit-status` で終わるのを待ちます。このワークフローは、まず Release が下書きで、そのコミットから作ったものであることを確かめます。次に windows-latest で、`package.json` のバージョンがタグと同じであることを確かめ、リポジトリの Secrets にある地図のキーと Google の OAuth クライアント(`RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY`、`ASIST_GOOGLE_CLIENT_ID`、`ASIST_GOOGLE_CLIENT_SECRET`)を入れて NSIS のインストーラーをビルドします。npm とリポジトリのスクリプトはこのビルドの job だけで動かし、その job のトークンには読む権限しか与えません。Release に書き込めるトークンを持つ job は、何も checkout せず、gh だけを動かします。GitHub の公開の設定は、このときだけコマンドラインで渡すので、自動更新の設定(`app-update.yml`)と `latest.yml` を持つのは、このインストーラーだけです。できたインストーラー(`ASIST-Setup-x64.exe`。名前にバージョンを含めないので、`releases/latest/download/ASIST-Setup-x64.exe` がいつも最新を指します)、その blockmap、`latest.yml`、同梱した Git for Windows のソース(`git-for-windows-<バージョン>.tar.gz`)は、Actions の artifact として Release に書き込める job に渡します。その job は、Release がまだ下書きで、同じコミットから作ったものであることをもう一度確かめてから、これらを下書きに置きます。`npm run release` は、下書きに Windows のファイルがすべてそろったことを確かめてから、Release を公開します。ワークフローが失敗したときは、下書きのまま止まり、次にすることを表示します。

出したバージョンに問題があったときは、Release を消したり前のバージョンに戻したりせず、番号を上げて直したバージョンを出します。自動更新は、今のバージョンより新しい番号のバージョンだけを入れるからです。

## 実機での確認

挙動を変えたときは、署名付きのアプリと実際のサービスで、関係する項目を確かめます。配布の前にはひととおり行い、使ったコミット、構成、結果を作業の報告に残します。

- **初回セットアップ。** 言語を選ぶと続きの画面がその言語になること、認証、モデルの準備、マイクの許可を確かめます。文字だけの使い方でも会話できることを確かめます。
- **相槌とつなぎ**(日本語)。スピーカーで短い発話と長い発話を試し、相槌、つなぎの一言(相槌のあと、本回答の前に鳴ること)、割り込み、自分の声の拾い直しが起きないことを確かめます。挨拶には相槌が鳴らず、困りごとには共感、「〜だっけ」には短い確認、訂正には詫びの相槌が出ること、HUD に「相槌: 調べ物 98%」のように判定が出ること、「えっとね、昨日の」のような言いかけのあとの間で発話が確定しないことを確かめます。MaAI が有効なら、言い切りが早く確定すること、言い淀みで待ち時間が延びること、読み上げ中の「うん」で読み上げが止まらないことも確かめます。
- **日本語以外の会話。** 会話の言語を英語に、地域をアメリカにして、返事が英語で返ること、天気が Open-Meteo から華氏で出ること、ニュースが英語圏のものになること、相槌分類器と MaAI が止まること、設定の「声」と「概要」から日本語だけの項目が消えることを確かめます。ほかの設定を 1 つ保存しても、言語と地域が元に戻らないことを確かめます。日本語に戻して、相槌が再び動くことを確かめます。
- **カード。** カードの表示と読み上げが一致し、返事の途中で言い直しても、古い返事やカードが混ざらないことを確かめます。ウィンドウの高さを変えて、カードが 3 つの大きさを切り替えながら下で切れないこと、最小の高さでも収まること、拡大表示で全部が見えることを確かめます。
- **Qwen3-TTS。** 長い返事で、最初の文が全部できあがる前に声が出ること、文と文の間が空きすぎないこと、文ごとの音量がそろっていること、読み上げ中に話しかけると止まること、相槌とつなぎが同じ声で鳴ること、別のエンジンに切り替えると Qwen3-TTS の worker が終わることを確かめます。メモリが 24GB 以上の Mac では、設定の「声」でモデルを 1.7B に替えると、その下の「準備する」で準備したあと新しいモデルで読み上げることを確かめます。
- **保存されるもの。** カードを閉じたあとや再起動のあともタイマーが動き、タスク、メモ、会話の履歴が残ることを確かめます。
- **記憶。** 前日の会話を整理し、記憶の取り込み、`me.md` と `user.md` が次の会話に載ること、整理の Agent がスキルのフォルダの uv で `count.py` と `validate.py` を実行して二つを上限に収めること(Node と自分の Python が無いマシンでも、自分の uv を入れたマシンでも)、以前の版の `instruction.md` が起動時に `me.md` と `user.md` に移ること、再起動のあとの検索、0 時を過ぎてから起動したときに整理が始まることを確かめます。
- **Agent。** 検証用のフォルダで、会話から頼んだジョブの開始、継続、取り込みのたびに確認画面が出て、キャンセルすると何も始まらないことを確かめます。worktree の差分の取り込みと破棄も確かめます。コミットしていない変更や衝突があるときは、取り込みが止まることを確かめます。取り込み先のブランチの名前が、カードの差分の上と会話からの取り込みの確認画面に出ること、差分を見たあとで同じコミットから作った別のブランチを開くと取り込みが止まることを確かめます。サブモジュールの中でコミットしたジョブは取り込めず、カードに worktree の場所が出て、カードの「捨てる」で確認画面が出ることを確かめます。HEAD がブランチを指していないとき(bisect の途中など)は取り込みが止まり、ジョブのブランチと worktree が残ることを確かめます。Agent の画面で、選んだジョブのログの下に成果物が並び、押すとファイルのカードが開くことを確かめます。成果物の HTML がページとして開き、同じフォルダの CSS と画像が効くこと、ページの中の外部リンクがアプリの中で開かないことを確かめます。Finder から開いたアプリで、npm で入れた codex のジョブが動くことと、ジョブを止めるとエージェントが動かしていたコマンドも止まることを確かめます。ターミナルから `open -a` で開いたアプリはターミナルの PATH を受け継ぐので、この確かめにはなりません。
- **常駐。** 通信や音声のサービスが戻ったときの復帰、30 分使ったときの CPU とメモリ、スリープからの復帰、トレイと呼び出しのショートカット(macOS は ⌥Space、Windows は Alt+Shift+Space)、完全に終了したあとに子プロセスが残らないことを確かめます。
- **カレンダー。** Google へのログイン、同意の画面で権限の片方を外したときにログインにならないこと、ログアウトで Google のアカウントの「サードパーティ製のアプリとサービス」から ASIST が消えること、表示するカレンダーと保存先の選択、再起動のあとも設定とログインが残ることを確かめます。検証用の予定で追加、変更、削除を試し、キャンセルで何も変わらないこと、Google カレンダーにも反映されることを確かめます。月の表示で日をまたぐ終日の予定が 1 本の帯になること、週の表示で重なる予定が左右に分かれ、現在時刻の線が今日に出ることを確かめます。
- **メール。** Gmail のアプリパスワードでアカウントを足し、受信箱の取り込み、IDLE での新着、再起動のあとの接続を確かめます。検証用のメールで「未読メールある?」「読んで」「返信して」を試し、返信が下書きのカードになり、「捨てる」で送らないこと、「送信」で相手に届いて送信済みに残ること、アーカイブとゴミ箱が確認画面を通ってサーバーにも反映されることを確かめます。メールの画面で、箱の切り替え、検索、スレッドの表示、作成からの送信と下書きの保存、まとめて既読にする操作を確かめます。
- **起動に失敗したときの更新。** このしくみを持つバージョンを入れ、それより新しいバージョンが Release に出ているときに、Mac と Windows の両方で確かめます。設定を読めない失敗と、サービスの準備の失敗の 2 つを試します。設定を読めない失敗は、設定とデータのフォルダの `settings.json` を別の場所に移し、読めない内容のファイルを代わりに置いて起こします。サービスの準備の失敗は、同じフォルダの `jobs.json` を別の場所に移し、読めない内容のファイルを代わりに置いて起こします。記憶の整理がジョブの履歴を読むところで起動が止まります。どちらでも、起動の失敗が出ているあいだも閉じたあとも、ASIST のウィンドウもトレイのアイコンも出ず、マイクが入らないことを確かめます。メールのアカウントがあるときは、取得のあいだに新着メールの通知が出ないことも確かめます。閉じると更新中の通知が出ることを確かめます。取得のあいだに、Mac では Finder や Dock から、Windows ではスタートメニューから ASIST をもう一度開くと、同じ通知がまた出ることを確かめます。Mac では、取得のあいだ Dock に ASIST のアイコンが出ます。最後に、新しいバージョンに入れ替わって ASIST が開くことを確かめます。Windows では、設定を読めない失敗でも通知が出ることを確かめます。壊したものはそのままなので、新しいバージョンでも起動の失敗が出て、閉じるとそのまま終了します。最後に、移したものを戻します。
- **マイクの許可。** 署名付きのアプリを 2 回再起動して、許可が残り、ネイティブのマイクが動くことを確かめます。音声認識、読み上げ、Agent の CLI が無い構成でも、設定の方法や失敗の理由が表示されることを確かめます。
- **ページの読み込み直し。** 設定の「起動時にマイクをオンにする」をオンにして、起動したときにマイクがオンになることを確かめます。macOS で、マイクがオンのまま ⌘R でページを読み込み直すと、新しいページはこの設定がオンでもマイクがオフで始まり、メニューバーのマイクの表示も消えることを確かめます。Gemini Live を選んでいるときは、そのセッションも閉じることを確かめます。CDP の `Page.crash` で renderer を落とすと、ページが読み込み直され、マイクがオフのまま使えることを確かめます。
- **live のエンジン。** Gemini Live を選び、話し始めでセッションが開くこと、返事が provider の声で鳴ること、天気や予定でカードが出ること、読み上げ中に話しかけると止まること、文字の入力に答えること、会話が止まると設定の秒数で閉じて次の声で開き直すこと、マイクを OFF にするとセッションが閉じること、会話ログに転写が残ることを確かめます。設定の「会話」の「モデル」を Gemini 3.8 Live (extended thinking) に替えて、セッションが開いて返事が鳴ることも確かめます。API が求める設定はモデルごとに違い、片方のモデルで開けても、もう片方で開けるとは限りません。

Windows では、インストーラーで入れたアプリで、上の項目を確かめます。Windows には無い、または Windows だけの動きがあるので、次の項目も確かめます。

- **インストール。** 署名の無いインストーラーで SmartScreen の警告が出て、「詳細情報」から「実行」で入ること、管理者の権限を求めずに `%LOCALAPPDATA%\Programs\asist` に入ること、スタートメニューから起動できることを確かめます。
- **ウィンドウとトレイ。** タイトルバーのボタンがトップバーの右に重なり、テーマを変えるとボタンの色も変わること、最大化と元に戻すでドックの高さが崩れないことを確かめます。トレイのアイコンが出て、メニューから表示、マイクの切り替え、終了ができること、ジョブの完了などの通知が出て、押すとアプリが前に出ることを確かめます。
- **マイク。** Windows の設定でデスクトップ アプリのマイクを拒否すると、理由と設定を開くボタンが出ることを確かめます。起動のログの `native-mic: check:` の行で、そのマシンのマイクのエコーキャンセルが有効と出るかを見ます。有効なら、マイクを入れると `asist-mic: ready:` と出て声が文字になること、マイクを入れているあいだほかの音が小さくならないこと、既定のマイクやスピーカーを替えると取り込みが作り直されることを確かめます。有効でなければ、最初から getUserMedia で取り込み、設定の「声」にエコーキャンセルの切り替えが出ないことを確かめます。どちらの経路でも、スピーカーで VOICEVOX、live のエンジン、システムの声を鳴らし、読み上げ中に自分の声を拾い直さないことを確かめます。
- **ネットワークの共有。** 設定の「見せてよいフォルダ」に `\\サーバー\共有\フォルダ` を書き、そこの PDF と画像がファイルのカードに出ることを確かめます。同じフォルダを割り当てたドライブ(`Z:\フォルダ`)で書いたときも確かめます。
- **聞き取りと Qwen3-TTS。** 単体の GPU があるマシンでは、初回セットアップで Qwen3-ASR と Qwen3-TTS が Vulkan で準備でき、声で会話できること、設定で Qwen3-ASR の 1.7B と 0.6B を切り替えられることを確かめます。タスク マネージャーの「パフォーマンス」で、GPU の専用メモリに収まっていることを確かめます。単体の GPU が無いマシンでは、その理由が出て、ブラウザの中の Whisper か live のエンジンを選べ、Qwen3-TTS が選択肢に出ないことを確かめます。
- **Agent。** claude と codex の両方で、ジョブの開始、停止、アプリを終了したときに CLI とその子プロセスが残らないことを確かめます。codex は Windows の elevated の sandbox でしか動かないので、その準備が済んでいないマシンではジョブが始まらず、準備の方法が出ること、ターミナルで準備したあとは書き込むジョブを取り込めることを確かめます。取り込んだファイルの改行が、リポジトリのもとの改行のままであることを確かめます。

## 実装を読む

| 場所 | 役割 |
|---|---|
| [src/main/](../src/main/) | 外部のサービス、保存、音声の worker、Agent の実行 |
| [src/main/services/brain/](../src/main/services/brain/) | 会話のループ、プロンプト、ツール、履歴、話す先の組み立て |
| [src/main/services/llm/](../src/main/services/llm/) | 会話のモデルの呼び出し。provider ごとの adapter が、provider に依らない会話の型([conversation.ts](../src/shared/conversation.ts))と、それぞれの API の形を変換します。 |
| [src/main/services/live/](../src/main/services/live/) | Gemini Live のエンジン |
| [src/main/services/weather/](../src/main/services/weather/) | 天気。気象庁と Open-Meteo |
| [src/preload/](../src/preload/) | main と画面の間の API。契約は [src/shared/ipc.ts](../src/shared/ipc.ts) にあります。 |
| [src/renderer/](../src/renderer/) | React の画面、マイクの入力、音声の再生、カード |
| [src/shared/](../src/shared/) | プロセスの間で共有する型とロジック。画面の文言の辞書は [i18n/messages/](../src/shared/i18n/messages/) にあります。 |
| [resources/](../resources/) | 音声と検索の worker、[記憶を整理する Agent の手順](../resources/skills/memory-curation/SKILL.md)(日本語以外の会話では[英語の手順](../resources/skills/memory-curation-en/SKILL.md)) |
| [tests/](../tests/) | Vitest のテスト |

カードを足すときは、[カタログ](../src/shared/panel-catalog.ts)にスキーマを定義し、[builtin/](../src/renderer/src/panels/builtin/) に表示を実装して、[registry.tsx](../src/renderer/src/panels/registry.tsx) に登録します。会話のモデルに渡すカード用のツールは、スキーマから作られます。

## 開発のときだけ使うモデル

| 用途 | モデル |
|---|---|
| 同梱する live の声の見本 | Google の `gemini-2.5-flash-preview-tts` |
| アイコン、天気の風景と空模様の画像 | 画像生成のモデル。プロンプトは `resources/artwork/` と `src/renderer/src/assets/weather/` にあります。 |
