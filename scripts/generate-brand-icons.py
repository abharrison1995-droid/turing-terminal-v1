#!/usr/bin/env python3
"""Regenerates the brand icons from the first idle frame of the approved skull.

Reads src/client/ui/mascot/frames.generated.ts (24x24 cells over '.obsa') and the --tt-mascot-* hex tokens, then writes:
  public/turing.svg (PWA icon and favicon), src-tauri/icons/{32x32,128x128,128x128@2x}.png and src-tauri/icons/icon.ico.
Run from the repo root: python3 scripts/generate-brand-icons.py   (needs Pillow)
"""
import re
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
frames = (root / 'src/client/ui/mascot/frames.generated.ts').read_text()
idle = frames.split('idle: {')[1].split('frames: [')[1].split('],\n    },')[0]
first = re.search(r"\[\s*((?:'[.obsa]{24}',\s*){24})\]", idle).group(1)
rows = re.findall(r"'([.obsa]{24})'", first)
assert len(rows) == 24
tokens = (root / 'src/client/styles/tokens.css').read_text()
palette = {}
for char, name in (('o', 'outline'), ('b', 'body'), ('s', 'shade'), ('a', 'accent')):
    palette[char] = re.search(rf'--tt-mascot-{name}:\s*(#[0-9a-fA-F]{{6}});', tokens).group(1).lower()
TILE = '#131317'

# SVG: 128 box, tile with 28 radius, the 24 grid scaled 4x (96 px) centred at 16.
paths = []
for char in 'obsa':
    d = ''
    for y, row in enumerate(rows):
        x = 0
        while x < 24:
            if row[x] != char:
                x += 1
                continue
            end = x
            while end < 24 and row[end] == char:
                end += 1
            d += f'M{x} {y}h{end - x}v1h-{end - x}z'
            x = end
    if d:
        paths.append(f'  <path fill="{palette[char]}" d="{d}"/>')
svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" shape-rendering="crispEdges">\n'
    f'  <rect width="128" height="128" rx="28" fill="{TILE}"/>\n'
    '  <g transform="translate(16 16) scale(4)">\n' + '\n'.join('  ' + p for p in paths) + '\n  </g>\n</svg>\n'
)
(root / 'public/turing.svg').write_text(svg)


def render(size: int) -> Image.Image:
    big = 256
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 28 // 128, fill=TILE)
    cell = 8
    offset = (big - 24 * cell) // 2
    for y, row in enumerate(rows):
        for x, char in enumerate(row):
            if char != '.':
                draw.rectangle(
                    (offset + x * cell, offset + y * cell, offset + (x + 1) * cell - 1, offset + (y + 1) * cell - 1),
                    fill=palette[char],
                )
    return image if size == big else image.resize((size, size), Image.BOX)


icons = root / 'src-tauri/icons'
for name, size in (('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256)):
    render(size).save(icons / name)
render(256).save(icons / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote public/turing.svg and src-tauri/icons')
