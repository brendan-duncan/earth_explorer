// Bake the monthly Niño 3.4 SST-anomaly record for geo_gis_explorer's ENSO classification.
//
// The Oceanic Niño Index needs MONTHLY means over the Niño 3.4 box (5°S–5°N, 170°W–120°W) — far
// denser in time than the map's 4-month time-lapse, but over a tiny region, so the whole 1981→now
// record is a few KB of JSON. The full OISST span lives on the CoastWatch ERDDAP (no CORS header →
// bake in Node); the sample extends the committed record to today browser-direct from NCEI
// (src/geo/live/enso.ts).
//
// Each month's value = mean of ~6 daily box-mean snapshots (every 5th day, every 4th cell = 1°).
// Output: assets/geo/enso_nino34.json  { source, box, months: [["1981-09", anomC, samples], …] }
//
//   node tools/geo/bake_enso.mjs [--since 1981] [--out DIR]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const DATASET = 'ncdcOisst21Agg_LonPM180';
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';
const BOX = { latMin: -5, latMax: 5, lonMin: -170, lonMax: -120 };   // Niño 3.4
const DAY_STRIDE = 5;   // every 5th day → ~6 samples per monthly mean
const CELL_STRIDE = 4;  // every 4th 0.25° cell → 1° box sampling

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const sinceYear = parseInt(arg('--since', '1981'), 10);
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

const encodeQuery = (q) => q.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

/** The dataset's [start, end] time coverage (epoch seconds) — requests outside it 404. */
async function timeRange() {
  const das = await (await fetch(`${ERDDAP}/${DATASET}.das`)).text();
  const m = das.match(/time \{[\s\S]*?actual_range ([0-9.eE+]+), ([0-9.eE+]+)/);
  if (!m) {
    throw new Error('no time actual_range in .das');
  }
  return { start: parseFloat(m[1]), end: parseFloat(m[2]) };
}

/** Per-day Niño 3.4 box-mean anomaly for one year, clamped to the dataset's coverage. */
async function fetchYear(year, range) {
  const iso = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 19) + 'Z';
  const y0 = Math.max(Date.UTC(year, 0, 1, 12) / 1000, range.start);
  const y1 = Math.min(Date.UTC(year, 11, 31, 12) / 1000, range.end);
  if (y0 > y1) {
    throw new Error('outside dataset coverage');
  }
  const sel = `[(${iso(y0)}):${DAY_STRIDE}:(${iso(y1)})][(0.0)]`
    + `[(${BOX.latMin}):${CELL_STRIDE}:(${BOX.latMax})][(${BOX.lonMin}):${CELL_STRIDE}:(${BOX.lonMax})]`;
  const res = await fetch(`${ERDDAP}/${DATASET}.json?${encodeQuery(`anom${sel}`)}`);
  if (!res.ok) {
    throw new Error(`ERDDAP ${res.status}`);
  }
  const { columnNames, rows } = (await res.json()).table;
  const iTime = columnNames.indexOf('time');
  const iAnom = columnNames.indexOf('anom');
  const acc = new Map();
  for (const r of rows) {
    const v = r[iAnom];
    if (v === null || v === undefined || Number.isNaN(v)) {
      continue;
    }
    const day = String(r[iTime]).slice(0, 10);
    const a = acc.get(day) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n++;
    acc.set(day, a);
  }
  const days = new Map();
  for (const [day, a] of acc) {
    days.set(day, a.sum / a.n);
  }
  return days;
}

async function main() {
  const nowYear = new Date().getUTCFullYear();
  const range = await timeRange();
  const monthAcc = new Map();   // 'YYYY-MM' → { sum, n }
  for (let y = sinceYear; y <= nowYear; y++) {
    try {
      const days = await fetchYear(y, range);
      for (const [day, v] of days) {
        const m = day.slice(0, 7);
        const a = monthAcc.get(m) ?? { sum: 0, n: 0 };
        a.sum += v;
        a.n++;
        monthAcc.set(m, a);
      }
      process.stderr.write(`  ${y}: ${days.size} days\n`);
    } catch (e) {
      process.stderr.write(`  ${y}: skipped (${e.message})\n`);
    }
  }
  const months = [...monthAcc.entries()]
    .map(([m, a]) => [m, Math.round((a.sum / a.n) * 100) / 100, a.n])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!months.length) {
    throw new Error('no months fetched');
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'enso_nino34.json'), JSON.stringify({
    source: 'NOAA OISST v2.1 anom via NOAA CoastWatch ERDDAP (monthly Niño 3.4 box means)',
    box: '5S-5N 170W-120W',
    months,
  }) + '\n');
  process.stderr.write(`wrote ${months.length} months (${months[0][0]} → ${months[months.length - 1][0]})\n`);
}

main().catch((e) => { process.stderr.write(`bake_enso failed: ${e.message}\n`); process.exit(1); });
