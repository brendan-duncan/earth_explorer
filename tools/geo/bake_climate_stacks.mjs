// Bake the long MONTHLY land-climate records geo_gis_explorer uses for ENSO teleconnection work:
//
//   assets/geo/gpcp_precip_stack.png/.json   GPCP v2.3 monthly precipitation (mm/day), 1979→,
//                                            2.5° global land+ocean, kept at its NATIVE 144×72
//                                            (the analysis FieldStore nearest-samples any grid onto
//                                            1°; resampling here would add ~6× the bytes and no
//                                            information). log10-encoded over [0.05, 40] mm/day.
//   assets/geo/land_anom_stack.png/.json     GHCN-CAMS monthly 2 m land air temperature ANOMALY
//                                            (°C vs. its own 1991–2020 per-calendar-month
//                                            climatology), 0.5° land-only, 2×2 block-averaged to 1°.
//                                            Linear over [−10, 10] °C (~0.08 °C steps).
//
// Why these two: the explorer's other rainfall/temperature layers are either short (GFS starts
// 2022-12) or daily and too heavy to average over decades (PERSIANN-CDR at 1° global is tens of GB
// of daily values). Monthly means going back to 1979 give ~45 ENSO winters — enough for a per-cell
// regression on the Niño index, which is what the `regress` analysis op fits.
//
// Temperature is baked as an ANOMALY, not absolute: an 8-bit atlas over the full −50..+40 °C land
// range is 0.35 °C per step, the same order as the ENSO signal being measured. Precipitation stays
// absolute (the `anomaly` op removes its seasonal cycle on demand) but log-encoded, because a
// linear 8-bit ramp that reaches monsoon totals flattens every desert to zero.
//
// Both come from NOAA PSL's THREDDS OPeNDAP server. It sends no CORS header, so this bakes in Node
// like the other geo stacks. The binary `.dods` response is parsed directly (big-endian XDR
// float32 after the `Data:` marker) — ASCII would be ~10× the bytes.
//
// Same atlas layout as bake_oisst_stack.mjs: frame i at rows [i·H, (i+1)·H), R = normalized value,
// A = valid mask.
//
//   node tools/geo/bake_climate_stacks.mjs [--since 1979] [--only gpcp|land] [--out DIR]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib_png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PSL = 'https://psl.noaa.gov/thredds/dodsC/Datasets';

const W = 360;
const H = 180;
const MISSING = -9e36;   // both datasets use −9.96921e36

// Ranges shared with the explorer's layer definitions — keep in sync with geo_gis_explorer.ts.
const GPCP = { file: 'gpcp_precip_stack', min: 0.05, max: 40, log: true };
const LAND = { file: 'land_anom_stack', min: -10, max: 10, log: false };
const BASE_START = 1991;
const BASE_END = 2020;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const sinceYear = parseInt(arg('--since', '1979'), 10);
const only = arg('--only', '');
const outDir = resolve(REPO, arg('--out', 'assets/geo'));

const enc = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

async function fetchBytes(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) {
        throw e;
      }
      process.stderr.write(`  retry (${e.message})\n`);
    }
  }
}

/** First array of a DAP2 `.dods` response: [uint32 n][uint32 n][n × BE float32 | float64]. */
function dodsArray(buf, bytesPer) {
  const marker = buf.indexOf('\nData:\n');
  if (marker < 0) {
    throw new Error(`no Data: marker (${buf.subarray(0, 200).toString()})`);
  }
  let o = marker + 7;
  const n = buf.readUInt32BE(o);
  o += 8;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++, o += bytesPer) {
    out[i] = bytesPer === 4 ? buf.readFloatBE(o) : buf.readDoubleBE(o);
  }
  return out;
}

/** A dataset's time axis as `YYYY-MM` month keys (units: `<unit> since 1800-01-01`). */
async function monthAxis(path, count, unitMs) {
  const buf = await fetchBytes(`${PSL}/${path}.dods?${enc(`time[0:1:${count - 1}]`)}`);
  const t0 = Date.UTC(1800, 0, 1);
  return Array.from(dodsArray(buf, 8), (v) => new Date(t0 + v * unitMs).toISOString().slice(0, 7));
}

/** Normalizes a physical value into an 8-bit R byte for the layer's range. */
function toByte(v, spec) {
  const n = spec.log
    ? (Math.log10(Math.max(v, spec.min)) - Math.log10(spec.min)) / (Math.log10(spec.max) - Math.log10(spec.min))
    : (v - spec.min) / (spec.max - spec.min);
  return Math.max(0, Math.min(255, Math.round(n * 255)));
}

/** Packs a Float32 frame (NaN = no data) into rgba8 atlas rows. */
function packFrame(values, spec) {
  const px = Buffer.alloc(values.length * 4);
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (Number.isNaN(v)) {
      continue;
    }
    const b = toByte(v, spec);
    px[k * 4] = b; px[k * 4 + 1] = b; px[k * 4 + 2] = b; px[k * 4 + 3] = 255;
  }
  return px;
}

function writeStack(spec, frames, dates, meta, width = W, height = H) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `${spec.file}.png`), encodePng(width, height * frames.length, Buffer.concat(frames.map((f) => packFrame(f, spec))), { filter: 'adaptive' }));
  writeFileSync(resolve(outDir, `${spec.file}.json`), JSON.stringify({
    ...meta, min: spec.min, max: spec.max, ...(spec.log ? { log: true } : {}),
    width, height, frames: frames.length, dates: dates.map((m) => `${m}-01`),
  }, null, 2) + '\n');
  process.stderr.write(`wrote ${spec.file}: ${width}x${height} × ${frames.length} frames (${dates[0]} → ${dates[dates.length - 1]})\n`);
}

// ── GPCP: 144×72 at 2.5°, lat SOUTH→north (−88.75…88.75), lon 1.25…358.75 ──────────────────────
// Its cell centers coincide with a 144×72 equirect grid starting at −180° (−178.75 ≡ 181.25), so
// the bake is a pure reorder: flip rows to north-first and rotate columns to start at −180°.
async function bakeGpcp() {
  const path = 'gpcp/precip.mon.mean.nc';
  const dds = (await fetchBytes(`${PSL}/${path}.dds`)).toString();
  const nt = parseInt(/precip\[time = (\d+)\]/.exec(dds)?.[1] ?? '0', 10);
  const months = await monthAxis(path, nt, 86400e3);
  const first = months.findIndex((m) => parseInt(m, 10) >= sinceYear);
  process.stderr.write(`GPCP: ${nt} months, baking ${months[first]} → ${months[nt - 1]}
`);
  const raw = dodsArray(await fetchBytes(`${PSL}/${path}.dods?${enc(`precip[${first}:1:${nt - 1}][0:1:71][0:1:143]`)}`), 4);
  const GW = 144, GH = 72;
  const frames = [];
  for (let t = 0; t < nt - first; t++) {
    const src = raw.subarray(t * GW * GH, (t + 1) * GW * GH);
    const out = new Float32Array(GW * GH);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const v = src[(GH - 1 - y) * GW + ((x + GW / 2) % GW)];
        out[y * GW + x] = v > MISSING && v >= 0 ? v : NaN;
      }
    }
    frames.push(out);
  }
  writeStack(GPCP, frames, months.slice(first), {
    variable: 'precip', unit: 'mm/day',
    source: 'GPCP v2.3 monthly precipitation (NOAA PSL), native 2.5°',
  }, GW, GH);
}

// ── GHCN-CAMS: 720×360 at 0.5°, lat NORTH→south (89.75…), lon 0.25…359.75, Kelvin, land only ──
async function bakeLand() {
  const path = 'ghcncams/air.mon.mean.nc';
  const dds = (await fetchBytes(`${PSL}/${path}.dds`)).toString();
  const nt = parseInt(/air\[time = (\d+)\]/.exec(dds)?.[1] ?? '0', 10);
  const months = await monthAxis(path, nt, 3600e3);
  const first = months.findIndex((m) => parseInt(m, 10) >= sinceYear);
  process.stderr.write(`GHCN-CAMS: ${nt} months, baking ${months[first]} → ${months[nt - 1]}\n`);
  const SW = 720, SH = 360;
  const absFrames = [];
  // One year per request: 12 × 720 × 360 × 4 B ≈ 12 MB.
  for (let t0 = first; t0 < nt; t0 += 12) {
    const t1 = Math.min(nt - 1, t0 + 11);
    const raw = dodsArray(await fetchBytes(`${PSL}/${path}.dods?${enc(`air[${t0}:1:${t1}][0:1:${SH - 1}][0:1:${SW - 1}]`)}`), 4);
    for (let t = 0; t <= t1 - t0; t++) {
      const src = raw.subarray(t * SW * SH, (t + 1) * SW * SH);
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // Output col x spans lon [−180+x, −179+x] → source cols at 0.5° in 0..360.
          const c = (((x - 180) * 2) % SW + SW) % SW;
          let s = 0, n = 0;
          for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
            const v = src[(y * 2 + dr) * SW + c + dc];
            if (v > MISSING && v >= 150 && v <= 400) {
              s += v; n++;
            }
          }
          out[y * W + x] = n ? s / n - 273.15 : NaN;
        }
      }
      absFrames.push(out);
    }
    process.stderr.write(`  ${months[t0]}…${months[t1]}\n`);
  }
  const dates = months.slice(first);
  // Per-cell, per-calendar-month 1991–2020 climatology → anomalies.
  const clim = Array.from({ length: 12 }, () => ({ s: new Float64Array(W * H), n: new Uint16Array(W * H) }));
  dates.forEach((m, i) => {
    const y = parseInt(m, 10);
    if (y < BASE_START || y > BASE_END) {
      return;
    }
    const c = clim[parseInt(m.slice(5, 7), 10) - 1];
    const f = absFrames[i];
    for (let k = 0; k < W * H; k++) {
      if (!Number.isNaN(f[k])) {
        c.s[k] += f[k]; c.n[k]++;
      }
    }
  });
  const minYears = Math.round((BASE_END - BASE_START + 1) * 0.8);
  const anomFrames = absFrames.map((f, i) => {
    const c = clim[parseInt(dates[i].slice(5, 7), 10) - 1];
    const out = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
      out[k] = !Number.isNaN(f[k]) && c.n[k] >= minYears ? f[k] - c.s[k] / c.n[k] : NaN;
    }
    return out;
  });
  writeStack(LAND, anomFrames, dates, {
    variable: 'landanom', unit: 'degC',
    source: 'GHCN-CAMS monthly 2 m land air temperature (NOAA PSL), 0.5° averaged to 1°',
    baseline: `${BASE_START}-01..${BASE_END}-12 per calendar month`,
  });
}

async function main() {
  if (only !== 'land') {
    await bakeGpcp();
  }
  if (only !== 'gpcp') {
    await bakeLand();
  }
}

main().catch((e) => { process.stderr.write(`bake_climate_stacks failed: ${e.message}\n`); process.exit(1); });
