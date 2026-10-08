/**
 * FieldStore — materializes a program's source nodes (TODO/geo-analysis-graph.md §5).
 *
 * The interpreter never fetches; this store resolves `layer` / `enso` nodes into CPU values
 * before dispatch. It is configured with per-layer PROVIDERS (the explorer wires these from
 * its own loaders; tests use fakes) and owns everything data-shaped between them and the
 * interpreter: ingestion onto the fixed 1° analysis grid, physical-unit conversion, the
 * scalar-component extraction for vector layers, a byte-bounded stack cache whose keys
 * double as the interpreter's `sourceKeys`, and the catalog the presets UI / LLM system
 * prompt render.
 *
 * Providers return {@link AnalysisFrame}s — a structural subset of
 * {@link "../live/gridded_field.ts".GriddedField} (`meta.date`, `sample`, `sampleVector`,
 * `destroy`), so the explorer passes GriddedFields straight through and tests pass plain
 * objects. Ownership transfers to the store, which destroys frames after resampling unless
 * the provider marks them `sharedFrames`.
 *
 * @category Analysis
 */

import { AnalysisError } from './interpret.js';
import { validate } from './validate.js';
import type { AnalysisProgram } from './ast.js';
import {
  ANALYSIS_HEIGHT, ANALYSIS_WIDTH, latAt, lonAt,
  type CpuField, type CpuStack, type SeriesValue, type Unit, type Value,
} from './types.js';

/** What a provider yields — GriddedField satisfies this structurally. @category Analysis */
export interface AnalysisFrame {
  readonly meta: { date: string; vector: boolean };
  /** Physical scalar at a geodetic point, or null over land/no-data. */
  sample(lonDeg: number, latDeg: number): number | null;
  /** Physical (u,v) m/s at a geodetic point — vector frames with retained cells only. */
  sampleVector?(lonDeg: number, latDeg: number): { u: number; v: number } | null;
  destroy(): void;
}

/** One data layer the analysis graph can source. @category Analysis */
export interface AnalysisLayerProvider {
  unit: Unit;
  /** Δ-like layer (the OISST anomaly): values convert like relative temperatures. */
  relative?: boolean;
  /** Vector layer — programs must pick a `component` (speed/u/v). */
  vector?: boolean;
  /** The quantity exists over land (weather fields). Water-only layers leave it false so derived
   *  maps are not painted across continents. */
  overLand?: boolean;
  /** One line for the catalog (presets UI, LLM system prompt). */
  description: string;
  /** Inclusive coverage, `YYYY-MM`. `end` defaults to the current month. */
  coverage: { start: string; end?: string };
  caveats?: string;
  /** Physical-unit conversion applied at ingestion (K → °C, Pa → hPa, fraction → %). */
  convert?(v: number): number;
  /** Loads the frames covering [start, end] (inclusive `YYYY-MM`) at the cadence. */
  getFrames(range: { start: string; end: string }, stepMonths: number): Promise<AnalysisFrame[]>;
  /** Frames are shared with the display — the store must not destroy them. */
  sharedFrames?: boolean;
}

/** A materialization request for one `forecast` node. @category Analysis */
export interface ForecastRequest {
  layer: string;
  /** Months ahead to predict (1–6). */
  months: number;
  /** Last observed month (`YYYY-MM`) to roll forward from; default = latest available. */
  from?: string;
}

/**
 * Produces predicted stacks for `forecast` source nodes. The engine defines only this seam;
 * the host supplies the model (the explorer runs a LiteRT neural net on-device).
 * @category Analysis
 */
export interface AnalysisForecaster {
  /** Model identity for caching — bump when the model or its weights change. */
  version: string;
  /** Layer keys this forecaster can predict. */
  layers: string[];
  run(req: ForecastRequest, store: FieldStore): Promise<CpuStack>;
}

/** A materialization request for one `layer` node. @category Analysis */
export interface StackRequest {
  layer: string;
  component?: 'speed' | 'u' | 'v';
  /** Inclusive `YYYY-MM`; defaults to the provider's coverage. */
  start?: string;
  end?: string;
  stepMonths?: number;
}

/** @category Analysis */
export interface CatalogEntry {
  key: string;
  unit: Unit;
  vector: boolean;
  relative: boolean;
  description: string;
  coverage: { start: string; end: string };
  caveats?: string;
}

interface CacheEntry { stack: CpuStack; bytes: number; }

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** @category Analysis */
export class FieldStore {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly maxBytes: number;
  private oni: Promise<SeriesValue> | null = null;

  constructor(
    private readonly providers: Record<string, AnalysisLayerProvider>,
    private readonly opts: {
      /** ONI loader for `enso` nodes (the explorer wires src/geo/live/enso.ts here). */
      loadOni?: () => Promise<SeriesValue>;
      /** Cadence used when a `layer` node doesn't set `stepMonths`. Default 4. */
      defaultStepMonths?: number;
      /** Model behind `forecast` nodes; without one they fail with a structured error. */
      forecaster?: AnalysisForecaster;
      /** CPU cache budget for materialized stacks. Default 300 MB. */
      maxBytes?: number;
    } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 300 * 1024 * 1024;
  }

  /** Per-layer metadata for the presets UI and the LLM system prompt. */
  catalog(): CatalogEntry[] {
    return Object.entries(this.providers).map(([key, p]) => ({
      key,
      unit: p.unit,
      vector: p.vector ?? false,
      relative: p.relative ?? false,
      description: p.description,
      coverage: { start: p.coverage.start, end: p.coverage.end ?? currentMonth() },
      caveats: p.caveats,
    }));
  }

  /** Fills request defaults and validates it against the provider — throws AnalysisError. */
  private normalize(req: StackRequest, node?: string): Required<Omit<StackRequest, 'component'>> & { component?: 'speed' | 'u' | 'v' } {
    const p = this.providers[req.layer];
    if (!p) {
      throw new AnalysisError([{
        node, param: 'layer',
        message: `unknown layer "${req.layer}"`,
        hint: `available: ${Object.keys(this.providers).join(', ')}`,
      }]);
    }
    if (p.vector && !req.component) {
      throw new AnalysisError([{
        node, param: 'component',
        message: `layer "${req.layer}" is a vector field — set component to speed, u, or v`,
      }]);
    }
    if (!p.vector && req.component) {
      throw new AnalysisError([{
        node, param: 'component',
        message: `layer "${req.layer}" is scalar — component does not apply`,
      }]);
    }
    const start = req.start ?? p.coverage.start;
    const end = req.end ?? p.coverage.end ?? currentMonth();
    if (start > end) {
      throw new AnalysisError([{ node, message: `empty date range ${start}..${end}` }]);
    }
    return { layer: req.layer, component: req.component, start, end, stepMonths: req.stepMonths ?? this.opts.defaultStepMonths ?? 4 };
  }

  /** Stable identity of a request — cache key here, `sourceKeys` entry for the interpreter. */
  sourceKey(req: StackRequest): string {
    const n = this.normalize(req);
    return `${n.layer}|${n.component ?? ''}|${n.start}|${n.end}|${n.stepMonths}mo`;
  }

  /** Materializes one layer request as a CPU stack on the 1° analysis grid (cached). */
  async getStack(req: StackRequest, node?: string): Promise<CpuStack> {
    const n = this.normalize(req, node);
    const key = `${n.layer}|${n.component ?? ''}|${n.start}|${n.end}|${n.stepMonths}mo`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);   // LRU refresh
      this.cache.set(key, hit);
      return hit.stack;
    }
    const p = this.providers[n.layer];
    const frames = await p.getFrames({ start: n.start, end: n.end }, n.stepMonths);
    const fields: CpuField[] = [];
    for (const frame of frames) {
      fields.push(ingest(frame, p, n.component));
      if (!p.sharedFrames) {
        frame.destroy();
      }
    }
    fields.sort((a, b) => a.date.localeCompare(b.date));
    const stack: CpuStack = { frames: fields };
    const bytes = fields.length * ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 4 + 256;
    this.cache.set(key, { stack, bytes });
    this.cacheBytes += bytes;
    while (this.cacheBytes > this.maxBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    return stack;
  }

  /** Cache identity of a forecast request (includes the model version). */
  private forecastKey(req: ForecastRequest): string {
    return `forecast|${this.opts.forecaster?.version ?? '?'}|${req.layer}|${req.from ?? 'latest'}|${req.months}mo`;
  }

  /** Materializes one `forecast` node through the configured forecaster (cached). */
  async getForecast(req: ForecastRequest, node?: string): Promise<CpuStack> {
    const f = this.opts.forecaster;
    if (!f) {
      throw new AnalysisError([{
        node, message: 'no forecast model is configured — forecast nodes are unavailable',
      }]);
    }
    if (!f.layers.includes(req.layer)) {
      throw new AnalysisError([{
        node, param: 'layer',
        message: `no forecast model for layer "${req.layer}"`,
        hint: `available: ${f.layers.join(', ')}`,
      }]);
    }
    const key = this.forecastKey(req);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);   // LRU refresh
      this.cache.set(key, hit);
      return hit.stack;
    }
    const stack = await f.run(req, this);
    const bytes = stack.frames.length * ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 4 + 256;
    this.cache.set(key, { stack, bytes });
    this.cacheBytes += bytes;
    while (this.cacheBytes > this.maxBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    return stack;
  }

  /** The monthly ONI series for `enso` nodes (loaded once). */
  getOni(): Promise<SeriesValue> {
    if (!this.opts.loadOni) {
      return Promise.reject(new AnalysisError([{ message: 'no ONI loader configured — enso nodes are unavailable' }]));
    }
    this.oni ??= this.opts.loadOni();
    return this.oni;
  }

  /**
   * Materializes every source node a program actually needs (validated + pruned — sources
   * feeding no sink load nothing). Returns the interpreter's `sources` + `sourceKeys`.
   */
  async resolveSources(program: AnalysisProgram): Promise<{ sources: Record<string, Value>; sourceKeys: Record<string, string> }> {
    const v = validate(program);
    if (!v.ok) {
      throw new AnalysisError(v.errors);
    }
    const byId = new Map(program.nodes.map((nd) => [nd.id, nd]));
    const sources: Record<string, Value> = {};
    const sourceKeys: Record<string, string> = {};
    for (const id of v.order) {
      const nd = byId.get(id)!;
      if (nd.op === 'layer') {
        const params = nd.params ?? {};
        const req: StackRequest = {
          layer: params.layer as string,
          component: params.component as StackRequest['component'],
          start: params.start as string | undefined,
          end: params.end as string | undefined,
          stepMonths: params.stepMonths as number | undefined,
        };
        sources[id] = { kind: 'stack', stack: await this.getStack(req, id) };
        sourceKeys[id] = this.sourceKey(req);
      } else if (nd.op === 'enso') {
        sources[id] = { kind: 'series', series: await this.getOni() };
        sourceKeys[id] = 'enso|oni';
      } else if (nd.op === 'forecast') {
        const params = nd.params ?? {};
        const req: ForecastRequest = {
          layer: params.layer as string,
          months: (params.months as number | undefined) ?? 3,
          from: params.from as string | undefined,
        };
        sources[id] = { kind: 'stack', stack: await this.getForecast(req, id) };
        sourceKeys[id] = this.forecastKey(req);
      }
    }
    return { sources, sourceKeys };
  }
}

/** Resamples one provider frame onto the 1° grid as decoded physical floats. */
function ingest(frame: AnalysisFrame, p: AnalysisLayerProvider, component?: 'speed' | 'u' | 'v'): CpuField {
  const values = new Float32Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT);
  for (let y = 0; y < ANALYSIS_HEIGHT; y++) {
    const lat = latAt(y, ANALYSIS_HEIGHT);
    for (let x = 0; x < ANALYSIS_WIDTH; x++) {
      const lon = lonAt(x, ANALYSIS_WIDTH);
      let v: number;
      if (p.vector) {
        const s = frame.sampleVector?.(lon, lat) ?? null;
        v = s === null ? NaN : component === 'u' ? s.u : component === 'v' ? s.v : Math.hypot(s.u, s.v);
      } else {
        v = frame.sample(lon, lat) ?? NaN;
      }
      values[y * ANALYSIS_WIDTH + x] = p.convert && Number.isFinite(v) ? p.convert(v) : v;
    }
  }
  return {
    width: ANALYSIS_WIDTH,
    height: ANALYSIS_HEIGHT,
    date: frame.meta.date,
    values,
    unit: p.unit,
    relative: p.relative ?? false,
    overLand: p.overLand ?? false,
  };
}
