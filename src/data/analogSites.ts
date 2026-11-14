import screenedSites from './candidate-sites.json';
import landformSites from './candidate-sites-evidence.json';
import { measurements } from './siteMeasurements';

/**
 * Every site shown in the app comes from this file.
 *
 * `studied` places have published analog work, cited in `sources`. `candidate` places were proposed
 * by tools/find_candidates.py from climate, remoteness and volcano data, and a literature search
 * found no published analog study of them. That is a statement about the search, not proof that
 * nobody has ever looked, and none of the candidates has been tested in the field.
 *
 * To add a site, also add it to tools/drone-sites.json and tools/detail-sites.json and re-run the
 * pipeline described in the README.
 */

export type PlanetaryTarget = 'Moon' | 'Mars';
export type SiteStatus = 'studied' | 'candidate';

export const CONTINENTS = ['North America', 'South America', 'Europe', 'Africa', 'Asia', 'Oceania'] as const;
export type Continent = (typeof CONTINENTS)[number];

export interface LocalCamera {
  zoom: number;
  pitch: number;
  bearing: number;
  /** How far the view can pan from its starting point, in degrees of longitude. */
  panDegrees: number;
}

export interface SourceReference {
  label: string;
  url: string;
}

export interface EvidenceItem {
  text: string;
  source: SourceReference;
}

export interface SiteResearch {
  terrain: string | null;
  analogRationale: string;
  /** Facts about how the place formed that bear on the comparison, each with where it comes from. */
  evidence?: EvidenceItem[];
  sources: SourceReference[];
}

export interface AnalogSite {
  id: string;
  name: string;
  /** Where it is, in plain words. */
  place: string;
  /** The world it is compared with. */
  target: PlanetaryTarget;
  status: SiteStatus;
  continent: Continent;
  /** ISO 3166-1 two-letter code of the country or territory the point is in. */
  country: string;
  region: string;
  lng: number;
  lat: number;
  localCamera: LocalCamera;
  /** The kind of landform, where the site was chosen for one: "Impact crater", "Lava tubes". */
  feature?: string;
  /** The Moon or Mars place this site is published as an analog of, if there is a specific one. */
  pairedBase?: string;
  /** Folder under public/terrain built by tools/build_drone_terrain.py, or null for no drone view. */
  droneScene: string | null;
  research: SiteResearch;
}

/** The opening direction of a site view. Its zoom is set for every site at the end of this file. */
const camera = (bearing: number): LocalCamera => ({ zoom: 0, pitch: 70, bearing, panDegrees: 3.5 });

const MEASURED_SQUARE_M = 51_000;
const SQUARE_WIDTH_PX = 560; // how wide the measured square opens on screen, at its middle
const ZOOM_0_METRES_PER_PX = 78_271.5; // at the equator, for this map's 512 px tiles

/**
 * The zoom at which the measured 51 km square opens at the same size for every site. The map shows
 * less ground per pixel towards the poles, so the zoom has to fall with latitude.
 */
const framedZoom = (lat: number) =>
  Math.log2((ZOOM_0_METRES_PER_PX * Math.cos((lat * Math.PI) / 180)) / (MEASURED_SQUARE_M / SQUARE_WIDTH_PX));

/** The Smithsonian's page for one volcano, by its Global Volcanism Program number. */
const GVP = (name: string, volcanoNumber: number): SourceReference => ({
  label: `${name}, Smithsonian Global Volcanism Program`,
  url: `https://volcano.si.edu/volcano.cfm?vn=${volcanoNumber}`,
});

/** Countries of the hand-written places below. */
const CURATED_COUNTRY: Record<string, string> = {
  haughton: 'CA', 'cinder-lake': 'US', 'san-borja': 'MX', yungay: 'CL', nazca: 'PE', 'payun-matru': 'AR', askja: 'IS',
  'rio-tinto': 'ES', calatrava: 'ES', 'nw-libya': 'LY', 'tarso-toh': 'TD', bayuda: 'SD', 'lake-salda': 'TR', hisma: 'SA',
  'gobi-altai': 'MN', 'taryatu-chulutu': 'MN', 'mauna-kea': 'US', nullarbor: 'AU', mcbride: 'AU',
};

/** The data files carry three-letter codes; the browser's country names need two-letter ones. */
const TWO_LETTER: Record<string, string> = {
  ARG: 'AR', AUS: 'AU', CAN: 'CA', CHN: 'CN', DZA: 'DZ', EGY: 'EG', ESP: 'ES', GRL: 'GL', IRN: 'IR', JOR: 'JO',
  KAZ: 'KZ', KEN: 'KE', KGZ: 'KG', LBY: 'LY', MEX: 'MX', MNG: 'MN', MRT: 'MR', NER: 'NE', NOR: 'NO', PER: 'PE',
  RUS: 'RU', SAU: 'SA', SDN: 'SD', TCD: 'TD', TJK: 'TJ', TKM: 'TM', TUR: 'TR', USA: 'US', UZB: 'UZ',
};

const curatedSites: readonly Omit<AnalogSite, 'country'>[] = [
  {
    id: 'haughton',
    name: 'Haughton Crater',
    place: 'Devon Island, Nunavut, Canada',
    target: 'Mars',
    status: 'studied',
    continent: 'North America',
    region: 'Arctic Canada',
    lng: -89.867,
    lat: 75.433,
    localCamera: camera(20),
    droneScene: 'haughton',
    research: {
      terrain: 'A 20 km impact crater about 23 million years old, in polar desert. Marker is the research station on the northwest rim.',
      analogRationale:
        'Site of the NASA-supported Haughton-Mars Project since 1997. Its ice-rich ground, old lake sediments and small valley networks resemble features on Mars. It is far milder than Mars: about -17 °C on average, against about -60 °C.',
      sources: [
        { label: 'Haughton-Mars Project Research Station, Mars Institute', url: 'https://www.marsinstitute.no/hmp' },
        { label: 'NASA/JPL Photojournal: Haughton Crater', url: 'https://photojournal.jpl.nasa.gov/catalog/PIA03714' },
      ],
    },
  },
  {
    id: 'cinder-lake',
    name: 'Cinder Lake',
    place: 'Near Flagstaff, Arizona, USA',
    target: 'Moon',
    status: 'studied',
    continent: 'North America',
    region: 'Southwest United States',
    lng: -111.5,
    lat: 35.31,
    localCamera: camera(330),
    droneScene: 'cinder-lake',
    research: {
      terrain: 'Basaltic cinders south of Sunset Crater. Marker position is approximate.',
      analogRationale:
        'The USGS blasted artificial crater fields here in the 1960s to train Apollo crews and test equipment, including the crews of Apollo 12 and 15.',
      sources: [
        { label: 'The USGS in Space Exploration, Mission Operations, and Training', url: 'https://usgs.gov/science/science-explorer/planetary-science/usgs-in-space' },
        { label: 'USGS Open-File Report 1967-7', url: 'https://pubs.usgs.gov/of/1967/0007/report.pdf' },
      ],
    },
  },
  {
    id: 'san-borja',
    name: 'San Borja',
    place: 'Baja California, Mexico',
    target: 'Moon',
    status: 'candidate',
    continent: 'North America',
    region: 'Baja California',
    lng: -113.75,
    lat: 28.5,
    localCamera: camera(40),
    droneScene: 'san-borja',
    research: {
      terrain: 'A plateau of lava flows and scoria cones covering over 1,600 km², with at least 227 eruption centres.',
      analogRationale: 'Proposed because it is a young volcanic field, of basaltic andesite and andesite lavas, in a very dry, remote setting. It has not been tested as an analog.',
      sources: [
        GVP('San Borja', 341007),
        { label: 'Wikipedia: San Borja volcanic field (area and number of centres)', url: 'https://en.wikipedia.org/wiki/San_Borja_volcanic_field' },
      ],
    },
  },
  {
    id: 'yungay',
    name: 'Yungay',
    place: 'Atacama Desert, Chile',
    target: 'Mars',
    status: 'studied',
    continent: 'South America',
    region: 'Atacama Desert',
    lng: -69.9,
    lat: -24.0,
    localCamera: camera(340),
    droneScene: 'yungay',
    research: {
      terrain: 'The hyperarid core of the Atacama, at about 1,000 m.',
      analogRationale:
        'Navarro-González and colleagues reported "Mars-like" soils here in 2003, with very low organics and almost no detectable bacteria. It is among the driest places on Earth.',
      sources: [
        { label: 'Mars-like soils in the driest core of the Atacama, Lunar and Planetary Institute', url: 'https://www.lpi.usra.edu/meetings/analogues2011/pdf/6005.pdf' },
        { label: 'Review: the Atacama as a Mars analog, Frontiers in Microbiology', url: 'https://www.frontiersin.org/articles/10.3389/fmicb.2017.00993/full' },
      ],
    },
  },
  {
    id: 'nazca',
    name: 'Nazca Desert',
    place: 'Ica region, Peru',
    target: 'Mars',
    status: 'candidate',
    continent: 'South America',
    region: 'Peruvian Coast',
    lng: -74.88,
    lat: -14.94,
    localCamera: camera(20),
    droneScene: 'nazca',
    research: {
      terrain: null,
      analogRationale:
        'Proposed because it falls in the driest rainfall class and is far from large cities, though the town of Nazca is nearby. A search found Mars analog work further south, at Pampas de La Joya, but none for this location.',
      sources: [{ label: 'Conference paper on the Pampas de La Joya Desert', url: 'https://sciforum.net/paper/5371' }],
    },
  },
  {
    id: 'payun-matru',
    name: 'Payún Matrú',
    place: 'Mendoza, Argentina',
    target: 'Mars',
    status: 'studied',
    continent: 'South America',
    region: 'Southern Andes',
    lng: -69.241,
    lat: -36.422,
    localCamera: camera(300),
    droneScene: 'payun-matru',
    research: {
      terrain: 'A volcano with an 8 km summit caldera, and about 200 scoria cones with long basaltic lava flows.',
      analogRationale:
        'A 2007 study proposed its long pahoehoe flows as an analog for lava flows on Mars. Single basaltic flows over 100 km long are rare on Earth but common on Mars. This is a comparison of lava flow forms, not a mission test site.',
      sources: [
        { label: 'Payún Matrú lava flows as a Mars analog, EPSC 2007', url: 'https://meetings.copernicus.org/www.cosis.net/abstracts/EPSC2007/00340/EPSC2007-J-00340.pdf' },
        { label: 'NASA Earth Observatory: Payún Matrú Volcanic Field', url: 'https://science.nasa.gov/earth/earth-observatory/payaon-matru-volcanic-field-argentina-77039' },
      ],
    },
  },
  {
    id: 'askja',
    name: 'Askja',
    place: 'Icelandic Highlands',
    target: 'Moon',
    status: 'studied',
    continent: 'Europe',
    region: 'Iceland',
    lng: -16.75,
    lat: 65.03,
    localCamera: camera(150),
    droneScene: 'askja',
    research: {
      terrain: 'A volcanic caldera in the barren highlands, with lava flows and pumice from the 1875 eruption.',
      analogRationale: 'Apollo astronauts did geology training around Askja in 1965 and 1967, because the bare volcanic terrain was considered among the most Moon-like available.',
      sources: [
        { label: 'Apollo program training', url: 'https://en.wikipedia.org/wiki/Apollo_program_training' },
        { label: 'Astronaut training in Iceland, The Exploration Museum', url: 'https://www.explorationmuseum.com/astronaut-training/' },
      ],
    },
  },
  {
    id: 'rio-tinto',
    name: 'Río Tinto',
    place: 'Huelva, Spain',
    target: 'Mars',
    status: 'studied',
    continent: 'Europe',
    region: 'Iberia',
    lng: -6.55,
    lat: 37.71,
    localCamera: camera(60),
    droneScene: 'rio-tinto',
    research: {
      terrain: 'An acidic river with a mean pH of about 2.3, rising in an old mining district. Marker position is approximate.',
      analogRationale:
        'A chemical analog of Meridiani Planum on Mars: its acidic waters deposit hematite, goethite and jarosite. NASA and the Centro de Astrobiología drilled here for the MARTE project from 2003 to 2006.',
      sources: [
        { label: 'Río Tinto: a geochemical and mineralogical terrestrial analogue of Mars, Life (2014)', url: 'https://doi.org/10.3390/life4030511' },
        { label: 'MARTE drilling, NASA Technical Reports', url: 'https://ntrs.nasa.gov/citations/20050185076' },
      ],
    },
  },
  {
    id: 'calatrava',
    name: 'Campo de Calatrava',
    place: 'Ciudad Real, Spain',
    target: 'Mars',
    status: 'studied',
    continent: 'Europe',
    region: 'Iberia',
    lng: -4.02,
    lat: 38.87,
    localCamera: camera(200),
    droneScene: 'calatrava',
    research: {
      terrain: 'More than 300 pyroclastic cones, domes and maars across over 5,000 km².',
      analogRationale: 'Used for Mars instrument testing: a sensor model for the REMS weather station on Curiosity was field-tested at a volcanic quarry here in 2010. It is an instrument test site more than a landscape analog.',
      sources: [{ label: 'REMS ground temperature sensor test at Campos de Calatrava, CAB (INTA-CSIC)', url: 'https://cab.inta-csic.es/rems/campos-de-calatrava-spain-a-model-of-gts-sensor-is-tested-in-a-volcanic-ground-la-yezosa' }],
    },
  },
  {
    id: 'nw-libya',
    name: 'Nalut District',
    place: 'Northwest Libya',
    target: 'Mars',
    status: 'candidate',
    continent: 'Africa',
    region: 'Northwest Libya',
    lng: 11.6,
    lat: 31.05,
    localCamera: camera(80),
    droneScene: 'nw-libya',
    research: {
      terrain: null,
      analogRationale: "Proposed because it falls in the driest rainfall class and is more than a day from a city in the screening layer. A search found no analog study of this location.",
      sources: [],
    },
  },
  {
    id: 'tarso-toh',
    name: 'Tarso Toh',
    place: 'Tibesti, Chad',
    target: 'Moon',
    status: 'candidate',
    continent: 'Africa',
    region: 'Tibesti',
    lng: 16.33,
    lat: 21.33,
    localCamera: camera(15),
    droneScene: 'tarso-toh',
    research: {
      terrain: 'A volcanic field of about 150 scoria cones and two maars.',
      analogRationale: 'Proposed because it is a young volcanic field in very dry, remote desert. Field access has been limited since the 1970s, and a search found no analog study of it.',
      sources: [GVP('Tarso Toh', 225009)],
    },
  },
  {
    id: 'bayuda',
    name: 'Bayuda',
    place: 'Bayuda Desert, Sudan',
    target: 'Moon',
    status: 'candidate',
    continent: 'Africa',
    region: 'Bayuda Desert',
    lng: 32.75,
    lat: 18.33,
    localCamera: camera(310),
    droneScene: 'bayuda',
    research: {
      terrain: 'A small field of at least 53 cinder cones and 15 maars, across about 480 km².',
      analogRationale: 'Proposed because it is a compact volcanic field in very dry desert. A search found studies of its geology, but none treating it as an analog.',
      sources: [
        { label: 'The monogenetic Bayuda Volcanic Field, Journal of Volcanology and Geothermal Research (2018)', url: 'https://ui.adsabs.harvard.edu/abs/2018JVGR..356..211L' },
      ],
    },
  },
  {
    id: 'lake-salda',
    name: 'Lake Salda',
    place: 'Burdur, Türkiye',
    target: 'Mars',
    status: 'studied',
    continent: 'Asia',
    region: 'Anatolia',
    lng: 29.68,
    lat: 37.55,
    localCamera: camera(130),
    droneScene: 'lake-salda',
    pairedBase: 'jezero',
    research: {
      terrain: 'A lake with white hydromagnesite shores and a delta, below steep bedrock slopes.',
      analogRationale: 'Studied in 2019 by a team including a Perseverance scientist as an analog for Jezero Crater. NASA describes it as the only known lake on Earth with carbonates and deltas similar to those at Jezero.',
      sources: [{ label: 'What a Lake in Turkey Can Tell Us About Mars, NASA Earth Observatory', url: 'https://earthobservatory.nasa.gov/blogs/earthmatters/2021/02/17/what-a-lake-in-turkey-can-tell-us-about-mars/' }],
    },
  },
  {
    id: 'hisma',
    name: 'Tabuk Desert',
    place: 'Tabuk Province, Saudi Arabia',
    target: 'Mars',
    status: 'candidate',
    continent: 'Asia',
    region: 'Arabia',
    lng: 36.91,
    lat: 29.23,
    localCamera: camera(250),
    droneScene: 'hisma',
    research: {
      terrain: null,
      analogRationale: 'Proposed because it falls in the driest rainfall class and is more than a day from a city in the screening layer, though the city of Tabuk is about 100 km away. A 2026 review points to Saudi deserts generally as possible Mars analogs, but a search found nothing for this location.',
      sources: [
        {
          label: 'Extreme Arabian environments and their microbiomes, Extremophiles (2026), summary on Astrobiology.com',
          url: 'https://astrobiology.com/2026/04/13/extreme-arabian-environments-and-their-microbiomes-new-frontiers-for-astrobiology-and-biosignature-discovery/',
        },
      ],
    },
  },
  {
    id: 'gobi-altai',
    name: 'Gobi Altai',
    place: 'Bayankhongor, Mongolia',
    target: 'Mars',
    status: 'studied',
    continent: 'Asia',
    region: 'Mongolia',
    lng: 100.2,
    lat: 44.34,
    localCamera: camera(170),
    droneScene: 'gobi-altai',
    research: {
      terrain: null,
      analogRationale: 'A 2007 conference study did Mars analog field work in Mongolian terrain including the Gobi Altai and Bayankhongor. This point came from our own screen, so the study did not necessarily work at this exact spot.',
      sources: [{ label: 'Mongolian terrains as Mars analogs, EPSC 2007', url: 'https://meetings.copernicus.org/www.cosis.net/abstracts/EPSC2007/00260/EPSC2007-J-00260.pdf' }],
    },
  },
  {
    id: 'taryatu-chulutu',
    name: 'Taryatu-Chulutu',
    place: 'Khangai Mountains, Mongolia',
    target: 'Moon',
    status: 'candidate',
    continent: 'Asia',
    region: 'Mongolia',
    lng: 99.95,
    lat: 48.133,
    localCamera: camera(100),
    droneScene: 'taryatu-chulutu',
    research: {
      terrain: 'Cinder cones and lava flows, including the Horgo flow that dammed Lake Terkhin-Tsagan-Nur.',
      analogRationale: 'Proposed because it is a young volcanic field in a cold, dry, remote setting. A search found no analog study of it.',
      sources: [GVP('Taryatu-Chulutu', 303010)],
    },
  },
  {
    id: 'mauna-kea',
    name: 'Mauna Kea',
    place: 'Island of Hawaiʻi, USA',
    target: 'Moon',
    status: 'studied',
    continent: 'Oceania',
    region: 'Hawaii',
    lng: -155.4707,
    lat: 19.7609,
    localCamera: camera(290),
    droneScene: 'mauna-kea',
    research: {
      terrain: 'Marker is Puʻu Hiwahine, a cinder cone at about 2,800 m below the summit, in tephra that reasonably simulates lunar regolith.',
      analogRationale: 'Used for lunar resource-extraction field tests with NASA, the Canadian Space Agency and others, including the 2008 and 2010 campaigns run through PISCES.',
      sources: [
        { label: 'Mauna Kea as an analogue site for planetary resource exploration, NASA', url: 'https://ntrs.nasa.gov/api/citations/20110008363/downloads/20110008363.pdf' },
        { label: 'The 2010 ILSO-ISRU field test at Mauna Kea, LPSC 2011', url: 'https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2810.pdf' },
      ],
    },
  },
  {
    id: 'nullarbor',
    name: 'Nullarbor Plain',
    place: 'Western Australia',
    target: 'Mars',
    status: 'studied',
    continent: 'Oceania',
    region: 'Southern Australia',
    lng: 127.62,
    lat: -31.05,
    localCamera: camera(45),
    droneScene: 'nullarbor',
    research: {
      terrain: null,
      analogRationale: 'Treated as a Mars analogue in a study of meteorites as microbial habitats, and in 2026 work on recognising hidden caves from the surface. The marker came from our own screen, not from those study sites.',
      sources: [
        { label: 'Meteorites from the red desert of Australia support the search for life on Mars, ANSTO', url: 'https://ansto.gov.au/news/meteorites-from-red-desert-of-australia-support-search-for-life-on-red-planet-mars' },
      ],
    },
  },
  {
    id: 'mcbride',
    name: 'McBride Basalt Province',
    place: 'North Queensland, Australia',
    target: 'Moon',
    status: 'studied',
    continent: 'Oceania',
    region: 'North Queensland',
    lng: 144.567,
    lat: -18.367,
    localCamera: camera(340),
    droneScene: 'mcbride',
    research: {
      terrain: '164 eruption centres, including the Undara lava tube system of over 110 km.',
      analogRationale: 'A 2010 symposium paper proposed the Undara lava caves and "The Wall" ridge as a possible lunar analogue. It is a proposal, not an established test site.',
      sources: [{ label: 'Lava Caves, Depressions and The Wall: a Possible Lunar Analogue (2010)', url: 'https://www.vulcanospeleology.org/sym14/papers/Atkinson.pdf' }],
    },
  },
];

const BEARING_STEP = 47; // varies the opening direction from one place to the next

/** Places from tools/find_candidates.py, checked against the literature in candidate-sites.json. */
const additionalSites: readonly AnalogSite[] = screenedSites.map((site, index) => ({
  id: site.id,
  name: site.name,
  place: site.place,
  target: site.target as PlanetaryTarget,
  status: site.status as SiteStatus,
  continent: site.continent as Continent,
  country: TWO_LETTER[site.iso3] ?? '',
  region: site.region,
  lng: site.lng,
  lat: site.lat,
  localCamera: camera((index * BEARING_STEP) % 360),
  droneScene: site.id,
  research: { terrain: site.terrain, analogRationale: site.analogRationale, sources: site.sources },
}));

/**
 * Places chosen for their landform (impact craters, lava tubes, yardangs, salt pans, periglacial
 * ground), each with sourced evidence. One appears once the pipeline has measured it.
 */
const evidenceSites: readonly AnalogSite[] = landformSites
  .filter((site) => site.id in measurements.sites)
  .map((site, index) => ({
    id: site.id,
    name: site.name,
    place: site.place,
    target: site.target as PlanetaryTarget,
    status: site.status as SiteStatus,
    feature: site.feature,
    continent: site.continent as Continent,
    country: TWO_LETTER[site.iso3] ?? '',
    region: site.region,
    lng: site.lng,
    lat: site.lat,
    localCamera: camera((index * BEARING_STEP + 20) % 360),
    droneScene: site.id,
    research: { terrain: site.terrain, analogRationale: site.analogRationale, evidence: site.evidence, sources: site.sources },
  }));

const withCountry: readonly AnalogSite[] = curatedSites.map((site) => ({ ...site, country: CURATED_COUNTRY[site.id] ?? '' }));

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** "Kenya" for "KE". */
export const countryName = (code: string): string => (code ? regionNames.of(code) ?? code : 'Unknown');

export const analogSites: readonly AnalogSite[] = [...withCountry, ...additionalSites, ...evidenceSites].map((site) => ({
  ...site,
  localCamera: { ...site.localCamera, zoom: framedZoom(site.lat) },
}));
