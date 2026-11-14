import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Map as MapLibreMap, Marker, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { AnalogSite } from '../data/analogSites';
import { flyStep, siteGroups, tierAt } from '../data/siteGroups';
import type { SiteGroup } from '../data/siteGroups';
import { createBasemapStyle, localTerrain, overviewCamera, RASTER_LAYER_IDS, TERRAIN_SOURCE_ID } from './basemap';
import { CameraDirector } from './cameraDirector';
import { installVectorLines } from './liveDetail';
import { installSpaceBackdrop } from './spaceBackdrop';
import { installDaylight } from './sunlight';
import type { AtlasState } from './cameraDirector';

// MapLibre 6 ships its worker as a separate file, so the bundler has to hand over the URL.
setWorkerUrl(maplibreWorkerUrl);

const FAR_SIDE_COSINE = Math.cos((86 * Math.PI) / 180); // just short of the horizon

const SEA_LABELS = [
  { name: 'North Pacific', lng: -150, lat: 26, wideOnly: true },
  { name: 'North Atlantic', lng: -41, lat: 33, wideOnly: false },
  { name: 'South Atlantic', lng: -15, lat: -31, wideOnly: true },
  { name: 'Indian Ocean', lng: 78, lat: -24, wideOnly: true },
];

const STATUS_LABEL = { studied: 'Studied, for reference', candidate: 'New candidate' } as const;

interface MapStageProps {
  sites: readonly AnalogSite[];
  atlas: AtlasState;
  onSelect: (site: AnalogSite) => void;
  onStateChange: (state: AtlasState) => void;
  onReady: (map: MapLibreMap, director: CameraDirector) => void;
  onFailure: () => void;
}

export function MapStage({ sites, atlas, onSelect, onStateChange, onReady, onFailure }: MapStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spaceRef = useRef<HTMLCanvasElement>(null);
  const spaceFrontRef = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onStateChange, onReady, onFailure });
  callbacks.current = { onStateChange, onReady, onFailure };

  const [hosts] = useState(() => ({
    sites: sites.map((site) => ({ site, element: document.createElement('div') })),
    groups: siteGroups.map((group) => ({ group, element: document.createElement('div') })),
    seas: SEA_LABELS.map((label) => ({ label, element: document.createElement('div') })),
  }));
  const mapRef = useRef<MapLibreMap | null>(null);
  const userMovedOverview = useRef(false);

  const openGroup = (group: SiteGroup) => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;
    userMovedOverview.current = true;
    map.flyTo({
      center: [group.lng, group.lat],
      zoom: overviewCamera(container.clientWidth, container.clientHeight).zoom + flyStep(group),
      pitch: 0,
      bearing: 0,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1400,
      essential: true,
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let director: CameraDirector | null = null;
    let map: MapLibreMap;
    const start = overviewCamera(container.clientWidth, container.clientHeight);
    try {
      map = new MapLibreMap({
        container,
        style: createBasemapStyle(),
        ...start,
        minZoom: start.zoom - 0.5,
        maxZoom: 16,
        maxPitch: 78,
        attributionControl: false,
        fadeDuration: 120,
        maxTileCacheSize: 1500, // keeps tiles you've seen, so panning back is instant
        transformCameraUpdate: (next) => director?.limitLocalCamera(next) ?? {},
      });
    } catch (error) {
      console.error('Offworld Atlas could not start the map:', error);
      callbacks.current.onFailure();
      return;
    }

    director = new CameraDirector(map, RASTER_LAYER_IDS, localTerrain ? TERRAIN_SOURCE_ID : null, (state) =>
      callbacks.current.onStateChange(state),
    );
    const activeDirector = director;
    const removeSpace =
      spaceRef.current && spaceFrontRef.current
        ? installSpaceBackdrop(map, spaceRef.current, spaceFrontRef.current, container)
        : undefined;

    const markers: Marker[] = [
      ...hosts.sites.map(({ site, element }) =>
        // Stays fully visible when a ridge passes in front of it.
        new Marker({ element, anchor: 'center', subpixelPositioning: true, opacityWhenCovered: '1' })
          .setLngLat([site.lng, site.lat])
          .addTo(map),
      ),
      ...hosts.groups.map(({ group, element }) =>
        new Marker({ element, anchor: 'center' }).setLngLat([group.lng, group.lat]).addTo(map),
      ),
      ...hosts.seas.map(({ label, element }) =>
        new Marker({ element, anchor: 'center' }).setLngLat([label.lng, label.lat]).addTo(map),
      ),
    ];
    mapRef.current = map;

    // Zooming in swaps continent numbers for region numbers, then for the named places.
    const updateTier = () => {
      container.dataset.tier = tierAt(map.getZoom(), overviewCamera(container.clientWidth, container.clientHeight).zoom);
    };
    map.on('zoom', updateTier);
    updateTier();

    // On a sphere, anything over the horizon must not show through the planet.
    const placed = [
      ...hosts.sites.map(({ site, element }) => ({ element, lng: site.lng, lat: site.lat })),
      ...hosts.groups.map(({ group, element }) => ({ element, lng: group.lng, lat: group.lat })),
      ...hosts.seas.map(({ label, element }) => ({ element, lng: label.lng, lat: label.lat })),
    ];
    const hideFarSide = () => {
      const center = map.getCenter();
      const toRadians = Math.PI / 180;
      for (const { element, lng, lat } of placed) {
        const cosAngle =
          Math.sin(center.lat * toRadians) * Math.sin(lat * toRadians) +
          Math.cos(center.lat * toRadians) * Math.cos(lat * toRadians) * Math.cos((lng - center.lng) * toRadians);
        element.style.visibility = cosAngle < FAR_SIDE_COSINE ? 'hidden' : '';
      }
    };
    map.on('move', hideFarSide);
    hideFarSide();

    // Refit the world when the window changes size, unless the user has moved the map.
    // Tracked from input events because MapLibre itself nudges the camera during a resize.
    map.on('movestart', (event) => {
      if (event.originalEvent && activeDirector.isAtOverview()) userMovedOverview.current = true;
    });
    const handleResize = () => {
      const next = overviewCamera(container.clientWidth, container.clientHeight);
      const untouched = !userMovedOverview.current && map.getPitch() === 0 && map.getBearing() === 0;
      updateTier();
      map.setMinZoom(next.zoom - 0.5);
      if (activeDirector.isAtOverview() && untouched) map.jumpTo(next);
      activeDirector.refitLocal(sites);
    };
    map.on('resize', handleResize);
    map.on('sourcedata', (event) => {
      if (event.sourceId === TERRAIN_SOURCE_ID && event.isSourceLoaded) activeDirector.terrainChanged();
    });
    // The browser can drop and restore graphics under load, so give it a moment to come back.
    let contextTimer: number | undefined;
    map.on('webglcontextlost', () => {
      contextTimer = window.setTimeout(() => callbacks.current.onFailure(), 4000);
    });
    map.on('webglcontextrestored', () => window.clearTimeout(contextTimer));
    let removeDaylight: (() => void) | undefined;
    map.once('load', () => {
      removeDaylight = installDaylight(map);
      installVectorLines(map);
      if (new URLSearchParams(window.location.search).has('e2e')) {
        (window as unknown as { __atlas: unknown }).__atlas = { map, director: activeDirector };
      }
      callbacks.current.onReady(map, activeDirector);
    });

    return () => {
      window.clearTimeout(contextTimer);
      removeSpace?.();
      removeDaylight?.();
      activeDirector.destroy();
      markers.forEach((marker) => marker.remove());
      map.remove();
    };
  }, [hosts, sites]);

  return (
    <>
      <canvas ref={spaceRef} className="space" aria-hidden="true" />
      <div ref={containerRef} className="map-canvas" />
      <canvas ref={spaceFrontRef} className="space space--front" aria-hidden="true" />
      {hosts.sites.map(({ site, element }) =>
        createPortal(
          <SiteMark site={site} atlas={atlas} onSelect={onSelect} />,
          element,
          site.id,
        ),
      )}
      {hosts.groups.map(({ group, element }) =>
        createPortal(
          <button
            type="button"
            className="cluster"
            data-level={group.level}
            data-testid={`group-${group.id}`}
            aria-label={`${group.name}: ${group.count} ${group.count === 1 ? 'place' : 'places'}, ${group.candidates} new. Zoom in.`}
            onClick={(event) => {
              event.stopPropagation();
              openGroup(group);
            }}
          >
            <span className="cluster__count">{group.count}</span>
            <span className="cluster__name">{group.name}</span>
            {group.candidates > 0 && <span className="cluster__new">{group.candidates} new</span>}
          </button>,
          element,
          group.id,
        ),
      )}
      {hosts.seas.map(({ label, element }) =>
        createPortal(
          <span className="sea-label" data-wide-only={label.wideOnly} aria-hidden="true">
            {label.name}
          </span>,
          element,
          label.name,
        ),
      )}
    </>
  );
}

function SiteMark({
  site,
  atlas,
  onSelect,
}: {
  site: AnalogSite;
  atlas: AtlasState;
  onSelect: (site: AnalogSite) => void;
}) {
  const isActive = atlas.siteId === site.id;
  const atRest = atlas.phase === 'overview';
  const state = isActive ? 'active' : atRest ? 'idle' : 'hidden';

  return (
    <button
      type="button"
      className="site-mark"
      data-state={state}
      data-status={site.status}
      data-phase={atlas.phase}
      data-testid={`marker-${site.id}`}
      tabIndex={atRest ? 0 : -1}
      aria-hidden={atRest ? undefined : true}
      aria-label={`Open ${site.name}, ${STATUS_LABEL[site.status].toLowerCase()}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(site);
      }}
    >
      <svg className="site-mark__glyph" viewBox="-22 -22 44 44" width="44" height="44" aria-hidden="true">
        <circle className="site-mark__pulse" r="11" />
        <g className="site-mark__ticks">
          <path d="M0 -20V-14M0 20V14M-20 0H-14M20 0H14" />
        </g>
        <path className="site-mark__trig" d="M0 -8.5 8 5.5H-8Z" />
        <circle className="site-mark__dot" r="1.6" />
      </svg>
      <span className="site-mark__label">
        <span className="site-mark__name">{site.name}</span>
        <span className="site-mark__status">{STATUS_LABEL[site.status]}</span>
      </span>
    </button>
  );
}
