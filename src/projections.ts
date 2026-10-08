/**
 * Map projections for the GIS explorer's flat display modes.
 *
 * The display shader needs only the INVERSE projection — each pixel walks
 * screen → projection plane → (lon, lat) → the shared equirect UV that
 * `mapColor` composites — so adding a projection here (plus its WGSL twin in
 * `geo_gis_explorer.ts`, marked KEEP IN SYNC) is all it takes; every layer,
 * overlay, and analysis result works in it untouched.
 *
 * This CPU mirror exists for the interactions the shader can't serve: the
 * point-analysis click (pixel → lon/lat) and view clamping. Conventions match
 * the shader exactly: the projection plane is normalized by per-projection
 * half-extents so the whole world spans vuv [0,1]²; y is up in plane space.
 */

/** `map` is the classic equirectangular view; `globe` is handled separately (ray-marched). */
export type ProjectionKey = 'map' | 'mercator' | 'mollweide' | 'equalearth' | 'arctic' | 'antarctic';

export interface ProjectionSpec {
  key: ProjectionKey;
  label: string;
  /** The shader's projection selector (uniform value). */
  index: number;
  /** Projection-plane half extents (world bounds); aspect = halfW / halfH. */
  halfW: number;
  halfH: number;
  /** Cylindrical modes wrap longitude while panning; bounded ones clamp. */
  wraps: boolean;
  /** Tooltip note (distortion caveats etc.). */
  note: string;
  /** Plane coords → geodetic degrees, or null outside the projection's domain. */
  inverse(px: number, py: number): { lonDeg: number; latDeg: number } | null;
  /**
   * Geodetic degrees → plane coords, or null where the projection can't place the point
   * (a hidden hemisphere in polar views, poleward of Mercator's cap). Used for screen-space
   * annotations (analysis markers); the raster path never needs it.
   */
  forward(lonDeg: number, latDeg: number): { px: number; py: number } | null;
}

const PI = Math.PI;

// Equal Earth polynomial coefficients (Šavrič, Patterson & Jenny 2018) and the
// derived bounds. KEEP IN SYNC with the WGSL twin.
const EE_A1 = 1.340264, EE_A2 = -0.081106, EE_A3 = 0.000893, EE_A4 = 0.003796;
const EE_M = Math.sqrt(3) / 2;
const EE_MAX_THETA = PI / 3;                       // θ at the poles (sin θ = M · sin 90°)
const eeY = (t: number): number => t * (EE_A1 + t * t * (EE_A2 + t ** 4 * (EE_A3 + EE_A4 * t * t)));
const eeDy = (t: number): number => EE_A1 + t * t * (3 * EE_A2 + t ** 4 * (7 * EE_A3 + 9 * EE_A4 * t * t));
const EE_HALF_W = PI / (EE_M * EE_A1);             // x at (λ=π, φ=0)
const EE_HALF_H = eeY(EE_MAX_THETA);               // y at the poles

const SQRT2 = Math.SQRT2;

/** Polar stereographic radius at the equator (ρ = 2·tan(45°)) — the view's world bound. */
const POLAR_RHO_MAX = 2;

const deg = (rad: number): number => (rad * 180) / PI;
const rad = (d: number): number => (d * PI) / 180;

/** Mercator's latitude cap — where |y| reaches halfH (= π). */
const MERCATOR_MAX_LAT = deg(2 * Math.atan(Math.exp(PI)) - PI / 2);

function forwardMercator(lonDeg: number, latDeg: number): { px: number; py: number } | null {
  if (Math.abs(latDeg) > MERCATOR_MAX_LAT) {
    return null;
  }
  return { px: rad(lonDeg), py: Math.log(Math.tan(PI / 4 + rad(latDeg) / 2)) };
}

function forwardMollweide(lonDeg: number, latDeg: number): { px: number; py: number } {
  const phi = rad(latDeg);
  let theta = phi;
  if (Math.abs(latDeg) < 90) {   // Newton's denominator vanishes at the poles
    for (let i = 0; i < 25; i++) {
      theta -= (2 * theta + Math.sin(2 * theta) - PI * Math.sin(phi)) / (2 + 2 * Math.cos(2 * theta));
    }
  }
  return { px: ((2 * SQRT2) / PI) * rad(lonDeg) * Math.cos(theta), py: SQRT2 * Math.sin(theta) };
}

function forwardEqualEarth(lonDeg: number, latDeg: number): { px: number; py: number } {
  const t = Math.asin(EE_M * Math.sin(rad(latDeg)));
  return { px: (rad(lonDeg) * Math.cos(t)) / (EE_M * eeDy(t)), py: eeY(t) };
}

function forwardPolar(lonDeg: number, latDeg: number, south: boolean): { px: number; py: number } | null {
  if (south ? latDeg > 0 : latDeg < 0) {
    return null;   // the other hemisphere is outside the view
  }
  const rho = south ? 2 * Math.tan(PI / 4 + rad(latDeg) / 2) : 2 * Math.tan(PI / 4 - rad(latDeg) / 2);
  const lon = rad(lonDeg);
  return south
    ? { px: rho * Math.sin(lon), py: rho * Math.cos(lon) }
    : { px: rho * Math.sin(lon), py: -rho * Math.cos(lon) };
}

function inverseMercator(px: number, py: number): { lonDeg: number; latDeg: number } | null {
  if (Math.abs(py) > PI + 1e-9) {
    return null;
  }
  return { lonDeg: deg(px), latDeg: deg(2 * Math.atan(Math.exp(py)) - PI / 2) };
}

function inverseMollweide(px: number, py: number): { lonDeg: number; latDeg: number } | null {
  const sy = py / SQRT2;
  if (Math.abs(sy) > 1) {
    return null;
  }
  const theta = Math.asin(sy);
  const sphi = (2 * theta + Math.sin(2 * theta)) / PI;
  if (Math.abs(sphi) > 1) {
    return null;
  }
  const ct = Math.cos(theta);
  if (ct < 1e-9) {
    return Math.abs(px) < 1e-6 ? { lonDeg: 0, latDeg: Math.sign(py) * 90 } : null;   // the poles are points
  }
  const lon = (PI * px) / (2 * SQRT2 * ct);
  if (Math.abs(lon) > PI + 1e-9) {
    return null;
  }
  return { lonDeg: deg(lon), latDeg: deg(Math.asin(sphi)) };
}

function inverseEqualEarth(px: number, py: number): { lonDeg: number; latDeg: number } | null {
  // Newton-solve θ from y (the polynomial is gentle; 4 iterations ≫ enough).
  let t = py / EE_A1;
  for (let i = 0; i < 4; i++) {
    t -= (eeY(t) - py) / eeDy(t);
  }
  if (Math.abs(t) > EE_MAX_THETA + 1e-6) {
    return null;
  }
  const sphi = Math.sin(t) / EE_M;
  if (Math.abs(sphi) > 1) {
    return null;
  }
  const lon = (px * EE_M * eeDy(t)) / Math.cos(t);
  if (Math.abs(lon) > PI + 1e-9) {
    return null;
  }
  return { lonDeg: deg(lon), latDeg: deg(Math.asin(sphi)) };
}

function inversePolar(px: number, py: number, south: boolean): { lonDeg: number; latDeg: number } | null {
  const rho = Math.hypot(px, py);
  if (rho > POLAR_RHO_MAX + 1e-9) {
    return null;
  }
  const lat = south ? 2 * Math.atan(rho / 2) - PI / 2 : PI / 2 - 2 * Math.atan(rho / 2);
  // North: Greenwich points down; south: Greenwich points up. Both keep 90°E on the right.
  const lon = south ? Math.atan2(px, py) : Math.atan2(px, -py);
  return { lonDeg: deg(lon), latDeg: deg(lat) };
}

/** All flat projections, in the order the UI offers them. @see geo_gis_explorer.ts */
export const PROJECTIONS: ProjectionSpec[] = [
  {
    key: 'map', label: '🗺 Equirect', index: 0, halfW: PI, halfH: PI / 2, wraps: true,
    note: 'Equirectangular (plate carrée) — the data\'s native grid.',
    inverse: (px, py) => (Math.abs(py) > PI / 2 + 1e-9 ? null : { lonDeg: deg(px), latDeg: deg(py) }),
    forward: (lonDeg, latDeg) => ({ px: rad(lonDeg), py: rad(latDeg) }),
  },
  {
    key: 'mercator', label: 'Mercator', index: 1, halfW: PI, halfH: PI, wraps: true,
    note: 'Conformal web-map look (to ±85°). Beware: polar areas are hugely inflated — do not judge areas by eye.',
    inverse: inverseMercator,
    forward: forwardMercator,
  },
  {
    key: 'mollweide', label: 'Mollweide', index: 2, halfW: 2 * SQRT2, halfH: SQRT2, wraps: false,
    note: 'Equal-area ellipse — pixel area ∝ true area; the climate-literature standard.',
    inverse: inverseMollweide,
    forward: forwardMollweide,
  },
  {
    key: 'equalearth', label: 'Equal Earth', index: 3, halfW: EE_HALF_W, halfH: EE_HALF_H, wraps: false,
    note: 'Equal-area pseudocylindrical (Šavrič–Patterson–Jenny 2018) — honest areas, gentler shapes than Mollweide.',
    inverse: inverseEqualEarth,
    forward: forwardEqualEarth,
  },
  {
    key: 'arctic', label: 'Arctic', index: 4, halfW: POLAR_RHO_MAX, halfH: POLAR_RHO_MAX, wraps: false,
    note: 'North polar stereographic, pole to equator — the sea-ice view. Greenwich points down.',
    inverse: (px, py) => inversePolar(px, py, false),
    forward: (lonDeg, latDeg) => forwardPolar(lonDeg, latDeg, false),
  },
  {
    key: 'antarctic', label: 'Antarctic', index: 5, halfW: POLAR_RHO_MAX, halfH: POLAR_RHO_MAX, wraps: false,
    note: 'South polar stereographic, pole to equator. Greenwich points up.',
    inverse: (px, py) => inversePolar(px, py, true),
    forward: (lonDeg, latDeg) => forwardPolar(lonDeg, latDeg, true),
  },
];

export function projectionByKey(key: string | null): ProjectionSpec {
  return PROJECTIONS.find((p) => p.key === key) ?? PROJECTIONS[0];
}
