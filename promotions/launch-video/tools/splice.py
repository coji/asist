# /// script
# dependencies = ["librosa", "numpy"]
# ///
"""Scores splice points that skip whole phrases of the music, by how alike the harmony is on both sides.

A splice at video beat v jumps to music beat v + skip; the beats just before v in the video should
sound like the beats just before v + skip in the music, and likewise just after.
"""
import sys
from pathlib import Path

import librosa
import numpy as np

MUSIC = sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'assets/bgm/musicbox.mp3'

y, sr = librosa.load(MUSIC, sr=22050, mono=True)
P, T0 = 0.56605, 0.1309
hop = 256
chroma = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(y), sr=sr, hop_length=hop)
times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)
rms = librosa.feature.rms(y=y, hop_length=hop)[0]


def beat_chroma(b0, b1):
    m = (times >= T0 + b0 * P) & (times < T0 + b1 * P)
    v = chroma[:, m].mean(axis=1)
    return v / (np.linalg.norm(v) + 1e-9)


def loud(b0, b1):
    m = (times >= T0 + b0 * P) & (times < T0 + b1 * P)
    return 20 * np.log10(rms[m].mean() + 1e-9)


for skip in (8, 16, 24):
    for v in range(7, 88 - skip, 4):
        before = float(beat_chroma(v - 2, v) @ beat_chroma(v + skip - 2, v + skip))
        after = float(beat_chroma(v, v + 2) @ beat_chroma(v + skip, v + skip + 2))
        print(f'skip {skip:2d}  video beat {v} ({T0 + v * P:6.2f} s) -> music {T0 + (v + skip) * P:6.2f} s  '
              f'before {before:.3f}  after {after:.3f}  loudness {loud(v - 2, v):5.1f} / {loud(v + skip, v + skip + 2):5.1f} dB')
