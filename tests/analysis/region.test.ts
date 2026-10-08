// Polygon regions — the geometry behind an area drawn on the map. The antimeridian cases are the
// whole reason this has tests: a ring straddling ±180° is the one shape a naive point-in-polygon
// test silently gets inside-out, and it happens the moment someone drags a box across the Pacific.

import { describe, expect, it } from 'vitest';
import {
  formatRing, inRegion, parseRing, regionBbox, unwrapRing, type RegionValue,
} from '../../src/analysis/types.js';

const poly = (points: Array<[number, number]>): RegionValue => ({ kind: 'polygon', points });

describe('parseRing / formatRing', () => {
  it('round-trips a ring through the string form params use', () => {
    const pts: Array<[number, number]> = [[-80, 25], [-40, 25], [-40, 45]];
    expect(parseRing(formatRing(pts))).toEqual(pts);
  });

  it('skips malformed vertices rather than producing NaN geometry', () => {
    expect(parseRing('10,20 bogus 30,40 50,')).toEqual([[10, 20], [30, 40]]);
  });

  it('tolerates the whitespace a hand-written or LLM-written param carries', () => {
    expect(parseRing('  10,20\n  30,40  ')).toEqual([[10, 20], [30, 40]]);
  });
});

describe('unwrapRing', () => {
  it('leaves a ring that does not cross the antimeridian alone', () => {
    expect(unwrapRing([[-80, 25], [-40, 25], [-40, 45]])).toEqual([[-80, 25], [-40, 25], [-40, 45]]);
  });

  it('makes a Pacific-crossing ring contiguous instead of springing across the map', () => {
    // 170°E → 170°W is a 20° hop east, not a 340° hop west.
    const out = unwrapRing([[170, 0], [-170, 0], [-170, 10], [170, 10]]);
    expect(out.map(([lon]) => lon)).toEqual([170, 190, 190, 170]);
  });
});

describe('regionBbox', () => {
  it('bounds a plain polygon', () => {
    expect(regionBbox(poly([[-80, 25], [-40, 25], [-40, 45], [-80, 45]])))
      .toEqual({ lonMin: -80, lonMax: -40, latMin: 25, latMax: 45 });
  });

  it('folds an antimeridian-crossing ring back to a wrapping bbox', () => {
    const b = regionBbox(poly([[170, 0], [-170, 0], [-170, 10], [170, 10]]));
    expect(b.latMin).toBe(0);
    expect(b.latMax).toBe(10);
    // Folded back into [−180, 180] it reads as the wrapping form lonMin > lonMax.
    expect(b.lonMin).toBeCloseTo(170, 6);
    expect(b.lonMax).toBeCloseTo(-170, 6);
  });

  it('always folds polygon longitudes back into [-180, 180]', () => {
    // Out-of-range input (a ring authored in 0..360, or unwrapped by a caller) still yields
    // legal longitudes. Only the latitude bounds are load-bearing — they are the per-row reject.
    const b = regionBbox(poly([[190, -10], [230, -10], [230, 10], [190, 10]]));
    expect(b.lonMin).toBeGreaterThanOrEqual(-180);
    expect(b.lonMax).toBeLessThanOrEqual(180);
    expect(b.latMin).toBe(-10);
    expect(b.latMax).toBe(10);
    // …and the exact test still accepts the interior, wherever the longitudes were written.
    expect(inRegion(-150, 0, poly([[190, -10], [230, -10], [230, 10], [190, 10]]))).toBe(true);
  });
});

describe('inRegion — polygons', () => {
  const gulf = poly([[-80, 25], [-40, 25], [-40, 45], [-80, 45]]);

  it('accepts interior points and rejects exterior ones', () => {
    expect(inRegion(-60, 35, gulf)).toBe(true);
    expect(inRegion(-100, 35, gulf)).toBe(false);   // west of it
    expect(inRegion(-60, 15, gulf)).toBe(false);    // south of it
    expect(inRegion(-60, 55, gulf)).toBe(false);    // north of it
  });

  it('handles a concave ring — a bay is outside even though it is inside the bbox', () => {
    // A "C" opening east: the notch between the arms must read as outside.
    const c = poly([[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]]);
    expect(inRegion(1, 5, c)).toBe(true);    // the spine
    expect(inRegion(6, 5, c)).toBe(false);   // the notch
    expect(inRegion(6, 1, c)).toBe(true);    // the lower arm
    expect(inRegion(6, 9, c)).toBe(true);    // the upper arm
  });

  it('works across the antimeridian, from both sides', () => {
    const pacific = poly([[170, -5], [-170, -5], [-170, 5], [170, 5]]);
    expect(inRegion(175, 0, pacific)).toBe(true);    // east of the dateline
    expect(inRegion(-175, 0, pacific)).toBe(true);   // west of it
    expect(inRegion(180, 0, pacific)).toBe(true);    // on it
    expect(inRegion(0, 0, pacific)).toBe(false);     // the far side of the world
    expect(inRegion(175, 20, pacific)).toBe(false);  // right longitude, wrong latitude
  });

  it('treats a degenerate ring as empty rather than throwing', () => {
    expect(inRegion(0, 0, poly([[0, 0], [1, 1]]))).toBe(false);
    expect(inRegion(0, 0, poly([]))).toBe(false);
  });

  it('still routes boxes and presets through the bbox forms', () => {
    expect(inRegion(-150, 0, { kind: 'preset', name: 'nino34' })).toBe(true);
    expect(inRegion(0, 0, { kind: 'preset', name: 'nino34' })).toBe(false);
    // A box written in the wrapping form covers the dateline.
    const wrap: RegionValue = { kind: 'bbox', lonMin: 120, lonMax: -100, latMin: 0, latMax: 60 };
    expect(inRegion(170, 30, wrap)).toBe(true);
    expect(inRegion(-120, 30, wrap)).toBe(true);
    expect(inRegion(0, 30, wrap)).toBe(false);
  });
});
