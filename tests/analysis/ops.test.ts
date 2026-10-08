import { describe, it, expect } from 'vitest';
import {
  executeOp, OpError,
  type AnnotateResult, type AnswerResult, type DisplayResult, type HistogramResult,
  type HovmollerResult, type ScatterResult, type VectorsResult,
} from '../../src/analysis/ops.js';
import { addMonthsToDate, addMonthsToEpoch, frameEpoch, type Value } from '../../src/analysis/types.js';
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

describe('date helpers', () => {
  it('addMonthsToDate clamps the day and crosses years', () => {
    expect(addMonthsToDate('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsToDate('2024-11-15', 3)).toBe('2025-02-15');
    expect(addMonthsToDate('2024-03-01', -4)).toBe('2023-11-01');
  });

  it('addMonthsToEpoch matches calendar month arithmetic', () => {
    const t = frameEpoch('2024-01-01');
    expect(addMonthsToEpoch(t, 2)).toBe(frameEpoch('2024-03-01'));
    expect(addMonthsToEpoch(t, -1)).toBe(frameEpoch('2023-12-01'));
  });
});

describe('areaMean', () => {
  it('weights by cos(lat): a ±30° band of 1s over 0s averages to sin(30°) = 0.5', () => {
    const f = makeField((_lon, lat) => (Math.abs(lat) < 30 ? 1 : 0));
    const out = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: f } }));
    expect(out.scalar.v).toBeCloseTo(0.5, 3);
    expect(out.scalar.n).toBe(f.values.length);
  });

  it('restricts to a region and skips invalid cells', () => {
    const f = makeField((_lon, lat) => (lat > 0 ? 2 : NaN));
    const region: Value = { kind: 'region', region: { kind: 'bbox', lonMin: -180, latMin: 0, lonMax: 180, latMax: 90 } };
    const out = scalar(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'field', field: f }, region }));
    expect(out.scalar.v).toBeCloseTo(2, 6);
    expect(out.scalar.n).toBe(f.values.length / 2);
  });

  it('stack → per-frame series with frame epochs', () => {
    const dates = monthlyDates('2024-01', 3);
    const s = makeStack(dates, (_lon, _lat, k) => k + 1);
    const out = series(run({ id: 'm', op: 'areaMean' }, { value: { kind: 'stack', stack: s } }));
    expect([...out.series.v].map((v) => Math.round(v))).toEqual([1, 2, 3]);
    expect(out.series.t[0]).toBe(frameEpoch(dates[0]));
  });
});

describe('mask', () => {
  it('keeps only cells inside a bbox, including one wrapping the antimeridian', () => {
    const f = makeField(() => 1);
    const wrap: Value = { kind: 'region', region: { kind: 'bbox', lonMin: 170, latMin: -90, lonMax: -170, latMax: 90 } };
    const out = field(run({ id: 'm', op: 'mask' }, { value: { kind: 'field', field: f }, region: wrap }));
    let valid = 0;
    for (const v of out.field.values) {
      if (Number.isFinite(v)) {
        valid++;
      }
    }
    // 20° of 360° longitude at every latitude, on a 72-column grid = 4 columns.
    expect(valid).toBe(4 * f.height);
  });
});

describe('anomaly / timeReduce / trend', () => {
  it('anomaly subtracts the per-cell mean of the loaded window and marks output relative', () => {
    const s = makeStack(monthlyDates('2024-01', 4), (_lon, _lat, k) => k);   // 0,1,2,3 → mean 1.5
    const out = stack(run({ id: 'a', op: 'anomaly' }, { value: { kind: 'stack', stack: s } }));
    expect(out.stack.frames[0].values[0]).toBeCloseTo(-1.5, 6);
    expect(out.stack.frames[3].values[0]).toBeCloseTo(1.5, 6);
    expect(out.stack.frames[0].relative).toBe(true);
  });

  it('timeReduce computes range per cell and needs ≥2 samples for it', () => {
    const s = makeStack(monthlyDates('2024-01', 3), (_lon, lat, k) => (lat > 0 ? k * 2 : NaN));
    const out = field(run({ id: 't', op: 'timeReduce', params: { stat: 'range' } }, { value: { kind: 'stack', stack: s } }));
    expect(out.field.values[0]).toBeCloseTo(4, 6);                        // north: 0,2,4
    expect(out.field.values[out.field.values.length - 1]).toBeNaN();     // south: never valid
    expect(out.field.relative).toBe(true);
  });

  it('trend fits per-cell slope, reported per decade', () => {
    const dates = monthlyDates('2020-01', 24);
    const t0 = frameEpoch(dates[0]);
    const yearsAt = (k: number): number => (frameEpoch(dates[k]) - t0) / (365.25 * 86400e3);
    const s = makeStack(dates, (_lon, _lat, k) => 0.5 * yearsAt(k));      // +0.5 per year
    const out = field(run({ id: 't', op: 'trend' }, { value: { kind: 'stack', stack: s } }));
    expect(out.field.values[0]).toBeCloseTo(5, 5);                        // per decade
    expect(out.field.relative).toBe(true);
  });
});

describe('lag / selectFrames', () => {
  it('lag shifts stack dates by whole months', () => {
    const s = makeStack(monthlyDates('2024-01', 2), () => 1);
    const out = stack(run({ id: 'l', op: 'lag', params: { months: 3 } }, { value: { kind: 'stack', stack: s } }));
    expect(out.stack.frames.map((f) => f.date)).toEqual(['2024-04-01', '2024-05-01']);
  });

  it('selectFrames filters by month-of-year', () => {
    const s = makeStack(monthlyDates('2024-01', 12), () => 1);
    const out = stack(run({ id: 's', op: 'selectFrames', params: { months: '12,1,2' } }, { value: { kind: 'stack', stack: s } }));
    expect(out.stack.frames.map((f) => f.date.slice(5, 7))).toEqual(['01', '02', '12']);
  });

  it('selectFrames filters by ENSO phase via the ONI threshold', () => {
    const dates = monthlyDates('2024-01', 6);
    const s = makeStack(dates, () => 1);
    const oni = makeSeries(dates, [1.2, 0.8, 0.1, -0.2, -0.9, -1.4], 'oni');
    const nino = stack(run(
      { id: 's', op: 'selectFrames', params: { phase: 'elnino' } },
      { value: { kind: 'stack', stack: s }, oni: { kind: 'series', series: oni } },
    ));
    expect(nino.stack.frames.map((f) => f.date.slice(5, 7))).toEqual(['01', '02']);
    const nina = stack(run(
      { id: 's', op: 'selectFrames', params: { phase: 'lanina' } },
      { value: { kind: 'stack', stack: s }, oni: { kind: 'series', series: oni } },
    ));
    expect(nina.stack.frames.map((f) => f.date.slice(5, 7))).toEqual(['05', '06']);
  });
});

describe('math', () => {
  it('subtracting fields intersects validity and marks the result relative', () => {
    const a = makeField((_lon, lat) => (lat > 0 ? 3 : NaN));
    const b = makeField(() => 1);
    const out = field(run({ id: 'm', op: 'math', params: { fn: 'sub' } }, {
      a: { kind: 'field', field: a }, b: { kind: 'field', field: b },
    }));
    expect(out.field.values[0]).toBeCloseTo(2, 6);
    expect(out.field.values[out.field.values.length - 1]).toBeNaN();
    expect(out.field.relative).toBe(true);
  });

  it('broadcasts a scalar over a stack, and division by zero is NaN', () => {
    const s = makeStack(monthlyDates('2024-01', 2), (_lon, lat) => (lat > 0 ? 4 : 0));
    const divisor: Value = { kind: 'scalar', scalar: { v: 2, unit: 'none', relative: false, label: 'two' } };
    const out = stack(run({ id: 'm', op: 'math', params: { fn: 'div' } }, { a: { kind: 'stack', stack: s }, b: divisor }));
    expect(out.stack.frames[0].values[0]).toBeCloseTo(2, 6);

    const zero: Value = { kind: 'scalar', scalar: { v: 0, unit: 'none', relative: false, label: 'zero' } };
    const boom = stack(run({ id: 'm', op: 'math', params: { fn: 'div' } }, { a: { kind: 'stack', stack: s }, b: zero }));
    expect(boom.stack.frames[0].values[0]).toBeNaN();
  });
});

describe('correlate', () => {
  const dates = monthlyDates('2023-01', 12);

  it('temporal: per-cell r is ±1 for (anti-)linear signals', () => {
    const a = makeStack(dates, (_lon, _lat, k) => Math.sin(k));
    const b = makeStack(dates, (_lon, _lat, k) => 2 * Math.sin(k) + 1);
    const out = field(run({ id: 'r', op: 'correlate', params: { mode: 'temporal' } }, {
      a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: b },
    }));
    expect(out.field.unit).toBe('r');
    expect(out.field.values[0]).toBeCloseTo(1, 5);

    const c = makeStack(dates, (_lon, _lat, k) => -Math.sin(k));
    const anti = field(run({ id: 'r', op: 'correlate', params: { mode: 'temporal' } }, {
      a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: c },
    }));
    expect(anti.field.values[0]).toBeCloseTo(-1, 5);
  });

  it('temporal: cells with fewer than the minimum valid pairs are NaN', () => {
    const a = makeStack(dates, (lon, lat, k) => (lon < -175 && lat > 85 && k >= 3 ? NaN : Math.sin(k)));
    const b = makeStack(dates, (_lon, _lat, k) => Math.sin(k) * 3);
    const out = field(run({ id: 'r', op: 'correlate', params: { mode: 'temporal' } }, {
      a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: b },
    }));
    expect(out.field.values[0]).toBeNaN();          // NW corner cell: only 3 valid pairs
    expect(out.field.values[5]).toBeCloseTo(1, 5);  // same row, valid everywhere else
  });

  it('temporal: refuses stacks whose time ranges do not overlap', () => {
    const a = makeStack(dates, (_lon, _lat, k) => k);
    const off = makeStack(monthlyDates('2026-01', 12), (_lon, _lat, k) => k);
    expect(() => run({ id: 'r', op: 'correlate', params: { mode: 'temporal' } }, {
      a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: off },
    })).toThrow(OpError);
  });

  it('temporal: pairs monthly frames by nearest date despite day-of-month offsets', () => {
    const a = makeStack(dates, (_lon, _lat, k) => Math.sin(k));
    const off = makeStack(dates.map((d) => d.replace('-01', '-11')), (_lon, _lat, k) => Math.sin(k));
    const out = field(run({ id: 'r', op: 'correlate', params: { mode: 'temporal' } }, {
      a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: off },
    }));
    expect(out.field.values[0]).toBeCloseTo(1, 5);
  });

  it('spatial: one weighted r across cells', () => {
    const a = makeField((_lon, lat) => lat);
    const b = makeField((_lon, lat) => 2 * lat + 3);
    const out = scalar(run({ id: 'r', op: 'correlate', params: { mode: 'spatial' } }, {
      a: { kind: 'field', field: a }, b: { kind: 'field', field: b },
    }));
    expect(out.scalar.v).toBeCloseTo(1, 6);
    expect(out.scalar.unit).toBe('r');
    expect(out.scalar.n).toBe(a.values.length);
  });
});

describe('correlateSeries', () => {
  const dates = monthlyDates('2022-01', 24);
  const f = (m: number): number => Math.sin((2 * Math.PI * m) / 12);

  it('recovers a known phase shift through lagMonths', () => {
    const a = makeSeries(dates, dates.map((_d, m) => f(m)), 'a');
    const b = makeSeries(dates, dates.map((_d, m) => f(m + 2)), 'b');   // b leads a by 2 months
    const lagged = scalar(run({ id: 'r', op: 'correlateSeries', params: { lagMonths: 2 } }, {
      a: { kind: 'series', series: a }, b: { kind: 'series', series: b },
    }));
    expect(lagged.scalar.v).toBeCloseTo(1, 6);

    const raw = scalar(run({ id: 'r', op: 'correlateSeries' }, {
      a: { kind: 'series', series: a }, b: { kind: 'series', series: b },
    }));
    expect(raw.scalar.v).toBeCloseTo(Math.cos((2 * Math.PI * 2) / 12), 6);   // cos(60°) = 0.5
    expect(raw.scalar.n).toBe(24);
  });
});

describe('sinks', () => {
  it('display auto-legend: r → balance ±1; relative → symmetric; absolute → viridis p2..p98', () => {
    const r = makeField(() => 0.4, { unit: 'r' });
    const d1 = executeOp({ id: 'd', op: 'display' }, { value: { kind: 'field', field: r } }) as DisplayResult;
    expect(d1.legend.colormap).toBe('balance');
    expect(d1.legend.min).toBe(-1);
    expect(d1.legend.max).toBe(1);

    const rel = makeField((_lon, lat) => lat / 30, { relative: true });
    const d2 = executeOp({ id: 'd', op: 'display' }, { value: { kind: 'field', field: rel } }) as DisplayResult;
    expect(d2.legend.colormap).toBe('balance');
    expect(d2.legend.min).toBeCloseTo(-d2.legend.max, 6);

    const abs = makeField((_lon, lat) => lat);
    const d3 = executeOp({ id: 'd', op: 'display' }, { value: { kind: 'field', field: abs } }) as DisplayResult;
    expect(d3.legend.colormap).toBe('viridis');
    expect(d3.legend.min).toBeGreaterThan(-90);
    expect(d3.legend.max).toBeLessThan(90);
    expect(d3.legend.max).toBeGreaterThan(80);

    const titled = executeOp({ id: 'd', op: 'display', params: { title: 'Custom', colormap: 'thermal' } }, { value: { kind: 'field', field: abs } }) as DisplayResult;
    expect(titled.legend.title).toBe('Custom');
    expect(titled.legend.colormap).toBe('thermal');
  });

  it('answer summarizes a field with area-weighted stats and the autocorrelation flag', () => {
    const f = makeField((_lon, lat) => (lat > 0 ? 1 : NaN), { unit: 'r' });
    const a = executeOp({ id: 'a', op: 'answer', params: { label: 'mean r' } }, { value: { kind: 'field', field: f } }) as AnswerResult;
    expect(a.label).toBe('mean r');
    if (a.payload.type !== 'field') {
      throw new Error('expected field payload');
    }
    expect(a.payload.areaWeightedMean).toBeCloseTo(1, 6);
    expect(a.payload.validFraction).toBeCloseTo(0.5, 6);
    expect(a.payload.spatiallyAutocorrelated).toBe(true);
  });

  it('answer summarizes a series with range and count', () => {
    const s = makeSeries(monthlyDates('2024-01', 3), [1, 2, 3], 'test');
    const a = executeOp({ id: 'a', op: 'answer', params: { label: 'ts' } }, { value: { kind: 'series', series: s } }) as AnswerResult;
    if (a.payload.type !== 'series') {
      throw new Error('expected series payload');
    }
    expect(a.payload.n).toBe(3);
    expect(a.payload.mean).toBeCloseTo(2, 6);
    expect(a.payload.start).toBe('2024-01-01');
  });
});

describe('scatter', () => {
  it('pairs two series by date and fits the exact line', () => {
    const dates = monthlyDates('2024-01', 12);
    const xs = dates.map((_, i) => i);
    const a = makeSeries(dates, xs, 'x');
    const b = makeSeries(dates, xs.map((x) => 2 * x + 1), 'y');
    const s = executeOp({ id: 's', op: 'scatter', inputs: { a: 'a', b: 'b' } },
      { a: { kind: 'series', series: a }, b: { kind: 'series', series: b } }) as ScatterResult;
    expect(s.mode).toBe('temporal');
    expect(s.n).toBe(12);
    expect(s.r).toBeCloseTo(1, 9);
    expect(s.slope).toBeCloseTo(2, 9);
    expect(s.intercept).toBeCloseTo(1, 9);
    expect(s.x).toHaveLength(12);
  });

  it('pairs grid cells (time-mean reducing stacks) and subsamples the plotted points', () => {
    const dates = monthlyDates('2024-01', 3);
    const a = makeStack(dates, (lon) => lon);
    const b = makeStack(dates, (lon) => -3 * lon);
    const s = executeOp({ id: 's', op: 'scatter', inputs: { a: 'a', b: 'b' }, params: { maxPoints: 500 } },
      { a: { kind: 'stack', stack: a }, b: { kind: 'stack', stack: b } }) as ScatterResult;
    expect(s.mode).toBe('spatial');
    expect(s.r).toBeCloseTo(-1, 9);
    expect(s.slope).toBeCloseTo(-3, 6);
    expect(s.x.length).toBeLessThanOrEqual(520);
    expect(s.n).toBe(72 * 36);
  });

  it('rejects disjoint series', () => {
    const a = makeSeries(monthlyDates('2020-01', 3), [1, 2, 3]);
    const b = makeSeries(monthlyDates('2024-01', 3), [1, 2, 3]);
    expect(() => executeOp({ id: 's', op: 'scatter', inputs: { a: 'a', b: 'b' } },
      { a: { kind: 'series', series: a }, b: { kind: 'series', series: b } })).toThrow(OpError);
  });
});

describe('histogram', () => {
  it('bins valid cells with cos(lat) weighting and normalized counts', () => {
    // Northern hemisphere = 1, southern = 3; equal weight either side → 50/50 split.
    const f = makeField((_lon, lat) => (lat > 0 ? 1 : 3));
    const h = executeOp({ id: 'h', op: 'histogram', inputs: { value: 'f' }, params: { bins: 10 } },
      { value: { kind: 'field', field: f } }) as HistogramResult;
    expect(h.edges).toHaveLength(11);
    const total = [...h.counts].reduce((s, c) => s + c, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(h.counts[0]).toBeCloseTo(0.5, 6);        // value 1 → first bin
    expect(h.counts[9]).toBeCloseTo(0.5, 6);        // value 3 → last bin
    expect(h.mean).toBeCloseTo(2, 6);
    expect(h.min).toBe(1);
    expect(h.max).toBe(3);
  });

  it('rejects all-NaN input', () => {
    const f = makeField(() => NaN);
    expect(() => executeOp({ id: 'h', op: 'histogram', inputs: { value: 'f' } },
      { value: { kind: 'field', field: f } })).toThrow(/no valid cells/);
  });
});

describe('hovmoller', () => {
  it('averages each longitude column per frame (lon x time)', () => {
    const dates = monthlyDates('2024-01', 4);
    const stack = makeStack(dates, (lon, _lat, k) => lon + k * 360);
    const hv = executeOp({ id: 'hv', op: 'hovmoller', inputs: { value: 'v' } },
      { value: { kind: 'stack', stack } }) as HovmollerResult;
    expect(hv.axis).toBe('lon');
    expect(hv.width).toBe(72);
    expect(hv.height).toBe(4);
    expect(hv.dates).toHaveLength(4);
    // Column 0 of frame 0 = lon of column 0 (constant along the column).
    expect(hv.values[0]).toBeCloseTo(-177.5, 3);
    // Frame k adds 360.
    expect(hv.values[hv.width]).toBeCloseTo(-177.5 + 360, 3);
    expect(hv.axisStart).toBeCloseTo(-177.5, 3);
    expect(hv.axisStep).toBeCloseTo(5, 6);
  });

  it('restricts averaging to a region and supports the lat axis', () => {
    const dates = monthlyDates('2024-01', 2);
    // Value = lat inside the tropics, NaN elsewhere → lat-axis rows echo their latitude.
    const stack = makeStack(dates, (_lon, lat) => lat);
    const hv = executeOp({ id: 'hv', op: 'hovmoller', inputs: { value: 'v', region: 'r' }, params: { axis: 'lat' } },
      {
        value: { kind: 'stack', stack },
        region: { kind: 'region', region: { kind: 'bbox', lonMin: -180, latMin: -10, lonMax: 180, latMax: 10 } },
      }) as HovmollerResult;
    expect(hv.width).toBe(36);
    // Rows outside the band are NaN; rows inside echo their latitude.
    expect(hv.values[0]).toBeNaN();                       // 87.5N excluded
    const rowInBand = Math.floor(36 / 2) - 1;             // 2.5N
    expect(hv.values[rowInBand]).toBeCloseTo(2.5, 3);
  });
});

describe('annotate', () => {
  it('finds separated maxima and minima with values and coordinates', () => {
    // Two warm blobs on the equator at -90 and +90, cold elsewhere.
    const f = makeField((lon, _lat) => {
      const d1 = Math.abs(lon + 90), d2 = Math.abs(lon - 90);
      return 10 - Math.min(d1, d2) * 0.1;
    });
    const a = executeOp({ id: 'a', op: 'annotate', inputs: { value: 'f' }, params: { stat: 'max', count: 2 } },
      { value: { kind: 'field', field: f } }) as AnnotateResult;
    expect(a.markers).toHaveLength(2);
    const lons = a.markers.map((m) => m.lon).sort((x, y) => x - y);
    expect(Math.abs(lons[0] + 90)).toBeLessThan(6);
    expect(Math.abs(lons[1] - 90)).toBeLessThan(6);
    for (const m of a.markers) {
      expect(m.kind).toBe('max');
      expect(m.value).toBeGreaterThan(9);
    }
  });

  it('both mode returns max and min markers', () => {
    const f = makeField((lon) => lon);
    const a = executeOp({ id: 'a', op: 'annotate', inputs: { value: 'f' }, params: { stat: 'both', count: 1 } },
      { value: { kind: 'field', field: f } }) as AnnotateResult;
    expect(a.markers).toHaveLength(2);
    expect(a.markers[0].kind).toBe('max');
    expect(a.markers[1].kind).toBe('min');
    expect(a.markers[0].value).toBeGreaterThan(a.markers[1].value);
  });
});

describe('displayVectors', () => {
  it('time-mean reduces stack components and reports a p98 magnitude normalizer', () => {
    const dates = monthlyDates('2024-01', 2);
    const u = makeStack(dates, (_lon, _lat, k) => (k === 0 ? 2 : 4), { unit: 'mps' });   // mean 3
    const v = makeStack(dates, () => 4, { unit: 'mps' });
    const r = executeOp({ id: 'v', op: 'displayVectors', inputs: { u: 'u', v: 'v' } },
      { u: { kind: 'stack', stack: u }, v: { kind: 'stack', stack: v } }) as VectorsResult;
    expect(r.u[0]).toBeCloseTo(3, 5);
    expect(r.v[0]).toBeCloseTo(4, 5);
    expect(r.maxMag).toBeCloseTo(5, 3);
    expect(r.strideDeg).toBe(5);
    expect(r.unit).toBe('mps');
  });

  it('rejects mismatched grids', () => {
    const u = makeField(() => 1);
    const v = makeField(() => 1, { width: 10, height: 5 });
    expect(() => executeOp({ id: 'v', op: 'displayVectors', inputs: { u: 'u', v: 'v' } },
      { u: { kind: 'field', field: u }, v: { kind: 'field', field: v } })).toThrow(/grid mismatch/);
  });
});
