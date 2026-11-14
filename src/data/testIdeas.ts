import type { AnalogSite } from './analogSites';
import { measurements } from './siteMeasurements';

/**
 * What a mission team could rehearse at a place.
 *
 * These are suggestions worked out by rule from the place's landform and this app's measurements.
 * They are starting points for a field plan, not published test plans, and the panel says so.
 */

export interface TestIdea {
  /** What to test, as a short heading. */
  what: string;
  /** Why this place suits it, citing the landform or a measured figure. */
  why: string;
}

export interface TestPlan {
  ideas: TestIdea[];
  /** How long it takes to reach the place from a city, where measured. */
  access: string | null;
}

type Kind = 'crater' | 'tubes' | 'lava' | 'yardangs' | 'salt' | 'deflation' | 'ice' | 'dunes' | null;

function kindOf(site: AnalogSite): Kind {
  const feature = (site.feature ?? '').toLowerCase();
  if (feature.includes('impact')) return 'crater';
  if (feature.includes('tube')) return 'tubes';
  if (feature.includes('lava')) return 'lava';
  if (feature.includes('yardang')) return 'yardangs';
  if (/salt|evaporite|playa/.test(feature)) return 'salt';
  if (feature.includes('deflation')) return 'deflation';
  if (/periglacial|rock glacier/.test(feature)) return 'ice';
  if (feature) return null;

  // Places without a named landform: read it from the name and the terrain note.
  const text = `${site.name} ${site.research.terrain ?? ''}`.toLowerCase();
  if (/impact crater|impact structure/.test(text)) return 'crater';
  if (/lava tube/.test(text)) return 'tubes';
  if (/volcan|lava|basalt|cinder|scoria|harrat|shield/.test(text)) return 'lava';
  if (/dune|sand desert|sand sea/.test(text)) return 'dunes';
  if (/salt|playa|dried bed/.test(text)) return 'salt';
  return null;
}

function landformIdea(kind: Kind, target: AnalogSite['target']): TestIdea | null {
  switch (kind) {
    case 'crater':
      return {
        what: 'Crater field geology',
        why:
          target === 'Moon'
            ? 'A real impact structure to practise rim traverses and the sampling of shocked and melted rock, which crews will meet at lunar craters.'
            : 'A real impact structure to practise rim traverses and reading crater geology. Mars rovers work inside craters such as Jezero and Gale.',
      };
    case 'tubes':
      return {
        what: 'Cave entry, mapping and radio links',
        why: `Lava tubes let robots and crews rehearse entering a cave, mapping it and keeping contact underground. Pits that may open into such tubes are seen on the ${target}.`,
      };
    case 'lava':
      return {
        what: 'Driving and sampling on lava',
        why:
          target === 'Moon'
            ? 'Basalt flows and cones give wheels, suits and sampling tools the kind of rock that makes up the lunar maria.'
            : 'Basalt flows and cones give wheels and sampling tools the volcanic rock that covers much of Mars.',
      };
    case 'yardangs':
      return {
        what: 'Routes through wind-carved ridges',
        why: 'Yardangs test rover route planning between ridges and show how wind shapes rock. Wind is the most active force on the surface of Mars today.',
      };
    case 'salt':
      return {
        what: 'Salt detection and the search for life',
        why: 'Salt crusts let instruments practise identifying salts left by evaporating water and looking for traces of life in them. Mars has such deposits from its vanished lakes.',
      };
    case 'deflation':
      return {
        what: 'Dust lifting and dust tolerance',
        why: 'Wind strips fine sediment from this basin, so it suits studies of dust lifting and tests of how equipment copes with dust, a hazard on both worlds.',
      };
    case 'ice':
      return {
        what: 'Finding and drilling buried ice',
        why: 'Frozen ground lets teams test ground-penetrating radar and drills on ice hidden under dry soil, the resource sought at Martian mid-latitudes and the lunar poles.',
      };
    case 'dunes':
      return {
        what: 'Mobility in loose sand',
        why: 'Dune sand tests wheel sinkage and traction, a known hazard for Mars rovers.',
      };
    default:
      return null;
  }
}

/** Up to three things a team could test here, most specific first. */
export function testPlan(site: AnalogSite): TestPlan {
  const entry = measurements.sites[site.id];
  const ideas: TestIdea[] = [];
  const first = landformIdea(kindOf(site), site.target);
  if (first) ideas.push(first);
  if (!entry) return { ideas, access: null };

  const value = (section: 'dust' | 'water' | 'climate' | 'operations', label: string) =>
    entry.sections[section].find((row) => row.label === label)?.value ?? '';
  const number = (text: string) => Number.parseFloat(text.replace(/,/g, '').replace('−', '-'));
  const flat = number(value('operations', 'Ground under 5° slope'));
  const bare = number(value('dust', 'Bare or sparse ground'));
  const rain = number(value('water', 'Precipitation'));
  const coldest = number(value('climate', 'Coldest month, daily low'));

  if (Number.isFinite(flat) && flat >= 70) {
    ideas.push({
      what: 'Landing and navigation rehearsals',
      why: `${flat.toFixed(0)}% of the ground within 51 km slopes less than 5°, the gentle ground landers and long rover drives need.`,
    });
  } else if (Number.isFinite(flat) && flat < 35) {
    ideas.push({
      what: 'Steep-terrain mobility',
      why: `Only ${flat.toFixed(0)}% of the ground within 51 km slopes less than 5°, so it suits tests of climbing, descending and route planning on slopes.`,
    });
  }
  if (Number.isFinite(rain) && Number.isFinite(bare) && rain < 150 && bare >= 60) {
    ideas.push({
      what: 'Long equipment trials in dry, dusty ground',
      why: `About ${rain.toFixed(0)} mm of rain and snow a year and ${bare.toFixed(0)}% bare ground mean hardware can run for months with little rain, plant cover or mud.`,
    });
  }
  if (Number.isFinite(coldest) && coldest <= -20) {
    ideas.push({
      what: 'Cold-weather operations',
      why: `Nights in the coldest month average ${String(Math.round(coldest)).replace('-', '−')} °C. That is far milder than the ${site.target}, but cold enough to stress batteries, seals and crews.`,
    });
  }

  const travel = value('operations', 'Travel to a city of 50,000+');
  return { ideas: ideas.slice(0, 3), access: travel || null };
}
