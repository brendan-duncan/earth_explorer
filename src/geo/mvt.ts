/**
 * Minimal Mapbox Vector Tile (MVT) decoder — pure, GPU-free, dependency-free.
 *
 * MVT is a small, stable protobuf schema (https://github.com/mapbox/vector-tile-spec): a tile
 * is a set of named layers, each a list of features (point / line / polygon) whose geometry is
 * in tile-local integer coordinates (0..`extent`, default 4096, origin top-left, y down) and
 * whose properties are key/value indices into the layer's tables. We hand-roll the protobuf
 * wire reader (as with the EXIF parser in geo_photo) rather than pull in `pbf` — only a handful
 * of wire types and fields are needed, and this keeps the geo system free of npm decoders.
 *
 * The geometry decoder expands the command/parameter integer stream into rings of `[x, y]`
 * points (one ring per MoveTo); polygon exterior vs. interior (hole) rings are left for the
 * consumer to classify by signed area (see {@link ringArea}).
 */

/** MVT geometry type (Feature.type).
 * @category Vector & GeoJSON */
export const enum MvtGeomType {
  Unknown = 0,
  Point = 1,
  LineString = 2,
  Polygon = 3,
}

/** A decoded feature: its geometry as rings of tile-local points + decoded properties.
 * @category Vector & GeoJSON */
export interface VectorFeature {
  type: MvtGeomType;
  /** Rings of `[x, y]` points in tile coordinates (0..extent). For polygons each ring is a
   *  closed loop; classify exterior/hole via {@link ringArea}. */
  rings: Array<Array<[number, number]>>;
  properties: Record<string, string | number | boolean>;
  id?: number;
}

/** A decoded layer.
 * @category Vector & GeoJSON */
export interface VectorLayer {
  name: string;
  extent: number;
  features: VectorFeature[];
}

// ── Protobuf wire reader ──────────────────────────────────────────────────────

/** Wire types we handle. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

/** A cursor over a protobuf message's bytes. */
class PbReader {
  pos: number;
  constructor(private readonly buf: Uint8Array, private readonly end: number, start = 0) {
    this.pos = start;
  }

  get atEnd(): boolean {
    return this.pos >= this.end;
  }

  /** Reads a base-128 varint as a JS number (safe to 2^53 — ample for MVT). */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift; // multiply (not <<) so it survives past 32 bits
      if ((b & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    return result;
  }

  readTag(): { field: number; wire: number } {
    const key = this.readVarint();
    return { field: key >>> 3, wire: key & 0x7 };
  }

  readString(): string {
    const len = this.readVarint();
    const s = utf8Decode(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  readFloat(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  readDouble(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  /** Returns a sub-reader over the next length-delimited field, advancing past it. */
  readMessage(): PbReader {
    const len = this.readVarint();
    const sub = new PbReader(this.buf, this.pos + len, this.pos);
    this.pos += len;
    return sub;
  }

  /** Skips a field of the given wire type. */
  skip(wire: number): void {
    if (wire === WIRE_VARINT) {
      this.readVarint();
    } else if (wire === WIRE_BYTES) {
      this.pos += this.readVarint();
    } else if (wire === WIRE_FIXED32) {
      this.pos += 4;
    } else if (wire === WIRE_FIXED64) {
      this.pos += 8;
    }
  }
}

/** Minimal UTF-8 decode over a byte range (TextDecoder when available, else a small ASCII+
 *  multibyte fallback so it works in any environment). */
function utf8Decode(buf: Uint8Array, start: number, end: number): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(buf.subarray(start, end));
  }
  let s = '';
  for (let i = start; i < end; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

// ── MVT message decoding ──────────────────────────────────────────────────────

/** Zig-zag decode (geometry params + sint values). */
function zigzag(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

/** Decodes a feature's command/parameter geometry stream into rings of tile-local points. */
function decodeGeometry(data: number[]): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < data.length) {
    const cmd = data[i] & 0x7;
    const count = data[i] >> 3;
    i++;
    if (cmd === 1) { // MoveTo — starts a new ring
      for (let k = 0; k < count; k++) {
        x += zigzag(data[i++]);
        y += zigzag(data[i++]);
        if (cur.length > 0) {
          rings.push(cur);
        }
        cur = [[x, y]];
      }
    } else if (cmd === 2) { // LineTo
      for (let k = 0; k < count; k++) {
        x += zigzag(data[i++]);
        y += zigzag(data[i++]);
        cur.push([x, y]);
      }
    } else if (cmd === 7) { // ClosePath
      if (cur.length > 0) {
        rings.push(cur);
        cur = [];
      }
    }
  }
  if (cur.length > 0) {
    rings.push(cur);
  }
  return rings;
}

/** Reads packed-or-unpacked repeated uint32 from a field into `out`. */
function readPackedUint32(r: PbReader, wire: number, out: number[]): void {
  if (wire === WIRE_BYTES) {
    const sub = r.readMessage();
    while (!sub.atEnd) {
      out.push(sub.readVarint());
    }
  } else {
    out.push(r.readVarint());
  }
}

/** Decodes one MVT Value message to a JS primitive. */
function decodeValue(r: PbReader): string | number | boolean {
  let value: string | number | boolean = '';
  while (!r.atEnd) {
    const { field, wire } = r.readTag();
    switch (field) {
      case 1: value = r.readString(); break;
      case 2: value = r.readFloat(); break;
      case 3: value = r.readDouble(); break;
      case 4: value = r.readVarint(); break;          // int_value
      case 5: value = r.readVarint(); break;          // uint_value
      case 6: value = zigzag(r.readVarint()); break;  // sint_value
      case 7: value = r.readVarint() !== 0; break;    // bool_value
      default: r.skip(wire); break;
    }
  }
  return value;
}

/** Decodes a single layer message. */
function decodeLayer(r: PbReader): VectorLayer {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: Array<string | number | boolean> = [];
  const featureReaders: PbReader[] = [];
  while (!r.atEnd) {
    const { field, wire } = r.readTag();
    switch (field) {
      case 1: name = r.readString(); break;
      case 2: featureReaders.push(r.readMessage()); break;
      case 3: keys.push(r.readString()); break;
      case 4: values.push(decodeValue(r.readMessage())); break;
      case 5: extent = r.readVarint(); break;
      case 15: r.readVarint(); break; // version
      default: r.skip(wire); break;
    }
  }
  const features: VectorFeature[] = [];
  for (const fr of featureReaders) {
    features.push(decodeFeature(fr, keys, values));
  }
  return { name, extent, features };
}

/** Decodes a single feature message, resolving its tags against the layer tables. */
function decodeFeature(
  r: PbReader, keys: string[], values: Array<string | number | boolean>,
): VectorFeature {
  let id: number | undefined;
  let type = MvtGeomType.Unknown;
  const tags: number[] = [];
  const geom: number[] = [];
  while (!r.atEnd) {
    const { field, wire } = r.readTag();
    switch (field) {
      case 1: id = r.readVarint(); break;
      case 2: readPackedUint32(r, wire, tags); break;
      case 3: type = r.readVarint() as MvtGeomType; break;
      case 4: readPackedUint32(r, wire, geom); break;
      default: r.skip(wire); break;
    }
  }
  const properties: Record<string, string | number | boolean> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const k = keys[tags[i]];
    const v = values[tags[i + 1]];
    if (k !== undefined && v !== undefined) {
      properties[k] = v;
    }
  }
  return { type, rings: decodeGeometry(geom), properties, id };
}

/**
 * Decodes an MVT tile into its layers. Gzip is NOT handled here — pass already-inflated bytes
 * (providers serve `.pbf` either raw or `Content-Encoding: gzip`, which the browser inflates).
 * @category Vector & GeoJSON
 */
export function decodeMvt(bytes: ArrayBuffer): VectorLayer[] {
  const buf = new Uint8Array(bytes);
  const r = new PbReader(buf, buf.length, 0);
  const layers: VectorLayer[] = [];
  while (!r.atEnd) {
    const { field, wire } = r.readTag();
    if (field === 3 && wire === WIRE_BYTES) {
      layers.push(decodeLayer(r.readMessage()));
    } else {
      r.skip(wire);
    }
  }
  return layers;
}

/** Signed area of a ring (shoelace). In MVT's y-down tile space an exterior ring is clockwise
 *  → positive area; a hole is counter-clockwise → negative.
 *  @category Vector & GeoJSON */
export function ringArea(ring: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}
