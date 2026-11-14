"""Describes the NASA Worldview (GIBS) layers offered in the Map data menu.

  python tools/build_worldview_layers.py --cache some/folder

Reads NASA's layer catalogue and colour maps, and writes src/data/worldviewLayers.json with each
layer's tile address, latest date and legend. The imagery itself is streamed from NASA when shown.
"""
import argparse
import datetime
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
TILES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{id}/default/{time}/{matrix}/{{z}}/{{y}}/{{x}}.{ext}"
NS = {"wmts": "http://www.opengis.net/wmts/1.0", "ows": "http://www.opengis.net/ows/1.1", "xlink": "http://www.w3.org/1999/xlink"}
STOPS = 9
DAILY_LAG_DAYS = 2  # the newest daily picture is still being filled in as satellites pass over

# convert: turns the legend's numbers into friendlier units. note: shown under the legend.
LAYERS = [
    {"id": "MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day", "label": "Land surface temperature, day",
     "convert": lambda k: k - 273.15, "unit": " °C", "digits": 0},
    {"id": "MODIS_Terra_L3_Land_Surface_Temp_Monthly_Night", "label": "Land surface temperature, night",
     "convert": lambda k: k - 273.15, "unit": " °C", "digits": 0},
    {"id": "MODIS_Terra_L3_Snow_Cover_Monthly_Average_Pct", "label": "Snow cover", "unit": "%", "digits": 0},
    {"id": "MERRA2_Dust_Surface_Mass_Concentration_Monthly", "label": "Dust near the surface",
     "convert": lambda kg: kg * 1e9, "unit": " µg/m³", "digits": 0,
     "note": "From NASA's MERRA-2 weather model, not a direct measurement."},
    {"id": "MODIS_Terra_L3_NDVI_Monthly", "label": "Vegetation index", "unit": "", "digits": 1},
    # VIIRS rather than MODIS: its wider view leaves no gaps between one orbit and the next.
    {"id": "VIIRS_NOAA20_CorrectedReflectance_TrueColor", "label": "Satellite view", "daily": True,
     "note": "Black areas had no daylight that day."},
]


def fetch(url, path):
    if not path.exists():
        response = requests.get(url, timeout=180)
        response.raise_for_status()
        path.write_bytes(response.content)
    return path


def number(text):
    match = re.search(r"-?\d+(?:\.\d+)?(?:e[-+]?\d+)?", text, re.IGNORECASE)
    return float(match.group()) if match else None


def legend(colormap_path, config):
    """Colour stops and end labels from the layer's continuous or discrete legend."""
    for colormap in ET.parse(colormap_path).getroot().iter("ColorMap"):
        for item in colormap.iter("Legend"):
            if item.get("type") not in ("continuous", "discrete"):
                continue
            entries = item.findall("LegendEntry")
            picks = [entries[round(i * (len(entries) - 1) / (STOPS - 1))] for i in range(STOPS)]
            stops = ["#%02x%02x%02x" % tuple(int(v) for v in entry.get("rgb").split(",")) for entry in picks]
            convert = config.get("convert", lambda value: value)
            ends = []
            for raw in (item.get("minLabel") or entries[0].get("tooltip"), item.get("maxLabel") or entries[-1].get("tooltip")):
                value = number(raw)
                ends.append(f"{convert(value):.{config['digits']}f}{config['unit']}".replace("-", "−") if value is not None else raw)
            return {"stops": stops, "ticks": ends}
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # legend labels use a true minus sign
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    root = ET.parse(fetch(CAPABILITIES, args.cache / "caps.xml")).getroot()
    found = {layer.find("ows:Identifier", NS).text: layer for layer in root.iter("{%s}Layer" % NS["wmts"])}

    output = []
    for config in LAYERS:
        layer = found[config["id"]]
        matrix = layer.find("wmts:TileMatrixSetLink/wmts:TileMatrixSet", NS).text
        image = layer.find("wmts:Format", NS).text
        time = layer.find("wmts:Dimension/wmts:Default", NS).text
        if config.get("daily"):
            time = (datetime.date.fromisoformat(time) - datetime.timedelta(days=DAILY_LAG_DAYS)).isoformat()
        entry = {
            "id": config["id"],
            "label": config["label"],
            "nasaTitle": layer.find("ows:Title", NS).text,
            "tiles": TILES.format(id=config["id"], time=time, matrix=matrix, ext="jpeg" if image == "image/jpeg" else "png"),
            "maxzoom": int(re.search(r"Level(\d+)", matrix).group(1)),
            "date": time,
            "period": "day" if config.get("daily") else "month",
            "url": f"https://worldview.earthdata.nasa.gov/?l={config['id']}&t={time}",
        }
        if config.get("note"):
            entry["note"] = config["note"]
        colormap = next(
            (m.get("{%s}href" % NS["xlink"]) for m in layer.findall("ows:Metadata", NS)
             if m.get("{%s}role" % NS["xlink"], "").endswith("colormap/1.3")),
            None,
        )
        if colormap:
            entry["legend"] = legend(fetch(colormap, args.cache / colormap.rsplit("/", 1)[1]), config)
        output.append(entry)
        print(entry["id"], entry["date"], entry["maxzoom"], entry.get("legend", {}).get("ticks") if entry.get("legend") else "no legend", flush=True)

    path = ROOT / "src" / "data" / "worldviewLayers.json"
    path.write_text(json.dumps(output, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
