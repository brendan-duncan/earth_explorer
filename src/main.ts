// Earth Explorer — a living-world map of NOAA ocean/atmosphere feeds, drawn flat (equirectangular)
// or wrapped onto a globe (a preview of a physical, emissive LED sphere display).
//
// A single fullscreen pass paints a selectable BASE layer over a natural-color Earth basemap (the
// basemap carries its own high-res land mask, so coastlines are crisp). Ocean value layers:
// sea-surface temperature, SST anomaly, and sea-ice concentration (live NOAA OISST time-lapse);
// chlorophyll (baked stack). Coral & heat stress (live NOAA Coral Reef Watch 5 km): degree heating
// weeks, bleaching alert level, marine-heatwave category. Waves (live PacIOOS WaveWatch III):
// total significant height plus its swell / wind-sea split and peak period. Atmosphere value
// layers (drawn over land AND ocean): GFS rainfall rate, 2 m air and surface temperature,
// humidity, sea-level pressure (isobars via the contour toggle) and the four surface radiation
// fluxes, plus PERSIANN-CDR satellite daily rainfall totals from NCEI. Imagery layers
// (RGB, no value scale): daily VIIRS true color assembled from NASA GIBS tiles (2012→now
// time-lapse of real clouds), and a live GOES-East+West GeoColor composite reprojected from the
// geostationary full disks. On top: currents/wind particle-trail overlays and a live RainViewer
// weather-radar overlay. Everything shares one equirect sampling contract, so it composites the
// same in the flat map and on the rotating globe.
//
// ANY layer can also be drawn OVER another one (the second picker in the bar, or `?over=`): area
// color is already spent on the fill, so the overlay draws as iso-lines tinted by its own colormap
// plus hatching above its actionable threshold. The two stacks keep their own coverage and are
// reconciled per date by pairOverlay(). The analysis `display` op takes the same second input.
//
// It runs on a phone. A finger has no hover, no wheel, no modifier key and no double-click, and the
// map leans on all four, so touch gets stand-ins: two fingers pinch to zoom and (in the perspective
// modes) aim the camera, a double-tap zooms in or closes a drawn shape, a long-press pins the value
// readout that hover gives a mouse, and the A/B compare seam becomes a handle you drag instead of a
// line that chases a cursor. On narrow screens the control bar collapses to one scrollable row.
//
// Clicking reads one point; the draw picker adds a LINE (value vs distance along the great circle)
// and an AREA (cos(lat)-weighted mean over the stack, which is also an analysis `region`). Shapes are
// rasterized into one equirect texture and composited by uv, so they are correct in every projection
// and on the globe. Every readout exports to CSV with a provenance header.
//
// Every layer carries an explanation behind the legend's ⓘ (also the `I` key, or `?info`): what the
// quantity is, how to read its range including any operational threshold, what change over time
// means, whether this record is long enough to show a trend, and which other layers co-vary — those
// render as chips that switch layers on click. Content lives in lib/geo_layer_info.ts.
//
// An ENSO panel classifies El Niño / La Niña by the NOAA CPC rule (Oceanic Niño Index = 3-month
// running mean of the Niño 3.4 anomaly, ±0.5 °C for ≥ 5 overlapping seasons). The index needs
// MONTHLY resolution — denser than the map's 4-month time-lapse — so it has its own record:
// baked 1981→now monthly box means (tools/geo/bake_enso.mjs, a few KB) extended to today
// browser-direct from NCEI, fetching only the Niño 3.4 box (src/geo/live/enso.ts).
//
// Data: OISST, PERSIANN-CDR (NCEI ERDDAP) and GFS, WW3, Coral Reef Watch (PacIOOS ERDDAP) are all
// browser-direct — those two hosts send `Access-Control-Allow-Origin: *`. Currents & chlorophyll are
// baked in Node (tools/geo/bake_*.mjs) because their ERDDAP hosts (CoastWatch, PolarWatch, upwell,
// OSMC, AOML) send no CORS header at all, which also rules out their live geostrophic-current,
// sea-surface-height and ocean-color datasets. Land basemap © Solar System Scope (CC BY 4.0).
// Space = play/pause.

import { GpuContext } from './gpu/gpu_context.js';
import { GriddedField, type GriddedMeta, type ScalarSource, type VectorSource } from './live/gridded_field.js';
import { buildSstColormapLut, sstColormapCssGradient, SST_COLORMAPS, type SstColormapName } from './live/sst_colormap.js';
import {
  currentUtcMonth, ensoEvents, eventAt, fetchNino34Live, mergeEnsoMonths, monthOrdinal, oniSeasons,
  parseBakedEnso, strengthLabel, type EnsoBakedJson, type EnsoEvent, type EnsoMonth, type EnsoSeason,
} from './live/enso.js';
import { GIBS_TRUE_COLOR_START, loadGibsDay } from './live/gibs.js';
import { TileWindowStreamer } from './live/tile_window.js';
import { loadGeoComposite } from './live/geostationary.js';
import { loadRadarOverlay } from './live/rainviewer.js';
import { OBIS_SPECIES, loadObisGrid } from './live/obis.js';
import { ATN_TAXA, loadAtnTracks, type AtnTrack } from './live/atn.js';
import {
  loadActiveCyclones, cycloneColor, cycloneClass, saffirSimpson,
  CYCLONE_ALERT_COLORS, CYCLONE_ALERT_LABELS, CYCLONE_ATTRIBUTION,
  type Cyclone, type LonLat,
} from './live/cyclones.js';
import {
  loadWildfires, loadForestUnits, hotspotColor, formatAcres, WILDFIRE_ATTRIBUTION,
  type WildfireSnapshot, type ForestUnit, type BBox,
} from './live/wildfire.js';
import {
  loadBoundaryLines, loadPlaces, detailForZoom, placeRankForZoom, formatPopulation,
  NATURAL_EARTH_ATTRIBUTION, type BoundaryLines, type Place, type DetailLevel,
} from './live/admin_places.js';
import { loadGfwEffortStack } from './live/gfw.js';
import { subsolarPoint } from './live/sun.js';
import { Texture } from './gpu/texture.js';
import { FlowOverlay, FLOW_WORLD, type FlowWindow } from './flow_overlay.js';
import { PROJECTIONS, projectionByKey, type ProjectionKey } from './projections.js';
import { FieldStore, type AnalysisForecaster, type AnalysisLayerProvider } from './analysis/field_store.js';
import { installAnalysisPanel } from './ui/analysis_panel.js';
import { installLayerInfoPanel, LAYER_INFO, type LayerInfoContext } from './ui/layer_info.js';
import { installReproducePanel } from './ui/reproduce_panel.js';
import { installImportPanel } from './ui/import_panel.js';
import type { AnnotateResult, DisplayResult, VectorsResult } from './analysis/ops.js';
import { inRegion, regionBbox, formatRing, parseRing, type RegionValue,
  type SeriesValue, type Unit as AnalysisUnit } from './analysis/types.js';
import sstPngUrl from '../assets/geo/sst_oisst.png?url';
import sstMetaUrl from '../assets/geo/sst_oisst.json?url';
import basemapUrl from '../assets/geo/earth_basemap.png?url';
import currentsStackPngUrl from '../assets/geo/currents_stack.png?url';
import currentsStackMetaUrl from '../assets/geo/currents_stack.json?url';
import chlStackPngUrl from '../assets/geo/chl_stack.png?url';
import chlStackMetaUrl from '../assets/geo/chl_stack.json?url';
import sstStackPngUrl from '../assets/geo/oisst_sst_stack.png?url';
import sstStackMetaUrl from '../assets/geo/oisst_sst_stack.json?url';
import anomStackPngUrl from '../assets/geo/oisst_anom_stack.png?url';
import anomStackMetaUrl from '../assets/geo/oisst_anom_stack.json?url';
import iceStackPngUrl from '../assets/geo/oisst_ice_stack.png?url';
import iceStackMetaUrl from '../assets/geo/oisst_ice_stack.json?url';
import gpcpStackPngUrl from '../assets/geo/gpcp_precip_stack.png?url';
import gpcpStackMetaUrl from '../assets/geo/gpcp_precip_stack.json?url';
import landAnomStackPngUrl from '../assets/geo/land_anom_stack.png?url';
import landAnomStackMetaUrl from '../assets/geo/land_anom_stack.json?url';
import topoPngUrl from '../assets/geo/topo_etopo.png?url';
import ensoJsonUrl from '../assets/geo/enso_nino34.json?url';
import nightmapUrl from '../assets/geo/earth_nightmap.png?url';

const SINCE_YEAR = 1981;      // time-lapse start = the OISST record's own start (1981-09). The
                              // committed baked stacks (bake_oisst_stack.mjs) cover 1981-09→their
                              // bake date at 1°, so the timeline is full even when NCEI is down (it
                              // has dropped its OISST datasets before); the live stream adds only
                              // dates newer than the bake. Every other layer clamps to its own floor
                              // in ANALYSIS_META, so a shorter feed still starts where its data does.
                              // Forty-five years is what makes a trend or a 30-year climatology
                              // mean anything — a decade of it is weather.
const STEP_MONTHS = 4;        // committed baked stacks' + wind overlay's cadence (fixed at bake/stream time).
                              // The BASE layer's live cadence is user-selectable (4/2/1 months, `step` param).
// Defaults are the FULL-FIDELITY view: the feed's native grid, sampled daily. Both are user
// choices in the gear menu, and both cost real bandwidth — one OISST day is ~282 KB at 1°,
// ~1.1 MB at 0.5°, ~4.4 MB native — so a daily native stack is ~120 frames × 4.4 MB ≈ half a
// gigabyte streamed and about the same again in GPU textures. That is the intended trade: this is
// a data explorer, and a coarse default quietly answers questions with less than the data has.
const DEFAULT_STRIDE = 1;     // OISST decimation: 1 → native 0.25° (4 → 1°, 2 → 0.5°). Toggle in UI.
const DEFAULT_STEP_MONTHS = 0.033;   // ≈ daily (sub-monthly walks days; see MAX_SUBMONTHLY_FRAMES)
// Sub-monthly cadences cover a bounded RECENT window rather than the whole record. Every feed is
// daily or finer upstream, so the cap is about what a browser can stream, not what exists: this
// many frames keeps a daily view in the same ballpark as the ~127 frames a monthly decade costs.
const MAX_SUBMONTHLY_FRAMES = 120;

// OISST on the NCEI ERDDAP — sends CORS *. Finalized product FIRST (it covers 2020→~2 weeks ago,
// so almost every dated fetch hits it directly); the near-real-time "preliminary" product only
// holds the last ~2 weeks and is the fallback for the newest days. The reverse order worked too,
// but 404'd once per historical date before falling back — needless console noise.
const OISST_SERVERS = ['https://www.ncei.noaa.gov/erddap/griddap'];
const OISST_DATASETS = ['ncdc_oisst_v2_avhrr_by_time_zlev_lat_lon', 'ncdc_oisst_v2_avhrr_prelim_by_time_zlev_lat_lon'];
const oisstSource = (variable: string, min: number, max: number): ScalarSource => ({
  servers: OISST_SERVERS, datasets: OISST_DATASETS, variable, hasLevel: true,
  source: 'NOAA OISST v2.1 (NCEI ERDDAP)', min, max,
});

// GFS atmosphere on the PacIOOS ERDDAP (CORS *) — the same dataset the wind overlay streams.
const GFS_SERVER = 'https://pae-paha.pacioos.hawaii.edu/erddap/griddap';
const gfsSource = (variable: string, min: number, max: number, isLog = false): ScalarSource => ({
  servers: [GFS_SERVER], datasets: ['ncep_global'],
  variable, hasLevel: false, source: 'NOAA GFS (PacIOOS)', min, max, isLog,
});
const isGfs = (src: { datasets: string[] }): boolean => src.datasets[0] === 'ncep_global';

// WaveWatch III on the same PacIOOS ERDDAP — total sea state (`Thgt`/`Tper`) plus its swell (`s*`)
// and wind-sea (`w*`) decomposition. Has a depth dim to pin to the surface.
const PACIOOS = 'https://pae-paha.pacioos.hawaii.edu/erddap/griddap';
const ww3Source = (variable: string, min: number, max: number): ScalarSource => ({
  servers: [PACIOOS], datasets: ['ww3_global'], variable, hasLevel: true,
  source: 'NOAA WaveWatch III (PacIOOS)', min, max,
});

// NOAA Coral Reef Watch 5 km daily (PacIOOS, CORS *): degree heating weeks, bleaching alert level,
// and — in the sibling `mhw_5km` — marine-heatwave category. The 1985 record start predates every
// other live feed here. At 0.05° these grids are 7200×3600 — 14 MB of JSON per frame even at the
// default stride — so `strideScale` decimates them onto the ~1°/cell grid the other live-streamed
// layers land on, holding a frame to ~3.5 MB (see ScalarSource.strideScale).
const CRW_STRIDE_SCALE = 10;   // 0.5° / 0.05°
const crwSource = (dataset: string, variable: string, min: number, max: number): ScalarSource => ({
  servers: [PACIOOS], datasets: [dataset], variable, hasLevel: false,
  source: 'NOAA Coral Reef Watch 5 km (PacIOOS)', min, max, strideScale: CRW_STRIDE_SCALE,
});

/** Decimation for a feed: the user's stride scaled by how much finer than ~0.5° its native grid is,
 *  so every live-streamed layer lands on a comparable cell count (and per-frame payload). */
const strideFor = (src: ScalarSource, stride: number): number => Math.max(1, Math.round(stride * (src.strideScale ?? 1)));

// UPSTREAM DATA BUG (probed 2026-07): PacIOOS's ncep_global aggregation serves LATITUDE-FLIPPED
// grids for archived dates — e.g. at 2023-01-01 the cell labeled 30N/88E (Tibet) returns the
// southern-ocean value and vice versa — while the current/forecast segment is labeled correctly.
// Detect per date with a two-cell probe: the Tibetan plateau (30N/88E, ~4.7 km up) is colder than
// the subtropical ocean at its mirror point in EVERY season, so if the cold end carries the −30
// label the grid must be loaded with `flipLat`. (WW3 on the same server probes clean — GFS only.)
const gfsFlipCache = new Map<string, boolean>();
async function gfsLatFlipped(timeISO: string): Promise<boolean> {
  const hit = gfsFlipCache.get(timeISO);
  if (hit !== undefined) {
    return hit;
  }
  let flipped = false;
  try {
    const q = `tmp2m[(${timeISO})][(-30.0):120:(30.0)][(88.0)]`.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    const { table } = await (await fetch(`${GFS_SERVER}/ncep_global.json?${q}`)).json() as { table: { columnNames: string[]; rows: unknown[][] } };
    const iLat = table.columnNames.indexOf('latitude');
    const iV = table.columnNames.indexOf('tmp2m');
    let north = NaN, south = NaN;
    for (const r of table.rows) {
      const lat = r[iLat] as number;
      if (lat > 0) { north = r[iV] as number; }
      if (lat < 0) { south = r[iV] as number; }
    }
    flipped = north - south > 2;   // Tibet must be the cold end; require a clear margin (K)
  } catch { /* unreachable probe → assume unflipped */ }
  gfsFlipCache.set(timeISO, flipped);
  return flipped;
}

// Temperature unit toggle. Absolute temps convert °F = °C·9/5 + 32; RELATIVE quantities
// (anomaly, Δ views, seasonal range, trends) scale by 9/5 only — no offset.
let UNIT_F = false;
const fmtTempAbs = (v: number): string => (UNIT_F ? `${(v * 9 / 5 + 32).toFixed(0)}°F` : `${v.toFixed(0)}°C`);
const fmtTempRel = (v: number): string => {
  const x = UNIT_F ? v * 9 / 5 : v;
  return `${x > 0 ? '+' : ''}${Math.abs(x) < 3 ? x.toFixed(1) : x.toFixed(0)}°${UNIT_F ? 'F' : 'C'}`;
};
const fmtTempSpan = (v: number): string => (UNIT_F ? `${(v * 9 / 5).toFixed(0)}°F` : `${v.toFixed(0)}°C`);

/** Picker sections — the layer list is long enough that a flat `<select>` stops being scannable. */
type LayerGroup = 'Ocean' | 'Coral & heat stress' | 'Waves' | 'Atmosphere' | 'Life' | 'Human activity' | 'Imagery';

/** A selectable ocean base layer (colormap value-texture + legend + how it's fetched). */
interface BaseLayer {
  key: string;
  label: string;
  group: LayerGroup;
  colormap: SstColormapName;
  legend: string;                 // legend title
  min: number; max: number; isLog: boolean;
  fmt: (v: number) => string;     // legend tick formatter (absolute values)
  /** Formatter for RELATIVE values (Δ views); defaults to a signed `fmt`. */
  fmtRel?: (v: number) => string;
  /** Formatter for SPANS (seasonal range); defaults to `fmt`. */
  fmtSpan?: (v: number) => string;
  kind: 'oisst' | 'live' | 'baked' | 'imagery' | 'geo-live' | 'obis' | 'gfw';
  source?: ScalarSource;          // oisst / live
  pngUrl?: string; metaUrl?: string;  // baked
  /** Committed pre-live-floor frames (bake_oisst_stack.mjs), prepended to the streamed stack. */
  bakedStack?: { pngUrl: string; metaUrl: string };
  /** ± full-scale of the "Δ vs prior year" analysis view (physical units). */
  deltaRange?: number;
  /** Field covers land too (GFS weather): draw data over land instead of the basemap. */
  overLand?: boolean;
  /** Sparse field (rain, coral heat stress): values at the scale's floor render as background rather
   *  than colormap-bottom, and no-data holes are left uncovered instead of flood-filled. */
  sparse?: boolean;
  /** Iso-line count when this layer is drawn as the OVERLAY over another one (default 8). Set it to
   *  the class count for ordinal layers so every line lands on a real category boundary. */
  overlayBands?: number;
  /** PHYSICAL value above which the overlay hatches — the threshold that makes the layer
   *  actionable (4 °C-weeks of coral stress, the 15 % sea-ice edge). Omit for lines only. */
  overlayHatchAt?: number;
}

/** Normalizes a physical value into the layer's 0..1 display range, matching how GriddedField
 *  encoded it (log10 for log layers) — so a threshold can be authored in real units. */
function normalizeValue(l: BaseLayer, v: number): number {
  if (l.isLog) {
    const l0 = Math.log10(l.min);
    return (Math.log10(Math.max(v, l.min)) - l0) / (Math.log10(l.max) - l0);
  }
  return (v - l.min) / (l.max - l.min);
}

/** Can this layer be drawn over another one? Imagery is RGB with no value scale to contour. */
const overlayable = (l: BaseLayer): boolean => l.kind !== 'imagery' && l.kind !== 'geo-live';

/** Analysis views over a temporal stack (computed CPU-side from the frames' retained cells). */
type ViewKey = 'abs' | 'delta' | 'mean' | 'min' | 'max' | 'range';

/** The overlay layer's legend strip — a thinner bar under the main colorbar, plus the threshold
 *  note when the overlay hatches. */
interface OverlayLegendSpec {
  title: string;
  colormap: SstColormapName;
  min: number;
  max: number;
  isLog: boolean;
  fmt: (v: number) => string;
  /** Formatted hatch threshold, e.g. "≥ 4 °C-wk"; omitted when the overlay is lines only. */
  hatchNote?: string;
}

/** What the colorbar legend shows (per layer + analysis view). */
interface LegendSpec {
  title: string;
  colormap: SstColormapName;
  min: number;
  max: number;
  isLog: boolean;
  fmt: (v: number) => string;
  /** Imagery layers carry no value scale — the colorbar hides entirely. */
  hidden?: boolean;
}
const VIEWS: ReadonlyArray<{ key: ViewKey; label: string }> = [
  { key: 'abs', label: 'Absolute' },
  { key: 'delta', label: 'Δ vs prior year' },
  { key: 'mean', label: 'Mean over years' },
  { key: 'min', label: 'Min over years' },
  { key: 'max', label: 'Max over years' },
  { key: 'range', label: 'Seasonal range' },
];

/**
 * Month-of-year filters. Restricting the stack to one season is what turns "the ocean over ten
 * years" into a question you can actually answer — a mean over every month buries a summer signal
 * under winter, and a max over all months is nearly always just "August".
 */
const SEASONS: ReadonlyArray<{ key: string; label: string; months: number[] }> = [
  { key: '', label: 'All months', months: [] },
  { key: 'djf', label: 'Dec–Feb', months: [12, 1, 2] },
  { key: 'mam', label: 'Mar–May', months: [3, 4, 5] },
  { key: 'jja', label: 'Jun–Aug', months: [6, 7, 8] },
  { key: 'son', label: 'Sep–Nov', months: [9, 10, 11] },
  ...Array.from({ length: 12 }, (_, i) => ({
    key: String(i + 1),
    label: new Date(Date.UTC(2000, i, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' }),
    months: [i + 1],
  })),
];

const fmtMeters = (v: number): string => `${v.toFixed(0)} m`;
const fmtMetersRel = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)} m`;
const fmtFlux = (v: number): string => `${v.toFixed(0)} W/m²`;
const fmtFluxRel = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(0)} W/m²`;
/** Category scales (bleaching alert level, marine-heatwave category) read as integers. */
const fmtCategory = (v: number): string => v.toFixed(0);

const LAYERS: BaseLayer[] = [
  { key: 'sst', label: 'Sea-surface temp', group: 'Ocean', colormap: 'thermal', legend: 'Sea-surface temp', min: -2, max: 34, isLog: false, fmt: fmtTempAbs, fmtRel: fmtTempRel, fmtSpan: fmtTempSpan, kind: 'oisst', deltaRange: 3, source: oisstSource('sst', -2, 34), bakedStack: { pngUrl: sstStackPngUrl, metaUrl: sstStackMetaUrl } },
  { key: 'anom', label: 'SST anomaly', group: 'Ocean', colormap: 'balance', legend: 'SST anomaly vs. climatology', min: -5, max: 5, isLog: false, fmt: fmtTempRel, fmtRel: fmtTempRel, fmtSpan: fmtTempSpan, kind: 'oisst', deltaRange: 3, source: oisstSource('anom', -5, 5), bakedStack: { pngUrl: anomStackPngUrl, metaUrl: anomStackMetaUrl } },
  { key: 'ice', label: 'Sea-ice concentration', group: 'Ocean', colormap: 'ice', legend: 'Sea-ice concentration', min: 0, max: 1, isLog: false, fmt: (v) => `${(v * 100).toFixed(0)}%`, fmtRel: (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`, kind: 'oisst', deltaRange: 0.5, overlayBands: 4, overlayHatchAt: 0.15, source: oisstSource('ice', 0, 1), bakedStack: { pngUrl: iceStackPngUrl, metaUrl: iceStackMetaUrl } },
  { key: 'chl', label: 'Chlorophyll', group: 'Ocean', colormap: 'chl', legend: 'Chlorophyll-a', min: 0.02, max: 20, isLog: true, fmt: (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(0)}`, kind: 'baked', bakedStack: { pngUrl: chlStackPngUrl, metaUrl: chlStackMetaUrl } },
  // Coral Reef Watch 5 km. All three are ocean-only and SPARSE: their scale floor means "no stress"
  // / "no heatwave" over most of the world, which should read as background rather than as the
  // colormap's bottom color smeared across every ocean.
  { key: 'dhw', label: 'Coral heat stress (DHW)', group: 'Coral & heat stress', colormap: 'thermal', legend: 'Degree heating weeks', min: 0, max: 16, isLog: false, fmt: (v) => `${v.toFixed(0)} °C-wk`, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C-wk`, kind: 'live', sparse: true, deltaRange: 6, overlayBands: 4, overlayHatchAt: 4, source: crwSource('dhw_5km', 'CRW_DHW', 0, 16) },
  { key: 'baa', label: 'Bleaching alert level', group: 'Coral & heat stress', colormap: 'thermal', legend: 'Bleaching alert (0–4)', min: 0, max: 4, isLog: false, fmt: fmtCategory, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, kind: 'live', sparse: true, deltaRange: 2, overlayBands: 4, overlayHatchAt: 3, source: crwSource('dhw_5km', 'CRW_BAA', 0, 4) },
  { key: 'mhw', label: 'Marine heatwave category', group: 'Coral & heat stress', colormap: 'thermal', legend: 'Marine heatwave (0–5)', min: 0, max: 5, isLog: false, fmt: fmtCategory, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, kind: 'live', sparse: true, deltaRange: 2, overlayBands: 5, overlayHatchAt: 2, source: crwSource('mhw_5km', 'heatwave_category', 0, 5) },
  // WaveWatch III: total sea state plus the swell / wind-sea split that composes it.
  { key: 'waves', label: 'Wave height (total)', group: 'Waves', colormap: 'viridis', legend: 'Significant wave height', min: 0, max: 10, isLog: false, fmt: fmtMeters, fmtRel: fmtMetersRel, kind: 'live', deltaRange: 2, overlayBands: 5, overlayHatchAt: 6, source: ww3Source('Thgt', 0, 10) },
  { key: 'swell', label: 'Swell height', group: 'Waves', colormap: 'viridis', legend: 'Swell significant height', min: 0, max: 8, isLog: false, fmt: fmtMeters, fmtRel: fmtMetersRel, kind: 'live', deltaRange: 2, source: ww3Source('shgt', 0, 8) },
  { key: 'windsea', label: 'Wind-sea height', group: 'Waves', colormap: 'viridis', legend: 'Wind-wave significant height', min: 0, max: 8, isLog: false, fmt: fmtMeters, fmtRel: fmtMetersRel, kind: 'live', deltaRange: 2, source: ww3Source('whgt', 0, 8) },
  { key: 'period', label: 'Peak wave period', group: 'Waves', colormap: 'ice', legend: 'Peak wave period', min: 0, max: 20, isLog: false, fmt: (v) => `${v.toFixed(0)} s`, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} s`, kind: 'live', deltaRange: 4, source: ww3Source('Tper', 0, 20) },
  // GFS atmosphere (same PacIOOS dataset as the wind overlay; archive floor ≈ 2022-12, and the
  // range's end is the +7-day FORECAST edge, so the calendar can pick a week into the future).
  // These cover land, so they draw over the basemap wherever data exists (`overLand`).
  { key: 'rain', label: 'Rainfall rate', group: 'Atmosphere', colormap: 'viridis', legend: 'Rainfall rate', min: 2.8e-5, max: 1.39e-2, isLog: true, fmt: (v) => { const mm = v * 3600; return `${mm < 1 ? mm.toFixed(1) : mm.toFixed(0)} mm/h`; }, fmtRel: (v) => `${v > 0 ? '+' : ''}${(v * 3600).toFixed(1)} mm/h`, kind: 'live', overLand: true, sparse: true, deltaRange: 1.4e-3, overlayBands: 4, overlayHatchAt: 2.78e-3, source: gfsSource('pratesfc', 2.8e-5, 1.39e-2, true) },
  // PERSIANN-CDR on the NCEI ERDDAP: satellite daily rainfall TOTALS back to 1983 — the only
  // precipitation record here that spans the whole timeline (GFS's archive starts 2022-12). ±60°.
  { key: 'precip', label: 'Daily rainfall (1983→)', group: 'Atmosphere', colormap: 'ice', legend: 'Daily precipitation', min: 0.2, max: 100, isLog: true, fmt: (v) => `${v < 1 ? v.toFixed(1) : v.toFixed(0)} mm`, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} mm`, kind: 'live', overLand: true, sparse: true, deltaRange: 20, overlayBands: 4, overlayHatchAt: 25, source: { servers: OISST_SERVERS, datasets: ['cdr_persiann_by_time_lon_lat'], variable: 'precipitation', hasLevel: false, source: 'NOAA PERSIANN-CDR (NCEI ERDDAP)', min: 0.2, max: 100, isLog: true, strideScale: 2 } },
  // The long MONTHLY land-climate records (tools/geo/bake_climate_stacks.mjs, NOAA PSL — no CORS, so
  // baked). They exist for decade-spanning and ENSO work: ~45 winters back to 1979, where GFS starts
  // 2022-12 and daily PERSIANN is far too heavy to average over decades in the browser. Ranges must
  // match the baker. GPCP stays on its native 2.5° grid; land temperature is baked as an anomaly.
  { key: 'precipmon', label: 'Monthly rainfall (GPCP, 1979→)', group: 'Atmosphere', colormap: 'ice', legend: 'Monthly-mean precipitation (GPCP)', min: 0.05, max: 40, isLog: true, fmt: (v) => `${v < 1 ? v.toFixed(1) : v.toFixed(0)} mm/d`, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} mm/d`, kind: 'baked', overLand: true, deltaRange: 4, overlayBands: 4, bakedStack: { pngUrl: gpcpStackPngUrl, metaUrl: gpcpStackMetaUrl } },
  { key: 'landanom', label: 'Land temp anomaly (1979→)', group: 'Atmosphere', colormap: 'balance', legend: 'Land 2 m air-temp anomaly vs 1991–2020 (GHCN-CAMS)', min: -10, max: 10, isLog: false, fmt: fmtTempRel, fmtRel: fmtTempRel, fmtSpan: fmtTempSpan, kind: 'baked', overLand: true, deltaRange: 4, bakedStack: { pngUrl: landAnomStackPngUrl, metaUrl: landAnomStackMetaUrl } },
  // The one to reach for when comparing against a weather report: 2 m air is what thermometers,
  // forecasts and people mean by "the temperature".
  { key: 'airtemp', label: 'Air temp (2 m) — as reported', group: 'Atmosphere', colormap: 'thermal', legend: 'Air temperature (2 m)', min: 233.15, max: 318.15, isLog: false, fmt: (v) => fmtTempAbs(v - 273.15), fmtRel: fmtTempRel, fmtSpan: fmtTempSpan, kind: 'live', overLand: true, deltaRange: 5, source: gfsSource('tmp2m', 233.15, 318.15) },
  // "Surface temp" reads as "the temperature outside" — which is the AIR temperature, a different
  // layer and, over dry ground at midday, 30 °C colder. The name has to carry the distinction,
  // because the number alone looks like an error to anyone who checked a weather report.
  { key: 'skintemp', label: 'Skin temp (ground/sea)', group: 'Atmosphere', colormap: 'thermal', legend: 'Skin temperature — the ground/sea itself, not 2 m air', min: 233.15, max: 328.15, isLog: false, fmt: (v) => fmtTempAbs(v - 273.15), fmtRel: fmtTempRel, fmtSpan: fmtTempSpan, kind: 'live', overLand: true, deltaRange: 5, source: gfsSource('tmpsfc', 233.15, 328.15) },
  { key: 'humidity', label: 'Humidity (2 m)', group: 'Atmosphere', colormap: 'ice', legend: 'Relative humidity (2 m)', min: 0, max: 100, isLog: false, fmt: (v) => `${v.toFixed(0)}%`, fmtRel: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`, kind: 'live', overLand: true, deltaRange: 30, source: gfsSource('rh2m', 0, 100) },
  { key: 'pressure', label: 'Sea-level pressure', group: 'Atmosphere', colormap: 'balance', legend: 'Mean sea-level pressure', min: 96000, max: 104000, isLog: false, fmt: (v) => `${(v / 100).toFixed(0) } hPa`, fmtRel: (v) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(1)} hPa`, kind: 'live', overLand: true, deltaRange: 1000, source: gfsSource('prmslmsl', 96000, 104000) },
  // Surface radiation budget. PacIOOS only carries these four fluxes in the RECENT segment of its
  // GFS aggregation — archived dates return all-null grids (probed 2026-07: empty at 2025-12,
  // populated from ~2026-01), so their timelines are short even though the dataset's advertised
  // range starts 2022-12. Same limitation the pre-existing `solar` layer has always had.
  { key: 'solar', label: 'Solar down (shortwave)', group: 'Atmosphere', colormap: 'thermal', legend: 'Downward shortwave flux', min: 0, max: 1100, isLog: false, fmt: fmtFlux, fmtRel: fmtFluxRel, kind: 'live', overLand: true, deltaRange: 300, source: gfsSource('dswrfsfc', 0, 1100) },
  { key: 'swup', label: 'Shortwave up (reflected)', group: 'Atmosphere', colormap: 'grayscale', legend: 'Upwelling shortwave flux', min: 0, max: 400, isLog: false, fmt: fmtFlux, fmtRel: fmtFluxRel, kind: 'live', overLand: true, deltaRange: 150, source: gfsSource('uswrfsfc', 0, 400) },
  { key: 'lwup', label: 'Longwave up (surface)', group: 'Atmosphere', colormap: 'thermal', legend: 'Upwelling longwave flux', min: 100, max: 600, isLog: false, fmt: fmtFlux, fmtRel: fmtFluxRel, kind: 'live', overLand: true, deltaRange: 100, source: gfsSource('ulwrfsfc', 100, 600) },
  { key: 'lwdown', label: 'Longwave down (surface)', group: 'Atmosphere', colormap: 'thermal', legend: 'Downward longwave flux', min: 50, max: 500, isLog: false, fmt: fmtFlux, fmtRel: fmtFluxRel, kind: 'live', overLand: true, deltaRange: 100, source: gfsSource('dlwrfsfc', 50, 500) },
  // Species occurrence density from OBIS. One layer, many species: the taxon is state (a picker in
  // the gear menu), not 12 near-identical layer entries — so one info entry and one citation cover
  // every species. No timeline: this is the whole record aggregated, so it is a single field.
  { key: 'obis', label: 'Species occurrences', group: 'Life', colormap: 'chl', legend: 'Occurrence records', min: 1, max: 50000, isLog: true, fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)), kind: 'obis', sparse: true },
  // Apparent fishing effort — the only layer needing a credential (see src/geo/live/gfw.ts).
  { key: 'fishing', label: 'Fishing effort', group: 'Human activity', colormap: 'cividis', legend: 'Apparent fishing effort', min: 1, max: 10000, isLog: true, fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k h` : `${v.toFixed(0)} h`), kind: 'gfw', sparse: true, overLand: false },
  // Satellite imagery (RGB as rendered upstream — no value cells, so no analysis views/readouts).
  { key: 'satellite', label: 'Satellite (true color)', group: 'Imagery', colormap: 'grayscale', legend: 'VIIRS true color', min: 0, max: 1, isLog: false, fmt: () => '', kind: 'imagery' },
  { key: 'goes', label: 'GOES live (clouds)', group: 'Imagery', colormap: 'grayscale', legend: 'GOES GeoColor', min: 0, max: 1, isLog: false, fmt: () => '', kind: 'geo-live' },
];

const WIND_SOURCE: VectorSource = {
  servers: [PACIOOS], datasets: ['ncep_global'],
  uVar: 'ugrd10m', vVar: 'vgrd10m', hasLevel: false, source: 'NOAA GFS 10 m wind (PacIOOS)', uMax: 25,
};

// ── Analysis graph wiring (TODO/geo-analysis-graph.md) ─────────────────────────────────
// The analysis engine consumes DECODED PHYSICAL floats, so each layer declares its unit and
// any ingestion conversion here (K → °C, Pa → hPa, fraction → %). Imagery layers carry no
// value cells and don't appear.

interface AnalysisMeta {
  unit: AnalysisUnit;
  relative?: boolean;
  convert?: (v: number) => number;
  start: string;               // coverage floor, YYYY-MM
  caveats?: string;
}

const ANALYSIS_META: Record<string, AnalysisMeta> = {
  // The OISST family reaches back to the record's own start: the committed atlases are baked from
  // CoastWatch's full aggregation, not the NCEI live endpoint (which only holds 2020→).
  sst: { unit: 'degC', start: '1981-09' },
  anom: { unit: 'degC', relative: true, start: '1981-09', caveats: 'anomaly vs the NOAA 1971–2000 climatology' },
  ice: { unit: 'percent', convert: (v) => v * 100, start: '1981-09' },
  waves: { unit: 'm', start: '2017-02', caveats: 'no coverage poleward of ±77°' },
  swell: { unit: 'm', start: '2017-02', caveats: 'swell component only; no coverage poleward of ±77°' },
  windsea: { unit: 'm', start: '2017-02', caveats: 'wind-sea component only; no coverage poleward of ±77°' },
  period: { unit: 's', start: '2017-02', caveats: 'peak period; no coverage poleward of ±77°' },
  chl: { unit: 'mgm3', start: '2016-01', caveats: 'log-distributed values; baked stack only' },
  dhw: { unit: 'degCwk', start: '2016-01', caveats: 'ocean only; heat stress accumulated over a rolling 12 weeks' },
  baa: { unit: 'none', start: '2016-01', caveats: 'ordinal alert level 0–4 (no stress → alert level 2), not a continuous quantity' },
  mhw: { unit: 'none', start: '2024-07', caveats: 'ordinal category 0–5 (none → beyond extreme), not a continuous quantity' },
  rain: { unit: 'mmph', convert: (v) => v * 3600, start: '2022-12', caveats: 'GFS 12:00Z snapshots' },
  fishing: { unit: 'h', start: '2012-01', caveats: 'apparent effort inferred from AIS: vessels without AIS, or with it switched off, are invisible; monthly totals per cell' },
  precip: { unit: 'mmpd', start: '2016-01', caveats: 'satellite daily totals, ±60° only; record starts 1983 but the timeline starts 2016' },
  precipmon: { unit: 'mmpd', start: '1979-01', caveats: 'monthly means on the native GPCP 2.5° grid — each value covers a 2.5° box, so it reads blocky on the 1° analysis grid; satellite + gauge blend' },
  landanom: { unit: 'degC', relative: true, start: '1979-01', caveats: 'land only; anomaly vs the 1991–2020 per-month GHCN-CAMS climatology (the SST anomaly layer uses 1971–2000, so the two are offset by recent warming)' },
  // GFS is 3-hourly and the map samples ONE instant per day, 12:00 UTC — which is 06:00 in New
  // Mexico, 13:00 in Nigeria and 21:00 in Japan. For the diurnal fields that spread is larger than
  // most of the geography (one high-desert cell reads 14 °C at 12 UTC and 46 °C six hours later),
  // so the hour has to be stated wherever the layer is described. The gear menu's daily
  // max/min/mean sampling reads the whole day instead.
  airtemp: { unit: 'degC', convert: (v) => v - 273.15, start: '2022-12', caveats: '12:00 UTC snapshots — a different local hour at every longitude, so a global map compares different times of day; use the daily max/min/mean sampling to avoid that' },
  skintemp: { unit: 'degC', convert: (v) => v - 273.15, start: '2022-12', caveats: 'surface (ground/sea) temperature, not the 2 m air temperature; 12:00 UTC snapshots — dawn in the Americas, night in East Asia — and skin temperature has the largest diurnal swing of any layer here' },
  humidity: { unit: 'percent', start: '2022-12', caveats: '12:00 UTC snapshots; relative humidity tracks the diurnal temperature cycle, so the sampling hour matters as much as the geography' },
  pressure: { unit: 'hpa', convert: (v) => v / 100, start: '2022-12', caveats: '12:00 UTC snapshots (pressure is the least diurnal of the GFS layers, so this matters least here)' },
  // The four radiation fluxes are only populated in the recent segment of PacIOOS's GFS
  // aggregation (probed 2026-07: all-null before ~2026-01), so their floor is NOT the dataset's
  // advertised 2022-12 — asking for earlier months yields empty grids, not data.
  solar: { unit: 'wm2', start: '2026-01', caveats: 'strongly diurnal — 12:00Z snapshots only; archived dates before ~2026-01 are empty upstream' },
  swup: { unit: 'wm2', start: '2026-01', caveats: 'strongly diurnal — 12:00Z snapshots only; archived dates before ~2026-01 are empty upstream' },
  lwup: { unit: 'wm2', start: '2026-01', caveats: 'SURFACE upwelling longwave (≈σT⁴ of the skin), NOT top-of-atmosphere OLR; archived dates before ~2026-01 are empty upstream' },
  lwdown: { unit: 'wm2', start: '2026-01', caveats: 'archived dates before ~2026-01 are empty upstream' },
};

/** Month-start dates (`YYYY-MM-01`) covering [start, end] inclusive at the cadence. */
function monthList(range: { start: string; end: string }, stepMonths: number): string[] {
  const out: string[] = [];
  let y = parseInt(range.start.slice(0, 4), 10);
  let m = parseInt(range.start.slice(5, 7), 10) - 1;
  const endY = parseInt(range.end.slice(0, 4), 10);
  const endM = parseInt(range.end.slice(5, 7), 10) - 1;
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}-01`);
    m += stepMonths;
    y += Math.floor(m / 12);
    m %= 12;
  }
  return out;
}

/** Formats a physical analysis value (legend ticks, answers, chart axes). */
function formatAnalysisValue(v: number, unit: AnalysisUnit, relative: boolean): string {
  if (!Number.isFinite(v)) {
    return '—';
  }
  const sign = relative && v > 0 ? '+' : '';
  switch (unit) {
    case 'degC': return relative ? fmtTempRel(v) : fmtTempAbs(v);
    case 'm': return `${sign}${v.toFixed(1)} m`;
    case 'mps': return `${sign}${v.toFixed(1)} m/s`;
    case 'percent': return `${sign}${v.toFixed(0)}%`;
    case 'mgm3': return `${sign}${v > -1 && v < 1 ? v.toFixed(2) : v.toFixed(1)}`;
    case 'hpa': return `${sign}${v.toFixed(1)} hPa`;
    case 'wm2': return `${sign}${v.toFixed(0)} W/m²`;
    case 'mmph': return `${sign}${v.toFixed(1)} mm/h`;
    case 'mmpd': return `${sign}${v.toFixed(1)} mm/day`;
    case 'degCwk': return `${sign}${v.toFixed(1)} °C-weeks`;
    case 'deg': return `${v.toFixed(1)}°`;
    case 'h': return `${sign}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)} h`;
    case 's': return `${sign}${v.toFixed(1)} s`;
    case 'r': return v.toFixed(2);
    default: return `${sign}${Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1)}`;
  }
}

/** Providers the FieldStore materializes `layer` nodes through — built on the same loaders
 *  as the display path (baked stacks first, then live months the bake doesn't cover). */
function buildAnalysisProviders(device: GPUDevice): Record<string, AnalysisLayerProvider> {
  const ym = (date: string): string => date.slice(0, 7);
  const inRange = (date: string, range: { start: string; end: string }): boolean => ym(date) >= range.start && ym(date) <= range.end;
  /** Dedupes by month and drops out-of-range frames (ERDDAP `(t)` snaps to the nearest index,
   *  so requests beyond a feed's coverage come back as duplicates of its edge frames). */
  const collector = (range: { start: string; end: string }): { out: GriddedField[]; seen: Set<string>; keep: (f: GriddedField) => void } => {
    const out: GriddedField[] = [];
    const seen = new Set<string>();
    return {
      out, seen,
      keep: (f) => {
        // Reject all-null grids for the same reason the display path does — a hole in the feed is not
        // a frame. Left in, it reads as a real measurement: an empty ice frame becomes an extent of
        // exactly 0.00 million km², which is indistinguishable from an ice-free Arctic.
        const empty = !Number.isFinite(f.stats()?.mean ?? NaN);
        if (!empty && inRange(f.meta.date, range) && !seen.has(ym(f.meta.date))) {
          seen.add(ym(f.meta.date));
          out.push(f);
        } else {
          f.destroy();
        }
      },
    };
  };

  const providers: Record<string, AnalysisLayerProvider> = {};
  for (const l of LAYERS) {
    const meta = ANALYSIS_META[l.key];
    if (!meta) {
      continue;   // imagery layers carry no value cells
    }
    providers[l.key] = {
      unit: meta.unit,
      relative: meta.relative,
      overLand: l.overLand,
      description: l.legend,
      coverage: { start: meta.start },
      caveats: meta.caveats,
      convert: meta.convert,
      async getFrames(range, stepMonths) {
        const c = collector(range);
        if (l.bakedStack) {
          try {
            (await GriddedField.loadBakedStack(device, l.bakedStack.pngUrl, l.bakedStack.metaUrl, { everyMonths: Math.max(1, Math.round(stepMonths)) })).forEach(c.keep);
          } catch { /* live frames below */ }
        }
        if (l.source) {
          const dates = monthList(range, stepMonths).filter((d) => !c.seen.has(ym(d)));
          await streamPool(dates, 3, async (d) => {
            try {
              const flip = isGfs(l.source!) ? await gfsLatFlipped(`${d}T12:00:00Z`) : false;
              c.keep(await GriddedField.loadScalar(device, routeByDate(l.source!, d), { timeSel: `(${d}T12:00:00Z)`, stride: strideFor(l.source!, 4), flipLat: flip }));
            } catch { /* skip a failed month */ }
          });
        }
        return c.out;
      },
    };
  }
  // Fishing effort needs its own provider: the generic path above materializes from a ScalarSource or
  // a baked atlas, and this layer has neither — it comes from decoded vector tiles, one request per
  // tile per YEAR that already contains all twelve months.
  providers.fishing = {
    unit: 'h',
    description: 'apparent fishing effort (Global Fishing Watch, AIS-derived)',
    coverage: { start: '2012-01' },
    caveats: ANALYSIS_META.fishing?.caveats,
    sharedFrames: true,   // the loader caches these; the store must not destroy them
    async getFrames(range) {
      const y0 = parseInt(range.start.slice(0, 4), 10);
      const y1 = parseInt(range.end.slice(0, 4), 10);
      const out: GriddedField[] = [];
      for (let y = y0; y <= y1; y++) {
        try {
          const frames = await loadGfwEffortStack(device, { year: y, zoom: 2 });
          for (const f of frames) {
            if (f.meta.date.slice(0, 7) >= range.start && f.meta.date.slice(0, 7) <= range.end) {
              out.push(f);
            }
          }
        } catch { /* a year GFW has no data for, or a rejected token: skip it */ }
      }
      return out;
    },
  };
  providers.wind = {
    unit: 'mps', vector: true, description: 'NOAA GFS 10 m wind', coverage: { start: '2022-12' },
    async getFrames(range, stepMonths) {
      const c = collector(range);
      await streamPool(monthList(range, stepMonths), 3, async (d) => {
        try {
          const flip = await gfsLatFlipped(`${d}T12:00:00Z`);
          c.keep(await GriddedField.loadVector(device, WIND_SOURCE, { timeSel: `(${d}T12:00:00Z)`, stride: 3, flipLat: flip, retainCells: true }));
        } catch { /* skip a failed month */ }
      });
      return c.out;
    },
  };
  providers.currents = {
    unit: 'mps', vector: true, description: 'ocean surface currents (baked AVISO)', coverage: { start: '2020-01' },
    async getFrames(range, stepMonths) {
      const c = collector(range);
      (await GriddedField.loadBakedStack(device, currentsStackPngUrl, currentsStackMetaUrl, { everyMonths: stepMonths, retainCells: true })).forEach(c.keep);
      return c.out;
    },
  };
  return providers;
}

/** The monthly ONI record as an analysis series (`enso` source nodes). */
async function loadOniSeries(): Promise<SeriesValue> {
  let months: EnsoMonth[] = [];
  try {
    const baked = parseBakedEnso(await (await fetch(ensoJsonUrl)).json() as EnsoBakedJson);
    const since = baked.length ? baked[baked.length - 1].month : '2020-03';
    months = mergeEnsoMonths(baked, await fetchNino34Live(since).catch(() => []));
  } catch {
    months = await fetchNino34Live('2020-03').catch(() => []);
  }
  const seasons = oniSeasons(months.filter((m) => m.month < currentUtcMonth()));
  return {
    t: new Float64Array(seasons.map((s) => Date.parse(`${s.month}-15T12:00:00Z`))),
    v: new Float64Array(seasons.map((s) => s.oni)),
    unit: 'degC',
    relative: true,
    label: 'ONI',
  };
}

const SHADER = /* wgsl */ `
const PI = 3.14159265359;

struct U {
  p0  : vec4<f32>,   // resX, resY, frameBlend (0..1), imageryMode (RGB layer, no LUT)
  p1  : vec4<f32>,   // contourBands, showContours, mode (0 flat / 1 globe), fieldWidth
  pad : vec4<f32>,   // relief exaggeration (0 = smooth sphere), overLand (GFS layers), sparse, dataAlpha
  bg  : vec4<f32>,   // letterbox / background color rgb, sunOn (day/night terminator)
  rot : vec4<f32>,   // globe yaw, globe pitch (tilt), subsolar lon (rad), subsolar lat (rad)
  ov  : vec4<f32>,   // currentsOn, windOn, ensoBoxOn, radarOn
  view: vec4<f32>,   // view center u, view center v, zoom (1 = whole world), flat projection mode
  win0: vec4<f32>,   // detail window rect: u0, v0, 1/spanU, 1/spanV (1/spanU = 0 → no window)
  lin0: vec4<f32>,   // deep-zoom linearized view: screen-center uv hi.xy + lo.xy (f32-split)
  lin1: vec4<f32>,   // deep-zoom Jacobian d(uv)/d(fuv): x column .xy, y column .zw
  lay2: vec4<f32>,   // OVERLAY layer: iso-line count (0 = no overlay), hatch threshold (normalized;
                     // ≥2 never hatches), hatch on, line/hatch strength
  cam0: vec4<f32>,   // EARTH mode camera: eye position in unit-sphere space, tan(half vertical fov)
  cam1: vec4<f32>,   // forward (unit), unused
  cam2: vec4<f32>,   // right (unit), unused
  cam3: vec4<f32>,   // up (unit), unused
  sig : vec4<f32>,   // significance stipple: on (0/1), dot spacing px, dot radius (0..0.5), darkening
  ovw : vec4<f32>,   // annotation-overlay window: u0, v0, 1/du, 1/dv (full world = 0,0,1,1)
  scl : vec4<f32>,   // display range remap: normalized offset, 1/normalized width, discrete levels
                     // (0 = continuous), unused. Identity = (0, 1, 0, 0)
  cmp : vec4<f32>,   // A/B compare: on (0/1), divider x in pixels, unused, unused
  flw : vec4<f32>,   // particle-trail window (currents + wind share it): u0, v0, 1/spanU, 1/spanV
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var fieldTex : texture_2d<f32>;   // r = normalized value, a = valid mask,
                                                        // b = "failed its significance test" flag
                                                        // (analysis displays only; see u.sig.x)
@group(0) @binding(2) var lut      : texture_2d<f32>;
@group(0) @binding(3) var samp     : sampler;
@group(0) @binding(4) var baseTex  : texture_2d<f32>;   // rgb = land basemap, a = land mask
@group(0) @binding(5) var trailCur : texture_2d<f32>;   // currents particle trails (equirect)
@group(0) @binding(6) var trailWnd : texture_2d<f32>;   // wind particle trails (equirect)
@group(0) @binding(7) var fieldNxt : texture_2d<f32>;   // next time-lapse frame (crossfade target)
@group(0) @binding(8) var topoTex  : texture_2d<f32>;   // ETOPO relief, 16-bit packed in R(hi)/G(lo)
@group(0) @binding(9) var radarTex : texture_2d<f32>;   // RainViewer radar, straight alpha (equirect)
@group(0) @binding(10) var nightTex : texture_2d<f32>;  // night basemap (city lights over black)
@group(0) @binding(11) var analysisVec : texture_2d<f32>;  // analysis arrow overlay, straight alpha (equirect); transparent 1×1 when unused
@group(0) @binding(12) var winTex : texture_2d<f32>;    // streamed detail window (equirect crop of Blue Marble / aerial tiles); 1×1 transparent when off
@group(0) @binding(13) var fieldTex2 : texture_2d<f32>; // OVERLAY layer's value field; 1×1 transparent when no overlay (or no frame paired to this date)
@group(0) @binding(14) var lut2 : texture_2d<f32>;      // overlay layer's colormap — tints its iso-lines so they match its own legend
@group(0) @binding(15) var geomTex : texture_2d<f32>;   // user-drawn point/line/area, straight alpha (equirect); transparent 1×1 when nothing is drawn
@group(0) @binding(16) var trackTex : texture_2d<f32>;  // ATN animal tracks, straight alpha (equirect); transparent 1×1 when none loaded
@group(0) @binding(17) var stormTex : texture_2d<f32>;  // tropical-cyclone tracks/cone/alerts, straight alpha (equirect); transparent 1×1 when the overlay is off
@group(0) @binding(18) var fireTex : texture_2d<f32>;   // wildfire perimeters/hotspots/forest units, straight alpha (equirect)
@group(0) @binding(19) var adminTex : texture_2d<f32>;  // country/state boundary lines + city labels, straight alpha (equirect)

/**
 * Samples an annotation overlay through its window rect.
 *
 * The three annotation rasters (drawn geometry, animal tracks, analysis arrows) no longer cover the
 * whole world — they cover the visible rect, so their texels land where the user is looking instead
 * of being spread evenly over the planet. Outside the window they contribute nothing: the shared
 * sampler WRAPS in u, so an out-of-range fetch would smear the overlay's edge across the map rather
 * than falling off it.
 */
/**
 * Samples a particle-trail raster through the flow window.
 *
 * Same remap as {@link overlaySample}, with one difference that matters: the trail rasters are
 * ADDITIVE, so a fetch outside the window must return zero rather than the wrapped edge — an
 * out-of-range sample would otherwise smear the window's border streaks across the rest of the map
 * as light, not just as a stray annotation.
 */
fn flowSample(t : texture_2d<f32>, uv : vec2<f32>) -> vec4<f32> {
  let q = vec2<f32>(fract(uv.x - u.flw.x) * u.flw.z, (uv.y - u.flw.y) * u.flw.w);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    return vec4<f32>(0.0);
  }
  return textureSampleLevel(t, samp, q, 0.0);
}

fn overlaySample(t : texture_2d<f32>, uv : vec2<f32>) -> vec4<f32> {
  let q = vec2<f32>(fract(uv.x - u.ovw.x) * u.ovw.z, (uv.y - u.ovw.y) * u.ovw.w);
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  return textureSampleLevel(t, samp, q, 0.0);
}

// ── ETOPO heightfield (packed by tools/geo/bake_topo.mjs) ───────────────────────────
const TOPO_MIN_M = -11000.0;
const TOPO_SPAN_M = 20000.0;
const EARTH_R_M = 6371000.0;

fn decodeTopo(c : vec4<f32>) -> f32 {
  return TOPO_MIN_M + ((c.r * 65280.0 + c.g * 255.0) / 65535.0) * TOPO_SPAN_M;
}

// Manual bilinear via textureLoad: the two packed bytes must be decoded BEFORE filtering (a
// hardware linear fetch would blend hi/lo bytes independently and ripple at low-byte wraps).
fn topoMeters(tuv : vec2<f32>) -> f32 {
  let dims = vec2<f32>(textureDimensions(topoTex));
  let fx = clamp(tuv.x, 0.0, 1.0) * (dims.x - 1.0);
  let fy = clamp(tuv.y, 0.0, 1.0) * (dims.y - 1.0);
  let x0 = i32(fx); let y0 = i32(fy);
  let x1 = min(x0 + 1, i32(dims.x) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let h00 = decodeTopo(textureLoad(topoTex, vec2<i32>(x0, y0), 0));
  let h10 = decodeTopo(textureLoad(topoTex, vec2<i32>(x1, y0), 0));
  let h01 = decodeTopo(textureLoad(topoTex, vec2<i32>(x0, y1), 0));
  let h11 = decodeTopo(textureLoad(topoTex, vec2<i32>(x1, y1), 0));
  return mix(mix(h00, h10, fract(fx)), mix(h01, h11, fract(fx)), fract(fy));
}

fn dirToUv(dirN : vec3<f32>) -> vec2<f32> {
  let lon = atan2(dirN.x, dirN.z);
  let lat = asin(clamp(dirN.y, -1.0, 1.0));
  return vec2<f32>(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}

/** Land height (ocean = 0) in unit-sphere radii, before exaggeration. */
fn terrainH(dirN : vec3<f32>) -> f32 {
  return max(topoMeters(dirToUv(dirN)), 0.0) / EARTH_R_M;
}

@vertex
fn vs(@builtin(vertex_index) vid : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[vid], 0.0, 1.0);
}

fn rotX(v : vec3<f32>, a : f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}
fn rotY(v : vec3<f32>, a : f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

// ── Flat map projections (KEEP IN SYNC with samples/geo_projections.ts) ─────────────
// mode: 0 equirect, 1 Mercator, 2 Mollweide, 3 Equal Earth, 4 Arctic, 5 Antarctic.
// Only the INVERSE is needed: each pixel walks plane → (lon, lat) → the shared equirect
// uv that mapColor composites, so every layer/overlay works in every projection.

fn projHalfExtents(mode : i32) -> vec2<f32> {
  if (mode == 1) { return vec2<f32>(PI, PI); }                 // Mercator, to ±85.05°
  if (mode == 2) { return vec2<f32>(2.8284271, 1.4142136); }   // Mollweide: 2√2 × √2
  if (mode == 3) { return vec2<f32>(2.7066297, 1.3180374); }   // Equal Earth
  if (mode >= 4) { return vec2<f32>(2.0, 2.0); }               // polar stereographic, to the equator
  return vec2<f32>(PI, PI * 0.5);                              // equirect
}

/** Inverse projection: plane point → (lon, lat, valid). */
fn invProject(mode : i32, p : vec2<f32>) -> vec3<f32> {
  if (mode == 1) {   // Mercator
    let lat = 2.0 * atan(exp(p.y)) - PI * 0.5;
    return vec3<f32>(p.x, lat, select(0.0, 1.0, abs(p.y) <= PI + 1e-5));
  }
  if (mode == 2) {   // Mollweide
    let sy = p.y / 1.4142136;
    if (abs(sy) > 1.0) { return vec3<f32>(0.0); }
    let theta = asin(clamp(sy, -1.0, 1.0));
    let sphi = clamp((2.0 * theta + sin(2.0 * theta)) / PI, -1.0, 1.0);
    let ct = cos(theta);
    if (ct < 1e-6) {   // the poles are single points on the ellipse rim
      return vec3<f32>(0.0, sign(p.y) * PI * 0.5, select(0.0, 1.0, abs(p.x) < 1e-3));
    }
    let lon = PI * p.x / (2.8284271 * ct);
    return vec3<f32>(lon, asin(sphi), select(0.0, 1.0, abs(lon) <= PI + 1e-5));
  }
  if (mode == 3) {   // Equal Earth — Newton-solve θ from y, then λ from x
    var t = p.y / 1.340264;
    for (var i = 0; i < 4; i = i + 1) {
      let t2 = t * t;
      let f = t * (1.340264 + t2 * (-0.081106 + t2 * t2 * (0.000893 + 0.003796 * t2))) - p.y;
      let fp = 1.340264 + t2 * (-0.243318 + t2 * t2 * (0.006251 + 0.034164 * t2));
      t = t - f / fp;
    }
    if (abs(t) > PI / 3.0 + 1e-4) { return vec3<f32>(0.0); }
    let sphi = sin(t) / 0.8660254;
    if (abs(sphi) > 1.0) { return vec3<f32>(0.0); }
    let t2 = t * t;
    let dy = 1.340264 + t2 * (-0.243318 + t2 * t2 * (0.006251 + 0.034164 * t2));
    let lon = p.x * 0.8660254 * dy / cos(t);
    return vec3<f32>(lon, asin(clamp(sphi, -1.0, 1.0)), select(0.0, 1.0, abs(lon) <= PI + 1e-5));
  }
  if (mode >= 4) {   // polar stereographic (4 = Arctic, Greenwich down; 5 = Antarctic, Greenwich up)
    let rho = length(p);
    if (rho > 2.0) { return vec3<f32>(0.0); }
    let c = 2.0 * atan(rho * 0.5);
    if (mode == 4) { return vec3<f32>(atan2(p.x, -p.y), PI * 0.5 - c, 1.0); }
    return vec3<f32>(atan2(p.x, p.y), c - PI * 0.5, 1.0);
  }
  return vec3<f32>(p.x, p.y, 1.0);   // equirect: the plane IS (lon, lat)
}

// Composite the base layer + basemap land + iso-contours at an equirect uv. Called
// UNCONDITIONALLY from fs (uniform control flow) so its derivatives are legal.
// wuv is the detail-window sample coordinate (see fs; anything outside [0,1]² is "no window").
fn mapColor(uv : vec2<f32>, wuv : vec2<f32>, fp : vec2<f32>) -> vec3<f32> {
  // Crossfade the current time-lapse frame into the next so dates ease in instead of snapping.
  let sA = textureSampleLevel(fieldTex, samp, uv, 0.0);
  let sB = textureSampleLevel(fieldNxt, samp, uv, 0.0);
  // A/B compare reuses the crossfade's second texture: instead of easing between the two frames it
  // takes one or the other by which side of the divider the pixel is on. Two dates then share one
  // projection, one color scale and one set of coastlines, which is the only way a difference this
  // subtle can be judged by eye — flipping between two screenshots cannot do it.
  var blend = u.p0.z;
  if (u.cmp.x > 0.5) {
    blend = select(0.0, 1.0, fp.x > u.cmp.y);
  }
  let s = mix(sA, sB, blend);                                   // r = normalized value, a = mask
  // Wrap-safe derivatives: uv.x jumps 0↔1 at the ±180° seam, which polar/pseudocylindrical
  // projections place mid-screen — take the smaller of the direct and half-shifted
  // derivative so the seam column doesn't get blasted to the smallest basemap mip.
  let ux2 = fract(uv.x + 0.5);
  let du = vec2<f32>(min(abs(dpdx(uv.x)), abs(dpdx(ux2))), dpdx(uv.y));
  let dv = vec2<f32>(min(abs(dpdy(uv.x)), abs(dpdy(ux2))), dpdy(uv.y));
  let lod = max(0.0, 0.5 * log2(max(dot(du, du), dot(dv, dv)) * 2048.0 * 2048.0));
  let bm = textureSampleLevel(baseTex, samp, uv, lod);          // rgb = land, a = land mask
  let landMask = smoothstep(0.35, 0.65, bm.a);
  // Streamed detail window (Blue Marble / aerial tiles): overrides the basemap COLOR where it
  // covers — the land mask and every data path stay on the global textures, so this is purely
  // cosmetic sharpening. Alpha-0 texels are tile-fetch holes → keep the global fallback.
  var bmc = bm.rgb;
  if (u.win0.z > 0.0 && all(wuv >= vec2<f32>(0.0)) && all(wuv <= vec2<f32>(1.0))) {
    let w = textureSampleLevel(winTex, samp, wuv, 0.0);
    bmc = mix(bmc, w.rgb, step(0.5, w.a));
  }
  var col : vec3<f32>;

  if (u.p0.w > 0.5) {
    // IMAGERY layer (satellite RGB, pre-rendered upstream): the field texture IS the color.
    // Uncovered pixels (alpha 0 — e.g. the GOES composite's Asia gap) fall back to a dim basemap.
    col = mix(bmc * 0.35, s.rgb, smoothstep(0.25, 0.6, s.a));
  } else {
    // VALUE layer: paint through the colormap LUT.
    // Masked cells store value 0, so a plain bilinear fetch bleeds 0 into valid neighbors and rings
    // every hole/coast with a dark halo. The sampled value is effectively PREMULTIPLIED by the
    // sampled mask — dividing by alpha recovers the coverage-weighted mean of the valid neighbors.
    var val = s.r / max(s.a, 0.25);
    var hasData = s.a >= 0.5;
    // The data grid is coarser than the basemap coastline, so a fringe of ocean has no data cell
    // (alpha 0) where the basemap already says "ocean". Flood the nearest valid value into that ring
    // so the false-color reaches the coast instead of showing the basemap's dark water as a halo.
    // SPARSE feeds opt out: theirs are large genuine holes (Coral Reef Watch masks every sea-ice
    // cell), and an 8-direction search across one invents star-shaped spikes of extreme heat stress
    // in ocean that simply has no measurement — worse than the dark halo this fixes.
    if (!hasData && landMask < 0.6 && u.pad.z < 0.5) {
      let tx = 1.0 / max(u.p1.w, 1.0);
      var sum = 0.0; var cnt = 0.0;
      for (var r = 1; r <= 4; r = r + 1) {
        let d = f32(r) * tx;
        for (var k = 0; k < 8; k = k + 1) {
          let ang = f32(k) * 0.785398163;
          let sn = textureSampleLevel(fieldTex, samp, uv + vec2<f32>(cos(ang) * d, sin(ang) * 2.0 * d), 0.0);
          if (sn.a >= 0.5) { sum = sum + sn.r / sn.a; cnt = cnt + 1.0; }
        }
        if (cnt > 0.0) { break; }
      }
      if (cnt > 0.0) { val = sum / cnt; hasData = true; }
    }
    // Sparse fields (rain): the scale's floor means "nothing here" — show the background, not the
    // colormap's bottom color smeared across the whole world.
    if (u.pad.z > 0.5 && val < 0.02) {
      hasData = false;
    }

    // Display-range remap. Values are byte-encoded over the LAYER's native range at fetch time, so
    // narrowing the scale has to happen here rather than by refetching: shift the normalized value
    // by where the display minimum sits and rescale by the window's width. Everything below —
    // contours, the LUT lookup, the stipple — then works in display units.
    //
    // Applied AFTER the sparse test above, which is written against the raw encoding: remapping
    // first would move the "nothing here" floor and flood empty ocean with color.
    val = (val - u.scl.x) * u.scl.y;
    // Discrete levels: quantize to band centers so a reader can count steps instead of estimating a
    // gradient. A zero level count leaves it continuous.
    if (u.scl.z > 0.5) {
      val = (floor(clamp(val, 0.0, 0.9999) * u.scl.z) + 0.5) / u.scl.z;
    }
    // Clamp to the LUT's half-texel: the shared sampler wraps in u (for equirect longitude), so a
    // value of exactly 1.0 would otherwise blend the LUT's two ENDS together (yellow+purple = tan).
    var shaded = textureSampleLevel(lut, samp, vec2<f32>(clamp(val, 0.002, 0.998), 0.5), 0.0).rgb;
    if (u.p1.y > 0.5) {
      let ph = val * u.p1.x;                                     // iso-contours in normalized units
      let aa = max(fwidth(ph), 1e-4) * 1.5;
      let line = 1.0 - smoothstep(0.0, aa, min(fract(ph), 1.0 - fract(ph)));
      let coast = smoothstep(0.80, 0.99, s.a);                  // fade lines in the filled ring
      shaded = mix(shaded, shaded * 0.12, line * coast);
    }
    // Significance stipple. An analysis result whose per-cell test failed keeps its VALUE — the
    // estimate exists, the evidence for it is weak — and gets a dot screen instead. Blanking it
    // would be indistinguishable from missing data and would throw the estimate away; desaturating
    // it would be worse still on the diverging colormap these results use, because washing a cell
    // toward the pale midpoint reads as "near zero", which is a claim about the value rather than
    // about the confidence in it.
    //
    // Dots are phased in SCREEN space, so their spacing stays constant while zooming — the same
    // reasoning as the overlay's hatch above. No derivatives here, so it is safe under the
    // per-pixel term.
    if (u.sig.x > 0.5) {
      let flagged = smoothstep(0.35, 0.65, s.b / max(s.a, 0.25));
      let cell = fract(fp / max(u.sig.y, 2.0)) - 0.5;
      let dots = 1.0 - smoothstep(u.sig.z * 0.75, u.sig.z, length(cell));
      shaded = mix(shaded, shaded * (1.0 - u.sig.w), dots * flagged);
    }
    // Ocean with no data (a feed's coverage gap — e.g. WaveWatch beyond ±77°, or cloud holes) reads
    // as a clean deep "no-coverage" tone rather than the basemap's speckly dark water.
    var dataCol = select(vec3<f32>(0.02, 0.05, 0.10), shaded, hasData);
    // Atmosphere layers cover land too. Keep the geography readable underneath: modulate the
    // data color by the basemap's luminance over land (terrain texture shows through, like a
    // tinted shaded-relief map), blend toward the basemap by the user's opacity slider, and etch
    // the coastline (landMask·(1−landMask) peaks at the land/sea edge).
    var lm = landMask;
    if (u.pad.y > 0.5 && hasData) {
      lm = 0.0;
      let terr = dot(bmc, vec3<f32>(0.299, 0.587, 0.114));
      let shade = mix(1.0, clamp(0.55 + 1.1 * terr, 0.55, 1.25), landMask);
      dataCol = mix(bmc, dataCol * shade, u.pad.w);
      let coastline = landMask * (1.0 - landMask) * 4.0;
      dataCol = dataCol * (1.0 - coastline * 0.45);
    }
    col = mix(dataCol, bmc, lm);
  }

  // Additive particle-trail overlays (currents / wind) — trails live only over ocean. Both rasters
  // cover the flow window (the whole world zoomed out, the visible rect zoomed in), so they are
  // sampled through it exactly like the annotation overlays; outside it there is nothing to add.
  let ocMask = (1.0 - landMask);
  if (u.ov.x > 0.5) { col += flowSample(trailCur, uv).rgb * ocMask; }
  if (u.ov.y > 0.5) { col += flowSample(trailWnd, uv).rgb; }
  // Radar echoes (RainViewer) alpha-blend over everything below the annotations.
  if (u.ov.w > 0.5) {
    let rd = textureSampleLevel(radarTex, samp, uv, 0.0);
    col = mix(col, rd.rgb, rd.a * 0.85);
  }

  // Day/night: darken toward the real sun's terminator (subsolar point in rot.zw, driven by the
  // map's CURRENT time, so the shadow follows the time-lapse) and glow the night basemap's city
  // lights in the dark. Twilight band ≈ ±7° of solar zenith around the terminator.
  if (u.bg.w > 0.5) {
    let latF = (0.5 - uv.y) * PI;
    let lonF = (uv.x - 0.5) * 2.0 * PI;
    let cosZ = sin(latF) * sin(u.rot.w) + cos(latF) * cos(u.rot.w) * cos(lonF - u.rot.z);
    let day = smoothstep(-0.12, 0.12, cosZ);
    let lights = textureSampleLevel(nightTex, samp, uv, 0.0).rgb;
    col = col * mix(0.2, 1.0, day) + lights * (1.0 - day) * 1.15;
  }

  // ── Overlay layer: a SECOND field over the filled base ──────────────────────────────
  // Area color is already spent on the base layer, so the overlay takes the channels that are
  // still free: line geometry and texture. It draws as iso-lines tinted by its OWN colormap (so
  // they read against its own legend), plus optional diagonal hatching above a threshold — for
  // alert-style fields (bleaching level, heat stress, the ice edge) "which side of this line" is
  // the question, and a filled zone answers it better than nested contours do.
  //
  // Every derivative here sits under the UNIFORM u.lay2.x test, never under the per-pixel mask
  // test, because fwidth() in non-uniform control flow is undefined. The mask only gates the final
  // blend. Hatching is phased in SCREEN space so stroke spacing stays constant while zooming.
  if (u.lay2.x > 0.5) {
    let o = textureSampleLevel(fieldTex2, samp, uv, 0.0);
    let ov = o.r / max(o.a, 0.25);
    let ph = ov * u.lay2.x;
    let aa = max(fwidth(ph), 1e-4) * 1.5;
    var line = 1.0 - smoothstep(0.0, aa, min(fract(ph), 1.0 - fract(ph)));
    // Suppress the level at value 0: a sparse overlay (heat stress, rainfall) is zero across most
    // of the world, and its zeroth contour would otherwise flood every empty cell with line.
    line = line * step(0.5, round(ph));
    let hatchPhase = (fp.x + fp.y) * 0.16;
    let hatch = select(0.0, smoothstep(0.5, 0.95, abs(sin(hatchPhase))) * 0.42,
                       u.lay2.z > 0.5 && ov >= u.lay2.y);
    let tint = textureSampleLevel(lut2, samp, vec2<f32>(clamp(ov, 0.002, 0.998), 0.5), 0.0).rgb;
    // Require nearly-full coverage: a half-covered texel at a coast ramps through several levels
    // and would ring every shoreline with spurious contours.
    let solid = select(0.0, 1.0, o.a >= 0.85);
    col = mix(col, tint, clamp(line * 0.95 + hatch, 0.0, 1.0) * u.lay2.w * solid);
  }

  // Analysis vector arrows (displayVectors sink) — drawn in equirect texture space, so they ride
  // the same uv as every overlay and work in all projections and on the globe. Composited after
  // day/night so they stay readable at night.
  let av = overlaySample(analysisVec, uv);
  col = mix(col, av.rgb, av.a);

  // Animal tracks, then user-drawn geometry: both are annotations about the map rather than part of
  // it, so they sit above every data layer and stay legible over any colormap, at night, and on the
  // globe. Drawn geometry goes last because it is what the user is actively working with.
  // Reference geometry first: boundaries and city labels are the frame everything else is read
  // against, so they go UNDER the event overlays — a fire perimeter must never be cut by a state
  // line drawn on top of it.
  let ad = overlaySample(adminTex, uv);
  col = mix(col, ad.rgb, ad.a);
  let tk = overlaySample(trackTex, uv);
  col = mix(col, tk.rgb, tk.a);
  // Cyclones and fires sit above the animal tracks: during a live event this is the thing being
  // looked at, and an official graphic that anything else can hide is worse than useless.
  let st = overlaySample(stormTex, uv);
  col = mix(col, st.rgb, st.a);
  let fr = overlaySample(fireTex, uv);
  col = mix(col, fr.rgb, fr.a);
  let gm = overlaySample(geomTex, uv);
  col = mix(col, gm.rgb, gm.a);

  // Niño 3.4 box outline (ENSO panel open): 5°S–5°N, 170°W–120°W. Screen-width lines via fwidth,
  // in uv space so the box tracks the globe as it rotates.
  if (u.ov.z > 0.5) {
    let b0 = vec2<f32>(-170.0 / 360.0 + 0.5, 0.5 - 5.0 / 180.0);
    let b1 = vec2<f32>(-120.0 / 360.0 + 0.5, 0.5 + 5.0 / 180.0);
    // Wrap-safe width: uv.x jumps 0↔1 at the ±180° seam, and a raw fwidth(uv).x there is ~1, which
    // passes the edge test for a whole column (a stray vertical line west of the box).
    let ux2 = fract(uv.x + 0.5);
    let fwX = min(abs(dpdx(uv.x)), abs(dpdx(ux2))) + min(abs(dpdy(uv.x)), abs(dpdy(ux2)));
    let w = max(vec2<f32>(fwX, fwidth(uv.y)) * 1.2, vec2<f32>(4e-4));
    let onX = min(abs(uv.x - b0.x), abs(uv.x - b1.x)) <= w.x && uv.y >= b0.y - w.y && uv.y <= b1.y + w.y;
    let onY = min(abs(uv.y - b0.y), abs(uv.y - b1.y)) <= w.y && uv.x >= b0.x - w.x && uv.x <= b1.x + w.x;
    if (onX || onY) {
      col = mix(col, vec3<f32>(1.0, 0.9, 0.35), 0.85);
    }
  }
  return col;
}

@fragment
fn fs(@builtin(position) fc : vec4<f32>) -> @location(0) vec4<f32> {
  let res = u.p0.xy;
  let p = fc.xy / res;
  var uv : vec2<f32>;
  var wuv = vec2<f32>(-1.0);   // detail-window sample coord; outside [0,1]² = no window
  var inView : bool;
  if (u.p1.z > 1.5) {
    // ── EARTH: perspective camera over a ray-marched terrain shell ────────────────────
    // Google-Earth-style navigation on the SAME heightfield the orthographic globe marches. The only
    // real difference is where rays come from: parallel rays down the view axis become rays diverging
    // from an eye point, which is what buys oblique views, a horizon, and terrain parallax.
    //
    // A general ray needs a general intersection, so instead of the orthographic path's "start at the
    // shell's front face and walk -z", this solves ray/sphere analytically for the outer shell and
    // (when hit) the sea-level sphere, then marches only the span between them.
    let aspect = res.x / res.y;
    var q = (p - vec2<f32>(0.5)) * 2.0;
    q.y = -q.y;
    let ro = u.cam0.xyz;
    let rd = normalize(u.cam1.xyz + u.cam2.xyz * (q.x * aspect * u.cam0.w) + u.cam3.xyz * (q.y * u.cam0.w));
    let ex = u.pad.x;
    let hMax = max(ex * (9000.0 / EARTH_R_M), 1e-5);
    let rOut = 1.0 + hMax;
    let b = dot(ro, rd);
    let cOut = dot(ro, ro) - rOut * rOut;
    let discOut = b * b - cOut;
    inView = false;
    var dir3 : vec3<f32> = normalize(ro);
    if (discOut > 0.0) {
      let sOut = sqrt(discOut);
      var t0 = max(-b - sOut, 0.0);
      var t1 = -b + sOut;
      // Stop at sea level when the ray reaches it: everything below is opaque ocean floor.
      let cIn = dot(ro, ro) - 1.0;
      let discIn = b * b - cIn;
      var hitSea = false;
      if (discIn > 0.0) {
        let tSea = -b - sqrt(discIn);
        if (tSea > t0) {
          t1 = min(t1, tSea);
          hitSea = true;
        }
      }
      if (t1 > t0) {
        var hitT = -1.0;
        var tPrev = t0;
        // Terrain can only be crossed while inside the shell; 64 steps over that span keeps the
        // silhouette clean at grazing angles without making a straight-down view expensive.
        for (var i = 1; i <= 64; i = i + 1) {
          let t = t0 + (f32(i) / 64.0) * (t1 - t0);
          let pp = ro + rd * t;
          if (length(pp) <= 1.0 + terrainH(normalize(pp)) * ex) {
            var a = tPrev;
            var bb = t;
            for (var k = 0; k < 6; k = k + 1) {
              let m = 0.5 * (a + bb);
              let pm = ro + rd * m;
              if (length(pm) <= 1.0 + terrainH(normalize(pm)) * ex) { bb = m; } else { a = m; }
            }
            hitT = bb;
            break;
          }
          tPrev = t;
        }
        if (hitT < 0.0 && hitSea) {
          hitT = t1;                     // straight to the sea surface
        }
        if (hitT >= 0.0) {
          inView = true;
          dir3 = normalize(ro + rd * hitT);
        }
      }
    }
    uv = dirToUv(dir3);
    wuv = vec2<f32>(-1.0);
  } else if (u.p1.z > 0.5) {
    // Globe preview: orthographic sphere, rotated by yaw + tilt. With relief on (pad.x > 0) the
    // surface is the ETOPO heightfield sphere-traced through a thin shell, so mountain ranges get
    // true limb silhouettes and perspective parallax as the globe turns; relief 0 falls back to
    // the analytic sphere. Color stays flat/unshaded (physical LED globe) apart from a subtle
    // slope hillshade on land applied below.
    let aspect = res.x / res.y;
    var q = (p - vec2<f32>(0.5)) * 2.0;
    q.x = q.x * aspect;
    q = q / (1.12 * u.view.z);   // wheel zoom scales the orthographic globe
    q.y = -q.y;
    let r2 = dot(q, q);
    let ex = u.pad.x;
    let hMax = ex * (9000.0 / EARTH_R_M);        // tallest possible terrain, in radii
    var dir3 : vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
    if (ex <= 0.0) {
      inView = r2 <= 1.0;
      let z = sqrt(max(0.0, 1.0 - r2));
      dir3 = rotY(rotX(normalize(vec3<f32>(q.x, q.y, z)), u.rot.y), u.rot.x);
    } else {
      let rOut = 1.0 + hMax;
      let rr = rOut * rOut;
      inView = r2 <= rr;
      if (inView) {
        // March the (rotated) view ray through the terrain shell. Rays that reach the inner unit
        // sphere always hit (ocean); rays grazing the limb may pass through untouched → sky.
        let z0 = sqrt(max(0.0, rr - r2));
        let o = rotY(rotX(vec3<f32>(q.x, q.y, z0), u.rot.y), u.rot.x);
        let d = rotY(rotX(vec3<f32>(0.0, 0.0, -1.0), u.rot.y), u.rot.x);
        var tEnd = 2.0 * z0;
        if (r2 <= 1.0) {
          tEnd = z0 - sqrt(max(0.0, 1.0 - r2)) + 0.002;   // stop just past the sea-level surface
        }
        var hitT = -1.0;
        var tPrev = 0.0;
        for (var i = 1; i <= 48; i = i + 1) {
          let t = (f32(i) / 48.0) * tEnd;
          let pp = o + d * t;
          if (length(pp) <= 1.0 + terrainH(normalize(pp)) * ex) {
            var a = tPrev;
            var b = t;
            for (var k = 0; k < 5; k = k + 1) {          // binary refine the crossing
              let m = 0.5 * (a + b);
              let pm = o + d * m;
              if (length(pm) <= 1.0 + terrainH(normalize(pm)) * ex) { b = m; } else { a = m; }
            }
            hitT = b;
            break;
          }
          tPrev = t;
        }
        inView = hitT >= 0.0;
        dir3 = normalize(o + d * max(hitT, 0.0));
      }
    }
    uv = dirToUv(dir3);
    // The detail window is an equirect crop, so the globe samples it by uv like any overlay
    // (globe zoom stays within plain-f32 range — no linearized path needed here).
    wuv = vec2<f32>(fract(uv.x - u.win0.x) * u.win0.z, (uv.y - u.win0.y) * u.win0.w);
  } else {
    let mode = i32(u.view.w + 0.5);
    let ext = projHalfExtents(mode);
    let mapA = ext.x / ext.y;
    let canvasA = res.x / res.y;
    var fuv = p;
    if (canvasA > mapA) {
      let sc = mapA / canvasA;
      fuv.x = (p.x - 0.5) / sc + 0.5;
    } else {
      let sc = canvasA / mapA;
      fuv.y = (p.y - 0.5) / sc + 0.5;
    }
    // Zoom/pan: view.xy is the map-frame point under the screen center, view.z the zoom.
    // The map frame [0,1]² spans the projection's world bounds; cylindrical modes wrap
    // longitude once zoomed in, at zoom 1 the whole-world letterbox applies.
    let duv = fuv - vec2<f32>(0.5);
    if (u.view.z >= 2048.0) {
      // Deep zoom: the per-pixel uv step falls below f32's ulp on the absolute transform, so
      // the CPU supplies the screen-center uv (split into an exact f32 hi part + residual lo)
      // and the projection's Jacobian, and each pixel walks a well-conditioned local linear
      // model instead — every projection is locally affine at this scale. The window coord is
      // built from the same small terms: (uvcHi − w0) is an exact f32 subtraction of nearby
      // values, so no cancellation. KEEP IN SYNC with fillDeepZoomUniforms().
      let uvRel = u.lin0.zw + u.lin1.xy * duv.x + u.lin1.zw * duv.y;
      uv = vec2<f32>(fract(u.lin0.x + uvRel.x), clamp(u.lin0.y + uvRel.y, 0.0, 1.0));
      wuv = (u.lin0.xy - u.win0.xy + uvRel) * u.win0.zw;
      // A zero Jacobian means the CPU couldn't linearize here (view center off the projection
      // shape, e.g. a Mollweide corner) — show background rather than a smeared world origin.
      inView = any(u.lin1 != vec4<f32>(0.0));
    } else {
      let vuv = u.view.xy + duv / u.view.z;
      if (mode == 0) {
        inView = vuv.y >= 0.0 && vuv.y <= 1.0
          && (u.view.z > 1.001 || (fuv.x >= 0.0 && fuv.x <= 1.0));
        uv = vec2<f32>(fract(vuv.x), clamp(vuv.y, 0.0, 1.0));
      } else {
        let plane = vec2<f32>((vuv.x * 2.0 - 1.0) * ext.x, (1.0 - vuv.y * 2.0) * ext.y);
        let ll = invProject(mode, plane);
        inView = ll.z > 0.5;
        if (mode == 1) {   // Mercator wraps like the equirect map
          inView = inView && (u.view.z > 1.001 || (fuv.x >= 0.0 && fuv.x <= 1.0));
        }
        uv = vec2<f32>(fract(ll.x / (2.0 * PI) + 0.5), clamp(0.5 - ll.y / PI, 0.0, 1.0));
      }
      // fract() makes the window coord wrap-agnostic: a rect stored with u0 outside [0,1]
      // (view astride the ±180° seam) still lands correctly.
      wuv = vec2<f32>(fract(uv.x - u.win0.x) * u.win0.z, (uv.y - u.win0.y) * u.win0.w);
    }
  }
  var col = mapColor(uv, wuv, fc.xy);
  // Subtle slope hillshade on land in the relief globe (fixed light from the upper-left, like a
  // physical relief globe under room light). textureLoad only — safe in non-uniform flow.
  if (u.p1.z > 0.5 && u.pad.x > 0.0 && inView) {   // both spherical modes
    let hm = topoMeters(uv);
    if (hm > 0.0) {
      let dims = vec2<f32>(textureDimensions(topoTex));
      let dE = topoMeters(uv + vec2<f32>(1.0 / dims.x, 0.0)) - hm;   // east slope, m per texel
      let dN = topoMeters(uv - vec2<f32>(0.0, 1.0 / dims.y)) - hm;   // north slope
      let shade = clamp(1.0 - dE * 0.0009 + dN * 0.0006, 0.72, 1.18);
      col = col * shade;
    }
  }
  // The compare divider, drawn over everything: without a visible seam the two halves read as one
  // map and the eye stitches the discontinuity into a real feature.
  if (u.cmp.x > 0.5) {
    let d = abs(fc.x - u.cmp.y);
    col = mix(col, vec3<f32>(0.95, 0.98, 1.0), 1.0 - smoothstep(0.5, 1.5, d));
    col = mix(col, col * 0.35, (1.0 - smoothstep(1.5, 3.0, d)) * 0.8);
  }
  return vec4<f32>(select(u.bg.rgb, col, inView), 1.0);
}
`;

/**
 * Whether this device has a touchscreen at all — phone, tablet, or a touch laptop that also has a
 * mouse. Only used to decide whether the on-screen flight controls are worth putting up; every
 * gesture below keys off the event's own `pointerType` instead, so a hybrid machine gets both.
 */
const HAS_TOUCH = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const statusEl = document.getElementById('status') as HTMLElement;

  const ctx = await GpuContext.create(canvas);
  const device = ctx.device;

  // ── Pipeline ──────────────────────────────────────────────────────────────────────
  const module = device.createShaderModule({ label: 'GeoLayersShader', code: SHADER });
  const bgl = device.createBindGroupLayout({
    label: 'GeoLayersBGL',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 16, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 17, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 18, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 19, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    label: 'GeoLayersPipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: ctx.format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
  const uniformBuf = device.createBuffer({ size: 80 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniform = new Float32Array(80);

  // ── Vector-flow overlays (currents baked, wind live) ───────────────────────────────
  const currentsFlow = new FlowOverlay(device, { count: 9000, speedScale: 0.05, life: 8.0, pointSize: 1.0, trailWidth: 2048, fadeRate: 0.02, tint: [0.20, 0.55, 1.6] });
  const windFlow = new FlowOverlay(device, { count: 16000, speedScale: 0.011, life: 4.0, pointSize: 0.9, trailWidth: 2048, fadeRate: 0.03, tint: [1.0, 1.02, 1.1] });
  // Both flows share one window — they are driven by the same view, and one uniform then describes
  // how the shader samples either trail raster.
  let flowWin: FlowWindow = FLOW_WORLD;
  // Time-stack of dated current frames (2020→now); the overlay advects between the two straddling
  // frames, driven by the same time index as the SST time-lapse.
  let currentsFrames: GriddedField[] = [];
  void GriddedField.loadBakedStack(device, currentsStackPngUrl, currentsStackMetaUrl).then((fs) => { currentsFrames = fs; }).catch(() => { /* overlay stays inert */ });
  // Night basemap (city lights) — 1×1 black until the sun toggle first loads it; pure darkening
  // still works meanwhile (black lights add nothing).
  let nightTex: Texture = Texture.createSolid(device, 0, 0, 0, 255);
  let nightLoading = false;
  function ensureNight(): void {
    if (nightLoading) {
      return;
    }
    nightLoading = true;
    void Texture.fromUrl(device, nightmapUrl, { srgb: false }).then((t) => {
      nightTex.destroy();
      nightTex = t;
      bgKey = '';   // rebind with the real night map
    }).catch(() => { nightLoading = false; /* retry on next toggle */ });
  }

  // RainViewer radar overlay — transparent 1×1 until the first toggle streams the composite.
  let radarTex: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  // Analysis arrow overlay (displayVectors sink): equirect straight-alpha texture composited by
  // the shader; the transparent 1×1 default no-ops. The generation counter rides the bind-group
  // key so a new rasterization swaps in without touching the rest of the cached entries.
  const analysisVecNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let analysisVecTex: Texture = analysisVecNone;
  let analysisVecGen = 0;
  // Drawn geometry (point / line / area) is rasterized into an equirect straight-alpha texture, the
  // same trick the vector arrows use: composited by uv, so one rasterization is correct in all six
  // projections AND on the globe with no forward projection anywhere.
  const geomNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let geomTex: Texture = geomNone;
  let geomGen = 0;

  // ── Annotation-overlay window ──────────────────────────────────────────────────────
  /**
   * The uv rect the annotation rasters (drawn geometry, animal tracks, analysis arrows) cover.
   *
   * Compositing them by uv is what keeps one rasterization correct in every projection and on the
   * globe — but a WORLD-sized canvas spends its texels uniformly across the planet. Zoomed into a
   * bay, a 2048-wide equirect raster leaves ~6 texels per degree, so a 3-px marker arrives on screen
   * as a 60-px blob and a 2-px track as a band. That is the whole "low-res overlay" problem.
   *
   * So the raster covers only what is VISIBLE, at the same texel budget: density then scales with
   * zoom instead of staying fixed. Because the window maps onto (roughly) the whole canvas at every
   * zoom, a feature authored at N raster px also stays ~N screen px — which is why none of the
   * marker radii or line widths below had to change when this stopped drawing the whole world.
   */
  interface OverlayWin { u0: number; v0: number; du: number; dv: number }
  const OVERLAY_WORLD: OverlayWin = { u0: 0, v0: 0, du: 1, dv: 1 };
  let overlayWin: OverlayWin = OVERLAY_WORLD;

  /** Texel budget along u. Height follows the canvas so one texel is ~square on screen. */
  const OVERLAY_TEXELS = 2048;

  /**
   * Raster size for the current window. The window fills the canvas by construction, so square
   * screen texels means matching the CANVAS aspect — the window's own uv aspect already encodes
   * whatever the projection is doing.
   */
  function overlayRasterSize(): { TW: number; TH: number } {
    const ratio = canvas.height / Math.max(canvas.width, 1);
    return { TW: OVERLAY_TEXELS, TH: Math.max(256, Math.min(2048, Math.round(OVERLAY_TEXELS * ratio))) };
  }

  /** Maps an UNWRAPPED equirect u into raster pixels (no wrap fix-up — see overlayShift). */
  function overlayX(u: number, TW: number): number {
    return ((u - overlayWin.u0) / overlayWin.du) * TW;
  }

  function overlayY(latDeg: number, TH: number): number {
    return (((90 - latDeg) / 180 - overlayWin.v0) / overlayWin.dv) * TH;
  }

  /**
   * How far to shift an already-unwrapped polyline so it lands on the window's copy of the world.
   * Applied once per path rather than per vertex: re-wrapping each point independently would tear
   * a line in half the moment it crossed the window edge.
   */
  function overlayShift(uFirst: number): number {
    return Math.round(uFirst - (overlayWin.u0 + overlayWin.du / 2));
  }

  // ── Shared annotation drawing ──────────────────────────────────────────────────────
  // Every vector overlay (storms, fires, boundaries, city labels) does the same three things to
  // get lon/lat onto the annotation raster: unwrap the path once, shift it onto the window's copy
  // of the world, and stroke or fill it. Kept here rather than per-overlay because the unwrap is
  // the part that is easy to get subtly wrong, and one wrong copy tears geometry at the window
  // edge only for certain longitudes — a bug that hides until someone pans to the Pacific.

  /** Projects a lon/lat path into raster pixels for the current overlay window. */
  function projectPath(pts: LonLat[], TW: number, TH: number): Array<{ x: number; y: number }> {
    if (pts.length === 0) {
      return [];
    }
    let prevU = (pts[0].lon + 180) / 360;
    const us = pts.map((p) => {
      const uu = (p.lon + 180) / 360;
      prevU = uu - Math.round(uu - prevU);   // continue the previous point's copy
      return prevU;
    });
    const shift = overlayShift(us[0]);
    return pts.map((p, i) => ({ x: overlayX(us[i] - shift, TW), y: overlayY(p.lat, TH) }));
  }

  /** Projects a single lon/lat onto the raster (a path of one, for markers and labels). */
  function projectPoint(lon: number, lat: number, TW: number, TH: number): { x: number; y: number } {
    return projectPath([{ lon, lat }], TW, TH)[0];
  }

  function tracePath(cx: OffscreenCanvasRenderingContext2D, pts: Array<{ x: number; y: number }>, close: boolean): void {
    cx.beginPath();
    pts.forEach((p, i) => { if (i === 0) { cx.moveTo(p.x, p.y); } else { cx.lineTo(p.x, p.y); } });
    if (close) {
      cx.closePath();
    }
  }

  /** Strokes a path twice: a dark casing, then the color. The only treatment legible over both a
   *  bright colormap and a dark ocean. */
  function strokeCased(
    cx: OffscreenCanvasRenderingContext2D, pts: Array<{ x: number; y: number }>,
    color: string, width: number, close = false,
  ): void {
    tracePath(cx, pts, close);
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.lineWidth = width + 2.5;
    cx.stroke();
    tracePath(cx, pts, close);
    cx.strokeStyle = color;
    cx.lineWidth = width;
    cx.stroke();
  }

  /** White-on-dark annotation text. */
  function drawLabel(
    cx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number,
    opts: { color?: string; font?: string } = {},
  ): void {
    cx.font = opts.font ?? '600 12px ui-sans-serif, system-ui, sans-serif';
    cx.lineWidth = 3;
    cx.strokeStyle = 'rgba(0,0,0,0.85)';
    cx.strokeText(text, x, y);
    cx.fillStyle = opts.color ?? '#ffffff';
    cx.fillText(text, x, y);
  }

  /**
   * Screen-space label declutter: accepts a label only when its box clears every box already
   * placed. Callers feed candidates in priority order (biggest fire, most prominent city), so what
   * survives a crowded view is what matters rather than what happened to be drawn first.
   */
  function makeLabelPlacer(): (x: number, y: number, w: number, h: number) => boolean {
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    return (x, y, w, h) => {
      const box = { x0: x - 2, y0: y - h, x1: x + w + 2, y1: y + 4 };
      for (const b of placed) {
        if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) {
          return false;
        }
      }
      placed.push(box);
      return true;
    };
  }

  /** The visible window as a lon/lat bbox, for feeds that take a viewport query. */
  function overlayBBox(): BBox {
    const lonAt = (u: number): number => u * 360 - 180;
    const latAt = (v: number): number => 90 - v * 180;
    return {
      west: lonAt(overlayWin.u0),
      east: lonAt(overlayWin.u0 + overlayWin.du),
      north: latAt(overlayWin.v0),
      south: latAt(overlayWin.v0 + overlayWin.dv),
    };
  }

  // ── Streamed terrain detail window (zoom sharpening) ───────────────────────────────
  // Blue Marble tiles at moderate zoom, aerial imagery at deep zoom, assembled into an
  // equirect crop of the visible rect; the shader overrides the basemap COLOR where the
  // window covers, so data layers and masks are untouched. The generation counter rides the
  // bind-group key like the analysis overlay's.
  const detailNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let detailGen = 0;
  const detailWin = new TileWindowStreamer(device, {
    onUpdate: () => { detailGen++; updateDetailAttribution(); },
  });
  // Tile attribution (required by the imagery providers while their tiles are on screen).
  const detailAttr = document.createElement('div');
  detailAttr.style.cssText = 'position:fixed;z-index:11;right:6px;bottom:2px;padding:1px 6px;display:none;'
    + 'background:rgba(8,10,14,0.75);border-radius:3px;color:#8a99a8;font:10px ui-monospace,monospace;pointer-events:none';
  document.body.appendChild(detailAttr);
  function updateDetailAttribution(): void {
    const w = detailWin.window;
    detailAttr.style.display = w ? 'block' : 'none';
    detailAttr.textContent = w ? w.attribution : '';
  }
  let radarTime = 0;
  let radarLoading = false;
  function ensureRadar(): void {
    if (radarTime > 0 || radarLoading) {
      return;
    }
    radarLoading = true;
    void loadRadarOverlay(device).then((r) => {
      radarTex.destroy();
      radarTex = r.texture;
      radarTime = r.time;
      bgKey = '';   // rebind with the real radar texture
    }).catch(() => { radarLoading = false; /* retry on next toggle */ });
  }
  // Wind is a live dated stack too (GFS history reaches back to 2022-12 at 3-hourly): the slider
  // dates within coverage plus one frame nearest NOW (GFS is a forecast model, so `(last)` would be
  // the +7-day forecast edge — not current conditions). Before 2022-12 the overlay clamps to the
  // earliest frame. Streamed lazily on first toggle.
  let windFrames: GriddedField[] = [];
  let windLoading = false;
  function ensureWind(): void {
    if (windFrames.length > 0 || windLoading) { return; }
    windLoading = true;
    statusEl.textContent = 'Loading wind…';   // immediate feedback — the first ERDDAP fetch can take a while
    void (async () => {
      try {
        const range = await sourceTimeRange(WIND_SOURCE.servers, WIND_SOURCE.datasets);
        // Nearest-now FIRST (ERDDAP `(value)` snaps to the closest index) so the flow starts
        // moving as soon as one frame lands; the dated history backfills through the pool.
        const dates = [new Date().toISOString(), ...sampledDates(range, SINCE_YEAR, STEP_MONTHS).map((d) => `${d}T12:00:00Z`).reverse()];
        await streamPool(dates, 3, async (iso) => {
          try {
            const f = await GriddedField.loadVector(device, WIND_SOURCE, { timeSel: `(${iso})`, stride: 3, flipLat: await gfsLatFlipped(iso) });
            windFrames.push(f);
            windFrames.sort((a, b) => a.meta.date.localeCompare(b.meta.date));
            if (!windFlow.hasField()) {
              windFlow.setField(f);
              if (statusEl.textContent === 'Loading wind…') {
                statusEl.textContent = '';   // flow is visible; stay out of the base layer's way
              }
            }
          } catch { /* skip a failed frame */ }
        });
      } catch { /* whatever streamed so far still animates; retry on next toggle if nothing did */ }
      windLoading = windFrames.length > 0;   // allow a retry only if we got nothing at all
    })();
  }

  // ── Base-layer state ────────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  let layer: BaseLayer = LAYERS.find((l) => l.key === params.get('layer')) ?? LAYERS[0];
  /** `?vmin`/`?vmax` as a range, or null when absent or nonsensical. */
  function scaleFromParams(): { min: number; max: number } | null {
    const lo = parseFloat(params.get('vmin') ?? '');
    const hi = parseFloat(params.get('vmax') ?? '');
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { min: lo, max: hi } : null;
  }
  let lutTex: Texture = buildSstColormapLut(device,
    SST_COLORMAPS.some((c) => c.name === params.get('cmap')) ? params.get('cmap') as SstColormapName : layer.colormap);
  let currentField: GriddedField | null = null;
  let nextField: GriddedField | null = null;   // crossfade target during time-lapse playback
  let basemapTex: Texture | null = null;
  let bindGroup: GPUBindGroup | null = null;
  let bgKey = '';
  function ensureBindGroup(): boolean {
    if (!currentField || !basemapTex) {
      return false;
    }
    const nxt = nextField ?? currentField;
    const key = `${currentField.meta.date}|${nxt.meta.date}|${layer.key}|v${analysisVecGen}|w${detailGen}`
      + `|o${overLayer?.key ?? '-'}:${overField?.meta.date ?? '-'}|g${geomGen}|k${trackGen}|s${stormGen}`
      + `|f${fireGen}|a${adminGen}`;
    if (key !== bgKey || !bindGroup) {
      bindGroup = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: currentField.texture.view },
          { binding: 2, resource: lutTex.view },
          { binding: 3, resource: sampler },
          { binding: 4, resource: basemapTex.view },
          { binding: 5, resource: currentsFlow.trailView },
          { binding: 6, resource: windFlow.trailView },
          { binding: 7, resource: nxt.texture.view },
          { binding: 8, resource: topoTex.view },
          { binding: 9, resource: radarTex.view },
          { binding: 10, resource: nightTex.view },
          { binding: 11, resource: analysisVecTex.view },
          { binding: 12, resource: detailWin.window?.view ?? detailNone.view },
          { binding: 13, resource: overField?.texture.view ?? overNone.view },
          { binding: 14, resource: lut2Tex.view },
          { binding: 15, resource: geomTex.view },
          { binding: 16, resource: trackTex.view },
          { binding: 17, resource: stormTex.view },
          { binding: 18, resource: fireTex.view },
          { binding: 19, resource: adminTex.view },
        ],
      });
      bgKey = key;
    }
    return true;
  }

  void Texture.fromUrl(device, basemapUrl, { srgb: false, generateMips: true }).then((t) => { basemapTex = t; }).catch(() => { /* land draws once it arrives */ });

  // ETOPO relief heightmap for the globe. The 1×1 black placeholder decodes to deep ocean
  // (terrainH = 0 everywhere), so the relief march is safely a smooth sphere until it loads.
  let topoTex: Texture = Texture.createSolid(device, 0, 0, 0, 255);
  void Texture.fromUrl(device, topoPngUrl, { srgb: false }).then((t) => {
    topoTex.destroy();
    topoTex = t;
    bgKey = '';   // rebind with the real heightmap
  }).catch(() => { /* globe stays a smooth sphere */ });

  // Baked SST snapshot as an instant/offline first frame. Claim the screen only while the SST
  // layer is active with nothing loaded yet — a `?layer=` deeplink races this fetch, and the
  // snapshot must not squat on currentField in another layer's colormap.
  let bootField: GriddedField | null = null;
  void GriddedField.loadBaked(device, sstPngUrl, sstMetaUrl).then((f) => {
    if (!currentField && layer.key === 'sst') {
      bootField = f;
      currentField = f;
    } else {
      f.destroy();
    }
  }).catch(() => { /* live frames provide color */ });

  // ── Base-layer loading (time-lapse stack, or a single live/baked frame) ────────────
  // `shared` marks frames owned by a loader's cache rather than by this stack: clearFields must not
  // destroy them, or re-selecting the layer hands back destroyed textures. Same contract as the
  // analysis store's `sharedFrames`.
  let absFrames: { date: string; field: GriddedField; shared?: boolean }[] = [];  // absolute (as-fetched) stack
  let frames: { date: string; field: GriddedField }[] = [];     // DISPLAYED stack (absolute or a derived view)
  let derived: { date: string; field: GriddedField }[] = [];    // derived-view fields (owned; rebuilt per view)
  let view: ViewKey = VIEWS.some((v) => v.key === params.get('view')) ? (params.get('view') as ViewKey) : 'abs';
  let deltaYears = /^[1-5]$/.test(params.get('dyr') ?? '') ? parseInt(params.get('dyr')!, 10) : 1;
  const reliefExagg = 25;   // fixed terrain exaggeration on the globe
  UNIT_F = params.get('unit') !== 'c';   // Fahrenheit by default; `unit=c` for Celsius
  const noGui = params.has('nogui');
  if (noGui) {
    statusEl.style.display = 'none';
    const desc = document.getElementById('desc');
    if (desc) {
      desc.style.display = 'none';
    }
  }
  let singleField: GriddedField | null = null;   // non-temporal layers / picked days
  let idx = 0;
  /**
   * Whether the display should ride the newest frame as a stack streams in.
   *
   * Stacks are fetched newest-first (see the streaming loaders below), so the first frame to land
   * is the one worth looking at — today — and the years behind it fill in underneath. Since they
   * arrive OLDER than what is on screen they insert BEFORE it, which moves the displayed frame's
   * index every time: without re-pinning, the scrubber handle drifts away from the frame actually
   * being drawn. Any deliberate move — scrubbing, playback, a picked day, a `?date` link — hands
   * control to the user and clears this, so a late arrival never yanks the view back.
   */
  let followNewest = true;

  /** Re-pins the display to the newest frame of the streaming stack. */
  function followNewestFrame(): void {
    // Only meaningful while the plain absolute stack is what's on screen: a derived view (Δ, mean,
    // …) or a season filter has its own frame list, rebuilt wholesale by applyView when the stream
    // finishes.
    if (!followNewest || view !== 'abs' || frames !== absFrames || absFrames.length === 0) {
      return;
    }
    idx = absFrames.length - 1;
    currentField = absFrames[idx].field;
    ui.setDate(absFrames[idx].date);
  }

  // ── Life: OBIS species grids + ATN animal tracks ─────────────────────────────────────
  // Both are opt-in state rather than extra layers: the species/taxon is a parameter of one layer and
  // one overlay, so the info panel, citation and analysis catalog each need a single entry.
  let obisSpecies = params.get('species') ?? OBIS_SPECIES[0].taxon;
  // GFW publishes complete years; default to the last one that is certainly finished.
  const gfwYear = /^\d{4}$/.test(params.get('year') ?? '')
    ? parseInt(params.get('year')!, 10) : new Date().getUTCFullYear() - 1;
  const obisPrecision = /^[1-4]$/.test(params.get('obisgrid') ?? '') ? parseInt(params.get('obisgrid')!, 10) : 3;
  let atnTaxon = params.get('tracks') ?? '';
  let atnTracks: AtnTrack[] = [];
  let atnGen = 0;
  const trackNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let trackTex: Texture = trackNone;
  let trackGen = 0;

  /** Rasterizes the loaded tracks into the equirect overlay, one hue per deployment. */
  function redrawTracks(): void {
    if (trackTex !== trackNone) {
      trackTex.destroy();
    }
    trackTex = trackNone;
    trackGen++;
    bindGroup = null;
    bgKey = '';
    if (atnTracks.length === 0) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    const Y = (lat: number): number => overlayY(lat, TH);
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    atnTracks.forEach((tr, i) => {
      // Distinct hues per deployment: overlapping tracks of one species are otherwise a single blob.
      const hue = (i * 47) % 360;
      // Unwrap the track once, then move the whole thing onto the window's copy of the world — a
      // per-point wrap would cut the path in two wherever it crossed the window edge.
      let prevU = (tr.points[0].lon + 180) / 360;
      const us = tr.points.map((pt) => {
        const uu = (pt.lon + 180) / 360;
        prevU = uu - Math.round(uu - prevU);   // continue the previous point's copy
        return prevU;
      });
      const shift = overlayShift(us[0]);
      const seg = (): void => {
        cx.beginPath();
        tr.points.forEach((pt, k) => {
          const px = overlayX(us[k] - shift, TW), py = Y(pt.lat);
          if (k === 0) { cx.moveTo(px, py); } else { cx.lineTo(px, py); }
        });
      };
      seg();
      cx.strokeStyle = 'rgba(0,0,0,0.55)';
      cx.lineWidth = 4.5;
      cx.stroke();
      seg();
      cx.strokeStyle = `hsl(${hue} 90% 62%)`;
      cx.lineWidth = 2;
      cx.stroke();
      // Mark the deployment start, so a path has a direction.
      cx.beginPath();
      cx.arc(overlayX(us[0] - shift, TW), Y(tr.points[0].lat), 4, 0, Math.PI * 2);
      cx.fillStyle = '#ffffff';
      cx.fill();
    });
    trackTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  async function loadTracks(): Promise<void> {
    const gen = ++atnGen;
    atnTracks = [];
    redrawTracks();
    if (!atnTaxon) {
      return;
    }
    const label = ATN_TAXA.find((t) => t.taxon === atnTaxon)?.label ?? atnTaxon;
    statusEl.textContent = `Fetching ATN tracks for ${label}…`;
    try {
      const tracks = await loadAtnTracks(atnTaxon);
      if (gen !== atnGen) {
        return;
      }
      atnTracks = tracks;
      redrawTracks();
      const fixes = tracks.reduce((n, t) => n + t.points.length, 0);
      statusEl.textContent = `${tracks.length} ATN track${tracks.length === 1 ? '' : 's'} · ${fixes} QC-passed fixes · ${label}`;
    } catch (e) {
      if (gen === atnGen) {
        statusEl.textContent = `ATN: ${(e as Error).message}`;
      }
    }
  }

  // ── Weather: active tropical cyclones ────────────────────────────────────────────────
  // The only feed here that is vector geometry rather than a field, and the only one whose whole
  // point is a FORECAST: the cone is the message, the center line is just where the cone is
  // narrowest. Drawn into the same windowed annotation raster the animal tracks use, so one
  // rasterization is correct on the flat map, on the globe and in earth mode alike.
  let cyclones: Cyclone[] = [];
  let stormsOn = params.has('storms');
  let stormGen = 0;
  let stormFetchedAt = 0;
  let stormLoading = false;
  const stormNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let stormTex: Texture = stormNone;

  /** Short UTC stamp for a forecast point, e.g. `Sun 18Z` — unambiguous without a timezone note. */
  function stormTimeLabel(ms: number): string {
    const d = new Date(ms);
    const day = d.toLocaleString('en', { weekday: 'short', timeZone: 'UTC' });
    return `${day} ${String(d.getUTCHours()).padStart(2, '0')}Z`;
  }

  /**
   * Rasterizes every active storm into the annotation overlay.
   *
   * Draw order is the advisory graphic's own: uncertainty underneath, then the coastline alerts,
   * then the past, then the forecast, then the labels — so nothing that says what WILL happen is
   * ever hidden by something that says what already did.
   */
  function redrawStorms(): void {
    if (stormTex !== stormNone) {
      stormTex.destroy();
    }
    stormTex = stormNone;
    stormGen++;
    bindGroup = null;
    bgKey = '';
    if (!stormsOn || cyclones.length === 0) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    const project = (pts: LonLat[]): Array<{ x: number; y: number }> => projectPath(pts, TW, TH);
    const trace = (pts: Array<{ x: number; y: number }>, close: boolean): void => tracePath(cx, pts, close);
    const label = (text: string, x: number, y: number, color = '#ffffff'): void =>
      drawLabel(cx, text, x, y, { color });

    for (const c of cyclones) {
      const tint = cycloneColor(c.current?.windKt ?? 0);
      // Error cone: filled, because the area IS the statement — the center is about as likely to
      // pass anywhere inside it, and a bare outline gets read as a boundary of "the storm".
      for (const ring of c.cone) {
        trace(project(ring), true);
        cx.fillStyle = 'rgba(255,255,255,0.13)';
        cx.fill();
        cx.setLineDash([5, 4]);
        cx.strokeStyle = 'rgba(255,255,255,0.6)';
        cx.lineWidth = 1.5;
        cx.stroke();
        cx.setLineDash([]);
      }
      // Coastline watches and warnings, in NHC's own alert colors.
      for (const a of c.alerts) {
        trace(project(a.path), false);
        cx.strokeStyle = 'rgba(0,0,0,0.6)';
        cx.lineWidth = 6;
        cx.stroke();
        cx.strokeStyle = CYCLONE_ALERT_COLORS[a.code];
        cx.lineWidth = 3.5;
        cx.stroke();
      }
      // Track so far.
      for (const path of c.observedTrack) {
        const pts = project(path);
        trace(pts, false);
        cx.strokeStyle = 'rgba(0,0,0,0.55)';
        cx.lineWidth = 4.5;
        cx.stroke();
        trace(pts, false);
        cx.strokeStyle = '#e6eef8';
        cx.lineWidth = 2;
        cx.stroke();
      }
      // One dot per six-hourly best-track fix, colored by the intensity AT THAT FIX: the track
      // stops being a line and becomes the storm's intensity history, which is what tells you
      // whether it is winding up or falling apart as it arrives.
      for (const f of c.observed) {
        const [p] = project([f]);
        cx.beginPath();
        cx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        cx.fillStyle = cycloneColor(f.windKt);
        cx.fill();
        cx.strokeStyle = 'rgba(0,0,0,0.55)';
        cx.lineWidth = 0.8;
        cx.stroke();
      }
      // Forecast center line — dashed, so it never reads as a fact.
      for (const path of c.forecastTrack) {
        const pts = project(path);
        trace(pts, false);
        cx.strokeStyle = 'rgba(0,0,0,0.55)';
        cx.lineWidth = 4.5;
        cx.stroke();
        trace(pts, false);
        cx.setLineDash([7, 5]);
        cx.strokeStyle = tint;
        cx.lineWidth = 2.2;
        cx.stroke();
        cx.setLineDash([]);
      }
      // Forecast points, sized by whether they are a hurricane. Labels are spaced by SCREEN
      // distance rather than by index: a fixed "every other point" rule reads fine zoomed in and
      // stacks four labels into one smear when the whole basin is on screen, because how far apart
      // 12 forecast hours land is a function of the zoom, not of the advisory.
      let lastLabelAt: { x: number; y: number } | null = null;
      c.forecast.forEach((f, i) => {
        const [p] = project([f]);
        const r = saffirSimpson(f.windKt) > 0 ? 5.5 : 4;
        cx.beginPath();
        cx.arc(p.x, p.y, r, 0, Math.PI * 2);
        cx.fillStyle = cycloneColor(f.windKt);
        cx.fill();
        cx.strokeStyle = 'rgba(0,0,0,0.7)';
        cx.lineWidth = 1.4;
        cx.stroke();
        const far = !lastLabelAt || Math.hypot(p.x - lastLabelAt.x, p.y - lastLabelAt.y) > 110;
        if (i > 0 && far) {
          label(`${stormTimeLabel(f.timeMs)} · ${f.windKt} kt`, p.x + r + 4, p.y + 4, '#dfe9f5');
          lastLabelAt = p;
        }
      });
      // Current position last, and largest.
      if (c.current) {
        const [p] = project([c.current]);
        cx.beginPath();
        cx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
        cx.fillStyle = tint;
        cx.fill();
        cx.lineWidth = 2;
        cx.strokeStyle = '#0b0f14';
        cx.stroke();
        cx.beginPath();
        cx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        cx.lineWidth = 1.5;
        cx.strokeStyle = 'rgba(255,255,255,0.85)';
        cx.stroke();
        label(`${c.name} · ${cycloneClass(c.current.windKt)} · ${c.current.windKt} kt`, p.x + 15, p.y - 9);
      }
    }
    stormTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  /** One-line summary of what is out there, for the status strip. */
  function stormSummary(): string {
    if (cyclones.length === 0) {
      return 'No active tropical cyclones';
    }
    const parts = cyclones.map((c) => {
      const w = c.current?.windKt ?? 0;
      const mv = c.current?.headingDeg != null && c.current.speedKt != null
        ? `, ${Math.round(c.current.headingDeg)}° at ${c.current.speedKt} kt` : '';
      const p = c.current?.pressureMb != null ? `, ${c.current.pressureMb} mb` : '';
      return `${c.name} (${c.basin}) ${cycloneClass(w)} · ${w} kt${p}${mv}`;
    });
    const adv = cyclones.find((c) => c.advisoryTimeMs > 0);
    const stamp = adv ? ` · advisory ${adv.advisory} ${new Date(adv.advisoryTimeMs).toISOString().slice(0, 16).replace('T', ' ')}Z` : '';
    return `${parts.join('  ·  ')}${stamp} · ${CYCLONE_ATTRIBUTION}`;
  }

  /**
   * Fetches the advisory package, at most once every five minutes.
   *
   * Advisories are issued every three hours at the fastest, so a re-toggle inside that window has
   * nothing new to show — but a stale package during a landfall is exactly the wrong thing to
   * cache forever, hence the expiry rather than a load-once flag.
   */
  function ensureStorms(): void {
    if (stormLoading || (stormFetchedAt > 0 && Date.now() - stormFetchedAt < 300_000)) {
      redrawStorms();
      return;
    }
    stormLoading = true;
    statusEl.textContent = 'Loading tropical cyclone advisories…';
    void loadActiveCyclones().then((list) => {
      cyclones = list;
      stormFetchedAt = Date.now();
      redrawStorms();
      statusEl.textContent = stormSummary();
    }).catch((e) => {
      statusEl.textContent = `Cyclones: ${(e as Error).message}`;
    }).finally(() => { stormLoading = false; });
  }

  // ── Weather: active wildfires ────────────────────────────────────────────────────────
  // Three feeds, three different questions: the PERIMETER is where it has burned as last mapped
  // (authoritative, hours-to-days stale), the INCIDENT record is what is known right now (acreage,
  // containment, crew), and VIIRS HOTSPOTS are where satellites saw heat in the last day — the
  // only near-real-time signal, and the one that shows which side is running. Forest boundaries go
  // underneath as the land context the fire is chewing through.
  let fireData: WildfireSnapshot | null = null;
  let forestUnits: ForestUnit[] = [];
  let fireOn = params.has('fire');
  let fireGen = 0;
  let fireFetchedAt = 0;
  let fireLoading = false;
  let firePending = false;
  let fireBBoxKey = '';
  const fireNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let fireTex: Texture = fireNone;

  /** Rasterizes forest units, perimeters, hotspots and incident labels into the overlay. */
  function redrawFire(): void {
    if (fireTex !== fireNone) {
      fireTex.destroy();
    }
    fireTex = fireNone;
    fireGen++;
    bindGroup = null;
    bgKey = '';
    if (!fireOn || (!fireData && forestUnits.length === 0)) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';

    // Forest units: a wash and a hairline, no more. This is the ground the fire is on, not the
    // subject — the moment it reads as strongly as a perimeter, the perimeter stops standing out.
    for (const unit of forestUnits) {
      for (const ring of unit.rings) {
        tracePath(cx, projectPath(ring, TW, TH), true);
        cx.fillStyle = 'rgba(64,150,90,0.16)';
        cx.fill();
        cx.strokeStyle = 'rgba(120,220,150,0.55)';
        cx.lineWidth = 1.2;
        cx.stroke();
      }
    }

    // Hotspots under the perimeter outline: inside a mapped fire they are texture, and outside it
    // they are the news — heat where no polygon has been drawn yet.
    for (const h of fireData?.hotspots ?? []) {
      const p = projectPoint(h.lon, h.lat, TW, TH);
      if (p.x < -20 || p.x > TW + 20 || p.y < -20 || p.y > TH + 20) {
        continue;
      }
      // Age is drawn as fade rather than as color: color already means intensity, and a stale
      // detection should look like weaker evidence, not like a cooler fire.
      const fade = Math.max(0.15, 1 - h.hoursOld / 24);
      cx.globalAlpha = fade;
      cx.beginPath();
      cx.arc(p.x, p.y, h.frp >= 30 ? 3.4 : 2.4, 0, Math.PI * 2);
      cx.fillStyle = hotspotColor(h.frp);
      cx.fill();
      cx.globalAlpha = 1;
    }

    for (const perim of fireData?.perimeters ?? []) {
      for (const ring of perim.rings) {
        const pts = projectPath(ring, TW, TH);
        tracePath(cx, pts, true);
        cx.fillStyle = perim.prescribed ? 'rgba(120,140,255,0.18)' : 'rgba(255,90,30,0.22)';
        cx.fill();
        strokeCased(cx, pts, perim.prescribed ? '#93a4ff' : '#ff6a2a', 2, true);
      }
    }

    // Incidents last, biggest fire first, with two acreage floors that scale with how much ground
    // the window covers. Without them a national view is 500 overlapping dots and a wall of names
    // over the western US — which is not "more information", it is the map refusing to say which
    // fire matters. Marking is looser than labelling: a dot still says "something is burning here"
    // when there is no room to say what.
    const span = overlayWin.du;
    const markerFloor = span > 0.5 ? 5000 : span > 0.1 ? 500 : span > 0.02 ? 10 : 0;
    const acresFloor = span > 0.5 ? 100_000 : span > 0.1 ? 20_000 : span > 0.02 ? 100 : 0;
    const place = makeLabelPlacer();
    cx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    for (const inc of fireData?.incidents ?? []) {
      if ((inc.acres ?? 0) < markerFloor) {
        continue;
      }
      const p = projectPoint(inc.lon, inc.lat, TW, TH);
      if (p.x < 0 || p.x > TW || p.y < 0 || p.y > TH) {
        continue;
      }
      const big = (inc.acres ?? 0) >= 100;
      cx.beginPath();
      cx.arc(p.x, p.y, big ? 5 : 3, 0, Math.PI * 2);
      cx.fillStyle = inc.prescribed ? '#93a4ff' : '#ff3b1f';
      cx.fill();
      cx.lineWidth = 1.4;
      cx.strokeStyle = 'rgba(0,0,0,0.75)';
      cx.stroke();
      if ((inc.acres ?? 0) < acresFloor) {
        continue;
      }
      const cont = inc.containedPct === null ? '' : ` · ${Math.round(inc.containedPct)}% contained`;
      const text = `${inc.name} · ${formatAcres(inc.acres)}${cont}`;
      const w = cx.measureText(text).width;
      if (place(p.x + 9, p.y + 4, w, 12)) {
        drawLabel(cx, text, p.x + 9, p.y + 4, { color: inc.prescribed ? '#cfd7ff' : '#ffd9c8' });
      }
    }
    fireTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  /** What the fire overlay is showing, for the status strip. */
  function fireSummary(): string {
    if (!fireData) {
      return '';
    }
    const wild = fireData.incidents.filter((i) => !i.prescribed);
    const big = wild.filter((i) => (i.acres ?? 0) >= 1000);
    const largest = wild[0];
    const head = largest
      ? `${largest.name} (${largest.state}) ${formatAcres(largest.acres)}`
        + `${largest.containedPct === null ? '' : ` · ${Math.round(largest.containedPct)}% contained`}`
        + `${largest.personnel ? ` · ${largest.personnel} personnel` : ''}`
      : 'no active incidents';
    const hs = `${fireData.hotspots.length}${fireData.hotspotsTruncated ? '+' : ''} hotspots ≤24 h in view`;
    const forests = forestUnits.length ? ` · ${forestUnits.length} forest unit${forestUnits.length === 1 ? '' : 's'}` : '';
    return `${wild.length} active fires · ${big.length} over 1,000 ac · largest: ${head} · ${hs}${forests} · ${WILDFIRE_ATTRIBUTION}`;
  }

  /**
   * Fetches the fire situation for the current view.
   *
   * Perimeters and incidents are national in one small request each; only the hotspots and the
   * forest boundaries are viewport queries, so a pan refetches those two and reuses the rest. The
   * bbox key is rounded hard — a fire map that re-queried on every pixel of a drag would spend its
   * life waiting on ArcGIS.
   */
  function ensureFire(force = false): void {
    if (fireLoading) {
      // The view moved while a request was out — which is the NORMAL case at startup, where the
      // deeplink kick runs against the world window and the real one arrives a moment later.
      // Dropping this call would leave the map showing the wrong viewport's data forever.
      firePending = true;
      return;
    }
    const bbox = overlayBBox();
    const key = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(1)).join(',');
    const fresh = Date.now() - fireFetchedAt < 300_000;
    if (!force && fresh && key === fireBBoxKey && fireData) {
      redrawFire();
      return;
    }
    fireLoading = true;
    if (!fireData) {
      statusEl.textContent = 'Loading active wildfires…';
    }
    // Forest boundaries are only fetched once the view is regional: the national forest system is
    // 150+ multipolygons, and at world zoom it is a green smear that says nothing.
    const wantForests = overlayWin.du < 0.35;
    const simplify = Math.max(0.0002, overlayWin.du * 0.004);
    void Promise.allSettled([
      loadWildfires({ bbox, hotspotHours: 24, maxHotspots: 3000 }),
      wantForests ? loadForestUnits(bbox, { simplify }) : Promise.resolve([]),
    ]).then(([fires, forests]) => {
      if (fires.status === 'fulfilled') {
        fireData = fires.value;
        fireFetchedAt = Date.now();
        fireBBoxKey = key;   // only a SUCCESSFUL fetch claims the viewport, so a failure retries
      }
      forestUnits = forests.status === 'fulfilled' ? forests.value : [];
      redrawFire();
      if (fires.status === 'rejected') {
        statusEl.textContent = `Wildfires: ${(fires.reason as Error).message}`;
      } else {
        statusEl.textContent = fireSummary();
      }
    }).finally(() => {
      fireLoading = false;
      if (firePending) {
        firePending = false;
        ensureFire();
      }
    });
  }

  // ── Reference geometry: boundaries and city labels ───────────────────────────────────
  // The only overlay whose DATA changes with zoom rather than just its rasterization: Natural
  // Earth ships the same borders generalized at 1:110M, 1:50M and 1:10M, and the right one to draw
  // is a function of how much ground is on screen (see detailForZoom). Both toggles share one
  // raster because they share one trigger — a zoom that changes the detail level redraws both.
  // On by default — reference geometry is the frame the rest of the map is read against, and a
  // map that needs a menu visit before it will tell you which country you are looking at is a
  // worse default than one that costs a few hundred KB. `?borders=0` / `?cities=0` opt out (the
  // presence test the other overlays use cannot express "off", so these two take a value).
  let bordersOn = params.get('borders') !== '0';
  let citiesOn = params.get('cities') !== '0';
  let adminLevel: DetailLevel | null = null;
  let adminLines: BoundaryLines | null = null;
  let adminPlaces: Place[] = [];
  let adminGen = 0;
  let adminLoading = false;
  let adminPending = false;
  const adminNone: Texture = Texture.createSolid(device, 0, 0, 0, 0);
  let adminTex: Texture = adminNone;

  function redrawAdmin(): void {
    if (adminTex !== adminNone) {
      adminTex.destroy();
    }
    adminTex = adminNone;
    adminGen++;
    bindGroup = null;
    bgKey = '';
    if ((!bordersOn && !citiesOn) || (!adminLines && adminPlaces.length === 0)) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';

    if (bordersOn && adminLines) {
      // Internal divisions first and thinner: a state line that competes with an international
      // border misreads the map's hierarchy at a glance.
      for (const path of adminLines.state) {
        const pts = projectPath(path, TW, TH);
        tracePath(cx, pts, false);
        cx.strokeStyle = 'rgba(0,0,0,0.35)';
        cx.lineWidth = 2.4;
        cx.stroke();
        tracePath(cx, pts, false);
        cx.setLineDash([6, 4]);
        cx.strokeStyle = 'rgba(226,236,255,0.55)';
        cx.lineWidth = 1;
        cx.stroke();
        cx.setLineDash([]);
      }
      for (const path of adminLines.country) {
        strokeCased(cx, projectPath(path, TW, TH), 'rgba(255,246,220,0.9)', 1.6);
      }
    }

    if (citiesOn && adminPlaces.length > 0) {
      const maxRank = placeRankForZoom(zoom);
      const place = makeLabelPlacer();
      cx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      for (const city of adminPlaces) {
        if (city.scaleRank > maxRank) {
          break;   // the list is sorted by prominence, so the first miss ends it
        }
        const p = projectPoint(city.lon, city.lat, TW, TH);
        if (p.x < 0 || p.x > TW || p.y < 0 || p.y > TH) {
          continue;
        }
        const r = city.capital ? 3.2 : 2.4;
        cx.beginPath();
        cx.arc(p.x, p.y, r, 0, Math.PI * 2);
        cx.fillStyle = city.capital ? '#ffd75e' : '#ffffff';
        cx.fill();
        cx.lineWidth = 1.2;
        cx.strokeStyle = 'rgba(0,0,0,0.8)';
        cx.stroke();
        // Population only once the view is regional enough for it to be a fact about a place
        // rather than clutter over a continent.
        const pop = overlayWin.du < 0.3 ? formatPopulation(city.population) : '';
        const text = pop ? `${city.name} · ${pop}` : city.name;
        const w = cx.measureText(text).width;
        if (place(p.x + r + 4, p.y + 4, w, 12)) {
          drawLabel(cx, text, p.x + r + 4, p.y + 4, { color: city.capital ? '#ffeab0' : '#eef3fb' });
        }
      }
    }
    adminTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  /**
   * Loads the detail level the current zoom calls for, then redraws.
   *
   * Levels are cached forever in the loader, so zooming back out is a redraw and not a fetch; only
   * the FIRST visit to a level pays. Called from the debounced overlay driver, so a zoom gesture
   * asks once, at the end.
   */
  function ensureAdmin(): void {
    if (!bordersOn && !citiesOn) {
      redrawAdmin();
      return;
    }
    const want = detailForZoom(zoom);
    if (want === adminLevel && (adminLines || adminPlaces.length)) {
      redrawAdmin();
      return;
    }
    if (adminLoading) {
      adminPending = true;   // zoomed again mid-load; re-decide once this one lands
      return;
    }
    adminLoading = true;
    void Promise.allSettled([
      bordersOn ? loadBoundaryLines(want) : Promise.resolve(null),
      citiesOn ? loadPlaces(want) : Promise.resolve([]),
    ]).then(([lines, places]) => {
      adminLevel = want;
      if (lines.status === 'fulfilled' && lines.value) {
        adminLines = lines.value;
      }
      if (places.status === 'fulfilled') {
        adminPlaces = places.value;
      }
      redrawAdmin();
    }).finally(() => {
      adminLoading = false;
      if (adminPending) {
        adminPending = false;
        ensureAdmin();
      }
    });
  }

  // ── Overlay layer: a second, independent stack drawn as line work over the base ──────
  // Kept fully separate from the base stack because the two layers have unrelated coverage floors
  // and their own upstream cadences; they are reconciled per displayed date by pairOverlay(), not
  // by being loaded in lockstep. The overlay does NOT crossfade between frames — it snaps to the
  // nearest paired frame, which keeps one texture binding instead of two and costs nothing legible
  // for line work.
  let overLayer: BaseLayer | null = null;
  let overFrames: { date: string; field: GriddedField }[] = [];
  let overField: GriddedField | null = null;      // frame paired to the date on screen
  let overGen = 0;
  const overNone = Texture.createSolid(device, 0, 0, 0, 0);   // "no overlay": alpha 0 draws nothing
  let lut2Tex: Texture = buildSstColormapLut(device, 'turbo');

  function clearOverlay(): void {
    overField = null;
    for (const f of overFrames) {
      f.field.destroy();
    }
    overFrames = [];
    bgKey = '';
  }

  /**
   * Streams the overlay layer's stack. Deliberately a separate, simpler path than `loadLayer` —
   * that function owns the timeline, calendar bounds, analysis views and status line, none of which
   * the overlay participates in, and threading a second layer through it would couple them.
   */
  async function loadOverlay(): Promise<void> {
    const gen = ++overGen;
    clearOverlay();
    const l = overLayer;
    if (!l) {
      return;
    }
    lut2Tex.destroy();
    lut2Tex = buildSstColormapLut(device, l.colormap);
    const keep = (date: string, f: GriddedField): void => {
      if (gen !== overGen) {
        f.destroy();
        return;
      }
      overFrames.push({ date, field: f });
      overFrames.sort((a, b) => a.date.localeCompare(b.date));
      bgKey = '';
    };
    if (l.bakedStack) {
      try {
        const baked = await GriddedField.loadBakedStack(device, l.bakedStack.pngUrl, l.bakedStack.metaUrl, { everyMonths: Math.max(1, Math.round(stepMonths)) });
        for (const f of baked) {
          keep(f.meta.date, f);
        }
      } catch { /* live months below may still cover it */ }
    }
    if (!l.source) {
      return;
    }
    let range: { start: number; end: number };
    try {
      range = await sourceTimeRange(l.source.servers, l.source.datasets);
    } catch {
      return;   // overlay silently stays empty; the base layer is unaffected
    }
    const floor = ANALYSIS_META[l.key]?.start;
    if (floor) {
      range.start = Math.max(range.start, Date.UTC(parseInt(floor.slice(0, 4), 10), parseInt(floor.slice(5, 7), 10) - 1, 1, 12) / 1000);
    }
    const dates = sampledDates(range, SINCE_YEAR, stepMonths).filter((d) => !overFrames.some((f) => f.date === d));
    // Newest first, like the base stack: the overlay pairs to whatever date is on screen, and that
    // is the newest frame while both stacks stream, so this is the order that pairs soonest.
    await streamPool([...dates].reverse(), 3, async (date) => {
      if (gen !== overGen) {
        return;
      }
      try {
        const f = await loadScalarFrame(l.source!, date, stride);
        if (!Number.isFinite(f.stats()?.mean ?? NaN)) {
          f.destroy();   // all-null grid: a hole in the feed, not a frame (see loadLayer)
          return;
        }
        keep(date, f);
      } catch { /* skip a failed month */ }
    });
  }

  /**
   * The overlay frame paired to epoch `t`: nearest by date, within half the display cadence but
   * never less than 16 days — the SAME rule the analysis engine pairs stacks by, so the map and a
   * program agree on what "the same moment" means. Returns null when the overlay has no frame near
   * that moment, and the shader then draws nothing rather than showing a stale field. Pairing on the
   * base layer's interpolated moment (not its frame index) matters because the two stacks start in
   * different years — ordinal alignment would silently drift them apart.
   */
  function pairOverlay(t: number, baseIdx: number): GriddedField | null {
    if (overFrames.length === 0) {
      return null;
    }
    // Analysis results are labeled with the SPAN they reduce ("2019-01-01–2019-09-01"), not a date,
    // so there is nothing to pair on — and nothing to pair: the program already aligned its own
    // inputs. Fall back to index alignment, but only when no frame carries a real date, so a genuine
    // coverage miss (an overlay whose record starts after the base's) still correctly draws nothing.
    if (!overFrames.some((f) => Number.isFinite(frameEpoch(f.date)))) {
      return overFrames[Math.min(baseIdx, overFrames.length - 1)].field;
    }
    if (!Number.isFinite(t)) {
      return null;
    }
    // Half the cadence, with a 16-day floor only for MONTHLY cadences — at a daily cadence a
    // 16-day tolerance would happily pair frames two weeks apart and call them the same moment.
    const stepMs = stepMonths * 30.44 * 86400e3;
    const tolMs = stepMonths >= 1 ? Math.max(16 * 86400e3, stepMs / 2) : Math.max(86400e3, stepMs / 2);
    let best: { date: string; field: GriddedField } | null = null;
    let bestDt = Infinity;
    for (const f of overFrames) {
      const dt = Math.abs(frameEpoch(f.date) - t);
      if (dt < bestDt) {
        bestDt = dt;
        best = f;
      }
    }
    return best && bestDt <= tolMs ? best.field : null;
  }
  // Analysis-graph display takeover: a display sink swaps its result in as the derived stack;
  // any normal layer/view/pick action clears it back to the regular flow.
  let analysisActive = false;
  let analysisOverLand = false;   // displayed analysis result covers land (from its source layers)
  // The displayed analysis stack carries per-cell significance flags in its blue channel, so the
  // shader should draw the stipple screen. Cleared by any ordinary layer/view change.
  let analysisStipple = false;
  let analysisFmt: ((v: number) => string) | null = null;
  // `?res=` is the decimation stride itself (1 = native, 2 = 0.5°, 4 = 1°), matching what Share
  // writes and what the resolution picker's option values are. Anything else falls back to the
  // default — a shared link that silently reopened at a different resolution would hand back
  // different numbers than the ones it was shared to show.
  const resParam = parseInt(params.get('res') ?? '', 10);
  let stride = [1, 2, 4].includes(resParam) ? resParam : DEFAULT_STRIDE;
  /**
   * How a sub-daily feed is sampled onto a daily frame.
   *
   * `snapshot` takes 12:00 UTC, which is what every GFS layer here has always done — and which is
   * dawn in New Mexico, midday in Nigeria and night in Japan. For a diurnal field that spread is
   * bigger than the geography: GFS skin temperature at one high-desert cell reads 14 °C at 12 UTC
   * and 46 °C six hours later. The reductions sample the whole UTC day instead, which is coherent
   * worldwide because every longitude passes local noon exactly once inside it.
   *
   * Display-only, deliberately: the analysis graph keeps reading the literal 12:00 UTC frame, since
   * it has explicit `timeReduce` ops and a hidden reduction under an op that says "layer" would be
   * a trap. The legend says which one is on screen.
   */
  type DailySampling = 'snapshot' | 'max' | 'min' | 'mean';
  const aggParam = params.get('agg') ?? '';
  let sampling: DailySampling = (['max', 'min', 'mean'] as const).includes(aggParam as 'max')
    ? aggParam as DailySampling : 'snapshot';

  /** Loads one dated frame of a scalar layer, honouring the sampling mode for sub-daily feeds. */
  async function loadScalarFrame(src: ScalarSource, date: string, atStride: number): Promise<GriddedField> {
    const flip = isGfs(src) ? await gfsLatFlipped(`${date}T12:00:00Z`) : false;
    if (sampling !== 'snapshot' && isGfs(src)) {
      return GriddedField.loadScalarDaily(device, src, {
        date, reduce: sampling, stride: strideFor(src, atStride), flipLat: flip,
      });
    }
    return GriddedField.loadScalar(device, routeByDate(src, date), {
      timeSel: `(${date}T12:00:00Z)`, stride: strideFor(src, atStride), flipLat: flip,
    });
  }

  /** Suffix for the legend/status so a reduced frame is never mistaken for an instantaneous one. */
  const samplingLabel = (): string => (sampling === 'snapshot' ? '' : ` · daily ${sampling}`);

  /** Whether THIS source is actually being reduced (only sub-daily feeds can be). */
  const reducing = (src: ScalarSource | undefined): boolean =>
    sampling !== 'snapshot' && !!src && isGfs(src);
  // Fractional = sub-monthly (0.033 ≈ daily, 0.25 ≈ weekly); whole numbers walk calendar months.
  const stepParam = parseFloat(params.get('step') ?? '');
  let stepMonths = Number.isFinite(stepParam) && stepParam > 0 && stepParam <= 12
    ? stepParam : DEFAULT_STEP_MONTHS;
  let loadGen = 0;
  const isTemporal = (l: BaseLayer): boolean => l.kind === 'oisst' || l.kind === 'live' || l.kind === 'imagery';  // calendar-pickable
  const hasTimeline = (l: BaseLayer): boolean => isTemporal(l) || !!l.bakedStack || l.kind === 'gfw';  // any dated stack
  const analyzable = (l: BaseLayer): boolean => hasTimeline(l) && l.kind !== 'imagery';  // views need CPU cells

  function clearFields(): void {
    // Drop every reference to the soon-destroyed textures FIRST — currentField/nextField and the
    // cached bind group otherwise reach the next queue.submit as destroyed textures.
    analysisActive = false;
    analysisOverLand = false;
    analysisStipple = false;
    analysisFmt = null;
    showAnalysisAnnotations(null);
    showAnalysisVectors(null);
    // A program-supplied overlay belongs to the analysis result, so it leaves with it. An overlay the
    // user picked from the dropdown is independent of the base layer and stays put.
    if (overLayer?.key === 'analysis-over') {
      clearOverlay();
      overLayer = null;
      ui.setOverlayLegend(null);
    }
    currentField = null;
    nextField = null;
    bindGroup = null;
    bgKey = '';
    for (const f of absFrames) {
      if (!f.shared) {
        f.field.destroy();
      }
    }
    for (const d of derived) {
      d.field.destroy();
    }
    absFrames = [];
    derived = [];
    frames = absFrames;
    singleField?.destroy();
    singleField = null;
    pickedField?.destroy();
    pickedField = null;
    bootField?.destroy();
    bootField = null;
    idx = 0;
    followNewest = true;   // a fresh stack starts by riding its newest frame again
  }

  /** How the current cadence reads in the status line. */
  function cadenceLabel(): string {
    if (stepMonths >= 1) {
      return `every ${stepMonths} mo`;
    }
    const d = Math.max(1, Math.round(stepMonths * 30.44));
    return `every ${d === 1 ? 'day' : `${d} days`} (latest ${MAX_SUBMONTHLY_FRAMES} frames)`;
  }

  // ── Display scale ──────────────────────────────────────────────────────────────────
  /**
   * User override of the color scale's range, and an optional quantization into discrete bands.
   *
   * Layers ship with a range chosen to make the WHOLE WORLD legible — SST spans −2..34 °C — which
   * is exactly wrong for looking at one shelf sea, where the entire signal lives inside two degrees
   * and arrives as a single flat color. Null means "use the layer's own range".
   */
  // `?vmin=`/`?vmax=`/`?bands=`/`?cmap=` so a chosen scale travels in a shared link. A screenshot of
  // a rescaled map is unreadable without them: the same colors mean different numbers.
  // ── Season filter ──────────────────────────────────────────────────────────────────
  /** Months of year to keep, or null for all. `?season=jja` / `?season=7`. */
  let seasonMonths: number[] | null =
    SEASONS.find((s) => s.key && s.key === params.get('season'))?.months ?? null;

  /**
   * The absolute stack restricted to the chosen months.
   *
   * Everything that reads the stack goes through this — the time-lapse, the derived reductions and
   * the point/area readouts — so "the map is showing summers" means the same thing in the animation,
   * the mean, and the chart underneath. Station match-ups are the deliberate exception: those
   * collocate to each station's OWN date, and filtering the record there would report a miss for a
   * sample that the product covers perfectly well.
   */
  function seasonFrames(): typeof absFrames {
    if (!seasonMonths) {
      return absFrames;
    }
    const keep = new Set(seasonMonths);
    return absFrames.filter((f) => keep.has(parseInt(f.date.slice(5, 7), 10)));
  }

  /** How the active filter reads in the legend title and CSV provenance. */
  function seasonLabel(): string {
    return seasonMonths ? (SEASONS.find((s) => s.months === seasonMonths)?.label ?? '') : '';
  }

  // ── A/B compare ────────────────────────────────────────────────────────────────────
  /**
   * The date pinned on the other side of the divider, or null when comparing is off.
   *
   * Two dates under one projection, one color scale and one set of coastlines is the only way a
   * difference of a degree or two can be judged by eye. Flipping between two screenshots cannot do
   * it — the eye has no memory for absolute color.
   */
  let compareDate: string | null = params.get('cmp');
  /** Divider position as a fraction of canvas width; follows the cursor while comparing. */
  let dividerFrac = 0.5;

  /** Index of the frame nearest `compareDate`, or null when off / nothing loaded. */
  function compareIndex(): number | null {
    if (!compareDate || frames.length === 0) {
      return null;
    }
    const want = frameEpoch(compareDate);
    if (!Number.isFinite(want)) {
      return null;
    }
    let best = 0;
    for (let i = 1; i < frames.length; i++) {
      if (Math.abs(frameEpoch(frames[i].date) - want) < Math.abs(frameEpoch(frames[best].date) - want)) {
        best = i;
      }
    }
    return best;
  }

  let scaleOverride = scaleFromParams();
  let scaleLevels = [0, 5, 8, 10, 16].includes(Number(params.get('bands'))) ? Number(params.get('bands')) : 0;
  /** Colormap override, so a layer's default can be swapped without editing the table. */
  let colormapOverride: SstColormapName | null =
    SST_COLORMAPS.some((c) => c.name === params.get('cmap')) ? params.get('cmap') as SstColormapName : null;

  /** Position of a physical value in the CURRENT field's byte encoding, in 0..1. */
  function normalizeInField(v: number, meta: GriddedMeta): number {
    if (meta.isLog) {
      const lo = Math.log10(Math.max(meta.min, 1e-12));
      const hi = Math.log10(Math.max(meta.max, 1e-12));
      return (Math.log10(Math.max(v, 1e-12)) - lo) / (hi - lo || 1);
    }
    return (v - meta.min) / (meta.max - meta.min || 1);
  }

  /**
   * The shader's remap for the current override. Values are byte-encoded over the FIELD's range at
   * fetch time, so a narrower display window is a shift-and-stretch of the normalized value rather
   * than a refetch — which also means the 8-bit encoding is the precision floor; see scaleBands().
   */
  function scaleRemap(): { offset: number; invWidth: number; levels: number } {
    const meta = currentField?.meta;
    if (!scaleOverride || !meta) {
      return { offset: 0, invWidth: 1, levels: scaleLevels };
    }
    const a = normalizeInField(scaleOverride.min, meta);
    const b = normalizeInField(scaleOverride.max, meta);
    const w = b - a;
    return Math.abs(w) < 1e-6 ? { offset: 0, invWidth: 1, levels: scaleLevels } : { offset: a, invWidth: 1 / w, levels: scaleLevels };
  }

  /**
   * How many of the encoding's 256 steps survive inside the chosen window. Narrow far enough and the
   * map posterizes — not a bug in the range control but a hard limit of storing the field as bytes
   * over its full range, and the user has to be told rather than left wondering why a smooth
   * gradient turned into stripes.
   */
  function scaleBands(): number {
    const meta = currentField?.meta;
    if (!scaleOverride || !meta) {
      return 256;
    }
    const w = Math.abs(normalizeInField(scaleOverride.max, meta) - normalizeInField(scaleOverride.min, meta));
    return Math.max(1, Math.round(256 * w));
  }

  /**
   * Percentile range of the frame on screen, restricted to the drawn region when there is one.
   * A 256-bin histogram over the stored bytes IS the exact distribution — the values are bytes —
   * so this needs no sampling or sorting.
   */
  function autoFitRange(loPct: number, hiPct: number): { min: number; max: number } | null {
    const f = currentField;
    if (!f?.values || !f.mask) {
      return null;
    }
    const { width: W, height: H } = f.meta;
    const region = drawVerts.length >= 3
      ? { kind: 'polygon' as const, points: drawVerts.map((v) => [v.lon, v.lat] as [number, number]) }
      : null;
    const hist = new Float64Array(256);
    let total = 0;
    for (let y = 0; y < H; y++) {
      const lat = 90 - ((y + 0.5) / H) * 180;
      // cos(lat) weighting, for the same reason every other spatial reduction here uses it.
      const w = Math.cos((lat * Math.PI) / 180);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!f.mask[i]) {
          continue;
        }
        if (region && !inRegion(((x + 0.5) / W) * 360 - 180, lat, region)) {
          continue;
        }
        hist[f.values[i]] += w;
        total += w;
      }
    }
    if (total <= 0) {
      return null;
    }
    const at = (p: number): number => {
      let acc = 0;
      for (let b = 0; b < 256; b++) {
        acc += hist[b];
        if (acc >= total * p) {
          return f.decode(b);
        }
      }
      return f.decode(255);
    };
    const min = at(loPct), max = at(hiPct);
    return max > min ? { min, max } : null;
  }

  /** Legend/colormap spec for the active layer + view, before any user scale override. */
  function baseViewSpec(): LegendSpec {
    const dr = layer.deltaRange ?? (layer.max - layer.min) * 0.1;
    const rel = layer.fmtRel ?? ((v: number): string => `${v > 0 ? '+' : ''}${layer.fmt(v)}`);
    const span = layer.fmtSpan ?? layer.fmt;
    // The season goes in the TITLE, not just a control: a mean over summers and a mean over
    // everything look alike and mean entirely different things, and the legend is what survives
    // into a screenshot.
    const s = seasonLabel();
    const over = s ? `over ${s}` : 'over all years';
    const season = s ? ` · ${s}` : '';
    switch (view) {
      case 'delta': return { title: `${layer.legend} — Δ vs ${deltaYears} year${deltaYears > 1 ? 's' : ''} earlier${season}`, colormap: 'balance', min: -dr, max: dr, isLog: false, fmt: rel };
      case 'mean': return { title: `${layer.legend} — mean ${over}`, colormap: layer.colormap, min: layer.min, max: layer.max, isLog: layer.isLog, fmt: layer.fmt };
      case 'min': return { title: `${layer.legend} — min ${over}`, colormap: layer.colormap, min: layer.min, max: layer.max, isLog: false, fmt: layer.fmt };
      case 'max': return { title: `${layer.legend} — max ${over}`, colormap: layer.colormap, min: layer.min, max: layer.max, isLog: false, fmt: layer.fmt };
      case 'range': return { title: `${layer.legend} — range (max−min) ${over}`, colormap: 'viridis', min: 0, max: (layer.max - layer.min) / 2, isLog: false, fmt: span };
      default: {
        const sp = layer.kind === 'obis'
          ? OBIS_SPECIES.find((x) => x.taxon === obisSpecies)?.label ?? obisSpecies
          : null;
        return { title: `${sp ? `${sp} — occurrence records` : layer.legend}${season}`, colormap: layer.colormap, min: layer.min, max: layer.max, isLog: layer.isLog, fmt: layer.fmt, hidden: layer.kind === 'imagery' || layer.kind === 'geo-live' };
      }
    }
  }

  /**
   * The legend as displayed: the view's own spec with the user's range and colormap applied, so the
   * ticks always describe the colors actually on screen.
   */
  function viewSpec(): LegendSpec {
    const base = baseViewSpec();
    return {
      ...base,
      // The sampling belongs in the TITLE for the same reason the season does: a daily max and a
      // 12 UTC snapshot look alike and mean entirely different things, and the legend is what
      // survives into a screenshot.
      ...(reducing(layer.source) ? { title: `${base.title}${samplingLabel()}` } : {}),
      ...(scaleOverride ? { min: scaleOverride.min, max: scaleOverride.max } : {}),
      ...(colormapOverride ? { colormap: colormapOverride } : {}),
    };
  }

  /** Rebuilds the displayed stack for the current view from the absolute frames (CPU, instant). */
  function applyView(v: ViewKey): void {
    // Each view has its own natural range (an anomaly is ±3, the absolute field is −2..34), so a
    // range picked for one is meaningless on the next — but only on an actual CHANGE. Resetting
    // unconditionally also fired at boot and on a season change, throwing away a range that arrived
    // in the share link before it was ever used.
    if (v !== view) {
      scaleOverride = null;
    }
    view = v;
    analysisActive = false;
    analysisOverLand = false;
    analysisStipple = false;
    analysisFmt = null;
    showAnalysisAnnotations(null);
    showAnalysisVectors(null);
    for (const d of derived) {
      d.field.destroy();
    }
    derived = [];
    if (v === 'abs') {
      frames = seasonFrames();
    } else {
      derived = buildDerived(v);
      frames = derived;
    }
    idx = Math.max(0, frames.length - 1);   // newest frame, not the oldest
    nextField = null;
    bindGroup = null;
    // Never fall back to a field that may have just been destroyed (e.g. the previous derived
    // stack) — an empty view shows the background until its frames exist.
    currentField = frames[0]?.field ?? null;
    if (frames[0]) { ui.setDate(frames[0].date); }
    const spec = viewSpec();
    lutTex.destroy();
    lutTex = buildSstColormapLut(device, spec.colormap);
    bgKey = '';
    ui.setLegend(spec);
    infoPanel.refresh(infoContext());   // the view note describes whichever view is active
  }

  /** Derived analysis stacks, computed from the absolute frames' CPU cells on a fixed 0.5° grid. */
  function buildDerived(v: ViewKey): { date: string; field: GriddedField }[] {
    const src = seasonFrames().filter((f) => f.field.values && f.field.mask);
    if (src.length === 0) {
      return [];
    }
    const W = 720, H = 360;
    const spec = viewSpec();
    const meta = (variable: string, date: string): GriddedMeta => ({
      variable, source: src[0].field.meta.source, date, width: W, height: H,
      min: spec.min, max: spec.max, isLog: false, vector: false,
    });
    const lonAt = (x: number): number => ((x + 0.5) / W) * 360 - 180;
    const latAt = (y: number): number => 90 - ((y + 0.5) / H) * 180;
    const norm = (val: number): number => Math.max(0, Math.min(255, Math.round(((val - spec.min) / (spec.max - spec.min)) * 255)));

    if (v === 'delta') {
      // One Δ frame per date that has a frame ~deltaYears earlier — stays animatable/scrubbable.
      const out: { date: string; field: GriddedField }[] = [];
      const YEAR = 365.25 * 86400e3;
      for (const cur of src) {
        const t = frameEpoch(cur.date) - deltaYears * YEAR;
        let ref: typeof cur | null = null;
        for (const cand of src) {
          if (Math.abs(frameEpoch(cand.date) - t) < 62 * 86400e3 && (!ref || Math.abs(frameEpoch(cand.date) - t) < Math.abs(frameEpoch(ref.date) - t))) {
            ref = cand;
          }
        }
        if (!ref || ref === cur) {
          continue;
        }
        const values = new Uint8Array(W * H);
        const mask = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const a = cur.field.sample(lonAt(x), latAt(y));
            const b = ref.field.sample(lonAt(x), latAt(y));
            if (a === null || b === null) {
              continue;
            }
            const i = y * W + x;
            values[i] = norm(a - b); mask[i] = 1;
          }
        }
        out.push({ date: cur.date, field: GriddedField.fromBytes(device, values, mask, meta('delta', cur.date)) });
      }
      return out;
    }

    // mean / min / max / range over every loaded frame → a single static frame.
    const values = new Uint8Array(W * H);
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
        for (const f of src) {
          const s = f.field.sample(lonAt(x), latAt(y));
          if (s !== null) {
            lo = Math.min(lo, s); hi = Math.max(hi, s); sum += s; n++;
          }
        }
        // A range needs two samples to mean anything; the rest need one.
        if (n === 0 || (v === 'range' && n < 2)) {
          continue;
        }
        const i = y * W + x;
        values[i] = norm(v === 'mean' ? sum / n : v === 'min' ? lo : v === 'max' ? hi : hi - lo);
        mask[i] = 1;
      }
    }
    const span = `${src[0].date.slice(0, 4)}–${src[src.length - 1].date.slice(0, 4)}`;
    return [{ date: span, field: GriddedField.fromBytes(device, values, mask, meta(v, span)) }];
  }

  async function loadLayer(): Promise<void> {
    const gen = ++loadGen;
    ui.setLegend(viewSpec());
    ui.refreshScaleControls();   // the new layer's own range seeds the inputs
    clearFields();
    // A shared link can pin the timeline to a date — jump to the nearest frame once, then forget.
    const jumpToSharedDate = (): void => {
      const want = params.get('date');
      if (!want || frames.length === 0) {
        return;
      }
      params.delete('date');
      followNewest = false;   // the link asked for a specific date
      let best = 0;
      for (let i = 1; i < frames.length; i++) {
        if (Math.abs(frameEpoch(frames[i].date) - frameEpoch(want)) < Math.abs(frameEpoch(frames[best].date) - frameEpoch(want))) {
          best = i;
        }
      }
      idx = best;
      currentField = frames[best].field;
      ui.setDate(frames[best].date);
    };
    if (layer.kind === 'geo-live') {
      // Live geostationary composite: one "now" frame, reprojected client-side.
      statusEl.textContent = 'Fetching GOES full-disk imagery…';
      try {
        const f = await loadGeoComposite(device);
        if (gen !== loadGen) { f.destroy(); return; }
        singleField = f; currentField = f;
        ui.setDate(f.meta.date.slice(0, 10));
        statusEl.textContent = `${layer.legend} · ${f.meta.date.slice(0, 16).replace('T', ' ')}Z · ${f.meta.source}`;
      } catch (e) {
        statusEl.textContent = `${layer.legend} unavailable (${(e as Error).message}).`;
      }
      return;
    }
    if (layer.kind === 'obis') {
      // A single aggregated field — every record OBIS holds for this species, gridded.
      statusEl.textContent = `Fetching OBIS records for ${obisSpecies}…`;
      try {
        const f = await loadObisGrid(device, obisSpecies, { precision: obisPrecision });
        if (gen !== loadGen) { f.destroy(); return; }
        singleField = f; currentField = f;
        ui.setDate(f.meta.date.slice(0, 10));
        const st = f.stats();
        statusEl.textContent = `${obisSpecies} · ${st && Number.isFinite(st.max) ? `up to ${Math.round(st.max)} records/cell` : 'no records'}`
          + ` · grid ${obisPrecision} · ${f.meta.source}`;
      } catch (e) {
        statusEl.textContent = `OBIS: ${(e as Error).message}`;
      }
      return;
    }
    if (layer.kind === 'gfw') {
      // Twelve monthly frames from the SAME requests a single annual snapshot would cost — the tiles
      // carry every month per cell. Frames are cached in the loader, so re-selecting is instant and
      // the stack must NOT be destroyed here.
      statusEl.textContent = `Fetching Global Fishing Watch effort for ${gfwYear}…`;
      try {
        const frames = await loadGfwEffortStack(device, { year: gfwYear, zoom: 2 });
        if (gen !== loadGen) { return; }
        for (const f of frames) {
          absFrames.push({ date: f.meta.date, field: f, shared: true });
        }
        absFrames.sort((a, b) => a.date.localeCompare(b.date));
        if (absFrames.length && view === 'abs') {
          idx = absFrames.length - 1;
          currentField = absFrames[idx].field;
          ui.setDate(absFrames[idx].date);
        }
        const peak = Math.max(...frames.map((f) => f.stats()?.max ?? 0));
        statusEl.textContent = `${absFrames.length} months · ${gfwYear} apparent fishing effort`
          + ` · up to ${Math.round(peak)} h/cell · ${frames[0].meta.source}`;
        if (view !== 'abs') {
          applyView(view);
        }
      } catch (e) {
        statusEl.textContent = `Global Fishing Watch: ${(e as Error).message}`;
      }
      return;
    }
    if (layer.kind === 'imagery') {
      // GIBS daily imagery: a dated stack on the shared timeline (VIIRS lags ~a day, so the
      // newest frame — and the calendar's max — is the day before yesterday).
      const maxISO = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
      ui.setDateBounds(GIBS_TRUE_COLOR_START, maxISO);
      const dates = sampledDates({ start: Date.parse(GIBS_TRUE_COLOR_START) / 1000, end: Date.parse(maxISO) / 1000 + 43200 }, SINCE_YEAR, stepMonths);
      let assembled = 0;
      await streamPool([...dates].reverse(), 2, async (date) => {   // newest day first
        if (gen !== loadGen) { return; }
        try {
          const f = await loadGibsDay(device, date);
          if (gen !== loadGen) { f.destroy(); return; }
          absFrames.push({ date, field: f });
          absFrames.sort((a, b) => a.date.localeCompare(b.date));
          if (!currentField || currentField === bootField) {
            followNewest = true;
          }
          followNewestFrame();
        } catch { /* skip a failed day */ }
        assembled++;
        if (gen === loadGen) {
          statusEl.textContent = `Assembling ${layer.legend} ${assembled}/${dates.length}…`;
        }
      });
      if (gen === loadGen) {
        statusEl.textContent = absFrames.length
          ? `${absFrames.length} frames · ${layer.legend} · every ${stepMonths} mo since ${absFrames[0].date.slice(0, 4)} · NASA GIBS`
          : `${layer.legend} unavailable.`;
        jumpToSharedDate();
      }
      return;
    }
    if (layer.kind === 'baked') {
      // Baked-only layer: either a dated stack (full timeline — playback/scrub/views, no calendar
      // picks since there's no live feed) or a single snapshot.
      try {
        if (layer.bakedStack) {
          const baked = await GriddedField.loadBakedStack(device, layer.bakedStack.pngUrl, layer.bakedStack.metaUrl, { everyMonths: Math.max(1, Math.round(stepMonths)) });
          if (gen !== loadGen) { baked.forEach((f) => f.destroy()); return; }
          for (const f of baked) {
            absFrames.push({ date: f.meta.date, field: f });
          }
          if (absFrames.length && view === 'abs') { idx = absFrames.length - 1; currentField = absFrames[idx].field; ui.setDate(absFrames[idx].date); }
          statusEl.textContent = `${absFrames.length} frames · ${layer.legend} · baked · ${absFrames[0]?.field.meta.source ?? ''}`;
          if (view !== 'abs') {
            applyView(view);
          }
        } else {
          const f = await GriddedField.loadBaked(device, layer.pngUrl!, layer.metaUrl!);
          if (gen !== loadGen) { f.destroy(); return; }
          singleField = f; currentField = f;
          statusEl.textContent = `${layer.legend} · baked snapshot · ${f.meta.date?.slice(0, 10) ?? ''}`;
        }
      } catch {
        statusEl.textContent = `${layer.legend} unavailable.`;
      }
      return;
    }
    // Live time-lapse stack (OISST temp/anomaly/ice, or WaveWatch III wave height), optionally
    // preceded by committed baked frames covering the years before the live feed's floor.
    const src = layer.source!;
    if (layer.bakedStack) {
      try {
        const baked = await GriddedField.loadBakedStack(device, layer.bakedStack.pngUrl, layer.bakedStack.metaUrl, { everyMonths: Math.max(1, Math.round(stepMonths)) });
        if (gen !== loadGen) { baked.forEach((f) => f.destroy()); return; }
        for (const f of baked) {
          absFrames.push({ date: f.meta.date, field: f });
        }
        if (absFrames.length && view === 'abs') { idx = absFrames.length - 1; currentField = absFrames[idx].field; ui.setDate(absFrames[idx].date); }
      } catch { /* live frames still stream below */ }
    }
    let range: { start: number; end: number } | null = null;
    // Live feed unreachable (it happens — NCEI drops whole datasets for hours at a time, answering
    // "unknown datasetID"): the baked stack alone still gives the full committed timeline, views
    // and date deeplinks, and the feed is retried with backoff so the newer dates arrive once it
    // is back, without a reload. A layer change (loadGen) ends the retries.
    for (let attempt = 0; !range; attempt++) {
      try {
        range = await sourceTimeRange(src.servers, src.datasets);
      } catch (e) {
        if (gen !== loadGen) {
          return;
        }
        const waitS = Math.min(300, 30 * 2 ** attempt);
        const newest = absFrames.length ? absFrames[absFrames.length - 1].date.slice(0, 10) : '';
        statusEl.textContent = absFrames.length
          ? `${absFrames.length} frames · ${layer.legend} · baked frames through ${newest} — live feed `
            + `unavailable (${(e as Error).message}), retrying in ${waitS < 60 ? `${waitS}s` : `${waitS / 60} min`}`
          : `${layer.legend} unavailable (${(e as Error).message}) — retrying in ${waitS}s`;
        if (attempt === 0) {
          if (view !== 'abs') {
            applyView(view);
          }
          jumpToSharedDate();
        }
        await new Promise((res) => setTimeout(res, waitS * 1000));
        if (gen !== loadGen) {
          return;
        }
      }
    }
    if (gen !== loadGen) { return; }
    // A feed can ADVERTISE more time than it serves: PacIOOS's GFS aggregation spans 2022-12→now but
    // its four radiation fluxes are all-null before ~2026-01. The per-layer coverage floor in
    // ANALYSIS_META is the authority, so clamp to it instead of streaming empty frames (and offering
    // empty days in the calendar) for the advertised-but-unserved months.
    const floor = ANALYSIS_META[layer.key]?.start;
    if (floor) {
      range.start = Math.max(range.start, Date.UTC(parseInt(floor.slice(0, 4), 10), parseInt(floor.slice(5, 7), 10) - 1, 1, 12) / 1000);
    }
    const dates = sampledDates(range, SINCE_YEAR, stepMonths).filter((d) => !absFrames.some((f) => f.date === d));
    // Fetched NEWEST FIRST. The date list is chronological because everything else (calendar
    // bounds, the "already have it" filter, the status line) reads it that way, so only the
    // fetch order is reversed: the first frame on screen is then today's, and the record fills
    // in behind it, instead of the map sitting on a decade-old frame until the stream finishes.
    const fetchOrder = [...dates].reverse();
    // Calendar bounds = the LIVE feed's range (picked days are fetched live; baked years are
    // reachable via the scrubber, which spans the full merged stack).
    const liveMinISO = new Date(Math.max(range.start, Date.UTC(SINCE_YEAR, 0, 1, 12) / 1000) * 1000).toISOString().slice(0, 10);
    ui.setDateBounds(liveMinISO, new Date(range.end * 1000).toISOString().slice(0, 10));
    // Cell size for the status line, read back from a loaded frame rather than inferred from the
    // stride — feeds differ in native spacing, and `strideScale` decimates the finer ones further.
    const res = (): string => {
      // The DISPLAYED frame's grid, not the stack's oldest. A committed baked frame (0.5°) and a
      // live native one (0.25°) routinely sit in the same stack, and labelling the whole stack by
      // whichever frame happens to be oldest reports a resolution the map is not showing.
      const w = (currentField ?? absFrames[absFrames.length - 1]?.field)?.meta.width ?? 0;
      return w ? `${+(360 / w).toFixed(2)}°` : `~${(stride * 0.25).toFixed(2)}°`;
    };
    let fetched = 0;
    await streamPool(fetchOrder, 3, async (date) => {
      if (gen !== loadGen) { return; }
      try {
        const f = await loadScalarFrame(src, date, stride);
        if (gen !== loadGen) { f.destroy(); return; }
        // An all-null grid is a HOLE in the feed, not a frame: ERDDAP answers 200 with every cell
        // null for dates a variable doesn't actually cover. Keeping it would blank the map mid-
        // playback and poison the Δ / min / max views, which read every frame's cells.
        if (!Number.isFinite(f.stats()?.mean ?? NaN)) {
          f.destroy();
        } else {
          absFrames.push({ date, field: f });
          absFrames.sort((a, b) => a.date.localeCompare(b.date));
          // Take the screen from nothing OR from the boot snapshot (it may have landed mid-stream),
          // and keep riding the newest frame as older ones insert behind it.
          if (!currentField || currentField === bootField) {
            followNewest = true;
          }
          followNewestFrame();
        }
      } catch { /* skip a failed day */ }
      fetched++;
      if (gen === loadGen) {
        statusEl.textContent = `Streaming ${layer.legend} ${fetched}/${dates.length} · ${res()}…`;
      }
    });
    if (gen === loadGen) {
      statusEl.textContent = absFrames.length
        ? `${absFrames.length} frames · ${layer.legend} · ${cadenceLabel()} since ${absFrames[0].date.slice(0, 10)} · ${res()} · ${src.source}`
        : `${layer.legend} unavailable.`;
      if (view !== 'abs') {
        applyView(view);   // (re)build the derived view over the completed stack
      } else {
        // Settle on the newest frame — normally already there, since the stream started with it,
        // but a frame can arrive out of order and the last one in is not necessarily the latest.
        // Skipped once the user has scrubbed or started playback: finishing a background load is
        // not a reason to move the date out from under them.
        followNewestFrame();
      }
      jumpToSharedDate();   // a ?date deeplink still wins
    }
  }

  // A single day picked from the calendar (OISST layers), fetched on demand, held apart.
  let pickedField: GriddedField | null = null;
  let pickGen = 0;
  async function pickDate(dateStr: string): Promise<void> {
    if (!isTemporal(layer)) { return; }
    const gen = ++pickGen;
    statusEl.textContent = `Loading ${dateStr}…`;
    try {
      const f = layer.kind === 'imagery'
        ? await loadGibsDay(device, dateStr)
        : await loadScalarFrame(layer.source!, dateStr, stride);
      if (gen !== pickGen) { f.destroy(); return; }
      if (view !== 'abs' || analysisActive) {
        ui.setView('abs');
        applyView('abs');   // a picked day is an absolute field (and never an analysis result)
      }
      pickedField?.destroy();
      pickedField = f; currentField = f;
      followNewest = false;   // a picked day outranks a stack still streaming in behind it
      ui.setPlaying(false); ui.setDate(dateStr);
      statusEl.textContent = `${dateStr} · ${layer.legend} · picked day`;
    } catch {
      if (gen === pickGen) { statusEl.textContent = `Couldn't load ${dateStr}.`; }
    }
  }

  // ── Analysis graph: presets panel + display-sink takeover ─────────────────────────
  // `forecast` nodes run a small LiteRT neural net on-device; the module (and LiteRT's
  // WASM runtime behind it) loads lazily on first use, like the Ask tab's SDK. The version
  // string mirrors FORECAST_VERSION in lib/analysis_forecast.ts — bump both on retrain.
  const forecaster: AnalysisForecaster = {
    version: 'sst-anom-v2',
    layers: ['anom'],
    run: (req, store) => import('./ui/analysis_forecast.js').then((m) => m.runForecast(req, store)),
  };
  const analysisStore = new FieldStore(buildAnalysisProviders(device), { loadOni: loadOniSeries, defaultStepMonths: 4, forecaster });
  const analysisPanel = installAnalysisPanel({
    store: analysisStore,
    onDisplay: showAnalysisResult,
    onAnnotate: showAnalysisAnnotations,
    onVectors: showAnalysisVectors,
    format: formatAnalysisValue,
    // Plot exports reuse the map's CSV writer, so they carry the same provenance header — a file
    // that says which program produced it and in what units.
    exportCsv: (name, header, rows) => downloadCsv(name, header, rows, [
      `${name} exported from the Earth Explorer analysis graph`,
      'values are the analysis engine\'s decoded physical floats on its 1° grid',
    ]),
  });

  /** Shows a display-sink result on the map, exactly like a derived view: the analysis
   *  fields become the owned displayed stack (scrubbable when temporal), with the sink's
   *  colormap and physical legend range. */
  function showAnalysisResult(d: DisplayResult): void {
    for (const dd of derived) {
      dd.field.destroy();
    }
    derived = [];
    nextField = null;
    bindGroup = null;
    bgKey = '';
    const span = d.legend.max - d.legend.min || 1;
    analysisStipple = d.insignificant !== undefined;
    for (const [fi, f] of d.fields.entries()) {
      const values = new Uint8Array(f.values.length);
      const mask = new Uint8Array(f.values.length);
      for (let i = 0; i < f.values.length; i++) {
        const v = f.values[i];
        if (Number.isFinite(v)) {
          values[i] = Math.max(0, Math.min(255, Math.round(((v - d.legend.min) / span) * 255)));
          mask[i] = 1;
        }
      }
      derived.push({
        date: f.date,
        field: GriddedField.fromBytes(device, values, mask, {
          variable: 'analysis', source: 'analysis graph', date: f.date, width: f.width, height: f.height,
          min: d.legend.min, max: d.legend.max, isLog: false, vector: false,
        }, d.insignificant?.[fi]),
      });
    }
    frames = derived;
    idx = 0;
    currentField = frames[0]?.field ?? null;
    if (frames[0]) {
      ui.setDate(frames[0].date);
    }
    lutTex.destroy();
    lutTex = buildSstColormapLut(device, d.legend.colormap as SstColormapName);
    analysisFmt = (v) => formatAnalysisValue(v, d.legend.unit, d.legend.relative);
    ui.setLegend({
      title: d.legend.title,
      colormap: d.legend.colormap as SstColormapName,
      min: d.legend.min,
      max: d.legend.max,
      isLog: false,
      fmt: analysisFmt,
    });
    // The derivation caveat rides with the map, not just the answer text: whoever screenshots this
    // legend must get the baseline and the significance filter along with the colors. Set AFTER
    // setLegend, which clears any note left by a previous result.
    ui.setNote(d.notes && d.notes.length > 0 ? d.notes.join(' · ') : null);
    // A `display` with its `over` input wired becomes the overlay layer, going through exactly the
    // same path a picked overlay does: a synthetic BaseLayer carries the draw spec, so the shader
    // uniforms, the legend strip and pairOverlay's date matching are all reused rather than forked.
    clearOverlay();
    overLayer = null;
    if (d.overlay) {
      const o = d.overlay;
      const oSpan = o.legend.max - o.legend.min || 1;
      const oFmt = (v: number): string => formatAnalysisValue(v, o.legend.unit, o.legend.relative);
      lut2Tex.destroy();
      lut2Tex = buildSstColormapLut(device, o.legend.colormap as SstColormapName);
      for (const f of o.fields) {
        const values = new Uint8Array(f.values.length);
        const mask = new Uint8Array(f.values.length);
        for (let i = 0; i < f.values.length; i++) {
          const v = f.values[i];
          if (Number.isFinite(v)) {
            values[i] = Math.max(0, Math.min(255, Math.round(((v - o.legend.min) / oSpan) * 255)));
            mask[i] = 1;
          }
        }
        overFrames.push({
          date: f.date,
          field: GriddedField.fromBytes(device, values, mask, {
            variable: 'analysis-over', source: 'analysis graph', date: f.date, width: f.width, height: f.height,
            min: o.legend.min, max: o.legend.max, isLog: false, vector: false,
          }),
        });
      }
      overFrames.sort((a, b) => a.date.localeCompare(b.date));
      overLayer = {
        key: 'analysis-over', label: o.legend.title, group: 'Ocean',
        colormap: o.legend.colormap as SstColormapName, legend: o.legend.title,
        min: o.legend.min, max: o.legend.max, isLog: false, fmt: oFmt, kind: 'live',
        overlayBands: o.bands, overlayHatchAt: o.hatchAt,
      };
      ui.setOverlayLayer('');   // the picker has no entry for a program-supplied overlay
    }
    ui.setOverlayLegend(overlayLegendSpec());
    analysisActive = true;
    analysisOverLand = d.overLand;
    lastStatsField = null;   // re-derive the stats line with the analysis formatter
  }

  /** The last displayVectors result, so the overlay window can re-rasterize it after a zoom. */
  let lastVectors: VectorsResult | null = null;

  /** Rasterizes a displayVectors sink into the equirect overlay texture (null clears it). */
  function showAnalysisVectors(res: VectorsResult | null): void {
    if (analysisVecTex !== analysisVecNone) {
      analysisVecTex.destroy();
    }
    analysisVecTex = analysisVecNone;
    analysisVecGen++;
    lastVectors = res;
    bindGroup = null;
    bgKey = '';
    if (!res) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    const step = Math.max(1, Math.round(res.strideDeg / (360 / res.width)));   // grid cells between arrows
    // Grid cells are laid out in raster px through the WINDOW, so both the spacing and the arrow
    // length that follows from it grow as the view zooms in — arrows stay proportional to the gap
    // between them instead of shrinking into dots.
    const cellPx = TW / (res.width * overlayWin.du);
    const cellPy = TH / (res.height * overlayWin.dv);
    const maxLen = step * cellPx * 0.85 * res.scale;
    // Two passes per arrow — a dark halo under a light stroke — so arrows read on any layer.
    const drawArrows = (style: string, width: number): void => {
      cx.strokeStyle = style;
      cx.lineWidth = width;
      cx.lineCap = 'round';
      for (let gy = Math.floor(step / 2); gy < res.height; gy += step) {
        for (let gx = Math.floor(step / 2); gx < res.width; gx += step) {
          const i = gy * res.width + gx;
          const uu = res.u[i], vv = res.v[i];
          if (!Number.isFinite(uu) || !Number.isFinite(vv)) {
            continue;
          }
          const mag = Math.hypot(uu, vv);
          if (mag < 1e-9 || res.maxMag <= 0) {
            continue;
          }
          const len = Math.min(1.15, mag / res.maxMag) * maxLen;
          if (len < 2) {
            continue;
          }
          // Cell center → equirect uv → window px. Arrows are independent points, so each takes the
          // wrap copy nearest the window — unlike a polyline, there is no path to tear. The grid is
          // world-wide, so most cells land off-canvas once the window is small; the 2D context
          // clips them for free.
          let cu = (gx + 0.5) / res.width;
          cu -= Math.round(cu - (overlayWin.u0 + overlayWin.du / 2));
          const px = (cu - overlayWin.u0) * cellPx * res.width;
          const py = ((gy + 0.5) / res.height - overlayWin.v0) * cellPy * res.height;
          const dx = uu / mag, dy = -vv / mag;   // canvas y grows southward
          const tx = px - (dx * len) / 2, ty = py - (dy * len) / 2;
          const hx = px + (dx * len) / 2, hy = py + (dy * len) / 2;
          cx.beginPath();
          cx.moveTo(tx, ty);
          cx.lineTo(hx, hy);
          // Arrowhead: two barbs swept back from the tip.
          const head = Math.min(7, len * 0.35);
          const bx = -dx * head, by = -dy * head;
          cx.moveTo(hx + bx - by * 0.6, hy + by + bx * 0.6);
          cx.lineTo(hx, hy);
          cx.lineTo(hx + bx + by * 0.6, hy + by - bx * 0.6);
          cx.stroke();
        }
      }
    };
    drawArrows('rgba(0,0,0,0.55)', 3.4);
    drawArrows('rgba(255,255,255,0.92)', 1.6);
    analysisVecTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  // ── Analysis extrema markers (annotate sink): screen-space pins over the flat map ────
  const markerLayer = document.createElement('div');
  markerLayer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:9';
  document.body.appendChild(markerLayer);
  let analysisMarkers: AnnotateResult | null = null;
  const markerEls: HTMLDivElement[] = [];

  function showAnalysisAnnotations(a: AnnotateResult | null): void {
    analysisMarkers = a;
    markerLayer.textContent = '';
    markerEls.length = 0;
    if (!a) {
      return;
    }
    for (const m of a.markers) {
      const el = document.createElement('div');
      const hot = m.kind === 'max';
      el.style.cssText = 'position:fixed;transform:translate(-50%,-100%);display:none;text-align:center;'
        + 'font:12px ui-monospace,monospace;text-shadow:0 1px 3px #000,0 0 6px #000;white-space:nowrap';
      el.style.color = hot ? '#ffb454' : '#7fd8ff';
      const value = formatAnalysisValue(m.value, a.unit, a.relative);
      el.innerHTML = `<div style="font-size:13px">${value}</div><div style="font-size:14px;line-height:8px">${hot ? '▲' : '▼'}</div>`;
      el.title = `${a.label} · ${Math.abs(m.lat).toFixed(1)}°${m.lat >= 0 ? 'N' : 'S'} ${Math.abs(m.lon).toFixed(1)}°${m.lon >= 0 ? 'E' : 'W'}`;
      markerLayer.appendChild(el);
      markerEls.push(el);
    }
  }

  /** Repositions the pins every frame: lon/lat → forward projection → view transform → px. */
  function updateAnalysisMarkers(): void {
    if (!analysisMarkers || markerEls.length === 0) {
      return;
    }
    const globeMode = ui.mode() === 'globe';
    const rect = canvas.getBoundingClientRect();
    const s = flatScale();
    analysisMarkers.markers.forEach((m, i) => {
      const el = markerEls[i];
      const f = globeMode ? null : flatProj.forward(m.lon, m.lat);
      if (!f) {
        el.style.display = 'none';   // globe mode, or a hemisphere the projection hides
        return;
      }
      let u = (f.px / flatProj.halfW) * 0.5 + 0.5;
      const v = 0.5 - (f.py / flatProj.halfH) * 0.5;
      if (flatProj.wraps) {
        u = viewCx + ((((u - viewCx) % 1) + 1.5) % 1) - 0.5;   // nearest wrap copy to the view
      }
      const fx = 0.5 + (u - viewCx) * zoom;
      const fy = 0.5 + (v - viewCy) * zoom;
      if (fx < -0.02 || fx > 1.02 || fy < -0.02 || fy > 1.02) {
        el.style.display = 'none';   // panned/zoomed out of view
        return;
      }
      el.style.display = 'block';
      el.style.left = `${((fx - 0.5) * s.sx + 0.5) * rect.width + rect.left}px`;
      el.style.top = `${((fy - 0.5) * s.sy + 0.5) * rect.height + rect.top}px`;
    });
  }

  const ensoPanel = buildEnsoPanel();

  // ── Layer info overlay (legend ⓘ) ────────────────────────────────────────────────────
  // Selecting a layer is shared by the picker and by the info panel's correlate chips, so both go
  // through one function — the chips would otherwise switch the field without moving the `<select>`.
  function switchLayer(key: string): void {
    layer = LAYERS.find((l) => l.key === key) ?? LAYERS[0];
    view = 'abs';
    // A range and a ramp belong to the QUANTITY they were chosen for: carrying "20..24" from sea
    // temperature onto rainfall would silently show one band of color over an empty-looking world.
    scaleOverride = null;
    colormapOverride = null;
    ui.setLayer(layer.key);
    ui.setView('abs');
    ui.setViewEnabled(analyzable(layer));
    ui.resetScaleControls();
    lutTex.destroy();
    lutTex = buildSstColormapLut(device, layer.colormap);
    bgKey = '';
    void loadLayer();
    infoPanel.refresh(infoContext());   // keep an open panel on the layer it now describes
  }

  /** Legend spec for the overlay layer, or null when there is no overlay. */
  function overlayLegendSpec(): OverlayLegendSpec | null {
    const l = overLayer;
    if (!l) {
      return null;
    }
    return {
      title: l.legend,
      colormap: l.colormap,
      min: l.min,
      max: l.max,
      isLog: l.isLog,
      fmt: l.fmt,
      hatchNote: l.overlayHatchAt !== undefined ? `≥ ${l.fmt(l.overlayHatchAt)}` : undefined,
    };
  }

  /** Switches (or clears, on `''`) the overlay layer. */
  function switchOverlay(key: string): void {
    const next = key ? LAYERS.find((l) => l.key === key && overlayable(l)) ?? null : null;
    overLayer = next;
    ui.setOverlayLayer(next?.key ?? '');
    ui.setOverlayLegend(overlayLegendSpec());
    infoPanel.refresh(infoContext());
    void loadOverlay();
  }

  /** The dynamic half of the info panel's content: what is on screen right now. */
  function infoContext(): LayerInfoContext {
    const meta = ANALYSIS_META[layer.key];
    const o = overLayer;
    return {
      key: layer.key,
      label: layer.label,
      legendTitle: viewSpec().title,
      ticks: ui.legendTicks(),
      source: layer.source?.source ?? (layer.bakedStack ? 'baked atlas (host sends no CORS header)' : undefined),
      coverage: meta?.start,
      caveats: meta?.caveats,
      view,
      overlay: o
        ? {
          key: o.key,
          label: o.label,
          how: o.overlayHatchAt !== undefined
            ? `Drawn over the base as iso-lines every ${o.fmt((o.max - o.min) / (o.overlayBands ?? 8))}, with diagonal hatching where it reaches ${o.fmt(o.overlayHatchAt)} — the threshold that makes this layer actionable.`
            : `Drawn over the base as iso-lines every ${o.fmt((o.max - o.min) / (o.overlayBands ?? 8))}, tinted by its own colormap.`,
          paired: overField ? overField.meta.date.slice(0, 10) : null,
        }
        : undefined,
    };
  }

  const infoPanel = installLayerInfoPanel({
    onLayer: (key) => switchLayer(key),
    labelFor: (key) => LAYERS.find((l) => l.key === key)?.label ?? null,
  });

  /**
   * "Get this data": the exact griddap request behind the frame on screen, as a NetCDF/CSV URL, an
   * xarray snippet, an R snippet and a citation. Built from the same `layer.source` + stride + date
   * the loader used, so what someone downloads is what they were looking at.
   */
  const reproducePanel = installReproducePanel({
    makeDraggable,
    context: () => {
      const src = layer.source;
      if (!src) {
        // Baked atlases (chlorophyll, currents) ship as committed PNGs because their ERDDAP hosts
        // send no CORS header — there is no live query to hand over, and pretending otherwise
        // would produce a URL that fails from the browser.
        return { unavailable: `${layer.label} is served from a committed baked atlas, not a live query — `
          + 'see the ⓘ panel for the product and provider. Pick a live layer (SST, waves, coral heat '
          + 'stress, the GFS atmosphere layers) for a reproducible request.' };
      }
      if (analysisActive) {
        return { unavailable: 'The map is showing an analysis result, which is computed from one or '
          + 'more layers rather than fetched. Switch back to a data layer to get its request, or use '
          + 'the analysis panel\'s CSV export for the numbers behind the plot.' };
      }
      const date = (frames[idx]?.date ?? '').slice(0, 10);
      const s = strideFor(src, stride);
      // Read the resolution off the grid that actually came back rather than deriving it from the
      // source metadata: `strideScale` is a stride multiplier, NOT a native-cell ratio, and these
      // products' native grids disagree anyway (OISST 0.25°, GFS 0.5°, Coral Reef Watch 0.05°).
      // The returned width is the one number that is true for every layer.
      const gridW = frames[idx]?.field.meta.width ?? currentField?.meta.width ?? 0;
      const drawn = drawVerts.length >= 3 ? regionBbox({ kind: 'polygon', points: drawVerts.map((v) => [v.lon, v.lat] as [number, number]) }) : null;
      return {
        ctx: {
          request: {
            servers: src.servers, datasets: src.datasets, variable: src.variable,
            hasLevel: src.hasLevel === true,
            // A reduced frame is a RANGE request plus a reduction, and the panel exists so a reader
            // can rerun exactly what they are looking at — so it emits the range, not the 12Z instant.
            timeSel: reducing(src) && date
              ? `(${date}T00:00:00Z):1:(${date}T21:00:00Z)`
              : date ? `(${date}T12:00:00Z)` : '(last)',
            stride: s,
            reduce: reducing(src) ? sampling as 'max' | 'min' | 'mean' : undefined,
          },
          layerKey: layer.key,
          layerLabel: layer.legend,
          unit: ANALYSIS_META[layer.key]?.unit,
          box: drawn,
          resolutionDeg: gridW > 0 ? 360 / gridW : undefined,
        },
        cite: LAYER_INFO[layer.key]?.cite,
      };
    },
  });

  const ui = buildUI({
    getStride: () => stride,
    // Resolution and cadence apply to BOTH stacks — the overlay is decimated and sampled on the
    // same terms as the base, and pairOverlay's tolerance is derived from the cadence.
    setStride: (s) => { stride = s; if (isTemporal(layer)) { void loadLayer(); } if (overLayer) { void loadOverlay(); } },
    getStep: () => stepMonths,
    setStep: (m) => { stepMonths = m; if (hasTimeline(layer)) { void loadLayer(); } if (overLayer) { void loadOverlay(); } },
    getSampling: () => sampling,
    setSampling: (s) => {
      sampling = s;
      // Only the sub-daily feeds change; reloading anyway keeps one code path and costs a refetch
      // the user just asked for by touching the control.
      if (isTemporal(layer)) { void loadLayer(); }
      if (overLayer) { void loadOverlay(); }
      ui.setLegend(viewSpec());
    },
    getView: () => ({ z: zoom, cx: viewCx, cy: viewCy }),
    onFlyTo: (lon, lat, z) => flyTo(lon, lat, z),
    frameDate: (i) => frames[i]?.date ?? null,
    onScrub: (i) => {
      if (frames.length === 0) { return; }
      followNewest = false;   // the user picked a date; a still-streaming stack must not take it back
      idx = Math.max(0, Math.min(frames.length - 1, i));
      currentField = frames[idx].field;
      ui.setDate(frames[idx].date);
    },
    onPickDate: (d) => { void pickDate(d); },
    onLayer: (key) => { switchLayer(key); },
    onOverlayLayer: (key) => { switchOverlay(key); },
    getSpecies: () => obisSpecies,
    onSpecies: (taxon) => {
      obisSpecies = taxon;
      if (layer.kind === 'obis') {
        void loadLayer();
      }
    },
    getTracks: () => atnTaxon,
    onTracks: (taxon) => {
      atnTaxon = taxon;
      void loadTracks();
    },
    onDraw: (m) => {
      drawMode = m === 'line' || m === 'area' ? m : 'off';
      clearGeometry();
      updateGeometryReadout();   // say what to do BEFORE the first click, not after
    },
    drawnRing: () => (drawVerts.length ? formatRing(drawVerts.map((v) => [v.lon, v.lat])) : null),
    earthCam: () => [
      ['clon', camLon.toFixed(2)], ['clat', camLat.toFixed(2)], ['calt', camAlt.toFixed(3)],
      ['ctilt', camTilt.toFixed(3)], ['chdg', camHeading.toFixed(3)],
    ],
    onInfo: () => { infoPanel.show(infoContext()); },
    onReproduce: () => { reproducePanel.toggle(); },
    onImport: () => { importPanel.toggle(); },
    onView: (v) => { applyView(v); },
    onDeltaYears: (n) => {
      deltaYears = n;
      if (view === 'delta') {
        applyView('delta');   // rebuild the Δ stack against the new reference year
      }
    },
    onUnit: (f) => {
      UNIT_F = f;
      ui.setLegend(viewSpec());
      lastStatsField = null;   // re-derive the stats line in the new unit
      if (lastPoint) {
        showPointSeries(lastPoint.lon, lastPoint.lat);
      }
    },
    onScaleRange: (range) => {
      scaleOverride = range;
      ui.setLegend(viewSpec());
    },
    onScaleLevels: (levels) => { scaleLevels = levels; },
    onColormap: (name) => {
      colormapOverride = name;
      lutTex.destroy();
      lutTex = buildSstColormapLut(device, viewSpec().colormap);
      bindGroup = null;
      bgKey = '';
      ui.setLegend(viewSpec());
    },
    onScaleAuto: () => {
      // p2–p98 rather than the extremes: one anomalous cell would otherwise set the whole scale,
      // which is the failure the auto-fit exists to avoid.
      const r = autoFitRange(0.02, 0.98);
      if (r) {
        scaleOverride = r;
        ui.setLegend(viewSpec());
      }
      return r;
    },
    scaleBands: () => scaleBands(),
    onCompare: (dateISO) => {
      compareDate = dateISO || null;
      dividerFrac = 0.5;   // recenter so the seam is findable before the cursor has moved
      // On a touchscreen the seam does not follow anything, so say that it is a handle — an
      // unexplained white line down the middle of the map reads as a rendering fault.
      if (compareDate && HAS_TOUCH) {
        statusEl.textContent = 'Comparing — drag the white seam to swipe between the two dates';
      }
      const i = compareIndex();
      return i === null ? null : frames[i].date.slice(0, 10);
    },
    onSeason: (key) => {
      seasonMonths = SEASONS.find((s) => s.key && s.key === key)?.months ?? null;
      // Rebuild through applyView so the reductions recompute over the new subset and the
      // time-lapse re-indexes, rather than leaving a stale derived frame on screen.
      applyView(view);
      ui.setLegend(viewSpec());
      if (lastPoint) {
        showPointSeries(lastPoint.lon, lastPoint.lat);
      }
    },
    compareSnapped: () => {
      const i = compareIndex();
      return i === null ? null : frames[i].date.slice(0, 10);
    },
    currentRange: () => ({ min: viewSpec().min, max: viewSpec().max }),
    sharedScale: () => ({ range: scaleOverride, levels: scaleLevels, colormap: colormapOverride }),
    onOverlay: (which, on) => {
      if (which === 'wind' && on) { ensureWind(); }
      if (which === 'radar' && on) { ensureRadar(); }
      if (which === 'storms') {
        stormsOn = on;
        if (on) {
          ensureStorms();
        } else {
          redrawStorms();   // draws nothing while off; frees the raster
        }
      }
      if (which === 'fire') {
        fireOn = on;
        if (on) {
          ensureFire();
        } else {
          redrawFire();
        }
      }
      if (which === 'borders' || which === 'cities') {
        if (which === 'borders') {
          bordersOn = on;
        } else {
          citiesOn = on;
        }
        ensureAdmin();
      }
    },
    onEnso: (on) => {
      ensoPanel.setVisible(on && !noGui);
      if (on) { ensoPanel.ensureLoaded(); }
    },
    onSun: (on) => { if (on) { ensureNight(); } },
    onProjection: () => {
      flatProj = projectionByKey(ui.projection());
      clampView();   // wrap↔clamp semantics differ per projection
    },
    analysisButton: noGui ? undefined : analysisPanel.button,
  });
  ui.setLegend(viewSpec());
  ui.setView(view);
  ui.setViewEnabled(analyzable(layer));
  const overParam = params.get('over') ?? '';
  if (overParam && LAYERS.some((l) => l.key === overParam && overlayable(l))) {
    switchOverlay(overParam);   // `?over=` deeplinks a two-layer composite
  }
  if (params.has('info') && !noGui) {
    infoPanel.show(infoContext());   // `?info` deeplinks straight to a layer's explanation
  }
  void loadLayer();
  if (atnTaxon) { void loadTracks(); }   // `?tracks=` deeplink
  if (ui.overlay('wind')) { ensureWind(); }   // URL-enabled overlays need their lazy loads kicked
  if (ui.overlay('radar')) { ensureRadar(); }
  if (ui.overlay('storms')) { ensureStorms(); }
  if (ui.sun()) { ensureNight(); }
  if (ui.enso()) { ensoPanel.setVisible(!noGui); ensoPanel.ensureLoaded(); }   // ?enso deeplink

  // ── View interaction: drag = pan (flat) / rotate (globe), wheel = zoom ─────────────
  let globeYaw = 0;
  let globeTilt = -0.35;
  let dragging = false;
  let dragDist = 0;   // px moved since pointerdown — separates a pan from a point-analysis click
  let lastX = 0, lastY = 0;
  const clampf = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  /** Hermite ease between two edges — the surface-lock ↔ free-fly blend uses it. */
  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = clampf((x - e0) / (e1 - e0 || 1), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // Flat modes stream detail tiles (aerial imagery to z19, sub-meter), so the flat zoom cap is
  // "as deep as the tiles go" (~400 m across the screen). The globe streams the same window
  // but its cap is where the orthographic ray math's plain f32 still resolves sub-pixel uv
  // steps (~2048, ≈20 km across the screen); beyond that the flat modes take over.
  const MAX_ZOOM = 131072;
  // ── Earth-mode camera ────────────────────────────────────────────────────────────────
  // An orbit camera around a target point on the surface: the target is where you are looking, tilt
  // leans the eye off the vertical toward the horizon, heading swings it around, and altitude is how
  // far out it sits. That is the Google-Earth mental model, and it keeps "what am I looking at"
  // separate from "from where" — which is what makes dragging feel like flying rather than spinning.
  let camLon = parseFloat(params.get('clon') ?? '') || -30;
  let camLat = parseFloat(params.get('clat') ?? '') || 25;
  let camAlt = parseFloat(params.get('calt') ?? '') || 1.6;   // eye distance from the target, in radii
  let camTilt = parseFloat(params.get('ctilt') ?? '') || 0;    // 0 = straight down, →1.4 rad = horizon
  let camHeading = parseFloat(params.get('chdg') ?? '') || 0;
  const CAM_FOV = 45 * Math.PI / 180;

  /** Unit-sphere direction for a lon/lat, matching the shader's dirToUv inverse. */
  function dirFromLonLat(lonDeg: number, latDeg: number): [number, number, number] {
    const lo = (lonDeg * Math.PI) / 180, la = (latDeg * Math.PI) / 180;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  }

  /**
   * Builds the eye/basis the shader needs. Done on the CPU because it is uniform across the frame —
   * and in f32 the difference between "computed once" and "computed per pixel" shows up as shimmer.
   */
  function earthCamera(): { eye: [number, number, number]; fwd: [number, number, number];
    right: [number, number, number]; up: [number, number, number]; } {
    const T = dirFromLonLat(camLon, camLat);
    // Local frame at the target. At a pole, east from the world Y axis degenerates, so fall back to
    // an arbitrary but stable axis rather than emitting NaNs.
    const wy: [number, number, number] = [0, 1, 0];
    let E: [number, number, number] = [
      wy[1] * T[2] - wy[2] * T[1], wy[2] * T[0] - wy[0] * T[2], wy[0] * T[1] - wy[1] * T[0],
    ];
    let eLen = Math.hypot(E[0], E[1], E[2]);
    if (eLen < 1e-6) {
      E = [1, 0, 0];
      eLen = 1;
    }
    E = [E[0] / eLen, E[1] / eLen, E[2] / eLen];
    const N: [number, number, number] = [
      T[1] * E[2] - T[2] * E[1], T[2] * E[0] - T[0] * E[2], T[0] * E[1] - T[1] * E[0],
    ];
    const ct = Math.cos(camTilt), st = Math.sin(camTilt);
    const ch = Math.cos(camHeading), sh = Math.sin(camHeading);
    // Offset direction from the target toward the eye: radial when tilt is 0, swinging into the
    // tangent plane (along heading) as tilt grows.
    const off: [number, number, number] = [
      T[0] * ct + (E[0] * sh + N[0] * ch) * st,
      T[1] * ct + (E[1] * sh + N[1] * ch) * st,
      T[2] * ct + (E[2] * sh + N[2] * ch) * st,
    ];
    const eye: [number, number, number] = [
      T[0] + off[0] * camAlt, T[1] + off[1] * camAlt, T[2] + off[2] * camAlt,
    ];
    let fwd: [number, number, number] = [T[0] - eye[0], T[1] - eye[1], T[2] - eye[2]];
    const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    fwd = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
    // Roll-free basis: right is horizontal with respect to the offset direction (the local up).
    let right: [number, number, number] = [
      fwd[1] * off[2] - fwd[2] * off[1], fwd[2] * off[0] - fwd[0] * off[2], fwd[0] * off[1] - fwd[1] * off[0],
    ];
    let rl = Math.hypot(right[0], right[1], right[2]);
    if (rl < 1e-6) {
      right = [E[0], E[1], E[2]];
      rl = 1;
    }
    right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up: [number, number, number] = [
      right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0],
    ];
    return { eye, fwd, right, up };
  }

  const GLOBE_MAX_ZOOM = 2048;
  // The globe may zoom BELOW 1 (a smaller sphere with space around it); the flat map may not — its
  // zoom 1 already letterboxes the whole world, and below that it would just shrink into the middle.
  const GLOBE_MIN_ZOOM = 0.3;
  const zoomMin = (): number => (ui.mode() === 'globe' ? GLOBE_MIN_ZOOM : 1);
  let zoom = clampf(parseFloat(params.get('z') ?? '1') || 1, zoomMin(), MAX_ZOOM);
  let viewCx = parseFloat(params.get('cx') ?? '0.5');
  let viewCy = parseFloat(params.get('cy') ?? '0.5');
  // The active flat projection (the UI select updates it via onProjection). The globe is a
  // separate mode; projectionByKey falls back to the equirect map for 'globe'/unknown keys.
  let flatProj = projectionByKey(params.get('proj'));
  // These two deeplinks are kicked HERE, not with the others above, because both read the view:
  // the fire feeds query the visible bbox and the boundary set is chosen by zoom, neither of which
  // exists until the lines just above have run.
  if (ui.overlay('fire')) { ensureFire(); }
  if (ui.overlay('borders') || ui.overlay('cities')) { ensureAdmin(); }
  function clampView(): void {
    zoom = clampf(zoom, zoomMin(), MAX_ZOOM);
    if (ui.mode() === 'globe') {
      // The globe is rotated by yaw/tilt, not panned by a view center, and its zoom is free to go
      // below 1. Everything below is the flat map's letterbox/pan bookkeeping.
      viewCx = 0.5; viewCy = 0.5;
      return;
    }
    if (zoom < 1.001) {
      zoom = 1; viewCx = 0.5; viewCy = 0.5;
      return;
    }
    const half = 0.5 / zoom;
    viewCy = clampf(Number.isFinite(viewCy) ? viewCy : 0.5, half, 1 - half);
    if (!Number.isFinite(viewCx)) {
      viewCx = 0.5;
    } else if (flatProj.wraps) {
      viewCx = ((viewCx % 1) + 1) % 1;   // cylindrical: pan around the world
    } else {
      viewCx = clampf(viewCx, half, 1 - half);   // bounded projections: stay on the map
    }
  }
  clampView();
  /** The flat view's letterbox scale (matches the shader's aspect fit). */
  function flatScale(): { sx: number; sy: number } {
    const a = canvas.clientWidth / canvas.clientHeight;
    const mapA = flatProj.halfW / flatProj.halfH;
    return a > mapA ? { sx: mapA / a, sy: 1 } : { sx: 1, sy: a / mapA };
  }
  /**
   * Globe-mode pick: canvas pixel → lon/lat, or null when the click misses the sphere. This is the
   * CPU inverse of the shader's orthographic globe (KEEP IN SYNC with the `u.p1.z > 0.5` branch in
   * fs): same aspect correction, same 1.12·zoom scale, same y flip, then the same rotX(tilt) →
   * rotY(yaw) applied to the un-rotated surface normal.
   *
   * Deliberately intersects the ANALYTIC sphere rather than re-marching the relief shell the shader
   * draws: a pick asks a geographic question, and the terrain parallax between the two answers is
   * far smaller than one data cell even at the coarsest zoom.
   */
  function globePick(clientX: number, clientY: number): { lonDeg: number; latDeg: number } | null {
    const p = uvAtGlobeScreen(clientX / canvas.clientWidth, clientY / canvas.clientHeight);
    return p ? { lonDeg: (p.u - 0.5) * 360, latDeg: (0.5 - p.v) * 180 } : null;
  }

  /**
   * Earth-mode pick: intersect the camera ray with the ANALYTIC sphere. The rendered surface is the
   * relief shell, so on a mountain flank this lands a little short of the drawn pixel — far less than
   * one data cell, and the alternative is duplicating the 64-step march on the CPU.
   */
  function earthPick(clientX: number, clientY: number): { lonDeg: number; latDeg: number } | null {
    const c = earthCamera();
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const qx = (clientX / canvas.clientWidth - 0.5) * 2 * aspect * Math.tan(CAM_FOV / 2);
    const qy = -(clientY / canvas.clientHeight - 0.5) * 2 * Math.tan(CAM_FOV / 2);
    const rd = [
      c.fwd[0] + c.right[0] * qx + c.up[0] * qy,
      c.fwd[1] + c.right[1] * qx + c.up[1] * qy,
      c.fwd[2] + c.right[2] * qx + c.up[2] * qy,
    ];
    const rl = Math.hypot(rd[0], rd[1], rd[2]) || 1;
    const d = [rd[0] / rl, rd[1] / rl, rd[2] / rl];
    const b = c.eye[0] * d[0] + c.eye[1] * d[1] + c.eye[2] * d[2];
    const cc = c.eye[0] ** 2 + c.eye[1] ** 2 + c.eye[2] ** 2 - 1;
    const disc = b * b - cc;
    if (disc <= 0) {
      return null;   // the ray misses the globe — sky
    }
    const t = -b - Math.sqrt(disc);
    if (t <= 0) {
      return null;
    }
    const px = c.eye[0] + d[0] * t, py = c.eye[1] + d[1] * t, pz = c.eye[2] + d[2] * t;
    const len = Math.hypot(px, py, pz) || 1;
    return {
      lonDeg: (Math.atan2(px / len, pz / len) * 180) / Math.PI,
      latDeg: (Math.asin(Math.max(-1, Math.min(1, py / len))) * 180) / Math.PI,
    };
  }

  /** Screen pixel → lon/lat in whichever mode is active, or null off the map/sphere. */
  function pickLonLat(clientX: number, clientY: number): { lonDeg: number; latDeg: number } | null {
    if (ui.mode() === 'earth') {
      return earthPick(clientX, clientY);
    }
    if (ui.mode() === 'globe') {
      return globePick(clientX, clientY);
    }
    const { u, v } = canvasToUv(clientX, clientY);
    if (flatProj.wraps && zoom < 1.001 && (u < 0 || u > 1)) {
      return null;   // whole-world letterbox: the side bars are not places
    }
    let px = (u * 2 - 1) * flatProj.halfW;
    if (flatProj.wraps) {
      const span = 2 * flatProj.halfW;
      px = ((px + flatProj.halfW) % span + span) % span - flatProj.halfW;
    }
    return flatProj.inverse(px, (1 - v * 2) * flatProj.halfH);
  }

  /** Canvas pixel → map uv through the letterbox + zoom/pan transform (flat mode). */
  function canvasToUv(clientX: number, clientY: number): { u: number; v: number } {
    const s = flatScale();
    const fx = (clientX / canvas.clientWidth - 0.5) / s.sx + 0.5;
    const fy = (clientY / canvas.clientHeight - 0.5) / s.sy + 0.5;
    return { u: viewCx + (fx - 0.5) / zoom, v: viewCy + (fy - 0.5) / zoom };
  }

  // ── Detail-window + deep-zoom support (flat modes) ─────────────────────────────────
  /** f64 twin of the shader's flat path: letterboxed map-frame point → equirect uv. */
  function uvAtMapFrame(fx: number, fy: number): { u: number; v: number } | null {
    const vx = viewCx + (fx - 0.5) / zoom;
    const vy = viewCy + (fy - 0.5) / zoom;
    if (flatProj.index === 0) {
      return vy >= 0 && vy <= 1 ? { u: vx, v: vy } : null;
    }
    const ll = flatProj.inverse((vx * 2 - 1) * flatProj.halfW, (1 - vy * 2) * flatProj.halfH);
    if (!ll) {
      return null;
    }
    return { u: ll.lonDeg / 360 + 0.5, v: 0.5 - ll.latDeg / 180 };
  }

  /** f64 twin of the shader's globe path: screen fraction → orthographic-sphere uv (analytic
   *  sphere — relief displacement is small and the window's padding absorbs the parallax). */
  function uvAtGlobeScreen(sx: number, sy: number): { u: number; v: number } | null {
    const aspect = canvas.width / canvas.height;
    const k = 1.12 * zoom;
    const qx = ((sx - 0.5) * 2 * aspect) / k;
    const qy = -((sy - 0.5) * 2) / k;
    const r2 = qx * qx + qy * qy;
    if (r2 > 1) {
      return null;   // off the sphere
    }
    const z = Math.sqrt(1 - r2);
    const ct = Math.cos(globeTilt), st = Math.sin(globeTilt);
    const y1 = ct * qy - st * z, z1 = st * qy + ct * z;
    const cy = Math.cos(globeYaw), sy2 = Math.sin(globeYaw);
    const x2 = cy * qx + sy2 * z1, z2 = -sy2 * qx + cy * z1;
    const lon = Math.atan2(x2, z2);
    const lat = Math.asin(clampf(y1, -1, 1));
    return { u: lon / (2 * Math.PI) + 0.5, v: 0.5 - lat / Math.PI };
  }

  /**
   * The visible lon/lat span as an equirect uv rect — u unwrapped about the screen center so
   * a view astride ±180° stays contiguous — padded 15% per side so small pans keep sampling
   * inside the streamed window while the next one loads.
   */
  function visibleUvRect(globe: boolean): { u0: number; v0: number; u1: number; v1: number } | null {
    const s = globe ? { sx: 1, sy: 1 } : flatScale();
    const at = (fx: number, fy: number): { u: number; v: number } | null =>
      globe ? uvAtGlobeScreen(fx, fy) : uvAtMapFrame((fx - 0.5) / s.sx + 0.5, (fy - 0.5) / s.sy + 0.5);
    const center = at(0.5, 0.5);
    if (!center) {
      return null;
    }
    let u0 = center.u, u1 = center.u, v0 = center.v, v1 = center.v;
    const N = 6;
    for (let iy = 0; iy <= N; iy++) {
      for (let ix = 0; ix <= N; ix++) {
        const p = at(ix / N, iy / N);
        if (!p) {
          continue;   // off the projection's world shape / off the sphere
        }
        const uu = p.u - Math.round(p.u - center.u);   // nearest wrap copy to the center
        u0 = Math.min(u0, uu); u1 = Math.max(u1, uu);
        v0 = Math.min(v0, p.v); v1 = Math.max(v1, p.v);
      }
    }
    if (u1 - u0 > 0.9) {
      // Effectively every longitude is on screen (a pole view): take the whole band, and the
      // grid can't have sampled the pole itself, so extend to whichever pole is being viewed.
      u0 = 0; u1 = 1;
      if (flatProj.key === 'arctic' || (globe && center.v < 0.5)) { v0 = 0; }
      if (flatProj.key === 'antarctic' || (globe && center.v >= 0.5)) { v1 = 1; }
    }
    const pu = Math.min(0.15 * (u1 - u0), (1 - (u1 - u0)) * 0.5);
    const pv = 0.15 * (v1 - v0);
    return { u0: u0 - pu, u1: u1 + pu, v0: Math.max(0, v0 - pv), v1: Math.min(1, v1 + pv) };
  }

  const LINEAR_ZOOM = 2048;   // KEEP IN SYNC with the shader's deep-zoom branch
  /** CPU (f64) side of the shader's deep-zoom linearized view — see the WGSL comment there. */
  function fillDeepZoomUniforms(center: { u: number; v: number } | null): void {
    uniform.fill(0, 32, 40);
    // Fill slightly below the shader's threshold so f32 rounding of the zoom uniform can't
    // land the shader in the deep-zoom branch while these are still zeros.
    if (!center || zoom < LINEAR_ZOOM * 0.999) {
      return;
    }
    const e = 1e-3;
    const at = (fx: number, fy: number): { u: number; v: number } => {
      const p = uvAtMapFrame(fx, fy) ?? center;
      return { u: p.u - Math.round(p.u - center.u), v: p.v };
    };
    const xp = at(0.5 + e, 0.5), xm = at(0.5 - e, 0.5);
    const yp = at(0.5, 0.5 + e), ym = at(0.5, 0.5 - e);
    const hiU = Math.fround(center.u), hiV = Math.fround(center.v);
    uniform[32] = hiU; uniform[33] = hiV;                          // uv center, exact f32 part
    uniform[34] = center.u - hiU; uniform[35] = center.v - hiV;    // + the f32 residual
    uniform[36] = (xp.u - xm.u) / (2 * e); uniform[37] = (xp.v - xm.v) / (2 * e);
    uniform[38] = (yp.u - ym.u) / (2 * e); uniform[39] = (yp.v - ym.v) / (2 * e);
  }

  /** A view key that changes whenever the visible region does — shared by the debounced drivers. */
  function viewKey(globe: boolean): string {
    return globe
      ? `globe|${zoom.toPrecision(5)}|${globeYaw.toFixed(7)}|${globeTilt.toFixed(7)}|${canvas.width}`
      : `${flatProj.key}|${zoom.toPrecision(5)}|${viewCx.toFixed(10)}|${viewCy.toFixed(10)}|${canvas.width}`;
  }

  // ── Annotation-overlay re-raster driver ────────────────────────────────────────────
  // Same debounce as the tile streamer below: rasterizing three canvases on every frame of a drag
  // would cost more than the sharpness is worth, and the 15% padding visibleUvRect already applies
  // means a small pan keeps sampling inside the window that is up.
  let overlayViewKey = '';
  let overlaySettleAt = 0;

  /** True when two windows are close enough that re-rasterizing would not visibly change anything. */
  function sameOverlayWin(a: OverlayWin, b: OverlayWin): boolean {
    const tol = 0.02 * Math.max(a.du, b.du);
    return Math.abs(a.u0 - b.u0) < tol && Math.abs(a.v0 - b.v0) < tol
      && Math.abs(a.du - b.du) < tol && Math.abs(a.dv - b.dv) < tol;
  }

  function overlayTick(clock: number, globe: boolean): void {
    // Nothing drawn = nothing to sharpen; leave the window at world so the next raster starts sane.
    if (drawVerts.length === 0 && atnTracks.length === 0 && !lastVectors
      && !(stormsOn && cyclones.length > 0) && !fireOn && !bordersOn && !citiesOn) {
      overlayWin = OVERLAY_WORLD;
      overlayViewKey = '';
      return;
    }
    const key = viewKey(globe);
    if (key !== overlayViewKey) {
      overlayViewKey = key;
      overlaySettleAt = clock + 0.2;
      return;
    }
    if (clock < overlaySettleAt) {
      return;
    }
    // Below ~1.5× the world raster already has texels to spare, and keeping the whole world in it
    // means panning at low zoom never re-rasterizes at all.
    let want = OVERLAY_WORLD;
    if (zoom >= 1.5) {
      const r = visibleUvRect(globe);
      if (r) {
        want = { u0: r.u0, v0: r.v0, du: Math.max(1e-6, r.u1 - r.u0), dv: Math.max(1e-6, r.v1 - r.v0) };
      }
    }
    if (sameOverlayWin(want, overlayWin)) {
      return;
    }
    overlayWin = want;
    redrawGeometry();
    redrawTracks();
    redrawStorms();
    // These two re-QUERY rather than just re-rasterize: the fire feeds are viewport-scoped and the
    // boundary set is scale-scoped, so a settled view is exactly when they should reconsider. Both
    // no-op when the answer has not changed.
    if (fireOn) {
      ensureFire();
    }
    if (bordersOn || citiesOn) {
      ensureAdmin();
    }
    if (lastVectors) {
      showAnalysisVectors(lastVectors);
    }
  }

  // ── Flow-window driver ─────────────────────────────────────────────────────────────
  // The particle overlays get the same treatment as the annotation rasters: zoomed out they cover
  // the world, zoomed in they cover only what is visible, so both the trail raster's texels and
  // the fixed particle budget land where the user is looking instead of being spread over a planet
  // that is mostly off screen. Debounced for a different reason than the others, though — a window
  // change DROPS the accumulated trails, so re-windowing every frame of a drag would leave the flow
  // permanently blank; it must settle first.
  let flowViewKey = '';
  let flowSettleAt = 0;

  function flowTick(clock: number, globe: boolean): void {
    if (!ui.overlay('wind') && !ui.overlay('currents')) {
      return;   // nothing advecting; leave the window where it is
    }
    const key = viewKey(globe);
    if (key !== flowViewKey) {
      flowViewKey = key;
      flowSettleAt = clock + 0.35;
      return;
    }
    if (clock < flowSettleAt) {
      return;
    }
    let want = FLOW_WORLD;
    if (zoom >= 1.5) {
      const r = visibleUvRect(globe);
      if (r) {
        want = { u0: r.u0, v0: r.v0, du: Math.max(1e-6, r.u1 - r.u0), dv: Math.max(1e-6, r.v1 - r.v0) };
      }
    }
    // Same "close enough" test the annotation window uses: a re-window costs every trail on screen,
    // so a sub-pixel difference is not worth paying for.
    const w = flowWin;
    const tol = 0.02 * Math.max(w.du, want.du);
    if (Math.abs(w.u0 - want.u0) < tol && Math.abs(w.v0 - want.v0) < tol
      && Math.abs(w.du - want.du) < tol && Math.abs(w.dv - want.dv) < tol) {
      return;
    }
    flowWin = want;
    windFlow.setWindow(want);
    currentsFlow.setWindow(want);
  }

  // Debounced view → streamer driver: request tiles only once the view has settled briefly,
  // so a zoom gesture doesn't spray requests for every intermediate level.
  let detailViewKey = '';
  let detailSettleAt = 0;
  function detailTick(clock: number, globe: boolean): { u: number; v: number } | null {
    const center = globe ? uvAtGlobeScreen(0.5, 0.5) : uvAtMapFrame(0.5, 0.5);
    if (zoom < 2) {
      detailWin.clear();
      detailViewKey = '';
      return center;
    }
    const key = viewKey(globe);
    if (key !== detailViewKey) {
      detailViewKey = key;
      detailSettleAt = clock + 0.25;
    } else if (clock >= detailSettleAt) {
      const rect = visibleUvRect(globe);
      if (rect) {
        detailWin.request(rect, canvas.width, canvas.height);
      }
    }
    return center;
  }
  /**
   * Zooms by `f` (>1 = closer) about a screen point, keeping whatever is under it fixed.
   *
   * Shared by the wheel and by touch's pinch and double-tap: each mode anchors differently, and a
   * second copy of that arithmetic would be a second copy of its bugs.
   */
  function zoomAt(clientX: number, clientY: number, f: number): void {
    if (ui.mode() === 'earth') {
      // Altitude, not zoom: dividing by f means "zoom in" descends. The floor keeps the eye above
      // the tallest terrain the shell can contain, so the camera cannot end up inside a mountain.
      camAlt = clampf(camAlt / f, 0.004, 8);
      return;
    }
    if (ui.mode() === 'globe') {
      // Anchor at the cursor like the flat modes: restore the lon/lat under it by nudging
      // yaw/tilt (exact at the sphere center, converges over successive steps at the limb; the
      // tilt clamp wins near the poles).
      const sx = clientX / canvas.clientWidth;
      const sy = clientY / canvas.clientHeight;
      const before = uvAtGlobeScreen(sx, sy);
      zoom = clampf(zoom * f, GLOBE_MIN_ZOOM, GLOBE_MAX_ZOOM);
      const after = uvAtGlobeScreen(sx, sy);
      if (before && after) {
        const du = after.u - before.u - Math.round(after.u - before.u);
        globeYaw -= du * 2 * Math.PI;
        globeTilt = clampf(globeTilt - (after.v - before.v) * Math.PI, -1.3, 1.3);
      }
      return;
    }
    // Anchor the zoom at the cursor: keep the uv under it fixed across the scale change.
    const before = canvasToUv(clientX, clientY);
    zoom = clampf(zoom * f, 1, MAX_ZOOM);
    const after = canvasToUv(clientX, clientY);
    viewCx += before.u - after.u;
    viewCy += before.v - after.v;
    clampView();
  }

  // ── Fly-to ──────────────────────────────────────────────────────────────────────────
  // Place search and pasted coordinates land here. Every mode keeps its own idea of "where the
  // camera is" (uv center + zoom, yaw/tilt + zoom, an orbit target, a floating-origin frame), so
  // the flight is expressed per mode and the frame loop eases it in. A cut would also work, but a
  // 1-second glide is what tells the eye which way it went — on a globe especially, where the
  // destination hemisphere may not have been visible at all.
  interface Flight {
    t: number;      // elapsed seconds
    dur: number;
    from: number[];
    to: number[];
    apply: (v: number[]) => void;
  }
  let flight: Flight | null = null;
  const FLY_SECONDS = 1.1;

  /** Eased, with zoom-like components interpolated in log space by the caller. */
  function flyTick(dt: number): void {
    if (!flight) {
      return;
    }
    if (dragging || pinch) {
      flight = null;   // the user grabbed the map mid-flight: their hand wins
      return;
    }
    const f = flight;
    f.t += dt;
    const k = smoothstep(0, 1, f.t / f.dur);
    f.apply(f.from.map((a, i) => a + (f.to[i] - a) * k));
    if (f.t >= f.dur) {
      flight = null;
    }
  }

  /**
   * Glides the view to a lon/lat. `targetZoom` is the flat/globe zoom factor to arrive at (1 =
   * whole world across the viewport); the orbit mode derives its altitude from it.
   */
  function flyTo(lon: number, lat: number, targetZoom: number): void {
    const mode = ui.mode();
    if (mode === 'earth') {
      const alt = clampf(1.6 / targetZoom, 0.004, 8);
      flight = {
        t: 0, dur: FLY_SECONDS,
        from: [camLon, camLat, Math.log(camAlt)],
        to: [camLon + ((lon - camLon + 540) % 360) - 180, lat, Math.log(alt)],
        apply: (v) => { camLon = v[0]; camLat = v[1]; camAlt = Math.exp(v[2]); },
      };
      return;
    }
    if (mode === 'globe') {
      // The screen center sees lon = yaw, lat = −tilt (see uvAtGlobeScreen at qx = qy = 0). Yaw
      // takes the short way round; tilt stays inside the drag clamp so the poles stay reachable
      // only as far as a drag could reach them.
      const yaw = lon * Math.PI / 180;
      const dYaw = ((yaw - globeYaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const z = clampf(targetZoom, GLOBE_MIN_ZOOM, GLOBE_MAX_ZOOM);
      flight = {
        t: 0, dur: FLY_SECONDS,
        from: [globeYaw, globeTilt, Math.log(zoom)],
        to: [globeYaw + dYaw, clampf(-lat * Math.PI / 180, -1.3, 1.3), Math.log(z)],
        apply: (v) => { globeYaw = v[0]; globeTilt = v[1]; zoom = Math.exp(v[2]); },
      };
      return;
    }
    const p = flatProj.forward(lon, lat);
    if (!p) {
      statusEl.textContent = 'That place is outside this projection\'s view — switch projection to go there';
      return;
    }
    let u = (p.px / flatProj.halfW + 1) / 2;
    const v = (1 - p.py / flatProj.halfH) / 2;
    if (flatProj.wraps) {
      u -= Math.round(u - viewCx);   // nearest wrap copy, so the glide never crosses the whole world
    }
    const z = clampf(targetZoom, 1, MAX_ZOOM);
    flight = {
      t: 0, dur: FLY_SECONDS,
      from: [viewCx, viewCy, Math.log(zoom)],
      to: [u, v, Math.log(z)],
      apply: (val) => { viewCx = val[0]; viewCy = val[1]; zoom = Math.exp(val[2]); clampView(); },
    };
  }

  // Active pointers on the canvas: one = drag (pan/rotate), two = pinch zoom. The canvas has
  // `touch-action: none`, so the browser's own pinch/scroll never competes for these gestures.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; midX: number; midY: number } | null = null;

  // ── Touch gestures ──────────────────────────────────────────────────────────────────
  // A finger has no hover, no wheel, no modifier key and no double-click, and this map leans on all
  // four. The stand-ins below are the whole of the difference; every one of them keys off
  // `pointerType`, so the mouse paths stay byte-for-byte what they were.
  //
  //   drag            pan / rotate            (already worked)
  //   two fingers     pinch zoom + aim        (aim is new, and is the only tilt touch can reach)
  //   double-tap      zoom in / close a shape (the wheel and dblclick have no touch equivalent)
  //   long-press      value readout           (stands in for hover)
  //   drag the seam   A/B compare swipe       (the desktop divider follows a cursor there is none of)
  const TAP_SLOP = 12;          // px a finger may travel and still count as a tap
  const LONG_PRESS_MS = 450;
  const DOUBLE_TAP_MS = 320;
  const DIVIDER_GRAB_PX = 44;   // how near the compare seam a finger must land to grab it
  let touchDown: { x: number; y: number; t: number } | null = null;
  let longPressTimer = 0;
  let lastTapAt = -Infinity;
  let lastTapX = 0, lastTapY = 0;
  let dragDivider = false;      // this touch grabbed the A/B seam, so it steers instead of panning
  let suppressClick = false;    // a long-press or double-tap already answered this gesture

  function cancelLongPress(): void {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }

  /** Screen x of the A/B compare seam, in client pixels. */
  function dividerClientX(): number {
    return canvas.getBoundingClientRect().left + dividerFrac * canvas.clientWidth;
  }

  /** Touch double-tap: closes a shape while drawing (as dblclick does), otherwise zooms in. */
  function touchDoubleTap(x: number, y: number): void {
    if (drawMode === 'line' || drawMode === 'area') {
      finishShape();
      return;
    }
    zoomAt(x, y, 2);
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    pinch = null;
    if (pointers.size === 1) {
      dragging = true; dragDist = 0; lastX = e.clientX; lastY = e.clientY;
    } else {
      dragging = false;
      dragDist = 100;   // a pinch is never a point-analysis click
    }
    // Cleared for every pointer type, not just touch: a long-press whose click never arrived would
    // otherwise leave the flag set and swallow the next mouse click on a hybrid machine.
    suppressClick = false;
    if (e.pointerType !== 'touch') {
      return;
    }
    cancelLongPress();
    if (pointers.size !== 1) {
      touchDown = null;
      dragDivider = false;
      return;
    }
    touchDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    // With compare on, the seam becomes a handle: land on it and the drag steers the swipe, land
    // anywhere else and it still pans. Both gestures stay available, which the desktop behavior
    // (the divider simply follows the cursor) cannot offer a finger — there is nothing to follow.
    dragDivider = Boolean(compareDate) && Math.abs(e.clientX - dividerClientX()) < DIVIDER_GRAB_PX;
    if (dragDivider) {
      return;
    }
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      // A held finger is asking "what is the number here" — the question hover answers with a
      // mouse. Suppressing the click keeps it from ALSO opening the point-series panel.
      suppressClick = true;
      dragging = false;
      showTouchReadout(e.clientX, e.clientY);
    }, LONG_PRESS_MS);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Past the tap slop this is a drag, not a press: the readout would land under a moving finger.
    if (touchDown && Math.hypot(e.clientX - touchDown.x, e.clientY - touchDown.y) > TAP_SLOP) {
      cancelLongPress();
    }
    if (dragDivider && pointers.size === 1) {
      dividerFrac = Math.min(1, Math.max(0, (e.clientX - canvas.getBoundingClientRect().left)
        / Math.max(canvas.clientWidth, 1)));
      dragDist = 100;   // steering the seam is not a point-analysis click, however little it moved
      return;
    }
    if (ui.mode() === 'earth' && dragging && pointers.size === 1) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      if (e.shiftKey) {
        // Shift-drag: aim the camera rather than move it. Tilt stops just short of the horizon —
        // past that the march grazes the shell for thousands of steps and buys nothing.
        camHeading += dx * 0.005;
        camTilt = clampf(camTilt + dy * 0.005, 0, 1.45);
      } else {
        // Fly: pan the target. Scaled by altitude so a drag covers a screenful, not a fixed number
        // of degrees — close in it nudges, far out it crosses oceans.
        const k = 0.12 * Math.max(camAlt, 0.02);
        camLon -= dx * k;
        camLat = clampf(camLat + dy * k, -89, 89);
        camLon = ((camLon + 180) % 360 + 360) % 360 - 180;
      }
      return;
    }
    if (pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      if (pinch) {
        const f = dist / pinch.dist;
        if (ui.mode() === 'earth') {
          // Two fingers fly the camera: the spread is the wheel (altitude) and the midpoint's
          // motion is shift-drag (heading + tilt). Without this the pinch fell through to the flat
          // branch below and silently panned a view that is not on screen.
          camAlt = clampf(camAlt / f, 0.004, 8);
          camHeading += (midX - pinch.midX) * 0.005;
          camTilt = clampf(camTilt + (midY - pinch.midY) * 0.005, 0, 1.45);
        } else if (ui.mode() === 'globe') {
          zoom = clampf(zoom * f, GLOBE_MIN_ZOOM, GLOBE_MAX_ZOOM);
          globeYaw += ((midX - pinch.midX) * 0.006) / zoom;
          globeTilt = clampf(globeTilt + ((midY - pinch.midY) * 0.006) / zoom, -1.3, 1.3);
        } else {
          // Pan by the midpoint's motion, then scale anchored at the midpoint.
          const s = flatScale();
          viewCx -= (midX - pinch.midX) / (canvas.clientWidth * s.sx * zoom);
          viewCy -= (midY - pinch.midY) / (canvas.clientHeight * s.sy * zoom);
          const before = canvasToUv(midX, midY);
          zoom = clampf(zoom * f, 1, MAX_ZOOM);
          const after = canvasToUv(midX, midY);
          viewCx += before.u - after.u;
          viewCy += before.v - after.v;
          clampView();
        }
      }
      pinch = { dist, midX, midY };
      return;
    }
    if (!dragging) { return; }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    if (ui.mode() === 'globe') {
      globeYaw += (dx * 0.006) / zoom;
      globeTilt = clampf(globeTilt + (dy * 0.006) / zoom, -1.3, 1.3);
    } else if (zoom > 1.001) {
      const s = flatScale();
      viewCx -= dx / (canvas.clientWidth * s.sx * zoom);
      viewCy -= dy / (canvas.clientHeight * s.sy * zoom);
      clampView();
    }
    lastX = e.clientX; lastY = e.clientY;
  });
  const endDrag = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinch = null;
    if (pointers.size === 1) {
      // Hand off from pinch to a single-finger drag without a position jump.
      const p = [...pointers.values()][0];
      dragging = true; lastX = p.x; lastY = p.y;
    } else if (pointers.size === 0) {
      dragging = false;
    }
    if (e.pointerType !== 'touch') {
      return;
    }
    cancelLongPress();
    const down = touchDown;
    touchDown = null;
    dragDivider = false;
    // `pointercancel` is the OS taking the gesture away (app switcher, edge swipe, an incoming
    // call) — never a tap.
    if (e.type !== 'pointerup' || !down || suppressClick
      || Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) {
      return;
    }
    const now = performance.now();
    if (now - lastTapAt < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
      lastTapAt = -Infinity;
      // The click for THIS tap has not fired yet (click follows pointerup), so suppressing it here
      // means a double-tap zooms instead of also opening a second point readout. The first tap's
      // click has already been through, which matches the mouse: a dblclick is a click first.
      suppressClick = true;
      touchDoubleTap(e.clientX, e.clientY);
      return;
    }
    lastTapAt = now; lastTapX = e.clientX; lastTapY = e.clientY;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ── Hover readout ───────────────────────────────────────────────────────────────────
  // A color map answers "where"; a number answers "how much". Without this the only way to read a
  // value is to click, which commits to a point series and repaints the panel — far too heavy for
  // the constant back-and-forth of "is that eddy warmer than this one".
  //
  // Its own listener rather than a branch inside the pan/pinch handler above: that one returns early
  // down every drag path, and a readout has to survive all of them.
  const hoverBox = document.createElement('div');
  hoverBox.style.cssText = 'position:fixed;z-index:12;display:none;pointer-events:none;padding:3px 7px;'
    + 'background:rgba(8,10,14,0.86);border:1px solid rgba(94,240,200,0.3);border-radius:4px;'
    + 'font-family:ui-monospace,monospace;font-size:11.5px;color:#dfeef0;line-height:1.45;'
    + 'white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.8)';
  document.body.appendChild(hoverBox);
  let hoverPending: { x: number; y: number } | null = null;
  let hoverRaf = 0;
  let touchReadout = false;   // the box is showing a long-press answer, not following a cursor

  /** Formats one field's value at a point, or null when it has none there. */
  function hoverValue(field: GriddedField | null, fmt: (v: number) => string, lon: number, lat: number): string | null {
    const v = field?.sample(lon, lat);
    return v === null || v === undefined || !Number.isFinite(v) ? null : fmt(v);
  }

  function drawHover(): void {
    hoverRaf = 0;
    const at = hoverPending;
    if (!at) {
      return;
    }
    const ll = pickLonLat(at.x, at.y);
    if (!ll) {
      hoverBox.style.display = 'none';   // off the globe / outside the projection's world shape
      return;
    }
    const lines: string[] = [];
    const fmt = analysisFmt ?? viewSpec().fmt;
    const base = hoverValue(currentField, fmt, ll.lonDeg, ll.latDeg);
    // "no data" is a real answer — land, ice, a cloud gap — and saying it beats an empty tooltip
    // that reads as though the readout is broken.
    lines.push(`${layer.legend}: ${base ?? '— no data'}`);
    if (overLayer && overField) {
      const ov = hoverValue(overField, overLayer.fmt, ll.lonDeg, ll.latDeg);
      lines.push(`${overLayer.legend}: ${ov ?? '— no data'}`);
    }
    lines.push(`${Math.abs(ll.latDeg).toFixed(2)}°${ll.latDeg >= 0 ? 'N' : 'S'} `
      + `${Math.abs(ll.lonDeg).toFixed(2)}°${ll.lonDeg >= 0 ? 'E' : 'W'}`);
    hoverBox.innerHTML = lines.map((l, i) => (i === lines.length - 1
      ? `<span style="color:#8fa5ab">${l}</span>` : l)).join('<br>');
    hoverBox.style.display = 'block';
    // Flip to the other side of the cursor near an edge so the box never leaves the window.
    const r = hoverBox.getBoundingClientRect();
    const x = at.x + 14 + r.width > window.innerWidth ? at.x - 14 - r.width : at.x + 14;
    const y = at.y + 14 + r.height > window.innerHeight ? at.y - 14 - r.height : at.y + 14;
    hoverBox.style.left = `${Math.max(2, x)}px`;
    hoverBox.style.top = `${Math.max(2, y)}px`;
  }

  /**
   * The long-press stand-in for hover: pins the same readout beside the finger and leaves it up
   * until the next touch, since a finger has no "moved away" to dismiss it with.
   *
   * Offset well above the touch point — a box drawn where the mouse tooltip goes would sit under
   * the hand that asked for it.
   */
  function showTouchReadout(x: number, y: number): void {
    touchReadout = true;
    // drawHover samples the map at the point it is given, so the offset has to go into the BOX, not
    // into the coordinate — read the value under the finger, draw the answer above it.
    hoverPending = { x, y };
    drawHover();
    hoverBox.style.top = `${Math.max(2, y - hoverBox.getBoundingClientRect().height - 22)}px`;
  }

  /** Drops a long-press readout, on the next touch or when the view moves under it. */
  function hideTouchReadout(): void {
    if (touchReadout) {
      touchReadout = false;
      hoverBox.style.display = 'none';
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      hideTouchReadout();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    // Touch drags the map; a readout pinned under a finger would be both hidden and useless. The
    // long-press readout is the exception — it owns the box until the next touch dismisses it.
    if (dragging || pointers.size > 0 || e.pointerType === 'touch') {
      if (!touchReadout) {
        hoverBox.style.display = 'none';
      }
      return;
    }
    // The divider tracks the cursor: a swipe you steer by pointing, with no handle to find and no
    // conflict with panning (which still drags the map underneath both halves).
    if (compareDate) {
      dividerFrac = Math.min(1, Math.max(0, (e.clientX - canvas.getBoundingClientRect().left) / Math.max(canvas.clientWidth, 1)));
    }
    hoverPending = { x: e.clientX, y: e.clientY };
    // Coalesce to one sample per frame: pointermove can outpace the display several times over,
    // and each readout costs a projection inverse plus a grid lookup.
    if (!hoverRaf) {
      hoverRaf = requestAnimationFrame(drawHover);
    }
  });
  canvas.addEventListener('pointerleave', (e) => {
    // A touch pointer stops existing when the finger lifts, and the browser reports that as a
    // `pointerleave` — which wiped the long-press readout the instant it was asked for.
    if (e.pointerType === 'touch') {
      return;
    }
    hoverPending = null;
    hoverBox.style.display = 'none';
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    if (drawMode !== 'off') {
      return;   // while drawing, a double-click closes the shape rather than resetting the view
    }
    zoom = 1; clampView();
  });

  // Corner zoom buttons (wheel-free navigation); hidden in nogui/display mode.
  if (!noGui) {
    const zc = document.createElement('div');
    zc.className = 'gis-panel gis-zoom';
    for (const [label, title, fn] of [
      ['＋', 'Zoom in', (): void => { zoom *= 1.5; clampView(); }],
      ['−', 'Zoom out', (): void => { zoom /= 1.5; clampView(); }],
      ['⟲', 'Reset view', (): void => { zoom = 1; clampView(); }],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      zc.appendChild(b);
    }
    document.body.appendChild(zc);
  }


  // ── Point analysis: click the flat map → time series at that point ────────────────
  const pointPanel = document.createElement('div');
  pointPanel.className = 'gis-panel solid gis-point';
  pointPanel.style.cssText = 'display:none;width:280px';
  const ptTitle = document.createElement('div');
  ptTitle.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;color:#5ef0c8';
  const ptLabel = document.createElement('span');
  let lastPoint: { lon: number; lat: number } | null = null;
  const ptClose = document.createElement('button');
  ptClose.textContent = '✕';
  ptClose.style.cssText = 'cursor:pointer;background:none;border:none;color:#889;font-size:11px;padding:0';
  ptClose.addEventListener('click', () => { pointPanel.style.display = 'none'; setSamplePoint(null); });
  // CSV of exactly the numbers plotted — the readout is a view of the data, not a substitute for it.
  let csvRows: { name: string; header: string[]; rows: Array<Array<string | number>>;
    provenance: string[]; } | null = null;
  const regionBtn = document.createElement('button');
  regionBtn.textContent = 'region';
  regionBtn.title = 'Copy this area as the `points` param of an analysis `region` node';
  regionBtn.style.cssText = 'cursor:pointer;background:none;border:none;color:#5ef0c8;font-size:10px;'
    + 'padding:0 8px 0 0;font-family:inherit;display:none';
  const csvBtn = document.createElement('button');
  csvBtn.textContent = 'CSV';
  csvBtn.title = 'Download the plotted values as CSV';
  csvBtn.style.cssText = 'cursor:pointer;background:none;border:none;color:#5ef0c8;font-size:10px;'
    + 'padding:0 8px 0 0;font-family:inherit';
  csvBtn.addEventListener('click', () => {
    if (csvRows) {
      downloadCsv(csvRows.name, csvRows.header, csvRows.rows, csvRows.provenance);
    }
  });
  // Timeline ↔ by-year. Only offered for time series; a transect's x axis is distance.
  const yearBtn = document.createElement('button');
  yearBtn.title = 'Fold the series onto Jan→Dec, one line per year (or back to one timeline)';
  yearBtn.style.cssText = 'cursor:pointer;background:none;border:none;color:#5ef0c8;font-size:10px;'
    + 'padding:0 8px 0 0;font-family:inherit;display:none';
  ptTitle.append(ptLabel, yearBtn, regionBtn, csvBtn, ptClose);
  const spark = document.createElement('canvas');
  spark.width = 260; spark.height = 90;
  spark.style.cssText = 'width:260px;height:90px;display:block;background:rgba(255,255,255,0.04);border-radius:3px';
  // By-year legend + "how unusual is the latest month" line. Its own element because hovering and
  // pinning redraw it without touching the caller's stats below.
  const ptYearNote = document.createElement('div');
  ptYearNote.style.cssText = 'margin-top:5px;line-height:1.5;color:#bcd;display:none';
  const ptStats = document.createElement('div');
  ptStats.style.cssText = 'margin-top:5px;line-height:1.5;color:#bcd';
  // ── Drawing toolbar ─────────────────────────────────────────────────────────────────
  // Finishing and clearing a shape were Enter and Esc, which a phone has neither of — a line drawn
  // on a tablet could not be closed or thrown away at all. Undo is new to both: retracing one
  // mis-tapped vertex meant starting the shape over.
  //
  // Inside the readout panel rather than floating over the map: the panel is already on screen for
  // the whole of a draw (it measures the shape as you go), the buttons belong with the thing they
  // act on, and anything bottom-anchored lands on the legend at phone height.
  const drawBar = document.createElement('div');
  drawBar.className = 'gis-draw';
  drawBar.style.cssText = 'display:none;gap:6px;margin-top:7px';
  for (const [label, title, fn] of [
    ['✓ finish', 'Close the shape (Enter, or double-tap the map)', (): void => { finishShape(); }],
    ['↶ undo', 'Remove the last point', (): void => {
      drawVerts.pop();
      drawDone = false;
      redrawGeometry();
      updateGeometryReadout();
    }],
    // clearGeometry closes the panel, which would take these buttons down with it — reopen it on
    // the "draw it" prompt, which is where the user now is.
    ['✕ clear', 'Discard the shape (Esc)', (): void => { clearGeometry(); updateGeometryReadout(); }],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'flex:1;cursor:pointer;background:#2a2a38;color:#dfeef0;border:1px solid #444;'
      + 'border-radius:4px;padding:4px 9px;font-size:11px;font-family:ui-monospace,monospace';
    b.addEventListener('click', fn);
    drawBar.appendChild(b);
  }
  let drawBarShown = false;
  /** Shows the toolbar exactly while a shape can be drawn. Called per frame; cheap when unchanged. */
  function syncDrawBar(): void {
    const want = drawMode !== 'off';
    if (want !== drawBarShown) {
      drawBarShown = want;
      drawBar.style.display = want ? 'flex' : 'none';
    }
  }

  // Resize grip, bottom-LEFT: the panel docks to the right edge, so this corner is the one with
  // room to grow into. It resizes the CHART (the text below reflows to its width).
  const ptGrip = document.createElement('div');
  ptGrip.title = 'Drag to resize the chart (double-click to reset)';
  ptGrip.style.cssText = 'position:absolute;left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize;'
    + 'touch-action:none;border-bottom-left-radius:6px;'
    + 'background:linear-gradient(45deg,rgba(94,240,200,0.55) 0 2px,transparent 2px 5px,'
    + 'rgba(94,240,200,0.55) 5px 7px,transparent 7px)';
  pointPanel.append(ptTitle, spark, ptYearNote, ptStats, drawBar, ptGrip);
  document.body.appendChild(pointPanel);
  makeDraggable(pointPanel, ptTitle);

  /** User-chosen chart size (CSS px) per view; null = the view's default. */
  const CHART_SIZE_KEY = 'earth_explorer_gis_point_chart_size';
  let chartSizes: { timeline: { w: number; h: number } | null; years: { w: number; h: number } | null } = { timeline: null, years: null };
  try {
    const saved = JSON.parse(localStorage.getItem(CHART_SIZE_KEY) ?? 'null') as typeof chartSizes | null;
    if (saved) {
      chartSizes = { timeline: saved.timeline ?? null, years: saved.years ?? null };
    }
  } catch {
    // storage blocked or corrupt: defaults
  }
  /** Redraws whatever the panel is showing at the chart's current size. */
  function replotChart(): void {
    if (chartSeries) {
      const s = chartSeries;
      plotSeries(s.pts, s.fmt, s.xLeft, s.xRight);
    } else if (drawMode === 'line' && drawVerts.length >= 2) {
      showTransect(drawVerts);
    }
  }
  let gripDrag: { x: number; y: number; w: number; h: number; right: number; key: 'timeline' | 'years' } | null = null;
  ptGrip.addEventListener('pointerdown', (e) => {
    const r = pointPanel.getBoundingClientRect();
    // Pin the panel by left/top (as a title-bar drag does) so its right edge holds still.
    pointPanel.style.left = `${r.left}px`;
    pointPanel.style.top = `${r.top}px`;
    pointPanel.style.right = 'auto';
    pointPanel.style.bottom = 'auto';
    gripDrag = {
      x: e.clientX, y: e.clientY, right: r.right,
      w: parseFloat(spark.style.width), h: parseFloat(spark.style.height),
      key: chartSeries && byYear ? 'years' : 'timeline',
    };
    ptGrip.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  ptGrip.addEventListener('pointermove', (e) => {
    if (!gripDrag) {
      return;
    }
    const g = gripDrag;
    const w = Math.round(Math.max(220, Math.min(g.right - 44, g.w + (g.x - e.clientX))));
    const h = Math.round(Math.max(70, Math.min(window.innerHeight - 160, g.h + (e.clientY - g.y))));
    chartSizes[g.key] = { w, h };
    replotChart();
    pointPanel.style.left = `${g.right - pointPanel.offsetWidth}px`;   // measured: includes padding
  });
  const endGrip = (e: PointerEvent): void => {
    if (!gripDrag) {
      return;
    }
    gripDrag = null;
    if (ptGrip.hasPointerCapture(e.pointerId)) {
      ptGrip.releasePointerCapture(e.pointerId);
    }
    try {
      localStorage.setItem(CHART_SIZE_KEY, JSON.stringify(chartSizes));
    } catch {
      // storage blocked: the size lasts for this page only
    }
  };
  ptGrip.addEventListener('pointerup', endGrip);
  ptGrip.addEventListener('pointercancel', endGrip);
  ptGrip.addEventListener('dblclick', () => {
    const r = pointPanel.getBoundingClientRect();
    chartSizes[chartSeries && byYear ? 'years' : 'timeline'] = null;
    replotChart();
    pointPanel.style.left = `${r.right - pointPanel.offsetWidth}px`;
    try {
      localStorage.setItem(CHART_SIZE_KEY, JSON.stringify(chartSizes));
    } catch {
      // storage blocked
    }
  });

  /**
   * Draws a line chart into the readout canvas: `xs` in whatever units the caller is plotting
   * against (epoch-ms for time series, km for a transect), values in physical units.
   */
  function drawSpark(pts: Array<{ x: number; v: number }>, fmt: (v: number) => string,
    xLeft: string, xRight: string): { min: number; max: number; mean: number } | null {
    const cx = spark.getContext('2d')!;
    cx.clearRect(0, 0, spark.width, spark.height);
    if (pts.length < 2) {
      return null;
    }
    const vs = pts.map((p) => p.v);
    const vMin = Math.min(...vs), vMax = Math.max(...vs);
    const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
    const P = 8;
    const w = spark.width - 2 * P, h = spark.height - 2 * P;
    const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
    const ySpan = Math.max(vMax - vMin, 1e-6);
    const X = (x: number): number => P + ((x - x0) / Math.max(x1 - x0, 1e-9)) * w;
    const Y = (v: number): number => P + (1 - (v - vMin) / ySpan) * h;
    cx.strokeStyle = '#5ef0c8';
    cx.lineWidth = 1.5;
    cx.beginPath();
    pts.forEach((p, i) => { if (i === 0) { cx.moveTo(X(p.x), Y(p.v)); } else { cx.lineTo(X(p.x), Y(p.v)); } });
    cx.stroke();
    cx.fillStyle = '#9fd8cf';
    for (const p of pts) {
      cx.fillRect(X(p.x) - 1, Y(p.v) - 1, 2, 2);
    }
    cx.fillStyle = 'rgba(223,238,240,0.65)';
    cx.font = '9px ui-monospace,monospace';
    cx.fillText(fmt(vMax), 2, 9);
    cx.fillText(fmt(vMin), 2, spark.height - 2);
    cx.textAlign = 'right';
    cx.fillText(xLeft, spark.width - 30, spark.height - 2);
    cx.fillText(xRight, spark.width - 2, spark.height - 2);
    cx.textAlign = 'left';
    return { min: vMin, max: vMax, mean };
  }

  // ── By-year view: the same series folded onto Jan→Dec, one line per year ────────────
  // A long record drawn end to end buries the question people usually bring to it — "is this
  // year unusual for the time of year?" — under the seasonal cycle. Folding puts every year on
  // one calendar axis, so the latest year reads against all the others at the same date. Every
  // year is gray context; the latest year and up to three pinned years (click a line) get color.
  const BY_YEAR_KEY = 'earth_explorer_gis_point_by_year';
  let byYear = params.has('byyear');
  try {
    byYear ||= localStorage.getItem(BY_YEAR_KEY) === '1';
  } catch {
    // storage blocked: the view just doesn't persist
  }
  const YEAR_LATEST_COLOR = '#3987e5';
  const YEAR_PIN_COLORS = ['#d95926', '#199e70', '#c98500'];
  /** A pin keeps its color while it stays pinned, so un-pinning one never repaints the others. */
  let pinnedYears: Array<{ year: number; color: string }> = [];
  type YearLine = { year: number; pts: Array<{ f: number; v: number; t: number }> };
  let yearLines: YearLine[] = [];
  let hover: { year: number; i: number } | null = null;
  /** The series on the chart, kept so a toggle, hover or pin redraws without re-sampling the stack. */
  let chartSeries: { pts: Array<{ x: number; v: number }>; fmt: (v: number) => string;
    xLeft: string; xRight: string; } | null = null;
  const YM = { l: 46, r: 34, t: 8, b: 16 };   // plot margins (CSS px): y labels left, year labels right
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function sizeChart(wide: boolean): void {
    const user = chartSizes[wide ? 'years' : 'timeline'];
    const cssW = Math.min(user?.w ?? (wide ? 460 : 260), Math.max(220, window.innerWidth - 44));
    const cssH = user?.h ?? (wide ? 230 : 90);
    const dpr = wide ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    spark.width = Math.round(cssW * dpr);
    spark.height = Math.round(cssH * dpr);
    spark.style.width = `${cssW}px`;
    spark.style.height = `${cssH}px`;
    spark.style.cursor = wide ? 'crosshair' : '';
    // 45 overlapping lines need a quiet ground; the translucent panel lets the map bleed through.
    spark.style.background = wide ? '#0b0e13' : 'rgba(255,255,255,0.04)';
    pointPanel.style.width = `${cssW + 20}px`;
  }

  /** Back to the plain chart for readouts that are not a time series (transects, draw prompts). */
  function plainChart(): void {
    chartSeries = null;
    hover = null;
    yearBtn.style.display = 'none';
    ptYearNote.style.display = 'none';
    sizeChart(false);
  }

  /**
   * Plots a time series (x = epoch-ms) in whichever view is selected. Returns the same summary
   * stats in both views so callers write one stats line.
   */
  function plotSeries(pts: Array<{ x: number; v: number }>, fmt: (v: number) => string,
    xLeft: string, xRight: string): { min: number; max: number; mean: number } | null {
    chartSeries = { pts, fmt, xLeft, xRight };
    hover = null;
    yearBtn.style.display = 'inline';
    yearBtn.textContent = byYear ? 'timeline' : 'by year';
    const byY = new Map<number, YearLine>();
    for (const p of pts) {
      const { year, f } = yearFraction(p.x);
      let line = byY.get(year);
      if (!line) {
        line = { year, pts: [] };
        byY.set(year, line);
      }
      line.pts.push({ f, v: p.v, t: p.x });
    }
    yearLines = [...byY.values()].sort((a, b) => a.year - b.year);
    if (!byYear) {
      ptYearNote.style.display = 'none';
      sizeChart(false);
      return drawSpark(pts, fmt, xLeft, xRight);
    }
    sizeChart(true);
    drawByYear();
    if (pts.length < 2) {
      return null;
    }
    let min = Infinity, max = -Infinity, sum = 0;
    for (const p of pts) {
      min = Math.min(min, p.v);
      max = Math.max(max, p.v);
      sum += p.v;
    }
    return { min, max, mean: sum / pts.length };
  }

  /** Round tick values (1/2/5 × 10ⁿ) covering [lo, hi]. */
  function niceTicks(lo: number, hi: number, want: number): number[] {
    const raw = (hi - lo) / Math.max(1, want);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
      out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    }
    return out;
  }

  function yearGeometry(): { W: number; H: number; X: (f: number) => number; Y: (v: number) => number;
    vMin: number; vMax: number; } {
    const dpr = spark.width / (parseFloat(spark.style.width) || spark.width);
    const W = spark.width / dpr, H = spark.height / dpr;
    let vMin = Infinity, vMax = -Infinity;
    for (const line of yearLines) {
      for (const p of line.pts) {
        vMin = Math.min(vMin, p.v);
        vMax = Math.max(vMax, p.v);
      }
    }
    const pad = Math.max((vMax - vMin) * 0.04, 1e-6);
    vMin -= pad;
    vMax += pad;
    const pw = W - YM.l - YM.r, ph = H - YM.t - YM.b;
    return {
      W, H, vMin, vMax,
      X: (f) => YM.l + f * pw,
      Y: (v) => YM.t + (1 - (v - vMin) / (vMax - vMin)) * ph,
    };
  }

  function drawByYear(): void {
    const cx = spark.getContext('2d')!;
    const dpr = spark.width / (parseFloat(spark.style.width) || spark.width);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = chartSeries;
    if (!s || yearLines.length === 0) {
      cx.clearRect(0, 0, spark.width, spark.height);
      ptYearNote.style.display = 'none';
      return;
    }
    const { W, H, X, Y, vMin, vMax } = yearGeometry();
    cx.clearRect(0, 0, W, H);
    cx.font = '9px ui-monospace,monospace';
    cx.lineJoin = 'round';

    // Recessive frame: dotted month lines, horizontal value ticks, a firmer zero line.
    cx.strokeStyle = 'rgba(223,238,240,0.10)';
    cx.lineWidth = 1;
    cx.setLineDash([1, 3]);
    cx.beginPath();
    for (let m = 0; m <= 12; m++) {
      const x = Math.round(X(m / 12)) + 0.5;
      cx.moveTo(x, YM.t);
      cx.lineTo(x, H - YM.b);
    }
    const ticks = niceTicks(vMin, vMax, 4);
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      cx.moveTo(YM.l, y);
      cx.lineTo(W - YM.r, y);
    }
    cx.stroke();
    cx.setLineDash([]);
    if (vMin < 0 && vMax > 0) {
      cx.strokeStyle = 'rgba(223,238,240,0.35)';
      cx.beginPath();
      cx.moveTo(YM.l, Math.round(Y(0)) + 0.5);
      cx.lineTo(W - YM.r, Math.round(Y(0)) + 0.5);
      cx.stroke();
    }
    cx.fillStyle = 'rgba(223,238,240,0.65)';
    cx.textAlign = 'right';
    cx.textBaseline = 'middle';
    for (const v of ticks) {
      cx.fillText(s.fmt(v), YM.l - 4, Y(v));
    }
    cx.textAlign = 'center';
    cx.textBaseline = 'alphabetic';
    const narrow = W < 360;
    for (let m = 0; m < 12; m++) {
      cx.fillText(narrow ? MONTHS[m][0] : MONTHS[m], X((m + 0.5) / 12), H - 4);
    }

    const latest = yearLines[yearLines.length - 1].year;
    const strokeLine = (line: YearLine, color: string, width: number): void => {
      cx.strokeStyle = color;
      cx.lineWidth = width;
      cx.beginPath();
      line.pts.forEach((p, i) => {
        if (i === 0) {
          cx.moveTo(X(p.f), Y(p.v));
        } else {
          cx.lineTo(X(p.f), Y(p.v));
        }
      });
      cx.stroke();
      if (line.pts.length === 1) {
        cx.fillStyle = color;
        cx.fillRect(X(line.pts[0].f) - 1.5, Y(line.pts[0].v) - 1.5, 3, 3);
      }
    };
    // Context first, highlights last so they sit on top.
    const highlighted = new Map<number, { color: string; width: number }>();
    for (const pin of pinnedYears) {
      highlighted.set(pin.year, { color: pin.color, width: 1.75 });
    }
    highlighted.set(latest, { color: YEAR_LATEST_COLOR, width: 2.5 });
    for (const line of yearLines) {
      if (!highlighted.has(line.year)) {
        strokeLine(line, 'rgba(190,205,215,0.24)', 1);
      }
    }
    const labels: Array<{ year: number; y: number; x: number }> = [];
    for (const line of yearLines) {
      const h = highlighted.get(line.year);
      if (h && line.year !== latest) {
        strokeLine(line, h.color, h.width);
      }
    }
    const latestLine = yearLines[yearLines.length - 1];
    strokeLine(latestLine, YEAR_LATEST_COLOR, 2.5);
    for (const line of yearLines) {
      if (highlighted.has(line.year)) {
        const end = line.pts[line.pts.length - 1];
        labels.push({ year: line.year, y: Y(end.v), x: X(end.f) });
      }
    }

    // Hovered line: drawn white over everything, with its nearest sample marked.
    if (hover) {
      const line = yearLines.find((l) => l.year === hover!.year);
      const p = line?.pts[hover.i];
      if (line && p) {
        strokeLine(line, '#ffffff', 2);
        const px = X(p.f), py = Y(p.v);
        cx.strokeStyle = 'rgba(223,238,240,0.35)';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(Math.round(px) + 0.5, YM.t);
        cx.lineTo(Math.round(px) + 0.5, H - YM.b);
        cx.stroke();
        cx.fillStyle = '#ffffff';
        cx.beginPath();
        cx.arc(px, py, 3.5, 0, Math.PI * 2);
        cx.fill();
        const d = new Date(p.t);
        const tip = `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${s.fmt(p.v)}`;
        const tw = cx.measureText(tip).width + 10;
        const tx = Math.min(Math.max(px - tw / 2, YM.l), W - YM.r - tw);
        const ty = py - 22 < YM.t ? py + 8 : py - 22;
        cx.fillStyle = 'rgba(8,10,14,0.92)';
        cx.fillRect(tx, ty, tw, 15);
        cx.fillStyle = '#ffffff';
        cx.textAlign = 'left';
        cx.textBaseline = 'middle';
        cx.fillText(tip, tx + 5, ty + 7.5);
        cx.textBaseline = 'alphabetic';
      }
    }

    // Direct year labels at each highlighted line's last sample, nudged apart vertically.
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 10);
    }
    cx.fillStyle = 'rgba(223,238,240,0.85)';
    cx.textAlign = 'left';
    cx.textBaseline = 'middle';
    for (const lb of labels) {
      cx.fillText(String(lb.year), Math.min(lb.x + 4, W - YM.r + 3), lb.y);
    }
    cx.textBaseline = 'alphabetic';
    updateYearNote(latest);
  }

  /** Legend chips + where the latest sample ranks among the same calendar month in every year. */
  function updateYearNote(latest: number): void {
    const s = chartSeries;
    if (!s || s.pts.length === 0) {
      ptYearNote.style.display = 'none';
      return;
    }
    const chip = (color: string, label: string): string =>
      `<span style="display:inline-block;width:12px;height:3px;border-radius:2px;background:${color};`
      + `vertical-align:middle;margin-right:4px"></span>${label}`;
    const parts = [chip(YEAR_LATEST_COLOR, `${latest}`)];
    for (const pin of pinnedYears) {
      if (pin.year !== latest && yearLines.some((l) => l.year === pin.year)) {
        parts.push(chip(pin.color, `${pin.year}`));
      }
    }
    parts.push(chip('rgba(190,205,215,0.5)', `${yearLines[0].year}–${latest}`));
    let html = parts.join(' &nbsp;');
    // Rank the latest year's value for its newest month against the same month in every other
    // year. Per-YEAR means, not raw samples: the live tail is daily while the baked record is one
    // sample per month, so counting samples would let this September's 26 days outvote 45 years.
    const last = s.pts[s.pts.length - 1];
    const month = new Date(last.x).getUTCMonth();
    const byYearMonth = new Map<number, { sum: number; n: number }>();
    for (const p of s.pts) {
      const d = new Date(p.x);
      if (d.getUTCMonth() !== month) {
        continue;
      }
      const acc = byYearMonth.get(d.getUTCFullYear()) ?? { sum: 0, n: 0 };
      acc.sum += p.v;
      acc.n++;
      byYearMonth.set(d.getUTCFullYear(), acc);
    }
    const lastYear = new Date(last.x).getUTCFullYear();
    const means = [...byYearMonth.entries()].map(([y, a]) => ({ y, v: a.sum / a.n }));
    const mine = means.find((m) => m.y === lastYear);
    if (mine && means.length >= 5) {
      const rank = means.filter((m) => m.v > mine.v).length + 1;
      const ord = (n: number): string => {
        if (n % 100 >= 11 && n % 100 <= 13) {
          return `${n}th`;
        }
        return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
      };
      const where = rank === 1 ? 'highest' : rank === means.length ? 'lowest' : `${ord(rank)} highest`;
      const n = byYearMonth.get(lastYear)!.n;
      html += `<br>${MONTHS[month]} ${lastYear}${n > 1 ? ` (mean of ${n} days so far)` : ''}: ${s.fmt(mine.v)} — `
        + `${where} of ${means.length} years`;
    }
    // The baked stacks are one DAILY field per month (the 1st), not monthly means — say so, or a
    // spike on the 1st reads as a month-long event.
    if (s.pts.every((p) => new Date(p.x).getUTCDate() === 1)) {
      html += '<br><span style="color:#889">one daily sample per month (the 1st), not monthly means</span>';
    }
    html += `<br><span style="color:#889">hover a line to identify it · click to pin (up to ${YEAR_PIN_COLORS.length})</span>`;
    ptYearNote.innerHTML = html;
    ptYearNote.style.display = 'block';
  }

  /** The line nearest the pointer (vertically, at the pointer's date), within a few pixels. */
  function yearAt(e: PointerEvent): { year: number; i: number } | null {
    const r = spark.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const { X, Y, W } = yearGeometry();
    const f = (mx - YM.l) / (W - YM.l - YM.r);
    if (f < -0.02 || f > 1.02) {
      return null;
    }
    let best: { year: number; i: number } | null = null;
    let bestD = 14;   // px
    for (const line of yearLines) {
      const ps = line.pts;
      // Distance from the pointer to the polyline, so a hover between two monthly samples still hits.
      for (let i = 0; i < ps.length; i++) {
        const ax = X(ps[i].f), ay = Y(ps[i].v);
        const b = ps[Math.min(i + 1, ps.length - 1)];
        const bx = X(b.f), by = Y(b.v);
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / len2)) : 0;
        const d = Math.hypot(mx - (ax + t * dx), my - (ay + t * dy));
        if (d < bestD) {
          bestD = d;
          best = { year: line.year, i: t < 0.5 ? i : Math.min(i + 1, ps.length - 1) };
        }
      }
    }
    return best;
  }

  spark.addEventListener('pointermove', (e) => {
    if (!byYear || !chartSeries) {
      return;
    }
    const h = yearAt(e);
    if (h?.year !== hover?.year || h?.i !== hover?.i) {
      hover = h;
      drawByYear();
    }
  });
  spark.addEventListener('pointerleave', () => {
    if (byYear && hover) {
      hover = null;
      drawByYear();
    }
  });
  spark.addEventListener('click', (e) => {
    if (!byYear || !chartSeries) {
      return;
    }
    const h = yearAt(e as PointerEvent) ?? hover;
    if (!h || h.year === yearLines[yearLines.length - 1]?.year) {
      return;   // the latest year is always highlighted
    }
    const at = pinnedYears.findIndex((p) => p.year === h.year);
    if (at >= 0) {
      pinnedYears.splice(at, 1);
    } else {
      if (pinnedYears.length >= YEAR_PIN_COLORS.length) {
        pinnedYears.shift();   // oldest pin makes room; its color frees up
      }
      const used = new Set(pinnedYears.map((p) => p.color));
      pinnedYears.push({ year: h.year, color: YEAR_PIN_COLORS.find((c) => !used.has(c))! });
    }
    drawByYear();
  });
  yearBtn.addEventListener('click', () => {
    byYear = !byYear;
    try {
      localStorage.setItem(BY_YEAR_KEY, byYear ? '1' : '0');
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    if (chartSeries) {
      const s = chartSeries;
      plotSeries(s.pts, s.fmt, s.xLeft, s.xRight);
    }
  });

  // ── Drawn geometry: point / line / area ─────────────────────────────────────────────
  // A point reuses the click readout. A LINE gives value-versus-distance along a great-circle path
  // through the frame on screen; an AREA gives a cos(lat)-weighted mean over time, and doubles as a
  // `region` for the analysis language (the polygon travels as the `points` param).
  type DrawMode = 'off' | 'line' | 'area';
  type Vertex = { lon: number; lat: number };
  let drawMode: DrawMode = 'off';
  let drawVerts: Vertex[] = [];
  let drawDone = false;   // shape finished: the next click starts a new one instead of extending

  /** Great-circle interpolation, so a path is sampled the way the Earth is shaped. */
  function gcPoint(a: Vertex, b: Vertex, t: number): Vertex {
    const d2r = Math.PI / 180;
    const la1 = a.lat * d2r, lo1 = a.lon * d2r, la2 = b.lat * d2r, lo2 = b.lon * d2r;
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2
      + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (d < 1e-9) {
      return { lon: a.lon, lat: a.lat };
    }
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    return { lon: Math.atan2(y, x) / d2r, lat: Math.atan2(z, Math.hypot(x, y)) / d2r };
  }

  const EARTH_KM = 6371;
  function gcDistanceKm(a: Vertex, b: Vertex): number {
    const d2r = Math.PI / 180;
    const la1 = a.lat * d2r, lo1 = a.lon * d2r, la2 = b.lat * d2r, lo2 = b.lon * d2r;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2
      + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
  }

  /** Rasterizes the current shape (plus any in-progress vertices) into the equirect overlay. */
  function redrawGeometry(): void {
    if (geomTex !== geomNone) {
      geomTex.destroy();
    }
    geomTex = geomNone;
    geomGen++;
    bindGroup = null;
    bgKey = '';
    const verts = drawVerts;
    const sp = lastPoint;
    if (verts.length === 0 && !sp) {
      return;
    }
    const { TW, TH } = overlayRasterSize();
    const cnv = new OffscreenCanvas(TW, TH);
    const cx = cnv.getContext('2d')!;
    // Densify legs finely enough that a step is under a pixel at the window's scale — at world view
    // 100 km was plenty, but zoomed to a bay the same step would draw a visibly faceted great circle.
    const stepKm = Math.max(2, 100 * overlayWin.du);
    // The whole shape shares one wrap copy, chosen from its first vertex, so a path crossing the
    // window edge stays one path.
    const shift = overlayShift(((verts[0] ?? sp!).lon + 180) / 360);
    const X = (lon: number, prevU?: number): number => {
      let uu = (lon + 180) / 360;
      if (prevU !== undefined) {
        uu -= Math.round(uu - prevU);   // continue the previous vertex's copy
      }
      return overlayX(uu - shift, TW);
    };
    const Y = (lat: number): number => overlayY(lat, TH);
    // Densify every leg along its great circle: a straight line in equirect pixels is NOT a straight
    // line on the globe, and at high latitude the two diverge badly.
    const path = (pts: Vertex[], close: boolean): void => {
      cx.beginPath();
      const legs = close ? pts.length : pts.length - 1;
      let prevU = (pts[0].lon + 180) / 360;
      for (let i = 0; i < legs; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const steps = Math.max(2, Math.ceil(gcDistanceKm(a, b) / stepKm));
        for (let k = 0; k <= steps; k++) {
          const p = gcPoint(a, b, k / steps);
          const uu = (p.lon + 180) / 360;
          prevU = uu - Math.round(uu - prevU);
          const px = overlayX(prevU - shift, TW), py = Y(p.lat);
          if (i === 0 && k === 0) {
            cx.moveTo(px, py);
          } else {
            cx.lineTo(px, py);
          }
        }
      }
    };
    const isArea = drawMode === 'area';
    if (verts.length >= 2) {
      if (isArea) {
        path(verts, true);
        cx.fillStyle = 'rgba(94,240,200,0.16)';
        cx.fill();
      }
      // Dark halo under a bright stroke, so the outline reads over any colormap.
      path(verts, isArea);
      cx.strokeStyle = 'rgba(0,0,0,0.6)'; cx.lineWidth = 6; cx.lineJoin = 'round'; cx.stroke();
      path(verts, isArea);
      cx.strokeStyle = '#5ef0c8'; cx.lineWidth = 2.4; cx.stroke();
    }
    for (const v of verts) {
      const vx = X(v.lon), vy = Y(v.lat);
      cx.beginPath();
      cx.arc(vx, vy, 5, 0, Math.PI * 2);
      cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fill();
      cx.beginPath();
      cx.arc(vx, vy, 3, 0, Math.PI * 2);
      cx.fillStyle = '#5ef0c8'; cx.fill();
    }
    // The clicked point the readout panel is plotting: a white ring around a dot (vertices are
    // plain dots), haloed so it reads over any colormap, in the same raster as the shapes so it
    // lands correctly in every projection and on the globe.
    if (sp) {
      const px = overlayX((sp.lon + 180) / 360 - overlayShift((sp.lon + 180) / 360), TW), py = Y(sp.lat);
      cx.lineWidth = 5;
      cx.strokeStyle = 'rgba(0,0,0,0.6)';
      cx.beginPath();
      cx.arc(px, py, 8, 0, Math.PI * 2);
      cx.stroke();
      cx.lineWidth = 2.2;
      cx.strokeStyle = '#ffffff';
      cx.beginPath();
      cx.arc(px, py, 8, 0, Math.PI * 2);
      cx.stroke();
      cx.beginPath();
      cx.arc(px, py, 3.5, 0, Math.PI * 2);
      cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fill();
      cx.beginPath();
      cx.arc(px, py, 2.2, 0, Math.PI * 2);
      cx.fillStyle = '#5ef0c8'; cx.fill();
    }
    geomTex = Texture.fromBitmap(device, cnv.transferToImageBitmap(), { srgb: false });
  }

  /** Sets the point the readout plots and re-rasterizes its marker (only when it moved). */
  function setSamplePoint(p: { lon: number; lat: number } | null): void {
    if (p?.lon === lastPoint?.lon && p?.lat === lastPoint?.lat) {
      return;
    }
    lastPoint = p;
    redrawGeometry();
  }

  function clearGeometry(): void {
    drawVerts = [];
    drawDone = false;
    csvRows = null;
    lastPoint = null;   // the panel closes below, so its point marker goes with it
    redrawGeometry();
    pointPanel.style.display = 'none';
  }

  /**
   * Recomputes the drawn object's readout. Called on EVERY vertex, so a shape measures itself as it
   * is built — an explicit "finish" gesture is a terrible thing to require, because nothing on screen
   * can tell you it exists. Double-click/Enter only marks the shape closed so the next click starts a
   * fresh one; below the minimum vertex count the panel says what to do next instead of staying dark.
   */
  function updateGeometryReadout(): void {
    if (drawMode === 'off') {
      return;
    }
    const need = drawMode === 'area' ? 3 : 2;
    if (drawVerts.length >= need) {
      if (drawMode === 'line') {
        showTransect(drawVerts);
      } else {
        showAreaSeries(drawVerts);
      }
      return;
    }
    // Not measurable yet: acknowledge the click and name the next step.
    regionBtn.style.display = 'none';
    csvRows = null;
    const label = drawMode === 'area' ? 'Area' : 'Line';
    ptLabel.textContent = drawVerts.length ? `${label} · ${drawVerts.length} of ${need} points` : `${label} · draw it`;
    pointPanel.style.display = 'block';
    plainChart();
    spark.getContext('2d')!.clearRect(0, 0, spark.width, spark.height);
    const left = need - drawVerts.length;
    ptStats.innerHTML = `Tap the map to add ${left} point${left > 1 ? 's' : ''}`
      + `${drawVerts.length ? ' more' : ''}; it measures itself as you go.`
      + `<br>Double-tap or Enter closes it · Esc clears · or use the buttons below.`;
  }

  /** Marks the shape closed (the readout is already live). */
  function finishShape(): void {
    if (drawMode !== 'off' && drawVerts.length >= (drawMode === 'area' ? 3 : 2)) {
      drawDone = true;
    }
  }

  /** Re-runs the active shape's readout — the layer or displayed frame changed under it. */
  function refreshGeometryReadout(): void {
    updateGeometryReadout();
  }

  /**
   * "Your data": a GeoJSON study area becomes the drawn region, and a station CSV is collocated
   * against the layer on screen.
   *
   * The region path deliberately funnels into exactly the same `drawVerts` the mouse produces, so
   * an imported boundary gets the area readout, the CSV export, the `region` copy button and every
   * analysis op (areaMean, mask, histogram, hovmöller) for free — and behaves identically to a
   * traced one everywhere downstream.
   */
  const importPanel = installImportPanel({
    makeDraggable,
    onRegion: (points, name) => {
      drawMode = 'area';
      ui.setDrawMode('area');
      drawVerts = points.map(([lon, lat]) => ({ lon, lat }));
      drawDone = true;
      redrawGeometry();
      updateGeometryReadout();
      statusEl.textContent = `Region: ${name}`;
    },
    // Always the ABSOLUTE frames: a match-up must carry physical values, not whatever derived view
    // (delta, anomaly-vs-N-years) happens to be on screen.
    frames: () => absFrames.map((f) => ({ date: f.date, sample: (lon, lat) => f.field.sample(lon, lat) })),
    valueColumn: () => `${layer.key}_${ANALYSIS_META[layer.key]?.unit ?? 'value'}`,
    // Read off the grid that came back, not from source metadata — same reasoning as the request
    // panel: `strideScale` is a stride multiplier, and these products' native grids disagree.
    cellDeg: () => {
      const w = absFrames[0]?.field.meta.width ?? 0;
      return w > 0 ? 360 / w : undefined;
    },
    currentDate: () => frames[idx]?.date,
    exportCsv: (name, header, rows, provenance) => downloadCsv(name, header, rows, provenance),
    provenance: (what) => csvProvenance(what),
  });

  // A shared `?shape=` link restores the drawn object immediately; its readout fills in on the first
  // frame that lands (refreshGeometryReadout runs whenever the displayed field changes).
  const shapeParam = params.get('shape');
  if (shapeParam && !noGui) {
    const pts = parseRing(shapeParam);
    const mode = params.get('draw') === 'line' ? 'line' : 'area';
    if (pts.length >= (mode === 'area' ? 3 : 2)) {
      drawMode = mode;
      ui.setDrawMode(mode);
      drawVerts = pts.map(([lon, lat]) => ({ lon, lat }));
      drawDone = true;
      redrawGeometry();
    }
  }
  /**
   * Runs `fn` once the layer's first frames are in.
   *
   * Every deeplink that describes the DATA rather than the view has to wait: the boot block runs
   * before the first fetch resolves, and acting early produces something that looks like a failure
   * (a match-up with no frames) or, worse, something plausible but wrong (a request naming `(last)`,
   * the one form that stops meaning the same thing tomorrow). If the feed never answers, run anyway
   * so the deeplink reports the real problem instead of silently doing nothing.
   */
  function whenFramesReady(fn: () => void): void {
    const deadline = performance.now() + 8000;
    const tick = (): void => {
      if (frames.length > 0 || performance.now() > deadline) {
        fn();
      } else {
        setTimeout(tick, 150);
      }
    };
    tick();
  }

  // `?stations=` / `?region=` import from a URL, so a whole study setup — the boundary and the
  // sample points — travels in a link the way the hand-drawn `?shape=` already does.
  const regionUrl = params.get('region');
  if (regionUrl && !noGui) {
    void importPanel.importUrl(regionUrl);   // a boundary needs no data to be adopted
  }
  const stationsUrl = params.get('stations');
  if (stationsUrl && !noGui) {
    whenFramesReady(() => { void importPanel.importUrl(stationsUrl); });   // collocation needs frames
  }
  if (params.has('data') && !noGui) {
    // `?data` deeplinks straight to the request/snippets/citation — the form a link takes when it
    // is shared to say "here is the data", not "here is the picture". It opens HERE, after `?shape`
    // has been applied, both because the panel reads `drawVerts` (declared below the boot block, so
    // opening earlier hits its temporal dead zone) and because a shared region belongs in the
    // citation's subset line.
    whenFramesReady(() => reproducePanel.open());
  }

  /**
   * Provenance header for an export: what the numbers are, which product they came from, and how they
   * were reduced. A CSV outlives the page it was exported from, so the file has to say this itself.
   */
  function csvProvenance(what: string): string[] {
    const meta = ANALYSIS_META[layer.key];
    const cite = LAYER_INFO[layer.key]?.cite;
    const lines = [
      `${what} exported from the Earth Explorer`,
      `layer: ${layer.legend} (${layer.key})${meta ? `, units ${meta.unit}` : ''}`,
    ];
    if (cite) {
      lines.push(`source: ${cite.product} — ${cite.provider}`);
      lines.push(`access: ${cite.access}`);
      lines.push(`reference: ${cite.url}`);
      if (cite.license) {
        lines.push(`license: ${cite.license}`);
      }
    }
    if (meta?.caveats) {
      lines.push(`caveats: ${meta.caveats}`);
    }
    lines.push(...gridProvenance());
    if (view !== 'abs') {
      lines.push(`NOTE: exported from the "${view}" analysis view, not the absolute field`);
    }
    // A seasonal subset changes what every row below means, and a CSV that omits it reads as a
    // full record.
    const season = seasonLabel();
    if (season) {
      lines.push(`NOTE: restricted to ${season} — frames from other months are NOT included`);
    }
    return lines;
  }

  /**
   * The resolution the numbers were actually computed at.
   *
   * The explorer fetches with a decimation stride, so a spatial mean is a mean of the SUBSAMPLED
   * cells — its value moves when the resolution picker moves, and nothing in the exported column
   * says so. Anyone comparing this file against an operational figure computed at native resolution
   * needs this line to explain the difference.
   */
  function gridProvenance(): string[] {
    const m = currentField?.meta;
    if (!m || !m.width || !m.height) {
      return [];
    }
    const dLon = 360 / m.width, dLat = 180 / m.height;
    const s = layer.source ? strideFor(layer.source, stride) : stride;
    const lines = [
      `grid: ${m.width}×${m.height} cells, ${dLon.toFixed(3)}° lon × ${dLat.toFixed(3)}° lat`,
    ];
    if (s > 1) {
      lines.push(`decimation: every ${s}${s === 2 ? 'nd' : s === 3 ? 'rd' : 'th'} source cell (resolution setting "${stride === 1 ? 'native' : `${(stride * 0.25).toFixed(2)}°`}")`);
      lines.push('NOTE: spatial means below are over the DECIMATED cells above, not the source '
        + 'product\'s native grid — expect a small offset against operational figures, and re-export '
        + 'at "native" resolution if the exact value matters');
    }
    return lines;
  }

  /** Value along a drawn path, sampled on the great circle through the frame on screen. */
  function showTransect(verts: Vertex[]): void {
    setSamplePoint(null);
    const field = currentField;
    if (!field || verts.length < 2) {
      return;
    }
    const legKm = verts.slice(1).map((v, i) => gcDistanceKm(verts[i], v));
    const totalKm = legKm.reduce((s, d) => s + d, 0);
    const N = Math.max(24, Math.min(400, Math.round(totalKm / 25)));
    const pts: Array<{ x: number; v: number }> = [];
    const rows: Array<Array<string | number>> = [];
    for (let i = 0; i <= N; i++) {
      const want = (i / N) * totalKm;
      // Walk the legs to find which one this sample falls in.
      let acc = 0, li = 0;
      while (li < legKm.length - 1 && acc + legKm[li] < want) {
        acc += legKm[li];
        li++;
      }
      const t = legKm[li] > 1e-9 ? (want - acc) / legKm[li] : 0;
      const p = gcPoint(verts[li], verts[li + 1], t);
      const v = field.sample(p.lon, p.lat);
      rows.push([want.toFixed(2), p.lon.toFixed(4), p.lat.toFixed(4), v === null ? '' : v]);
      if (v !== null) {
        pts.push({ x: want, v });
      }
    }
    regionBtn.style.display = 'none';
    ptLabel.textContent = `Transect · ${totalKm < 1000 ? totalKm.toFixed(0) : (totalKm / 1000).toFixed(2) + 'k'} km`;
    pointPanel.style.display = 'block';
    const fmt = analysisFmt ?? viewSpec().fmt;
    plainChart();
    const st = drawSpark(pts, fmt, '0', `${totalKm.toFixed(0)} km`);
    csvRows = {
      name: `transect_${layer.key}_${field.meta.date.slice(0, 10)}`,
      provenance: csvProvenance('a transect (value along a drawn path)'),
      header: ['distance_km', 'longitude', 'latitude', `${layer.key}_${ANALYSIS_META[layer.key]?.unit ?? ''}`],
      rows,
    };
    ptStats.innerHTML = st
      ? `min ${fmt(st.min)} · mean ${fmt(st.mean)} · max ${fmt(st.max)}<br>`
        + `${pts.length}/${N + 1} samples with data · ${field.meta.date.slice(0, 10)}`
      : 'No data along this line.';
  }

  /** cos(lat)-weighted mean inside a drawn polygon, over the whole loaded stack. */
  function showAreaSeries(verts: Vertex[]): void {
    setSamplePoint(null);
    if (verts.length < 3 || absFrames.length === 0) {
      return;
    }
    const region: RegionValue = { kind: 'polygon', points: verts.map((v) => [v.lon, v.lat] as [number, number]) };
    const box = regionBbox(region);
    const pts: Array<{ x: number; v: number }> = [];
    const rows: Array<Array<string | number>> = [];
    let cells = 0;
    // Worst per-frame coverage across the series: an area mean over a polygon that is mostly land
    // (or mostly cloud, for a sparse product) is a real number about a small part of the shape the
    // user drew, and the mean alone gives no hint of that.
    let minCoverage = Infinity;
    let sdSum = 0, sdN = 0;
    for (const f of seasonFrames()) {
      const { width: W, height: H } = f.field.meta;
      let sum = 0, sumSq = 0, sw = 0, n = 0, inside = 0;
      // Scan only the shape's latitude band; the polygon test then rejects per cell.
      const y0 = Math.max(0, Math.floor(((90 - box.latMax) / 180) * H));
      const y1 = Math.min(H - 1, Math.ceil(((90 - box.latMin) / 180) * H));
      for (let y = y0; y <= y1; y++) {
        const lat = 90 - ((y + 0.5) / H) * 180;
        const w = Math.cos((lat * Math.PI) / 180);
        for (let x = 0; x < W; x++) {
          const lon = ((x + 0.5) / W) * 360 - 180;
          if (!inRegion(lon, lat, region)) {
            continue;
          }
          inside++;
          const v = f.field.sample(lon, lat);
          if (v === null) {
            continue;
          }
          sum += w * v; sumSq += w * v * v; sw += w; n++;
        }
      }
      if (n === 0) {
        continue;
      }
      cells = Math.max(cells, n);
      const t = frameEpoch(f.date);
      const mean = sum / sw;
      // Spread across the region's cells — not a standard error: neighboring cells are strongly
      // spatially autocorrelated, so sd/√n would be a confidence interval this data cannot support.
      const sd = n > 1 ? Math.sqrt(Math.max(0, sumSq / sw - mean * mean)) : NaN;
      const coverage = inside > 0 ? n / inside : 0;
      minCoverage = Math.min(minCoverage, coverage);
      if (Number.isFinite(sd)) {
        sdSum += sd; sdN++;
      }
      rows.push([f.date.slice(0, 10), mean, Number.isFinite(sd) ? sd : '', n, inside, coverage.toFixed(4)]);
      if (Number.isFinite(t)) {
        pts.push({ x: t, v: mean });
      }
    }
    ptLabel.textContent = `Area · ${verts.length} vertices`;
    pointPanel.style.display = 'block';
    // The same ring the analysis language wants: `region(points: "lon,lat …")` restricts areaMean,
    // mask, histogram and hovmoller through exactly the test used above.
    const ring = formatRing(region.points);
    regionBtn.style.display = 'inline';
    regionBtn.onclick = (): void => {
      void navigator.clipboard?.writeText(ring);
      regionBtn.textContent = 'copied';
      setTimeout(() => { regionBtn.textContent = 'region'; }, 1200);
    };
    const fmt = analysisFmt ?? viewSpec().fmt;
    const y0 = pts.length ? new Date(pts[0].x).getUTCFullYear() : '';
    const y1 = pts.length ? new Date(pts[pts.length - 1].x).getUTCFullYear() : '';
    const st = plotSeries(pts, fmt, String(y0), String(y1));
    csvRows = {
      name: `area_${layer.key}`,
      provenance: csvProvenance('an area-mean time series (cos(lat)-weighted, inside a drawn polygon)'),
      header: [
        'date', `area_mean_${layer.key}_${ANALYSIS_META[layer.key]?.unit ?? ''}`,
        'within_region_sd', 'valid_cells', 'cells_in_region', 'coverage_fraction',
      ],
      rows,
    };
    const meanSd = sdN > 0 ? sdSum / sdN : NaN;
    const cov = Number.isFinite(minCoverage) ? minCoverage : 0;
    // A spread is a SPAN, not a value: for temperature the °C→°F conversion must scale without the
    // 32° offset, or a 0.4 °C sd would print as 33 °F. fmtRel does that scaling and keeps a decimal
    // (fmtSpan rounds to whole degrees, which would show a 0.4° sd as "0°"); its leading "+" is for
    // signed anomalies and makes no sense on a magnitude, so it goes.
    const fmtSd = (v: number): string => (layer.fmtRel ?? layer.fmtSpan ?? fmt)(v).replace(/^\+/, '');
    ptStats.innerHTML = st
      ? `area mean ${fmt(st.mean)}${Number.isFinite(meanSd) ? ` ± ${fmtSd(meanSd)} sd` : ''} · range ${fmt(st.min)}…${fmt(st.max)}<br>`
        + `${cells} cells · ${pts.length} frames · cos(lat)-weighted · ${(cov * 100).toFixed(0)}% coverage at worst`
      : 'No data inside this area.';
  }

  function showPointSeries(lonDeg: number, latDeg: number): void {
    setSamplePoint({ lon: lonDeg, lat: latDeg });
    // Always analyze the ABSOLUTE frames (physical values), regardless of the display view.
    const pts = seasonFrames()
      .map((f) => ({ x: frameEpoch(f.date), v: f.field.sample(lonDeg, latDeg), date: f.date }))
      .filter((p): p is { x: number; v: number; date: string } => p.v !== null && Number.isFinite(p.x));
    regionBtn.style.display = 'none';
    ptLabel.textContent = `${Math.abs(latDeg).toFixed(1)}°${latDeg >= 0 ? 'N' : 'S'} ${Math.abs(lonDeg).toFixed(1)}°${lonDeg >= 0 ? 'E' : 'W'}`;
    pointPanel.style.display = 'block';
    csvRows = {
      name: `point_${layer.key}_${latDeg.toFixed(2)}_${lonDeg.toFixed(2)}`,
      provenance: csvProvenance('a point time series'),
      header: ['date', `${layer.key}_${ANALYSIS_META[layer.key]?.unit ?? ''}`],
      rows: pts.map((p) => [p.date.slice(0, 10), p.v]),
    };
    const y0 = pts.length ? new Date(pts[0].x).getUTCFullYear() : '';
    const y1 = pts.length ? new Date(pts[pts.length - 1].x).getUTCFullYear() : '';
    const st = plotSeries(pts, layer.fmt, String(y0), String(y1));
    if (!st) {
      ptStats.textContent = 'No ocean data at this point.';
      return;
    }
    // Least-squares trend, reported per decade.
    const t0 = pts[0].x;
    const xs = pts.map((p) => (p.x - t0) / (365.25 * 86400e3));   // years since first sample
    const xm = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    let num = 0, den = 0;
    for (let i = 0; i < pts.length; i++) {
      num += (xs[i] - xm) * (pts[i].v - st.mean);
      den += (xs[i] - xm) ** 2;
    }
    const slope = den > 1e-9 ? num / den : 0;   // physical units per year
    // Trends are RELATIVE quantities: °F trend = °C trend × 9/5 (no offset).
    const isTemp = layer.key === 'sst' || layer.key === 'anom';
    const tr = (isTemp && UNIT_F ? slope * 9 / 5 : slope) * 10;
    const trUnit = isTemp ? `°${UNIT_F ? 'F' : 'C'}` : '';
    const sgn = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    ptStats.innerHTML = `min ${layer.fmt(st.min)} · mean ${layer.fmt(st.mean)} · max ${layer.fmt(st.max)}<br>`
      + `trend ${sgn(tr)}${trUnit}/decade · ${pts.length} samples`;
  }

  canvas.addEventListener('dblclick', (e) => {
    if (drawMode === 'line' || drawMode === 'area') {
      e.preventDefault();
      finishShape();
    }
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (drawMode === 'off' || (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'))) {
      return;
    }
    if (e.key === 'Enter') { finishShape(); }
    if (e.key === 'Escape') { clearGeometry(); }
  });

  canvas.addEventListener('click', (e) => {
    if (noGui || absFrames.length === 0 || dragDist > 4) {
      return;   // a pan/rotate gesture is not a point pick
    }
    if (suppressClick) {
      suppressClick = false;   // a long-press or double-tap already answered this touch
      return;
    }
    if (drawMode === 'line' || drawMode === 'area') {
      const p = pickLonLat(e.clientX, e.clientY);
      if (p) {
        if (drawDone) {
          drawVerts = [];                       // the previous shape was closed: begin a new one
          drawDone = false;
        }
        drawVerts.push({ lon: p.lonDeg, lat: p.latDeg });
        redrawGeometry();
        updateGeometryReadout();
      }
      return;
    }
    if (ui.mode() === 'globe' || ui.mode() === 'earth') {
      const g = pickLonLat(e.clientX, e.clientY);
      if (g) {
        showPointSeries(g.lonDeg, g.latDeg);
      }
      return;
    }
    // Invert the letterbox + zoom/pan transform to the map frame, then through the active
    // projection's inverse to lon/lat (mirrors the shader; null = outside the projection).
    const { u, v } = canvasToUv(e.clientX, e.clientY);
    if (flatProj.wraps && zoom < 1.001 && (u < 0 || u > 1)) {
      return;   // whole-world letterbox: the side bars are not picks
    }
    let px = (u * 2 - 1) * flatProj.halfW;
    if (flatProj.wraps) {
      const span = 2 * flatProj.halfW;
      px = ((px + flatProj.halfW) % span + span) % span - flatProj.halfW;
    }
    const ll = flatProj.inverse(px, (1 - v * 2) * flatProj.halfH);
    if (ll) {
      showPointSeries(ll.lonDeg, ll.latDeg);
    }
  });

  // ── Render + animate ──────────────────────────────────────────────────────────────
  /**
   * Steps the time-lapse if it is playing, returning whether it is.
   */
  function advanceTimeLapse(dt: number): boolean {
    const playing = ui.playing() && !ui.scrubbing() && frames.length > 1;
    if (playing) {
      acc += dt;
      if (acc >= ui.interval()) {
        acc = 0;
        followNewest = false;   // playback owns the date now
        idx = (idx + 1) % frames.length;
        currentField = frames[idx].field;
        ui.setDate(frames[idx].date);
      }
    }
    ui.setTimeline(frames.length, idx);
    return playing;
  }

  let acc = 0;
  let last = -1;
  let clock = 0;
  let lastStatsField: GriddedField | null = null;   // updates the legend stats line on frame change
  function frame(now: number): void {
    const dt = last < 0 ? 0 : (now - last) / 1000;
    last = now;
    clock += dt;
    syncDrawBar();
    ctx.update();

    const playingLapse = advanceTimeLapse(dt);
    // Crossfade toward the next frame over the interval so dates ease in rather than snap. Only
    // while the stack is auto-playing; a scrub/pick/single-frame shows its exact field (blend 0).
    //
    // Compare mode takes the same slot for a PINNED frame instead, and hands the choice to the
    // shader's divider — so the two never fight over one texture.
    // Loaders append to the RAW stack and jump to its newest index; with a season filter active
    // that index can point past the filtered view. Clamp here rather than chasing every loader —
    // one guard on the path that actually consumes `idx`.
    if (idx >= frames.length) {
      idx = Math.max(0, frames.length - 1);
      currentField = frames[idx]?.field ?? currentField;
      if (frames[idx]) {
        ui.setDate(frames[idx].date);
      }
    }
    const cmpIdx = compareIndex();
    nextField = cmpIdx !== null
      ? (frames[cmpIdx]?.field ?? currentField)
      : (frames.length > 1 ? frames[(idx + 1) % frames.length].field : currentField);
    const blend = cmpIdx !== null ? 0 : (playingLapse ? Math.min(1, acc / Math.max(ui.interval(), 1e-3)) : 0);
    if (currentField !== lastStatsField) {
      lastStatsField = currentField;
      const s = currentField?.stats();
      const f = analysisFmt ?? viewSpec().fmt;
      ui.setStats(s && Number.isFinite(s.min) ? `min ${f(s.min)} · mean ${f(s.mean)} · max ${f(s.max)}` : '');
      refreshGeometryReadout();   // a transect reads the frame on screen, so it follows the timeline
    }
    const earth = ui.mode() === 'earth';
    const globe = ui.mode() === 'globe' || earth;   // both are spherical: relief, sun, no letterbox
    if (globe && zoom > GLOBE_MAX_ZOOM) {
      zoom = GLOBE_MAX_ZOOM;   // deep flat zoom doesn't survive a switch to the globe
    }
    if (!globe && zoom < 1) {
      zoom = 1;                // nor does the globe's zoomed-OUT range survive a switch to flat
    }
    if (globe && ui.spin() && !dragging) { globeYaw += dt * 0.15; }
    flyTick(dt);
    const detailCenter = detailTick(clock, globe);
    overlayTick(clock, globe);
    flowTick(clock, globe);

    // Both vector overlays advect between the two dated frames straddling the base layer's
    // CURRENT moment (date-matched — the stacks start in different years, so ordinal alignment
    // would drift; outside a stack's coverage it clamps to its nearest frame).
    let target = Date.now();
    if (frames.length > 0) {
      const a = frameEpoch(frames[idx].date);
      const b = frameEpoch(frames[(idx + 1) % frames.length].date);
      target = b > a ? a + (b - a) * blend : a;
    }
    if (!Number.isFinite(target)) {
      target = Date.now();   // static analysis frames carry a "2016–2026" span, not a date
    }
    if (ui.enso()) {
      ensoPanel.setMarker(new Date(target).toISOString().slice(0, 7));
    }
    let curBlend = 0;
    if (ui.overlay('currents') && currentsFrames.length > 0) {
      curBlend = syncFlowToDate(currentsFlow, currentsFrames, target);
    }
    let wndBlend = 0;
    if (ui.overlay('wind') && windFrames.length > 0) {
      wndBlend = syncFlowToDate(windFlow, windFrames, target);
    }
    const curOn = ui.overlay('currents') && currentsFlow.hasField();
    const wndOn = ui.overlay('wind') && windFlow.hasField();
    // Overlay layer: re-pair to the base's current moment (cheap — a scan of ≤ a few hundred dates).
    overField = overLayer ? pairOverlay(target, idx) : null;

    uniform[0] = ctx.width; uniform[1] = ctx.height; uniform[2] = blend;
    uniform[3] = layer.kind === 'imagery' || layer.kind === 'geo-live' ? 1 : 0;
    uniform[4] = 14; uniform[5] = ui.contours() ? 1 : 0; uniform[6] = earth ? 2 : globe ? 1 : 0;
    uniform[7] = currentField?.meta.width ?? 720;
    // Relief fades out beyond overview zooms: the 48-step shell march terraces up close, and
    // 0.25° ETOPO has no detail to offer there anyway (the streamed window carries the look).
    // Exaggeration has to fall with altitude: 25× reads as mountains from orbit and as absurd
    // cliffs from 700 km, because the vertical scale grows while the 0.25° horizontal detail does not.
    uniform[8] = earth
      ? reliefExagg * clampf(camAlt * 1.6, 0.1, 1)
      : reliefExagg * clampf(1 - (zoom - 16) / 16, 0, 1);   // 0 = smooth sphere
    // Draw over land only where the quantity actually EXISTS over land. For an analysis result that
    // answer comes from the display sink (propagated from the source layers), not from "it is an
    // analysis result": assuming yes painted water-only fields like chlorophyll across the
    // continents, because every coastal cell of the coarse 1° analysis grid overlaps a lot of
    // shoreline, and inland lakes carry real ocean-color retrievals of their own.
    uniform[9] = (analysisActive ? analysisOverLand : layer.overLand) ? 1 : 0;
    uniform[10] = layer.sparse && view === 'abs' && !analysisActive ? 1 : 0;   // Δ/min/max of rain are dense fields
    uniform[11] = ui.dataAlpha();
    uniform[12] = 0.03; uniform[13] = 0.035; uniform[14] = 0.05;   // background
    uniform[15] = ui.sun() ? 1 : 0;
    uniform[16] = globeYaw; uniform[17] = globeTilt;
    if (ui.sun()) {
      // The sun's DATE follows the map's current moment, but its TIME OF DAY is the slider's
      // fixed UTC hour. Holding the hour fixed keeps the terminator steady as dates change
      // (seasonal tilt + the ±4°/yr equation-of-time wobble only) — without it, time-lapse
      // playback sweeps months per second and the spinning hour angle strobes the terminator.
      const sunTime = Math.floor(target / 86400e3) * 86400e3 + ui.sunHour() * 3600e3;
      const sp = subsolarPoint(sunTime);
      uniform[18] = (sp.lonDeg * Math.PI) / 180;
      uniform[19] = (sp.latDeg * Math.PI) / 180;
    }
    uniform[20] = curOn ? 1 : 0; uniform[21] = wndOn ? 1 : 0; uniform[22] = ui.enso() ? 1 : 0;
    uniform[23] = ui.overlay('radar') ? 1 : 0;   // placeholder texture is fully transparent pre-load
    uniform[24] = viewCx; uniform[25] = viewCy; uniform[26] = zoom;
    uniform[27] = flatProj.index;
    const win = detailWin.window;
    if (win) {
      // Unwrap the window's west edge to the copy nearest the view center so the deep-zoom
      // path's (uvcHi − w0) stays a small exact difference; the fract() in the direct path
      // is unaffected by whole-world shifts.
      const cu = detailCenter?.u ?? viewCx;
      uniform[28] = win.rect.u0 + Math.round(cu - win.rect.u0);
      uniform[29] = win.rect.v0;
      uniform[30] = 1 / (win.rect.u1 - win.rect.u0);
      uniform[31] = 1 / (win.rect.v1 - win.rect.v0);
    } else {
      uniform[28] = 0; uniform[29] = 0; uniform[30] = 0; uniform[31] = 0;
    }
    // Overlay draw spec. Bands 0 disables the whole block; the hatch threshold is authored in
    // physical units on the layer and normalized here with the same curve the field was encoded on.
    if (overLayer && overField) {
      uniform[40] = overLayer.overlayBands ?? 8;
      uniform[41] = overLayer.overlayHatchAt !== undefined ? normalizeValue(overLayer, overLayer.overlayHatchAt) : 2;
      uniform[42] = overLayer.overlayHatchAt !== undefined ? 1 : 0;
      uniform[43] = 0.85;
    } else {
      uniform[40] = 0; uniform[41] = 2; uniform[42] = 0; uniform[43] = 0;
    }
    if (earth) {
      const c = earthCamera();
      uniform[44] = c.eye[0]; uniform[45] = c.eye[1]; uniform[46] = c.eye[2];
      uniform[47] = Math.tan(CAM_FOV / 2);
      uniform[48] = c.fwd[0]; uniform[49] = c.fwd[1]; uniform[50] = c.fwd[2];
      uniform[52] = c.right[0]; uniform[53] = c.right[1]; uniform[54] = c.right[2];
      uniform[56] = c.up[0]; uniform[57] = c.up[1]; uniform[58] = c.up[2];
    }
    // Significance stipple (analysis displays only): 7 px dot pitch, dots a third of a cell wide,
    // 70% darkening — dense enough to read as "hatched" at a glance without hiding the color.
    uniform[60] = analysisStipple ? 1 : 0;
    uniform[61] = 7; uniform[62] = 0.17; uniform[63] = 0.7;
    uniform[64] = overlayWin.u0; uniform[65] = overlayWin.v0;
    uniform[66] = 1 / overlayWin.du; uniform[67] = 1 / overlayWin.dv;
    const sc = scaleRemap();
    uniform[68] = sc.offset; uniform[69] = sc.invWidth; uniform[70] = sc.levels; uniform[71] = 0;
    uniform[76] = flowWin.u0; uniform[77] = flowWin.v0;
    uniform[78] = 1 / flowWin.du; uniform[79] = 1 / flowWin.dv;
    uniform[72] = cmpIdx !== null ? 1 : 0;
    uniform[73] = dividerFrac * ctx.width;
    uniform[74] = 0; uniform[75] = 0;
    fillDeepZoomUniforms(globe ? null : detailCenter);   // the linearized path is flat-only
    device.queue.writeBuffer(uniformBuf, 0, uniform.buffer as ArrayBuffer);

    const enc = device.createCommandEncoder();
    if (curOn) { currentsFlow.update(enc, dt, clock, curBlend); }
    if (wndOn) { windFlow.update(enc, dt, clock, wndBlend); }
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.backbufferView, loadOp: 'clear', clearValue: { r: 0.03, g: 0.035, b: 0.05, a: 1 }, storeOp: 'store' }],
    });
    if (ensureBindGroup() && bindGroup) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    updateAnalysisMarkers();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * Each dataset's own time coverage (epoch-seconds), as last read from its `.das`. OISST splits the
 * record across two datasets — finalized up to ~2 weeks ago, preliminary after — and asking the
 * wrong one first costs a 404 round trip per frame (a native-resolution frame is several MB, so
 * the stream is slow enough already).
 */
const DATASET_RANGES = new Map<string, { start: number; end: number }>();

/**
 * The source with its datasets reordered so the one whose coverage holds `date` is asked first.
 * Unknown coverage keeps the declared order — the fallback chain still runs either way.
 */
function routeByDate<T extends { datasets: string[] }>(src: T, date: string): T {
  const t = frameEpoch(date) / 1000;
  const covers = (ds: string): boolean => {
    const r = DATASET_RANGES.get(ds);
    return !!r && t >= r.start - 43200 && t <= r.end + 43200;
  };
  const first = src.datasets.filter(covers);
  if (first.length === 0 || first.length === src.datasets.length) {
    return src;
  }
  return { ...src, datasets: [...first, ...src.datasets.filter((ds) => !covers(ds))] };
}

/** A layer's available date range (epoch-seconds) = union of its datasets' `.das` time actual_range. */
async function sourceTimeRange(servers: string[], datasets: string[]): Promise<{ start: number; end: number }> {
  let start = Infinity, end = -Infinity;
  for (const ds of datasets) {
    for (const server of servers) {
      try {
        const das = await (await fetch(`${server}/${ds}.das`)).text();
        const m = das.match(/time \{[\s\S]*?actual_range ([0-9.eE+]+), ([0-9.eE+]+)/);
        if (m) {
          const r = { start: parseFloat(m[1]), end: parseFloat(m[2]) };
          DATASET_RANGES.set(ds, r);
          start = Math.min(start, r.start);
          end = Math.max(end, r.end);
          break;   // this dataset resolved; other servers are fallbacks, not additions
        }
      } catch { /* try the next server */ }
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('no dataset metadata');
  }
  return { start, end };
}

/** Epoch-ms of a frame date, whether a bare `YYYY-MM-DD` (pinned to 12:00Z) or a full ISO string. */
/**
 * Downloads rows as a CSV file. Values are quoted only when they need it, and the file carries a
 * `#` provenance header — a CSV that has lost track of which product and which units it came from is
 * worse than no CSV, because it still looks authoritative.
 */
function downloadCsv(name: string, header: string[], rows: Array<Array<string | number>>, provenance: string[] = []): void {
  const cell = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = provenance.map((p) => `# ${p}`);
  lines.push(header.map(cell).join(','));
  for (const r of rows) {
    lines.push(r.map(cell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * Makes `panel` draggable by `handle` — the panel's whole title bar, not a corner of it. Buttons,
 * links, selects and inputs inside the handle keep their own clicks, so a header can carry controls
 * and still be grab surface everywhere else.
 *
 * Dragging switches the panel to top/left positioning: a box pinned with `right`/`bottom` would
 * otherwise jump on the first move, because setting `left` while `right` is still set stretches it.
 */
function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';
  handle.style.touchAction = 'none';
  let drag: { dx: number; dy: number } | null = null;
  handle.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement
      || t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) {
      return;
    }
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) {
      return;
    }
    // Keep a sliver on screen: a panel dragged fully past an edge cannot be grabbed back.
    const maxX = window.innerWidth - 40;
    const maxY = window.innerHeight - 28;
    panel.style.left = `${Math.max(-panel.offsetWidth + 40, Math.min(maxX, e.clientX - drag.dx))}px`;
    panel.style.top = `${Math.max(0, Math.min(maxY, e.clientY - drag.dy))}px`;
  });
  const end = (e: PointerEvent): void => {
    if (drag) {
      drag = null;
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }
    }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function frameEpoch(date: string): number {
  return Date.parse(date.includes('T') ? date : `${date}T12:00:00Z`);
}

/** Epoch-ms → its UTC year and how far through that year it falls (0 = Jan 1, 1 = next Jan 1). */
function yearFraction(t: number): { year: number; f: number } {
  const year = new Date(t).getUTCFullYear();
  const a = Date.UTC(year, 0, 1), b = Date.UTC(year + 1, 0, 1);
  return { year, f: (t - a) / (b - a) };
}

/**
 * Points `flow` at the two dated frames bracketing `target` (epoch-ms) and returns the blend
 * between them. Clamps outside the stack's coverage (before the first / after the last frame).
 */
function syncFlowToDate(flow: FlowOverlay, stack: GriddedField[], target: number): number {
  let ci = stack.length - 1;
  for (let i = 0; i < stack.length; i++) {
    if (frameEpoch(stack[i].meta.date) > target) {
      ci = Math.max(0, i - 1);
      break;
    }
  }
  const cn = Math.min(ci + 1, stack.length - 1);
  const ea = frameEpoch(stack[ci].meta.date);
  const eb = frameEpoch(stack[cn].meta.date);
  flow.setFields(stack[ci], stack[cn]);
  return eb > ea ? Math.max(0, Math.min(1, (target - ea) / (eb - ea))) : 0;
}

/** Runs `worker(item, index)` over `items` with up to `width` requests in flight (ERDDAP handles
 *  a few concurrent fetches fine, and one slow response no longer stalls the whole stream). */
async function streamPool<T>(items: T[], width: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      await worker(items[i], i);
    }
  }));
}

/** The 1st (12:00Z) of every `stepMonths`-th month from `sinceYear`-01 up to `range.end`. */
function sampledDates(range: { start: number; end: number }, sinceYear: number, stepMonths: number): string[] {
  const out: string[] = [];
  if (stepMonths < 1) {
    // Sub-monthly: walk DAYS backwards from the newest data, bounded by MAX_SUBMONTHLY_FRAMES. The
    // whole record at this cadence would be thousands of requests, and the recent window is what a
    // fine cadence is for — watching a storm, a bloom or a heat event evolve.
    const stepDays = Math.max(1, Math.round(stepMonths * 30.44));
    const floor = Math.max(range.start, Date.UTC(sinceYear, 0, 1, 12) / 1000);
    for (let i = 0; i < MAX_SUBMONTHLY_FRAMES; i++) {
      const epoch = range.end - i * stepDays * 86400;
      if (epoch < floor) { break; }
      out.push(new Date(epoch * 1000).toISOString().slice(0, 10));
    }
    return out.reverse();
  }
  let y = sinceYear, m = 0;
  for (;;) {
    const epoch = Date.UTC(y, m, 1, 12) / 1000;
    if (epoch > range.end) { break; }
    if (epoch >= range.start) { out.push(new Date(epoch * 1000).toISOString().slice(0, 10)); }
    m += stepMonths; y += Math.floor(m / 12); m %= 12;
  }
  return out;
}

// ── ENSO classification panel ─────────────────────────────────────────────────────────
// A CPC-style ONI bar chart (1981→now, monthly) + the classification of "now" and of the map's
// scrubbed date. Data = committed baked record extended live from NCEI; all °C by convention.

interface EnsoPanel {
  setVisible: (on: boolean) => void;
  ensureLoaded: () => void;
  /** Sync the chart marker + readout to the map timeline's current month (`YYYY-MM`). */
  setMarker: (month: string) => void;
}

function buildEnsoPanel(): EnsoPanel {
  const panel = document.createElement('div');
  panel.className = 'gis-panel solid gis-enso';
  panel.style.cssText = 'display:none;width:320px';
  const title = document.createElement('div');
  title.style.cssText = 'margin-bottom:5px;color:#5ef0c8';
  title.textContent = 'ENSO — Oceanic Niño Index (Niño 3.4)';
  const chart = document.createElement('canvas');
  chart.width = 640; chart.height = 180;
  chart.style.cssText = 'width:320px;height:90px;display:block;background:rgba(255,255,255,0.04);border-radius:3px';
  const nowLine = document.createElement('div');
  nowLine.style.cssText = 'margin-top:5px;line-height:1.5;color:#bcd';
  const markLine = document.createElement('div');
  markLine.style.cssText = 'line-height:1.5;color:#9fd8cf';
  const noteLine = document.createElement('div');
  noteLine.style.cssText = 'margin-top:3px;color:rgba(223,238,240,0.45);font-size:9px';
  noteLine.textContent = 'ONI = 3-mo mean Niño 3.4 anomaly · event ≥ 5 seasons past ±0.5°C · OISST-derived';
  panel.append(title, chart, nowLine, markLine, noteLine);
  document.body.appendChild(panel);
  makeDraggable(panel, title);

  let seasons: EnsoSeason[] = [];
  let seasonByMonth = new Map<string, EnsoSeason>();
  let events: EnsoEvent[] = [];
  let monthToDate: EnsoMonth | null = null;
  let loaded = false;
  let loading = false;
  let markerMonth = '';
  let hoverMonth = '';

  const sgn = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
  const phaseName = (p: 'el-nino' | 'la-nina'): string => (p === 'el-nino' ? 'El Niño' : 'La Niña');

  /** One-line classification of a month: `ONI +2.3 · El Niño (very strong, peak +2.6)`. */
  function describe(month: string): string {
    const s = seasonByMonth.get(month);
    if (!s) {
      return month === monthToDate?.month ? `anomaly ${sgn(monthToDate.anom)}°C month-to-date` : 'no index data';
    }
    const ev = eventAt(events, month);
    const phase = ev
      ? `${phaseName(ev.phase)} (${strengthLabel(ev.peak)}, peak ${sgn(ev.peak)})`
      : s.oni >= 0.5 ? 'warm — at El Niño threshold'
      : s.oni <= -0.5 ? 'cool — at La Niña threshold'
      : 'neutral';
    return `ONI ${sgn(s.oni)} · ${phase}`;
  }

  function draw(): void {
    const cx = chart.getContext('2d')!;
    const W = chart.width, H = chart.height;
    cx.clearRect(0, 0, W, H);
    if (seasons.length < 2) {
      return;
    }
    const PX = 14, PY = 12;
    const o0 = monthOrdinal(seasons[0].month);
    const o1 = monthOrdinal(seasons[seasons.length - 1].month);
    const X = (month: string): number => PX + ((monthOrdinal(month) - o0) / Math.max(o1 - o0, 1)) * (W - 2 * PX);
    const ONI_FS = 3;                                          // ±full-scale of the y axis, °C
    const Y = (v: number): number => H / 2 - (Math.max(-ONI_FS, Math.min(ONI_FS, v)) / ONI_FS) * (H / 2 - PY);

    // Zero line + dashed ±0.5 event thresholds.
    cx.strokeStyle = 'rgba(223,238,240,0.35)';
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(PX, Y(0)); cx.lineTo(W - PX, Y(0)); cx.stroke();
    cx.setLineDash([3, 3]);
    cx.strokeStyle = 'rgba(255,120,90,0.45)';
    cx.beginPath(); cx.moveTo(PX, Y(0.5)); cx.lineTo(W - PX, Y(0.5)); cx.stroke();
    cx.strokeStyle = 'rgba(110,170,255,0.45)';
    cx.beginPath(); cx.moveTo(PX, Y(-0.5)); cx.lineTo(W - PX, Y(-0.5)); cx.stroke();
    cx.setLineDash([]);

    // Monthly ONI bars, CPC-style: red past +0.5, blue past −0.5, gray in between.
    const barW = Math.max(1, (W - 2 * PX) / seasons.length);
    for (const s of seasons) {
      cx.fillStyle = s.oni >= 0.5 ? 'rgba(255,95,70,0.95)' : s.oni <= -0.5 ? 'rgba(90,155,255,0.95)' : 'rgba(190,205,215,0.4)';
      const y = Y(s.oni);
      cx.fillRect(X(s.month) - barW / 2, Math.min(y, Y(0)), barW, Math.max(1, Math.abs(y - Y(0))));
    }

    // Year ticks every 5 years.
    cx.fillStyle = 'rgba(223,238,240,0.5)';
    cx.font = '9px ui-monospace,monospace';
    cx.textAlign = 'center';
    for (const s of seasons) {
      const y = parseInt(s.month.slice(0, 4), 10);
      if (s.month.endsWith('-01') && y % 5 === 0) {
        cx.fillText(`'${s.month.slice(2, 4)}`, X(s.month), H - 2);
      }
    }
    cx.textAlign = 'left';

    // Markers: teal = the map timeline's month, white = hover.
    for (const [month, color] of [[markerMonth, '#5ef0c8'], [hoverMonth, 'rgba(255,255,255,0.8)']] as const) {
      if (month && seasonByMonth.has(month)) {
        cx.strokeStyle = color;
        cx.lineWidth = 1.5;
        cx.beginPath(); cx.moveTo(X(month), PY - 6); cx.lineTo(X(month), H - PY + 6); cx.stroke();
      }
    }
  }

  chart.addEventListener('pointermove', (e) => {
    if (seasons.length < 2) {
      return;
    }
    const r = chart.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const o0 = monthOrdinal(seasons[0].month);
    const o1 = monthOrdinal(seasons[seasons.length - 1].month);
    const o = Math.round(o0 + t * (o1 - o0));
    const m = `${Math.floor(o / 12)}-${String((o % 12) + 1).padStart(2, '0')}`;
    if (m !== hoverMonth) {
      hoverMonth = m;
      markLine.textContent = `${m} · ${describe(m)}`;
      draw();
    }
  });
  chart.addEventListener('pointerleave', () => {
    hoverMonth = '';
    markLine.textContent = markerMonth ? `map date ${markerMonth} · ${describe(markerMonth)}` : '';
    draw();
  });

  function refreshNow(): void {
    if (seasons.length === 0) {
      nowLine.textContent = 'No index data (NCEI unreachable and no baked record).';
      return;
    }
    const lastSeason = seasons[seasons.length - 1];
    const mtd = monthToDate ? ` · ${monthToDate.month.slice(5)}/${monthToDate.month.slice(2, 4)} to-date ${sgn(monthToDate.anom)}°C` : '';
    nowLine.textContent = `now (${lastSeason.month}): ${describe(lastSeason.month)}${mtd}`;
  }

  function ensureLoaded(): void {
    if (loaded || loading) {
      return;
    }
    loading = true;
    nowLine.textContent = 'Loading Niño 3.4 record…';
    void (async () => {
      let months: EnsoMonth[] = [];
      try {
        const baked = parseBakedEnso(await (await fetch(ensoJsonUrl)).json() as EnsoBakedJson);
        months = baked;
        // Re-fetch from the START of the bake's last month (it was partial at bake time) to now.
        const since = baked.length ? baked[baked.length - 1].month : '2020-03';
        months = mergeEnsoMonths(baked, await fetchNino34Live(since).catch(() => []));
      } catch {
        // No baked asset (bake not run yet) — live still covers 2020→now.
        months = await fetchNino34Live('2020-03').catch(() => []);
      }
      const cur = currentUtcMonth();
      monthToDate = months.find((m) => m.month === cur) ?? null;
      const complete = months.filter((m) => m.month < cur);
      seasons = oniSeasons(complete);
      seasonByMonth = new Map(seasons.map((s) => [s.month, s]));
      events = ensoEvents(seasons);
      loaded = seasons.length > 0;
      loading = false;
      refreshNow();
      draw();
    })();
  }

  return {
    setVisible: (on) => { panel.style.display = on ? 'block' : 'none'; },
    ensureLoaded,
    setMarker: (month) => {
      if (month === markerMonth || !loaded) {
        return;
      }
      markerMonth = month;
      if (!hoverMonth) {
        markLine.textContent = `map date ${month} · ${describe(month)}`;
        draw();
      }
    },
  };
}

type ViewMode = 'flat' | 'globe' | 'earth';
type OverlayKey = 'currents' | 'wind' | 'radar' | 'storms' | 'fire' | 'borders' | 'cities';

interface UI {
  playing: () => boolean;
  interval: () => number;
  sunHour: () => number;
  contours: () => boolean;
  mode: () => ViewMode;
  /** The active flat projection key ('map' while the globe is shown). */
  projection: () => ProjectionKey;
  spin: () => boolean;
  scrubbing: () => boolean;
  overlay: (k: OverlayKey) => boolean;
  enso: () => boolean;
  sun: () => boolean;
  dataAlpha: () => number;
  setPlaying: (v: boolean) => void;
  setDate: (date: string) => void;
  setTimeline: (count: number, index: number) => void;
  setDateBounds: (minISO: string, maxISO: string) => void;
  setLegend: (spec: LegendSpec) => void;
  /** The legend's currently rendered scale endpoints, so the info overlay can quote them. */
  legendTicks: () => { lo: string; mid: string; hi: string };
  /** Moves the picker to `key` — for layer switches that did not come from the picker itself. */
  setLayer: (key: string) => void;
  /** The overlay layer's legend strip; null hides it. */
  setOverlayLegend: (spec: OverlayLegendSpec | null) => void;
  /** Moves the overlay picker to `key` (`''` = none). */
  setOverlayLayer: (key: string) => void;
  /** Moves the draw-mode picker. */
  setDrawMode: (mode: string) => void;
  setStats: (text: string) => void;
  /** Derivation caveat shown under the legend (analysis results); null/'' hides it. */
  setNote: (text: string | null) => void;
  /** Clears the scale widgets back to the layer's defaults (the host reset the override). */
  resetScaleControls: () => void;
  /** Re-reads the live range into the widgets — after a load, a view change or a frame swap. */
  refreshScaleControls: () => void;
  setView: (v: ViewKey) => void;
  setViewEnabled: (enabled: boolean) => void;
}

/** Builds the floating control bar + colorbar legend. */
function buildUI(opts: {
  getStride: () => number;
  setStride: (stride: number) => void;
  getStep: () => number;
  setStep: (months: number) => void;
  getSampling: () => 'snapshot' | 'max' | 'min' | 'mean';
  setSampling: (s: 'snapshot' | 'max' | 'min' | 'mean') => void;
  getView: () => { z: number; cx: number; cy: number };
  /** Place search / pasted coordinates: glide the view to a lon/lat at a zoom factor. */
  onFlyTo: (lon: number, lat: number, zoom: number) => void;
  /** The date of timeline frame `i` (null past the end) — for year steps and scrub tick marks. */
  frameDate: (i: number) => string | null;
  onScrub: (index: number) => void;
  onPickDate: (dateISO: string) => void;
  onLayer: (key: string) => void;
  /** The overlay picker changed; `''` means no overlay. */
  onOverlayLayer: (key: string) => void;
  /** The draw-mode picker changed ('off' | 'line' | 'area'). */
  onDraw: (mode: string) => void;
  /** OBIS species for the occurrence layer. */
  getSpecies: () => string;
  onSpecies: (taxon: string) => void;
  /** ATN track taxon ('' = no tracks). */
  getTracks: () => string;
  onTracks: (taxon: string) => void;
  /** The drawn shape's ring as a `points` string, or null when nothing is drawn (for Share). */
  drawnRing: () => string | null;
  /** Earth-camera params for Share, as [key, value] pairs. */
  earthCam: () => Array<[string, string]>;
  /** The legend's ⓘ was clicked (or `I` pressed): open the layer-info overlay. */
  onInfo: () => void;
  /** The gear menu's "get this data" row: open the request / snippets / citation panel. */
  onReproduce: () => void;
  /** The gear menu's "your data" row: open the GeoJSON-region / station-CSV import panel. */
  onImport: () => void;
  onView: (v: ViewKey) => void;
  onDeltaYears: (years: number) => void;
  onUnit: (fahrenheit: boolean) => void;
  /** Color-scale controls: an explicit range (null resets to the layer's own), band count and
   *  colormap. `onScaleAuto` fits the range to the frame (or the drawn region) and returns what it
   *  chose, so the inputs can show it. */
  onScaleRange: (range: { min: number; max: number } | null) => void;
  onScaleLevels: (levels: number) => void;
  onColormap: (name: SstColormapName | null) => void;
  onScaleAuto: () => { min: number; max: number } | null;
  /** Distinct steps left in the 8-bit encoding at the current range — a banding warning. */
  scaleBands: () => number;
  /** Pins a second date opposite the swipe divider; '' turns comparing off. Returns the frame date
   *  actually snapped to, so the control can show it. */
  onCompare: (dateISO: string) => string | null;
  /** Restricts every stack read to these months of year; '' is all months. */
  onSeason: (key: string) => void;
  /** The frame date currently pinned opposite the divider, without changing anything. */
  compareSnapped: () => string | null;
  /** The range currently displayed, for seeding the inputs. */
  currentRange: () => { min: number; max: number };
  /** Scale state for the share link — only what differs from the layer's defaults. */
  sharedScale: () => { range: { min: number; max: number } | null; levels: number; colormap: SstColormapName | null };
  onOverlay: (which: OverlayKey, on: boolean) => void;
  onEnso: (on: boolean) => void;
  onSun: (on: boolean) => void;
  /** The projection select changed (flat projections or the globe). */
  onProjection?: () => void;
  /** Analysis-panel toggle, appended to the main bar (omitted in nogui mode). */
  analysisButton?: HTMLElement;
}): UI {
  // Layout and skin live in geo_gis_explorer.css (classes `gis-*`); what is set inline here is
  // per-instance only — a width, an accent colour, a display toggle. `css` is kept for those.
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };
  /** A `<tag class="…">`, the one-liner most of this builder is made of. */
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.className = className;
    return e;
  };
  const check = (labelText: string, checked: boolean): { wrap: HTMLLabelElement; box: HTMLInputElement } => {
    const wrap = el('label', 'gis-check');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = checked;
    wrap.append(box, document.createTextNode(labelText));
    return { wrap, box };
  };

  const q = new URLSearchParams(location.search);
  const noGui = q.has('nogui');

  const bar = el('div', 'gis-panel gis-bar');

  const playBtn = el('button', 'gis-btn icon');
  // Paused by default: the map opens on the newest frame, and animation is an opt-in (Space, the
  // play button, or `?play`). `?paused` is still accepted so old links keep working.
  let playing = q.has('play');
  const paintPlay = (): void => {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? 'Pause (Space)' : 'Play the time-lapse (Space)';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  paintPlay();
  const togglePlay = (): void => { playing = !playing; paintPlay(); };
  playBtn.addEventListener('click', togglePlay);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;   // typing in a field: every key below belongs to the field
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) { stepYears(-1); } else { stepFrames(-1); } break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) { stepYears(1); } else { stepFrames(1); } break;
      case 'Home': e.preventDefault(); stepFrames(-1e9); break;
      case 'End': e.preventDefault(); stepFrames(1e9); break;
      // Shift+/ reaches here as '?' on a US layout and as '/' + shiftKey on some others.
      case '/': e.preventDefault(); if (e.shiftKey) { toggleHelp(); } else { openSearch(); } break;
      case '?': e.preventDefault(); toggleHelp(); break;
      default: break;
    }
  });

  const speed = document.createElement('input');
  speed.type = 'range'; speed.min = '0.15'; speed.max = '2'; speed.step = '0.05';
  speed.value = /^[0-9.]+$/.test(q.get('speed') ?? '') ? q.get('speed') as string : '0.7';
  speed.title = 'Playback speed (seconds per frame)';
  css(speed, 'width:56px');

  const dateLbl = el('span', 'gis-date');
  dateLbl.textContent = '—';

  let scrubbing = false;
  const scrub = el('input', 'gis-scrub');
  scrub.type = 'range'; scrub.min = '0'; scrub.max = '0'; scrub.step = '1'; scrub.value = '0';
  scrub.title = 'Scrub the time-lapse';
  scrub.addEventListener('input', () => { scrubbing = true; opts.onScrub(parseInt(scrub.value, 10)); });
  const stopScrub = (): void => { scrubbing = false; };
  scrub.addEventListener('change', stopScrub);
  scrub.addEventListener('pointerup', stopScrub);
  // Year tick marks under the slider. A 500-frame record is a featureless track without them;
  // with them, "the 2015–16 El Niño" is a place you can aim for. Rebuilt only when the timeline's
  // shape changes (see setTimeline) — the datalist is read by the browser, not by us.
  const scrubTicks = document.createElement('datalist');
  scrubTicks.id = 'gis-scrub-years';
  scrub.setAttribute('list', scrubTicks.id);
  let tickKey = '';
  const rebuildTicks = (count: number): void => {
    const key = `${count}|${opts.frameDate(0) ?? ''}|${opts.frameDate(count - 1) ?? ''}`;
    if (key === tickKey) {
      return;
    }
    tickKey = key;
    scrubTicks.replaceChildren();
    let lastYear = '';
    for (let i = 0; i < count; i++) {
      const year = (opts.frameDate(i) ?? '').slice(0, 4);
      if (year && year !== lastYear) {
        lastYear = year;
        const o = document.createElement('option');
        o.value = String(i);
        scrubTicks.appendChild(o);
      }
    }
  };
  // The date under the pointer, while hovering or dragging: the big label only ever shows the
  // frame that is ON screen, which is no help in aiming for one that is not.
  const scrubTip = el('div', 'gis-scrub-tip');
  const showScrubTip = (clientX: number): void => {
    const max = parseInt(scrub.max, 10);
    if (!(max > 0)) {
      scrubTip.style.display = 'none';
      return;
    }
    const r = scrub.getBoundingClientRect();
    // Range thumbs travel over (width − thumb) px; 8 px is a close enough thumb half-width for the
    // native control on every platform this runs on.
    const t = Math.max(0, Math.min(1, (clientX - r.left - 8) / Math.max(1, r.width - 16)));
    const i = Math.round(t * max);
    const d = opts.frameDate(i);
    if (!d) {
      scrubTip.style.display = 'none';
      return;
    }
    scrubTip.textContent = d;
    scrubTip.style.display = 'block';
    scrubTip.style.left = `${r.left + 8 + t * (r.width - 16)}px`;
    scrubTip.style.top = `${r.top - 4}px`;
  };
  scrub.addEventListener('pointermove', (e) => showScrubTip(e.clientX));
  scrub.addEventListener('pointerleave', () => { scrubTip.style.display = 'none'; });
  /** Steps the timeline by `delta` frames, clamped. */
  const stepFrames = (delta: number): void => {
    const max = parseInt(scrub.max, 10);
    if (!(max > 0)) {
      return;
    }
    const i = Math.max(0, Math.min(max, parseInt(scrub.value, 10) + delta));
    scrub.value = String(i);
    opts.onScrub(i);
  };
  /** Steps to the frame nearest the same date `years` away — one year, whatever the cadence. */
  const stepYears = (years: number): void => {
    const max = parseInt(scrub.max, 10);
    const cur = opts.frameDate(parseInt(scrub.value, 10));
    if (!(max > 0) || !cur) {
      return;
    }
    const target = frameEpoch(cur) + years * 365.25 * 86400e3;
    let best = 0, bestErr = Infinity;
    for (let i = 0; i <= max; i++) {
      const d = opts.frameDate(i);
      const err = d ? Math.abs(frameEpoch(d) - target) : Infinity;
      if (err < bestErr) {
        best = i; bestErr = err;
      }
    }
    scrub.value = String(best);
    opts.onScrub(best);
  };

  const datePick = document.createElement('input');
  datePick.type = 'date';
  datePick.title = 'Pick any day (OISST layers, fetched on demand)';
  datePick.className = 'gis-ctrl';
  css(datePick, 'padding:1px 4px;color-scheme:dark');
  datePick.addEventListener('change', () => { if (datePick.value) { opts.onPickDate(datePick.value); } });

  // Base-layer selector.
  const layerSel = document.createElement('select');
  // Both pickers are capped: two grouped selects of full-length layer labels would otherwise wrap
  // the control bar onto a second line.
  layerSel.className = 'gis-ctrl';
  css(layerSel, 'max-width:150px');
  // Grouped by domain — the flat list stopped being scannable past ~a dozen layers. Groups are
  // emitted in first-appearance order, so LAYERS' order is still the single source of truth.
  const groups = new Map<LayerGroup, HTMLOptGroupElement>();
  for (const l of LAYERS) {
    let g = groups.get(l.group);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = l.group;
      groups.set(l.group, g);
      layerSel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = l.key; o.textContent = l.label;
    g.appendChild(o);
  }
  if (LAYERS.some((l) => l.key === q.get('layer'))) { layerSel.value = q.get('layer') as string; }
  layerSel.addEventListener('change', () => opts.onLayer(layerSel.value));

  // Overlay-layer selector: a SECOND field drawn as iso-lines over the base one. Same grouping as
  // the base picker, minus imagery (RGB has no value scale to contour), plus an explicit "none".
  const overSel = document.createElement('select');
  overSel.className = 'gis-ctrl';
  css(overSel, 'max-width:150px');
  overSel.title = 'Draw a second layer over the base one as iso-lines (+ hatching above its threshold)';
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = '+ overlay…';
  overSel.appendChild(noneOpt);
  const overGroups = new Map<LayerGroup, HTMLOptGroupElement>();
  for (const l of LAYERS) {
    if (!overlayable(l)) {
      continue;
    }
    let g = overGroups.get(l.group);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = l.group;
      overGroups.set(l.group, g);
      overSel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = l.key; o.textContent = l.label;
    g.appendChild(o);
  }
  if (LAYERS.some((l) => l.key === q.get('over') && overlayable(l))) { overSel.value = q.get('over') as string; }
  overSel.addEventListener('change', () => opts.onOverlayLayer(overSel.value));

  // Species picker for the OBIS occurrence layer, and the ATN track overlay's taxon. Both live in
  // the gear menu: they are parameters of one layer / one overlay, not layers of their own.
  const speciesSel = document.createElement('select');
  speciesSel.className = 'gis-ctrl';
  css(speciesSel, 'max-width:190px');
  speciesSel.title = 'Species for the OBIS occurrence layer (any name OBIS indexes works — this is a menu, not a limit)';
  {
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const sp of OBIS_SPECIES) {
      let g = groups.get(sp.group);
      if (!g) {
        g = document.createElement('optgroup');
        g.label = sp.group;
        groups.set(sp.group, g);
        speciesSel.appendChild(g);
      }
      const o = document.createElement('option');
      o.value = sp.taxon; o.textContent = sp.label;
      g.appendChild(o);
    }
  }
  speciesSel.value = opts.getSpecies();
  speciesSel.addEventListener('change', () => opts.onSpecies(speciesSel.value));

  const tracksSel = document.createElement('select');
  tracksSel.className = 'gis-ctrl';
  css(tracksSel, 'max-width:190px');
  tracksSel.title = 'Draw satellite tracks of tagged marine animals (US Animal Telemetry Network)';
  {
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'none';
    tracksSel.appendChild(none);
    for (const t of ATN_TAXA) {
      const o = document.createElement('option');
      o.value = t.taxon; o.textContent = t.label;
      tracksSel.appendChild(o);
    }
  }
  tracksSel.value = opts.getTracks();
  tracksSel.addEventListener('change', () => opts.onTracks(tracksSel.value));

  // Draw mode: what a click on the map does. `off` keeps the plain point-pick readout. A segmented
  // control rather than a select — the active tool is state you want to see without opening
  // anything, and three icons read faster than a dropdown's caption.
  const drawSeg = el('div', 'gis-draw-mode');
  drawSeg.setAttribute('role', 'radiogroup');
  drawSeg.setAttribute('aria-label', 'Map click tool');
  const drawBtns = new Map<string, HTMLButtonElement>();
  let drawValue = 'off';
  const paintDraw = (): void => {
    for (const [v, b] of drawBtns) {
      b.setAttribute('aria-checked', String(v === drawValue));   // the stylesheet paints the active one
    }
  };
  for (const [v, glyph, label, tip] of [
    ['off', '⌖', 'pick', 'Click reads the value under the pointer (and a point time series)'],
    ['line', '╱', 'line', 'Draw a line for value vs distance along it. Double-click or Enter finishes, Esc clears'],
    ['area', '⬟', 'area', 'Draw an area for its cos(lat)-weighted mean over time. Double-click or Enter finishes, Esc clears'],
  ] as const) {
    const b = el('button', 'gis-btn');
    b.type = 'button';
    b.textContent = glyph;
    b.title = tip;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => {
      if (drawValue !== v) {
        drawValue = v;
        paintDraw();
        opts.onDraw(v);
      }
    });
    drawBtns.set(v, b);
    drawSeg.appendChild(b);
  }
  paintDraw();

  // Analysis-view selector (absolute field, Δ vs prior year, min/max/range over all years).
  const viewSel = document.createElement('select');
  viewSel.className = 'gis-ctrl';
  viewSel.title = 'Analysis view over the loaded years';
  for (const v of VIEWS) {
    const o = document.createElement('option');
    o.value = v.key; o.textContent = v.label;
    viewSel.appendChild(o);
  }
  if (VIEWS.some((v) => v.key === q.get('view'))) { viewSel.value = q.get('view') as string; }
  viewSel.addEventListener('change', () => opts.onView(viewSel.value as ViewKey));

  // Time-lapse cadence: how often a frame is sampled. Live layers re-stream on change; the
  // committed baked stacks stay at 4 months, so finer cadence refines the live-covered years.
  const stepSel = document.createElement('select');
  stepSel.className = 'gis-ctrl';
  stepSel.title = 'Time-lapse cadence — sample a frame every N months (finer = more data streamed)';
  // Fractional values are sub-monthly: every feed here is daily or finer upstream (GFS 3-hourly,
  // WaveWatch hourly, OISST/Coral Reef Watch/PERSIANN daily), so the coarse end is our choice, not a
  // limit of the data. Sub-monthly cadences cover a BOUNDED recent window instead of the whole
  // record — 10 years of daily frames is ~3,650 requests, which is not a viewer, it is a download.
  for (const [v, label] of [
    ['4', '4 mo'], ['2', '2 mo'], ['1', '1 mo'],
    ['0.5', '~2 wk'], ['0.25', '~1 wk'], ['0.033', 'daily'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    stepSel.appendChild(o);
  }
  stepSel.value = String(opts.getStep());
  stepSel.addEventListener('change', () => opts.setStep(parseFloat(stepSel.value)));

  // How a sub-daily feed collapses onto a daily frame. Only the GFS atmosphere layers are
  // sub-daily; on everything else the picker is inert and says so.
  const sampSel = document.createElement('select');
  sampSel.className = 'gis-ctrl';
  sampSel.title = 'How sub-daily feeds (the GFS atmosphere layers) are sampled onto each day. '
    + '12:00 UTC is one instant — dawn in New Mexico, midday in Nigeria, night in Japan — so a '
    + 'global map of a diurnal field is comparing different times of day. The daily reductions read '
    + 'every 3-hourly step instead, which is coherent worldwide because each longitude passes local '
    + 'noon exactly once per UTC day. Costs ~8× the data per frame.';
  for (const [v, label] of [
    ['snapshot', '12:00 UTC'], ['max', 'daily max'], ['min', 'daily min'], ['mean', 'daily mean'],
  ] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sampSel.appendChild(o);
  }
  sampSel.value = opts.getSampling();
  sampSel.addEventListener('change', () => opts.setSampling(sampSel.value as 'snapshot'));

  // Δ-view reference: how many years back to compare against.
  const dyrSel = document.createElement('select');
  dyrSel.className = 'gis-ctrl';
  dyrSel.title = 'Δ view — years back to compare against';
  for (let n = 1; n <= 5; n++) {
    const o = document.createElement('option');
    o.value = String(n); o.textContent = `−${n} yr`;
    dyrSel.appendChild(o);
  }
  if (/^[1-5]$/.test(q.get('dyr') ?? '')) { dyrSel.value = q.get('dyr') as string; }
  dyrSel.addEventListener('change', () => opts.onDeltaYears(parseInt(dyrSel.value, 10)));

  const iso = check('iso', q.has('iso'));
  const spinOn = q.has('spin');   // globe auto-spin — URL-only (`?spin`, for nogui/display mode)

  // Opacity of over-land data layers (air temp, rain, …) over the basemap — lets the terrain
  // show through instead of the data taking over the whole display.
  const alphaSl = document.createElement('input');
  alphaSl.type = 'range'; alphaSl.min = '0.25'; alphaSl.max = '1'; alphaSl.step = '0.05';
  alphaSl.value = /^0?\.[0-9]+$|^1$/.test(q.get('alpha') ?? '') ? q.get('alpha') as string : '0.8';
  alphaSl.title = 'Data opacity over the basemap (atmosphere layers)';
  css(alphaSl, 'width:56px;accent-color:#dfa94e');
  const curOv = check('currents', q.has('currents'));
  curOv.wrap.title = 'Ocean-current particle flow (baked AVISO)';
  curOv.box.style.accentColor = '#7fe3ff';
  curOv.box.addEventListener('change', () => opts.onOverlay('currents', curOv.box.checked));
  const wndOv = check('wind', q.has('wind'));
  wndOv.wrap.title = 'Wind particle flow (live NOAA GFS)';
  wndOv.box.style.accentColor = '#b9c6ff';
  wndOv.box.addEventListener('change', () => opts.onOverlay('wind', wndOv.box.checked));
  const rdrOv = check('radar', q.has('radar'));
  rdrOv.wrap.title = 'Live weather-radar echoes, last ~10 min (RainViewer; land coverage only)';
  rdrOv.box.style.accentColor = '#8ef78e';
  rdrOv.box.addEventListener('change', () => opts.onOverlay('radar', rdrOv.box.checked));
  const stmOv = check('storms', q.has('storms'));
  stmOv.wrap.title = 'Active tropical cyclones: best track, forecast track, error cone, and coastal '
    + `watches/warnings (${CYCLONE_ATTRIBUTION}). ${CYCLONE_ALERT_LABELS.HWR} is red, `
    + `${CYCLONE_ALERT_LABELS.HWA} pink, ${CYCLONE_ALERT_LABELS.TWR} blue, ${CYCLONE_ALERT_LABELS.TWA} yellow. `
    + 'Always the LATEST advisory — this overlay does not follow the time slider';
  stmOv.box.style.accentColor = '#ff5f3b';
  stmOv.box.addEventListener('change', () => opts.onOverlay('storms', stmOv.box.checked));
  const fireOvChk = check('fire', q.has('fire'));
  fireOvChk.wrap.title = 'Active wildfires: mapped perimeters, incident size/containment, and VIIRS '
    + 'satellite hotspots from the last 24 h, over national-forest boundaries (NIFC/WFIGS · NASA · USFS). '
    + 'Perimeters lag the reported acreage — they are only updated when the fire is flown';
  fireOvChk.box.style.accentColor = '#ff6a2a';
  fireOvChk.box.addEventListener('change', () => opts.onOverlay('fire', fireOvChk.box.checked));
  const bordersChk = check('borders', q.get('borders') !== '0');   // default ON; `?borders=0` opts out
  bordersChk.wrap.title = 'Country and state/province boundary lines. Detail follows the zoom — '
    + `1:110M, 1:50M, then 1:10M (${NATURAL_EARTH_ATTRIBUTION})`;
  bordersChk.box.style.accentColor = '#fff6dc';
  bordersChk.box.addEventListener('change', () => opts.onOverlay('borders', bordersChk.box.checked));
  const citiesChk = check('cities', q.get('cities') !== '0');   // default ON; `?cities=0` opts out
  citiesChk.wrap.title = 'City labels, thinned by Natural Earth\'s own prominence ranking and by '
    + 'screen-space collision — more cities appear as you zoom in';
  citiesChk.box.style.accentColor = '#eef3fb';
  citiesChk.box.addEventListener('change', () => opts.onOverlay('cities', citiesChk.box.checked));
  const sunChk = check('sun', q.has('sun'));
  sunChk.wrap.title = 'Day/night — the real sun position at the map\'s current date: terminator darkening + city lights (night map © Solar System Scope)';
  sunChk.box.style.accentColor = '#ffd75e';
  // Time of day (UTC) for the sun. Holding the hour fixed as the date changes keeps the
  // terminator's position steady (only the ±4°/yr equation-of-time wobble + seasonal tilt).
  const sunHr = document.createElement('input');
  sunHr.type = 'range'; sunHr.min = '0'; sunHr.max = '23.75'; sunHr.step = '0.25';
  sunHr.value = /^([01]?[0-9]|2[0-3])(\.[0-9]+)?$/.test(q.get('sunh') ?? '') ? q.get('sunh') as string : '12';
  sunHr.title = 'Sun time of day (UTC) — held fixed as the date changes';
  css(sunHr, 'width:56px;accent-color:#ffd75e');
  sunChk.box.addEventListener('change', () => opts.onSun(sunChk.box.checked));
  const ensoChk = check('ENSO', q.has('enso'));
  ensoChk.wrap.title = 'El Niño / La Niña classification — Oceanic Niño Index over the Niño 3.4 box (outlined on the map)';
  ensoChk.box.style.accentColor = '#ffd166';
  ensoChk.box.addEventListener('change', () => opts.onEnso(ensoChk.box.checked));

  // Temperature unit toggle (absolute °F = °C·9/5+32; deltas/ranges scale by 9/5 only).
  const unitBtn = el('button', 'gis-btn');
  let unitF = q.get('unit') !== 'c';   // Fahrenheit by default
  unitBtn.textContent = unitF ? '°F' : '°C';
  unitBtn.title = 'Toggle temperature units (Celsius / Fahrenheit)';
  unitBtn.addEventListener('click', () => {
    unitF = !unitF;
    unitBtn.textContent = unitF ? '°F' : '°C';
    opts.onUnit(unitF);
  });

  // Fetch resolution. Stride 1 is each feed's NATIVE grid (0.25° for OISST and PERSIANN, 0.5° for
  // GFS and WaveWatch, 0.05° for Coral Reef Watch) — 4–100× the payload of the default, so the option
  // exists but says so.
  const resSel = document.createElement('select');
  resSel.className = 'gis-ctrl';
  resSel.title = 'Fetch resolution. Stride 1 is the feed\'s native grid — much more data per frame; '
    + 'pair it with a coarse cadence or a short window.';
  for (const [v, label] of [['4', '1° (coarse)'], ['2', '0.5°'], ['1', 'native']] as const) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    resSel.appendChild(o);
  }
  resSel.value = String(opts.getStride());
  resSel.addEventListener('change', () => opts.setStride(parseInt(resSel.value, 10)));

  // Projection select: the flat map projections + the ray-marched relief globe.
  const projSel = document.createElement('select');
  projSel.className = 'gis-ctrl';
  projSel.title = 'Projection — equirect map, Mercator (conformal; beware inflated polar areas), '
    + 'Mollweide & Equal Earth (equal-area — honest for climate data), polar stereographic views, '
    + 'or the relief globe (drag to rotate)';
  for (const proj of PROJECTIONS) {
    const o = document.createElement('option');
    o.value = proj.key;
    o.textContent = proj.label;
    o.title = proj.note;
    projSel.appendChild(o);
  }
  // The ray-marched perspective 'earth' mode is NOT offered: at low altitude 0.25° ETOPO melts into
  // plateaus, which is a data-resolution limit no amount of camera work fixes. The shader path and
  // camera survive behind `?proj=earth` so it stays one URL away.
  const globeOpt = document.createElement('option');
  globeOpt.value = 'globe';
  globeOpt.textContent = '🌐 Globe';
  globeOpt.title = 'Ray-marched relief sphere — preview for a physical globe display';
  projSel.appendChild(globeOpt);
  // `?proj=earth` needs an option to select: assigning a select's value to something with no
  // matching <option> silently leaves it blank, and mode() then read '' as flat — so the escape
  // hatch the comment above promises quietly showed the equirect map instead. Hidden, so the
  // picker still doesn't offer it.
  const earthOpt = document.createElement('option');
  earthOpt.value = 'earth';
  earthOpt.textContent = '🛰 Earth (ray-marched)';
  earthOpt.hidden = true;
  projSel.appendChild(earthOpt);
  const projParam = q.get('proj');
  if (projParam && (projParam === 'globe' || projParam === 'earth' || PROJECTIONS.some((proj) => proj.key === projParam))) {
    projSel.value = projParam;
  } else if (q.has('globe')) {
    projSel.value = 'globe';   // legacy deeplink
  } else {
    projSel.value = 'globe';   // default view
  }
  projSel.addEventListener('change', () => opts.onProjection?.());

  // Share: encode the current UI state as URL params and copy the link.
  const shareBtn = el('button', 'gis-btn');
  shareBtn.textContent = '🔗 Share';
  shareBtn.title = 'Copy a link that reproduces the current view';
  shareBtn.addEventListener('click', () => {
    const p = new URLSearchParams();
    if (layerSel.value !== LAYERS[0].key) { p.set('layer', layerSel.value); }
    if (overSel.value) { p.set('over', overSel.value); }
    if (speciesSel.value !== OBIS_SPECIES[0].taxon) { p.set('species', speciesSel.value); }
    if (tracksSel.value) { p.set('tracks', tracksSel.value); }
    if (drawValue !== 'off') { p.set('draw', drawValue); }
    const ring = opts.drawnRing();
    if (ring) { p.set('shape', ring); }
    if (viewSel.value !== 'abs') { p.set('view', viewSel.value); }
    if (dyrSel.value !== '1') { p.set('dyr', dyrSel.value); }
    if (projSel.value !== 'globe') { p.set('proj', projSel.value); }
    if (projSel.value === 'earth') { opts.earthCam().forEach(([k, v]) => p.set(k, v)); }
    if (spinOn) { p.set('spin', ''); }
    if (iso.box.checked) { p.set('iso', ''); }
    if (curOv.box.checked) { p.set('currents', ''); }
    if (wndOv.box.checked) { p.set('wind', ''); }
    if (rdrOv.box.checked) { p.set('radar', ''); }
    if (stmOv.box.checked) { p.set('storms', ''); }
    if (fireOvChk.box.checked) { p.set('fire', ''); }
    // Default-ON overlays serialize their OFF state, so a shared link reproduces a deliberately
    // cleared map instead of quietly turning the borders back on at the other end.
    if (!bordersChk.box.checked) { p.set('borders', '0'); }
    if (!citiesChk.box.checked) { p.set('cities', '0'); }
    if (sunChk.box.checked) { p.set('sun', ''); }
    if (ensoChk.box.checked) { p.set('enso', ''); }
    if (opts.getStride() !== DEFAULT_STRIDE) { p.set('res', String(opts.getStride())); }
    // The color scale is part of what a shared map MEANS, not a local preference: the same colors
    // stand for different numbers once the range moves.
    const sr = opts.sharedScale();
    if (sr.range) { p.set('vmin', String(sr.range.min)); p.set('vmax', String(sr.range.max)); }
    if (sr.levels) { p.set('bands', String(sr.levels)); }
    if (sr.colormap) { p.set('cmap', sr.colormap); }
    if (cmpDate.value) { p.set('cmp', cmpDate.value); }
    if (seasonSel.value) { p.set('season', seasonSel.value); }
    if (stepSel.value !== String(DEFAULT_STEP_MONTHS)) { p.set('step', stepSel.value); }
    if (sampSel.value !== 'snapshot') { p.set('agg', sampSel.value); }
    const vw = opts.getView();
    if (vw.z > 1.001) {
      p.set('z', vw.z.toFixed(2));
      p.set('cx', vw.cx.toFixed(4));
      p.set('cy', vw.cy.toFixed(4));
    }
    if (speed.value !== '0.7') { p.set('speed', speed.value); }
    if (alphaSl.value !== '0.8') { p.set('alpha', alphaSl.value); }
    if (sunChk.box.checked && sunHr.value !== '12') { p.set('sunh', sunHr.value); }
    if (!unitF) { p.set('unit', 'c'); }
    if (playing) { p.set('play', ''); }
    if (dateLbl.textContent && dateLbl.textContent !== '—' && !dateLbl.textContent.includes('–')) { p.set('date', dateLbl.textContent); }
    const qs = p.toString().replace(/=(?=&|$)/g, '');
    const url = `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}`;
    void navigator.clipboard.writeText(url).then(() => {
      shareBtn.textContent = '✓ Copied';
      setTimeout(() => { shareBtn.textContent = '🔗 Share'; }, 1500);
    });
  });

  // ── Assembly: a minimal main bar + a labeled ⚙ menu for everything else ─────────────
  // ── Color-scale controls ───────────────────────────────────────────────────────────
  // A layer's shipped range is chosen so the whole world reads at once; a regional question needs
  // a regional range, or the entire signal arrives as one flat color.
  const numIn = (title: string): HTMLInputElement => {
    const i = el('input', 'gis-ctrl');
    i.type = 'number';
    i.title = title;
    css(i, 'width:64px');
    return i;
  };
  const sel = (options: Array<{ value: string; label: string }>, value: string): HTMLSelectElement => {
    const s = el('select', 'gis-ctrl');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      s.appendChild(opt);
    }
    s.value = value;
    return s;
  };
  const scaleMin = numIn('Color-scale minimum, in the layer\'s own units');
  const scaleMax = numIn('Color-scale maximum, in the layer\'s own units');
  const scaleAuto = el('button', 'gis-btn small');
  scaleAuto.textContent = 'fit';
  scaleAuto.title = 'Fit the scale to this frame\'s 2nd–98th percentile — inside the drawn region if there is one';
  const scaleReset = el('button', 'gis-btn small');
  scaleReset.textContent = 'reset';
  scaleReset.title = 'Back to the layer\'s own range';
  const levelSel = sel([
    { value: '0', label: 'smooth' },
    { value: '5', label: '5 bands' },
    { value: '8', label: '8 bands' },
    { value: '10', label: '10 bands' },
    { value: '16', label: '16 bands' },
    // Seeded from the URL so the widgets agree with the map a shared link produced — a banded map
    // under a dropdown reading "smooth" is the kind of small lie that makes a UI untrustworthy.
  ], ['5', '8', '10', '16'].includes(q.get('bands') ?? '') ? q.get('bands') as string : '0');
  levelSel.title = 'Quantize the color scale into discrete bands, so values can be counted rather than estimated';
  const cmapSel = sel([{ value: '', label: 'layer default' },
    ...SST_COLORMAPS.map((c) => ({ value: c.name, label: c.label }))],
  SST_COLORMAPS.some((c) => c.name === q.get('cmap')) ? q.get('cmap') as string : '');
  cmapSel.title = 'Color ramp. Turbo is offered for old links but should be avoided: its lightness '
    + 'is not monotonic, so it invents boundaries the data has not got, and it collapses under '
    + 'red-green color-vision deficiency.';
  const scaleWarn = el('span', 'gis-warn');

  // Season: restrict every read of the stack to some months of the year. Sits next to the view
  // picker because the two compose — "mean over Jun–Aug" is one question, not two controls.
  const seasonSel = sel(SEASONS.map((s) => ({ value: s.key, label: s.label })),
    SEASONS.some((s) => s.key && s.key === q.get('season')) ? q.get('season') as string : '');
  seasonSel.title = 'Use only these months of the year — in the time-lapse, in the mean/min/max/range '
    + 'reductions, and in the charts under a clicked point or drawn area';
  seasonSel.addEventListener('change', () => opts.onSeason(seasonSel.value));

  // Compare: a second date on the other side of a swipe divider.
  const cmpDate = el('input', 'gis-ctrl');
  cmpDate.type = 'date';
  cmpDate.title = 'Show a second date on the left of a divider that follows your cursor — the same '
    + 'projection and color scale, so a small difference is actually judgeable';
  css(cmpDate, 'padding:1px 4px;color-scheme:dark');
  cmpDate.value = q.get('cmp') ?? '';
  const cmpOff = el('button', 'gis-btn small');
  cmpOff.textContent = 'off';
  cmpOff.title = 'Stop comparing';
  const cmpNote = el('span', 'gis-note');
  const applyCompare = (): void => {
    const snapped = opts.onCompare(cmpDate.value);
    // Frames are monthly at best, so the nearest one is rarely the date typed — say which it is
    // rather than letting the divider show a silently different month.
    cmpNote.textContent = cmpDate.value && snapped ? `↔ ${snapped}` : '';
  };
  cmpDate.addEventListener('change', applyCompare);
  cmpOff.addEventListener('click', () => { cmpDate.value = ''; applyCompare(); });

  /** Reflects the live range into the inputs and warns when the encoding starts to posterize. */
  const refreshScale = (): void => {
    const r = opts.currentRange();
    // Enough decimals to be editable at any magnitude, without printing 14 of them for a 0..1 layer.
    const step = Math.abs(r.max - r.min);
    const dp = step >= 100 ? 0 : step >= 10 ? 1 : step >= 1 ? 2 : 3;
    scaleMin.value = r.min.toFixed(dp);
    scaleMax.value = r.max.toFixed(dp);
    const snapped = opts.compareSnapped();
    cmpNote.textContent = cmpDate.value && snapped ? `↔ ${snapped}` : '';
    const bands = opts.scaleBands();
    scaleWarn.textContent = bands < 24 ? `≈${bands} steps — banding` : '';
    scaleWarn.title = bands < 24
      ? `The field is stored as one byte per cell across the layer's full range, so this window `
        + `leaves only about ${bands} distinct values. Widen it, or read exact numbers by clicking the map.`
      : '';
  };
  const applyRange = (): void => {
    const lo = parseFloat(scaleMin.value), hi = parseFloat(scaleMax.value);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      opts.onScaleRange({ min: lo, max: hi });
    }
    refreshScale();
  };
  scaleMin.addEventListener('change', applyRange);
  scaleMax.addEventListener('change', applyRange);
  scaleAuto.addEventListener('click', () => { opts.onScaleAuto(); refreshScale(); });
  scaleReset.addEventListener('click', () => { opts.onScaleRange(null); refreshScale(); });
  levelSel.addEventListener('change', () => opts.onScaleLevels(parseInt(levelSel.value, 10)));
  cmapSel.addEventListener('change', () => {
    opts.onColormap(cmapSel.value ? cmapSel.value as SstColormapName : null);
  });

  const gearBtn = el('button', 'gis-btn icon');
  gearBtn.textContent = '⚙';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.setAttribute('aria-haspopup', 'true');
  gearBtn.title = 'Settings — playback, analysis, overlays, day/night';
  // Lives in the gear menu rather than the bar: it belongs to whoever is going to take the data
  // away, which is a minority of visits, and the bar already wraps on a narrow window.
  const reproBtn = el('button', 'gis-btn');
  reproBtn.textContent = '⤓ request, snippets, citation';
  reproBtn.title = 'The exact ERDDAP request behind this frame — NetCDF/CSV download, xarray and R '
    + 'snippets, and a citation with the access date';
  reproBtn.addEventListener('click', () => opts.onReproduce());
  const importBtn = el('button', 'gis-btn');
  importBtn.textContent = '⤒ region or stations';
  importBtn.title = 'Import a GeoJSON study area as the analysis region, or a CSV of stations to '
    + 'collocate against this layer (you can also drop the file anywhere on the map)';
  importBtn.addEventListener('click', () => opts.onImport());
  // Four titled sections laid out as columns that wrap: on a desktop the menu is two or four
  // abreast and a third the height of the old single list; on a phone they stack into a bottom
  // sheet. Twenty flat rows had stopped being scannable — "where is opacity?" should not need
  // reading every label. Open/closed is the inline display, toggled below.
  const menu = el('div', 'gis-panel gis-menu');
  menu.style.display = 'none';
  const row = (label: string, ...els: (HTMLElement | Text)[]): HTMLDivElement => {
    const r = el('div', 'gis-menu-row');
    const l = el('span', 'gis-menu-label');
    l.textContent = label;
    r.append(l, ...els);
    return r;
  };
  const section = (title: string, ...rows: HTMLElement[]): HTMLDivElement => {
    const s = el('div', 'gis-menu-section');
    const h = document.createElement('h3');
    h.textContent = title;
    s.append(h, ...rows);
    return s;
  };
  const dataSection = section('data',
    row('export', reproBtn),
    row('import', importBtn),
  );
  menu.append(
    section('time',
      row('speed', speed),
      row('cadence', stepSel, sampSel),
      row('go to day', datePick),
      row('compare', cmpDate, cmpOff, cmpNote),
    ),
    section('field',
      row('view', viewSel, dyrSel, seasonSel),
      row('style', iso.wrap, unitBtn),
      row('scale', scaleMin, scaleMax, scaleAuto, scaleReset, scaleWarn),
      row('colors', cmapSel, levelSel),
      row('resolution', resSel),
      row('opacity', alphaSl),
    ),
    section('layers',
      row('flow', curOv.wrap, wndOv.wrap, rdrOv.wrap),
      row('hazards', stmOv.wrap, fireOvChk.wrap),
      row('reference', bordersChk.wrap, citiesChk.wrap),
      row('day/night', sunChk.wrap, sunHr),
      row('climate', ensoChk.wrap),
      row('species', speciesSel),
      row('tracks', tracksSel),
    ),
    dataSection,
  );
  gearBtn.addEventListener('click', () => {
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    searchPanel.style.display = 'none';   // the two share the slot under the bar
    syncChips();
  });
  if (q.has('menu')) {
    menu.style.display = 'flex';   // dev/deeplink convenience: open the menu on load
  }
  // ── Place search ────────────────────────────────────────────────────────────────────
  // Natural Earth's 1:10M populated-places set (~7,300 cities, the same file the city labels draw
  // from, so it is often cached already) searched in-page: no geocoding service, no key, works
  // offline once fetched. A pasted "lat, lon" goes straight to the map.
  const searchBtn = el('button', 'gis-btn icon');
  searchBtn.textContent = '🔍';
  searchBtn.title = 'Go to a place — city name or "lat, lon" (/)';
  searchBtn.setAttribute('aria-label', 'Search places');
  const searchPanel = el('div', 'gis-panel gis-search');
  searchPanel.style.display = 'none';
  const searchInput = el('input', 'gis-ctrl');
  searchInput.type = 'search';
  searchInput.placeholder = 'City, or  21.3, -157.9';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', 'Place name or coordinates');
  const searchList = el('div', 'gis-search-list');
  const searchHint = el('div', 'gis-search-hint');
  searchPanel.append(searchInput, searchList, searchHint);

  interface SearchHit { label: string; detail: string; lon: number; lat: number; zoom: number }
  let placeIndex: { place: Place; name: string; words: string[]; country: string }[] | null = null;
  let placeLoad: Promise<void> | null = null;
  const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const ensurePlaces = (): Promise<void> => {
    if (!placeLoad) {
      searchHint.textContent = 'Loading places…';
      // 1:10M is the complete set; fall back a rung rather than offer nothing if it fails.
      placeLoad = loadPlaces('10m').catch(() => loadPlaces('50m')).then((ps) => {
        placeIndex = ps.map((place) => {
          const name = fold(place.name);
          return { place, name, words: name.split(/[\s-]+/), country: fold(place.country) };
        });
        searchHint.textContent = '';
      }).catch(() => {
        searchHint.textContent = 'Place list unavailable — coordinates still work';
      });
    }
    return placeLoad;
  };
  /** "21.3, -157.9", "21.3 N 157.9 W", "21.3°S, 43.2°E" → a hit, or null when it is not a pair. */
  const parseCoords = (text: string): SearchHit | null => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/.exec(text);
    if (!m) {
      return null;
    }
    let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
    if (m[2] && m[2].toUpperCase() === 'S') { lat = -Math.abs(lat); }
    if (m[4] && m[4].toUpperCase() === 'W') { lon = -Math.abs(lon); }
    if (!m[2] && !m[4] && Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
      [lat, lon] = [lon, lat];   // the only reading that is on the planet is lon-first
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return null;
    }
    return { label: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, detail: 'coordinates', lon, lat, zoom: 48 };
  };
  const searchHits = (text: string): SearchHit[] => {
    const coords = parseCoords(text);
    if (coords) {
      return [coords];
    }
    const query = fold(text.trim());
    if (!query || !placeIndex) {
      return [];
    }
    const scored: { score: number; e: typeof placeIndex[number] }[] = [];
    for (const e of placeIndex) {
      let score: number;
      if (e.name.startsWith(query)) {
        score = 0;
      } else if (e.words.some((w) => w.startsWith(query))) {
        score = 1;
      } else if (e.name.includes(query)) {
        score = 2;
      } else if (query.length >= 3 && e.country.startsWith(query)) {
        score = 3;   // "japan" lists Japan's cities, biggest first
      } else {
        continue;
      }
      scored.push({ score, e });
    }
    // Within a match grade, Natural Earth's own prominence order (the index is pre-sorted by it).
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 8).map(({ e }) => {
      const p = e.place;
      const pop = formatPopulation(p.population);
      return {
        label: p.name,
        detail: `${p.country}${pop ? ` · ${pop}` : ''}${p.capital ? ' · capital' : ''}`,
        lon: p.lon, lat: p.lat,
        // A capital or a metropolis is a region; a small town is a dot. Zoom 1 = the world across
        // the viewport, so 32 ≈ 11° wide and 64 ≈ 5.6° — deep enough to place the town, not so deep
        // that a 1° climate grid is six blocks across the screen.
        zoom: p.capital || (p.population ?? 0) >= 2e6 ? 32 : 64,
      };
    });
  };
  let hits: SearchHit[] = [];
  let hitSel = 0;
  const closeSearch = (): void => {
    searchPanel.style.display = 'none';
    searchInput.blur();
    syncChips();
  };
  const goTo = (h: SearchHit): void => {
    opts.onFlyTo(h.lon, h.lat, h.zoom);
    closeSearch();
  };
  const renderHits = (): void => {
    searchList.replaceChildren();
    hitSel = Math.max(0, Math.min(hitSel, hits.length - 1));
    hits.forEach((h, i) => {
      const row = el('div', 'gis-search-hit');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === hitSel));
      const name = document.createElement('span');
      name.textContent = h.label;
      const detail = document.createElement('span');
      detail.textContent = h.detail;
      row.append(name, detail);
      row.addEventListener('pointerenter', () => { hitSel = i; renderHits(); });
      // pointerdown, not click: the input blurs on mousedown, and a blur-closes-panel rule would
      // otherwise remove the row before its click arrived.
      row.addEventListener('pointerdown', (e) => { e.preventDefault(); goTo(h); });
      searchList.appendChild(row);
    });
    if (hits.length === 0 && searchInput.value.trim() && placeIndex) {
      searchHint.textContent = 'No match — try a larger nearby city, or paste coordinates';
    } else if (placeIndex) {
      searchHint.textContent = hits.length ? '↑↓ choose · Enter go · Esc close' : 'Type a city, or "lat, lon"';
    }
  };
  const runSearch = (): void => {
    hits = searchHits(searchInput.value);
    renderHits();
  };
  const openSearch = (): void => {
    searchPanel.style.display = 'flex';
    menu.style.display = 'none';
    syncChips();
    searchInput.focus();
    searchInput.select();
    void ensurePlaces().then(runSearch);
    runSearch();
  };
  searchBtn.addEventListener('click', () => {
    if (searchPanel.style.display === 'none') { openSearch(); } else { closeSearch(); }
  });
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hitSel++; renderHits(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hitSel--; renderHits(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hits[hitSel]) { goTo(hits[hitSel]); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });
  // Click-away closes it; the panel's own rows take pointerdown first (see renderHits).
  window.addEventListener('pointerdown', (e) => {
    if (searchPanel.style.display !== 'none' && !searchPanel.contains(e.target as Node) && e.target !== searchBtn) {
      closeSearch();
    }
  });

  // ── Active-overlay chips ────────────────────────────────────────────────────────────
  // Everything the gear menu can switch on is otherwise invisible as STATE: a radar echo over the
  // Pacific looks like data until you remember you turned radar on. One chip per active toggle,
  // under the bar, each with its own ×. Reference lines/labels are deliberately absent — they are
  // on by default and read as the map, not as something added to it.
  const chips = el('div', 'gis-chips');
  interface ChipSource { label: () => string; color: string; active: () => boolean; off: () => void; note?: string }
  const boxChip = (c: { wrap: HTMLLabelElement; box: HTMLInputElement }, label: string, color: string, note?: string): ChipSource => ({
    label: () => label, color, note,
    active: () => c.box.checked,
    off: () => { c.box.checked = false; c.box.dispatchEvent(new Event('change')); },
  });
  const chipSources: ChipSource[] = [
    {
      label: () => `⎯ ${overSel.selectedOptions[0]?.textContent ?? ''}`, color: '#dfeef0',
      active: () => overSel.value !== '',
      off: () => { overSel.value = ''; opts.onOverlayLayer(''); },
    },
    boxChip(curOv, 'currents', '#7fe3ff'),
    boxChip(wndOv, 'wind', '#b9c6ff'),
    boxChip(rdrOv, 'radar', '#8ef78e'),
    // The one overlay that ignores the time slider says so where it can be seen, not in a tooltip.
    boxChip(stmOv, 'storms', '#ff5f3b', 'latest advisory'),
    boxChip(fireOvChk, 'fire', '#ff6a2a', 'last 24 h'),
    {
      label: () => `tracks: ${tracksSel.selectedOptions[0]?.textContent ?? ''}`, color: '#f7a8ff',
      active: () => tracksSel.value !== '',
      off: () => { tracksSel.value = ''; opts.onTracks(''); },
    },
    boxChip(sunChk, 'day/night', '#ffd75e'),
    boxChip(ensoChk, 'ENSO', '#ffd166'),
  ];
  const refreshChips = (): void => {
    chips.replaceChildren();
    for (const src of chipSources) {
      if (!src.active()) {
        continue;
      }
      const chip = el('button', 'gis-chip');
      chip.type = 'button';
      chip.title = `Turn off ${src.label()}`;
      chip.setAttribute('aria-label', `Turn off ${src.label()}`);
      const dot = el('span', 'dot');
      dot.style.background = src.color;
      const text = document.createElement('span');
      text.textContent = src.label();
      chip.append(dot, text);
      if (src.note) {
        const note = el('span', 'gis-muted');
        note.textContent = `· ${src.note}`;
        chip.appendChild(note);
      }
      const x = el('span', 'x');
      x.textContent = '×';
      chip.appendChild(x);
      chip.addEventListener('click', () => { src.off(); refreshChips(); });
      chips.appendChild(chip);
    }
  };
  /** The chips sit in the slot the gear menu and search panel drop into; they yield while one is open. */
  const syncChips = (): void => {
    chips.style.visibility = menu.style.display !== 'none' || searchPanel.style.display !== 'none' ? 'hidden' : 'visible';
  };
  for (const c of [curOv, wndOv, rdrOv, stmOv, fireOvChk, sunChk, ensoChk]) {
    c.box.addEventListener('change', refreshChips);
  }
  overSel.addEventListener('change', refreshChips);
  tracksSel.addEventListener('change', refreshChips);

  // ── Keyboard help ───────────────────────────────────────────────────────────────────
  const help = el('div', 'gis-panel gis-help');
  help.style.display = 'none';
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  const helpRows: [string, string][] = [
    ['Space', 'play / pause'],
    ['← →', 'previous / next frame'],
    ['Shift ← →', 'a year back / forward'],
    ['Home End', 'first / last frame'],
    ['/', 'go to a place or coordinates'],
    ['I', 'what this layer means'],
    ['Enter Esc', 'finish / clear a drawn line or area'],
    ['Drag · wheel', 'pan or rotate · zoom'],
    ['Double-click', 'zoom in on a point'],
    ['?', 'this list'],
  ];
  const helpTitle = document.createElement('h3');
  helpTitle.textContent = 'Keyboard';
  const helpClose = el('button', 'gis-link x');
  helpClose.textContent = '×';
  helpClose.setAttribute('aria-label', 'Close');
  helpTitle.appendChild(helpClose);
  const helpTable = el('div', 'gis-help-table');
  for (const [keys, what] of helpRows) {
    const k = document.createElement('kbd');
    k.textContent = keys;
    const w = document.createElement('span');
    w.textContent = what;
    helpTable.append(k, w);
  }
  help.append(helpTitle, helpTable);
  const toggleHelp = (): void => {
    help.style.display = help.style.display === 'none' ? 'block' : 'none';
  };
  helpClose.addEventListener('click', toggleHelp);
  // Capture phase, so an Esc that closes this never also reaches the draw tool's clear-shape rule.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && help.style.display !== 'none') {
      e.stopImmediatePropagation();
      toggleHelp();
    }
  }, true);
  const helpBtn = el('button', 'gis-btn');
  helpBtn.textContent = '⌨ shortcuts';
  helpBtn.title = 'Keyboard shortcuts (?)';
  helpBtn.addEventListener('click', () => { menu.style.display = 'none'; syncChips(); toggleHelp(); });
  dataSection.appendChild(row('keys', helpBtn));

  bar.append(playBtn, dateLbl, scrub, layerSel, overSel, drawSeg, projSel, searchBtn, gearBtn);
  if (opts.analysisButton) {
    bar.append(opts.analysisButton);
  }
  bar.append(shareBtn);
  // Browser session-restore likes to resurrect form state over our URL-derived defaults (a
  // restored tab came back with sun/layer flipped) — opt every control out of autofill.
  for (const el of [...bar.querySelectorAll('input, select'), ...menu.querySelectorAll('input, select')]) {
    (el as HTMLInputElement | HTMLSelectElement).autocomplete = 'off';
  }
  if (!noGui) {
    document.body.append(bar, menu, searchPanel, chips, help, scrubTip, scrubTicks);
    refreshChips();
  }
  // Phone layout scrolls the bar sideways (see the page's <style>); flag "more to the right" so
  // the stylesheet can fade the trailing edge only while that is true.
  const syncBarOverflow = (): void => {
    bar.dataset.more = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2 ? '1' : '';
  };
  bar.addEventListener('scroll', syncBarOverflow, { passive: true });
  new ResizeObserver(syncBarOverflow).observe(bar);

  // Legend colorbar (+ per-frame global stats line, + the ⓘ that explains what the numbers mean).
  const legend = el('div', 'gis-panel gis-legend');
  const titleRow = el('div', 'gis-legend-title');
  const title = document.createElement('div');
  const infoBtn = el('button', 'gis-link');
  infoBtn.textContent = 'ⓘ';
  infoBtn.setAttribute('aria-label', 'About this layer');
  infoBtn.title = 'What this data means, how to read the scale, and what it correlates with (I)';
  infoBtn.addEventListener('click', () => opts.onInfo());
  titleRow.append(title, infoBtn);
  const swatch = el('div', 'gis-swatch');
  const ticks = el('div', 'gis-ticks');
  const lo = document.createElement('span'), mid = document.createElement('span'), hi = document.createElement('span');
  ticks.append(lo, mid, hi);
  const statsLine = el('div', 'gis-legend-stats');
  // Derivation caveats for an analysis result — which climatology, which significance filter. A map
  // that has silently dropped its insignificant cells looks exactly like one that never had any, so
  // this sits under the colorbar rather than behind the ⓘ.
  const noteLine = el('div', 'gis-legend-note');
  let scaleHidden = false;   // imagery layer active: suppress the colorbar, keep the title + ⓘ
  // Overlay legend: its own gradient strip, marked as line work so it is not mistaken for the fill.
  const overRow = el('div', 'gis-legend-over');
  const overTitle = document.createElement('div');
  const overSwatch = el('div', 'gis-swatch thin');
  const overTicks = el('div', 'gis-ticks');
  overTicks.style.opacity = '0.8';
  const overLo = document.createElement('span'), overHi = document.createElement('span');
  overTicks.append(overLo, overHi);
  overRow.append(overTitle, overSwatch, overTicks);
  legend.append(titleRow, swatch, ticks, statsLine, noteLine, overRow);
  // `I` opens the same overlay from the keyboard (skipped while typing in a field).
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey && !(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'))) {
      e.preventDefault();
      opts.onInfo();
    }
  });
  if (!noGui) {
    document.body.appendChild(legend);
  }

  return {
    playing: () => playing,
    interval: () => parseFloat(speed.value),
    sunHour: () => parseFloat(sunHr.value),
    contours: () => iso.box.checked,
    mode: () => (projSel.value === 'globe' ? 'globe' : projSel.value === 'earth' ? 'earth' : 'flat'),
    projection: () => (projSel.value === 'globe' ? 'map' : projSel.value as ProjectionKey),
    spin: () => spinOn,
    scrubbing: () => scrubbing,
    overlay: (k) => {
      const boxes: Record<OverlayKey, HTMLInputElement> = {
        currents: curOv.box, wind: wndOv.box, radar: rdrOv.box, storms: stmOv.box,
        fire: fireOvChk.box, borders: bordersChk.box, cities: citiesChk.box,
      };
      return boxes[k].checked;
    },
    enso: () => ensoChk.box.checked,
    sun: () => sunChk.box.checked,
    dataAlpha: () => parseFloat(alphaSl.value),
    setPlaying: (v) => { playing = v; paintPlay(); },
    setDate: (date) => { dateLbl.textContent = date; },
    setTimeline: (count, index) => {
      if (scrubbing) { return; }
      scrub.max = String(Math.max(0, count - 1));
      scrub.value = String(index);
      scrub.disabled = count < 2;
      rebuildTicks(count);
    },
    setDateBounds: (minISO, maxISO) => { datePick.min = minISO; datePick.max = maxISO; if (!datePick.value) { datePick.value = maxISO; } },
    setLegend: (l) => {
      // A layer with no value scale (imagery) keeps the title row so its ⓘ stays reachable — only
      // the colorbar itself, its ticks and the stats line drop out.
      title.textContent = l.title;
      // Any legend change drops the caveat: it belongs to the result that set it, and a stale
      // "showing only cells with p ≤ 0.05" over an ordinary layer would be a lie. The analysis path
      // re-sets it immediately after.
      noteLine.textContent = '';
      noteLine.style.display = 'none';
      const scaleDisplay = l.hidden ? 'none' : 'block';
      swatch.style.display = scaleDisplay;
      ticks.style.display = l.hidden ? 'none' : 'flex';
      scaleHidden = Boolean(l.hidden);
      statsLine.style.display = scaleHidden || !statsLine.textContent ? 'none' : 'block';
      swatch.style.background = sstColormapCssGradient(l.colormap);
      const at = (t: number): number => (l.isLog ? Math.pow(10, Math.log10(l.min) + t * (Math.log10(l.max) - Math.log10(l.min))) : l.min + t * (l.max - l.min));
      lo.textContent = l.hidden ? '' : l.fmt(at(0));
      mid.textContent = l.hidden ? '' : l.fmt(at(0.5));
      hi.textContent = l.hidden ? '' : l.fmt(at(1));
    },
    legendTicks: () => ({ lo: lo.textContent ?? '', mid: mid.textContent ?? '', hi: hi.textContent ?? '' }),
    setLayer: (key) => { layerSel.value = key; },
    setOverlayLegend: (l) => {
      overRow.style.display = l ? 'block' : 'none';
      if (!l) {
        return;
      }
      overTitle.textContent = `⎯ ${l.title}${l.hatchNote ? ` · hatched ${l.hatchNote}` : ''}`;
      overSwatch.style.background = sstColormapCssGradient(l.colormap);
      const at = (t: number): number => (l.isLog ? Math.pow(10, Math.log10(l.min) + t * (Math.log10(l.max) - Math.log10(l.min))) : l.min + t * (l.max - l.min));
      overLo.textContent = l.fmt(at(0));
      overHi.textContent = l.fmt(at(1));
    },
    setOverlayLayer: (key) => { overSel.value = key; refreshChips(); },
    setDrawMode: (mode) => { drawValue = drawBtns.has(mode) ? mode : 'off'; paintDraw(); },
    setStats: (text) => { statsLine.textContent = text; statsLine.style.display = text && !scaleHidden ? 'block' : 'none'; },
    resetScaleControls: () => { levelSel.value = '0'; cmapSel.value = ''; refreshScale(); },
    refreshScaleControls: () => refreshScale(),
    setNote: (text) => { noteLine.textContent = text ?? ''; noteLine.style.display = text ? 'block' : 'none'; },
    setView: (v) => { viewSel.value = v; },
    setViewEnabled: (enabled) => { viewSel.disabled = !enabled; },
  };
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:red;padding:1rem">${(err as Error).stack ?? err}</pre>`;
  console.error(err);
});
