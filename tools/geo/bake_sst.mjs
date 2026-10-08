// Bake a recent global Sea-Surface-Temperature snapshot into a small equirectangular
// value-texture for the planet_explorer "living world" SST layer.
//
// Source: NOAA OISST v2.1 (0.25°, daily) served by the NOAA CoastWatch ERDDAP as a
// gridded dataset. We fetch the latest day, strided down to ~1° so the whole globe is
// a tiny image, and write:
//
//   assets/geo/sst_oisst.png   equirect rgba8, lon -180..180 (col 0 = -180), lat +90..-90
//                              (row 0 = north). R=G=B = normalized temperature (grayscale,
//                              so the PNG is human-viewable), A = valid mask (0 over land /
//                              no-data). Loaded with srgb:false so R decodes linearly.
//   assets/geo/sst_oisst.json  { dataset, date, width, height, tMinC, tMaxC } — the shader
//                              maps R back to °C as tMinC + R*(tMaxC-tMinC).
//
// The temperature range is FIXED (not data-derived) so successive bakes stay comparable
// and the shader's ramp is stable. Re-run any time to refresh the snapshot:
//
//   node tools/geo/bake_sst.mjs [--stride N] [--out DIR]
//
// This is the "static bake" that de-risks the render integration; a live ERDDAP fetch
// behind the same value-texture contract is the follow-up (see src/geo/live/sst_field.ts).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

// Fixed physical range the R channel is normalized into (°C). Open ocean spans roughly
// -2 °C (polar, near freezing point of seawater) to ~34 °C (tropical warm pools).
const T_MIN_C = -2.0;
const T_MAX_C = 34.0;

const DATASET = 'ncdcOisst21Agg_LonPM180';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const stride = Math.max(1, parseInt(arg('--stride', '2'), 10)); // 0.25° * 2 = 0.5°
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

// ── Fetch ─────────────────────────────────────────────────────────────────────────
async function fetchGrid() {
  // Griddap .json query: latest time, surface zlev, full lat/lon strided.
  // Axis order for this dataset is [time][zlev][latitude][longitude].
  const q = `sst[(last)][(0.0)][(-89.875):${stride}:(89.875)][(-179.875):${stride}:(179.875)]`;
  const url = `${ERDDAP}/${DATASET}.json?${encodeURIComponent(q).replace(/%3A/g, ':').replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%28/g, '(').replace(/%29/g, ')')}`;
  process.stderr.write(`fetch ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 400));
  }
  const json = await res.json();
  const { columnNames, rows } = json.table;
  const iTime = columnNames.indexOf('time');
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iSst = columnNames.indexOf('sst');
  return { rows, iTime, iLat, iLon, iSst };
}

async function main() {
  const { rows, iTime, iLat, iLon, iSst } = await fetchGrid();

  // Discover the grid axes from the returned rows.
  const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => a - b);
  const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
  const width = lons.length;
  const height = lats.length;
  const lonIndex = new Map(lons.map((v, i) => [v, i]));
  // Row 0 = north: latitude descending.
  const latIndex = new Map(lats.map((v, i) => [v, height - 1 - i]));

  const rgba = Buffer.alloc(width * height * 4);
  let valid = 0;
  for (const r of rows) {
    const col = lonIndex.get(r[iLon]);
    const row = latIndex.get(r[iLat]);
    const o = (row * width + col) * 4;
    const t = r[iSst];
    if (t === null || t === undefined || Number.isNaN(t)) {
      rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0; // land / no-data
      continue;
    }
    const n = Math.max(0, Math.min(1, (t - T_MIN_C) / (T_MAX_C - T_MIN_C)));
    const v = Math.round(n * 255);
    rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    valid++;
  }

  const date = rows.length ? String(rows[0][iTime]) : 'unknown';
  mkdirSync(outDir, { recursive: true });
  const png = encodePng(width, height, rgba);
  writeFileSync(resolve(outDir, 'sst_oisst.png'), png);
  writeFileSync(resolve(outDir, 'sst_oisst.json'), JSON.stringify({
    dataset: DATASET,
    source: 'NOAA OISST v2.1 via NOAA CoastWatch ERDDAP',
    date,
    width,
    height,
    tMinC: T_MIN_C,
    tMaxC: T_MAX_C,
  }, null, 2) + '\n');

  process.stderr.write(`wrote ${width}x${height} (${valid} valid cells), date ${date}\n`);
  process.stderr.write(`  ${resolve(outDir, 'sst_oisst.png')}\n`);
}

main().catch((e) => {
  process.stderr.write(`bake_sst failed: ${e.message}\n`);
  process.exit(1);
});
