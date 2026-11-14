import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import {
  describeGridValue,
  GLOBAL_COORDINATES,
  globalLayers,
  siteLayers,
} from '../data/dataLayers';
import type { LayerSpec } from '../data/dataLayers';
import worldviewLayers from '../data/worldviewLayers.json';
import type { AtlasPhase } from './cameraDirector';
import { Legend } from './Legend';
import { hideContours, showContours } from './liveDetail';

const OVERLAY = 'data-overlay';
const BEFORE_LAYER = 'graticule-major';
const OVERLAY_OPACITY = 0.84;
const base = import.meta.env.BASE_URL;

interface Tip {
  x: number;
  y: number;
  value: string;
  label: string;
}

interface ActiveLayer {
  spec: LayerSpec;
  folder: string;
  coordinates: typeof GLOBAL_COORDINATES;
  gridSize: number;
  isGlobal: boolean;
  bounds?: [number, number, number, number];
}

const pointLayerId = (id: string) => `points-${id}`;

/** NASA Worldview imagery, streamed as map tiles. The list comes from tools/build_worldview_layers.py. */
interface WorldviewLayer {
  id: string;
  label: string;
  nasaTitle: string;
  tiles: string;
  maxzoom: number;
  date: string;
  period: string;
  url: string;
  note?: string;
  legend?: { stops: string[]; ticks: string[] } | null;
}
const WORLDVIEW = worldviewLayers as WorldviewLayer[];
const WORLDVIEW_OVERLAY = 'worldview-overlay';
const worldviewDate = (layer: WorldviewLayer) =>
  new Date(`${layer.date}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    ...(layer.period === 'day' ? { day: 'numeric' } : {}),
  });

/** One layer in the sidebar: an eye to show or hide it, then its name and where it comes from. */
function LayerRow({
  id,
  on,
  title,
  subtitle,
  swatch,
  onToggle,
}: {
  id: string;
  on: boolean;
  title: string;
  subtitle: string;
  swatch?: string;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="layer-row" aria-pressed={on} data-testid={`layer-${id}`} onClick={onToggle}>
      <span className="layer-row__eye">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.500 15.500 10 15.500 1.5 10 1.5 10Z" />
          <circle cx="10" cy="10" r="2.6" />
          {!on && <path d="M3 17 17 3" />}
        </svg>
      </span>
      <span className="layer-row__text">
        <strong>
          {swatch && <span className="legend__dot" style={{ background: swatch }} />}
          {title}
        </strong>
        <em>{subtitle}</em>
      </span>
    </button>
  );
}

interface DataLayerControlProps {
  map: MapLibreMap | null;
  phase: AtlasPhase;
  siteId: string | null;
  /** The sidebar element the layer list is drawn into. */
  slot: HTMLElement | null;
}

export function DataLayerControl({ map, phase, siteId, slot }: DataLayerControlProps) {
  const [globalChoice, setGlobalChoice] = useState('none');
  const [siteChoice, setSiteChoice] = useState('none');
  const [points, setPoints] = useState<Record<string, boolean>>({});
  const [tip, setTip] = useState<Tip | null>(null);
  const gridRef = useRef<Uint8Array | null>(null);

  const site = siteId ? siteLayers(siteId) : undefined;
  const onOverview = phase === 'overview';
  const onSite = phase === 'local' && Boolean(site);

  const active = useMemo<ActiveLayer | null>(() => {
    if (onOverview && globalLayers) {
      const spec = globalLayers.layers.find((layer) => layer.id === globalChoice);
      if (spec) {
        return { spec, folder: 'global', coordinates: GLOBAL_COORDINATES, gridSize: globalLayers.gridSize, isGlobal: true };
      }
    }
    if (onSite && site && siteId) {
      const spec = site.layers.find((layer) => layer.id === siteChoice);
      if (spec) {
        return { spec, folder: `sites/${siteId}`, coordinates: site.coordinates, gridSize: site.gridSize, isGlobal: false, bounds: site.bounds };
      }
    }
    return null;
  }, [onOverview, onSite, site, siteId, globalChoice, siteChoice]);

  // The picture of the layer, plus the small grid of values behind the hover readout.
  useEffect(() => {
    if (!map || !active) return;
    let cancelled = false;
    gridRef.current = null;
    map.addSource(OVERLAY, {
      type: 'image',
      url: `${base}data/${active.folder}/${active.spec.id}.webp`,
      coordinates: active.coordinates,
    });
    map.addLayer(
      { id: OVERLAY, type: 'raster', source: OVERLAY, paint: { 'raster-opacity': OVERLAY_OPACITY, 'raster-fade-duration': 0 } },
      BEFORE_LAYER,
    );
    fetch(`${base}data/${active.folder}/${active.spec.id}.bin`)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        if (!cancelled) gridRef.current = new Uint8Array(buffer);
      })
      .catch(() => undefined); // the map layer still shows; only the readout is lost

    return () => {
      cancelled = true;
      gridRef.current = null;
      setTip(null);
      if (map.getStyle()) {
        map.removeLayer(OVERLAY);
        map.removeSource(OVERLAY);
      }
    };
  }, [map, active]);

  const worldview = onOverview ? WORLDVIEW.find((layer) => layer.id === globalChoice) : undefined;

  useEffect(() => {
    if (!map || !worldview) return;
    map.addSource(WORLDVIEW_OVERLAY, {
      type: 'raster',
      tiles: [worldview.tiles],
      tileSize: 256,
      maxzoom: worldview.maxzoom,
    });
    map.addLayer(
      {
        id: WORLDVIEW_OVERLAY,
        type: 'raster',
        source: WORLDVIEW_OVERLAY,
        paint: { 'raster-opacity': worldview.legend ? OVERLAY_OPACITY : 1, 'raster-fade-duration': 0 },
      },
      BEFORE_LAYER,
    );
    return () => {
      if (map.getStyle()) {
        map.removeLayer(WORLDVIEW_OVERLAY);
        map.removeSource(WORLDVIEW_OVERLAY);
      }
    };
  }, [map, worldview]);

  // Contour lines belong to the site being viewed.
  useEffect(() => {
    if (!map || !onSite || !siteId) return;
    showContours(map, siteId);
    return () => hideContours(map);
  }, [map, onSite, siteId]);

  // Marker layers are added once, then only shown or hidden.
  useEffect(() => {
    if (!map || !globalLayers) return;
    for (const layer of globalLayers.points) {
      const id = pointLayerId(layer.id);
      map.addSource(id, { type: 'geojson', data: `${base}data/global/${layer.id}.geojson` });
      map.addLayer({
        id,
        type: 'circle',
        source: id,
        layout: { visibility: 'none' },
        paint: {
          'circle-color': layer.color,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 6, 7],
          'circle-stroke-color': '#17171b',
          'circle-stroke-width': 2,
        },
      });
    }
    return () => {
      if (!map.getStyle()) return;
      for (const layer of globalLayers?.points ?? []) {
        const id = pointLayerId(layer.id);
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id) as GeoJSONSource | undefined) map.removeSource(id);
      }
    };
  }, [map]);

  useEffect(() => {
    if (!map || !globalLayers) return;
    for (const layer of globalLayers.points) {
      map.setLayoutProperty(pointLayerId(layer.id), 'visibility', onOverview && points[layer.id] ? 'visible' : 'none');
    }
    setTip(null);
  }, [map, onOverview, points]);

  // Hover on desktop, tap on touch screens.
  useEffect(() => {
    if (!map) return;
    const shownPoints = onOverview
      ? (globalLayers?.points ?? []).filter((layer) => points[layer.id]).map((layer) => pointLayerId(layer.id))
      : [];

    const readLayer = (lng: number, lat: number) => {
      const grid = gridRef.current;
      if (!active || !grid) return null;
      const wrapped = ((lng + 540) % 360) - 180;
      let u: number;
      let v: number;
      if (active.isGlobal) {
        const sin = Math.sin((lat * Math.PI) / 180);
        u = (wrapped + 180) / 360;
        v = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
      } else {
        const [west, south, east, north] = active.bounds!;
        u = (wrapped - west) / (east - west);
        v = (north - lat) / (north - south);
      }
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
      const index = Math.floor(v * active.gridSize) * active.gridSize + Math.floor(u * active.gridSize);
      return describeGridValue(active.spec, grid[index]);
    };

    const handle = (event: MapMouseEvent) => {
      const { x, y } = event.point;
      const canvas = map.getCanvas();
      if (shownPoints.length > 0) {
        // A box bigger than the dot, so markers are easy to land on.
        const features = map.queryRenderedFeatures([[x - 9, y - 9], [x + 9, y + 9]], { layers: shownPoints });
        if (features[0]) {
          const { name, detail, last } = features[0].properties as { name: string; detail: string; last?: number };
          canvas.style.cursor = 'pointer';
          setTip({ x, y, value: name, label: last ? `${detail}, last erupted ${last}` : detail });
          return;
        }
      }
      canvas.style.cursor = '';
      const reading = readLayer(event.lngLat.lng, event.lngLat.lat);
      setTip(reading && active ? { x, y, value: reading, label: active.spec.label } : null);
    };
    const clear = () => setTip(null);

    map.on('mousemove', handle);
    map.on('click', handle);
    map.on('mouseout', clear);
    map.on('movestart', clear);
    return () => {
      map.off('mousemove', handle);
      map.off('click', handle);
      map.off('mouseout', clear);
      map.off('movestart', clear);
    };
  }, [map, active, onOverview, points]);

  if (!map || !globalLayers) return null;

  const choices = onSite ? site!.layers : globalLayers.layers;
  const choice = onSite ? siteChoice : globalChoice;
  const setChoice = onSite ? setSiteChoice : setGlobalChoice;
  // One layer shows at a time: selecting the one that's showing turns it off.
  const toggle = (id: string) => setChoice(choice === id ? 'none' : id);
  const flipTip = tip !== null && tip.x > map.getCanvas().clientWidth - 200;

  const rows = (
    <div className="layers" data-testid="data-layers">
      <h3 className="section-bar">{onSite ? 'Site data' : 'Atlas data'}</h3>
      <ul>
        {choices.map((layer) => (
          <li key={layer.id}>
            <LayerRow
              id={layer.id}
              on={choice === layer.id}
              title={layer.label}
              subtitle={layer.source.name}
              onToggle={() => toggle(layer.id)}
            />
            {active?.spec.id === layer.id && (
              <div className="layer-detail">
                <Legend spec={active.spec} />
                {!active.isGlobal && <p className="layer-detail__note">Covers the measured 51 km square.</p>}
                <a className="credit" href={active.spec.source.url} target="_blank" rel="noreferrer">
                  {active.spec.source.name}
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>

      {onOverview && (
        <>
          <h3 className="section-bar">NASA Worldview imagery</h3>
          <ul>
            {WORLDVIEW.map((layer) => (
              <li key={layer.id}>
                <LayerRow
                  id={layer.id}
                  on={choice === layer.id}
                  title={layer.label}
                  subtitle={worldviewDate(layer)}
                  onToggle={() => toggle(layer.id)}
                />
                {worldview?.id === layer.id && (
                  <div className="layer-detail">
                    {layer.legend && (
                      <Legend
                        spec={{
                          id: layer.id,
                          label: layer.label,
                          kind: 'continuous',
                          unit: '',
                          stops: layer.legend.stops,
                          ticks: layer.legend.ticks,
                          source: { name: 'NASA Worldview', url: layer.url },
                        }}
                      />
                    )}
                    <p className="layer-detail__note" data-testid="worldview-note">
                      {layer.note} A picture from NASA, so there are no hover values.
                    </p>
                    <a className="credit" href={layer.url} target="_blank" rel="noreferrer" title={layer.nasaTitle}>
                      NASA Worldview (GIBS)
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3 className="section-bar">Markers</h3>
          <ul>
            {globalLayers.points.map((layer) => (
              <li key={layer.id}>
                <LayerRow
                  id={`points-${layer.id}`}
                  on={Boolean(points[layer.id])}
                  title={layer.label}
                  subtitle={layer.source.name}
                  swatch={layer.color}
                  onToggle={() => setPoints((current) => ({ ...current, [layer.id]: !current[layer.id] }))}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  return (
    <>
      {slot && createPortal(rows, slot)}

      {tip && (
        <div
          className="map-tip"
          data-testid="map-tip"
          data-flip={flipTip}
          style={{ left: tip.x, top: tip.y }}
        >
          <strong>{tip.value}</strong>
          <span>{tip.label}</span>
        </div>
      )}
    </>
  );
}
