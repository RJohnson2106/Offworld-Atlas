#!/usr/bin/env python3
"""Build the map overlays and chart data behind the Offworld Atlas visualizations.

Writes images and value grids to public/data/ and descriptions to src/data/layers/.
Run one part at a time, so the parts can run side by side:

  python tools/build_data_layers.py --part global
  python tools/build_data_layers.py --part references
  python tools/build_data_layers.py --part basin-01       (or any id in tools/drone-sites.json)

Needs rasterio, numpy, scipy, requests and Pillow.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import (  # noqa: E402
    ENV, LOLA, MOLA, REFERENCES, copernicus_urls, degrees_for, get_json, gsw_urls,
    mosaic, power, read_planet, window_bounds, worldcover_urls,
)

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public" / "data"
MANIFESTS = ROOT / "src" / "data" / "layers"
GLOBAL_SIZE = 2048
GLOBAL_GRID = 512
SITE_SIZE = 1024
SITE_GRID = 256
MERCATOR_LIMIT = 85.0511
NODATA = 255

# One hue per magnitude scale, light to dark. Temperature diverges around freezing.
ORANGE = ["#fde3d6", "#f7b598", "#eb6834", "#b8481f", "#7a2c10"]
AQUA = ["#d6f3e8", "#8fdcc0", "#1baf7a", "#12805a", "#0a4d36"]
VIOLET = ["#e5e1fa", "#b5abee", "#6250d6", "#42349e", "#2a1f66"]
BLUE = ["#cde2fb", "#86b6ef", "#2a78d6", "#184f95", "#0d366b"]
TEMPERATURE = ["#184f95", "#5598e7", "#d9d8d2", "#e66767", "#9c1f1f"]

SLOPE_EDGES = [0, 5, 10, 15, 25, 90]
SLOPE_LABELS = ["Under 5°", "5–10°", "10–15°", "15–25°", "Over 25°"]
# The three hues pass the colour-vision checks together. Snow and built-up are neutrals,
# told apart by brightness, so they don't add hues that would fail those checks.
LAND_COVER = [
    ("Vegetation", "#199e70", [10, 20, 30, 40, 90, 95, 100]),
    ("Bare or sparse ground", "#d95926", [60]),
    ("Open water", "#3987e5", [80]),
    ("Snow and ice", "#e8eef2", [70]),
    ("Built-up", "#3b4148", [50]),
]


def hex_rgb(value):
    return [int(value[i : i + 2], 16) for i in (1, 3, 5)]


def ramp_lookup(stops):
    """256-step colour table, interpolated between the stops."""
    points = np.linspace(0, 255, len(stops))
    rgb = np.array([hex_rgb(s) for s in stops], dtype=np.float32)
    return np.stack([np.interp(np.arange(256), points, rgb[:, c]) for c in range(3)], axis=-1).astype(np.uint8)


def class_stops(stops, count):
    table = ramp_lookup(stops)
    return ["#%02x%02x%02x" % tuple(table[int(i)]) for i in np.linspace(0, 255, count)]


def write_layer(folder, name, rgba, grid):
    folder.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(folder / f"{name}.webp", "WEBP", quality=88, alpha_quality=90, method=5)
    grid.astype(np.uint8).tofile(folder / f"{name}.bin")


def shrink_nearest(array, size):
    rows = (np.arange(size) + 0.5) * array.shape[0] / size
    cols = (np.arange(size) + 0.5) * array.shape[1] / size
    return array[rows.astype(int)][:, cols.astype(int)]


def continuous_layer(folder, name, values, low, high, stops, size, grid_size):
    """values: float with NaN for no data. Stored as 0-254 across low..high, 255 for none."""
    valid = np.isfinite(values)
    scaled = np.zeros(values.shape, dtype=np.uint8)
    scaled[valid] = np.round((np.clip(values[valid], low, high) - low) / (high - low) * 254).astype(np.uint8)
    table = ramp_lookup(stops)
    rgb = table[np.round(scaled.astype(np.float32) * 255 / 254).astype(np.uint8)]
    rgba = np.dstack([rgb, np.where(valid, 255, 0).astype(np.uint8)])
    grid = np.where(valid, scaled, NODATA).astype(np.uint8)
    write_layer(folder, name, shrink_nearest(rgba, size), shrink_nearest(grid, grid_size))


def class_layer(folder, name, classes, colors, size, grid_size):
    """classes: int array, with NODATA for no data."""
    table = np.array([hex_rgb(c) for c in colors], dtype=np.uint8)
    valid = classes != NODATA
    rgb = np.zeros((*classes.shape, 3), dtype=np.uint8)
    rgb[valid] = table[classes[valid]]
    rgba = np.dstack([rgb, np.where(valid, 255, 0).astype(np.uint8)])
    write_layer(folder, name, shrink_nearest(rgba, size), shrink_nearest(classes, grid_size))


def bin_classes(values, edges):
    classes = np.full(values.shape, NODATA, dtype=np.uint8)
    valid = np.isfinite(values)
    classes[valid] = np.clip(np.digitize(values[valid], edges[1:-1]), 0, len(edges) - 2)
    return classes


def read_global(url, convert):
    """Sample a global lat/long raster onto a Web Mercator square."""
    with rasterio.open(f"/vsicurl/{url}") as dataset:
        height = int(round(dataset.height * GLOBAL_SIZE / dataset.width))
        data = dataset.read(1, out_shape=(height, GLOBAL_SIZE), resampling=Resampling.nearest)
        top, bottom = dataset.bounds.top, dataset.bounds.bottom
    values = convert(data.astype(np.float64))
    y = (np.arange(GLOBAL_SIZE) + 0.5) / GLOBAL_SIZE
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))
    rows = ((top - lat) / (top - bottom) * height).astype(int)
    inside = (rows >= 0) & (rows < height)
    result = np.full((GLOBAL_SIZE, GLOBAL_SIZE), np.nan)
    result[inside] = values[rows[inside]]
    return result


def apply_land_mask(water_tif):
    """Clear the sea from the climate layers, which are land-surface products."""
    source = np.asarray(Image.open(water_tif).convert("L"))
    water = ndimage.binary_opening(source == 106, structure=np.ones((3, 3)))
    height, width = water.shape
    y = (np.arange(GLOBAL_SIZE) + 0.5) / GLOBAL_SIZE
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))
    rows = np.clip(((90 - lat) / 180 * height).astype(int), 0, height - 1)
    cols = np.clip(((np.arange(GLOBAL_SIZE) + 0.5) / GLOBAL_SIZE * width).astype(int), 0, width - 1)
    sea = water[rows][:, cols]
    folder = PUBLIC / "global"
    for name in ("temperature", "precipitation"):
        rgba = np.array(Image.open(folder / f"{name}.webp").convert("RGBA"))
        rgba[sea, 3] = 0
        grid = np.fromfile(folder / f"{name}.bin", dtype=np.uint8).reshape(GLOBAL_GRID, GLOBAL_GRID).copy()
        grid[shrink_nearest(sea, GLOBAL_GRID)] = NODATA
        write_layer(folder, name, rgba, grid)
    print("land mask applied", flush=True)


def climate_values(offset):
    def convert(data):
        result = data * 0.1 + offset
        result[(data <= 0) | (data >= 65000)] = np.nan
        return result
    return convert


CHELSA = "https://os.zhdk.cloud.switch.ch/chelsav2/GLOBAL/climatologies/1981-2010/bio/CHELSA_{}_1981-2010_V.2.1.tif"
TRAVEL = "https://geodata.ucdavis.edu/geodata/travel/travel_time_to_cities_11.tif"
CHELSA_SOURCE = {"name": "CHELSA V2.1, 1981–2010", "url": "https://www.chelsa-climate.org/"}
PRECIP_EDGES = [0, 100, 250, 500, 1000, 2000, 100000]
TRAVEL_EDGES = [0, 30, 60, 180, 360, 720, 1440, 1000000]


def build_global():
    folder = PUBLIC / "global"
    layers = []

    temperature = read_global(CHELSA.format("bio1"), climate_values(-273.15))
    continuous_layer(folder, "temperature", temperature, -30, 30, TEMPERATURE, GLOBAL_SIZE, GLOBAL_GRID)
    layers.append({
        "id": "temperature", "label": "Mean temperature", "kind": "continuous", "unit": "°C",
        "min": -30, "max": 30, "stops": TEMPERATURE, "ticks": ["−30 °C", "0 °C", "30 °C"], **{"source": CHELSA_SOURCE},
    })

    rain = read_global(CHELSA.format("bio12"), climate_values(0))
    rain_colors = class_stops(AQUA, 6)
    class_layer(folder, "precipitation", bin_classes(rain, PRECIP_EDGES), rain_colors, GLOBAL_SIZE, GLOBAL_GRID)
    layers.append({
        "id": "precipitation", "label": "Yearly rain and snow", "kind": "classes", "unit": "",
        "classes": [{"label": l, "color": c} for l, c in zip(
            ["Under 100 mm", "100–250 mm", "250–500 mm", "500–1,000 mm", "1,000–2,000 mm", "Over 2,000 mm"], rain_colors)],
        "source": CHELSA_SOURCE,
    })

    def convert_travel(data):
        result = data.copy()
        result[data >= 65535] = np.nan
        return result

    travel = read_global(TRAVEL, convert_travel)
    travel_colors = class_stops(ORANGE, 7)
    class_layer(folder, "remoteness", bin_classes(travel, TRAVEL_EDGES), travel_colors, GLOBAL_SIZE, GLOBAL_GRID)
    layers.append({
        "id": "remoteness", "label": "Travel time to a city", "kind": "classes", "unit": "",
        "classes": [{"label": l, "color": c} for l, c in zip(
            ["Under 30 min", "30–60 min", "1–3 hours", "3–6 hours", "6–12 hours", "12–24 hours", "Over a day"], travel_colors)],
        "source": {"name": "Global travel time to cities", "url": "https://figshare.com/articles/Travel_time_to_cities_and_ports_in_the_year_2015/7638134"},
    })

    with rasterio.Env(**ENV):
        pass
    volcano_data = get_json(
        "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows",
        params={"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                "typeName": "GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes", "outputFormat": "application/json"},
    )
    volcanoes = [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": f["geometry"]["coordinates"]},
         "properties": {"name": f["properties"]["Volcano_Name"], "detail": f["properties"].get("Primary_Volcano_Type") or "",
                        "last": f["properties"].get("Last_Eruption_Year")}}
        for f in volcano_data["features"] if f.get("geometry")
    ]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "volcanoes.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": volcanoes}, ensure_ascii=False), "utf-8")

    manifest = {
        "layers": layers,
        "gridSize": GLOBAL_GRID,
        "points": [
            {"id": "volcanoes", "label": "Volcanoes, last 12,000 years", "color": "#d95926", "count": len(volcanoes),
             "source": {"name": "Smithsonian Volcanoes of the World", "url": "https://volcano.si.edu/"}},
        ],
    }
    (MANIFESTS / "global.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print("global done", len(volcanoes), "volcanoes", flush=True)


def slope_of(z, res_m):
    filled = np.where(np.isnan(z), np.nanmean(z), z)
    dy, dx = np.gradient(filled, res_m)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))
    slope[np.isnan(z)] = np.nan
    return slope


def slope_bins(z, res_m):
    slope = slope_of(z, res_m)
    valid = slope[np.isfinite(slope)]
    counts, _ = np.histogram(valid, bins=SLOPE_EDGES)
    return [round(float(c) * 100 / valid.size, 1) for c in counts]


def earth_dem(bounds, lat, res_m):
    z = mosaic(copernicus_urls(bounds), bounds, degrees_for(res_m, lat), Resampling.average, -9999.0).astype(np.float32)
    z[(z == -9999.0) | (z == 0)] = np.nan  # the sea is exactly 0 in this model; land below sea level is negative
    return z


def build_site(site):
    lat, lng = site["lat"], site["lng"]
    bounds = window_bounds(lat, lng)
    folder = PUBLIC / "sites" / site["id"]

    z = earth_dem(bounds, lat, 30)
    slope = slope_of(z, 30)
    slope_colors = class_stops(ORANGE, 5)
    class_layer(folder, "slope", bin_classes(slope, SLOPE_EDGES), slope_colors, SITE_SIZE, SITE_GRID)

    filled = np.where(np.isnan(z), np.nanmean(z), z)
    rough = (ndimage.maximum_filter(filled, size=3) - ndimage.minimum_filter(filled, size=3)).astype(np.float32)
    rough[np.isnan(z)] = np.nan
    continuous_layer(folder, "roughness", rough, 0, 80, VIOLET, SITE_SIZE, SITE_GRID)

    cover = mosaic(worldcover_urls(bounds), bounds, degrees_for(30, lat), Resampling.nearest, 0)
    classes = np.full(cover.shape, NODATA, dtype=np.uint8)
    shares = []
    valid_cover = cover > 0
    for index, (name, color, codes) in enumerate(LAND_COVER):
        mask = np.isin(cover, codes)
        classes[mask] = index
        shares.append({"label": name, "color": color, "share": round(float(mask[valid_cover].mean() * 100), 1)})
    class_layer(folder, "landcover", classes, [c for _, c, _ in LAND_COVER], SITE_SIZE, SITE_GRID)

    water = mosaic(gsw_urls(bounds), bounds, degrees_for(30, lat), Resampling.nearest, 255).astype(np.float32)
    water[(water == 255) | (water == 0)] = np.nan
    continuous_layer(folder, "water", water, 1, 100, BLUE, SITE_SIZE, SITE_GRID)

    climate = power(lat, lng)
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    days = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    monthly = [
        {"month": m.title(), "mean": climate["T2M"][m], "high": climate["T2M_MAX"][m], "low": climate["T2M_MIN"][m],
         "precipitation": round(climate["PRECTOTCORR"][m] * d, 1)}
        for m, d in zip(months, days)
    ]

    west, south, east, north = bounds
    manifest = {
        "coordinates": [[west, north], [east, north], [east, south], [west, south]],
        "bounds": [west, south, east, north],
        "gridSize": SITE_GRID,
        "layers": [
            {"id": "slope", "label": "Slope", "kind": "classes", "unit": "",
             "classes": [{"label": l, "color": c} for l, c in zip(SLOPE_LABELS, slope_colors)],
             "source": {"name": "Copernicus DEM GLO-30", "url": "https://registry.opendata.aws/copernicus-dem/"}},
            {"id": "roughness", "label": "Local roughness", "kind": "continuous", "unit": "m", "min": 0, "max": 80,
             "stops": VIOLET, "ticks": ["0 m", "40 m", "80 m+"],
             "source": {"name": "Copernicus DEM GLO-30", "url": "https://registry.opendata.aws/copernicus-dem/"}},
            {"id": "landcover", "label": "Land cover", "kind": "classes", "unit": "",
             "classes": [{"label": n, "color": c} for n, c, _ in LAND_COVER],
             "source": {"name": "ESA WorldCover 2021", "url": "https://esa-worldcover.org/"}},
            {"id": "water", "label": "How often water is present", "kind": "continuous", "unit": "% of time", "min": 1, "max": 100,
             "stops": BLUE, "ticks": ["Rarely", "Half the time", "Always"],
             "source": {"name": "JRC Global Surface Water", "url": "https://global-surface-water.appspot.com/"}},
        ],
        "charts": {
            "climate": monthly,
            "landCover": shares,
            "slopeLabels": SLOPE_LABELS,
            "slopeBins": {
                "118": slope_bins(earth_dem(bounds, lat, 118), 118),
                "463": slope_bins(earth_dem(bounds, lat, 463), 463),
            },
        },
    }
    (MANIFESTS / f"{site['id']}.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print(site["id"], "done", flush=True)


def build_references():
    bins = {}
    for reference in REFERENCES:
        moon = reference["world"] == "Moon"
        res = 118 if moon else 463
        bins[reference["id"]] = slope_bins(read_planet(LOLA if moon else MOLA, reference["lat"], reference["lng"], res), res)
        print(reference["id"], bins[reference["id"]], flush=True)
    (MANIFESTS / "references.json").write_text(json.dumps({"slopeBins": bins}, indent=1) + "\n", "utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--part", required=True, help="global, global-mask, references, or a site id")
    parser.add_argument("--water-mask", type=Path, help="GRAY_50M_SR_W.tif, used by global and global-mask")
    args = parser.parse_args()
    MANIFESTS.mkdir(parents=True, exist_ok=True)

    with rasterio.Env(**ENV):
        if args.part == "global-mask":
            apply_land_mask(args.water_mask)
        elif args.part == "global":
            build_global()
            if args.water_mask:
                apply_land_mask(args.water_mask)
        elif args.part == "references":
            build_references()
        else:
            sites = json.loads((ROOT / "tools" / "drone-sites.json").read_text("utf-8"))
            build_site(next(s for s in sites if s["id"] == args.part))


if __name__ == "__main__":
    main()
