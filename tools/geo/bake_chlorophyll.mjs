// Bake a TIME-STACK of global ocean-color (chlorophyll-a) snapshots so the geo_gis_explorer sample
// can play chlorophyll through the same 2016→now time-lapse as the other layers.
//
// Source: NOAA S-NPP VIIRS science-quality monthly chlorophyll (`nesdisVHNSQchlaMonthly`, global
// 0.0375°, 2012→present) on the CoastWatch ERDDAP — no CORS header there, so baked in Node.
// Chlorophyll spans orders of magnitude, so frames store a LOG-scaled value.
//
// Writes ONE vertically-stacked atlas (frame i at rows [i·H, (i+1)·H)):
//   assets/geo/chl_stack.png    equirect rgba8: R = log10-normalized chlorophyll into
//                                [minC, maxC], A = valid mask (0 = land / cloud / no-data).
//   assets/geo/chl_stack.json   { source, min, max, log:true, width, height, frames, dates }
//                                decode: chl = 10^(log10(min) + R/255·(log10(max)−log10(min))).
//
//   node tools/geo/bake_chlorophyll.mjs [--stride 16] [--since 2016] [--step 4] [--out DIR]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const DATASET = 'nesdisVHNSQchlaMonthly';
const VARIABLE = 'chlor_a';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';
const MIN_C = 0.02;   // mg m^-3 — clear open-ocean floor
const MAX_C = 20.0;   // productive-coastal ceiling

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// CoastWatch's WAF 403s Node's default user-agent for this dataset (curl works) — send a plain one.
const FETCH_OPTS = { headers: { 'User-Agent': 'earth-explorer-bake/1.0' } };

const stride = Math.max(1, parseInt(arg('--stride', '16'), 10));   // 0.0375° × 16 = 0.6°
const sinceYear = parseInt(arg('--since', '2016'), 10);
const stepMonths = Math.max(1, parseInt(arg('--step', '4'), 10));
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

async function datasetEnd() {
  const das = await (await fetch(`${ERDDAP}/${DATASET}.das`, FETCH_OPTS)).text();
  const m = das.match(/time \{[\s\S]*?actual_range [0-9.eE+]+, ([0-9.eE+]+)/);
  return m ? parseFloat(m[1]) : Date.now() / 1000;
}

/** Fetch one month and place it into a full-globe equirect frame (log-scaled). */
async function fetchFrame(dateStr, grid) {
  const enc = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  // Axis order: [time][altitude][latitude][longitude]; `(value)` time snaps to the nearest month.
  const q = enc(`${VARIABLE}[(${dateStr}T12:00:00Z)][0][0:${stride}:last][0:${stride}:last]`);
  const res = await fetch(`${ERDDAP}/${DATASET}.json?${q}`, FETCH_OPTS);
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json()).table;
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iChl = columnNames.indexOf(VARIABLE);
  const iTime = columnNames.indexOf('time');

  if (!grid.width) {
    const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => a - b);
    const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
    grid.width = Math.round(360 / ((lons[lons.length - 1] - lons[0]) / (lons.length - 1)));
    grid.height = Math.round(180 / ((lats[lats.length - 1] - lats[0]) / (lats.length - 1)));
  }
  const { width, height } = grid;
  const l0 = Math.log10(MIN_C);
  const span = Math.log10(MAX_C) - l0;
  const rgba = Buffer.alloc(width * height * 4);
  let valid = 0;
  for (const r of rows) {
    const c = r[iChl];
    if (c === null || c === undefined || Number.isNaN(c) || c <= 0) {
      continue;
    }
    const lat = r[iLat];
    const lon = r[iLon] >= 180 ? r[iLon] - 360 : r[iLon];
    const col = ((Math.round(((lon + 180) / 360) * width) % width) + width) % width;
    const row = Math.min(height - 1, Math.max(0, Math.round(((90 - lat) / 180) * (height - 1))));
    const n = Math.max(0, Math.min(1, (Math.log10(Math.max(c, MIN_C)) - l0) / span));
    const v = Math.round(n * 255);
    const o = (row * width + col) * 4;
    rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    valid++;
  }
  inpaintSmallHoles(rgba, width, height);
  return { rgba, valid, date: rows.length ? String(rows[0][iTime]).slice(0, 10) : dateStr };
}

/**
 * Fills SMALL no-data holes (cloud speckle, decimation dropouts) with the mean of their valid
 * 8-neighbors (needs ≥3), a couple of passes. Large genuinely-unobserved regions (persistent
 * cloud decks, polar night) don't have enough valid neighbors and stay honestly masked.
 */
function inpaintSmallHoles(rgba, width, height, iterations = 2) {
  for (let it = 0; it < iterations; it++) {
    const src = Buffer.from(rgba);
    let filled = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (src[o + 3] !== 0) {
          continue;
        }
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const xx = (x + dx + width) % width;   // wrap longitude
            const oo = (yy * width + xx) * 4;
            if (src[oo + 3] !== 0) {
              sum += src[oo]; cnt++;
            }
          }
        }
        if (cnt >= 3) {
          const v = Math.round(sum / cnt);
          rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
          filled++;
        }
      }
    }
    if (filled === 0) {
      break;
    }
  }
}

async function main() {
  const end = await datasetEnd();
  const wanted = [];
  for (let y = sinceYear, m = 0; ; m += stepMonths, y += Math.floor(m / 12), m %= 12) {
    const epoch = Date.UTC(y, m, 1, 12) / 1000;
    if (epoch > end) {
      break;
    }
    wanted.push(new Date(epoch * 1000).toISOString().slice(0, 10));
  }

  const grid = {};
  const frames = [];
  const dates = [];
  for (const date of wanted) {
    try {
      const { rgba, valid, date: actual } = await fetchFrame(date, grid);
      frames.push(rgba); dates.push(actual);
      process.stderr.write(`  ${date} → ${actual}: ${valid} cells\n`);
    } catch (e) {
      process.stderr.write(`  ${date}: skipped (${e.message})\n`);
    }
  }
  if (!frames.length) {
    throw new Error('no frames fetched');
  }
  const { width, height } = grid;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'chl_stack.png'), encodePng(width, height * frames.length, Buffer.concat(frames)));
  writeFileSync(resolve(outDir, 'chl_stack.json'), JSON.stringify({
    variable: VARIABLE, source: 'NOAA S-NPP VIIRS chlorophyll-a via NOAA CoastWatch ERDDAP',
    min: MIN_C, max: MAX_C, log: true, width, height, frames: frames.length, dates,
  }, null, 2) + '\n');
  process.stderr.write(`wrote ${width}x${height} × ${frames.length} frames\n`);
}

main().catch((e) => { process.stderr.write(`bake_chlorophyll failed: ${e.message}\n`); process.exit(1); });
