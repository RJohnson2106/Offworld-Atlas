import type { Map as MapLibreMap } from 'maplibre-gl';
import { moonOrbitPath, NIGHT_LAYER, nightDarkness, siteLight, skyClock } from './sunlight';
import type { SkyPositions, Vector } from './sunlight';

/**
 * Stars, Sun and Moon behind the globe. Everything sits at infinity, so the sky turns as the globe
 * is dragged and the opaque planet hides whatever passes behind it.
 *
 * The Sun's and Moon's directions and the Moon's phase are calculated for the chosen time. Sizes are
 * enlarged so they can be seen, the Sun waits at the window edge on its own side when out of view,
 * and the Moon's orbit is drawn far closer than it really is so it fits around the globe. The star
 * field is decorative: positions are generated, not catalogued.
 */

const STAR_COUNT = 9000;
const BAND_SHARE = 0.35; // share of stars gathered into a Milky Way-like band
const BAND_TILT = (62 * Math.PI) / 180;
const STAR_COLOURS = ['#ffffff', '#cfe0ff', '#ffe9c9', '#ffd2a8'];
const MOON_SIZE = 0.15; // diameter as a share of the window's shorter side
const MOON_ORBIT_RADII = 1.75; // drawn orbit, in Earth radii; the real one is about 60
const ORBIT_LINE = 'rgb(245 238 223 / 0.3)';
const CAP_EDGE_LAT = 84.9; // just inside where map tiles end
const CAP_POINTS = 96;
const POLE_CAPS: { sign: 1 | -1; colour: Vector }[] = [
  { sign: 1, colour: [34, 103, 150] }, // Arctic Ocean, matched to the imagery around it
  { sign: -1, colour: [252, 253, 255] }, // polar ice, likewise
];
const SUN_SIZE = 0.07;
const SUN_GLOW = 4.2; // glow radius, in sun diameters
const GLOW_STEPS = 16;
const EARTHSHINE = 0.13; // sunlight reflected off the Earth, brightened so a new Moon can be seen
const EDGE_GAP = 26; // px kept between a waiting Sun or Moon and the window edge, for its label
const BEHIND_FULL = -0.75; // cosine of the angle from the view axis at which fading starts...
const BEHIND_GONE = -0.98; // ...and ends: directly behind the viewer there is no "side" to wait on
const HAZE: [number, number] = [4.6, 6.6]; // zooms between which the sky fades to horizon haze
const SPACE: Vector = [2, 4, 10];
const TERMINATOR_WIDTH = 0.18; // how gradually the Moon's light falls away
const NORTH: Vector = [0, 0, 1];
const toRadians = Math.PI / 180;

const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function normalize(v: Vector): Vector {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cameraBasis(lng: number, lat: number, bearing: number, pitch: number) {
  const [lo, la, b, p] = [lng * toRadians, lat * toRadians, bearing * toRadians, pitch * toRadians];
  const out: Vector = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const east: Vector = [-Math.sin(lo), Math.cos(lo), 0];
  const north: Vector = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const mix = (u: Vector, s: number, v: Vector, t: number): Vector => [
    u[0] * s + v[0] * t,
    u[1] * s + v[1] * t,
    u[2] * s + v[2] * t,
  ];
  const heading = mix(north, Math.cos(b), east, Math.sin(b));
  return {
    right: mix(east, Math.cos(b), north, -Math.sin(b)),
    up: mix(out, Math.sin(p), heading, Math.cos(p)),
    forward: mix(out, -Math.cos(p), heading, Math.sin(p)),
  };
}

type Basis = ReturnType<typeof cameraBasis>;

function makeStars() {
  // Seeded, so the sky is the same on every visit.
  let seed = 0x5eed1969;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return Array.from({ length: STAR_COUNT }, () => {
    const inBand = random() < BAND_SHARE;
    const height = inBand ? (random() + random() + random() - 1.5) * 0.16 : random() * 2 - 1;
    const angle = random() * 2 * Math.PI;
    const ring = Math.sqrt(Math.max(0, 1 - height * height));
    const [x, y, z] = [ring * Math.cos(angle), ring * Math.sin(angle), height];
    const brightness = random() ** 3.2; // many faint stars, few bright ones
    return {
      direction: [x, y * Math.cos(BAND_TILT) - z * Math.sin(BAND_TILT), y * Math.sin(BAND_TILT) + z * Math.cos(BAND_TILT)] as Vector,
      size: 0.7 + brightness * 1.6,
      alpha: inBand ? 0.22 + brightness * 0.6 : 0.3 + brightness * 0.7,
      colour: STAR_COLOURS[Math.floor(random() * STAR_COLOURS.length)],
    };
  });
}

/** Redraws the Moon's disc with the lit part facing the Sun. */
function makeMoonShader() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let source: ImageData | null = null;

  return {
    canvas,
    load(image: HTMLImageElement) {
      if (!context) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      source = context.getImageData(0, 0, canvas.width, canvas.height);
    },
    ready: () => source !== null,
    shade(sun: Vector, moon: Vector, right: Vector, north: Vector) {
      if (!context || !source) return;
      const light: Vector = [dot(sun, right), dot(sun, north), -dot(sun, moon)];
      const { width, height, data } = source;
      const output = context.createImageData(width, height);
      const pixels = output.data;
      for (let row = 0; row < height; row += 1) {
        const y = 1 - ((row + 0.5) / height) * 2;
        for (let column = 0; column < width; column += 1) {
          const index = (row * width + column) * 4;
          const x = ((column + 0.5) / width) * 2 - 1;
          const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
          const sunlit = clamp01((x * light[0] + y * light[1] + z * light[2]) / TERMINATOR_WIDTH) ** 0.75;
          const lit = Math.max(sunlit, EARTHSHINE);
          for (let channel = 0; channel < 3; channel += 1) {
            pixels[index + channel] = Math.max(data[index + channel] * lit, SPACE[channel]);
          }
          pixels[index + 3] = data[index + 3];
        }
      }
      context.putImageData(output, 0, 0);
    },
  };
}

/** Draws the sky into `canvas` as the map moves. Returns a function that stops it. */
export function installSpaceBackdrop(
  map: MapLibreMap,
  canvas: HTMLCanvasElement,
  frontCanvas: HTMLCanvasElement,
  mapContainer: HTMLElement,
): () => void {
  const context = canvas.getContext('2d');
  const frontContext = frontCanvas.getContext('2d');
  if (!context || !frontContext) return () => undefined;
  const sky = context;
  const front = frontContext;

  const stars = makeStars();
  const moonImage = new Image();
  const moonShader = makeMoonShader();
  let positions: SkyPositions = skyClock.positions();
  let orbit: Vector[] = [];
  let moonNorth: Vector = NORTH;

  const focalLength = (height: number) => height / 2 / Math.tan((map.getVerticalFieldOfView() * toRadians) / 2);

  const updateSky = () => {
    positions = skyClock.positions();
    orbit = moonOrbitPath(skyClock.now(), positions.siderealAngle);
    const { sun, moon } = positions;
    moonNorth = normalize([-moon[2] * moon[0], -moon[2] * moon[1], 1 - moon[2] * moon[2]]);
    moonShader.shade(sun, moon, cross(moon, moonNorth), moonNorth);
  };

  const fit = () => {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    for (const [target, layer] of [[canvas, sky], [frontCanvas, front]] as const) {
      target.width = Math.round(canvas.clientWidth * scale);
      target.height = Math.round(canvas.clientHeight * scale);
      layer.setTransform(scale, 0, 0, scale, 0, 0);
    }
  };

  /** Where a direction lands on screen: its true place, or the window edge on its side. */
  function place(direction: Vector, { right, up, forward }: Basis, width: number, height: number, size: number) {
    const depth = dot(direction, forward);
    const fade = clamp01((depth - BEHIND_GONE) / (BEHIND_FULL - BEHIND_GONE));
    const focal = focalLength(height);
    // Past the side of the view there's no true position, so use a far point in that direction.
    const reach = depth > 0.001 ? focal / depth : focal * 1000;
    const x = dot(direction, right) * reach;
    const y = dot(direction, up) * reach;
    const halfWidth = Math.max(1, width / 2 - size / 2 - EDGE_GAP);
    const halfHeight = Math.max(1, height / 2 - size / 2 - EDGE_GAP);
    const shrink = Math.min(1, halfWidth / Math.max(Math.abs(x), 1e-6), halfHeight / Math.max(Math.abs(y), 1e-6));
    return { x: width / 2 + x * shrink, y: height / 2 - y * shrink, fade };
  }

  function label(target: CanvasRenderingContext2D, text: string, x: number, y: number) {
    target.font = '600 12.5px "Public Sans Variable", Arial, sans-serif';
    target.textAlign = 'center';
    target.fillStyle = '#ffffff';
    target.fillText(text, x, y);
  }

  /** The Moon and its orbit around the globe. The near half is drawn in front of the Earth. */
  function drawMoon(basis: Basis, zoom: number, centerLat: number, pitch: number, width: number, height: number) {
    const globeRadius = (512 * 2 ** zoom) / (2 * Math.PI * Math.cos(centerLat * toRadians));
    const reach = globeRadius * MOON_ORBIT_RADII;
    const globeY = height / 2 + globeRadius * Math.sin(pitch * toRadians); // tilting lifts the view off the centre
    const toScreen = (direction: Vector): [number, number] => [
      width / 2 + dot(direction, basis.right) * reach,
      globeY - dot(direction, basis.up) * reach,
    ];

    const farPath = new Path2D();
    const nearPath = new Path2D();
    orbit.slice(1).forEach((point, i) => {
      const path = dot(point, basis.forward) < 0 ? nearPath : farPath;
      path.moveTo(...toScreen(orbit[i]));
      path.lineTo(...toScreen(point));
    });
    for (const [target, path] of [[sky, farPath], [front, nearPath]] as const) {
      target.strokeStyle = ORBIT_LINE;
      target.lineWidth = 1;
      target.stroke(path);
    }

    if (!moonShader.ready()) return;
    const size = MOON_SIZE * Math.min(width, height);
    const margin = size / 2 + EDGE_GAP;
    const [orbitX, orbitY] = toScreen(positions.moon);
    const x = Math.min(width - margin, Math.max(margin, orbitX));
    const y = Math.min(height - margin, Math.max(margin, orbitY));
    const target = dot(positions.moon, basis.forward) < 0 ? front : sky;
    target.save();
    target.translate(x, y);
    // The disc is north-up; turn it to match how north lies on screen right now.
    target.rotate(Math.atan2(dot(moonNorth, basis.right), dot(moonNorth, basis.up)));
    target.drawImage(moonShader.canvas, -size / 2, -size / 2, size, size);
    target.restore();
    label(target, 'Moon', x, y + size / 2 + 18);
  }

  /**
   * Map tiles stop about 5° from each pole, and MapLibre smears their last row over the gap.
   * A flat cap in the colour of that row, shaded for the time of day, covers it.
   */
  function drawPoleCaps(center: { lng: number; lat: number }, zoom: number, height: number) {
    const lengthOut = (lng: number, lat: number): Vector => [
      Math.cos(lat * toRadians) * Math.cos(lng * toRadians),
      Math.cos(lat * toRadians) * Math.sin(lng * toRadians),
      Math.sin(lat * toRadians),
    ];
    const toCamera = lengthOut(center.lng, center.lat);
    const globeRadius = (512 * 2 ** zoom) / (2 * Math.PI * Math.cos(center.lat * toRadians));
    const horizon = 1 / (1 + focalLength(height) / globeRadius);
    const nightOn = map.getLayer(NIGHT_LAYER) && map.getLayoutProperty(NIGHT_LAYER, 'visibility') !== 'none';

    for (const { sign, colour } of POLE_CAPS) {
      const ring = Array.from({ length: CAP_POINTS }, (_, i) => {
        const lng = (i * 360) / CAP_POINTS - 180;
        const lat = sign * CAP_EDGE_LAT;
        return { lng, lat, visible: dot(lengthOut(lng, lat), toCamera) > horizon };
      });
      const shown = ring.filter((point) => point.visible);
      if (shown.length < 3) continue;
      // Starts just after a hidden stretch, so a cap crossing the horizon stays one simple shape.
      const firstHidden = ring.findIndex((point) => !point.visible);
      const ordered = firstHidden < 0 ? ring : [...ring.slice(firstHidden), ...ring.slice(0, firstHidden)].filter((p) => p.visible);

      const darkness = nightOn ? nightDarkness((Math.asin(positions.sun[2] * sign) / toRadians)) : 0;
      const shaded = colour.map((value, i) => Math.round(value + (SPACE[i] - value) * darkness));
      front.fillStyle = `rgb(${shaded.join(' ')})`;
      front.beginPath();
      ordered.forEach(({ lng, lat }, i) => {
        const { x, y } = map.project([lng, lat]);
        if (i === 0) front.moveTo(x, y);
        else front.lineTo(x, y);
      });
      front.closePath();
      front.fill();
    }
  }

  const draw = () => {
    const zoom = map.getZoom();
    const haze = clamp01((zoom - HAZE[0]) / (HAZE[1] - HAZE[0]));
    const center = map.getCenter();
    const horizon = siteLight(positions.sun, center.lng, center.lat).haze;
    mapContainer.style.backgroundColor = haze > 0 ? `rgb(${horizon.join(' ')} / ${haze})` : '';
    frontCanvas.style.opacity = String(1 - haze); // it sits above the map, so the haze can't cover it
    if (haze === 1) return; // fully covered

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    front.clearRect(0, 0, width, height);
    if (haze === 0) drawPoleCaps(center, zoom, height);
    const shortSide = Math.min(width, height);
    const basis = cameraBasis(center.lng, center.lat, map.getBearing(), map.getPitch());
    const focal = focalLength(height);
    sky.clearRect(0, 0, width, height);

    // The Earth turns under the stars, so the star field follows sidereal time.
    const turn = positions.siderealAngle * toRadians;
    const spin = ([x, y, z]: Vector): Vector => [
      x * Math.cos(turn) - y * Math.sin(turn),
      x * Math.sin(turn) + y * Math.cos(turn),
      z,
    ];
    const starRight = spin(basis.right);
    const starUp = spin(basis.up);
    const starForward = spin(basis.forward);

    for (const star of stars) {
      const depth = dot(star.direction, starForward);
      if (depth <= 0) continue;
      const x = width / 2 + (focal * dot(star.direction, starRight)) / depth;
      const y = height / 2 - (focal * dot(star.direction, starUp)) / depth;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      sky.globalAlpha = star.alpha;
      sky.fillStyle = star.colour;
      sky.beginPath();
      sky.arc(x, y, star.size / 2, 0, 2 * Math.PI);
      sky.fill();
    }

    const sunSize = SUN_SIZE * shortSide;
    const sun = place(positions.sun, basis, width, height, sunSize);
    if (sun.fade > 0) {
      const glowRadius = sunSize * SUN_GLOW;
      const glow = sky.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, glowRadius);
      const disc = sunSize / 2 / glowRadius;
      glow.addColorStop(0, 'rgb(255 255 255 / 1)');
      glow.addColorStop(disc * 0.85, 'rgb(255 253 244 / 1)');
      // Falls off with the square of distance, so the glow has no visible outer ring.
      for (let step = 0; step <= GLOW_STEPS; step += 1) {
        const at = disc + ((1 - disc) * step) / GLOW_STEPS;
        glow.addColorStop(at, `rgb(255 226 172 / ${0.9 * (disc / at) ** 2 * ((1 - at) / (1 - disc))})`);
      }
      sky.globalAlpha = sun.fade;
      sky.fillStyle = glow;
      sky.beginPath();
      sky.arc(sun.x, sun.y, glowRadius, 0, 2 * Math.PI);
      sky.fill();
      label(sky, 'Sun', sun.x, sun.y + sunSize / 2 + 18);
    }
    sky.globalAlpha = 1;

    drawMoon(basis, zoom, center.lat, map.getPitch(), width, height);
  };

  const refit = () => {
    fit();
    draw();
  };
  let frame = 0;
  const redrawSky = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateSky();
      draw();
    });
  };

  moonImage.onload = () => {
    moonShader.load(moonImage);
    updateSky();
    draw();
  };
  moonImage.src = `${import.meta.env.BASE_URL}space/moon.webp`;
  map.on('move', draw);
  map.on('resize', refit);
  const stopClock = skyClock.subscribe(redrawSky);
  updateSky();
  refit();

  return () => {
    moonImage.onload = null;
    cancelAnimationFrame(frame);
    stopClock();
    map.off('move', draw);
    map.off('resize', refit);
  };
}
