import { analogSites } from './analogSites';
import type { AnalogSite } from './analogSites';

/** The numbered bubbles on the map: one per continent, then one per region. */
export interface SiteGroup {
  id: string;
  name: string;
  level: 'continent' | 'region';
  lng: number;
  lat: number;
  count: number;
  /** How many of them are new candidates, not already-studied analogs. */
  candidates: number;
}

/** The middle of a set of places on the sphere, so groups spanning 180° still land correctly. */
function middle(sites: readonly AnalogSite[]): [number, number] {
  let [x, y, z] = [0, 0, 0];
  for (const site of sites) {
    const lat = (site.lat * Math.PI) / 180;
    const lng = (site.lng * Math.PI) / 180;
    x += Math.cos(lat) * Math.cos(lng);
    y += Math.cos(lat) * Math.sin(lng);
    z += Math.sin(lat);
  }
  return [(Math.atan2(y, x) * 180) / Math.PI, (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI];
}

function groupBy(level: SiteGroup['level'], key: (site: AnalogSite) => string): SiteGroup[] {
  const groups = new Map<string, AnalogSite[]>();
  for (const site of analogSites) groups.set(key(site), [...(groups.get(key(site)) ?? []), site]);
  return [...groups].map(([name, sites]) => {
    const [lng, lat] = middle(sites);
    const candidates = sites.filter((site) => site.status === 'candidate').length;
    return { id: `${level}-${name}`, name, level, lng, lat, count: sites.length, candidates };
  });
}

export const siteGroups: readonly SiteGroup[] = [
  ...groupBy('continent', (site) => site.continent),
  ...groupBy('region', (site) => site.region),
];

// Zoom steps above the whole-globe view at which the map changes level of detail.
export const REGION_TIER_STEP = 0.8;
export const SITE_TIER_STEP = 2.2;
// Where a click on a bubble takes the camera, a little past the step so the next level shows.
const CONTINENT_FLY_STEP = 1.15;
const REGION_FLY_STEP = 2.7;

export type MapTier = 'continent' | 'region' | 'site';

export function tierAt(zoom: number, globeZoom: number): MapTier {
  if (zoom < globeZoom + REGION_TIER_STEP) return 'continent';
  return zoom < globeZoom + SITE_TIER_STEP ? 'region' : 'site';
}

export function flyStep(group: SiteGroup): number {
  return group.level === 'continent' ? CONTINENT_FLY_STEP : REGION_FLY_STEP;
}
