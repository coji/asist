---
title: 使っているモデル
description: このコンピュータで動くモデルと、API で呼ぶモデル。
sidebar:
  order: 1
---

## このコンピュータで動くもの

取得するものは、どれもバージョンと sha256 を固定しています。

| 用途 | モデル | 取得元 | ライセンス |
|---|---|---|---|
| 音声認識(macOS、メモリが 16GB 以上なら勧める) | Qwen3-ASR 1.7B 8bit(MLX) | `mlx-community/Qwen3-ASR-1.7B-8bit` | Apache-2.0 |
| 音声認識(macOS、メモリが 16GB 未満なら勧める) | Whisper large-v3-turbo fp16(MLX) | `mlx-community/whisper-large-v3-turbo-asr-fp16` | MIT(OpenAI Whisper) |
| 音声認識(Windows、GPU のメモリが 6GB 以上なら勧める) | Qwen3-ASR 1.7B(CUDA 版 PyTorch と transformers) | `Qwen/Qwen3-ASR-1.7B-hf` | Apache-2.0 |
| 音声認識(Windows、GPU のメモリが 6GB 未満なら勧める) | Qwen3-ASR 0.6B(CUDA 版 PyTorch と transformers) | `Qwen/Qwen3-ASR-0.6B-hf` | Apache-2.0 |
| 音声認識(ブラウザの中、予備) | Whisper small(ONNX、transformers.js) | `onnx-community/whisper-small` | MIT(OpenAI Whisper) |
| 声の区間の検出 | Silero VAD(ONNX、同梱) | 同梱 | MIT |
| マイクの雑音の抑制 | DeepFilterNet3(ONNX、同梱) | 同梱 | MIT か Apache-2.0 |
| 読み上げ(macOS) | Qwen3-TTS 12Hz 0.6B CustomVoice 8bit(MLX)。9 つの声 | `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` | Apache-2.0 |
| 話し終わりと相槌の間合い(MaAI、日本語) | 京都大学 MaAI team の `vap_jp_kyoto`、`bc_det_jp`、`vap_bc_2type_jp`、`vap_nod_jp`。エンコーダは kyutai の Mimi、CPC の事前学習の重みは facebookresearch/CPC_audio | Hugging Face の `maai-kyoto`、`dl.fbaipublicfiles.com` | MIT(Mimi は CC BY 4.0) |
| 相槌の種類の判定(日本語) | sbintuitions/modernbert-ja-70m を合成データで fine-tune したもの(ONNX int8) | [sakasegawa/asist-aizuchi-ja](https://huggingface.co/sakasegawa/asist-aizuchi-ja) | MIT |
| 記憶の意味検索 | multilingual-e5 small(ONNX int8) | `Xenova/multilingual-e5-small`(`intfloat/multilingual-e5-small` を変換したもの) | MIT |

読み上げには、ほかに OS の音声合成(「macOS の音声合成」か「Windows の音声合成」)と、別のアプリとして動く VOICEVOX、AivisSpeech を使えます。VOICEVOX と AivisSpeech の声には、それぞれの利用規約があります。

## API で呼ぶもの

| 用途 | モデル | 提供元 |
|---|---|---|
| 会話、つなぎの一言、履歴の要約 | Claude Sonnet 5、Claude Haiku 4.5、Claude Opus 5 | Anthropic |
| 同上 | GPT-5.6 Luna、GPT-5.6 Terra、GPT-5.6 Sol | OpenAI |
| 同上 | Gemini 3.8 Flash、Gemini 3.5 Flash Lite | Google |
| 同上 | Qwen 3.8 27B、GPT OSS 120B | Cerebras |
| 声のエンジン | `gpt-live-1` | OpenAI |
| 声のエンジン | `gemini-3.8-live` | Google |

会話に選べるモデルの一覧と既定は [llm-catalog.ts](https://github.com/nyosegawa/asist/blob/main/src/shared/llm-catalog.ts) にあります。Agent のジョブと記憶の整理が使うモデルは、codex と claude の CLI が決めます。
