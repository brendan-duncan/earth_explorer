import { describe, expect, it } from 'vitest';
import {
  chooseDetailSource,
  esriTileCount,
  gibsTileCount,
  mercYNorm,
  type UvRect,
} from '../../src/live/tile_window.js';

/** A viewport rect centered at (cu, cv) spanning du×dv in equirect uv. */
function rect(cu: number, cv: number, du: number, dv: number): UvRect {
  return { u0: cu - du / 2, u1: cu + du / 2, v0: cv - dv / 2, v1: cv + dv / 2 };
}

describe('mercYNorm', () => {
  it('maps the equator to 0.5 and the caps to 0/1', () => {
    expect(mercYNorm(0)).toBeCloseTo(0.5, 12);
    expect(mercYNorm(85.06)).toBeCloseTo(0, 5);   // clamped at the Mercator cap
    expect(mercYNorm(-85.06)).toBeCloseTo(1, 5);
  });

  it('is monotonically decreasing in latitude', () => {
    let prev = mercYNorm(-84);
    for (let lat = -80; lat <= 84; lat += 4) {
      const y = mercYNorm(lat);
      expect(y).toBeLessThan(prev);
      prev = y;
    }
  });

  it('matches the closed form at ±45°', () => {
    // y = 0.5 − ln(tan(45°) + sec(45°))·… — spot value: ln(1+√2)/(2π) below center.
    expect(mercYNorm(45)).toBeCloseTo(0.5 - Math.log(1 + Math.SQRT2) / (2 * Math.PI), 12);
  });
});

describe('chooseDetailSource', () => {
  const W = 1500, H = 750;

  it('serves a moderate zoom from GIBS at a resolution-matched level', () => {
    // du 0.125 → needs 12000 world px → GIBS level ceil(log2(12000/640)) = 5.
    const pick = chooseDetailSource(rect(0.5, 0.5, 0.125, 0.0625), W, H);
    expect(pick).toMatchObject({ kind: 'gibs', level: 5, worldW: 640 << 5 });
  });

  it('hands off to Esri once the need exceeds the GIBS ceiling', () => {
    // du 0.01 → needs 150000 world px > 640·2^7 → Mercator z = ceil(log2(150000/256)) = 10.
    const pick = chooseDetailSource(rect(0.5, 0.5, 0.01, 0.005), W, H);
    expect(pick).toMatchObject({ kind: 'esri', level: 10 });
  });

  it('resolves street-level views near the provider max zoom', () => {
    const pick = chooseDetailSource(rect(0.3, 0.4, 1e-5, 5e-6), W, H);
    expect(pick?.kind).toBe('esri');
    expect(pick?.level).toBe(19);   // capped at Esri's native max
  });

  it('never exceeds the Esri max zoom', () => {
    const pick = chooseDetailSource(rect(0.3, 0.4, 1e-8, 5e-9), W, H);
    expect(pick?.level).toBe(19);
  });

  it('backs off under the tile budget', () => {
    const r = rect(0.5, 0.5, 0.01, 0.005);
    const pick = chooseDetailSource(r, W, H, { maxTiles: 12 });
    expect(pick).not.toBeNull();
    if (pick!.kind === 'esri') {
      expect(esriTileCount(r, pick!.level)).toBeLessThanOrEqual(12);
    } else {
      expect(gibsTileCount(r, pick!.level)).toBeLessThanOrEqual(12);
    }
  });

  it('declines a window that would be coarser than the global basemap', () => {
    // A near-pole band: every longitude on screen but a sliver of latitude. The budget
    // backoff would bottom out below basemap resolution — expect "no window" instead.
    const pick = chooseDetailSource({ u0: 0, u1: 1, v0: 0.001, v1: 0.003 }, W, H);
    expect(pick).toBeNull();
  });

  it('declines empty or degenerate rects', () => {
    expect(chooseDetailSource({ u0: 0.5, u1: 0.5, v0: 0.2, v1: 0.4 }, W, H)).toBeNull();
    expect(chooseDetailSource(rect(0.5, 0.5, 0.1, 0.05), 0, 0)).toBeNull();
  });

  it('keeps the assembled raster within the destination caps', () => {
    for (const r of [rect(0.5, 0.5, 0.4, 0.05), rect(0.5, 0.5, 0.02, 0.3), rect(0.1, 0.2, 0.002, 0.001)]) {
      const pick = chooseDetailSource(r, W, H);
      if (pick) {
        expect(Math.min(1, r.u1 - r.u0) * pick.worldW).toBeLessThanOrEqual(3200);
        expect((r.v1 - r.v0) * pick.worldW * 0.5).toBeLessThanOrEqual(2304);
      }
    }
  });
});

describe('tile counts', () => {
  it('gibs: whole world at level 2 is the loadGibsDay grid (≈15 tiles + seams)', () => {
    // Level 2 world = 2560×1280 → 5×3 tiles; the +1 seam slack keeps the estimate an upper bound.
    expect(gibsTileCount({ u0: 0, u1: 1, v0: 0, v1: 1 }, 2)).toBeGreaterThanOrEqual(15);
    expect(gibsTileCount({ u0: 0, u1: 1, v0: 0, v1: 1 }, 2)).toBeLessThanOrEqual(24);
  });

  it('esri: a screen-sized mid-latitude rect stays near a handful of tiles', () => {
    const n = esriTileCount(rect(0.5, 0.3, 0.01, 0.005), 10);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(110);
  });

  it('esri: rows collapse for a rect fully poleward of the Mercator cap', () => {
    // Above 85.05° the mercY span clamps to zero-height → minimal row count, no blow-up.
    const n = esriTileCount({ u0: 0.2, u1: 0.3, v0: 0.001, v1: 0.01 }, 12);
    expect(n).toBeLessThanOrEqual((Math.ceil(0.1 * 4096) + 1) * 2);
  });
});
