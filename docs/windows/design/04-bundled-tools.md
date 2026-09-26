# 同梱する git、uv、Python

## 準備のスクリプト(`scripts/prepare-resources.mjs`)

- **いまの形。** `package.json` の `predev`、`prebuild`、`pretest` は、`sh scripts/*.sh` を4つ並べています。各スクリプトは、Mac 以外では何もせずに `exit 0` で終わります。
- **新しい入口。** これを Node の1つの入口に替えます。
  - `node scripts/prepare-resources.mjs <用途>` の形にし、用途は `dev`、`build`、`test` のいずれかです。
  - 入口は OS と CPU を見て、用意するものを決めます。
  - 対応していない組み合わせでは、何を用意できないかを出して、終了コード 1 で止まります。対象は macOS arm64 と Windows x64 の2つです。
- **用途ごとに用意するもの。**

| 用途 | macOS arm64 | Windows x64 |
|---|---|---|
| `test` | git、Electron の本体 | git、Electron の本体 |
| `dev` | git、uv、Swift の補助プログラム2つ | git、uv、`asist-agent-launcher.exe` |
| `build` | `dev` と同じものと、許可のダイアログの文(`scripts/macos/permission-texts.mjs`) | `dev` と同じもの |

- **Electron の本体を用意する理由。** `pretest` がいま `install-electron` を呼んでいるのは、テストの worker が同時に Electron をダウンロードして、40件が失敗したことがあるからです(electron の package は postinstall を持たず、最初に require されたときにダウンロードします)。入口からも同じく先に取得します。
- **すでに用意できているとき。** 取得したものはバージョンの記録(いまの `VERSION` のファイルと同じ)を見て、合っていれば何もしません。
- **モジュールの分け方。** `scripts/resources/` の下に、次のモジュールを置きます。
  - `git-macos.mjs`: いまの `build-git.sh` を Node にしたもの
  - `git-windows.mjs`
  - `uv.mjs`
  - `native-macos.mjs`
  - `native-windows.mjs`
- **バージョンとハッシュの置き場所。** バージョンとハッシュは各モジュールの先頭に置きます。CI のキャッシュのキーは、`scripts/resources/` のファイルのハッシュから作ります。

## git

### macOS

いまのまま、ソースから arm64 向けにコンパイルします(ADR 0007)。

### Windows: MinGit

2026-09-27 に、`MinGit-2.55.0.5-64-bit.zip` をダウンロードして中身を確かめました。

- **ダウンロードと確認。**
  - 入手先は、git-for-windows/git の v2.55.0.windows.5 のリリースです。
  - sha256 は `56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e` です。リリースノートの表とも一致しました。
- **大きさ。** 展開すると 91 MB(365 ファイル)です。そのうち約 30 MB は Git Credential Manager(.NET と Avalonia の DLL)です。
- **中身の並び。** `LICENSE.txt`、`cmd/`、`etc/`、`mingw64/`、`usr/` です。
- **git の本体。** 本体は `mingw64/bin/git.exe` です。`cmd/git.exe` は、環境を整えてから本体を起動する小さなプログラムです。
- **sh。**
  - `usr/bin/sh.exe` は bash です(bash 5.3.015)。
  - `git-submodule` や `git-sh-setup` のようなシェルのスクリプトは、`mingw64/libexec/git-core/` にあります。
  - `git.exe` を直接起動したときは、`MSYSTEM` が設定されていなければ、git が自分で `mingw64\bin` と `usr\bin` を PATH の先頭に足します(`compat/mingw.c:3700-3830`)。そのため、フックやシェルのスクリプトから sh を見つけられます。
- **ライセンス。**
  - `LICENSE.txt` は git の COPYING(GPL-2.0)です。
  - ライブラリのライセンスは、`mingw64/share/licenses/` と `usr/share/licenses/` にあります。
- **`etc/gitconfig`。**
  - 中身は `core.autocrlf=true`、`core.symlinks=false`、`credential.helper=manager`、git-lfs の `filter` などです。
  - `GIT_CONFIG_NOSYSTEM=1` を付けると、このファイルは読まれません。
  - `etc/gitattributes`(`diff=astextplain`)を読まないようにするには、`GIT_ATTR_NOSYSTEM=1` も要ります。
- **`/dev/null`。**
  - Git for Windows は、`/dev/null` を開くときに `nul` に読み替えます(`compat/mingw.c:956,1050,1079,1173`)。
  - そのため、いまの `GIT_CONFIG_GLOBAL=/dev/null` は Windows でも動きます。
  - `os.devNull`(Windows では `\\.\nul`)にはしません。Git for Windows が特別に扱うのは `/dev/null` と `nul` だけで、`\\.\nul` は予約名 NUL として開くのを拒み、設定を読むところで止まります。

### 設計

- **`git-windows.mjs` の手順。**
  1. zip をダウンロードし、ハッシュを確かめます。
  2. `resources/git/` に展開します。
  3. 使わない部分を消します。Git Credential Manager(`mingw64/bin/git-credential-manager*` とその DLL)、`mingw64/share/doc`、`mingw64/share/git-gui` などです。いまの macOS のビルドも、サーバーの部品を消しています。
  4. `VERSION` を書きます。
- **消してよいものの確かめ方。** 何を消してよいかは、Windows で `npm test` の git のテストを全部通して確かめます。
- **`gitPath()` の場所。** `gitPath()` は、macOS では `resources/git/bin/git`、Windows では `resources/git/mingw64/bin/git.exe` を返します。
  - Node(libuv)は、拡張子のない絶対パスにも `.com` と `.exe` を足して探します。そのため、拡張子を省いても起動はできます。
  - ただし、`fs.existsSync` で確かめる箇所と食い違わないように、拡張子まで書きます。
- **`gitEnv()` に足すもの(Windows)。**
  - `MSYSTEM` を消します。親の環境に `MSYSTEM` があると、git が PATH を整えないためです。
  - `GIT_ATTR_NOSYSTEM=1` を足します。
  - `core.longpaths=true` を、`GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_0`、`GIT_CONFIG_VALUE_0` で渡します。そうすれば、呼び出しのたびに `-c` を書かずに済みます。
  - 2026-09-27 に検証機で、530 文字のパスのファイルがジョブの worktree に取り出され、worktree を消せることを確かめました。長いパスのために、ほかに変えることはありません。
- **改行とシンボリックリンク。**
  - 利用者の git の `core.autocrlf`、`core.eol`、`core.symlinks` だけを、グローバルの段で引き継ぎます。理由と実測は ADR 0018 にあります。
  - Windows で「利用者の git」とするのは、PATH で最初に見つかる、同梱したものでない `git.exe` です。Git for Windows のインストーラーは、既定で `C:\Program Files\Git\cmd` をシステムの PATH に足すので、スタートメニューから開いた ASIST からも見つかります。
- **ライセンスの表記。**
  - `scripts/third-party-notices.mjs` の git の行(いまは `git/COPYING` を指す)は、Windows では `git/LICENSE.txt` と、ライブラリのライセンスのフォルダを指すようにします。
  - GPL の義務として、配布するときは、Git for Windows の同じタグのソースと、MSYS2 のパッケージのソースへの案内も添えます。

## uv

- **macOS。** いまのままです(0.12.18、`uv-aarch64-apple-darwin.tar.gz`)。
- **Windows で使うもの。**
  - 入手先は `https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-pc-windows-msvc.zip` です。
  - sha256 は `cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff` です(2026-09-27 に、ダウンロードしたファイルで確かめました)。
- **Windows の zip の中身。**
  - フォルダを持たない平らな zip で、`uv.exe`、`uvx.exe`、`uvw.exe` だけが入っています。
  - ライセンスのファイルは入っていないので、いまの macOS と同じく、タグから `LICENSE-MIT` と `LICENSE-APACHE` を取ります。`uvx.exe` と `uvw.exe` は使わないので入れません。
- **`uvPath()`。** Windows では `resources/uv/uv.exe` を返します。
- **uv と Python のバージョンの持ち方。** `uv.mjs` は、OS と CPU の組ごとの「アセットの名前とハッシュ」の表を1つ持ちます。バージョンは両方の OS で同じにします。

## Python の環境

- **Python の入手。** いまと同じく、uv が決まったバージョン(3.12.14)の Python を userData の下に取得します。
- **venv の Python の場所。** `uv.ts` に `venvPython(dir)` を置き、次の3か所の決め打ちをこれに替えます。
  - 場所は、macOS では `<dir>/bin/python`、Windows では `<dir>\Scripts\python.exe` です。
  - 替える3か所は `mlx-runtime.ts:47`、`vap.ts:168`、`onnx-runtime.ts:41` です。
- **Windows の venv の `python.exe` は、本物の Python を子として起動する小さなプログラムです。**
  - uv の trampoline と CPython の launcher は、どちらも子を `KILL_ON_JOB_CLOSE` の Job に入れます。そのため、ASIST が `python.exe` を止めれば、本物の Python も止まります。
  - ただし、Node が知っている PID は本物の Python の PID ではありません。PID を使う処理を書かないようにします。
- **worker の環境変数。** すべての worker に `PYTHONUTF8=1` を渡します。
  - Windows の Python は、パイプの文字コードに cp932 か cp1252 を使います。そのままでは、JSON に入った日本語を読み違えます。
  - macOS でも害はないので、OS で分けずに渡します。
- **worker の止め方。**
  - いまは、標準入力を閉じたあと 1 秒待ち、`kill('SIGTERM')` で止めています。
  - Windows では、SIGTERM は `TerminateProcess` になりますが、止めるきっかけは標準入力の EOF なので、このままでかまいません。
- **`vap_worker.py:215` の `os.nice(5)`。** Windows には `os.nice` がありません。`hasattr(os, 'nice')` で分けます。
  - Windows で優先度を下げる必要があるかは、MaAI の CPU の実測(M5)で決めます。
- **lock ファイル。**
  - いまの lock ファイル(`vap-requirements.txt`、`embedding-requirements.txt`)は、`--python-platform aarch64-apple-darwin` でコンパイルしています。
  - Windows 向けにコンパイルし直すと、違いは colorama(click と tqdm が Windows でだけ使う)の1つだけでした。
  - 2つの OS で使う lock は、`uv pip compile --universal` で1つにしました。固定したバージョンとハッシュは変わらず、増えたのは Windows だけの colorama と、Linux だけの torch の依存(`sys_platform == 'linux'`、macOS と Windows には入らない)です。
- **CUDA の実行環境。** CUDA の実行環境の lock は、Windows だけのファイルになります([05-speech.md](05-speech.md))。
