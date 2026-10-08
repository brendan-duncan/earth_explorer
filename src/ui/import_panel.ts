/**
 * "Bring your own data" for the GIS explorer: a study area and a station list.
 *
 * Two imports, because they are the two things a working scientist already has on disk and cannot
 * otherwise get into this map:
 *
 *  - a GeoJSON polygon — their actual study area, sanctuary boundary or survey box, instead of a
 *    shape traced by hand with a mouse, which is neither accurate nor reproducible;
 *  - a station CSV — their sample points, collocated against the displayed layer in space AND time,
 *    which is the "extract the satellite value at my sites" workflow that turns a viewer into a
 *    step in someone's analysis.
 *
 * The parsing and collocation live in `src/geo/live/matchup.ts` and `src/geo/geojson.ts`; this file
 * is the panel, the drop target and the reporting around them.
 */

import { parseGeoJson } from '../geo/geojson.js';
import {
  matchupStations, matchupSummary, matchupTable, parseStationCsv, StationParseError,
  type MatchupFrame,
} from '../live/matchup.js';

export interface ImportPanelOptions {
  /** Adopts a ring as the drawn area (same path as a hand-drawn polygon). */
  onRegion(points: Array<[number, number]>, name: string): void;
  /** Dated frames of the CURRENT layer, newest last, for collocation. */
  frames(): MatchupFrame[];
  /** Column name for the sampled value, e.g. `sst_degC`. */
  valueColumn(): string;
  /** Grid cell size in degrees, so the report can state how far a "match" may actually be. */
  cellDeg(): number | undefined;
  /** Frame the map is showing, so untimed stations match what is on screen. */
  currentDate(): string | undefined;
  /** Host CSV writer, so a match-up file carries the same provenance header the map's exports do. */
  exportCsv(name: string, header: string[], rows: Array<Array<string | number>>, provenance: string[]): void;
  /** Provenance lines describing the current layer/product. */
  provenance(what: string): string[];
  makeDraggable?: (panel: HTMLElement, handle: HTMLElement) => void;
}

export interface ImportPanel {
  toggle(): void;
  open(): void;
  /**
   * Imports from a URL (including a `data:` one) instead of a picked file — what a `?stations=` or
   * `?region=` deeplink uses, so a study setup travels in a link the way the drawn `?shape=` does.
   */
  importUrl(url: string): Promise<void>;
}

export function installImportPanel(opts: ImportPanelOptions): ImportPanel {
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };

  const panel = document.createElement('div');
  panel.id = 'import-panel';
  css(panel, 'position:fixed;z-index:13;right:12px;top:64px;width:460px;max-width:92vw;max-height:78vh;'
    + 'overflow-y:auto;display:none;background:rgba(8,10,14,0.94);border-radius:6px;padding:10px 12px;'
    + 'font-family:ui-monospace,monospace;color:#dfeef0;font-size:12px;'
    + 'box-shadow:0 6px 32px rgba(0,0,0,0.6);border:1px solid rgba(94,240,200,0.22)');

  const header = document.createElement('div');
  css(header, 'display:flex;align-items:center;gap:8px;margin-bottom:6px;color:#5ef0c8;'
    + 'cursor:move;user-select:none;touch-action:none');
  const title = document.createElement('span');
  css(title, 'flex:1;letter-spacing:0.5px');
  title.textContent = 'Your data';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  css(closeBtn, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0');
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
  header.append(title, closeBtn);

  const intro = document.createElement('div');
  css(intro, 'color:#8fa5ab;line-height:1.5;margin-bottom:8px');
  intro.textContent = 'Drop a file anywhere on the map, or pick one below. '
    + 'GeoJSON becomes the analysis region; a CSV of stations is collocated against the layer on screen.';

  /** Where results and errors land — rebuilt per import. */
  const report = document.createElement('div');
  css(report, 'margin-top:8px;line-height:1.5');

  function say(html: string, tone: 'ok' | 'warn' | 'err' = 'ok'): HTMLDivElement {
    const d = document.createElement('div');
    css(d, `margin-top:4px;color:${tone === 'err' ? '#ff9b9b' : tone === 'warn' ? '#dfa94e' : '#dfeef0'}`);
    d.innerHTML = html;
    report.appendChild(d);
    return d;
  }

  const btnCss = 'cursor:pointer;background:#2a2a38;color:#5ef0c8;border:1px solid #444;'
    + 'border-radius:4px;padding:3px 10px;font-size:11px;font-family:inherit';

  function fileRow(label: string, accept: string, onFile: (f: File) => void): HTMLDivElement {
    const r = document.createElement('div');
    css(r, 'display:flex;align-items:center;gap:8px;margin:5px 0');
    const l = document.createElement('span');
    css(l, 'width:104px;flex:none;color:#8fa5ab;text-align:right');
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    css(input, 'flex:1;font-size:11px;font-family:inherit;color:#dfeef0');
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) {
        onFile(f);
      }
      input.value = '';   // same file twice in a row should still fire
    });
    r.append(l, input);
    return r;
  }

  // ── GeoJSON → analysis region ───────────────────────────────────────────────────────

  function importGeoJson(name: string, text: string): void {
    report.textContent = '';
    let parsed;
    try {
      parsed = parseGeoJson(JSON.parse(text));
    } catch (e) {
      say(`Could not read ${name} as GeoJSON: ${(e as Error).message}`, 'err');
      return;
    }
    const file = { name };
    if (parsed.polygons.length === 0) {
      const other = parsed.lines.length + parsed.points.length;
      say(`${file.name} has no polygons${other > 0 ? ` (found ${other} line/point features instead)` : ''} — `
        + 'an analysis region needs a Polygon or MultiPolygon.', 'err');
      return;
    }
    // The outer ring of the first polygon. Holes and extra parts are ignored rather than silently
    // unioned: the region test downstream is a single even-odd ring, so pretending otherwise would
    // report an area the analysis is not actually using.
    const poly = parsed.polygons[0];
    const ring = poly.rings[0].map((p) => [p[0], p[1]] as [number, number]);
    if (ring.length < 3) {
      say(`${file.name}'s first polygon has fewer than 3 vertices.`, 'err');
      return;
    }
    // Prefer the feature's own name over the file's — a boundary file usually says what it is.
    const label = String(poly.properties?.name ?? poly.properties?.NAME ?? poly.id ?? name);
    opts.onRegion(ring, label);
    say(`Region set: <b>${label}</b> — ${ring.length} vertices${label === name ? '' : ` (from ${name})`}.`);
    if (parsed.polygons.length > 1) {
      say(`The file has ${parsed.polygons.length} polygons; used the first. Split them into separate `
        + 'files to analyze each one.', 'warn');
    }
    if (poly.rings.length > 1) {
      say(`Ignored ${poly.rings.length - 1} interior ring(s) — the region test uses the outer boundary only.`, 'warn');
    }
  }

  // ── Station CSV → match-ups ─────────────────────────────────────────────────────────

  function importStations(name: string, text: string): void {
    report.textContent = '';
    let parse;
    try {
      parse = parseStationCsv(text);
    } catch (e) {
      say(`${name}: ${e instanceof StationParseError ? e.message : (e as Error).message}`, 'err');
      return;
    }
    const file = { name };
    const frames = opts.frames();
    if (frames.length === 0) {
      say('No frames are loaded for the current layer yet — wait for it to finish loading, then try again.', 'err');
      return;
    }
    const rows = matchupStations(parse.stations, frames, { fallbackDate: opts.currentDate() });
    const s = matchupSummary(rows);

    // Say which columns were guessed BEFORE the numbers: matching the wrong column is the failure
    // that produces confident nonsense, and it is invisible once the values are on screen.
    const cols = [`lon=<b>${parse.matched.lon}</b>`, `lat=<b>${parse.matched.lat}</b>`,
      parse.matched.time ? `time=<b>${parse.matched.time}</b>` : 'no time column (matched to the frame on screen)',
      parse.matched.id ? `id=<b>${parse.matched.id}</b>` : 'no id column (using row numbers)'];
    say(`<b>${file.name}</b> · ${parse.stations.length} stations · ${cols.join(' · ')}`);
    say(`Matched <b>${s.ok}</b> of ${s.total}`
      + `${s.noData > 0 ? ` · ${s.noData} fell where the product has no data (land, ice or cloud)` : ''}`
      + `${s.noFrame > 0 ? ` · ${s.noFrame} had no frame within 16 days` : ''}`,
    s.ok === 0 ? 'err' : s.ok < s.total ? 'warn' : 'ok');
    // How far a "match" can actually be. At 0.5° a cell is ~55 km across, so a station a few km
    // inland still lands in an ocean cell and comes back with a perfectly plausible number — the
    // single most important caveat on a collocated file, and invisible once it is a column of values.
    const cell = opts.cellDeg();
    if (cell) {
      const km = cell * 111;
      say(`Collocated to the nearest ${cell.toFixed(2)}° cell — a value may come from up to `
        + `~${Math.round(km / 2)} km away, so a coastal station can sample open water (and vice versa).`, 'warn');
    }
    if (parse.skipped.length > 0) {
      const shown = parse.skipped.slice(0, 4).map((k) => `line ${k.line}: ${k.reason}`).join('<br>');
      say(`Skipped ${parse.skipped.length} row(s):<br>${shown}`
        + (parse.skipped.length > 4 ? `<br>…and ${parse.skipped.length - 4} more` : ''), 'warn');
    }
    if (s.ok > 0) {
      const dl = document.createElement('button');
      dl.textContent = `⤓ Download match-ups (${s.total} rows)`;
      css(dl, `${btnCss};margin-top:7px`);
      dl.addEventListener('click', () => {
        const t = matchupTable(rows, opts.valueColumn());
        opts.exportCsv(`matchup_${file.name.replace(/\.[^.]+$/, '')}`, t.header, t.rows,
          opts.provenance('a station match-up (values sampled at uploaded points, nearest frame in time)'));
      });
      report.appendChild(dl);
      const note = document.createElement('div');
      css(note, 'margin-top:5px;color:#8fa5ab;line-height:1.45');
      note.textContent = 'Every station is exported, including the ones with no value — a match-up '
        + 'file that quietly drops its misses tells you nothing about coverage. The status column '
        + 'separates "no data here" from "no frame for that date".';
      report.appendChild(note);
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────────────

  /** Routes by extension, falling back to sniffing the content when there isn't a useful one. */
  function importText(name: string, text: string): void {
    const n = name.toLowerCase();
    const looksJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    if (n.endsWith('.geojson') || n.endsWith('.json') || (!n.match(/\.(csv|tsv|txt)$/) && looksJson)) {
      importGeoJson(name, text);
    } else if (n.match(/\.(csv|tsv|txt)$/) || !looksJson) {
      importStations(name, text);
    } else {
      report.textContent = '';
      say(`Don't know what to do with ${name} — expected .geojson for a region or .csv for stations.`, 'err');
    }
    panel.style.display = 'block';
  }

  function importFile(file: File): void {
    void file.text().then((t) => importText(file.name, t)).catch((e: Error) => {
      report.textContent = '';
      say(`Could not read ${file.name}: ${e.message}`, 'err');
      panel.style.display = 'block';
    });
  }

  panel.append(header, intro,
    fileRow('region', '.geojson,.json,application/geo+json,application/json', importFile),
    fileRow('stations', '.csv,.tsv,.txt,text/csv', importFile),
    report);
  document.body.appendChild(panel);
  opts.makeDraggable?.(panel, header);

  // Drop anywhere on the page. Dragging a file onto a map is the gesture people try first, and
  // making them find a file picker for it is friction with no purpose.
  const veil = document.createElement('div');
  css(veil, 'position:fixed;inset:0;z-index:20;display:none;pointer-events:none;'
    + 'background:rgba(8,10,14,0.55);border:3px dashed rgba(94,240,200,0.7);'
    + 'align-items:center;justify-content:center;color:#5ef0c8;font-family:ui-monospace,monospace;font-size:15px');
  veil.textContent = 'Drop a GeoJSON region or a station CSV';
  document.body.appendChild(veil);

  // dragenter/leave fire per element, so count them; a bare `leave` handler flickers the veil off
  // every time the cursor crosses a child.
  let depth = 0;
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
      depth++;
      veil.style.display = 'flex';
    }
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      veil.style.display = 'none';
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    veil.style.display = 'none';
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      importFile(f);
    }
  });

  return {
    open(): void { panel.style.display = 'block'; },
    toggle(): void { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; },
    async importUrl(url: string): Promise<void> {
      // The name drives both the format routing and the exported file name; a data: URL has none,
      // so fall back to a neutral one and let importText sniff the content.
      const name = /^data:/.test(url) ? 'pasted' : (url.split('/').pop()?.split('?')[0] || 'imported');
      try {
        const r = await fetch(url);
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        importText(name, await r.text());
      } catch (e) {
        report.textContent = '';
        say(`Could not load ${url.slice(0, 80)}${url.length > 80 ? '…' : ''}: ${(e as Error).message}`, 'err');
        panel.style.display = 'block';
      }
    },
  };
}
