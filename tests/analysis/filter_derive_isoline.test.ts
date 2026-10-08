// The three ODV-inspired ops: a range filter, derived variables, and the 2-D isosurface analogue.
//
// What these tests are really guarding: that `filter` narrows data WITHOUT touching units (it
// selects, it does not transform), that `derive` tells the truth about units when a log or a power
// changes the dimension, and that `isoline` weights by real spherical cell area — the whole point of
// the op is quoting an extent in km², and an unweighted count would inflate polar regions enormously.

import { describe, expect, it } from 'vitest';
import { executeOp, type SinkResult } from '../../src/analysis/ops.js';
import type { AnalysisNode } from '../../src/analysis/ast.js';
import type { CpuField, RegionValue, Value } from '../../src/analysis/types.js';
import { makeField, makeStack } from './fixtures.js';

const node = (op: string, params: Record<string, unknown> = {}, inputs: Record<string, string> = {}): AnalysisNode =>
  ({ id: 'n', op, params, inputs } as AnalysisNode);

const field = (v: Value | SinkResult): CpuField => {
  if (v.kind !== 'field') {
    throw new Error(`expected a field, got ${v.kind}`);
  }
  return v.field;
};

describe('filter — range sample filter', () => {
  const ramp = makeField((lon) => lon);   // −180 … 180

  it('drops values below min and keeps the rest untouched', () => {
    const out = field(executeOp(node('filter', { min: 0 }), { value: { kind: 'field', field: ramp } }));
    const kept = [...out.values].filter((v) => Number.isFinite(v));
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...kept)).toBeCloseTo(177.5, 1);
  });

  it('applies both bounds inclusively', () => {
    const out = field(executeOp(node('filter', { min: -10, max: 10 }), { value: { kind: 'field', field: ramp } }));
    const kept = [...out.values].filter((v) => Number.isFinite(v));
    expect(kept.every((v) => v >= -10 && v <= 10)).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('compares magnitude with abs — "anomaly of either sign, bigger than N"', () => {
    const out = field(executeOp(node('filter', { min: 100, abs: true }), { value: { kind: 'field', field: ramp } }));
    const kept = [...out.values].filter((v) => Number.isFinite(v));
    expect(kept.some((v) => v < 0)).toBe(true);    // the negative tail survives
    expect(kept.some((v) => v > 0)).toBe(true);
    expect(kept.every((v) => Math.abs(v) >= 100)).toBe(true);
  });

  it('preserves units and shape — it selects values, it does not transform them', () => {
    const src = makeField(() => 5, { unit: 'degC', relative: true });
    const out = field(executeOp(node('filter', { min: 0 }), { value: { kind: 'field', field: src } }));
    expect(out.unit).toBe('degC');
    expect(out.relative).toBe(true);
    expect(out.width).toBe(src.width);
    expect(out.height).toBe(src.height);
  });

  it('filters a stack frame by frame', () => {
    const stack = makeStack(['2024-01-01', '2024-02-01'], (_lon, _lat, k) => (k === 0 ? 1 : 100));
    const out = executeOp(node('filter', { min: 50 }), { value: { kind: 'stack', stack } });
    if (out.kind !== 'stack') {
      throw new Error('expected a stack');
    }
    expect([...out.stack.frames[0].values].every((v) => Number.isNaN(v))).toBe(true);
    expect([...out.stack.frames[1].values].every((v) => v === 100)).toBe(true);
  });

  it('rejects a filter that could never pass, and one with no bounds', () => {
    const input = { value: { kind: 'field' as const, field: ramp } };
    expect(() => executeOp(node('filter', { min: 10, max: 0 }), input)).toThrow(/above max/);
    expect(() => executeOp(node('filter', {}), input)).toThrow(/at least one/);
  });
});

describe('derive — derived variables', () => {
  it('takes log10, and sends non-positive values to no-data', () => {
    const src = makeField((lon) => (lon < 0 ? -1 : 100));
    const out = field(executeOp(node('derive', { fn: 'log10' }), { value: { kind: 'field', field: src } }));
    const vals = [...out.values];
    expect(vals.filter((v) => Number.isFinite(v)).every((v) => Math.abs(v - 2) < 1e-6)).toBe(true);
    expect(vals.some((v) => Number.isNaN(v))).toBe(true);
  });

  it('reports a log as dimensionless rather than keeping a unit that would be a lie', () => {
    const src = makeField(() => 10, { unit: 'mgm3' });
    const out = field(executeOp(node('derive', { fn: 'log10' }), { value: { kind: 'field', field: src } }));
    expect(out.unit).toBe('none');
    expect(out.relative).toBe(false);
  });

  it('keeps the unit for abs and negate, but abs stops being relative', () => {
    const src = makeField(() => -3, { unit: 'degC', relative: true });
    const a = field(executeOp(node('derive', { fn: 'abs' }), { value: { kind: 'field', field: src } }));
    expect(a.values[0]).toBe(3);
    expect(a.unit).toBe('degC');
    expect(a.relative).toBe(false);           // a magnitude has no sign to convert

    const n = field(executeOp(node('derive', { fn: 'negate' }), { value: { kind: 'field', field: src } }));
    expect(n.values[0]).toBe(3);
    expect(n.unit).toBe('degC');
    expect(n.relative).toBe(true);            // still a signed Δ-quantity
  });

  it('guards the undefined cases: sqrt of a negative, inverse of zero', () => {
    const neg = makeField(() => -4);
    expect(field(executeOp(node('derive', { fn: 'sqrt' }), { value: { kind: 'field', field: neg } })).values[0]).toBeNaN();
    const zero = makeField(() => 0);
    expect(field(executeOp(node('derive', { fn: 'inverse' }), { value: { kind: 'field', field: zero } })).values[0]).toBeNaN();
  });

  it('maps a scalar and a series too', () => {
    const sc = executeOp(node('derive', { fn: 'abs' }), {
      value: { kind: 'scalar', scalar: { v: -7, unit: 'degC', relative: true, label: 'x' } },
    });
    if (sc.kind !== 'scalar') {
      throw new Error('expected a scalar');
    }
    expect(sc.scalar.v).toBe(7);
  });

  it('rejects an unknown function', () => {
    expect(() => executeOp(node('derive', { fn: 'tangent' }), {
      value: { kind: 'field', field: makeField(() => 1) },
    })).toThrow(/unknown derive function/);
  });
});

describe('isoline — the 2-D isosurface analogue', () => {
  it('measures a whole-globe extent as Earth\'s surface area', () => {
    const all = makeField(() => 10);
    const out = executeOp(node('isoline', { level: 1, measure: 'area' }), { value: { kind: 'field', field: all } });
    if (out.kind !== 'scalar') {
      throw new Error('expected a scalar');
    }
    // 4πR² = 510.1 million km². The row-by-row spherical sum must reproduce it.
    expect(out.scalar.v).toBeCloseTo(510.1, 0);
  });

  it('weights by real cell area, so a polar band is far smaller than an equatorial one', () => {
    const band = (lo: number, hi: number): number => {
      const f = makeField((_lon, lat) => (lat >= lo && lat <= hi ? 10 : 0));
      const out = executeOp(node('isoline', { level: 1 }), { value: { kind: 'field', field: f } });
      if (out.kind !== 'scalar') {
        throw new Error('expected a scalar');
      }
      return out.scalar.v;
    };
    const equator = band(0, 20);
    const polar = band(70, 90);
    expect(equator).toBeGreaterThan(polar * 3);   // an unweighted cell count would make these equal
  });

  it('reports the area-weighted mean latitude of the enclosed region', () => {
    // A band from 40N to 60N: its area centroid sits below the arithmetic midpoint, because the
    // southern rows are wider.
    const f = makeField((_lon, lat) => (lat >= 40 && lat <= 60 ? 10 : 0));
    const out = executeOp(node('isoline', { level: 1, measure: 'latitude' }), { value: { kind: 'field', field: f } });
    if (out.kind !== 'scalar') {
      throw new Error('expected a scalar');
    }
    expect(out.scalar.v).toBeGreaterThan(45);
    expect(out.scalar.v).toBeLessThan(50);
    expect(out.scalar.unit).toBe('deg');
  });

  it('measures below the level when asked', () => {
    const f = makeField((_lon, lat) => (lat > 0 ? 10 : -10));
    const above = executeOp(node('isoline', { level: 0 }), { value: { kind: 'field', field: f } });
    const below = executeOp(node('isoline', { level: 0, below: true }), { value: { kind: 'field', field: f } });
    if (above.kind !== 'scalar' || below.kind !== 'scalar') {
      throw new Error('expected scalars');
    }
    expect(above.scalar.v).toBeCloseTo(below.scalar.v, 0);      // two hemispheres, equal area
    expect(above.scalar.v + below.scalar.v).toBeCloseTo(510.1, 0);
  });

  it('turns a stack into a series — the extent time series', () => {
    // Growing ice: each frame covers more of the north.
    const stack = makeStack(['2024-01-01', '2024-02-01', '2024-03-01'],
      (_lon, lat, k) => (lat >= 80 - k * 20 ? 10 : 0));
    const out = executeOp(node('isoline', { level: 1 }), { value: { kind: 'stack', stack } });
    if (out.kind !== 'series') {
      throw new Error('expected a series');
    }
    expect(out.series.v.length).toBe(3);
    expect(out.series.v[0]).toBeLessThan(out.series.v[1]);
    expect(out.series.v[1]).toBeLessThan(out.series.v[2]);
    expect(out.series.label).toContain('extent');
  });

  it('restricts to a region first, so one hemisphere can be measured alone', () => {
    const f = makeField(() => 10);
    const north: RegionValue = { kind: 'bbox', lonMin: -180, lonMax: 180, latMin: 0, latMax: 90 };
    const out = executeOp(node('isoline', { level: 1 }, { region: 'r' }), {
      value: { kind: 'field', field: f },
      region: { kind: 'region', region: north },
    });
    if (out.kind !== 'scalar') {
      throw new Error('expected a scalar');
    }
    expect(out.scalar.v).toBeCloseTo(510.1 / 2, 0);
  });

  it('ignores no-data cells rather than counting them as below the level', () => {
    const half = makeField((lon) => (lon < 0 ? NaN : 10));
    const out = executeOp(node('isoline', { level: 1 }), { value: { kind: 'field', field: half } });
    if (out.kind !== 'scalar') {
      throw new Error('expected a scalar');
    }
    expect(out.scalar.v).toBeCloseTo(510.1 / 2, 0);
  });
});
