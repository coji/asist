# エージェントのプロセスを Windows で動かす

## いまの仕組み(macOS)

エージェントのジョブ(claude と codex)は、次の約束で動いています。どれも Windows で同じ強さに保つ必要があります。

1. **ジョブを保存するまで、CLI を書き込み始めさせない。**
   - `/bin/sh` の小さなスクリプトが、標準入力の1行目の `start` を待ってから CLI を `exec` します(`agent-process.ts:108`)。
   - ASIST が先に落ちれば、標準入力の EOF で、CLI は起動する前に終わります。
2. **CLI とその子孫をまとめて止め、全員がいなくなったことを確かめてからジョブを終える。**
   - 起動用のシェルを `detached: true` でプロセスグループのリーダーにします。
   - 止めるときは `process.kill(-pid)` でグループに SIGTERM を送り、2秒後に SIGKILL を送ります。
   - グループが空になるまで待ちます(`agent-process-lifetime.ts`)。
   - CLI が自分で終わったときも、子孫が残っていれば止めます。
3. **再起動のあと、前の起動で動いていたジョブを見つけて止める。ほかのプロセスは止めない。**
   - pid と開始時刻と、環境変数に入れたトークン(`ASIST_AGENT_EXECUTION_ID`)を保存しておきます。
   - `ps` でグループの全員の環境変数を読み、トークンが合うときだけ止めます(`agent-process-identity.ts`)。
   - PID が再利用されていないことは、BSD の性質(グループの ID に使われている PID は新しいプロセスに渡さない)と開始時刻で確かめています。

Windows には、プロセスグループ、負の PID への信号、`ps` がありません。ほかのプロセスの環境変数も、メモリーを読まないと取れません。PID はすぐ再利用されます。

## Windows での形: 起動用の小さなプログラムと Job Object

Job Object は、Windows でプロセスの集まりをまとめて扱う仕組みです。入れたプロセスが作った子は、親子のつながりが切れても、自動で同じ Job に入ります。Job をまとめて止めることも、中にいるプロセスの数を調べることもできます。

C で `asist-agent-launcher.exe` を作り、これが Job Object を持ちます。いまの `/bin/sh` のスクリプトにあたるものです。

```
ASIST (main)                       asist-agent-launcher.exe             CLI (claude.exe / codex.exe)
 │ spawn(launcher, [--run, token, ASIST の pid, cli, ...args], windowsHide)
 │──────────────────────────────▶ │ ASIST のプロセスを開く(終わるのを待てるように)
 │                                  │ 名前付き Job「Local\asist-agent-<token>」を作る(KILL_ON_JOB_CLOSE)
 │ ジョブを保存する                   │
 │ stdin: "start\n" + プロンプト ──▶ │ stdin から1バイトずつ読んで "start" を確かめる
 │                                  │ CreateProcess(PROC_THREAD_ATTRIBUTE_JOB_LIST で最初から Job の中に)
 │                                  │──────────────────────────────▶ │ stdin の残り(プロンプト)を読む
 │ ◀──────────────── stdout(JSONL)と stderr は CLI から直接 ─────────── │
 │                                  │ CLI の終了か ASIST の終了を待つ
 │                                  │ Job にまだプロセスが残っていれば止める
 │                                  │ Job が空になるのを待つ
 │ ◀────── launcher の終了(CLI の終了コード。止めたときは 130) ─┘
```

- **止めるとき。**
  - ASIST が `asist-agent-launcher.exe --stop <token>` を起動します。これが名前から Job を開き、`TerminateJobObject` で全員を止め、Job の中のプロセスが0になるのを待って終わります。
  - CLI が終わるので、`--run` の launcher も Job が空になったのを確かめてから終わります。
  - そのため、**ASIST から見ると「launcher が終わった」ことが「子孫も全員いなくなった」ことになります。** いまの `groupWatch` で25ミリ秒ごとに確かめる処理は、Windows では要りません。
- **ASIST が落ちたとき。**
  - launcher は ASIST のプロセスのハンドルを待っているので、ASIST が終わると Job を止め、空になるのを待って終わります。
  - `start` の前に ASIST が落ちたときは、標準入力が閉じるので、CLI は起動しません。
  - launcher 自身が止められても、Job の最後のハンドルが閉じるので、`KILL_ON_JOB_CLOSE` で全員が止まります。
- **再起動のあと(クラッシュからの回復)。**
  - 保存したトークンから Job の名前が決まります。
  - `asist-agent-launcher.exe --inspect <token>` は、Job が無ければ `gone` を返し、あれば中のプロセスの数を返します。
  - `--stop <token>` は、Job を止めて空になるのを待ちます。
  - Job の名前はトークンで一意なので、PID の再利用も、ほかの人のプロセスを止める心配もありません。そのため、環境変数を読む照合は要りません。
- **保存する値。** `AgentProcessIdentity`(`pid`、`startedAt`、`token`)の形は変えません。
  - Windows では、`pid` は launcher の PID を、`startedAt` は ASIST が起動した時刻を入れます。
  - 回復に使うのは `token` だけです。
  - `jobs.json` の形は変わらないので、バージョンは上げません。

### 引数と実行ファイル

- **`.exe` だけを起動し、`.cmd` と `.bat` は受け付けません。**
  - `.cmd` を起動するには `cmd.exe` を通す必要があります。
  - ASIST が渡す引数には `"`(`-c sandbox_mode="workspace-write"`)や `(`、`)`、`*`(`Bash(node … *)`)が入っていて、`cmd.exe` の解釈で壊れます。Node も CVE-2024-27980 のあと、`shell` なしでは `.cmd` を起動しません。
- **コマンドラインの組み立て。** launcher は、受け取った引数を MSVC の実行時ライブラリの規則(`CommandLineToArgvW` が戻せる形)で引用して、1本のコマンドラインにします。
- **プロンプトの渡し方。** Windows のコマンドラインは 32,767 文字までなので、プロンプトはいまと同じく標準入力で渡します。
- **コンソールのウィンドウ。** launcher は `windowsHide: true` で起動します。CLI と、その子の git や node は、launcher の見えないコンソールを受け継ぐので、ウィンドウが出ません。

## CLI を探す(`agent-process/cli-locator.ts`)

| | macOS(いまのまま) | Windows |
|---|---|---|
| 環境変数での上書き | `CLAUDE_CLI_PATH`、`CODEX_CLI_PATH` | 同じ |
| 決まった場所 | `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.claude/local` | claude: `%USERPROFILE%\.local\bin\claude.exe`(ネイティブのインストーラー)。codex: `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`(インストーラー) |
| PATH から探す | `zsh -lc 'whence -p …'`(GUI のアプリは PATH が短いため) | `Path` を `;` で分け、`.exe` だけを探す。Windows の GUI のアプリは利用者の PATH をそのまま受け継ぐので、シェルは要らない |
| npm で入れたもの | そのまま使える | `%APPDATA%\npm\claude.cmd` のような `.cmd` しか無いときは、「ネイティブのインストーラーで入れてください」というエラーにする。npm のパッケージの中にある本物の `.exe` を探す方法もあるが、場所が CLI のバージョンで変わるので採らない |

いまは、見つからなかった結果も起動中ずっと覚えています(`cliPathCache`)。Windows ではインストール先が複数あるので、設定画面で「探し直す」ときに捨てるようにします。

## 安全の境界

AGENTS.md の「外に書き込むジョブの承認の関門を保つ」と、記憶の整理のジョブの閉じ込め方(`src/shared/agent-cli.ts:50-80` のコメント)は、Windows でも同じ強さでなければなりません。次の点は、Windows の実機で確かめてから有効にします。確かめられないあいだは、そのジョブを始めずにエラーにします。

- **claude の記憶の整理。**
  - いまは `--restricted` と `dontAsk` で、許すコマンドを `Bash(node <path>/validate.mjs *)` の1つにしています。
  - Windows の claude は、Git Bash が無いと Bash のツールではなく PowerShell のツールを使います。そのため、規則の書き方とパスの区切り(`\`)を実機で合わせる必要があります。
- **codex の記憶の整理と読むだけのジョブ。**
  - `workspace-write` と `read-only` の sandbox は、OS が強制するものです。
  - Windows の codex の sandbox(elevated と unelevated の2つ)で、次の2つが守られることを確かめます。
    - 書き込みが worktree の中に限られること
    - ネットワークが閉じていること
- **API キー。**
  - Windows の safeStorage(DPAPI)は、同じユーザーのほかのプロセスから守りません。
  - ジョブが `%APPDATA%\ASIST\Local State` と `api-keys.json` を読めば、キーを取り出せます。
  - これは ADR 0006 の制約として書き足します([05-adr-drafts.md](../05-adr-drafts.md))。
  - 記憶の整理のジョブについては、sandbox の外のファイルを読めないことも確かめます。

## 止めるときの違い

- macOS では、SIGTERM のあと2秒待ってから SIGKILL を送るので、CLI が片づけをする時間があります。
- Windows には SIGTERM にあたるものが無いので、`TerminateJobObject` ですぐに止めます。
- そのため、CLI が worktree に残した一時ファイルやロックのファイルは、取り込みや破棄のときの git の確認で見つけることになります。これも ADR に制約として書きます。

## テスト

- **Mac で書けるもの。**
  - `cli-locator.ts` の候補の表と PATH の探し方(`path.win32` と、差し替えた `fs.existsSync` で確かめる)
  - `.cmd` を拒むこと
  - 起動、止める、回復の流れ。launcher を差し替えて確かめます。
- **Windows で書くもの。**
  - launcher の実物を使うテスト。例えば、子孫を残して終わる CLI の役を PowerShell か小さな `.exe` にして、launcher の終了のあとにそのプロセスがいないことを確かめます。
  - ASIST の役のプロセスを止めて、Job が止まることを確かめます。
- **OS で分けるテスト。** いまの `agent-crash-recovery.test.ts` と `agent-process-lifetime.test.ts` の POSIX のテストは、`describe.runIf(process.platform !== 'win32')` にして、理由をコメントに書きます。同じことを確かめる Windows のテストを、対にして置きます。

## 見送った案

- **ASIST と launcher を名前付きパイプでつなぎ、`stop` の指示と ASIST の終了をパイプで伝える。** ASIST の終了は ASIST のプロセスのハンドルを待てば分かり、止める指示は名前から Job を開く `--stop` で足ります。パイプのサーバーを ASIST の側に持たずに済みます。
- **`taskkill /T /F` で止める。** 生きている親子のつながりしかたどれず、親が先に終わった孫を取りこぼします。いまの macOS の実装が防いでいる「自分で終わった CLI が子を残す」場合に、そのまま穴が開きます。
- **Node から FFI(koffi など)で Job Object を直接扱う。**
  - `spawn` のあとに Job に入れるまでのあいだに、CLI が子を作れてしまいます。
  - これを防ぐには、止めた状態で起動して Job に入れてから再開する必要があり、どのみち起動用のプログラムが要ります。
  - 起動用のプログラムに Job の扱いを全部入れれば、main に FFI を持ち込まずに済みます。
- **PowerShell の `Get-CimInstance Win32_Process` で調べる。** 起動に時間がかかります。また、親子のつながりが切れた子孫が自分のものかどうかを確かめられません。
