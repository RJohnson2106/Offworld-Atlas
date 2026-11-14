import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { AnalogSite } from '../data/analogSites';
import { localSun, siteLight, skyClock } from '../map/sunlight';
import { describeGridValue, siteLayers } from '../data/dataLayers';
import { Legend } from '../map/Legend';
import { lngLatToScene, sceneToLngLat } from './sitePosition';
import { DetailImagery } from './detailImagery';
import { fetchDetailCredit, hasDetailImagery } from './imageryService';
import { DroneFlight, IMAGERY_CREDIT, loadImagery, loadTerrain } from './droneFlight';
import type { FlightAction, FlightReadout, MarkPosition } from './droneFlight';

interface DroneViewProps {
  site: AnalogSite;
  sceneId: string;
  active: boolean;
  exiting: boolean;
  reducedMotion: boolean;
  onReady: () => void;
  onFailure: () => void;
  onExit: () => void;
}

const metres = (value: number) => `${Math.round(value).toLocaleString('en-US')} m`;
const IMAGERY_HEAD_START_MS = 3000; // most imagery lands before the reveal; the rest fades in
const READING_INTERVAL_MS = 200;
const LAYER_BASE = `${import.meta.env.BASE_URL}data/sites`;

export default function DroneView({
  site,
  sceneId,
  active,
  exiting,
  reducedMotion,
  onReady,
  onFailure,
  onExit,
}: DroneViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const groundRef = useRef<HTMLElement>(null);
  const clearanceRef = useRef<HTMLElement>(null);
  const flightRef = useRef<DroneFlight | null>(null);
  const callbacks = useRef({ onReady, onFailure });
  callbacks.current = { onReady, onFailure };
  const [atEdge, setAtEdge] = useState(false);
  const [showingImagery, setShowingImagery] = useState(false);
  const [detailCredit, setDetailCredit] = useState<string | null>(null);
  const layers = siteLayers(site.id);
  const [overlayIndex, setOverlayIndex] = useState(-1); // -1 is off
  const [readings, setReadings] = useState<{ label: string; value: string }[]>([]);
  const gridsRef = useRef<Record<string, Uint8Array>>({});
  const overlaySpec = overlayIndex >= 0 ? layers?.layers[overlayIndex] : undefined;

  // The small grids of values behind the readout, the same ones the site view reads on hover.
  useEffect(() => {
    gridsRef.current = {};
    let cancelled = false;
    for (const layer of layers?.layers ?? []) {
      fetch(`${LAYER_BASE}/${site.id}/${layer.id}.bin`)
        .then((response) => response.arrayBuffer())
        .then((buffer) => {
          if (!cancelled) gridsRef.current[layer.id] = new Uint8Array(buffer);
        })
        .catch(() => undefined); // that row just shows no reading
    }
    return () => {
      cancelled = true;
    };
  }, [layers, site.id]);

  useEffect(() => {
    if (!active) return;
    const cycle = (event: KeyboardEvent) => {
      if (event.code !== 'KeyM' || event.repeat) return;
      setOverlayIndex((index) => (index + 1 >= (layers?.layers.length ?? 0) ? -1 : index + 1));
    };
    window.addEventListener('keydown', cycle);
    return () => window.removeEventListener('keydown', cycle);
  }, [active, layers]);

  useEffect(() => {
    const flight = flightRef.current;
    if (!flight || !layers) return;
    if (!overlaySpec) {
      void flight.showOverlay(null);
      return;
    }
    const [west, south, east, north] = layers.bounds;
    const start = lngLatToScene(west, north, site);
    const end = lngLatToScene(east, south, site);
    flight
      .showOverlay({
        url: `${LAYER_BASE}/${site.id}/${overlaySpec.id}.webp`,
        minX: start.x,
        minZ: start.z,
        width: end.x - start.x,
        depth: end.z - start.z,
      })
      .catch(() => setOverlayIndex(-1));
  }, [overlaySpec, layers, site]);

  useEffect(() => {
    let cancelled = false;
    let created: DroneFlight | null = null;
    const stage = stageRef.current;
    if (!stage) return;

    let lastReading = 0;
    const readGround = (x: number, z: number) => {
      const manifest = siteLayers(site.id);
      if (!manifest) return;
      const [lng, lat] = sceneToLngLat(x, z, site);
      const [west, south, east, north] = manifest.bounds;
      const u = (lng - west) / (east - west);
      const v = (north - lat) / (north - south);
      const inside = u >= 0 && u < 1 && v >= 0 && v < 1;
      const next = manifest.layers.map((layer) => {
        const grid = gridsRef.current[layer.id];
        const index = Math.floor(v * manifest.gridSize) * manifest.gridSize + Math.floor(u * manifest.gridSize);
        const value = inside && grid ? describeGridValue(layer, grid[index]) : null;
        // The water layer stores "never seen as water" as empty, so empty isn't missing data there.
        const empty = inside && grid && layer.id === 'water' ? 'None detected' : 'No data';
        return { label: layer.label, value: value ?? empty };
      });
      setReadings((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };

    const updateReadout = (readout: FlightReadout) => {
      if (groundRef.current) groundRef.current.textContent = metres(readout.groundElevation);
      if (clearanceRef.current) clearanceRef.current.textContent = metres(readout.aboveGround);
      needleRef.current?.setAttribute('transform', `rotate(${-readout.heading})`);
      setAtEdge(readout.atEdge);
      const now = performance.now();
      if (now - lastReading >= READING_INTERVAL_MS) {
        lastReading = now;
        readGround(readout.x, readout.z);
      }
    };
    const updateMark = (mark: MarkPosition) => {
      const element = markRef.current;
      if (!element) return;
      element.style.visibility = mark.visible ? 'visible' : 'hidden';
      element.style.transform = `translate(${mark.x}px, ${mark.y}px)`;
    };

    loadTerrain(sceneId)
      .then((terrain) => {
        if (cancelled) {
          terrain.shade.dispose();
          return;
        }
        created = new DroneFlight(stage, terrain, reducedMotion, updateReadout, updateMark, () =>
          callbacks.current.onFailure(),
        );
        flightRef.current = created;
        const { sun } = skyClock.positions();
        const light = siteLight(sun, site.lng, site.lat);
        created.setLight(light.haze, light.zenith, light.ground, localSun(sun, site.lng, site.lat));
        if (new URLSearchParams(window.location.search).has('e2e')) {
          (window as unknown as { __drone: unknown }).__drone = created;
        }

        const flight = created;
        if (hasDetailImagery) {
          flight.attachDetail(
            new DetailImagery(site.lat, site.lng, flight.maxAnisotropy, window.matchMedia('(pointer: coarse)').matches),
          );
          void fetchDetailCredit().then((credit) => {
            if (!cancelled) setDetailCredit(credit);
          });
        }
        const imagery = loadImagery(site.lng, site.lat, terrain.meta, flight.maxAnisotropy)
          .catch(() => null)
          .then((patch) => {
            if (!patch) return;
            if (cancelled) {
              patch.texture.dispose();
              return;
            }
            flight.setImagery(patch);
            setShowingImagery(true);
          });
        return Promise.race([
          imagery,
          new Promise((resolve) => window.setTimeout(resolve, IMAGERY_HEAD_START_MS)),
        ]).then(() => {
          if (!cancelled) callbacks.current.onReady();
        });
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onFailure();
      });

    return () => {
      cancelled = true;
      created?.dispose();
      flightRef.current = null;
    };
  }, [sceneId, reducedMotion, site.id, site.lng, site.lat]);

  useEffect(() => {
    if (active) flightRef.current?.start();
  }, [active]);

  const hold = (action: FlightAction) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      flightRef.current?.press(action, true);
    },
    onPointerUp: () => flightRef.current?.press(action, false),
    onPointerCancel: () => flightRef.current?.press(action, false),
  });

  const pad = (action: FlightAction, label: string, children: ReactNode) => (
    <button type="button" aria-label={label} {...hold(action)}>
      {children}
    </button>
  );

  return (
    <section
      className="drone"
      data-active={active && !exiting}
      data-testid="drone-view"
      aria-label={`Drone view of ${site.name}`}
      inert={!active || exiting}
    >
      <div ref={stageRef} className="drone__stage" />

      <div ref={markRef} className="drone-mark" aria-hidden="true">
        <svg viewBox="-12 -12 24 24" width="24" height="24">
          <path d="M0 -8.5 8 5.5H-8Z" />
        </svg>
        <span>{site.name}</span>
      </div>

      <div className="drone__title">
        <h2>{site.name}</h2>
        <p>{site.place}</p>
      </div>

      <button type="button" className="drone__exit" data-testid="exit-drone" onClick={onExit}>
        Exit drone view
      </button>

      {layers && (
        <div className="drone__data" data-testid="drone-map-data">
          <button
            type="button"
            data-testid="drone-layer"
            onClick={() => setOverlayIndex((index) => (index + 1 >= layers.layers.length ? -1 : index + 1))}
          >
            <span>Map data</span>
            <span>{overlaySpec?.label ?? 'Off'}</span>
          </button>
          {overlaySpec && <Legend spec={overlaySpec} />}
          {overlaySpec && (
            <a className="credit" href={overlaySpec.source.url} target="_blank" rel="noreferrer">
              {overlaySpec.source.name}
            </a>
          )}
        </div>
      )}

      <p className="drone__hint">
        W A S D to fly. E and Q for height. Shift for speed. M for map data. Drag to look. Esc to exit.
      </p>

      <div className="drone__pad">
        {pad('up', 'Fly higher', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11h10M8 8V2M5.5 4.5 8 2l2.5 2.5" /></svg>)}
        {pad('forward', 'Fly forward', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>)}
        {pad('down', 'Fly lower', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10M8 8v6M5.5 11.5 8 14l2.5-2.5" /></svg>)}
        {pad('left', 'Fly left', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3M7 4 3 8l4 4" /></svg>)}
        {pad('back', 'Fly back', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4" /></svg>)}
        {pad('right', 'Fly right', <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>)}
      </div>

      {atEdge && (
        <p className="drone__edge" role="status">
          This is the edge of the mapped terrain.
        </p>
      )}

      <div className="drone__readout">
        <dl>
          <div>
            <dt>Ground</dt>
            <dd ref={groundRef} data-testid="drone-ground">0 m</dd>
          </div>
          <div>
            <dt>Above ground</dt>
            <dd ref={clearanceRef} data-testid="drone-clearance">0 m</dd>
          </div>
        </dl>
        <svg className="drone__compass" viewBox="-20 -20 40 40" width="40" height="40" aria-hidden="true">
          <g ref={needleRef}>
            <path className="compass__north" d="M0 -13 5 0H-5Z" />
            <path className="compass__south" d="M0 13 5 0H-5Z" />
            <text className="compass__n" y="-15.5" textAnchor="middle">N</text>
          </g>
        </svg>
        {readings.length > 0 && (
          <dl className="drone__readings" data-testid="drone-readings">
            {readings.map((reading) => (
              <div key={reading.label}>
                <dt>{reading.label}</dt>
                <dd>{reading.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="drone__credits" data-testid="drone-credits">
        <a
          className="credit"
          href="https://registry.opendata.aws/terrain-tiles/"
          target="_blank"
          rel="noreferrer"
        >
          Elevation: Terrain Tiles on AWS
        </a>
        {showingImagery && (
          <a className="credit" href="https://cloudless.eox.at" target="_blank" rel="noreferrer">
            {IMAGERY_CREDIT}
          </a>
        )}
        {detailCredit && (
          <a className="credit" href="https://www.esri.com/" target="_blank" rel="noreferrer">
            Powered by Esri. {detailCredit}
          </a>
        )}
      </div>
    </section>
  );
}
