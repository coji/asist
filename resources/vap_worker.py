"""The MaAI turn-taking worker.

Reads an interleaved float32le stream from stdin at 16 kHz with two channels (ch0 is the user's microphone,
ch1 is the assistant's TTS) and runs two pipelines on it incrementally.

  - vap: vap_jp_kyoto + bc_det, sharing the Mimi encoder (12.5 Hz = 80 ms frames, 20 s of context). It gives
    the turn-holding probabilities p_now / p_future and p_bc_det, the probability that a channel is
    producing a backchannel right now.
  - aux: bc_2type + nod, sharing the CPC encoder (10 Hz = 100 ms frames, 5 s of context). It gives the
    probability that a backchannel is due and the probability of a nod.

There are two pipelines because bc_2type and nod have no Mimi version, and MaaiMultiple can only bundle
models with the same encoder settings. In the vap-test evaluation the Mimi version of vap scored best
(AUC 0.873), and the CPU real-time factor is about 0.16 for vap plus 0.10 for aux.

Output, one line each on stdout with the ASIST_JSON: prefix, carrying the latest values per vap frame:
  {"type": "ready", "device": "cpu", "frameHz": 12.5}
  {"type": "state", "t": 12.3, "pNowUser": 0.9, "pNowAssistant": 0.1,
   "pFutureUser": 0.8, "pFutureAssistant": 0.2, "eotUser": 0.1, "bcDetUser": 0.02,
   "bcReact": 0.3, "bcEmo": 0.05, "nodShort": 0.2, "nodLong": 0.6, "inferMs": 9.5,
   "turnLagMs": 80, "backchannelLagMs": 0}
  {"type": "fatal", "error": "..."}

EOF on stdin stops the worker. All model and encoder weights arrive as local paths and the worker never
uses the network at run time; downloading and pinning them is the main process's job (vap.ts).
"""

import argparse
import json
import os
import queue
import sys
import threading
import time
import types

import numpy as np

PREFIX = "ASIST_JSON:"
SAMPLE_RATE = 16_000
WARMUP_SEC = 1.0
READY_TIMEOUT_SEC = 30.0

# A protocol line is written to the original stdout, a duplicate of fd 1, in a single write. MaAI prints
# its own logs from its own threads, so sharing Python's sys.stdout would interleave the lines. sys.stdout
# is pointed at stderr instead, and MaAI's logs end up in main as `vap: ...`.
PROTOCOL_FD = os.dup(1)
sys.stdout = sys.stderr


def emit(payload: dict) -> None:
    line = (PREFIX + json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
    # A write of at most PIPE_BUF, which is 512 bytes, is atomic on a pipe and cannot interleave with
    # another write.
    os.write(PROTOCOL_FD, line)


def fatal(message: str) -> None:
    emit({"type": "fatal", "error": message})
    # This exits immediately even while the reader thread still holds stdin.
    os._exit(1)


def stub_unused_modules() -> None:
    """maai imports microphone input (pyaudio) and playback (pygame) at import time. The worker uses neither
    and does not install them, so empty modules stand in."""
    for name in ("pyaudio", "pygame"):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)


class StereoFeeder:
    """Splits the interleaved f32le stream from stdin into two channels and feeds each pipeline chunks of
    exactly its frame length. Mimi's ONNX encoder accepts only a fixed-length input of one frame, so the
    data is re-cut here instead of being passed on in the sizes it arrives in."""

    def __init__(self, sinks: list) -> None:
        # sinks: [(ch0_input, ch1_input, chunk_samples), ...]
        self.sinks = sinks
        self.buffers = [np.zeros((0, 2), dtype=np.float32) for _ in sinks]
        self.pending = b""
        self.closed = False
        self.samples = 0

    def feed(self, chunk: bytes) -> None:
        data = self.pending + chunk
        usable = len(data) - (len(data) % 8)  # 2ch x 4byte
        self.pending = data[usable:]
        if usable == 0:
            return
        frames = np.frombuffer(data[:usable], dtype="<f4").reshape(-1, 2)
        self.push(frames[:, 0], frames[:, 1])

    def push(self, user: np.ndarray, assistant: np.ndarray) -> None:
        self.samples += len(user)
        frames = np.stack([user, assistant], axis=1)
        for index, (ch0, ch1, chunk) in enumerate(self.sinks):
            buffered = np.concatenate([self.buffers[index], frames])
            offset = 0
            while len(buffered) - offset >= chunk:
                ch0.put_chunk(buffered[offset:offset + chunk, 0])
                ch1.put_chunk(buffered[offset:offset + chunk, 1])
                offset += chunk
            self.buffers[index] = buffered[offset:]

    def run(self) -> None:
        # sys.stdin.buffer holds a lock that races with a daemon thread while the interpreter shuts down,
        # so the raw fd 0 is read instead.
        while True:
            chunk = os.read(0, 4096)
            if not chunk:
                self.closed = True
                return
            self.feed(chunk)


def build_pipelines(args):
    from maai import MaaiInput, MaaiMultiple

    class NumberedInput(MaaiInput.Chunk):
        """A channel that counts the frames put into it and, on MaAI's thread, notes the number of the frame MaAI
        took last. MaAI takes the frames in order but empties its queue once more than 100 wait, so the frame
        taken is the one counted before those still waiting."""

        def __init__(self):
            super().__init__()
            self.received = 0
            self.taken = 0

        def put_chunk(self, chunk_data):
            super().put_chunk(chunk_data)
            self.received += 1

        def get_audio_data(self, q=None):
            data = super().get_audio_data(q)
            self.taken = self.received - q.qsize()
            return data

    class FrameResults(queue.Queue):
        """MaAI's result queue, which pairs each result with the number of the frame it was made from. MaAI puts a
        result on the thread that took its frame, before that thread takes the next."""

        def __init__(self, source):
            super().__init__()
            self.source = source

        def put(self, item, block=True, timeout=None):
            super().put((self.source.taken, item), block, timeout)

    vap_in = (NumberedInput(), MaaiInput.Chunk())
    aux_in = (NumberedInput(), MaaiInput.Chunk())
    vap = MaaiMultiple(
        configs=[
            {"mode": "vap", "lang": "jp_kyoto", "label": "vap", "local_model": args.vap_model},
            {"mode": "bc_det", "lang": "jp", "label": "bcdet", "local_model": args.bc_det_model},
        ],
        audio_ch1=vap_in[0],
        audio_ch2=vap_in[1],
        frame_rate=args.vap_frame_rate,
        context_len_sec=args.vap_context,
        device="cpu",
        model_type="normal-ver2",
        use_mimi_onnx=True,
        mimi_onnx_precision="fp32",
        mimi_local_onnx_fp32_path=args.mimi_onnx,
        mimi_local_onnx_fp32_meta_path=args.mimi_meta,
        mimi_onnx_cpu_intra_threads=args.threads,
        mimi_onnx_cpu_inter_threads=1,
    )
    aux = MaaiMultiple(
        configs=[
            {"mode": "bc_2type", "lang": "jp", "label": "bc", "local_model": args.bc_model},
            {"mode": "nod", "lang": "jp", "label": "nod", "local_model": args.nod_model},
        ],
        audio_ch1=aux_in[0],
        audio_ch2=aux_in[1],
        frame_rate=args.aux_frame_rate,
        context_len_sec=args.aux_context,
        device="cpu",
        model_type="normal",
        cpc_model=args.cpc,
    )
    vap.result_dict_queue = FrameResults(vap_in[0])
    aux.result_dict_queue = FrameResults(aux_in[0])
    vap_chunk = int(round(SAMPLE_RATE / args.vap_frame_rate))
    aux_chunk = int(round(SAMPLE_RATE / args.aux_frame_rate))
    return vap, aux, [(vap_in[0], vap_in[1], vap_chunk), (aux_in[0], aux_in[1], aux_chunk)]


def drain(pipeline) -> tuple | None:
    """Empties the result queue and returns only the latest result, with the number of its frame."""
    latest = None
    while True:
        try:
            latest = pipeline.result_dict_queue.get_nowait()
        except queue.Empty:
            return latest


def lag_ms(source, frame: int, frame_rate: float) -> int:
    """How much newer audio had reached a pipeline than the frame its values were made from. MaAI queues its input
    without dropping any until more than 100 frames wait, so a pipeline slower than real time goes on sending
    values on time that are about older and older audio."""
    return round((source.received - frame) * 1000 / frame_rate)


def last_infer_ms(pipeline) -> float:
    times = getattr(pipeline, "list_process_time_context", None)
    if times:
        return round(float(times[-1]) * 1000, 1)
    return 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vap-model", required=True)
    parser.add_argument("--vap-frame-rate", type=float, required=True)
    parser.add_argument("--vap-context", type=float, required=True)
    parser.add_argument("--bc-det-model", required=True)
    parser.add_argument("--mimi-onnx", required=True)
    parser.add_argument("--mimi-meta", required=True)
    parser.add_argument("--bc-model", required=True)
    parser.add_argument("--nod-model", required=True)
    parser.add_argument("--aux-frame-rate", type=float, required=True)
    parser.add_argument("--aux-context", type=float, required=True)
    parser.add_argument("--cpc", required=True)
    parser.add_argument("--threads", type=int, default=1, help="torch / ONNX Runtime のスレッド数")
    args = parser.parse_args()

    for label, path in (
        ("vap model", args.vap_model),
        ("bc_det model", args.bc_det_model),
        ("mimi onnx", args.mimi_onnx),
        ("mimi meta", args.mimi_meta),
        ("bc model", args.bc_model),
        ("nod model", args.nod_model),
        ("cpc", args.cpc),
    ):
        if not os.path.exists(path):
            fatal(f"{label} not found: {path}")

    stub_unused_modules()
    try:
        import torch
    except Exception as error:  # noqa: BLE001
        fatal(f"torch unavailable: {error}")
        return
    # This lives beside the ASR and the noise suppression, which are workers on the renderer side. With
    # more threads, the spin-waiting of OpenMP and ONNX Runtime keeps the CPU busy, the renderer's Silero
    # VAD falls behind and utterances get dropped. One thread still finishes inside one 80 ms frame.
    torch.set_num_threads(args.threads)
    # The priority is lowered too. The conversation carries on without this estimate, which fails open,
    # while capturing the audio cannot be allowed to stall. Windows has no os.nice, and there the worker
    # keeps the normal priority.
    if hasattr(os, "nice"):
        try:
            os.nice(5)
        except OSError:
            pass

    try:
        vap, aux, sinks = build_pipelines(args)
        vap.start()
        aux.start()
    except Exception as error:  # noqa: BLE001
        fatal(f"model load failed: {error}")
        return

    feeder = StereoFeeder(sinks)
    (vap_source, _, _), (aux_source, _, _) = sinks

    # Warm-up: silence is pushed through and the first result awaited, so that the kernels are initialized
    # before ready.
    zeros = np.zeros(int(WARMUP_SEC * SAMPLE_RATE), dtype=np.float32)
    feeder.push(zeros, zeros)
    deadline = time.time() + READY_TIMEOUT_SEC
    warmup = None
    while time.time() < deadline and warmup is None:
        warmup = drain(vap)
        if warmup is None:
            time.sleep(0.05)
    if warmup is None:
        fatal("warmup produced no output")
        return
    # A result numbered 0 was made from a frame MaAI did not take through NumberedInput, as after a change in how it
    # reads its input. Every lag would then count from before the first frame, and no estimate would ever be used.
    if warmup[0] == 0:
        fatal("warmup result carries no frame number")
        return
    drain(aux)

    threading.Thread(target=feeder.run, daemon=True).start()
    emit({"type": "ready", "device": "cpu", "frameHz": args.vap_frame_rate})

    bc = {"p_bc_react": 0.0, "p_bc_emo": 0.0}
    nod = {"p_nod_short": 0.0, "p_nod_long": 0.0}
    # Frame 0 is before any audio, so these zeros count as old until aux sends its first values.
    aux_frame = 0
    emitted = 0
    while True:
        if feeder.closed:
            vap.stop(wait=False)
            aux.stop(wait=False)
            os._exit(0)
        try:
            frame, result = vap.result_dict_queue.get(timeout=0.1)
        except queue.Empty:
            continue
        # vap runs at 12.5 Hz and aux at 10 Hz, so the newest aux value rides along, with its own lag.
        aux_result = drain(aux)
        if aux_result is not None:
            aux_frame, aux_values = aux_result
            bc = aux_values["bc"]
            nod = aux_values["nod"]
        out = result["vap"]
        p_now = out["p_now"]
        p_future = out["p_future"]
        # p_bc_det is the probability that an aizuchi is being made right now, as
        # [ch0 = user, ch1 = assistant].
        bc_det = result["bcdet"]["p_bc_det"]
        emitted += 1
        emit(
            {
                "type": "state",
                # The total seconds of audio processed. MaAI's own t is wall-clock time and is not used.
                "t": round(emitted / args.vap_frame_rate, 2),
                "pNowUser": round(float(p_now[0]), 4),
                "pNowAssistant": round(float(p_now[1]), 4),
                "pFutureUser": round(float(p_future[0]), 4),
                "pFutureAssistant": round(float(p_future[1]), 4),
                "eotUser": round(1.0 - float(p_now[0]), 4),
                "bcDetUser": round(float(bc_det[0]), 4),
                "bcReact": round(float(bc["p_bc_react"]), 4),
                "bcEmo": round(float(bc["p_bc_emo"]), 4),
                "nodShort": round(float(nod["p_nod_short"]), 4),
                "nodLong": round(float(nod["p_nod_long"]), 4),
                "inferMs": last_infer_ms(vap),
                "turnLagMs": lag_ms(vap_source, frame, args.vap_frame_rate),
                "backchannelLagMs": lag_ms(aux_source, aux_frame, args.aux_frame_rate),
            }
        )


if __name__ == "__main__":
    main()
