/**
 * Geostationary full-disk satellite imagery (GOES GeoColor) reprojected to equirect.
 *
 * NOAA STAR's CDN (`cdn.star.nesdis.noaa.gov`, CORS `*`, keyless) serves the latest ABI
 * full-disk GeoColor JPEG for each GOES satellite every ~10 minutes. Each disk is the standard
 * ABI fixed grid: an orthographic-like "geos" projection spanning scan angles ±0.151844 rad,
 * inscribed in the image square. {@link loadGeoComposite} inverse-projects every equirect pixel
 * into whichever disk sees it best and bilinearly samples the JPEG — CPU-side, ~2M pixels, one-off.
 *
 * GOES-East (75.2°W) + GOES-West (137.0°W) together cover roughly 155°E eastward to 15°E; the
 * remaining Asia/Indian-Ocean gap stays alpha-0 (the shader falls back to a dim basemap there).
 *
 * @category Live
 */

import { GriddedField, rasterToTexture } from './gridded_field.js';

/** One geostationary imagery source. @category Live */
export interface GeoSatSource {
  name: string;
  url: string;
  /** Sub-satellite longitude, degrees east. */
  subLon: number;
}

/** @category Live */
export const GOES_EAST: GeoSatSource = {
  name: 'GOES-East', subLon: -75.2,
  url: 'https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/1808x1808.jpg',
};
/** @category Live */
export const GOES_WEST: GeoSatSource = {
  name: 'GOES-West', subLon: -137.0,
  url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg',
};

// ABI fixed-grid constants (GOES-R PUG): GRS80 ellipsoid, orbit radius from Earth center.
const R_EQ = 6378.137;          // km
const R_POL = 6356.7523;        // km
const H_ORBIT = 42164.16;       // km, satellite distance from Earth center
const E2 = 1 - (R_POL * R_POL) / (R_EQ * R_EQ);   // first eccentricity²
/** Full-disk image half-extent in scan-angle radians (image edge = ±this). */
export const FD_EXTENT = 0.151844;

/**
 * Inverse "geos" projection: geodetic lon/lat (deg) → fixed-grid scan angles (rad) for a
 * satellite at `subLon`, or null when the point is beyond the limb (not visible).
 * @category Live
 */
export function geosProject(lonDeg: number, latDeg: number, subLon: number): { x: number; y: number } | null {
  const lat = (latDeg * Math.PI) / 180;
  const dLon = (((lonDeg - subLon + 540) % 360) - 180) * (Math.PI / 180);
  const latC = Math.atan(((R_POL * R_POL) / (R_EQ * R_EQ)) * Math.tan(lat));   // geocentric latitude
  const rc = R_POL / Math.sqrt(1 - E2 * Math.cos(latC) * Math.cos(latC));      // geocentric radius
  const sx = H_ORBIT - rc * Math.cos(latC) * Math.cos(dLon);
  const sy = -rc * Math.cos(latC) * Math.sin(dLon);
  const sz = rc * Math.sin(latC);
  // Visibility: the line of sight must not pass through the ellipsoid before the point.
  if (H_ORBIT * (H_ORBIT - sx) < sy * sy + ((R_EQ * R_EQ) / (R_POL * R_POL)) * sz * sz) {
    return null;
  }
  return {
    x: Math.asin(-sy / Math.hypot(sx, sy, sz)),
    y: Math.atan2(sz, sx),
  };
}

/**
 * Fetches the given full-disk images and composites them into one equirect RGBA raster
 * (alpha 255 where covered). Satellites are tried nearest-sub-longitude first per pixel; disks
 * that fail to fetch are skipped, and the whole load throws only if none arrive.
 * @category Live
 */
export async function loadGeoComposite(
  device: GPUDevice,
  opts: { sats?: GeoSatSource[]; width?: number; height?: number } = {},
): Promise<GriddedField> {
  const sats = opts.sats ?? [GOES_EAST, GOES_WEST];
  const W = opts.width ?? 2048;
  const H = opts.height ?? 1024;

  const disks = (await Promise.all(sats.map(async (sat) => {
    try {
      const r = await fetch(sat.url);
      if (!r.ok) {
        return null;
      }
      const bmp = await createImageBitmap(await r.blob());
      const size = bmp.width;   // capture before close() zeroes it
      const cnv = new OffscreenCanvas(size, bmp.height);
      const cx = cnv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      cx.drawImage(bmp, 0, 0);
      const img = cx.getImageData(0, 0, size, bmp.height);
      bmp.close?.();
      return { sat, px: img.data, size };
    } catch {
      return null;
    }
  }))).filter((d): d is NonNullable<typeof d> => d !== null);
  if (disks.length === 0) {
    throw new Error('geostationary: no full-disk images reachable');
  }

  const out = new Uint8Array(W * H * 4);
  // Trim the smeared limb: only accept samples within 97% of the disk's angular radius.
  const rMax = FD_EXTENT * 0.97;
  const lonDelta = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
  // Nearest satellite first — it sees a longitude at the steepest (sharpest) angle. The order
  // depends only on longitude, so compute it once per column, not per pixel.
  const orderByX = Array.from({ length: W }, (_, xPix) => {
    const lon = ((xPix + 0.5) / W) * 360 - 180;
    return [...disks].sort((a, b) => lonDelta(lon, a.sat.subLon) - lonDelta(lon, b.sat.subLon));
  });
  for (let yPix = 0; yPix < H; yPix++) {
    const lat = 90 - ((yPix + 0.5) / H) * 180;
    for (let xPix = 0; xPix < W; xPix++) {
      const lon = ((xPix + 0.5) / W) * 360 - 180;
      for (const d of orderByX[xPix]) {
        const p = geosProject(lon, lat, d.sat.subLon);
        if (!p || Math.hypot(p.x, p.y) > rMax) {
          continue;
        }
        const size = d.size;
        const fx = (0.5 + p.x / (2 * FD_EXTENT)) * size - 0.5;
        const fy = (0.5 - p.y / (2 * FD_EXTENT)) * size - 0.5;
        const x0 = Math.max(0, Math.min(size - 2, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(size - 2, Math.floor(fy)));
        const tx = Math.max(0, Math.min(1, fx - x0));
        const ty = Math.max(0, Math.min(1, fy - y0));
        const o = (yPix * W + xPix) * 4;
        for (let c = 0; c < 3; c++) {
          const v00 = d.px[(y0 * size + x0) * 4 + c];
          const v10 = d.px[(y0 * size + x0 + 1) * 4 + c];
          const v01 = d.px[((y0 + 1) * size + x0) * 4 + c];
          const v11 = d.px[((y0 + 1) * size + x0 + 1) * 4 + c];
          out[o + c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        }
        out[o + 3] = 255;
        break;
      }
    }
  }
  const texture = rasterToTexture(device, W, H, out as Uint8Array<ArrayBuffer>, 'GeoComposite');
  return new GriddedField(texture, {
    variable: 'geocolor', source: `NOAA GOES GeoColor (${disks.map((d) => d.sat.name).join(' + ')})`,
    date: new Date().toISOString(), width: W, height: H, min: 0, max: 1, isLog: false, vector: false,
  });
}
