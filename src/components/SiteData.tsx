import { useState } from 'react';
import { analogSites } from '../data/analogSites';
import type { AnalogSite } from '../data/analogSites';
import { referenceSlopeBins, siteLayers } from '../data/dataLayers';
import geology from '../data/geology.generated.json';
import { analogProfile, celsius, NOT_YET_COMPARABLE, science, surfaceTemperature } from '../data/analogTraits';
import surfaceTemperatures from '../data/surfaceTemperature.generated.json';
import moonIce from '../data/moonIce.generated.json';
import { compareMinerals, GROUP_LABELS, mineralSource, siteMinerals } from '../data/mineralGroups';
import type { TraitScore } from '../data/analogTraits';
import { measurements, SECTION_TITLES } from '../data/siteMeasurements';
import type { SectionKey, TerrainMetrics } from '../data/siteMeasurements';
import { ClimateCharts, LandCoverBar, ReliefScatter, RoughnessByScale, SlopeDistribution } from './SiteCharts';
import type { ScatterPoint } from './SiteCharts';

const SECTION_ORDER = Object.keys(SECTION_TITLES) as SectionKey[];
const surfaceSources = surfaceTemperatures.sources;

/** Shares of the area, in percent, by how near the surface ice could survive. */
interface MoonIce {
  surface: number;
  shallow: number;
  deeper: number;
  none: number;
}

const TERRAIN_ROWS: { label: string; read: (m: TerrainMetrics) => string }[] = [
  { label: 'Relief', read: (m) => `${m.relief.toLocaleString('en-US')} m` },
  { label: 'Mean slope', read: (m) => `${m.meanSlope}°` },
  { label: 'Under 5° slope', read: (m) => `${m.flatShare}%` },
  { label: 'Under 15° slope', read: (m) => `${m.gentleShare}%` },
  { label: 'Local roughness', read: (m) => `${m.roughness} m` },
];

/** Measured values for one site, grouped by the challenge's dimensions of analogy. */
export function Measurements({ site }: { site: AnalogSite }) {
  const data = measurements.sites[site.id];
  const charts = siteLayers(site.id)?.charts;
  if (!data) return null;

  return (
    <div className="measurements" data-testid="measurements">
      {SECTION_ORDER.map((key) => {
        const rows = data.sections[key];
        return (
          <details key={key} className="measure" open={key === 'terrain'}>
            <summary>{SECTION_TITLES[key]}</summary>
            {rows.length === 0 ? (
              <p className="measure__empty">No open data for this site yet.</p>
            ) : (
              <dl>
                {rows.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {key === 'climate' && charts && <ClimateCharts months={charts.climate} />}
            {key === 'dust' && charts && <LandCoverBar shares={charts.landCover} />}
          </details>
        );
      })}
    </div>
  );
}

const CONDITION_ROWS: { section: SectionKey; label: string; show: string }[] = [
  { section: 'water', label: 'Precipitation', show: 'Rain and snow' },
  { section: 'climate', label: 'Mean air temperature', show: 'Mean temperature' },
  { section: 'climate', label: 'Coldest month, daily low', show: 'Coldest daily low' },
  { section: 'dust', label: 'Bare or sparse ground', show: 'Bare or sparse ground' },
  { section: 'biology', label: 'Vegetated, including sparse grass', show: 'Vegetated' },
  { section: 'water', label: 'Glaciers reaching this area', show: 'Glaciers' },
  { section: 'subsurface', label: 'Nearest Holocene volcano', show: 'Nearest young volcano' },
  { section: 'operations', label: 'Travel to a city of 50,000+', show: 'Travel to a city' },
];

/** The measured conditions that bear on why a place might work as an analog. */
export function SiteConditions({ site }: { site: AnalogSite }) {
  const data = measurements.sites[site.id];
  if (!data) return null;
  const minerals = siteMinerals(site.id);
  const rows = CONDITION_ROWS.flatMap(({ section, label, show }) => {
    const value = data.sections[section].find((row) => row.label === label)?.value;
    return value ? [{ show, value }] : [];
  });

  return (
    <section className="evidence" data-testid="site-conditions">
      <h3>Measured conditions here</h3>
      <dl className="conditions">
        {rows.map((row) => (
          <div key={row.show}>
            <dt>{row.show}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
        {minerals && minerals.length > 0 && (
          <div>
            <dt>Minerals detected</dt>
            <dd>{minerals.map(({ group, share }) => `${GROUP_LABELS[group]} (${Math.round(share)}% of pixels)`).join(', ')}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

interface RockRecord {
  unit: string | null;
  family: string | null;
}

/** Only states a result when both maps name the kind of rock outright. */
function rockVerdict(site: string | null, reference: string | null): string {
  if (!site || !reference) return "Can't say from these maps";
  if (site === reference) return `Same broad family: ${site}`;
  return `Different families: ${site} and ${reference}`;
}

function TraitList({
  title,
  traits,
  siteName,
  referenceName,
}: {
  title: string;
  traits: TraitScore[];
  siteName: string;
  referenceName: string;
}) {
  if (traits.length === 0) return null;
  return (
    <div className="traits">
      <h4>{title}</h4>
      <ul>
        {traits.map((trait) => (
          <li key={trait.id}>
            <div className="traits__head">
              <span>{trait.label}</span>
              <strong>{trait.percent}%</strong>
            </div>
            <span className="traits__track" aria-hidden="true">
              <span style={{ width: `${trait.percent}%` }} />
            </span>
            <p className="traits__values">
              {siteName}: {trait.siteValue}. {referenceName}: {trait.referenceValue}.
              {trait.basis === 'calculated' && (trait.id === 'temperature' ? ' From a climate model, not a measurement.' : ' Calculated from physics.')}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Side-by-side numbers, measured the same way on each world, with one score per trait. */
export function Comparison({ site }: { site: AnalogSite }) {
  const { references, planets, sites, sources } = measurements;
  const data = sites[site.id];
  // Opens on its published counterpart if it has one, otherwise the base it most resembles.
  const [referenceId, setReferenceId] = useState(() => {
    if (site.pairedBase) return site.pairedBase;
    const sameWorld = references.filter((r) => r.world === site.target);
    const ranked = [...sameWorld].sort(
      (a, b) => (analogProfile(site.id, b)?.overall.percent ?? -1) - (analogProfile(site.id, a)?.overall.percent ?? -1),
    );
    return ranked[0]?.id ?? references[0]?.id;
  });
  const reference = references.find((r) => r.id === referenceId);
  if (!data || !reference) return null;

  const grid = reference.metrics.gridMetres;
  const matched = data.terrain?.[String(grid)];
  const siteTemperature = data.sections.climate.find((r) => r.label === 'Mean air temperature')?.value;
  const world = planets[reference.world];
  const ice = (moonIce.references as Record<string, MoonIce | undefined>)[reference.id];
  const siteSurface = surfaceTemperature(site.id);
  const referenceSurface = surfaceTemperature(reference.id);
  const referenceSource =
    referenceSurface && typeof referenceSurface.source === 'object' ? referenceSurface.source : surfaceSources.moon;
  const charts = siteLayers(site.id)?.charts;
  const referenceBins = referenceSlopeBins[reference.id];
  const profile = analogProfile(site.id, reference);
  const mineralMatch = compareMinerals(site.id, reference.id, reference.world);
  const siteRock = geology.sites[site.id as keyof typeof geology.sites] as RockRecord | undefined;
  const referenceRock = geology.references[reference.id as keyof typeof geology.references] as RockRecord | undefined;
  const siteScales = science(site.id)?.terrain[String(grid)]?.scales;
  const referenceScales = science(reference.id)?.terrain[String(grid)]?.scales;

  // Everything on one grid, so the positions can be compared.
  const scatter: ScatterPoint[] = [
    ...Object.entries(sites).flatMap(([id, entry]) => {
      const metrics = entry.terrain?.[String(grid)];
      if (!metrics) return [];
      const name = analogSites.find((candidate) => candidate.id === id)?.name ?? id;
      return [{ id, name, relief: metrics.relief, slope: metrics.meanSlope, role: id === site.id ? ('site' as const) : ('other' as const) }];
    }),
    ...references
      .filter((r) => r.world === reference.world)
      .map((r) => ({
        id: r.id,
        name: r.name,
        relief: r.metrics.relief,
        slope: r.metrics.meanSlope,
        role: r.id === reference.id ? ('reference' as const) : ('other' as const),
      })),
  ];

  return (
    <section className="comparison" data-testid="comparison">
      <h3>How close it is to {reference.world === 'Moon' ? 'the Moon' : 'Mars'}</h3>
      <label className="comparison__picker">
        <span>Compare with</span>
        <select
          value={reference.id}
          data-testid="compare-reference"
          onChange={(event) => setReferenceId(event.target.value)}
        >
          {(['Moon', 'Mars'] as const).map((name) => (
            <optgroup key={name} label={name}>
              {references
                .filter((r) => r.world === name)
                .map((r) => {
                  const overall = analogProfile(site.id, r)?.overall;
                  return (
                    <option key={r.id} value={r.id}>
                      {overall ? `${r.name}, ${overall.percent}% overall` : r.name}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
      </label>

      {profile && (
        <div className="match" data-testid="trait-match">
          <p className="match__eyebrow">Overall match with {reference.name}</p>
          <p className="match__score" data-testid="overall-match">
            <strong>{profile.overall.percent}%</strong> average of {profile.overall.traitCount} traits
          </p>
          <p className="match__least">
            Closest trait: {profile.closest.label}, {profile.closest.percent}%
          </p>
          <p className="match__least">
            Least alike: {profile.leastAlike.label}, {profile.leastAlike.percent}%
          </p>

          <TraitList title="Similar" traits={profile.similar} siteName={site.name} referenceName={reference.name} />
          <TraitList title="Partly similar" traits={profile.partly} siteName={site.name} referenceName={reference.name} />
          <TraitList title="Different" traits={profile.different} siteName={site.name} referenceName={reference.name} />

          {siteRock && referenceRock && (
            <div className="rock" data-testid="rock-family">
              <h4>Rock family</h4>
              <p className="rock__verdict">{rockVerdict(siteRock.family, referenceRock.family)}</p>
              <p className="traits__values">
                {site.name}: {siteRock.unit ?? 'No unit mapped'}. {reference.name}:{' '}
                {referenceRock.unit ?? 'No unit mapped'}. Read from the names on geologic maps at
                continental scale, so it describes the broad region.
              </p>
            </div>
          )}

          <div className="rock" data-testid="chemistry">
            <h4>Chemistry: mineral groups</h4>
            {mineralMatch.kind === 'scored' ? (
              <>
                <p className="rock__verdict">
                  {mineralMatch.percent}% shared ({mineralMatch.shared.length} of{' '}
                  {mineralMatch.shared.length + mineralMatch.baseOnly.length} groups)
                </p>
                <p className="traits__values">
                  {mineralMatch.shared.length > 0 &&
                    `At both: ${mineralMatch.shared.map((group) => GROUP_LABELS[group]).join(', ')}. `}
                  {mineralMatch.baseOnly.length > 0 &&
                    `Only at ${reference.name}: ${mineralMatch.baseOnly.map((group) => GROUP_LABELS[group]).join(', ')}. `}
                  This compares which groups are present, not how much of each.{' '}
                  <a href={mineralSource.url} target="_blank" rel="noreferrer">
                    {mineralSource.name}
                  </a>
                  ,{' '}
                  <a href={mineralMatch.source.url} target="_blank" rel="noreferrer">
                    {mineralMatch.source.label}
                  </a>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="rock__verdict">No percentage</p>
                <p className="traits__values">{mineralMatch.reason}</p>
              </>
            )}
          </div>

          {ice && (
            <div className="rock" data-testid="moon-ice">
              <h4>Water ice at {reference.name}</h4>
              <p className="rock__verdict">
                Ice could last on {ice.surface}% of the surface, and within {moonIce.shallowMetres} m of it on a further{' '}
                {ice.shallow}%
              </p>
              <p className="traits__values">
                No percentage: nowhere on Earth keeps ice the way permanently cold lunar ground does. This is a model
                driven by measured temperatures, not a detection of ice. On {ice.none}% of the area ice would not last
                in the top 2.9 m.{' '}
                <a href={moonIce.source.url} target="_blank" rel="noreferrer">
                  {moonIce.source.name}
                </a>
                .
              </p>
            </div>
          )}

          <p className="match__note">
            The overall figure is a plain average of the traits above that are specific to this place,
            and it leaves out rock family and minerals. Every percentage is how alike the places are, not
            the chance this is a true analog. Similar means 70% or more, and different means under 40%.
            Not compared yet: {NOT_YET_COMPARABLE}.
          </p>
        </div>
      )}

      <table>
        <caption className="visually-hidden">
          {site.name} compared with {reference.name}
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">{site.name}</th>
            <th scope="col">{reference.name}</th>
          </tr>
        </thead>
        <tbody>
          {matched &&
            TERRAIN_ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.read(matched)}</td>
                <td>{row.read(reference.metrics)}</td>
              </tr>
            ))}
          {siteSurface && referenceSurface ? (
            <tr>
              <th scope="row">Ground surface temperature</th>
              <td>{celsius(siteSurface.mean)}</td>
              <td>{celsius(referenceSurface.mean)}</td>
            </tr>
          ) : (
            siteTemperature && (
              <tr>
                <th scope="row">Mean temperature</th>
                <td>{siteTemperature}</td>
                <td>{world.meanTemperature}*</td>
              </tr>
            )
          )}
          <tr>
            <th scope="row">Gravity</th>
            <td>{planets.Earth.gravity}</td>
            <td>{world.gravity}</td>
          </tr>
          <tr>
            <th scope="row">Air pressure</th>
            <td>{planets.Earth.pressure}*</td>
            <td>{world.pressure}*</td>
          </tr>
        </tbody>
      </table>

      <p className="comparison__note">
        {reference.note} Both sides cover {measurements.windowKm} km and use a {grid} m grid, matched
        to {sources[reference.source].name}. *Planet-wide average.
        {siteSurface && referenceSurface && (
          <>
            {' '}
            Ground surface temperature is from{' '}
            <a href={referenceSource.url} target="_blank" rel="noreferrer">
              {referenceSource.name}
            </a>{' '}
            and{' '}
            <a href={surfaceSources.earth.url} target="_blank" rel="noreferrer">
              {surfaceSources.earth.name}
            </a>
            .{reference.world === 'Moon' && ' The Moon figure averages a whole lunar day, about 29.5 Earth days.'}
          </>
        )}
      </p>

      {charts && referenceBins && charts.slopeBins[String(grid)] && (
        <SlopeDistribution
          labels={charts.slopeLabels}
          site={charts.slopeBins[String(grid)]}
          reference={referenceBins}
          siteName={site.name}
          referenceName={reference.name}
        />
      )}
      {siteScales && referenceScales && (
        <RoughnessByScale
          site={siteScales}
          reference={referenceScales}
          siteName={site.name}
          referenceName={reference.name}
        />
      )}
      {scatter.length > 1 && <ReliefScatter points={scatter} grid={grid} />}
    </section>
  );
}

/** Every dataset behind this panel, with the credit its licence asks for. */
export function DataCredits({ site }: { site: AnalogSite }) {
  const { sites, sources, references, generatedOn } = measurements;
  const data = sites[site.id];
  if (!data) return null;
  const used = new Set(Object.values(data.sections).flat().map((row) => row.source));
  references.forEach((reference) => used.add(reference.source));
  used.add('factsheet');

  return (
    <ul className="credits" data-testid="data-sources">
      {[...used].map((id) => (
        <li key={id}>
          <a href={sources[id].url} target="_blank" rel="noreferrer">
            {sources[id].name}
          </a>
          <span>{sources[id].credit}</span>
        </li>
      ))}
      {geology.sources.map((source) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.name}
          </a>
          <span>{source.credit}</span>
        </li>
      ))}
      <li className="credits__date">Retrieved {generatedOn}.</li>
    </ul>
  );
}
