import minerals from './minerals.generated.json';

/**
 * Compares which broad mineral groups occur at a site and at a Mars base. It records presence only:
 * orbiters, rovers and EMIT measure in different ways, so amounts can't be compared fairly.
 */

export type MineralGroup = 'ironOxide' | 'clay' | 'carbonate' | 'sulfate';

export const GROUP_LABELS: Record<MineralGroup, string> = {
  ironOxide: 'Iron oxides',
  clay: 'Clays and micas',
  carbonate: 'Carbonates',
  sulfate: 'Sulfates',
};

const PRESENT_FROM = 1; // percent of the square's pixels, so scattered detections don't count

interface MineralRecord {
  usable: boolean;
  reason?: string;
  shares?: Record<MineralGroup, number>;
}

/** Groups confirmed in published orbital or rover work at each base. */
const REFERENCE_MINERALS: Record<string, { groups: MineralGroup[]; source: { label: string; url: string } }> = {
  jezero: {
    groups: ['ironOxide', 'clay', 'carbonate', 'sulfate'],
    source: { label: 'Perseverance and orbital mineralogy of Jezero', url: 'https://www.eurekalert.org/news-releases/1097904' },
  },
  gale: {
    groups: ['ironOxide', 'clay', 'carbonate', 'sulfate'],
    source: { label: 'Curiosity CheMin results at Gale', url: 'https://ntrs.nasa.gov/api/citations/20210026241/downloads/Rampe_etal_LPSC_2022_CheMin_clay-sulfate.pdf' },
  },
};

const records = minerals.sites as Record<string, MineralRecord>;
export const mineralSource = minerals.source;

export function siteMinerals(siteId: string): { group: MineralGroup; share: number }[] | null {
  const record = records[siteId];
  if (!record?.usable || !record.shares) return null;
  return (Object.keys(GROUP_LABELS) as MineralGroup[])
    .map((group) => ({ group, share: record.shares![group] }))
    .filter(({ share }) => share >= PRESENT_FROM)
    .sort((a, b) => b.share - a.share);
}

export type MineralComparison =
  | { kind: 'scored'; percent: number; shared: MineralGroup[]; siteOnly: MineralGroup[]; baseOnly: MineralGroup[]; source: { label: string; url: string } }
  | { kind: 'none'; reason: string };

export function compareMinerals(siteId: string, referenceId: string, world: 'Moon' | 'Mars'): MineralComparison {
  if (world === 'Moon') {
    return { kind: 'none', reason: "EMIT detects clays, carbonates, sulfates and iron oxides. The Moon's mineral maps cover plagioclase, pyroxene and olivine instead, so there's nothing to match." };
  }
  const reference = REFERENCE_MINERALS[referenceId];
  if (!reference) return { kind: 'none', reason: "We couldn't find published mineral data for these groups at this Mars location." };
  const record = records[siteId];
  if (!record) return { kind: 'none', reason: 'Mineral data for this place is still being processed.' };
  if (record.reason === 'vegetation') return { kind: 'none', reason: 'Most of what EMIT sees here is vegetation, so it says little about the ground.' };
  if (record.reason === 'failed') return { kind: 'none', reason: "This place's mineral data couldn't be processed." };
  const found = siteMinerals(siteId);
  if (!found) return { kind: 'none', reason: 'EMIT has too little clear coverage of this place.' };

  const present = found.map(({ group }) => group);
  const shared = present.filter((group) => reference.groups.includes(group));
  return {
    kind: 'scored',
    percent: Math.round((shared.length / reference.groups.length) * 100),
    shared,
    siteOnly: present.filter((group) => !reference.groups.includes(group)),
    baseOnly: reference.groups.filter((group) => !present.includes(group)),
    source: reference.source,
  };
}
