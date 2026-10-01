---
title: Memory requirements
description: How much memory the models that run on this computer use.
sidebar:
  order: 2
---

Each prepared model stays resident in a process of its own. The table below gives values measured on an M5 Mac (32GB). For searching the memory by meaning, choosing the kind of backchannel and detecting the end of a turn, it is the physical footprint from `vmmap --summary`, 30 seconds after launch. Speech recognition was measured running a Q8_0 model in llama.cpp b11246, and reading aloud running Irodori-TTS (F16) and Qwen3-TTS (Q8_0) in speech.cpp v0.3.0. Reading aloud was measured after it had read one sentence.

| Process | Model | Memory | Runs when | Measured on |
|---|---|---|---|---|
| Speech recognition | Qwen3-ASR 1.7B (Q8_0) | 3.4GB | At launch (when speech recognition is Qwen3-ASR 1.7B) | 2026-09-29 |
| Speech recognition | Qwen3-ASR 0.6B (Q8_0) | 1.8GB | At launch (when speech recognition is Qwen3-ASR 0.6B) | 2026-09-29 |
| Reading aloud | Irodori-TTS v4.1-Small-MF (F16) | 2.1GB | At launch (when reading aloud uses Irodori-TTS) | 2026-10-01 |
| Reading aloud | Qwen3-TTS 0.6B (Q8_0) | 1.8GB | At launch (when reading aloud uses Qwen3-TTS with the 0.6B model) | 2026-10-01 |
| Reading aloud | Qwen3-TTS 1.7B (Q8_0) | 2.8GB | At launch (when reading aloud uses Qwen3-TTS with the 1.7B model) | 2026-10-01 |
| Searching the memory by meaning | multilingual-e5 small (ONNX int8) | 655MB | At launch (when semantic search is on) | 2026-09-22 |
| Choosing the kind of backchannel | ModernBERT-ja 70m (ONNX int8) | 325MB | At launch (in Japanese, with backchannels on, and not with a Live engine) | 2026-09-20 |
| Detecting the end of a turn | MaAI (PyTorch) | 685MB | When the microphone is turned on (in Japanese, with MaAI on) | 2026-09-20 |

With Qwen3-ASR 1.7B for speech recognition and the other three running, they use about 5.1GB; with 0.6B for speech recognition, about 3.5GB. Choosing Irodori-TTS for reading aloud uses about 2.1GB more, and Qwen3-TTS about 1.8GB more with 0.6B and about 2.8GB more with 1.7B. The app itself and its window each use about 90MB.

On a Mac with 16GB of memory or more, ASIST recommends 1.7B for speech recognition, and the first-time setup recommends Irodori-TTS and Qwen3-TTS. With less than 16GB, it recommends 0.6B for speech recognition. The 1.7B size of Qwen3-TTS can be chosen on a Mac with 24GB of memory or more.

## Windows

On Windows, speech recognition and reading aloud (Irodori-TTS and Qwen3-TTS) load their models into the memory of a discrete GPU. Measured on a GeForce RTX 2080 (8GB) on 2026-09-29:

| Model | GPU memory |
|---|---|
| Qwen3-ASR 1.7B (Q8_0) | 3.2GB |
| Qwen3-ASR 0.6B (Q8_0) | 1.9GB |
| Irodori-TTS v4.1-Small-MF (F16) | 2.1GB (measured by speech.cpp, 2026-10-01) |
| Qwen3-TTS 0.6B (Q8_0) | 1.6GB |
| Qwen3-TTS 1.7B (Q8_0) | 2.7GB |

The Windows desktop uses the same GPU memory as well, 1.9GB at the time of the measurement. Together with the desktop, 1.7B speech recognition and 0.6B Qwen3-TTS took 6.7GB, and 7.7GB with 1.7B Qwen3-TTS. This is why ASIST recommends 1.7B for speech recognition with 6GB of GPU memory or more, and the first-time setup also recommends Irodori-TTS and Qwen3-TTS with 8GB or more. Irodori-TTS takes 0.5GB more than Qwen3-TTS 0.6B, so with 1.7B speech recognition and the desktop it should come to about 7.2GB. This combination has not been measured on Windows yet. Below 6GB, it recommends 0.6B for speech recognition. The 1.7B size of Qwen3-TTS can be chosen with 10GB of GPU memory or more.

Searching the memory by meaning, choosing the kind of backchannel and detecting the end of a turn run on the CPU and the main memory on Windows as well. Their memory use on Windows has not been measured yet.
