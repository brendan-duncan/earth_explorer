import { describe, it, expect } from 'vitest';
import { AnalysisError, InterpreterCache, interpret } from '../../src/analysis/interpret.js';
import type { AnalysisProgram } from '../../src/analysis/ast.js';
import type { AnswerResult, DisplayResult } from '../../src/analysis/ops.js';
import type { Value } from '../../src/analysis/types.js';
import { makeStack, monthlyDates } from './fixtures.js';

const dates = monthlyDates('2023-01', 12);

/** SST-vs-wind shaped sources: perfectly correlated synthetic signals. */
function sources(): Record<string, Value> {
  return {
    sst: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => Math.sin(k), { unit: 'degC' }) },
    wind: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => 3 * Math.sin(k) + 5, { unit: 'mps' }) },
  };
}

/** The design doc's canonical program: correlate two layers, display + answer. */
function program(): AnalysisProgram {
  return {
    nodes: [
      { id: 'sst', op: 'layer', params: { layer: 'sst' } },
      { id: 'wind', op: 'layer', params: { layer: 'wind', component: 'speed' } },
      { id: 'r', op: 'correlate', inputs: { a: 'sst', b: 'wind' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'per-cell r' } },
    ],
  };
}

describe('interpret — end to end', () => {
  it('runs the canonical correlation program to a map and an answer', () => {
    const result = interpret(program(), { sources: sources() });
    expect(result.sinks).toHaveLength(2);

    const display = result.sinks.find((s) => s.kind === 'display') as DisplayResult;
    expect(display.legend.colormap).toBe('balance');
    expect(display.legend.min).toBe(-1);
    expect(display.fields[0].values[0]).toBeCloseTo(1, 5);

    const answer = result.sinks.find((s) => s.kind === 'answer') as AnswerResult;
    if (answer.payload.type !== 'field') {
      throw new Error('expected field payload');
    }
    expect(answer.payload.areaWeightedMean).toBeCloseTo(1, 4);
    expect(answer.payload.unit).toBe('r');
    expect(result.types.r).toBe('field');
    expect(result.costCellOps).toBeGreaterThan(0);
  });

  it('reports progress across the execution order', () => {
    const seen: Array<[string, number, number]> = [];
    interpret(program(), { sources: sources(), onProgress: (id, done, total) => seen.push([id, done, total]) });
    expect(seen).toHaveLength(5);
    expect(seen[seen.length - 1][1]).toBe(5);
    expect(seen.every(([, , total]) => total === 5)).toBe(true);
  });

  it('does not demand data for sources that reach no sink', () => {
    const p = program();
    p.nodes.push({ id: 'stray', op: 'layer', params: { layer: 'ice' } });
    const result = interpret(p, { sources: sources() });   // no data for "stray"
    expect(result.warnings.some((w) => w.node === 'stray')).toBe(true);
  });
});

describe('interpret — failure modes', () => {
  it('throws AnalysisError with structured issues on invalid programs', () => {
    const bad: AnalysisProgram = { nodes: [
      { id: 'r', op: 'correlate', inputs: { a: 'ghost', b: 'ghost' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' } },
    ] };
    try {
      interpret(bad, { sources: {} });
      throw new Error('expected AnalysisError');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisError);
      expect((e as AnalysisError).issues.some((i) => i.node === 'r')).toBe(true);
    }
  });

  it('throws when a source node has no materialized data', () => {
    expect(() => interpret(program(), { sources: { sst: sources().sst } }))
      .toThrow(/no data provided for source "wind"/);
  });

  it('throws when a source provides the wrong value kind', () => {
    const s = sources();
    s.wind = { kind: 'series', series: { t: new Float64Array(0), v: new Float64Array(0), unit: 'mps', relative: false, label: 'x' } };
    expect(() => interpret(program(), { sources: s })).toThrow(/provided a series/);
  });

  it('refuses programs over the cost budget with an actionable hint', () => {
    try {
      interpret(program(), { sources: sources(), budgetCellOps: 1000 });
      throw new Error('expected AnalysisError');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisError);
      expect((e as AnalysisError).issues[0].hint).toContain('date range');
    }
  });

  it('surfaces data-dependent op failures as AnalysisError', () => {
    const s = sources();
    s.wind = { kind: 'stack', stack: makeStack(monthlyDates('2026-01', 12), (_lon, _lat, k) => k, { unit: 'mps' }) };
    try {
      interpret(program(), { sources: s });
      throw new Error('expected AnalysisError');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisError);
      expect((e as AnalysisError).issues[0].node).toBe('r');
      expect((e as AnalysisError).issues[0].message).toContain('overlap');
    }
  });
});

describe('interpret — memo cache', () => {
  it('replays unchanged subgraphs from cache when sources have stable keys', () => {
    const cache = new InterpreterCache();
    const sourceKeys = { sst: 'sst|2023', wind: 'wind|2023' };
    const src = sources();

    const first = interpret(program(), { sources: src, sourceKeys, cache });
    expect(cache.hits).toBe(0);
    expect(cache.entries).toBeGreaterThan(0);

    const second = interpret(program(), { sources: src, sourceKeys, cache });
    expect(cache.hits).toBeGreaterThan(0);

    const a1 = first.sinks.find((s) => s.kind === 'answer') as AnswerResult;
    const a2 = second.sinks.find((s) => s.kind === 'answer') as AnswerResult;
    expect(a2.payload).toEqual(a1.payload);
  });

  it('editing a node param recomputes, changing only that subgraph key', () => {
    const answerOnly = (mode: string): AnalysisProgram => ({ nodes: [
      { id: 'sst', op: 'layer', params: { layer: 'sst' } },
      { id: 'wind', op: 'layer', params: { layer: 'wind', component: 'speed' } },
      { id: 'r', op: 'correlate', inputs: { a: 'sst', b: 'wind' }, params: { mode } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'r' } },
    ] });
    const cache = new InterpreterCache();
    const sourceKeys = { sst: 'sst|2023', wind: 'wind|2023' };
    const src = sources();
    interpret(answerOnly('temporal'), { sources: src, sourceKeys, cache });

    const before = cache.hits;
    interpret(answerOnly('spatial'), { sources: src, sourceKeys, cache });
    expect(cache.hits).toBe(before);   // spatial r is a different key — no false hit
    expect(cache.entries).toBe(2);     // temporal field + spatial scalar
  });

  it('without stable source keys nothing ever hits', () => {
    const cache = new InterpreterCache();
    const src = sources();
    interpret(program(), { sources: src, cache });
    interpret(program(), { sources: src, cache });
    expect(cache.hits).toBe(0);
  });
});
