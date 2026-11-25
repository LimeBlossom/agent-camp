#!/usr/bin/env python3
"""Renders a Tiled .tmj from this repo to a PNG, for checking a map without the app.
usage: preview-map.py <map.tmj> <out.png> [scale] [--spots]
--spots draws a dot on every spawn point, labelled, to check seat placement."""
import json
import os
import sys

from PIL import Image, ImageDraw


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    scale = int(next((a for a in sys.argv[3:] if a.isdigit()), '2'))
    m = json.load(open(src))
    base = os.path.dirname(os.path.abspath(src))
    t = m['tilewidth']
    sheets = []
    for ts in m['tilesets']:
        img = Image.open(os.path.normpath(os.path.join(base, ts['image']))).convert('RGBA')
        sheets.append((ts['firstgid'], ts['columns'], ts['tilecount'], img))
    canvas = Image.new('RGBA', (m['width'] * t, m['height'] * t), (0, 0, 0, 255))
    for layer in m['layers']:
        if layer.get('type') != 'tilelayer' or layer['name'] == 'collision':
            continue
        for i, gid in enumerate(layer['data']):
            if not gid:
                continue
            for first, cols, count, img in reversed(sheets):
                if gid >= first:
                    n = gid - first
                    tile = img.crop(((n % cols) * t, (n // cols) * t, (n % cols + 1) * t, (n // cols + 1) * t))
                    canvas.alpha_composite(tile, ((i % m['width']) * t, (i // m['width']) * t))
                    break
    big = canvas.resize((canvas.width * scale, canvas.height * scale), Image.NEAREST)
    if '--spots' in sys.argv:
        d = ImageDraw.Draw(big)
        for layer in m['layers']:
            if layer['name'] != 'spawn-points':
                continue
            for o in layer['objects']:
                x, y = (o['x'] + t / 2) * scale, (o['y'] + t / 2) * scale
                d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(255, 0, 0, 255))
                d.text((x + 5, y - 6), o['name'], fill=(255, 255, 255, 255))
    big.save(out)


if __name__ == '__main__':
    main()
