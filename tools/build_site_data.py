#!/usr/bin/env python3
"""Measure each site from open datasets, plus Moon and Mars reference sites.

Writes src/data/siteMeasurements.generated.json, which the site panel reads.
Every value records which source it came from. Nothing here is scored or ranked.

Usage:
  python tools/build_site_data.py --cache some/folder

Needs rasterio, numpy, scipy and requests. Sites come from tools/drone-sites.json.
A dataset that can't be reached is reported and left out; the run carries on.
"""
import argparse
import datetime
import json
import math
import time
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
HEADERS = {"User-Agent": "offworld-atlas-hackathon-prototype"}
HALF_WINDOW_M = 25_500  # the same 51 km square as drone view
EARTH_GRIDS = (30, 118, 463)  # metres: native, and matched to the LOLA and MOLA maps
ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    GDAL_HTTP_USERAGENT=HEADERS["User-Agent"],
    GDAL_HTTP_MAX_RETRY="4",
    GDAL_HTTP_RETRY_DELAY="2",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.vrt",
)

LOLA = "https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif"
MOLA = "https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif"

# Named features use the centre in the IAU Gazetteer of Planetary Nomenclature.
# Apollo sites use the Lunar Module position from NASA's NSSDC.
REFERENCES = [
    {"id": "malapert", "name": "Mons Malapert", "world": "Moon", "lat": -85.98, "lng": -1.67,
     "note": "IAU centre of this south-polar massif, which hosts an Artemis III candidate region."},
    {"id": "mons-mouton", "name": "Mons Mouton", "world": "Moon", "lat": -84.6, "lng": 31.0,
     "note": "IAU centre of this south-polar massif, which hosts an Artemis III candidate region."},
    {"id": "apollo-17", "name": "Apollo 17 landing site", "world": "Moon", "lat": 20.1911, "lng": 30.7723,
     "note": "Lunar Module position in the Taurus-Littrow valley."},
    {"id": "apollo-11", "name": "Apollo 11 landing site", "world": "Moon", "lat": 0.67416, "lng": 23.47314,
     "note": "Lunar Module position on the mare plains."},
    {"id": "jezero", "name": "Jezero Crater", "world": "Mars", "lat": 18.4082, "lng": 77.6873,
     "note": "IAU centre of the crater Perseverance landed in."},
    {"id": "gale", "name": "Gale Crater", "world": "Mars", "lat": -5.3672, "lng": 137.811,
     "note": "IAU centre of the crater Curiosity landed in."},
    {"id": "arcadia", "name": "Arcadia Planitia", "world": "Mars", "lat": 49.02, "lng": -171.85,
     "note": "IAU centre of this northern plain."},
]

PLANETS = {
    "Earth": {"gravity": "9.82 m/s²", "pressure": "1,014 mb", "meanTemperature": "15 °C"},
    "Moon": {"gravity": "1.62 m/s²", "pressure": "Near vacuum", "meanTemperature": "−20 °C"},
    "Mars": {"gravity": "3.73 m/s²", "pressure": "6.36 mb", "meanTemperature": "−65 °C"},
}

SOURCES = {
    "copernicus": {"name": "Copernicus DEM GLO-30", "url": "https://registry.opendata.aws/copernicus-dem/",
                   "credit": "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved."},
    "worldcover": {"name": "ESA WorldCover 2021", "url": "https://esa-worldcover.org/",
                   "credit": "© ESA WorldCover project 2021. Contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium. CC BY 4.0."},
    "gsw": {"name": "JRC Global Surface Water", "url": "https://global-surface-water.appspot.com/",
            "credit": "Source: EC JRC/Google."},
    "soilgrids": {"name": "SoilGrids 250 m", "url": "https://www.isric.org/explore/soilgrids",
                  "credit": "ISRIC SoilGrids. CC BY 4.0."},
    "macrostrat": {"name": "Macrostrat", "url": "https://macrostrat.org/",
                   "credit": "Macrostrat and its original map providers. CC BY 4.0."},
    "power": {"name": "NASA POWER", "url": "https://power.larc.nasa.gov/",
              "credit": "NASA Langley Research Center POWER Project."},
    "wind": {"name": "Global Wind Atlas", "url": "https://globalwindatlas.info/",
             "credit": "Global Wind Atlas (World Bank, DTU). CC BY 4.0."},
    "glims": {"name": "GLIMS glacier database", "url": "https://www.glims.org/",
              "credit": "GLIMS and NSIDC."},
    "gbif": {"name": "GBIF", "url": "https://www.gbif.org/", "credit": "GBIF.org occurrence search."},
    "gvp": {"name": "Smithsonian Volcanoes of the World", "url": "https://volcano.si.edu/",
            "credit": "Global Volcanism Program, Smithsonian Institution."},
    "wokam": {"name": "WHYMAP WOKAM", "url": "https://www.whymap.org/",
              "credit": "WHYMAP WOKAM, (C) BGR Berlin, IAH Reading, KIT Karlsruhe, UNESCO Paris 2017."},
    "osm": {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright",
            "credit": "© OpenStreetMap contributors. ODbL."},
    "travel": {"name": "Global travel time to cities", "url": "https://figshare.com/articles/Travel_time_to_cities_and_ports_in_the_year_2015/7638134",
               "credit": "Nelson et al. (2019). CC BY 4.0."},
    "lola": {"name": "LRO LOLA 118 m elevation", "url": "https://astrogeology.usgs.gov/search/map/moon_lro_lola_dem_118m",
             "credit": "NASA LRO LOLA team, via USGS Astrogeology."},
    "mola": {"name": "MGS MOLA 463 m elevation", "url": "https://astrogeology.usgs.gov/search/map/mars_mgs_mola_dem_463m",
             "credit": "NASA MGS MOLA team, via USGS Astrogeology."},
    "factsheet": {"name": "NASA Planetary Fact Sheets", "url": "https://nssdc.gsfc.nasa.gov/planetary/factsheet/",
                  "credit": "NASA Space Science Data Coordinated Archive."},
}

# Reviewed but not in this build, shown in the README so the gaps stay visible.
NOT_IMPLEMENTED = [
    {"name": "Impact craters", "reason": "The open list available included unconfirmed entries; needs a checked source."},
    {"name": "NASA EMIT minerals", "reason": "Needs a free Earthdata login."},
    {"name": "NASA MERRA-2 dust", "reason": "Needs a free Earthdata login."},
    {"name": "ESA Permafrost CCI", "reason": "Distributed as large multi-year NetCDF files; not sampled yet."},
    {"name": "Protected Planet", "reason": "Terms forbid redistributing the data in a public app."},
    {"name": "Geomorpho90m", "reason": "Replaced by slope and roughness calculated from Copernicus DEM; its licence is also unclear."},
    {"name": "GLiM lithology", "reason": "Licence unconfirmed; Macrostrat is used for geology."},
    {"name": "ASU Lava Tube Database, Pyroduct Digital Catalog", "reason": "No queryable coordinates found."},
]

WORLDCOVER_GROUPS = {
    "Bare or sparse ground": [60],
    "Snow and ice": [70],
    "Vegetation": [10, 20, 30, 40, 90, 95, 100],
    "Open water": [80],
    "Built-up": [50],
}
GBIF_KINGDOMS = {"1": "Animals", "6": "Plants", "5": "Fungi", "3": "Bacteria", "2": "Archaea"}


def get_json(url, **kwargs):
    for attempt in range(4):
        try:
            response = requests.get(url, headers=HEADERS, timeout=120, **kwargs)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError):
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))


def window_bounds(lat, lng):
    dlat = HALF_WINDOW_M / 110_574
    dlng = HALF_WINDOW_M / (111_320 * math.cos(math.radians(lat)))
    return lng - dlng, lat - dlat, lng + dlng, lat + dlat


def degrees_for(res_m, lat):
    return res_m / (111_320 * math.cos(math.radians(lat))), res_m / 110_574


def open_existing(urls):
    datasets = []
    for url in urls:
        try:
            datasets.append(rasterio.open(f"/vsicurl/{url}"))
        except rasterio.errors.RasterioIOError:
            pass  # e.g. a Copernicus tile that is all ocean
    return datasets


def mosaic(urls, bounds, res, resampling, nodata):
    datasets = open_existing(urls)
    if not datasets:
        raise RuntimeError("no source tiles available")
    try:
        merged, _ = merge(datasets, bounds=bounds, res=res, resampling=resampling, nodata=nodata)
    finally:
        for dataset in datasets:
            dataset.close()
    return merged[0]


def tile_range(low, high, step):
    start = math.floor(low / step) * step
    return list(range(int(start), int(math.floor(high / step) * step) + step, step))


def copernicus_urls(bounds):
    urls = []
    for lat in tile_range(bounds[1], bounds[3], 1):
        for lng in tile_range(bounds[0], bounds[2], 1):
            name = (
                f"Copernicus_DSM_COG_10_{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00_"
                f"{'E' if lng >= 0 else 'W'}{abs(lng):03d}_00_DEM"
            )
            urls.append(f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif")
    return urls


def worldcover_urls(bounds):
    urls = []
    for lat in tile_range(bounds[1], bounds[3], 3):
        for lng in tile_range(bounds[0], bounds[2], 3):
            tile = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lng >= 0 else 'W'}{abs(lng):03d}"
            urls.append(
                f"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
            )
    return urls


def gsw_urls(bounds):
    urls = []
    for top in tile_range(bounds[1], bounds[3], 10):
        for left in tile_range(bounds[0], bounds[2], 10):
            north = top + 10
            urls.append(
                "https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/"
                f"occurrence_{abs(left)}{'E' if left >= 0 else 'W'}_{abs(north)}{'N' if north >= 0 else 'S'}v1_4_2021.tif"
            )
    return urls


def terrain_metrics(z, res_m):
    """Same calculation for every world, so the numbers can be compared."""
    filled = np.where(np.isnan(z), np.nanmean(z), z)
    dy, dx = np.gradient(filled, res_m)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))
    local = ndimage.maximum_filter(filled, size=3) - ndimage.minimum_filter(filled, size=3)
    valid = ~np.isnan(z)
    return {
        "minElevation": round(float(np.nanmin(z))),
        "maxElevation": round(float(np.nanmax(z))),
        "relief": round(float(np.nanmax(z) - np.nanmin(z))),
        "meanSlope": round(float(slope[valid].mean()), 1),
        "flatShare": round(float((slope[valid] < 5).mean() * 100), 1),
        "gentleShare": round(float((slope[valid] < 15).mean() * 100), 1),
        "roughness": round(float(local[valid].mean()), 1),
        "gridMetres": res_m,
    }


def measure_earth_terrain(bounds, lat):
    metrics = {}
    urls = copernicus_urls(bounds)
    for res_m in EARTH_GRIDS:
        z = mosaic(urls, bounds, degrees_for(res_m, lat), Resampling.average, -9999.0).astype(np.float32)
        z[(z == -9999.0) | (z == 0)] = np.nan  # the sea is exactly 0 in this model; land below sea level is negative
        metrics[str(res_m)] = terrain_metrics(z, res_m)
    return metrics


def measure_planet(url, lat, lng, res_m):
    return terrain_metrics(read_planet(url, lat, lng, res_m), res_m)


def read_planet(url, lat, lng, res_m):
    with rasterio.open(f"/vsicurl/{url}") as dataset:
        metres_per_degree = (dataset.bounds.right - dataset.bounds.left) / 360
        half_x = HALF_WINDOW_M / math.cos(math.radians(lat))
        x, y = lng * metres_per_degree, lat * metres_per_degree
        window = from_bounds(x - half_x, y - HALF_WINDOW_M, x + half_x, y + HALF_WINDOW_M, dataset.transform)
        size = int(2 * HALF_WINDOW_M / res_m)
        data = dataset.read(1, window=window, out_shape=(size, size), resampling=Resampling.average)
        z = data.astype(np.float32) * float(dataset.scales[0])
        z[data == dataset.nodata] = np.nan
    return z


def percent(mask):
    return float(mask.mean() * 100)


def row(label, value, source):
    return {"label": label, "value": value, "source": source}


def fmt_km(value):
    return f"{value:,.0f} km" if value >= 10 else f"{value:.1f} km"


def haversine_km(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(a))


def world_cover(bounds, lat):
    data = mosaic(worldcover_urls(bounds), bounds, degrees_for(30, lat), Resampling.nearest, 0)
    valid = data > 0
    return {name: percent(np.isin(data[valid], classes)) for name, classes in WORLDCOVER_GROUPS.items()}


def surface_water(bounds, lat):
    data = mosaic(gsw_urls(bounds), bounds, degrees_for(30, lat), Resampling.nearest, 255)
    valid = data != 255
    return percent(data[valid] > 0), percent(data[valid] >= 75)


def soil(bounds):
    values = {}
    for prop, scale in (("clay", 10), ("sand", 10), ("silt", 10), ("phh2o", 10)):
        url = f"/vsicurl/https://files.isric.org/soilgrids/latest/data/{prop}/{prop}_0-5cm_mean.vrt"
        with rasterio.open(url) as dataset:
            with WarpedVRT(dataset, crs="EPSG:4326", resampling=Resampling.nearest) as vrt:
                window = from_bounds(*bounds, vrt.transform)
                data = vrt.read(1, window=window, out_shape=(60, 60)).astype(np.float32)
                data = data[(data != dataset.nodata) & (data > 0)]
                values[prop] = float(data.mean() / scale) if data.size > 40 else None
    return values


def power(lat, lng):
    params = "T2M,T2M_MAX,T2M_MIN,ALLSKY_SFC_SW_DWN,WS10M,RH2M,PRECTOTCORR"
    data = get_json(
        "https://power.larc.nasa.gov/api/temporal/climatology/point",
        params={"parameters": params, "community": "RE", "longitude": lng, "latitude": lat, "format": "JSON"},
    )
    return data["properties"]["parameter"]


def wind(site, bounds, lat, cache):
    path = cache / f"wind_{site['iso3']}_10.tif"
    if not path.exists():
        url = f"https://globalwindatlas.info/api/gis/country/{site['iso3']}/wind-speed/10"
        response = requests.get(url, headers=HEADERS, timeout=600)
        response.raise_for_status()
        path.write_bytes(response.content)
    with rasterio.open(path) as dataset:
        data = dataset.read(1, window=from_bounds(*bounds, dataset.transform), boundless=True, fill_value=np.nan)
    data = data[np.isfinite(data) & (data > 0)]
    return float(data.mean())


def macrostrat(lat, lng):
    data = get_json("https://macrostrat.org/api/v2/geologic_units/map", params={"lat": lat, "lng": lng})
    units = data["success"]["data"]
    return next((u for u in units if u.get("name") or u.get("strat_name") or u.get("descrip")), None)


def glaciers(bounds):
    data = get_json(
        "https://www.glims.org/geoserver/GLIMS/ows",
        params={
            "service": "WFS", "version": "1.0.0", "request": "GetFeature",
            "typeName": "GLIMS:GLIMS_Glacier_Outlines", "outputFormat": "application/json",
            "maxFeatures": 5000, "bbox": ",".join(str(round(v, 4)) for v in bounds),
        },
    )
    newest = {}
    for feature in data["features"]:
        props = feature["properties"]
        key = props.get("glac_id")
        stamp = str(props.get("anlys_time") or props.get("src_date") or "")
        if key not in newest or stamp > newest[key][0]:
            newest[key] = (stamp, float(props.get("db_area") or props.get("area") or 0))
    return len(newest), sum(area for _, area in newest.values())


def biodiversity(bounds):
    data = get_json(
        "https://api.gbif.org/v1/occurrence/search",
        params={
            "decimalLatitude": f"{bounds[1]:.4f},{bounds[3]:.4f}",
            "decimalLongitude": f"{bounds[0]:.4f},{bounds[2]:.4f}",
            "limit": 0, "facet": "kingdomKey", "facetLimit": 12,
        },
    )
    counts = {c["name"]: c["count"] for c in data["facets"][0]["counts"]} if data.get("facets") else {}
    return data["count"], {label: counts.get(key, 0) for key, label in GBIF_KINGDOMS.items()}


def karst(lat, lng):
    data = get_json(
        "https://services.bgr.de/arcgis/rest/services/grundwasser/whymap_wokam/MapServer/identify",
        params={
            "geometry": f"{lng},{lat}", "geometryType": "esriGeometryPoint", "sr": 4326, "tolerance": 1,
            "mapExtent": f"{lng-2},{lat-2},{lng+2},{lat+2}", "imageDisplay": "400,400,96",
            "layers": "all", "returnGeometry": "false", "f": "json",
        },
    )
    for result in data.get("results", []):
        rule = result.get("attributes", {}).get("RuleID")
        if rule and rule != "Null":
            return rule
    return None


def caves(bounds):
    south, west, north, east = bounds[1], bounds[0], bounds[3], bounds[2]
    query = f'[out:json][timeout:40];node["natural"="cave_entrance"]({south},{west},{north},{east});out count;'
    for attempt in range(4):
        response = requests.post("https://overpass-api.de/api/interpreter", data={"data": query}, headers=HEADERS, timeout=90)
        if response.ok:
            return int(response.json()["elements"][0]["tags"]["nodes"])
        time.sleep(15 * (attempt + 1))
    response.raise_for_status()


def volcano_list():
    data = get_json(
        "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows",
        params={
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeName": "GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes", "outputFormat": "application/json",
        },
    )
    return [(f["properties"]["Volcano_Name"], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
            for f in data["features"] if f.get("geometry")]


def travel_minutes(lat, lng):
    url = "/vsicurl/https://geodata.ucdavis.edu/geodata/travel/travel_time_to_cities_11.tif"
    with rasterio.open(url) as dataset:
        value = next(dataset.sample([(lng, lat)]))[0]
    return None if value == 65535 else int(value)


def attempt(name, failures, function, *args):
    try:
        return function(*args)
    except Exception as error:  # one unreachable dataset shouldn't stop the others
        failures.append(f"{name}: {type(error).__name__}: {str(error)[:120]}")
        print(f"  ! {name} failed: {error}", flush=True)
        return None


def build_site(site, cache, volcanoes, failures):
    lat, lng = site["lat"], site["lng"]
    bounds = window_bounds(lat, lng)
    print(site["id"], flush=True)

    terrain = attempt("terrain", failures, measure_earth_terrain, bounds, lat)
    cover = attempt("worldcover", failures, world_cover, bounds, lat)
    water = attempt("surface water", failures, surface_water, bounds, lat)
    soils = attempt("soilgrids", failures, soil, bounds)
    climate = attempt("power", failures, power, lat, lng)
    wind_speed = attempt("wind", failures, wind, site, bounds, lat, cache)
    unit = attempt("macrostrat", failures, macrostrat, lat, lng)
    glacier = attempt("glims", failures, glaciers, bounds)
    life = attempt("gbif", failures, biodiversity, bounds)
    karst_class = attempt("wokam", failures, karst, lat, lng)
    cave_count = attempt("overpass", failures, caves, bounds)
    travel = attempt("travel", failures, travel_minutes, lat, lng)

    sections = {key: [] for key in ("geology", "terrain", "climate", "water", "dust", "biology", "subsurface", "operations")}

    if unit:
        name = unit.get("strat_name") or unit.get("name")
        if name:
            sections["geology"].append(row("Mapped unit", name, "macrostrat"))
        age = " to ".join(dict.fromkeys(x for x in (unit.get("b_int_name"), unit.get("t_int_name")) if x))
        if age:
            sections["geology"].append(row("Age", age, "macrostrat"))
        if unit.get("descrip"):
            sections["geology"].append(row("Description", unit["descrip"][:220], "macrostrat"))
    if soils and soils.get("clay") is not None:
        sections["geology"].append(
            row("Topsoil mix, where modelled", f"{soils['sand']:.0f}% sand, {soils['silt']:.0f}% silt, {soils['clay']:.0f}% clay", "soilgrids")
        )
        if soils.get("phh2o"):
            sections["geology"].append(row("Topsoil pH, where modelled", f"{soils['phh2o']:.1f}", "soilgrids"))

    if terrain:
        t = terrain["30"]
        sections["terrain"] += [
            row("Elevation range", f"{t['minElevation']:,} to {t['maxElevation']:,} m", "copernicus"),
            row("Relief", f"{t['relief']:,} m", "copernicus"),
            row("Mean slope", f"{t['meanSlope']}°", "copernicus"),
            row("Local roughness", f"{t['roughness']} m at 30 m", "copernicus"),
        ]
        sections["operations"] += [
            row("Ground under 5° slope", f"{t['flatShare']}%", "copernicus"),
            row("Ground under 15° slope", f"{t['gentleShare']}%", "copernicus"),
        ]
    if climate:
        months = [m for m in climate["T2M"] if m != "ANN"]
        sections["climate"] += [
            row("Mean air temperature", f"{climate['T2M']['ANN']:.1f} °C", "power"),
            row("Warmest month, daily high", f"{max(climate['T2M_MAX'][m] for m in months):.1f} °C", "power"),
            row("Coldest month, daily low", f"{min(climate['T2M_MIN'][m] for m in months):.1f} °C", "power"),
            row("Sunlight at surface", f"{climate['ALLSKY_SFC_SW_DWN']['ANN']:.1f} kWh/m² per day", "power"),
        ]
        sections["water"].append(row("Precipitation", f"{climate['PRECTOTCORR']['ANN'] * 365:,.0f} mm per year", "power"))
        sections["dust"].append(row("Relative humidity", f"{climate['RH2M']['ANN']:.0f}%", "power"))

    if water:
        sections["water"].append(row("Area ever seen as water, 1984-2021", f"{water[0]:.1f}%", "gsw"))
        sections["water"].append(row("Area water at least 75% of the time", f"{water[1]:.1f}%", "gsw"))
    if glacier is not None:
        count, area = glacier
        sections["water"].append(row("Glaciers reaching this area", f"{count:,}, {area:,.0f} km² in full" if count else "None mapped", "glims"))
    if cover:
        sections["water"].append(row("Snow and ice cover", f"{cover['Snow and ice']:.1f}%", "worldcover"))
        sections["dust"].append(row("Bare or sparse ground", f"{cover['Bare or sparse ground']:.1f}%", "worldcover"))
        sections["biology"].append(row("Vegetated, including sparse grass", f"{cover['Vegetation']:.1f}%", "worldcover"))
        sections["operations"].append(row("Built-up land", f"{cover['Built-up']:.2f}%", "worldcover"))

    if wind_speed is not None:
        sections["dust"].append(row("Mean wind at 10 m", f"{wind_speed:.1f} m/s", "wind"))

    if life:
        total, kingdoms = life
        sections["biology"].append(row("Species records", f"{total:,}", "gbif"))
        for label, count in kingdoms.items():
            if count:
                sections["biology"].append(row(f"{label} records", f"{count:,}", "gbif"))

    if karst_class is not None or "wokam" not in " ".join(failures):
        sections["subsurface"].append(row("Cave-forming rock", karst_class or "None mapped", "wokam"))
    if cave_count is not None:
        sections["subsurface"].append(row("Mapped cave entrances", f"{cave_count:,}", "osm"))
    if volcanoes:
        near = sorted((haversine_km(lat, lng, a, b), n) for n, a, b in volcanoes)
        sections["subsurface"].append(row("Nearest Holocene volcano", f"{near[0][1]}, {fmt_km(near[0][0])}", "gvp"))
        sections["subsurface"].append(row("Holocene volcanoes within 100 km", f"{sum(d <= 100 for d, _ in near)}", "gvp"))

    if travel is not None:
        hours = travel / 60
        sections["operations"].append(
            row("Travel to a city of 50,000+", f"{travel} min" if travel < 120 else f"{hours:.1f} hours", "travel")
        )

    return {"sections": sections, "terrain": terrain}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, required=True, help="folder for downloaded files")
    parser.add_argument("--sites", type=Path, default=ROOT / "tools" / "drone-sites.json")
    parser.add_argument("--references-only", action="store_true", help="keep the site data, redo Moon and Mars")
    parser.add_argument("--merge", action="store_true", help="add these sites to the ones already measured")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    failures = []
    path = ROOT / "src" / "data" / "siteMeasurements.generated.json"

    with rasterio.Env(**ENV):
        if args.references_only:
            sites = json.loads(path.read_text("utf-8"))["sites"]
        else:
            volcanoes = attempt("gvp", failures, volcano_list)
            sites = {
                site["id"]: build_site(site, args.cache, volcanoes, failures)
                for site in json.loads(args.sites.read_text("utf-8"))
            }
            if args.merge:
                sites = {**json.loads(path.read_text("utf-8"))["sites"], **sites}
        references = []
        for reference in REFERENCES:
            print(reference["id"], flush=True)
            moon = reference["world"] == "Moon"
            metrics = attempt(
                reference["id"], failures, measure_planet,
                LOLA if moon else MOLA, reference["lat"], reference["lng"], 118 if moon else 463,
            )
            if metrics:
                references.append({**reference, "source": "lola" if moon else "mola", "metrics": metrics})

    for site in sites.values():
        site["sections"]["terrain"] = [
            row_ for row_ in site["sections"]["terrain"] if row_["source"] != "wikidata"
        ]

    output = {
        "generatedOn": datetime.date.today().isoformat(),
        "windowKm": HALF_WINDOW_M * 2 / 1000,
        "sources": SOURCES,
        "sites": sites,
        "references": references,
        "planets": PLANETS,
        "notImplemented": NOT_IMPLEMENTED,
    }
    path.write_text(json.dumps(output, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print(f"wrote {path}\nfailures: {failures or 'none'}", flush=True)


if __name__ == "__main__":
    main()
