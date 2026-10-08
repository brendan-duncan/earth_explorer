/**
 * Op implementations for the geo analysis graph (TODO/geo-analysis-graph.md §3).
 *
 * Every op is a pure function over the value model — inputs are NEVER mutated (results may
 * share input typed arrays only when the op provably doesn't change them, e.g. `lag`), so
 * the interpreter's memo cache can hand the same value to many consumers. No DOM, no GPU,
 * no fetch: this module runs unchanged in a Worker.
 *
 * Conventions encoded once, for every op:
 *  - spatial reductions are cos(lat)-weighted (equirect cells shrink poleward);
 *  - stacks pair frames by NEAREST DATE within max(16 days, half the coarser cadence);
 *  - per-cell temporal statistics need ≥ {@link MIN_TEMPORAL_SAMPLES} samples, else NaN;
 *  - invalid cells are NaN and validity intersects through binary ops.
 *
 * @category Analysis
 */

import type { AnalysisNode, ParamValue } from './ast.js';
import {
  MIN_TEMPORAL_SAMPLES, frameEpoch, addMonthsToDate, addMonthsToEpoch,
  inRegion, latAt, lonAt, parseRing, regionBbox, rowWeight, withValues,
  type CpuField, type CpuStack, type RegionValue, type ScalarValue, type SeriesValue,
  type Unit, type Value,
} from './types.js';
import {
  correlationPValue, effectiveSampleSize, lag1Autocorrelation, studentTTwoSided, trendFitFromSums,
} from './stats.js';

// ── Sink results ─────────────────────────────────────────────────────────────────────

/** What the map should show for a `display` sink. @category Analysis */
export interface LegendSpec {
  title: string;
  colormap: string;
  min: number;
  max: number;
  unit: Unit;
  relative: boolean;
}

/** @category Analysis */
export interface DisplayResult {
  kind: 'display';
  node: string;
  fields: CpuField[];
  legend: LegendSpec;
  /** The displayed quantity exists over land, so the host may paint it across continents. False for
   *  water-only results — see CpuField.overLand. */
  overLand: boolean;
  /** Derivation caveats for the displayed quantity — which climatology, which significance filter,
   *  which test. The host shows these with the legend: a map that has silently dropped its
   *  insignificant cells looks exactly like one that had none. */
  notes?: string[];
  /**
   * Per-frame, per-cell marker: 1 where the estimate FAILED its significance test, 0 where it
   * passed or was never tested. Parallel to `fields`, same cell order.
   *
   * This is the honest alternative to blanking. A blanked map cannot distinguish "no trend here"
   * from "no data here", and it throws away the estimate entirely; a marked map shows the value and
   * says the evidence for it is weak. Present only when the `stipple` param asked for it AND the
   * input carried per-cell uncertainty.
   */
  insignificant?: Uint8Array[];
  /** Second quantity to draw over the base as iso-lines (the `over` input), if one was wired. */
  overlay?: {
    fields: CpuField[];
    legend: LegendSpec;
    /** Iso-line count. */
    bands: number;
    /** Physical value above which to hatch, or undefined for lines only. */
    hatchAt?: number;
  };
}

/** @category Analysis */
export interface ChartResult {
  kind: 'chart';
  node: string;
  title: string;
  series: SeriesValue[];
  /** Derivation caveats behind the plotted series (coverage, baseline). */
  notes?: string[];
}

/** Summary statistics an LLM (or status line) needs to narrate a value it can't see. */
export type AnswerPayload =
  | {
      type: 'scalar'; value: number; unit: Unit; relative: boolean; n?: number;
      /** Independent samples after the autocorrelation discount, when the number was tested. */
      nEff?: number;
      /** Two-sided p-value, when a valid test exists. Absent means UNTESTED, not "not significant". */
      p?: number;
      /** Spread of the samples behind the number (not a confidence interval — see SeriesSpread). */
      sd?: number;
      /** Valid fraction of the region, for spatial reductions. */
      coverage?: number;
    }
  | {
      type: 'series'; label: string; unit: Unit; relative: boolean; n: number;
      start: string; end: string; min: number; max: number; mean: number;
      /** Mean within-region spread across samples, when the series came from a spatial reduction. */
      meanSd?: number;
      /** Worst per-sample coverage — the number that says whether the series is trustworthy. */
      minCoverage?: number;
    }
  | {
      type: 'field'; date: string; unit: Unit; relative: boolean; cells: number; validFraction: number;
      areaWeightedMean: number; meanAbs: number; p5: number; p95: number;
      /** Grid-wide statistics overstate independence — narrate as association, not significance. */
      spatiallyAutocorrelated: true;
      /** Present only for ESTIMATED fields (trend, temporal correlation) that carry per-cell tests. */
      significance?: {
        method: string;
        /** Cells where a test could be run at all. */
        tested: number;
        /** Of those, the fraction with p ≤ 0.05 and ≤ 0.01. */
        fractionP05: number;
        fractionP01: number;
        /** Median effective sample size across tested cells — the real degrees of freedom + 2. */
        medianNEff: number;
      };
    };

/** @category Analysis */
export interface AnswerResult {
  kind: 'answer';
  node: string;
  label: string;
  payload: AnswerPayload;
  /** Derivation caveats the numbers don't carry — which climatology, which coverage, which test.
   *  A consumer that narrates the value must narrate these too. */
  notes?: string[];
}

/** Scatter of two paired variables + least-squares fit. @category Analysis */
export interface ScatterResult {
  kind: 'scatter';
  node: string;
  title: string;
  /** 'temporal' = dots are time steps; 'spatial' = dots are grid cells. */
  mode: 'temporal' | 'spatial';
  xLabel: string;
  yLabel: string;
  xUnit: Unit;
  yUnit: Unit;
  xRelative: boolean;
  yRelative: boolean;
  x: Float64Array;
  y: Float64Array;
  /** Optional third variable per plotted point, mapped to dot colour (a property-property plot). */
  c?: Float64Array;
  cLabel?: string;
  cUnit?: Unit;
  cRelative?: boolean;
  r: number;
  slope: number;
  intercept: number;
  /** Pairs behind the fit (≥ plotted points in cell mode — the fit uses ALL valid pairs). */
  n: number;
}

/** Weighted value distribution of a field/stack. @category Analysis */
export interface HistogramResult {
  kind: 'histogram';
  node: string;
  title: string;
  unit: Unit;
  relative: boolean;
  /** bins+1 ascending edges. */
  edges: Float64Array;
  /** Weighted fraction per bin (sums to 1). */
  counts: Float64Array;
  n: number;
  mean: number;
  min: number;
  max: number;
}

/** Longitude/latitude × time heatmap. @category Analysis */
export interface HovmollerResult {
  kind: 'hovmoller';
  node: string;
  title: string;
  axis: 'lon' | 'lat';
  /** Columns along `axis`; rows are frames (oldest first). NaN = no valid cells. */
  width: number;
  height: number;
  values: Float32Array;
  dates: string[];
  /** Axis coordinate of column 0 and per-column step, degrees. */
  axisStart: number;
  axisStep: number;
  unit: Unit;
  relative: boolean;
  /** Legend range (p2..p98; symmetric for relative/r values). */
  min: number;
  max: number;
}

/** Extrema markers for the map. @category Analysis */
export interface AnnotateResult {
  kind: 'annotate';
  node: string;
  label: string;
  unit: Unit;
  relative: boolean;
  date: string;
  markers: Array<{ lon: number; lat: number; value: number; kind: 'max' | 'min' }>;
}

/** A vector field to draw as map arrows. @category Analysis */
export interface VectorsResult {
  kind: 'vectors';
  node: string;
  title: string;
  width: number;
  height: number;
  /** Eastward / northward components on the analysis grid (time-mean of stack inputs). */
  u: Float32Array;
  v: Float32Array;
  unit: Unit;
  /** p98 magnitude — the arrow-length normalizer. */
  maxMag: number;
  strideDeg: number;
  scale: number;
}

/** @category Analysis */
export type SinkResult = DisplayResult | ChartResult | AnswerResult
  | ScatterResult | HistogramResult | HovmollerResult | AnnotateResult | VectorsResult;

/** A data-dependent failure inside an op (validation passed, the data didn't). */
export class OpError extends Error {
  constructor(readonly node: string, message: string) {
    super(message);
    this.name = 'OpError';
  }
}

// ── Input coercion (validation guarantees these; the throws are internal-error guards) ──

function port(inputs: Record<string, Value>, name: string, node: string): Value {
  const v = inputs[name];
  if (!v) {
    throw new OpError(node, `internal: missing input "${name}"`);
  }
  return v;
}

function asStack(inputs: Record<string, Value>, name: string, node: string): CpuStack {
  const v = port(inputs, name, node);
  if (v.kind !== 'stack') {
    throw new OpError(node, `internal: input "${name}" is a ${v.kind}, expected stack`);
  }
  return v.stack;
}

function asSeries(inputs: Record<string, Value>, name: string, node: string): SeriesValue {
  const v = port(inputs, name, node);
  if (v.kind !== 'series') {
    throw new OpError(node, `internal: input "${name}" is a ${v.kind}, expected series`);
  }
  return v.series;
}

function asRegion(inputs: Record<string, Value>, name: string, node: string): RegionValue {
  const v = port(inputs, name, node);
  if (v.kind !== 'region') {
    throw new OpError(node, `internal: input "${name}" is a ${v.kind}, expected region`);
  }
  return v.region;
}

function sameGrid(a: CpuField, b: CpuField, node: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new OpError(node, `grid mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height} — resample sources onto one analysis grid`);
  }
}

// ── Shared numerics ──────────────────────────────────────────────────────────────────

const DAY_MS = 86400e3;
const MIN_PAIR_TOLERANCE_MS = 16 * DAY_MS;

function medianStepMs(epochs: number[]): number {
  if (epochs.length < 2) {
    return 0;
  }
  const steps = [];
  for (let i = 1; i < epochs.length; i++) {
    steps.push(epochs[i] - epochs[i - 1]);
  }
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/** Nearest-date pairing tolerance: half the coarser cadence, at least 16 days. */
function pairToleranceMs(ea: number[], eb: number[]): number {
  return Math.max(MIN_PAIR_TOLERANCE_MS, Math.max(medianStepMs(ea), medianStepMs(eb)) / 2);
}

/** Pairs two ascending epoch lists by nearest neighbor within tolerance (each b used once). */
function pairByTime(ea: number[], eb: number[]): Array<[number, number]> {
  const tol = pairToleranceMs(ea, eb);
  const pairs: Array<[number, number]> = [];
  let j = 0;
  for (let i = 0; i < ea.length && j < eb.length; i++) {
    while (j + 1 < eb.length && Math.abs(eb[j + 1] - ea[i]) < Math.abs(eb[j] - ea[i])) {
      j++;
    }
    if (Math.abs(eb[j] - ea[i]) <= tol) {
      pairs.push([i, j]);
      j++;
    }
  }
  return pairs;
}

function pairFrames(a: CpuStack, b: CpuStack): Array<[number, number]> {
  return pairByTime(a.frames.map((f) => frameEpoch(f.date)), b.frames.map((f) => frameEpoch(f.date)));
}

interface Pearson { r: number; n: number; }

/** (Optionally weighted) Pearson correlation over paired samples. */
function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>, ws?: ArrayLike<number>): Pearson {
  let sw = 0, sx = 0, sy = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws ? ws[i] : 1;
    sw += w; sx += w * xs[i]; sy += w * ys[i];
    n++;
  }
  if (n === 0 || sw <= 0) {
    return { r: NaN, n };
  }
  const mx = sx / sw, my = sy / sw;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws ? ws[i] : 1;
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += w * dx * dy; vx += w * dx * dx; vy += w * dy * dy;
  }
  const den = Math.sqrt(vx * vy);
  return { r: den > 0 ? cov / den : NaN, n };
}

function dateSpanLabel(frames: CpuField[]): string {
  if (frames.length === 0) {
    return '';
  }
  const first = frames[0].date.slice(0, 10);
  const last = frames[frames.length - 1].date.slice(0, 10);
  return first === last ? first : `${first}–${last}`;
}

/** Sampled valid values across fields (bounded), sorted — for percentile legends/summaries. */
function sampleValid(fields: CpuField[], cap = 200_000): Float64Array {
  const total = fields.reduce((s, f) => s + f.values.length, 0);
  const stride = Math.max(1, Math.ceil(total / cap));
  const out: number[] = [];
  let k = 0;
  for (const f of fields) {
    for (let i = 0; i < f.values.length; i++, k++) {
      if (k % stride === 0 && Number.isFinite(f.values[i])) {
        out.push(f.values[i]);
      }
    }
  }
  return new Float64Array(out.sort((a, b) => a - b));
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) {
    return NaN;
  }
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** A spatial reduction and the coverage behind it. @category Analysis */
export interface SpatialStats {
  /** cos(lat)-weighted mean over valid cells. */
  mean: number;
  /** cos(lat)-weighted standard deviation over those cells — the region's SPREAD, not a
   *  confidence interval on the mean (grid cells are far from independent; see SeriesSpread). */
  sd: number;
  /** Valid cells. */
  n: number;
  /** Cells inside the region, valid or not. */
  cells: number;
  /** n / cells. A mean over a polygon that is 80% land must not look as solid as a full one. */
  coverage: number;
}

/**
 * cos(lat)-weighted mean, spread and coverage over valid cells, optionally inside a region.
 * One pass accumulates both moments; the variance is the weighted-mean-of-squares form, clamped
 * at zero so float cancellation can't produce a negative variance on a near-constant field.
 */
function weightedStats(field: CpuField, region: RegionValue | null): SpatialStats {
  // bbox is the cheap per-ROW reject; `inside` is the exact per-cell test (a polygon needs it).
  const bbox = region ? regionBbox(region) : null;
  const inside = region ? (lon: number, lat: number): boolean => inRegion(lon, lat, region) : null;
  let sum = 0, sumSq = 0, sw = 0, n = 0, cells = 0;
  for (let y = 0; y < field.height; y++) {
    const w = rowWeight(y, field.height);
    const lat = latAt(y, field.height);
    if (bbox && (lat < bbox.latMin || lat > bbox.latMax)) {
      continue;
    }
    for (let x = 0; x < field.width; x++) {
      if (inside && !inside(lonAt(x, field.width), lat)) {
        continue;
      }
      cells++;
      const v = field.values[y * field.width + x];
      if (!Number.isFinite(v)) {
        continue;
      }
      sum += w * v; sumSq += w * v * v; sw += w; n++;
    }
  }
  if (!(sw > 0)) {
    return { mean: NaN, sd: NaN, n: 0, cells, coverage: 0 };
  }
  const mean = sum / sw;
  const variance = Math.max(0, sumSq / sw - mean * mean);
  return { mean, sd: n > 1 ? Math.sqrt(variance) : NaN, n, cells, coverage: cells > 0 ? n / cells : 0 };
}

/** cos(lat)-weighted mean over valid cells — the reduction alone, for callers that want no stats. */
function weightedMean(field: CpuField, region: RegionValue | null): { mean: number; n: number } {
  const s = weightedStats(field, region);
  return { mean: s.mean, n: s.n };
}

/**
 * The one line a spatial mean must carry: how much of the region actually had data. A mean over a
 * polygon that is four-fifths land is a real number about a fifth of the area the user drew, and
 * nothing about the number itself says so.
 */
function coverageNote(s: SpatialStats, upstream: string | undefined, whose = ''): string | undefined {
  const parts: string[] = [];
  if (upstream) {
    parts.push(upstream);
  }
  if (s.cells > 0) {
    const pct = (s.coverage * 100).toFixed(0);
    parts.push(`${s.n} of ${s.cells} cells had data${whose ? ` in the ${whose}` : ''} (${pct}% coverage)`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** Time-mean field of a stack (the spatial-correlate reduction). */
function timeMeanField(stack: CpuStack, node: string): CpuField {
  if (stack.frames.length === 0) {
    throw new OpError(node, 'empty stack — no frames in the requested window');
  }
  const f0 = stack.frames[0];
  const len = f0.values.length;
  const sum = new Float64Array(len);
  const cnt = new Int32Array(len);
  for (const f of stack.frames) {
    sameGrid(f0, f, node);
    for (let i = 0; i < len; i++) {
      const v = f.values[i];
      if (Number.isFinite(v)) {
        sum[i] += v; cnt[i]++;
      }
    }
  }
  const values = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    values[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  }
  return { width: f0.width, height: f0.height, date: dateSpanLabel(stack.frames), values, unit: f0.unit, relative: f0.relative, overLand: f0.overLand };
}

// ── The ops ──────────────────────────────────────────────────────────────────────────

function opMask(node: AnalysisNode, inputs: Record<string, Value>): Value {
  const region = asRegion(inputs, 'region', node.id);
  // A drawn polygon restricts exactly like a box does — same call, different region kind.
  const maskField = (f: CpuField): CpuField => {
    const values = new Float32Array(f.values.length);
    // Masking keeps the surviving values bit-for-bit, so their uncertainty stays valid and travels
    // with them — masking a trend map to a study region is exactly what a region-scoped result is.
    // The dropped cells are blanked in lockstep so no cell claims a test it no longer has.
    const u = f.uncertainty;
    const un = u && {
      stderr: new Float32Array(u.stderr.length), pValue: new Float32Array(u.pValue.length),
      n: new Int32Array(u.n.length), nEff: new Float32Array(u.nEff.length), method: u.method,
    };
    for (let y = 0; y < f.height; y++) {
      const lat = latAt(y, f.height);
      for (let x = 0; x < f.width; x++) {
        const i = y * f.width + x;
        const keep = inRegion(lonAt(x, f.width), lat, region);
        values[i] = keep ? f.values[i] : NaN;
        if (u && un) {
          un.stderr[i] = keep ? u.stderr[i] : NaN;
          un.pValue[i] = keep ? u.pValue[i] : NaN;
          un.n[i] = keep ? u.n[i] : 0;
          un.nEff[i] = keep ? u.nEff[i] : 0;
        }
      }
    }
    return withValues(f, values, un ? { uncertainty: un } : undefined);
  };
  const v = port(inputs, 'value', node.id);
  if (v.kind === 'field') {
    return { kind: 'field', field: maskField(v.field) };
  }
  if (v.kind === 'stack') {
    return { kind: 'stack', stack: { frames: v.stack.frames.map(maskField) } };
  }
  throw new OpError(node.id, `internal: mask over ${v.kind}`);
}

/** Per-cell mean over a chosen subset of frames — the climatology an anomaly is taken against. */
function climatologyField(frames: CpuField[], node: string): Float32Array {
  const f0 = frames[0];
  const len = f0.values.length;
  const sum = new Float64Array(len);
  const cnt = new Int32Array(len);
  for (const f of frames) {
    sameGrid(f0, f, node);
    for (let i = 0; i < len; i++) {
      const v = f.values[i];
      if (Number.isFinite(v)) {
        sum[i] += v; cnt[i]++;
      }
    }
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  }
  return out;
}

/** `YYYY-MM` (or a longer ISO date) as a comparable year*12+month ordinal. NaN if unparseable. */
function monthOrdinalOf(date: string): number {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(5, 7), 10);
  return Number.isFinite(y) && m >= 1 && m <= 12 ? y * 12 + (m - 1) : NaN;
}

/**
 * Anomaly against an EXPLICIT climatology.
 *
 * The baseline is the whole point: "the anomaly" is not a property of a cell, it is a difference
 * against a stated reference period, and the same pixel changes value when the reference changes.
 * The op therefore always records which baseline it used in the output's `note`, so a chart, a
 * legend and an exported CSV can never lose track of it.
 *
 * `climatology: 'monthly'` removes the SEASONAL CYCLE (each calendar month is differenced against
 * that month's own baseline mean) — which is what "anomaly" means in operational products. The
 * default `'window'` subtracts one flat mean, leaving the seasonal cycle in the result; that is
 * fine for a single season's frames and misleading across a multi-year monthly stack.
 */
function opAnomaly(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const stack = asStack(inputs, 'value', node.id);
  if (stack.frames.length === 0) {
    return { kind: 'stack', stack: { frames: [] } };
  }
  const monthly = params.climatology === 'monthly';
  const startSpec = params.baselineStart as string | undefined;
  const endSpec = params.baselineEnd as string | undefined;

  // Baseline frames: the stated reference period, or every loaded frame when none was given.
  let baseFrames = stack.frames;
  let baseLabel = `the loaded window (${dateSpanLabel(stack.frames)})`;
  if (startSpec !== undefined || endSpec !== undefined) {
    const lo = startSpec !== undefined ? monthOrdinalOf(startSpec) : -Infinity;
    const hi = endSpec !== undefined ? monthOrdinalOf(endSpec) : Infinity;
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      throw new OpError(node.id, 'baselineStart / baselineEnd must be YYYY-MM');
    }
    baseFrames = stack.frames.filter((f) => {
      const o = monthOrdinalOf(f.date);
      return o >= lo && o <= hi;
    });
    if (baseFrames.length === 0) {
      throw new OpError(node.id,
        `no loaded frames fall in the baseline ${startSpec ?? '…'}→${endSpec ?? '…'} — widen the layer's date range so it covers the baseline as well as the period you are studying`);
    }
    baseLabel = `${startSpec ?? '…'}–${endSpec ?? '…'} (${baseFrames.length} frames)`;
  }

  // One climatology for everything, or one per calendar month.
  const flat = monthly ? null : climatologyField(baseFrames, node.id);
  const perMonth = new Map<number, Float32Array>();
  if (monthly) {
    const byMonth = new Map<number, CpuField[]>();
    for (const f of baseFrames) {
      const m = parseInt(f.date.slice(5, 7), 10);
      const list = byMonth.get(m);
      if (list) {
        list.push(f);
      } else {
        byMonth.set(m, [f]);
      }
    }
    for (const [m, fs] of byMonth) {
      perMonth.set(m, climatologyField(fs, node.id));
    }
  }

  const percent = params.as === 'percent';
  const note = `${percent ? 'percent of normal' : 'anomaly'} vs ${monthly ? 'the month-of-year climatology of ' : 'the mean of '}${baseLabel}`;
  const frames: CpuField[] = [];
  for (const f of stack.frames) {
    const clim = flat ?? perMonth.get(parseInt(f.date.slice(5, 7), 10));
    if (!clim) {
      // No baseline frame shares this calendar month, so this frame HAS no anomaly. Dropping it is
      // the honest outcome; differencing it against some other month's mean would not be one.
      continue;
    }
    const values = new Float32Array(f.values.length);
    if (percent) {
      for (let i = 0; i < values.length; i++) {
        // A zero climatology (a desert month) has no "percent of normal"; say so with no-data rather
        // than an infinity that would blow out every legend it touches.
        values[i] = clim[i] > 0 ? ((f.values[i] - clim[i]) / clim[i]) * 100 : NaN;
      }
    } else {
      for (let i = 0; i < values.length; i++) {
        values[i] = f.values[i] - clim[i];   // NaN propagates
      }
    }
    frames.push(withValues(f, values, percent ? { relative: true, unit: 'percent', note } : { relative: true, note }));
  }
  return { kind: 'stack', stack: { frames } };
}

function opLag(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const months = params.months as number;
  const v = port(inputs, 'value', node.id);
  if (v.kind === 'stack') {
    const frames = v.stack.frames.map((f): CpuField => ({ ...f, date: addMonthsToDate(f.date, months) }));
    return { kind: 'stack', stack: { frames } };
  }
  if (v.kind === 'series') {
    const t = new Float64Array(v.series.t.length);
    for (let i = 0; i < t.length; i++) {
      t[i] = addMonthsToEpoch(v.series.t[i], months);
    }
    return { kind: 'series', series: { ...v.series, t } };
  }
  throw new OpError(node.id, `internal: lag over ${v.kind}`);
}

/** Nearest ONI sample within ~1.5 months, classified by the ±0.5 threshold. */
function ensoPhaseAt(oni: SeriesValue, epoch: number): 'elnino' | 'lanina' | 'neutral' | null {
  let best = -1, bestDt = Infinity;
  for (let i = 0; i < oni.t.length; i++) {
    const dt = Math.abs(oni.t[i] - epoch);
    if (dt < bestDt) {
      bestDt = dt; best = i;
    }
  }
  if (best < 0 || bestDt > 46 * DAY_MS) {
    return null;
  }
  const v = oni.v[best];
  if (!Number.isFinite(v)) {
    return null;
  }
  return v >= 0.5 ? 'elnino' : v <= -0.5 ? 'lanina' : 'neutral';
}

function opSelectFrames(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const stack = asStack(inputs, 'value', node.id);
  let months: Set<number> | null = null;
  if (typeof params.months === 'string') {
    months = new Set(params.months.split(',').map((s) => parseInt(s.trim(), 10)).filter((m) => m >= 1 && m <= 12));
    if (months.size === 0) {
      throw new OpError(node.id, `months "${params.months}" has no valid month numbers (1–12)`);
    }
  }
  const phase = params.phase as string | undefined;
  const oni = phase !== undefined ? asSeries(inputs, 'oni', node.id) : null;
  const frames = stack.frames.filter((f) => {
    if (months && !months.has(parseInt(f.date.slice(5, 7), 10))) {
      return false;
    }
    if (phase !== undefined && oni && ensoPhaseAt(oni, frameEpoch(f.date)) !== phase) {
      return false;
    }
    return true;
  });
  return { kind: 'stack', stack: { frames } };
}

function opAreaMean(node: AnalysisNode, inputs: Record<string, Value>): Value {
  const region = inputs.region ? asRegion(inputs, 'region', node.id) : null;
  const v = port(inputs, 'value', node.id);
  if (v.kind === 'field') {
    const s = weightedStats(v.field, region);
    const scalar: ScalarValue = {
      v: s.mean, unit: v.field.unit, relative: v.field.relative,
      label: `area mean · ${v.field.date}`,
      n: s.n, sd: s.sd, coverage: s.coverage,
      note: coverageNote(s, v.field.note),
    };
    return { kind: 'scalar', scalar };
  }
  if (v.kind === 'stack') {
    const pts: Array<{ t: number; v: number; sd: number; n: number; coverage: number }> = [];
    let unit: Unit = 'none';
    let relative = false;
    let worst: SpatialStats | null = null;
    for (const f of v.stack.frames) {
      unit = f.unit; relative = f.relative;
      const s = weightedStats(f, region);
      if (s.n > 0) {
        pts.push({ t: frameEpoch(f.date), v: s.mean, sd: s.sd, n: s.n, coverage: s.coverage });
        if (!worst || s.coverage < worst.coverage) {
          worst = s;
        }
      }
    }
    // Spread travels WITH the series so every consumer — chart band, CSV, LLM answer — sees the
    // same coverage the mean was computed from, instead of each one re-deriving or ignoring it.
    const series: SeriesValue = {
      t: new Float64Array(pts.map((p) => p.t)),
      v: new Float64Array(pts.map((p) => p.v)),
      unit, relative,
      label: region ? `area mean (${region.kind === 'preset' ? region.name : region.kind})` : 'area mean',
      spread: {
        sd: new Float64Array(pts.map((p) => p.sd)),
        n: new Float64Array(pts.map((p) => p.n)),
        coverage: new Float64Array(pts.map((p) => p.coverage)),
      },
      note: worst ? coverageNote(worst, v.stack.frames[0]?.note, 'worst frame') : undefined,
    };
    return { kind: 'series', series };
  }
  throw new OpError(node.id, `internal: areaMean over ${v.kind}`);
}

/**
 * Splits a date-sorted stack into RUNS of consecutive frames — a gap longer than 1.5× the stack's
 * median step starts a new run — so `selectFrames(months: "12,1,2")` becomes one run per winter.
 * Runs shorter than the longest are dropped: a season with a missing month would otherwise enter
 * the result as a full season's mean of fewer months.
 */
function frameRuns(stack: CpuStack): { runs: CpuField[][]; dropped: number } {
  const ep = stack.frames.map((f) => frameEpoch(f.date));
  const gap = 1.5 * Math.max(medianStepMs(ep), DAY_MS);
  const runs: CpuField[][] = [];
  stack.frames.forEach((f, i) => {
    if (i === 0 || ep[i] - ep[i - 1] > gap) {
      runs.push([f]);
    } else {
      runs[runs.length - 1].push(f);
    }
  });
  const full = Math.max(0, ...runs.map((r) => r.length));
  const kept = runs.filter((r) => r.length === full);
  return { runs: kept, dropped: runs.length - kept.length };
}

function opTimeReduce(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const stack = asStack(inputs, 'value', node.id);
  const stat = params.stat as 'mean' | 'min' | 'max' | 'range';
  if (params.per === 'run') {
    const { runs, dropped } = frameRuns(stack);
    if (runs.length === 0) {
      throw new OpError(node.id, 'empty stack — no frames in the requested window');
    }
    const frames = runs.map((run) => {
      const v = opTimeReduce(node, { value: { kind: 'stack', stack: { frames: run } } }, { stat }) as { kind: 'field'; field: CpuField };
      const src = run[0];
      // Dated at the run's MIDDLE frame, so a Dec–Feb mean pairs with the ONI season centred on January.
      const note = `${stat} of each run of ${run.length} consecutive frames${dropped ? ` (${dropped} incomplete run${dropped > 1 ? 's' : ''} dropped)` : ''}`;
      return withValues(v.field, v.field.values, {
        date: run[Math.floor(run.length / 2)].date,
        note: src.note ? `${note}; ${src.note}` : note,
      });
    });
    return { kind: 'stack', stack: { frames } };
  }
  if (stat === 'mean') {
    return { kind: 'field', field: timeMeanField(stack, node.id) };
  }
  if (stack.frames.length === 0) {
    throw new OpError(node.id, 'empty stack — no frames in the requested window');
  }
  const f0 = stack.frames[0];
  const len = f0.values.length;
  const lo = new Float32Array(len).fill(Infinity);
  const hi = new Float32Array(len).fill(-Infinity);
  const cnt = new Int32Array(len);
  for (const f of stack.frames) {
    sameGrid(f0, f, node.id);
    for (let i = 0; i < len; i++) {
      const v = f.values[i];
      if (Number.isFinite(v)) {
        lo[i] = Math.min(lo[i], v);
        hi[i] = Math.max(hi[i], v);
        cnt[i]++;
      }
    }
  }
  const values = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    if (cnt[i] === 0 || (stat === 'range' && cnt[i] < 2)) {
      values[i] = NaN;
    } else {
      values[i] = stat === 'min' ? lo[i] : stat === 'max' ? hi[i] : hi[i] - lo[i];
    }
  }
  const field: CpuField = {
    width: f0.width, height: f0.height, date: dateSpanLabel(stack.frames),
    values, unit: f0.unit, relative: stat === 'range' ? true : f0.relative, overLand: f0.overLand,
  };
  return { kind: 'field', field };
}

/**
 * Per-cell least-squares slope, reported per decade, WITH the uncertainty needed to read it.
 *
 * Three passes over frames × cells: accumulate the fit sums, then the residual sum of squares and
 * the residuals' lag-1 autocorrelation, then convert to a standard error and a two-sided p-value.
 * Degrees of freedom come from the autocorrelation-discounted effective sample size (Santer et al.
 * 2000), not the frame count: monthly geophysical fields are strongly serially correlated, and
 * `df = n − 2` on them manufactures significance out of persistence.
 *
 * `significance` blanks cells that fail the test, so a map can be restricted to where the trend is
 * actually distinguishable from zero. Cells that could not be tested at all (too few frames) are
 * blanked by that filter too — "untestable" is not "insignificant", but neither is it a result.
 */
function opTrend(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const stack = asStack(inputs, 'value', node.id);
  if (stack.frames.length === 0) {
    throw new OpError(node.id, 'empty stack — no frames in the requested window');
  }
  const alpha = params.significance as number | undefined;
  if (alpha !== undefined && !(alpha > 0 && alpha < 1)) {
    throw new OpError(node.id, `significance must be between 0 and 1 (got ${alpha})`);
  }
  const f0 = stack.frames[0];
  const len = f0.values.length;
  const t0 = frameEpoch(f0.date);
  const xs = stack.frames.map((f) => (frameEpoch(f.date) - t0) / (365.25 * DAY_MS));

  // Pass 1 — per-cell least squares via running sums.
  const n = new Int32Array(len);
  const sx = new Float64Array(len);
  const sy = new Float64Array(len);
  const sxx = new Float64Array(len);
  const sxy = new Float64Array(len);
  for (let k = 0; k < stack.frames.length; k++) {
    const f = stack.frames[k];
    sameGrid(f0, f, node.id);
    const x = xs[k];
    for (let i = 0; i < len; i++) {
      const v = f.values[i];
      if (Number.isFinite(v)) {
        n[i]++; sx[i] += x; sy[i] += v; sxx[i] += x * x; sxy[i] += x * v;
      }
    }
  }
  const slope = new Float64Array(len);       // per YEAR here; scaled to per-decade at the end
  const intercept = new Float64Array(len);
  const sxxC = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (n[i] < MIN_TEMPORAL_SAMPLES) {
      slope[i] = NaN;
      continue;
    }
    const den = sxx[i] - (sx[i] * sx[i]) / n[i];
    sxxC[i] = den;
    if (!(den > 1e-9)) {
      slope[i] = NaN;
      continue;
    }
    slope[i] = (sxy[i] - (sx[i] * sy[i]) / n[i]) / den;
    intercept[i] = (sy[i] - slope[i] * sx[i]) / n[i];
  }

  // Pass 2 — residual sum of squares and the lag-1 autocorrelation of the residuals. `prev` holds
  // the previous frame's residual per cell (NaN where that frame had no value), so a gap in a
  // cell's record breaks the consecutive pair instead of bridging across it.
  const sse = new Float64Array(len);
  const acNum = new Float64Array(len);
  const prev = new Float64Array(len).fill(NaN);
  for (let k = 0; k < stack.frames.length; k++) {
    const f = stack.frames[k];
    const x = xs[k];
    for (let i = 0; i < len; i++) {
      const v = f.values[i];
      let e = NaN;
      if (Number.isFinite(v) && Number.isFinite(slope[i])) {
        e = v - (intercept[i] + slope[i] * x);
        sse[i] += e * e;
        if (Number.isFinite(prev[i])) {
          acNum[i] += prev[i] * e;
        }
      }
      prev[i] = e;
    }
  }

  // Pass 3 — standard error, effective sample size and p, per cell.
  const values = new Float32Array(len);
  const stderr = new Float32Array(len);
  const pValue = new Float32Array(len);
  const nEff = new Float32Array(len);
  let tested = 0, significant = 0;
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(slope[i])) {
      values[i] = NaN; stderr[i] = NaN; pValue[i] = NaN; nEff[i] = 0;
      continue;
    }
    // Least-squares residuals have zero mean by construction, so Σe² IS their centered variance
    // and r1 = Σe_t·e_{t+1} / Σe².
    const r1 = sse[i] > 0 ? acNum[i] / sse[i] : 0;
    const fit = trendFitFromSums(n[i], sxxC[i], slope[i], sse[i], r1);
    values[i] = slope[i] * 10;                      // per decade
    stderr[i] = fit.stderr * 10;                    // same scaling as the estimate
    pValue[i] = fit.p;
    nEff[i] = fit.nEff;
    if (Number.isFinite(fit.p)) {
      tested++;
      if (alpha !== undefined && fit.p <= alpha) {
        significant++;
      }
    }
  }

  const notes: string[] = [
    'slope per decade; two-sided t-test on the autocorrelation-adjusted effective sample size (Santer et al. 2000)',
  ];
  if (alpha !== undefined) {
    for (let i = 0; i < len; i++) {
      if (!(pValue[i] <= alpha)) {
        values[i] = NaN;
      }
    }
    notes.push(`showing only cells with p ≤ ${alpha} (${significant} of ${tested} testable cells)`);
  }
  if (f0.note) {
    notes.unshift(f0.note);
  }
  const field: CpuField = {
    width: f0.width, height: f0.height, date: dateSpanLabel(stack.frames),
    values, unit: f0.unit, relative: true, overLand: f0.overLand,
    uncertainty: { stderr, pValue, n, nEff, method: 'OLS slope, t-test on effective DoF (lag-1 adjusted)' },
    note: notes.join('; '),
  };
  return { kind: 'field', field };
}

type MathFn = 'add' | 'sub' | 'mul' | 'div';

function applyFn(fn: MathFn, a: number, b: number): number {
  switch (fn) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': {
      const r = a / b;
      return Number.isFinite(r) ? r : NaN;
    }
  }
}

function mathUnit(fn: MathFn, a: { unit: Unit; relative: boolean }, b: { unit: Unit; relative: boolean }): { unit: Unit; relative: boolean } {
  if (fn === 'mul' || fn === 'div') {
    return { unit: 'none', relative: false };
  }
  if (fn === 'sub') {
    return { unit: a.unit, relative: true };
  }
  return { unit: a.unit, relative: a.relative && b.relative };
}

function mathFields(fn: MathFn, a: CpuField, b: CpuField, node: string): CpuField {
  sameGrid(a, b, node);
  const values = new Float32Array(a.values.length);
  for (let i = 0; i < values.length; i++) {
    values[i] = applyFn(fn, a.values[i], b.values[i]);   // NaN propagates
  }
  // Covers land only where both operands do — matching the validity intersection above.
  return withValues(a, values, { ...mathUnit(fn, a, b), overLand: a.overLand === true && b.overLand === true });
}

function mathFieldScalar(fn: MathFn, f: CpuField, s: number, scalarLeft: boolean, meta: { unit: Unit; relative: boolean }): CpuField {
  const values = new Float32Array(f.values.length);
  for (let i = 0; i < values.length; i++) {
    values[i] = scalarLeft ? applyFn(fn, s, f.values[i]) : applyFn(fn, f.values[i], s);
  }
  return withValues(f, values, meta);
}

function opMath(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const fn = params.fn as MathFn;
  const a = port(inputs, 'a', node.id);
  const b = port(inputs, 'b', node.id);

  if (a.kind === 'scalar' && b.kind === 'scalar') {
    const meta = mathUnit(fn, a.scalar, b.scalar);
    return { kind: 'scalar', scalar: { v: applyFn(fn, a.scalar.v, b.scalar.v), ...meta, label: `${a.scalar.label} ${fn} ${b.scalar.label}` } };
  }
  if (a.kind === 'scalar' || b.kind === 'scalar') {
    const s = a.kind === 'scalar' ? a.scalar : (b as { kind: 'scalar'; scalar: ScalarValue }).scalar;
    const other = a.kind === 'scalar' ? b : a;
    const scalarLeft = a.kind === 'scalar';
    const meta = scalarLeft
      ? mathUnit(fn, s, other.kind === 'field' ? other.field : other.kind === 'stack' ? (other.stack.frames[0] ?? s) : other.kind === 'series' ? other.series : s)
      : mathUnit(fn, other.kind === 'field' ? other.field : other.kind === 'stack' ? (other.stack.frames[0] ?? s) : other.kind === 'series' ? other.series : s, s);
    if (other.kind === 'field') {
      return { kind: 'field', field: mathFieldScalar(fn, other.field, s.v, scalarLeft, meta) };
    }
    if (other.kind === 'stack') {
      return { kind: 'stack', stack: { frames: other.stack.frames.map((f) => mathFieldScalar(fn, f, s.v, scalarLeft, meta)) } };
    }
    if (other.kind === 'series') {
      const v = new Float64Array(other.series.v.length);
      for (let i = 0; i < v.length; i++) {
        v[i] = scalarLeft ? applyFn(fn, s.v, other.series.v[i]) : applyFn(fn, other.series.v[i], s.v);
      }
      return { kind: 'series', series: { ...other.series, v, ...meta } };
    }
    throw new OpError(node.id, `math cannot combine a scalar with a ${other.kind}`);
  }
  if (a.kind === 'field' && b.kind === 'field') {
    return { kind: 'field', field: mathFields(fn, a.field, b.field, node.id) };
  }
  if (a.kind === 'stack' && b.kind === 'stack') {
    const pairs = pairFrames(a.stack, b.stack);
    const frames = pairs.map(([i, j]) => mathFields(fn, a.stack.frames[i], b.stack.frames[j], node.id));
    return { kind: 'stack', stack: { frames } };
  }
  if (a.kind === 'series' && b.kind === 'series') {
    const pairs = pairByTime([...a.series.t], [...b.series.t]);
    const t = new Float64Array(pairs.length);
    const v = new Float64Array(pairs.length);
    pairs.forEach(([i, j], k) => {
      t[k] = a.series.t[i];
      v[k] = applyFn(fn, a.series.v[i], b.series.v[j]);
    });
    const meta = mathUnit(fn, a.series, b.series);
    return { kind: 'series', series: { t, v, ...meta, label: `${a.series.label} ${fn} ${b.series.label}` } };
  }
  throw new OpError(node.id, `internal: math over ${a.kind} and ${b.kind}`);
}

function opCorrelate(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const a = port(inputs, 'a', node.id);
  const b = port(inputs, 'b', node.id);
  const alpha = params.significance as number | undefined;
  if (alpha !== undefined && !(alpha > 0 && alpha < 1)) {
    throw new OpError(node.id, `significance must be between 0 and 1 (got ${alpha})`);
  }
  if (params.mode === 'temporal') {
    if (a.kind !== 'stack' || b.kind !== 'stack') {
      throw new OpError(node.id, 'internal: correlate(temporal) over non-stacks');
    }
    const pairs = pairFrames(a.stack, b.stack);
    if (pairs.length === 0) {
      throw new OpError(node.id, 'no date-paired frames — the two stacks do not overlap in time');
    }
    const f0 = a.stack.frames[pairs[0][0]];
    sameGrid(f0, b.stack.frames[pairs[0][1]], node.id);
    const len = f0.values.length;
    // Per-cell running sums across pairs — one pass over pairs × cells.
    const n = new Int32Array(len);
    const sx = new Float64Array(len);
    const sy = new Float64Array(len);
    const sxx = new Float64Array(len);
    const syy = new Float64Array(len);
    const sxy = new Float64Array(len);
    for (const [i, j] of pairs) {
      const fa = a.stack.frames[i].values;
      const fb = b.stack.frames[j].values;
      for (let k = 0; k < len; k++) {
        const x = fa[k], y = fb[k];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          n[k]++; sx[k] += x; sy[k] += y; sxx[k] += x * x; syy[k] += y * y; sxy[k] += x * y;
        }
      }
    }
    const values = new Float32Array(len);
    const meanX = new Float64Array(len);
    const meanY = new Float64Array(len);
    const varX = new Float64Array(len);
    const varY = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      if (n[k] < MIN_TEMPORAL_SAMPLES) {
        values[k] = NaN;
        continue;
      }
      const cov = sxy[k] - (sx[k] * sy[k]) / n[k];
      const vx = sxx[k] - (sx[k] * sx[k]) / n[k];
      const vy = syy[k] - (sy[k] * sy[k]) / n[k];
      const den = Math.sqrt(vx * vy);
      values[k] = den > 0 ? cov / den : NaN;
      meanX[k] = sx[k] / n[k]; meanY[k] = sy[k] / n[k];
      varX[k] = vx; varY[k] = vy;
    }

    // Second pass — each input's lag-1 autocorrelation per cell, so the test can be run on the
    // number of INDEPENDENT samples rather than the frame count. Two adjacent monthly SST frames
    // are not two independent observations, and pretending otherwise is what turns a persistent
    // field into a map of spurious significance.
    const acX = new Float64Array(len);
    const acY = new Float64Array(len);
    const prevX = new Float64Array(len).fill(NaN);
    const prevY = new Float64Array(len).fill(NaN);
    for (const [i, j] of pairs) {
      const fa = a.stack.frames[i].values;
      const fb = b.stack.frames[j].values;
      for (let k = 0; k < len; k++) {
        const x = fa[k], y = fb[k];
        const ok = Number.isFinite(x) && Number.isFinite(y) && n[k] >= MIN_TEMPORAL_SAMPLES;
        const dx = ok ? x - meanX[k] : NaN;
        const dy = ok ? y - meanY[k] : NaN;
        if (ok && Number.isFinite(prevX[k])) {
          acX[k] += prevX[k] * dx;
          acY[k] += prevY[k] * dy;
        }
        prevX[k] = dx; prevY[k] = dy;
      }
    }
    const stderr = new Float32Array(len);
    const pValue = new Float32Array(len);
    const nEff = new Float32Array(len);
    let tested = 0, significant = 0;
    for (let k = 0; k < len; k++) {
      if (!Number.isFinite(values[k])) {
        stderr[k] = NaN; pValue[k] = NaN; nEff[k] = 0;
        continue;
      }
      const r1x = varX[k] > 0 ? acX[k] / varX[k] : 0;
      const r1y = varY[k] > 0 ? acY[k] / varY[k] : 0;
      const ne = effectiveSampleSize(n[k], r1x, r1y);
      nEff[k] = ne;
      pValue[k] = correlationPValue(values[k], ne);
      // Fisher-z standard error, back on the r scale — a usable ± for a single cell's r.
      stderr[k] = ne > 3 ? (1 - values[k] * values[k]) / Math.sqrt(ne - 3) : NaN;
      if (Number.isFinite(pValue[k])) {
        tested++;
        if (alpha !== undefined && pValue[k] <= alpha) {
          significant++;
        }
      }
    }
    const notes = ['two-sided t-test on the autocorrelation-adjusted effective sample size (Bretherton et al. 1999)'];
    if (alpha !== undefined) {
      for (let k = 0; k < len; k++) {
        if (!(pValue[k] <= alpha)) {
          values[k] = NaN;
        }
      }
      notes.push(`showing only cells with p ≤ ${alpha} (${significant} of ${tested} testable cells)`);
    }
    const paired = pairs.map(([i]) => a.stack.frames[i]);
    const field: CpuField = {
      width: f0.width, height: f0.height, date: dateSpanLabel(paired),
      // A correlation only covers land where BOTH inputs do; an ocean field on either side keeps the
      // result off the continents.
      values, unit: 'r', relative: false,
      overLand: a.stack.frames[0].overLand === true && b.stack.frames[0].overLand === true,
      uncertainty: { stderr, pValue, n, nEff, method: 'Pearson r, t-test on effective DoF (lag-1 adjusted)' },
      note: notes.join('; '),
    };
    return { kind: 'field', field };
  }

  // Spatial: reduce stacks to time-mean fields, then one weighted r across cells.
  const fa = a.kind === 'field' ? a.field : timeMeanField((a as { kind: 'stack'; stack: CpuStack }).stack, node.id);
  const fb = b.kind === 'field' ? b.field : timeMeanField((b as { kind: 'stack'; stack: CpuStack }).stack, node.id);
  sameGrid(fa, fb, node.id);
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (let y = 0; y < fa.height; y++) {
    const w = rowWeight(y, fa.height);
    for (let x = 0; x < fa.width; x++) {
      const i = y * fa.width + x;
      const va = fa.values[i], vb = fb.values[i];
      if (Number.isFinite(va) && Number.isFinite(vb)) {
        xs.push(va); ys.push(vb); ws.push(w);
      }
    }
  }
  const { r, n } = pearson(xs, ys, ws);
  const scalar: ScalarValue = {
    v: r, unit: 'r', relative: false, label: `spatial correlation · ${fa.date}`, n,
    // Deliberately NO p-value. Neighbouring grid cells are strongly spatially autocorrelated, so
    // the n here is nowhere near the number of independent samples and every standard test would
    // report a significance the data cannot support. The honest report is the association and its
    // cell count; a field-significance test (e.g. a moving-blocks bootstrap) is what this would
    // need, and it is not implemented.
    note: `${n} grid cells, which are spatially autocorrelated — this is an association, not a tested result`,
  };
  return { kind: 'scalar', scalar };
}

/** Half-width of the cross-validation hold-out window: a sample is predicted from a fit that
 *  excludes every sample within this many days of it — the 12 months around it, so the other
 *  months of the same season (which share its predictor value and most of its weather) cannot
 *  leak the answer the way plain leave-one-out lets them. */
const CV_HALF_WINDOW_MS = 183 * DAY_MS;

/** Collapses an `at` input to one predictor value per `atFrom`. */
function regressAt(v: Value, how: string, node: string): { x: number; label: string } {
  if (v.kind === 'scalar') {
    return { x: v.scalar.v, label: v.scalar.label };
  }
  if (v.kind !== 'series') {
    throw new OpError(node, `internal: at input is a ${v.kind}`);
  }
  const { t, v: ys } = v.series;
  const idx: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (Number.isFinite(ys[i])) {
      idx.push(i);
    }
  }
  if (idx.length === 0) {
    throw new OpError(node, 'the at series has no valid samples');
  }
  const month = (i: number): string => new Date(t[i]).toISOString().slice(0, 7);
  const mean = (is: number[]): number => is.reduce((s, i) => s + ys[i], 0) / is.length;
  switch (how) {
    case 'last': {
      const i = idx[idx.length - 1];
      return { x: ys[i], label: `${v.series.label} at ${month(i)}` };
    }
    case 'mean':
      return { x: mean(idx), label: `mean ${v.series.label} ${month(idx[0])}–${month(idx[idx.length - 1])}` };
    case 'peak': {
      const i = idx.reduce((b, k) => (Math.abs(ys[k]) > Math.abs(ys[b]) ? k : b), idx[0]);
      return { x: ys[i], label: `peak ${v.series.label} (${month(i)})` };
    }
    default: {
      const last = idx.slice(-3);
      return { x: mean(last), label: `mean ${v.series.label} ${month(last[0])}–${month(last[last.length - 1])}` };
    }
  }
}

/**
 * Per-cell OLS regression of a stack on a predictor series — the teleconnection model behind an
 * ENSO outlook. One pass of sums per cell, then one time-ordered pass for the lag-1
 * autocorrelations and the windowed cross-validation.
 *
 * Uncertainty follows `correlate`: the effective sample size discounts both the response's and the
 * predictor's lag-1 autocorrelation (Bretherton et al. 1999), and the textbook OLS variances are
 * inflated by (n−2)/(nEff−2) accordingly. The skill score is cross-validated, not in-sample: an
 * in-sample r² is the fraction of the PAST a line can fit, which says little about the next winter.
 */
function opRegress(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const stack = asStack(inputs, 'value', node.id);
  const pred = asSeries(inputs, 'predictor', node.id);
  const output = (params.output as string | undefined) ?? 'slope';
  const minSkill = params.minSkill as number | undefined;
  let x0 = NaN;
  let atLabel = '';
  if (output === 'predict') {
    if (inputs.at) {
      ({ x: x0, label: atLabel } = regressAt(inputs.at, (params.atFrom as string | undefined) ?? 'last3', node.id));
    } else {
      x0 = params.at as number;
      atLabel = `${pred.label} = ${x0}`;
    }
    if (!Number.isFinite(x0)) {
      throw new OpError(node.id, 'the predictor value to predict at is not a finite number');
    }
  }

  // Pair frames with the predictor, keeping only pairs with a finite predictor value.
  const fe = stack.frames.map((f) => frameEpoch(f.date));
  const pairs = pairByTime(fe, Array.from(pred.t)).filter(([, j]) => Number.isFinite(pred.v[j]));
  if (pairs.length < MIN_TEMPORAL_SAMPLES) {
    throw new OpError(node.id,
      `only ${pairs.length} frames pair with the predictor (need ${MIN_TEMPORAL_SAMPLES}) — check that the stack and the series overlap in time`);
  }
  const f0 = stack.frames[pairs[0][0]];
  const len = f0.values.length;
  const np = pairs.length;
  const xs = pairs.map(([, j]) => pred.v[j]);
  const ts = pairs.map(([i]) => fe[i]);
  const fr = pairs.map(([i]) => {
    sameGrid(f0, stack.frames[i], node.id);
    return stack.frames[i].values;
  });

  // CV windows depend only on the pair times: [lo, hi) = the pairs excluded when predicting pair i.
  const winLo = new Int32Array(np);
  const winHi = new Int32Array(np);
  for (let i = 0, lo = 0, hi = 0; i < np; i++) {
    while (ts[i] - ts[lo] > CV_HALF_WINDOW_MS) {
      lo++;
    }
    hi = Math.max(hi, i);
    while (hi < np && ts[hi] - ts[i] <= CV_HALF_WINDOW_MS) {
      hi++;
    }
    winLo[i] = lo;
    winHi[i] = hi;
  }

  const values = new Float32Array(len).fill(NaN);
  const stderr = new Float32Array(len).fill(NaN);
  const pValue = new Float32Array(len).fill(NaN);
  const nArr = new Int32Array(len);
  const nEffArr = new Float32Array(len);
  const cy = new Float64Array(np);
  const ok = new Uint8Array(np);
  let tested = 0, kept = 0, skilful = 0;
  for (let k = 0; k < len; k++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < np; i++) {
      const y = fr[i][k];
      ok[i] = Number.isFinite(y) ? 1 : 0;
      if (ok[i]) {
        const x = xs[i];
        cy[i] = y;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      }
    }
    if (n < MIN_TEMPORAL_SAMPLES) {
      continue;
    }
    const Sxx = sxx - (sx * sx) / n;
    const Syy = syy - (sy * sy) / n;
    const Sxy = sxy - (sx * sy) / n;
    if (!(Sxx > 0)) {
      continue;
    }
    const b = Sxy / Sxx;
    const mx = sx / n, my = sy / n;
    const a = my - b * mx;
    const r = Syy > 0 ? Sxy / Math.sqrt(Sxx * Syy) : 0;
    const sse = Math.max(0, Syy - b * Sxy);

    // Lag-1 autocorrelations of predictor and response over consecutive valid samples, and the
    // windowed cross-validation (refit without the samples near pair i, then predict pair i).
    let acx = 0, acy = 0, prev = -1;
    let pressReg = 0, pressClim = 0;
    for (let i = 0; i < np; i++) {
      if (!ok[i]) {
        continue;
      }
      if (prev >= 0) {
        acx += (xs[i] - mx) * (xs[prev] - mx);
        acy += (cy[i] - my) * (cy[prev] - my);
      }
      prev = i;
      let en = 0, ex = 0, ey = 0, exx = 0, exy = 0;
      for (let j = winLo[i]; j < winHi[i]; j++) {
        if (ok[j]) {
          const x = xs[j], y = cy[j];
          en++; ex += x; ey += y; exx += x * x; exy += x * y;
        }
      }
      const rn = n - en;
      if (rn < 3) {
        continue;
      }
      const rsx = sx - ex, rsy = sy - ey;
      const rSxx = (sxx - exx) - (rsx * rsx) / rn;
      const rSxy = (sxy - exy) - (rsx * rsy) / rn;
      const rmy = rsy / rn;
      const rb = rSxx > 0 ? rSxy / rSxx : 0;
      const yhat = rmy + rb * (xs[i] - rsx / rn);
      pressReg += (cy[i] - yhat) ** 2;
      pressClim += (cy[i] - rmy) ** 2;
    }
    const ne = effectiveSampleSize(n, acx / Sxx, Syy > 0 ? acy / Syy : 0);
    const skill = pressClim > 0 ? (1 - pressReg / pressClim) * 100 : NaN;
    nArr[k] = n;
    nEffArr[k] = ne;

    const resVar = ne > 2 ? sse / (ne - 2) : NaN;   // SSE/(n−2) · (n−2)/(nEff−2)
    if (output === 'skill') {
      values[k] = skill;
    } else if (output === 'predict') {
      values[k] = a + b * x0;
      stderr[k] = Math.sqrt(resVar * (1 / n + ((x0 - mx) ** 2) / Sxx));
      pValue[k] = studentTTwoSided(values[k] / stderr[k], ne - 2);
    } else {
      values[k] = b;
      stderr[k] = Math.sqrt(resVar / Sxx);
      pValue[k] = correlationPValue(r, ne);
    }
    if (!Number.isFinite(values[k])) {
      continue;
    }
    tested++;
    if (skill > 0) {
      skilful++;
    }
    if (minSkill !== undefined && output !== 'skill' && !(skill >= minSkill)) {
      values[k] = NaN;
      stderr[k] = NaN;
      pValue[k] = NaN;
    } else {
      kept++;
    }
  }

  const src = stack.frames[0];
  const span = dateSpanLabel(pairs.map(([i]) => stack.frames[i]));
  const notes = [
    `OLS on ${pred.label} over ${np} paired frames (${span})`,
    `${skilful} of ${tested} cells beat climatology in cross-validation (12-month hold-out)`,
  ];
  if (output === 'predict') {
    notes.unshift(`predicted at ${atLabel} (${x0.toFixed(2)})`);
  }
  if (minSkill !== undefined && output !== 'skill') {
    notes.push(`showing only cells with cross-validated skill ≥ ${minSkill}% (${kept} of ${tested})`);
  }
  if (src.note) {
    notes.push(src.note);
  }
  const base = { width: f0.width, height: f0.height, overLand: src.overLand, note: notes.join('; ') };
  if (output === 'skill') {
    return { kind: 'field', field: { ...base, date: span, values, unit: 'percent', relative: false } };
  }
  return {
    kind: 'field',
    field: {
      ...base,
      date: output === 'predict' ? `outlook @ ${x0.toFixed(2)}` : span,
      values,
      // A slope is a rate (response units per predictor unit), so always relative. A prediction is
      // in the response's own units, relative exactly when the response was (an anomaly).
      unit: src.unit,
      relative: output === 'slope' ? true : src.relative,
      uncertainty: {
        stderr, pValue, n: nArr, nEff: nEffArr,
        method: output === 'predict'
          ? 'OLS mean-response t-test vs 0 on effective DoF (lag-1 adjusted)'
          : 'OLS slope t-test on effective DoF (lag-1 adjusted)',
      },
    },
  };
}

function opCorrelateSeries(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const a = asSeries(inputs, 'a', node.id);
  const b = asSeries(inputs, 'b', node.id);
  const lagMonths = (params.lagMonths as number | undefined) ?? 0;
  const tb = new Array<number>(b.t.length);
  for (let i = 0; i < b.t.length; i++) {
    tb[i] = lagMonths !== 0 ? addMonthsToEpoch(b.t[i], lagMonths) : b.t[i];
  }
  const pairs = pairByTime([...a.t], tb);
  const xs = pairs.map(([i]) => a.v[i]);
  const ys = pairs.map(([, j]) => b.v[j]);
  const finite = xs.map((x, k) => Number.isFinite(x) && Number.isFinite(ys[k]));
  const fx = xs.filter((_, k) => finite[k]);
  const fy = ys.filter((_, k) => finite[k]);
  const { r, n } = pearson(fx, fy);
  const enough = n >= MIN_TEMPORAL_SAMPLES;
  // Both series are serially correlated, so the pair count is not the sample size. n_eff discounts
  // it by the product of their lag-1 autocorrelations; with persistent monthly indices this often
  // halves the degrees of freedom and turns a "significant" r into an undecided one.
  const nEff = enough ? effectiveSampleSize(n, lag1Autocorrelation(fx), lag1Autocorrelation(fy)) : NaN;
  const scalar: ScalarValue = {
    v: enough ? r : NaN,
    unit: 'r', relative: false,
    label: `r(${a.label}, ${b.label}${lagMonths ? ` lag ${lagMonths}mo` : ''})`,
    n,
    nEff: enough ? nEff : undefined,
    p: enough ? correlationPValue(r, nEff) : undefined,
    note: enough
      ? `${n} paired samples, ~${nEff.toFixed(1)} independent after the lag-1 autocorrelation discount`
      : `only ${n} paired samples — fewer than the ${MIN_TEMPORAL_SAMPLES} needed to report a correlation`,
  };
  return { kind: 'scalar', scalar };
}

// ── Sinks ────────────────────────────────────────────────────────────────────────────

/** Frames of a field-or-stack input, or null if it is neither. */
function displayFrames(v: Value): CpuField[] | null {
  return v.kind === 'field' ? [v.field] : v.kind === 'stack' ? v.stack.frames : null;
}

/** The auto-legend rule, shared by the base input and the overlay input. */
function autoLegend(fields: CpuField[], title: string): LegendSpec {
  const { unit, relative } = fields[0];
  let colormap: string;
  let min: number;
  let max: number;
  if (unit === 'r') {
    colormap = 'balance'; min = -1; max = 1;
  } else if (relative) {
    const s = sampleValid(fields);
    const sym = Math.max(Math.abs(percentile(s, 2)), Math.abs(percentile(s, 98)));
    colormap = 'balance';
    min = -(Number.isFinite(sym) && sym > 0 ? sym : 1);
    max = -min;
  } else {
    const s = sampleValid(fields);
    let lo = percentile(s, 2);
    let hi = percentile(s, 98);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0; hi = 1;
    } else if (hi - lo < 1e-9) {
      lo -= 0.5; hi += 0.5;
    }
    colormap = 'viridis'; min = lo; max = hi;
  }
  return { title, colormap, min, max, unit, relative };
}

function opDisplay(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): DisplayResult {
  const v = port(inputs, 'value', node.id);
  const fields = displayFrames(v);
  if (!fields) {
    throw new OpError(node.id, `internal: display over ${v.kind}`);
  }
  if (fields.length === 0) {
    throw new OpError(node.id, 'nothing to display — the input stack has no frames');
  }
  const { unit, relative } = fields[0];
  let colormap: string;
  let min: number;
  let max: number;
  if (unit === 'r') {
    colormap = 'balance'; min = -1; max = 1;
  } else if (relative) {
    const s = sampleValid(fields);
    const sym = Math.max(Math.abs(percentile(s, 2)), Math.abs(percentile(s, 98)));
    colormap = 'balance';
    min = -(Number.isFinite(sym) && sym > 0 ? sym : 1);
    max = -min;
  } else {
    const s = sampleValid(fields);
    let lo = percentile(s, 2);
    let hi = percentile(s, 98);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0; hi = 1;
    } else if (hi - lo < 1e-9) {
      lo -= 0.5; hi += 0.5;
    }
    colormap = 'viridis'; min = lo; max = hi;
  }
  // Optional second quantity, drawn over the base as iso-lines by the host. It gets the same
  // auto-legend treatment as the base so its line tint and its legend strip agree.
  let overlay: DisplayResult['overlay'];
  const ov = inputs.over;
  if (ov) {
    const overFields = displayFrames(ov);
    if (!overFields || overFields.length === 0) {
      throw new OpError(node.id, 'the `over` input has no frames to draw');
    }
    const bands = Math.max(1, Math.round((params.overBands as number | undefined) ?? 8));
    overlay = {
      fields: overFields,
      legend: autoLegend(overFields, (params.overTitle as string | undefined)
        ?? `${overFields[0].unit}${overFields[0].relative ? ' (Δ)' : ''} over`),
      bands,
      hatchAt: params.overHatchAt as number | undefined,
    };
  }
  // Significance MARKING (as opposed to trend/correlate's `significance`, which removes the cells
  // from the data). Cells that could not be tested at all are NOT marked: an untested cell is not a
  // failed one, and stippling it would assert evidence against a trend that was never weighed.
  const stipple = params.stipple as number | undefined;
  if (stipple !== undefined && !(stipple > 0 && stipple < 1)) {
    throw new OpError(node.id, `stipple must be a probability between 0 and 1 (got ${stipple})`);
  }
  const notes = fields[0].note ? [fields[0].note] : [];
  let insignificant: Uint8Array[] | undefined;
  if (stipple !== undefined) {
    if (!fields.some((f) => f.uncertainty)) {
      throw new OpError(node.id,
        'stipple needs per-cell significance, which only an estimated field carries — feed this display a trend or a correlate(temporal) result');
    }
    let marked = 0, tested = 0;
    insignificant = fields.map((f) => {
      const out = new Uint8Array(f.values.length);
      const u = f.uncertainty;
      if (u) {
        for (let i = 0; i < out.length; i++) {
          if (!Number.isFinite(u.pValue[i])) {
            continue;
          }
          tested++;
          if (u.pValue[i] > stipple) {
            out[i] = 1; marked++;
          }
        }
      }
      return out;
    });
    notes.push(`stippled where p > ${stipple} — ${marked} of ${tested} tested cells are not distinguishable from zero`);
  }
  return {
    kind: 'display',
    node: node.id,
    fields,
    notes: notes.length > 0 ? notes : undefined,
    insignificant,
    overLand: fields[0].overLand === true,
    legend: {
      title: (params.title as string | undefined) ?? `Analysis · ${unit}${relative ? ' (Δ)' : ''} · ${fields[0].date}`,
      colormap: (params.colormap as string | undefined) ?? colormap,
      min: (params.min as number | undefined) ?? min,
      max: (params.max as number | undefined) ?? max,
      unit, relative,
    },
    overlay,
  };
}

function opChart(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): ChartResult {
  const series: SeriesValue[] = [];
  for (const name of ['a', 'b', 'c']) {
    if (inputs[name]) {
      series.push(asSeries(inputs, name, node.id));
    }
  }
  const notes = series.map((s) => s.note).filter((n): n is string => n !== undefined);
  return {
    kind: 'chart',
    node: node.id,
    title: (params.title as string | undefined) ?? series.map((s) => s.label).join(' · '),
    series,
    notes: notes.length > 0 ? notes : undefined,
  };
}

/** Per-cell test summary for an estimated field — the numbers that say how much of the map is real. */
function significanceSummary(f: CpuField): NonNullable<Extract<AnswerPayload, { type: 'field' }>['significance']> | undefined {
  const u = f.uncertainty;
  if (!u) {
    return undefined;
  }
  let tested = 0, p05 = 0, p01 = 0;
  const effs: number[] = [];
  for (let i = 0; i < u.pValue.length; i++) {
    const p = u.pValue[i];
    if (!Number.isFinite(p)) {
      continue;
    }
    tested++;
    if (p <= 0.05) {
      p05++;
    }
    if (p <= 0.01) {
      p01++;
    }
    effs.push(u.nEff[i]);
  }
  if (tested === 0) {
    return { method: u.method, tested: 0, fractionP05: NaN, fractionP01: NaN, medianNEff: NaN };
  }
  effs.sort((a, b) => a - b);
  return {
    method: u.method,
    tested,
    fractionP05: p05 / tested,
    fractionP01: p01 / tested,
    medianNEff: effs[Math.floor(effs.length / 2)],
  };
}

function opAnswer(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): AnswerResult {
  const label = params.label as string;
  const v = port(inputs, 'value', node.id);
  const notes: string[] = [];
  let payload: AnswerPayload;
  if (v.kind === 'scalar') {
    const s = v.scalar;
    payload = {
      type: 'scalar', value: s.v, unit: s.unit, relative: s.relative,
      n: s.n, nEff: s.nEff, p: s.p, sd: s.sd, coverage: s.coverage,
    };
    if (s.note) {
      notes.push(s.note);
    }
  } else if (v.kind === 'series') {
    const s = v.series;
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let i = 0; i < s.v.length; i++) {
      if (Number.isFinite(s.v[i])) {
        min = Math.min(min, s.v[i]); max = Math.max(max, s.v[i]); sum += s.v[i]; n++;
      }
    }
    let meanSd: number | undefined;
    let minCoverage: number | undefined;
    if (s.spread) {
      let sdSum = 0, sdN = 0, worst = Infinity;
      for (let i = 0; i < s.spread.sd.length; i++) {
        if (Number.isFinite(s.spread.sd[i])) {
          sdSum += s.spread.sd[i]; sdN++;
        }
        worst = Math.min(worst, s.spread.coverage[i]);
      }
      meanSd = sdN > 0 ? sdSum / sdN : undefined;
      minCoverage = Number.isFinite(worst) ? worst : undefined;
    }
    payload = {
      type: 'series', label: s.label, unit: s.unit, relative: s.relative, n,
      start: s.t.length ? new Date(s.t[0]).toISOString().slice(0, 10) : '',
      end: s.t.length ? new Date(s.t[s.t.length - 1]).toISOString().slice(0, 10) : '',
      min: n ? min : NaN, max: n ? max : NaN, mean: n ? sum / n : NaN,
      meanSd, minCoverage,
    };
    if (s.note) {
      notes.push(s.note);
    }
  } else if (v.kind === 'field') {
    const f = v.field;
    const { mean, n } = weightedMean(f, null);
    const absField = withValues(f, f.values.map((x) => Math.abs(x)) as Float32Array);
    const s = sampleValid([f]);
    payload = {
      type: 'field', date: f.date, unit: f.unit, relative: f.relative, cells: f.values.length,
      validFraction: f.values.length ? n / f.values.length : 0,
      areaWeightedMean: mean,
      meanAbs: weightedMean(absField, null).mean,
      p5: percentile(s, 5), p95: percentile(s, 95),
      spatiallyAutocorrelated: true,
      significance: significanceSummary(f),
    };
    if (f.note) {
      notes.push(f.note);
    }
  } else {
    throw new OpError(node.id, `internal: answer over ${v.kind}`);
  }
  return { kind: 'answer', node: node.id, label, payload, notes: notes.length > 0 ? notes : undefined };
}

/** Weighted least squares + Pearson r over paired samples. */
function weightedFit(xs: ArrayLike<number>, ys: ArrayLike<number>, ws: ArrayLike<number> | null): { r: number; slope: number; intercept: number; n: number } {
  let sw = 0, sx = 0, sy = 0, n = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws ? ws[i] : 1;
    sw += w; sx += w * xs[i]; sy += w * ys[i]; n++;
  }
  if (n === 0 || sw <= 0) {
    return { r: NaN, slope: NaN, intercept: NaN, n };
  }
  const mx = sx / sw, my = sy / sw;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws ? ws[i] : 1;
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += w * dx * dy; vx += w * dx * dx; vy += w * dy * dy;
  }
  const den = Math.sqrt(vx * vy);
  const slope = vx > 0 ? cov / vx : NaN;
  return { r: den > 0 ? cov / den : NaN, slope, intercept: my - slope * mx, n };
}

function asGriddedField(inputs: Record<string, Value>, name: string, node: string): CpuField {
  const v = port(inputs, name, node);
  if (v.kind === 'field') {
    return v.field;
  }
  if (v.kind === 'stack') {
    return timeMeanField(v.stack, node);
  }
  throw new OpError(node, `internal: input "${name}" is a ${v.kind}, expected field or stack`);
}

function opScatter(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): ScatterResult {
  const a = port(inputs, 'a', node.id);
  const b = port(inputs, 'b', node.id);
  const title = (params.title as string | undefined) ?? 'scatter';
  const cIn = inputs.c;
  if (a.kind === 'series' && b.kind === 'series') {
    const pairs = pairByTime([...a.series.t], [...b.series.t]);
    // The colour series pairs to the SAME x-samples, so a dot's colour always belongs to its point.
    const cs = cIn && cIn.kind === 'series' ? cIn.series : null;
    const cPairs = cs ? new Map(pairByTime([...a.series.t], [...cs.t])) : null;
    const xs: number[] = [], ys: number[] = [], cvals: number[] = [];
    for (const [i, j] of pairs) {
      if (Number.isFinite(a.series.v[i]) && Number.isFinite(b.series.v[j])) {
        xs.push(a.series.v[i]); ys.push(b.series.v[j]);
        if (cs) {
          const k = cPairs?.get(i);
          cvals.push(k === undefined ? NaN : cs.v[k]);
        }
      }
    }
    if (xs.length === 0) {
      throw new OpError(node.id, 'no date-paired samples — the two series do not overlap in time');
    }
    const fit = weightedFit(xs, ys, null);
    return {
      kind: 'scatter', node: node.id, title, mode: 'temporal',
      xLabel: a.series.label, yLabel: b.series.label,
      xUnit: a.series.unit, yUnit: b.series.unit,
      xRelative: a.series.relative, yRelative: b.series.relative,
      x: new Float64Array(xs), y: new Float64Array(ys),
      ...(cs ? { c: new Float64Array(cvals), cLabel: cs.label, cUnit: cs.unit, cRelative: cs.relative } : {}),
      ...fit,
    };
  }
  // Cell mode: pair grid cells of the (time-mean) fields; fit on ALL pairs, plot a subsample.
  const fa = asGriddedField(inputs, 'a', node.id);
  const fb = asGriddedField(inputs, 'b', node.id);
  sameGrid(fa, fb, node.id);
  const fc = cIn ? asGriddedField(inputs, 'c', node.id) : null;
  if (fc) {
    sameGrid(fa, fc, node.id);
  }
  const xs: number[] = [], ys: number[] = [], ws: number[] = [], cvals: number[] = [];
  for (let y = 0; y < fa.height; y++) {
    const w = rowWeight(y, fa.height);
    for (let x = 0; x < fa.width; x++) {
      const i = y * fa.width + x;
      if (Number.isFinite(fa.values[i]) && Number.isFinite(fb.values[i])) {
        xs.push(fa.values[i]); ys.push(fb.values[i]); ws.push(w);
        if (fc) {
          cvals.push(fc.values[i]);   // NaN is fine: an uncoloured dot draws in the neutral tone
        }
      }
    }
  }
  if (xs.length === 0) {
    throw new OpError(node.id, 'no cells where both fields are valid');
  }
  const fit = weightedFit(xs, ys, ws);
  const maxPoints = Math.max(100, (params.maxPoints as number | undefined) ?? 3000);
  const stride = Math.max(1, Math.ceil(xs.length / maxPoints));
  const px: number[] = [], py: number[] = [], pc: number[] = [];
  for (let i = 0; i < xs.length; i += stride) {
    px.push(xs[i]); py.push(ys[i]);
    if (fc) {
      pc.push(cvals[i]);
    }
  }
  return {
    kind: 'scatter', node: node.id, title, mode: 'spatial',
    xLabel: node.inputs?.a ?? 'a', yLabel: node.inputs?.b ?? 'b',
    xUnit: fa.unit, yUnit: fb.unit,
    xRelative: fa.relative, yRelative: fb.relative,
    x: new Float64Array(px), y: new Float64Array(py),
    ...(fc ? { c: new Float64Array(pc), cLabel: node.inputs?.c ?? 'c', cUnit: fc.unit, cRelative: fc.relative } : {}),
    ...fit,
  };
}

function opHistogram(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): HistogramResult {
  const v = port(inputs, 'value', node.id);
  const fields = v.kind === 'field' ? [v.field] : v.kind === 'stack' ? v.stack.frames : null;
  if (!fields || fields.length === 0) {
    throw new OpError(node.id, 'nothing to bin — no fields');
  }
  const bins = (params.bins as number | undefined) ?? 40;
  let lo = Infinity, hi = -Infinity, sw = 0, swv = 0, n = 0;
  for (const f of fields) {
    for (let y = 0; y < f.height; y++) {
      const w = rowWeight(y, f.height);
      for (let x = 0; x < f.width; x++) {
        const val = f.values[y * f.width + x];
        if (Number.isFinite(val)) {
          lo = Math.min(lo, val); hi = Math.max(hi, val);
          sw += w; swv += w * val; n++;
        }
      }
    }
  }
  if (n === 0) {
    throw new OpError(node.id, 'no valid cells to bin');
  }
  if (hi - lo < 1e-9) {
    lo -= 0.5; hi += 0.5;
  }
  const counts = new Float64Array(bins);
  const span = hi - lo;
  for (const f of fields) {
    for (let y = 0; y < f.height; y++) {
      const w = rowWeight(y, f.height);
      for (let x = 0; x < f.width; x++) {
        const val = f.values[y * f.width + x];
        if (Number.isFinite(val)) {
          counts[Math.min(bins - 1, Math.floor(((val - lo) / span) * bins))] += w;
        }
      }
    }
  }
  for (let i = 0; i < bins; i++) {
    counts[i] /= sw;
  }
  const edges = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) {
    edges[i] = lo + (span * i) / bins;
  }
  const { unit, relative } = fields[0];
  return {
    kind: 'histogram', node: node.id,
    title: (params.title as string | undefined) ?? `distribution · ${dateSpanLabel(fields)}`,
    unit, relative, edges, counts, n, mean: swv / sw, min: lo, max: hi,
  };
}

function opHovmoller(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): HovmollerResult {
  const stack = asStack(inputs, 'value', node.id);
  if (stack.frames.length === 0) {
    throw new OpError(node.id, 'empty stack');
  }
  const region = inputs.region ? asRegion(inputs, 'region', node.id) : null;
  const bbox = region ? regionBbox(region) : null;
  const inside = region ? (lon: number, lat: number): boolean => inRegion(lon, lat, region) : null;
  const axis = ((params.axis as string | undefined) ?? 'lon') as 'lon' | 'lat';
  const f0 = stack.frames[0];
  const W = f0.width, H = f0.height;
  const cols = axis === 'lon' ? W : H;
  const values = new Float32Array(cols * stack.frames.length);
  values.fill(NaN);
  for (let r = 0; r < stack.frames.length; r++) {
    const f = stack.frames[r];
    const sums = new Float64Array(cols);
    const wsum = new Float64Array(cols);
    for (let y = 0; y < H; y++) {
      const lat = latAt(y, H);
      const w = rowWeight(y, H);
      if (bbox && (lat < bbox.latMin || lat > bbox.latMax)) {
        continue;
      }
      for (let x = 0; x < W; x++) {
        const val = f.values[y * W + x];
        if (!Number.isFinite(val)) {
          continue;
        }
        if (inside && !inside(lonAt(x, W), lat)) {
          continue;
        }
        const c = axis === 'lon' ? x : y;
        sums[c] += w * val;
        wsum[c] += w;
      }
    }
    for (let c = 0; c < cols; c++) {
      if (wsum[c] > 0) {
        values[r * cols + c] = sums[c] / wsum[c];
      }
    }
  }
  // Legend range from the diagram's own values (p2..p98; symmetric for Δ-like data).
  const sorted = new Float64Array([...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b));
  if (sorted.length === 0) {
    throw new OpError(node.id, region ? 'no valid cells inside the region' : 'no valid cells');
  }
  const { unit, relative } = f0;
  let min: number, max: number;
  if (relative || unit === 'r') {
    const sym = Math.max(Math.abs(percentile(sorted, 2)), Math.abs(percentile(sorted, 98))) || 1;
    min = -sym; max = sym;
  } else {
    min = percentile(sorted, 2); max = percentile(sorted, 98);
    if (max - min < 1e-9) {
      min -= 0.5; max += 0.5;
    }
  }
  return {
    kind: 'hovmoller', node: node.id,
    title: (params.title as string | undefined) ?? `Hovmöller · ${axis} × time`,
    axis, width: cols, height: stack.frames.length, values,
    dates: stack.frames.map((f) => f.date),
    axisStart: axis === 'lon' ? lonAt(0, W) : latAt(0, H),
    axisStep: axis === 'lon' ? 360 / W : -180 / H,
    unit, relative, min, max,
  };
}

function opAnnotate(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): AnnotateResult {
  const v = port(inputs, 'value', node.id);
  if (v.kind !== 'field') {
    throw new OpError(node.id, `internal: annotate over ${v.kind}`);
  }
  const f = v.field;
  const stat = ((params.stat as string | undefined) ?? 'max') as 'max' | 'min' | 'both';
  const count = (params.count as number | undefined) ?? 3;
  const SEP_DEG = 12;   // keep markers from stacking inside one blob
  const cells: Array<{ value: number; lon: number; lat: number }> = [];
  for (let y = 0; y < f.height; y++) {
    const lat = latAt(y, f.height);
    for (let x = 0; x < f.width; x++) {
      const val = f.values[y * f.width + x];
      if (Number.isFinite(val)) {
        cells.push({ value: val, lon: lonAt(x, f.width), lat });
      }
    }
  }
  if (cells.length === 0) {
    throw new OpError(node.id, 'no valid cells to annotate');
  }
  const pick = (kind: 'max' | 'min'): Array<{ lon: number; lat: number; value: number; kind: 'max' | 'min' }> => {
    const sorted = [...cells].sort((a, b) => (kind === 'max' ? b.value - a.value : a.value - b.value));
    const out: Array<{ lon: number; lat: number; value: number; kind: 'max' | 'min' }> = [];
    for (const c of sorted) {
      const clash = out.some((m) => {
        let dLon = Math.abs(m.lon - c.lon);
        dLon = Math.min(dLon, 360 - dLon) * Math.cos(((m.lat + c.lat) / 2) * (Math.PI / 180));
        return Math.hypot(dLon, m.lat - c.lat) < SEP_DEG;
      });
      if (!clash) {
        out.push({ lon: c.lon, lat: c.lat, value: c.value, kind });
        if (out.length >= count) {
          break;
        }
      }
    }
    return out;
  };
  const markers = [
    ...(stat !== 'min' ? pick('max') : []),
    ...(stat !== 'max' ? pick('min') : []),
  ];
  return {
    kind: 'annotate', node: node.id,
    label: (params.label as string | undefined) ?? `${stat} of ${node.inputs?.value ?? 'field'}`,
    unit: f.unit, relative: f.relative, date: f.date, markers,
  };
}

function opVectors(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): VectorsResult {
  const fu = asGriddedField(inputs, 'u', node.id);
  const fv = asGriddedField(inputs, 'v', node.id);
  sameGrid(fu, fv, node.id);
  const mag = new Float32Array(fu.values.length);
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Number.isFinite(fu.values[i]) && Number.isFinite(fv.values[i]) ? Math.hypot(fu.values[i], fv.values[i]) : NaN;
  }
  const sorted = sampleValid([{ ...fu, values: mag }]);
  if (sorted.length === 0) {
    throw new OpError(node.id, 'no cells where both components are valid');
  }
  const maxMag = percentile(sorted, 98) || 1;
  return {
    kind: 'vectors', node: node.id,
    title: (params.title as string | undefined) ?? `vectors · ${node.inputs?.u ?? 'u'}, ${node.inputs?.v ?? 'v'}`,
    width: fu.width, height: fu.height,
    u: fu.values, v: fv.values, unit: fu.unit,
    maxMag, strideDeg: (params.strideDeg as number | undefined) ?? 5,
    scale: (params.scale as number | undefined) ?? 1,
  };
}

/** Applies a per-value transform to every frame/sample, preserving the input's shape. */
function mapValues(v: Value, node: string, f: (x: number) => number,
  meta: (m: { unit: Unit; relative: boolean }) => { unit: Unit; relative: boolean }): Value {
  // Take ONLY unit/relative off the callback and set them by name. Spreading its whole return value
  // would let a pass-through callback (filter's `(m) => m` returns the input itself) put the original
  // values back over the mapped ones — a filter that silently did nothing.
  const mapField = (fd: CpuField): CpuField => {
    const values = new Float32Array(fd.values.length);
    for (let i = 0; i < values.length; i++) {
      values[i] = f(fd.values[i]);
    }
    const m = meta(fd);
    return withValues(fd, values, { unit: m.unit, relative: m.relative });
  };
  if (v.kind === 'field') {
    return { kind: 'field', field: mapField(v.field) };
  }
  if (v.kind === 'stack') {
    return { kind: 'stack', stack: { frames: v.stack.frames.map(mapField) } };
  }
  if (v.kind === 'series') {
    const out = new Float64Array(v.series.v.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = f(v.series.v[i]);
    }
    const ms = meta(v.series);
    return { kind: 'series', series: { ...v.series, v: out, unit: ms.unit, relative: ms.relative } };
  }
  if (v.kind === 'scalar') {
    const mc = meta(v.scalar);
    return { kind: 'scalar', scalar: { ...v.scalar, v: f(v.scalar.v), unit: mc.unit, relative: mc.relative } };
  }
  throw new OpError(node, `internal: cannot map over ${v.kind}`);
}

/** Range filter — ODV's sample filter. Out-of-range values become no-data; the shape is unchanged. */
function opFilter(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const lo = params.min as number | undefined;
  const hi = params.max as number | undefined;
  if (lo === undefined && hi === undefined) {
    throw new OpError(node.id, 'filter needs at least one of min / max');
  }
  if (lo !== undefined && hi !== undefined && lo > hi) {
    throw new OpError(node.id, `filter min (${lo}) is above max (${hi}) — nothing could pass`);
  }
  const useAbs = params.abs === true;
  const keep = (x: number): number => {
    if (!Number.isFinite(x)) {
      return NaN;
    }
    const t = useAbs ? Math.abs(x) : x;
    return (lo !== undefined && t < lo) || (hi !== undefined && t > hi) ? NaN : x;
  };
  // Units are untouched: this SELECTS values, it does not transform them.
  return mapValues(port(inputs, 'value', node.id), node.id, keep, (m) => m);
}

const DERIVE_FNS: Record<string, { f: (x: number) => number; keepUnit: boolean }> = {
  log10: { f: (x) => (x > 0 ? Math.log10(x) : NaN), keepUnit: false },
  ln: { f: (x) => (x > 0 ? Math.log(x) : NaN), keepUnit: false },
  abs: { f: Math.abs, keepUnit: true },
  sqrt: { f: (x) => (x >= 0 ? Math.sqrt(x) : NaN), keepUnit: false },
  square: { f: (x) => x * x, keepUnit: false },
  negate: { f: (x) => -x, keepUnit: true },
  inverse: { f: (x) => (x !== 0 ? 1 / x : NaN), keepUnit: false },
};

/** Derived variables: one function applied element-wise. */
function opDerive(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const spec = DERIVE_FNS[params.fn as string];
  if (!spec) {
    throw new OpError(node.id, `unknown derive function "${String(params.fn)}"`);
  }
  return mapValues(port(inputs, 'value', node.id), node.id, spec.f, (m) => {
    if (spec.keepUnit) {
      // abs() of a Δ-quantity is no longer signed, so it stops being "relative".
      return { unit: m.unit, relative: params.fn === 'abs' ? false : m.relative };
    }
    // A log or a power changes the dimension. This language does not track compound units, so the
    // honest answer is "dimensionless" rather than a unit label that would now be a lie.
    return { unit: 'none', relative: false };
  });
}

/** Area of one grid row's cells, in km² — R²·Δλ·|sin φ₂ − sin φ₁|, exact on the sphere. */
function cellAreaKm2(y: number, width: number, height: number): number {
  const R = 6371;
  const dLon = (2 * Math.PI) / width;
  const north = ((90 - (y / height) * 180) * Math.PI) / 180;
  const south = ((90 - ((y + 1) / height) * 180) * Math.PI) / 180;
  return R * R * dLon * Math.abs(Math.sin(north) - Math.sin(south));
}

/** Measures the region a contour encloses — the 2-D counterpart of an isosurface. */
function opIsoline(node: AnalysisNode, inputs: Record<string, Value>, params: Record<string, ParamValue>): Value {
  const level = params.level as number;
  if (!Number.isFinite(level)) {
    throw new OpError(node.id, 'isoline needs a numeric level');
  }
  const measure = ((params.measure as string | undefined) ?? 'area') as 'area' | 'latitude' | 'longitude';
  const below = params.below === true;
  const region = inputs.region ? asRegion(inputs, 'region', node.id) : null;
  const bbox = region ? regionBbox(region) : null;
  const v = port(inputs, 'value', node.id);
  const frames = v.kind === 'field' ? [v.field] : v.kind === 'stack' ? v.stack.frames : null;
  if (!frames || frames.length === 0) {
    throw new OpError(node.id, 'isoline needs a field or a non-empty stack');
  }
  const measureFrame = (f: CpuField): number => {
    let areaSum = 0, coordSum = 0;
    for (let y = 0; y < f.height; y++) {
      const lat = latAt(y, f.height);
      if (bbox && (lat < bbox.latMin || lat > bbox.latMax)) {
        continue;
      }
      const cellA = cellAreaKm2(y, f.width, f.height);
      for (let x = 0; x < f.width; x++) {
        const val = f.values[y * f.width + x];
        if (!Number.isFinite(val)) {
          continue;
        }
        const lon = lonAt(x, f.width);
        if (region && !inRegion(lon, lat, region)) {
          continue;
        }
        if (below ? val > level : val < level) {
          continue;
        }
        areaSum += cellA;
        // Position is AREA-weighted, so the answer is the centroid of the enclosed region rather
        // than a mean over grid rows, which would over-count the shrinking polar cells.
        coordSum += cellA * (measure === 'longitude' ? lon : lat);
      }
    }
    if (measure === 'area') {
      return areaSum / 1e6;            // million km² — the unit ice extent is always quoted in
    }
    return areaSum > 0 ? coordSum / areaSum : NaN;
  };
  const cmp = below ? '<=' : '>=';
  const unit: Unit = measure === 'area' ? 'none' : 'deg';
  const label = measure === 'area'
    ? `extent ${cmp} ${level} (million km2)`
    : `area-weighted mean ${measure} where ${cmp} ${level}`;
  if (v.kind === 'field') {
    return { kind: 'scalar', scalar: { v: measureFrame(v.field), unit, relative: false, label } };
  }
  const t = new Float64Array(frames.length);
  const out = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    t[i] = frameEpoch(frames[i].date);
    out[i] = measureFrame(frames[i]);
  }
  return { kind: 'series', series: { t, v: out, unit, relative: false, label } };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────────────

/**
 * Executes one non-source node. Inputs are the already-computed values of its input ports;
 * returns the node's output value, or a {@link SinkResult} for sinks.
 */
export function executeOp(node: AnalysisNode, inputs: Record<string, Value>): Value | SinkResult {
  const params = node.params ?? {};
  switch (node.op) {
    case 'region': {
      if (params.preset !== undefined) {
        return { kind: 'region', region: { kind: 'preset', name: params.preset as never } };
      }
      if (params.points !== undefined) {
        const pts = parseRing(params.points as string);
        if (pts.length < 3) {
          throw new OpError(node.id, 'a polygon region needs at least 3 "lon,lat" vertices');
        }
        return { kind: 'region', region: { kind: 'polygon', points: pts } };
      }
      return {
        kind: 'region',
        region: {
          kind: 'bbox',
          lonMin: params.lonMin as number, latMin: params.latMin as number,
          lonMax: params.lonMax as number, latMax: params.latMax as number,
        },
      };
    }
    case 'mask': return opMask(node, inputs);
    case 'filter': return opFilter(node, inputs, params);
    case 'derive': return opDerive(node, inputs, params);
    case 'isoline': return opIsoline(node, inputs, params);
    case 'anomaly': return opAnomaly(node, inputs, params);
    case 'lag': return opLag(node, inputs, params);
    case 'selectFrames': return opSelectFrames(node, inputs, params);
    case 'areaMean': return opAreaMean(node, inputs);
    case 'timeReduce': return opTimeReduce(node, inputs, params);
    case 'trend': return opTrend(node, inputs, params);
    case 'math': return opMath(node, inputs, params);
    case 'correlate': return opCorrelate(node, inputs, params);
    case 'correlateSeries': return opCorrelateSeries(node, inputs, params);
    case 'regress': return opRegress(node, inputs, params);
    case 'display': return opDisplay(node, inputs, params);
    case 'chart': return opChart(node, inputs, params);
    case 'answer': return opAnswer(node, inputs, params);
    case 'scatter': return opScatter(node, inputs, params);
    case 'histogram': return opHistogram(node, inputs, params);
    case 'hovmoller': return opHovmoller(node, inputs, params);
    case 'annotate': return opAnnotate(node, inputs, params);
    case 'displayVectors': return opVectors(node, inputs, params);
    case 'layer':
    case 'enso':
    case 'forecast':
      throw new OpError(node.id, `internal: source op "${node.op}" must be materialized by the caller`);
  }
}
