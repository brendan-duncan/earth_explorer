/**
 * GeoJSON (RFC 7946) parsing — "put your own data on the map". Pure and GPU/DOM-free
 * (unit-tests without a device): it turns a parsed JSON object into a flat, render-ready
 * list of typed primitives in lon/lat, leaving tessellation + floating-origin baking to
 * {@link geojson_build.ts} and rendering to the GeoJSON render feature.
 *
 * Scope: the seven GeoJSON geometry types (`Point`, `MultiPoint`, `LineString`,
 * `MultiLineString`, `Polygon`, `MultiPolygon`, `GeometryCollection`) plus `Feature` /
 * `FeatureCollection` wrappers. A `Multi*` geometry expands into one primitive per part,
 * each carrying the parent feature's `properties` (so a click / style sees them). Bare
 * geometries (no `Feature` wrapper) and a top-level geometry are accepted too. Not handled
 * (out of scope for a renderer): CRS members (RFC 7946 fixes WGS84 lon/lat), bounding-box
 * `bbox` members (ignored), and foreign top-level members.
 */

/** A GeoJSON position: `[lon, lat]` or `[lon, lat, altitude]` (degrees / meters). Altitude
 *  defaults to 0 when absent.
 *  @category Vector & GeoJSON */
export type GeoPosition = [number, number] | [number, number, number];

/** A feature's free-form properties (GeoJSON allows any JSON; null when the feature has none).
 *  @category Vector & GeoJSON */
export type GeoProperties = Record<string, unknown> | null;

/** A point primitive (one of a `Point` / each part of a `MultiPoint`).
 *  @category Vector & GeoJSON */
export interface GeoPointPrimitive {
  position: GeoPosition;
  properties: GeoProperties;
  /** The feature `id`, when the source set one (GeoJSON `Feature.id`). */
  id?: string | number;
}

/** A polyline primitive (a `LineString` / each part of a `MultiLineString`).
 *  @category Vector & GeoJSON */
export interface GeoLinePrimitive {
  path: GeoPosition[];
  properties: GeoProperties;
  id?: string | number;
}

/** A polygon primitive (a `Polygon` / each part of a `MultiPolygon`). `rings[0]` is the
 *  exterior ring; any further rings are holes. Rings keep their GeoJSON winding (exterior
 *  CCW, holes CW per the spec) but the builders are orientation-agnostic.
 *  @category Vector & GeoJSON */
export interface GeoPolygonPrimitive {
  rings: GeoPosition[][];
  properties: GeoProperties;
  id?: string | number;
}

/** The flat, primitive-typed result of {@link parseGeoJson} — three lists ready for the
 *  builders, with `Multi*` parts already expanded.
 *  @category Vector & GeoJSON */
export interface ParsedGeoJson {
  points: GeoPointPrimitive[];
  lines: GeoLinePrimitive[];
  polygons: GeoPolygonPrimitive[];
}

function isPosition(v: unknown): v is GeoPosition {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

function isPositionArray(v: unknown): v is GeoPosition[] {
  return Array.isArray(v) && v.every(isPosition);
}

/**
 * Parses a GeoJSON object (a `FeatureCollection`, a `Feature`, a `GeometryCollection`, or a
 * bare geometry) into a {@link ParsedGeoJson}. Malformed parts are skipped rather than
 * thrown on, so one bad feature doesn't drop a whole dataset; pass an already-`JSON.parse`d
 * object (this module does no fetching).
 * @category Vector & GeoJSON
 */
export function parseGeoJson(root: unknown): ParsedGeoJson {
  const out: ParsedGeoJson = { points: [], lines: [], polygons: [] };
  if (root === null || typeof root !== 'object') {
    return out;
  }
  const obj = root as { type?: unknown };
  switch (obj.type) {
    case 'FeatureCollection': {
      const fc = root as { features?: unknown };
      if (Array.isArray(fc.features)) {
        for (const f of fc.features) {
          addFeature(f, out);
        }
      }
      break;
    }
    case 'Feature':
      addFeature(root, out);
      break;
    default:
      // A bare geometry (or GeometryCollection) at the top level — no properties.
      addGeometry(root, null, undefined, out);
      break;
  }
  return out;
}

function addFeature(feature: unknown, out: ParsedGeoJson): void {
  if (feature === null || typeof feature !== 'object') {
    return;
  }
  const f = feature as { type?: unknown; geometry?: unknown; properties?: unknown; id?: unknown };
  if (f.type !== 'Feature' || f.geometry === null || f.geometry === undefined) {
    return;
  }
  const props = (f.properties && typeof f.properties === 'object') ? f.properties as Record<string, unknown> : null;
  const id = (typeof f.id === 'string' || typeof f.id === 'number') ? f.id : undefined;
  addGeometry(f.geometry, props, id, out);
}

function addGeometry(geometry: unknown, props: GeoProperties, id: string | number | undefined, out: ParsedGeoJson): void {
  if (geometry === null || typeof geometry !== 'object') {
    return;
  }
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  const c = g.coordinates;
  switch (g.type) {
    case 'Point':
      if (isPosition(c)) {
        out.points.push({ position: c, properties: props, id });
      }
      break;
    case 'MultiPoint':
      if (isPositionArray(c)) {
        for (const p of c) {
          out.points.push({ position: p, properties: props, id });
        }
      }
      break;
    case 'LineString':
      if (isPositionArray(c) && c.length >= 2) {
        out.lines.push({ path: c, properties: props, id });
      }
      break;
    case 'MultiLineString':
      if (Array.isArray(c)) {
        for (const line of c) {
          if (isPositionArray(line) && line.length >= 2) {
            out.lines.push({ path: line, properties: props, id });
          }
        }
      }
      break;
    case 'Polygon':
      if (Array.isArray(c)) {
        const rings = c.filter(isPositionArray);
        if (rings.length > 0) {
          out.polygons.push({ rings, properties: props, id });
        }
      }
      break;
    case 'MultiPolygon':
      if (Array.isArray(c)) {
        for (const poly of c) {
          if (Array.isArray(poly)) {
            const rings = poly.filter(isPositionArray);
            if (rings.length > 0) {
              out.polygons.push({ rings, properties: props, id });
            }
          }
        }
      }
      break;
    case 'GeometryCollection':
      if (Array.isArray(g.geometries)) {
        for (const sub of g.geometries) {
          addGeometry(sub, props, id, out);
        }
      }
      break;
    default:
      break; // unknown geometry type — skip
  }
}
