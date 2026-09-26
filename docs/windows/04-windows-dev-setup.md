# Windows のマシンの準備

Windows で開発のセッションを始める前に、ここまでを済ませておきます。M0-2 で、このうち長く使う手順を `docs/development.md` に移します。

## 入れるもの

| もの | 目的 | 注意 |
|---|---|---|
| Windows 11(x64) | | 「設定」→「システム」→「開発者向け」で**開発者モード**を有効にする。git がシンボリックリンクを作れるようになる |
| NVIDIA のドライバー | ローカルの音声認識(CUDA 13.0 の torch) | 580 以上。GPU は RTX 20 以降(compute capability 7.5 以上)。`nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv` で確かめる |
| Git for Windows | リポジトリの操作と、Claude Code の Bash のツール | インストーラーの「改行の扱い」は「Checkout as-is, commit as-is」にする(リポジトリの `.gitattributes` で LF に揃えるため)。シンボリックリンクを有効にする |
| Node.js 22 | CI と同じ(`.github/actions/setup-app` は `node-version: 22`) | npm も一緒に入る |
| Visual Studio 2022 以降の Build Tools | `asist-agent-launcher.c` を `cl.exe` でビルドする | 「C++ によるデスクトップ開発」を入れる |
| GitHub CLI(`gh`) | PR と CI | `gh auth login` |
| Claude Code | 開発のセッション、ASIST のエージェントのジョブの動作確認 | ネイティブのインストーラー(`irm https://claude.ai/install.ps1 \| iex`)。`%USERPROFILE%\.local\bin\claude.exe` に入る |
| Codex CLI | ASIST のエージェントのジョブの動作確認 | インストーラー(`irm https://chatgpt.com/codex/install.ps1 \| iex`)。npm では入れない(`.cmd` しか作られないため) |
| Google Chrome | `scripts/cdp` の撮影と計測 | |
| VOICEVOX(任意) | 読み上げの確認 | |

Python は入れません。アプリに同梱した uv が、決まったバージョンの Python を userData の下に取得します(ADR 0007)。

## clone

```powershell
git config --global core.symlinks true
git config --global core.longpaths true
git clone git@github.com:nyosegawa/asist.git
```

clone したあと、`.claude\skills` と `.agents\skills` がフォルダへのリンクになっていることを確かめます(`dir .claude` で `<SYMLINKD>` と出る)。

リンクではなくテキストファイルになっていたら、Claude Code と Codex はスキルを1つも読めません。その場合は、次の手順で作り直します。

1. 開発者モードを有効にします。
2. `git config core.symlinks true` を実行します。
3. `git checkout -- .claude/skills .agents/skills` を実行します。

## Claude Code の個人の設定

`~/.claude/CLAUDE.md` と Claude Code のメモリーは、マシンごとにあり、Mac のものは Windows に引き継がれません。Mac で決めている返事の言語や作業の進め方があれば、Windows の `~/.claude/CLAUDE.md` にも書いておきます。シェルについての決まり(Mac では zsh)は、Windows では Bash のツールが Git Bash で動き、npm のスクリプトが `cmd.exe` で動くことに合わせて書き直します。

## 最初のセッションで確かめること

[03-milestones.md](03-milestones.md) の M3 の最初のタスクです。

1. `npm ci` が通ること。
2. `npm run typecheck` が通ること。
3. `npm test` の結果。M2 が終わっていれば、失敗は Windows の実機で作る部分のテストだけのはずです。
4. `npm run dev` で、ウィンドウが開くこと。
