/**
 * LLM front-end surface for the analysis graph (TODO/geo-analysis-graph.md §7): the
 * `run_analysis` tool's JSON Schema, the program sanitizer for what comes back, and the
 * system-prompt renderer — all generated from the {@link OPS} metadata table so the language
 * has one source of truth.
 *
 * The tool is deliberately NOT `strict`. Strict-mode grammars are compiled server-side and
 * a 16-op language exceeds their size limits (first the ≤16 union-typed-parameter budget,
 * then the overall compiled-grammar cap — both hit live). The schema still shapes the
 * model's output — op names, layer keys, and enums are enumerated, objects are closed, and
 * only genuinely required fields are `required` (optional ones are simply omitted) — and
 * anything that slips through comes back from `validate` as structured issues the
 * tool-runner loop lets the model repair. {@link sanitizeProgram} additionally strips
 * null / empty-string placeholders defensively.
 *
 * @category Analysis
 */

import { OPS, OP_NAMES, type AnalysisNode, type AnalysisProgram, type OpName, type ParamSpec, type ParamValue } from './ast.js';
import { REGION_PRESETS, MIN_TEMPORAL_SAMPLES } from './types.js';
import type { CatalogEntry } from './field_store.js';

/** A JSON Schema fragment (kept untyped — it goes straight into the tool definition). */
export type JsonSchema = Record<string, unknown>;

function paramSchema(name: string, p: ParamSpec, op: OpName, layerKeys: string[]): JsonSchema {
  if (op === 'layer' && name === 'layer' && layerKeys.length > 0) {
    return { type: 'string', enum: layerKeys, description: p.description };
  }
  const s: JsonSchema = { type: p.type, description: p.description };
  if (p.enum) {
    s.enum = [...p.enum];
  }
  return s;
}

function nodeSchema(op: OpName, layerKeys: string[]): JsonSchema {
  const spec = OPS[op];
  const props: Record<string, JsonSchema> = {
    id: { type: 'string', description: 'Unique node id within the program.' },
    op: { const: op, description: spec.description },
  };
  const required = ['id', 'op'];
  if (Object.keys(spec.inputs).length > 0) {
    const iProps: Record<string, JsonSchema> = {};
    const iRequired: string[] = [];
    for (const [name, port] of Object.entries(spec.inputs)) {
      iProps[name] = { type: 'string', description: `${port.description} Id of a node producing: ${port.types.join(' | ')}.${port.required ? '' : ' Omit when unused.'}` };
      if (port.required) {
        iRequired.push(name);
      }
    }
    props.inputs = { type: 'object', properties: iProps, ...(iRequired.length > 0 ? { required: iRequired } : {}), additionalProperties: false };
    if (iRequired.length > 0) {
      required.push('inputs');
    }
  }
  if (Object.keys(spec.params).length > 0) {
    const pProps: Record<string, JsonSchema> = {};
    const pRequired: string[] = [];
    for (const [name, p] of Object.entries(spec.params)) {
      pProps[name] = paramSchema(name, p, op, layerKeys);
      if (p.required) {
        pRequired.push(name);
      }
    }
    props.params = { type: 'object', properties: pProps, ...(pRequired.length > 0 ? { required: pRequired } : {}), additionalProperties: false };
    if (pRequired.length > 0) {
      required.push('params');
    }
  }
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/**
 * The `run_analysis` tool's `input_schema`. `layerKeys` (from the FieldStore catalog) become
 * the enum on the `layer` param, so the model cannot source a layer that doesn't exist.
 */
export function runAnalysisInputSchema(layerKeys: string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        description: 'A flat dataflow DAG: nodes reference producers by id via inputs. '
          + 'Every program needs at least one sink (display, chart, or answer). '
          + 'Omit optional fields you don\'t use.',
        items: { anyOf: OP_NAMES.map((op) => nodeSchema(op, layerKeys)) },
      },
    },
    required: ['nodes'],
    additionalProperties: false,
  };
}

/** Strips the schema's `null` placeholders (and junk) back into a clean {@link AnalysisProgram}. */
export function sanitizeProgram(input: unknown): AnalysisProgram {
  const raw = (input as { nodes?: unknown } | null)?.nodes;
  const nodes: AnalysisNode[] = [];
  for (const n of Array.isArray(raw) ? raw : []) {
    if (!n || typeof n !== 'object') {
      continue;
    }
    const r = n as Record<string, unknown>;
    const node: AnalysisNode = { id: String(r.id ?? ''), op: r.op as OpName };
    if (r.inputs && typeof r.inputs === 'object') {
      const entries = Object.entries(r.inputs as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0);
      if (entries.length > 0) {
        node.inputs = Object.fromEntries(entries);
      }
    }
    if (r.params && typeof r.params === 'object') {
      const entries = Object.entries(r.params as Record<string, unknown>)
        .filter((e): e is [string, ParamValue] => e[1] !== null && e[1] !== undefined && e[1] !== '');
      if (entries.length > 0) {
        node.params = Object.fromEntries(entries);
      }
    }
    nodes.push(node);
  }
  return { nodes };
}

// ── URL sharing ──────────────────────────────────────────────────────────────────────

/** Encodes a program as a base64url string for `?prog=` deeplinks. */
export function encodeProgram(program: AnalysisProgram): string {
  const bytes = new TextEncoder().encode(JSON.stringify(program));
  let bin = '';
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a `?prog=` deeplink back into a (sanitized) program. Throws on garbage. */
export function decodeProgram(encoded: string): AnalysisProgram {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return sanitizeProgram(JSON.parse(new TextDecoder().decode(bytes)));
}

// ── System prompt ────────────────────────────────────────────────────────────────────

const EXAMPLE_CORRELATION = {
  nodes: [
    { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2020-01', end: '2026-06', stepMonths: 4 } },
    { id: 'wind', op: 'layer', params: { layer: 'wind', start: '2020-01', end: '2026-06', stepMonths: 4, component: 'speed' } },
    { id: 'r', op: 'correlate', inputs: { a: 'sst', b: 'wind' }, params: { mode: 'temporal' } },
    { id: 'show', op: 'display', inputs: { value: 'r' }, params: { title: 'r · SST × wind speed' } },
    { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'per-cell correlation of SST vs wind speed' } },
  ],
};

const EXAMPLE_ENSO_COMPOSITE = {
  nodes: [
    { id: 'sst', op: 'layer', params: { layer: 'anom', start: '2016-01', end: '2026-06', stepMonths: 1 } },
    { id: 'oni', op: 'enso' },
    { id: 'nino', op: 'selectFrames', inputs: { value: 'sst', oni: 'oni' }, params: { phase: 'elnino', months: '12,1,2' } },
    { id: 'mean', op: 'timeReduce', inputs: { value: 'nino' }, params: { stat: 'mean' } },
    { id: 'show', op: 'display', inputs: { value: 'mean' }, params: { title: 'SST anomaly · El Niño winters' } },
    { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: 'mean SST anomaly during El Niño winters' } },
  ],
};

const EXAMPLE_REGION_SERIES = {
  nodes: [
    { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2016-01', end: '2026-06', stepMonths: 1 } },
    { id: 'reg', op: 'region', params: { preset: 'nino34' } },
    { id: 'mean', op: 'areaMean', inputs: { value: 'sst', region: 'reg' } },
    { id: 'oni', op: 'enso' },
    { id: 'r', op: 'correlateSeries', inputs: { a: 'mean', b: 'oni' } },
    { id: 'c', op: 'chart', inputs: { a: 'mean' }, params: { title: 'Niño 3.4 SST' } },
    { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'correlation of Niño 3.4 SST with the ONI' } },
  ],
};

function opCheatSheet(): string {
  return OP_NAMES.map((op) => {
    const spec = OPS[op];
    const ports = Object.entries(spec.inputs).map(([n, p]) => `${n}${p.required ? '' : '?'}: ${p.types.join('|')}`).join(', ');
    const params = Object.entries(spec.params).map(([n, p]) => `${n}${p.required ? '' : '?'}${p.enum ? `∈{${p.enum.join(',')}}` : ''}`).join(', ');
    return `- ${op}(${ports})${params ? ` [${params}]` : ''} — ${spec.description}`;
  }).join('\n');
}

/**
 * The `run_analysis` system prompt: the data catalog, the op cheat sheet, worked examples,
 * and narration rules. Stable for a given catalog — put it first in `system` and cache it.
 */
export function renderSystemPrompt(catalog: CatalogEntry[]): string {
  const layers = catalog.map((c) =>
    `- ${c.key}${c.vector ? ' (vector — set component)' : ''}: ${c.description}. Unit ${c.unit}${c.relative ? ' (relative)' : ''}, coverage ${c.coverage.start} → ${c.coverage.end}.${c.caveats ? ` Caveat: ${c.caveats}.` : ''}`,
  ).join('\n');
  const regions = Object.entries(REGION_PRESETS)
    .map(([name, b]) => `${name} (${b.lonMin}..${b.lonMax}°E, ${b.latMin}..${b.latMax}°N)`)
    .join(', ');

  return `You are the analysis assistant of an interactive Earth-data explorer showing NOAA ocean and atmosphere layers on a world map. You answer questions about the data by writing small dataflow programs and running them with the run_analysis tool. The user sees the same map you draw on.

## Data layers
${layers}

Region presets: ${regions}. Custom boxes: lonMin > lonMax wraps the antimeridian.

## The program language
A program is a flat list of nodes forming a DAG; inputs reference producer node ids. Value types: scalar, series (time), field (one lat/lon grid), stack (time × grid), region. Every program needs at least one sink (display / chart / answer). Omit optional fields you don't use.

${opCheatSheet()}

Semantics to respect:
- Spatial reductions are cos(lat)-weighted; stacks pair frames by nearest date (within half the coarser cadence).
- Per-cell temporal stats (correlate temporal, trend) need ≥ ${MIN_TEMPORAL_SAMPLES} paired frames per cell — pick date ranges and stepMonths that give enough frames (e.g. 2020→now at 4 months ≈ 19 frames; at 1 month you get more statistical power but slower loads).
- correlate(a, lag(b, N)) pairs a(t) with b(t−N months), i.e. tests whether b LEADS a by N months.
- anomaly subtracts a climatology you should STATE (baselineStart/baselineEnd, e.g. 1991-01→2020-12, which must be inside the layer's loaded range). With no baseline the reference is the loaded window's own mean, so the answer changes with the date range. Across more than a year of monthly frames also set climatology:"monthly", or the seasonal cycle stays in the "anomaly". (The anom LAYER is a different thing: NOAA's own 1971–2000 climatology, already applied.)
- selectFrames with phase needs the oni input connected to an enso node; phase is the instantaneous ONI ±0.5 threshold.

Uncertainty — this matters more than any other rule here:
- trend and correlate(temporal) test every cell on the EFFECTIVE sample size (raw n discounted by lag-1 autocorrelation), not the frame count. The answer payload's \`significance\` block gives the tested-cell count, the fraction with p ≤ 0.05 / 0.01, and the median nEff. Quote those, not the frame count.
- When the question is "where is this real?", set \`stipple: 0.05\` on the DISPLAY sink: the map keeps every estimate and dot-hatches the cells that fail, which is what a reader needs. Use trend/correlate's \`significance\` only to EXCLUDE weak cells from a downstream statistic — it blanks them, and a blank cell cannot be told apart from missing data.
- correlateSeries returns \`p\` and \`nEff\`. Report r WITH p and nEff. A large r on ~10 independent samples is not a finding.
- A missing p means UNTESTED, not "not significant" — say so rather than implying either result.
- correlate(spatial) has NO p-value by design: grid cells are not independent samples. Describe it as an association only.
- areaMean carries per-sample coverage; if minCoverage is low the region was mostly land or no-data and the mean is about a small part of the area asked for. Say so.

## Worked examples
"Is there a correlation between sea temperature and wind?"
${JSON.stringify(EXAMPLE_CORRELATION)}

"What does SST anomaly look like during El Niño winters?"
${JSON.stringify(EXAMPLE_ENSO_COMPOSITE)}

"Does Niño 3.4 SST track the ONI?"
${JSON.stringify(EXAMPLE_REGION_SERIES)}

## Answering rules
- Prefer display for map-shaped results (the user sees it immediately) plus an answer for the numbers; chart for time series.
- The tool result carries the numbers (answer payloads, coverage, n). Read them and answer with the actual values; never invent numbers.
- Correlations on gridded data are associations, not significance — say "associated with", not "causes"; always mention n and the date window you used.
- If the tool returns errors, fix the program and retry — the errors name the node, port, or param at fault.
- Follow-ups usually mean editing the previous program (a node or two), not starting over.
- Be compact: a short paragraph with the key numbers, then one line on what the map/chart shows.`;
}
