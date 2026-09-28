#!/usr/bin/env python3
"""ASIST-owned JSON-lines worker for pinned Qwen3-ASR models on an NVIDIA GPU, through transformers."""

from __future__ import annotations

import json
import os
import sys
import traceback
import wave

# CUDA numbers the GPUs fastest first unless told otherwise, while nvidia-smi lists them by PCI bus.
# With the same order on both sides, the first GPU of compute capability 7.5 or higher that the worker
# picks is the one main read from nvidia-smi.
os.environ["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"

import numpy as np
import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor

PREFIX = "ASIST_JSON:"
SAMPLE_RATE = 16000

# Runs the model on the CPU in float32, so that the protocol and the transcriptions can be checked on a
# machine without an NVIDIA GPU while developing this worker. ASIST never sets it.
CPU_FOR_DEVELOPMENT = "ASIST_CUDA_ASR_ON_CPU"


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def choose_device() -> tuple[torch.device, torch.dtype]:
    if os.environ.get(CPU_FOR_DEVELOPMENT) == "1":
        return torch.device("cpu"), torch.float32
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available: no NVIDIA GPU, or its driver is older than CUDA 13.0 needs")
    capabilities = [torch.cuda.get_device_capability(index) for index in range(torch.cuda.device_count())]
    usable = [index for index, capability in enumerate(capabilities) if capability >= (7, 5)]
    if not usable:
        found = ", ".join(f"{major}.{minor}" for major, minor in capabilities)
        raise RuntimeError(f"no GPU of compute capability 7.5 or higher (found {found})")
    index = usable[0]
    # Turing (7.5) has no bfloat16 arithmetic, so it runs in float16.
    dtype = torch.bfloat16 if capabilities[index] >= (8, 0) else torch.float16
    return torch.device("cuda", index), dtype


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as audio:
        form = (audio.getnchannels(), audio.getsampwidth(), audio.getframerate())
        if form != (1, 2, SAMPLE_RATE):
            raise ValueError(f"expected a 16 kHz mono 16-bit WAV, got {form[0]} channels, {form[1] * 8}-bit, {form[2]} Hz")
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def main() -> int:
    if len(sys.argv) != 3:
        emit({"type": "fatal", "error": "expected model reference and revision"})
        return 2

    model_ref, revision = sys.argv[1:]
    try:
        device, dtype = choose_device()
        kwargs = {} if revision == "-" else {"revision": revision}
        processor = AutoProcessor.from_pretrained(model_ref, **kwargs)
        # device_map would load straight onto the GPU but requires accelerate, which the lock leaves out.
        model = AutoModelForMultimodalLM.from_pretrained(model_ref, dtype=dtype, **kwargs).to(device).eval()
        emit({"type": "ready", "device": str(device), "dtype": str(dtype)})
    except Exception as error:
        emit({"type": "fatal", "error": str(error)})
        traceback.print_exc(file=sys.stderr)
        return 1

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            # The caller sends the language as the English name Qwen3-ASR was trained with, which the
            # processor writes into the prompt so that the model generates only the transcription.
            inputs = processor.apply_transcription_request(
                audio=read_wav(str(request["wavPath"])),
                language=str(request["language"]),
            ).to(model.device, model.dtype)
            # The pinned revision's generation_config.json sets greedy decoding and 512 new tokens.
            with torch.inference_mode():
                output = model.generate(**inputs)
            text = processor.decode(output[:, inputs["input_ids"].shape[1]:], return_format="transcription_only")[0]
            emit({"type": "result", "id": request_id, "text": text.strip()})
        except Exception as error:
            request_id = str(request.get("id", "")) if "request" in locals() else ""
            emit({"type": "error", "id": request_id, "error": str(error)})
            traceback.print_exc(file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
