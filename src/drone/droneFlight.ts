import * as THREE from 'three';
import type { DetailImagery } from './detailImagery';

/**
 * Free flight over real elevation data. Knows nothing about React or the map.
 *
 * World units are metres: +x east, +z south, +y up, with the site at x = z = 0.
 * Heights and shading come from public/terrain/<id>/ (tools/build_drone_terrain.py).
 */

export interface TerrainMeta {
  size: number;
  metresPerSample: number;
  minElevation: number;
  maxElevation: number;
}

export interface TerrainData {
  meta: TerrainMeta;
  heights: Int16Array;
  shade: THREE.Texture;
}

/** A map data picture and where it lies in the scene. */
export interface OverlayPlacement {
  url: string;
  minX: number;
  minZ: number;
  width: number;
  depth: number;
}

export interface FlightReadout {
  x: number;
  z: number;
  groundElevation: number;
  aboveGround: number;
  heading: number;
  atEdge: boolean;
}

export interface MarkPosition {
  x: number;
  y: number;
  visible: boolean;
}

export type FlightAction = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down' | 'boost';

// The baked relief and these colours are already display values, so skip conversion.
THREE.ColorManagement.enabled = false;

const GRID = window.matchMedia('(pointer: coarse)').matches ? 512 : 768; // phones get a lighter mesh
const RANGE_FRACTION = 0.255; // how far the drone can fly from the site, as a share of the grid
const FOG_DISTANCE_M = 12_000; // lower is thicker: at this distance the view is about 63% haze
const MIN_CLEARANCE = 70;
const MAX_CLEARANCE = 3200;
const CRUISE = 190;
const BOOST = 520;
const CLIMB = 150;
const LOOK_SPEED = 0.0034;
const REVEAL_MS = 2400;
const SHADE_AMBIENT = 0.36; // share of light that isn't direct sun; lower gives harder relief
const MIN_SUN_UP = 0.3; // about 17° up: at night the terrain still needs a light to be read by
const SHADOW_STRIDE = 2; // height samples per shadow step, and per shadow cell
const SHADOW_BIAS_M = 4; // stops flat ground shadowing itself
const LIGHT_RANGE = 2; // the light map stores 0 to this, as a multiple of the photo's brightness
const HAZE = new THREE.Color(0x8db2c9);
const ZENITH = new THREE.Color(0x14457f);

const KEY_ACTIONS: Record<string, FlightAction> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyE: 'up',
  KeyQ: 'down',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export async function loadTerrain(id: string): Promise<TerrainData> {
  const base = `${import.meta.env.BASE_URL}terrain/${id}/`;
  const [metaResponse, heightResponse, shade] = await Promise.all([
    fetch(`${base}meta.json`),
    fetch(`${base}height.bin`),
    new THREE.TextureLoader().loadAsync(`${base}shade.webp`),
  ]);
  if (!metaResponse.ok || !heightResponse.ok) throw new Error('Terrain files are missing');
  const meta = (await metaResponse.json()) as TerrainMeta;
  const heights = new Int16Array(await heightResponse.arrayBuffer());
  if (heights.length !== meta.size * meta.size) throw new Error('Terrain file has the wrong size');
  return { meta, heights, shade };
}

export interface ImageryPatch {
  texture: THREE.Texture;
  minX: number;
  minZ: number;
  width: number;
  depth: number;
}

// Loaded live from the public service rather than bundled: see the licence note in the README.
const IMAGERY_URL =
  'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg';
export const IMAGERY_CREDIT =
  'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)';
const IMAGERY_TARGET_METRES = 8;
const IMAGERY_MAX_TILES = 16; // per side, which keeps the texture within 4096 px
const IMAGERY_CONNECTIONS = 8;
const IMAGERY_MARGIN = 1500;
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Imagery tile failed'));
    image.src = url;
  });
}

/** Sharp satellite imagery over the flyable area. Resolves to null if it isn't reachable. */
export async function loadImagery(
  lng: number,
  lat: number,
  meta: TerrainMeta,
  maxAnisotropy: number,
): Promise<ImageryPatch | null> {
  const cos = Math.cos((lat * Math.PI) / 180);
  const zoom = Math.floor(Math.log2((EARTH_CIRCUMFERENCE_M * cos) / (256 * IMAGERY_TARGET_METRES)));
  const worldPixels = 256 * 2 ** zoom;
  const metresPerPixel = (EARTH_CIRCUMFERENCE_M * cos) / worldPixels;
  const centerX = ((lng + 180) / 360) * worldPixels;
  const sin = Math.sin((lat * Math.PI) / 180);
  const centerY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldPixels;

  const range = (meta.size - 1) * meta.metresPerSample * RANGE_FRACTION + IMAGERY_MARGIN;
  const half = Math.min(range / metresPerPixel, (IMAGERY_MAX_TILES * 256) / 2 - 1);
  const firstX = Math.floor((centerX - half) / 256);
  const firstY = Math.floor((centerY - half) / 256);
  const across = Math.min(Math.floor((centerX + half) / 256) - firstX + 1, IMAGERY_MAX_TILES);
  const down = Math.min(Math.floor((centerY + half) / 256) - firstY + 1, IMAGERY_MAX_TILES);

  const canvas = document.createElement('canvas');
  canvas.width = across * 256;
  canvas.height = down * 256;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const queue: [number, number][] = [];
  for (let y = 0; y < down; y += 1) for (let x = 0; x < across; x += 1) queue.push([x, y]);
  const total = queue.length;
  let failed = 0;

  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [x, y] = next;
      try {
        const url = IMAGERY_URL.replace('{z}', String(zoom))
          .replace('{x}', String(firstX + x))
          .replace('{y}', String(firstY + y));
        context.drawImage(await loadImage(url), x * 256, y * 256);
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: IMAGERY_CONNECTIONS }, worker));
  if (failed > total * 0.25) return null;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return {
    texture,
    minX: (firstX * 256 - centerX) * metresPerPixel,
    minZ: (firstY * 256 - centerY) * metresPerPixel,
    width: across * 256 * metresPerPixel,
    depth: down * 256 * metresPerPixel,
  };
}

export class DroneFlight {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 20, 90_000);
  private readonly sky: THREE.Mesh;
  private lightMap: THREE.DataTexture | null = null;
  private readonly overlays = new Map<string, THREE.Texture>();
  private overlayRequest = 0;
  private readonly resize: ResizeObserver;
  private readonly held = new Set<FlightAction>();
  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly markPoint = new THREE.Vector3();
  private readonly radius: number;
  private terrainMaterial: THREE.ShaderMaterial | null = null;
  private imagery: ImageryPatch | null = null;
  private detail: DetailImagery | null = null;
  private yaw: number;
  private pitch = 0;
  private frameId: number | null = null;
  private lastFrame = 0;
  private lastReadout = 0;
  private revealStart = 0;
  private revealing = false;
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private readonly lookFrom = { x: 0, z: 0, height: 0, pitch: 0 };
  private readonly lookTo = { x: 0, z: 0, height: 0, pitch: 0 };

  constructor(
    private readonly container: HTMLElement,
    private readonly terrain: TerrainData,
    private readonly reducedMotion: boolean,
    private readonly onReadout: (readout: FlightReadout) => void,
    private readonly onMark: (mark: MarkPosition) => void,
    private readonly onContextLost: () => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(HAZE);
    container.appendChild(this.renderer.domElement);

    this.radius = (terrain.meta.size - 1) * terrain.meta.metresPerSample * RANGE_FRACTION;
    this.yaw = this.mostDramaticYaw();
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.buildTerrain());
    this.sky = this.buildSky();
    this.scene.add(this.sky);
    this.markPoint.set(0, this.heightAt(0, 0) + 30, 0);

    this.planReveal();
    this.applyPose(0);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.releaseAll);
  }

  /** Begin the descent into the scene and start taking input. */
  start(): void {
    if (this.frameId !== null) return;
    this.revealStart = performance.now();
    this.revealing = !this.reducedMotion;
    if (this.reducedMotion) this.applyPose(1);
    this.lastFrame = performance.now();
    this.frameId = requestAnimationFrame(this.frame);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  hasImagery(): boolean {
    return this.imagery !== null;
  }

  /** Lay satellite imagery over the shaded relief. Fades in if the flight is already running. */
  setImagery(patch: ImageryPatch): void {
    const material = this.terrainMaterial;
    if (!material) return;
    this.imagery = patch;
    material.uniforms.imagery.value = patch.texture;
    material.uniforms.imageryWindow.value.set(patch.minX, patch.minZ, patch.width, patch.depth);
    if (this.frameId === null || this.reducedMotion) material.uniforms.imageryMix.value = 1;
  }

  /** Attach streaming imagery. Starts loading around where the descent will end. */
  attachDetail(detail: DetailImagery): void {
    const material = this.terrainMaterial;
    if (!material) return;
    this.detail = detail;
    // The coarsest level always takes the last slot, which the shader paints first.
    const firstSlot = 5 - detail.levels.length;
    detail.levels.forEach((level, index) => {
      material.uniforms[`detail${firstSlot + index}`].value = level.texture;
      material.uniforms[`detailWindow${firstSlot + index}`].value = level.window;
    });
    // One level is set up per call, and the flight isn't running yet to do the rest.
    for (let i = 0; i < detail.levels.length; i += 1) {
      detail.update(this.lookTo.x, this.lookTo.z, -Math.sin(this.yaw), -Math.cos(this.yaw), performance.now());
    }
  }

  press(action: FlightAction, down: boolean): void {
    if (down) this.held.add(action);
    else this.held.delete(action);
  }

  getState() {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      ground: this.heightAt(this.position.x, this.position.z),
      yaw: this.yaw,
      revealing: this.revealing,
    };
  }

  /** Shows a map data picture on the ground, or removes it when passed null. */
  async showOverlay(placement: OverlayPlacement | null): Promise<void> {
    const request = (this.overlayRequest += 1);
    const uniforms = this.terrainMaterial?.uniforms;
    if (!uniforms) return;
    if (!placement) {
      uniforms.overlayOn.value = 0;
      return;
    }
    let texture = this.overlays.get(placement.url);
    if (!texture) {
      texture = await new THREE.TextureLoader().loadAsync(placement.url);
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.overlays.set(placement.url, texture);
    }
    if (request !== this.overlayRequest) return; // the user has already moved on to another layer
    uniforms.overlay.value = texture;
    uniforms.overlayWindow.value.set(placement.minX, placement.minZ, placement.width, placement.depth);
    uniforms.overlayOn.value = 1;
  }

  /** Matches the sky, ground and relief lighting to the time of day here. Colours are 0–255. */
  setLight(
    haze: readonly number[],
    zenith: readonly number[],
    ground: number,
    sun: { east: number; north: number; up: number },
  ): void {
    HAZE.setRGB(haze[0] / 255, haze[1] / 255, haze[2] / 255);
    ZENITH.setRGB(zenith[0] / 255, zenith[1] / 255, zenith[2] / 255);
    this.renderer.setClearColor(HAZE);
    if (!this.terrainMaterial) return;
    this.terrainMaterial.uniforms.daylight.value = ground;
    this.lightMap?.dispose();
    this.lightMap = this.buildLightMap(sun);
    this.terrainMaterial.uniforms.lightMap.value = this.lightMap;
  }

  /**
   * How much to brighten or darken the photo at each point: slopes facing the Sun gain light, slopes
   * facing away lose it, and ridges cast shadows. It's relative to flat ground, so level terrain
   * keeps the photo's own brightness. The imagery's own shadows, from when it was taken, remain.
   */
  private buildLightMap(sun: { east: number; north: number; up: number }): THREE.DataTexture {
    const { size, metresPerSample } = this.terrain.meta;
    const heights = this.terrain.heights;
    const up = Math.max(sun.up, MIN_SUN_UP);
    const across = Math.sqrt(1 - up * up);
    const flatLength = Math.hypot(sun.east, sun.north) || 1;
    // In grid terms: columns run east, rows run south.
    const towardsColumn = sun.east / flatLength;
    const towardsRow = -sun.north / flatLength;
    const lightX = towardsColumn * across;
    const lightZ = towardsRow * across;
    const risePerStep = (up / across) * SHADOW_STRIDE * metresPerSample;
    let highest = -Infinity;
    for (const height of heights) if (height > highest) highest = height;

    const cells = Math.floor(size / SHADOW_STRIDE);
    const lit = new Float32Array(cells * cells).fill(1);
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const startRow = row * SHADOW_STRIDE;
        const startColumn = column * SHADOW_STRIDE;
        let ray = heights[startRow * size + startColumn] + SHADOW_BIAS_M;
        for (let step = 1; ; step += 1) {
          ray += risePerStep;
          if (ray > highest) break;
          const y = Math.round(startRow + towardsRow * SHADOW_STRIDE * step);
          const x = Math.round(startColumn + towardsColumn * SHADOW_STRIDE * step);
          if (x < 0 || y < 0 || x >= size || y >= size) break;
          if (heights[y * size + x] > ray) {
            lit[row * cells + column] = 0;
            break;
          }
        }
      }
    }
    // A short blur softens the shadow edges, which the 60 m cells would otherwise show.
    const soft = new Float32Array(lit.length);
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        let total = 0;
        let count = 0;
        for (let r = Math.max(0, row - 1); r <= Math.min(cells - 1, row + 1); r += 1) {
          for (let c = Math.max(0, column - 1); c <= Math.min(cells - 1, column + 1); c += 1) {
            total += lit[r * cells + c];
            count += 1;
          }
        }
        soft[row * cells + column] = total / count;
      }
    }

    const flatGround = SHADE_AMBIENT + (1 - SHADE_AMBIENT) * up;
    const data = new Uint8Array(size * size);
    for (let row = 0; row < size; row += 1) {
      const above = Math.max(0, row - 1);
      const below = Math.min(size - 1, row + 1);
      for (let column = 0; column < size; column += 1) {
        const left = Math.max(0, column - 1);
        const right = Math.min(size - 1, column + 1);
        const slopeX = (heights[row * size + right] - heights[row * size + left]) / ((right - left) * metresPerSample);
        const slopeZ = (heights[below * size + column] - heights[above * size + column]) / ((below - above) * metresPerSample);
        const facing = Math.max(0, (up - slopeX * lightX - slopeZ * lightZ) / Math.hypot(slopeX, 1, slopeZ));
        const shadow = soft[Math.min(cells - 1, Math.floor(row / SHADOW_STRIDE)) * cells + Math.min(cells - 1, Math.floor(column / SHADOW_STRIDE))];
        const light = (SHADE_AMBIENT + (1 - SHADE_AMBIENT) * facing * shadow) / flatGround;
        data[row * size + column] = clamp(light / LIGHT_RANGE, 0, 1) * 255;
      }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    return texture;
  }

  dispose(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.resize.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    this.terrain.shade.dispose();
    this.lightMap?.dispose();
    this.overlays.forEach((texture) => texture.dispose());
    this.detail?.dispose();
    this.imagery?.texture.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  /** Arrive facing the direction with the most relief, so the first view has something in it. */
  private mostDramaticYaw(): number {
    let bestHeading = 0;
    let bestRange = -1;
    for (let degrees = 0; degrees < 360; degrees += 30) {
      const heading = (degrees * Math.PI) / 180;
      const aheadX = Math.sin(heading);
      const aheadZ = -Math.cos(heading);
      let low = Infinity;
      let high = -Infinity;
      for (let distance = 3000; distance <= 11_000; distance += 1000) {
        for (let lateral = -2000; lateral <= 2000; lateral += 1000) {
          const height = this.heightAt(aheadX * distance - aheadZ * lateral, aheadZ * distance + aheadX * lateral);
          low = Math.min(low, height);
          high = Math.max(high, height);
        }
      }
      if (high - low > bestRange) {
        bestRange = high - low;
        bestHeading = heading;
      }
    }
    return -bestHeading;
  }

  /** Bilinear ground height, in metres above sea level. */
  private heightAt(x: number, z: number): number {
    const { size, metresPerSample } = this.terrain.meta;
    const u = clamp(x / metresPerSample + (size - 1) / 2, 0, size - 1.001);
    const v = clamp(z / metresPerSample + (size - 1) / 2, 0, size - 1.001);
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    const fu = u - iu;
    const fv = v - iv;
    const h = this.terrain.heights;
    const at = (i: number, j: number) => h[j * size + i];
    return lerp(lerp(at(iu, iv), at(iu + 1, iv), fu), lerp(at(iu, iv + 1), at(iu + 1, iv + 1), fu), fv);
  }

  private buildTerrain(): THREE.Mesh {
    const span = (this.terrain.meta.size - 1) * this.terrain.meta.metresPerSample;
    const count = GRID + 1;
    const positions = new Float32Array(count * count * 3);
    const uvs = new Float32Array(count * count * 2);
    // Vertices bunch toward the middle, where the drone spends its time.
    const warp = (u: number) => 0.4 * u + 0.6 * u * u * u;

    let p = 0;
    let q = 0;
    for (let j = 0; j < count; j += 1) {
      const z = warp((j / GRID) * 2 - 1) * (span / 2);
      for (let i = 0; i < count; i += 1) {
        const x = warp((i / GRID) * 2 - 1) * (span / 2);
        positions[p++] = x;
        positions[p++] = this.heightAt(x, z);
        positions[p++] = z;
        uvs[q++] = x / span + 0.5;
        uvs[q++] = 1 - (z / span + 0.5);
      }
    }

    const indices = new Uint32Array(GRID * GRID * 6);
    let n = 0;
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        const a = j * count + i;
        const b = a + 1;
        const c = a + count;
        const d = c + 1;
        indices[n++] = a;
        indices[n++] = c;
        indices[n++] = b;
        indices[n++] = b;
        indices[n++] = c;
        indices[n++] = d;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const { shade } = this.terrain;
    shade.colorSpace = THREE.NoColorSpace;
    shade.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    shade.minFilter = THREE.LinearMipmapLinearFilter;
    shade.generateMipmaps = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        shade: { value: shade },
        imagery: { value: null },
        imageryWindow: { value: new THREE.Vector4(0, 0, 1, 1) },
        imageryMix: { value: 0 },
        detail0: { value: null },
        detail1: { value: null },
        detail2: { value: null },
        detail3: { value: null },
        detail4: { value: null },
        detailWindow4: { value: new THREE.Vector4(0, 0, 0, 0) },
        detailWindow0: { value: new THREE.Vector4(0, 0, 0, 0) },
        detailWindow1: { value: new THREE.Vector4(0, 0, 0, 0) },
        detailWindow2: { value: new THREE.Vector4(0, 0, 0, 0) },
        detailWindow3: { value: new THREE.Vector4(0, 0, 0, 0) },
        haze: { value: HAZE },
        daylight: { value: 1 },
        lightMap: { value: null },
        lightRange: { value: LIGHT_RANGE },
        overlay: { value: null },
        overlayWindow: { value: new THREE.Vector4(0, 0, 1, 1) },
        overlayOn: { value: 0 },
        hazeScale: { value: FOG_DISTANCE_M },
        edgeStart: { value: span * 0.36 },
        edgeEnd: { value: span * 0.49 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vView;
        varying vec2 vGround;
        varying float vHeight;
        void main() {
          vUv = uv;
          vGround = position.xz;
          vHeight = position.y;
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          vView = view.xyz;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D shade;
        uniform sampler2D imagery;
        uniform vec4 imageryWindow;
        uniform float imageryMix;
        uniform sampler2D detail0;
        uniform sampler2D detail1;
        uniform sampler2D detail2;
        uniform sampler2D detail3;
        uniform sampler2D detail4;
        uniform vec4 detailWindow4;
        uniform vec4 detailWindow0;
        uniform vec4 detailWindow1;
        uniform vec4 detailWindow2;
        uniform vec4 detailWindow3;
        uniform vec3 haze;
        uniform float daylight;
        uniform sampler2D lightMap;
        uniform float lightRange;
        uniform sampler2D overlay;
        uniform vec4 overlayWindow;
        uniform float overlayOn;
        uniform float hazeScale;
        uniform float edgeStart;
        uniform float edgeEnd;
        varying vec2 vUv;
        varying vec3 vView;
        varying vec2 vGround;
        varying float vHeight;

        vec4 readDetail(sampler2D map, vec4 box) {
          if (box.z <= 0.0) return vec4(0.0);
          vec2 p = (vGround - box.xy) / box.zw;
          if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0) return vec4(0.0);
          vec2 border = min(p, 1.0 - p);
          vec4 sampled = texture2D(map, vec2(p.x, 1.0 - p.y));
          sampled.a *= smoothstep(0.0, 0.08, min(border.x, border.y));
          return sampled;
        }

        void main() {
          vec3 color = texture2D(shade, vUv).rgb;
          if (imageryMix > 0.0) {
            vec2 photoUv = (vGround - imageryWindow.xy) / imageryWindow.zw;
            photoUv.y = 1.0 - photoUv.y;
            vec4 photo = texture2D(imagery, photoUv);
            vec2 border = min(photoUv, 1.0 - photoUv);
            float inside = smoothstep(0.0, 0.07, min(border.x, border.y));
            vec3 lum = vec3(0.299, 0.587, 0.114);
            vec3 lit = photo.rgb;
            float grey = dot(lit, lum);
            // Snow shadows are blue in the imagery, and saturating them looks unreal.
            float snowBlue = vHeight > 5.0 ? clamp((lit.b - max(lit.r, lit.g)) * 5.0, 0.0, 1.0) : 0.0;
            lit = clamp(mix(vec3(grey), lit, mix(1.14, 0.4, snowBlue)), 0.0, 1.0);
            color = mix(color, lit, imageryMix * inside * photo.a);
          }
          // Coarsest square first, so each finer one paints over it.
          vec4 layer = readDetail(detail4, detailWindow4);
          color = mix(color, layer.rgb, layer.a);
          layer = readDetail(detail3, detailWindow3);
          color = mix(color, layer.rgb, layer.a);
          layer = readDetail(detail2, detailWindow2);
          color = mix(color, layer.rgb, layer.a);
          layer = readDetail(detail1, detailWindow1);
          color = mix(color, layer.rgb, layer.a);
          layer = readDetail(detail0, detailWindow0);
          color = mix(color, layer.rgb, layer.a);
          // Thickens with the square of distance, like real air: clear nearby, gone far away.
          float fogRange = length(vView) / hazeScale;
          float distanceHaze = 1.0 - exp(-fogRange * fogRange);
          float edgeHaze = smoothstep(edgeStart, edgeEnd, max(abs(vGround.x), abs(vGround.y)));
          // A gentle S-curve and saturation lift, then the terrain's own light and shadow.
          float luma = dot(color, vec3(0.299, 0.587, 0.114));
          vec3 graded = mix(vec3(luma), color, 1.16);
          graded = mix(graded, graded * graded * (3.0 - 2.0 * graded), 0.42);
          float light = texture2D(lightMap, vec2(vUv.x, 1.0 - vUv.y)).r * lightRange;
          vec3 surface = clamp(graded * light, 0.0, 1.0) * daylight;
          if (overlayOn > 0.0) {
            vec2 place = (vGround - overlayWindow.xy) / overlayWindow.zw;
            if (place.x >= 0.0 && place.x <= 1.0 && place.y >= 0.0 && place.y <= 1.0) {
              vec4 data = texture2D(overlay, vec2(place.x, 1.0 - place.y));
              // Keeps some of the relief, but stays readable at night.
              surface = mix(surface, data.rgb * clamp(0.62 + 0.38 * light, 0.0, 1.2), data.a * 0.82);
            }
          }
          gl_FragColor = vec4(mix(surface, haze, max(distanceHaze, edgeHaze)), 1.0);
        }
      `,
    });

    this.terrainMaterial = material;
    return new THREE.Mesh(geometry, material);
  }

  private buildSky(): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { haze: { value: HAZE }, zenith: { value: ZENITH } },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 haze;
        uniform vec3 zenith;
        varying vec3 vDirection;
        void main() {
          float t = smoothstep(0.0, 0.42, normalize(vDirection).y);
          gl_FragColor = vec4(mix(haze, zenith, t), 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(70_000, 32, 16), material);
    sky.renderOrder = -1;
    return sky;
  }

  /** The descent ends behind the site, looking across it. */
  private planReveal(): void {
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const ground = this.heightAt(0, 0);
    const endX = -forwardX * 2600;
    const endZ = -forwardZ * 2600;
    Object.assign(this.lookFrom, {
      x: -forwardX * 700,
      z: -forwardZ * 700,
      height: ground + 6500,
      pitch: (-58 * Math.PI) / 180,
    });
    Object.assign(this.lookTo, {
      x: endX,
      z: endZ,
      height: Math.max(ground, this.heightAt(endX, endZ)) + 480,
      pitch: (-10 * Math.PI) / 180,
    });
  }

  private applyPose(t: number): void {
    const eased = easeOutCubic(t);
    this.position.set(
      lerp(this.lookFrom.x, this.lookTo.x, eased),
      lerp(this.lookFrom.height, this.lookTo.height, eased),
      lerp(this.lookFrom.z, this.lookTo.z, eased),
    );
    this.pitch = lerp(this.lookFrom.pitch, this.lookTo.pitch, eased);
  }

  private frame = (now: number) => {
    const dt = clamp((now - this.lastFrame) / 1000, 0, 0.05);
    this.lastFrame = now;

    const mix = this.terrainMaterial?.uniforms.imageryMix;
    if (mix && this.imagery && mix.value < 1) mix.value = Math.min(1, mix.value + dt);

    let atEdge = false;
    if (this.revealing) {
      const t = clamp((now - this.revealStart) / REVEAL_MS, 0, 1);
      this.applyPose(t);
      if (t >= 1) this.revealing = false;
    } else {
      atEdge = this.fly(dt);
    }

    this.detail?.update(this.position.x, this.position.z, -Math.sin(this.yaw), -Math.cos(this.yaw), now);
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.updateMatrixWorld();
    this.sky.position.copy(this.position);
    this.renderer.render(this.scene, this.camera);
    this.reportMark();

    if (now - this.lastReadout > 120) {
      this.lastReadout = now;
      const ground = this.heightAt(this.position.x, this.position.z);
      this.onReadout({
        x: this.position.x,
        z: this.position.z,
        groundElevation: ground,
        aboveGround: this.position.y - ground,
        heading: ((-this.yaw * 180) / Math.PI + 720) % 360,
        atEdge,
      });
    }
    this.frameId = requestAnimationFrame(this.frame);
  };

  private fly(dt: number): boolean {
    const { held } = this;
    const speed = held.has('boost') ? BOOST : CRUISE;
    const ahead = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
    const side = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const vertical = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0);

    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const length = Math.hypot(ahead, side) || 1;
    const targetX = ((forwardX * ahead + rightX * side) / length) * speed;
    const targetZ = ((forwardZ * ahead + rightZ * side) / length) * speed;
    const targetY = vertical * CLIMB;

    const blend = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
    this.velocity.x = lerp(this.velocity.x, targetX, blend);
    this.velocity.y = lerp(this.velocity.y, targetY, blend);
    this.velocity.z = lerp(this.velocity.z, targetZ, blend);
    this.position.addScaledVector(this.velocity, dt);

    let atEdge = false;
    const radius = Math.hypot(this.position.x, this.position.z);
    if (radius > this.radius) {
      this.position.x *= this.radius / radius;
      this.position.z *= this.radius / radius;
      atEdge = true;
    }

    // Look ahead along the flight path so the drone rises before a slope, not into it.
    const ground = this.heightAt(this.position.x, this.position.z);
    const futureGround = this.heightAt(
      this.position.x + this.velocity.x * 1.4,
      this.position.z + this.velocity.z * 1.4,
    );
    const floor = Math.max(ground, futureGround) + MIN_CLEARANCE;
    if (this.position.y < floor) {
      this.position.y = lerp(this.position.y, floor, 1 - Math.exp(-dt * 6));
      this.velocity.y = Math.max(this.velocity.y, 0);
    }
    this.position.y = clamp(this.position.y, ground + 25, ground + MAX_CLEARANCE);
    return atEdge;
  }

  private reportMark(): void {
    const projected = this.markPoint.clone().project(this.camera);
    const { clientWidth, clientHeight } = this.container;
    this.onMark({
      x: ((projected.x + 1) / 2) * clientWidth,
      y: ((1 - projected.y) / 2) * clientHeight,
      visible: projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1,
    });
  }

  private fit(): void {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.onContextLost();
  };

  private handlePointerDown = (event: PointerEvent) => {
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  // Measured from clientX/Y because some browsers report no movementX/Y for touch.
  private handlePointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    if (this.revealing) return;
    this.yaw -= dx * LOOK_SPEED;
    this.pitch = clamp(this.pitch - dy * LOOK_SPEED, -1.35, 0.55);
  };

  private handlePointerUp = () => {
    this.dragging = false;
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    const action = KEY_ACTIONS[event.code];
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code.startsWith('Arrow')) event.preventDefault();
    this.held.add(action);
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    const action = KEY_ACTIONS[event.code];
    if (action) this.held.delete(action);
  };

  private releaseAll = () => {
    this.held.clear();
    this.dragging = false;
  };
}
