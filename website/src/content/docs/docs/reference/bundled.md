---
title: 同梱しているもの
description: アプリに同梱しているソフトウェアとデータ。
sidebar:
  order: 3
---

## ソフトウェア

| ソフトウェア | 入手先 | ライセンス |
|---|---|---|
| uv | Astral の GitHub のリリース。ハッシュで確かめてから同梱します。 | MIT か Apache-2.0 |
| git | Mac では kernel.org のソースの tarball。ハッシュで確かめてから、手元の操作に要る部分だけをコンパイルします。ソースには手を加えていません。Windows では Git for Windows が配る MinGit。ハッシュで確かめてから、ASIST が使わない部分を除いて同梱します。 | GPL-2.0 |
| llama.cpp の llama-server | ggml-org の GitHub のリリース。ハッシュで確かめてから同梱します。音声認識の Qwen3-ASR を動かします。Windows では、同じリリースに入っている LLVM の OpenMP のランタイムも同梱します。 | MIT(OpenMP のランタイムは Apache-2.0 with LLVM exception) |
| speech.cpp の speech-worker | [nyosegawa/speech.cpp](https://github.com/nyosegawa/speech.cpp) の GitHub のリリース。ハッシュで確かめてから同梱します。読み上げの Qwen3-TTS を動かします。 | MIT |

どれもライセンスの本文をアプリの中に入れています。git のソースは、各バージョンの [Release](https://github.com/nyosegawa/asist/releases) に同じバージョンの tarball を置いています。Windows の git については、同じバージョンの Git for Windows のソースを置いています。

## データ

| データ | 作り方 |
|---|---|
| 天気の地域の表(47 都道府県と 1,919 の市区町村、予報区と観測所の対応) | 気象庁の定数ファイルと、国土地理院の市区町村の一覧 |
| Qwen3-TTS の相槌の音声(9 つの声) | Qwen3-TTS で合成し、切り出して同梱しています。 |
| Live の声の見本 | 提供元の TTS で合成して同梱しています。 |

使っているモデルとデータのライセンスの一覧は、アプリの設定の「このアプリについて」でも見られます。
