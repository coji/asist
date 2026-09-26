# ウィンドウ、トレイ、ショートカット、通知、許可、文言

## ウィンドウ(`src/main/window-chrome.ts`)

いまは `index.ts:53-54` で `titleBarStyle: 'hiddenInset'` と `trafficLightPosition` を指定しています。Windows でこのままにすると、閉じる、最小化、最大化のボタンが無いウィンドウになります。

- **タイトルバー。** Windows では `titleBarStyle: 'hidden'` と `titleBarOverlay` を使います。
  - これで、画面の右上に Windows のボタンだけが重なります。
  - ボタンの背景と記号の色は、テーマの色に合わせる必要があります。AGENTS.md のとおり、色はテーマのトークン(`src/renderer/src/assets/themes.css`)から取ります。
  - main は CSS を読めないので、renderer がテーマを切り替えたときに計算済みのトークンの値を IPC で送ります。main はその値で `setTitleBarOverlay` を呼びます。
- **ドラッグできる帯と左の余白。** いまは、上の帯(`main.css:147-153`)の左に、信号機のボタンのための 96px の余白(`main.css:191-192`)を取っています。
  - renderer は、capabilities の `os` を `document.documentElement.dataset.os` に入れます。
  - Windows では左の余白をなくし、右に `env(titlebar-area-width)` から求めた余白を取ります。
- **アプリのメニュー。** Windows では `Menu.setApplicationMenu(null)` にします。
  - Electron の既定のメニュー(File、Edit、View…)は、タイトルバーを隠すと見えません。それでも Alt キーで開いてしまいます。
  - 文字の欄でのコピーと貼り付けは、メニューが無くても Chromium が扱います。
- **この処理を置く場所。** `window-chrome.ts` は、OS ごとの `BrowserWindow` の設定とメニューを返す関数だけを持ちます。`index.ts` はそれを受け取るだけにします。

## トレイ

- いまのアイコンは、`os-integration.ts:24-26` に埋め込んだ 18×18 の黒一色のテンプレート画像です。macOS のメニューバーのための形なので、Windows の暗いタスクバーでは見えません。
- Windows では、色のついた 16px と 32px の入った `.ico` を使います。元の絵(`resources/artwork/`)から、`scripts/gen-icon.py` で作ります。
- 左クリックでウィンドウを出し、右クリックでメニューを出す動きは、いまのままで Windows でも同じです。

## グローバルショートカット

- `Alt+Space`(`os-integration.ts:95-97`)は、Windows ではウィンドウのシステムメニューと PowerToys Run が使っています。
- ショートカットの値を capabilities の `hotkey` にし、OS ごとに既定の値を決めます。Windows の候補は `Ctrl+Alt+Space` ですが、これは実機で他のアプリとぶつからないかを確かめてから決めます。
- 画面の「⌥Space」(`settings-voice.ts:641`)は、値から表記を作ります。Mac では `⌥Space`、Windows では `Ctrl+Alt+Space` になります。
- 登録に失敗したときは、いまは `console.warn` だけです(`os-integration.ts:106`)。これを、設定の画面に失敗として出すように変えます。この変更は Mac でも同じです。

## 通知

- Windows の通知(トースト)は、スタートメニューのショートカットに付いた AppUserModelID と、アプリの `app.setAppUserModelId` の値が一致しないと出ません。
- 起動の最初に、Windows では `app.setAppUserModelId('com.nyosegawa.asist')`(`electron-builder.yml` の `appId`)を呼びます。ショートカットは NSIS のインストーラーが作ります。
- 開発中のアプリ(`npm run dev`)では、ショートカットが無いので通知は出ません。これは開発の手順(development.md)に書きます。
- 「この Mac は通知を表示できません」(`app.ts:146`)の文言は、OS に依らない言い方にします。

## マイクの許可

- いまの `ipc.ts:225-230` は、macOS 以外では許可を確かめずに `true` を返します。
- Windows では、`systemPreferences.getMediaAccessStatus('microphone')` で「デスクトップ アプリがマイクにアクセスできるようにする」の設定を読みます。
- Windows はアプリから許可を求められないので、拒否されているときは設定を開くボタンを出します。
- 設定を開くリンクは、OS ごとに `x-apple.systempreferences:…Privacy_Microphone` と `ms-settings:privacy-microphone` を使い分けます(`ipc.ts:204`)。カレンダーの許可のリンク(`ipc.ts:429`)は、Windows では出しません。

## 終了と、Windows のサインアウト

- ウィンドウを閉じると隠れるだけで、終了はトレイから行う、という動きはいまのままです。
- 終了のときに `before-quit` を止めてエージェントを止める処理(`os-integration.ts:43-58`)も、いまのままです。
- Windows のサインアウトやシャットダウンでは、`session-end` が来たあと、Windows がアプリを止めます。
  - エージェントは Job Object と制御のパイプで守られていて、ASIST が止められれば、launcher が子孫をまとめて止めます([03-agent-process.md](03-agent-process.md))。
  - そのため、`session-end` では待たずに終わってかまいません。

## フォント

- いまの並びは、`'Avenir Next', -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif` と、等幅の `ui-monospace, 'SF Mono', Menlo, monospace`、pop のテーマの `ui-rounded, 'Hiragino Maru Gothic ProN'` です。
- Windows のフォントを足します。
  - 本文: `'Segoe UI Variable', 'Segoe UI', 'Yu Gothic UI', 'Meiryo UI'`
  - 等幅: `'Cascadia Mono', Consolas`
- 文字が収まるかを確かめる `demo:fit` は、macOS のフォントで測っています。Windows のフォントでは折り返しが変わるので、Windows でも測る必要があります。CI の Windows の runner に日本語のフォント(Yu Gothic)が入っているかは未確認です([06-open-questions.md](../06-open-questions.md))。

## 画面の文言

- **件数。** Mac を前提にした文言は、英語で82件あり、11言語で同じ数です。
- **主な場所。**
  - `setup.ts`、`settings-voice.ts`、`settings-models.ts`、`files.ts`
  - `calendar.ts`(カレンダーは Windows では出さないので、そのままでよい)
  - `settings-conversation.ts`、`settings-about.ts`、`voice-engines.ts`
  - 会話のモデルへの文(`brain/prompt.ts:238,241` の「この Mac のタイムゾーン」)
- **書き分けの方針。**
  - **OS の部品の名前を出すもの**(Finder とエクスプローラー、システム設定と Windows の設定、`~/Library/Logs` と `%APPDATA%\ASIST\logs`)は、OS ごとのキーを作ります。renderer は capabilities の `os` で選び、main はプロセスの OS で選びます。
  - **「この Mac」のように機械を指すだけのもの**は、OS に依らない言い方にします。例えば「このパソコン」「this computer」です。
  - **モデルへの文**は、`PromptText` の `{ ja, en }` を OS に依らない言い方にします。
- **進め方。** `ui-text` スキルに従い、11言語を同じ変更で直し、`npm run i18n -- check` と `demo:fit` で確かめます。

## カレンダー

保留です。Windows では capabilities の `calendar` を `false` にし、ツール、カード、設定、要約から外します。どの方法で作るか(CalDAV、Google Calendar API など)を決めたら、`CalendarService` の差し込み口(`calendar-service.ts:20-27` の `native(input)`)に新しい実装を渡します。

- **差し込み口の形。** 差し込み口は、EventKit の許可の状態(`notDetermined | denied | restricted | writeOnly | fullAccess`)と、予定のリビジョン(変更の衝突を見つけるための値)を前提にしています。
- **別の方法の場合。** 別の方法では、次の2つの対応を決める必要があります。
  - 許可の状態を、その方法の何に当てはめるか
  - リビジョンに、ETag や changeKey を使うか
