#!/usr/bin/env python3
"""Look up the mapped geologic unit at each Moon and Mars place, and each site's rock family.

Writes src/data/geology.generated.json.

Usage:
  python tools/build_geology.py --mars SIM3292_Global_Geology.shp --moon GeoUnits.shp

Sources: USGS SIM 3292 (Mars, 1:20,000,000) and the Unified Geologic Map of the Moon
(1:5,000,000). Needs pyshp and shapely.

A rock family is only assigned when a unit's own name says so. Otherwise it stays unknown, so a
"same family" result never rests on an inference.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import shapefile
from shapely.geometry import Point, shape

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import REFERENCES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MOON_RADIUS_M = 1_737_400

EARTH_WORDS = {
    "volcanic": ("rhyolit", "basalt", "andesit", "dacit", "volcanic", "tuff", "ignimbrite"),
    "sedimentary": ("limestone", "sandstone", "marl", "shale", "conglomerate", "mudstone", "siltstone"),
}


def moon_family(name):
    if "Mare" in name or "Dark Mantling" in name:
        return "volcanic"
    if "Crater" in name or "Basin" in name:
        return "impact"
    return None


def mars_family(name):
    lower = name.lower()
    if "volcanic" in lower:
        return "volcanic"
    if "impact" in lower:
        return "impact"
    return None


def earth_family(text):
    lower = text.lower()
    return next((family for family, words in EARTH_WORDS.items() if any(w in lower for w in words)), None)


def load_units(path):
    reader = shapefile.Reader(str(path))
    fields = [f[0] for f in reader.fields[1:]]
    return [(shape(item.shape.__geo_interface__), dict(zip(fields, item.record))) for item in reader.iterShapeRecords()]


def find_unit(units, x, y):
    point = Point(x, y)
    return next((record for geometry, record in units if geometry.covers(point)), None)


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # unit names include letters like ā
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mars", type=Path, required=True)
    parser.add_argument("--moon", type=Path, required=True)
    args = parser.parse_args()

    mars_units = load_units(args.mars)
    moon_units = load_units(args.moon)
    references = {}

    for reference in REFERENCES:
        lat, lng = reference["lat"], reference["lng"]
        if reference["world"] == "Moon":
            # This map is equidistant cylindrical, in metres on the lunar sphere.
            metres_per_degree = math.radians(1) * MOON_RADIUS_M
            record = find_unit(moon_units, lng * metres_per_degree, lat * metres_per_degree)
            unit = f"{record['FIRST_Un_1']} {record['FIRST_Un_2']}" if record else None
            family = moon_family(record["FIRST_Un_2"]) if record else None
            code = record["FIRST_Unit"] if record else None
        else:
            record = find_unit(mars_units, lng, lat)  # this one is in degrees
            unit = record["UnitDesc"] if record else None
            family = mars_family(record["UnitDesc"]) if record else None
            code = record["Unit"] if record else None
        references[reference["id"]] = {"unit": unit, "code": code, "family": family}
        print(reference["id"], references[reference["id"]], flush=True)

    measurements = json.loads((ROOT / "src" / "data" / "siteMeasurements.generated.json").read_text("utf-8"))
    sites = {}
    for site_id, entry in measurements["sites"].items():
        rows = {row["label"]: row["value"] for row in entry["sections"]["geology"]}
        name = rows.get("Mapped unit", "")
        text = f"{name} {rows.get('Description', '')}"
        sites[site_id] = {"unit": name or None, "age": rows.get("Age"), "family": earth_family(text)}
        print(site_id, sites[site_id], flush=True)

    output = {
        "sites": sites,
        "references": references,
        "sources": [
            {"name": "USGS Geologic Map of Mars, SIM 3292", "url": "https://pubs.usgs.gov/publication/sim3292",
             "credit": "Tanaka et al. (2014), U.S. Geological Survey."},
            {"name": "USGS Unified Geologic Map of the Moon", "url": "https://astrogeology.usgs.gov/search/map/unified_geologic_map_of_the_moon_1_5m_2020",
             "credit": "Fortezzo, Spudis and Harrel (2020), U.S. Geological Survey."},
        ],
    }
    path = ROOT / "src" / "data" / "geology.generated.json"
    path.write_text(json.dumps(output, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
