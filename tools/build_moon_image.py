"""Renders the Moon seen in the world view from NASA's CGI Moon Kit colour map.

    python tools/build_moon_image.py <lroc_color_poles_2k.jpg> public/space/moon.webp

Orthographic view of the near side, north up and evenly lit. The app applies the phase.
"""
import sys

import numpy as np
from PIL import Image

SIZE = 512


def main(source: str, target: str) -> None:
    texture = np.asarray(Image.open(source).convert("RGB"), dtype=np.float32) / 255
    height, width, _ = texture.shape

    axis = (np.arange(SIZE) + 0.5) / SIZE * 2 - 1
    x, y = np.meshgrid(axis, -axis)
    r2 = x * x + y * y
    z = np.sqrt(np.clip(1 - r2, 0, 1))

    lat = np.arcsin(np.clip(y, -1, 1))
    lng = np.arctan2(x, z)
    column = ((lng / (2 * np.pi) + 0.5) * width).astype(int) % width
    row = np.clip(((0.5 - lat / np.pi) * height).astype(int), 0, height - 1)
    colour = texture[row, column]

    # The source map is bright and flat; deepen it so the seas read against the highlands.
    lit = np.clip(colour**1.5 * 0.95, 0, 1)

    # One-pixel soft edge, so the disc isn't jagged against the stars.
    alpha = np.clip((1 - np.sqrt(r2)) * SIZE / 2, 0, 1)
    pixels = np.dstack([lit, alpha])
    Image.fromarray((pixels * 255).astype(np.uint8), "RGBA").save(target, "WEBP", quality=88, alpha_quality=95)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
