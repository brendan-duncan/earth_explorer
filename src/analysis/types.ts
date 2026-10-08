/**
 * Value model for the geo analysis graph (TODO/geo-analysis-graph.md).
 *
 * Programs are dataflow DAGs whose edges carry one of five value types. Fields cross the
 * analysis boundary as DECODED PHYSICAL floats (NaN = land/no-data) on a fixed 1° equirect
 * grid — never the normalized bytes {@link "../live/gridded_field.ts".GriddedField} stores — so
 * ops are unit-preserving arithmetic with no knowledge of display ranges, and derived values
 * (an anomaly, a correlation) are not clamped to any source layer's legend.
 *
 * Everything here is plain data: no DOM, no GPU, no fetch. Values must survive a
 * `postMessage` to a Worker (typed arrays transfer; the rest is structured-cloneable).
 *
 * @category Analysis
 */

/** Physical unit riding a value; sinks map these to formatters. @category Analysis */
export type Unit =
  | 'degC'      // sea-surface / air temperature
  | 'm'         // wave height
  | 'mps'       // wind / current speed (and u, v components)
  | 'percent'   // sea-ice concentration, humidity (0–100)
  | 'mgm3'      // chlorophyll-a
  | 'hpa'       // sea-level pressure (converted from Pa at ingestion)
  | 'wm2'       // radiative flux (shortwave / longwave)
  | 'mmph'      // rainfall rate
  | 'mmpd'      // daily rainfall total
  | 'degCwk'    // coral-reef heat stress (degree heating weeks)
  | 's'         // wave period
  | 'deg'       // a geographic angle — latitude/longitude of a measured boundary
  | 'h'         // hours (vessel activity)
  | 'r'         // correlation coefficient
  | 'none';     // dimensionless / mixed

/** The five edge types of the graph. @category Analysis */
export type ValueType = 'scalar' | 'series' | 'field' | 'stack' | 'region';

/** All fields are resampled onto this fixed 1° grid on entry (row 0 = north). */
export const ANALYSIS_WIDTH = 360;
export const ANALYSIS_HEIGHT = 180;

/** Minimum valid samples for per-cell temporal statistics (correlation, trend). */
export const MIN_TEMPORAL_SAMPLES = 8;

/**
 * Per-cell uncertainty for an ESTIMATED field — a trend, a correlation — as opposed to an
 * observed one. Without this a slope fitted from 5 frames renders identically to one fitted
 * from 400, which is how a map of noise gets published as a finding.
 *
 * Degrees of freedom are always the autocorrelation-discounted {@link nEff}, never the raw
 * frame count: see `stats.ts`.
 * @category Analysis
 */
export interface FieldUncertainty {
  /** Standard error of each cell's estimate, in the field's own units. NaN where untestable. */
  stderr: Float32Array;
  /** Two-sided p-value per cell against "the estimate is zero". NaN = not testable, which is
   *  NOT the same as "not significant" and must not be rendered as though it were. */
  pValue: Float32Array;
  /** Raw samples behind each cell. */
  n: Int32Array;
  /** Samples after the lag-1 autocorrelation discount — the actual degrees of freedom + 2. */
  nEff: Float32Array;
  /** One line naming the test, for legends, answers and CSV provenance. */
  method: string;
}

/**
 * A CPU-only field on the analysis grid. Decoupled from GriddedField so it can cross a
 * Worker boundary and carry values outside any layer's display range.
 * @category Analysis
 */
export interface CpuField {
  width: number;
  height: number;
  /** ISO date (`YYYY-MM-DD` or full ISO), or a span label (`2016–2026`) for reductions. */
  date: string;
  /** Physical value per cell, row-major, row 0 = north. NaN = land/no-data. */
  values: Float32Array;
  unit: Unit;
  /** Δ-like quantity (anomaly, difference, trend): °F conversion scales without offset. */
  relative: boolean;
  /**
   * Per-cell uncertainty, when the values are a fitted estimate. MUST be dropped by any op that
   * changes `values` — a standard error that has drifted away from the numbers it describes is
   * worse than none, because it still looks like evidence. Use {@link withValues}.
   */
  uncertainty?: FieldUncertainty;
  /**
   * One line about a derivation the numbers alone don't reveal — which climatology an anomaly was
   * taken against, which significance filter was applied. Propagated into legends and CSV headers.
   */
  note?: string;
  /** True when the quantity legitimately exists over land (weather fields), false for water-only
   *  ones (sea temperature, chlorophyll, waves). A host uses it to decide whether a derived map may
   *  be painted across continents: an ocean field drawn over land reads as garbage, because on the
   *  coarse analysis grid every coastal cell overlaps a lot of shoreline and bleeds inland. */
  overLand?: boolean;
}

/** A date-sorted stack of fields (one layer over time). @category Analysis */
export interface CpuStack {
  frames: CpuField[];
}

/**
 * How much the cells behind a spatial reduction disagreed, per sample.
 *
 * `sd` is the SPREAD OF THE REGION, not a confidence interval on the mean. There is deliberately
 * no standard error here: grid cells a degree apart are strongly spatially autocorrelated, so
 * `sd/√n` would understate the true uncertainty by a large and unknown factor. Reporting the
 * spread is honest; reporting a fake CI is the error this module exists to prevent.
 * @category Analysis
 */
export interface SeriesSpread {
  /** cos(lat)-weighted standard deviation across the valid cells behind each sample. */
  sd: Float64Array;
  /** Valid cells behind each sample. */
  n: Float64Array;
  /** Valid cells ÷ cells inside the region: 1 = fully covered, 0.2 = mostly land or no-data. */
  coverage: Float64Array;
}

/** A time series. @category Analysis */
export interface SeriesValue {
  /** Epoch-ms per sample, ascending. */
  t: Float64Array;
  v: Float64Array;
  unit: Unit;
  relative: boolean;
  label: string;
  /** Per-sample spread and coverage, when the series came from a spatial reduction. */
  spread?: SeriesSpread;
  /** One line about a derivation the numbers alone don't reveal (see CpuField.note). */
  note?: string;
}

/** A single number with provenance. @category Analysis */
export interface ScalarValue {
  v: number;
  unit: Unit;
  relative: boolean;
  label: string;
  /** Sample count behind the number (pairs or cells), when meaningful. */
  n?: number;
  /** Effective sample count after the autocorrelation discount — the basis of {@link p}. */
  nEff?: number;
  /** Two-sided p-value, when this number is a test statistic. Absent when no valid test exists
   *  (e.g. a spatial correlation, where the samples are not independent). */
  p?: number;
  /** Spread of the samples behind the number — see {@link SeriesSpread.sd}. */
  sd?: number;
  /** Valid fraction of the region, for spatial reductions. */
  coverage?: number;
  /** One line about a derivation the number alone doesn't reveal (see CpuField.note). */
  note?: string;
}

/**
 * Copies a field with new values, DROPPING any per-cell uncertainty.
 *
 * Every op that changes `values` must go through this rather than `{ ...f, values }`: an object
 * spread silently carries the old field's standard errors and p-values onto numbers they no longer
 * describe, and the result still renders as though it had been tested.
 * @category Analysis
 */
export function withValues(f: CpuField, values: Float32Array, patch?: Partial<CpuField>): CpuField {
  const out: CpuField = { ...f, values };
  // Drop BEFORE the patch, never after: an op that recomputes the uncertainty in step with the new
  // values (mask) passes it in, and deleting afterwards would silently throw that away.
  delete out.uncertainty;
  return patch ? { ...out, ...patch } : out;
}

/** Named region presets (bboxes; lonMin > lonMax means the box crosses the antimeridian). */
export type RegionPresetName =
  | 'nino34' | 'tropics' | 'arctic' | 'southern-ocean'
  | 'gulf-stream' | 'north-atlantic' | 'north-pacific';

/** A lon/lat box. `lonMin > lonMax` wraps across the antimeridian. @category Analysis */
export interface Bbox {
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
}

/** @category Analysis */
export type RegionValue =
  | ({ kind: 'bbox' } & Bbox)
  | { kind: 'preset'; name: RegionPresetName }
  /** A closed ring of `[lon, lat]` vertices — what a user draws on the map. */
  | { kind: 'polygon'; points: Array<[number, number]> };

/** Preset definitions (Niño 3.4 matches the explorer's shader box exactly). */
export const REGION_PRESETS: Record<RegionPresetName, Bbox> = {
  'nino34': { lonMin: -170, latMin: -5, lonMax: -120, latMax: 5 },
  'tropics': { lonMin: -180, latMin: -23.5, lonMax: 180, latMax: 23.5 },
  'arctic': { lonMin: -180, latMin: 66.5, lonMax: 180, latMax: 90 },
  'southern-ocean': { lonMin: -180, latMin: -90, lonMax: 180, latMax: -50 },
  'gulf-stream': { lonMin: -80, latMin: 25, lonMax: -40, latMax: 45 },
  'north-atlantic': { lonMin: -80, latMin: 0, lonMax: 0, latMax: 65 },
  'north-pacific': { lonMin: 120, latMin: 0, lonMax: -100, latMax: 65 },   // wraps
};

/**
 * Unwraps a ring's longitudes so consecutive vertices are never more than 180° apart, letting a
 * polygon drawn across the antimeridian stay one contiguous shape instead of springing across the
 * whole map. The first vertex keeps its value; the rest may leave [−180, 180].
 * @category Analysis
 */
export function unwrapRing(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let prev = points.length ? points[0][0] : 0;
  for (const [lon, lat] of points) {
    const u = lon - 360 * Math.round((lon - prev) / 360);
    out.push([u, lat]);
    prev = u;
  }
  return out;
}

/**
 * Parses a polygon ring written as `"lon,lat lon,lat …"`. Params in this language are only
 * string/number/boolean, so a drawn shape travels as one compact string that survives `?prog=`
 * links and is legible enough for an LLM to write by hand. Malformed vertices are skipped.
 * @category Analysis
 */
export function parseRing(spec: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of spec.trim().split(/\s+/)) {
    const parts = tok.split(',');
    // Both halves must be present AND non-empty: Number('') is 0, so a trailing "50," would
    // otherwise parse as a perfectly plausible vertex on the equator.
    if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') {
      continue;
    }
    const lon = Number(parts[0]), lat = Number(parts[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      out.push([lon, lat]);
    }
  }
  return out;
}

/** Formats a ring for the `points` param / a share link. @category Analysis */
export function formatRing(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([lon, lat]) => `${lon.toFixed(3)},${lat.toFixed(3)}`).join(' ');
}

/** Resolves a region value to its bbox. @category Analysis */
export function regionBbox(region: RegionValue): Bbox {
  if (region.kind === 'bbox') {
    return region;
  }
  if (region.kind === 'preset') {
    return REGION_PRESETS[region.name];
  }
  // For a polygon this is an ENVELOPE, not the region: callers use the latitude bounds as a cheap
  // per-row reject and must still call inRegion per cell. The longitude bounds are folded back into
  // [−180, 180] (so they read as the usual wrapping form) and are advisory only — a ring drawn
  // around a pole has no meaningful longitude extent at all.
  const ring = unwrapRing(region.points);
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const [lon, lat] of ring) {
    lonMin = Math.min(lonMin, lon); lonMax = Math.max(lonMax, lon);
    latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
  }
  const fold = (x: number): number => ((((x + 180) % 360) + 360) % 360) - 180;
  return { lonMin: fold(lonMin), lonMax: fold(lonMax), latMin, latMax };
}

/**
 * Point-in-region test: the bbox forms for boxes and presets, an even-odd ray cast for polygons.
 * Every spatial reduction goes through this, so a drawn shape restricts a statistic the same way a
 * typed box does. @category Analysis
 */
export function inRegion(lonDeg: number, latDeg: number, region: RegionValue): boolean {
  if (region.kind !== 'polygon') {
    return inBbox(lonDeg, latDeg, regionBbox(region));
  }
  const ring = unwrapRing(region.points);
  if (ring.length < 3) {
    return false;
  }
  // Test the cell longitude in the ring's own unwrapped frame — including the ±360 copies, so a
  // ring that crosses the antimeridian still catches cells on both sides of it.
  const base = ring[0][0];
  for (const shift of [0, 360, -360]) {
    const lon = lonDeg - 360 * Math.round((lonDeg + shift - base) / 360) + shift;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > latDeg) !== (yj > latDeg)
        && lon < ((xj - xi) * (latDeg - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) {
      return true;
    }
  }
  return false;
}

/** A value flowing along a graph edge. @category Analysis */
export type Value =
  | { kind: 'scalar'; scalar: ScalarValue }
  | { kind: 'series'; series: SeriesValue }
  | { kind: 'field'; field: CpuField }
  | { kind: 'stack'; stack: CpuStack }
  | { kind: 'region'; region: RegionValue };

/** The edge type of a value. @category Analysis */
export function valueType(v: Value): ValueType {
  return v.kind;
}

// ── Grid geometry ────────────────────────────────────────────────────────────────────

/** Longitude of column `x`'s center on a `width`-column equirect grid. */
export function lonAt(x: number, width: number): number {
  return -180 + ((x + 0.5) / width) * 360;
}

/** Latitude of row `y`'s center (row 0 = north). */
export function latAt(y: number, height: number): number {
  return 90 - ((y + 0.5) / height) * 180;
}

/** Area weight of row `y` — equirect cells shrink poleward by cos(lat). */
export function rowWeight(y: number, height: number): number {
  return Math.cos((latAt(y, height) * Math.PI) / 180);
}

/** True when (lon, lat) falls inside the bbox, handling antimeridian wrap. */
export function inBbox(lonDeg: number, latDeg: number, b: Bbox): boolean {
  if (latDeg < b.latMin || latDeg > b.latMax) {
    return false;
  }
  if (b.lonMin <= b.lonMax) {
    return lonDeg >= b.lonMin && lonDeg <= b.lonMax;
  }
  return lonDeg >= b.lonMin || lonDeg <= b.lonMax;   // wraps across ±180
}

// ── Date helpers ─────────────────────────────────────────────────────────────────────

/** Epoch-ms of a frame date: bare `YYYY-MM-DD` pins to 12:00Z (matching the explorer). */
export function frameEpoch(date: string): number {
  return Date.parse(date.includes('T') ? date : `${date}T12:00:00Z`);
}

/**
 * Shifts a `YYYY-MM-DD` (or full ISO) date by whole months, clamping the day-of-month to
 * the target month's length. Returns a bare `YYYY-MM-DD`.
 */
export function addMonthsToDate(date: string, months: number): string {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(5, 7), 10) - 1;
  const d = parseInt(date.slice(8, 10), 10) || 1;
  const total = y * 12 + m + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny.toString().padStart(4, '0')}-${(nm + 1).toString().padStart(2, '0')}-${nd.toString().padStart(2, '0')}`;
}

/** Shifts an epoch-ms timestamp by whole months (UTC calendar arithmetic, day clamped). */
export function addMonthsToEpoch(t: number, months: number): number {
  const date = new Date(t);
  const day = date.getUTCDate();
  const target = new Date(t);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}
