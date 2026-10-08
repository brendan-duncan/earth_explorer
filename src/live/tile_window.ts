/**
 * Streaming detail window for equirect map renderers — slippy-map-style zoom detail.
 *
 * A renderer that composites everything through one full-globe equirect texture (the GIS
 * explorer's `mapColor(uv)`) can only ever be as sharp as that texture. This module streams a
 * higher-resolution CROP — a "detail window" — covering just the currently visible lon/lat
 * rectangle, assembled from public tile pyramids, so the terrain sharpens as the user zooms:
 *
 *  - moderate zoom → NASA GIBS `BlueMarble_ShadedRelief_Bathymetry` (EPSG:4326 WMTS, ~500 m/px
 *    max). 4326 tiles ARE equirect, so they paste straight into the window with `drawImage`.
 *  - deep zoom → Esri World Imagery (Web Mercator XYZ, to z19 ≈ sub-meter). Mercator tiles are
 *    first mosaicked in their own space, then reprojected into the equirect window row by row
 *    (x is shared between the projections; only y needs the Mercator→latitude remap).
 *
 * Both sources are keyless and CORS-open (the explorer's rule for live feeds). The window is
 * COLOR ONLY — the caller keeps masks/data logic on its global textures — and tiles that fail
 * to fetch leave alpha-0 holes that the caller's shader treats as "fall back to the basemap".
 *
 * @category Live
 */

import { ESRI_WORLD_IMAGERY, type ImageryProvider } from '../geo/imagery.js';

/** A lon/lat window as equirect uv (u = lon/360°+0.5, v = 0.5−lat/180°; v0 is the NORTH edge).
 *  `u0`/`u1` may run outside [0,1] when the view straddles the ±180° seam (u1 > u0 always).
 *  @category Live */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** @category Live */
export type DetailSourceKind = 'gibs' | 'esri';

/** The pyramid + level chosen for a window request. @category Live */
export interface DetailPick {
  kind: DetailSourceKind;
  /** GIBS TileMatrix level, or Web Mercator z. */
  level: number;
  /** Equirect world width in pixels at this level (GIBS: 640·2^L; Esri: 256·2^z). */
  worldW: number;
}

/** GIBS 4326 level-0 world width in px (0.5625°/px — NOT a power-of-two pyramid). */
const GIBS_L0_WORLD_W = 640;
const GIBS_TILE = 512;
/** The `500m` TileMatrixSet tops out at level 7 (~488 m/px). */
const GIBS_MAX_LEVEL = 7;
const ESRI_TILE = 256;
/** Web Mercator's latitude cap (±85.051°). */
const MAX_MERC_LAT_DEG = (2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2) * (180 / Math.PI);
/** Widest window raster we'll assemble (≈ a padded screen at 1:1). */
const MAX_DEST_W = 3200;
const MAX_DEST_H = 2304;

/** Normalized Web Mercator y in [0,1] (0 at +85.051°, 1 at −85.051°). @category Live */
export function mercYNorm(latDeg: number): number {
  const lat = (Math.max(-MAX_MERC_LAT_DEG, Math.min(MAX_MERC_LAT_DEG, latDeg)) * Math.PI) / 180;
  const s = Math.sin(lat);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Equirect v → latitude in degrees. */
const latOfV = (v: number): number => (0.5 - v) * 180;

/** Approximate tile-fetch count for a GIBS assembly of `rect` at `level`. @category Live */
export function gibsTileCount(rect: UvRect, level: number): number {
  const worldW = GIBS_L0_WORLD_W << level;
  const cols = Math.ceil((Math.min(1, rect.u1 - rect.u0) * worldW) / GIBS_TILE) + 1;
  const rows = Math.ceil(((rect.v1 - rect.v0) * worldW * 0.5) / GIBS_TILE) + 1;
  return cols * rows;
}

/** Approximate tile-fetch count for an Esri assembly of `rect` at Mercator `z`. @category Live */
export function esriTileCount(rect: UvRect, z: number): number {
  const n = 1 << z;
  const cols = Math.ceil(Math.min(1, rect.u1 - rect.u0) * n) + 1;
  const y0 = mercYNorm(latOfV(rect.v0));
  const y1 = mercYNorm(latOfV(rect.v1));
  const rows = Math.ceil((y1 - y0) * n) + 1;
  return cols * Math.max(1, rows);
}

/**
 * Picks the source pyramid + level whose resolution matches the screen: the window must supply
 * at least one texel per screen pixel across the visible rect. GIBS (whole-globe coverage,
 * pole to pole) serves until its ~500 m ceiling; beyond that Esri World Imagery takes over.
 * Levels back off under a tile budget and a maximum raster size (a near-pole equirect window
 * spans every longitude, which would otherwise explode the fetch count).
 * @category Live
 */
export function chooseDetailSource(
  rect: UvRect,
  screenW: number,
  screenH: number,
  o: { maxTiles?: number; esriMaxZoom?: number } = {},
): DetailPick | null {
  const du = Math.min(1, rect.u1 - rect.u0);
  const dv = rect.v1 - rect.v0;
  if (!(du > 0) || !(dv > 0) || !(screenW > 0)) {
    return null;
  }
  const maxTiles = o.maxTiles ?? 110;
  // World width needed so the window matches screen resolution (world is 2:1, so the
  // v-span needs 2·screenH/dv of world width).
  const needW = Math.max(screenW / du, (2 * screenH) / dv);
  const fits = (worldW: number): boolean =>
    du * worldW <= MAX_DEST_W && dv * worldW * 0.5 <= MAX_DEST_H;
  // A window coarser than a typical baked global basemap (4096 px world) would BLUR the
  // display instead of sharpening it — happens when the budget backoff bottoms out on a
  // near-pole view spanning every longitude. Better no window at all.
  const MIN_USEFUL_WORLD_W = 5120;
  if (needW <= GIBS_L0_WORLD_W << GIBS_MAX_LEVEL) {
    let level = Math.max(0, Math.ceil(Math.log2(needW / GIBS_L0_WORLD_W)));
    while (level > 0 && (gibsTileCount(rect, level) > maxTiles || !fits(GIBS_L0_WORLD_W << level))) {
      level--;
    }
    const worldW = GIBS_L0_WORLD_W << level;
    return worldW >= MIN_USEFUL_WORLD_W ? { kind: 'gibs', level, worldW } : null;
  }
  let z = Math.min(o.esriMaxZoom ?? ESRI_WORLD_IMAGERY.maxZoom, Math.ceil(Math.log2(needW / ESRI_TILE)));
  while (z > 2 && (esriTileCount(rect, z) > maxTiles || !fits(ESRI_TILE << z))) {
    z--;
  }
  const worldW = ESRI_TILE << z;
  return worldW >= MIN_USEFUL_WORLD_W ? { kind: 'esri', level: z, worldW } : null;
}

/** @category Live */
export interface DetailWindow {
  view: GPUTextureView;
  rect: UvRect;
  kind: DetailSourceKind;
  attribution: string;
}

/** @category Live */
export interface TileWindowOpts {
  /** GIBS static layer for the moderate-zoom band. */
  gibsLayer?: string;
  /** Deep-zoom Web Mercator provider. */
  provider?: ImageryProvider;
  /** Tile budget per assembly. Default 110. */
  maxTiles?: number;
  /** LRU decoded-tile cache size. Default 96. */
  cacheTiles?: number;
  /** Fired whenever `window` changes (new detail ready, or cleared). */
  onUpdate?: () => void;
}

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const GIBS_ATTR = 'Blue Marble © NASA Earth Observatory / GIBS';

/**
 * Streams the detail window: `request()` (fire-and-forget, caller debounces) resolves the best
 * source/level for the rect, fetches the covering tiles through an LRU bitmap cache, assembles
 * them into an equirect crop, and swaps it in as `window`. A newer request abandons older
 * in-flight assemblies (generation guard); the previous window stays up until its replacement
 * is ready, so zooming never flashes back to the blurry basemap.
 * @category Live
 */
export class TileWindowStreamer {
  window: DetailWindow | null = null;

  private readonly device: GPUDevice;
  private readonly gibsLayer: string;
  private readonly provider: ImageryProvider;
  private readonly maxTiles: number;
  private readonly cacheTiles: number;
  private readonly onUpdate: (() => void) | undefined;
  private readonly cache = new Map<string, Promise<ImageBitmap | null>>();
  private texture: GPUTexture | null = null;
  private gen = 0;
  private currentKey = '';
  /** '' until probed; then the working GIBS static-layer URL prefix. null = GIBS unavailable. */
  private gibsPrefix: string | null | '' = '';

  constructor(device: GPUDevice, opts: TileWindowOpts = {}) {
    this.device = device;
    this.gibsLayer = opts.gibsLayer ?? 'BlueMarble_ShadedRelief_Bathymetry';
    this.provider = opts.provider ?? ESRI_WORLD_IMAGERY;
    this.maxTiles = opts.maxTiles ?? 110;
    this.cacheTiles = opts.cacheTiles ?? 96;
    this.onUpdate = opts.onUpdate;
  }

  /** Drops the current window (view zoomed back out / switched to the globe). */
  clear(): void {
    this.gen++;
    this.currentKey = '';
    if (this.window) {
      this.window = null;
      this.texture?.destroy();
      this.texture = null;
      this.onUpdate?.();
    }
  }

  destroy(): void {
    this.clear();
    for (const p of this.cache.values()) {
      void p.then((b) => b?.close());
    }
    this.cache.clear();
  }

  /** Kicks an assembly for the visible rect (idempotent for an unchanged view). */
  request(rect: UvRect, screenW: number, screenH: number): void {
    const pick = chooseDetailSource(rect, screenW, screenH, { maxTiles: this.maxTiles });
    if (!pick) {
      return;
    }
    // Snap the rect to whole world pixels at the chosen level so an identical settled view
    // (same tiles, same crop) is a no-op instead of a re-assembly.
    const w = pick.worldW;
    const px0 = Math.floor(rect.u0 * w);
    const px1 = Math.ceil(rect.u1 * w);
    const py0 = Math.max(0, Math.floor((rect.v0 * w) / 2));
    const py1 = Math.min(w / 2, Math.ceil((rect.v1 * w) / 2));
    const key = `${pick.kind}|${pick.level}|${px0}|${px1}|${py0}|${py1}`;
    if (key === this.currentKey) {
      return;
    }
    this.currentKey = key;
    const gen = ++this.gen;
    void this.assemble(pick, { px0, px1, py0, py1 }, gen).catch(() => {
      if (gen === this.gen) {
        this.currentKey = '';   // failed — allow the next settle to retry
      }
    });
  }

  private async assemble(
    pick: DetailPick,
    px: { px0: number; px1: number; py0: number; py1: number },
    gen: number,
  ): Promise<void> {
    const destW = px.px1 - px.px0;
    const destH = px.py1 - px.py0;
    if (destW <= 0 || destH <= 0) {
      return;
    }
    const cnv = new OffscreenCanvas(destW, destH);
    const cx = cnv.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const ok = pick.kind === 'gibs'
      ? await this.drawGibs(cx, pick.level, px, gen)
      : await this.drawEsri(cx, pick.level, px, gen);
    if (gen !== this.gen || !ok) {
      return;
    }
    const texture = this.device.createTexture({
      label: `DetailWindow:${pick.kind}${pick.level}`,
      size: [destW, destH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: cnv }, { texture }, [destW, destH]);
    const old = this.texture;
    this.texture = texture;
    this.window = {
      view: texture.createView(),
      rect: { u0: px.px0 / pick.worldW, u1: px.px1 / pick.worldW, v0: (px.py0 * 2) / pick.worldW, v1: (px.py1 * 2) / pick.worldW },
      kind: pick.kind,
      attribution: pick.kind === 'gibs' ? GIBS_ATTR : `Imagery © ${this.provider.attribution.replace(/^Imagery © /, '')}`,
    };
    old?.destroy();
    this.onUpdate?.();
  }

  /** GIBS 4326 tiles are equirect already — draw each straight into the window. */
  private async drawGibs(
    cx: OffscreenCanvasRenderingContext2D,
    level: number,
    px: { px0: number; px1: number; py0: number; py1: number },
    gen: number,
  ): Promise<boolean> {
    const prefix = await this.ensureGibsPrefix();
    if (prefix === null || gen !== this.gen) {
      return false;
    }
    const worldW = GIBS_L0_WORLD_W << level;
    const rowsWorld = Math.ceil(worldW / 2 / GIBS_TILE);
    const c0 = Math.floor(px.px0 / GIBS_TILE);
    const c1 = Math.floor((px.px1 - 1) / GIBS_TILE);
    const r0 = Math.max(0, Math.floor(px.py0 / GIBS_TILE));
    const r1 = Math.min(rowsWorld - 1, Math.floor((px.py1 - 1) / GIBS_TILE));
    let ok = 0;
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        // Longitude wrap: worldW is a multiple of the tile size for L ≥ 2, so a wrapped
        // column lands exactly on another column of the same grid.
        const cw = level >= 2 ? ((c * GIBS_TILE) % worldW + worldW) % worldW / GIBS_TILE : c;
        if (cw < 0 || cw * GIBS_TILE >= worldW) {
          continue;
        }
        jobs.push(this.tile(`${prefix}/${level}/${r}/${cw}.jpeg`).then((bmp) => {
          if (bmp && gen === this.gen) {
            cx.drawImage(bmp, c * GIBS_TILE - px.px0, r * GIBS_TILE - px.py0);
            ok++;
          }
        }));
      }
    }
    await Promise.all(jobs);
    return ok > 0;
  }

  /** Esri Web Mercator: mosaic the tiles in Mercator space, then remap row-by-row into the
   *  equirect window (x is shared between the projections; only y needs the latitude remap). */
  private async drawEsri(
    cx: OffscreenCanvasRenderingContext2D,
    z: number,
    px: { px0: number; px1: number; py0: number; py1: number },
    gen: number,
  ): Promise<boolean> {
    const n = 1 << z;
    const worldW = ESRI_TILE << z;
    const destW = px.px1 - px.px0;
    const destH = px.py1 - px.py0;
    // Mercator-y pixel range covering the window's latitude span.
    const yn0 = mercYNorm(latOfV((px.py0 * 2) / worldW));
    const yn1 = mercYNorm(latOfV((px.py1 * 2) / worldW));
    const my0 = Math.max(0, Math.floor(yn0 * worldW));
    const my1 = Math.min(worldW, Math.ceil(yn1 * worldW));
    if (my1 <= my0) {
      return false;   // window entirely poleward of Mercator's cap
    }
    const mosaic = new OffscreenCanvas(destW, my1 - my0);
    const mcx = mosaic.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const c0 = Math.floor(px.px0 / ESRI_TILE);
    const c1 = Math.floor((px.px1 - 1) / ESRI_TILE);
    const r0 = Math.floor(my0 / ESRI_TILE);
    const r1 = Math.floor((my1 - 1) / ESRI_TILE);
    let ok = 0;
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const tile = { z, x: ((c % n) + n) % n, y: r };
        jobs.push(this.tile(this.provider.url(tile)).then((bmp) => {
          if (bmp && gen === this.gen) {
            mcx.drawImage(bmp, c * ESRI_TILE - px.px0, r * ESRI_TILE - my0);
            ok++;
          }
        }));
      }
    }
    await Promise.all(jobs);
    if (ok === 0 || gen !== this.gen) {
      return false;
    }
    // Remap: each destination (equirect) row samples the mosaic at its latitude's Mercator y.
    for (let y = 0; y < destH; y++) {
      const lat = latOfV(((px.py0 + y + 0.5) * 2) / worldW);
      if (Math.abs(lat) >= MAX_MERC_LAT_DEG) {
        continue;   // leave the row transparent → basemap fallback
      }
      const sy = mercYNorm(lat) * worldW - my0;
      cx.drawImage(mosaic, 0, sy - 0.5, destW, 1, 0, y, destW, 1);
    }
    return true;
  }

  /** Static GIBS layers serve as `{layer}/default/{TMS}/…`; some deployments want an explicit
   *  `default` time segment. Probe once with tile 0/0/0 and remember which form works. */
  private async ensureGibsPrefix(): Promise<string | null> {
    if (this.gibsPrefix !== '') {
      return this.gibsPrefix;
    }
    for (const prefix of [
      `${GIBS_BASE}/${this.gibsLayer}/default/500m`,
      `${GIBS_BASE}/${this.gibsLayer}/default/default/500m`,
    ]) {
      try {
        const r = await fetch(`${prefix}/0/0/0.jpeg`);
        if (r.ok) {
          this.gibsPrefix = prefix;
          return prefix;
        }
      } catch { /* try the next form */ }
    }
    this.gibsPrefix = null;
    return null;
  }

  /** Fetch + decode one tile through the LRU cache; failures cache as null (a hole). */
  private tile(url: string): Promise<ImageBitmap | null> {
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url);
      this.cache.set(url, hit);   // refresh recency
      return hit;
    }
    const p = (async (): Promise<ImageBitmap | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          return null;
        }
        return await createImageBitmap(await r.blob());
      } catch {
        return null;
      }
    })();
    this.cache.set(url, p);
    if (this.cache.size > this.cacheTiles) {
      const oldest = this.cache.keys().next().value as string;
      void this.cache.get(oldest)?.then((b) => b?.close());
      this.cache.delete(oldest);
    }
    return p;
  }
}
