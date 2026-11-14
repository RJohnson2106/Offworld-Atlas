#!/usr/bin/env python3
"""Build the terrain used by drone view.

Reads Copernicus DEM GLO-30 around each site in tools/drone-sites.json and writes
public/terrain/<site>/:

  height.bin   little-endian Int16 metres, size x size, north to south
  shade.webp   relief shaded from those heights, tinted with the basemap's land colour
  meta.json    grid size, ground resolution and elevation range

Usage:
  python tools/build_drone_terrain.py --colour NE1_HR_LC_SR_W.tif

Needs rasterio, numpy, scipy, requests and Pillow.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_basemap import merc_y_to_lat, vivid  # noqa: E402
from build_site_data import ENV, copernicus_urls, mosaic  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
TARGET_METRES = 30  # coarsest zoom that still resolves about this much on the ground
SIZE = 1536  # height samples per side, about 50 km
TEXTURE_SCALE = 2
ARC_SECOND = 1 / 3600
EARTH_CIRCUMFERENCE_M = 40_075_016.686
SEA_COLOUR = np.array([22, 104, 158], dtype=np.float32)


def zoom_for(lat: float) -> int:
    per_tile = EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / (256 * TARGET_METRES)
    return math.floor(math.log2(per_tile))


def load_heights(lng: float, lat: float, zoom: int):
    """Copernicus DEM on the Web Mercator drone grid, plus the grid's top-left world pixel."""
    world = 256 * (1 << zoom)
    s = math.sin(math.radians(lat))
    cx = (lng + 180) / 360 * world
    cy = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * world
    x0, y0 = round(cx - SIZE / 2), round(cy - SIZE / 2)

    lngs = (x0 + np.arange(SIZE) + 0.5) / world * 360 - 180
    lats = merc_y_to_lat((y0 + np.arange(SIZE) + 0.5) / world)
    margin = 0.01
    bounds = (lngs.min() - margin, lats.min() - margin, lngs.max() + margin, lats.max() + margin)
    with rasterio.Env(**ENV):
        source = mosaic(copernicus_urls(bounds), bounds, (ARC_SECOND, ARC_SECOND), Resampling.bilinear, -9999.0)
    source = np.where(source == -9999.0, 0, source).astype(np.float32)

    rows = (bounds[3] - lats) / ARC_SECOND - 0.5
    cols = (lngs - bounds[0]) / ARC_SECOND - 0.5
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    heights = ndimage.map_coordinates(source, [rr, cc], order=1, mode="nearest").astype(np.float32)
    # A light blur removes radar speckle that would otherwise read as dents at low altitude.
    # The panel's measurements use the unblurred data.
    heights = ndimage.gaussian_filter(heights, 0.7)
    # Sea level and below are flat as far as the drone cares.
    return np.maximum(heights, 0), x0, y0


def lambert(dx: np.ndarray, dy: np.ndarray, azimuth: float, altitude: float) -> np.ndarray:
    """dx points east, dy points south. Azimuth is clockwise from north."""
    az, alt = math.radians(azimuth), math.radians(altitude)
    lx, ly, lz = math.sin(az) * math.cos(alt), -math.cos(az) * math.cos(alt), math.sin(alt)
    norm = np.sqrt(dx * dx + dy * dy + 1)
    return np.clip((-dx * lx - dy * ly + lz) / norm, 0, 1)


def land_colour(colour: np.ndarray, zoom: int, x0: int, y0: int, size: int) -> np.ndarray:
    """Natural Earth land colour for the texture grid. Smooth, because it is 1.85 km data."""
    h_src, w_src = colour.shape[:2]
    world = 256 * (1 << zoom)
    span = np.arange(size) / TEXTURE_SCALE + 0.5 / TEXTURE_SCALE
    cols = ((x0 + span) / world * w_src - 0.5).astype(np.float32)
    rows = ((90 - merc_y_to_lat((y0 + span) / world)) / 180 * h_src - 0.5).astype(np.float32)
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    r0, r1 = max(int(rows.min()) - 6, 0), min(int(rows.max()) + 7, h_src)
    c0, c1 = max(int(cols.min()) - 6, 0), min(int(cols.max()) + 7, w_src)
    return np.stack(
        [
            ndimage.map_coordinates(
                ndimage.gaussian_filter(colour[r0:r1, c0:c1, c].astype(np.float32), 1.2),
                [rr - r0, cc - c0],
                order=1,
                mode="nearest",
            )
            for c in range(3)
        ],
        axis=-1,
    )


def shade(heights: np.ndarray, metres_per_px: float, tint: np.ndarray) -> np.ndarray:
    fine = ndimage.zoom(heights, TEXTURE_SCALE, order=3)
    step = metres_per_px / TEXTURE_SCALE
    smooth = ndimage.gaussian_filter(fine, 1.5)
    dy, dx = np.gradient(smooth, step)

    light = (
        lambert(dx, dy, 315, 38) * 0.62
        + lambert(dx, dy, 270, 50) * 0.2
        + lambert(dx, dy, 0, 50) * 0.18
    )
    # Valleys sit darker and crests lighter, which reads better from low altitude.
    relief = smooth - ndimage.gaussian_filter(smooth, 28)
    fine_relief = smooth - ndimage.gaussian_filter(smooth, 7)
    light = light + np.clip(relief / 900, -0.14, 0.14) + np.clip(fine_relief / 70, -0.1, 0.1)
    tone = np.clip((light - 0.2) / 0.74, 0, 1) ** 1.4
    rgb = vivid(tint, 0.26 + tone * 0.9)

    sea = np.clip((0.5 - fine) / 0.5, 0, 1)[..., None].astype(np.float32)
    return rgb * (1 - sea) + SEA_COLOUR * sea


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--colour", type=Path, required=True, help="NE1_HR_LC_SR_W.tif")
    parser.add_argument("--sites", type=Path, default=ROOT / "tools" / "drone-sites.json")
    parser.add_argument("--out", type=Path, default=ROOT / "public" / "terrain")
    args = parser.parse_args()
    colour = np.asarray(Image.open(args.colour).convert("RGB"))

    for site in json.loads(args.sites.read_text("utf-8")):
        zoom = zoom_for(site["lat"])
        heights, x0, y0 = load_heights(site["lng"], site["lat"], zoom)
        metres = EARTH_CIRCUMFERENCE_M * math.cos(math.radians(site["lat"])) / (256 * (1 << zoom))

        out = args.out / site["id"]
        out.mkdir(parents=True, exist_ok=True)
        np.rint(heights).astype("<i2").tofile(out / "height.bin")
        tint = land_colour(colour, zoom, x0, y0, SIZE * TEXTURE_SCALE)
        rgb = shade(heights, metres, tint)
        Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB").save(
            out / "shade.webp", "WEBP", quality=82, method=6
        )
        meta = {
            "size": SIZE,
            "metresPerSample": round(metres, 4),
            "minElevation": round(float(heights.min())),
            "maxElevation": round(float(heights.max())),
        }
        (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", "utf-8")
        files = {p.name: round(p.stat().st_size / 1e6, 2) for p in out.iterdir()}
        print(site["id"], f"z{zoom}", meta, files)


if __name__ == "__main__":
    main()
