// Bake a TIME-STACK of global surface-current snapshots for the geo_gis_explorer flow overlay, so the
// currents evolve in step with the SST time-lapse (2020 → now, every few months) and the sample can
// interpolate between the sampled dates.
//
// Source: NOAA CoastWatch "Near Real Time Geostrophic Currents" (`miamicurrents`, 0.2°, global to
// ±64.7°, daily, 2016→present) with u_current / v_current (m/s). CoastWatch sends no CORS header, so
// the browser can't fetch it directly — we bake here in Node (no CORS limit), like the SST baseline.
//
// Writes ONE vertically-stacked atlas (frame i at rows [i·H, (i+1)·H)):
//   assets/geo/currents_stack.png    equirect rgba8, lon -180..180 (col 0 = -180), lat +90..-90.
//                                     R = u encoded (u/uMax*0.5+0.5), G = v encoded, B = speed/uMax,
//                                     A = valid mask (0 over land / no-data / beyond ±64.7°).
//   assets/geo/currents_stack.json    { source, uMax, width, height, frames, dates:[...] } — decode
//                                     u = (R-0.5)*2*uMax, v = (G-0.5)*2*uMax, speed = B*uMax.
//
//   node tools/geo/bake_currents.mjs [--stride N] [--since 2020] [--step 4] [--out DIR]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const DATASET = 'miamicurrents';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';
const U_MAX = 2.5;   // m/s ±full-scale of the encoding (geostrophic currents peak ~2.4 m/s here)

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const stride = Math.max(1, parseInt(arg('--stride', '4'), 10));   // 0.2° * 4 = 0.8°
const sinceYear = parseInt(arg('--since', '2020'), 10);
const stepMonths = Math.max(1, parseInt(arg('--step', '4'), 10));
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

/** The dataset's latest available time (epoch seconds) from its `.das`. */
async function datasetEnd() {
  const das = await (await fetch(`${ERDDAP}/${DATASET}.das`)).text();
  const m = das.match(/time \{[\s\S]*?actual_range [0-9.eE+]+, ([0-9.eE+]+)/);
  return m ? parseFloat(m[1]) : Date.now() / 1000;
}

/** Fetch one day's u/v and place it into a FULL-globe equirect rgba frame (poles/land masked). */
async function fetchFrame(dateStr, grid) {
  const enc = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  const sel = `[(${dateStr}T00:00:00Z)][0:${stride}:last][0:${stride}:last]`;
  const q = enc(`u_current${sel},v_current${sel}`);
  const res = await fetch(`${ERDDAP}/${DATASET}.json?${q}`);   // Node fetch follows the 302 redirect
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json()).table;
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iU = columnNames.indexOf('u_current');
  const iV = columnNames.indexOf('v_current');

  // Establish the full-globe grid geometry once, from the first frame's spacing.
  if (!grid.width) {
    const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => a - b);
    const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
    const dLat = (lats[lats.length - 1] - lats[0]) / (lats.length - 1);
    const dLon = (lons[lons.length - 1] - lons[0]) / (lons.length - 1);
    grid.width = Math.round(360 / dLon);
    grid.height = Math.round(180 / dLat);
  }
  const { width, height } = grid;
  const rgba = Buffer.alloc(width * height * 4);
  const encByte = (x) => Math.max(0, Math.min(255, Math.round((x / U_MAX * 0.5 + 0.5) * 255)));
  let valid = 0;
  for (const r of rows) {
    const lat = r[iLat];
    const lon = r[iLon] >= 180 ? r[iLon] - 360 : r[iLon];       // 0..360 → -180..180
    const col = ((Math.round(((lon + 180) / 360) * width) % width) + width) % width;
    const row = Math.min(height - 1, Math.max(0, Math.round(((90 - lat) / 180) * (height - 1))));
    const u = r[iU], v = r[iV];
    if (u === null || v === null || Number.isNaN(u) || Number.isNaN(v)) {
      continue;
    }
    const o = (row * width + col) * 4;
    rgba[o] = encByte(u); rgba[o + 1] = encByte(v);
    rgba[o + 2] = Math.min(255, Math.round(Math.hypot(u, v) / U_MAX * 255)); rgba[o + 3] = 255;
    valid++;
  }
  return { rgba, valid };
}

async function main() {
  const end = await datasetEnd();
  // Dates: 1st of every `stepMonths`-th month from sinceYear-01, up to the dataset's latest day.
  const dates = [];
  for (let y = sinceYear, m = 0; ; m += stepMonths, y += Math.floor(m / 12), m %= 12) {
    const epoch = Date.UTC(y, m, 1) / 1000;
    if (epoch > end) {
      break;
    }
    dates.push(new Date(epoch * 1000).toISOString().slice(0, 10));
  }

  const grid = {};
  const frames = [];
  const keptDates = [];
  for (const date of dates) {
    try {
      const { rgba, valid } = await fetchFrame(date, grid);
      frames.push(rgba); keptDates.push(date);
      process.stderr.write(`  ${date}: ${valid} cells\n`);
    } catch (e) {
      process.stderr.write(`  ${date}: skipped (${e.message})\n`);
    }
  }
  if (!frames.length) {
    throw new Error('no frames fetched');
  }
  const { width, height } = grid;
  const atlas = Buffer.concat(frames);   // stacked vertically: frame i at rows [i*H,(i+1)*H)

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'currents_stack.png'), encodePng(width, height * frames.length, atlas));
  writeFileSync(resolve(outDir, 'currents_stack.json'), JSON.stringify({
    source: 'NOAA CoastWatch near-real-time geostrophic currents (miamicurrents)',
    uMax: U_MAX, width, height, frames: frames.length, dates: keptDates,
  }, null, 2) + '\n');
  process.stderr.write(`wrote ${width}x${height} × ${frames.length} frames\n`);
}

main().catch((e) => { process.stderr.write(`bake_currents failed: ${e.message}\n`); process.exit(1); });
