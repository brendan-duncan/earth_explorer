/**
 * Program AST + op metadata for the geo analysis graph (TODO/geo-analysis-graph.md).
 *
 * A program is a FLAT list of nodes referencing each other by id — not a recursive tree.
 * That is deliberate: it is the natural encoding of a DAG, it is what a node editor edits,
 * and it sidesteps the no-recursive-schemas limit of strict LLM structured outputs.
 *
 * The {@link OPS} table is the single source of truth for the language: the validator's
 * signatures, the LLM tool's JSON schema, and the node editor's port/param widgets all
 * derive from it. Adding an op = one entry here + one implementation in `ops.ts`.
 *
 * @category Analysis
 */

import type { ValueType } from './types.js';

/** @category Analysis */
export type OpName =
  | 'layer' | 'enso' | 'region' | 'forecast'
  | 'mask' | 'filter' | 'derive' | 'anomaly' | 'lag' | 'selectFrames' | 'isoline'
  | 'areaMean' | 'timeReduce' | 'trend'
  | 'math' | 'correlate' | 'correlateSeries' | 'regress'
  | 'display' | 'chart' | 'answer'
  | 'scatter' | 'histogram' | 'hovmoller' | 'annotate' | 'displayVectors';

/** Param values are flat JSON scalars — friendly to URL sharing and strict LLM schemas. */
export type ParamValue = string | number | boolean;

/** One node of a program. @category Analysis */
export interface AnalysisNode {
  /** Unique within the program. */
  id: string;
  op: OpName;
  /** Port name → id of the producing node. */
  inputs?: Record<string, string>;
  params?: Record<string, ParamValue>;
}

/** A whole program. Node order is arbitrary; the interpreter topo-sorts. @category Analysis */
export interface AnalysisProgram {
  nodes: AnalysisNode[];
}

// ── Op metadata ──────────────────────────────────────────────────────────────────────

/** @category Analysis */
export interface ParamSpec {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  enum?: readonly string[];
  description: string;
}

/** @category Analysis */
export interface PortSpec {
  /** Edge types this port accepts. */
  types: readonly ValueType[];
  required?: boolean;
  description: string;
}

/** @category Analysis */
export interface OpSpec {
  description: string;
  inputs: Record<string, PortSpec>;
  params: Record<string, ParamSpec>;
  /** Source ops produce data the caller must materialize before interpretation. */
  source?: boolean;
  /** Sinks have no output; they emit results. Every program needs at least one. */
  sink?: boolean;
  /**
   * Output type for resolved input types + params — `null` for sinks, `{ error }` when the
   * combination is invalid (e.g. `correlate(temporal)` over anything but two stacks).
   */
  resolve(inputs: Record<string, ValueType>, params: Record<string, ParamValue>): ValueType | null | { error: string };
  /** Op-specific structural check (param coupling); returns an error message or null. */
  check?(params: Record<string, ParamValue>, inputs: Record<string, string>): string | null;
}

// `turbo` last and effectively deprecated: its lightness is not monotonic, so it invents boundaries
// the data does not have, and it collapses under simulated protanopia. See sst_colormap.ts.
const COLORMAPS = ['thermal', 'balance', 'viridis', 'cividis', 'ice', 'chl', 'grayscale', 'turbo'] as const;
const REGION_PRESET_NAMES = [
  'nino34', 'tropics', 'arctic', 'southern-ocean', 'gulf-stream', 'north-atlantic', 'north-pacific',
] as const;

const same = (t: ValueType): ValueType => t;

/** Shared param check for the `significance` threshold on trend / correlate. */
function significanceCheck(v: ParamValue | undefined): string | null {
  if (v === undefined) {
    return null;
  }
  if (typeof v !== 'number' || !(v > 0 && v < 1)) {
    return 'significance must be a probability strictly between 0 and 1 (e.g. 0.05)';
  }
  return null;
}

/** The op catalog. @category Analysis */
export const OPS: Record<OpName, OpSpec> = {
  // ── Sources (materialized by the caller — FieldStore in the explorer, fixtures in tests) ──
  layer: {
    description: 'A data layer as a stack of dated 1° fields. Vector layers (wind, currents) '
      + 'must pick a scalar component.',
    source: true,
    inputs: {},
    params: {
      // This list is the LLM's only view of the catalog, so it has to stay in step with the host's
      // providers — a stale key here becomes a program that fails to materialize.
      layer: { type: 'string', required: true, description: 'Layer key (sst, anom, ice, chl, dhw, baa, mhw, waves, swell, windsea, period, rain, precip, precipmon, landanom, airtemp, skintemp, humidity, pressure, solar, swup, lwup, lwdown, wind, currents). precipmon (monthly rainfall, 1979→) and landanom (monthly land air-temperature anomaly, 1979→) are the long land-climate records — use them, not precip/airtemp, for anything spanning decades or ENSO events.' },
      start: { type: 'string', description: 'Inclusive start, YYYY-MM. Default: the explorer\'s time-lapse floor.' },
      end: { type: 'string', description: 'Inclusive end, YYYY-MM. Default: now.' },
      stepMonths: { type: 'number', description: 'Months between frames (1, 2, or 4). Default: the explorer\'s current cadence.' },
      component: { type: 'string', enum: ['speed', 'u', 'v'], description: 'Required for vector layers: which scalar to extract.' },
    },
    resolve: () => 'stack',
  },
  enso: {
    description: 'The monthly Oceanic Niño Index (ONI) as a series.',
    source: true,
    inputs: {},
    params: {},
    resolve: () => 'series',
  },
  region: {
    description: 'An analysis region: a named preset, a lon/lat box (lonMin > lonMax wraps the '
      + 'antimeridian), or an arbitrary POLYGON via `points`. Every spatial reduction (areaMean, '
      + 'mask, histogram, hovmoller) restricts through it the same way.',
    inputs: {},
    params: {
      preset: { type: 'string', enum: REGION_PRESET_NAMES, description: 'Named region.' },
      lonMin: { type: 'number', description: 'West edge, degrees.' },
      latMin: { type: 'number', description: 'South edge, degrees.' },
      lonMax: { type: 'number', description: 'East edge, degrees.' },
      latMax: { type: 'number', description: 'North edge, degrees.' },
      points: {
        type: 'string',
        description: 'Polygon ring as "lon,lat lon,lat …" (≥3 vertices; closes automatically). '
          + 'Takes precedence over the box params. This is what drawing an area on the map produces.',
      },
    },
    resolve: () => 'region',
    check: (params) => {
      const hasPreset = params.preset !== undefined;
      const bbox = ['lonMin', 'latMin', 'lonMax', 'latMax'].filter((k) => params[k] !== undefined);
      if (hasPreset && bbox.length > 0) {
        return 'give either preset or bbox bounds, not both';
      }
      if (!hasPreset && bbox.length !== 4) {
        return 'give preset, or all four of lonMin/latMin/lonMax/latMax';
      }
      return null;
    },
  },

  forecast: {
    description: 'An ML forecast: a small on-device neural network rolls a layer forward '
      + 'month by month from the latest observations (or `from`). Output is a stack with one '
      + 'PREDICTED frame per future month — treat it as an outlook, not data.',
    source: true,
    inputs: {},
    params: {
      layer: { type: 'string', required: true, enum: ['anom'], description: 'Layer to forecast (only anom — the model is trained on the SST anomaly).' },
      months: { type: 'number', description: 'How many months ahead to predict, 1–6. Default 3.' },
      from: { type: 'string', description: 'Last observed month to forecast from, YYYY-MM. Default: the latest available data.' },
    },
    resolve: () => 'stack',
    check: (params) => {
      const m = params.months;
      if (m !== undefined && (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 6)) {
        return 'months must be a whole number between 1 and 6';
      }
      if (params.from !== undefined && !/^\d{4}-\d{2}$/.test(String(params.from))) {
        return 'from must be YYYY-MM';
      }
      return null;
    },
  },

  // ── Transforms (shape-preserving) ──────────────────────────────────────────────────
  mask: {
    description: 'Keeps only cells inside the region; everything else becomes no-data.',
    inputs: {
      value: { types: ['stack', 'field'], required: true, description: 'What to mask.' },
      region: { types: ['region'], required: true, description: 'Where to keep data.' },
    },
    params: {},
    resolve: (i) => same(i.value),
  },
  filter: {
    description: 'Range filter: keeps only cells whose value falls in [min, max] and drops the rest '
      + 'to no-data, so every downstream reduction sees just the part you asked about ("area mean '
      + 'WHERE heat stress ≥ 4"). Shape-preserving — it narrows the data, not the grid.',
    inputs: { value: { types: ['stack', 'field', 'series'], required: true, description: 'What to filter.' } },
    params: {
      min: { type: 'number', description: 'Lower bound, inclusive. Omit for no lower bound.' },
      max: { type: 'number', description: 'Upper bound, inclusive. Omit for no upper bound.' },
      abs: { type: 'boolean', description: 'Compare |value| instead of value — for "anomaly of either sign, bigger than N".' },
    },
    resolve: (i) => same(i.value),
  },
  derive: {
    description: 'Applies one function to every value — ODV-style derived variables. log10/ln are the '
      + 'ones that matter most: log-distributed quantities (chlorophyll, rainfall) correlate and average '
      + 'meaningfully in log space, where a Pearson r on raw values is dominated by a few extremes. '
      + 'Non-positive inputs to a log become no-data.',
    inputs: { value: { types: ['stack', 'field', 'series', 'scalar'], required: true, description: 'What to transform.' } },
    params: {
      fn: {
        type: 'string', required: true,
        enum: ['log10', 'ln', 'abs', 'sqrt', 'square', 'negate', 'inverse'],
        description: 'Function to apply.',
      },
    },
    resolve: (i) => same(i.value),
  },
  isoline: {
    description: 'The 2-D analogue of an isosurface: measures the region a contour encloses instead of '
      + 'colouring a depth surface. `area` gives the extent where value ≥ level (sea-ice extent, '
      + 'marine-heatwave coverage); `latitude`/`longitude` give the area-weighted mean position of that '
      + 'region, which tracks a boundary — the ice edge, the 26.5°C cyclone threshold — over time. '
      + 'Cells are counted whole on the 1° analysis grid, so an extent runs a few percent high '
      + 'against an operational figure computed at the source resolution; the SHAPE of the series is '
      + 'what this is for, not headline agreement.',
    inputs: {
      value: { types: ['stack', 'field'], required: true, description: 'Field whose contour to measure.' },
      region: { types: ['region'], description: 'Restrict to a region first (e.g. one hemisphere).' },
    },
    params: {
      level: { type: 'number', required: true, description: 'Contour value, in the layer’s physical units.' },
      measure: {
        type: 'string', enum: ['area', 'latitude', 'longitude'],
        description: 'What to report (default area, in million km²).',
      },
      below: { type: 'boolean', description: 'Measure value ≤ level instead of ≥.' },
    },
    resolve: (i) => (i.value === 'stack' ? 'series' : 'scalar'),
  },
  anomaly: {
    description: 'Subtracts a climatology. State the baseline: with no baselineStart/baselineEnd '
      + 'the reference is the mean of whatever frames happen to be LOADED, so the same cell changes '
      + 'value when the date range or cadence changes — fine for a quick look, not for a result you '
      + 'will quote. climatology="monthly" removes the SEASONAL CYCLE (each calendar month against '
      + 'its own baseline mean), which is what operational anomaly products mean by the word; the '
      + 'default "window" subtracts one flat mean and leaves the seasonal cycle in. The baseline '
      + 'used is recorded on the output and shown in legends, charts and CSV exports.',
    inputs: { value: { types: ['stack'], required: true, description: 'Stack to de-mean.' } },
    params: {
      baselineStart: { type: 'string', description: 'First month of the reference period, YYYY-MM (e.g. 1991-01). Must be inside the loaded range.' },
      baselineEnd: { type: 'string', description: 'Last month of the reference period, YYYY-MM (e.g. 2020-12).' },
      climatology: {
        type: 'string', enum: ['window', 'monthly'],
        description: 'window (default) = one flat mean; monthly = per-calendar-month means, removing the seasonal cycle.',
      },
      as: {
        type: 'string', enum: ['difference', 'percent'],
        description: 'difference (default) = value − climatology, in the layer\'s units; percent = (value − climatology) / climatology × 100, '
          + 'i.e. percent of normal. Use percent for rainfall: a 1 mm/day excess is a flood in a desert and noise in a monsoon, and '
          + 'raw differences let the wettest places dominate every map. Cells with a climatology ≤ 0 become no-data.',
      },
    },
    resolve: () => 'stack',
    check: (params) => {
      for (const k of ['baselineStart', 'baselineEnd']) {
        if (params[k] !== undefined && !/^\d{4}-\d{2}$/.test(String(params[k]))) {
          return `${k} must be YYYY-MM`;
        }
      }
      const s = params.baselineStart, e = params.baselineEnd;
      if (s !== undefined && e !== undefined && String(s) > String(e)) {
        return 'baselineStart is after baselineEnd';
      }
      return null;
    },
  },
  lag: {
    description: 'Shifts dates forward by N months. correlate(a, lag(b, 3)) pairs a(t) with '
      + 'b(t−3mo), i.e. tests whether b leads a by 3 months.',
    inputs: { value: { types: ['stack', 'series'], required: true, description: 'What to shift.' } },
    params: { months: { type: 'number', required: true, description: 'Whole months to shift (negative allowed).' } },
    resolve: (i) => same(i.value),
  },
  selectFrames: {
    description: 'Keeps only frames matching a month-of-year list and/or an ENSO phase '
      + '(phase = instantaneous ONI threshold ±0.5 at the nearest month — a simplification '
      + 'of the CPC 5-season rule).',
    inputs: {
      value: { types: ['stack'], required: true, description: 'Stack to filter.' },
      oni: { types: ['series'], description: 'ONI series (an enso node); required when phase is set.' },
    },
    params: {
      months: { type: 'string', description: 'Comma-separated months of year to keep, e.g. "12,1,2".' },
      phase: { type: 'string', enum: ['elnino', 'lanina', 'neutral'], description: 'ENSO phase to keep.' },
    },
    resolve: () => 'stack',
    check: (params, inputs) => {
      if (params.months === undefined && params.phase === undefined) {
        return 'set months, phase, or both — otherwise the op is a no-op';
      }
      if (params.phase !== undefined && inputs.oni === undefined) {
        return 'phase needs the oni input (connect an enso node)';
      }
      return null;
    },
  },

  // ── Reductions ─────────────────────────────────────────────────────────────────────
  areaMean: {
    description: 'cos(lat)-weighted mean over valid cells (optionally inside a region): '
      + 'stack → series, field → scalar. The bridge from maps to time series.',
    inputs: {
      value: { types: ['stack', 'field'], required: true, description: 'What to average.' },
      region: { types: ['region'], description: 'Restrict to a region (default: all valid cells).' },
    },
    params: {},
    resolve: (i) => (i.value === 'stack' ? 'series' : 'scalar'),
  },
  timeReduce: {
    description: 'Per-cell reduction across frames → one field (mean, min, max, or range = max−min). '
      + 'per="run" instead reduces each RUN of consecutive frames separately and returns a stack — '
      + 'after selectFrames(months: "12,1,2") that is one Dec–Feb mean per winter, the seasonal series '
      + 'a teleconnection regression should be fitted to (single months carry weather noise a season averages out).',
    inputs: { value: { types: ['stack'], required: true, description: 'Stack to reduce.' } },
    params: {
      stat: { type: 'string', required: true, enum: ['mean', 'min', 'max', 'range'], description: 'Which statistic.' },
      per: {
        type: 'string', enum: ['all', 'run'],
        description: 'all (default) = one field over every frame; run = one frame per run of consecutive frames '
          + '(dated at its middle frame; runs shorter than the longest are dropped as incomplete).',
      },
    },
    resolve: (_i, p) => (p.per === 'run' ? 'stack' : 'field'),
  },
  trend: {
    description: 'Per-cell least-squares slope across frames, reported per decade, WITH a '
      + 'significance test. Each cell also carries a standard error and a two-sided p-value, tested '
      + 'on the effective sample size after discounting the residuals\' lag-1 autocorrelation — '
      + 'geophysical series are persistent, so the raw frame count is not the degrees of freedom. '
      + 'Set `significance` to blank cells whose trend is not distinguishable from zero.',
    inputs: { value: { types: ['stack'], required: true, description: 'Stack to fit.' } },
    params: {
      significance: {
        type: 'number',
        description: 'Show only cells with p ≤ this (e.g. 0.05). Cells that could not be tested at '
          + 'all are blanked too. Omit to show every fitted slope regardless of significance.',
      },
    },
    resolve: () => 'field',
    check: (params) => significanceCheck(params.significance),
  },

  // ── Combinators ────────────────────────────────────────────────────────────────────
  math: {
    description: 'Element-wise arithmetic. Operands must be the same type (stacks pair frames '
      + 'by nearest date; series pair by nearest time), or one operand may be a scalar (broadcast).',
    inputs: {
      a: { types: ['scalar', 'series', 'field', 'stack'], required: true, description: 'Left operand.' },
      b: { types: ['scalar', 'series', 'field', 'stack'], required: true, description: 'Right operand.' },
    },
    params: { fn: { type: 'string', required: true, enum: ['add', 'sub', 'mul', 'div'], description: 'Operation.' } },
    resolve: (i) => {
      if (i.a === i.b) {
        return same(i.a);
      }
      if (i.a === 'scalar') {
        return same(i.b);
      }
      if (i.b === 'scalar') {
        return same(i.a);
      }
      return { error: `math needs matching operand types or a scalar operand (got ${i.a} and ${i.b})` };
    },
  },
  correlate: {
    description: 'Pearson correlation. temporal: per-cell r across date-paired frames of two '
      + 'stacks → field. spatial: one cos(lat)-weighted r across cells → scalar (stack inputs '
      + 'are time-mean reduced first).',
    inputs: {
      a: { types: ['stack', 'field'], required: true, description: 'First variable.' },
      b: { types: ['stack', 'field'], required: true, description: 'Second variable.' },
    },
    params: {
      mode: { type: 'string', required: true, enum: ['temporal', 'spatial'], description: 'Correlation mode.' },
      significance: {
        type: 'number',
        description: 'temporal only: show only cells with p ≤ this (e.g. 0.05), tested on the '
          + 'autocorrelation-adjusted effective sample size. Spatial mode reports no p-value at all '
          + '— neighbouring cells are not independent samples, so no honest test exists here.',
      },
    },
    resolve: (i, p) => {
      if (p.mode === 'temporal') {
        if (i.a !== 'stack' || i.b !== 'stack') {
          return { error: `correlate(temporal) needs two stacks (got ${i.a} and ${i.b})` };
        }
        return 'field';
      }
      return 'scalar';
    },
    check: (params) => {
      if (params.significance !== undefined && params.mode !== 'temporal') {
        return 'significance applies to correlate(temporal) only — spatial correlation over autocorrelated grid cells has no valid p-value';
      }
      return significanceCheck(params.significance);
    },
  },
  correlateSeries: {
    description: 'Pearson r between two series (paired by nearest time), optionally lagging b. '
      + 'Reports r with a two-sided p-value and the effective sample size after discounting both '
      + 'series\' lag-1 autocorrelation — for persistent monthly indices this often halves the '
      + 'degrees of freedom, so quote nEff and p, never the raw pair count alone.',
    inputs: {
      a: { types: ['series'], required: true, description: 'First series.' },
      b: { types: ['series'], required: true, description: 'Second series.' },
    },
    params: { lagMonths: { type: 'number', description: 'Shift b forward by N months before pairing.' } },
    resolve: () => 'scalar',
  },

  regress: {
    description: 'Per-cell least-squares regression of a stack on a series (typically an index such as the ONI): '
      + 'value(t) ≈ a + b·predictor(t), frames paired to the nearest predictor sample. The statistical '
      + 'core of a TELECONNECTION outlook — "how much wetter is this cell per degree of El Niño, how '
      + 'reliably, and what does that imply for a predicted index value". output = slope (b, value '
      + 'units per predictor unit), predict (a + b·x₀ at the predictor value `at`, e.g. a forecast '
      + 'ONI), or skill (cross-validated % of variance explained, vs. climatology: each sample is '
      + 'predicted from a fit that EXCLUDES the 12 months around it, so neighbouring months of the '
      + 'same season cannot leak the answer; ≤ 0 means no usable skill). slope and predict carry a '
      + 'standard error and p-value on the autocorrelation-adjusted sample size, so display can '
      + 'stipple them. Feed it anomalies (anomaly climatology=monthly) and one season (selectFrames '
      + 'months) — a regression over every calendar month mixes seasons whose response differs.',
    inputs: {
      value: { types: ['stack'], required: true, description: 'Response: the gridded variable (usually a seasonal anomaly stack).' },
      predictor: { types: ['series'], required: true, description: 'Predictor index, e.g. an enso node (ONI).' },
      at: {
        types: ['scalar', 'series'],
        description: 'Predictor value to predict at (output=predict). A series collapses per `atFrom` — wire '
          + 'areaMean(forecast(anom), nino34) here to drive the outlook from the on-device forecast.',
      },
    },
    params: {
      output: { type: 'string', enum: ['slope', 'predict', 'skill'], description: 'What to return per cell (default slope).' },
      at: { type: 'number', description: 'Predictor value for output=predict when no `at` input is connected, e.g. 1.5 for a strong El Niño.' },
      atFrom: {
        type: 'string', enum: ['last', 'last3', 'mean', 'peak'],
        description: 'How an `at` SERIES becomes one number: last sample, mean of the last three (the season a '
          + 'forecast ends on), mean of all, or the sample with the largest magnitude. Default last3.',
      },
      minSkill: {
        type: 'number',
        description: 'slope/predict only: blank cells whose cross-validated skill (%) is below this. An outlook '
          + 'should not paint a confident colour where the relationship has never predicted anything; 0 keeps '
          + 'only cells that beat climatology at all.',
      },
    },
    resolve: () => 'field',
    check: (params, inputs) => {
      const out = params.output ?? 'slope';
      if (out === 'predict' && params.at === undefined && inputs.at === undefined) {
        return 'output=predict needs a predictor value: set the at param or connect the at input';
      }
      if (out !== 'predict' && (params.at !== undefined || inputs.at !== undefined)) {
        return 'at only applies to output=predict';
      }
      if (params.minSkill !== undefined && out === 'skill') {
        return 'minSkill filters slope/predict maps; for output=skill use a filter node instead';
      }
      if (params.minSkill !== undefined && (typeof params.minSkill !== 'number' || params.minSkill >= 100)) {
        return 'minSkill is a percentage below 100';
      }
      return null;
    },
  },

  // ── Sinks ──────────────────────────────────────────────────────────────────────────
  display: {
    description: 'Shows a field (or scrubbable stack) on the map as a derived layer. '
      + 'Auto-legend: r → balance ±1; relative → balance symmetric; else viridis p2..p98. '
      + 'An optional second input draws OVER the first as iso-lines (area colour is already spent '
      + 'on the fill), so two quantities can be compared in place instead of one at a time.',
    sink: true,
    inputs: {
      value: { types: ['field', 'stack'], required: true, description: 'What to display as the filled base.' },
      over: { types: ['field', 'stack'], description: 'Optional second quantity, drawn over the base as iso-lines.' },
    },
    params: {
      colormap: { type: 'string', enum: COLORMAPS, description: 'Override the auto colormap.' },
      title: { type: 'string', description: 'Legend title.' },
      min: { type: 'number', description: 'Override legend minimum (physical units).' },
      max: { type: 'number', description: 'Override legend maximum (physical units).' },
      stipple: {
        type: 'number',
        description: 'Stipple (dot-hatch) the cells whose p-value exceeds this, e.g. 0.05. Marks '
          + 'weak evidence WITHOUT removing the estimate — prefer this to trend/correlate\'s '
          + '`significance`, which blanks those cells and so cannot be told apart from missing data. '
          + 'Needs an input carrying per-cell uncertainty (trend, correlate temporal).',
      },
      overTitle: { type: 'string', description: 'Legend title for the overlay input.' },
      overBands: { type: 'number', description: 'Iso-line count for the overlay (default 8).' },
      overHatchAt: { type: 'number', description: 'Hatch the overlay above this PHYSICAL value; omit for lines only.' },
    },
    resolve: () => null,
  },
  chart: {
    description: 'Line chart of up to three series (dual axis when units differ).',
    sink: true,
    inputs: {
      a: { types: ['series'], required: true, description: 'First series.' },
      b: { types: ['series'], description: 'Second series.' },
      c: { types: ['series'], description: 'Third series.' },
    },
    params: { title: { type: 'string', description: 'Chart title.' } },
    resolve: () => null,
  },
  answer: {
    description: 'A structured result for the caller: the value plus the summary statistics '
      + 'needed to narrate it (fields report area-weighted mean, p5/p95, valid fraction, N).',
    sink: true,
    inputs: { value: { types: ['scalar', 'series', 'field'], required: true, description: 'What to report.' } },
    params: { label: { type: 'string', required: true, description: 'What this number answers.' } },
    resolve: () => null,
  },
  scatter: {
    description: 'Scatter plot of two variables with a least-squares line and r — shows the '
      + 'relationship a correlation number summarizes. Two series pair by date (one dot per '
      + 'time step); fields/stacks pair by cell (stacks are time-mean reduced; dots are a '
      + 'cos(lat)-weighted subsample).',
    sink: true,
    inputs: {
      a: { types: ['series', 'field', 'stack'], required: true, description: 'X variable.' },
      b: { types: ['series', 'field', 'stack'], required: true, description: 'Y variable.' },
      c: {
        types: ['series', 'field', 'stack'],
        description: 'Optional THIRD variable, mapped to dot colour. This is what makes a '
          + 'property-property plot readable — the structure inside the cloud (which water mass, '
          + 'which latitude, which season) is invisible in a two-variable scatter.',
      },
    },
    params: {
      title: { type: 'string', description: 'Plot title.' },
      maxPoints: { type: 'number', description: 'Cap on plotted points for cell mode (default 3000).' },
    },
    resolve: (i) => {
      const aIsSeries = i.a === 'series';
      const bIsSeries = i.b === 'series';
      if (aIsSeries !== bIsSeries) {
        return { error: `scatter needs two series or two gridded inputs (got ${i.a} and ${i.b})` };
      }
      if (i.c !== undefined && (i.c === 'series') !== aIsSeries) {
        return { error: `scatter's colour input must match the others (got ${i.c} alongside ${i.a})` };
      }
      return null;
    },
  },
  histogram: {
    description: 'Distribution of a field\'s valid cells (cos(lat)-weighted; stacks pool all '
      + 'frames) — how common each value is, and how skewed.',
    sink: true,
    inputs: { value: { types: ['field', 'stack'], required: true, description: 'What to bin.' } },
    params: {
      bins: { type: 'number', description: 'Bin count, 5–120 (default 40).' },
      title: { type: 'string', description: 'Plot title.' },
    },
    resolve: () => null,
    check: (params) => {
      const b = params.bins;
      if (b !== undefined && (typeof b !== 'number' || !Number.isInteger(b) || b < 5 || b > 120)) {
        return 'bins must be a whole number between 5 and 120';
      }
      return null;
    },
  },
  hovmoller: {
    description: 'Hovmöller diagram: longitude (or latitude) × time heatmap of a stack, each '
      + 'frame averaged along the other axis (optionally inside a region). THE plot for seeing '
      + 'anomalies propagate — e.g. ENSO warm pools drifting east along the equator.',
    sink: true,
    inputs: {
      value: { types: ['stack'], required: true, description: 'Stack to plot.' },
      region: { types: ['region'], description: 'Restrict the averaging to a region (e.g. an equatorial band).' },
    },
    params: {
      axis: { type: 'string', enum: ['lon', 'lat'], description: 'Horizontal axis (default lon).' },
      title: { type: 'string', description: 'Plot title.' },
    },
    resolve: () => null,
  },
  annotate: {
    description: 'Marks the strongest cells of a field on the map: pins with the value at the '
      + 'top-N maxima and/or minima (kept apart by a separation radius).',
    sink: true,
    inputs: { value: { types: ['field'], required: true, description: 'Field to mark extrema on.' } },
    params: {
      stat: { type: 'string', enum: ['max', 'min', 'both'], description: 'Which extrema to mark (default max).' },
      count: { type: 'number', description: 'Markers per kind, 1–8 (default 3).' },
      label: { type: 'string', description: 'What the markers show (used in the summary).' },
    },
    resolve: () => null,
    check: (params) => {
      const c = params.count;
      if (c !== undefined && (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 8)) {
        return 'count must be a whole number between 1 and 8';
      }
      return null;
    },
  },
  displayVectors: {
    description: 'Draws a vector field as arrows on the map from two scalar components '
      + '(u = eastward, v = northward; stacks are time-mean reduced). Arrow length scales '
      + 'with magnitude.',
    sink: true,
    inputs: {
      u: { types: ['field', 'stack'], required: true, description: 'Eastward component.' },
      v: { types: ['field', 'stack'], required: true, description: 'Northward component.' },
    },
    params: {
      title: { type: 'string', description: 'Overlay title (used in the summary).' },
      strideDeg: { type: 'number', description: 'Degrees between arrows, 2–15 (default 5).' },
      scale: { type: 'number', description: 'Arrow length multiplier (default 1).' },
    },
    resolve: () => null,
    check: (params) => {
      const s = params.strideDeg;
      if (s !== undefined && (typeof s !== 'number' || s < 2 || s > 15)) {
        return 'strideDeg must be between 2 and 15';
      }
      return null;
    },
  },
};

/** All op names, for schema generation and iteration. @category Analysis */
export const OP_NAMES = Object.keys(OPS) as OpName[];
