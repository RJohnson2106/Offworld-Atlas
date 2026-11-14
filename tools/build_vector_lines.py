#!/usr/bin/env python3
"""Build the vector lines that stay crisp at any zoom.

  python tools/build_vector_lines.py --part global      coastline, rivers, borders (Natural Earth 1:10m)
  python tools/build_vector_lines.py --part basin-01    contour lines from Copernicus DEM, for one site

Writes GeoJSON to public/data/vector/ and public/data/sites/<id>/contours.geojson.
Needs rasterio, numpy, requests, pyshp, shapely and contourpy.
"""
import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import requests
import shapefile
from contourpy import contour_generator
from rasterio.enums import Resampling
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import ENV, HEADERS, copernicus_urls, degrees_for, mosaic, window_bounds  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GLOBAL_LAYERS = {
    "coastline": "https://naciscdn.org/naturalearth/10m/physical/ne_10m_coastline.zip",
    "rivers": "https://naciscdn.org/naturalearth/10m/physical/ne_10m_rivers_lake_centerlines.zip",
    "boundaries": "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_boundary_lines_land.zip",
}
CONTOUR_GRID_M = 60
CONTOUR_INTERVAL_M = 100
INDEX_EVERY = 5
SIMPLIFY_DEGREES = 0.0002


def feature(coordinates, properties=None):
    return {"type": "Feature", "properties": properties or {}, "geometry": {"type": "LineString", "coordinates": coordinates}}


def write(path, features):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")), "utf-8")
    print(path.name, len(features), "lines", round(path.stat().st_size / 1e6, 2), "MB", flush=True)


def build_global():
    for name, url in GLOBAL_LAYERS.items():
        response = requests.get(url, headers=HEADERS, timeout=300)
        response.raise_for_status()
        archive = zipfile.ZipFile(io.BytesIO(response.content))
        stem = next(n[:-4] for n in archive.namelist() if n.endswith(".shp"))
        reader = shapefile.Reader(
            shp=io.BytesIO(archive.read(f"{stem}.shp")),
            shx=io.BytesIO(archive.read(f"{stem}.shx")),
            dbf=io.BytesIO(archive.read(f"{stem}.dbf")),
        )
        features = []
        for item in reader.shapes():
            starts = list(item.parts) + [len(item.points)]
            for start, end in zip(starts[:-1], starts[1:]):
                line = [[round(x, 4), round(y, 4)] for x, y in item.points[start:end]]
                if len(line) >= 2:
                    features.append(feature(line))
        write(ROOT / "public" / "data" / "vector" / f"{name}.geojson", features)


def build_contours(site):
    lat, lng = site["lat"], site["lng"]
    bounds = window_bounds(lat, lng)
    x_res, y_res = degrees_for(CONTOUR_GRID_M, lat)
    z = mosaic(copernicus_urls(bounds), bounds, (x_res, y_res), Resampling.average, -9999.0).astype(np.float64)
    z[(z == -9999.0) | (z <= 0)] = np.nan

    rows, cols = z.shape
    west, south, east, north = bounds
    xs = np.linspace(west, east, cols)
    ys = np.linspace(north, south, rows)
    generator = contour_generator(x=xs, y=ys, z=np.ma.masked_invalid(z))

    low = int(np.nanmin(z) // CONTOUR_INTERVAL_M + 1) * CONTOUR_INTERVAL_M
    high = int(np.nanmax(z) // CONTOUR_INTERVAL_M) * CONTOUR_INTERVAL_M
    features = []
    for level in range(low, high + 1, CONTOUR_INTERVAL_M):
        for points in generator.lines(level):
            if len(points) < 8:
                continue  # specks too small to read
            line = LineString(points).simplify(SIMPLIFY_DEGREES)
            coordinates = [[round(x, 5), round(y, 5)] for x, y in line.coords]
            properties = {"elevation": level, "index": int(level % (CONTOUR_INTERVAL_M * INDEX_EVERY) == 0)}
            features.append(feature(coordinates, properties))
    write(ROOT / "public" / "data" / "sites" / site["id"] / "contours.geojson", features)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--part", required=True, help="global, or a site id")
    args = parser.parse_args()
    if args.part == "global":
        build_global()
        return
    with rasterio.Env(**ENV):
        sites = json.loads((ROOT / "tools" / "drone-sites.json").read_text("utf-8"))
        build_contours(next(s for s in sites if s["id"] == args.part))


if __name__ == "__main__":
    main()
