/**
 * Built-in analysis graphs (TODO/geo-analysis-graph.md §9) — curated, runnable example
 * programs that ship with the explorer. They serve three audiences at once: users get
 * one-click interesting results, the graph editor gets teaching examples of each language
 * concept (temporal vs spatial correlation, series lag, composites), and the test suite
 * validates every one of them against the real language so they can never rot.
 *
 * Layer keys and date floors assume the explorer's standard catalog (sst, anom, ice, waves,
 * chl, wind, … — see ANALYSIS_META in the sample); the engine itself doesn't check keys, the
 * FieldStore does at run time.
 *
 * @category Analysis
 */

import type { AnalysisProgram } from './ast.js';

/** @category Analysis */
export interface BuiltinAnalysis {
  name: string;
  /** What it shows and which language concept it demonstrates (dropdown tooltip). */
  description: string;
  program: AnalysisProgram;
}

/** @category Analysis */
export const BUILTIN_ANALYSES: BuiltinAnalysis[] = [
  {
    name: 'SST × wind coupling',
    description: 'TEMPORAL correlation: at each ocean cell, does sea-surface temperature rise '
      + 'and fall with wind speed over time? Mostly negative in the tropics — stronger wind '
      + 'cools the surface by evaporation and mixing.',
    program: { nodes: [
      { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2023-01', stepMonths: 2 } },
      { id: 'wind', op: 'layer', params: { layer: 'wind', component: 'speed', start: '2023-01', stepMonths: 2 } },
      { id: 'r', op: 'correlate', inputs: { a: 'sst', b: 'wind' }, params: { mode: 'temporal' } },
      { id: 'map', op: 'display', inputs: { value: 'r' }, params: { title: 'r · SST × wind speed' } },
      { id: 'dots', op: 'scatter', inputs: { a: 'sst', b: 'wind' }, params: { title: 'SST vs wind speed · one dot per cell' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'per-cell r: SST vs wind speed' } },
    ] },
  },
  {
    name: 'Wind makes waves',
    description: 'TEMPORAL correlation, the positive counterpart: wave height tracks wind '
      + 'speed almost everywhere. Compare this map with "SST × wind coupling" — same program '
      + 'shape, opposite physics.',
    program: { nodes: [
      { id: 'waves', op: 'layer', params: { layer: 'waves', start: '2023-01', stepMonths: 2 } },
      { id: 'wind', op: 'layer', params: { layer: 'wind', component: 'speed', start: '2023-01', stepMonths: 2 } },
      { id: 'r', op: 'correlate', inputs: { a: 'waves', b: 'wind' }, params: { mode: 'temporal' } },
      { id: 'map', op: 'display', inputs: { value: 'r' }, params: { title: 'r · wave height × wind speed' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'per-cell r: wave height vs wind speed' } },
    ] },
  },
  {
    name: 'El Niño − La Niña pattern',
    description: 'COMPOSITE difference: average the SST anomaly over El Niño months and La '
      + 'Niña months separately, then subtract — the classic equatorial-Pacific ENSO dipole '
      + 'emerges. Demonstrates selectFrames(phase) + math(sub).',
    program: { nodes: [
      { id: 'anom', op: 'layer', params: { layer: 'anom', start: '2016-01', stepMonths: 1 } },
      { id: 'oni', op: 'enso' },
      { id: 'nino', op: 'selectFrames', inputs: { value: 'anom', oni: 'oni' }, params: { phase: 'elnino' } },
      { id: 'nina', op: 'selectFrames', inputs: { value: 'anom', oni: 'oni' }, params: { phase: 'lanina' } },
      { id: 'ninoMean', op: 'timeReduce', inputs: { value: 'nino' }, params: { stat: 'mean' } },
      { id: 'ninaMean', op: 'timeReduce', inputs: { value: 'nina' }, params: { stat: 'mean' } },
      { id: 'diff', op: 'math', inputs: { a: 'ninoMean', b: 'ninaMean' }, params: { fn: 'sub' } },
      { id: 'map', op: 'display', inputs: { value: 'diff' }, params: { title: 'SST anomaly · El Niño − La Niña' } },
      { id: 'dist', op: 'histogram', inputs: { value: 'diff' }, params: { title: 'How the difference is distributed' } },
      { id: 'ans', op: 'answer', inputs: { value: 'diff' }, params: { label: 'El Niño − La Niña anomaly difference' } },
    ] },
  },
  {
    name: 'El Niño winter outlook · rainfall',
    description: 'TELECONNECTION OUTLOOK: the on-device forecast of Niño 3.4 drives a per-cell '
      + 'regression of Dec–Feb rainfall (percent of the 1991–2020 normal, GPCP 1981→) on the ONI, '
      + 'fitted over ~45 winters. Cells are shown only where the relationship beat climatology in '
      + 'cross-validation, and stippled where the predicted departure is not distinguishable from '
      + 'zero. The forecast index is the mean of the forecast\'s last three months — a statistical '
      + 'outlook, not a weather forecast. The forecaster sees only SST, so beyond ~3 months it damps a '
      + 'growing event toward zero; to use an official Niño 3.4 outlook instead, disconnect `at` and '
      + 'set the at param. Demonstrates timeReduce(per: run) → forecast → areaMean → regress(predict).',
    program: { nodes: [
      { id: 'pr', op: 'layer', params: { layer: 'precipmon', start: '1981-09', stepMonths: 1 } },
      { id: 'djf', op: 'selectFrames', inputs: { value: 'pr' }, params: { months: '12,1,2' } },
      { id: 'winter', op: 'timeReduce', inputs: { value: 'djf' }, params: { stat: 'mean', per: 'run' } },
      { id: 'pct', op: 'anomaly', inputs: { value: 'winter' }, params: { climatology: 'monthly', baselineStart: '1991-01', baselineEnd: '2020-12', as: 'percent' } },
      { id: 'oni', op: 'enso' },
      { id: 'fc', op: 'forecast', params: { layer: 'anom', months: 6 } },
      { id: 'n34', op: 'region', params: { preset: 'nino34' } },
      { id: 'fcIdx', op: 'areaMean', inputs: { value: 'fc', region: 'n34' } },
      { id: 'out', op: 'regress', inputs: { value: 'pct', predictor: 'oni', at: 'fcIdx' }, params: { output: 'predict', atFrom: 'last3', minSkill: 0 } },
      { id: 'map', op: 'display', inputs: { value: 'out' }, params: { title: 'Dec–Feb rainfall outlook · % of normal', min: -60, max: 60, stipple: 0.05 } },
      { id: 'idx', op: 'chart', inputs: { a: 'oni', b: 'fcIdx' }, params: { title: 'ONI history and the Niño 3.4 forecast driving the outlook' } },
      { id: 'ans', op: 'answer', inputs: { value: 'out' }, params: { label: 'predicted Dec–Feb rainfall, % of normal' } },
    ] },
  },
  {
    name: 'El Niño winter outlook · land temperature',
    description: 'The temperature half of the outlook: Dec–Feb land air-temperature anomaly '
      + '(GHCN-CAMS, 1981→) regressed on the ONI and evaluated at the forecast Niño 3.4 — the warm '
      + 'Canada / northern-US signal of an El Niño winter, shown only where it has cross-validated '
      + 'skill. Same forecast-damping caveat as the rainfall outlook. Demonstrates regress(predict) on '
      + 'an already-anomalous layer.',
    program: { nodes: [
      { id: 't', op: 'layer', params: { layer: 'landanom', start: '1981-09', stepMonths: 1 } },
      { id: 'djf', op: 'selectFrames', inputs: { value: 't' }, params: { months: '12,1,2' } },
      { id: 'winter', op: 'timeReduce', inputs: { value: 'djf' }, params: { stat: 'mean', per: 'run' } },
      { id: 'oni', op: 'enso' },
      { id: 'fc', op: 'forecast', params: { layer: 'anom', months: 6 } },
      { id: 'n34', op: 'region', params: { preset: 'nino34' } },
      { id: 'fcIdx', op: 'areaMean', inputs: { value: 'fc', region: 'n34' } },
      { id: 'out', op: 'regress', inputs: { value: 'winter', predictor: 'oni', at: 'fcIdx' }, params: { output: 'predict', atFrom: 'last3', minSkill: 0 } },
      { id: 'map', op: 'display', inputs: { value: 'out' }, params: { title: 'Dec–Feb land temperature outlook · anomaly', min: -3, max: 3, stipple: 0.05 } },
      { id: 'ans', op: 'answer', inputs: { value: 'out' }, params: { label: 'predicted Dec–Feb land temperature anomaly' } },
    ] },
  },
  {
    name: 'Where ENSO predicts winter rain · skill',
    description: 'How far to trust the outlook: the cross-validated percent of Dec–Feb rainfall '
      + 'variance of the Dec–Feb MEAN the ONI explains, per cell. Each winter is predicted from a fit that never saw it '
      + '(12-month hold-out), so this is out-of-sample skill; ≤ 0 means the ONI does no better than '
      + 'the long-term normal. Demonstrates regress(skill).',
    program: { nodes: [
      { id: 'pr', op: 'layer', params: { layer: 'precipmon', start: '1981-09', stepMonths: 1 } },
      { id: 'djf', op: 'selectFrames', inputs: { value: 'pr' }, params: { months: '12,1,2' } },
      { id: 'winter', op: 'timeReduce', inputs: { value: 'djf' }, params: { stat: 'mean', per: 'run' } },
      { id: 'pct', op: 'anomaly', inputs: { value: 'winter' }, params: { climatology: 'monthly', baselineStart: '1991-01', baselineEnd: '2020-12', as: 'percent' } },
      { id: 'oni', op: 'enso' },
      { id: 'skill', op: 'regress', inputs: { value: 'pct', predictor: 'oni' }, params: { output: 'skill' } },
      { id: 'map', op: 'display', inputs: { value: 'skill' }, params: { title: 'ENSO → Dec–Feb rainfall · cross-validated skill (%)', colormap: 'viridis', min: 0, max: 50 } },
      { id: 'ans', op: 'answer', inputs: { value: 'skill' }, params: { label: 'cross-validated skill of ONI for Dec–Feb rainfall' } },
    ] },
  },
  {
    name: 'ENSO propagation · Hovmöller',
    description: 'HOVMÖLLER diagram: the equatorial-band SST anomaly, longitude × time. El '
      + 'Niño warm pools appear as red streaks drifting along the equatorial Pacific — '
      + 'propagation a map can only show one month at a time. Demonstrates hovmoller + region.',
    program: { nodes: [
      { id: 'anom', op: 'layer', params: { layer: 'anom', start: '2016-01', stepMonths: 1 } },
      { id: 'eq', op: 'region', params: { lonMin: -180, latMin: -5, lonMax: 180, latMax: 5 } },
      { id: 'hv', op: 'hovmoller', inputs: { value: 'anom', region: 'eq' }, params: { axis: 'lon', title: 'SST anomaly · equatorial band (±5°)' } },
      { id: 'series', op: 'areaMean', inputs: { value: 'anom', region: 'eq' } },
      { id: 'ans', op: 'answer', inputs: { value: 'series' }, params: { label: 'equatorial-band mean SST anomaly' } },
    ] },
  },
  {
    name: 'ENSO vs global warmth · scatter',
    description: 'TEMPORAL scatter: each dot is one month — the ONI on x, the global-mean '
      + 'SST anomaly on y — with the least-squares fit. The cloud shows what the correlation '
      + 'number compresses. Demonstrates scatter over two series.',
    program: { nodes: [
      { id: 'anom', op: 'layer', params: { layer: 'anom', start: '2016-01', stepMonths: 1 } },
      { id: 'warm', op: 'areaMean', inputs: { value: 'anom' } },
      { id: 'oni', op: 'enso' },
      { id: 'dots', op: 'scatter', inputs: { a: 'oni', b: 'warm' }, params: { title: 'ONI (x) vs global SST anomaly (y) · monthly' } },
      { id: 'r', op: 'correlateSeries', inputs: { a: 'warm', b: 'oni' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'r: global anomaly vs ONI, same month' } },
    ] },
  },
  {
    name: 'Seasons march · Hovmöller (lat)',
    description: 'LATITUDE × time Hovmöller: zonal-mean SST, one row per month — the warm '
      + 'band swings north and south with the seasons like a heartbeat, ten years of it in '
      + 'one image. Demonstrates hovmoller(axis: lat).',
    program: { nodes: [
      { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2016-01', stepMonths: 1 } },
      { id: 'hv', op: 'hovmoller', inputs: { value: 'sst' }, params: { axis: 'lat', title: 'Zonal-mean SST · pole to pole' } },
      { id: 'mean', op: 'areaMean', inputs: { value: 'sst' } },
      { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: 'global-mean SST' } },
    ] },
  },
  {
    name: 'Most unusual seas · pins',
    description: 'EXTREMA markers: the strongest warm and cold SST anomalies of the recent '
      + 'months, pinned on the map with their values (markers stay ≥ 12° apart). '
      + 'Demonstrates annotate(stat: both).',
    program: { nodes: [
      { id: 'anom', op: 'layer', params: { layer: 'anom', start: '2026-01', stepMonths: 1 } },
      { id: 'recent', op: 'timeReduce', inputs: { value: 'anom' }, params: { stat: 'mean' } },
      { id: 'map', op: 'display', inputs: { value: 'recent' }, params: { title: 'SST anomaly · recent mean', colormap: 'balance', min: -5, max: 5 } },
      { id: 'pins', op: 'annotate', inputs: { value: 'recent' }, params: { stat: 'both', count: 3, label: 'strongest anomalies' } },
      { id: 'ans', op: 'answer', inputs: { value: 'recent' }, params: { label: 'recent-months SST anomaly' } },
    ] },
  },
  {
    name: 'Surface currents · arrows',
    description: 'VECTOR arrows: the mean ocean surface circulation, drawn from the baked '
      + 'currents layer\'s u and v components — gyres, the equatorial current system, the '
      + 'western boundary jets. Demonstrates displayVectors over component extractions.',
    program: { nodes: [
      { id: 'u', op: 'layer', params: { layer: 'currents', component: 'u', start: '2024-01', stepMonths: 1 } },
      { id: 'v', op: 'layer', params: { layer: 'currents', component: 'v', start: '2024-01', stepMonths: 1 } },
      { id: 'spd', op: 'layer', params: { layer: 'currents', component: 'speed', start: '2024-01', stepMonths: 1 } },
      { id: 'mean', op: 'timeReduce', inputs: { value: 'spd' }, params: { stat: 'mean' } },
      { id: 'map', op: 'display', inputs: { value: 'mean' }, params: { title: 'Mean current speed', colormap: 'ice' } },
      { id: 'arrows', op: 'displayVectors', inputs: { u: 'u', v: 'v' }, params: { title: 'mean surface currents', strideDeg: 4 } },
      { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: 'mean surface current speed' } },
    ] },
  },
  {
    name: 'ENSO leads global warmth',
    description: 'SERIES correlation with LAG: the global-mean SST anomaly tracks the ONI '
      + 'best a few months AFTER an ENSO peak. Compare r at lag 0 with r when the ONI leads '
      + 'by 4 months. Demonstrates areaMean → correlateSeries(lagMonths).',
    program: { nodes: [
      { id: 'anom', op: 'layer', params: { layer: 'anom', start: '2016-01', stepMonths: 1 } },
      { id: 'globalMean', op: 'areaMean', inputs: { value: 'anom' } },
      { id: 'oni', op: 'enso' },
      { id: 'now', op: 'correlateSeries', inputs: { a: 'globalMean', b: 'oni' } },
      { id: 'lag4', op: 'correlateSeries', inputs: { a: 'globalMean', b: 'oni' }, params: { lagMonths: 4 } },
      { id: 'c', op: 'chart', inputs: { a: 'globalMean', b: 'oni' }, params: { title: 'Global SST anomaly vs ONI' } },
      { id: 'ansNow', op: 'answer', inputs: { value: 'now' }, params: { label: 'r at lag 0 (same month)' } },
      { id: 'ansLag', op: 'answer', inputs: { value: 'lag4' }, params: { label: 'r with the ONI leading by 4 months' } },
    ] },
  },
  {
    name: 'Arctic sea-ice pulse',
    description: 'The Arctic breathes once a year: a time series of area-mean ice '
      + 'concentration, plus a map of each cell\'s seasonal range — the marginal seas swing '
      + 'full-scale while the central pack barely moves. Demonstrates region + areaMean + '
      + 'timeReduce(range).',
    program: { nodes: [
      { id: 'ice', op: 'layer', params: { layer: 'ice', start: '2016-01', stepMonths: 1 } },
      { id: 'arctic', op: 'region', params: { preset: 'arctic' } },
      { id: 'series', op: 'areaMean', inputs: { value: 'ice', region: 'arctic' } },
      { id: 'range', op: 'timeReduce', inputs: { value: 'ice' }, params: { stat: 'range' } },
      { id: 'map', op: 'display', inputs: { value: 'range' }, params: { title: 'Sea-ice seasonal range', colormap: 'ice', min: 0, max: 100 } },
      { id: 'c', op: 'chart', inputs: { a: 'series' }, params: { title: 'Arctic sea-ice concentration · area mean' } },
      { id: 'ans', op: 'answer', inputs: { value: 'series' }, params: { label: 'Arctic mean ice concentration' } },
    ] },
  },
  {
    name: 'SST anomaly · ML outlook',
    description: 'FORECAST: a small neural network running on-device rolls the SST anomaly '
      + 'forward three months from the latest observations. The map scrubs across the '
      + 'predicted months — an outlook, not data. Demonstrates the forecast source op.',
    program: { nodes: [
      { id: 'fc', op: 'forecast', params: { layer: 'anom', months: 3 } },
      { id: 'map', op: 'display', inputs: { value: 'fc' }, params: { title: 'SST anomaly · ML forecast (predicted)', colormap: 'balance', min: -3, max: 3 } },
      { id: 'last', op: 'timeReduce', inputs: { value: 'fc' }, params: { stat: 'mean' } },
      { id: 'pins', op: 'annotate', inputs: { value: 'last' }, params: { stat: 'both', count: 2, label: 'strongest predicted anomalies' } },
      { id: 'mean', op: 'areaMean', inputs: { value: 'fc' } },
      { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: 'global-mean predicted SST anomaly' } },
    ] },
  },
  {
    name: 'Sea-ice extent, measured',
    description: 'The number that gets reported every September. isoline turns the 15 % ice-edge '
      + 'contour — the threshold the whole field uses to define "ice" — into an extent in million '
      + 'km², and into the area-weighted latitude of the ice edge, which is the same retreat seen '
      + 'as a moving boundary. Demonstrates isoline(area) + isoline(latitude).',
    program: { nodes: [
      { id: 'ice', op: 'layer', params: { layer: 'ice', start: '2016-01', stepMonths: 1 } },
      { id: 'north', op: 'region', params: { lonMin: -180, latMin: 0, lonMax: 180, latMax: 90 } },
      { id: 'ext', op: 'isoline', inputs: { value: 'ice', region: 'north' }, params: { level: 15, measure: 'area' } },
      { id: 'edge', op: 'isoline', inputs: { value: 'ice', region: 'north' }, params: { level: 15, measure: 'latitude' } },
      { id: 'c', op: 'chart', inputs: { a: 'ext', b: 'edge' }, params: { title: 'Arctic ice: extent (10⁶ km²) and ice-edge latitude' } },
      { id: 'ans', op: 'answer', inputs: { value: 'ext' }, params: { label: 'Arctic sea-ice extent above 15 %' } },
    ] },
  },
  {
    name: 'Only the hot part counts',
    description: 'A range filter is what separates "how warm was the ocean" from "how much ocean was '
      + 'dangerously hot". Keeping only cells at or above 4 °C-weeks of coral heat stress, the area '
      + 'mean describes the stressed water alone, and the extent says how much of it there was. '
      + 'Demonstrates filter + areaMean + isoline.',
    program: { nodes: [
      { id: 'dhw', op: 'layer', params: { layer: 'dhw', start: '2016-01', stepMonths: 1 } },
      { id: 'hot', op: 'filter', inputs: { value: 'dhw' }, params: { min: 4 } },
      { id: 'sev', op: 'areaMean', inputs: { value: 'hot' } },
      { id: 'ext', op: 'isoline', inputs: { value: 'dhw' }, params: { level: 4, measure: 'area' } },
      { id: 'map', op: 'display', inputs: { value: 'hot' }, params: { title: 'Heat stress, bleaching-level cells only', colormap: 'thermal' } },
      { id: 'c', op: 'chart', inputs: { a: 'ext', b: 'sev' }, params: { title: 'Reef heat stress: area affected, and its mean severity' } },
      { id: 'ans', op: 'answer', inputs: { value: 'ext' }, params: { label: 'ocean area at or above 4 °C-weeks' } },
    ] },
  },
  {
    name: 'Chlorophyll in log space',
    description: 'Chlorophyll spans three orders of magnitude, so a correlation on raw mg/m³ is '
      + 'decided by a handful of coastal extremes. Taking log10 first puts every gyre and upwelling on '
      + 'comparable footing — compare this r against the raw one in "Warm seas are deserts". The '
      + 'scatter colours each cell by latitude, so you can see WHICH water makes the relationship. '
      + 'Demonstrates derive(log10) + a three-variable scatter.',
    program: { nodes: [
      { id: 'chl', op: 'layer', params: { layer: 'chl', start: '2016-01', stepMonths: 2 } },
      { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2016-01', stepMonths: 2 } },
      { id: 'logChl', op: 'derive', inputs: { value: 'chl' }, params: { fn: 'log10' } },
      { id: 'mLog', op: 'timeReduce', inputs: { value: 'logChl' }, params: { stat: 'mean' } },
      { id: 'mSst', op: 'timeReduce', inputs: { value: 'sst' }, params: { stat: 'mean' } },
      { id: 'r', op: 'correlate', inputs: { a: 'mLog', b: 'mSst' }, params: { mode: 'spatial' } },
      { id: 'sc', op: 'scatter', inputs: { a: 'mSst', b: 'mLog', c: 'mSst' }, params: { title: 'log₁₀ chlorophyll vs SST' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'spatial r: log₁₀ chlorophyll vs mean SST' } },
    ] },
  },
  {
    name: 'Warm seas are deserts',
    description: 'SPATIAL correlation: across the map, do the geographic patterns of mean '
      + 'chlorophyll and mean SST line up? One cos(lat)-weighted number — negative, because '
      + 'warm stratified gyres are nutrient deserts. Demonstrates correlate(mode: spatial).',
    program: { nodes: [
      { id: 'chl', op: 'layer', params: { layer: 'chl', start: '2016-01', stepMonths: 2 } },
      { id: 'sst', op: 'layer', params: { layer: 'sst', start: '2016-01', stepMonths: 2 } },
      { id: 'r', op: 'correlate', inputs: { a: 'chl', b: 'sst' }, params: { mode: 'spatial' } },
      { id: 'chlMean', op: 'timeReduce', inputs: { value: 'chl' }, params: { stat: 'mean' } },
      { id: 'map', op: 'display', inputs: { value: 'chlMean' }, params: { title: 'Mean chlorophyll-a', colormap: 'chl' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'spatial r: mean chlorophyll vs mean SST' } },
    ] },
  },
];
