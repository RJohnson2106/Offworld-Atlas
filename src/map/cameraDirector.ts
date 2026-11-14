import { LngLat } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { AnalogSite, LocalCamera } from '../data/analogSites';
import { NARROW_BREAKPOINT } from '../layout';

/**
 * The fly-in, the local view and the return to the overview.
 *
 * MapLibre's flyTo moves the centre and arcs the zoom, so a destination that
 * starts off-centre swings across the screen. This drives the camera one frame
 * at a time instead: it picks a screen position for the site, then solves for
 * the map centre that puts the site there. The site can't drift, whatever the
 * zoom, pitch or bearing are doing.
 */

export type AtlasPhase =
  | 'overview'
  | 'departing'
  | 'arriving'
  | 'local'
  | 'returning'
  | 'diving'
  | 'drone'
  | 'surfacing';

export interface AtlasState {
  phase: AtlasPhase;
  siteId: string | null;
}

export interface CameraSnapshot {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

interface Point {
  x: number;
  y: number;
}

type Orientation = Pick<CameraSnapshot, 'zoom' | 'pitch' | 'bearing'>;

interface Flight {
  site: AnalogSite;
  duration: number;
  from: Orientation;
  to: Orientation;
  screenFrom: Point;
  screenTo: () => Point;
  zoomWindow: [number, number];
  tiltWindow: [number, number];
  moveWindow: [number, number];
  brightness?: (progress: number) => number;
  /** Height scale at this point in the flight; null means flat, with terrain off. */
  terrain?: (progress: number) => number | null;
  onProgress?: (progress: number) => void;
  onDone: () => void;
}

export const FLY_IN_MS = 1800;
const RETURN_MS = 1350;
const ARRIVING_AT = 0.72;
const DIM_DEPTH = 0.36;
const ZOOM_SLACK_OUT = 2.2;
const ZOOM_SLACK_IN = 6;
const DIVE_MS = 1150;
const SURFACE_MS = 1000;
const DIVE_ZOOM = 10.6;
const DIVE_PITCH = 72;
const DIVE_BRIGHTNESS = 0.1;
const TERRAIN_LOAD_AT = 0.55; // switched on early and flat, so elevation has time to arrive
const TERRAIN_FLATTEN_BY = 0.35;

/** At a few hundred km across, true-scale mountains read as flat, so the default is raised. */
export const HEIGHT_SCALES = [1, 2, 4] as const;
export const DEFAULT_HEIGHT_SCALE = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const within = (p: number, [a, b]: [number, number]) => clamp((p - a) / (b - a), 0, 1);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const shortestTurn = (from: number, to: number) => ((to - from + 540) % 360) - 180;

function snapshot(map: MapLibreMap): CameraSnapshot {
  const c = map.getCenter();
  return {
    center: [c.lng, c.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

export class CameraDirector {
  private state: AtlasState = { phase: 'overview', siteId: null };
  private savedOverview: CameraSnapshot | null = null;
  private frameId: number | null = null;
  private localBounds: { center: LngLat; lngSpan: number; latSpan: number; zoom: number } | null = null;
  private localHome: { camera: CameraSnapshot; width: number; height: number } | null = null;
  private savedLocal: CameraSnapshot | null = null;
  private savedBounds: { center: LngLat; lngSpan: number; latSpan: number; zoom: number } | null = null;
  private currentBrightness = 1;
  private heightScale: number = DEFAULT_HEIGHT_SCALE;
  private currentHeight = 0;
  private localSite: AnalogSite | null = null;
  private destroyed = false;

  constructor(
    private readonly map: MapLibreMap,
    private readonly rasterLayers: string[],
    private readonly terrainSource: string | null,
    private readonly onState: (state: AtlasState) => void,
  ) {}

  getCamera(): CameraSnapshot {
    return snapshot(this.map);
  }

  /** How much terrain height is multiplied in the local view. 1 is true scale. */
  setHeightScale(scale: number): void {
    this.heightScale = scale;
    if (this.state.phase !== 'local') return;
    this.applyTerrain(scale);
    this.terrainChanged();
  }

  /**
   * Call when elevation arrives or its scale changes. Markers only re-read the ground when
   * the camera moves, so without this a marker keeps the height it had before the data loaded.
   */
  terrainChanged(): void {
    // A moving camera already refreshes its markers, and nudging it here would stop the move.
    if (this.state.phase !== 'local' || this.map.isMoving()) return;
    if (this.localSite && this.isUntouchedLocal()) this.frameLocal(this.localSite);
    else this.map.jumpTo({});
  }

  /** Start the move into a site. Ignored unless the overview is at rest. */
  fly(site: AnalogSite, reducedMotion: boolean): void {
    if (this.state.phase !== 'overview') return;
    this.map.stop();
    this.savedOverview = snapshot(this.map);
    this.setInteractive(false);

    if (reducedMotion) {
      this.settle(site);
      return;
    }

    this.emit('departing', site.id);
    const target = site.localCamera;
    this.run({
      site,
      duration: FLY_IN_MS,
      from: this.orientation(),
      to: { zoom: target.zoom, pitch: target.pitch, bearing: target.bearing },
      screenFrom: this.siteOnScreen(site),
      screenTo: () => this.localAnchor(),
      zoomWindow: [0.1, 1],
      tiltWindow: [0.32, 1],
      moveWindow: [0.08, 0.92],
      terrain: (p) =>
        p < TERRAIN_LOAD_AT ? null : this.heightScale * easeInOutSine(within(p, [ARRIVING_AT, 1])),
      onProgress: (p) => {
        if (p >= ARRIVING_AT && this.state.phase === 'departing') this.emit('arriving', site.id);
      },
      onDone: () => this.settle(site),
    });
  }

  /** Return to the saved overview, from the local view or partway through a flight. */
  back(sites: readonly AnalogSite[], reducedMotion: boolean): void {
    const { phase, siteId } = this.state;
    const saved = this.savedOverview;
    if (phase === 'overview' || phase === 'returning' || !saved) return;
    if (phase === 'diving' || phase === 'drone' || phase === 'surfacing') return;
    const site = sites.find((s) => s.id === siteId);

    this.cancelFrame();
    this.map.stop();
    this.localBounds = null;
    this.setInteractive(false);
    this.emit('returning', siteId);

    if (reducedMotion || !site) {
      this.finishReturn(saved);
      return;
    }

    // A flight that barely left the overview doesn't need the full return time.
    const travelled = clamp(Math.abs(this.map.getZoom() - saved.zoom) / 4, 0, 1);
    const startHeight = this.currentHeight;
    this.run({
      site,
      duration: lerp(450, RETURN_MS, travelled),
      from: this.orientation(),
      to: { zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing },
      screenFrom: this.siteOnScreen(site),
      screenTo: this.frozenScreenPosition(site, saved),
      zoomWindow: [0, 0.94],
      tiltWindow: [0, 0.68],
      moveWindow: [0.04, 0.96],
      terrain: (p) => (p >= TERRAIN_FLATTEN_BY ? null : startHeight * (1 - within(p, [0, TERRAIN_FLATTEN_BY]))),
      onDone: () => this.finishReturn(saved),
    });
  }

  /** Push the map camera down into the site and darken it, ready for the drone scene. */
  dive(site: AnalogSite, reducedMotion: boolean): void {
    if (this.state.phase !== 'local') return;
    this.map.stop();
    this.savedLocal = snapshot(this.map);
    this.savedBounds = this.localBounds;
    this.localBounds = null;
    this.setInteractive(false);

    if (reducedMotion) {
      this.emit('drone', site.id);
      return;
    }

    this.emit('diving', site.id);
    const from = this.orientation();
    this.run({
      site,
      duration: DIVE_MS,
      from,
      to: { zoom: DIVE_ZOOM, pitch: DIVE_PITCH, bearing: from.bearing },
      screenFrom: this.siteOnScreen(site),
      screenTo: () => {
        const { clientWidth: w, clientHeight: h } = this.map.getContainer();
        return { x: w / 2, y: h * 0.6 };
      },
      zoomWindow: [0, 1],
      tiltWindow: [0, 0.8],
      moveWindow: [0, 0.85],
      brightness: (p) => lerp(1, DIVE_BRIGHTNESS, p * p),
      onDone: () => this.emit('drone', site.id),
    });
  }

  /** Come back up to the exact local view the dive started from. */
  surface(sites: readonly AnalogSite[], reducedMotion: boolean): void {
    const { phase, siteId } = this.state;
    const saved = this.savedLocal;
    if ((phase !== 'diving' && phase !== 'drone') || !saved) return;
    const site = sites.find((s) => s.id === siteId);

    this.cancelFrame();
    this.emit('surfacing', siteId);
    if (reducedMotion || !site) {
      this.finishSurface(saved, siteId);
      return;
    }

    const startBrightness = this.currentBrightness;
    this.run({
      site,
      duration: SURFACE_MS,
      from: this.orientation(),
      to: { zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing },
      screenFrom: this.siteOnScreen(site),
      screenTo: this.frozenScreenPosition(site, saved),
      zoomWindow: [0, 1],
      tiltWindow: [0, 1],
      moveWindow: [0, 1],
      brightness: (p) => lerp(startBrightness, 1, p),
      onDone: () => this.finishSurface(saved, siteId),
    });
  }

  /** Put the local view back to its starting frame. */
  resetLocal(sites: readonly AnalogSite[], reducedMotion: boolean): void {
    if (this.state.phase !== 'local') return;
    const site = sites.find((s) => s.id === this.state.siteId);
    if (!site) return;
    const home = this.solveLocalHome(site);
    this.map.easeTo({
      center: home.center,
      zoom: home.zoom,
      pitch: home.pitch,
      bearing: home.bearing,
      duration: reducedMotion ? 0 : 750,
    });
  }

  /** Passed to the map as `transformCameraUpdate`; keeps the local view in its small area. */
  limitLocalCamera = (next: { center: LngLat; zoom: number }): { center?: LngLat; zoom?: number } => {
    const bounds = this.localBounds;
    if (!bounds) return {};
    return {
      center: new LngLat(
        clamp(next.center.lng, bounds.center.lng - bounds.lngSpan, bounds.center.lng + bounds.lngSpan),
        clamp(next.center.lat, bounds.center.lat - bounds.latSpan, bounds.center.lat + bounds.latSpan),
      ),
      zoom: clamp(next.zoom, bounds.zoom - ZOOM_SLACK_OUT, bounds.zoom + ZOOM_SLACK_IN),
    };
  };

  destroy(): void {
    this.destroyed = true;
    this.cancelFrame();
  }

  isAtOverview(): boolean {
    return this.state.phase === 'overview';
  }

  /** After a window resize, keep an untouched local view framed beside the panel. */
  refitLocal(sites: readonly AnalogSite[]): void {
    if (this.state.phase !== 'local' || !this.localHome) return;
    const site = sites.find((s) => s.id === this.state.siteId);
    if (site && this.isUntouchedLocal()) this.frameLocal(site);
  }

  private isUntouchedLocal(): boolean {
    if (!this.localHome) return false;
    const home = this.localHome.camera;
    const now = snapshot(this.map);
    return (
      Math.abs(now.zoom - home.zoom) < 0.001 &&
      Math.abs(now.pitch - home.pitch) < 0.01 &&
      Math.abs(now.bearing - home.bearing) < 0.01 &&
      Math.abs(now.center[0] - home.center[0]) < 0.01 &&
      Math.abs(now.center[1] - home.center[1]) < 0.01
    );
  }

  private settle(site: AnalogSite): void {
    this.localSite = site;
    this.applyTerrain(this.heightScale);
    this.frameLocal(site);
    this.setBrightness(1);
    this.setInteractive(true);
    this.emit('local', site.id);
  }

  private frameLocal(site: AnalogSite): void {
    const camera: LocalCamera = site.localCamera;
    this.localBounds = null;
    this.placeSite(site, this.localAnchor(), camera);
    const center = this.map.getCenter();
    const { clientWidth: width, clientHeight: height } = this.map.getContainer();
    this.localHome = { camera: snapshot(this.map), width, height };
    this.localBounds = {
      center,
      lngSpan: camera.panDegrees,
      latSpan: camera.panDegrees * Math.cos((site.lat * Math.PI) / 180),
      zoom: camera.zoom,
    };
  }

  private finishSurface(saved: CameraSnapshot, siteId: string | null): void {
    this.map.jumpTo(saved);
    this.setBrightness(1);
    this.localBounds = this.savedBounds;
    this.savedLocal = null;
    this.savedBounds = null;
    this.setInteractive(true);
    this.emit('local', siteId);
  }

  private finishReturn(saved: CameraSnapshot): void {
    this.applyTerrain(null);
    this.map.jumpTo(saved);
    this.setBrightness(1);
    this.savedOverview = null;
    this.setInteractive(true);
    this.emit('overview', null);
  }

  private solveLocalHome(site: AnalogSite): CameraSnapshot {
    const { clientWidth, clientHeight } = this.map.getContainer();
    const stored = this.localHome;
    if (stored && stored.width === clientWidth && stored.height === clientHeight) return stored.camera;

    // The window changed size since arrival, so the old frame no longer fits.
    const current = snapshot(this.map);
    const bounds = this.localBounds;
    this.localBounds = null;
    this.placeSite(site, this.localAnchor(), site.localCamera);
    const home = snapshot(this.map);
    this.map.jumpTo(current);
    this.localBounds = bounds;
    this.localHome = { camera: home, width: clientWidth, height: clientHeight };
    return home;
  }

  private run(flight: Flight): void {
    this.cancelFrame();
    const started = performance.now();
    const turn = shortestTurn(flight.from.bearing, flight.to.bearing);

    const step = (now: number) => {
      if (this.destroyed) return;
      const p = clamp((now - started) / flight.duration, 0, 1);
      const zoomT = easeInOutCubic(within(p, flight.zoomWindow));
      const tiltT = easeInOutSine(within(p, flight.tiltWindow));
      const moveT = easeInOutCubic(within(p, flight.moveWindow));
      const anchor = flight.screenTo();
      if (flight.terrain) this.applyTerrain(flight.terrain(p));

      this.placeSite(
        flight.site,
        {
          x: lerp(flight.screenFrom.x, anchor.x, moveT),
          y: lerp(flight.screenFrom.y, anchor.y, moveT),
        },
        {
          zoom: lerp(flight.from.zoom, flight.to.zoom, zoomT),
          pitch: lerp(flight.from.pitch, flight.to.pitch, tiltT),
          bearing: flight.from.bearing + turn * tiltT,
        },
      );
      // The relief drops back mid-flight so the marked point holds the eye.
      this.setBrightness(flight.brightness ? flight.brightness(p) : 1 - DIM_DEPTH * Math.sin(Math.PI * p));
      flight.onProgress?.(p);

      if (p < 1) {
        this.frameId = requestAnimationFrame(step);
      } else {
        this.frameId = null;
        flight.onDone();
      }
    };
    this.frameId = requestAnimationFrame(step);
  }

  /** Set an orientation, then solve for the centre that puts the site at `screen`. */
  private placeSite(site: AnalogSite, screen: Point, camera: Orientation): void {
    const { map } = this;
    const { zoom, pitch, bearing } = camera;
    map.jumpTo({ zoom, pitch, bearing });
    const midX = map.getContainer().clientWidth / 2;
    const midY = map.getContainer().clientHeight / 2;

    // Unprojecting a point far off-screen on a tilted map lands past the horizon and
    // diverges, so a long jump first centres the site and solves from there.
    const start = map.project(this.siteNearCenter(site));
    if (Math.abs(start.x - midX) > midX * 1.5 || Math.abs(start.y - midY) > midY * 1.5) {
      map.jumpTo({ center: this.siteNearCenter(site) });
    }

    for (let i = 0; i < 3; i += 1) {
      const projected = map.project(this.siteNearCenter(site));
      const dx = screen.x - projected.x;
      const dy = screen.y - projected.y;
      if (Math.hypot(dx, dy) < 0.2) break;
      map.jumpTo({ center: map.unproject([midX - dx, midY - dy]) });
    }
  }

  private siteOnScreen(site: AnalogSite): Point {
    const { x, y } = this.map.project(this.siteNearCenter(site));
    return { x, y };
  }

  /** Where the site will sit once the saved camera is restored. */
  private frozenScreenPosition(site: AnalogSite, saved: CameraSnapshot): () => Point {
    const current = snapshot(this.map);
    this.map.jumpTo(saved);
    const position = this.siteOnScreen(site);
    this.map.jumpTo(current);
    return () => position;
  }

  /** Picks the copy of the site's longitude closest to the map centre. */
  private siteNearCenter(site: AnalogSite): [number, number] {
    const centerLng = this.map.getCenter().lng;
    return [site.lng + 360 * Math.round((centerLng - site.lng) / 360), site.lat];
  }

  /** The clear part of the screen, beside the desktop panel or above the mobile sheet. */
  private localAnchor(): Point {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    if (w <= NARROW_BREAKPOINT) return { x: w / 2, y: h * 0.31 };
    const panel = this.map.getContainer().parentElement?.querySelector<HTMLElement>('.site-panel');
    return { x: (w - (panel?.offsetWidth ?? 0)) / 2, y: h * 0.56 };
  }

  private orientation(): Orientation {
    return { zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
  }

  private applyTerrain(scale: number | null): void {
    const { map, terrainSource } = this;
    if (!terrainSource) return;
    this.currentHeight = scale ?? 0;
    if (scale === null) {
      if (map.getTerrain()) map.setTerrain(null);
      return;
    }
    const exaggeration = Math.max(scale, 0.001);
    if (!map.getTerrain() || !map.terrain) {
      map.setTerrain({ source: terrainSource, exaggeration });
    } else {
      // Rebuilding terrain every frame would stall the animation, so only the scale changes.
      map.terrain.exaggeration = exaggeration;
      map.triggerRepaint();
    }
  }

  private setBrightness(value: number): void {
    this.currentBrightness = value;
    for (const id of this.rasterLayers) {
      this.map.setPaintProperty(id, 'raster-brightness-max', value);
    }
  }

  private setInteractive(enabled: boolean): void {
    const { map } = this;
    const handlers = [
      map.dragPan,
      map.dragRotate,
      map.scrollZoom,
      map.boxZoom,
      map.doubleClickZoom,
      map.keyboard,
      map.touchZoomRotate,
      map.touchPitch,
    ];
    for (const handler of handlers) {
      if (enabled) handler.enable();
      else handler.disable();
    }
  }

  private cancelFrame(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private emit(phase: AtlasPhase, siteId: string | null): void {
    this.state = { phase, siteId };
    this.onState(this.state);
  }
}
