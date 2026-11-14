import { useMemo, useState } from 'react';
import type { AnalogSite } from '../data/analogSites';
import { analogProfile } from '../data/analogTraits';
import controls from '../data/control-sites.json';
import { measurements } from '../data/siteMeasurements';

interface RankingProps {
  sites: readonly AnalogSite[];
  activeSiteId: string | null;
  newOnly: boolean;
  onSelect: (site: AnalogSite) => void;
}

/** Every place ranked by its overall match with one Moon or Mars base. */
export function Ranking({ sites, activeSiteId, newOnly, onSelect }: RankingProps) {
  const { references } = measurements;
  const [referenceId, setReferenceId] = useState(references[0]?.id);
  const reference = references.find((candidate) => candidate.id === referenceId);

  const ranked = useMemo(() => {
    if (!reference) return [];
    return sites
      .filter((site) => !newOnly || site.status === 'candidate')
      .flatMap((site) => {
        const profile = analogProfile(site.id, reference);
        return profile ? [{ site, profile }] : [];
      })
      .sort((a, b) => b.profile.overall.percent - a.profile.overall.percent);
  }, [sites, reference, newOnly]);

  // Places picked because they are plainly unlike the Moon or Mars. If the scoring works, they rank low.
  const controlRows = useMemo(() => {
    if (!reference) return [];
    return controls.flatMap((control) => {
      const profile = analogProfile(control.id, reference);
      return profile ? [{ control, percent: profile.overall.percent }] : [];
    });
  }, [reference]);

  if (!reference) return null;

  const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const known = ranked.filter(({ site }) => site.status === 'studied' && site.target === reference.world);
  const beaten = ranked.filter(({ profile }) => controlRows.every((row) => profile.overall.percent > row.percent)).length;

  return (
    <div className="ranking" data-testid="ranking">
      <label className="ranking__picker">
        <span>Rank against</span>
        <select value={reference.id} data-testid="ranking-base" onChange={(event) => setReferenceId(event.target.value)}>
          {(['Moon', 'Mars'] as const).map((world) => (
            <optgroup key={world} label={world}>
              {references
                .filter((candidate) => candidate.world === world)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="sidebar__summary">
        Overall match is the average of each place's measured traits against {reference.name}. It shows how alike the
        places are, not the chance a place is a true analog, and gaps of a few points mean little.
      </p>
      {controlRows.length > 0 && known.length > 0 && (
        <div className="method-check" data-testid="method-check">
          <h3 className="section-bar">Method check</h3>
          <p>
            Known {reference.world} analogs average <strong>{mean(known.map(({ profile }) => profile.overall.percent))}%</strong>{' '}
            against {reference.name}. {controlRows.length} control places chosen to be unlike it (rainforest, farmland,
            wetland) average <strong>{mean(controlRows.map((row) => row.percent))}%</strong>. {beaten} of {ranked.length}{' '}
            places listed here score above every control.
          </p>
          <ul>
            {[...controlRows]
              .sort((a, b) => b.percent - a.percent)
              .map(({ control, percent }) => (
                <li key={control.id}>
                  <span>
                    {control.name} <em>{control.kind.toLowerCase()}</em>
                  </span>
                  <span>{percent}%</span>
                </li>
              ))}
          </ul>
        </div>
      )}
      <ol>
        {ranked.map(({ site, profile }, index) => (
          <li key={site.id}>
            <button
              type="button"
              className="place-row rank-row"
              data-status={site.status}
              data-active={activeSiteId === site.id}
              data-testid={`rank-${site.id}`}
              onClick={() => onSelect(site)}
            >
              <span className="rank-row__place">{index + 1}</span>
              <span className="rank-row__text">
                <strong>
                  {site.name}
                  {site.status === 'candidate' && <span className="new-tag">New</span>}
                </strong>
                <em>
                  Closest: {profile.closest.label.toLowerCase()}, {profile.closest.percent}%
                </em>
                <span className="rank-row__track" aria-hidden="true">
                  <span style={{ width: `${profile.overall.percent}%` }} />
                </span>
              </span>
              <span className="rank-row__score">{profile.overall.percent}%</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
