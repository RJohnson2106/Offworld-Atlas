/** Converts between drone scene metres (+x east, +z south, site at 0,0) and longitude and latitude. */

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const radians = Math.PI / 180;

const mercatorY = (lat: number) => {
  const sin = Math.sin(lat * radians);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
};

const metresPerWorld = (siteLat: number) => EARTH_CIRCUMFERENCE_M * Math.cos(siteLat * radians);

export function sceneToLngLat(x: number, z: number, site: { lng: number; lat: number }): [number, number] {
  const world = metresPerWorld(site.lat);
  const y = mercatorY(site.lat) + z / world;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / radians;
  return [site.lng + (x / world) * 360, lat];
}

export function lngLatToScene(lng: number, lat: number, site: { lng: number; lat: number }): { x: number; z: number } {
  const world = metresPerWorld(site.lat);
  return { x: ((lng - site.lng) / 360) * world, z: (mercatorY(lat) - mercatorY(site.lat)) * world };
}
