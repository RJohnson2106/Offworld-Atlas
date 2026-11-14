# Offworld Atlas

Prototype for the NASA Space Apps challenge on finding Earth analogs for Moon and Mars sites.
An interactive map that flies from a world view to a local terrain view, then into a free-flight
drone view over real elevation data.

The map shows 56 real places. Seventeen have published analog research, cited in each site's panel.
Thirty-nine are new candidates, proposed by `tools/find_candidates.py` from climate, remoteness and
volcano data. A literature search found no published analog study of those 39. That describes the search,
not proof that nobody has looked, and none of them has been tested in the field. Some markers are
approximate or come from the screening grid rather than a studied spot; the site notes say which.

The globe shows a number per continent, which splits into numbered regions as you zoom in, then
into named places. The groups are worked out from each site's `continent` and `region` fields.

## How to run it

Needs Node.js. No map key or backend.

```
npm install
npm run dev
```

Open http://localhost:5173.

For the production build: `npm run build`, then `npm run preview` (http://localhost:4173).

## Add your site data

| What you want to change | Where |
| --- | --- |
| Sites, coordinates, camera framing, research text and sources | `src/data/analogSites.ts` |
| Basemap tiles, or terrain on the map | `src/map/basemap.ts` |
| Fly-in, return and dive timing | `src/map/cameraDirector.ts` |
| Site panel layout | `src/components/SitePanel.tsx` |
| Drone flight speed, height limits and range | `src/drone/droneFlight.ts` |

To add a site, add it to `analogSites.ts`, `tools/drone-sites.json` and `tools/detail-sites.json`,
then run the build tools below.

### Rebuild the map tiles for a new site

Add the site to `tools/detail-sites.json`, download `GRAY_HR_SR_W`, `NE1_HR_LC_SR_W` and
`GRAY_50M_SR_OB` from Natural Earth, then run (needs Python with numpy, scipy and Pillow):

```
python tools/build_basemap.py --skip-world --relief GRAY_HR_SR_W.tif --colour NE1_HR_LC_SR_W.tif --ocean GRAY_50M_SR_OB.tif --cache some/folder
```

Leave out `--skip-world` to rebuild the world map as well, which takes several minutes.

### Add drone view to a site

1. Add the site to `tools/drone-sites.json`.
2. Run `python tools/build_drone_terrain.py --colour NE1_HR_LC_SR_W.tif`.
3. Set `droneScene` on the site in `analogSites.ts` to the site's `id`.

## Site measurements

Each site panel shows values for the eight dimensions of analogy in the NASA brief, plus a Moon or
Mars comparison. They come from `tools/build_site_data.py`, which writes
`src/data/siteMeasurements.generated.json`. To refresh them, or to measure a new site added to
`tools/drone-sites.json` (needs Python with rasterio, numpy, scipy and requests):

```
python tools/build_site_data.py --cache some/folder
```

How to read the numbers:

- They describe a 51 km square around each marker, so they characterise the area rather than one
  exact study spot.
- In the comparison, Earth elevation is re-gridded to match each planetary map (118 m for the Moon,
  463 m for Mars). Slope and roughness depend on grid size, so comparing them at different grids
  would be misleading.
- Ground surface temperature at the four Moon bases is measured by NASA's LRO Diviner
  (`tools/build_surface_temperature.py`): the bins inside the same 51 km square, averaged over a
  whole lunar day. It is compared with the yearly mean ground surface ("skin") temperature at each
  Earth site from NASA POWER, so both sides are the ground, not the air. This trait is specific to
  each place, so it counts towards the overall match. POWER's grid is about 50 km, so a mountain
  site such as Mauna Kea reads warmer than its summit. A 100 °C gap or more scores 0%.
- Mars ground temperature is site-specific too (`tools/mars-surface-temperature.json`). Jezero and
  Gale are our own averages of rover ground-temperature files in NASA's Planetary Data System
  (Perseverance MEDA and Curiosity REMS), sampled across one Mars year, not figures quoted from a
  paper. Arcadia has no lander, so its value comes from the Mars Climate Database, a model, and the
  panel says so. The file records how each was worked out.
- Earth ground temperature is the 2025 mean of MODIS day and night land surface temperature inside
  the 51 km square, read back from NASA's browse imagery using its published colour table (about
  2.4 km pixels, 0.6 K steps). MODIS passes at about 10:30 and 22:30, so it isn't a full daily mean.
- For the two south polar Moon bases the panel also shows where water ice could last near the
  surface (`tools/build_moon_ice.py`, from Diviner's Polar Resource Product). It is a model driven
  by measured temperatures, not a detection of ice, and it has no Earth counterpart, so it isn't
  scored. Its yearly mean temperature for Mons Malapert (−154.0 °C) agrees with the separate global
  Diviner product used for the temperature trait (−153.9 °C).
- Two traits score the ground itself: the share free of vegetation (bare rock, soil, snow or ice,
  against a world with none) and dryness (yearly rain and snow against none; 1,000 mm or more scores
  0%). They were added after the control places showed the score needed them: before, a rainforest
  mountain range scored 71% against Apollo 17 on terrain alone. Because the controls guided that
  change, they are no longer an independent test of the score.
- The method check still fails for Arcadia Planitia, a flat icy plain: flat forest and farmland
  match its terrain, so controls average about the same as known Mars analogs there. Treat Arcadia
  rankings with caution.
- The Ranking tab orders every place by overall match with one base. Its method check compares
  known analogs with eight control places chosen to be unlike the Moon or Mars
  (`src/data/control-sites.json`: rainforest, farmland, wetland, forest). Controls are measured the
  same way but aren't shown on the map.
- Pressure for both worlds is still a planet-wide average, not a value for that location. Reference positions come from the IAU Gazetteer of Planetary Nomenclature (named
  features) and NASA's NSSDC (Apollo Lunar Module positions).
- An analog doesn't have to match everything, so traits are scored one at a time
  (`src/data/analogTraits.ts`). The overall figure is the plain, equally weighted average of the
  traits specific to the place. Planet-wide traits are left out because they're the same for every
  site, and so are rock family and minerals. The weighting is a choice of ours, so don't read small
  differences between places as meaningful.
- Chemistry (`tools/build_minerals.py`, `src/data/mineralGroups.ts`) compares which of four mineral
  groups occur at a site and at Jezero or Gale, from NASA EMIT and published rover and orbital work.
  It compares presence, not amounts. A group counts as present on 1% or more of pixels. The Moon has
  no comparison, because its mineral maps cover different minerals from EMIT.
- Each percentage is a similarity score of our own design, not a probability that a site is a
  valid analog. Planet-wide figures are shown for context and can't be the headline trait.
- Only terrain is measured the same way on all three worlds so far. There's no matched Moon or Mars
  comparison yet for minerals, ice, dust or biology.

The tool's `NOT_IMPLEMENTED` list records datasets that were reviewed and left out, and why.

## Map data layers and charts

`tools/build_data_layers.py` writes the heat maps, markers and chart data. Run each part separately
(`--part global`, `--part references`, `--part <site id>`); they can run side by side.

The local view is real 3D, using the same elevation as drone view, loaded live. If it can't be
reached the local view stays flat. Heights default to ×4 so relief is visible at this scale, and
the **True scale** button shows them unexaggerated.

Colours were checked with a colour-vision validator. Land cover uses three hues plus two neutrals,
because adding more hues made classes indistinguishable for colourblind viewers.

The Layers tab also offers six NASA Worldview layers on the globe (land surface temperature by day
and night, snow cover, dust, vegetation and a daily satellite picture). They are streamed from
NASA's GIBS service when shown, and listed by `tools/build_worldview_layers.py`, which records each
layer's latest date and legend at the time it is run. They keep NASA's own colour scales, which
weren't checked with the validator, and they are pictures only, so there are no hover values.

## Interface

The interface (`src/chrome.css`, `src/components/Sidebar.tsx`, `src/map/Timeline.tsx`) follows the
conventions of Earth-observation viewers such as NASA Worldview: a tabbed sidebar of places and
layers, a date and time bar along the bottom, and translucent panels over the map. It uses no NASA
logo or name. New candidate analogs are marked in yellow throughout; already-studied places are
shown dimmer, as reference, and can be hidden with **Show new candidates only**.

## Guided tour, country finder, similar places and test ideas

- **Guided tour** (`src/components/Tour.tsx`): eight stops that tell the project's story by moving
  the map. Every figure in the captions is read from the app's data when the tour starts, so the
  story can't drift from the numbers.
- **Candidates near you** (`src/components/Sidebar.tsx`): lists the places in a chosen country,
  starting with the country in the browser's language setting, and the five places nearest to the
  visitor. The location is only used in the browser to measure distances.
- **Places like this one** (`src/data/similarPlaces.ts`): an Earth-to-Earth search. Each place is
  compared with every other on slope spread, flat ground, relief, roughness, how roughness grows with
  distance, bare ground, rain, ground temperature and mapped rock family, and the five closest are
  listed. The figure is the plain average of the traits both places have. It means two places are
  physically alike in what was measured, not that they share a history.
- **What you could test here** (`src/data/testIdeas.ts`): up to three suggestions per place, worked
  out by rule from its landform and the measurements (flat ground, dryness, bare ground, winter
  cold), with the travel time to the nearest city. They are starting points, not published test
  plans, and the panel says so.

## The globe and the sky

The world view is a MapLibre globe, which flattens to a regular map as you zoom in. Behind it,
`src/map/spaceBackdrop.ts` draws the stars, Sun and Moon, which turn as the globe turns.

The **Time** control (UTC) sets the moment shown; it starts at the current time. `src/map/sunlight.ts`
calculates the Sun and Moon with the Astronomical Almanac's low-precision formulae (about 0.01° for
the Sun, 0.3° for the Moon) and shades the side of the Earth where the Sun is below the horizon,
through twilight to 18° below it. The Moon's phase comes from the same calculation. Site views and
drone view follow the same clock: the ground darkens and the sky changes colour with the Sun's
height at that place. Night there is kept lighter than true darkness so the terrain can be read.
Drone view also lights the terrain from the Sun's real direction, with shadows cast by ridges; at
night it uses a raised Sun so relief stays readable. The site view doesn't, and any shadows already in
the photos are from when they were taken.

**Play** runs a time-lapse at 1, 6 or 12 hours per second. The clock, slider, lighting and sky all
follow it.

Not to scale or simplified: the Sun and Moon are enlarged, the Moon's dark side is brightened as if
by strong earthshine so a new Moon can still be seen, the Moon's orbit is drawn at 1.75 Earth radii
(really about 60) in its true direction, the Sun waits at the window edge on its own side when out
of view, the star positions are generated rather than catalogued, and bending of sunlight
by the air and Moon parallax are ignored.

## Staying sharp when zoomed in

With an Esri key the map shows streamed aerial imagery at every zoom, and coastlines, rivers,
borders and contour lines are drawn as vectors (`tools/build_vector_lines.py`). Contours come from
Copernicus DEM at 100 m intervals. To return to the bundled atlas map, set `LIVE_IMAGERY` to `false`
in `src/map/liveDetail.ts`; `VECTOR_LINES` does the same for the lines. Each visit is capped at
6,000 imagery tiles.

Esri's imagery mosaics different satellites at different zooms, so tiles sharper than zoom 12 are
re-toned against zoom 12 in the browser (`colourMatchedTile` in `src/drone/imageryService.ts`). This
only changes appearance. Site imagery is also requested as the camera sets off, so it's usually in
the browser's cache on arrival.

## Analog science

`tools/build_science.py` adds terrain science (RMS height difference at several distances and the
Hurst exponent, on grids matched to each planetary map) and physical environment (sunlight at each
latitude, day length, gravity and air overhead). The physics uses NASA Planetary Fact Sheet values.
Sunlight is top-of-atmosphere on a circular orbit, and pressure is scaled by elevation.

`tools/build_geology.py` reads the USGS geologic maps of Mars (SIM 3292) and the Moon. A rock family
is only assigned when a unit's own name states it, so many units honestly stay "Can't say". Those
maps aren't in this repository; the tool's header says which files to pass in.

## Browsers

Works in current Chrome, Edge, Firefox and Safari, and needs WebGL 2. Without WebGL the site index
and details still work, on a still image of the map.

Drone view loads satellite imagery live, so it needs a connection for the sharpest picture. Offline
it falls back to shaded relief.

For sub-metre imagery near the drone, put a free Esri key in `.env.local` as `VITE_ESRI_API_KEY=...`.
Without one, drone view uses Sentinel-2 only. Restrict the key to your site's address in Esri's
settings, because a key used in a web page is visible to visitors, and keep pay-as-you-go off to
stay inside the free tier. Tiles are streamed and never stored in this project.

## Test

```
npx playwright install chromium
npm run build
npm run test:e2e
```

Screenshots are written to `screenshots/`. The specs in `e2e/` were written for an earlier version with demo
places, and need updating before they pass against the current site list.

## Credits

- Map colour and relief: [Natural Earth](https://www.naturalearthdata.com/) Natural Earth I and
  Gray Earth (public domain). Recoloured and cut into tiles by `tools/build_basemap.py`.
- Elevation, for site detail and drone view:
  [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/), from Mapzen and its
  sources, including NASA SRTM. See the
  [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Climate heat maps: [CHELSA V2.1](https://www.chelsa-climate.org/), 1981–2010.
- Remoteness heat map: [Global travel time to cities](https://figshare.com/articles/Travel_time_to_cities_and_ports_in_the_year_2015/7638134) (CC BY 4.0).
- Markers: [Smithsonian Volcanoes of the World](https://volcano.si.edu/).
- Worldview layers: we acknowledge the use of imagery provided by services from NASA's Global
  Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).
- Moon surface temperature: [LRO Diviner Global Cumulative Products](https://pds-geosciences.wustl.edu/missions/lro/diviner.htm),
  Williams et al. (2017), NASA Planetary Data System. Earth surface temperature:
  [NASA POWER](https://power.larc.nasa.gov/), NASA Langley Research Center.
- The Moon in the world view: [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), NASA's Scientific
  Visualization Studio, from Lunar Reconnaissance Orbiter data.
- Drone view imagery: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains
  modified Copernicus Sentinel data 2024).

### Imagery licence

EOxCloudless is free for non-commercial use (CC BY-NC-SA 4.0) as long as the credit stays visible
in the interface. It is streamed from EOX's public service and deliberately not stored in this
repository, because EOX's documentation doesn't clearly allow bulk copying. Any commercial use, or
bundling the tiles, needs an agreement with EOX: cloudless@eox.at.
- Map rendering: [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause).
- 3D rendering: [three.js](https://threejs.org/) (MIT).
- Type: Public Sans and DM Mono (SIL Open Font License), via Fontsource.
