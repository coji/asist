# 開発

Electron、React、TypeScript、electron-vite、Vitest を使っています。開発のときの決まりは [AGENTS.md](../AGENTS.md) に、文字列をどこに書くかは [ui-text skill](../skills/ui-text/SKILL.md) に、設計の判断とその理由は [docs/adr](adr/) にあります。

```bash
npm run typecheck
npm test
npm run build
```

`npm test` は、最初に同梱用の git を用意し(macOS ではコンパイルし、Windows では MinGit を取得します)、テストが使う Electron を取得します。

## Windows で clone する

Windows 対応はまだ途中です。計画と進み具合は [docs/windows](windows/) と issue #48 にあります。Windows で作業するときは、clone の前に、次のことを済ませます。

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

Node.js、npm、Xcode Command Line Tools が要ります。マイクとカレンダーのネイティブのヘルパーと git をコンパイルし、uv を取得して、アプリに同梱します。

```bash
npm install
npm run dev
```

Windows 11(x64)では、Node.js 22、上の「Windows で clone する」のとおりに設定した Git for Windows、Visual Studio の「C++ によるデスクトップ開発」が要ります。Visual Studio は Build Tools だけでもかまいません。準備のスクリプトは、git の代わりに MinGit を取得し、エージェントの CLI を動かす `asist-agent-launcher.exe` を、`vswhere` で見つけた Visual Studio の `cl.exe` でコンパイルします。Visual Studio Community 2017 と、CI(windows-latest)の Visual Studio 2026 で確かめました。コマンドは macOS と同じです。アプリは、設定と記憶を `%APPDATA%\asist` に、ログを `%APPDATA%\asist\logs` に書きます。Windows は、スタートメニューのショートカットと同じ AppUserModelID を持つアプリの通知しか出しません。`npm run dev` のアプリにはショートカットが無いので、通知はインストールしたアプリで確かめます。

起動時の環境変数は、親プロセスの環境変数、実行ディレクトリの `.env` の順に優先します。Finder や Dock から開いたアプリは `/` で起動するので、実行ディレクトリの `.env` を読むのは、`npm run dev` のようにリポジトリから起動したときだけです。

API キーは、環境変数(実行ディレクトリの `.env` を含む)にあればそれを使い、なければ設定で保存したキーを使います。環境変数にある provider のキーは、設定では保存できません。設定で保存したキーは、Electron の safeStorage で macOS のキーチェーンの鍵を使って暗号化し、平文では書きません。暗号化が使えないときは保存せず、エラーにします。開発版とインストールしたアプリでは鍵が違うので、一方で保存したキーはもう一方では読めません。読めないときはエラーになるので、設定で入れ直します。

地図のカードには、Google の Maps Embed API のキーが要ります。キーはビルドのときに埋め込みます。Google Cloud で Maps Embed API を有効にしてキーを作り、リポジトリ直下の `.env` に書いてから `npm run dev` や `npm run dist:mac` を実行します。

```bash
RENDERER_VITE_GOOGLE_MAPS_EMBED_KEY=...
```

このキーは iframe の URL に載るので、配布したアプリから取り出せます。キーの「API の制限」で Maps Embed API だけを許可し、同じプロジェクトでほかの有料の API を有効にしないでください。本番のアプリは `file://` から開くので Referer が送られず、ウェブサイトによる制限は使えません。Google の規約で地図の帰属表示を変えられないため、カードの地図には色のフィルターをかけていません。

## CI

GitHub Actions(`.github/workflows/ci.yml`)が、main への push と pull request のたびに、次の job を同時に動かします。アプリの job は、Apple Silicon の macOS と x64 の Windows で動きます。

| job | 確かめること |
| --- | --- |
| `test` | `npm run typecheck`、`npm run i18n -- check`、`npm test` |
| `fit` | `npm run demo:fit`。11 の言語とすべてのテーマで、カードと画面の文字が収まっていること。テーマを 2 台に分けて(`--shard 1/2` と `2/2`)同時に調べます |
| `build` | `npm run dist:mac:unsigned` でネイティブのヘルパー、git、uv を含めて署名なしのアプリまで作り、アプリの中の git と uv が動くこと |
| `test-windows` | Windows で `npm run typecheck` と `npm test`。辞書は OS に依らないので、`test` だけで確かめます |
| `build-windows` | `npm run dist:win:dir` で Windows のアプリを作り、アプリの中の git、uv、`asist-agent-launcher.exe` が動くこと、`ASIST.exe` が ASAR の検査を通って起動すること |
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
| `npm run demo:fit` | 全言語で、カードと画面の文言が収まるかを調べます。20 秒ほどかかります。 |

実際のサービスを使うセルフテストは、API キーと音声のサービスを用意し、ビルドのあとに実行します。

```bash
ASIST_SELFTEST=1 npx electron .
```

## 同梱している素材の作り直し

- **Qwen3-TTS の相槌の音声。** アプリは実行時に合成せず、`resources/aizuchi/qwen3tts/<声>/` に同梱したものを使います。Qwen3-TTS は、短い一言だけを読ませると数秒しゃべり続けることがあるためです。相槌の文言(`src/shared/aizuchi-bank.ts`)を変えたときや、声を足したときは、`node scripts/aizuchi-clips/build.mjs <声> <確認用の HTML の出力先>` で作り直します。スクリプトは、相槌を続きの文の前に付けて何度か読ませ、forced aligner で相槌の区間を切り出し、音声認識で文言を確かめて、いちばん良い候補を書き出します。アプリが準備した MLX の実行環境と、Qwen3-TTS、Qwen3-ASR、Qwen3-ForcedAligner のモデルが要ります。出力された HTML で全部を聞いて確かめてから、コミットします。
- **live の声の見本。** `npm run gen:live-voices` が、provider の TTS に同じ文を読ませて `src/renderer/src/assets/live-voices/` に置きます。
- **アイコン。** 元の画像と生成プロンプトは `resources/artwork/` にあり、`python3 scripts/gen-icon.py` で作り直せます(Pillow が要ります)。
- **天気の画像。** 47 都道府県の風景と 5 種類の空模様を、別々の画像として重ねています。生成プロンプトは `src/renderer/src/assets/weather/` の各 `prompts.json` にあり、`python3 scripts/check-weather-alpha.py` で PNG のアルファを検査します。取得と対応表の更新は[天気の仕様](../src/main/services/weather/SPEC.md)にあります。
- **macOS の許可のダイアログの文。** `scripts/macos/permission-texts.mjs` が、ビルドの前に 11 言語分を書き出します。macOS は、アプリの設定ではなく、システムの言語でこの文を選びます。

## サイトと紹介動画

紹介ページとドキュメントは [website/](../website/) にあり、https://asist-agent.com で公開しています。Astro と Starlight で作る、アプリとは別の npm のプロジェクトです。YouTube と X に投稿する紹介動画とそのサムネイルは [promotions/launch-video/](../promotions/launch-video/) にあります。どちらもアプリには含まれません。

```bash
npm --prefix website install # サイトの依存を入れます(最初に一度だけ)
npm run website              # http://localhost:5194 で開きます
npm run website:build        # website/dist に書き出し、全ページのリンクと画像を確かめます
npm run website:deploy       # asist-agent.com に公開します(main から)
npm run promo:video          # 紹介動画を promotions/launch-video/out/asist-launch-video.mp4 に作ります
npm run promo:thumbnail      # YouTube のサムネイルを promotions/launch-video/out/youtube-thumbnail.png に作ります
```

ドキュメントを書く場所、訳し方、公開の手順は [website のスキル](../skills/website/SKILL.md)にあります。

## macOS のアプリをビルドする

署名の証明書を指定して実行します。アプリは `dist/` に出ます。

```bash
CSC_NAME="Apple Development: ..." npm run dist:mac
```

証明書は、Team ID を持つもの(Apple Development か Developer ID Application)を指定します。アプリはライブラリの検証を有効にしているので、自己署名の証明書で署名すると、アプリ本体と Electron Framework の Team ID が一致せず、起動した直後に終了します。`CSC_NAME` を省くと electron-builder がキーチェーンから証明書を選ぶので、自己署名の証明書があるときは必ず指定します。

`npm run build` のあとには `scripts/third-party-notices.mjs` が動き、バンドルに入った npm のパッケージと、app.asar に入る本番用の依存パッケージのライセンスを集めて `build/THIRD_PARTY_NOTICES.txt` に書きます。アプリの `Contents/Resources` には、これと ASIST の `LICENSE.txt`、Electron と Chromium のライセンスが入り、「このアプリについて」から開けます。ライセンスを書いていないパッケージがあると、ビルドはそこで止まります。

署名なしでビルドするには `npm run dist:mac:unsigned` を使います。署名なしでは、マイクの許可が再起動のあとに残らないことがあるので、音声の実機確認には署名付きのアプリを使います。配布の前には `npm audit --omit=dev` で依存関係も確かめます。

ビルドしたアプリは、Electron の fuse(`electron-builder.yml` の `electronFuses`)で `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、`--inspect` を受け付けず、`app.asar` 以外からアプリのコードを読み込まず、`app.asar` の中身が変わっていれば起動しません。どれも、ほかのプロセスが ASIST の署名のまま、ユーザーが許可したマイクやカレンダーを使うことを防ぐためです。ビルドのあとに `npx @electron/fuses read --app dist/mac-arm64/ASIST.app` で値を確かめられます。`--remote-debugging-port` は fuse では止まらないので、CDP でアプリを動かすときだけ付けて起動します。

開発機の `/Applications` に入れて確かめるまでの手順は、[インストールの手順](../skills/install-mac-app/SKILL.md)にあります。

## Windows のアプリをビルドする

Windows 11 の x64 のマシンで実行します。準備のスクリプトはビルドするマシンのための git、uv、ネイティブのヘルパーを用意するので、ほかの OS では `npm run build` のあとで止まります。

```powershell
npm run dist:win       # インストーラーを dist\ASIST Setup <版>.exe に作ります
npm run dist:win:dir   # インストールせずに動かせるアプリを dist\win-unpacked に作ります
```

証明書はまだ設定していないので、署名はしません。インストーラーは、管理者の権限を求めずに、使う人ごとに `%LOCALAPPDATA%\Programs\asist` に入れます。Electron の fuse は macOS と同じです。`app.asar` の中身が変わっていれば、`ASIST.exe` は起動してすぐに終了します。`ELECTRON_ENABLE_LOGGING=1` を付けて起動すると、そのときは `Integrity check failed for asar archive` と出ます。

Windows のマシンで、インストールして確かめ、終了するまでの手順は、[Windows のインストールの手順](../skills/install-windows-app/SKILL.md)にあります。

## 実機での確認

挙動を変えたときは、署名付きのアプリと実際のサービスで、関係する項目を確かめます。配布の前にはひととおり行い、使ったコミット、構成、結果を作業の報告に残します。

- **初回セットアップ。** 言語を選ぶと続きの画面がその言語になること、認証、モデルの準備、マイクの許可を確かめます。文字だけの使い方でも会話できることを確かめます。
- **相槌とつなぎ**(日本語)。スピーカーで短い発話と長い発話を試し、相槌、つなぎの一言(相槌のあと、本回答の前に鳴ること)、割り込み、自分の声の拾い直しが起きないことを確かめます。挨拶には相槌が鳴らず、困りごとには共感、「〜だっけ」には短い確認、訂正には詫びの相槌が出ること、HUD に「相槌: 調べ物 98%」のように判定が出ること、「えっとね、昨日の」のような言いかけのあとの間で発話が確定しないことを確かめます。MaAI が有効なら、言い切りが早く確定すること、言い淀みで待ち時間が延びること、読み上げ中の「うん」で読み上げが止まらないことも確かめます。
- **日本語以外の会話。** 会話の言語を英語に、地域をアメリカにして、返事が英語で返ること、天気が Open-Meteo から華氏で出ること、ニュースが英語圏のものになること、相槌分類器と MaAI が止まること、設定の「声」と「モデル」から日本語だけの項目が消えることを確かめます。ほかの設定を 1 つ保存しても、言語と地域が元に戻らないことを確かめます。日本語に戻して、相槌が再び動くことを確かめます。
- **カード。** カードの表示と読み上げが一致し、返事の途中で言い直しても、古い返事やカードが混ざらないことを確かめます。ウィンドウの高さを変えて、カードが 3 つの大きさを切り替えながら下で切れないこと、最小の高さでも収まること、拡大表示で全部が見えることを確かめます。
- **Qwen3-TTS。** 長い返事で、最初の文が全部できあがる前に声が出ること、文と文の間が空きすぎないこと、文ごとの音量がそろっていること、読み上げ中に話しかけると止まること、相槌とつなぎが同じ声で鳴ること、別のエンジンに切り替えると Qwen3-TTS の worker が終わることを確かめます。
- **保存されるもの。** カードを閉じたあとや再起動のあともタイマーが動き、タスク、メモ、会話の履歴が残ることを確かめます。
- **記憶。** 前日の会話を整理し、記憶の取り込み、`instruction.md` が次の会話に載ること、再起動のあとの検索、0 時を過ぎてから起動したときに整理が始まることを確かめます。
- **Agent。** 検証用のフォルダで、会話から頼んだジョブの開始、継続、取り込みのたびに確認画面が出て、キャンセルすると何も始まらないことを確かめます。worktree の差分の取り込みと破棄も確かめます。コミットしていない変更や衝突があるときは、取り込みが止まることを確かめます。取り込み先のブランチの名前が、カードの差分の上と会話からの取り込みの確認画面に出ること、差分を見たあとで同じコミットから作った別のブランチを開くと取り込みが止まることを確かめます。サブモジュールの中でコミットしたジョブは取り込めず、カードに worktree の場所が出て、カードの「捨てる」で確認画面が出ることを確かめます。HEAD がブランチを指していないとき(bisect の途中など)は取り込みが止まり、ジョブのブランチと worktree が残ることを確かめます。Agent の画面で、選んだジョブのログの下に成果物が並び、押すとファイルのカードが開くことを確かめます。成果物の HTML がページとして開き、同じフォルダの CSS と画像が効くこと、ページの中の外部リンクがアプリの中で開かないことを確かめます。
- **常駐。** 通信や音声のサービスが戻ったときの復帰、30 分使ったときの CPU とメモリ、スリープからの復帰、トレイと呼び出しのショートカット(macOS は ⌥Space、Windows は Alt+Shift+Space)、完全に終了したあとに子プロセスが残らないことを確かめます。
- **カレンダー。** 許可、拒否、再許可、表示するカレンダーと保存先の選択、再起動のあとも設定が残ることを確かめます。検証用の予定で追加、変更、削除を試し、キャンセルで何も変わらないこと、Google にも反映されることを確かめます。月の表示で日をまたぐ終日の予定が 1 本の帯になること、週の表示で重なる予定が左右に分かれ、現在時刻の線が今日に出ることを確かめます。
- **メール。** Gmail のアプリパスワードでアカウントを足し、受信箱の取り込み、IDLE での新着、再起動のあとの接続を確かめます。検証用のメールで「未読メールある?」「読んで」「返信して」を試し、返信が下書きのカードになり、「捨てる」で送らないこと、「送信」で相手に届いて送信済みに残ること、アーカイブとゴミ箱が確認画面を通ってサーバーにも反映されることを確かめます。メールの画面で、箱の切り替え、検索、スレッドの表示、作成からの送信と下書きの保存、まとめて既読にする操作を確かめます。
- **マイクの許可。** 署名付きのアプリを 2 回再起動して、許可が残り、ネイティブのマイクが動くことを確かめます。音声認識、読み上げ、Agent の CLI が無い構成でも、設定の方法や失敗の理由が表示されることを確かめます。
- **live のエンジン。** GPT-Live と Gemini Live をそれぞれ選び、話し始めでセッションが開くこと、返事が provider の声で鳴ること、天気や予定でカードが出ること、読み上げ中に話しかけると止まること、文字の入力に答えること、会話が止まると設定の秒数で閉じて次の声で開き直すこと、マイクを OFF にするとセッションが閉じることを確かめます。Gemini Live では会話ログに転写が残ること、GPT-Live では会話のモデルの返事が画面に出て、会話ログにも一度だけ残ることも確かめます。

## 実装を読む

| 場所 | 役割 |
|---|---|
| [src/main/](../src/main/) | 外部のサービス、保存、音声の worker、Agent の実行 |
| [src/main/services/brain/](../src/main/services/brain/) | 会話のループ、プロンプト、ツール、履歴、話す先の組み立て |
| [src/main/services/llm/](../src/main/services/llm/) | 会話のモデルの呼び出し。provider ごとの adapter が、provider に依らない会話の型([conversation.ts](../src/shared/conversation.ts))と、それぞれの API の形を変換します。 |
| [src/main/services/live/](../src/main/services/live/) | GPT-Live と Gemini Live のエンジン |
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
| 同梱する相槌の音声の切り出しと検証 | Qwen3-ForcedAligner 0.6B 4bit(`mlx-community/Qwen3-ForcedAligner-0.6B-4bit`、Apache-2.0)、Qwen3-ASR、Qwen3-TTS |
| 同梱する live の声の見本 | OpenAI の `gpt-4o-mini-tts`(TTS に無い声は `gpt-live-1` のセッションから録音)、Google の `gemini-2.5-flash-preview-tts` |
| アイコン、天気の風景と空模様の画像 | 画像生成のモデル。プロンプトは `resources/artwork/` と `src/renderer/src/assets/weather/` にあります。 |
