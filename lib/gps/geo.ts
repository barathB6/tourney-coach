// Shared geo math for the GPS pipeline: distance and centroid calculations
// used by tee-cluster detection and green labeling.

const EARTH_RADIUS_M = 6371000;

export interface LatLng {
  lat: number;
  lng: number;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function centroid(points: LatLng[]): LatLng {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

// Average distance of every point to the centroid — small for a tight
// cluster (teammates standing at the same tee box), large for scattered
// points (players still walking in from the parking lot).
export function spreadMeters(points: LatLng[]): number {
  const c = centroid(points);
  return points.reduce((s, p) => s + haversineMeters(p, c), 0) / points.length;
}
