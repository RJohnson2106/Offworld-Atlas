"""Where water ice could survive near the surface around the Moon's south polar bases.

  python tools/build_moon_ice.py --table dlre_prp_south.tab

From NASA's LRO Diviner Polar Resource Product (Paige et al.): for each small patch of ground it gives
the depth at which ice would be lost more slowly than 1 kg per square metre per billion years. This
is a model driven by Diviner temperatures, not a detection of ice. The patches inside the same 51 km
square used elsewhere are counted. Writes src/data/moonIce.generated.json.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import REFERENCES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MOON_RADIUS_KM = 1737.4
HALF_WINDOW_KM = 25.5
TOO_DEEP = -999.0  # the product's value for "deeper than 2.87 m, or not stable"
SHALLOW_M = 1.0
KELVIN = 273.15
MIN_PATCHES = 1000


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--table", type=Path, required=True)
    args = parser.parse_args()
    lng, lat, mean_k, depth = np.loadtxt(args.table, delimiter=",", skiprows=1, usecols=(9, 10, 12, 14), dtype=np.float32).T
    print("patches", len(lat), "northern edge", float(lat.max()), flush=True)

    references = {}
    for reference in REFERENCES:
        if reference["world"] != "Moon":
            continue
        half_lat = HALF_WINDOW_KM / (math.pi * MOON_RADIUS_KM / 180)
        half_lng = half_lat / math.cos(math.radians(reference["lat"]))
        offset = (lng - reference["lng"] + 180) % 360 - 180
        inside = (np.abs(lat - reference["lat"]) <= half_lat) & (np.abs(offset) <= half_lng)
        count = int(inside.sum())
        if count < MIN_PATCHES:
            continue  # outside the polar product
        depths = depth[inside]
        share = lambda mask: round(float(mask.sum()) / count * 100, 1)
        references[reference["id"]] = {
            "surface": share(depths == 0),
            "shallow": share((depths > 0) & (depths <= SHALLOW_M)),
            "deeper": share(depths > SHALLOW_M),
            "none": share(depths == TOO_DEEP),
            "meanAnnualC": round(float(mean_k[inside].mean()) - KELVIN, 1),
            "patches": count,
        }
        print(reference["id"], references[reference["id"]], flush=True)

    output = {
        "source": {"name": "NASA LRO Diviner Polar Resource Product",
                   "url": "https://pds-geosciences.wustl.edu/missions/lro/diviner.htm",
                   "credit": "Paige et al., NASA Planetary Data System."},
        "shallowMetres": SHALLOW_M,
        "references": references,
    }
    path = ROOT / "src" / "data" / "moonIce.generated.json"
    path.write_text(json.dumps(output, indent=1) + "\n", "utf-8")
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
