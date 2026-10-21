#!/usr/bin/env python3
"""Sesli CV — yayın klasörünü üretir.

page.html yalnızca sayfa içeriğini taşır (Claude Artifact biçimi). Bu betik onu tam bir HTML
belgesine sarar, betikleri yanına kopyalar ve telefonda "ana ekrana ekle" için manifest + simge
üretir. Çıktı: site/  (GitHub Pages ya da herhangi bir statik sunucu için)

Kullanım:  python3 build.py
"""
import json
import math
import os
import shutil
import struct
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "site")
FILES = ["parse.js", "speech.js", "pdfdoc.js", "app.js", "fonts.js"]
ACCENT = (0x1F, 0x5C, 0x4A)
BG = "#EDF1EE"

RESET = (
    ":root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "body{margin:0;font:14px/1.4 system-ui,-apple-system,sans-serif}"
    "img{max-width:100%}[hidden]{display:none!important}"
)


def wrap(page: str) -> str:
    # Everything before the icon sprite is head material (title, metas, font links, style).
    cut = page.index("<svg")
    head, body = page[:cut].strip(), page[cut:].strip()
    return (
        "<!doctype html>\n<html lang=\"tr\">\n<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
        "<link rel=\"manifest\" href=\"manifest.webmanifest\">\n"
        "<link rel=\"icon\" type=\"image/png\" href=\"icon-192.png\">\n"
        "<link rel=\"apple-touch-icon\" href=\"icon-180.png\">\n"
        "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n"
        "<meta name=\"apple-mobile-web-app-title\" content=\"Sesli CV\">\n"
        f"<style>{RESET}</style>\n{head}\n</head>\n<body>\n{body}\n</body>\n</html>\n"
    )


def png(size: int) -> bytes:
    """Rounded green square with a white microphone, anti-aliased, no external libraries."""
    S = size
    px = bytearray()
    r_corner = 0.22 * S

    def cov(d):  # signed distance (negative = inside) -> coverage
        return max(0.0, min(1.0, 0.5 - d))

    def rrect(x, y, cx, cy, hw, hh, r):
        qx, qy = abs(x - cx) - hw + r, abs(y - cy) - hh + r
        return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

    for j in range(S):
        px.append(0)  # filter byte
        for i in range(S):
            x, y = i + 0.5, j + 0.5
            bg = cov(rrect(x, y, S / 2, S / 2, S / 2, S / 2, r_corner))
            u = S / 100.0
            # mic capsule
            d = rrect(x, y, 50 * u, 38 * u, 11 * u, 19 * u, 11 * u)
            # holder arc: ring segment below centre
            cx, cy, R, w = 50 * u, 42 * u, 22 * u, 3.6 * u
            ring = abs(math.hypot(x - cx, y - cy) - R) - w
            if y < cy:
                ring = 1e9
            stem = rrect(x, y, 50 * u, 72 * u, w, 8 * u, 0)
            base = rrect(x, y, 50 * u, 80 * u, 13 * u, w, w)
            mic = cov(min(d, ring, stem, base))
            a = bg
            r = ACCENT[0] * (1 - mic) + 255 * mic
            g = ACCENT[1] * (1 - mic) + 255 * mic
            b = ACCENT[2] * (1 - mic) + 255 * mic
            px += bytes((int(r), int(g), int(b), int(a * 255)))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(px), 9)) + chunk(b"IEND", b""))


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    with open(os.path.join(ROOT, "page.html"), encoding="utf-8") as f:
        page = f.read()
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(wrap(page))
    for name in FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(OUT, name))
    for size in (180, 192, 512):
        with open(os.path.join(OUT, f"icon-{size}.png"), "wb") as f:
            f.write(png(size))
    manifest = {
        "name": "Sesli CV Hazırlayıcı",
        "short_name": "Sesli CV",
        "description": "Soruları sesli yanıtlayarak CV hazırlayın, PDF olarak indirin.",
        "lang": "tr",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": BG,
        "theme_color": "#1F5C4A",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    with open(os.path.join(OUT, "manifest.webmanifest"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, ".nojekyll"), "w") as f:
        f.write("")
    print("site/ hazır:", ", ".join(sorted(os.listdir(OUT))))


if __name__ == "__main__":
    main()
