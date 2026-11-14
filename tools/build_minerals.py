"""Reads NASA EMIT L2B mineral identifications inside each site's 51 km square.

  python tools/build_minerals.py --cache some/folder

Needs EARTHDATA_TOKEN in .env.local. Writes src/data/minerals.generated.json.

Each share is the part of the pixels in the square where EMIT identified that mineral group. It shows
where a group was detected, not how much of it is in the rock. A site is marked unusable when too
little of it is covered by clear scenes, or when most of what EMIT identified there is vegetation.
"""
import argparse
import json
import math
import time
from pathlib import Path

import h5py
import numpy as np
import requests
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
HALF_KM = 25.5
MAX_CLOUD = 30  # percent, for a whole scene
SCENES = 3
MIN_COVER = 50  # percent of the square under clear scenes
MAX_ORGANIC = 50  # percent of identifications
ATTEMPTS = 4
RETRY_SECONDS = 15
GROUPS = {
    "ironOxide": ("hematite", "goethite", "ferrihydrite", "lepidocrocite", "maghemite", "fe-hydroxide"),
    "clay": ("kaol", "halloysite", "dickite", "montmorillonite", "nontronite", "saponite", "beidellite", "illite",
             "muscovite", "mica", "vermiculite", "chlorite", "clinochlore", "chamosite", "smect", "palygorskite",
             "sepiolite", "biotite", "phlogopite"),
    "carbonate": ("calcite", "dolomite", "ankerite", "aragonite", "siderite", "magnesite", "rhodochrosite"),
    "sulfate": ("gypsum", "bassanite", "anhydrite", "jarosite", "alunite", "epsomite", "thenardite", "kieserite", "copiapite"),
}
ORGANIC = ("organic", "vegetation", "grass", "wood", "plastic")


def token():
    for line in (ROOT / ".env.local").read_text("utf-8").splitlines():
        if line.startswith("EARTHDATA_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("EARTHDATA_TOKEN is missing from .env.local")


def clear_scenes(window):
    west, south, east, north = window
    found = []
    for page in range(1, 6):
        entries = requests.get(CMR, params={
            "short_name": "EMITL2BMIN", "bounding_box": f"{west},{south},{east},{north}", "page_size": 200, "page_num": page,
        }, timeout=90).json()["feed"]["entry"]
        found += entries
        if len(entries) < 200:
            break
    usable = [e for e in found if e.get("cloud_cover") is not None and float(e["cloud_cover"]) <= MAX_CLOUD]
    return sorted(usable, key=lambda e: float(e["cloud_cover"]))


def outline(entry):
    shapes = []
    for polygon in entry.get("polygons", []):
        numbers = [float(v) for v in polygon[0].split()]
        shapes.append(Polygon([(numbers[i + 1], numbers[i]) for i in range(0, len(numbers), 2)]).buffer(0))
    return shapes


def download(session, entry, cache):
    link = next(l["href"] for l in entry["links"]
                if l["href"].startswith("https") and l["href"].endswith(".nc") and "_UNC_" not in l["href"])
    path = cache / link.rsplit("/", 1)[1]
    if path.exists():
        return path
    partial = path.with_suffix(".part")
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with session.get(link, stream=True, timeout=900) as response:
                response.raise_for_status()
                with open(partial, "wb") as file:
                    for chunk in response.iter_content(1 << 20):
                        file.write(chunk)
            partial.replace(path)
            return path
        except requests.RequestException as error:
            status = getattr(error.response, "status_code", "no response")
            print(f"  download attempt {attempt} failed: {status}", flush=True)
            if attempt == ATTEMPTS:
                raise
            time.sleep(attempt * RETRY_SECONDS)
    return path


def read_scene(path, window, tally):
    west, south, east, north = window
    with h5py.File(path, "r") as data:
        lat, lon = data["location/lat"][()], data["location/lon"][()]
        inside = (lat >= south) & (lat <= north) & (lon >= west) & (lon <= east)
        names = [n.decode().lower() if isinstance(n, bytes) else str(n).lower() for n in data["mineral_metadata/name"][()]]
        indices = [int(i) for i in data["mineral_metadata/index"][()]]
        ids = [data[f"{g}_mineral_id"][()] for g in ("group_1", "group_2")]
        depths = [data[f"{g}_band_depth"][()] for g in ("group_1", "group_2")]

    def mask(words):
        wanted = [i for i, name in zip(indices, names) if any(word in name for word in words)]
        result = np.zeros(inside.shape, bool)
        for layer, depth in zip(ids, depths):
            result |= inside & np.isin(layer, wanted) & (depth > 0)
        return result

    tally["pixels"] += int(inside.sum())
    for group, words in GROUPS.items():
        tally[group] += int(mask(words).sum())
    found = np.zeros(inside.shape, bool)
    for layer, depth in zip(ids, depths):
        found |= inside & (layer > 0) & (depth > 0)
    tally["identified"] += int(found.sum())
    tally["organic"] += int(mask(ORGANIC).sum())


def build_site(site, session, cache):
    half_lat = HALF_KM / 111.32
    half_lng = half_lat / math.cos(math.radians(site["lat"]))
    window = (site["lng"] - half_lng, site["lat"] - half_lat, site["lng"] + half_lng, site["lat"] + half_lat)
    scenes = clear_scenes(window)
    area = box(*window)
    shapes = [shape for entry in scenes for shape in outline(entry)]
    cover = round(unary_union(shapes).intersection(area).area / area.area * 100) if shapes else 0
    if cover < MIN_COVER:
        return {"usable": False, "reason": "coverage", "cover": cover, "scenes": len(scenes)}

    tally = {"pixels": 0, "identified": 0, "organic": 0, **{group: 0 for group in GROUPS}}
    for entry in scenes[:SCENES]:
        read_scene(download(session, entry, cache), window, tally)
    organic = round(tally["organic"] / max(tally["identified"], 1) * 100, 1)
    shares = {group: round(tally[group] / max(tally["pixels"], 1) * 100, 1) for group in GROUPS}
    record = {"usable": organic <= MAX_ORGANIC, "cover": cover, "scenes": min(len(scenes), SCENES), "organicShare": organic, "shares": shares}
    if not record["usable"]:
        record["reason"] = "vegetation"
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token()}"
    sites = {}
    for site in json.loads((ROOT / "tools" / "drone-sites.json").read_text("utf-8")):
        try:
            sites[site["id"]] = build_site(site, session, args.cache)
        except Exception as error:  # one failed site shouldn't lose the others
            sites[site["id"]] = {"usable": False, "reason": "failed"}
            print(site["id"], "FAILED", type(error).__name__, flush=True)
        print(site["id"], sites[site["id"]], flush=True)
    output = {
        "source": {"name": "NASA EMIT L2B Mineral Identification", "url": "https://www.earthdata.nasa.gov/data/catalog/lpcloud-emitl2bmin-001"},
        "sites": sites,
    }
    path = ROOT / "src" / "data" / "minerals.generated.json"
    path.write_text(json.dumps(output, indent=1) + "\n", "utf-8")
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
