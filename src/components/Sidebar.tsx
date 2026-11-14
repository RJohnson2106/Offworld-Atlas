import { useEffect, useMemo, useState } from 'react';
import { CONTINENTS, countryName } from '../data/analogSites';
import type { AnalogSite } from '../data/analogSites';
import { Ranking } from './Ranking';

interface SidebarProps {
  sites: readonly AnalogSite[];
  activeSiteId: string | null;
  /** 'overview' shows places and layers; 'local' shows the layers for the open site. */
  mode: 'overview' | 'local' | 'hidden';
  onSelect: (site: AnalogSite) => void;
  /** Hides the already-studied places, here and on the map. */
  newOnly: boolean;
  onNewOnly: (value: boolean) => void;
  /** Receives the element the map's layer list is drawn into. */
  layerSlot: (element: HTMLElement | null) => void;
  onTour: () => void;
}

type Tab = 'places' | 'ranking' | 'layers';
const NARROW_WINDOW = 720; // phones start with the sidebar folded, so the globe is visible
const NEAREST_COUNT = 5;

/** Great-circle distance in kilometres. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(a));
}

/** The country in the browser's language setting, such as "CA" for "en-CA", if the atlas has places there. */
function localeCountry(known: Set<string>): string {
  for (const language of navigator.languages ?? []) {
    try {
      const region = new Intl.Locale(language).region;
      if (region && known.has(region)) return region;
    } catch {
      // An odd language tag: try the next one.
    }
  }
  return '';
}

/** The panel at the top left: the place index and the map layers, on two tabs. */
export function Sidebar({ sites, activeSiteId, mode, onSelect, newOnly, onNewOnly, layerSlot, onTour }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('places');
  const [folded, setFolded] = useState(() => window.innerWidth <= NARROW_WINDOW);
  const candidates = sites.filter((site) => site.status === 'candidate').length;
  const shown: Tab = mode === 'local' ? 'layers' : tab;

  const countries = useMemo(() => {
    const byCode = new Map<string, { code: string; name: string; fresh: number; studied: number }>();
    for (const site of sites) {
      if (!site.country) continue;
      const entry = byCode.get(site.country) ?? { code: site.country, name: countryName(site.country), fresh: 0, studied: 0 };
      if (site.status === 'candidate') entry.fresh += 1;
      else entry.studied += 1;
      byCode.set(site.country, entry);
    }
    return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sites]);
  const [country, setCountry] = useState(() => localeCountry(new Set(sites.map((site) => site.country))));
  const [nearest, setNearest] = useState<{ site: AnalogSite; km: number }[] | null>(null);
  const [nearestNote, setNearestNote] = useState('');
  const inCountry = sites
    .filter((site) => site.country === country && (!newOnly || site.status === 'candidate'))
    .sort((a, b) => Number(a.status === 'studied') - Number(b.status === 'studied'));

  const findNearest = () => {
    if (!navigator.geolocation) {
      setNearestNote("This browser can't share a location. Choose a country instead.");
      return;
    }
    setNearestNote('Finding your location');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setNearest(
          sites
            .filter((site) => !newOnly || site.status === 'candidate')
            .map((site) => ({ site, km: distanceKm(coords.latitude, coords.longitude, site.lat, site.lng) }))
            .sort((a, b) => a.km - b.km)
            .slice(0, NEAREST_COUNT),
        );
        setNearestNote('');
      },
      () => setNearestNote("Your location wasn't shared. Choose a country instead."),
      { maximumAge: 600_000, timeout: 15_000 },
    );
  };

  const placeRow = (site: AnalogSite, detail: string, testId: string) => (
    <li key={site.id}>
      <button type="button" className="place-row" data-status={site.status} data-active={activeSiteId === site.id} data-testid={testId} onClick={() => onSelect(site)}>
        <strong>
          {site.name}
          {site.status === 'candidate' && <span className="new-tag">New</span>}
        </strong>
        <em>{detail}</em>
      </button>
    </li>
  );

  useEffect(() => {
    if (mode === 'local' && window.innerWidth <= NARROW_WINDOW) setFolded(true);
  }, [mode]);

  return (
    <aside className="sidebar" data-visible={mode !== 'hidden'} data-mode={mode} inert={mode === 'hidden'} aria-label="Offworld Atlas">
      <header className="sidebar__brand">
        {/* The official small logo, unaltered, as the Space Apps brand guidelines require. */}
        <img
          src={`${import.meta.env.BASE_URL}brand/space-apps-small-white.svg`}
          alt="NASA Space Apps Challenge"
          title="A NASA Space Apps Challenge 2026 project"
        />
        <h1>Offworld Atlas</h1>
      </header>

      <div className="sidebar__tabs" role="tablist">
        {mode === 'overview' && (
          <button type="button" role="tab" aria-selected={shown === 'places'} data-testid="tab-places" onClick={() => { setTab('places'); setFolded(false); }}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a4.6 4.6 0 0 0-4.6 4.6C3.400 9.600 8 14.500 8 14.500s4.600-4.900 4.600-8.400A4.600 4.600 0 0 0 8 1.500Zm0 6.200a1.700 1.700 0 1 1 0-3.400 1.700 1.700 0 0 1 0 3.400Z" /></svg>
            Places
          </button>
        )}
        {mode === 'overview' && (
          <button type="button" role="tab" aria-selected={shown === 'ranking'} data-testid="tab-ranking" onClick={() => { setTab('ranking'); setFolded(false); }}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.500 9h3.500v5.500H1.500Zm4.750-7.500h3.500v13h-3.500ZM11 5.500h3.500v9H11Z" /></svg>
            Ranking
          </button>
        )}
        <button type="button" role="tab" aria-selected={shown === 'layers'} data-testid="tab-layers" onClick={() => { setTab('layers'); setFolded(false); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.500 15 5 8 8.500 1 5Zm-5.300 6L8 10.200l5.300-2.700L15 8.400 8 12 1 8.400Zm0 3.200L8 13.400l5.300-2.700 1.700.900L8 15.200 1 11.600Z" /></svg>
          Layers
        </button>
        <button
          type="button"
          className="sidebar__fold"
          aria-expanded={!folded}
          aria-label={folded ? 'Open the sidebar' : 'Fold the sidebar'}
          data-testid="sidebar-fold"
          onClick={() => setFolded((current) => !current)}
        >
          <svg viewBox="0 0 12 8" aria-hidden="true"><path d={folded ? 'M0 0h12L6 8Z' : 'M0 8 6 0l6 8Z'} /></svg>
        </button>
      </div>

      <div className="sidebar__body" hidden={folded}>
        <div role="tabpanel" hidden={shown !== 'places'}>
          <p className="sidebar__summary">
            <strong>{candidates} new candidate analogs</strong> for the Moon and Mars, found by screening the whole
            Earth, in {countries.filter((entry) => entry.fresh > 0).length} countries. {sites.length - candidates} already-studied places are included for reference.
          </p>
          <button type="button" className="tour-start" data-testid="tour-start" onClick={onTour}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.500v11l9-5.500Z" /></svg>
            Take the guided tour
          </button>
          <label className="sidebar__filter">
            <input type="checkbox" checked={newOnly} data-testid="new-only" onChange={(event) => onNewOnly(event.target.checked)} />
            Show new candidates only
          </label>
          <div className="country-finder" data-testid="country-finder">
            <h3 className="section-bar">Candidates near you</h3>
            <label className="ranking__picker">
              <span>Country</span>
              <select value={country} data-testid="country-select" onChange={(event) => setCountry(event.target.value)}>
                <option value="">Choose a country</option>
                {countries.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.name} ({entry.fresh > 0 ? `${entry.fresh} new` : `${entry.studied} studied`})
                  </option>
                ))}
              </select>
            </label>
            {country && (
              <ul data-testid="country-places">
                {inCountry.map((site) => placeRow(site, `${site.target} analog, ${site.place}`, `country-${site.id}`))}
              </ul>
            )}
            <button type="button" className="near-me" data-testid="near-me" onClick={findNearest}>
              Find the places nearest to me
            </button>
            {nearestNote && <p className="panel-note" role="status">{nearestNote}</p>}
            {nearest && (
              <ul data-testid="nearest-places">
                {nearest.map(({ site, km }) =>
                  placeRow(site, `${Math.round(km).toLocaleString('en-US')} km away, ${countryName(site.country)}`, `nearest-${site.id}`),
                )}
              </ul>
            )}
            <p className="panel-note">
              {countries.length} countries have a place in this atlas. Your location is only used in this browser to
              measure distances. This app does not store or send it.
            </p>
          </div>
          <h3 className="section-bar">All places by continent</h3>          {CONTINENTS.map((continent) => {
            // New candidates lead each list; studied places follow as reference.
            const members = sites
              .filter((site) => site.continent === continent && (!newOnly || site.status === 'candidate'))
              .sort((a, b) => Number(a.status === 'studied') - Number(b.status === 'studied'));
            const fresh = members.filter((site) => site.status === 'candidate').length;
            if (members.length === 0) return null;
            return (
              <details key={continent} name="site-index">
                <summary className="section-bar">
                  <span>{continent}</span>
                  <span className="section-bar__count">
                    {fresh > 0 && <b>{fresh} new</b>}
                    {!newOnly && ` of ${members.length}`}
                  </span>
                </summary>
                <ul>
                  {members.map((site) => (
                    <li key={site.id}>
                      <button
                        type="button"
                        className="place-row"
                        data-status={site.status}
                        data-active={activeSiteId === site.id}
                        data-testid={`index-${site.id}`}
                        onClick={() => onSelect(site)}
                      >
                        <strong>
                          {site.name}
                          {site.status === 'candidate' && <span className="new-tag">New</span>}
                        </strong>
                        <em>
                          {site.target} analog{site.status === 'studied' && ', studied reference'}
                        </em>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
        <div role="tabpanel" hidden={shown !== 'ranking'}>
          {shown === 'ranking' && <Ranking sites={sites} activeSiteId={activeSiteId} newOnly={newOnly} onSelect={onSelect} />}
        </div>
        <div role="tabpanel" hidden={shown !== 'layers'} ref={layerSlot} />
      </div>
    </aside>
  );
}
