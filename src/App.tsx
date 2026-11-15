import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { analogSites } from './data/analogSites';
import type { AnalogSite } from './data/analogSites';
import { MapStage } from './map/MapStage';
import { MapInstruments } from './map/MapInstruments';
import { DataLayerControl } from './map/DataLayerControl';
import { preloadSiteImagery } from './map/liveDetail';
import { DEFAULT_HEIGHT_SCALE } from './map/cameraDirector';
import type { AtlasState, CameraDirector } from './map/cameraDirector';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './map/Timeline';
import { LocalControls } from './components/LocalControls';
import { PanelBoundary } from './components/PanelBoundary';
import { SitePanel } from './components/SitePanel';
import type { DroneStatus } from './components/SitePanel';
import { basemap } from './map/basemap';
import { buildTour, Tour } from './components/Tour';
import { Landing } from './components/Landing';

// Three.js is only fetched when someone enters a drone view.
const DroneView = lazy(() => import('./drone/DroneView'));

const OVERVIEW: AtlasState = { phase: 'overview', siteId: null };
const DRONE_EXIT_FADE_MS = 190;
const LANDING_FADE_MS = 380;
const ENTERED_KEY = 'offworld-atlas-entered';

/** The landing page is shown once per browser tab. Automated checks skip it with ?e2e. */
function skipLanding(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('e2e') || window.sessionStorage.getItem(ENTERED_KEY) === '1';
  } catch {
    return false;
  }
}

function canUseWebGL(): boolean {
  try {
    // MapLibre 6 and three.js both need WebGL 2.
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function announcement({ phase, siteId }: AtlasState): string {
  const name = analogSites.find((site) => site.id === siteId)?.name;
  if (phase === 'departing') return `Flying to ${name}`;
  if (phase === 'local') return `${name} site view`;
  if (phase === 'drone') return `Drone view of ${name}`;
  return '';
}

interface DroneRequest {
  site: AnalogSite;
  sceneId: string;
}

export default function App() {
  const [atlas, setAtlas] = useState<AtlasState>(OVERVIEW);
  const [webglMissing] = useState(() => !canUseWebGL());
  const [mapAvailable, setMapAvailable] = useState(!webglMissing);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [layerSlot, setLayerSlot] = useState<HTMLElement | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [drone, setDrone] = useState<DroneRequest | null>(null);
  const [droneStatus, setDroneStatus] = useState<DroneStatus>('idle');
  const [droneExiting, setDroneExiting] = useState(false);
  const [heightScale, setHeightScale] = useState<number>(DEFAULT_HEIGHT_SCALE);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [landing, setLanding] = useState<'shown' | 'leaving' | 'gone'>(() => (skipLanding() ? 'gone' : 'shown'));
  const landingRef = useRef(landing);
  landingRef.current = landing;
  const candidateCount = useMemo(() => analogSites.filter((entry) => entry.status === 'candidate').length, []);
  const countryCount = useMemo(
    () => new Set(analogSites.filter((entry) => entry.status === 'candidate').map((entry) => entry.country)).size,
    [],
  );
  const tourStops = useMemo(() => buildTour(analogSites), []);

  const directorRef = useRef<CameraDirector | null>(null);
  const lastSiteRef = useRef<string | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const usingKeyboardRef = useRef(false);
  const exitTimerRef = useRef<number | null>(null);
  const atlasRef = useRef(atlas);
  atlasRef.current = atlas;
  const droneRef = useRef(drone);
  droneRef.current = drone;

  const { phase, siteId } = atlas;
  const site = analogSites.find((candidate) => candidate.id === siteId) ?? null;

  const select = useCallback((next: AnalogSite) => {
    lastSiteRef.current = next.id;
    preloadSiteImagery(next.lng, next.lat, next.localCamera.zoom, next.localCamera.bearing);
    if (directorRef.current) directorRef.current.fly(next, prefersReducedMotion());
    else setAtlas({ phase: 'local', siteId: next.id });
  }, []);

  const back = useCallback(() => {
    if (directorRef.current) directorRef.current.back(analogSites, prefersReducedMotion());
    else setAtlas(OVERVIEW);
  }, []);

  // Where the map has been asked to end up. A site view can't fly straight to another site, so the
  // request is kept here and followed one step at a time as each flight lands.
  const wantedRef = useRef<{ siteId: string | null } | null>(null);
  const pursue = useCallback(() => {
    const wanted = wantedRef.current;
    if (!wanted) return;
    const current = atlasRef.current;
    if (current.phase === 'overview') {
      wantedRef.current = null;
      const next = analogSites.find((candidate) => candidate.id === wanted.siteId);
      if (next) select(next);
    } else if (current.phase === 'local') {
      if (current.siteId === wanted.siteId) wantedRef.current = null;
      else back();
    }
  }, [select, back]);

  /** Go to a site, or to the whole-Earth view with null, from wherever the map is now. */
  const goTo = useCallback(
    (targetId: string | null) => {
      wantedRef.current = { siteId: targetId };
      pursue();
    },
    [pursue],
  );
  const goToSite = useCallback((next: AnalogSite) => goTo(next.id), [goTo]);

  useEffect(() => {
    pursue();
  }, [atlas.phase, pursue]);

  const tourIndexRef = useRef(tourIndex);
  tourIndexRef.current = tourIndex;
  const newOnlyBeforeTour = useRef(false);
  const showStop = useCallback(
    (index: number) => {
      const stop = tourStops[index];
      if (!stop) return;
      if (tourIndexRef.current === null) newOnlyBeforeTour.current = newOnly;
      setTourIndex(index);
      setNewOnly(Boolean(stop.newOnly));
      goTo(stop.siteId);
    },
    [tourStops, newOnly, goTo],
  );
  const endTour = useCallback(() => {
    setTourIndex(null);
    setNewOnly(newOnlyBeforeTour.current);
  }, []);

  /** Fade the landing page out, then optionally start the guided tour. */
  const leaveLanding = useCallback(
    (startTour: boolean) => {
      if (landingRef.current !== 'shown') return;
      try {
        window.sessionStorage.setItem(ENTERED_KEY, '1');
      } catch {
        // Private browsing can refuse storage. The page still opens.
      }
      setLanding('leaving');
      window.setTimeout(() => {
        setLanding('gone');
        if (startTour) showStop(0);
      }, prefersReducedMotion() ? 0 : LANDING_FADE_MS);
    },
    [showStop],
  );

  const enterDrone = useCallback(() => {
    const current = analogSites.find((candidate) => candidate.id === atlasRef.current.siteId);
    if (!current?.droneScene || droneRef.current || atlasRef.current.phase !== 'local') return;
    setDroneStatus('loading');
    setDrone({ site: current, sceneId: current.droneScene });
  }, []);

  const handleDroneReady = useCallback(() => {
    const request = droneRef.current;
    if (!request) return;
    setDroneStatus('idle');
    directorRef.current?.dive(request.site, prefersReducedMotion());
  }, []);

  const exitDrone = useCallback(() => {
    const current = atlasRef.current.phase;
    if (current === 'local') {
      // Still loading: nothing has moved yet, so just cancel.
      setDrone(null);
      setDroneStatus('idle');
      return;
    }
    if ((current !== 'diving' && current !== 'drone') || exitTimerRef.current !== null) return;

    const reduced = prefersReducedMotion();
    const finish = () => {
      exitTimerRef.current = null;
      setDroneExiting(false);
      setDrone(null);
      directorRef.current?.surface(analogSites, reduced);
    };
    if (current === 'diving' || reduced) {
      finish();
    } else {
      setDroneExiting(true);
      exitTimerRef.current = window.setTimeout(finish, DRONE_EXIT_FADE_MS);
    }
  }, []);

  const handleDroneFailure = useCallback(() => {
    setDrone(null);
    setDroneExiting(false);
    setDroneStatus('failed');
    directorRef.current?.surface(analogSites, prefersReducedMotion());
  }, []);

  const handleFailure = useCallback(() => {
    directorRef.current = null;
    setMap(null);
    setMapAvailable(false);
    setDrone(null);
    setAtlas((current) =>
      current.siteId ? { phase: 'local', siteId: current.siteId } : OVERVIEW,
    );
  }, []);

  const handleReady = useCallback((readyMap: MapLibreMap, director: CameraDirector) => {
    directorRef.current = director;
    setMap(readyMap);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (landingRef.current !== 'gone') leaveLanding(false);
      else if (droneRef.current) exitDrone();
      else if (tourIndexRef.current !== null) endTour();
      else back();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [back, exitDrone, endTour, leaveLanding]);

  useEffect(() => {
    const onPointer = () => {
      usingKeyboardRef.current = false;
    };
    const onKey = () => {
      usingKeyboardRef.current = true;
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    };
  }, []);

  // Keyboard users follow the view change. Mouse users keep their place, with no focus ring.
  useEffect(() => {
    if (!usingKeyboardRef.current) return;
    if (phase === 'local') {
      backButtonRef.current?.focus({ preventScroll: true });
    } else if (phase === 'overview' && lastSiteRef.current) {
      document
        .querySelector<HTMLButtonElement>(`[data-testid="index-${lastSiteRef.current}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [phase]);

  const panelOpen = phase === 'arriving' || phase === 'local';

  return (
    <>
    <main
      className="atlas"
      inert={landing === 'shown'}
      data-phase={phase}
      data-site={siteId ?? ''}
      data-map={mapAvailable ? 'live' : 'unavailable'}
      data-new-only={newOnly}
      data-tour={tourIndex !== null}
      data-testid="atlas"
    >
      {mapAvailable ? (
        <MapStage
          sites={analogSites}
          atlas={atlas}
          onSelect={select}
          onStateChange={setAtlas}
          onReady={handleReady}
          onFailure={handleFailure}
        />
      ) : (
        <div className="map-fallback" style={{ backgroundImage: `url(${basemap.staticImage})` }}>
          <p className="map-fallback__note" role="status">
            {webglMissing
              ? "This browser can't draw the interactive map. The site index and details still work. Turn on WebGL or use another browser to see the map."
              : "The interactive map stopped working. The site index and details still work. Reload the page to try again."}
          </p>
        </div>
      )}

      <div className="drone-veil" />

      <Sidebar
        sites={analogSites}
        activeSiteId={siteId}
        mode={phase === 'overview' ? 'overview' : phase === 'local' ? 'local' : 'hidden'}
        onSelect={select}
        newOnly={newOnly}
        onNewOnly={setNewOnly}
        layerSlot={setLayerSlot}
        onTour={() => showStop(0)}
      />

      <button
        ref={backButtonRef}
        type="button"
        className="back-to-map"
        data-testid="back-to-map"
        onClick={back}
        inert={!panelOpen}
      >
        Back to map
      </button>

      {mapAvailable && (
        <LocalControls
          map={map}
          interactive={phase === 'local'}
          reducedMotion={prefersReducedMotion}
          onReset={() => directorRef.current?.resetLocal(analogSites, prefersReducedMotion())}
          heightScale={heightScale}
          onHeightScale={(scale) => {
            setHeightScale(scale);
            directorRef.current?.setHeightScale(scale);
          }}
        />
      )}

      {mapAvailable && <MapInstruments map={map} reducedMotion={prefersReducedMotion} />}

      {mapAvailable && <DataLayerControl map={map} phase={phase} siteId={siteId} slot={layerSlot} />}

      {map && <Timeline map={map} visible={phase === 'overview' || phase === 'local'} />}

      <PanelBoundary key={site?.id ?? 'none'}>
        <SitePanel
          site={site}
          open={panelOpen}
          droneAvailable={mapAvailable}
          droneStatus={droneStatus}
          onEnterDrone={enterDrone}
          sites={analogSites}
          onSelect={goToSite}
        />
      </PanelBoundary>

      {tourIndex !== null && <Tour stops={tourStops} index={tourIndex} onIndex={showStop} onEnd={endTour} />}

      {drone && (
        <Suspense fallback={null}>
          <DroneView
            site={drone.site}
            sceneId={drone.sceneId}
            active={phase === 'drone'}
            exiting={droneExiting}
            reducedMotion={prefersReducedMotion()}
            onReady={handleDroneReady}
            onFailure={handleDroneFailure}
            onExit={exitDrone}
          />
        </Suspense>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement(atlas)}
      </p>
    </main>
    {landing !== 'gone' && (
      <Landing
        candidates={candidateCount}
        countries={countryCount}
        leaving={landing === 'leaving'}
        reducedMotion={prefersReducedMotion()}
        onEnter={() => leaveLanding(false)}
        onTour={() => leaveLanding(true)}
      />
    )}
    </>
  );
}
