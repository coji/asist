# Windows のマシンの準備

Windows で開発のセッションを始める前に、ここまでを済ませておきます。clone の手順は `docs/development.md` にあります。

## 入れるもの

| もの | 目的 | 注意 |
|---|---|---|
| Windows 11(x64) | | 「設定」→「システム」→「開発者向け」で**開発者モード**を有効にする。git がシンボリックリンクを作れるようになる |
| NVIDIA のドライバー | ローカルの音声認識(CUDA 13.0 の torch) | 580 以上。GPU は RTX 20 以降(compute capability 7.5 以上)。`nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv` で確かめる |
| Git for Windows | リポジトリの操作と、Claude Code の Bash のツール | シンボリックリンクを有効にする。改行はリポジトリの `.gitattributes` で LF にそろうので、インストーラーの改行の設定はどれでもよい |
| Node.js 22 | CI と同じ(`.github/actions/setup-app` は `node-version: 22`) | npm も一緒に入る |
| Visual Studio か、その Build Tools | `asist-agent-launcher.c` を `cl.exe` でビルドする | 「C++ によるデスクトップ開発」を入れる。確かめた版は `docs/development.md` の「ソースから起動する」にある |
| GitHub CLI(`gh`) | PR と CI | `gh auth login` で、git の方式に SSH を選び、認証はブラウザで行う。SSH の鍵だけでは gh の API は使えない |
| Claude Code | 開発のセッション、ASIST のエージェントのジョブの動作確認 | ネイティブのインストーラー(`irm https://claude.ai/install.ps1 \| iex`)。`%USERPROFILE%\.local\bin\claude.exe` に入り、このフォルダを利用者の PATH に足す。npm で入れた claude が残っていると PATH で先に見つかるので、`npm uninstall -g @anthropic-ai/claude-code` で消す。`claude --version` が動くこと、`Get-Command claude -All` にネイティブのものだけが出ることを確かめる |
| PowerShell 7 | Codex のインストーラーを動かす | `winget install --id Microsoft.PowerShell --exact`。Windows に最初からある PowerShell 5.1 では、Codex のインストーラーが `OSArchitecture` を読めずに止まる(2026-09-27) |
| Codex CLI | ASIST のエージェントのジョブの動作確認 | PowerShell 7 で公式のインストーラー(`irm https://chatgpt.com/codex/install.ps1 \| iex`)。`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` に入る。winget の `OpenAI.Codex`(0.157.1)は、リンクから起動されると自分の置き場所の確かめ(`codex-package.json`)に失敗し、`the CLI package does not match this platform or executable` で止まるので使わない。npm では `.cmd` しか作られないので入れない |
| Google Chrome | `scripts/cdp` の撮影と計測 | |
| VOICEVOX(任意) | 読み上げの確認 | |

Python は入れません。アプリに同梱した uv が、決まったバージョンの Python を userData の下に取得します(ADR 0007)。

## clone

[docs/development.md](../development.md) の「Windows で clone する」の手順に従います。開発者モードと `core.symlinks=true` が無いと、`.claude/skills` と `.agents/skills` がテキストファイルになり、スキルを1つも読めません。

## Claude Code の個人の設定

`~/.claude/CLAUDE.md` と Claude Code のメモリーは、マシンごとにあり、Mac のものは Windows に引き継がれません。Mac で決めている返事の言語や作業の進め方があれば、Windows の `~/.claude/CLAUDE.md` にも書いておきます。シェルについての決まり(Mac では zsh)は、Windows では Bash のツールが Git Bash で動き、npm のスクリプトが `cmd.exe` で動くことに合わせて書き直します。

## 最初のセッションで確かめること

[03-milestones.md](03-milestones.md) の M3 の最初のタスクです。

1. `npm ci` が通ること。
2. `npm run typecheck` が通ること。
3. `npm test` の結果。M2 が終わっていれば、失敗は Windows の実機で作る部分のテストだけのはずです。
4. `npm run dev` で、ウィンドウが開くこと。
