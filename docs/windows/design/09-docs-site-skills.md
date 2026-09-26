# ドキュメント、サイト、README、動画、skills、AGENTS.md

アプリのコードのほかにも、「Mac 向けのアプリ」を前提に書いたものが多くあります。AGENTS.md の決まり(利用者に見えることを変えたら、同じ変更で日本語と英語のドキュメントを直す)に従い、どの変更でどれを直すかを決めておきます。

## 公開する時期との関係

- **Windows で使えるようになる前の扱い。** Windows で使えるようになるまで(M6 まで)は、サイトと README に「Windows で使える」とは書きません。
- **開発の途中で直すもの。** 開発の途中で直すのは、開発者向けのものだけです。
  - AGENTS.md
  - `docs/development.md`
  - skills
- **利用者向けのもの。** 利用者向けのもの(サイト、README、ドキュメント)は、M6 でまとめて直します。
  - 例外があります。画面の文言を OS に依らない言い方にした PR(M1 の D)では、ドキュメントに引用している画面の文言も同じ PR で直します。

## README.md と README.ja.md

Mac を前提にした行は、それぞれ6か所あります。

- **1行目の説明。** 「A realtime assistant for the Mac」を、OS に依らない言い方にします。
- **動く環境のバッジ。** macOS 14 以降・Apple Silicon のバッジに、Windows 11 x64 を足します。
- **必要なもの。** 必要なものの段落に、次のことを OS ごとに書きます。
  - Windows でローカルの音声認識を使うには、NVIDIA の GPU(RTX 20 以降、ドライバー 580 以降)が要ること
  - GPU が無くてもブラウザの中の聞き取りと live のエンジンは使えること
- **データの置き場所。** 「Your data stays on your Mac」と「Only on this Mac」を、「this computer」にします。
- **キーの暗号化。** 「macOS のキーチェーンの鍵で暗号化」の行に、Windows では DPAPI を使うことを書きます。守れる範囲の違いは、プライバシーのページへのリンクで示します。

## サイト(asist-agent.com)

### 紹介ページ

- **直す場所の数。** 11言語の `website/src/i18n/landing/*.ts` に、それぞれ8か所あります。
- **直す場所。**
  - 説明と OG の説明の文(`description`、`ogDescription`)
  - 冒頭の文(`leadHtml`)
  - 動く環境の表記(`macos`、`silicon`)。Windows の表記を足します。
  - 最後の呼びかけ(「あなたの Mac に、ASIST を。」)
  - 始め方の手順(`step1`)
- **絵。** 机で Mac に向かうクレイのジオラマ(`artAlt`)は絵なので、そのまま使います。代わりの文(alt)は絵の中身の説明なので、変えません。
- **OG の画像。** `website/og/og.html` の「Mac 向けのリアルタイムアシスタント」を直し、`website/og/render.mjs` で作り直します。
- **ダウンロードの案内。** 紹介ページのダウンロードの案内は、OS ごとに Release のファイルを出し分けます。
- **翻訳。** 11言語すべてを同じ PR で直します(`website` スキル)。

### ドキュメント(日本語と英語)

- **直す場所の数。** Mac を前提にした記述があるのは、それぞれ約20ページです。
- **OS ごとの手順の見せ方。** OS ごとに手順が違うページは、Starlight の `Tabs`(`syncKey="os"`)で Mac と Windows を切り替えられるようにします。
  - 読む人が一度選べば、ほかのページでも同じ OS が選ばれます。
  - タブを使うページは、`.md` を `.mdx` にします。

| ページ | 直すこと |
|---|---|
| `start/install` | Windows のインストーラーの入れ方。署名が無いあいだは、SmartScreen で「詳細情報」→「実行」を押すこと。Smart App Control が有効なマシンでは動かないこと |
| `start/update` | Windows の自動更新。PR #1 の electron-updater は NSIS に対応している |
| `start/setup` | 初回セットアップの違い。聞き取りのモデルの準備で、CUDA の実行環境(約 2 GB)とモデルをダウンロードすること |
| `start/microphone` | Windows の「設定」→「プライバシーとセキュリティ」→「マイク」での許可 |
| `start/calendar`、`apps/calendar` | Windows では使えないこと |
| `start/agent-cli` | claude と codex を Windows で入れる方法。ネイティブのインストーラーで入れること。npm で入れたものは使えないこと |
| `start/safety`、`privacy/index`、`privacy/external` | キーの暗号化の違い(DPAPI)と、守れる範囲 |
| `settings/voice-engine`、`settings/models`、`reference/models` | Windows の聞き取りのモデル(`Qwen/Qwen3-ASR-1.7B-hf`、`0.6B-hf`)と、その入手先とライセンス。GPU の条件 |
| `usage/index` | ショートカットの OS ごとの表記 |
| `apps/notes` | ごみ箱とエクスプローラー |
| `reference/memory` | 記憶のフォルダの場所(`%APPDATA%\asist`) |
| `troubleshooting` | Windows の項目。GPU が見つからない、ドライバーが古い、SmartScreen、Smart App Control、ウイルス対策のソフトが遅くする |

- **画面の写真。** 画面の写真(`website/public/screens/`)は、`npm run demo:docs-shots` が demo(renderer だけ)を撮ったものです。
  - OS の部品は写っていないので、Mac で撮ったものをそのまま使います。
  - 上の帯の左の余白(信号機のボタンの場所)だけは Mac の形です。気になるなら、Windows の形(`data-os="windows"`)でも撮れるようにします。

## 紹介動画(promotions/launch-video)

- **Mac を前提にした文。** `index.html` の2つの場面と、`thumbnail.html` に、Mac を前提にした文があります。
  - 「Mac 向けのリアルタイムアシスタント」
  - 「macOS 14 以降」
  - 「Apple Silicon」
  - 「あなたの Mac に、ASIST を。」
- **どう扱うか。** この動画は、公開のときの紹介として YouTube と X に投稿したものです。作り直して投稿し直すかどうかは、公開の判断なので、別に決めます([06-open-questions.md](../06-open-questions.md))。
- **いまの案。** 公開済みの動画はそのままにします。Windows に対応したときに告知が要るなら、別の短い動画を作ります。

## skills

| スキル | 直すこと | いつ |
|---|---|---|
| `install-mac-app` | 変えない(Mac だけのスキル)。PR #1 が手を入れている | |
| `install-windows-app`(新規) | ビルド、インストール、ログ付きの起動、CDP での確認、終了。Windows の userData とログの場所、`taskkill` ではなく CDP か終了のメニューで終わらせること | M3-9 |
| `pull-request` | 説明の「installing the app on this Mac (install-mac-app)」と、最後の「install from main (install-mac-app)」を、OS ごとのスキルを指す形にする | M3-9 |
| `worktree-delegation` | `cp -cR` を使うスクリプトを Node にし、`sh …` で呼ぶ説明を直す | M0-3 |
| `visual-debugging` | 「the Mac's Chrome」を、どちらの OS の Chrome でもよい書き方にする。インストールしたアプリを CDP で開く手順を、OS ごとのスキルに分ける | M0-4 |
| `panel-card-design` | `references/shell-contract.md` のウィンドウの高さの数字は、macOS のメニューバーと Dock が前提。Windows(タスクバーとタイトルバー)の数字を実測して足す | M3-7 |
| `ui-text` | OS の部品の名前を出す文は OS ごとのキーにし、それ以外は OS に依らない言い方にする、という決まりを足す | M1 の D |
| `theme` | Windows のタイトルバーのボタンの色がテーマのどのトークンから来るかを足す | M3-2 |
| `website` | 「this Mac」の書き方を直す。OS ごとの手順を `Tabs` で書く決まりを足す | M6-3 |
| `adr`、`screen-mock` | 変えない | |

skills の説明(description)に「this Mac」と書いてあるものは、その OS でしか使わないスキル(`install-mac-app`)を除き、OS に依らない書き方にします。

## AGENTS.md と CLAUDE.md

- **CLAUDE.md。** `@AGENTS.md` の1行だけなので、変えません。
- **AGENTS.md に足すこと。**
  - **Project。** 対象の OS(macOS arm64 と Windows x64)を書きます。
  - **Architecture。** OS による違いは main の capabilities で決め、renderer とモデルのツールは OS を見ない、という決まりを書きます(M1 の C)。
  - **Code。**
    - パスを `/` で分けないことを書きます。main では `node:path`、renderer と shared では `src/shared/file-path.ts` を使います(M1 の A)。
    - 子プロセスには `windowsHide: true` を付けることを書きます(M1 の B)。
    - ネイティブの補助プログラムは、その OS の標準の道具で書くこと(Swift と C)を書きます(M2 の E)。
  - **Tests。**
    - テストは macOS と Windows の CI で動くことを書きます。
    - OS に固有のことを確かめるテストは `runIf` で分け、理由を書くことを書きます(M2 の H)。
  - **Workflow。**
    - パッケージの設定を変えたら、`npm run build` に加えて、その OS のアプリを作って確かめることを書きます(M2 の G)。アプリはビルドするマシンと同じ OS のものしか作れないので、Mac では `dist:mac:unsigned`、Windows では `dist:win:dir` を動かし、もう一方の OS は CI の `build` と `build-windows` で確かめます。
    - スキルの一覧に `install-windows-app` を足します(M3-9)。
  - **Skills の段落。**
    - `.claude/skills` と `.agents/skills` がシンボリックリンクであることは、すでに書いてあります。
    - これに、Windows で clone するときは開発者モードと `core.symlinks=true` が要ることを足します(M0-2)。

## docs/development.md

| 見出し | 直すこと | いつ |
|---|---|---|
| ソースから起動する | 必要なもの(Xcode Command Line Tools)を OS ごとにし、Windows の手順を足す | M2-12 |
| API キーの保存 | キーチェーンと DPAPI の違い。開発中のアプリとインストールしたアプリで鍵が違うのは macOS だけであること | M3-10 |
| CI | Windows の job の表 | M2-12 |
| アプリをビルドする | Windows のビルド(`dist:win`、署名なし)の見出しを足す | M2-12 |
| 実機での確認 | Windows で確かめる項目 | M6-1 |
| 同梱している素材の作り直し | macOS の許可のダイアログの文は Mac だけであること | M2-12 |

## PR #1(署名付きのリリースと自動更新)との関係

- **PR #1 の中身。** 開いたままの PR #1(`ship-signed-releases-with-auto-update`)は、次のものを足します。
  - electron-updater
  - `scripts/release.mjs`
  - `src/main/services/app-update.ts`
  - 設定の「このアプリについて」の更新の表示
  - いまは Apple の証明書を待って止めています。
- **Windows との関係。**
  - electron-updater は NSIS のインストーラーの更新に対応しています。そのため、Windows でも同じ仕組みで更新できます。
  - `scripts/release.mjs` が Windows のインストーラーも作って Release に載せるようにするのは、PR #1 がマージされてから、M6 のあとで行います。
  - Mac の上でも NSIS のインストーラーを作れることは確かめてあります。
  - 署名の無い Windows のアプリで、electron-updater の署名の確かめ(`verifyUpdateCodeSignature`)がどう振る舞うかは未確認です。
- **ぶつからないようにすること。** PR #1 と M2 の G(electron-builder)は、どちらも `electron-builder.yml` と `package.json` を触ります。先にマージされたほうに、もう一方を合わせます。
