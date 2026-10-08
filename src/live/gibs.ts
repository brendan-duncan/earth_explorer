/**
 * NASA GIBS (Global Imagery Browse Services) — daily satellite imagery as an equirect texture.
 *
 * GIBS serves pre-rendered EPSG:4326 WMTS tiles (CORS `*`, keyless), so a full-globe equirect
 * raster is just a grid of tile fetches drawn side by side — no reprojection. GOTCHA: the 4326
 * TileMatrixSets are NOT a power-of-two pyramid. Level 0 is 0.5625°/px (a 512 px tile spans
 * 288°), so the tile grid covers 576°×288° and the world occupies only its top-left corner;
 * right/bottom edge tiles are partial. Level L: the world is 640·2^L × 320·2^L px, fetched as
 * ceil-many tiles and CROPPED to exactly 360°×180° (level 2 → 2560×1280 from 15 tiles).
 *
 * This is IMAGERY (RGB as rendered by NASA), not a value field: the returned
 * {@link GriddedField} carries no CPU cells, so point readouts and analysis views don't apply.
 * The daily archive reaches back to 2012 (VIIRS) / 2000 (MODIS) — a real-cloud time-lapse.
 *
 * @category Live
 */

import { GriddedField, rasterToTexture } from './gridded_field.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';

/** The daily true-color layer (SNPP VIIRS corrected reflectance), available 2012→now. @category Live */
export const GIBS_TRUE_COLOR = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
/** First day of {@link GIBS_TRUE_COLOR} coverage. @category Live */
export const GIBS_TRUE_COLOR_START = '2012-01-19';

/**
 * Assembles one GIBS layer for one day into an equirect RGB texture. Tiles that fail to fetch
 * leave alpha-0 holes (rendered as basemap fallback); throws only if EVERY tile failed.
 * @category Live
 */
export async function loadGibsDay(
  device: GPUDevice,
  dateISO: string,
  opts: { layer?: string; level?: number } = {},
): Promise<GriddedField> {
  const layer = opts.layer ?? GIBS_TRUE_COLOR;
  const level = opts.level ?? 2;
  const W = 640 << level;    // world extent in pixels at 0.5625/2^level °/px
  const H = 320 << level;
  const cols = Math.ceil(W / 512);
  const rows = Math.ceil(H / 512);
  const cnv = new OffscreenCanvas(cols * 512, rows * 512);
  const cx = cnv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  let ok = 0;
  await Promise.all(Array.from({ length: cols * rows }, async (_, i) => {
    const col = i % cols, row = (i / cols) | 0;
    try {
      const r = await fetch(`${GIBS}/${layer}/default/${dateISO}/250m/${level}/${row}/${col}.jpg`);
      if (!r.ok) {
        return;
      }
      const bmp = await createImageBitmap(await r.blob());
      cx.drawImage(bmp, col * 512, row * 512);
      bmp.close?.();
      ok++;
    } catch { /* leave the hole transparent */ }
  }));
  if (ok === 0) {
    throw new Error(`GIBS: no tiles for ${layer} @ ${dateISO}`);
  }
  const px = cx.getImageData(0, 0, W, H).data;   // crop to the 360°×180° world region
  const rgba = new Uint8Array(px.buffer.slice(0)) as Uint8Array<ArrayBuffer>;
  const texture = rasterToTexture(device, W, H, rgba, `Gibs:${layer}`);
  return new GriddedField(texture, {
    variable: layer, source: 'NASA GIBS (Worldview imagery)', date: dateISO,
    width: W, height: H, min: 0, max: 1, isLog: false, vector: false,
  });
}
