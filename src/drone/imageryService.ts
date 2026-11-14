/**
 * Esri imagery service details, kept apart from the 3D code so the map can use them
 * without loading three.js.
 */

const API_KEY = (import.meta.env.VITE_ESRI_API_KEY as string | undefined)?.trim() ?? '';
const SERVICE = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';

export const hasDetailImagery = API_KEY.length > 0;

export const detailTileUrl = (z: number, y: number, x: number) => `${SERVICE}/tile/${z}/${y}/${x}?token=${API_KEY}`;

/** Esri returns a flat grey "not yet available" picture where it has no data at this zoom. */
const probe = document.createElement('canvas');
probe.width = probe.height = 16;
const probeContext = probe.getContext('2d', { willReadFrequently: true });

export function isPlaceholderImage(image: CanvasImageSource): boolean {
  if (!probeContext) return false;
  probeContext.drawImage(image, 0, 0, 16, 16);
  const { data } = probeContext.getImageData(0, 0, 16, 16);
  let grey = 0;
  for (let i = 0; i < data.length; i += 4) {
    const neutral = Math.abs(data[i] - data[i + 1]) < 4 && Math.abs(data[i + 1] - data[i + 2]) < 4;
    if (neutral && data[i] > 185 && data[i] < 225) grey += 1;
  }
  return grey > 16 * 16 * 0.85;
}

/**
 * Esri's imagery is a mosaic: different satellites at different zooms, so neighbouring tiles can
 * differ in colour. Sharp tiles are re-toned against one coarse reference zoom, keeping their
 * detail while taking broad colour from the reference. This changes appearance only; nothing
 * in the analysis reads these pixels.
 */
const REFERENCE_ZOOM = 12;
const TILE_SIZE = 256;
const GAIN_MIN = 0.45;
const GAIN_MAX = 2.2;
const MAX_CACHED_REFERENCES = 96;
const references = new Map<string, Promise<Uint8ClampedArray | null>>();

function makeCanvas(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return { canvas, context: canvas.getContext('2d', { willReadFrequently: true })! };
}

function loadReference(x: number, y: number): Promise<Uint8ClampedArray | null> {
  const key = `${x}/${y}`;
  const existing = references.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const response = await fetch(detailTileUrl(REFERENCE_ZOOM, y, x));
      if (!response.ok) return null;
      const bitmap = await createImageBitmap(await response.blob());
      const { context } = makeCanvas(TILE_SIZE);
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } catch {
      return null;
    }
  })();
  references.set(key, pending);
  if (references.size > MAX_CACHED_REFERENCES) references.delete(references.keys().next().value as string);
  return pending;
}

/** Returns a re-toned copy of a tile, or null if it's coarse enough to leave alone. */
export async function colourMatchedTile(
  image: CanvasImageSource,
  z: number,
  y: number,
  x: number,
): Promise<HTMLCanvasElement | null> {
  if (z <= REFERENCE_ZOOM) return null;
  const shift = z - REFERENCE_ZOOM;
  const scale = 2 ** shift;
  const reference = await loadReference(x >> shift, y >> shift);
  if (!reference) return null;

  // The part of the reference tile that this tile covers, as a coarse grid of colours.
  const regionSize = TILE_SIZE / scale;
  const cells = Math.max(1, Math.min(6, Math.floor(regionSize)));
  const startX = (x & (scale - 1)) * regionSize;
  const startY = (y & (scale - 1)) * regionSize;
  const target = new Float32Array(cells * cells * 3);
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const px0 = Math.floor(startX + (col * regionSize) / cells);
      const py0 = Math.floor(startY + (row * regionSize) / cells);
      const px1 = Math.max(px0 + 1, Math.floor(startX + ((col + 1) * regionSize) / cells));
      const py1 = Math.max(py0 + 1, Math.floor(startY + ((row + 1) * regionSize) / cells));
      const totals = [0, 0, 0];
      let count = 0;
      for (let py = py0; py < py1; py += 1) {
        for (let px = px0; px < px1; px += 1) {
          const index = (Math.min(py, 255) * TILE_SIZE + Math.min(px, 255)) * 4;
          totals[0] += reference[index];
          totals[1] += reference[index + 1];
          totals[2] += reference[index + 2];
          count += 1;
        }
      }
      for (let c = 0; c < 3; c += 1) target[(row * cells + col) * 3 + c] = totals[c] / count;
    }
  }

  const small = makeCanvas(cells);
  small.context.imageSmoothingQuality = 'high';
  small.context.drawImage(image, 0, 0, cells, cells);
  const current = small.context.getImageData(0, 0, cells, cells).data;
  const gains = new Float32Array(cells * cells * 3);
  for (let i = 0; i < cells * cells; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      gains[i * 3 + c] = Math.max(GAIN_MIN, Math.min(GAIN_MAX, (target[i * 3 + c] + 4) / (current[i * 4 + c] + 4)));
    }
  }

  // Applied as a smooth field, so the correction itself leaves no visible grid.
  const full = makeCanvas(TILE_SIZE);
  full.context.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
  const pixels = full.context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const { data } = pixels;
  for (let py = 0; py < TILE_SIZE; py += 1) {
    const fy = Math.max(0, Math.min(cells - 1, ((py + 0.5) / TILE_SIZE) * cells - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(cells - 1, y0 + 1);
    const ty = fy - y0;
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const fx = Math.max(0, Math.min(cells - 1, ((px + 0.5) / TILE_SIZE) * cells - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(cells - 1, x0 + 1);
      const tx = fx - x0;
      const index = (py * TILE_SIZE + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        const top = gains[(y0 * cells + x0) * 3 + c] * (1 - tx) + gains[(y0 * cells + x1) * 3 + c] * tx;
        const bottom = gains[(y1 * cells + x0) * 3 + c] * (1 - tx) + gains[(y1 * cells + x1) * 3 + c] * tx;
        data[index + c] = data[index + c] * (top * (1 - ty) + bottom * ty);
      }
    }
  }
  full.context.putImageData(pixels, 0, 0);
  return full.canvas;
}

/** The credit Esri's service publishes for this imagery. */
export async function fetchDetailCredit(): Promise<string> {
  try {
    const response = await fetch(`${SERVICE}?f=json&token=${API_KEY}`);
    const info = (await response.json()) as { copyrightText?: string };
    if (info.copyrightText) return info.copyrightText;
  } catch {
    // fall through to the general credit
  }
  return 'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
}
