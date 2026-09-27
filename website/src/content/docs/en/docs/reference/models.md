---
title: Models ASIST uses
description: The models that run on this computer, and the models called over an API.
sidebar:
  order: 1
---

## Models that run on this computer

Everything that is downloaded is pinned to a version and a sha256.

| Use | Model | Source | License |
|---|---|---|---|
| Speech recognition (macOS, recommended with 16GB of memory or more) | Qwen3-ASR 1.7B 8bit (MLX) | `mlx-community/Qwen3-ASR-1.7B-8bit` | Apache-2.0 |
| Speech recognition (macOS, recommended with less than 16GB of memory) | Whisper large-v3-turbo fp16 (MLX) | `mlx-community/whisper-large-v3-turbo-asr-fp16` | MIT (OpenAI Whisper) |
| Speech recognition (Windows, recommended with 6GB of GPU memory or more) | Qwen3-ASR 1.7B (CUDA build of PyTorch with transformers) | `Qwen/Qwen3-ASR-1.7B-hf` | Apache-2.0 |
| Speech recognition (Windows, recommended with less than 6GB of GPU memory) | Qwen3-ASR 0.6B (CUDA build of PyTorch with transformers) | `Qwen/Qwen3-ASR-0.6B-hf` | Apache-2.0 |
| Speech recognition (in the browser, as a backup) | Whisper small (ONNX, transformers.js) | `onnx-community/whisper-small` | MIT (OpenAI Whisper) |
| Voice activity detection | Silero VAD (ONNX, bundled) | Bundled | MIT |
| Microphone noise suppression | DeepFilterNet3 (ONNX, bundled) | Bundled | MIT or Apache-2.0 |
| Reading aloud (macOS) | Qwen3-TTS 12Hz 0.6B CustomVoice 8bit (MLX). Nine voices | `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` | Apache-2.0 |
| End of turn and backchannel timing (MaAI, Japanese) | `vap_jp_kyoto`, `bc_det_jp`, `vap_bc_2type_jp` and `vap_nod_jp` from the MaAI team at Kyoto University. The encoder is Mimi from kyutai, and the CPC pretrained weights are from facebookresearch/CPC_audio | `maai-kyoto` on Hugging Face, `dl.fbaipublicfiles.com` | MIT (Mimi is CC BY 4.0) |
| Choosing the kind of backchannel (Japanese) | sbintuitions/modernbert-ja-70m fine-tuned on synthetic data (ONNX int8) | [sakasegawa/asist-aizuchi-ja](https://huggingface.co/sakasegawa/asist-aizuchi-ja) | MIT |
| Searching the memory by meaning | multilingual-e5 small (ONNX int8) | `Xenova/multilingual-e5-small` (converted from `intfloat/multilingual-e5-small`) | MIT |

For reading aloud, you can also use the system's voice ("macOS voice" or "Windows voice"), or VOICEVOX and AivisSpeech, which run as separate apps. The VOICEVOX and AivisSpeech voices each have their own terms of use.

## Models called over an API

| Use | Model | Provider |
|---|---|---|
| Conversation, bridge phrase, history summary | Claude Sonnet 5, Claude Haiku 4.5, Claude Opus 5 | Anthropic |
| Same as above | GPT-5.6 Luna, GPT-5.6 Terra, GPT-5.6 Sol | OpenAI |
| Same as above | Gemini 3.8 Flash, Gemini 3.5 Flash Lite | Google |
| Same as above | Qwen 3.8 27B, GPT OSS 120B | Cerebras |
| Voice engine | `gpt-live-1` | OpenAI |
| Voice engine | `gemini-3.8-live` | Google |

The list of models you can choose for the conversation, and the default, is in [llm-catalog.ts](https://github.com/nyosegawa/asist/blob/main/src/shared/llm-catalog.ts). The codex and claude CLIs decide which models Agent jobs and memory curation use.
