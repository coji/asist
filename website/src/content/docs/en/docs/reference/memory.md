---
title: Memory requirements
description: How much memory the models that run on this computer use.
sidebar:
  order: 2
---

Each prepared model stays resident in a process of its own. The table below gives the physical footprint from `vmmap --summary`, measured 30 seconds after launch on an M5 Mac (32GB).

| Process | Model | Memory | Runs when | Measured on |
|---|---|---|---|---|
| Speech recognition | Qwen3-ASR 1.7B 8bit (MLX) | 2.4GB | At launch (when speech recognition uses MLX) | 2026-09-20 |
| Searching the memory by meaning | multilingual-e5 small (ONNX int8) | 655MB | At launch (when semantic search is on) | 2026-09-22 |
| Choosing the kind of backchannel | ModernBERT-ja 70m (ONNX int8) | 325MB | At launch (in Japanese, with backchannels on, and not with a Live engine) | 2026-09-20 |
| Detecting the end of a turn | MaAI (PyTorch) | 685MB | When the microphone is turned on (in Japanese, with MaAI on) | 2026-09-20 |

With all four running, they use about 4.1GB. Choosing Qwen3-TTS for reading aloud uses about 2GB more. The app itself and its window each use about 90MB.

## Windows

On Windows, speech recognition loads its model into the memory of the NVIDIA GPU. Measured on a GeForce RTX 2080 (8GB) on 2026-09-27, Qwen3-ASR 1.7B takes about 3.9GB and 0.6B about 1.6GB, and CUDA takes about 0.5GB on top of that. This is why 1.7B is recommended with 6GB of GPU memory or more, and 0.6B below that.

Searching the memory by meaning, choosing the kind of backchannel and detecting the end of a turn run on the CPU and the main memory on Windows as well. Their memory use on Windows has not been measured yet.
