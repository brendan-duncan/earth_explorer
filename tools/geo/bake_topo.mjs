// Bake a global ETOPO1 relief heightmap for geo_gis_explorer's terrain-relief globe.
//
// Source: ETOPO1 (1 arc-minute global relief, NOAA NCEI) served by the CoastWatch ERDDAP as the
// time-less `etopo180` grid (Int16 altitude, meters, lon −180..180). No CORS there — baked in Node
// like the other CoastWatch feeds.
//
// Writes:
//   assets/geo/topo_etopo.png    equirect rgba8, lon -180..180 (col 0 = -180), lat +90..-90.
//                                 Elevation packed 16-bit: R = high byte, G = low byte of
//                                 (elevation − MIN_M) / (MAX_M − MIN_M) · 65535. B unused, A = 255.
//   assets/geo/topo_etopo.json    { source, width, height, minM, maxM } — decode:
//                                 elevation = minM + ((R·256 + G) / 65535) · (maxM − minM).
//
//   node tools/geo/bake_topo.mjs [--stride 15] [--out DIR]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const DATASET = 'etopo180';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';
const MIN_M = -11000;   // Mariana Trench floor
const MAX_M = 9000;     // above Everest

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const stride = Math.max(1, parseInt(arg('--stride', '15'), 10));   // 1' × 15 = 0.25°
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

async function main() {
  const q = `altitude%5B0:${stride}:last%5D%5B0:${stride}:last%5D`;
  process.stderr.write(`fetch ${ERDDAP}/${DATASET}.json?${q}\n`);
  const res = await fetch(`${ERDDAP}/${DATASET}.json?${q}`);
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json()).table;
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iAlt = columnNames.indexOf('altitude');

  const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => a - b);
  const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
  const width = lons.length;
  const height = lats.length;
  const lonIndex = new Map(lons.map((v, i) => [v, i]));
  const latIndex = new Map(lats.map((v, i) => [v, height - 1 - i])); // row 0 = north

  const rgba = Buffer.alloc(width * height * 4);
  for (const r of rows) {
    const col = lonIndex.get(r[iLon]);
    const row = latIndex.get(r[iLat]);
    if (col === undefined || row === undefined) {
      continue;
    }
    const alt = r[iAlt] ?? 0;
    const n = Math.max(0, Math.min(65535, Math.round(((alt - MIN_M) / (MAX_M - MIN_M)) * 65535)));
    const o = (row * width + col) * 4;
    rgba[o] = n >> 8; rgba[o + 1] = n & 0xff; rgba[o + 2] = 0; rgba[o + 3] = 255;
  }

  mkdirSync(outDir, { recursive: true });
  const png = encodePng(width, height, rgba);
  writeFileSync(resolve(outDir, 'topo_etopo.png'), png);
  writeFileSync(resolve(outDir, 'topo_etopo.json'), JSON.stringify({
    source: 'ETOPO1 global relief (NOAA NCEI, via CoastWatch ERDDAP)',
    width, height, minM: MIN_M, maxM: MAX_M,
  }, null, 2) + '\n');
  process.stderr.write(`wrote ${width}x${height}, ${(png.length / 1e6).toFixed(2)} MB\n`);
}

main().catch((e) => { process.stderr.write(`bake_topo failed: ${e.message}\n`); process.exit(1); });
