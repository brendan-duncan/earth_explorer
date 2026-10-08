/**
 * Analysis panel for the GIS explorer — the PRESETS + ASK front ends of the analysis graph
 * (TODO/geo-analysis-graph.md §7/§9). Presets are small forms that build an
 * {@link AnalysisProgram}; the Ask tab lets an LLM write the programs (Claude or Gemini —
 * see `analysis_chat.ts`). Both run through one `execute` pipeline: materialize sources via the
 * {@link FieldStore}, interpret on the {@link AnalysisRunner} (Worker with inline fallback),
 * then route sinks — `display` to the host map, `chart` to the panel canvas, `answer` to
 * text — and return a JSON-able summary (which is also the LLM tool result).
 *
 * Self-contained like the ENSO panel: the host supplies the store, a display callback, and
 * a unit formatter, and appends {@link AnalysisPanel.button} to its control bar.
 */

import type { AnalysisProgram, AnalysisNode, ParamValue } from '../analysis/ast.js';
import { AnalysisError } from '../analysis/interpret.js';
import { AnalysisRunner } from '../analysis/run.js';
import { decodeProgram, encodeProgram, renderSystemPrompt, runAnalysisInputSchema } from '../analysis/schema.js';
import { BUILTIN_ANALYSES } from '../analysis/presets.js';
import { buildAnalysisGraphEditor } from './analysis_graph_panel.js';
import type { AnalysisChat } from './analysis_chat.js';
import type {
  AnnotateResult, AnswerPayload, AnswerResult, ChartResult, DisplayResult,
  HistogramResult, HovmollerResult, ScatterResult, VectorsResult,
} from '../analysis/ops.js';
import { sampleSstColormap, type SstColormapName } from '../live/sst_colormap.js';
import type { ValidationIssue } from '../analysis/validate.js';
import type { CatalogEntry, FieldStore } from '../analysis/field_store.js';
import { REGION_PRESETS, type RegionPresetName, type Unit } from '../analysis/types.js';

export interface AnalysisPanelOptions {
  store: FieldStore;
  /** Show a display-sink result on the map (the host owns the swap into its layer state). */
  onDisplay(result: DisplayResult): void;
  /** Show (or clear, with null) annotate-sink markers on the map. */
  onAnnotate?(result: AnnotateResult | null): void;
  /** Show (or clear, with null) a displayVectors-sink arrow overlay on the map. */
  onVectors?(result: VectorsResult | null): void;
  /** Formats a physical value for answers and chart axes. */
  format(v: number, unit: Unit, relative: boolean): string;
  /** Host-provided CSV download, so a plot export carries the same provenance the map's exports do. */
  exportCsv(name: string, header: string[], rows: Array<Array<string | number>>): void;
}

export interface AnalysisPanel {
  /** Toolbar toggle — the host appends this to its control bar. */
  button: HTMLButtonElement;
  setVisible(on: boolean): void;
}

/** What one run produced — rendered in the panel AND returned to the LLM as the tool result. */
export interface RunSummary {
  ok: boolean;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  costCellOps?: number;
  /** Legend titles now visible on the map. */
  displayed?: string[];
  charts?: string[];
  answers?: Array<{ label: string; payload: AnswerPayload }>;
  /** Scatter fits (the panel shows the plot; the numbers are for the caller/LLM). */
  scatters?: Array<{ title: string; mode: 'temporal' | 'spatial'; r: number; slope: number; n: number }>;
  histograms?: Array<{ title: string; mean: number; min: number; max: number; n: number }>;
  hovmollers?: Array<{ title: string; axis: 'lon' | 'lat'; frames: number }>;
  /** Extrema markers now pinned on the map, with coordinates the LLM can narrate. */
  annotations?: Array<{ label: string; markers: Array<{ lon: number; lat: number; value: number; kind: 'max' | 'min' }> }>;
  /** Titles of vector-arrow overlays now on the map. */
  vectors?: string[];
}

const SERIES_COLORS = ['#5ef0c8', '#dfa94e', '#b9c6ff'];

export function installAnalysisPanel(opts: AnalysisPanelOptions): AnalysisPanel {
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };
  const ctrl = 'background:#12141a;color:#dfeef0;border:1px solid #444;border-radius:4px;font-size:13px;padding:2px 5px';
  const btnCss = 'cursor:pointer;background:#2a2a38;color:#dfeef0;border:1px solid #444;border-radius:4px;height:26px;padding:0 10px;font-size:13px;font-family:inherit';

  const panel = document.createElement('div');
  // max-width, not a media query: at 400px the panel is wider than a phone screen, and a fixed box
  // that overhangs the viewport takes its close button off the edge with it.
  css(panel, 'position:fixed;z-index:11;right:12px;bottom:64px;display:none;width:400px;max-width:calc(100vw - 24px);max-height:76vh;overflow-y:auto;'
    + 'background:rgba(8,10,14,0.85);border-radius:6px;font-family:ui-monospace,monospace;color:#dfeef0;'
    + 'box-shadow:0 1px 6px rgba(0,0,0,0.4);padding:10px 12px;font-size:13px');

  // The header doubles as the drag handle (grab anywhere that isn't a button/link).
  const header = document.createElement('div');
  css(header, 'display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;color:#5ef0c8;'
    + 'cursor:move;user-select:none;touch-action:none');
  const title = document.createElement('span');
  title.textContent = 'Analysis';
  // The title takes the header's slack, so the whole empty middle is drag surface. Giving the
  // flex to the docs LINK instead made most of the bar an anchor, and anchors abort the drag —
  // which left only the word 'Analysis' grabbable.
  css(title, 'flex:1');
  const docsLink = document.createElement('a');
  docsLink.textContent = 'docs ↗';
  // The built docs site sits beside samples/ in the deployed tree; the host swaps in a
  // GitHub fallback when the site isn't there (local dev) — see the explorer's link probe.
  docsLink.id = 'analysis-docs-link';
  docsLink.href = 'https://github.com/brendan-duncan/earth_explorer/blob/main/docs/tutorials/README.md';
  docsLink.target = '_blank';
  docsLink.rel = 'noopener';
  docsLink.title = 'Analysis tutorials + the full node reference';
  css(docsLink, 'color:#8fa5ab;font-size:12px;text-decoration:none;margin-left:8px;cursor:pointer');
  const minBtn = document.createElement('button');
  minBtn.textContent = '–';
  minBtn.title = 'Minimize to the title bar';
  css(minBtn, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0;margin-right:10px;width:16px');
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  css(closeBtn, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0');
  header.append(title, docsLink, minBtn, closeBtn);

  /** Everything below the header — hidden while minimized. */
  const body = document.createElement('div');

  // ── Move + minimize ─────────────────────────────────────────────────────────────────
  const POS_STORAGE = 'earth_explorer_analysis_panel_pos';
  let minimized = false;

  /** Anchors the panel at (x, y), clamped so the title bar always stays reachable. */
  function placeAt(x: number, y: number): void {
    const w = panel.getBoundingClientRect().width || 400;   // hidden panels measure 0
    panel.style.left = `${Math.max(120 - w, Math.min(x, window.innerWidth - 120))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 48))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  let drag: { dx: number; dy: number } | null = null;
  header.addEventListener('pointerdown', (e) => {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
      return;   // buttons and the docs link keep their own clicks
    }
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  header.addEventListener('pointermove', (e) => {
    if (drag) {
      placeAt(e.clientX - drag.dx, e.clientY - drag.dy);
    }
  });
  header.addEventListener('pointerup', (e) => {
    if (drag) {
      drag = null;
      header.releasePointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      localStorage.setItem(POS_STORAGE, JSON.stringify({ x: r.left, y: r.top }));
    }
  });
  window.addEventListener('resize', () => {
    if (panel.style.left) {
      const r = panel.getBoundingClientRect();
      placeAt(r.left, r.top);   // keep the title bar reachable after a resize
    }
  });

  function setMinimized(on: boolean): void {
    minimized = on;
    body.style.display = on ? 'none' : 'block';
    minBtn.textContent = on ? '❐' : '–';
    minBtn.title = on ? 'Restore the panel' : 'Minimize to the title bar';
    header.style.marginBottom = on ? '0' : '7px';
    applyWidth();
  }
  minBtn.addEventListener('click', () => setMinimized(!minimized));

  const row = (label: string, ...els: HTMLElement[]): HTMLDivElement => {
    const r = document.createElement('div');
    css(r, 'display:flex;align-items:center;gap:6px;min-height:28px');
    const l = document.createElement('span');
    css(l, 'width:64px;flex:none;text-align:right;color:#8fa5ab');
    l.textContent = label;
    r.append(l, ...els);
    return r;
  };
  const select = (options: Array<{ value: string; label: string }>, value?: string): HTMLSelectElement => {
    const s = document.createElement('select');
    css(s, ctrl);
    for (const o of options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      s.appendChild(el);
    }
    if (value !== undefined) {
      s.value = value;
    }
    return s;
  };

  // ── Tabs ────────────────────────────────────────────────────────────────────────────
  const tabRow = document.createElement('div');
  css(tabRow, 'display:flex;gap:6px;margin-bottom:8px');
  const presetsTabBtn = document.createElement('button');
  presetsTabBtn.textContent = 'Presets';
  const askTabBtn = document.createElement('button');
  askTabBtn.textContent = 'Ask';
  const graphTabBtn = document.createElement('button');
  graphTabBtn.textContent = 'Graph';
  tabRow.append(presetsTabBtn, askTabBtn, graphTabBtn);

  const presetsSection = document.createElement('div');
  const askSection = document.createElement('div');
  askSection.style.display = 'none';
  const graphSection = document.createElement('div');
  graphSection.style.display = 'none';

  // The Ask tab loads lazily on first open, so the explorer's startup chunk stays lean for
  // users who never touch it; the chosen vendor's SDK is a further lazy import on first ask.
  let chatLoaded = false;
  let chatApi: AnalysisChat | null = null;
  type Tab = 'presets' | 'ask' | 'graph';
  let currentTab: Tab = 'presets';
  function applyWidth(): void {
    panel.style.width = minimized ? '230px' : currentTab === 'graph' ? 'min(94vw, 880px)' : '400px';
  }
  function selectTab(tab: Tab): void {
    currentTab = tab;
    presetsSection.style.display = tab === 'presets' ? 'block' : 'none';
    askSection.style.display = tab === 'ask' ? 'block' : 'none';
    graphSection.style.display = tab === 'graph' ? 'block' : 'none';
    setMinimized(false);   // picking a tab always brings the panel back
    applyWidth();
    css(presetsTabBtn, `${btnCss};${tab === 'presets' ? 'color:#5ef0c8;border-color:#5ef0c8' : ''}`);
    css(askTabBtn, `${btnCss};${tab === 'ask' ? 'color:#5ef0c8;border-color:#5ef0c8' : ''}`);
    css(graphTabBtn, `${btnCss};${tab === 'graph' ? 'color:#5ef0c8;border-color:#5ef0c8' : ''}`);
    if (tab === 'ask' && !chatLoaded) {
      chatLoaded = true;
      askSection.textContent = 'Loading…';
      void import('./analysis_chat.js').then((m) => {
        askSection.textContent = '';
        chatApi = m.buildAnalysisChat({
          container: askSection,
          systemPrompt: renderSystemPrompt(catalog),
          inputSchema: runAnalysisInputSchema(catalog.map((c) => c.key)),
          execute,
        });
      }).catch((e: Error) => {
        chatLoaded = false;
        askSection.textContent = `Failed to load the chat module: ${e.message}`;
      });
    }
  }
  presetsTabBtn.addEventListener('click', () => selectTab('presets'));
  askTabBtn.addEventListener('click', () => selectTab('ask'));
  graphTabBtn.addEventListener('click', () => selectTab('graph'));

  // ── Preset form ─────────────────────────────────────────────────────────────────────
  const catalog: CatalogEntry[] = opts.store.catalog();
  const layerOptions = catalog.map((c) => ({
    value: c.key,
    label: c.vector ? `${c.key} (speed)` : c.key,
  }));
  const byKey = new Map<string, CatalogEntry>(catalog.map((c) => [c.key, c]));

  // One-line orientation so a first-time user knows what the three tabs are for.
  const intro = document.createElement('div');
  intro.textContent = 'Analyze the map\'s data layers three ways: run a ready-made preset below, '
    + 'ask a question in plain English (Ask), or wire up the analysis yourself (Graph).';
  css(intro, 'color:#8fa5ab;font-size:12px;line-height:1.5;margin-bottom:8px');

  const PRESET_HINTS: Record<string, string> = {
    correlate: 'Where (or how strongly) do two layers move together over time?',
    trend: 'Per-cell rate of change, mapped — °/decade, m/decade, …',
    series: 'Average a layer over a region and chart it through time.',
    forecast: 'A small neural net, running on this device, predicts the next months of SST anomaly from the latest observations.',
  };
  const presetSel = select([
    { value: 'correlate', label: 'Correlate two layers' },
    { value: 'trend', label: 'Trend map' },
    { value: 'series', label: 'Region time series' },
    { value: 'forecast', label: 'ML forecast · SST anomaly' },
  ]);
  const presetHint = document.createElement('div');
  css(presetHint, 'color:#667;font-size:12px;line-height:1.45;margin:2px 0 4px 70px');

  const thisYear = new Date().getUTCFullYear();
  const years: Array<{ value: string; label: string }> = [];
  for (let y = 2016; y <= thisYear; y++) {
    years.push({ value: String(y), label: String(y) });
  }
  const startYearSel = select(years, '2020');
  const endYearSel = select(years, String(thisYear));
  const stepSel = select([
    { value: '4', label: '4 mo' },
    { value: '2', label: '2 mo' },
    { value: '1', label: '1 mo' },
  ], '4');

  const layerASel = select(layerOptions, byKey.has('sst') ? 'sst' : layerOptions[0]?.value);
  const layerBSel = select(layerOptions, byKey.has('wind') ? 'wind' : layerOptions[0]?.value);
  const modeSel = select([
    { value: 'temporal', label: 'map over time' },
    { value: 'spatial', label: 'one number' },
  ]);
  const regionSel = select([
    { value: 'global', label: 'global' },
    ...(Object.keys(REGION_PRESETS) as RegionPresetName[]).map((name) => ({ value: name, label: name })),
  ]);

  const monthsSel = select(
    [1, 2, 3, 4, 5, 6].map((m) => ({ value: String(m), label: `${m} month${m > 1 ? 's' : ''} ahead` })),
    '3',
  );

  // Significance treatment for the map presets. MARKING comes before hiding, and is what the
  // shorter labels get: stippling shows the estimate and says the evidence is weak, while hiding
  // discards it and leaves a hole indistinguishable from missing data. Hiding is still offered,
  // because excluding weak cells from a downstream statistic is a legitimate thing to want.
  const sigSel = select([
    { value: '', label: 'show all cells' },
    { value: 'stipple:0.05', label: 'stipple p > 0.05' },
    { value: 'stipple:0.01', label: 'stipple p > 0.01' },
    { value: 'hide:0.05', label: 'hide p > 0.05' },
  ], '');

  const rowLayer = row('layer', layerASel);
  const rowB = row('vs', layerBSel, modeSel);
  const rowRegion = row('region', regionSel);
  const rowYears = row('years', startYearSel, endYearSel, stepSel);
  const rowMonths = row('predict', monthsSel);
  const rowSig = row('test', sigSel);

  const runBtn = document.createElement('button');
  css(runBtn, 'cursor:pointer;background:#2a2a38;color:#5ef0c8;border:1px solid #444;border-radius:4px;height:28px;padding:0 14px;font-size:13px;font-family:inherit;margin-top:4px');
  runBtn.textContent = '▶ Run';

  presetsSection.append(
    intro,
    row('preset', presetSel),
    presetHint,
    rowLayer,
    rowB,
    rowRegion,
    rowYears,
    rowMonths,
    rowSig,
    runBtn,
  );

  function refreshForm(): void {
    const preset = presetSel.value;
    presetHint.textContent = PRESET_HINTS[preset] ?? '';
    rowLayer.style.display = preset === 'forecast' ? 'none' : 'flex';
    rowB.style.display = preset === 'correlate' ? 'flex' : 'none';
    rowRegion.style.display = preset === 'series' ? 'flex' : 'none';
    rowYears.style.display = preset === 'forecast' ? 'none' : 'flex';
    rowMonths.style.display = preset === 'forecast' ? 'flex' : 'none';
    // Only the per-cell map results can be filtered: a spatial correlation is one number over
    // autocorrelated cells and has no p-value to threshold on.
    const testable = preset === 'trend' || (preset === 'correlate' && modeSel.value === 'temporal');
    rowSig.style.display = testable ? 'flex' : 'none';
  }
  modeSel.addEventListener('change', refreshForm);
  presetSel.addEventListener('change', refreshForm);
  refreshForm();

  // ── Shared results area (below both tabs) ───────────────────────────────────────────
  const status = document.createElement('div');
  status.id = 'analysis-status';   // stable hooks for automated UI checks
  css(status, 'margin-top:6px;color:#8fa5ab;min-height:16px;white-space:pre-wrap');

  const answers = document.createElement('div');
  answers.id = 'analysis-answers';
  css(answers, 'margin-top:6px;line-height:1.6;color:#dfeef0;white-space:pre-wrap');

  /** One block per plot sink (chart/scatter/histogram/Hovmöller), rebuilt every run. */
  const results = document.createElement('div');
  results.id = 'analysis-results';

  /** Starts a titled plot block with a backing canvas; returns its 2D context + legend div. */
  /** Rows a plot can export. */
  interface PlotCsv { name: string; header: string[]; rows: Array<Array<string | number>>; }

  /** Per-plot hooks: what to say under the cursor, and what to write to CSV. */
  interface PlotHooks {
    /** Cursor in NORMALIZED canvas coords (0..1) → a readout string, or null off the data. */
    probe?: (nx: number, ny: number) => string | null;
    csv?: () => PlotCsv;
  }

  /**
   * One plot block: title bar, canvas, legend. The title bar carries the tools a plot needs to be
   * more than a picture — pop it out into a floating window you can drag and resize, and export the
   * exact numbers behind it. Hovering reads values off the plot, because "roughly where is that dot"
   * is the first question anyone asks of a scatter.
   */
  /** Drag a floating window by its whole title bar (buttons keep their clicks). */
  function dragByHandle(win: HTMLElement, handle: HTMLElement): void {
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.style.touchAction = 'none';
    let d: { dx: number; dy: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
        return;
      }
      const r = win.getBoundingClientRect();
      d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (d) {
        win.style.left = `${Math.max(-win.offsetWidth + 60, Math.min(window.innerWidth - 60, e.clientX - d.dx))}px`;
        win.style.top = `${Math.max(0, Math.min(window.innerHeight - 30, e.clientY - d.dy))}px`;
      }
    });
    const end = (e: PointerEvent): void => {
      if (d) {
        d = null;
        if (handle.hasPointerCapture(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function plotBlock(title: string, w: number, h: number, hooks: PlotHooks = {}):
  { cx: CanvasRenderingContext2D; legend: HTMLDivElement; canvas: HTMLCanvasElement } {
    const wrap = document.createElement('div');
    css(wrap, 'margin-top:8px');
    const bar = document.createElement('div');
    css(bar, 'display:flex;align-items:baseline;gap:6px;margin-bottom:4px;color:#9fd8cf');
    const t = document.createElement('span');
    css(t, 'flex:1');
    t.textContent = title;
    const tool = 'cursor:pointer;background:none;border:none;color:#5ef0c8;font-size:11px;'
      + 'padding:0;font-family:inherit;flex:none';
    const popBtn = document.createElement('button');
    popBtn.textContent = '⧉';
    popBtn.title = 'Pop out into a resizable window';
    css(popBtn, `${tool};font-size:13px`);
    const csvBtn = document.createElement('button');
    csvBtn.textContent = 'CSV';
    csvBtn.title = 'Download the values behind this plot';
    css(csvBtn, tool);
    csvBtn.style.display = hooks.csv ? 'inline' : 'none';
    bar.append(t, csvBtn, popBtn);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    css(canvas, `width:100%;max-width:376px;aspect-ratio:${w}/${h};display:block;background:rgba(255,255,255,0.04);border-radius:3px`);
    const legend = document.createElement('div');
    css(legend, 'margin-top:3px;line-height:1.5;color:#8fa5ab');
    const hover = document.createElement('div');
    css(hover, 'margin-top:2px;min-height:14px;color:#dfeef0');
    wrap.append(bar, canvas, legend, hover);
    results.appendChild(wrap);

    if (hooks.probe) {
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('pointermove', (e) => {
        const r = canvas.getBoundingClientRect();
        hover.textContent = hooks.probe!((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height) ?? '';
      });
      canvas.addEventListener('pointerleave', () => { hover.textContent = ''; });
    }
    if (hooks.csv) {
      csvBtn.addEventListener('click', () => {
        const d = hooks.csv!();
        opts.exportCsv(d.name, d.header, d.rows);
      });
    }
    popBtn.addEventListener('click', () => {
      if (wrap.parentElement !== results) {
        return;   // already floating
      }
      const win = document.createElement('div');
      css(win, 'position:fixed;z-index:14;left:80px;top:80px;width:620px;height:auto;resize:both;'
        + 'max-width:calc(100vw - 96px);max-height:82vh;'
        + 'overflow:auto;min-width:280px;min-height:220px;background:rgba(8,10,14,0.94);'
        + 'border:1px solid rgba(94,240,200,0.25);border-radius:8px;box-shadow:0 6px 32px rgba(0,0,0,0.6);'
        + 'padding:10px 12px;font-family:ui-monospace,monospace;color:#dfeef0;font-size:12.5px');
      const wbar = document.createElement('div');
      css(wbar, 'display:flex;align-items:baseline;gap:8px;margin-bottom:6px;color:#5ef0c8');
      const wt = document.createElement('span');
      css(wt, 'flex:1');
      wt.textContent = title;
      const close = document.createElement('button');
      close.textContent = '✕';
      close.title = 'Dock this plot back into the panel';
      css(close, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0');
      wbar.append(wt, close);
      win.append(wbar, wrap);
      document.body.appendChild(win);
      // The canvas is capped for the narrow panel; in its own window let it use the whole width.
      canvas.style.maxWidth = 'none';
      t.style.display = 'none';                 // the window's own bar carries the title
      dragByHandle(win, wbar);
      close.addEventListener('click', () => {
        canvas.style.maxWidth = '376px';
        t.style.display = '';
        results.appendChild(wrap);              // back into the panel, in run order
        win.remove();
      });
    });
    return { cx: canvas.getContext('2d')!, legend, canvas };
  }

  body.append(tabRow, presetsSection, askSection, graphSection, status, answers, results);
  panel.append(header, body);
  document.body.appendChild(panel);
  selectTab('presets');
  // Restore a dragged position from earlier sessions (clamped — windows change size).
  try {
    const saved = JSON.parse(localStorage.getItem(POS_STORAGE) ?? 'null') as { x: number; y: number } | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      placeAt(saved.x, saved.y);
    }
  } catch { /* corrupt storage — keep the default anchor */ }

  // ── Program builders ────────────────────────────────────────────────────────────────
  function layerNode(id: string, key: string): AnalysisNode {
    const entry = byKey.get(key);
    const params: Record<string, string | number> = {
      layer: key,
      start: `${startYearSel.value}-01`,
      end: `${endYearSel.value}-12`,
      stepMonths: parseInt(stepSel.value, 10),
    };
    if (entry?.vector) {
      params.component = 'speed';
    }
    return { id, op: 'layer', params };
  }

  function buildProgram(): AnalysisProgram {
    const preset = presetSel.value;
    const a = layerASel.value;
    // '' = show every cell; else "stipple:α" marks weak cells and "hide:α" removes them. Marking
    // rides on the display sink (it never touches the data); hiding rides on the estimator.
    const [sigMode, sigAlpha] = sigSel.value.split(':');
    const alpha = sigAlpha ? parseFloat(sigAlpha) : undefined;
    const sigParam: Record<string, ParamValue> = alpha !== undefined && sigMode === 'hide' ? { significance: alpha } : {};
    const showParam: Record<string, ParamValue> = alpha !== undefined && sigMode === 'stipple' ? { stipple: alpha } : {};
    const sigSuffix = alpha === undefined ? ''
      : sigMode === 'stipple' ? ` · stippled where p > ${alpha}` : ` · p ≤ ${alpha}`;
    if (preset === 'correlate') {
      const b = layerBSel.value;
      const mode = modeSel.value;
      const nodes: AnalysisNode[] = [
        layerNode('a', a),
        layerNode('b', b),
        { id: 'r', op: 'correlate', inputs: { a: 'a', b: 'b' }, params: { mode, ...(mode === 'temporal' ? sigParam : {}) } },
        { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: `correlation of ${a} vs ${b}` } },
      ];
      if (mode === 'temporal') {
        nodes.push({ id: 'show', op: 'display', inputs: { value: 'r' }, params: { title: `r · ${a} × ${b} · ${startYearSel.value}–${endYearSel.value}${sigSuffix}`, ...showParam } });
      }
      return { nodes };
    }
    if (preset === 'forecast') {
      const months = parseInt(monthsSel.value, 10);
      return { nodes: [
        { id: 'fc', op: 'forecast', params: { layer: 'anom', months } },
        { id: 'show', op: 'display', inputs: { value: 'fc' }, params: { title: `SST anomaly · ML forecast +${months} mo (predicted)`, colormap: 'balance', min: -3, max: 3 } },
        { id: 'mean', op: 'areaMean', inputs: { value: 'fc' } },
        { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: 'global-mean predicted SST anomaly' } },
      ] };
    }
    if (preset === 'trend') {
      return { nodes: [
        layerNode('a', a),
        { id: 't', op: 'trend', inputs: { value: 'a' }, params: sigParam },
        { id: 'show', op: 'display', inputs: { value: 't' }, params: { title: `trend per decade · ${a} · ${startYearSel.value}–${endYearSel.value}${sigSuffix}`, ...showParam } },
        { id: 'ans', op: 'answer', inputs: { value: 't' }, params: { label: `${a} trend per decade` } },
      ] };
    }
    // Region time series.
    const nodes: AnalysisNode[] = [layerNode('a', a)];
    const meanInputs: Record<string, string> = { value: 'a' };
    if (regionSel.value !== 'global') {
      nodes.push({ id: 'reg', op: 'region', params: { preset: regionSel.value } });
      meanInputs.region = 'reg';
    }
    nodes.push(
      { id: 'mean', op: 'areaMean', inputs: meanInputs },
      { id: 'c', op: 'chart', inputs: { a: 'mean' }, params: { title: `${a} · ${regionSel.value} · area mean` } },
      { id: 'ans', op: 'answer', inputs: { value: 'mean' }, params: { label: `${a} area mean (${regionSel.value})` } },
    );
    return { nodes };
  }

  // ── Sink rendering ──────────────────────────────────────────────────────────────────

  /**
   * A spread formatted as a MAGNITUDE: the relative formatter does the unit conversion a span needs
   * (scale, no offset), but its leading "+" is meant for signed anomalies and reads as nonsense on
   * a standard deviation.
   */
  function fmtSpread(v: number, unit: Parameters<typeof opts.format>[1]): string {
    return opts.format(v, unit, true).replace(/^\+/, '');
  }

  /** A p-value as a reader actually needs it: the threshold it clears, not four decimal places. */
  function fmtP(p: number): string {
    if (!Number.isFinite(p)) {
      return 'p n/a';
    }
    if (p < 0.001) {
      return 'p < 0.001';
    }
    return `p = ${p < 0.01 ? p.toFixed(4) : p.toFixed(3)}`;
  }

  /**
   * One answer line. Sample counts, effective sample size, p and coverage ride WITH the number,
   * because a value quoted without them is the failure mode this panel exists to prevent — and
   * the derivation notes (which climatology, which significance filter) go on the next line.
   */
  function renderAnswer(a: AnswerResult): string {
    const p = a.payload;
    const notes = (a.notes ?? []).map((n) => `\n  ${n}`).join('');
    if (p.type === 'scalar') {
      const bits: string[] = [];
      if (p.n !== undefined) {
        bits.push(`n=${p.n}`);
      }
      if (p.nEff !== undefined && Number.isFinite(p.nEff)) {
        bits.push(`n_eff≈${p.nEff.toFixed(1)}`);
      }
      if (p.p !== undefined) {
        bits.push(fmtP(p.p));
      }
      if (p.sd !== undefined && Number.isFinite(p.sd)) {
        bits.push(`sd ${fmtSpread(p.sd, p.unit)}`);
      }
      if (p.coverage !== undefined) {
        bits.push(`${(p.coverage * 100).toFixed(0)}% coverage`);
      }
      return `${a.label}: ${opts.format(p.value, p.unit, p.relative)}${bits.length ? ` (${bits.join(' · ')})` : ''}${notes}`;
    }
    if (p.type === 'series') {
      const extra: string[] = [];
      if (p.meanSd !== undefined && Number.isFinite(p.meanSd)) {
        extra.push(`± ${fmtSpread(p.meanSd, p.unit)} within-region sd`);
      }
      if (p.minCoverage !== undefined) {
        extra.push(`${(p.minCoverage * 100).toFixed(0)}% coverage at worst`);
      }
      return `${a.label}: mean ${opts.format(p.mean, p.unit, p.relative)} · ${opts.format(p.min, p.unit, p.relative)}…${opts.format(p.max, p.unit, p.relative)} · ${p.n} samples (${p.start} → ${p.end})${extra.length ? ` · ${extra.join(' · ')}` : ''}${notes}`;
    }
    const fm = (v: number): string => opts.format(v, p.unit, p.relative);
    let sig = '';
    if (p.significance) {
      const s = p.significance;
      sig = s.tested > 0
        ? `\n  ${(s.fractionP05 * 100).toFixed(0)}% of ${s.tested} testable cells reach p ≤ 0.05 (${(s.fractionP01 * 100).toFixed(0)}% reach p ≤ 0.01); median n_eff ≈ ${s.medianNEff.toFixed(1)}`
        : '\n  no cell had enough independent samples to test';
    } else if (p.unit === 'r') {
      sig = '\n  (gridded r — read as association, not significance)';
    }
    return `${a.label}: mean ${fm(p.areaWeightedMean)} · p5 ${fm(p.p5)} · p95 ${fm(p.p95)} · ${(p.validFraction * 100).toFixed(0)}% coverage${sig}${notes}`;
  }

  function drawChart(c: ChartResult): void {
    const W = 600, H = 240;
    const P = 16;
    const t0 = Math.min(...c.series.map((s) => s.t[0] ?? Infinity));
    const t1 = Math.max(...c.series.map((s) => s.t[s.t.length - 1] ?? -Infinity));
    // Hover maps the cursor's x back to a date and reports every series at its nearest sample —
    // reading a multi-series chart by eye is exactly what people cannot do.
    const { cx, legend: chartLegend } = plotBlock(c.title, W, H, {
      probe: (nx) => {
        if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
          return null;
        }
        const inner = (nx * W - P) / Math.max(W - 2 * P, 1);
        if (inner < 0 || inner > 1) {
          return null;
        }
        const t = t0 + inner * (t1 - t0);
        const parts = [new Date(t).toISOString().slice(0, 10)];
        for (const sr of c.series) {
          let bi = -1, bd = Infinity;
          for (let i = 0; i < sr.t.length; i++) {
            const dd = Math.abs(sr.t[i] - t);
            if (dd < bd) { bd = dd; bi = i; }
          }
          if (bi >= 0 && Number.isFinite(sr.v[bi])) {
            const sp = sr.spread;
            // The spread and the coverage under the cursor, not just the mean: a sample drawn from
            // 12% of the region should say so at the moment someone reads it off the plot.
            const band = sp && Number.isFinite(sp.sd[bi]) ? ` ±${fmtSpread(sp.sd[bi], sr.unit)}` : '';
            const cov = sp && sp.coverage[bi] < 0.999 ? ` [${(sp.coverage[bi] * 100).toFixed(0)}%]` : '';
            parts.push(`${sr.label} ${opts.format(sr.v[bi], sr.unit, sr.relative)}${band}${cov}`);
          }
        }
        return parts.join(' · ');
      },
      csv: () => {
        // Every column the plot knows about — a CSV that drops the spread and the coverage hands on
        // a number that looks more certain than the one on screen.
        const rows: Array<Array<string | number>> = [];
        for (const sr of c.series) {
          for (let i = 0; i < sr.t.length; i++) {
            const sp = sr.spread;
            rows.push([
              new Date(sr.t[i]).toISOString().slice(0, 10), sr.label, sr.unit, sr.v[i],
              sp ? sp.sd[i] : '', sp ? sp.n[i] : '', sp ? sp.coverage[i] : '',
            ]);
          }
        }
        return {
          name: `chart_${c.node}`,
          header: ['date', 'series', 'unit', 'value', 'within_region_sd', 'valid_cells', 'coverage_fraction'],
          rows,
        };
      },
    });
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
      return;
    }
    c.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      // The band is part of the data, so it sets the y-range too — scaling to the mean alone would
      // clip the very spread the band exists to show.
      const spread = s.spread;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < s.v.length; i++) {
        const v = s.v[i];
        if (!Number.isFinite(v)) {
          continue;
        }
        const sd = spread && Number.isFinite(spread.sd[i]) ? spread.sd[i] : 0;
        lo = Math.min(lo, v - sd); hi = Math.max(hi, v + sd);
      }
      if (!Number.isFinite(lo)) {
        return;
      }
      const span = Math.max(hi - lo, 1e-9);
      const X = (t: number): number => P + ((t - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P);
      const Y = (v: number): number => P + (1 - (v - lo) / span) * (H - 2 * P);
      if (spread) {
        // ±1 within-region sd as a filled ribbon: upper edge left→right, lower edge back. This is
        // the SPREAD OF THE REGION, not a confidence interval on the mean — grid cells are far from
        // independent, so a standard error here would be fiction. The legend says which it is.
        cx.fillStyle = `${color}22`;
        cx.beginPath();
        let open = false;
        for (let i = 0; i < s.t.length; i++) {
          if (!Number.isFinite(s.v[i]) || !Number.isFinite(spread.sd[i])) {
            continue;
          }
          const px = X(s.t[i]), py = Y(s.v[i] + spread.sd[i]);
          if (open) {
            cx.lineTo(px, py);
          } else {
            cx.moveTo(px, py);
            open = true;
          }
        }
        if (open) {
          for (let i = s.t.length - 1; i >= 0; i--) {
            if (Number.isFinite(s.v[i]) && Number.isFinite(spread.sd[i])) {
              cx.lineTo(X(s.t[i]), Y(s.v[i] - spread.sd[i]));
            }
          }
          cx.closePath();
          cx.fill();
        }
      }
      cx.strokeStyle = color;
      cx.lineWidth = 2;
      cx.beginPath();
      let started = false;
      for (let i = 0; i < s.t.length; i++) {
        if (!Number.isFinite(s.v[i])) {
          continue;
        }
        if (started) {
          cx.lineTo(X(s.t[i]), Y(s.v[i]));
        } else {
          cx.moveTo(X(s.t[i]), Y(s.v[i]));
          started = true;
        }
      }
      cx.stroke();
      const legendLine = document.createElement('div');
      legendLine.style.color = color;
      const bandText = spread ? ' · shaded ±1 sd across the region (spread, not a confidence interval)' : '';
      legendLine.textContent = `${s.label}: ${opts.format(lo, s.unit, false)} … ${opts.format(hi, s.unit, false)}${bandText}`;
      chartLegend.appendChild(legendLine);
    });
    for (const note of c.notes ?? []) {
      const n = document.createElement('div');
      css(n, 'color:#8fa5ab;font-style:italic');
      n.textContent = note;
      chartLegend.appendChild(n);
    }
    cx.fillStyle = 'rgba(223,238,240,0.6)';
    cx.font = '16px ui-monospace,monospace';
    cx.fillText(new Date(t0).toISOString().slice(0, 7), P, H - 2);
    cx.textAlign = 'right';
    cx.fillText(new Date(t1).toISOString().slice(0, 7), W - P, H - 2);
    cx.textAlign = 'left';
  }

  function drawScatter(s: ScatterResult): void {
    const W = 600, H = 400, P = 44;
    let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (let i = 0; i < s.x.length; i++) {
      xLo = Math.min(xLo, s.x[i]); xHi = Math.max(xHi, s.x[i]);
      yLo = Math.min(yLo, s.y[i]); yHi = Math.max(yHi, s.y[i]);
    }
    const xPad = (xHi - xLo || 1) * 0.05, yPad = (yHi - yLo || 1) * 0.05;
    xLo -= xPad; xHi += xPad; yLo -= yPad; yHi += yPad;
    // Hover reports the NEAREST plotted dot in data space, which is what "what is that outlier"
    // means; the cloud is far too dense to read a single point out of by eye.
    const { cx, legend } = plotBlock(s.title, W, H, {
      probe: (nx, ny) => {
        const dx = xLo + ((nx * W - P) / Math.max(W - P - 12, 1)) * (xHi - xLo);
        const dy = yLo + ((H - P - ny * H) / Math.max(H - P - 12, 1)) * (yHi - yLo);
        let bi = -1, bd = Infinity;
        for (let i = 0; i < s.x.length; i++) {
          // Normalized distance, so neither axis dominates just by having a bigger range.
          const ddx = (s.x[i] - dx) / (xHi - xLo);
          const ddy = (s.y[i] - dy) / (yHi - yLo);
          const dd = ddx * ddx + ddy * ddy;
          if (dd < bd) { bd = dd; bi = i; }
        }
        if (bi < 0 || bd > 0.0025) {
          return null;   // more than ~5 % of the plot away: not pointing at anything
        }
        const bits = [
          `${s.xLabel} ${opts.format(s.x[bi], s.xUnit, s.xRelative)}`,
          `${s.yLabel} ${opts.format(s.y[bi], s.yUnit, s.yRelative)}`,
        ];
        if (s.c && Number.isFinite(s.c[bi])) {
          bits.push(`${s.cLabel ?? 'c'} ${opts.format(s.c[bi], s.cUnit ?? 'none', s.cRelative ?? false)}`);
        }
        return bits.join(' · ');
      },
      csv: () => {
        const header = [s.xLabel || 'x', s.yLabel || 'y'];
        if (s.c) {
          header.push(s.cLabel ?? 'c');
        }
        const rows: Array<Array<string | number>> = [];
        for (let i = 0; i < s.x.length; i++) {
          const row: Array<string | number> = [s.x[i], s.y[i]];
          if (s.c) {
            row.push(s.c[i]);
          }
          rows.push(row);
        }
        return { name: `scatter_${s.node}`, header, rows };
      },
    });
    const X = (v: number): number => P + ((v - xLo) / (xHi - xLo)) * (W - P - 12);
    const Y = (v: number): number => (H - P) - ((v - yLo) / (yHi - yLo)) * (H - P - 12);
    // Axes.
    cx.strokeStyle = 'rgba(223,238,240,0.25)';
    cx.lineWidth = 1;
    cx.strokeRect(P, 12, W - P - 12, H - P - 12);
    // Dots. With a third variable wired, color carries it — this is what turns a two-variable
    // cloud into a property-property plot: the structure inside the cloud (which water mass, which
    // latitude, which season) is invisible when every dot is the same color.
    let cLo = Infinity, cHi = -Infinity;
    if (s.c) {
      for (const v of s.c) {
        if (Number.isFinite(v)) {
          cLo = Math.min(cLo, v); cHi = Math.max(cHi, v);
        }
      }
    }
    const hasColor = s.c !== undefined && cHi > cLo;
    for (let i = 0; i < s.x.length; i++) {
      if (hasColor) {
        const t = (s.c![i] - cLo) / (cHi - cLo);
        // A diverging ramp for Δ-quantities (mid-gray at zero), sequential otherwise.
        const rgb = Number.isFinite(t)
          ? sampleSstColormap(s.cRelative ? 'balance' : 'viridis', Math.max(0, Math.min(1, t)))
          : [150, 160, 165] as [number, number, number];
        cx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.65)`;   // components are already 0–255
      } else {
        cx.fillStyle = 'rgba(94,240,200,0.35)';
      }
      cx.beginPath();
      cx.arc(X(s.x[i]), Y(s.y[i]), 3, 0, 2 * Math.PI);
      cx.fill();
    }
    // Color key: a short ramp with its end values, so the third axis is readable.
    if (hasColor) {
      const kx = W - 130, ky = 20, kw = 100, kh = 8;
      for (let i = 0; i < kw; i++) {
        const rgb = sampleSstColormap(s.cRelative ? 'balance' : 'viridis', i / (kw - 1));
        cx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        cx.fillRect(kx + i, ky, 1, kh);
      }
      cx.strokeStyle = 'rgba(223,238,240,0.35)';
      cx.lineWidth = 1;
      cx.strokeRect(kx, ky, kw, kh);
      cx.fillStyle = 'rgba(223,238,240,0.75)';
      cx.font = '13px ui-monospace,monospace';
      cx.textAlign = 'right';
      cx.fillText(opts.format(cLo, s.cUnit ?? 'none', s.cRelative ?? false), kx - 4, ky + kh);
      cx.textAlign = 'left';
      cx.fillText(opts.format(cHi, s.cUnit ?? 'none', s.cRelative ?? false), kx + kw + 4, ky + kh);
      cx.textAlign = 'left';
    }
    // Least-squares line, clipped to the plot box by its endpoints.
    if (Number.isFinite(s.slope)) {
      cx.strokeStyle = '#dfa94e';
      cx.lineWidth = 2.5;
      cx.beginPath();
      cx.moveTo(X(xLo), Y(s.intercept + s.slope * xLo));
      cx.lineTo(X(xHi), Y(s.intercept + s.slope * xHi));
      cx.stroke();
    }
    // Tick labels: axis ranges in physical units.
    cx.fillStyle = 'rgba(223,238,240,0.7)';
    cx.font = '15px ui-monospace,monospace';
    cx.fillText(opts.format(xLo, s.xUnit, s.xRelative), P, H - P + 18);
    cx.textAlign = 'right';
    cx.fillText(opts.format(xHi, s.xUnit, s.xRelative), W - 12, H - P + 18);
    cx.textAlign = 'left';
    cx.save();
    cx.translate(14, H - P);
    cx.rotate(-Math.PI / 2);
    cx.fillText(opts.format(yLo, s.yUnit, s.yRelative), 0, 0);
    cx.restore();
    cx.save();
    cx.translate(14, 12);
    cx.rotate(-Math.PI / 2);
    cx.textAlign = 'right';
    cx.fillText(opts.format(yHi, s.yUnit, s.yRelative), 0, 0);
    cx.restore();
    const dots = s.mode === 'temporal' ? 'months' : 'cells';
    legend.textContent = `${s.xLabel} (x) vs ${s.yLabel} (y)`
      + (hasColor ? ` · color ${s.cLabel ?? 'c'}` : '')
      + ` · r=${s.r.toFixed(2)} · n=${s.n} ${dots}`
      + (s.x.length < s.n ? ` (${s.x.length} plotted)` : '');
  }

  function drawHistogram(h: HistogramResult): void {
    const W = 600, H = 240, P = 12;
    const { cx, legend } = plotBlock(h.title, W, H);
    const peak = Math.max(...h.counts, 1e-9);
    const bins = h.counts.length;
    const bw = (W - 2 * P) / bins;
    cx.fillStyle = 'rgba(94,240,200,0.55)';
    for (let i = 0; i < bins; i++) {
      const bh = (h.counts[i] / peak) * (H - 2 * P - 16);
      cx.fillRect(P + i * bw + 0.5, H - P - 18 - bh, Math.max(1, bw - 1), bh);
    }
    // Mean marker.
    const mx = P + ((h.mean - h.edges[0]) / (h.edges[bins] - h.edges[0])) * (W - 2 * P);
    cx.strokeStyle = '#dfa94e';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(mx, P);
    cx.lineTo(mx, H - P - 18);
    cx.stroke();
    cx.fillStyle = 'rgba(223,238,240,0.7)';
    cx.font = '15px ui-monospace,monospace';
    cx.fillText(opts.format(h.min, h.unit, h.relative), P, H - 4);
    cx.textAlign = 'right';
    cx.fillText(opts.format(h.max, h.unit, h.relative), W - P, H - 4);
    cx.textAlign = 'left';
    legend.textContent = `mean ${opts.format(h.mean, h.unit, h.relative)} · ${h.n} cells (area-weighted)`;
  }

  function drawHovmoller(hv: HovmollerResult): void {
    // Native-resolution heatmap, stretched by CSS: x = axis bins, y = one row per frame.
    const { cx, legend, canvas } = plotBlock(`${hv.title} · time ↓`, hv.width, hv.height);
    canvas.style.aspectRatio = '';
    canvas.style.height = `${Math.max(120, Math.min(280, hv.height * 3))}px`;
    canvas.style.imageRendering = 'auto';
    const img = cx.createImageData(hv.width, hv.height);
    const cmap: SstColormapName = hv.relative || hv.unit === 'r' ? 'balance' : 'viridis';
    const span = hv.max - hv.min || 1;
    for (let i = 0; i < hv.values.length; i++) {
      const v = hv.values[i];
      const o = i * 4;
      if (!Number.isFinite(v)) {
        img.data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = sampleSstColormap(cmap, Math.max(0, Math.min(1, (v - hv.min) / span)));   // 8-bit rgb
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    const a0 = hv.axisStart.toFixed(0);
    const a1 = (hv.axisStart + hv.axisStep * (hv.width - 1)).toFixed(0);
    legend.textContent = `${hv.axis} ${a0}° → ${a1}° · ${hv.dates[0]?.slice(0, 7)} ↓ ${hv.dates[hv.dates.length - 1]?.slice(0, 7)}`
      + ` · ${opts.format(hv.min, hv.unit, hv.relative)} … ${opts.format(hv.max, hv.unit, hv.relative)}`;
  }

  // ── Shared execution pipeline (presets AND the LLM tool run through this) ───────────
  const runner = new AnalysisRunner();
  let running = false;

  /** `syncGraph: false` for runs started FROM the graph editor (its layout must survive). */
  async function execute(program: AnalysisProgram, syncGraph = true): Promise<RunSummary> {
    if (syncGraph) {
      graphEditor.setProgram(structuredClone(program));
    }
    while (running) {
      await new Promise((r) => setTimeout(r, 100));   // serialize concurrent asks
    }
    running = true;
    runBtn.disabled = true;
    answers.textContent = '';
    results.textContent = '';
    status.textContent = 'Loading data…';
    try {
      // Clear the host's map overlays inside the try — a host-callback failure must land in
      // the status line like any other, not evaporate as an unhandled rejection.
      opts.onAnnotate?.(null);
      opts.onVectors?.(null);
      const { sources, sourceKeys } = await opts.store.resolveSources(program);
      status.textContent = 'Computing…';
      const result = await runner.run(program, { sources, sourceKeys });
      const summary: RunSummary = {
        ok: true,
        costCellOps: result.costCellOps,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        displayed: [],
        charts: [],
        answers: [],
      };
      const lines: string[] = [];
      for (const sink of result.sinks) {
        if (sink.kind === 'display') {
          opts.onDisplay(sink);
          summary.displayed!.push(sink.legend.title);
          lines.push(`map: ${sink.legend.title}`);
        } else if (sink.kind === 'chart') {
          drawChart(sink);
          summary.charts!.push(sink.title);
        } else if (sink.kind === 'scatter') {
          drawScatter(sink);
          (summary.scatters ??= []).push({ title: sink.title, mode: sink.mode, r: sink.r, slope: sink.slope, n: sink.n });
        } else if (sink.kind === 'histogram') {
          drawHistogram(sink);
          (summary.histograms ??= []).push({ title: sink.title, mean: sink.mean, min: sink.min, max: sink.max, n: sink.n });
        } else if (sink.kind === 'hovmoller') {
          drawHovmoller(sink);
          (summary.hovmollers ??= []).push({ title: sink.title, axis: sink.axis, frames: sink.height });
        } else if (sink.kind === 'annotate') {
          if (opts.onAnnotate) {
            opts.onAnnotate(sink);
            lines.push(`map: ${sink.markers.length} marker${sink.markers.length > 1 ? 's' : ''} · ${sink.label}`);
          }
          for (const m of sink.markers) {
            lines.push(`  ${m.kind === 'max' ? '▲' : '▼'} ${opts.format(m.value, sink.unit, sink.relative)} at ${Math.abs(m.lat).toFixed(1)}°${m.lat >= 0 ? 'N' : 'S'} ${Math.abs(m.lon).toFixed(1)}°${m.lon >= 0 ? 'E' : 'W'}`);
          }
          (summary.annotations ??= []).push({ label: sink.label, markers: sink.markers });
        } else if (sink.kind === 'vectors') {
          if (opts.onVectors) {
            opts.onVectors(sink);
            lines.push(`map: arrows · ${sink.title}`);
          }
          (summary.vectors ??= []).push(sink.title);
        } else {
          summary.answers!.push({ label: sink.label, payload: sink.payload });
          lines.push(renderAnswer(sink));
        }
      }
      answers.textContent = lines.join('\n');
      status.textContent = `done · ${Math.max(1, Math.round(result.costCellOps / 1e6))}M cell-ops`;
      return summary;
    } catch (e) {
      const issues: ValidationIssue[] = e instanceof AnalysisError ? e.issues : [{ message: (e as Error).message }];
      status.textContent = issues.map((i) => `${i.node ? `[${i.node}] ` : ''}${i.message}${i.hint ? `\n  ${i.hint}` : ''}`).join('\n');
      return { ok: false, errors: issues };
    } finally {
      running = false;
      runBtn.disabled = false;
    }
  }
  runBtn.addEventListener('click', () => { void execute(buildProgram()); });

  // ── Graph tab: edit the last-run program (or build one from scratch) ────────────────
  const graphEditor = buildAnalysisGraphEditor({
    container: graphSection,
    layerKeys: catalog.map((c) => c.key),
    execute: (p) => execute(p, false),
    onRun: (p) => chatApi?.notifyExternalRun(p),
    makeLink: (p) => `${location.origin}${location.pathname}?analysis=graph&prog=${encodeProgram(p)}`,
    builtins: BUILTIN_ANALYSES,
  });

  // ── Toggle ──────────────────────────────────────────────────────────────────────────
  const button = document.createElement('button');
  css(button, btnCss);
  button.textContent = '⚗ Analysis';
  button.title = 'Analysis graph — ask questions, correlations, trends, and time series over the data layers';
  const setVisible = (on: boolean): void => { panel.style.display = on ? 'block' : 'none'; };
  button.addEventListener('click', () => setVisible(panel.style.display === 'none'));
  closeBtn.addEventListener('click', () => setVisible(false));

  // Deeplinks, like the host's ?enso / ?menu: `?analysis` opens the panel (`=ask` / `=graph`
  // pick a tab), `?analysis=run` runs the current preset, and `?prog=` carries a whole
  // shared program — loaded into the graph editor and run. Deferred a microtask: a deeplink
  // run reaches back into the HOST's callbacks (onDisplay/onAnnotate/onVectors), and the
  // host is still mid-initialization while installAnalysisPanel is on the stack.
  queueMicrotask(() => {
    const q = new URLSearchParams(location.search);
    const prog = q.get('prog');
    if (prog) {
      try {
        const shared = decodeProgram(prog);
        setVisible(true);
        selectTab('graph');
        graphEditor.setProgram(shared);
        void execute(shared, false);
      } catch {
        status.textContent = 'The ?prog link in this URL could not be decoded.';
        setVisible(true);
      }
    } else if (q.has('analysis')) {
      setVisible(true);
      if (q.get('analysis') === 'ask') {
        selectTab('ask');
      } else if (q.get('analysis') === 'graph') {
        selectTab('graph');
      } else if (q.get('analysis') === 'run') {
        void execute(buildProgram());
      }
    }
  });

  return { button, setVisible };
}
