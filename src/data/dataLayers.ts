/** Typed view of the files written by tools/build_data_layers.py. */

export interface LayerSource {
  name: string;
  url: string;
}

export interface LayerClass {
  label: string;
  color: string;
}

export interface LayerSpec {
  id: string;
  label: string;
  kind: 'continuous' | 'classes';
  unit: string;
  min?: number;
  max?: number;
  stops?: string[];
  ticks?: string[];
  classes?: LayerClass[];
  source: LayerSource;
}

export interface PointLayer {
  id: string;
  label: string;
  color: string;
  count: number;
  source: LayerSource;
}

export interface GlobalManifest {
  layers: LayerSpec[];
  points: PointLayer[];
  gridSize: number;
}

export interface MonthlyClimate {
  month: string;
  mean: number;
  high: number;
  low: number;
  precipitation: number;
}

export interface LandCoverShare {
  label: string;
  color: string;
  share: number;
}

export interface SiteLayers {
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  bounds: [number, number, number, number];
  gridSize: number;
  layers: LayerSpec[];
  charts: {
    climate: MonthlyClimate[];
    landCover: LandCoverShare[];
    slopeLabels: string[];
    slopeBins: Record<string, number[]>;
  };
}

const files = import.meta.glob('./layers/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export const globalLayers = files['./layers/global.json'] as GlobalManifest | undefined;

export const siteLayers = (id: string) => files[`./layers/${id}.json`] as SiteLayers | undefined;

export const referenceSlopeBins = (
  (files['./layers/references.json'] as { slopeBins: Record<string, number[]> } | undefined)?.slopeBins ?? {}
);

export const GLOBAL_COORDINATES: SiteLayers['coordinates'] = [
  [-180, 85.0511],
  [180, 85.0511],
  [180, -85.0511],
  [-180, -85.0511],
];

/** Turns a value-grid byte into the text shown on hover. Returns null where there's no data. */
export function describeGridValue(spec: LayerSpec, value: number): string | null {
  if (value === 255) return null;
  if (spec.kind === 'classes') return spec.classes?.[value]?.label ?? null;
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const reading = Math.round(min + (value / 254) * (max - min));
  return `${reading.toLocaleString('en-US')} ${spec.unit}`;
}
