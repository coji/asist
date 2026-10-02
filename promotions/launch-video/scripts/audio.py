# /// script
# dependencies = ["numpy"]
# ///
"""Mixes the background music and the sound effects for the video into out/audio.wav.

The effects are placed at the cues that render.mjs wrote to out/cues.json. Each cue names what
happens on screen; KIND below maps it to a kind of sound in sfx.py (clay pattern).

The music plays through to its own last chord, but jumps ahead by whole beats at one beat of the
video, to the same place in its phrase. The timeline (MUSIC in js/core.js) says where and how far,
and render.mjs writes that into cues.json. The jump is aligned on the note onsets found on both sides.

  uv run scripts/audio.py
  uv run scripts/audio.py --sfx-db -12 --out out/audio-quiet.wav
"""
import argparse
import json
import subprocess
import wave
from pathlib import Path

import numpy as np

import sfx

ROOT = Path(__file__).resolve().parent.parent
SR = sfx.SR
BEAT = 0.56605
T0 = 0.1309
ap = argparse.ArgumentParser()
ap.add_argument('--bgm', default='assets/bgm/musicbox.mp3')
ap.add_argument('--sfx-db', type=float, default=-9, help='overall level of the effects in dB, added to the per-kind levels in sfx.py')
ap.add_argument('--out', default='out/audio.wav')
args = ap.parse_args()

# A cue of the timeline maps to (kind of sound, extra gain in dB). None is silent on purpose.
KIND = {
    'voice': ('voice', 0), 'reply': ('reply', 0), 'jump': ('jump', 0), 'land': ('land', 0),
    'card': ('card', -2), 'deal': ('deal', -2), 'open': ('open', 0), 'close': ('close', 0), 'fly': ('fly', 0),
    'pop': ('appear', -2), 'dialog': ('appear', 0), 'cli': ('appear', -1), 'badge': None, 'logo': ('appear', 1),
    'whoosh': ('transition', 3), 'swoosh': ('transition', 3), 'zoom': ('transition', 2), 'night': ('transition', 2),
    'type': ('chime', -5), 'chip': ('chime', -3), 'count': ('chime', -2), 'progress': ('cascade', 0),
    'marker': ('hand', -2), 'note': ('hand', 0),
    # The six labels of the Dock come on consecutive eighth notes. Pencil sounds that close together blur
    # into a scratch, so each label plays one note of a rising kalimba run from the music-box pattern.
    'label': ('musicbox:hand', -6),
    'tap': ('click', 0), 'click': ('click', 0),
    'done': ('done', 0), 'clock': ('clock', 0), 'write': ('write', 0), 'morning': ('morning', 0), 'cta': ('cta', 0),
    'sparkle': None, 'cursor': None,
}

meta = json.loads((ROOT / 'out/cues.json').read_text())
DUR = meta['duration']
SPLICE, SKIP = meta['music']['splice'], meta['music']['skip']
N = int(DUR * SR)
fx = np.zeros((N, 2))
pan_rng = np.random.default_rng(5)

for c in meta['cues']:
    entry = KIND[c['type']]
    if entry is None:
        continue
    kind, gain = entry
    # A kind may name its pattern, as in 'musicbox:hand'; the rest use the clay pattern.
    pattern, kind = kind.split(':') if ':' in kind else ('clay', kind)
    n = int(c.get('n', 6))
    dur = float(c.get('dur', 0.5))
    if kind in ('cascade', 'chime'):
        n = max(2, min(n, 11 if c['type'] == 'count' else 7))
    sig = sfx.make(pattern, kind, c.get('i', 0), n, dur) * 10 ** ((args.sfx_db + gain) / 20)
    start = c['t'] - (0.08 if kind == 'transition' else 0)
    i = max(0, int(start * SR))
    sig = sig[: N - i]
    pan = pan_rng.uniform(-0.25, 0.25)
    fx[i : i + len(sig), 0] += sig * np.sqrt(1 - pan)
    fx[i : i + len(sig), 1] += sig * np.sqrt(1 + pan)

# The music is decoded at a fixed loudness, so the effects always sit at the same place under it.
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(ROOT / args.bgm), '-af', 'loudnorm=I=-22:TP=-3',
                      '-ar', str(SR), '-ac', '2', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
bgm = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)


def onset_near(x, t, window=0.09):
    """The time of the strongest rise in energy within window seconds of t (10 ms frames)."""
    hop = int(0.005 * SR)
    a = int((t - window - 0.05) * SR)
    seg = x[a : a + int((2 * window + 0.1) * SR)].mean(axis=1)
    frames = np.lib.stride_tricks.sliding_window_view(seg, 2 * hop)[::hop]
    e = np.log(np.maximum((frames ** 2).mean(axis=1), 1e-12))
    rise = np.diff(e)
    times = a / SR + (np.arange(len(rise)) + 1) * hop / SR
    ok = np.abs(times - t) <= window
    return float(times[ok][np.argmax(rise[ok])])


music = np.zeros((N, 2))
if SKIP == 0:
    music[: min(N, len(bgm))] = bgm[:N]
else:
    tv = onset_near(bgm, T0 + SPLICE * BEAT)
    tm = onset_near(bgm, T0 + (SPLICE + SKIP) * BEAT)
    print(f'splice: video {tv:.3f} s <- music {tm:.3f} s (skips {tm - tv:.3f} s)')
    # An equal-power crossfade of 40 ms ends 15 ms before the onset, so the new note starts clean.
    xf0 = tv - 0.055
    xf = int(0.04 * SR)
    a = int(xf0 * SR)
    music[:a] = bgm[:a]
    k = np.linspace(0, np.pi / 2, xf)[:, None]
    off = int((tm - tv) * SR)
    music[a : a + xf] = bgm[a : a + xf] * np.cos(k) + bgm[a + off : a + off + xf] * np.sin(k)
    rest = bgm[a + off + xf :][: N - a - xf]
    music[a + xf : a + xf + len(rest)] = rest

mix = music + fx
fade = np.ones(N)
fade[: int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
tail = int(0.5 * SR)
fade[-tail:] = np.linspace(1, 0, tail) ** 1.5
mix *= fade[:, None]
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
mix *= 0.89 / np.abs(mix).max()

pcm = (mix * 32767).astype('<i2')
with wave.open(str(ROOT / args.out), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', args.out)
