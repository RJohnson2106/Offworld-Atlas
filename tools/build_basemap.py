#!/usr/bin/env python3
"""Cut the Offworld Atlas basemap.

Output is a set of 512 px Web Mercator WebP tiles under public/tiles:

  public/tiles/world/{z}/{x}/{y}.webp          z0-5, Natural Earth at 1:10m
  public/tiles/detail/<site>/{z}/{x}/{y}.webp  z6-8 around each site, shaded from real elevation

It also writes src/map/detailRegions.generated.json, which basemap.ts reads.

Inputs:
  --relief  GRAY_HR_SR_W.tif     Natural Earth relief and water mask
  --colour  NE1_HR_LC_SR_W.tif   Natural Earth land colour
  --ocean   GRAY_50M_SR_OB.tif   Natural Earth ocean-floor shading
  --cache   a folder for downloaded Terrain Tiles (AWS Open Data, no key needed)

Needs numpy, scipy and Pillow. To add sharp detail around a new site, add it to
tools/detail-sites.json and run this again. Change the look with SATURATION,
DEPTH and the OCEAN ramp below.
"""
import argparse
import io
import json
import math
import shutil
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
TILE = 512
WATER_VALUE = 106  # Natural Earth flat water.
WORLD_MAX_Z = 5
DETAIL_LEVELS = ((6, 2), (7, 3), (8, 3))  # zoom, and patch half-width in tiles at that zoom
EDGE_FADE = 0.16  # share of each patch that fades into the level below
WEBP_QUALITY = 84
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
EARTH_CIRCUMFERENCE_M = 40_075_016.686

SATURATION = 1.65
DEPTH = 1.32  # above 1 deepens the mid-tones

# Ocean-floor shading value -> colour, from the deepest basins to the shallows.
OCEAN_IN = np.array([62, 84, 98, 118, 150, 185], dtype=np.float32)
OCEAN_OUT = np.array(
    [
        [9, 40, 92],
        [13, 62, 124],
        [18, 86, 150],
        [26, 118, 170],
        [44, 158, 184],
        [96, 196, 196],
    ],
    dtype=np.float32,
)


def vivid(colour: np.ndarray, relief: np.ndarray) -> np.ndarray:
    """Deepen and saturate land colour, then multiply in the relief. Inputs 0-255 and 0-1+."""
    rgb = (colour.astype(np.float32) / 255) ** DEPTH
    luma = (rgb * np.array([0.299, 0.587, 0.114], dtype=np.float32)).sum(-1, keepdims=True)
    rgb = np.clip(luma + (rgb - luma) * SATURATION, 0, 1)
    return (rgb * relief[..., None] * 255).astype(np.float32)


def sea_colour(ocean: np.ndarray) -> np.ndarray:
    return np.stack([np.interp(ocean, OCEAN_IN, OCEAN_OUT[:, c]) for c in range(3)], axis=-1).astype(
        np.float32
    )


def blend(land: np.ndarray, sea: np.ndarray, water: np.ndarray) -> np.ndarray:
    return (land * (1 - water[..., None]) + sea * water[..., None]).astype(np.float32)


def merc_y_to_lat(y: np.ndarray) -> np.ndarray:
    """y in world fractions, 0 at the north limit, 1 at the south limit."""
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))


def lng_lat_to_world(lng: float, lat: float):
    s = math.sin(math.radians(lat))
    return (lng + 180) / 360, 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


def save(pixels: np.ndarray, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "RGBA" if pixels.shape[-1] == 4 else "RGB"
    Image.fromarray(pixels.clip(0, 255).astype(np.uint8), mode).save(
        path, "WEBP", quality=WEBP_QUALITY, alpha_quality=70, method=4
    )
    return path.stat().st_size


class NaturalEarth:
    """The source rasters, sampled onto Web Mercator tile windows."""

    def __init__(self, relief: Path, colour: Path, ocean: Path):
        self.relief = np.asarray(Image.open(relief).convert("L"))
        self.colour = np.asarray(Image.open(colour).convert("RGB"))
        self.ocean = np.asarray(Image.open(ocean).convert("L"))
        # Opening drops land pixels that happen to equal the water value.
        self.water = ndimage.binary_opening(
            self.relief == WATER_VALUE, structure=np.ones((3, 3))
        ).astype(np.uint8)
        self.height, self.width = self.relief.shape

    def grid(self, z: int, xa: int, xb: int, ya: int, yb: int):
        n = 1 << z
        cols = ((xa + (np.arange((xb - xa) * TILE) + 0.5) / TILE) / n * self.width - 0.5).astype(np.float32)
        lat = merc_y_to_lat((ya + (np.arange((yb - ya) * TILE) + 0.5) / TILE) / n)
        rows = np.clip((90 - lat) / 180 * self.height - 0.5, 0, self.height - 1.001).astype(np.float32)
        return rows, cols

    def sample(self, z: int, xa: int, xb: int, ya: int, yb: int, blur_colour: float = 0.0):
        """Returns relief, colour, water coverage and sea colour for a tile window."""
        rows, cols = self.grid(z, xa, xb, ya, yb)
        rr, cc = np.meshgrid(rows, cols, indexing="ij")
        margin = 10
        r0, r1 = max(int(rows.min()) - margin, 0), min(int(rows.max()) + margin + 1, self.height)
        c0, c1 = max(int(cols.min()) - margin, 0), min(int(cols.max()) + margin + 1, self.width)
        coords = [rr - r0, cc - c0]

        def sample_layer(layer: np.ndarray, order: int) -> np.ndarray:
            return ndimage.map_coordinates(layer.astype(np.float32), coords, order=order, mode="nearest")

        relief = sample_layer(self.relief[r0:r1, c0:c1], 1)
        colour = np.stack(
            [
                sample_layer(
                    ndimage.gaussian_filter(self.colour[r0:r1, c0:c1, c].astype(np.float32), blur_colour)
                    if blur_colour
                    else self.colour[r0:r1, c0:c1, c],
                    1,
                )
                for c in range(3)
            ],
            axis=-1,
        )
        soft = ndimage.gaussian_filter(self.water[r0:r1, c0:c1].astype(np.float32), 1.1)
        cover = sample_layer(soft, 1)
        # Re-sharpen to a smooth coastline instead of stair-stepped source pixels.
        cover = np.clip((cover - 0.36) / 0.28, 0, 1)
        cover = cover * cover * (3 - 2 * cover)
        # The ocean raster is half the resolution of the others.
        sea = sea_colour(
            ndimage.map_coordinates(self.ocean.astype(np.float32), [rr / 2, cc / 2], order=1, mode="nearest")
        )
        return relief, colour, cover, sea


def build_world(earth: NaturalEarth, out: Path) -> None:
    n = 1 << WORLD_MAX_Z
    size = TILE * n
    mosaic = np.zeros((size, size, 3), dtype=np.uint8)
    total = count = 0
    for x in range(n):
        for y in range(n):
            relief, colour, cover, sea = earth.sample(WORLD_MAX_Z, x, x + 1, y, y + 1)
            land = vivid(colour, np.clip((relief / 205) ** 1.4, 0.42, 1.28))
            tile = blend(land, sea, cover).clip(0, 255).astype(np.uint8)
            total += save(tile, out / "world" / str(WORLD_MAX_Z) / str(x) / f"{y}.webp")
            count += 1
            mosaic[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE] = tile

    level = Image.fromarray(mosaic, "RGB")
    del mosaic
    for z in range(WORLD_MAX_Z - 1, -1, -1):
        level = level.resize((TILE << z, TILE << z), Image.LANCZOS)
        pixels = np.asarray(level)
        for x in range(1 << z):
            for y in range(1 << z):
                tile = pixels[y * TILE : (y + 1) * TILE, x * TILE : (x + 1) * TILE]
                total += save(tile, out / "world" / str(z) / str(x) / f"{y}.webp")
                count += 1
    print(f"world: {count} tiles, {total / 1e6:.1f} MB", flush=True)


def fetch_dem(z: int, x: int, y: int, cache: Path) -> np.ndarray:
    path = cache / f"{z}_{x}_{y}.png"
    if not path.exists():
        url = DEM_URL.format(z=z, x=x, y=y)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=60) as response:
                    path.write_bytes(response.read())
                break
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
    rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB"), dtype=np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def lambert(dx: np.ndarray, dy: np.ndarray, azimuth: float, altitude: float) -> np.ndarray:
    """dx points east, dy points south. Azimuth is clockwise from north."""
    az, alt = math.radians(azimuth), math.radians(altitude)
    lx, ly, lz = math.sin(az) * math.cos(alt), -math.cos(az) * math.cos(alt), math.sin(alt)
    norm = np.sqrt(dx * dx + dy * dy + 1)
    return np.clip((-dx * lx - dy * ly + lz) / norm, 0, 1)


def build_detail(earth: NaturalEarth, sites: list, cache: Path, out: Path) -> list:
    """Sharp relief around each site, shaded from real elevation at three zooms."""
    cache.mkdir(parents=True, exist_ok=True)
    regions = []
    for site in sites:
        wx, wy = lng_lat_to_world(site["lng"], site["lat"])
        total = count = 0
        for z, half in DETAIL_LEVELS:
            n = 1 << z
            cx, cy = math.floor(wx * n), math.floor(wy * n)
            xa, xb = max(cx - half, 0), min(cx + half, n - 1) + 1
            ya, yb = max(cy - half, 0), min(cy + half, n - 1) + 1

            # A 512 px tile at zoom z lines up with four 256 px elevation tiles at z + 1.
            coords = [(z + 1, x, y) for y in range(ya * 2, yb * 2) for x in range(xa * 2, xb * 2)]
            with ThreadPoolExecutor(max_workers=6) as pool:
                pieces = list(pool.map(lambda c: fetch_dem(c[0], c[1], c[2], cache), coords))
            columns = (xb - xa) * 2
            heights = np.vstack(
                [np.hstack(pieces[r * columns : (r + 1) * columns]) for r in range((yb - ya) * 2)]
            )
            heights = np.maximum(heights, 0)

            rows = heights.shape[0]
            lat = merc_y_to_lat((ya + (np.arange(rows) + 0.5) / TILE) / n)
            metres = (EARTH_CIRCUMFERENCE_M * np.cos(np.radians(lat)) / (TILE * n)).astype(np.float32)
            smooth = ndimage.gaussian_filter(heights, 0.7)
            dy, dx = np.gradient(smooth)
            # Slopes flatten as pixels get coarser, so zoomed-out levels are lifted to match.
            lift = 1.5 + 0.6 * (DETAIL_LEVELS[-1][0] - z)
            dx = dx / metres[:, None] * lift
            dy = dy / metres[:, None] * lift
            light = (
                lambert(dx, dy, 315, 40) * 0.64
                + lambert(dx, dy, 270, 52) * 0.2
                + lambert(dx, dy, 0, 52) * 0.16
            )
            tone = np.clip((light - 0.2) / 0.74, 0, 1) ** 1.25

            _, colour, cover, sea = earth.sample(z, xa, xb, ya, yb, blur_colour=2.0)
            land = vivid(colour, 0.24 + tone * 0.82)
            rgb = blend(land, sea, cover)

            # Soft edges, so each patch melts into the coarser map beneath it.
            fade = max(1, int(rows * EDGE_FADE))
            ramp_rows = np.minimum(np.arange(rows), np.arange(rows)[::-1]) / fade
            ramp_cols = np.minimum(np.arange(rgb.shape[1]), np.arange(rgb.shape[1])[::-1]) / (
                max(1, int(rgb.shape[1] * EDGE_FADE))
            )
            alpha = np.minimum(np.clip(ramp_rows, 0, 1)[:, None], np.clip(ramp_cols, 0, 1)[None, :])
            alpha = alpha * alpha * (3 - 2 * alpha) * 255
            rgba = np.dstack([rgb, alpha.astype(np.float32)])

            for x in range(xa, xb):
                for y in range(ya, yb):
                    px, py = (x - xa) * TILE, (y - ya) * TILE
                    path = out / "detail" / site["id"] / str(z) / str(x) / f"{y}.webp"
                    total += save(rgba[py : py + TILE, px : px + TILE], path)
                    count += 1

            regions.append(
                {
                    "id": site["id"],
                    "zoom": z,
                    "bounds": [
                        round(xa / n * 360 - 180, 6),
                        round(float(merc_y_to_lat(np.array(yb / n))), 6),
                        round(xb / n * 360 - 180, 6),
                        round(float(merc_y_to_lat(np.array(ya / n))), 6),
                    ],
                }
            )
        print(f"detail {site['id']}: {count} tiles, {total / 1e6:.1f} MB", flush=True)
    return regions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--relief", type=Path, required=True, help="GRAY_HR_SR_W.tif")
    parser.add_argument("--colour", type=Path, required=True, help="NE1_HR_LC_SR_W.tif")
    parser.add_argument("--ocean", type=Path, required=True, help="GRAY_50M_SR_OB.tif")
    parser.add_argument("--cache", type=Path, required=True, help="folder for downloaded elevation")
    parser.add_argument("--sites", type=Path, default=ROOT / "tools" / "detail-sites.json")
    parser.add_argument("--out", type=Path, default=ROOT / "public" / "tiles")
    parser.add_argument("--skip-world", action="store_true", help="only rebuild the site detail")
    args = parser.parse_args()

    earth = NaturalEarth(args.relief, args.colour, args.ocean)
    shutil.rmtree(args.out / "detail", ignore_errors=True)
    if not args.skip_world:
        shutil.rmtree(args.out / "world", ignore_errors=True)
        build_world(earth, args.out)
    regions = build_detail(earth, json.loads(args.sites.read_text("utf-8")), args.cache, args.out)

    manifest = ROOT / "src" / "map" / "detailRegions.generated.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(regions, indent=2) + "\n", "utf-8")
    print(f"wrote {manifest}", flush=True)


if __name__ == "__main__":
    main()
