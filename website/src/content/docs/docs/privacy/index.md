---
title: データの置き場所
description: ASIST がこのコンピュータのどこに何を置くか。
sidebar:
  order: 2
---

ASIST から開発者へ送るデータはありません。設定とデータは、次のフォルダにあります。アプリを入れ直しても消えません。

| OS | 設定とデータ | 動作ログ |
|---|---|---|
| macOS | `~/Library/Application Support/asist/` | `~/Library/Logs/asist/` |
| Windows | `%APPDATA%\asist\` | `%APPDATA%\asist\logs\` |

設定とデータのフォルダには、次のものがあります。

| 場所 | 中身 |
|---|---|
| `settings.json` | 設定 |
| `api-keys.json` | 暗号化した API キー |
| `memory/` | 記憶(Markdown、Git の履歴つき) |
| `conversations/` | 会話ログ |
| `tasks.json` | タスク |
| `notes/` | メモ(1 件が 1 つの Markdown ファイル) |
| `mail-cache.sqlite`、`mail-secrets.json` | 取り込んだメールと、暗号化したパスワード |
| `api-usage.json` | 有料の API の使用量と料金(日ごとの合計) |
| `joblogs/` | Agent のジョブのログ |
| `python/`、`uv-cache/` | uv が取得した Python と、パッケージのキャッシュ |
| `speech-models/` | 声の聞き取りと Qwen3-TTS のモデル |
| `embedding-runtime/`、`vap-runtime/` | 記憶の意味検索、相槌の種類の判定、MaAI が使う Python の環境 |

動作ログは、上の表の動作ログのフォルダに日ごとに残ります。

以前のバージョンの ASIST は、声の聞き取りと読み上げのために `mlx-audio-runtime/`(macOS)か `cuda-speech-runtime/`(Windows)に Python の環境を作り、モデルを Hugging Face の標準のキャッシュに取得していました。今のバージョンはどれも使わないので、削除できます。Hugging Face のキャッシュは macOS では `~/.cache/huggingface/hub/`、Windows では `%USERPROFILE%\.cache\huggingface\hub\` です。ほかのアプリも同じ場所を使うので、ASIST が取得した次のフォルダだけを削除します。

- `models--mlx-community--Qwen3-ASR-1.7B-8bit`
- `models--mlx-community--whisper-large-v3-turbo-asr-fp16`
- `models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit`
- `models--Qwen--Qwen3-ASR-1.7B-hf`
- `models--Qwen--Qwen3-ASR-0.6B-hf`

自動更新で取得した新しいバージョンのファイルは、macOS では `~/Library/Caches/asist-updater/`、Windows では `%LOCALAPPDATA%\asist-updater\` に置きます。Windows では、インストーラーの控えもここに置きます。どちらも、ASIST をアンインストールしても消えません。

## API キーとパスワード

設定で保存した API キーとメールのパスワードは、Electron の safeStorage で暗号化し、平文では書きません。暗号化が使えないときは保存せず、エラーにします。暗号化の鍵の守り方は、OS によって違います。

- macOS では、鍵をキーチェーンに置きます。ASIST 以外のアプリがその鍵を読もうとすると、macOS が確認を求めます。
- Windows では、鍵を Windows のユーザーに結び付けて DPAPI で暗号化し、設定とデータのフォルダの `Local State` に置きます。同じ Windows のユーザーで動くプログラムなら、どれでもこの鍵を解いて、保存したキーを取り出せます。この暗号化で防げるのは、ファイルだけがほかのユーザーやほかのコンピュータに渡った場合です。

Agent の CLI、Python のワーカー、音声のエンジンなどの子プロセスには、どの提供元の API キーも渡しません。

## 動作ログ

動作ログには、アプリの出力と、画面の警告とエラーが残ります。キー、トークン、パスワードの値と、保存した API キーは、書く前に伏せるので、不具合の報告にそのまま添えられます。会話の本文は書きません。14 日を過ぎたファイルは消し、1 日のファイルは 20MB までです。設定の「会話」の「動作ログ」から、このフォルダを開けます。

## 設定のファイルのバージョン

設定、タスク、タイマー、ジョブなどの JSON のファイルは、形式のバージョンを持ちます。ASIST を新しくして古いバージョンのファイルを開くと、元のファイルを `<名前>.v<バージョン>.json` として同じ場所に残してから、今の形式に移します。今の ASIST より新しい ASIST が書いたファイルや、壊れていて読めないファイルがあるときは、ファイルの場所と理由を表示して止まり、元のファイルには手を付けません。

外へ送るものは、[外へ送るもの](/docs/privacy/external/)にあります。

ASIST とこのサイトがデータをどう扱うかは、[プライバシーポリシー](/privacy/)にまとめています。
