import { addProtocol, setMaxParallelImageRequests } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { colourMatchedTile, detailTileUrl, hasDetailImagery, isPlaceholderImage } from '../drone/imageryService';

/**
 * What keeps the map sharp at every zoom. To go back to the bundled atlas map,
 * set LIVE_IMAGERY to false.
 */
export const LIVE_IMAGERY = true; // streamed Esri imagery when zoomed in
export const VECTOR_LINES = true; // coastlines, rivers, borders and contours

export const liveImageryOn = LIVE_IMAGERY && hasDetailImagery;
export const LIVE_IMAGERY_LAYER = 'imagery-live';
const CONTOURS_FROM_ZOOM = 9;

const PROTOCOL = 'esri-imagery';
export const LIVE_IMAGERY_TILES = `${PROTOCOL}://{z}/{y}/{x}`;
const MAX_TILES_PER_VISIT = 6000; // past this the bundled map shows, protecting the free allowance
const VECTOR_FROM_ZOOM = 3.5;
const base = import.meta.env.BASE_URL;

/** A transparent 1×1 PNG: what the map gets where there is no imagery to show. */
const EMPTY_TILE = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGBgAAAABQABDQottAAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
).buffer;

let tilesUsed = 0;

if (liveImageryOn) {
  setMaxParallelImageRequests(32); // the view is tile-heavy, and gaps look worse than a brief burst
  addProtocol(PROTOCOL, async (params, controller) => {
    if (tilesUsed >= MAX_TILES_PER_VISIT) return { data: EMPTY_TILE.slice(0) };
    tilesUsed += 1;
    const [z, y, x] = params.url.replace(`${PROTOCOL}://`, '').split('/').map(Number);
    try {
      const response = await fetch(detailTileUrl(z, y, x), { signal: controller.signal });
      if (!response.ok) return { data: EMPTY_TILE.slice(0) };
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      if (isPlaceholderImage(bitmap)) {
        bitmap.close();
        return { data: EMPTY_TILE.slice(0) };
      }
      const matched = await colourMatchedTile(bitmap, z, y, x).catch(() => null);
      bitmap.close();
      if (!matched) return { data: await blob.arrayBuffer() };
      const toned = await new Promise<Blob | null>((resolve) => matched.toBlob(resolve, 'image/jpeg', 0.92));
      return { data: await (toned ?? blob).arrayBuffer() };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      return { data: EMPTY_TILE.slice(0) }; // the bundled map shows through
    }
  });
}

const PRELOAD_CONNECTIONS = 16;
const preloaded = new Set<string>();

/**
 * Fetches a site's imagery as the camera sets off, so the browser already holds it on arrival.
 * It only warms the browser's short-lived cache; nothing is saved to the project.
 */
export function preloadSiteImagery(lng: number, lat: number, zoom: number, bearing: number): void {
  if (!liveImageryOn) return;
  const finest = Math.ceil(zoom) + 1;
  const jobs: { z: number; x: number; y: number }[] = [];
  const sin = Math.sin((lat * Math.PI) / 180);

  // Coarse first, so a blurry version is ready before the sharp one.
  for (const [z, radius] of [[finest - 2, 3], [finest - 1, 4], [finest, 6]] as const) {
    const n = 2 ** z;
    const heading = (bearing * Math.PI) / 180;
    // The tilted view looks ahead of the site, so the covered area leans that way.
    const centerX = Math.floor(((lng + 180) / 360) * n + Math.sin(heading) * (radius / 2));
    const centerY = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n - Math.cos(heading) * (radius / 2));
    const ring: { z: number; x: number; y: number; distance: number }[] = [];
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        ring.push({ z, x: ((x % n) + n) % n, y, distance: Math.hypot(x - centerX, y - centerY) });
      }
    }
    ring.sort((a, b) => a.distance - b.distance);
    jobs.push(...ring.filter((tile) => tile.y >= 0 && tile.y < n));
  }

  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const key = `${job.z}/${job.y}/${job.x}`;
      if (preloaded.has(key) || tilesUsed >= MAX_TILES_PER_VISIT) continue;
      preloaded.add(key);
      tilesUsed += 1;
      try {
        await (await fetch(detailTileUrl(job.z, job.y, job.x))).blob();
      } catch {
        // a missed preload just means this tile loads normally later
      }
    }
  };
  for (let i = 0; i < PRELOAD_CONNECTIONS; i += 1) void worker();
}

/** Adds the lines once they're useful, so the world view doesn't load 15 MB it can't show. */
export function installVectorLines(map: MapLibreMap): void {
  if (!VECTOR_LINES) return;
  const install = () => {
    if (map.getZoom() < VECTOR_FROM_ZOOM || map.getSource('vector-coastline')) return;
    map.off('zoom', install);
    const layers: { id: string; color: string; width: number; opacity: number }[] = [
      { id: 'rivers', color: '#a9d6f0', width: 0.8, opacity: 0.75 },
      { id: 'boundaries', color: '#f5eedf', width: 0.7, opacity: 0.55 },
      { id: 'coastline', color: '#f5eedf', width: 0.8, opacity: 0.4 },
    ];
    for (const layer of layers) {
      const id = `vector-${layer.id}`;
      map.addSource(id, { type: 'geojson', data: `${base}data/vector/${layer.id}.geojson` });
      map.addLayer({
        id,
        type: 'line',
        source: id,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': layer.color,
          'line-width': layer.width,
          // Fades out up close, where these 1:10m lines would stray from the real shoreline.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 3.5, 0, 4.5, layer.opacity, 11, layer.opacity, 12.5, 0],
        },
      });
    }
  };
  map.on('zoom', install);
  install();
}

const CONTOURS = 'site-contours';

export function showContours(map: MapLibreMap, siteId: string): void {
  if (!VECTOR_LINES || map.getSource(CONTOURS)) return;
  map.addSource(CONTOURS, { type: 'geojson', data: `${base}data/sites/${siteId}/contours.geojson` });
  map.addLayer({
    id: CONTOURS,
    type: 'line',
    source: CONTOURS,
    minzoom: CONTOURS_FROM_ZOOM,
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#f5eedf',
      'line-width': ['case', ['==', ['get', 'index'], 1], 1.2, 0.5],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], CONTOURS_FROM_ZOOM, 0, 10, 0.65],
    },
  });
}

export function hideContours(map: MapLibreMap): void {
  if (!map.getStyle() || !map.getSource(CONTOURS)) return;
  map.removeLayer(CONTOURS);
  map.removeSource(CONTOURS);
}
