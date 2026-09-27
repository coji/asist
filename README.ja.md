<p align="center">
  <img src="website/public/img/og.png" alt="ASIST — 話しかけるだけで、予定もメールも片づく。" width="720" />
</p>

<h1 align="center">ASIST</h1>

<p align="center">
  Mac と Windows で使えるリアルタイムアシスタント
</p>

<p align="center">
  <a href="https://asist-agent.com">紹介ページ</a> ·
  <a href="https://github.com/nyosegawa/asist/releases/latest">ダウンロード</a> ·
  <a href="https://asist-agent.com/docs/">ドキュメント</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/nyosegawa/asist/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/nyosegawa/asist/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/nyosegawa/asist/releases/latest"><img src="https://img.shields.io/github/v/release/nyosegawa/asist?style=flat-square" alt="最新のバージョン" /></a>
  <img src="https://img.shields.io/badge/macOS-14%2B%20%C2%B7%20Apple%20Silicon-lightgrey?style=flat-square" alt="macOS 14 以降、Apple Silicon" />
  <img src="https://img.shields.io/badge/Windows-11%20%C2%B7%20x64-lightgrey?style=flat-square" alt="Windows 11、x64" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" /></a>
</p>

ASIST は、話しかけると声で答えるアシスタントです。天気や予定やメールは会話の横のカードに出し、時間のかかる調べものやファイルの編集は、あなたが承認したあとに Agent(codex か claude の CLI)へ任せます。会話には Anthropic、OpenAI、Google、Cerebras のモデルから選んだものを使います。

**あなたのデータは、あなたのコンピュータに。** 声の聞き取り、記憶、メモ、会話の履歴はこのコンピュータの中にあります。会話の文はあなたが選んだモデルの提供元に、カードのデータを取るときは天気やニュースのサービスにだけ問い合わせます。ASIST から開発者へ送るデータはありません。

<p align="center">
  <img src="website/public/img/home.jpg" alt="ASIST のホーム画面。中央に会話、左に為替のカード、右に天気のカード、下に Dock が並んでいる" width="860" />
</p>

<table>
  <tr>
    <td width="50%"><img src="website/public/screens/ja/calendar.webp" alt="カレンダーのミニアプリ。週の表示に予定が並んでいる" /><br /><sub>カレンダー(いまは Mac だけ)。「来週の予定を見せて」で開きます。</sub></td>
    <td width="50%"><img src="website/public/screens/ja/agent.webp" alt="Agent のジョブの画面。ログの下に成果物が並んでいる" /><br /><sub>Agent のジョブ。進み具合と成果物を見られます。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="website/public/screens/ja/memory.webp" alt="記憶のミニアプリ。ASIST が書いた日記が開いている" /><br /><sub>記憶。毎日の日記と、覚えていること。</sub></td>
    <td width="50%"><img src="website/public/screens/ja/mail.webp" alt="メールのミニアプリ。受信箱と、ASIST が書いた下書き" /><br /><sub>メール。読み上げ、要約、下書きまで。</sub></td>
  </tr>
</table>

## できること

- **話すだけで片づく。** 話し終わるとすぐに短い一言で答え始め、返事の途中で話しかけると、読み上げを止めて聞きます。日本語の会話では、話の途中で相槌も打ちます。
- **答えはカードで。** 天気、予定、メールの下書き、To-Do、為替、ニュース、地図、タイマーなどを、声で答えながら会話の横に並べます。
- **ミニアプリ。** Agent のジョブ、タスク、メモ、メール、記憶、カレンダーを Dock から開けます。「カレンダーで来週を開いて」と会話から開くこともできます。
- **面倒な仕事は Agent に。** 調べものやファイルの編集を codex か claude の CLI に引き渡し、進み具合と成果物をその場で見られます。始める前には必ず確認を求めます。
- **覚えている。** 毎日、その日の会話からあなたのことを記憶に整理し、ASIST 自身の日記も書きます。次の日の会話はそこから始まります。
- **11 の言語。** 画面と会話は 11 の言語で使えます。日本語の会話は、相槌や間の取り方まで作り込んでいます。

## はじめる

必要なのは、Apple Silicon の Mac(macOS 14 以降)か x64 の Windows 11 の PC と、会話のモデルの API キー(Anthropic、OpenAI、Google、Cerebras のどれか 1 つ)です。Windows で声の聞き取りをこのコンピュータの中で動かすには、NVIDIA の GPU(GeForce RTX 20 か GTX 16 以降の世代、ドライバー 580 以降)が要ります。GPU が無くても、ブラウザの中で動く Whisper か Live API の声のエンジンで話すか、文字で使えます。Windows 版には、カレンダーと Qwen3-TTS はまだありません。

1. [Releases](https://github.com/nyosegawa/asist/releases/latest) からダウンロードします。Mac では `ASIST-arm64.dmg` をダウンロードし、ASIST を「アプリケーション」に入れます。Windows では `ASIST Setup <バージョン>.exe` をダウンロードして開きます。インストーラーにはまだ署名が無いので、SmartScreen の警告が出たら「詳細情報」を押し、そのあと「実行」を押します。
2. ASIST を開き、初回セットアップで言語、モデル、声、マイクを選びます。
3. 話しかけます。新しいバージョンは自動で届き、次に終了したときに入れ替わります。Windows では、新しいバージョンのインストーラーを前のバージョンの上から入れます。データはそのまま残ります。

画面つきの手順、マイクとカレンダーの許可、Agent の CLI の準備は、ドキュメントの[はじめる](https://asist-agent.com/docs/start/)にあります。

## 安全に使うために

ASIST の返事とカードは言語モデルが作るので、間違っていることがあります。大事な内容は確かめてから使ってください。予定の変更、メールの送信、Agent のジョブは、あなたが承認したときだけ行います。承認したジョブは、あなたの codex か claude の CLI がその CLI の権限で動かし、選んだフォルダのファイルを書き換えることがあるので、中身を読んでから承認してください。API はあなたの API キーで呼び、料金はそれぞれの提供元があなたに直接請求するので、提供元ごとに使える金額の上限を設定しておいてください。会話の文と、Live API の声のエンジンを選んだときの音声は、あなたが選んだ提供元に送られます。使い始める前に、ドキュメントの[安全に使うために](https://asist-agent.com/docs/start/safety/)を読んでください。ASIST は MIT License で配布しており、保証はありません。

## プライバシー

| どこで | 何を |
|---|---|
| このコンピュータの中だけ | 声の聞き取り、声の区間の検出、相槌の判定、記憶の検索。設定、記憶、メモ、タスク、会話の履歴、取り込んだメール |
| 選んだモデルの提供元 | 会話の文と、その会話に関係する記憶。声のエンジンに Live API を選んだときは、マイクの音声 |
| カードのデータの取得元 | 天気の場所、ニュースの話題、為替の通貨など、カードに要る語だけ |
| codex か claude の CLI の先 | あなたが承認したジョブのプロンプトと、CLI が読んだファイル |

API キーとメールのパスワードは、macOS ではキーチェーンの鍵で、Windows では DPAPI で暗号化して保存し、Agent の CLI を含むどの子プロセスにも渡しません。Windows では、あなたのユーザーで動くプログラムならその暗号を解けます。送り先の一覧は、ドキュメントの[プライバシーとデータ](https://asist-agent.com/docs/privacy/)にあります。

## ドキュメント

使う人向けのドキュメントは [asist-agent.com/docs](https://asist-agent.com/docs/) にあります。

| 知りたいこと | 読むところ |
|---|---|
| インストール、初回セットアップ、許可、Agent の CLI | [はじめる](https://asist-agent.com/docs/start/) |
| 話しかけ方、カード、ミニアプリ | [使い方](https://asist-agent.com/docs/usage/) |
| 見た目、言語と地域、モデル、声、Agent | [設定](https://asist-agent.com/docs/settings/) |
| データの置き場所と送り先 | [プライバシーとデータ](https://asist-agent.com/docs/privacy/) |
| うまく動かないとき | [困ったとき](https://asist-agent.com/docs/troubleshooting/) |
| 使っているモデル、外部のデータ、ライセンス | [参考](https://asist-agent.com/docs/reference/models/) |
| ソースからの起動、ビルド、リリース | [docs/development.md](docs/development.md)(このリポジトリ) |
| 設計の判断とその理由 | [docs/adr/](docs/adr/)(このリポジトリ) |

## 開発

```bash
npm install
npm run dev      # ソースから起動します
npm test
```

Node.js と npm に加えて、Mac では Xcode Command Line Tools が、Windows では Visual Studio の「C++ によるデスクトップ開発」が要ります。ビルド、CI、画面の確かめ方、リリースの手順は [docs/development.md](docs/development.md) に、Agent で開発するときの決まりは [AGENTS.md](AGENTS.md) にあります。

不具合の報告と要望は [Issues](https://github.com/nyosegawa/asist/issues) へどうぞ。脆弱性は公開の Issue ではなく、[SECURITY.md](SECURITY.md) の手順で知らせてください。

## ライセンス

[MIT](LICENSE)。アプリに同梱している git は GPL-2.0 で、そのソースは各バージョンの Release に置いています。使っているモデルとデータのライセンスは、ドキュメントの[参考](https://asist-agent.com/docs/reference/models/)にあります。
