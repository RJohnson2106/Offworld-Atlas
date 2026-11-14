import type { AnalogSite } from './analogSites';
import { distributionOverlap, ratioSimilarity, science, surfaceTemperature } from './analogTraits';
import { siteLayers } from './dataLayers';
import geology from './geology.generated.json';
import { measurements } from './siteMeasurements';

/**
 * Earth-to-Earth search: which other places are most like this one?
 *
 * Each place becomes a set of measured traits (terrain, bareness, dryness, ground temperature and
 * mapped rock family), and two places are compared one trait at a time, the same way a place is
 * compared with a Moon or Mars base. The figure is the plain average of the traits both places have.
 * It says two places are physically alike in what was measured, nothing more.
 */

const GRID = '118'; // metres per sample; every place and every Moon base is measured at this spacing
const TEMPERATURE_SPAN_C = 40; // Earth sites differ by tens of degrees, so a 40 °C gap scores 0%
const RAIN_SPAN_MM = 1000;

interface Fingerprint {
  slopeBins?: number[];
  flatShare?: number;
  relief?: number;
  roughness?: number;
  hurst?: number;
  barren?: number;
  rain?: number;
  ground?: number;
  rock?: string;
}

const cache = new Map<string, Fingerprint | null>();

function fingerprint(id: string): Fingerprint | null {
  if (cache.has(id)) return cache.get(id) ?? null;
  const entry = measurements.sites[id];
  const terrain = entry?.terrain?.[GRID];
  let result: Fingerprint | null = null;
  if (entry && terrain) {
    const row = (section: 'dust' | 'water', label: string) =>
      Number.parseFloat((entry.sections[section].find((item) => item.label === label)?.value ?? '').replace(/,/g, ''));
    const bare = row('dust', 'Bare or sparse ground');
    const snow = row('water', 'Snow and ice cover');
    const rain = row('water', 'Precipitation');
    const rock = (geology.sites as Record<string, { family: string | null } | undefined>)[id]?.family;
    result = {
      slopeBins: siteLayers(id)?.charts.slopeBins[GRID],
      flatShare: terrain.flatShare,
      relief: terrain.relief,
      roughness: terrain.roughness,
      hurst: science(id)?.terrain[GRID]?.hurst,
      barren: Number.isFinite(bare) ? Math.min(100, bare + (Number.isFinite(snow) ? snow : 0)) : undefined,
      rain: Number.isFinite(rain) ? rain : undefined,
      ground: surfaceTemperature(id)?.mean,
      rock: rock ?? undefined,
    };
  }
  cache.set(id, result);
  return result;
}

export interface SharedTrait {
  label: string;
  percent: number;
}

export interface SimilarPlace {
  site: AnalogSite;
  percent: number;
  traitCount: number;
  /** The traits the two places share most closely, best first. */
  closest: SharedTrait[];
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function compare(a: Fingerprint, b: Fingerprint): SharedTrait[] {
  const traits: SharedTrait[] = [];
  const add = (label: string, score: number | null) => {
    if (score !== null && Number.isFinite(score)) traits.push({ label, percent: Math.round(clamp(score) * 100) });
  };
  const both = <T>(x: T | undefined, y: T | undefined, score: (x: T, y: T) => number) =>
    x === undefined || y === undefined ? null : score(x, y);

  add('slope spread', both(a.slopeBins, b.slopeBins, distributionOverlap));
  add('flat ground', both(a.flatShare, b.flatShare, (x, y) => 1 - Math.abs(x - y) / 100));
  add('relief', both(a.relief, b.relief, ratioSimilarity));
  add('roughness', both(a.roughness, b.roughness, ratioSimilarity));
  add('how roughness grows with distance', both(a.hurst, b.hurst, (x, y) => 1 - Math.abs(x - y)));
  add('bare ground', both(a.barren, b.barren, (x, y) => 1 - Math.abs(x - y) / 100));
  add('rain and snow', both(a.rain, b.rain, (x, y) => 1 - Math.abs(x - y) / RAIN_SPAN_MM));
  add('ground temperature', both(a.ground, b.ground, (x, y) => 1 - Math.abs(x - y) / TEMPERATURE_SPAN_C));
  add('rock family', both(a.rock, b.rock, (x, y) => (x === y ? 1 : 0)));
  return traits;
}

/** The places most like the given one, best first. */
export function similarPlaces(siteId: string, sites: readonly AnalogSite[], count = 5): SimilarPlace[] {
  const own = fingerprint(siteId);
  if (!own) return [];
  return sites
    .flatMap((site): SimilarPlace[] => {
      const other = site.id === siteId ? null : fingerprint(site.id);
      if (!other) return [];
      const traits = compare(own, other);
      if (traits.length < 5) return [];
      const percent = Math.round(traits.reduce((sum, trait) => sum + trait.percent, 0) / traits.length);
      const closest = [...traits].sort((x, y) => y.percent - x.percent).slice(0, 2);
      return [{ site, percent, traitCount: traits.length, closest }];
    })
    .sort((x, y) => y.percent - x.percent)
    .slice(0, count);
}
