"""Screens the world for places worth measuring as Moon or Mars analogs, using the bundled grids.

  python tools/find_candidates.py

This only proposes places to look at. It doesn't show that any of them is a good analog: that takes
the full measurements (tools/build_site_data.py) and, ultimately, field work.

  Mars-like: the driest, coldest and most remote land cells on each continent.
  Moon-like: Holocene basaltic volcanic fields and shields in the driest, most remote settings.

Areas already well known as analogs are excluded, so the output is places that are not on that list.
"""
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GLOBAL = ROOT / "public" / "data" / "global"
PER_CONTINENT = 12
MIN_SPACING_KM = 300
EXISTING_RADIUS_KM = 200  # how close a new place may sit to one already on the map
MARS_MAX_PRECIPITATION = 1  # class index: under 250 mm a year
MOON_MAX_PRECIPITATION = 2  # class index: under 500 mm a year
NO_DATA = 255
# Rough boxes: west, south, east, north. First match wins, so the order matters.
CONTINENTS = [
    ("Asia", 26, 36, 45, 42),  # Anatolia and the Levant
    ("Asia", 34, 27, 60, 36),  # Sinai eastward
    ("Asia", 38, 12, 60, 27),  # Arabia
    ("Europe", -11, 36, 40, 71),
    ("Africa", -18, -35, 52, 37),
    ("Asia", 26, -11, 180, 78),
    ("North America", -170, 15, -52, 75),
    ("South America", -82, -56, -34, 13),
    ("Oceania", 112, -48, 180, -11),
]
# Name, lng, lat, radius in km. Places with published analog work that this screen shouldn't repeat.
KNOWN_ANALOGS = [
    ("Atacama", -69.9, -24.0, 900),
    ("Altiplano and Salar de Uyuni", -67.5, -20.5, 500),
    ("Colorado Plateau, Mojave and Death Valley", -113, 37, 800),
    ("Devon and Axel Heiberg islands", -90, 77, 700),
    ("Svalbard", 16, 78, 400),
    ("Iceland", -18.5, 65, 500),
    ("Hawaii", -155.5, 19.7, 300),
    ("Canary Islands", -15.5, 28.5, 300),
    ("Rio Tinto", -6.55, 37.7, 200),
    ("Lake Salda", 29.68, 37.55, 200),
    ("Ries crater", 10.6, 48.9, 200),
    ("Qaidam Basin", 94, 37.5, 500),
    ("Danakil and Dallol", 40.3, 14.2, 500),
    ("Namib", 15, -24, 500),
    ("Pilbara", 119, -21.5, 500),
    ("Kachchh", 70, 23.5, 300),
    ("Oman ophiolite and Dhofar", 56.5, 21, 600),
    ("Sudbury", -81, 46.6, 200),
    ("Mistastin", -63.3, 55.9, 200),
    ("Western Sahara and Tindouf", -8, 27.5, 400),
    ("Egyptian Western Desert", 26, 24, 500),
]
BASALTIC = ("shield", "lava field", "volcanic field", "pyroclastic", "fissure")


def distance_km(lng1, lat1, lng2, lat2):
    a, b = math.radians(lat1), math.radians(lat2)
    h = math.sin((b - a) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def cell_of(lng, lat, size):
    sin = math.sin(math.radians(max(-85, min(85, lat))))
    u = (lng + 180) / 360
    v = 0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)
    return min(size - 1, int(v * size)), min(size - 1, int(u * size))


def lng_lat_of(row, column, size):
    lng = (column + 0.5) / size * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (row + 0.5) / size))))
    return lng, lat


def continent_of(lng, lat):
    return next((c[0] for c in CONTINENTS if c[1] <= lng <= c[3] and c[2] <= lat <= c[4]), None)


EXISTING = json.loads((ROOT / "tools" / "drone-sites.json").read_text("utf-8"))


def known_analog(lng, lat):
    if any(distance_km(lng, lat, site["lng"], site["lat"]) < EXISTING_RADIUS_KM for site in EXISTING):
        return "already on the map"
    return next((k[0] for k in KNOWN_ANALOGS if distance_km(lng, lat, k[1], k[2]) < k[3]), None)


def pick(items):
    """Best-scoring first, spaced apart, a few per continent."""
    chosen = []
    counts = {}
    for item in sorted(items, key=lambda entry: entry["score"]):
        if counts.get(item["continent"], 0) >= PER_CONTINENT:
            continue
        if any(distance_km(item["lng"], item["lat"], c["lng"], c["lat"]) < MIN_SPACING_KM for c in chosen):
            continue
        counts[item["continent"]] = counts.get(item["continent"], 0) + 1
        chosen.append(item)
    return chosen


def main():
    spec = json.loads((ROOT / "src" / "data" / "layers" / "global.json").read_text("utf-8"))
    layers = {layer["id"]: layer for layer in spec["layers"]}
    size = spec["gridSize"]
    grid = {
        name: np.frombuffer((GLOBAL / f"{name}.bin").read_bytes(), np.uint8).reshape(size, size)
        for name in ("temperature", "precipitation", "remoteness")
    }
    t_min, t_max = layers["temperature"]["min"], layers["temperature"]["max"]
    print("precipitation classes:", [c["label"] for c in layers["precipitation"]["classes"]])
    print("remoteness classes:", [c["label"] for c in layers["remoteness"]["classes"]])

    def reading(row, column):
        values = [grid[n][row, column] for n in grid]
        if NO_DATA in values:
            return None
        return {
            "temperature": round(t_min + grid["temperature"][row, column] / 254 * (t_max - t_min), 1),
            "precipitation": int(grid["precipitation"][row, column]),
            "remoteness": int(grid["remoteness"][row, column]),
        }

    mars = []
    for row in range(size):
        for column in range(size):
            data = reading(row, column)
            if not data or data["precipitation"] > MARS_MAX_PRECIPITATION:
                continue
            lng, lat = lng_lat_of(row, column, size)
            continent = continent_of(lng, lat)
            if not continent or known_analog(lng, lat):
                continue
            score = data["precipitation"] * 4 - data["remoteness"] + data["temperature"] / 12
            mars.append({"target": "Mars", "lng": round(lng, 2), "lat": round(lat, 2), "continent": continent, "score": round(score, 2), **data})

    moon = []
    for feature in json.loads((GLOBAL / "volcanoes.geojson").read_text("utf-8"))["features"]:
        props = feature["properties"]
        kind = str(props.get("detail", "")).lower()
        if not any(word in kind for word in BASALTIC):
            continue
        lng, lat = feature["geometry"]["coordinates"][:2]
        data = reading(*cell_of(lng, lat, size))
        continent = continent_of(lng, lat)
        if not data or data["precipitation"] > MOON_MAX_PRECIPITATION or not continent or known_analog(lng, lat):
            continue
        score = data["precipitation"] * 4 - data["remoteness"]
        moon.append({"target": "Moon", "name": props.get("name"), "kind": props.get("detail"), "lng": round(lng, 3), "lat": round(lat, 3), "continent": continent, "score": score, **data})

    for label, items in (("MARS-LIKE", mars), ("MOON-LIKE", moon)):
        print(f"\n{label} ({len(items)} eligible)")
        for item in pick(items):
            print(json.dumps(item, ensure_ascii=False))


if __name__ == "__main__":
    main()
