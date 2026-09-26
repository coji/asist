# ビルド、CI、テスト

## electron-builder

2026-09-27 に、`node_modules` の electron-builder 26.16.1 と Electron 43.1.0 の win32 の zip を使って確かめたことです。

- **Mac でのビルド。** `electron-builder --win --dir` は、Mac の上で Wine なしに動きます。
  - 実行ファイルのリソースの書き換えは、rcedit ではなく、JS の resedit で行います。
  - 証明書が無ければ、署名は飛ばします。
  - NSIS のインストーラーも Mac で作れます。
  - そのため、M2 で Windows のアプリの形(`win-unpacked`)を Mac で作り、中身の並びを確かめられます。確かめ方は、下の「ビルドする OS」に書きました。
  - 起動を確かめるのは Windows です。
- **ASAR の検査。** `enableEmbeddedAsarIntegrityValidation` は Windows でも効きます。
  - electron-builder が、`ASIST.exe` に ASAR の検査の値を埋め込みます。
  - Mac の上で、実際の手順(検査の値、fuse、リソースの書き換え)を Windows の `electron.exe` の写しに通したところ、値が残っていることを確かめました。
- **Mac の fuse の設定。** `resetAdHocDarwinSignature` は、`.app` のときしか動かないので、Windows では無害です。
- **無い `extraResources`。** `extraResources` の `from` が無いときは、警告を出して飛ばします(`fileMatcher.js:271-274`)。
  - そのため、いまの設定のままでも Windows のビルドは止まりません。
  - それでも、警告を読み飛ばす形は避けたいので、Mac のものは `mac.extraResources` に移します。
- **ライセンスのファイルの場所。** Electron と Chromium のライセンスは、Windows では `ASIST.exe` の隣に `LICENSE.electron.txt` と `LICENSES.chromium.html` として置かれます。`resources/` の中ではありません(Mac だけ `Contents/Resources` に移されます)。
  - `third-party-notices.mjs` は、同梱したプログラムのライセンスの場所を、ビルドする OS ごとに書き分けます。
  - Windows では、Electron のものは「`ASIST.exe` の隣、1つ上のフォルダ」、git のものは `git/LICENSE.txt` と、ライブラリのライセンスのフォルダ `git/mingw64/share/licenses` と `git/usr/share/licenses` を指します。
- **`--dir` のときの CPU。** `electron-builder --win --dir` は、設定の `target` の `arch` を使わず、ビルドするマシンの CPU で作ります(Apple Silicon の Mac では `win-arm64-unpacked` になりました)。そのため、`dist:win:dir` には `--x64` を付けます。
- **ビルドする OS。** 準備のスクリプトは、ビルドするマシンの git と uv を用意します。そのため、Mac で Windows のアプリを作ると、Mac の git と uv が入ってしまいます。
  - `electron-builder.yml` の `beforePack`(`scripts/before-pack.mjs`)が、作る OS と CPU がビルドするマシンと違えば、理由を出して止めます。Windows のアプリは Windows で、Mac のアプリは Mac で作ります。
  - `dist:win` と `dist:win:dir` も、Mac では `npm run build` のあとで止まります。
  - Mac で Windows のアプリの並びだけを確かめるときは、`node scripts/prepare-resources.mjs check --platform win32 --arch x64` で取得した git と uv を指し、`beforePack` を外した設定の写しを作って、`electron-builder --win --dir --x64 --config <写し>` を動かします。出来たものは配りません。
- **言語のファイル。** `electronLanguages` は、Windows では `locales/*.pak` を減らします。いまの11言語の指定で、12個のファイル(英語は en-US と en-GB)が残ります。
- **NSIS のインストール先。** 利用者ごとのワンクリックのインストールでは、`%LOCALAPPDATA%\Programs\asist\ASIST.exe` に入ります。

### 設定の形

```yaml
extraResources:            # 両方の OS で使うもの
  - LICENSE → LICENSE.txt
  - build/THIRD_PARTY_NOTICES.txt
  - resources/aizuchi、resources/skills
  - resources/uv、resources/git
  - resources/embedding_worker.py、aizuchi_worker.py、embedding-requirements.txt
  - resources/vap_worker.py、vap-requirements*.txt
  - resources/hf_snapshot.py

beforePack: ./scripts/before-pack.mjs   # ビルドするマシンと違う OS と CPU のアプリを作らない

mac:
  extraResources:
    - build/lproj
    - resources/native/macos/asist-calendar → asist-calendar
    - resources/native/macos/asist-mic → asist-mic
    - resources/mlx_asr_worker.py、qwen_tts_worker.py、mlx-audio-requirements.txt
  (いまの mac: の設定)

win:
  target: [{ target: nsis, arch: [x64] }]     # 確認用には --dir --x64
  icon: build/icon.png                        # 256px 以上の PNG から .ico を作る
  extraResources:
    - resources/native/windows/asist-agent-launcher.exe → asist-agent-launcher.exe
    - resources/cuda_asr_worker.py、cuda-speech-requirements.txt   # M5 で足す

nsis:
  oneClick: true
  perMachine: false
```

`package.json` には、`dist:win` と `dist:win:dir`(確認用)を足します。どちらも Windows でだけ動きます。いまの `dist:mac:unsigned` は `CSC_IDENTITY_AUTO_DISCOVERY=false` を前に付けていて、`cmd.exe` では動きません。ただし、Mac でしか使わないので、このままでかまいません。

**署名。** 当分は署名しません。証明書を入れるときは、`CSC_LINK` が `WIN_CSC_LINK` の代わりにも使われる(`platformPackager.js:84-88`)ことに気をつけます。Mac の署名のために `CSC_LINK` を設定していると、Windows でも署名しようとします。

## CI

| job | runner | すること |
|---|---|---|
| `test`(いまのまま) | macos-latest | typecheck、`i18n -- check`、`npm test` |
| `test-windows`(新規) | windows-latest | `npm run typecheck`、`npm test` |
| `fit`(いまのまま) | macos-latest | 文字が収まるか(macOS のフォント) |
| `build`(いまのまま) | macos-latest | `dist:mac:unsigned` と、中の git と uv の起動 |
| `build-windows`(新規) | windows-latest | `dist:win:dir`、中の `git.exe --version`、`uv.exe --version`、`asist-agent-launcher.exe` の自己診断、`ASIST.exe` を起動してすぐ終わる確認(ASAR の検査が通ること) |
| `result` | ubuntu | `needs` に新しい2つの job を足す |

- **`.github/actions/setup-app`。**
  - いまは、Electron のキャッシュの場所に `~/Library/Caches/electron` と `~/Library/Caches/electron-builder` を書いています。
  - Windows の場所 `~/AppData/Local/electron/Cache` と `~/AppData/Local/electron-builder/Cache` も並べて書きます。無い場所は無視されます。
- **同梱の道具のキャッシュ。** いまのキーは `hashFiles('scripts/build-git.sh', 'scripts/fetch-uv.sh')` です。これを `hashFiles('scripts/resources/**')` に替えます。キーには `runner.os` が入っているので、OS ごとに分かれます。
- **`asist-agent-launcher.exe` のビルド。** `windows-latest` には Visual Studio が入っているので、`native-windows.mjs` が `vswhere` で `cl.exe` を見つけてビルドします。
- **windows-latest の注意。**
  - windows-2025 のイメージには D ドライブがなく、ディスクの読み書きが遅めです。
  - Defender がファイルを調べるので、`npm ci` とテストが macOS より遅くなります。
  - まずは時間を測り、遅すぎれば Dev Drive を作ってその上で動かします。
- **いつから必須にするか。** `test-windows` と `build-windows` を `result` の `needs` に入れるのは、緑になってからにします。それまでは、PR ごとに結果を見るだけにします。
  - 入れる前から必須にすると、第0段階の途中の PR が全部止まります。
  - 必須にしないあいだは、「失敗が見えているのに通す」状態になります。そのため、この期間は第0段階の PR の間だけに限り、M2 の最後で必須にします。

## テスト

### Windows で動かさないテスト

POSIX に固有のことを確かめるテストは、`describe.runIf(process.platform !== 'win32')` にし、なぜ POSIX だけなのかをコメントに書きます。対になる Windows のテストがあるものは、それも書きます。

| テスト | 理由 | Windows で対になるもの |
|---|---|---|
| `agent-process-lifetime.test.ts:110,137`、`agent-crash-recovery.test.ts` のプロセスグループの部分 | プロセスグループと `ps` を確かめる | launcher と Job Object のテスト(M4) |
| `memory-store.test.ts:211`、`memory-service.test.ts:97` | `mkfifo` | なし(Windows に FIFO は無い)。シンボリックリンクを拒むテストは両方で動かす |
| 権限の値(`0o600`)を確かめる6件 | Windows に POSIX の権限は無い | なし |

### Windows でも動かすように直すテスト

| テスト | 直し方 |
|---|---|
| `#!/bin/sh` のフックを置くもの(`git-service.test.ts`、`agent-worktree.test.ts`) | MinGit の sh で動くはず。M3 で動かして確かめ、動かなければ原因を直す |
| シンボリックリンクを作るもの | Windows では開発者モードでないと作れない。CI の runner は管理者で動くので作れる。作れないマシンでは、テストを飛ばさずに「開発者モードが要る」と失敗させる |
| `uv-env.test.ts:26-27` | 期待値を `path.join` で作る |
| `file-preview.test.ts`、`file-protocol.test.ts` の一時フォルダのパスを使うもの | 実装を直せば通る。加えて `path.win32` の形のテストを足す |
| `file-preview.test.ts:86`(NFD と NFC) | NTFS は正規化しないので、期待する結果を OS ごとに決める |
| OS を差し替えて `darwin` のふりをするもの | capabilities を差し込む形にする([02-platform-capabilities.md](02-platform-capabilities.md)) |

### 一時フォルダ

- windows-latest の `%TEMP%` は `C:\Users\RUNNER~1\AppData\Local\Temp` のような短い名前です。
- git は長い名前でパスを返すので、比べると食い違います。
- 実装の側で `realpathSync.native` を通すのが本来の直し方です。テストの側では、`os.tmpdir()` を `realpathSync.native` してから使います。
