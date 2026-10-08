/**
 * Political reference geometry — country and state/province boundary lines, and populated places
 * for labels — from **Natural Earth**, at three levels of detail.
 *
 * Reference lines are the one overlay whose usefulness is entirely a function of scale. A world
 * view wants the coarsest possible outlines: 1:10M borders at that zoom are megabytes of vertices
 * collapsing into the same two-pixel line, and every one of them costs fetch, parse and draw time
 * for nothing. A view of one county wants the opposite — 1:110M borders there are visibly wrong,
 * cutting corners by tens of kilometres. So the data is a LADDER, not a layer: three cartographic
 * scales, and the renderer asks for the one that matches what is on screen (see
 * {@link detailForZoom}).
 *
 * Natural Earth is public-domain and already generalized BY CARTOGRAPHERS at each of those scales,
 * which is the part that matters: a runtime line-simplifier removes vertices, but it cannot decide
 * that a bay should stay and an inlet should go. It is served here from jsDelivr (CORS `*`,
 * keyless, CDN-cached), the same rule every other feed in this module follows.
 *
 * Places carry Natural Earth's own `scalerank` — its editorial judgment of which cities earn a
 * label at which scale — so label thinning follows a cartographer's ranking rather than raw
 * population, which would put every Chinese prefecture city on a world map and drop Reykjavík.
 *
 * @category Live
 */

import type { LonLat } from './cyclones.js';
import { geometryPaths } from './cyclones.js';

const NE = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson';

/** Attribution required while this data is on screen. @category Live */
export const NATURAL_EARTH_ATTRIBUTION = 'Boundaries & places © Natural Earth (public domain)';

/** Cartographic scale of a fetched set: 1:110M, 1:50M, 1:10M. @category Live */
export type DetailLevel = '110m' | '50m' | '10m';

/** Country + state boundary lines at one detail level. @category Live */
export interface BoundaryLines {
  level: DetailLevel;
  /** International boundaries on land — NOT coastlines, which the basemap already draws. */
  country: LonLat[][];
  /** First-order internal divisions: US states, Canadian provinces, and so on. */
  state: LonLat[][];
}

/** One populated place. @category Live */
export interface Place {
  name: string;
  lon: number;
  lat: number;
  /** Metro population where Natural Earth has one. */
  population: number | null;
  /**
   * Natural Earth's prominence ranking, 0 (most prominent) … 10. Lower shows at coarser scales;
   * this is the field label thinning is driven by.
   */
  scaleRank: number;
  /** True for a national capital. */
  capital: boolean;
  /** Country name, for disambiguating the many Springfields. */
  country: string;
}

/**
 * The detail level for a zoom factor (1 = whole world across the viewport).
 *
 * The thresholds are where the finer set starts to *show* — roughly where a 1:110M line's
 * generalization error grows past a pixel, then a 1:50M line's. Deliberately hysteresis-free: the
 * caller debounces view changes, so a level flipping back and forth costs a cache hit, not a fetch.
 * @category Live
 */
export function detailForZoom(zoom: number): DetailLevel {
  if (zoom >= 12) {
    return '10m';
  }
  if (zoom >= 3) {
    return '50m';
  }
  return '110m';
}

/**
 * Whether a place earns a label at this zoom.
 *
 * One rank per doubling of zoom, starting from "capitals and megacities only" at the world view.
 * Screen-space collision still has the last word — this only bounds how many candidates it has to
 * consider, which is what keeps a 7,000-city set from being sorted and projected every re-raster.
 * @category Live
 */
export function placeRankForZoom(zoom: number): number {
  return Math.min(10, Math.max(1, Math.round(Math.log2(Math.max(zoom, 1)) + 1)));
}

interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

async function fetchGeoJson(url: string, signal?: AbortSignal): Promise<Feature[]> {
  const r = await fetch(url, { signal, cache: 'force-cache' });
  if (!r.ok) {
    throw new Error(`Natural Earth: HTTP ${r.status}`);
  }
  const json = await r.json() as { features?: Feature[] };
  return json.features ?? [];
}

// Fetched sets are held forever: they are static reference data (a few hundred KB at the coarse
// levels), and the whole point of the ladder is that zooming back out is instant.
const boundaryCache = new Map<DetailLevel, Promise<BoundaryLines>>();
const placeCache = new Map<DetailLevel, Promise<Place[]>>();

/**
 * Country and state boundary lines at one detail level, cached.
 *
 * The two files are independent: a missing state file still yields country lines rather than
 * nothing. 1:10M state lines are the one gap — the file is past jsDelivr's 20 MB ceiling, so 10m
 * falls back to the 1:50M state set, which is the right call anyway at the zooms where anyone can
 * tell the difference (a state line is smooth; a coastline is not).
 * @category Live
 */
export function loadBoundaryLines(level: DetailLevel, signal?: AbortSignal): Promise<BoundaryLines> {
  const hit = boundaryCache.get(level);
  if (hit) {
    return hit;
  }
  const stateLevel: DetailLevel = level === '10m' ? '50m' : level;
  const load = (async (): Promise<BoundaryLines> => {
    const [country, state] = await Promise.allSettled([
      fetchGeoJson(`${NE}/ne_${level}_admin_0_boundary_lines_land.geojson`, signal),
      fetchGeoJson(`${NE}/ne_${stateLevel}_admin_1_states_provinces_lines.geojson`, signal),
    ]);
    const paths = (r: PromiseSettledResult<Feature[]>): LonLat[][] => (r.status === 'fulfilled'
      ? r.value.flatMap((f) => geometryPaths(f.geometry)) : []);
    const lines = { level, country: paths(country), state: paths(state) };
    if (lines.country.length === 0 && lines.state.length === 0) {
      throw new Error('Natural Earth: no boundary data');
    }
    return lines;
  })();
  boundaryCache.set(level, load);
  load.catch(() => boundaryCache.delete(level));   // let a failed level be retried
  return load;
}

/**
 * Populated places at one detail level, cached, sorted most-prominent first so a label pass can
 * simply take them in order and stop when the screen is full.
 * @category Live
 */
export function loadPlaces(level: DetailLevel, signal?: AbortSignal): Promise<Place[]> {
  const hit = placeCache.get(level);
  if (hit) {
    return hit;
  }
  const load = (async (): Promise<Place[]> => {
    const features = await fetchGeoJson(`${NE}/ne_${level}_populated_places_simple.geojson`, signal);
    const places: Place[] = [];
    for (const f of features) {
      if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) {
        continue;
      }
      const [lon, lat] = f.geometry.coordinates as number[];
      const p = f.properties;
      const name = typeof p.name === 'string' ? p.name : '';
      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        continue;
      }
      const pop = Number(p.pop_max);
      places.push({
        name,
        lon,
        lat,
        population: Number.isFinite(pop) && pop > 0 ? pop : null,
        scaleRank: Number.isFinite(Number(p.scalerank)) ? Number(p.scalerank) : 10,
        capital: Number(p.adm0cap) === 1,
        country: typeof p.adm0name === 'string' ? p.adm0name : '',
      });
    }
    // Capitals outrank their scalerank by half a step: a national capital is what a reader looks
    // for first on an unfamiliar continent, even when a larger city sits next to it.
    places.sort((a, b) => (a.scaleRank - (a.capital ? 0.5 : 0)) - (b.scaleRank - (b.capital ? 0.5 : 0))
      || (b.population ?? 0) - (a.population ?? 0));
    return places;
  })();
  placeCache.set(level, load);
  load.catch(() => placeCache.delete(level));
  return load;
}

/** Population as a label reads it: `8.6M`, `340k`, `4,200`. @category Live */
export function formatPopulation(pop: number | null): string {
  if (pop === null) {
    return '';
  }
  if (pop >= 1e6) {
    return `${(pop / 1e6).toFixed(pop >= 1e7 ? 0 : 1)}M`;
  }
  if (pop >= 1e4) {
    return `${Math.round(pop / 1e3)}k`;
  }
  return pop.toLocaleString('en-US');
}
