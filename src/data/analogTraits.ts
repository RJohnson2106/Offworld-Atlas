import { referenceSlopeBins, siteLayers } from './dataLayers';
import { measurements } from './siteMeasurements';
import surfaceTemperatures from './surfaceTemperature.generated.json';
import type { ReferenceSite } from './siteMeasurements';

/**
 * How alike a site and a Moon or Mars place are, one trait at a time.
 *
 * An analog doesn't have to match everything, so each trait keeps its own score. The overall figure
 * is the plain average of the traits specific to this place. Every percentage is a similarity score
 * of our own design, not a probability that the site is a valid analog.
 */

interface ScienceRecord {
  world: string;
  terrain: Record<string, { grid: number; hurst: number; steeperThan15: number; scales: { lag: number; rms: number }[] }>;
  physical: { sunlight: number; dayHours: number; gravity: number; pressureMb: number; airColumnKg: number; meanElevation: number };
}

const scienceFiles = import.meta.glob('./science/*.json', { eager: true, import: 'default' }) as Record<string, ScienceRecord>;
export const science = (id: string): ScienceRecord | undefined => scienceFiles[`./science/${id}.json`];

interface SurfaceTemperature {
  mean: number;
  max?: number;
  min?: number;
  /** 'calculated' when the figure comes from a model, not an instrument. */
  basis?: string;
  /** What the mean covers and who measured it. */
  period?: string;
  /** For a Moon or Mars base, where the figure comes from. For an Earth site, the dataset's short name. */
  source?: { name: string; url: string } | string;
}

/** Ground surface temperature in °C: NASA POWER for Earth sites, LRO Diviner for Moon bases. */
export function surfaceTemperature(id: string): SurfaceTemperature | null {
  const all = { ...surfaceTemperatures.sites, ...surfaceTemperatures.references } as Record<string, SurfaceTemperature | null>;
  return all[id] ?? null;
}

export const celsius = (value: number) => `${String(Math.round(value)).replace('-', '−')} °C`;

export type TraitBasis = 'measured' | 'calculated' | 'planet';

export interface TraitScore {
  id: string;
  label: string;
  /** Short form for the comparison picker. */
  short: string;
  percent: number;
  basis: TraitBasis;
  siteValue: string;
  referenceValue: string;
}

export interface AnalogProfile {
  /** Average of the traits specific to this place, equally weighted. */
  overall: { percent: number; traitCount: number };
  closest: TraitScore;
  leastAlike: TraitScore;
  similar: TraitScore[];
  partly: TraitScore[];
  different: TraitScore[];
}

/** Dimensions in the NASA brief with no Moon or Mars data in this build. */
export const NOT_YET_COMPARABLE = 'ice, dust, biology and caves';

// The bands are a reading aid chosen for this project, not a scientific threshold.
const SIMILAR_FROM = 70;
const DIFFERENT_BELOW = 40;
const TEMPERATURE_SPAN_C = 100; // a 100 °C gap or more scores 0%
const AIR_NEGLIGIBLE_KG = 0.01;
const WET_YEAR_MM = 1000; // this much rain and snow a year, or more, scores 0% for dryness

// Planet-wide means from the NASA Planetary Fact Sheets.
const WORLD_MEAN_TEMPERATURE_C = { Moon: -20, Mars: -65 };

/** 1 when equal, 0 when one is ten times the other or more. */
export function ratioSimilarity(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return 1 - Math.min(1, Math.abs(Math.log10(a / b)));
}

/** The share of ground that falls in the same slope bands in both places. */
export function distributionOverlap(a: number[], b: number[]): number {
  const totalA = a.reduce((sum, value) => sum + value, 0);
  const totalB = b.reduce((sum, value) => sum + value, 0);
  if (totalA === 0 || totalB === 0) return 0;
  return a.reduce((sum, value, index) => sum + Math.min(value / totalA, b[index] / totalB), 0);
}

const metres = (value: number) => `${value.toLocaleString('en-US')} m`;
const byPercent = (a: TraitScore, b: TraitScore) => b.percent - a.percent;
const percentOf = (score: number) => Math.round(Math.max(0, Math.min(1, score)) * 100);
const air = (kg: number) => (kg < AIR_NEGLIGIBLE_KG ? 'Near vacuum' : `${Math.round(kg).toLocaleString('en-US')} kg/m²`);
const dayLength = (hours: number) => (hours > 100 ? `${(hours / 24).toFixed(1)} Earth days` : `${hours.toFixed(1)} hours`);

export function analogProfile(siteId: string, reference: ReferenceSite): AnalogProfile | null {
  const grid = String(reference.metrics.gridMetres);
  const entry = measurements.sites[siteId];
  const site = entry?.terrain?.[grid];
  const other = reference.metrics;
  const siteBins = siteLayers(siteId)?.charts.slopeBins[grid];
  const referenceBins = referenceSlopeBins[reference.id];
  if (!site || !siteBins || !referenceBins) return null;

  const trait = (
    id: string, label: string, short: string, score: number, basis: TraitBasis, siteValue: string, referenceValue: string,
  ): TraitScore => ({ id, label, short, percent: percentOf(score), basis, siteValue, referenceValue });

  const traits: TraitScore[] = [
    trait('slope', 'Slope spread', 'slope', distributionOverlap(siteBins, referenceBins), 'measured',
      `${site.meanSlope}° mean`, `${other.meanSlope}° mean`),
    trait('flat', 'Flat ground for landing', 'flat ground', 1 - Math.abs(site.flatShare - other.flatShare) / 100, 'measured',
      `${site.flatShare}% under 5°`, `${other.flatShare}% under 5°`),
    trait('relief', 'Relief', 'relief', ratioSimilarity(site.relief, other.relief), 'measured',
      metres(site.relief), metres(other.relief)),
    trait('roughness', 'Local roughness', 'roughness', ratioSimilarity(site.roughness, other.roughness), 'measured',
      metres(site.roughness), metres(other.roughness)),
  ];

  const siteScience = science(siteId);
  const referenceScience = science(reference.id);
  const siteTerrain = siteScience?.terrain[grid];
  const referenceTerrain = referenceScience?.terrain[grid];

  if (siteTerrain && referenceTerrain) {
    const pairs = siteTerrain.scales.map((scale, index) => ratioSimilarity(scale.rms, referenceTerrain.scales[index].rms));
    const last = siteTerrain.scales.length - 1;
    traits.push(
      trait('scales', 'Roughness across distances', 'roughness by scale', pairs.reduce((sum, v) => sum + v, 0) / pairs.length, 'measured',
        `${metres(siteTerrain.scales[last].rms)} over ${metres(siteTerrain.scales[last].lag)}`,
        `${metres(referenceTerrain.scales[last].rms)} over ${metres(referenceTerrain.scales[last].lag)}`),
      trait('hurst', 'How roughness grows with distance', 'Hurst exponent', 1 - Math.abs(siteTerrain.hurst - referenceTerrain.hurst), 'measured',
        `Hurst ${siteTerrain.hurst.toFixed(2)}`, `Hurst ${referenceTerrain.hurst.toFixed(2)}`),
    );
  }

  if (siteScience && referenceScience) {
    const a = siteScience.physical;
    const b = referenceScience.physical;
    traits.push(
      trait('sunlight', 'Sunlight at this latitude', 'sunlight', ratioSimilarity(a.sunlight, b.sunlight), 'calculated',
        `${Math.round(a.sunlight)} W/m²`, `${Math.round(b.sunlight)} W/m²`),
      // These two are the same everywhere on a world, so they can't say anything about one site.
      trait('day', 'Length of day', 'day length', ratioSimilarity(a.dayHours, b.dayHours), 'planet',
        dayLength(a.dayHours), dayLength(b.dayHours)),
      trait('gravity', 'Gravity', 'gravity', ratioSimilarity(a.gravity, b.gravity), 'planet',
        `${a.gravity.toFixed(2)} m/s²`, `${b.gravity.toFixed(2)} m/s²`),
      trait('air', 'Air overhead (shielding)', 'air overhead', ratioSimilarity(a.airColumnKg, b.airColumnKg), 'calculated',
        air(a.airColumnKg), air(b.airColumnKg)),
    );
  }

  // The Moon and Mars are bare and rainless everywhere, but Earth sites differ widely in both, so
  // these two tell places apart. The control places showed the score needed them: without them a
  // forested mountain could match rugged lunar terrain.
  const percentRow = (section: 'dust' | 'water', label: string) =>
    Number.parseFloat(entry.sections[section].find((row) => row.label === label)?.value ?? '');
  const bare = percentRow('dust', 'Bare or sparse ground');
  const snowAndIce = percentRow('water', 'Snow and ice cover');
  const precipitation = Number.parseFloat(
    (entry.sections.water.find((row) => row.label === 'Precipitation')?.value ?? '').replace(/,/g, ''),
  );
  if (Number.isFinite(bare)) {
    const barren = Math.min(100, bare + (Number.isFinite(snowAndIce) ? snowAndIce : 0));
    traits.push(
      trait('barren', 'Ground free of vegetation', 'bare ground', barren / 100, 'measured',
        `${barren.toFixed(0)}% bare rock, soil, snow or ice`, 'no vegetation'),
    );
  }
  if (Number.isFinite(precipitation)) {
    traits.push(
      trait('dryness', 'Dryness', 'dryness', 1 - Math.min(1, precipitation / WET_YEAR_MM), 'measured',
        `${precipitation.toLocaleString('en-US')} mm of rain and snow a year`, 'no rain'),
    );
  }

  const temperatureRow = entry.sections.climate.find((row) => row.label === 'Mean air temperature');
  const siteTemperature = temperatureRow ? Number.parseFloat(temperatureRow.value) : Number.NaN;
  const siteSurface = surfaceTemperature(siteId);
  const referenceSurface = surfaceTemperature(reference.id);
  if (siteSurface && referenceSurface) {
    // Ground against ground, measured at both places, so this one counts as specific to the site.
    traits.push(
      trait('temperature', 'Ground surface temperature', 'surface temperature',
        1 - Math.abs(siteSurface.mean - referenceSurface.mean) / TEMPERATURE_SPAN_C,
        referenceSurface.basis === 'calculated' ? 'calculated' : 'measured',
        `${celsius(siteSurface.mean)} yearly mean`,
        `${celsius(referenceSurface.mean)} ${referenceSurface.period ?? 'mean'}` +
          (referenceSurface.min !== undefined && referenceSurface.max !== undefined
            ? `, typical day from ${celsius(referenceSurface.min)} to ${celsius(referenceSurface.max)}`
            : '')),
    );
  } else if (Number.isFinite(siteTemperature)) {
    const worldMean = WORLD_MEAN_TEMPERATURE_C[reference.world];
    traits.push(
      trait('temperature', 'Mean temperature, against planet average', 'temperature',
        1 - Math.abs(siteTemperature - worldMean) / TEMPERATURE_SPAN_C, 'planet',
        `${siteTemperature.toFixed(1)} °C`, `${String(worldMean).replace('-', '−')} °C`),
    );
  }

  const sorted = [...traits].sort(byPercent);
  // A planet-wide property says little about one specific spot, so it can't be the headline.
  const eligible = sorted.filter((t) => t.basis !== 'planet');
  return {
    overall: {
      percent: Math.round(eligible.reduce((sum, t) => sum + t.percent, 0) / eligible.length),
      traitCount: eligible.length,
    },
    closest: eligible[0],
    leastAlike: eligible[eligible.length - 1],
    similar: sorted.filter((t) => t.percent >= SIMILAR_FROM),
    partly: sorted.filter((t) => t.percent >= DIFFERENT_BELOW && t.percent < SIMILAR_FROM),
    different: sorted.filter((t) => t.percent < DIFFERENT_BELOW),
  };
}
