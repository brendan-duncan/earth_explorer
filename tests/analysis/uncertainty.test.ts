/**
 * Uncertainty behavior of the analysis ops.
 *
 * These exist because a number without its uncertainty is the characteristic failure of a tool
 * like this: a slope fitted from a handful of persistent frames renders identically to a real one,
 * an "anomaly" silently changes meaning with the loaded window, and an area mean over a polygon
 * that is mostly land looks exactly as solid as one over open ocean.
 */

import { describe, it, expect } from 'vitest';
import { executeOp, type AnswerPayload, type AnswerResult, type DisplayResult } from '../../src/analysis/ops.js';
import { frameEpoch, type Value } from '../../src/analysis/types.js';
import type { AnalysisNode } from '../../src/analysis/ast.js';
import { makeField, makeSeries, makeStack, monthlyDates } from './fixtures.js';

const field = (v: Value): Value & { kind: 'field' } => {
  expect(v.kind).toBe('field');
  return v as Value & { kind: 'field' };
};
const stack = (v: Value): Value & { kind: 'stack' } => {
  expect(v.kind).toBe('stack');
  return v as Value & { kind: 'stack' };
};
const scalar = (v: Value): Value & { kind: 'scalar' } => {
  expect(v.kind).toBe('scalar');
  return v as Value & { kind: 'scalar' };
};
const series = (v: Value): Value & { kind: 'series' } => {
  expect(v.kind).toBe('series');
  return v as Value & { kind: 'series' };
};

function run(node: AnalysisNode, inputs: Record<string, Value>): Value {
  return executeOp(node, inputs) as Value;
}

/**
 * Deterministic stand-in for weakly-correlated noise: sampling a sine at an irrational step gives a
 * repeatable sequence with lag-1 autocorrelation around −0.72, so a test can exercise the p-value
 * path without a random seed. Slow signals (`Math.sin(k / 4)`) are the opposite case on purpose —
 * they really are almost one independent sample, and the code reports them as untestable.
 */
const jitter = (k: number): number => Math.sin(k * 2.399963);

describe('trend uncertainty', () => {
  const dates = monthlyDates('2020-01', 36);
  const t0 = frameEpoch(dates[0]);
  const yearsAt = (k: number): number => (frameEpoch(dates[k]) - t0) / (365.25 * 86400e3);

  it('carries a standard error, a p-value and an effective sample size per cell', () => {
    const s = makeStack(dates, (_lon, _lat, k) => 0.5 * yearsAt(k));
    const out = field(run({ id: 't', op: 'trend' }, { value: { kind: 'stack', stack: s } }));
    const u = out.field.uncertainty;
    expect(u).toBeDefined();
    expect(u!.n[0]).toBe(36);
    expect(u!.nEff[0]).toBeGreaterThan(0);
    expect(u!.nEff[0]).toBeLessThanOrEqual(36);
    expect(u!.pValue[0]).toBeLessThan(0.001);        // a clean ramp is unambiguous
    expect(u!.method).toMatch(/effective DoF/);
    expect(out.field.note).toMatch(/per decade/);
  });

  it('the standard error is in the SAME per-decade units as the slope', () => {
    // Doubling the slope leaves the noise alone, so the reported stderr must not move with it —
    // that is the check that catches a stderr left on a per-year scale next to a per-decade value.
    const noisy = (k: number, gain: number): number => gain * yearsAt(k) + 0.3 * jitter(k);
    const a = field(run({ id: 't', op: 'trend' },
      { value: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => noisy(k, 0.5)) } }));
    const b = field(run({ id: 't', op: 'trend' },
      { value: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => noisy(k, 1.0)) } }));
    expect(a.field.values[0]).toBeCloseTo(5, 0);     // 0.5/yr → 5/decade
    expect(b.field.values[0]).toBeCloseTo(10, 0);
    expect(a.field.uncertainty!.stderr[0]).toBeCloseTo(b.field.uncertainty!.stderr[0], 6);
  });

  it('a trendless wobble is NOT reported as significant', () => {
    const s = makeStack(dates, (_lon, _lat, k) => jitter(k));
    const out = field(run({ id: 't', op: 'trend' }, { value: { kind: 'stack', stack: s } }));
    expect(out.field.uncertainty!.pValue[0]).toBeGreaterThan(0.05);
  });

  it('serial correlation discounts the degrees of freedom below the frame count', () => {
    const s = makeStack(dates, (_lon, _lat, k) => Math.sin(k / 8));   // slow, persistent residuals
    const out = field(run({ id: 't', op: 'trend' }, { value: { kind: 'stack', stack: s } }));
    expect(out.field.uncertainty!.nEff[0]).toBeLessThan(36);
  });

  it('a signal too persistent to test reports NO p-value rather than a flattering one', () => {
    // ~1.4 cycles of a slow wave across 36 frames really is about one independent observation, so
    // there is nothing to test. NaN says "untestable"; it must never be read as "not significant".
    const s = makeStack(dates, (_lon, _lat, k) => Math.sin(k / 4));
    const out = field(run({ id: 't', op: 'trend' }, { value: { kind: 'stack', stack: s } }));
    expect(out.field.uncertainty!.nEff[0]).toBeLessThan(3);
    expect(out.field.uncertainty!.pValue[0]).toBeNaN();
    // The slope itself is still reported — the estimate exists, the evidence for it does not.
    expect(Number.isFinite(out.field.values[0])).toBe(true);
  });

  it('significance blanks the cells that fail the test, and says so', () => {
    // North half trends hard; south half only wobbles.
    const s = makeStack(dates, (_lon, lat, k) => (lat > 0 ? 0.5 * yearsAt(k) : jitter(k)));
    const out = field(run({ id: 't', op: 'trend', params: { significance: 0.05 } },
      { value: { kind: 'stack', stack: s } }));
    const last = out.field.values.length - 1;
    expect(out.field.values[0]).toBeCloseTo(5, 1);              // north survives
    expect(out.field.values[last]).toBeNaN();                   // south is blanked
    // The p-values themselves are NOT blanked: the filter hides values, not the evidence about them.
    expect(Number.isFinite(out.field.uncertainty!.pValue[last])).toBe(true);
    expect(out.field.note).toMatch(/p ≤ 0.05/);
  });

  it('rejects a significance threshold that is not a probability', () => {
    const s = makeStack(dates, (_lon, _lat, k) => k);
    expect(() => run({ id: 't', op: 'trend', params: { significance: 5 } },
      { value: { kind: 'stack', stack: s } })).toThrow(/between 0 and 1/);
  });
});

describe('correlation significance', () => {
  const dates = monthlyDates('2020-01', 40);

  it('temporal: per-cell p-values and an effective sample size below the pair count', () => {
    const a = makeStack(dates, (_lon, _lat, k) => jitter(k));
    const b = makeStack(dates, (_lon, _lat, k) => jitter(k) * 2);
    const out = field(run({ id: 'c', op: 'correlate', params: { mode: 'temporal' } },
      { a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: b } }));
    expect(out.field.values[0]).toBeCloseTo(1, 5);
    const u = out.field.uncertainty!;
    expect(u.n[0]).toBe(40);
    expect(u.nEff[0]).toBeLessThan(40);              // both inputs are persistent
    expect(u.pValue[0]).toBeLessThan(0.05);
  });

  it('temporal: significance blanks cells whose r is not distinguishable from zero', () => {
    // North: identical signals. South: a half-step offset, which mostly decorrelates them.
    const a = makeStack(dates, (_lon, _lat, k) => jitter(k));
    const b = makeStack(dates, (_lon, lat, k) => (lat > 0 ? jitter(k) : jitter(k + 0.5)));
    const out = field(run({ id: 'c', op: 'correlate', params: { mode: 'temporal', significance: 0.01 } },
      { a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: b } }));
    expect(out.field.values[0]).toBeCloseTo(1, 5);
    expect(out.field.values[out.field.values.length - 1]).toBeNaN();
    expect(out.field.note).toMatch(/p ≤ 0.01/);
  });

  it('spatial: reports no p-value at all, and says why', () => {
    const a = makeField((_lon, lat) => lat);
    const b = makeField((_lon, lat) => lat * 2);
    const out = scalar(run({ id: 'c', op: 'correlate', params: { mode: 'spatial' } },
      { a: { kind: 'field', field: a }, b: { kind: 'field', field: b } }));
    expect(out.scalar.v).toBeCloseTo(1, 6);
    expect(out.scalar.p).toBeUndefined();
    expect(out.scalar.note).toMatch(/spatially autocorrelated/);
  });

  it('correlateSeries reports r WITH p and an effective sample size', () => {
    const vals = dates.map((_d, k) => jitter(k));
    const a = makeSeries(dates, vals, 'a');
    const b = makeSeries(dates, vals.map((v) => v * 3 + 1), 'b');
    const out = scalar(run({ id: 'r', op: 'correlateSeries' },
      { a: { kind: 'series', series: a }, b: { kind: 'series', series: b } }));
    expect(out.scalar.v).toBeCloseTo(1, 6);
    expect(out.scalar.n).toBe(40);
    expect(out.scalar.nEff!).toBeLessThan(40);
    expect(out.scalar.p!).toBeLessThan(0.05);
    expect(out.scalar.note).toMatch(/independent/);
  });

  it('correlateSeries refuses to report r below the minimum sample count', () => {
    const few = monthlyDates('2024-01', 4);
    const out = scalar(run({ id: 'r', op: 'correlateSeries' }, {
      a: { kind: 'series', series: makeSeries(few, [1, 2, 3, 4], 'a') },
      b: { kind: 'series', series: makeSeries(few, [2, 4, 6, 8], 'b') },
    }));
    expect(out.scalar.v).toBeNaN();
    expect(out.scalar.p).toBeUndefined();
    expect(out.scalar.note).toMatch(/fewer than/);
  });
});

describe('anomaly baselines', () => {
  it('records which baseline it used, even the implicit one', () => {
    const s = makeStack(monthlyDates('2024-01', 4), (_lon, _lat, k) => k);
    const out = stack(run({ id: 'a', op: 'anomaly' }, { value: { kind: 'stack', stack: s } }));
    expect(out.stack.frames[0].note).toMatch(/loaded window/);
  });

  it('takes the anomaly against an EXPLICIT reference period, not the whole window', () => {
    // 24 months of 0 then 12 months of 10. Baselined on the first two years the final year's
    // anomaly is +10; baselined on the whole window it would be +6.67 — a different answer.
    const dates = monthlyDates('2020-01', 36);
    const s = makeStack(dates, (_lon, _lat, k) => (k < 24 ? 0 : 10));
    const out = stack(run({ id: 'a', op: 'anomaly', params: { baselineStart: '2020-01', baselineEnd: '2021-12' } },
      { value: { kind: 'stack', stack: s } }));
    expect(out.stack.frames[0].values[0]).toBeCloseTo(0, 6);
    expect(out.stack.frames[35].values[0]).toBeCloseTo(10, 6);
    expect(out.stack.frames[0].note).toMatch(/2020-01–2021-12/);
  });

  it('the same data gives a DIFFERENT anomaly with no baseline — which is why it must be stated', () => {
    const dates = monthlyDates('2020-01', 36);
    const s = makeStack(dates, (_lon, _lat, k) => (k < 24 ? 0 : 10));
    const windowed = stack(run({ id: 'a', op: 'anomaly' }, { value: { kind: 'stack', stack: s } }));
    expect(windowed.stack.frames[35].values[0]).toBeCloseTo(10 - 10 / 3, 5);
  });

  it('monthly climatology removes the seasonal cycle a flat mean leaves behind', () => {
    const dates = monthlyDates('2020-01', 36);
    const season = (k: number): number => Math.sin(((k % 12) / 12) * 2 * Math.PI) * 5;
    const s = makeStack(dates, (_lon, _lat, k) => season(k) + (k >= 24 ? 2 : 0));
    const flat = stack(run({ id: 'a', op: 'anomaly' }, { value: { kind: 'stack', stack: s } }));
    const monthly = stack(run({ id: 'a', op: 'anomaly', params: { climatology: 'monthly' } },
      { value: { kind: 'stack', stack: s } }));
    // A flat baseline leaves the whole ±5 seasonal swing inside the "anomaly"…
    expect(Math.max(...flat.stack.frames.map((f) => Math.abs(f.values[0])))).toBeGreaterThan(4);
    // …while the month-of-year baseline leaves only the step.
    expect(Math.max(...monthly.stack.frames.map((f) => Math.abs(f.values[0])))).toBeLessThan(2);
    expect(monthly.stack.frames[0].note).toMatch(/month-of-year/);
  });

  it('refuses a baseline the loaded frames do not cover, rather than silently using another', () => {
    const s = makeStack(monthlyDates('2024-01', 6), () => 1);
    expect(() => run({ id: 'a', op: 'anomaly', params: { baselineStart: '1991-01', baselineEnd: '2020-12' } },
      { value: { kind: 'stack', stack: s } })).toThrow(/no loaded frames fall in the baseline/);
  });

  it('rejects a malformed baseline', () => {
    const s = makeStack(monthlyDates('2024-01', 6), () => 1);
    expect(() => run({ id: 'a', op: 'anomaly', params: { baselineStart: 'last year' } },
      { value: { kind: 'stack', stack: s } })).toThrow(/YYYY-MM/);
  });
});

describe('areaMean coverage', () => {
  it('reports spread and coverage next to the mean', () => {
    // Northern half is 10, southern half is no-data: the mean describes half the region only.
    const f = makeField((_lon, lat) => (lat > 0 ? 10 : NaN));
    const out = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: f } }));
    expect(out.scalar.v).toBeCloseTo(10, 6);
    expect(out.scalar.coverage).toBeCloseTo(0.5, 6);
    expect(out.scalar.sd).toBeCloseTo(0, 6);
    expect(out.scalar.note).toMatch(/50% coverage/);
  });

  it('the spread reflects how much the region disagrees with itself', () => {
    const flat = makeField(() => 4);
    const split = makeField((lon) => (lon < 0 ? 0 : 8));
    const a = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: flat } }));
    const b = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: split } }));
    expect(a.scalar.v).toBeCloseTo(b.scalar.v, 6);   // the same mean…
    expect(a.scalar.sd).toBeCloseTo(0, 6);           // …over very different regions
    expect(b.scalar.sd).toBeCloseTo(4, 6);
  });

  it('a stack carries per-sample spread, cell count and coverage alongside the series', () => {
    const dates = monthlyDates('2024-01', 3);
    // Coverage shrinks each frame: everywhere, then the northern half, then a polar sliver.
    const s = makeStack(dates, (_lon, lat, k) => (k === 0 ? 1 : k === 1 ? (lat > 0 ? 1 : NaN) : (lat > 85 ? 1 : NaN)));
    const out = series(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'stack', stack: s } }));
    const sp = out.series.spread!;
    expect(sp.coverage[0]).toBeCloseTo(1, 6);
    expect(sp.coverage[1]).toBeCloseTo(0.5, 6);
    expect(sp.coverage[2]).toBeLessThan(0.05);
    expect(sp.n[1]).toBeLessThan(sp.n[0]);
    expect(out.series.note).toMatch(/coverage/);
  });

  it('coverage is measured against the REGION, not the globe', () => {
    const f = makeField(() => 3);
    const region: Value = { kind: 'region', region: { kind: 'bbox', lonMin: -10, latMin: -10, lonMax: 10, latMax: 10 } };
    const out = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: f }, region }));
    expect(out.scalar.coverage).toBeCloseTo(1, 6);
  });
});

describe('uncertainty does not outlive the values it describes', () => {
  const dates = monthlyDates('2020-01', 24);
  const trendField = (): Value & { kind: 'field' } => field(run({ id: 't', op: 'trend' },
    { value: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => k) } }));

  it('math drops it — the numbers changed, so the standard errors no longer describe them', () => {
    const t = trendField();
    expect(t.field.uncertainty).toBeDefined();
    const doubled = field(run({ id: 'x', op: 'math', params: { fn: 'mul' } }, {
      a: t, b: { kind: 'scalar', scalar: { v: 2, unit: 'none', relative: false, label: '2' } },
    }));
    expect(doubled.field.uncertainty).toBeUndefined();
  });

  it('derive and filter drop it too', () => {
    expect(field(run({ id: 'd', op: 'derive', params: { fn: 'abs' } }, { value: trendField() }))
      .field.uncertainty).toBeUndefined();
    expect(field(run({ id: 'f', op: 'filter', params: { min: 0 } }, { value: trendField() }))
      .field.uncertainty).toBeUndefined();
  });

  it('mask KEEPS it — the surviving values are untouched — but blanks the cells it dropped', () => {
    const region: Value = { kind: 'region', region: { kind: 'bbox', lonMin: -180, latMin: 0, lonMax: 180, latMax: 90 } };
    const out = field(run({ id: 'm', op: 'mask' }, { value: trendField(), region }));
    const u = out.field.uncertainty!;
    expect(Number.isFinite(u.pValue[0])).toBe(true);            // north: kept
    expect(u.pValue[u.pValue.length - 1]).toBeNaN();            // south: dropped
    expect(u.n[u.n.length - 1]).toBe(0);
  });
});

describe('answer surfaces the uncertainty', () => {
  it('a trend field answers with the tested-cell counts, not just the mean', () => {
    const dates = monthlyDates('2020-01', 30);
    const t = field(run({ id: 't', op: 'trend' },
      { value: { kind: 'stack', stack: makeStack(dates, (_lon, _lat, k) => k) } }));
    const a = executeOp({ id: 'ans', op: 'answer', params: { label: 'trend' }, inputs: { value: 't' } },
      { value: t }) as AnswerResult;
    expect(a.payload.type).toBe('field');
    const sig = (a.payload as Extract<AnswerPayload, { type: 'field' }>).significance!;
    expect(sig.tested).toBeGreaterThan(0);
    expect(sig.fractionP05).toBeCloseTo(1, 6);
    expect(sig.medianNEff).toBeGreaterThan(0);
    expect(a.notes!.join(' ')).toMatch(/per decade/);
  });

  it('an ordinary field has no significance block at all', () => {
    const a = executeOp({ id: 'ans', op: 'answer', params: { label: 'sst' }, inputs: { value: 'f' } },
      { value: { kind: 'field', field: makeField(() => 1) } }) as AnswerResult;
    expect((a.payload as Extract<AnswerPayload, { type: 'field' }>).significance).toBeUndefined();
  });

  it('a scalar answer carries p and n_eff through', () => {
    const dates = monthlyDates('2020-01', 40);
    const vals = dates.map((_d, k) => jitter(k));
    const r = run({ id: 'r', op: 'correlateSeries' }, {
      a: { kind: 'series', series: makeSeries(dates, vals, 'a') },
      b: { kind: 'series', series: makeSeries(dates, vals.map((v) => v * 2), 'b') },
    });
    const a = executeOp({ id: 'ans', op: 'answer', params: { label: 'r' }, inputs: { value: 'r' } },
      { value: r }) as AnswerResult;
    const p = a.payload as Extract<AnswerPayload, { type: 'scalar' }>;
    expect(p.p!).toBeLessThan(0.05);
    expect(p.nEff!).toBeLessThan(40);
  });
});

describe('display marks weak cells instead of deleting them', () => {
  const dates = monthlyDates('2020-01', 36);
  const t0 = frameEpoch(dates[0]);
  const yearsAt = (k: number): number => (frameEpoch(dates[k]) - t0) / (365.25 * 86400e3);
  // North trends hard, south only wobbles — one field with a clear pass and a clear fail.
  const trendField = (): Value => run({ id: 't', op: 'trend' }, {
    value: { kind: 'stack', stack: makeStack(dates, (_lon, lat, k) => (lat > 0 ? 0.5 * yearsAt(k) : jitter(k))) },
  });

  it('flags the cells that failed the test and KEEPS their values', () => {
    const d = executeOp({ id: 'show', op: 'display', params: { stipple: 0.05 }, inputs: { value: 't' } },
      { value: trendField() }) as DisplayResult;
    const last = d.fields[0].values.length - 1;
    expect(d.insignificant).toBeDefined();
    expect(d.insignificant![0][0]).toBe(0);                       // north passed
    expect(d.insignificant![0][last]).toBe(1);                    // south failed
    // The whole point: the failing cell still has its estimate, unlike the blanking filter.
    expect(Number.isFinite(d.fields[0].values[last])).toBe(true);
    expect(d.notes!.join(' ')).toMatch(/stippled where p > 0.05/);
  });

  it('does NOT flag cells that were never tested — untested is not failed', () => {
    // Too few frames to fit anything, so every cell is untestable rather than insignificant.
    const short = run({ id: 't', op: 'trend' },
      { value: { kind: 'stack', stack: makeStack(monthlyDates('2020-01', 9), (_lon, _lat, k) => k) } });
    const d = executeOp({ id: 'show', op: 'display', params: { stipple: 0.05 }, inputs: { value: 'short' } },
      { value: short }) as DisplayResult;
    expect(d.insignificant![0].every((f) => f === 0)).toBe(true);
  });

  it('emits no flags at all when stipple was not asked for', () => {
    const d = executeOp({ id: 'show', op: 'display', inputs: { value: 't' } },
      { value: trendField() }) as DisplayResult;
    expect(d.insignificant).toBeUndefined();
  });

  it('refuses to stipple a field that carries no significance', () => {
    expect(() => executeOp({ id: 'show', op: 'display', params: { stipple: 0.05 }, inputs: { value: 'f' } },
      { value: { kind: 'field', field: makeField(() => 1) } })).toThrow(/only an estimated field carries/);
  });

  it('rejects a stipple threshold that is not a probability', () => {
    expect(() => executeOp({ id: 'show', op: 'display', params: { stipple: 95 }, inputs: { value: 't' } },
      { value: trendField() })).toThrow(/between 0 and 1/);
  });
});
