"""Ground surface temperature at each site and at each Moon base, so they can be compared like for like.

  python tools/build_surface_temperature.py --cache some/folder

Moon: NASA LRO Diviner Global Cumulative Products (Williams et al. 2017), bolometric brightness
temperature in 0.5 degree bins for every quarter hour of the lunar day. The bins inside the same
51 km square used elsewhere are averaged, then the mean, highest and lowest of the day are taken.

Earth: NASA POWER "Earth Skin Temperature", the long-term yearly mean at the site. This is the
temperature of the ground surface, not of the air, which is what Diviner measures on the Moon.

Writes src/data/surfaceTemperature.generated.json.
"""
import argparse
import json
import math
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import REFERENCES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GCP = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gcp/"
POWER = "https://power.larc.nasa.gov/api/temporal/climatology/point"
MOON_RADIUS_KM = 1737.4
HALF_WINDOW_KM = 25.5
NO_DATA = -9999
KELVIN = 273.15
HEADERS = {"User-Agent": "OffworldAtlas-research/1.0"}
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
MODIS_COLOURS = "https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_Land_Surface_Temp.xml"
MODIS_LAYERS = ("MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day", "MODIS_Terra_L3_Land_Surface_Temp_Monthly_Night")
MODIS_MONTHS = [f"2025-{month:02d}-01" for month in range(1, 13)]
MODIS_ZOOM = 6  # about 2.4 km per pixel at the equator
MODIS_MIN_MONTHS = 9  # fewer than this and the yearly mean would be lopsided
EARTH_CIRCUMFERENCE_KM = 40075.017


def band_file(lat):
    """The 10 degree band holding this latitude, named south edge first: 00n10n, 10s00s, 90s80s."""
    low = math.floor(lat / 10) * 10
    side = "n" if lat >= 0 else "s"
    return f"global_cumul_avg_cyl_{abs(low):02d}{side}{abs(low + 10):02d}{side}_002.tab"


def download(name, cache):
    path = cache / name
    if not path.exists():
        partial = path.with_suffix(".part")
        with requests.get(GCP + name, headers=HEADERS, stream=True, timeout=1800) as response:
            response.raise_for_status()
            with open(partial, "wb") as file:
                for chunk in response.iter_content(1 << 20):
                    file.write(chunk)
        partial.replace(path)
    return path


def moon_temperature(reference, tables, cache):
    name = band_file(reference["lat"])
    if name not in tables:
        tables[name] = np.loadtxt(download(name, cache), delimiter=",", skiprows=1, usecols=(0, 1, 2, 10), dtype=np.float32)
    lng, lat, hour, tbol = tables[name].T
    half_lat = HALF_WINDOW_KM / (math.pi * MOON_RADIUS_KM / 180)
    half_lng = half_lat / math.cos(math.radians(reference["lat"]))
    offset = (lng - reference["lng"] + 180) % 360 - 180
    inside = (np.abs(lat - reference["lat"]) <= half_lat) & (np.abs(offset) <= half_lng)
    bins = len(set(zip(lng[inside].tolist(), lat[inside].tolist())))
    valid = inside & (tbol != NO_DATA) & (tbol > 0)

    hours = np.unique(hour)
    curve = np.array([tbol[valid & (hour == h)].mean() if (valid & (hour == h)).any() else np.nan for h in hours])
    missing = np.isnan(curve)
    if missing.all():
        return None
    # Quarter hours with no observations are filled from their neighbours, wrapping past midnight.
    curve[missing] = np.interp(hours[missing], hours[~missing], curve[~missing], period=24)
    return {
        "mean": round(float(curve.mean()) - KELVIN, 1),
        "max": round(float(curve.max()) - KELVIN, 1),
        "min": round(float(curve.min()) - KELVIN, 1),
        "bins": int(bins),
        "hoursObserved": int((~missing).sum()),
    }


def modis_values(cache):
    """NASA publishes the colour of every value in its browse imagery, so a tile's colours can be read back as kelvin."""
    path = cache / "MODIS_Land_Surface_Temp.xml"
    if not path.exists():
        path.write_bytes(requests.get(MODIS_COLOURS, headers=HEADERS, timeout=120).content)
    table = {}
    for entry in ET.parse(path).getroot().iter("ColorMapEntry"):
        numbers = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", entry.get("value", ""))]
        if entry.get("transparent") == "true" or not numbers:
            continue
        table[tuple(int(v) for v in entry.get("rgb").split(","))] = sum(numbers) / len(numbers)
    return table


def modis_tile(layer, month, x, y, cache):
    path = cache / "modis" / f"{layer}_{month}_{x}_{y}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        url = f"{GIBS}/{layer}/default/{month}/GoogleMapsCompatible_Level6/{MODIS_ZOOM}/{y}/{x}.png"
        response = requests.get(url, headers=HEADERS, timeout=120)
        response.raise_for_status()
        path.write_bytes(response.content)
    return np.asarray(Image.open(path).convert("RGBA"))


def earth_temperature_modis(site, cache, table):
    """Yearly mean of MODIS day and night land surface temperature over the 51 km square, or None."""
    world = 256 * 2 ** MODIS_ZOOM
    scale = EARTH_CIRCUMFERENCE_KM * math.cos(math.radians(site["lat"])) / world  # km per pixel
    sin = math.sin(math.radians(site["lat"]))
    cx = (site["lng"] + 180) / 360 * world
    cy = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world
    half = HALF_WINDOW_KM / scale
    x0, x1, y0, y1 = int(cx - half), int(cx + half), int(cy - half), int(cy + half)

    months = []
    for month in MODIS_MONTHS:
        pair = []
        for layer in MODIS_LAYERS:
            values = []
            for ty in range(y0 // 256, y1 // 256 + 1):
                for tx in range(x0 // 256, x1 // 256 + 1):
                    tile = modis_tile(layer, month, tx % (world // 256), ty, cache)
                    rows = slice(max(y0 - ty * 256, 0), min(y1 - ty * 256, 255) + 1)
                    cols = slice(max(x0 - tx * 256, 0), min(x1 - tx * 256, 255) + 1)
                    for r, g, b, a in tile[rows, cols].reshape(-1, 4):
                        kelvin = table.get((int(r), int(g), int(b))) if a else None
                        if kelvin is not None:
                            values.append(kelvin)
            if values:
                pair.append(sum(values) / len(values))
        if len(pair) == len(MODIS_LAYERS):
            months.append(sum(pair) / len(pair))
    if len(months) < MODIS_MIN_MONTHS:
        return None
    return {"mean": round(sum(months) / len(months) - KELVIN, 1), "source": "modis", "months": len(months)}


def earth_temperature(site, cache, table):
    try:
        modis = earth_temperature_modis(site, cache, table)
    except (requests.RequestException, OSError):
        modis = None
    if modis:
        return modis
    path = cache / f"power_ts_{site['id']}.json"
    if not path.exists():
        for attempt in range(1, 5):
            try:
                response = requests.get(POWER, params={
                    "parameters": "TS", "community": "RE", "longitude": site["lng"], "latitude": site["lat"], "format": "JSON",
                }, headers=HEADERS, timeout=120)
                response.raise_for_status()
                path.write_text(response.text, "utf-8")
                break
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(attempt * 10)
    value = json.loads(path.read_text("utf-8"))["properties"]["parameter"]["TS"]["ANN"]
    return None if value is None or value < -900 else {"mean": round(float(value), 1), "source": "power"}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--sites", type=Path, default=ROOT / "tools" / "drone-sites.json")
    parser.add_argument("--out", type=Path, default=ROOT / "src" / "data" / "surfaceTemperature.generated.json")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)

    tables = {}
    references = {}
    for reference in REFERENCES:
        if reference["world"] != "Moon":
            continue
        value = moon_temperature(reference, tables, args.cache)
        if value:
            value.update(basis="measured", period="mean over a lunar day, measured by LRO Diviner")
        references[reference["id"]] = value
        print(reference["id"], value, flush=True)
    # Mars has no ready-made temperature grid, so these come from rover data and a model: see the file.
    mars = json.loads((ROOT / "tools" / "mars-surface-temperature.json").read_text("utf-8"))
    references.update({key: {k: v for k, v in entry.items() if k != "method"} for key, entry in mars.items()})

    sites = {}
    table = modis_values(args.cache)
    for site in json.loads(args.sites.read_text("utf-8")):
        try:
            sites[site["id"]] = earth_temperature(site, args.cache, table)
        except Exception as error:  # one failed site shouldn't lose the others
            sites[site["id"]] = None
            print(site["id"], "FAILED", type(error).__name__, flush=True)
        print(site["id"], sites[site["id"]], flush=True)

    output = {
        "sources": {
            "moon": {"name": "NASA LRO Diviner Global Cumulative Products",
                     "url": "https://pds-geosciences.wustl.edu/missions/lro/diviner.htm",
                     "credit": "Williams et al. (2017), Icarus 283. NASA Planetary Data System."},
            "earth": {"name": "NASA MODIS land surface temperature",
                      "url": "https://worldview.earthdata.nasa.gov/?l=MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day",
                      "credit": "MODIS Terra monthly day and night land surface temperature for 2025, read from NASA GIBS "
                                "imagery. NASA POWER skin temperature where MODIS has too few months."},
        },
        "sites": sites,
        "references": references,
    }
    path = args.out
    path.write_text(json.dumps(output, indent=1) + "\n", "utf-8")
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
