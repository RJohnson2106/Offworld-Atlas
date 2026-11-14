import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import { SKY } from './basemap';

/**
 * Where the Sun and Moon are for a given moment, and which part of the Earth is in darkness.
 * Positions use the low-precision formulae of the Astronomical Almanac: good to about 0.01° for
 * the Sun and 0.3° for the Moon, around the present day. Air bending the light is ignored.
 */

export type Vector = [number, number, number];

const NIGHT = 'night';
export const NIGHT_LAYER = NIGHT;
const BEFORE_LAYER = 'graticule-major';
const LIGHT_DISTANCE = 1.15;
// Each band is one more layer of shade as the Sun sinks, which builds the soft edge of twilight.
const SHADE_BANDS = 36;
const SHADE_STEP = 0.5; // degrees of Sun altitude per band
const SHADE_OPACITY = 0.053;
const SITE_SHADE_OPACITY = 0.04; // lighter close up, so terrain can still be read at night
const SHADE_ZOOMS: [number, number] = [5, 7]; // moves from the globe's shade to the site shade
const SKY_FROM_ZOOM = 4; // below this the sky is space, so its colours can't be seen
const SHADE_TEXTURE = 720; // night picture size in pixels; twilight is smooth, so it needn't be big
const SHADE_LOOKUP = 4096;
const SITE_SHADE_STRENGTH = 0.9; // the night picture's strength close up, so terrain stays readable
const NIGHT_COLOUR: Vector = [2, 4, 10];
const MERCATOR_LIMIT = 85.0511;
const SHADE_CORNERS: [[number, number], [number, number], [number, number], [number, number]] = [
  [-180, MERCATOR_LIMIT],
  [180, MERCATOR_LIMIT],
  [180, -MERCATOR_LIMIT],
  [-180, -MERCATOR_LIMIT],
];
const SIDEREAL_MONTH_DAYS = 27.32;
const ORBIT_SAMPLES = 96;

type Rgb = [number, number, number];

/** Sky colours by Sun altitude at the place being viewed. The last stop is the normal daytime sky. */
const SKY_STOPS: { altitude: number; haze: Rgb; zenith: Rgb }[] = [
  { altitude: -18, haze: [7, 11, 24], zenith: [3, 5, 12] },
  { altitude: -6, haze: [44, 54, 84], zenith: [11, 20, 48] },
  { altitude: -0.5, haze: [212, 138, 92], zenith: [43, 74, 124] },
  { altitude: 8, haze: [220, 180, 142], zenith: [63, 115, 171] },
  { altitude: 20, haze: [141, 178, 201], zenith: [20, 69, 127] },
];

const radians = Math.PI / 180;
const sin = (degrees: number) => Math.sin(degrees * radians);
const cos = (degrees: number) => Math.cos(degrees * radians);

export interface SkyPositions {
  /** Unit vectors from the Earth's centre: x through 0° longitude, y through 90° E, z north. */
  sun: Vector;
  moon: Vector;
  /** Greenwich sidereal time in degrees: how far the Earth has turned against the stars. */
  siderealAngle: number;
  subsolar: { lng: number; lat: number };
}

function equatorialToEarth(rightAscension: number, declination: number, siderealAngle: number): Vector {
  const hourAngle = rightAscension - siderealAngle;
  return [cos(declination) * cos(hourAngle), cos(declination) * sin(hourAngle), sin(declination)];
}

function eclipticToEarth(longitude: number, latitude: number, obliquity: number, siderealAngle: number): Vector {
  const x = cos(latitude) * cos(longitude);
  const y = cos(latitude) * sin(longitude) * cos(obliquity) - sin(latitude) * sin(obliquity);
  const z = cos(latitude) * sin(longitude) * sin(obliquity) + sin(latitude) * cos(obliquity);
  return equatorialToEarth(Math.atan2(y, x) / radians, Math.asin(z) / radians, siderealAngle);
}

const daysSinceEpoch = (date: Date) => date.getTime() / 86_400_000 + 2440587.5 - 2451545; // J2000
const obliquityAt = (days: number) => 23.439 - 0.0000004 * days;

export function skyPositions(date: Date): SkyPositions {
  const days = daysSinceEpoch(date);
  const obliquity = obliquityAt(days);
  const siderealAngle = ((280.46061837 + 360.98564736629 * days) % 360 + 360) % 360;

  const anomaly = 357.528 + 0.9856003 * days;
  const sunLongitude = 280.46 + 0.9856474 * days + 1.915 * sin(anomaly) + 0.02 * sin(2 * anomaly);
  const sun = eclipticToEarth(sunLongitude, 0, obliquity, siderealAngle);
  const moon = moonDirection(days, siderealAngle);

  return {
    sun,
    moon,
    siderealAngle,
    subsolar: { lng: Math.atan2(sun[1], sun[0]) / radians, lat: Math.asin(sun[2]) / radians },
  };
}

function moonDirection(days: number, siderealAngle: number): Vector {
  const t = days / 36525;
  const moonLongitude =
    218.32 +
    481267.881 * t +
    6.29 * sin(135.0 + 477198.87 * t) -
    1.27 * sin(259.3 - 413335.36 * t) +
    0.66 * sin(235.7 + 890534.22 * t) +
    0.21 * sin(269.9 + 954397.74 * t) -
    0.19 * sin(357.5 + 35999.05 * t) -
    0.11 * sin(186.5 + 966404.03 * t);
  const moonLatitude =
    5.13 * sin(93.3 + 483202.02 * t) +
    0.28 * sin(228.2 + 960400.89 * t) -
    0.28 * sin(318.3 + 6003.15 * t) -
    0.17 * sin(217.6 - 407332.21 * t);
  return eclipticToEarth(moonLongitude, moonLatitude, obliquityAt(days), siderealAngle);
}

/** One lap of the Moon around the given moment, as seen with the Earth's turn frozen there. */
export function moonOrbitPath(date: Date, siderealAngle: number): Vector[] {
  const days = daysSinceEpoch(date);
  return Array.from({ length: ORBIT_SAMPLES + 1 }, (_, i) =>
    moonDirection(days + (i / ORBIT_SAMPLES - 0.5) * SIDEREAL_MONTH_DAYS, siderealAngle),
  );
}

export interface SiteLight {
  altitude: number;
  haze: Rgb;
  zenith: Rgb;
  /** Share of daytime brightness left on the ground, matching the map's site shade. */
  ground: number;
}

/** How the sky and ground look from a place on Earth, given the direction of the Sun. */
/** The direction of the Sun as seen from a place: unit vector parts towards east, north and up. */
export function localSun(sun: Vector, lng: number, lat: number): { east: number; north: number; up: number } {
  return {
    east: -sin(lng) * sun[0] + cos(lng) * sun[1],
    north: -sin(lat) * cos(lng) * sun[0] - sin(lat) * sin(lng) * sun[1] + cos(lat) * sun[2],
    up: cos(lat) * cos(lng) * sun[0] + cos(lat) * sin(lng) * sun[1] + sin(lat) * sun[2],
  };
}

/** How dark the globe's shade is, from 0 to 1, for a Sun at this altitude in degrees. */
export function nightDarkness(altitude: number): number {
  const bands = Math.min(SHADE_BANDS, Math.max(0, -altitude / SHADE_STEP));
  return 1 - (1 - SHADE_OPACITY) ** bands;
}

export function siteLight(sun: Vector, lng: number, lat: number): SiteLight {
  const altitude =
    Math.asin(cos(lat) * cos(lng) * sun[0] + cos(lat) * sin(lng) * sun[1] + sin(lat) * sun[2]) / radians;
  const next = SKY_STOPS.findIndex((stop) => altitude < stop.altitude);
  const upper = SKY_STOPS[next === -1 ? SKY_STOPS.length - 1 : Math.max(next, 1)];
  const lower = SKY_STOPS[next === -1 ? SKY_STOPS.length - 2 : Math.max(next - 1, 0)];
  const share = Math.min(1, Math.max(0, (altitude - lower.altitude) / (upper.altitude - lower.altitude)));
  const blend = (a: Rgb, b: Rgb) => a.map((value, i) => Math.round(value + (b[i] - value) * share)) as Rgb;
  const bands = Math.min(SHADE_BANDS, Math.max(0, -altitude / SHADE_STEP));
  return {
    altitude,
    haze: blend(lower.haze, upper.haze),
    zenith: blend(lower.zenith, upper.zenith),
    ground: (1 - SITE_SHADE_OPACITY) ** bands,
  };
}

/**
 * A picture of the night side in map (Mercator) coordinates, repainted on this thread. Unlike a
 * GeoJSON layer, which is rebuilt in a worker, it is never behind the clock during a time-lapse.
 */
function makeNightPainter() {
  const canvas = document.createElement('canvas');
  canvas.width = SHADE_TEXTURE;
  canvas.height = SHADE_TEXTURE;
  const context = canvas.getContext('2d');
  const image = new ImageData(SHADE_TEXTURE, SHADE_TEXTURE);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = NIGHT_COLOUR[0];
    image.data[i + 1] = NIGHT_COLOUR[1];
    image.data[i + 2] = NIGHT_COLOUR[2];
  }

  const sinLat = new Float32Array(SHADE_TEXTURE);
  const cosLat = new Float32Array(SHADE_TEXTURE);
  const sinLng = new Float32Array(SHADE_TEXTURE);
  const cosLng = new Float32Array(SHADE_TEXTURE);
  for (let i = 0; i < SHADE_TEXTURE; i += 1) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (i + 0.5)) / SHADE_TEXTURE)));
    sinLat[i] = Math.sin(lat);
    cosLat[i] = Math.cos(lat);
    const lng = ((i + 0.5) / SHADE_TEXTURE) * 2 * Math.PI - Math.PI;
    sinLng[i] = Math.sin(lng);
    cosLng[i] = Math.cos(lng);
  }

  // Darkness by the sine of the Sun's altitude, deepening through twilight.
  const darkness = Uint8ClampedArray.from({ length: SHADE_LOOKUP }, (_, i) =>
    255 * nightDarkness(Math.asin((2 * i) / (SHADE_LOOKUP - 1) - 1) / radians),
  );

  return {
    canvas,
    paint(sun: Vector) {
      const pixels = image.data;
      const scale = (SHADE_LOOKUP - 1) / 2;
      let index = 3;
      for (let row = 0; row < SHADE_TEXTURE; row += 1) {
        for (let column = 0; column < SHADE_TEXTURE; column += 1) {
          const sinAltitude = sinLat[row] * sun[2] + cosLat[row] * (cosLng[column] * sun[0] + sinLng[column] * sun[1]);
          pixels[index] = darkness[((sinAltitude + 1) * scale + 0.5) | 0];
          index += 4;
        }
      }
      context?.putImageData(image, 0, 0);
    },
  };
}

/** The moment the sky shows. Everything that depends on the time listens here. */
export const skyClock = (() => {
  let current = new Date();
  const listeners = new Set<() => void>();
  return {
    now: () => current,
    positions: () => skyPositions(current),
    set(date: Date) {
      current = date;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();

/** Adds the night shading and points the globe's atmosphere glow at the Sun. */
export function installDaylight(map: MapLibreMap): () => void {
  const painter = makeNightPainter();
  painter.paint(skyClock.positions().sun);
  map.addSource(NIGHT, {
    type: 'canvas',
    canvas: painter.canvas,
    coordinates: SHADE_CORNERS,
    animate: false,
  });
  map.addLayer(
    {
      id: NIGHT,
      type: 'raster',
      source: NIGHT,
      paint: {
        'raster-fade-duration': 0,
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], SHADE_ZOOMS[0], 1, SHADE_ZOOMS[1], SITE_SHADE_STRENGTH],
      },
    },
    BEFORE_LAYER,
  );

  // Recoloured only when the Sun has moved noticeably, since this runs as the camera moves.
  let skyKey = Number.NaN;
  const applySky = () => {
    if (map.getZoom() < SKY_FROM_ZOOM) return;
    const center = map.getCenter();
    const { altitude, haze, zenith } = siteLight(skyClock.positions().sun, center.lng, center.lat);
    const key = Math.round(altitude * 2);
    if (key === skyKey) return;
    skyKey = key;
    const colour = (rgb: Rgb) => `rgb(${rgb.join(',')})`;
    map.setSky({ ...SKY, 'sky-color': colour(zenith), 'horizon-color': colour(haze), 'fog-color': colour(haze) });
  };

  let frame = 0;
  const apply = () => {
    frame = 0;
    applySky();
    const { sun } = skyClock.positions();
    painter.paint(sun);
    // Playing and pausing straight away uploads this one new picture and asks for a redraw.
    const source = map.getSource(NIGHT) as CanvasSource | undefined;
    source?.play();
    source?.pause();
    // MapLibre's globe axes are x = 90° E, y = north, z = 0°, and it aims the light along -position.
    const [x, y, z] = [-sun[1] * LIGHT_DISTANCE, -sun[2] * LIGHT_DISTANCE, -sun[0] * LIGHT_DISTANCE];
    const azimuth = Math.atan2(y, x) / radians - 90;
    const polar = Math.acos(z / LIGHT_DISTANCE) / radians;
    map.setLight({ anchor: 'map', position: [LIGHT_DISTANCE, azimuth, polar] });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };

  apply();
  map.on('move', applySky);
  const stop = skyClock.subscribe(schedule);
  return () => {
    stop();
    cancelAnimationFrame(frame);
    map.off('move', applySky);
  };
}
