"""Stands in for MaAI 0.2.18 when the tests run vap_worker.py. The input classes and MaaiMultiple's worker loop are
MaAI's own, so the worker's frame numbering meets what it meets in the app; the models are replaced by values read
from the audio of the frame, so a test can tell which frame each value was made from.

  - vap: p_now and p_future of the user are the last user sample of the frame, and so is p_bc_det.
  - bc and nod: every probability is the last assistant sample of the frame.

FAKE_MAAI_FIRST_FRAME_SEC delays the first result after the warm-up, so that a test can have all of its frames
arrive before any result. FAKE_MAAI_FRAME_SEC is the time every frame takes, as inference takes it in the app.
FAKE_MAAI_UNNUMBERED takes the frames from the queue without going through the input's get_audio_data, as a MaAI
that read its input another way would.
"""

import os
import queue
import threading
import time
import types


class _Base:
    """maai.input.Base: each subscriber gets its own queue of every chunk put in."""

    def __init__(self):
        self._subscriber_queues = []
        self._lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subscriber_queues.append(q)
        return q

    def _put_to_all_queues(self, data):
        with self._lock:
            for q in self._subscriber_queues:
                q.put(data)

    def get_audio_data(self, q=None):
        return q.get()

    def start(self):
        pass


class _Chunk(_Base):
    """maai.input.Chunk."""

    def put_chunk(self, chunk_data):
        self._put_to_all_queues([float(x) for x in chunk_data])


MaaiInput = types.SimpleNamespace(Chunk=_Chunk)


class MaaiMultiple:
    """maai.model.MaaiMultiple with its worker loop as in 0.2.18 and the inference replaced."""

    def __init__(self, configs, audio_ch1, audio_ch2, frame_rate, context_len_sec, device, **_options):
        self.labels = [config["label"] for config in configs]
        self.mic1 = audio_ch1
        self.mic2 = audio_ch2
        self._mic1_queue = audio_ch1.subscribe()
        self._mic2_queue = audio_ch2.subscribe()
        self.result_dict_queue = queue.Queue()
        self.list_process_time_context = []
        self._stop_event = threading.Event()
        self._worker_thread = None
        self._skip_first_output = True
        self._warm = False

    def _take(self, source, q):
        if os.environ.get("FAKE_MAAI_UNNUMBERED") == "1":
            return q.get()
        return source.get_audio_data(q)

    def worker(self):
        self._mic1_queue.queue.clear()
        self._mic2_queue.queue.clear()
        while not self._stop_event.is_set():
            x1 = self._take(self.mic1, self._mic1_queue)
            x2 = self._take(self.mic2, self._mic2_queue)
            if self._stop_event.is_set() or x1 is None or x2 is None:
                break
            self.process(x1, x2)
            if self._mic1_queue.qsize() > 100:
                self._mic1_queue.queue.clear()
            if self._mic2_queue.qsize() > 100:
                self._mic2_queue.queue.clear()

    def start(self):
        self._stop_event.clear()
        self._mic1_queue.queue.clear()
        self._mic2_queue.queue.clear()
        self._worker_thread = threading.Thread(target=self.worker, daemon=True)
        self._worker_thread.start()

    def stop(self, wait=True, timeout=2.0):
        self._stop_event.set()
        self._mic1_queue.put(None)
        self._mic2_queue.put(None)
        if wait and self._worker_thread is not None:
            self._worker_thread.join(timeout=timeout)

    def process(self, x1, x2):
        started = time.time()
        time.sleep(float(os.environ.get("FAKE_MAAI_FRAME_SEC", "0")))
        # MaAI skips the Mimi encoder's first output after a start and makes no result for that frame.
        if self._skip_first_output:
            self._skip_first_output = False
            return
        if not self._warm and x1[-1] != 0:
            self._warm = True
            time.sleep(float(os.environ.get("FAKE_MAAI_FIRST_FRAME_SEC", "0")))
        user = x1[-1]
        assistant = x2[-1]
        values = {
            "vap": {"p_now": [user, 1 - user], "p_future": [user, 1 - user]},
            "bcdet": {"p_bc_det": [user, 0.0]},
            "bc": {"p_bc_react": assistant, "p_bc_emo": assistant},
            "nod": {"p_nod_short": assistant, "p_nod_long": assistant},
        }
        result = {"t": time.time(), "x1": x1, "x2": x2}
        for label in self.labels:
            result[label] = values[label]
        self.list_process_time_context.append(time.time() - started)
        self.result_dict_queue.put(result)
