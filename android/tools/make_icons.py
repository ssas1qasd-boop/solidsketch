#!/usr/bin/env python3
"""Generate the legacy launcher icon PNGs (API 24-25) without any third-party library.

Draws a blue rounded square with a white isometric cube (a hexagon split into three
shaded faces) and writes res/mipmap-<density>/ic_launcher.png for every density.
API 26+ uses the adaptive icon in res/mipmap-anydpi-v26 instead.

Usage: python3 -I make_icons.py <res-dir>
"""
import math
import os
import struct
import sys
import zlib

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
SS = 4  # supersampling factor per axis

BLUE = (0x2F, 0x6F, 0xED)
TOP = (0xFF, 0xFF, 0xFF)
LEFT = (0xDF, 0xE8, 0xFC)
RIGHT = (0xB9, 0xCD, 0xF8)


def png_bytes(w, h, rgba_rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rgba_rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def in_poly(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    # geometry in a unit square, scaled to the pixel size
    m = 0.06 * size            # margin around the rounded square
    rad = 0.20 * size          # corner radius
    cx, cy, R = size / 2.0, size / 2.0 + 0.01 * size, 0.29 * size
    hexv = [(cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a)))
            for a in (-90, -30, 30, 90, 150, 210)]
    top_v, ur, lr, bot, ll, ul = hexv
    c = (cx, cy)
    faces = [([top_v, ur, c, ul], TOP), ([ul, c, bot, ll], LEFT), ([c, ur, lr, bot], RIGHT)]
    rows = []
    n = SS * SS
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0, 0, 0]
            cover = 0
            for sy in range(SS):
                y = py + (sy + 0.5) / SS
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    if not in_round_rect(x, y, m, m, size - m, size - m, rad):
                        continue
                    cover += 1
                    col = BLUE
                    for poly, fc in faces:
                        if in_poly(x, y, poly):
                            col = fc
                            break
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
            if cover:
                row += [round(acc[0] / cover), round(acc[1] / cover), round(acc[2] / cover), round(255 * cover / n)]
            else:
                row += [0, 0, 0, 0]
        rows.append(row)
    return png_bytes(size, size, rows)


def main():
    res = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "res")
    for dens, size in DENSITIES.items():
        d = os.path.join(res, "mipmap-" + dens)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "ic_launcher.png"), "wb") as f:
            f.write(render(size))
        print("icon", dens, size, "px")


if __name__ == "__main__":
    main()
