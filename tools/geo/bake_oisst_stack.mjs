// Bake the OISST time-lapse stack (2016→now by default) for geo_gis_explorer's temporal layers.
//
// The browser streams OISST live from the NCEI ERDDAP (CORS *), but NCEI's aggregation only
// reaches back to 2020-02-28 — and NCEI has dropped the datasets outright before (2026-07), which
// left the timeline ending at the baked frames. So the committed stack covers the FULL range up to
// the bake date; the live stream only fills in dates newer than the bake (dedup by date). The
// full record lives on the CoastWatch ERDDAP (`ncdcOisst21Agg_LonPM180`), no CORS → bake in Node.
//
// One vertically-stacked atlas per variable (frame i at rows [i·H, (i+1)·H)), same scalar
// encoding as the live loader (R = value normalized into the layer's fixed range, A = valid mask):
//   assets/geo/oisst_sst_stack.png/.json     sst  → [-2, 34] °C
//   assets/geo/oisst_anom_stack.png/.json    anom → [-5, 5] °C
//   assets/geo/oisst_ice_stack.png/.json     ice  → [0, 1]
//
// The committed stacks are baked MONTHLY (--step 1): GriddedField.loadBakedStack filters frames
// to the sample's selected display cadence (4/2/1 months), so finer cadence costs GPU memory only
// when chosen.
//
// They are baked at 1° (--stride 4) over the FULL record (--since 1981), which is what ships:
// 539 frames, ~47 MB across the three atlases. The alternative — 0.5° over the same span — is
// 87 MB for the anomaly file alone, past what belongs in a git repo, and buys nothing where it
// matters: every analysis op and the forecaster run on the 1° grid, and the trainer downsamples
// 720×360 to 360×180 on load anyway. Recent dates get their detail from the live stream, which
// defaults to the feed's native 0.25°.
//
//   node tools/geo/bake_oisst_stack.mjs [--stride 4] [--since 1981] [--step 1] [--until YYYY-MM-DD] [--out DIR]
//   node tools/geo/bake_oisst_stack.mjs --append     # extend the committed stacks with the months since
//
// `--append` decodes the existing atlases and fetches only the dates after their last frame — a
// monthly top-up is a couple of frames, not a 539-frame, hour-long re-pull of a 1° record that has
// not changed. The grid, stride and cadence come from the existing stack, so they stay consistent.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const DATASET = 'ncdcOisst21Agg_LonPM180';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';

// Fixed ranges shared with the sample's layer definitions — keep in sync with geo_gis_explorer.ts.
const VARS = [
  { name: 'sst', min: -2, max: 34, file: 'oisst_sst_stack' },
  { name: 'anom', min: -5, max: 5, file: 'oisst_anom_stack' },
  { name: 'ice', min: 0, max: 1, file: 'oisst_ice_stack' },
];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const stride = Math.max(1, parseInt(arg('--stride', '4'), 10)); // 0.25° * 4 = 1°, the analysis grid
const sinceYear = parseInt(arg('--since', '1981'), 10);         // OISST's own start (1981-09)
const stepMonths = Math.max(1, parseInt(arg('--step', '1'), 10));
const untilISO = arg('--until', new Date().toISOString().slice(0, 10));   // bake dates BEFORE it (default: today)
const outDir = resolve(REPO, arg('--out', 'assets/geo'));
const append = process.argv.includes('--append');

/**
 * The committed stacks, decoded: per-variable RGBA frame buffers plus the shared date list, or
 * null when there is nothing to append to. The three atlases are baked together and must agree on
 * their dates; a mismatch means a half-written bake, and starting over is the only safe answer.
 */
async function readExisting() {
  const metas = VARS.map((v) => {
    const p = resolve(outDir, `${v.file}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  });
  if (metas.some((m) => !m)) {
    return null;
  }
  const dates = metas[0].dates;
  if (metas.some((m) => JSON.stringify(m.dates) !== JSON.stringify(dates))) {
    throw new Error('existing stacks disagree on their dates — re-bake from scratch');
  }
  const { width, height } = metas[0];
  const stacks = [];
  for (const v of VARS) {
    const { data, info } = await sharp(resolve(outDir, `${v.file}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height * dates.length || info.channels !== 4) {
      throw new Error(`${v.file}.png is ${info.width}x${info.height}x${info.channels}, expected ${width}x${height * dates.length}x4`);
    }
    const frames = [];
    for (let i = 0; i < dates.length; i++) {
      frames.push(data.subarray(i * width * height * 4, (i + 1) * width * height * 4));
    }
    stacks.push(frames);
  }
  return { width, height, dates, stacks };
}

/** One fetch per date returns all three variables; split into per-variable frames. */
async function fetchDay(dateStr, grid) {
  const enc = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  const sel = `[(${dateStr}T12:00:00Z)][(0.0)][(-89.875):${stride}:(89.875)][(-179.875):${stride}:(179.875)]`;
  const q = enc(VARS.map((v) => `${v.name}${sel}`).join(','));
  const res = await fetch(`${ERDDAP}/${DATASET}.json?${q}`);
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json()).table;
  const iLat = columnNames.indexOf('latitude');
  const iLon = columnNames.indexOf('longitude');
  const iVar = VARS.map((v) => columnNames.indexOf(v.name));

  if (!grid.width) {
    const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => a - b);
    const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
    grid.width = Math.round(360 / ((lons[lons.length - 1] - lons[0]) / (lons.length - 1)));
    grid.height = Math.round(180 / ((lats[lats.length - 1] - lats[0]) / (lats.length - 1)));
  }
  const { width, height } = grid;
  const frames = VARS.map(() => Buffer.alloc(width * height * 4));
  for (const r of rows) {
    const lat = r[iLat];
    const lon = r[iLon];
    const col = ((Math.round(((lon + 180) / 360) * width) % width) + width) % width;
    const row = Math.min(height - 1, Math.max(0, Math.round(((90 - lat) / 180) * (height - 1))));
    const o = (row * width + col) * 4;
    for (let k = 0; k < VARS.length; k++) {
      const val = r[iVar[k]];
      if (val === null || val === undefined || Number.isNaN(val)) {
        continue; // land / no-data → alpha 0 (ice over open water reports 0, which is valid data)
      }
      const { min, max } = VARS[k];
      const byte = Math.max(0, Math.min(255, Math.round(((val - min) / (max - min)) * 255)));
      frames[k][o] = byte; frames[k][o + 1] = byte; frames[k][o + 2] = byte; frames[k][o + 3] = 255;
    }
  }
  return frames;
}

async function main() {
  const until = Date.UTC(...untilISO.split('-').map((x, i) => (i === 1 ? +x - 1 : +x))) / 1000;
  const dates = [];
  for (let y = sinceYear, m = 0; ; m += stepMonths, y += Math.floor(m / 12), m %= 12) {
    const epoch = Date.UTC(y, m, 1, 12) / 1000;
    if (epoch >= until) {
      break;
    }
    dates.push(new Date(epoch * 1000).toISOString().slice(0, 10));
  }

  const grid = {};
  let stacks = VARS.map(() => []);
  let keptDates = [];
  const existing = append ? await readExisting() : null;
  if (append && !existing) {
    process.stderr.write('nothing to append to — baking from scratch\n');
  }
  if (existing) {
    grid.width = existing.width;
    grid.height = existing.height;
    stacks = existing.stacks;
    keptDates = [...existing.dates];
    const last = keptDates[keptDates.length - 1];
    const fresh = dates.filter((d) => d > last);
    process.stderr.write(`existing stack: ${keptDates.length} frames through ${last}; ${fresh.length} to fetch\n`);
    dates.length = 0;
    dates.push(...fresh);
  }
  for (const date of dates) {
    try {
      const frames = await fetchDay(date, grid);
      frames.forEach((f, k) => stacks[k].push(f));
      keptDates.push(date);
      process.stderr.write(`  ${date}: ok\n`);
    } catch (e) {
      process.stderr.write(`  ${date}: skipped (${e.message})\n`);
    }
  }
  if (!keptDates.length) {
    throw new Error('no frames fetched');
  }
  const { width, height } = grid;
  mkdirSync(outDir, { recursive: true });
  for (let k = 0; k < VARS.length; k++) {
    const v = VARS[k];
    writeFileSync(resolve(outDir, `${v.file}.png`), encodePng(width, height * keptDates.length, Buffer.concat(stacks[k])));
    writeFileSync(resolve(outDir, `${v.file}.json`), JSON.stringify({
      variable: v.name, source: 'NOAA OISST v2.1 via NOAA CoastWatch ERDDAP (baked pre-2020 tail)',
      min: v.min, max: v.max, width, height, frames: keptDates.length, dates: keptDates,
    }, null, 2) + '\n');
  }
  process.stderr.write(`wrote ${width}x${height} × ${keptDates.length} frames × ${VARS.length} vars\n`);
}

main().catch((e) => { process.stderr.write(`bake_oisst_stack failed: ${e.message}\n`); process.exit(1); });
