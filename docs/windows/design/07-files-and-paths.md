# パス、ファイルの書き込み、秘密の保存

## パス

### 方針

- **main のパスの扱い。** main では `node:path` の関数だけを使います。`/` で分けたり、`startsWith('/')` で絶対パスかを決めたりする処理はなくします。
- **renderer と shared のパスの扱い。** renderer と shared は `node:path` を使えないので、`src/shared/file-path.ts` を作ります。ここに、両方の書き方を扱う次の関数だけを置きます。
  - `isAbsolutePath`: `/`、`C:\`、`C:/`、`\\server\share` を絶対パスとみなします。
  - `baseName`、`dirName`: `/` と `\` の両方で分けます。
  - `trimTrailingSeparator`
- **テストの書き方。** テストは `path.posix` と `path.win32` の両方で書きます。main の関数は、テストから `path` の実装を差し込めるようにするか、`path.win32` の値を直接渡して確かめます。

### 直す場所

| 場所 | 直し方 |
|---|---|
| `file-preview.ts:21` `allowedPath` と `realPath` | `path.isAbsolute` で判定し、`path.parse(target).root` と `path.sep` で分けて組み立て直す。Windows では、許可したフォルダとの比較を大文字小文字を区別せずに行う。ドライブレターの後ろ以外に `:` を含むパスは拒む(NTFS の代替データストリーム `file.txt:stream` を読ませないため) |
| `file-protocol.ts:18,96-109` | URL は `asist-file:///C:/x/y.png` の形にする(`pathToFileURL(p).pathname` と同じ)。戻すときは `fileURLToPath` と同じ規則で、ドライブレターの前の `/` を取る。Node 24 の `pathToFileURL(p, { windows: true })` を使えば、Mac の上でも Windows の形をテストできる |
| `shared/agent-stream.ts:242` `artifactPaths` | `isAbsolutePath` を使う |
| `brain/job-tools.ts:183` `ABSOLUTE_PATH` | `isAbsolutePath` を使う |
| `shared/files.ts:78,101`、`shared/project-index.ts:29,73`、`services/project-index.ts:77`、`panel-fetchers.ts:246` | `baseName` と `trimTrailingSeparator` を使う |
| renderer の `JobLog.tsx`、`JobArtifacts.tsx`、`agent-job.tsx`、`CodeViewer.tsx` | `baseName`、`dirName`、`isAbsolutePath` を使う。`PptxViewer.tsx` の zip の中のパスは、どの OS でも `/` なので変えない |
| `settings.ts:57,60` の既定のフォルダ | `app.getPath('desktop' / 'documents' / 'downloads')` を使う。OneDrive にフォルダを移したマシンでも正しい場所になる |
| `ui/settings/pages/AgentPage.tsx:71` の入力例 `/Users/you/Desktop` | OS ごとの入力例にする(文言の辞書に入れる) |

### git が返すパス

- git は Windows でも `C:/Users/…` のように `/` でパスを返します。
- git から受け取ったパスは、必ず `path.resolve` と `fs.realpathSync.native` を通してから、比べたり保存したりします。Windows では、比べるときに大文字小文字を区別しません。
- 次の2つはこの手当てが要ります。
  - `memory-store.ts:78` の `git.toplevel(dir) !== dir` は、いまのままでは Windows で毎回違うと判定され、起動のたびに `git init` が走ります。
  - `agent.ts:386` の `projectIndex.noteUsed(git.toplevel(cwd))` と、`shared/project-index.ts:73-75` の重複の判定。
- `git.ts:128-136` の `resolvedAsFarAsExists` は、もともと `path.resolve` と `realpathSync` で比べています。Windows では、ここを `realpathSync.native` にします。JS の `realpathSync` は `RUNNER~1` のような短い名前を長い名前に戻さないためです。

### 記憶のページ

- **開き方。** `memory-store.ts:95` は `O_NOFOLLOW | O_NONBLOCK` で開いて、シンボリックリンクと FIFO を拒んでいます。Windows ではこの2つの値が `undefined` になり、黙って 0 になります。
  - Windows では、開く前に `lstat` でシンボリックリンクとジャンクションを拒みます。
  - 開いたあとは `fstat` の `ino` を `lstat` の `ino` と比べ、そのあいだに差し替えられていないことを確かめます。
- **ページの名前。** `shared/memory-page.ts:158` は `/\:*?"<>|` を拒んでいます。これに加えて、Windows の予約名(`CON`、`CONIN$`、`CONOUT$`、`PRN`、`AUX`、`NUL`、`COM1`〜`COM9`、`LPT1`〜`LPT9`)も拒みます。拡張子が付いていても予約名なので、`CON.md` も作れません。
  - 名前の末尾の `.` と空白は拒みません。ページのファイル名は必ず `.md` で終わるので、Windows で問題になりません。
  - この決まりは Mac でも同じにします。記憶のフォルダを別の OS に持っていっても開けるようにするためです。

## 置き換えの書き込み

- いまは、一時ファイルに書いてからリネームで置き換える処理が、8か所に別々にあります(`atomic-json.ts:39,52`、`encrypted-secrets.ts:92-94`、`settings.ts:106-108`、`store.ts:22`、`timers.ts:87-89`、`mail-drafts.ts:86-87`、`notes.ts:93-95`、`onnx-runtime.ts:137`)。
- 一時ファイルの名前は `${file}.tmp` で決まっているので、2つの書き込みが重なるとぶつかります。
- Windows のリネームは `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` です。置き換える先を別のプロセスが開いていると失敗します。開いているのは、ウイルス対策、検索のインデックス、OneDrive、バックアップのソフトなどです。

`atomic-json.ts` に、次の1つの関数を置き、8か所はそれを呼ぶ形にします。

- **一時ファイルの名前。** 同じフォルダに、書き込みごとに違う名前で作ります(`${file}.${process.pid}.${random}.tmp`)。
- **書き込みと置き換え。** 書き込んで `fsync` したあと、リネームで置き換えます。
- **Windows での再試行。**
  - Windows では、`EPERM`、`EBUSY`、`EACCES` のときだけ、合わせて約2秒まで間隔を空けて再試行します。
  - それでも失敗すれば、例外を投げます。
  - これは「一時的に失敗する操作の再試行」で、別の結果で置き換える fallback ではありません。
- **権限。** `mode: 0o600` は、Windows では意味を持ちません。
  - Windows では、`%APPDATA%` の下のファイルは、利用者のプロファイルのアクセス権で守られます。
  - 権限の値を確かめるテスト(`api-key-secrets.test.ts:74` など6件)は、POSIX だけで動かします。

## 秘密の保存

- **コードの変更。** safeStorage は差し込む形で使っているので、コードの変更は要りません。
- **DPAPI の性質。** Windows の safeStorage は DPAPI で、利用者ごとに鍵を守ります。
  - macOS のキーチェーンには、アプリごとのアクセス制御があります。DPAPI には、それがありません。
  - 同じ利用者で動くプロセスであれば、`%APPDATA%\ASIST\Local State` の鍵を `CryptUnprotectData` で取り出し、`api-keys.json` を読めます。
- **ADR 0006 への影響。** そのため、ADR 0006 の「ジョブにキーを渡さない」は、Windows では、プロンプトインジェクションを受けたジョブが自分で読みに行く場合を防げません。これを ADR の制約として書き足します。
- **開発中のアプリとインストールしたアプリ。** ADR 0006 には「開発中のアプリとインストールしたアプリでは鍵が違う」と書いてあります。
  - 開発中のアプリもインストールしたアプリも、userData は `%APPDATA%\asist` です。`package.json` の `name` が `asist` で、`productName` は `electron-builder.yml` にしかなく、アプリの中の `package.json` には入らないためです(Mac でも `~/Library/Application Support/asist` を共有しています)。
  - Windows の safeStorage の鍵は、userData の `Local State` に置かれます。そのため、開発中のアプリとインストールしたアプリが同じ鍵を使い、一方で保存したキーをもう一方で読めます。
  - macOS で鍵が違うのは、鍵がキーチェーンにあり、アプリの署名で読める相手が分かれるからです。
- **Electron 45 での変更。** safeStorage の同期の API は、Electron 45 で非推奨になり、46 で無くなります。非同期の API へ移す作業は、Windows とは別の PR で行います。
