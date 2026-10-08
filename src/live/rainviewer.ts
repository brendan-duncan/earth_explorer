/**
 * RainViewer global radar composite as an equirect overlay texture.
 *
 * `api.rainviewer.com` (CORS `*`, keyless) publishes a rolling ~2-hour window of global
 * weather-radar composites as Web-Mercator PNG tiles. {@link loadRadarOverlay} fetches the most
 * recent frame at a low zoom, then reprojects Mercator → equirect on the CPU into an RGBA
 * texture whose alpha is the radar echo's own transparency — ready to alpha-blend over any base
 * layer. Coverage is land-radar-network only (oceans are empty), and |lat| > 85° has no tiles.
 *
 * @category Live
 */

import { Texture } from '../gpu/texture.js';
import { rasterToTexture } from './gridded_field.js';

const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

interface RadarFrame { time: number; path: string; }
interface WeatherMaps { host: string; radar: { past: RadarFrame[]; nowcast: RadarFrame[] }; }

/** A loaded radar overlay: the equirect texture + the composite's unix time. @category Live */
export interface RadarOverlay {
  texture: Texture;
  /** Unix seconds of the radar composite. */
  time: number;
}

/**
 * Loads the latest radar composite (zoom-2 Mercator mosaic = 1024², reprojected to 2048×1024
 * equirect). `colorScheme` follows RainViewer's numbering (2 = "universal blue").
 * @category Live
 */
export async function loadRadarOverlay(
  device: GPUDevice,
  opts: { colorScheme?: number; width?: number; height?: number } = {},
): Promise<RadarOverlay> {
  const maps = await (await fetch(RAINVIEWER_API)).json() as WeatherMaps;
  const frame = maps.radar.past[maps.radar.past.length - 1];
  const Z = 2, TILES = 1 << Z, TILE = 256;
  const mercSize = TILES * TILE;   // 1024²
  const cnv = new OffscreenCanvas(mercSize, mercSize);
  const cx = cnv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  const scheme = opts.colorScheme ?? 2;
  let ok = 0;
  await Promise.all(Array.from({ length: TILES * TILES }, async (_, i) => {
    const x = i % TILES, y = (i / TILES) | 0;
    try {
      const r = await fetch(`${maps.host}${frame.path}/${TILE}/${Z}/${x}/${y}/${scheme}/1_1.png`);
      if (!r.ok) {
        return;
      }
      const bmp = await createImageBitmap(await r.blob());
      cx.drawImage(bmp, x * TILE, y * TILE);
      bmp.close?.();
      ok++;
    } catch { /* leave the tile empty */ }
  }));
  if (ok === 0) {
    throw new Error('RainViewer: no radar tiles');
  }
  const merc = cx.getImageData(0, 0, mercSize, mercSize).data;

  const W = opts.width ?? 2048;
  const H = opts.height ?? 1024;
  const out = new Uint8Array(W * H * 4);
  for (let yPix = 0; yPix < H; yPix++) {
    const lat = 90 - ((yPix + 0.5) / H) * 180;
    if (Math.abs(lat) > 85) {
      continue;   // beyond Mercator's pole cut — stays transparent
    }
    const phi = (lat * Math.PI) / 180;
    const mercY = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2 * mercSize;
    const sy = Math.max(0, Math.min(mercSize - 1, Math.round(mercY - 0.5)));
    for (let xPix = 0; xPix < W; xPix++) {
      const sx = Math.min(mercSize - 1, Math.floor((xPix / W) * mercSize));
      const src = (sy * mercSize + sx) * 4;
      const dst = (yPix * W + xPix) * 4;
      out[dst] = merc[src];
      out[dst + 1] = merc[src + 1];
      out[dst + 2] = merc[src + 2];
      out[dst + 3] = merc[src + 3];
    }
  }
  return { texture: rasterToTexture(device, W, H, out as Uint8Array<ArrayBuffer>, 'RadarOverlay'), time: frame.time };
}
