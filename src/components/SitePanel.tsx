import { useMemo } from 'react';
import type { AnalogSite } from '../data/analogSites';
import { similarPlaces } from '../data/similarPlaces';
import { testPlan } from '../data/testIdeas';
import { Comparison, DataCredits, Measurements, SiteConditions } from './SiteData';

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`;
}

export type DroneStatus = 'idle' | 'loading' | 'failed';

interface SitePanelProps {
  site: AnalogSite | null;
  open: boolean;
  droneAvailable: boolean;
  droneStatus: DroneStatus;
  onEnterDrone: () => void;
  /** Every place, for the search for similar ones. */
  sites: readonly AnalogSite[];
  onSelect: (site: AnalogSite) => void;
}

export function SitePanel({ site, open, droneAvailable, droneStatus, onEnterDrone, sites, onSelect }: SitePanelProps) {
  const alike = useMemo(() => (site ? similarPlaces(site.id, sites) : []), [site, sites]);
  const plan = useMemo(() => (site ? testPlan(site) : null), [site]);
  if (!site) return <aside className="site-panel" data-open="false" aria-hidden="true" />;

  const { terrain, analogRationale, evidence, sources } = site.research;

  return (
    <aside
      className="site-panel"
      data-open={open}
      aria-labelledby="site-panel-title"
      data-testid="site-panel"
      inert={!open}
    >
      <div className="site-panel__meta" data-status={site.status}>
        <span>{site.status === 'studied' ? 'Studied analog, for reference' : 'New candidate analog'}</span>
        <span className="target-tag">{site.target} analog</span>
      </div>
      <h2 id="site-panel-title" className="site-panel__title">
        {site.name}
      </h2>
      <p className="site-panel__place">
        {site.place}
        <br />
        {formatCoordinate(site.lat, 'N', 'S')}, {formatCoordinate(site.lng, 'E', 'W')}
        <br />
        {site.status === 'studied'
          ? 'Used in published analog research. The numbers below are measured by this app for the 51 km around this point.'
          : site.feature
            ? `No published analog study found in our search. It was picked for its landform (${site.feature.toLowerCase()}) and hasn't been tested in the field. The numbers below describe the 51 km around this point.`
            : "No published analog study found in our search. It was picked by screening climate, remoteness and volcano data, and hasn't been tested in the field."}
      </p>

      {site.droneScene && droneAvailable && (
        <div className="drone-entry">
          <button
            type="button"
            className="drone-entry__button"
            data-testid="enter-drone"
            disabled={droneStatus === 'loading'}
            onClick={onEnterDrone}
          >
            {droneStatus === 'loading' ? 'Loading terrain' : 'Enter drone view'}
          </button>
          {droneStatus === 'failed' && (
            <p className="drone-entry__error" role="alert">
              The terrain didn't load, so you're still on the map. Select Enter drone view to try
              again.
            </p>
          )}
        </div>
      )}

      <section className="evidence">
        <h3>{site.status === 'studied' ? 'Why it is an analog' : 'Why it might be an analog'}</h3>
        <p>{analogRationale}</p>
      </section>
      {evidence && evidence.length > 0 && (
        <section className="evidence" data-testid="site-evidence">
          <h3>Evidence</h3>
          <ul className="evidence-list">
            {evidence.map((item) => (
              <li key={item.text}>
                {item.text}{' '}
                <a href={item.source.url} target="_blank" rel="noreferrer">
                  {item.source.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan && plan.ideas.length > 0 && (
        <section className="evidence" data-testid="test-ideas">
          <h3>What you could test here</h3>
          <ul className="evidence-list test-ideas">
            {plan.ideas.map((idea) => (
              <li key={idea.what}>
                <strong>{idea.what}.</strong> {idea.why}
              </li>
            ))}
          </ul>
          <p className="panel-note">
            {plan.access && <>Travel to the nearest city of 50,000 or more: {plan.access}. </>}
            Suggested by this app from the landform and the measurements below, as a starting point. It is not a
            published test plan.
          </p>
        </section>
      )}
      <SiteConditions site={site} />
      <Comparison key={site.id} site={site} />
      {alike.length > 0 && (
        <section className="evidence" data-testid="similar-places">
          <h3>Places like this one</h3>
          <p className="panel-note">
            The {alike.length} places on Earth most like {site.name}, found by comparing measured terrain, bare ground,
            rain, ground temperature and rock family across all {sites.length}. A high figure means two places are
            physically alike, not that they share a history.
          </p>
          <ul className="similar-list">
            {alike.map((match) => (
              <li key={match.site.id}>
                <button type="button" className="place-row similar-row" data-status={match.site.status} data-testid={`similar-${match.site.id}`} onClick={() => onSelect(match.site)}>
                  <span className="similar-row__text">
                    <strong>
                      {match.site.name}
                      {match.site.status === 'candidate' && <span className="new-tag">New</span>}
                    </strong>
                    <em>
                      {match.site.place}. Closest in {match.closest.map((trait) => trait.label).join(' and ')}
                    </em>
                  </span>
                  <span className="rank-row__score">{match.percent}%</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {terrain !== null && (
        <section className="evidence">
          <h3>Terrain notes</h3>
          <p>{terrain}</p>
        </section>
      )}
      <Measurements site={site} />
      <section className="evidence">
        <h3>Sources</h3>
        {sources.length > 0 && (
          <ul>
            {sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        )}
        <DataCredits site={site} />
      </section>
    </aside>
  );
}
