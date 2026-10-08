/** Synthetic-data builders for the analysis-graph tests (not a test file itself). */

import { frameEpoch, type CpuField, type CpuStack, type SeriesValue, type Unit } from '../../src/analysis/types.js';

/** Small 5° test grid — ops only require internal consistency, not the 1° analysis grid. */
export const W = 72;
export const H = 36;

export interface FieldOpts {
  date?: string;
  unit?: Unit;
  relative?: boolean;
  width?: number;
  height?: number;
}

/** Builds a field from a `(lonDeg, latDeg) → value` function (NaN = invalid). */
export function makeField(fn: (lon: number, lat: number) => number, opts: FieldOpts = {}): CpuField {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      values[y * width + x] = fn(lon, lat);
    }
  }
  return {
    width, height,
    date: opts.date ?? '2024-01-01',
    values,
    unit: opts.unit ?? 'degC',
    relative: opts.relative ?? false,
  };
}

/** Builds a dated stack from a per-frame field function. */
export function makeStack(dates: string[], fn: (lon: number, lat: number, k: number) => number, opts: FieldOpts = {}): CpuStack {
  return { frames: dates.map((date, k) => makeField((lon, lat) => fn(lon, lat, k), { ...opts, date })) };
}

/** `n` consecutive month-start dates from `start` (`YYYY-MM`). */
export function monthlyDates(start: string, n: number): string[] {
  let y = parseInt(start.slice(0, 4), 10);
  let m = parseInt(start.slice(5, 7), 10) - 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}-01`);
    m++;
    y += Math.floor(m / 12);
    m %= 12;
  }
  return out;
}

/** A monthly series over the given month-start dates. */
export function makeSeries(dates: string[], vals: number[], label = 'test'): SeriesValue {
  return {
    t: new Float64Array(dates.map((d) => frameEpoch(d))),
    v: new Float64Array(vals),
    unit: 'none',
    relative: false,
    label,
  };
}
