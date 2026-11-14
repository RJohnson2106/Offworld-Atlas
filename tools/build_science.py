#!/usr/bin/env python3
"""Terrain science and physical environment for each site and Moon or Mars place.

Writes src/data/science/<id>.json. Run parts side by side:

  python tools/build_science.py --part basin-01       (or any id in tools/drone-sites.json)
  python tools/build_science.py --part moon
  python tools/build_science.py --part mars

Terrain: RMS height difference at several horizontal distances, on a grid matched to the
planetary elevation map, and the Hurst exponent, which describes how roughness grows with
distance. Physical environment: calculated from the latitude and elevation of each place,
with constants from NASA's Planetary Fact Sheets. Sunlight assumes a circular orbit and is
measured at the top of the atmosphere.

Needs rasterio, numpy, scipy and requests.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import (  # noqa: E402
    ENV, LOLA, MOLA, REFERENCES, copernicus_urls, degrees_for, mosaic, read_planet, window_bounds,
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "science"
LAG_STEPS = (1, 2, 4, 8, 16)  # in grid cells
GRIDS = {"Moon": 118, "Mars": 463}

# NASA Planetary Fact Sheets. The Moon's axial tilt to the ecliptic is its 6.68° obliquity to
# its orbit less the orbit's 5.145° inclination to the ecliptic.
WORLD = {
    "Earth": {"irradiance": 1361.0, "tilt": 23.44, "dayHours": 24.0, "gravity": 9.82,
              "pressureMb": 1014.0, "scaleHeightKm": 8.5},
    "Moon": {"irradiance": 1361.0, "tilt": 6.68 - 5.145, "dayHours": 29.53 * 24, "gravity": 1.62,
             "pressureMb": 3e-12, "scaleHeightKm": None},
    "Mars": {"irradiance": 586.2, "tilt": 25.19, "dayHours": 24.6597, "gravity": 3.73,
             "pressureMb": 6.36, "scaleHeightKm": 11.0},
}


def annual_mean_sunlight(irradiance, tilt_deg, lat_deg):
    """Daily-mean sunlight at the top of the atmosphere, averaged around a circular orbit."""
    tilt, lat = math.radians(tilt_deg), math.radians(lat_deg)
    total = 0.0
    steps = 720
    for i in range(steps):
        declination = math.asin(math.sin(tilt) * math.sin(2 * math.pi * i / steps))
        cos_h = max(-1.0, min(1.0, -math.tan(lat) * math.tan(declination)))
        hour_angle = math.acos(cos_h)
        total += (irradiance / math.pi) * (
            hour_angle * math.sin(lat) * math.sin(declination)
            + math.cos(lat) * math.cos(declination) * math.sin(hour_angle)
        )
    return total / steps


def physical(world, lat, mean_elevation):
    w = WORLD[world]
    if w["scaleHeightKm"]:
        pressure = w["pressureMb"] * math.exp(-mean_elevation / (w["scaleHeightKm"] * 1000))
    else:
        pressure = w["pressureMb"]
    return {
        "sunlight": round(annual_mean_sunlight(w["irradiance"], w["tilt"], lat), 1),
        "dayHours": round(w["dayHours"], 2),
        "gravity": w["gravity"],
        "pressureMb": pressure,
        "airColumnKg": pressure * 100 / w["gravity"],
        "meanElevation": round(mean_elevation),
    }


def roughness_by_scale(z, res_m):
    rows = []
    for step in LAG_STEPS:
        along = z[:, step:] - z[:, :-step]
        down = z[step:, :] - z[:-step, :]
        diffs = np.concatenate([along[np.isfinite(along)], down[np.isfinite(down)]])
        rows.append({"lag": step * res_m, "rms": round(float(np.sqrt(np.mean(diffs * diffs))), 2)})
    log_lag = np.log10([r["lag"] for r in rows])
    log_rms = np.log10([max(r["rms"], 1e-3) for r in rows])
    return rows, round(float(np.polyfit(log_lag, log_rms, 1)[0]), 3)


def steep_share(z, res_m, degrees):
    filled = np.where(np.isnan(z), np.nanmean(z), z)
    dy, dx = np.gradient(filled, res_m)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))[np.isfinite(z)]
    return round(float((slope > degrees).mean() * 100), 1)


def describe(z, res_m):
    scales, hurst = roughness_by_scale(z, res_m)
    return {"grid": res_m, "scales": scales, "hurst": hurst, "steeperThan15": steep_share(z, res_m, 15)}


def write(identifier, record):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{identifier}.json").write_text(json.dumps(record, indent=1) + "\n", "utf-8")
    print(identifier, "done", record["terrain"].keys() if "terrain" in record else "", flush=True)


def build_site(site):
    lat, lng = site["lat"], site["lng"]
    bounds = window_bounds(lat, lng)
    urls = copernicus_urls(bounds)
    terrain = {}
    elevation = None
    for world, res_m in GRIDS.items():
        z = mosaic(urls, bounds, degrees_for(res_m, lat), Resampling.average, -9999.0).astype(np.float32)
        z[(z == -9999.0) | (z == 0)] = np.nan  # the sea is exactly 0 in this model; land below sea level is negative
        terrain[str(res_m)] = describe(z, res_m)
        elevation = float(np.nanmean(z))
    write(site["id"], {"world": "Earth", "terrain": terrain, "physical": physical("Earth", lat, elevation)})


def build_reference(reference):
    world = reference["world"]
    res_m = GRIDS[world]
    z = read_planet(LOLA if world == "Moon" else MOLA, reference["lat"], reference["lng"], res_m)
    write(reference["id"], {
        "world": world,
        "terrain": {str(res_m): describe(z, res_m)},
        "physical": physical(world, reference["lat"], float(np.nanmean(z))),
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--part", required=True, help="moon, mars, or a site id")
    args = parser.parse_args()
    with rasterio.Env(**ENV):
        if args.part in ("moon", "mars"):
            for reference in REFERENCES:
                if reference["world"].lower() == args.part:
                    build_reference(reference)
        else:
            sites = json.loads((ROOT / "tools" / "drone-sites.json").read_text("utf-8"))
            build_site(next(s for s in sites if s["id"] == args.part))


if __name__ == "__main__":
    main()
