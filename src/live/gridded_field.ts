/**
 * Generic gridded "living world" data field — the multi-layer generalization of
 * {@link "./sst_field".SstField}. Any ERDDAP griddap variable (or a committed baked snapshot)
 * becomes one equirectangular value-texture on a FULL −180..180 / +90..−90 grid, so every layer
 * shares one sampling contract regardless of the upstream grid's longitude convention, latitude
 * order, coverage, or extra depth/level dimension.
 *
 * Two texture shapes behind one contract:
 *   - **scalar** (`vector = false`): rgba8 with R = value normalized into [`min`,`max`] (linearly,
 *     or in log10 when `isLog`), A = valid/land mask. Decode: `v = min + R·(max−min)` (or the log
 *     inverse). Used for SST, anomaly, sea ice, wave height, chlorophyll.
 *   - **vector** (`vector = true`): rgba8 with R = u, G = v each encoded as `x/uMax·0.5 + 0.5`,
 *     B = speed/uMax, A = mask. Decode: `u = (R−0.5)·2·uMax`. Used for currents and wind, which
 *     the sample advects a particle field through.
 *
 * @category Live
 */

import { Texture } from '../gpu/texture.js';

/** Range + provenance for a loaded {@link GriddedField}. @category Live */
export interface GriddedMeta {
  variable: string;
  source: string;
  date: string;
  width: number;
  height: number;
  /** Scalar: physical value R=0 / R=1 map to. Vector: `min = -uMax`, `max = uMax` (m/s). */
  min: number;
  max: number;
  isLog: boolean;
  vector: boolean;
}

/** A live ERDDAP scalar variable. @category Live */
export interface ScalarSource {
  servers: string[];   // ERDDAP griddap base URLs, tried in order
  datasets: string[];  // dataset ids, tried in order (first that responds wins)
  variable: string;
  hasLevel: boolean;   // true if the grid has a zlev/depth dim to pin to index 0
  source: string;      // attribution string
  min: number;
  max: number;
  isLog?: boolean;
  /** Multiplier applied to the caller's decimation stride, so a feed on a much finer native grid
   *  (e.g. 0.05° Coral Reef Watch vs a 0.5° reference → 10) returns a comparable cell count — and
   *  a comparable payload — instead of tens of MB of JSON per frame. */
  strideScale?: number;
}

/** A live ERDDAP vector (u,v) pair. @category Live */
export interface VectorSource {
  servers: string[];
  datasets: string[];
  uVar: string;
  vVar: string;
  hasLevel: boolean;
  source: string;
  uMax: number;        // m/s full-scale of the ±encoding
}

interface Table { columnNames: string[]; rows: unknown[][]; }

/** Encodes an ERDDAP query, escaping only the brackets (ERDDAP wants `()`, `:` and `,` literal). */
function encodeQuery(q: string): string {
  return q.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
}

async function fetchTable(servers: string[], datasets: string[], query: string, cache: RequestCache): Promise<{ table: Table; dataset: string }> {
  let lastErr = '';
  for (const server of servers) {
    for (const ds of datasets) {
      try {
        const r = await fetch(`${server}/${ds}.json?${encodeQuery(query)}`, { cache });
        if (!r.ok) {
          lastErr = `${ds}: HTTP ${r.status}`;
          continue;
        }
        return { table: (await r.json()).table as Table, dataset: ds };
      } catch (e) {
        lastErr = `${ds}: ${(e as Error).message}`;
      }
    }
  }
  throw new Error(`GriddedField: all sources failed (${lastErr})`);
}

/** Axis geometry of a returned table, resampled onto a FULL-globe equirect grid. */
interface Grid {
  width: number;
  height: number;
  iLat: number;
  iLon: number;
  date: string;
  /** Full-grid destination index (row-major, row 0 = north) for a data row, or −1 if off-grid. */
  index(row: unknown[]): number;
}

function buildGrid(table: Table, flipLat = false): Grid {
  const { columnNames, rows } = table;
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iTime = columnNames.indexOf('time');
  const toDisp = (lon: number): number => (lon >= 180 ? lon - 360 : lon);  // 0..360 → −180..180
  const latSign = flipLat ? -1 : 1;

  const lats = [...new Set(rows.map((r) => r[iLat] as number))].sort((a, b) => a - b);
  const lonsDisp = [...new Set(rows.map((r) => toDisp(r[iLon] as number)))].sort((a, b) => a - b);
  // Grid spacing from the (possibly strided) samples → a full-globe grid the data drops into, so a
  // partial-coverage feed (e.g. WaveWatch's ~±77° band) lands at the right latitudes, poles masked.
  const dLat = lats.length > 1 ? (lats[lats.length - 1] - lats[0]) / (lats.length - 1) : 1;
  const dLon = lonsDisp.length > 1 ? (lonsDisp[lonsDisp.length - 1] - lonsDisp[0]) / (lonsDisp.length - 1) : 1;
  const width = Math.max(2, Math.round(360 / Math.max(dLon, 1e-6)));
  const height = Math.max(2, Math.round(180 / Math.max(dLat, 1e-6)));

  return {
    width,
    height,
    iLat,
    iLon,
    date: rows.length ? String(rows[0][iTime]) : 'unknown',
    index(r: unknown[]): number {
      const lat = latSign * (r[iLat] as number);
      const lon = toDisp(r[iLon] as number);
      const col = ((Math.round(((lon + 180) / 360) * width) % width) + width) % width;
      const row = Math.min(height - 1, Math.max(0, Math.round(((90 - lat) / 180) * (height - 1))));
      return row * width + col;
    },
  };
}

/** Uploads an equirect rgba8 raster to a non-srgb GPU texture. @category Live */
export function rasterToTexture(device: GPUDevice, width: number, height: number, rgba: Uint8Array<ArrayBuffer>, label: string): Texture {
  const tex = device.createTexture({
    label, size: { width, height }, format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, rgba, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
  return new Texture(tex, '2d');
}

/**
 * A loaded gridded field: the GPU value-texture plus decode metadata. Scalar fields also retain
 * their CPU cells (`values` = normalized byte per cell, `mask` = validity) so consumers can do
 * point readouts and cross-frame analysis (time series, min/max, year deltas) without GPU readback.
 * @category Live
 */
export class GriddedField {
  private statsCache: { min: number; max: number; mean: number } | null = null;

  constructor(
    readonly texture: Texture,
    readonly meta: GriddedMeta,
    /** Normalized value byte per cell (row-major, row 0 = north), scalar fields only. */
    readonly values: Uint8Array | null = null,
    /** 1 = valid cell, 0 = land/no-data; parallel to `values`. */
    readonly mask: Uint8Array | null = null,
    /** Physical (u,v) per cell in m/s — vector fields loaded with `retainCells` only. */
    readonly vectorCells: { u: Float32Array; v: Float32Array; mask: Uint8Array } | null = null,
  ) {}

  destroy(): void {
    this.texture.destroy();
  }

  /** Decodes a normalized byte back to the physical value (°C, m, mg/m³, …). */
  decode(byte: number): number {
    const n = byte / 255;
    if (this.meta.isLog) {
      const l0 = Math.log10(this.meta.min);
      return Math.pow(10, l0 + n * (Math.log10(this.meta.max) - l0));
    }
    return this.meta.min + n * (this.meta.max - this.meta.min);
  }

  /** Physical value at a geodetic point via nearest-cell lookup, or null over land/no-data. */
  sample(lonDeg: number, latDeg: number): number | null {
    if (!this.values || !this.mask) {
      return null;
    }
    const { width, height } = this.meta;
    const u = ((((lonDeg + 180) % 360) + 360) % 360) / 360;
    const v = Math.max(0, Math.min(1, (90 - latDeg) / 180));
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const i = y * width + x;
    return this.mask[i] ? this.decode(this.values[i]) : null;
  }

  /** Physical (u,v) m/s at a geodetic point via nearest-cell lookup — vector fields loaded
   *  with `retainCells` only; null over land/no-data or when cells were not retained. */
  sampleVector(lonDeg: number, latDeg: number): { u: number; v: number } | null {
    if (!this.vectorCells) {
      return null;
    }
    const { width, height } = this.meta;
    const u = ((((lonDeg + 180) % 360) + 360) % 360) / 360;
    const v = Math.max(0, Math.min(1, (90 - latDeg) / 180));
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const i = y * width + x;
    return this.vectorCells.mask[i] ? { u: this.vectorCells.u[i], v: this.vectorCells.v[i] } : null;
  }

  /** Global min/mean/max over the valid cells (cached), or null without CPU cells. */
  stats(): { min: number; max: number; mean: number } | null {
    if (!this.values || !this.mask) {
      return null;
    }
    if (!this.statsCache) {
      let lo = 255, hi = 0, sum = 0, n = 0;
      for (let i = 0; i < this.values.length; i++) {
        if (this.mask[i]) {
          const b = this.values[i];
          lo = Math.min(lo, b); hi = Math.max(hi, b); sum += b; n++;
        }
      }
      this.statsCache = n
        ? { min: this.decode(lo), max: this.decode(hi), mean: this.decode(sum / n) }
        : { min: NaN, max: NaN, mean: NaN };
    }
    return this.statsCache;
  }

  /**
   * Builds a field from CPU cells (used for derived analysis views — deltas, min/max, range).
   *
   * `flag` is an optional per-cell 0/1 marker carried in the BLUE channel, which is otherwise a
   * redundant copy of the value (only R and A are ever sampled). The analysis display uses it for
   * "this cell's estimate failed its significance test", so the shader can stipple those cells
   * instead of the host having to blank them. Like the value, it is stored zeroed outside the mask,
   * so a bilinear fetch divided by alpha recovers the coverage-weighted fraction of flagged
   * neighbors rather than bleeding the flag across a no-data edge.
   */
  static fromBytes(device: GPUDevice, values: Uint8Array, mask: Uint8Array, meta: GriddedMeta, flag?: Uint8Array): GriddedField {
    const rgba = new Uint8Array(meta.width * meta.height * 4);
    for (let i = 0; i < values.length; i++) {
      const b = values[i];
      const valid = mask[i] ? 255 : 0;
      rgba[i * 4] = b; rgba[i * 4 + 1] = b;
      rgba[i * 4 + 2] = flag ? (flag[i] && mask[i] ? 255 : 0) : b;
      rgba[i * 4 + 3] = valid;
    }
    const texture = rasterToTexture(device, meta.width, meta.height, rgba, `GriddedDerived:${meta.variable}`);
    return new GriddedField(texture, meta, values, mask);
  }

  /**
   * Streams a scalar variable and normalizes it into [`src.min`,`src.max`] (log10 when `isLog`).
   * `flipLat` negates each row's latitude on placement — for feeds whose aggregation mislabels
   * the latitude axis on some dates (PacIOOS GFS archive), detected by the caller.
   */
  static async loadScalar(device: GPUDevice, src: ScalarSource, opts: { timeSel?: string; stride?: number; flipLat?: boolean } = {}): Promise<GriddedField> {
    const stride = Math.max(1, Math.floor(opts.stride ?? 4));
    const timeSel = opts.timeSel ?? '(last)';
    const lvl = src.hasLevel ? '[0]' : '';
    const q = `${src.variable}[${timeSel}]${lvl}[0:${stride}:last][0:${stride}:last]`;
    const { table } = await fetchTable(src.servers, src.datasets, q, timeSel === '(last)' ? 'default' : 'force-cache');
    const g = buildGrid(table, opts.flipLat ?? false);
    const iVal = table.columnNames.indexOf(src.variable);
    const isLog = src.isLog ?? false;
    const l0 = isLog ? Math.log10(src.min) : 0;
    const span = isLog ? Math.log10(src.max) - l0 : src.max - src.min;
    const rgba = new Uint8Array(g.width * g.height * 4);
    const values = new Uint8Array(g.width * g.height);
    const mask = new Uint8Array(g.width * g.height);
    for (const r of table.rows) {
      const v = r[iVal] as number | null;
      if (v === null || v === undefined || Number.isNaN(v)) {
        continue;
      }
      const n = isLog
        ? (Math.log10(Math.max(v, src.min)) - l0) / span
        : (v - src.min) / span;
      const byte = Math.max(0, Math.min(255, Math.round(n * 255)));
      const idx = g.index(r);
      values[idx] = byte; mask[idx] = 1;
      const o = idx * 4;
      rgba[o] = byte; rgba[o + 1] = byte; rgba[o + 2] = byte; rgba[o + 3] = 255;
    }
    const texture = rasterToTexture(device, g.width, g.height, rgba, `GriddedScalar:${src.variable}`);
    return new GriddedField(texture, {
      variable: src.variable, source: src.source, date: g.date, width: g.width, height: g.height,
      min: src.min, max: src.max, isLog, vector: false,
    }, values, mask);
  }

  /**
   * One DAY of a sub-daily feed, reduced per cell — a daily max/min/mean instead of a snapshot.
   *
   * A fixed-hour snapshot of a diurnal field is not a global map of that field: 12:00 UTC is dawn
   * in New Mexico, midday in Nigeria and night in Japan, and for surface temperature that spread is
   * larger than most of the geography. GFS surface skin temperature swings ~30 °C over a summer day
   * in high desert, so which hour you sampled dominates what the map appears to show.
   *
   * A daily reduction fixes that without needing per-longitude time windows: every longitude passes
   * local noon exactly once per UTC day, so a max over the day's steps captures each cell's own
   * diurnal peak wherever it sits. `mean` is likewise the day's mean everywhere.
   *
   * Costs one request covering all of the day's steps (8 for GFS's 3-hourly grid), so the payload
   * is ~8× a snapshot's — pair it with a coarser `stride` for global views.
   * @category Live
   */
  static async loadScalarDaily(
    device: GPUDevice,
    src: ScalarSource,
    opts: { date: string; reduce: 'max' | 'min' | 'mean'; stride?: number; flipLat?: boolean; lastHour?: string },
  ): Promise<GriddedField> {
    const stride = Math.max(1, Math.floor(opts.stride ?? 4));
    const lvl = src.hasLevel ? '[0]' : '';
    const span = `(${opts.date}T00:00:00Z):1:(${opts.date}T${opts.lastHour ?? '21:00:00'}Z)`;
    const q = `${src.variable}[${span}]${lvl}[0:${stride}:last][0:${stride}:last]`;
    const { table } = await fetchTable(src.servers, src.datasets, q, 'force-cache');
    const g = buildGrid(table, opts.flipLat ?? false);
    const iVal = table.columnNames.indexOf(src.variable);
    const cells = g.width * g.height;
    const acc = new Float64Array(cells);
    const count = new Uint16Array(cells);
    if (opts.reduce === 'max') {
      acc.fill(-Infinity);
    } else if (opts.reduce === 'min') {
      acc.fill(Infinity);
    }
    for (const r of table.rows) {
      const v = r[iVal] as number | null;
      if (v === null || v === undefined || Number.isNaN(v)) {
        continue;
      }
      const idx = g.index(r);
      count[idx]++;
      if (opts.reduce === 'max') {
        acc[idx] = Math.max(acc[idx], v);
      } else if (opts.reduce === 'min') {
        acc[idx] = Math.min(acc[idx], v);
      } else {
        acc[idx] += v;
      }
    }
    const isLog = src.isLog ?? false;
    const l0 = isLog ? Math.log10(src.min) : 0;
    const range = isLog ? Math.log10(src.max) - l0 : src.max - src.min;
    const rgba = new Uint8Array(cells * 4);
    const values = new Uint8Array(cells);
    const mask = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) {
      if (count[i] === 0) {
        continue;
      }
      const v = opts.reduce === 'mean' ? acc[i] / count[i] : acc[i];
      const n = isLog ? (Math.log10(Math.max(v, src.min)) - l0) / range : (v - src.min) / range;
      const byte = Math.max(0, Math.min(255, Math.round(n * 255)));
      values[i] = byte; mask[i] = 1;
      const o = i * 4;
      rgba[o] = byte; rgba[o + 1] = byte; rgba[o + 2] = byte; rgba[o + 3] = 255;
    }
    const texture = rasterToTexture(device, g.width, g.height, rgba, `GriddedDaily:${src.variable}`);
    return new GriddedField(texture, {
      variable: src.variable, source: src.source, date: `${opts.date}T12:00:00Z`,
      width: g.width, height: g.height, min: src.min, max: src.max, isLog, vector: false,
    }, values, mask);
  }

  /** Streams a (u,v) vector pair into an R=u,G=v,B=speed,A=mask texture (encoded by `src.uMax`).
   *  With `retainCells`, the physical (u,v) floats are kept on the CPU for point readouts and
   *  analysis (component extraction) without GPU readback. */
  static async loadVector(device: GPUDevice, src: VectorSource, opts: { timeSel?: string; stride?: number; flipLat?: boolean; retainCells?: boolean } = {}): Promise<GriddedField> {
    const stride = Math.max(1, Math.floor(opts.stride ?? 4));
    const timeSel = opts.timeSel ?? '(last)';
    const lvl = src.hasLevel ? '[0]' : '';
    const sel = `[${timeSel}]${lvl}[0:${stride}:last][0:${stride}:last]`;
    const q = `${src.uVar}${sel},${src.vVar}${sel}`;
    const { table } = await fetchTable(src.servers, src.datasets, q, timeSel === '(last)' ? 'default' : 'force-cache');
    const g = buildGrid(table, opts.flipLat ?? false);
    const iU = table.columnNames.indexOf(src.uVar);
    const iV = table.columnNames.indexOf(src.vVar);
    const rgba = new Uint8Array(g.width * g.height * 4);
    const cells = opts.retainCells
      ? { u: new Float32Array(g.width * g.height), v: new Float32Array(g.width * g.height), mask: new Uint8Array(g.width * g.height) }
      : null;
    const enc = (x: number): number => Math.max(0, Math.min(255, Math.round((x / src.uMax * 0.5 + 0.5) * 255)));
    for (const r of table.rows) {
      const u = r[iU] as number | null;
      const v = r[iV] as number | null;
      if (u === null || v === null || u === undefined || v === undefined || Number.isNaN(u) || Number.isNaN(v)) {
        continue;
      }
      const idx = g.index(r);
      const o = idx * 4;
      rgba[o] = enc(u); rgba[o + 1] = enc(v);
      rgba[o + 2] = Math.min(255, Math.round(Math.hypot(u, v) / src.uMax * 255));
      rgba[o + 3] = 255;
      if (cells) {
        cells.u[idx] = u; cells.v[idx] = v; cells.mask[idx] = 1;
      }
    }
    const texture = rasterToTexture(device, g.width, g.height, rgba, `GriddedVector:${src.uVar}`);
    return new GriddedField(texture, {
      variable: `${src.uVar},${src.vVar}`, source: src.source, date: g.date, width: g.width, height: g.height,
      min: -src.uMax, max: src.uMax, isLog: false, vector: true,
    }, null, null, cells);
  }

  /**
   * Loads a baked snapshot (png + json sidecar produced by a `tools/geo/bake_*.mjs`). The PNG is
   * uploaded with `srgb:false` so its channels decode linearly. Accepts both the general
   * `{min,max,log,vector,uMax}` sidecar and the SST baseline's `{tMinC,tMaxC}`.
   */
  static async loadBaked(device: GPUDevice, pngUrl: string, metaUrl: string): Promise<GriddedField> {
    const [j, blob] = await Promise.all([
      fetch(metaUrl).then((r) => r.json() as Promise<Record<string, unknown>>),
      fetch(pngUrl).then((r) => r.blob()),
    ]);
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const texture = Texture.fromBitmap(device, bitmap, { srgb: false });
    const vector = Boolean(j.vector) || j.uMax !== undefined;
    let values: Uint8Array | null = null;
    let mask: Uint8Array | null = null;
    if (!vector) {
      const cnv = new OffscreenCanvas(bitmap.width, bitmap.height);
      const cx = cnv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      cx.drawImage(bitmap, 0, 0);
      const px = cx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      values = new Uint8Array(bitmap.width * bitmap.height);
      mask = new Uint8Array(bitmap.width * bitmap.height);
      for (let k = 0; k < values.length; k++) {
        values[k] = px[k * 4];
        mask[k] = px[k * 4 + 3] >= 128 ? 1 : 0;
      }
    }
    const bw = bitmap.width, bh = bitmap.height;
    bitmap.close?.();
    const uMax = (j.uMax as number) ?? 1;
    return new GriddedField(texture, {
      variable: (j.variable as string) ?? (j.dataset as string) ?? 'baked',
      source: (j.source as string) ?? '',
      date: (j.date as string) ?? '',
      width: (j.width as number) ?? bw,
      height: (j.height as number) ?? bh,
      min: vector ? -uMax : (j.min as number) ?? (j.tMinC as number) ?? 0,
      max: vector ? uMax : (j.max as number) ?? (j.tMaxC as number) ?? 1,
      isLog: Boolean(j.log),
      vector,
    }, values, mask);
  }

  /**
   * Loads a baked TIME-STACK atlas (vertically-stacked frames, `frames` × `height` rows) produced
   * by `tools/geo/bake_currents.mjs` into one {@link GriddedField} per frame — so the sample can
   * interpolate between dated snapshots. Each frame is copied out of the decoded atlas by source
   * origin; the atlas bitmap is released afterwards.
   *
   * `opts.everyMonths` keeps only frames on an N-month grid aligned to the stack's first frame —
   * a monthly-baked atlas can serve a 4/2/1-month display cadence without paying GPU/CPU for the
   * skipped frames.
   */
  static async loadBakedStack(device: GPUDevice, pngUrl: string, metaUrl: string, opts: { everyMonths?: number; retainCells?: boolean } = {}): Promise<GriddedField[]> {
    const [j, blob] = await Promise.all([
      fetch(metaUrl).then((r) => r.json() as Promise<Record<string, unknown>>),
      fetch(pngUrl).then((r) => r.blob()),
    ]);
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const width = j.width as number;
    const height = j.height as number;
    const frames = j.frames as number;
    const uMax = (j.uMax as number) ?? 1;
    const dates = (j.dates as string[]) ?? [];
    const vector = Boolean(j.vector) || j.uMax !== undefined;
    // Decode the whole atlas once on the CPU so scalar frames carry cells for analysis
    // (vector frames too when the caller wants (u,v) readouts). In slabs of whole frames: a
    // canvas past the browser's size limit (the 1981→ 1° OISST atlas is 97 020 px tall) does not
    // throw, it reads back all zeros, which would silently mark every cell invalid.
    let px: Uint8ClampedArray | null = null;
    if (!vector || opts.retainCells) {
      px = new Uint8ClampedArray(width * height * frames * 4);
      const slabFrames = Math.max(1, Math.floor(16384 / height));
      const cnv = new OffscreenCanvas(width, height * Math.min(slabFrames, frames));
      const cx = cnv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      for (let f0 = 0; f0 < frames; f0 += slabFrames) {
        const rows = height * Math.min(slabFrames, frames - f0);
        cx.clearRect(0, 0, cnv.width, cnv.height);
        cx.drawImage(bitmap, 0, f0 * height, width, rows, 0, 0, width, rows);
        px.set(cx.getImageData(0, 0, width, rows).data, f0 * height * width * 4);
      }
    }
    const every = Math.max(1, Math.floor(opts.everyMonths ?? 1));
    const monthOrd = (date: string): number => parseInt(date.slice(0, 4), 10) * 12 + parseInt(date.slice(5, 7), 10) - 1;
    const ord0 = dates.length ? monthOrd(dates[0]) : 0;
    const out: GriddedField[] = [];
    for (let i = 0; i < frames; i++) {
      if (every > 1 && dates[i] && (monthOrd(dates[i]) - ord0) % every !== 0) {
        continue;
      }
      const tex = device.createTexture({
        label: `GriddedStack:${i}`, size: { width, height }, format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: bitmap, origin: { x: 0, y: i * height }, flipY: false },
        { texture: tex },
        { width, height },
      );
      let values: Uint8Array | null = null;
      let mask: Uint8Array | null = null;
      let cells: { u: Float32Array; v: Float32Array; mask: Uint8Array } | null = null;
      if (px) {
        const base = i * width * height * 4;
        if (vector) {
          cells = { u: new Float32Array(width * height), v: new Float32Array(width * height), mask: new Uint8Array(width * height) };
          for (let k = 0; k < width * height; k++) {
            cells.u[k] = (px[base + k * 4] / 255 - 0.5) * 2 * uMax;
            cells.v[k] = (px[base + k * 4 + 1] / 255 - 0.5) * 2 * uMax;
            cells.mask[k] = px[base + k * 4 + 3] >= 128 ? 1 : 0;
          }
        } else {
          values = new Uint8Array(width * height);
          mask = new Uint8Array(width * height);
          for (let k = 0; k < width * height; k++) {
            values[k] = px[base + k * 4];
            mask[k] = px[base + k * 4 + 3] >= 128 ? 1 : 0;
          }
        }
      }
      out.push(new GriddedField(new Texture(tex, '2d'), {
        variable: (j.variable as string) ?? 'stack', source: (j.source as string) ?? '',
        date: dates[i] ?? '', width, height,
        min: vector ? -uMax : (j.min as number) ?? 0,
        max: vector ? uMax : (j.max as number) ?? 1,
        isLog: Boolean(j.log), vector,
      }, values, mask, cells));
    }
    bitmap.close?.();
    return out;
  }
}
