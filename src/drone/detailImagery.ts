import * as THREE from 'three';
import { colourMatchedTile, detailTileUrl, isPlaceholderImage } from './imageryService';

/**
 * Streams sharp aerial imagery around the drone: three nested squares, finest in the middle.
 *
 * Tiles are only ever held in memory. Esri's basemap service is for live use with a key, so
 * nothing from it is written to this project. Without a key in .env.local, drone view simply
 * keeps its Sentinel-2 imagery.
 */

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE = 256;
const SIDE = 12; // tiles per side of each square
const RECENTRE_TILES = 3;
const CONNECTIONS = 8;
const MAX_TILES_PER_FLIGHT = 3000; // keeps one visit well inside the free monthly allowance
const UPLOAD_INTERVAL_MS = 150;
const TARGET_METRES = 0.5; // the same sharpness as the fully zoomed-in map
const MISSING_LEVEL_AFTER = 6; // failed tiles with no successes before a level is given up on
const LOOK_AHEAD = 0.12; // share of a square to bias toward where the camera is pointing

interface Level {
  zoom: number;
  metresPerPixel: number;
  centerPxX: number;
  centerPxY: number;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  window: THREE.Vector4;
  originX: number | null;
  originY: number;
  done: Set<string>;
  dirty: boolean;
  failures: number;
  successes: number;
}

interface Job {
  level: Level;
  x: number;
  y: number;
  key: string;
}

export class DetailImagery {
  readonly levels: Level[];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Set<string>();
  private readonly seen = new Set<string>();
  private active = 0;
  private used = 0;
  private lastUpload = 0;
  private disposed = false;

  constructor(lat: number, lng: number, maxAnisotropy: number, coarsePointer: boolean) {
    const cos = Math.cos((lat * Math.PI) / 180);
    const finest = Math.floor(Math.log2((EARTH_CIRCUMFERENCE_M * cos) / (TILE * TARGET_METRES)));
    const zooms = coarsePointer
      ? [finest - 2, finest - 3]
      : [finest, finest - 1, finest - 2, finest - 3, finest - 4];
    const sin = Math.sin((lat * Math.PI) / 180);

    this.levels = zooms.map((zoom) => {
      const world = TILE * 2 ** zoom;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIDE * TILE;
      const context = canvas.getContext('2d')!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = maxAnisotropy;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      return {
        zoom,
        metresPerPixel: (EARTH_CIRCUMFERENCE_M * cos) / world,
        centerPxX: ((lng + 180) / 360) * world,
        centerPxY: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
        canvas,
        context,
        texture,
        window: new THREE.Vector4(0, 0, 0, 0),
        originX: null,
        originY: 0,
        done: new Set<string>(),
        dirty: false,
        failures: 0,
        successes: 0,
      };
    });
  }

  /** Call every frame with the drone's position in metres from the site. */
  update(x: number, z: number, forwardX: number, forwardZ: number, now: number): void {
    let moved = false;
    for (const level of this.levels) {
      const span = SIDE * TILE * level.metresPerPixel;
      const aimX = x + forwardX * span * LOOK_AHEAD;
      const aimZ = z + forwardZ * span * LOOK_AHEAD;
      const tileX = (level.centerPxX + aimX / level.metresPerPixel) / TILE;
      const tileY = (level.centerPxY + aimZ / level.metresPerPixel) / TILE;
      const originX = Math.floor(tileX - SIDE / 2 + 0.5);
      const originY = Math.floor(tileY - SIDE / 2 + 0.5);

      if (
        level.originX === null ||
        Math.abs(originX - level.originX) >= RECENTRE_TILES ||
        Math.abs(originY - level.originY) >= RECENTRE_TILES
      ) {
        this.recentre(level, originX, originY);
        moved = true;
        break; // one big texture upload per frame keeps flight smooth
      }
    }
    if (moved) this.rebuildQueue(x, z);

    if (now - this.lastUpload > UPLOAD_INTERVAL_MS) {
      const next = this.levels.find((level) => level.dirty);
      if (next) {
        this.lastUpload = now;
        next.dirty = false;
        next.texture.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const level of this.levels) level.texture.dispose();
  }

  private recentre(level: Level, originX: number, originY: number): void {
    const { context, canvas } = level;
    if (level.originX !== null) {
      // Keep the tiles still in view; the picture and its position change together.
      context.globalCompositeOperation = 'copy';
      context.drawImage(canvas, (level.originX - originX) * TILE, (level.originY - originY) * TILE);
      context.globalCompositeOperation = 'source-over';
    }
    level.originX = originX;
    level.originY = originY;
    for (const key of level.done) {
      const [x, y] = key.split('/').map(Number);
      if (!this.inWindow(level, x, y)) level.done.delete(key);
    }
    level.window.set(
      (originX * TILE - level.centerPxX) * level.metresPerPixel,
      (originY * TILE - level.centerPxY) * level.metresPerPixel,
      SIDE * TILE * level.metresPerPixel,
      SIDE * TILE * level.metresPerPixel,
    );
    level.dirty = false;
    level.texture.needsUpdate = true;
  }

  private inWindow(level: Level, x: number, y: number): boolean {
    const originX = level.originX ?? 0;
    return x >= originX && x < originX + SIDE && y >= level.originY && y < level.originY + SIDE;
  }

  /** Coarse squares first, so the view fills in quickly, then nearest tiles first in each. */
  private rebuildQueue(x: number, z: number): void {
    const jobs: { job: Job; order: number; distance: number }[] = [];
    this.levels.forEach((level, levelIndex) => {
      if (level.successes === 0 && level.failures >= MISSING_LEVEL_AFTER) return;
      const tileX = (level.centerPxX + x / level.metresPerPixel) / TILE;
      const tileY = (level.centerPxY + z / level.metresPerPixel) / TILE;
      const originX = level.originX ?? 0;
      for (let row = 0; row < SIDE; row += 1) {
        for (let column = 0; column < SIDE; column += 1) {
          const tx = originX + column;
          const ty = level.originY + row;
          const key = `${tx}/${ty}`;
          if (level.done.has(key) || this.inFlight.has(`${level.zoom}/${key}`)) continue;
          jobs.push({
            job: { level, x: tx, y: ty, key },
            order: this.levels.length - levelIndex,
            distance: Math.hypot(tx + 0.5 - tileX, ty + 0.5 - tileY),
          });
        }
      }
    });
    jobs.sort((a, b) => b.order - a.order || a.distance - b.distance);
    this.queue.length = 0;
    this.queue.push(...jobs.map((entry) => entry.job));
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.active < CONNECTIONS && this.used < MAX_TILES_PER_FLIGHT) {
      const job = this.queue.shift();
      if (!job) return;
      if (!this.inWindow(job.level, job.x, job.y)) continue;
      this.load(job);
    }
  }

  private async placeTile(image: HTMLImageElement, level: Level, x: number, y: number, key: string): Promise<void> {
    if (this.disposed || !this.inWindow(level, x, y)) return;
    level.done.add(key);
    level.successes += 1;
    if (isPlaceholderImage(image)) return;
    const matched = await colourMatchedTile(image, level.zoom, y, x).catch(() => null);
    if (this.disposed || !this.inWindow(level, x, y)) return;
    const px = (x - (level.originX ?? 0)) * TILE;
    const py = (y - level.originY) * TILE;
    level.context.drawImage(matched ?? image, px, py, TILE, TILE);
    level.dirty = true;
  }

  private load({ level, x, y, key }: Job): void {
    const flightKey = `${level.zoom}/${key}`;
    this.active += 1;
    // A tile seen earlier in this flight comes from the browser cache, so it isn't charged again.
    if (!this.seen.has(flightKey)) {
      this.seen.add(flightKey);
      this.used += 1;
    }
    this.inFlight.add(flightKey);

    const finish = () => {
      this.active -= 1;
      this.inFlight.delete(flightKey);
      this.pump();
    };

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      void this.placeTile(image, level, x, y, key).finally(finish);
    };
    image.onerror = () => {
      // Esri has no tile this fine here. Stop asking, and let the next layer down show.
      level.done.add(key);
      level.failures += 1;
      finish();
    };
    image.src = detailTileUrl(level.zoom, y, x);
  }
}
