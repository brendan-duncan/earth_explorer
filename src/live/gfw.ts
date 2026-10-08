/**
 * Apparent fishing effort from **Global Fishing Watch** — where the world's industrial fishing fleet
 * spends its time, inferred from AIS vessel tracks by GFW's neural-network classifiers.
 *
 * GFW is the one source here that needs a credential. Its 4wings endpoints serve Mapbox Vector Tiles
 * whose features are grid cells carrying hours-fished keyed by the time interval, which this decodes
 * with the repo's own {@link decodeMvt} and rasterizes into an ordinary {@link GriddedField} — so
 * fishing effort composites, overlays, exports and analyses exactly like a physical layer.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * ABOUT THE TOKEN. {@link GFW_TOKEN} below is compiled into the JavaScript bundle, which means it is
 * readable by anyone who loads the page — it is NOT a secret, and should not be treated as one:
 *
 *  - GFW tokens are long-lived (ten years) and bound to a user account, so a leak is not self-healing;
 *  - rate limits are charged to the token, so every visitor spends the owner's quota;
 *  - rotating it means editing this file and redeploying.
 *
 * That is an accepted trade for a demo that has to run with no backend. Anything with real users
 * should keep the token server-side behind a thin proxy (browser → your endpoint → GFW with the
 * Bearer header) — GFW's own clients are server-side (Python, R) for exactly this reason.
 *
 * `localStorage.earth_explorer_gfw_token` overrides the constant, so a different token can be used without
 * touching the source or rebuilding.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * @category Live
 */

import { decodeMvt } from '../geo/mvt.js';
import { GriddedField, rasterToTexture, type GriddedMeta } from './gridded_field.js';

/**
 * Global Fishing Watch API token. Public by construction — see the file header. Replace it, or set
 * `localStorage.earth_explorer_gfw_token`, to use a different account's quota.
 */
export const GFW_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImtpZEtleSJ9.eyJkYXRhIjp7Im5hbWUiOiJnZW9fZ2lzX2V4cGxvcmVyIiwidXNlcklkIjo2NzAxOCwiYXBwbGljYXRpb25OYW1lIjoiZ2VvX2dpc19leHBsb3JlciIsImlkIjoxMjcyOSwidHlwZSI6InVzZXItYXBwbGljYXRpb24ifSwiaWF0IjoxNzg1MTA5NDg5LCJleHAiOjIxMDA0Njk0ODksImF1ZCI6ImdmdyIsImlzcyI6ImdmdyJ9.XGcSGzeHsMtvhs1_uWPpclMfIgFurYrcnHO-hphJrK2sWPukh6CpntVCOtl5u7oUAD4GfUvrxPQzJo6wiOP_7PlHYAOKOrPg-Ud1I6wbYcarIxF4CAc4n7F_-cS0plI1eH1IMRjigwVg1MBwJBcrtvFKWyh2g9IS1Yv_STPQik9OZMUgkuzxp-HlgFi3wYJ9oNcuVOtPvO-TjBJNXTpQFPdo-HER_Zc2BRFKxwZxjYHu6_EWentCOgkWUISJqzx4BHYvTpFXZizBCzYWBNaSWk9SRIgeLtK6JDGo2YMVtJQXAttDg1xehfOwKILmjFsWKBCBgG01km5FYMM2pgjgJt00G3DvSJx1hDnnQT4mo5G8CfZ0zitF5wYOSwBtmhutlX0pRwjzHQcEYgxPtlHlTVOn0MWqGWZOfjMlEqVf2mby58CMRYtskIOmNFwope7ug79RyGlc82n_QyKDkmc6n8HRH34We8DExrtC7jii4govKl7m44fQKWS6WK5-O8vo';

const GFW_API = 'https://gateway.api.globalfishingwatch.org/v3';

/** The token in force: a runtime override if one is stored, else the compiled-in constant. */
export function gfwToken(): string {
  try {
    return localStorage.getItem('earth_explorer_gfw_token') || GFW_TOKEN;
  } catch {
    return GFW_TOKEN;   // storage blocked (private mode / sandboxed iframe)
  }
}

/** GFW's public gridded activity datasets. */
export const GFW_DATASETS = [
  { id: 'public-global-fishing-effort:latest', label: 'Apparent fishing effort' },
  { id: 'public-global-presence:latest', label: 'All vessel presence' },
] as const;

/** Web Mercator tile point → lon/lat. */
function tileToLonLat(z: number, tx: number, ty: number, px: number, py: number, extent: number): [number, number] {
  const n = 2 ** z;
  const wx = (tx + px / extent) / n;
  const wy = (ty + py / extent) / n;
  const lon = wx * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * A 4wings time bucket index → the month it stands for.
 *
 * The tiles key each cell's values by an integer bucket, not by a date, and the mapping is simply
 * months since year zero: `year × 12 + (month − 1)`. Established empirically — 2020-01 is 24240 and
 * 2024-01 is 24288, exactly 48 apart. (With `interval=YEAR` the key is instead the plain year string,
 * which is why this loader always asks for MONTH.)
 */
function bucketToDate(bucket: number): string {
  const year = Math.floor(bucket / 12);
  const month = (bucket % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Decoded stacks live here so re-selecting the layer is instant instead of re-parsing megabytes. */
const stackCache = new Map<string, GriddedField[]>();

/**
 * Loads a year of activity as **twelve monthly frames**.
 *
 * The shape of the API makes this nearly free: one tile request at `interval=MONTH` carries every
 * month's value for every cell, so a scrubbable year costs exactly what a single annual snapshot
 * costs. All twelve frames share one colour scale — normalizing per frame would make the colormap
 * mean something different in every month, which is precisely what a time-lapse must not do.
 *
 * `zoom` selects the tile pyramid level; 2 is 16 requests for the world.
 */
export async function loadGfwEffortStack(
  device: GPUDevice,
  opts: { year?: number; zoom?: number; dataset?: string } = {},
): Promise<GriddedField[]> {
  const year = opts.year ?? new Date().getUTCFullYear() - 1;
  const zoom = Math.max(0, Math.min(3, Math.round(opts.zoom ?? 2)));
  const dataset = opts.dataset ?? GFW_DATASETS[0].id;
  const key = `${dataset}|${year}|${zoom}`;
  const hit = stackCache.get(key);
  if (hit) {
    return hit;
  }
  const n = 2 ** zoom;
  const W = 1440, H = 720;
  // One accumulator per month actually present, allocated lazily — a quiet year need not pay for
  // twelve full rasters.
  const months = new Map<number, Float32Array>();
  // A finished year never changes, so let the browser serve it from cache even once stale. GFW sends
  // `private, max-age=86400` with no ETag, so without this a completed year is re-downloaded daily.
  const complete = year < new Date().getUTCFullYear();
  const cache: RequestCache = complete ? 'force-cache' : 'default';

  const jobs: Array<Promise<void>> = [];
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const url = `${GFW_API}/4wings/tile/heatmap/${zoom}/${tx}/${ty}`
        + `?datasets%5B0%5D=${encodeURIComponent(dataset)}`
        + `&date-range=${year}-01-01,${year}-12-31&interval=MONTH&format=MVT`;
      jobs.push((async () => {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${gfwToken()}` }, cache });
        if (r.status === 401 || r.status === 403) {
          throw new Error('GFW rejected the token (401/403) — it may be expired or revoked');
        }
        if (!r.ok) {
          throw new Error(`GFW: HTTP ${r.status}`);
        }
        const layers = decodeMvt(await r.arrayBuffer());
        for (const layer of layers) {
          for (const f of layer.features) {
            const ring = f.rings[0];
            if (!ring || ring.length < 3) {
              continue;
            }
            let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
            for (const [px, py] of ring) {
              const [lon, lat] = tileToLonLat(zoom, tx, ty, px, py, layer.extent);
              lonMin = Math.min(lonMin, lon); lonMax = Math.max(lonMax, lon);
              latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
            }
            const x0 = Math.max(0, Math.floor(((lonMin + 180) / 360) * W));
            const x1 = Math.min(W - 1, Math.max(x0, Math.ceil(((lonMax + 180) / 360) * W) - 1));
            const y0 = Math.max(0, Math.floor(((90 - latMax) / 180) * H));
            const y1 = Math.min(H - 1, Math.max(y0, Math.ceil(((90 - latMin) / 180) * H) - 1));
            for (const [k, v] of Object.entries(f.properties)) {
              if (!/^\d+$/.test(k) || typeof v !== 'number' || !(v > 0)) {
                continue;   // `cell` and `id` are metadata, not buckets
              }
              const bucket = Number(k);
              let acc = months.get(bucket);
              if (!acc) {
                acc = new Float32Array(W * H);
                months.set(bucket, acc);
              }
              for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                  const i = y * W + x;
                  // Keep the maximum, not the sum: one Mercator cell covers many raster cells, and
                  // summing would multiply its hours by its footprint.
                  if (v > acc[i]) {
                    acc[i] = v;
                  }
                }
              }
            }
          }
        }
      })());
    }
  }
  await Promise.all(jobs);
  if (months.size === 0) {
    throw new Error(`GFW returned no ${year} activity for this dataset`);
  }

  // ONE scale across every month, so a colour means the same thing all year.
  let peak = 0;
  for (const acc of months.values()) {
    for (const v of acc) {
      if (v > peak) {
        peak = v;
      }
    }
  }
  const min = 1;                                   // one hour — below this is noise
  const max = Math.max(10, peak);
  const l0 = Math.log10(min);
  const span = Math.log10(max) - l0 || 1;
  const out: GriddedField[] = [];
  for (const bucket of [...months.keys()].sort((a, b) => a - b)) {
    const acc = months.get(bucket)!;
    const bytes = new Uint8Array(W * H);
    const mask = new Uint8Array(W * H);
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < acc.length; i++) {
      if (acc[i] < min) {
        continue;
      }
      const b = Math.max(1, Math.min(255, Math.round(((Math.log10(acc[i]) - l0) / span) * 255)));
      bytes[i] = b; mask[i] = 1;
      rgba[i * 4] = b; rgba[i * 4 + 1] = b; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    const meta: GriddedMeta = {
      variable: dataset, source: 'Global Fishing Watch (AIS-derived apparent effort)',
      date: bucketToDate(bucket), width: W, height: H, min, max, isLog: true, vector: false,
    };
    out.push(new GriddedField(rasterToTexture(device, W, H, rgba, `Gfw:${bucketToDate(bucket)}`), meta, bytes, mask));
  }
  stackCache.set(key, out);
  return out;
}
