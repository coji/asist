---
title: 外へ送るもの
description: ASIST が外へ送るものと、外から受け取るもの。
sidebar:
  order: 2
---

ASIST が外へ送るものと、外から受け取るものの一覧です。ニュースや検索の結果のリンクを押したときは、その先を既定のブラウザで開きます。

## 会話と声

| 送り先 | 送るもの | 受け取るもの |
|---|---|---|
| 選んだ会話のモデルの提供元(Anthropic、OpenAI、Google、Cerebras) | 会話の文、プロンプト、記憶のうちその会話に関係する部分、ツールの結果 | 返事、ツールの呼び出し |
| 提供元の組み込みの Web 検索(Anthropic、OpenAI、Google) | 会話のモデルが決めた検索の語 | 検索の結果 |
| OpenAI か Google の Live API(声のエンジンに選んだときだけ) | マイクの音声、直近の履歴、ツールの結果 | 音声、転写 |
| codex か claude の CLI の先のサービス | ジョブのプロンプト、作業フォルダの中身のうち CLI が読んだもの、記憶の整理では会話ログ | 作業の結果 |

音声認識、声の区間の検出、相槌の判定、記憶の検索は、このコンピュータの中だけで動き、音声も文も外へ送りません。

## カードのデータ

| データ | 取得元 | 送るもの |
|---|---|---|
| 天気(地域が日本) | [気象庁](https://www.jma.go.jp/bosai/)の予報、アメダスの観測値、分布予報 | 予報区と観測所のコード |
| 天気(地域が日本以外) | [Open-Meteo](https://open-meteo.com) の予報とジオコーディング | 場所の名前、緯度と経度 |
| 世界時計の場所 | Open-Meteo のジオコーディング | 都市の名前 |
| 為替 | ExchangeRate-API(`open.er-api.com`) | 基準の通貨 |
| ニュース | Google ニュースの RSS | 話題の語、言語と地域 |
| 地図 | Google の Maps Embed API | 場所や経路の語 |

気象庁のデータは出典を表示し、加工していることを明記します([気象庁の利用規約](https://www.jma.go.jp/jma/kishou/info/coment.html))。Open-Meteo は CC BY 4.0 で、無料の API には非商用の利用と回数の上限(1 日 10,000 回など)があります。キーが無いので、回数は接続元の IP アドレスごとに数えられ、上限はアプリ全体ではなく 1 人ずつにかかります。

カードのデータとモデルの取得では、`ASIST/<バージョン> (https://github.com/nyosegawa/asist)` を User-Agent として送ります。

## あなたのアカウント

| データ | つなぐ先 | 備考 |
|---|---|---|
| メール | 設定したアカウントの IMAP と SMTP のサーバー | 取り込んだメールはこのコンピュータに置きます。 |
| カレンダー(macOS だけ) | macOS のカレンダー | Google や iCloud との同期は macOS が行います。ASIST はそれらのサービスに直接つなぎません。 |

## モデル、実行環境、更新の取得

| 取得するもの | 取得元 |
|---|---|
| このコンピュータで動かすモデル | Hugging Face(`huggingface.co`)。CPC の重みだけ `dl.fbaipublicfiles.com` |
| Python | 同梱の uv が、GitHub の python-build-standalone から取得し、ハッシュで確かめます。 |
| Python のパッケージ | 同梱の uv が PyPI から取得し、固定したハッシュで確かめます。Windows の音声認識に使う CUDA 版 PyTorch だけは `download.pytorch.org` から取得します。 |
| 新しいバージョンの ASIST(macOS) | GitHub の Release(`github.com/nyosegawa/asist`) |
