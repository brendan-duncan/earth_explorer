/**
 * Active tropical cyclones — the official NHC / CPHC / JTWC advisory package, as geometry.
 *
 * Every other live feed here is a FIELD: a grid of numbers the renderer colors. A hurricane is
 * not that. What forecasters publish, and what people act on, is a small set of vector features —
 * where the center has been, where it is going, how wide the uncertainty is, and which coastline
 * is under a warning — so this module returns paths and polygons rather than a texture.
 *
 * Source is NOAA's own ArcGIS feature service (`Active_Hurricanes_v1`), which republishes the
 * advisory shapefiles NHC issues every six hours. It is keyless and answers with
 * `Access-Control-Allow-Origin: *`, so the browser can read it directly — the same rule every
 * other feed here follows. (`nhc.noaa.gov/CurrentStorms.json` carries the same intensity numbers
 * but sends no CORS header, so it is unusable from a page and deliberately not used.)
 *
 * Eleven service layers exist; five are fetched, because they are the five that answer a question
 * the others do not:
 *
 *  - **observed position** (1) — the six-hourly best-track fixes since genesis, each with its own
 *    intensity, which is what makes an intensity HISTORY drawable rather than just a path;
 *  - **observed track** (3) and **forecast track** (2) — the center line, past and projected;
 *  - **forecast position** (0) — the advisory's discrete forecast points, with the intensity,
 *    gust, direction and speed that the labels quote;
 *  - **error cone** (4) — the track uncertainty, which is the single most misread piece of a
 *    hurricane graphic and the one thing a bare line cannot express;
 *  - **watches and warnings** (5) — the coastline segments under alert.
 *
 * The wind-radii polygons (7–9) and the observed wind swath (11) are left alone: at the scale
 * this renders they overlap the cone almost exactly and turn it into mud.
 *
 * @category Live
 */

const SERVICE = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services'
  + '/Active_Hurricanes_v1/FeatureServer';

/** Attribution required while this data is on screen. @category Live */
export const CYCLONE_ATTRIBUTION = 'NOAA/NWS National Hurricane Center';

/** A lon/lat vertex, degrees. @category Live */
export interface LonLat { lon: number; lat: number }

/**
 * One position along a storm — a past best-track fix or an advisory forecast point.
 *
 * `windKt` is the maximum 1-minute sustained wind, which is the number the Saffir-Simpson
 * category is defined on; everything else is optional because the feeds disagree about which
 * fields they carry (a forecast point has a gust and a heading, a best-track fix does not).
 * @category Live
 */
export interface CycloneFix {
  lon: number;
  lat: number;
  /** Epoch ms this position is valid at. */
  timeMs: number;
  /** Max sustained wind, knots. */
  windKt: number;
  /** Gust, knots, when published. */
  gustKt: number | null;
  /** Minimum central pressure, mb, when published. */
  pressureMb: number | null;
  /** Heading the storm is moving toward, degrees clockwise from north; null when not published. */
  headingDeg: number | null;
  /** Forward speed, knots; null when not published. */
  speedKt: number | null;
  /** Development label as the advisory words it, e.g. "Category 1 Hurricane". */
  development: string;
  /** Local-time label from the advisory, e.g. "2026-08-15 11:00 AM Sat HST". Empty on best-track fixes. */
  label: string;
}

/** Watch/warning severities, in NHC's `TCWW` coding. @category Live */
export type CycloneAlert = 'TWA' | 'TWR' | 'HWA' | 'HWR';

/** Human labels for {@link CycloneAlert}. @category Live */
export const CYCLONE_ALERT_LABELS: Record<CycloneAlert, string> = {
  TWA: 'Tropical storm watch',
  TWR: 'Tropical storm warning',
  HWA: 'Hurricane watch',
  HWR: 'Hurricane warning',
};

/**
 * NHC's own alert colors. These are not a design choice — they are the colors the public
 * advisory graphics use, and a hurricane warning that is not red is a hurricane warning nobody
 * reads correctly. @category Live
 */
export const CYCLONE_ALERT_COLORS: Record<CycloneAlert, string> = {
  TWA: '#ffe14d',
  TWR: '#3e7bff',
  HWA: '#ff8fd0',
  HWR: '#ff3b30',
};

/** One coastline segment under a watch or warning. @category Live */
export interface CycloneAlertPath {
  code: CycloneAlert;
  path: LonLat[];
}

/** One active storm: its history, its forecast, and its uncertainty. @category Live */
export interface Cyclone {
  /** Advisory storm id, e.g. `cp012026`; falls back to `basin+number+name` when the feed omits it. */
  id: string;
  name: string;
  /** `AL`, `EP`, `CP`, `WP`, … (uppercased — the feed mixes cases across layers). */
  basin: string;
  /** Advisory number as issued, e.g. `"14"` (may carry an A/B suffix on intermediate advisories). */
  advisory: string;
  /** Epoch ms the advisory was issued. */
  advisoryTimeMs: number;
  /** Best-track fixes since genesis, oldest first. */
  observed: CycloneFix[];
  /** Advisory forecast points, soonest first (the first is the current position). */
  forecast: CycloneFix[];
  /** Center line so far. One path per feed part (a track crossing the antimeridian arrives split). */
  observedTrack: LonLat[][];
  /** Projected center line. */
  forecastTrack: LonLat[][];
  /** Error-cone rings (outer ring first per polygon; interior rings follow). */
  cone: LonLat[][];
  /** Coastline segments under watch or warning. */
  alerts: CycloneAlertPath[];
  /** Latest observed fix, or the advisory's own current position when no best track came back. */
  current: CycloneFix | null;
  /** Strongest wind anywhere in the forecast, knots — how bad this is allowed to get. */
  peakForecastKt: number;
}

/**
 * Saffir-Simpson category from sustained wind in knots: 0 for anything below hurricane force
 * (the scale simply does not define a category there), 1–5 above.
 * @category Live
 */
export function saffirSimpson(windKt: number): number {
  if (windKt >= 137) {
    return 5;
  }
  if (windKt >= 113) {
    return 4;
  }
  if (windKt >= 96) {
    return 3;
  }
  if (windKt >= 83) {
    return 2;
  }
  if (windKt >= 64) {
    return 1;
  }
  return 0;
}

/**
 * Short intensity label — the categories below hurricane force matter here too, since most of a
 * storm's plotted life is spent in them.
 * @category Live
 */
export function cycloneClass(windKt: number): string {
  const cat = saffirSimpson(windKt);
  if (cat > 0) {
    return `Cat ${cat}`;
  }
  return windKt >= 34 ? 'Trop. storm' : 'Trop. depression';
}

/**
 * Intensity color ramp: cool for the pre-hurricane stages, then the familiar yellow → red →
 * magenta hurricane progression, so a track drawn fix-by-fix reads as an intensity history.
 * @category Live
 */
export function cycloneColor(windKt: number): string {
  const RAMP = ['#7fd4ff', '#63e6b0', '#ffe14d', '#ffa53b', '#ff5f3b', '#ff2e63', '#ff4df0'];
  const cat = saffirSimpson(windKt);
  if (cat > 0) {
    return RAMP[cat + 1];
  }
  return windKt >= 34 ? RAMP[1] : RAMP[0];
}

// ── Feed decoding ──────────────────────────────────────────────────────────────────────

interface Feature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

/** The advisory feeds spell "missing" as 9999 rather than null, in every numeric field. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n === 9999 || n === -9999) {
    return null;
  }
  return n;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number';
}

/** GeoJSON position array → lon/lat path, dropping anything malformed. */
function toPath(coords: unknown): LonLat[] {
  if (!Array.isArray(coords)) {
    return [];
  }
  const out: LonLat[] = [];
  for (const c of coords) {
    if (isPair(c)) {
      out.push({ lon: c[0], lat: c[1] });
    }
  }
  return out;
}

/**
 * Flattens LineString / MultiLineString into a list of paths, and Polygon / MultiPolygon into a
 * list of rings. Both collapse to the same shape because both are drawn the same way: a sequence
 * of independent point runs, each stroked or filled on its own.
 * @category Live
 */
export function geometryPaths(geom: { type: string; coordinates: unknown } | null): LonLat[][] {
  if (!geom) {
    return [];
  }
  const paths: LonLat[][] = [];
  const push = (p: LonLat[]): void => {
    if (p.length >= 2) {
      paths.push(p);
    }
  };
  switch (geom.type) {
    case 'LineString':
      push(toPath(geom.coordinates));
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const part of (geom.coordinates as unknown[]) ?? []) {
        push(toPath(part));
      }
      break;
    case 'MultiPolygon':
      for (const poly of (geom.coordinates as unknown[]) ?? []) {
        for (const ring of (poly as unknown[]) ?? []) {
          push(toPath(ring));
        }
      }
      break;
    default:
      break;
  }
  return paths;
}

/** Groups features by storm. Names are unique among ACTIVE storms, which is all this feed holds. */
function stormKey(props: Record<string, unknown>): string {
  return str(props.STORMNAME).trim().toLowerCase();
}

/** Forecast point → fix. Valid time is the advisory time plus the point's TAU (forecast hour). */
function forecastFix(props: Record<string, unknown>, lon: number, lat: number): CycloneFix {
  const adv = num(props.ADVDATE) ?? 0;
  const tau = num(props.TAU) ?? 0;
  return {
    lon,
    lat,
    timeMs: adv + tau * 3600_000,
    windKt: num(props.MAXWIND) ?? 0,
    gustKt: num(props.GUST),
    pressureMb: num(props.MSLP),
    headingDeg: num(props.TCDIR),
    speedKt: num(props.TCSPD),
    development: str(props.ITCDVLP) || str(props.TCDVLP),
    label: str(props.FLDATELBL) || str(props.DATELBL),
  };
}

/** Best-track fix → fix. `DTG` is already epoch ms here; the rest of the fields are absent. */
function observedFix(props: Record<string, unknown>, lon: number, lat: number): CycloneFix {
  return {
    lon,
    lat,
    timeMs: num(props.DTG) ?? 0,
    windKt: num(props.INTENSITY) ?? 0,
    gustKt: null,
    pressureMb: num(props.MSLP),
    headingDeg: null,
    speedKt: null,
    development: str(props.STORMTYPE),
    label: '',
  };
}

const ALERT_CODES = new Set<string>(['TWA', 'TWR', 'HWA', 'HWR']);

/** The five queries, and the fields each one actually needs (the service returns every field otherwise). */
const QUERIES: ReadonlyArray<{ layer: number; fields: string }> = [
  { layer: 1, fields: 'STORMNAME,STORMID,BASIN,STORMNUM,DTG,MSLP,INTENSITY,STORMTYPE' },
  { layer: 0, fields: 'STORMNAME,BASIN,STORMNUM,ADVDATE,ADVISNUM,TAU,MAXWIND,GUST,MSLP,TCDIR,TCSPD,TCDVLP,ITCDVLP,DATELBL,FLDATELBL' },
  { layer: 3, fields: 'STORMNAME,STORMID,BASIN,STORMNUM' },
  { layer: 2, fields: 'STORMNAME,BASIN,STORMNUM,ADVDATE,ADVISNUM' },
  { layer: 4, fields: 'STORMNAME,BASIN,STORMNUM,ADVDATE,ADVISNUM' },
  { layer: 5, fields: 'STORMNAME,BASIN,STORMNUM,TCWW' },
];

async function queryLayer(layer: number, fields: string, signal?: AbortSignal): Promise<Feature[]> {
  const url = `${SERVICE}/${layer}/query?where=1%3D1&outFields=${encodeURIComponent(fields)}`
    + '&outSR=4326&returnGeometry=true&f=geojson';
  const r = await fetch(url, { signal, cache: 'no-cache' });
  if (!r.ok) {
    throw new Error(`hurricane layer ${layer}: HTTP ${r.status}`);
  }
  const json = await r.json() as { features?: Feature[] };
  return json.features ?? [];
}

/** Empty storm record, filled in as each layer's features arrive. */
function blankCyclone(name: string): Cyclone {
  return {
    id: '', name, basin: '', advisory: '', advisoryTimeMs: 0,
    observed: [], forecast: [], observedTrack: [], forecastTrack: [], cone: [], alerts: [],
    current: null, peakForecastKt: 0,
  };
}

/**
 * Loads every storm the advisory service currently lists, worldwide.
 *
 * Each of the six queries is independent and a failure is swallowed: a storm with a track but no
 * cone still draws correctly, and one dead layer should not blank the map during a live event —
 * which is exactly when this is being looked at. If NOTHING comes back the call throws, because
 * "no layers reachable" and "no active storms" must not look the same to the caller.
 * @category Live
 */
export async function loadActiveCyclones(opts: { signal?: AbortSignal } = {}): Promise<Cyclone[]> {
  const results = await Promise.allSettled(
    QUERIES.map((q) => queryLayer(q.layer, q.fields, opts.signal)),
  );
  if (results.every((r) => r.status === 'rejected')) {
    const first = results[0] as PromiseRejectedResult;
    throw new Error(String((first.reason as Error)?.message ?? 'hurricane service unreachable'));
  }
  const at = (i: number): Feature[] => (results[i].status === 'fulfilled'
    ? (results[i] as PromiseFulfilledResult<Feature[]>).value : []);

  const storms = new Map<string, Cyclone>();
  const get = (props: Record<string, unknown>): Cyclone | null => {
    const key = stormKey(props);
    if (!key) {
      return null;
    }
    let c = storms.get(key);
    if (!c) {
      c = blankCyclone(str(props.STORMNAME).trim());
      storms.set(key, c);
    }
    // Identity fields are spread across layers (only the best-track ones carry STORMID), so take
    // whichever arrives first and never let a later, emptier feature clear it.
    if (!c.id) {
      c.id = str(props.STORMID).toLowerCase();
    }
    if (!c.basin) {
      c.basin = str(props.BASIN).toUpperCase();
    }
    return c;
  };

  // Observed positions (best track).
  for (const f of at(0)) {
    const c = get(f.properties);
    if (c && f.geometry?.type === 'Point' && isPair(f.geometry.coordinates)) {
      const [lon, lat] = f.geometry.coordinates;
      c.observed.push(observedFix(f.properties, lon, lat));
    }
  }
  // Forecast positions. These carry the advisory identity, so record it here.
  for (const f of at(1)) {
    const c = get(f.properties);
    if (!c) {
      continue;
    }
    c.advisory = str(f.properties.ADVISNUM) || c.advisory;
    c.advisoryTimeMs = num(f.properties.ADVDATE) ?? c.advisoryTimeMs;
    if (f.geometry?.type === 'Point' && isPair(f.geometry.coordinates)) {
      const [lon, lat] = f.geometry.coordinates;
      c.forecast.push(forecastFix(f.properties, lon, lat));
    }
  }
  for (const f of at(2)) {
    const c = get(f.properties);
    if (c) {
      c.observedTrack.push(...geometryPaths(f.geometry));
    }
  }
  for (const f of at(3)) {
    const c = get(f.properties);
    if (c) {
      c.forecastTrack.push(...geometryPaths(f.geometry));
    }
  }
  for (const f of at(4)) {
    const c = get(f.properties);
    if (c) {
      c.cone.push(...geometryPaths(f.geometry));
    }
  }
  for (const f of at(5)) {
    const c = get(f.properties);
    const code = str(f.properties.TCWW).toUpperCase();
    if (!c || !ALERT_CODES.has(code)) {
      continue;
    }
    for (const path of geometryPaths(f.geometry)) {
      c.alerts.push({ code: code as CycloneAlert, path });
    }
  }

  for (const c of storms.values()) {
    c.observed.sort((a, b) => a.timeMs - b.timeMs);
    c.forecast.sort((a, b) => a.timeMs - b.timeMs);
    // The best track's last fix leads the advisory's own T=0 point by up to three hours (it is
    // updated on the intermediate cycle), so it is the better "where it is right now" — but it
    // carries no heading, speed or gust, which are exactly the numbers a "currently approaching"
    // question is about. Those come from the advisory's own T=0 point, which describes the same
    // storm at the same cycle; the fields are merged rather than written back into `observed`, so
    // the best track stays what the best track actually says.
    const last = c.observed[c.observed.length - 1];
    const t0 = c.forecast[0];
    c.current = last
      ? (t0 ? { ...last, headingDeg: last.headingDeg ?? t0.headingDeg, speedKt: last.speedKt ?? t0.speedKt, gustKt: last.gustKt ?? t0.gustKt } : last)
      : t0 ?? null;
    c.peakForecastKt = c.forecast.reduce((m, f) => Math.max(m, f.windKt), 0);
    if (!c.id) {
      // Only the best-track layers publish STORMID; a storm seen through the forecast layers
      // alone still needs a stable key.
      c.id = `${c.basin.toLowerCase()}-${c.name.toLowerCase()}`;
    }
  }
  // Strongest first: on a busy day the storm that matters should be the one named in the status
  // line, and "strongest" beats "whatever order ArcGIS returned".
  return [...storms.values()].sort((a, b) => {
    const aw = a.current?.windKt ?? 0, bw = b.current?.windKt ?? 0;
    return bw - aw;
  });
}
