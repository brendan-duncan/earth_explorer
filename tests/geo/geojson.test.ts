import { describe, it, expect } from 'vitest';
import { parseGeoJson } from '../../src/geo/geojson.js';

describe('geojson: parse', () => {
  it('reads a FeatureCollection with mixed geometry, carrying properties + id', () => {
    const p = parseGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 7, properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [10, 20] } },
        { type: 'Feature', properties: { road: 'main' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] } },
        { type: 'Feature', properties: null, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
      ],
    });
    expect(p.points).toHaveLength(1);
    expect(p.points[0].position).toEqual([10, 20]);
    expect(p.points[0].properties).toEqual({ name: 'A' });
    expect(p.points[0].id).toBe(7);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].path).toHaveLength(3);
    expect(p.lines[0].properties).toEqual({ road: 'main' });
    expect(p.polygons).toHaveLength(1);
    expect(p.polygons[0].rings[0]).toHaveLength(5);
  });

  it('expands Multi* parts into one primitive each, sharing the feature properties', () => {
    const p = parseGeoJson({
      type: 'Feature',
      properties: { kind: 'multi' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 5]]],
        ],
      },
    });
    expect(p.polygons).toHaveLength(2);
    expect(p.polygons[0].properties).toEqual({ kind: 'multi' });
    expect(p.polygons[1].properties).toEqual({ kind: 'multi' });
    expect(p.polygons[1].rings[0][0]).toEqual([5, 5]);
  });

  it('keeps polygon holes as extra rings', () => {
    const p = parseGeoJson({
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],     // exterior
        [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]],          // hole
      ],
    });
    expect(p.polygons).toHaveLength(1);
    expect(p.polygons[0].rings).toHaveLength(2);
  });

  it('recurses GeometryCollection and accepts MultiPoint / MultiLineString', () => {
    const p = parseGeoJson({
      type: 'GeometryCollection',
      geometries: [
        { type: 'MultiPoint', coordinates: [[0, 0], [1, 1], [2, 2]] },
        { type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]], [[0, 1], [1, 1]]] },
      ],
    });
    expect(p.points).toHaveLength(3);
    expect(p.lines).toHaveLength(2);
  });

  it('reads a 3D position altitude', () => {
    const p = parseGeoJson({ type: 'Point', coordinates: [1, 2, 300] });
    expect(p.points[0].position).toEqual([1, 2, 300]);
  });

  it('skips malformed parts instead of throwing', () => {
    const p = parseGeoJson({
      type: 'FeatureCollection',
      features: [
        null,
        { type: 'Feature' },                                              // no geometry
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0]] } }, // < 2 points
        { type: 'Feature', geometry: { type: 'Point', coordinates: [9, 9] } },        // valid
        { type: 'NotAType' },
      ],
    });
    expect(p.points).toHaveLength(1);
    expect(p.lines).toHaveLength(0);
    expect(p.polygons).toHaveLength(0);
  });

  it('returns empty for non-objects', () => {
    expect(parseGeoJson(null)).toEqual({ points: [], lines: [], polygons: [] });
    expect(parseGeoJson('nope')).toEqual({ points: [], lines: [], polygons: [] });
  });
});
