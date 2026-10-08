import { describe, it, expect } from 'vitest';
import { decodeMvt, ringArea, MvtGeomType } from '../../src/geo/mvt.js';

/** Minimal protobuf encode helpers, to craft a tiny MVT tile for the decoder round-trip. */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}
function lenDelim(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body];
}
function str(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

describe('decodeMvt', () => {
  // One "building" layer, extent 4096, one polygon feature: a 10×10 square at the origin.
  // Geometry: MoveTo(0,0), LineTo(10,0)(0,10)(-10,0), ClosePath. Deltas zig-zag encoded.
  const geometry = [
    9, 0, 0,            // MoveTo 1: dx=0, dy=0
    26, 20, 0, 0, 20, 19, 0, // LineTo 3: (+10,0)(0,+10)(-10,0)
    15,                 // ClosePath
  ];
  const feature = [
    ...tag(3, 0), 3,                 // type = Polygon
    ...lenDelim(4, geometry),        // geometry (packed)
  ];
  const layer = [
    ...tag(15, 0), 2,                // version
    ...lenDelim(1, str('building')), // name
    ...tag(5, 0), ...varint(4096),   // extent
    ...lenDelim(2, feature),         // features
  ];
  const tile = new Uint8Array(lenDelim(3, layer)).buffer;

  const layers = decodeMvt(tile);

  it('decodes the layer name + extent', () => {
    expect(layers.length).toBe(1);
    expect(layers[0].name).toBe('building');
    expect(layers[0].extent).toBe(4096);
  });

  it('decodes one polygon feature with the square ring', () => {
    const f = layers[0].features;
    expect(f.length).toBe(1);
    expect(f[0].type).toBe(MvtGeomType.Polygon);
    expect(f[0].rings.length).toBe(1);
    expect(f[0].rings[0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });
});

describe('ringArea', () => {
  it('is positive for a clockwise (exterior) ring in y-down tile space', () => {
    // The square above, wound clockwise in y-down coords → +100 (10×10).
    expect(ringArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
  });

  it('is negative for the reverse (hole) winding', () => {
    expect(ringArea([[0, 0], [0, 10], [10, 10], [10, 0]])).toBe(-100);
  });
});
