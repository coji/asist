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
| Speech recognition (recommended on a Mac with 16GB of memory or more, and on Windows with 6GB of GPU memory or more) | Qwen3-ASR 1.7B (GGUF, Q8_0) | `ggml-org/Qwen3-ASR-1.7B-GGUF` | Apache-2.0 |
| Speech recognition (recommended with less memory) | Qwen3-ASR 0.6B (GGUF, Q8_0) | `ggml-org/Qwen3-ASR-0.6B-GGUF` | Apache-2.0 |
| Speech recognition (in the browser, as a backup) | Whisper small (ONNX, transformers.js) | `onnx-community/whisper-small` | MIT (OpenAI Whisper) |
| Voice activity detection | Silero VAD (ONNX, bundled) | Bundled | MIT |
| Microphone noise suppression | DeepFilterNet3 (ONNX, bundled) | Bundled | MIT or Apache-2.0 |
| Reading aloud | Qwen3-TTS 12Hz CustomVoice 0.6B and 1.7B (GGUF: the model in Q8_0, and the audio decoder in F16, shared by both sizes). Nine voices | `sakasegawa/qwen3-tts-ggml` (converted from the models Qwen published) | Apache-2.0 |
| End of turn and backchannel timing (MaAI, Japanese) | `vap_jp_kyoto`, `bc_det_jp`, `vap_bc_2type_jp` and `vap_nod_jp` from the MaAI team at Kyoto University. The encoder is Mimi from kyutai, and the CPC pretrained weights are from facebookresearch/CPC_audio | `maai-kyoto` on Hugging Face, `dl.fbaipublicfiles.com` | MIT (Mimi is CC BY 4.0) |
| Choosing the kind of backchannel (Japanese) | sbintuitions/modernbert-ja-70m fine-tuned on synthetic data (ONNX int8) | [sakasegawa/asist-aizuchi-ja](https://huggingface.co/sakasegawa/asist-aizuchi-ja) | MIT |
| Searching the memory by meaning | multilingual-e5 small (ONNX int8) | `Xenova/multilingual-e5-small` (converted from `intfloat/multilingual-e5-small`) | MIT |

Speech recognition and Qwen3-TTS run in llama.cpp and speech.cpp, which are bundled with the app. They use the GPU through Metal on a Mac and through Vulkan on Windows. The downloads are about 2.5GB for 1.7B speech recognition, about 1.0GB for 0.6B, about 1.2GB for Qwen3-TTS 0.6B and about 2.3GB for 1.7B. The bundled programs are listed in [What is bundled](/en/docs/reference/bundled/).

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
