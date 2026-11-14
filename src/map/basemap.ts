import type { Feature, FeatureCollection, Position } from 'geojson';
import type { StyleSpecification, LayerSpecification, SkySpecification, SourceSpecification } from 'maplibre-gl';
import detailRegions from './detailRegions.generated.json';
import { LIVE_IMAGERY_LAYER, LIVE_IMAGERY_TILES, liveImageryOn } from './liveDetail';

/**
 * Basemap configuration. This is the one place to change what the map is drawn from.
 *
 * Swap the basemap: point `world.tiles` at another raster tile template.
 * Add local terrain: set `localTerrain` to a raster-dem tile template. The camera
 * code reads positions from the map, so it needs no changes.
 */
const base = `${window.location.origin}${import.meta.env.BASE_URL}`;

export const basemap = {
  world: {
    tiles: `${base}tiles/world/{z}/{x}/{y}.webp`,
    tileSize: 512,
    maxzoom: 5,
  },
  detailTiles: (regionId: string) => `${base}tiles/detail/${regionId}/{z}/{x}/{y}.webp`,
  /** Low-resolution picture of the same map, used when WebGL is unavailable. */
  staticImage: `${base}tiles/world/0/0/0.webp`,
  credit: { label: 'Natural Earth, Terrain Tiles on AWS', url: 'https://www.naturalearthdata.com/' },
};

export interface LocalTerrainConfig {
  tiles: string;
  encoding: 'mapbox' | 'terrarium';
  tileSize: number;
  maxzoom: number;
}

/**
 * Elevation for the 3D local view. Loaded live; if it can't be reached the local view stays flat.
 * The camera code switches it on near a site, so the world view stays a smooth globe.
 */
export const localTerrain: LocalTerrainConfig | null = {
  tiles: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 12,
};

export const TERRAIN_SOURCE_ID = 'local-terrain';

const OCEAN = '#0d3e7c';

function graticule(step: number, skipStep?: number): FeatureCollection {
  const features: Feature[] = [];
  const skip = (value: number) => skipStep !== undefined && value % skipStep === 0;
  const line = (coordinates: Position[]): Feature => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  });
  for (let lng = -180; lng <= 180; lng += step) {
    if (!skip(lng)) features.push(line([[lng, -85], [lng, 85]]));
  }
  for (let lat = -80; lat <= 80; lat += step) {
    if (!skip(lat)) features.push(line([[-180, lat], [180, lat]]));
  }
  return { type: 'FeatureCollection', features };
}

const detailLevelId = (region: { id: string; zoom: number }) => `${region.id}-${region.zoom}`;

export const RASTER_LAYER_IDS = [
  'relief-world',
  ...detailRegions.map((region) => `relief-${detailLevelId(region)}`),
  ...(liveImageryOn ? [LIVE_IMAGERY_LAYER] : []),
];

/** The same sky as drone view, seen when the tilted local view reaches the horizon. Daytime colours. */
export const SKY: SkySpecification = {
  'sky-color': '#14457f',
  'horizon-color': '#8db2c9',
  'fog-color': '#8db2c9',
  'sky-horizon-blend': 0.7,
  'horizon-fog-blend': 0.8,
  'fog-ground-blend': 0.55, // lower starts the haze closer to the camera
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 4, 0.45, 7, 0], // a glow around the globe; higher washes out the day side
};

export function createBasemapStyle(): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {
    world: {
      type: 'raster',
      tiles: [basemap.world.tiles],
      tileSize: basemap.world.tileSize,
      maxzoom: basemap.world.maxzoom,
    },
    'graticule-major': { type: 'geojson', data: graticule(30) },
    'graticule-minor': { type: 'geojson', data: graticule(1, 30) },
  };

  const rasterPaint = { 'raster-resampling': 'linear', 'raster-fade-duration': 180 } as const;

  const layers: LayerSpecification[] = [
    { id: 'water', type: 'background', paint: { 'background-color': OCEAN } },
    { id: 'relief-world', type: 'raster', source: 'world', paint: rasterPaint },
  ];

  // One source per zoom level, because each level covers a different area around its site.
  for (const region of detailRegions) {
    const id = detailLevelId(region);
    sources[`detail-${id}`] = {
      type: 'raster',
      tiles: [basemap.detailTiles(region.id)],
      tileSize: 512,
      minzoom: region.zoom,
      maxzoom: region.zoom,
      // Inset a hair, so rounding can't make the map ask for a tile just outside the patch.
      bounds: [
        region.bounds[0] + BOUNDS_INSET,
        region.bounds[1] + BOUNDS_INSET,
        region.bounds[2] - BOUNDS_INSET,
        region.bounds[3] - BOUNDS_INSET,
      ],
    };
    layers.push({
      id: `relief-${id}`,
      type: 'raster',
      source: `detail-${id}`,
      paint: rasterPaint,
    });
  }

  if (liveImageryOn) {
    sources[LIVE_IMAGERY_LAYER] = {
      type: 'raster',
      tiles: [LIVE_IMAGERY_TILES],
      tileSize: 256,
      maxzoom: 18,
    };
    layers.push({
      id: LIVE_IMAGERY_LAYER,
      type: 'raster',
      source: LIVE_IMAGERY_LAYER,
      paint: { 'raster-fade-duration': 0, 'raster-saturation': 0.18 }, // no fade, so no grey lingering
    });
  }

  layers.push(
    {
      id: 'graticule-major',
      type: 'line',
      source: 'graticule-major',
      paint: { 'line-color': '#efe7d6', 'line-width': 0.6, 'line-opacity': 0.13 },
    },
    {
      id: 'graticule-minor',
      type: 'line',
      source: 'graticule-minor',
      minzoom: 4.4,
      paint: {
        'line-color': '#efe7d6',
        'line-width': 0.6,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.4, 0, 5.6, 0.12],
      },
    },
  );

  const style: StyleSpecification = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    // A sphere when zoomed out. MapLibre flattens it to a regular map as you zoom in close.
    projection: { type: 'globe' },
    sky: SKY,
    sources,
    layers,
  };

  if (localTerrain) {
    style.sources[TERRAIN_SOURCE_ID] = {
      type: 'raster-dem',
      tiles: [localTerrain.tiles],
      encoding: localTerrain.encoding,
      tileSize: localTerrain.tileSize,
      maxzoom: localTerrain.maxzoom,
    };
  }

  return style;
}

const BOUNDS_INSET = 0.001;
const OVERVIEW_CENTER: [number, number] = [-30, 20];
const GLOBE_FILL = 0.46; // globe radius as a share of the window's shorter side

/** Frames the whole globe in the window, facing the Americas, Europe and Africa. */
export function overviewCamera(width: number, height: number) {
  const radius = GLOBE_FILL * Math.min(width, height);
  // MapLibre sizes the globe so its scale at the centre matches the flat map's at that latitude.
  const zoom = Math.log2((radius * 2 * Math.PI * Math.cos((OVERVIEW_CENTER[1] * Math.PI) / 180)) / 512);
  return { center: OVERVIEW_CENTER, zoom, pitch: 0, bearing: 0 };
}
