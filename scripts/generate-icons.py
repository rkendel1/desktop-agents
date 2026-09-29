#!/usr/bin/env python3
"""Generate Foundry's icon files from the supplied artwork, `resources/icons/foundry-source.jpg`.

The artwork is used as supplied: it is only cut out of its black canvas (the JPEG has no alpha, so the
pure-black area outside the rounded plate becomes transparent) and placed on the 1024px canvas with the
transparent margin the platform icons use (an ~824px plate). Nothing is redrawn, recoloured or decorated.
The development icon is the same artwork with a small `DEV` badge, as before.

Requires Pillow and NumPy:  python3 scripts/generate-icons.py
"""
from pathlib import Path
import numpy as np
from collections import deque
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / 'resources' / 'icons'
CANVAS, PLATE = 1024, 824


def cut_out(source: Image.Image) -> Image.Image:
    rgb = np.asarray(source.convert('RGB')).astype(np.int16)
    height, width, _ = rgb.shape
    dark = rgb.max(axis=2) < 6                      # the canvas around the plate is pure black; the plate itself is #101010
    outside = np.zeros((height, width), dtype=bool)
    queue = deque((y, x) for y, x in [(0, 0), (0, width - 1), (height - 1, 0), (height - 1, width - 1)] if dark[y, x])
    for y, x in queue: outside[y, x] = True
    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < height and 0 <= nx < width and dark[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True; queue.append((ny, nx))
    # Anti-alias the edge: within 3px of the cut-out, coverage follows how far the pixel is from black towards the plate colour.
    near = outside.copy()
    for _ in range(3):
        grown = near.copy()
        grown[1:, :] |= near[:-1, :]; grown[:-1, :] |= near[1:, :]; grown[:, 1:] |= near[:, :-1]; grown[:, :-1] |= near[:, 1:]
        near = grown
    luminance = rgb.max(axis=2)
    alpha = np.full((height, width), 255, dtype=np.uint8)
    edge = near & ~outside
    alpha[edge] = np.clip(luminance[edge] * 255 // 15, 0, 255).astype(np.uint8)
    alpha[outside] = 0
    out = Image.fromarray(rgb.astype(np.uint8), 'RGB').convert('RGBA')
    out.putalpha(Image.fromarray(alpha, 'L'))
    return out


def on_canvas(plate: Image.Image) -> Image.Image:
    canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    scaled = plate.resize((PLATE, PLATE), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((CANVAS - PLATE) // 2, (CANVAS - PLATE) // 2))
    return canvas


def with_dev_badge(icon: Image.Image) -> Image.Image:
    badge = icon.copy()
    draw = ImageDraw.Draw(badge)
    box = (CANVAS - 330, CANVAS - 260, CANVAS - 120, CANVAS - 130)
    draw.rounded_rectangle(box, radius=34, fill=(214, 40, 40, 255))
    font = ImageFont.load_default(size=88)
    draw.text(((box[0] + box[2]) // 2, (box[1] + box[3]) // 2), 'DEV', fill=(255, 255, 255, 255), font=font, anchor='mm')
    return badge


def main() -> None:
    icon = on_canvas(cut_out(Image.open(ROOT / 'foundry-source.jpg')))
    dev = with_dev_badge(icon)
    for name, image in (('foundry', icon), ('foundry-dev', dev)):
        image.save(ROOT / f'{name}.png')
        image.save(ROOT / f'{name}.icns', sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    icon.save(ROOT / 'foundry.ico', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])


if __name__ == '__main__':
    main()
