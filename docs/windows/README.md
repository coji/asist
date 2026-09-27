# ASIST を Windows で動かす計画

ASIST(nyosegawa/asist)は、いまは Apple Silicon の macOS でしか動きません。これを Windows 11 でも動かすための調査、設計、マイルストーンをまとめた文書です。調べた時点は 2026-09-27 の main(`5d7c5d6`)です。

このフォルダは、Windows 対応が終わったら消します。残す判断は実装の PR の中で ADR(`docs/adr/`)にし、手順は `docs/development.md` と skills に移すので、そのあとはコードと重なるだけになるためです。進み具合は issue #48 のチェックリストで追います。

## 決まったこと

- **対象。** Windows 11 の x64 だけを対象にします。Arm64 は対象にしません。
- **ローカルの音声認識。**
  - 最初に Windows で出すものに、ローカルの音声認識を入れます。
  - NVIDIA の GPU(RTX 20 以降、ドライバー 580 以降)がある前提で、Qwen3-ASR を CUDA の torch で動かします。
  - GPU が無いマシンでは、ブラウザの中の聞き取りと live のエンジンを使えます。
- **カレンダー。** Windows では最初は出しません。Google Calendar API で作り、Mac も揃えます(#81)。
- **署名と配布。** GitHub の Release から NSIS のインストーラーで配り、Microsoft Store では配りません(ADR 0022)。
  - 最初は署名しません。SmartScreen の警告の画面を、「詳細情報」から「実行」で進めて入れてもらいます。
  - SignPath Foundation のオープンソース向けの署名を申請します。
- **進め方。** Mac でできる準備(M0〜M2 と M5 の一部)を PR に分けて先に進め、そのあと Windows の Claude Code のセッションで続けます。

## 進め方

- **main に小さく入れる。**
  - 変更は、これまでどおり1つのまとまりごとに PR にして、main に入れます。Windows 対応のブランチは作りません。
  - main は squash マージしか受け付けないので、ブランチを最後に入れると、全部が1つのコミットになってしまいます。
  - また、M1 と M2 はコード全体と11言語の辞書に触るので、main から離れると毎日衝突します。
  - Windows のアプリは M6 まで配布しません。そのため、途中の Windows のコードが main にあっても、使う人はいません。
  - サイト、README、ドキュメントの利用者向けの記述は、M6 まで変えません。
- **2つのセッションで担当を分ける。**
  - Mac のセッションは、M0、M1、M2 を進めます。そのあとは、M5 の Mac の部分と M6 の文書を進めます。
  - Windows のセッションは、M2 が終わって windows-latest の CI が緑になってから始め、M3、M4、M5 の Windows の部分、M6 の実機の確認を進めます。
  - 同じファイルを触らないように、始める前に issue #48 で担当を確かめます。
- **進み具合と確認待ち。**
  - 各 PR の本文に「Part of #48」と書き、マージしたら issue #48 のチェックを付けます。
  - 決めてもらうことと実機で人が確かめることは、issue #48 の「確認待ち」に並べてあり、セッションはそこで止まって聞きます。

## 文書の一覧

| 文書 | 中身 |
|---|---|
| [01-current-state.md](01-current-state.md) | いまのコードで macOS に依存しているところと、Windows でテストを動かしたときの見込み |
| [03-milestones.md](03-milestones.md) | マイルストーン(M0〜M6)と、タスク、触るファイル、終わりの条件、PR の分け方 |
| [04-windows-dev-setup.md](04-windows-dev-setup.md) | Windows のマシンの準備。入れるもの、clone、Windows 用の `~/.claude/CLAUDE.md` |
| [05-adr-drafts.md](05-adr-drafts.md) | ADR にする判断の下書き |
| [06-open-questions.md](06-open-questions.md) | 決めていないこと、実機で確かめること |
| [references.md](references.md) | 参考にした資料 |
| **設計** | |
| [design/01-principles-and-structure.md](design/01-principles-and-structure.md) | 設計の方針と、ディレクトリ構成がどう変わるか |
| [design/02-platform-capabilities.md](design/02-platform-capabilities.md) | OS ごとに使える機能を main で決めて渡す仕組みと、設定の移行 |
| [design/03-agent-process.md](design/03-agent-process.md) | エージェントの CLI を Job Object の中で動かす仕組み |
| [design/04-bundled-tools.md](design/04-bundled-tools.md) | 準備のスクリプト、MinGit、uv、Python の環境 |
| [design/05-speech.md](design/05-speech.md) | マイク、Qwen3-ASR(CUDA)、読み上げ、CPU の worker |
| [design/06-os-integration.md](design/06-os-integration.md) | ウィンドウ、トレイ、ショートカット、通知、マイクの許可、フォント、文言 |
| [design/07-files-and-paths.md](design/07-files-and-paths.md) | パス、ファイルの書き込み、秘密の保存 |
| [design/08-build-ci-tests.md](design/08-build-ci-tests.md) | electron-builder、CI、テスト |
| [design/09-docs-site-skills.md](design/09-docs-site-skills.md) | ドキュメント、サイト、README、紹介動画、skills、AGENTS.md への影響 |

Windows のセッションを始めるときは、まず [04-windows-dev-setup.md](04-windows-dev-setup.md) を済ませます。そのあと、[03-milestones.md](03-milestones.md) の M3 から読みます。

## 綺麗に作れるか

大部分は綺麗に作れる見込みです。ただし、3か所は作り方を間違えると散らかります。

### 綺麗に作れる理由

- **OS に依存するところが少なく、まとまっている。**
  - 約12万行のうち、macOS に依存しているのは次の場所です。
    - エージェントのプロセスの3ファイル
    - git と uv の場所
    - 音声の実行環境
    - ネイティブのマイクとカレンダー
    - ウィンドウの設定
    - パスを `/` で分けている約15か所
  - 会話、LLM、live のエンジン、メール、カード、React の画面の大部分は、OS に触れていません。
- **差し込み口がすでにある。**
  - カレンダーは、ネイティブの処理を関数として受け取っています(`calendar-service.ts`)。
  - safeStorage は、差し込む形で使っています。
  - 同梱物の場所は、`resourcePath` の1か所で決めています。
  - 子プロセスの環境は、`childEnv` の1か所で決めています。
  - 音声の worker は、JSON lines のやりとりに揃っています。
  - そのため、Windows の実装は「同じ口に別の中身を入れる」形で足せます。
- **音声の実行環境がきれいに2つに分かれる。**
  - 音声の実行環境(`speech-runtime.ts`、もとの `mlx-runtime.ts`)の仕事のうち、MLX に固有なのは、動く条件、lock ファイル、worker のスクリプトだけです。
  - CUDA の実行環境を足すと、同じ責務の実装が2つになります。AGENTS.md の条件どおりに共通化できます。
  - 聞き取りの worker は、Mac と同じやりとりをそのまま使えます。
- **ビルドも Mac から確かめられる。**
  - `electron-builder --win` は Mac の上で Wine なしに動きます。
  - MinGit と uv の取得も、Mac で試せます。
  - そのため、Windows に移る前に、ビルドの形まで作れます。

### 散らかりやすい3か所

1. **エージェントのプロセス。**
   - いまの実装は、POSIX のプロセスグループ、`ps`、PID の再利用の性質に深く頼っています。
   - `if (win32)` を足して直そうとすると、読めなくなります。
   - 起動用の小さなプログラムに Job Object を持たせ、「launcher が終わったら子孫も全員いない」という約束にすれば、Windows 側はむしろいまより単純になります([design/03](design/03-agent-process.md))。
   - その代わり、C の小さなプログラムと、そのビルドの手順が増えます。
2. **パス。**
   - `/` で分ける処理が、main、shared、renderer に散らばっています。
   - 1か所ずつ `replace(/\\/g, '/')` で直すと、同じ処理が増えます。
   - main は `node:path`、renderer と shared は1つの小さなモジュール、と決めて全部を寄せます([design/07](design/07-files-and-paths.md))。
3. **テスト。**
   - POSIX に固有のことを確かめるテストを `runIf` で飛ばすだけにすると、Windows で何も守られていない状態になります。
   - 飛ばすテストには、Windows で同じ約束を確かめるテストを対にして置きます。

### 手間はかかるが難しくはないもの

- 画面の文言の82件 × 11言語の見直し
- ドキュメントの約20ページ × 2言語と、紹介ページの11言語
- 置き換えの書き込み8か所を1つにまとめること(Windows のためだけでなく、いまのコードの重複を減らす変更でもあります)

### 実機でしか分からない危うさ

次のものは、Mac の上でどれだけ準備しても答えが出ません。M3 から M5 のタスクとして、先に確かめるように並べてあります。

- エコーキャンセルの質
- CUDA の環境の大きさと遅延
- Windows の codex と claude の sandbox が、記憶の整理のジョブを閉じ込められるか
