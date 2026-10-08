/**
 * `regress` — per-cell regression of a stack on an index, the model behind the ENSO outlook — and
 * the `anomaly(as: percent)` mode that feeds it rainfall.
 */

import { describe, it, expect } from 'vitest';
import { executeOp } from '../../src/analysis/ops.js';
import { OPS } from '../../src/analysis/ast.js';
import type { AnalysisNode } from '../../src/analysis/ast.js';
import type { Value } from '../../src/analysis/types.js';
import { W, makeSeries, makeStack, monthlyDates } from './fixtures.js';

function run(node: AnalysisNode, inputs: Record<string, Value>): Value & { kind: 'field' } {
  const v = executeOp(node, inputs) as Value;
  expect(v.kind).toBe('field');
  return v as Value & { kind: 'field' };
}

/** Deterministic pseudo-noise (irrational-step sines), so no seed is needed. */
const noiseA = (k: number): number => Math.sin(k * 2.399963) + 0.5 * Math.sin(k * 7.13);
const noiseB = (k: number): number => Math.sin(k * 1.618034 + 1) + 0.5 * Math.sin(k * 5.77);

/** Three winter months (DJF) per year for `years` years — the stack shape the outlook regresses. */
function winterDates(years: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < years; y++) {
    const yr = 1980 + y;
    out.push(`${yr}-12-01`, `${yr + 1}-01-01`, `${yr + 1}-02-01`);
  }
  return out;
}

// Index value per sample: one draw per winter, shared by its three months — like the ONI.
const dates = winterDates(40);
const oniVals = dates.map((_, k) => 1.2 * noiseA(Math.floor(k / 3)));
const oni = makeSeries(dates, oniVals, 'ONI');
// West half responds at 2 units per index unit (+ weather noise); east half is pure noise.
const resp = makeStack(dates, (lon, _lat, k) => (lon < 0 ? 2 * oniVals[k] : 0) + 0.4 * noiseB(k), { relative: true });
const inputs = (extra: Record<string, Value> = {}): Record<string, Value> => ({
  value: { kind: 'stack', stack: resp },
  predictor: { kind: 'series', series: oni },
  ...extra,
});
const WEST = 0;          // column 0 → lon −177.5
const EAST = W - 1;      // last column → lon +177.5

describe('regress', () => {
  it('slope recovers the per-cell response and tests it', () => {
    const out = run({ id: 'r', op: 'regress' }, inputs());
    expect(out.field.values[WEST]).toBeCloseTo(2, 1);
    expect(Math.abs(out.field.values[EAST])).toBeLessThan(0.3);
    const u = out.field.uncertainty!;
    expect(u.pValue[WEST]).toBeLessThan(1e-4);
    expect(u.pValue[EAST]).toBeGreaterThan(0.05);
    expect(u.nEff[WEST]).toBeLessThanOrEqual(u.n[WEST]);
    expect(out.field.relative).toBe(true);
  });

  it('predict evaluates a + b·x0 from the at param', () => {
    const out = run({ id: 'r', op: 'regress', params: { output: 'predict', at: 1.5 } }, inputs());
    expect(out.field.values[WEST]).toBeCloseTo(3, 0);
    expect(out.field.uncertainty!.stderr[WEST]).toBeGreaterThan(0);
    expect(out.field.note).toMatch(/predicted at ONI = 1\.5/);
  });

  it('an at SERIES collapses per atFrom (default: mean of the last three samples)', () => {
    const fc = makeSeries(monthlyDates('2026-07', 6), [0.5, 0.8, 1.0, 1.4, 1.6, 1.8], 'forecast');
    const out = run({ id: 'r', op: 'regress', params: { output: 'predict' } },
      inputs({ at: { kind: 'series', series: fc } }));
    const slope = run({ id: 's', op: 'regress' }, inputs()).field.values[WEST];
    const b0 = out.field.values[WEST] - slope * 1.6;   // intercept implied at x0 = mean(1.4, 1.6, 1.8)
    expect(Math.abs(b0)).toBeLessThan(0.2);
    const peak = run({ id: 'r', op: 'regress', params: { output: 'predict', atFrom: 'peak' } },
      inputs({ at: { kind: 'series', series: fc } }));
    expect(peak.field.note).toMatch(/1\.80/);
  });

  it('skill is high where the index explains the cell and ~0 where it does not', () => {
    const out = run({ id: 'r', op: 'regress', params: { output: 'skill' } }, inputs());
    expect(out.field.unit).toBe('percent');
    expect(out.field.values[WEST]).toBeGreaterThan(80);
    expect(out.field.values[EAST]).toBeLessThan(5);
  });

  it('cross-validation holds out the whole season, so repeated months cannot leak skill', () => {
    // No relationship at all, but each winter's three months are IDENTICAL. Plain leave-one-out
    // would keep a sample's two twins in the fit and "predict" it from them; the 12-month hold-out
    // must not.
    const twin = makeStack(dates, (_lon, _lat, k) => noiseB(Math.floor(k / 3) * 3 + 1));
    const out = run({ id: 'r', op: 'regress', params: { output: 'skill' } },
      { value: { kind: 'stack', stack: twin }, predictor: { kind: 'series', series: oni } });
    expect(out.field.values[WEST]).toBeLessThan(5);
  });

  it('minSkill blanks cells that never beat climatology and says so', () => {
    const out = run({ id: 'r', op: 'regress', params: { output: 'predict', at: 1, minSkill: 10 } }, inputs());
    expect(Number.isFinite(out.field.values[WEST])).toBe(true);
    expect(Number.isNaN(out.field.values[EAST])).toBe(true);
    expect(out.field.note).toMatch(/skill ≥ 10%/);
  });

  it('refuses a stack that does not overlap the predictor', () => {
    const late = makeStack(monthlyDates('2030-01', 12), () => 1);
    expect(() => executeOp({ id: 'r', op: 'regress' },
      { value: { kind: 'stack', stack: late }, predictor: { kind: 'series', series: oni } })).toThrow(/pair with the predictor/);
  });

  it('validation: predict needs a value, at is predict-only', () => {
    const check = OPS.regress.check!;
    expect(check({ output: 'predict' }, {})).toMatch(/needs a predictor value/);
    expect(check({ output: 'predict' }, { at: 'x' })).toBeNull();
    expect(check({ at: 1 }, {})).toMatch(/only applies to output=predict/);
    expect(check({ output: 'skill', minSkill: 5 }, {})).toMatch(/minSkill/);
  });
});

describe('timeReduce per run', () => {
  it('reduces each run of consecutive frames to one frame dated at its middle', () => {
    const s = makeStack(winterDates(3), (_lon, _lat, k) => k);   // 0,1,2 | 3,4,5 | 6,7,8
    const v = executeOp({ id: 't', op: 'timeReduce', params: { stat: 'mean', per: 'run' } },
      { value: { kind: 'stack', stack: s } }) as Value & { kind: 'stack' };
    expect(v.kind).toBe('stack');
    expect(v.stack.frames.map((f) => f.date)).toEqual(['1981-01-01', '1982-01-01', '1983-01-01']);
    expect(v.stack.frames.map((f) => f.values[0])).toEqual([1, 4, 7]);
    expect(v.stack.frames[0].note).toMatch(/run of 3 consecutive frames/);
  });

  it('drops an incomplete season instead of averaging fewer months as a full one', () => {
    const dates = [...winterDates(2), '1982-12-01'];              // third winter has only December
    const v = executeOp({ id: 't', op: 'timeReduce', params: { stat: 'max', per: 'run' } },
      { value: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => k) } }) as Value & { kind: 'stack' };
    expect(v.stack.frames.length).toBe(2);
    expect(v.stack.frames[1].values[0]).toBe(5);
    expect(v.stack.frames[0].note).toMatch(/1 incomplete run dropped/);
  });

  it('resolves to a stack only for per=run', () => {
    expect(OPS.timeReduce.resolve({ value: 'stack' }, { stat: 'mean', per: 'run' })).toBe('stack');
    expect(OPS.timeReduce.resolve({ value: 'stack' }, { stat: 'mean' })).toBe('field');
  });
});

describe('anomaly as percent', () => {
  it('expresses each frame as percent of its calendar-month normal', () => {
    const d = monthlyDates('2000-01', 24);
    // Month-of-year normal of 2 (Jan) vs 4 (others); year two is 50% wetter.
    const s = makeStack(d, (_lon, _lat, k) => (k % 12 === 0 ? 2 : 4) * (k >= 12 ? 1.5 : 0.5));
    const v = executeOp({ id: 'a', op: 'anomaly', params: { climatology: 'monthly', as: 'percent' } },
      { value: { kind: 'stack', stack: s } }) as Value & { kind: 'stack' };
    const f = v.stack.frames;
    expect(f[12].values[0]).toBeCloseTo(50, 4);
    expect(f[0].values[0]).toBeCloseTo(-50, 4);
    expect(f[0].unit).toBe('percent');
    expect(f[0].note).toMatch(/percent of normal/);
  });

  it('a zero normal becomes no-data, not infinity', () => {
    const d = monthlyDates('2000-01', 2);
    const s = makeStack(d, (_lon, _lat, k) => (k === 0 ? 0 : 0));
    const v = executeOp({ id: 'a', op: 'anomaly', params: { as: 'percent' } },
      { value: { kind: 'stack', stack: s } }) as Value & { kind: 'stack' };
    expect(Number.isNaN(v.stack.frames[0].values[0])).toBe(true);
  });
});
