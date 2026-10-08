/**
 * Interpreter for analysis programs (TODO/geo-analysis-graph.md §4).
 *
 * Pure and headless: sources (`layer`, `enso`) are materialized by the CALLER (the
 * explorer's FieldStore, fixtures in tests) and injected via {@link InterpretOptions.sources};
 * the interpreter never fetches. Runs unchanged on the main thread or in a Worker.
 *
 * Pipeline: validate → cost-gate (Σ cells×frames against a budget, so a runaway program is
 * refused before any work) → topological execution with an optional cross-run memo cache
 * (node outputs keyed by op + params + input identities, the render graph's pooled-resource
 * idea — editing one node re-runs only its downstream).
 *
 * All failures throw {@link AnalysisError} carrying the same structured issues `validate`
 * produces, so the LLM front end returns them verbatim for one-shot self-correction.
 *
 * @category Analysis
 */

import { OPS, type AnalysisNode, type AnalysisProgram } from './ast.js';
import { executeOp, OpError, type SinkResult } from './ops.js';
import { validate, type ValidationIssue } from './validate.js';
import type { Value, ValueType } from './types.js';

/** A program that cannot run — carries the structured issues explaining why. @category Analysis */
export class AnalysisError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.node ? `[${i.node}] ` : ''}${i.message}`).join('; '));
    this.name = 'AnalysisError';
  }
}

function valueBytes(v: Value): number {
  switch (v.kind) {
    case 'field': return v.field.values.byteLength + 64;
    case 'stack': return v.stack.frames.reduce((s, f) => s + f.values.byteLength + 64, 64);
    case 'series': return v.series.t.byteLength + v.series.v.byteLength + 64;
    default: return 64;
  }
}

/**
 * Cross-run memo cache for node outputs (byte-bounded LRU). Hand the SAME instance to
 * successive `interpret` calls — with stable `sourceKeys`, unchanged subgraphs replay from
 * cache and only edited nodes (plus their downstream) recompute. Cached values are shared,
 * never copied: ops treat inputs as immutable, which is what makes this safe.
 * @category Analysis
 */
export class InterpreterCache {
  private map = new Map<string, { value: Value; bytes: number }>();
  private bytes = 0;
  hits = 0;
  misses = 0;

  constructor(readonly maxBytes = 256 * 1024 * 1024) {}

  get(key: string): Value | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);   // LRU refresh
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: Value): void {
    if (this.map.has(key)) {
      return;
    }
    const bytes = valueBytes(value);
    if (bytes > this.maxBytes) {
      return;
    }
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value!;
      this.bytes -= this.map.get(oldest)!.bytes;
      this.map.delete(oldest);
    }
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get entries(): number {
    return this.map.size;
  }
}

/** @category Analysis */
export interface InterpretOptions {
  /** Materialized value for every source node id (`layer`, `enso`). */
  sources: Record<string, Value>;
  /**
   * Stable identity per source node (e.g. `sst|2023-01..2026-06|1mo`) — required for cache
   * hits across calls. Without one, a source gets a per-call identity and never caches.
   */
  sourceKeys?: Record<string, string>;
  cache?: InterpreterCache;
  /** Refuse programs whose estimated Σ cells×frames exceeds this. Default 200e6. */
  budgetCellOps?: number;
  onProgress?: (nodeId: string, done: number, total: number) => void;
}

/** @category Analysis */
export interface InterpretResult {
  sinks: SinkResult[];
  /** Resolved output type per executed node (`null` = sink). */
  types: Record<string, ValueType | null>;
  /** The pre-execution cost estimate that was checked against the budget. */
  costCellOps: number;
  /** Non-fatal validation warnings (unreachable nodes, etc.). */
  warnings: ValidationIssue[];
}

const DEFAULT_BUDGET_CELL_OPS = 200e6;

// ── Cost estimation ─────────────────────────────────────────────────────────────────

interface Shape { cells: number; frames: number; }

function sourceShape(v: Value): Shape {
  switch (v.kind) {
    case 'stack': return { cells: v.stack.frames[0]?.values.length ?? 0, frames: v.stack.frames.length };
    case 'field': return { cells: v.field.values.length, frames: 1 };
    case 'series': return { cells: 1, frames: v.series.t.length };
    case 'scalar': return { cells: 1, frames: 1 };
    case 'region': return { cells: 0, frames: 0 };
  }
}

function outputShape(node: AnalysisNode, inputShapes: Record<string, Shape>, outType: ValueType | null): Shape {
  if (outType === null || outType === 'region') {
    return { cells: 0, frames: 0 };
  }
  if (outType === 'scalar') {
    return { cells: 1, frames: 1 };
  }
  const value = inputShapes.value ?? inputShapes.a ?? { cells: 0, frames: 0 };
  if (outType === 'series') {
    return { cells: 1, frames: Math.max(value.frames, 1) };
  }
  if (outType === 'field') {
    return { cells: value.cells, frames: 1 };
  }
  // stack — math over two stacks pairs frames (≤ min); everything else preserves.
  if (node.op === 'math' && inputShapes.a && inputShapes.b) {
    const nonScalar = [inputShapes.a, inputShapes.b].filter((s) => s.cells > 1 || s.frames > 1);
    if (nonScalar.length === 2) {
      return { cells: Math.max(nonScalar[0].cells, nonScalar[1].cells), frames: Math.min(nonScalar[0].frames, nonScalar[1].frames) };
    }
    return nonScalar[0] ?? { cells: 1, frames: 1 };
  }
  return value;
}

function work(s: Shape): number {
  return s.cells * Math.max(s.frames, 1);
}

// ── Cache keys ───────────────────────────────────────────────────────────────────────

function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashKey(s: string): string {
  return fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x9747b28c);
}

function paramsKey(node: AnalysisNode): string {
  const p = node.params ?? {};
  return Object.keys(p).sort().map((k) => `${k}=${JSON.stringify(p[k])}`).join(',');
}

let callSeq = 0;

// ── Interpretation ───────────────────────────────────────────────────────────────────

/** Runs a program. Throws {@link AnalysisError} on validation, budget, or data failures. */
export function interpret(program: AnalysisProgram, opts: InterpretOptions): InterpretResult {
  const v = validate(program);
  if (!v.ok) {
    throw new AnalysisError(v.errors);
  }
  const byId = new Map(program.nodes.map((n) => [n.id, n]));
  const call = ++callSeq;

  // ── Materialize + shape sources, estimate cost, gate ───────────────────────────────
  const shapes = new Map<string, Shape>();
  const values = new Map<string, Value>();
  let cost = 0;
  for (const id of v.order) {
    const node = byId.get(id)!;
    const spec = OPS[node.op];
    if (spec.source) {
      const src = opts.sources[id];
      if (!src) {
        throw new AnalysisError([{ node: id, message: `no data provided for source "${id}" (${node.op})`, hint: 'the caller must materialize every layer/enso node before interpreting' }]);
      }
      const expected = v.types.get(id);
      if (expected && src.kind !== expected) {
        throw new AnalysisError([{ node: id, message: `source "${id}" provided a ${src.kind}, but ${node.op} produces a ${expected}` }]);
      }
      values.set(id, src);
      shapes.set(id, sourceShape(src));
      continue;
    }
    const inputShapes: Record<string, Shape> = {};
    for (const [portName, ref] of Object.entries(node.inputs ?? {})) {
      const s = shapes.get(ref);
      if (s) {
        inputShapes[portName] = s;
        cost += work(s);
      }
    }
    shapes.set(id, outputShape(node, inputShapes, v.types.get(id) ?? null));
  }
  const budget = opts.budgetCellOps ?? DEFAULT_BUDGET_CELL_OPS;
  if (cost > budget) {
    throw new AnalysisError([{
      message: `estimated cost ${Math.round(cost / 1e6)}M cell-ops exceeds the budget of ${Math.round(budget / 1e6)}M`,
      hint: 'narrow the date range or region, or use a coarser stepMonths',
    }]);
  }

  // ── Execute ─────────────────────────────────────────────────────────────────────────
  const keys = new Map<string, string>();
  const sinks: SinkResult[] = [];
  const types: Record<string, ValueType | null> = {};
  let done = 0;
  for (const id of v.order) {
    const node = byId.get(id)!;
    const spec = OPS[node.op];
    types[id] = v.types.get(id) ?? null;

    if (spec.source) {
      keys.set(id, opts.sourceKeys?.[id] ?? `call${call}:${id}`);
      done++;
      opts.onProgress?.(id, done, v.order.length);
      continue;
    }

    const inputs: Record<string, Value> = {};
    const inputKeys: string[] = [];
    for (const [portName, ref] of Object.entries(node.inputs ?? {})) {
      inputs[portName] = values.get(ref)!;
      inputKeys.push(`${portName}:${keys.get(ref)}`);
    }
    const key = hashKey(`${node.op}|${paramsKey(node)}|${inputKeys.sort().join('|')}`);
    keys.set(id, key);

    try {
      if (spec.sink) {
        sinks.push(executeOp(node, inputs) as SinkResult);
      } else {
        let out = opts.cache?.get(key);
        if (!out) {
          out = executeOp(node, inputs) as Value;
          opts.cache?.set(key, out);
        }
        values.set(id, out);
      }
    } catch (e) {
      if (e instanceof OpError) {
        throw new AnalysisError([{ node: e.node, message: e.message }]);
      }
      throw e;
    }
    done++;
    opts.onProgress?.(id, done, v.order.length);
  }

  return { sinks, types, costCellOps: cost, warnings: v.warnings };
}
