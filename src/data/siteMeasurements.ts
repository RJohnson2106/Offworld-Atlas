import raw from './siteMeasurements.generated.json';

/** Typed view of the file written by tools/build_site_data.py. Edit that tool, not the JSON. */

export interface MeasurementRow {
  label: string;
  value: string;
  source: string;
}

export interface TerrainMetrics {
  minElevation: number;
  maxElevation: number;
  relief: number;
  meanSlope: number;
  flatShare: number;
  gentleShare: number;
  roughness: number;
  gridMetres: number;
}

export interface ReferenceSite {
  id: string;
  name: string;
  world: 'Moon' | 'Mars';
  lat: number;
  lng: number;
  note: string;
  source: string;
  metrics: TerrainMetrics;
}

export interface DataSource {
  name: string;
  url: string;
  credit: string;
}

export type SectionKey =
  | 'geology'
  | 'terrain'
  | 'climate'
  | 'water'
  | 'dust'
  | 'biology'
  | 'subsurface'
  | 'operations';

export interface SiteMeasurements {
  sections: Record<SectionKey, MeasurementRow[]>;
  terrain: Record<string, TerrainMetrics> | null;
}

export interface PlanetFacts {
  gravity: string;
  pressure: string;
  meanTemperature: string;
}

interface MeasurementsFile {
  generatedOn: string;
  windowKm: number;
  sources: Record<string, DataSource>;
  sites: Record<string, SiteMeasurements>;
  references: ReferenceSite[];
  planets: Record<'Earth' | 'Moon' | 'Mars', PlanetFacts>;
}

export const measurements = raw as unknown as MeasurementsFile;

/** The eight dimensions of analogy listed in the NASA challenge brief. */
export const SECTION_TITLES: Record<SectionKey, string> = {
  geology: 'Geology and surface materials',
  terrain: 'Terrain and topography',
  climate: 'Temperature and sunlight',
  water: 'Water and ice',
  dust: 'Dust, wind and erosion',
  biology: 'Biology and habitability',
  subsurface: 'Caves and subsurface',
  operations: 'Landing and operations',
};
