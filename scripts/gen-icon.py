#!/usr/bin/env python3
"""Builds the app's eight icons, the macOS icon with a white rounded background and the Windows tray icons from the transparent logo.

Requires: Pillow (python3 -m pip install Pillow)
Usage: python3 scripts/gen-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'resources/artwork'
RENDERER = ROOT / 'src/renderer/src/assets/holo'
TRAY = ROOT / 'src/main/assets/tray'
# The notification area draws a 16px icon at 100% display scale, and 20, 24 and 32px at 125, 150 and 200%.
TRAY_SIZES = (16, 20, 24, 32)
SIZE = 1024
SCALE = 4


def read_icon(name):
    image = Image.open(SOURCE / f'{name}-v2.png')
    if image.mode != 'RGBA' or image.getchannel('A').getextrema() != (0, 255):
        raise ValueError(f'{name}: 背景透過のRGBA画像が必要です')
    return image


def main():
    for name in ('asist', 'agent', 'tasks', 'notes', 'mail', 'memory', 'calendar', 'settings'):
        image = read_icon(name)
        image.resize((320, 320), Image.Resampling.LANCZOS).save(RENDERER / f'{name}.png')

    # The background and the logo are composited at 4x and then scaled down, which smooths the rounded corners.
    canvas = Image.new('RGBA', (SIZE * SCALE, SIZE * SCALE))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (100 * SCALE, 100 * SCALE, 924 * SCALE - 1, 924 * SCALE - 1),
        radius=185 * SCALE,
        fill='white',
    )
    logo = read_icon('asist')
    logo = logo.crop(logo.getchannel('A').getbbox())
    ratio = 640 * SCALE / max(logo.size)
    logo = logo.resize((round(logo.width * ratio), round(logo.height * ratio)), Image.Resampling.LANCZOS)
    canvas.alpha_composite(logo, ((SIZE * SCALE - logo.width) // 2, (SIZE * SCALE - logo.height) // 2))
    destination = ROOT / 'build/icon.png'
    canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(destination)

    # The logo alone, in colour, reads on both a light and a dark taskbar.
    trimmed = read_icon('asist')
    trimmed = trimmed.crop(trimmed.getchannel('A').getbbox())
    for size in TRAY_SIZES:
        icon = Image.new('RGBA', (size, size))
        logo = trimmed.copy()
        logo.thumbnail((size, size), Image.Resampling.LANCZOS)
        icon.alpha_composite(logo, ((size - logo.width) // 2, (size - logo.height) // 2))
        icon.save(TRAY / f'windows-{size}.png', optimize=True)
    print(f'本編の8アイコンと {destination} と Windows のトレイのアイコンを生成しました')


if __name__ == '__main__':
    main()
