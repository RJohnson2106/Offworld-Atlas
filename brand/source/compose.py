"""Lay out the team icon and banner around the Blender relief renders.

compose.py <icon render> <banner render> <output folder>
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

icon_render, banner_render, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)

NAVY = (11, 22, 38)
PAPER = (240, 237, 229)
MUTED = (122, 138, 160)
ACCENT = (255, 194, 51)  # the app's colour for a new candidate
MOON = (196, 193, 186)
MARS = (188, 96, 58)
SERIF = r"C:\Windows\Fonts\SitkaVF.ttf"
SERIF_ITALIC = r"C:\Windows\Fonts\SitkaVF-Italic.ttf"


def serif(size, weight=400, italic=False, optical=27):
    """Sitka, the reading typeface that ships with Windows. Axes: optical size 6-27, weight 400-700."""
    font = ImageFont.truetype(SERIF_ITALIC if italic else SERIF, size)
    font.set_variation_by_axes([optical, weight])
    return font


# ------------------------------------------------------------------ icon
def make_icon():
    S = 2048  # drawn at twice the delivered size
    canvas = Image.new("RGB", (S, S), NAVY)
    relief = Image.open(icon_render).convert("RGBA")
    radius = 760
    disc = relief.resize((radius * 2, radius * 2), Image.LANCZOS)
    mask = Image.new("L", (radius * 8, radius * 8), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, radius * 8 - 1, radius * 8 - 1), fill=255)
    mask = mask.resize((radius * 2, radius * 2), Image.LANCZOS)
    c = S // 2
    canvas.paste(disc.convert("RGB"), (c - radius, c - radius), mask)

    # Graticule ring: a tick every 10 degrees, longer at the cardinal points.
    big = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    C = S
    r_ring = (radius + 46) * 2
    d.ellipse((C - r_ring, C - r_ring, C + r_ring, C + r_ring), outline=PAPER + (255,), width=10)
    for deg in range(0, 360, 10):
        if deg == 0:
            continue
        cardinal = deg % 90 == 0
        a = math.radians(deg)
        inner = r_ring + 30
        outer = inner + (84 if cardinal else 40)
        x0, y0 = C + math.sin(a) * inner, C - math.cos(a) * inner
        x1, y1 = C + math.sin(a) * outer, C - math.cos(a) * outer
        d.line((x0, y0, x1, y1), fill=(PAPER if cardinal else MUTED) + (255,), width=12 if cardinal else 8)
    # North pointer in the candidate colour.
    tip, base, half = r_ring + 26, r_ring + 126, 50
    d.polygon([(C, C - tip), (C - half, C - base), (C + half, C - base)], fill=ACCENT + (255,))
    canvas.paste(big.resize((S, S), Image.LANCZOS), (0, 0), big.resize((S, S), Image.LANCZOS))

    return canvas.resize((1024, 1024), Image.LANCZOS)


# ------------------------------------------------------------------ banner
def make_banner():
    W, H = 2400, 800
    canvas = Image.new("RGB", (W, H), NAVY)
    relief = Image.open(banner_render).convert("RGBA").resize((W, H), Image.LANCZOS)
    canvas.paste(relief, (0, 0), relief)
    d = ImageDraw.Draw(canvas)
    left = 130

    title = serif(196, 620)
    d.text((left - 8, 78), "Offworld", font=title, fill=PAPER)
    d.text((left - 8, 262), "Atlas", font=title, fill=PAPER)
    d.text((left, 492), "New Earth stand-ins for the Moon and Mars", font=serif(47, italic=True, optical=20), fill=PAPER)

    d.line((left, 588, left + 860, 588), fill=(58, 72, 94), width=2)
    note = serif(27, optical=10)
    note_italic = serif(27, italic=True, optical=10)
    y = 612
    x = left + d.textlength("Plate: ", font=note_italic)
    d.text((left, y), "Plate: ", font=note_italic, fill=MUTED)
    d.text((x, y), "Mount Suswa, Kenya, 1.15\u00b0 S 36.35\u00b0 E", font=note, fill=PAPER)
    d.text((left, y + 42), "Real elevation from the Copernicus DEM, heights drawn three times taller.", font=note, fill=MUTED)
    y += 84
    d.rectangle((left, y + 4, left + 20, y + 24), fill=MOON)
    x = left + 34
    d.text((x, y), "tinted as the Moon", font=note, fill=MUTED)
    x += d.textlength("tinted as the Moon", font=note) + 40
    d.rectangle((x, y + 4, x + 20, y + 24), fill=MARS)
    d.text((x + 34, y), "tinted as Mars", font=note, fill=MUTED)
    return canvas


icon = make_icon()
icon.save(out / "offworld-atlas-icon.png")
icon.resize((512, 512), Image.LANCZOS).save(out / "offworld-atlas-icon-512.png")
icon.resize((96, 96), Image.LANCZOS).save(out / "offworld-atlas-icon-96.png")
make_banner().save(out / "offworld-atlas-banner.png")
print("saved to", out)
