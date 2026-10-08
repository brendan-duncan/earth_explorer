/**
 * Active wildfires — perimeters, incident facts, satellite hotspots — plus the national-forest
 * boundaries they burn in.
 *
 * Like {@link "./cyclones.ts"}, this is vector geometry rather than a gridded field, and for the same
 * reason: a fire is an OBJECT with an edge, not a value sampled everywhere. Three feeds answer
 * three different questions, and no one of them substitutes for another:
 *
 *  - the **perimeter** (NIFC/WFIGS) is where the fire has burned, as last mapped — authoritative,
 *    and hours-to-days old, because someone has to fly or walk it;
 *  - the **incident** record is what is known about it right now: acreage, containment, cause,
 *    fuel, crew size, complexity. It updates far more often than the perimeter does, which is why
 *    a fire's stated acreage routinely exceeds the polygon on screen;
 *  - **VIIRS hotspots** are where satellites detected heat in the last hours. They are the only
 *    near-real-time signal here, they are points rather than an edge, and they are the layer that
 *    shows which SIDE of a fire is actually running.
 *
 * Both services are keyless and answer `Access-Control-Allow-Origin: *`.
 *
 * The hotspot archive holds ~1.8M detections and ~200k in any 24 h, so it is queried by viewport
 * and capped, ordered by fire radiative power — a bounded request that keeps the biggest fires
 * when the cap bites. Perimeters are national in one 240 KB request (195 of them today) and are
 * not worth windowing.
 *
 * @category Live
 */

import type { LonLat } from './cyclones.js';
import { geometryPaths } from './cyclones.js';

const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const NOAA_AGOL = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services';
const USFS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer';

/** Attribution required while each feed is on screen. @category Live */
export const WILDFIRE_ATTRIBUTION = 'NIFC/WFIGS · NASA VIIRS via NOAA · USDA Forest Service';

/** A lon/lat bounding box, degrees. @category Live */
export interface BBox { west: number; south: number; east: number; north: number }

/** Everything known about one active incident, whether or not it has been mapped yet. @category Live */
export interface FireIncident {
  /** IRWIN id — the key every US fire system agrees on. */
  id: string;
  name: string;
  lon: number;
  lat: number;
  /** Current size in acres: the incident's own figure, or the mapped polygon's when it has one. */
  acres: number | null;
  containedPct: number | null;
  discoveredMs: number | null;
  cause: string;
  /** Fuel the fire is burning, as the incident reports it (e.g. "Timber (Grass and Understory)"). */
  fuel: string;
  personnel: number | null;
  /** Incident command complexity, e.g. "Type 2 Incident" — the plainest proxy for "how serious". */
  complexity: string;
  state: string;
  /** True for a planned burn (`RX`), which must not be drawn as if it were a wildfire. */
  prescribed: boolean;
  /** True when a mapped perimeter exists for this incident. */
  mapped: boolean;
}

/** One mapped fire edge. @category Live */
export interface FirePerimeter {
  id: string;
  name: string;
  acres: number | null;
  /** When the polygon was last updated — routinely days behind the incident's acreage. */
  mappedMs: number | null;
  prescribed: boolean;
  /** Outer ring first per polygon; interior rings (unburned islands) follow. */
  rings: LonLat[][];
}

/** One satellite thermal detection. @category Live */
export interface FireHotspot {
  lon: number;
  lat: number;
  /** Fire radiative power, MW — how much heat, not how much area. */
  frp: number;
  /** Brightness temperature, K (VIIRS I-4 band). */
  brightnessK: number;
  /** `low` | `nominal` | `high`, as the product reports it. */
  confidence: string;
  /** Hours since acquisition — what fades an old detection out. */
  hoursOld: number;
  night: boolean;
}

/** A national forest / grassland administrative unit. @category Live */
export interface ForestUnit {
  name: string;
  /** Forest Service region number, e.g. "03" for the Southwestern Region. */
  region: string;
  acres: number | null;
  rings: LonLat[][];
}

/** One fetch of the fire situation. @category Live */
export interface WildfireSnapshot {
  incidents: FireIncident[];
  perimeters: FirePerimeter[];
  hotspots: FireHotspot[];
  /** True when the hotspot cap was reached — the view holds more heat than is drawn. */
  hotspotsTruncated: boolean;
}

// ── Query plumbing ─────────────────────────────────────────────────────────────────────

interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
}

/** `geometry=` + `spatialRel` for a bbox, or '' for "everywhere". */
function envelope(bbox: BBox | undefined): string {
  if (!bbox) {
    return '';
  }
  const g = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  return `&geometry=${encodeURIComponent(g)}&geometryType=esriGeometryEnvelope&inSR=4326`
    + '&spatialRel=esriSpatialRelIntersects';
}

async function queryGeoJson(url: string, signal?: AbortSignal): Promise<Feature[]> {
  const r = await fetch(url, { signal, cache: 'no-cache' });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}`);
  }
  const json = await r.json() as { features?: Feature[]; error?: { message?: string } };
  if (json.error) {
    throw new Error(json.error.message || 'query failed');
  }
  return json.features ?? [];
}

/** First non-empty of a set of interchangeable field spellings (the feeds prefix inconsistently). */
function pick(props: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = props[k];
    if (v !== null && v !== undefined && v !== '') {
      return v;
    }
  }
  return null;
}

const PERIM_FIELDS = [
  'poly_IncidentName', 'poly_GISAcres', 'poly_DateCurrent', 'poly_IRWINID',
  'attr_IrwinID', 'attr_IncidentName', 'attr_IncidentSize', 'attr_PercentContained',
  'attr_IncidentTypeCategory',
].join(',');

const INCIDENT_FIELDS = [
  'IrwinID', 'IncidentName', 'IncidentTypeCategory', 'PercentContained', 'DiscoveryAcres',
  'FireDiscoveryDateTime', 'FireCause', 'POOState', 'TotalIncidentPersonnel',
  'IncidentComplexityLevel', 'PrimaryFuelModel', 'CpxName',
].join(',');

const HOTSPOT_FIELDS = 'frp,bright_ti4,confidence,hours_old,daynight';

/**
 * Loads the current fire situation.
 *
 * Each of the three queries is independent and a failure is swallowed: hotspots without perimeters
 * still show where the heat is, and perimeters without hotspots still show the burn. The call only
 * throws when nothing at all came back, so "quiet fire season" and "the services are down" stay
 * distinguishable.
 *
 * `bbox` bounds the hotspot query (and nothing else — the national perimeter set is one small
 * request, and clipping it would make a fire vanish as its edge left the screen).
 * @category Live
 */
export async function loadWildfires(opts: {
  bbox?: BBox;
  /** Detections older than this are not requested. Default 24 h. */
  hotspotHours?: number;
  /** Hard cap on detections, highest fire radiative power first. Default 3000. */
  maxHotspots?: number;
  signal?: AbortSignal;
} = {}): Promise<WildfireSnapshot> {
  const hours = opts.hotspotHours ?? 24;
  const cap = opts.maxHotspots ?? 3000;
  const common = '&outSR=4326&f=geojson&returnGeometry=true';

  const perimUrl = `${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`
    + `?where=1%3D1&outFields=${PERIM_FIELDS}${common}&maxAllowableOffset=0.001`;
  const incUrl = `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query`
    + `?where=1%3D1&outFields=${INCIDENT_FIELDS}${common}`;
  const hotUrl = `${NOAA_AGOL}/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query`
    + `?where=${encodeURIComponent(`hours_old<=${hours}`)}${envelope(opts.bbox)}`
    + `&outFields=${HOTSPOT_FIELDS}${common}&orderByFields=frp%20DESC&resultRecordCount=${cap}`;

  const [perimRes, incRes, hotRes] = await Promise.allSettled([
    queryGeoJson(perimUrl, opts.signal),
    queryGeoJson(incUrl, opts.signal),
    queryGeoJson(hotUrl, opts.signal),
  ]);
  if (perimRes.status === 'rejected' && incRes.status === 'rejected' && hotRes.status === 'rejected') {
    throw new Error(String((perimRes.reason as Error)?.message ?? 'fire services unreachable'));
  }
  const val = (r: PromiseSettledResult<Feature[]>): Feature[] => (r.status === 'fulfilled' ? r.value : []);

  const perimeters: FirePerimeter[] = [];
  /** Mapped acreage by IRWIN id — the incident record's own figure is often the stale one. */
  const mappedAcres = new Map<string, number>();
  for (const f of val(perimRes)) {
    const p = f.properties;
    const id = str(pick(p, 'attr_IrwinID', 'poly_IRWINID')).toLowerCase();
    const rings = geometryPaths(f.geometry);
    if (rings.length === 0) {
      continue;
    }
    const acres = num(pick(p, 'attr_IncidentSize', 'poly_GISAcres'));
    if (id && acres !== null) {
      mappedAcres.set(id, acres);
    }
    perimeters.push({
      id,
      name: str(pick(p, 'poly_IncidentName', 'attr_IncidentName')),
      acres,
      mappedMs: num(p.poly_DateCurrent),
      prescribed: str(p.attr_IncidentTypeCategory).toUpperCase() === 'RX',
      rings,
    });
  }

  const incidents: FireIncident[] = [];
  for (const f of val(incRes)) {
    const p = f.properties;
    if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) {
      continue;
    }
    const [lon, lat] = f.geometry.coordinates as number[];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }
    const id = str(p.IrwinID).toLowerCase();
    incidents.push({
      id,
      name: str(p.IncidentName) || str(p.CpxName) || 'Unnamed fire',
      lon,
      lat,
      // Prefer the mapped polygon's acreage: an incident's own DiscoveryAcres is what it was when
      // someone first saw it, which for a big fire is off by three orders of magnitude.
      acres: mappedAcres.get(id) ?? num(p.DiscoveryAcres),
      containedPct: num(p.PercentContained),
      discoveredMs: num(p.FireDiscoveryDateTime),
      cause: str(p.FireCause),
      fuel: str(p.PrimaryFuelModel),
      personnel: num(p.TotalIncidentPersonnel),
      complexity: str(p.IncidentComplexityLevel),
      state: str(p.POOState).replace(/^US-/, ''),
      prescribed: str(p.IncidentTypeCategory).toUpperCase() === 'RX',
      mapped: mappedAcres.has(id),
    });
  }
  // Biggest first: labels are drawn in this order and dropped when they collide, so the fire that
  // matters keeps its name when a cluster of small ones surrounds it.
  incidents.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));

  const hotspots: FireHotspot[] = [];
  for (const f of val(hotRes)) {
    const p = f.properties;
    if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) {
      continue;
    }
    const [lon, lat] = f.geometry.coordinates as number[];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }
    hotspots.push({
      lon,
      lat,
      frp: num(p.frp) ?? 0,
      brightnessK: num(p.bright_ti4) ?? 0,
      confidence: str(p.confidence),
      hoursOld: num(p.hours_old) ?? 0,
      night: str(p.daynight).toUpperCase() === 'N',
    });
  }

  return { incidents, perimeters, hotspots, hotspotsTruncated: hotspots.length >= cap };
}

/**
 * National forest / grassland boundaries intersecting `bbox`.
 *
 * `simplify` is passed to the server as `maxAllowableOffset` (degrees), so the generalization
 * happens upstream: the Santa Fe National Forest is 1.7M acres of very crinkly edge, and asking
 * for it at full fidelity costs megabytes to draw a line that is two pixels wide. Matching the
 * offset to the view's own scale keeps it in the tens of KB at every zoom.
 * @category Live
 */
export async function loadForestUnits(
  bbox: BBox,
  opts: { simplify?: number; signal?: AbortSignal } = {},
): Promise<ForestUnit[]> {
  const offset = opts.simplify ?? 0.002;
  const url = `${USFS}/0/query?where=1%3D1${envelope(bbox)}`
    + `&outFields=FORESTNAME,REGION,GIS_ACRES&outSR=4326&f=geojson&returnGeometry=true`
    + `&maxAllowableOffset=${offset}`;
  const features = await queryGeoJson(url, opts.signal);
  const units: ForestUnit[] = [];
  for (const f of features) {
    const rings = geometryPaths(f.geometry);
    if (rings.length === 0) {
      continue;
    }
    const p = f.properties;
    units.push({
      // The EDW layer lower-cases its field names in GeoJSON output but not in JSON output.
      name: str(pick(p, 'forestname', 'FORESTNAME')),
      region: str(pick(p, 'region', 'REGION')),
      acres: num(pick(p, 'gis_acres', 'GIS_ACRES')),
      rings,
    });
  }
  return units;
}

/**
 * Color for a detection by fire radiative power — the same yellow→white-hot ramp a thermal camera
 * implies, so "which part is burning hardest" reads without consulting a legend.
 * @category Live
 */
export function hotspotColor(frp: number): string {
  if (frp >= 100) {
    return '#fff3d0';
  }
  if (frp >= 30) {
    return '#ffd24a';
  }
  if (frp >= 10) {
    return '#ff9a2e';
  }
  return '#ff5a1f';
}

/** How much acreage reads at a glance: `8,921 ac`, `540 ac`, `0.3 ac`. @category Live */
export function formatAcres(acres: number | null): string {
  if (acres === null) {
    return 'size unreported';
  }
  if (acres >= 10) {
    return `${Math.round(acres).toLocaleString('en-US')} ac`;
  }
  return `${acres.toFixed(1)} ac`;
}
