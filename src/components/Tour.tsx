import type { AnalogSite } from '../data/analogSites';
import { analogProfile } from '../data/analogTraits';
import controls from '../data/control-sites.json';
import { measurements } from '../data/siteMeasurements';

/**
 * The guided tour: a short story told by moving the map.
 *
 * Every figure in the text is read from the same data the rest of the app shows, so the story
 * can't drift from the numbers. A sentence whose data is missing is left out.
 */

export interface TourStop {
  title: string;
  text: string;
  /** The place the map flies to, or null for the whole-Earth view. */
  siteId: string | null;
  /** Show only the new candidates on the map for this stop. */
  newOnly?: boolean;
}

const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

export function buildTour(sites: readonly AnalogSite[]): TourStop[] {
  const reference = (id: string) => measurements.references.find((candidate) => candidate.id === id);
  const candidates = sites.filter((site) => site.status === 'candidate');
  const countries = new Set(candidates.map((site) => site.country).filter(Boolean)).size;
  const stops: TourStop[] = [];

  stops.push({
    title: 'Rehearsing on Earth',
    text:
      'Before anyone builds a base on the Moon or lands on Mars, the equipment and the crews are tested on Earth, ' +
      'in places that resemble where they are going. Those places are called analogs.',
    siteId: null,
  });

  if (sites.some((site) => site.id === 'haughton')) {
    stops.push({
      title: 'The known rehearsal grounds',
      text:
        'Haughton Crater in Arctic Canada has hosted a NASA-supported Mars project since 1997. Sites like it are ' +
        'well studied. The challenge asks what else is out there.',
      siteId: 'haughton',
    });
  }

  stops.push({
    title: 'Screening the whole Earth',
    text:
      'We screened open data on climate, remoteness, volcanoes and landforms for places with no published analog ' +
      `study, then measured each one with NASA and ESA data. The yellow markers are the ${candidates.length} we ` +
      `found, in ${countries} countries. None has been tested in the field yet.`,
    siteId: null,
    newOnly: true,
  });

  const jezero = reference('jezero');
  if (jezero) {
    const best = candidates
      .filter((site) => site.target === 'Mars')
      .flatMap((site) => {
        const profile = analogProfile(site.id, jezero);
        return profile ? [{ site, profile }] : [];
      })
      .sort((a, b) => b.profile.overall.percent - a.profile.overall.percent)[0];
    if (best) {
      const { site, profile } = best;
      stops.push({
        title: 'A new candidate for Mars',
        text:
          `${site.name}, ${site.place}. Measured against Jezero Crater, where the Perseverance rover landed, it ` +
          `scores ${profile.overall.percent}% overall, the highest of the new Mars candidates. It is closest in ` +
          `${profile.closest.label.toLowerCase()} (${profile.closest.percent}%) and least alike in ` +
          `${profile.leastAlike.label.toLowerCase()} (${profile.leastAlike.percent}%).`,
        siteId: site.id,
      });
    }
  }

  const suswa = sites.find((site) => site.id === 'mount-suswa-lava-caves');
  const suswaData = suswa ? measurements.sites[suswa.id] : undefined;
  if (suswa && suswaData) {
    const rain = suswaData.sections.water.find((row) => row.label === 'Precipitation')?.value;
    const apollo = reference('apollo-11');
    const profile = apollo ? analogProfile(suswa.id, apollo) : null;
    stops.push({
      title: 'A match in one thing only',
      text:
        `Mount Suswa in Kenya is covered in vegetation${rain ? ` and gets ${rain.replace(' per year', '')} of rain a year` : ''}, nothing like the Moon` +
        `${profile && apollo ? `: against the ${apollo.name} it scores only ${profile.overall.percent}%` : ''}. ` +
        'But it has lava tube caves, like the pits seen on the Moon. An analog does not have to match everything. ' +
        'It has to match what you want to test.',
      siteId: suswa.id,
    });
  }

  const check = (id: string) => {
    const base = reference(id);
    if (!base) return null;
    const score = (siteId: string) => analogProfile(siteId, base)?.overall.percent;
    const known = sites
      .filter((site) => site.status === 'studied' && site.target === base.world)
      .flatMap((site) => score(site.id) ?? []);
    const control = controls.flatMap((place) => score(place.id) ?? []);
    return known.length > 0 && control.length > 0 ? { name: base.name, known: mean(known), control: mean(control) } : null;
  };
  const strong = check('jezero');
  const weak = check('arcadia');
  if (strong) {
    stops.push({
      title: 'Checking ourselves',
      text:
        `To test the scoring we also measured ${controls.length} places chosen to be unlike the Moon and Mars: ` +
        `rainforest, farmland and wetland. Against ${strong.name}, known Mars analogs average ${strong.known}% and ` +
        `these controls ${strong.control}%.` +
        (weak && weak.known <= weak.control + 3
          ? ` Against ${weak.name} the two groups score ${weak.known}% and ${weak.control}%, so there the method ` +
            'cannot yet tell them apart, and the app says so.'
          : ''),
      siteId: null,
    });
  }

  stops.push({
    title: 'What Earth cannot do',
    text:
      "No place on Earth has the Moon's vacuum, one-sixth gravity or radiation, or the thin air of Mars. Every " +
      'percentage here says how alike two places are in what we could measure. It is not proof that a place is a ' +
      'good analog.',
    siteId: null,
  });

  stops.push({
    title: 'Your turn',
    text:
      'Open any place to see its data and what could be tested there, fly a drone over its real terrain, rank ' +
      'every place against a base, or look up the candidates in your own country.',
    siteId: null,
  });

  return stops;
}

interface TourProps {
  stops: TourStop[];
  index: number;
  onIndex: (index: number) => void;
  onEnd: () => void;
}

/** The caption card for the current stop, with the controls to move through the story. */
export function Tour({ stops, index, onIndex, onEnd }: TourProps) {
  const stop = stops[index];
  const last = index === stops.length - 1;
  if (!stop) return null;
  return (
    <section className="tour" aria-label="Guided tour" data-testid="tour">
      <p className="tour__step">
        <span>Guided tour</span>
        <span>
          {index + 1} of {stops.length}
        </span>
      </p>
      <div aria-live="polite">
        <h2>{stop.title}</h2>
        <p>{stop.text}</p>
      </div>
      <div className="tour__actions">
        <button type="button" data-testid="tour-end" onClick={onEnd}>
          End tour
        </button>
        <button type="button" data-testid="tour-back" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          Back
        </button>
        <button type="button" className="tour__next" data-testid="tour-next" onClick={() => (last ? onEnd() : onIndex(index + 1))}>
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </section>
  );
}
