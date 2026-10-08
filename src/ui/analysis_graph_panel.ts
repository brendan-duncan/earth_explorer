/**
 * Node-graph editor for analysis programs — the GRAPH front end of the analysis graph
 * (TODO/geo-analysis-graph.md §8). The canvas edits the same flat {@link AnalysisProgram}
 * AST the presets build and Claude emits: nodes are HTML cards, edges are SVG beziers, port
 * colors are the five value types, and every widget derives from the {@link OPS} metadata
 * table. Validation runs live on each edit — invalid nodes get red badges with the same
 * structured messages the LLM sees — and dragging a connection dims the ports that would
 * reject it (the validator run as a can-connect oracle).
 *
 * Navigation: drag empty canvas (or middle-mouse anywhere) to pan, wheel to zoom anchored
 * at the cursor, ⟲ to reset. Right-click adds nodes (grouped op menu) or, on a node,
 * deletes / disconnects it. Node positions live in world coordinates under a
 * translate+scale viewport transform.
 *
 * Deliberately interpreted, not code-generating: edit → Run → result is milliseconds, and
 * the program stays plain JSON for `?prog=` links and saved presets.
 */

import { OPS, type AnalysisNode, type AnalysisProgram, type OpName, type ParamValue } from '../analysis/ast.js';
import { validate, type ValidationResult } from '../analysis/validate.js';
import type { BuiltinAnalysis } from '../analysis/presets.js';
import type { ValueType } from '../analysis/types.js';

export interface AnalysisGraphEditorOptions {
  container: HTMLElement;
  /** Layer keys for the `layer` param dropdown (from the FieldStore catalog). */
  layerKeys: string[];
  /** Runs the current program through the host's shared pipeline. */
  execute(program: AnalysisProgram): Promise<unknown>;
  /** Fires when the user runs an EDITED program (chat-continuity hook). */
  onRun?(program: AnalysisProgram): void;
  /** Builds a shareable `?prog=` URL for the current program. */
  makeLink(program: AnalysisProgram): string;
  /** Curated example graphs, shown above the user's saved presets. */
  builtins?: BuiltinAnalysis[];
}

export interface AnalysisGraphEditor {
  /** Replaces the graph (positions of surviving node ids are kept). */
  setProgram(program: AnalysisProgram): void;
  getProgram(): AnalysisProgram;
}

const TYPE_COLORS: Record<ValueType, string> = {
  scalar: '#dfa94e',
  series: '#5ef0c8',
  field: '#b9c6ff',
  stack: '#6f9bff',
  region: '#8ef78e',
};
const SINK_COLOR = '#8fa5ab';
const PRESETS_STORAGE = 'earth_explorer_analysis_graph_presets';
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

/** Right-click add-node menu, grouped the way the design doc groups the op catalog. */
const MENU_GROUPS: Array<{ label: string; ops: OpName[] }> = [
  { label: 'sources', ops: ['layer', 'enso', 'region', 'forecast'] },
  { label: 'transform', ops: ['mask', 'anomaly', 'lag', 'selectFrames'] },
  { label: 'reduce', ops: ['areaMean', 'timeReduce', 'trend'] },
  { label: 'combine', ops: ['math', 'correlate', 'correlateSeries', 'regress'] },
  { label: 'sinks', ops: ['display', 'chart', 'answer'] },
];

interface NodeEntry {
  node: AnalysisNode;
  x: number;
  y: number;
  el?: HTMLDivElement;
}

export function buildAnalysisGraphEditor(opts: AnalysisGraphEditorOptions): AnalysisGraphEditor {
  const css = (el: HTMLElement | SVGElement, s: string): void => { el.setAttribute('style', s); };
  const ctrl = 'background:#12141a;color:#dfeef0;border:1px solid #444;border-radius:4px;font-size:12px;padding:2px 4px';
  const btnCss = 'cursor:pointer;background:#2a2a38;color:#dfeef0;border:1px solid #444;border-radius:4px;height:26px;padding:0 10px;font-size:13px;font-family:inherit';

  const nodes = new Map<string, NodeEntry>();
  let counter = 1;

  // ── Toolbar ─────────────────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  css(toolbar, 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px');

  const runBtn = document.createElement('button');
  css(runBtn, `${btnCss};color:#5ef0c8`);
  runBtn.textContent = '▶ Run';
  const linkBtn = document.createElement('button');
  css(linkBtn, btnCss);
  linkBtn.textContent = '🔗 Copy link';
  linkBtn.title = 'Copy a link that opens this program and runs it';
  const viewBtn = document.createElement('button');
  css(viewBtn, `${btnCss};width:26px;padding:0`);
  viewBtn.textContent = '⟲';
  viewBtn.title = 'Reset pan/zoom';

  const presetSel = document.createElement('select');
  css(presetSel, ctrl);
  const presetName = document.createElement('input');
  presetName.type = 'text';
  presetName.placeholder = 'preset name';
  css(presetName, `${ctrl};width:100px`);
  presetName.autocomplete = 'off';
  const saveBtn = document.createElement('button');
  css(saveBtn, btnCss);
  saveBtn.textContent = '💾';
  saveBtn.title = 'Save the current program as a named preset (stored locally)';
  const delBtn = document.createElement('button');
  css(delBtn, btnCss);
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete the selected preset';

  const hint = document.createElement('span');
  hint.textContent = 'right-click: add · drag: pan · wheel: zoom';
  css(hint, 'color:#667;font-size:12px');

  toolbar.append(runBtn, linkBtn, viewBtn, presetSel, presetName, saveBtn, delBtn, hint);

  const issueLine = document.createElement('div');
  css(issueLine, 'color:#ffb4a4;font-size:12px;min-height:14px;margin-bottom:4px;white-space:pre-wrap');

  // ── Canvas + transformed viewport ───────────────────────────────────────────────────
  const canvas = document.createElement('div');
  // Capped height: the run's status line and result plots live BELOW this canvas in the
  // panel — an uncapped 46vh canvas pushes them out of view on tall windows.
  css(canvas, 'position:relative;overflow:hidden;height:clamp(240px, 38vh, 480px);background:rgba(255,255,255,0.03);border-radius:4px;border:1px solid #333;touch-action:none');
  const viewport = document.createElement('div');
  css(viewport, 'position:absolute;left:0;top:0;transform-origin:0 0');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  css(svg, 'position:absolute;left:0;top:0;pointer-events:none');
  const layer = document.createElement('div');
  css(layer, 'position:absolute;left:0;top:0');
  viewport.append(svg, layer);
  canvas.appendChild(viewport);

  opts.container.append(toolbar, issueLine, canvas);

  let panX = 20, panY = 10, zoom = 1;
  function applyView(): void {
    viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  function resetView(): void {
    panX = 20; panY = 10; zoom = 1;
    applyView();
  }
  viewBtn.addEventListener('click', resetView);
  applyView();

  /** Screen point → world (pre-transform) coordinates. */
  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const c = canvas.getBoundingClientRect();
    return { x: (clientX - c.left - panX) / zoom, y: (clientY - c.top - panY) / zoom };
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = canvas.getBoundingClientRect();
    const mx = e.clientX - c.left;
    const my = e.clientY - c.top;
    const wx = (mx - panX) / zoom;
    const wy = (my - panY) / zoom;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * Math.exp(-e.deltaY * 0.0015)));
    panX = mx - wx * zoom;   // keep the world point under the cursor fixed
    panY = my - wy * zoom;
    applyView();
  }, { passive: false });

  // ── Saved presets ───────────────────────────────────────────────────────────────────
  function loadPresets(): Record<string, AnalysisProgram> {
    try {
      return JSON.parse(localStorage.getItem(PRESETS_STORAGE) ?? '{}') as Record<string, AnalysisProgram>;
    } catch {
      return {};
    }
  }
  function refreshPresetSel(): void {
    presetSel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'examples…';
    presetSel.appendChild(first);
    const builtins = opts.builtins ?? [];
    if (builtins.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'built-in';
      builtins.forEach((b, i) => {
        const o = document.createElement('option');
        o.value = `b:${i}`;
        o.textContent = b.name;
        o.title = b.description;
        group.appendChild(o);
      });
      presetSel.appendChild(group);
    }
    const mine = Object.keys(loadPresets()).sort();
    if (mine.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'mine';
      for (const name of mine) {
        const o = document.createElement('option');
        o.value = `u:${name}`;
        o.textContent = name;
        group.appendChild(o);
      }
      presetSel.appendChild(group);
    }
  }
  refreshPresetSel();
  saveBtn.addEventListener('click', () => {
    const name = presetName.value.trim();
    if (!name) {
      return;
    }
    const all = loadPresets();
    all[name] = getProgram();
    localStorage.setItem(PRESETS_STORAGE, JSON.stringify(all));
    presetName.value = '';
    refreshPresetSel();
    presetSel.value = `u:${name}`;
  });
  presetSel.addEventListener('change', () => {
    const v = presetSel.value;
    if (v.startsWith('b:')) {
      const b = (opts.builtins ?? [])[parseInt(v.slice(2), 10)];
      if (b) {
        setProgram(structuredClone(b.program));
      }
    } else if (v.startsWith('u:')) {
      const p = loadPresets()[v.slice(2)];
      if (p) {
        setProgram(structuredClone(p));
      }
    }
  });
  delBtn.addEventListener('click', () => {
    if (!presetSel.value.startsWith('u:')) {
      return;   // built-ins can't be deleted
    }
    const all = loadPresets();
    delete all[presetSel.value.slice(2)];
    localStorage.setItem(PRESETS_STORAGE, JSON.stringify(all));
    refreshPresetSel();
  });

  // ── Model ───────────────────────────────────────────────────────────────────────────
  function getProgram(): AnalysisProgram {
    return { nodes: [...nodes.values()].map((e) => structuredClone(e.node)) };
  }

  function uniqueId(op: OpName): string {
    let id = `${op}${counter++}`;
    while (nodes.has(id)) {
      id = `${op}${counter++}`;
    }
    return id;
  }

  /** Column-by-dependency-depth auto-layout for nodes without a stored position. */
  function autoLayout(fresh: string[]): void {
    const depth = new Map<string, number>();
    const compute = (id: string, seen: Set<string>): number => {
      const hit = depth.get(id);
      if (hit !== undefined) {
        return hit;
      }
      if (seen.has(id)) {
        return 0;   // cycle — validation reports it; layout just needs to not hang
      }
      seen.add(id);
      const entry = nodes.get(id);
      let d = 0;
      for (const ref of Object.values(entry?.node.inputs ?? {})) {
        if (nodes.has(ref)) {
          d = Math.max(d, compute(ref, seen) + 1);
        }
      }
      depth.set(id, d);
      return d;
    };
    for (const id of nodes.keys()) {
      compute(id, new Set());
    }
    const rows = new Map<number, number>();
    for (const id of fresh) {
      const e = nodes.get(id)!;
      const d = depth.get(id) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      e.x = 16 + d * 218;
      e.y = 14 + row * 165;
    }
  }

  function setProgram(program: AnalysisProgram): void {
    const keep = new Map<string, { x: number; y: number }>();
    for (const [id, e] of nodes) {
      keep.set(id, { x: e.x, y: e.y });
    }
    nodes.clear();
    const fresh: string[] = [];
    for (const node of program.nodes) {
      const pos = keep.get(node.id);
      nodes.set(node.id, { node: structuredClone(node), x: pos?.x ?? 0, y: pos?.y ?? 0 });
      if (!pos) {
        fresh.push(node.id);
      }
    }
    autoLayout(fresh);
    resetView();
    render();
  }

  function addNode(op: OpName, x: number, y: number): void {
    const id = uniqueId(op);
    // Auto-pick the first enum value for required enum params (layer gets the catalog's first).
    const params: Record<string, ParamValue> = {};
    for (const [name, p] of Object.entries(OPS[op].params)) {
      if (p.required && p.enum) {
        params[name] = p.enum[0];
      }
      if (op === 'layer' && name === 'layer' && opts.layerKeys.length > 0) {
        params[name] = opts.layerKeys[0];
      }
    }
    nodes.set(id, { node: { id, op, ...(Object.keys(params).length > 0 ? { params } : {}) }, x, y });
    render();
  }

  function removeNode(id: string): void {
    nodes.delete(id);
    for (const e of nodes.values()) {
      for (const [port, ref] of Object.entries(e.node.inputs ?? {})) {
        if (ref === id) {
          delete e.node.inputs![port];
        }
      }
    }
    render();
  }

  function disconnect(id: string, port: string): void {
    const e = nodes.get(id);
    if (e?.node.inputs) {
      delete e.node.inputs[port];
      render();
    }
  }

  /** Type + cycle gate for a tentative connection, via the validator as oracle. */
  function canConnect(fromId: string, toId: string, port: string, types: ValidationResult['types']): boolean {
    if (fromId === toId) {
      return false;
    }
    const to = nodes.get(toId);
    const spec = to ? OPS[to.node.op] : undefined;
    const portSpec = spec?.inputs[port];
    const outType = types.get(fromId);
    if (!portSpec || outType === null || (outType && !portSpec.types.includes(outType))) {
      return false;
    }
    // Cycle check: validate the candidate program.
    const candidate = getProgram();
    const target = candidate.nodes.find((n) => n.id === toId)!;
    target.inputs = { ...target.inputs, [port]: fromId };
    return !validate(candidate).errors.some((i) => i.message.includes('cycle'));
  }

  // ── Context menu (right-click: add nodes / act on a node) ───────────────────────────
  const menu = document.createElement('div');
  css(menu, 'position:fixed;z-index:30;display:none;background:rgba(12,16,22,0.97);border:1px solid #444;'
    + 'border-radius:6px;font-family:ui-monospace,monospace;font-size:13px;color:#dfeef0;'
    + 'box-shadow:0 2px 10px rgba(0,0,0,0.6);padding:4px;max-height:60vh;overflow-y:auto');
  document.body.appendChild(menu);

  function menuItem(label: string, title: string, onPick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.textContent = label;
    item.title = title;
    css(item, 'padding:3px 10px;border-radius:4px;cursor:pointer;white-space:nowrap');
    item.addEventListener('pointerenter', () => { item.style.background = '#2a3a44'; });
    item.addEventListener('pointerleave', () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      closeMenu();
      onPick();
    });
    return item;
  }

  function closeMenu(): void {
    menu.style.display = 'none';
  }
  document.addEventListener('pointerdown', (e) => {
    if (menu.style.display !== 'none' && !menu.contains(e.target as Node)) {
      closeMenu();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  function openMenu(clientX: number, clientY: number, nodeId: string | null): void {
    menu.innerHTML = '';
    if (nodeId) {
      const entry = nodes.get(nodeId);
      const header = document.createElement('div');
      header.textContent = `${entry?.node.op} · ${nodeId}`;
      css(header, 'padding:2px 10px 4px;color:#5ef0c8');
      menu.appendChild(header);
      menu.appendChild(menuItem('✕ delete node', 'Remove this node (its edges go with it)', () => removeNode(nodeId)));
      if (Object.keys(entry?.node.inputs ?? {}).length > 0) {
        menu.appendChild(menuItem('⋯ disconnect inputs', 'Clear every input connection of this node', () => {
          const e = nodes.get(nodeId);
          if (e) {
            delete e.node.inputs;
            render();
          }
        }));
      }
    } else {
      const at = toWorld(clientX, clientY);
      for (const group of MENU_GROUPS) {
        const header = document.createElement('div');
        header.textContent = group.label;
        css(header, 'padding:3px 10px 1px;color:#8fa5ab;font-size:11px;letter-spacing:1px;text-transform:uppercase');
        menu.appendChild(header);
        for (const op of group.ops) {
          menu.appendChild(menuItem(op, OPS[op].description, () => addNode(op, at.x, at.y)));
        }
      }
    }
    menu.style.display = 'block';
    // Clamp on-screen (menu must be visible to measure).
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(clientX, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(clientY, window.innerHeight - r.height - 8)}px`;
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
    openMenu(e.clientX, e.clientY, nodeEl?.dataset.node ?? null);
  });

  // ── Rendering ───────────────────────────────────────────────────────────────────────
  let lastValidation: ValidationResult | null = null;

  function paramWidget(entry: NodeEntry, name: string): HTMLElement {
    const spec = OPS[entry.node.op].params[name];
    const value = entry.node.params?.[name];
    const commit = (v: ParamValue | undefined): void => {
      entry.node.params ??= {};
      if (v === undefined || v === '') {
        delete entry.node.params[name];
      } else {
        entry.node.params[name] = v;
      }
      render();
    };
    if (spec.type === 'boolean') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = value === true;
      box.addEventListener('change', () => commit(box.checked || undefined));
      return box;
    }
    const enumValues = entry.node.op === 'layer' && name === 'layer' ? opts.layerKeys : spec.enum ? [...spec.enum] : null;
    if (enumValues) {
      const sel = document.createElement('select');
      css(sel, `${ctrl};max-width:112px`);
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = spec.required ? '(pick)' : '—';
      sel.appendChild(blank);
      for (const v of enumValues) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      }
      sel.value = typeof value === 'string' ? value : '';
      sel.addEventListener('change', () => commit(sel.value || undefined));
      return sel;
    }
    const input = document.createElement('input');
    input.type = spec.type === 'number' ? 'number' : 'text';
    css(input, `${ctrl};width:${spec.type === 'number' ? 60 : 100}px`);
    input.autocomplete = 'off';
    input.title = spec.description;
    if (value !== undefined) {
      input.value = String(value);
    }
    input.placeholder = spec.required ? 'required' : '';
    input.addEventListener('change', () => {
      if (spec.type === 'number') {
        const n = parseFloat(input.value);
        commit(Number.isFinite(n) ? n : undefined);
      } else {
        commit(input.value || undefined);
      }
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return input;
  }

  function buildNodeEl(entry: NodeEntry, v: ValidationResult): void {
    const { node } = entry;
    const spec = OPS[node.op];
    const el = document.createElement('div');
    entry.el = el;
    el.dataset.node = node.id;
    const issues = v.errors.filter((i) => i.node === node.id);
    css(el, `position:absolute;left:${entry.x}px;top:${entry.y}px;width:190px;background:rgba(16,20,28,0.95);`
      + `border:1px solid ${issues.length > 0 ? '#c05040' : '#3a4048'};border-radius:6px;font-size:12px;user-select:none`);
    if (issues.length > 0) {
      el.title = issues.map((i) => i.message).join('\n');
    }

    const head = document.createElement('div');
    css(head, 'display:flex;align-items:center;gap:5px;padding:4px 6px;background:rgba(255,255,255,0.05);border-radius:6px 6px 0 0;cursor:grab');
    head.dataset.drag = node.id;
    const name = document.createElement('span');
    name.textContent = node.op;
    name.title = spec.description;
    css(name, `flex:1;color:${spec.sink ? SINK_COLOR : '#dfeef0'};pointer-events:none`);
    const idLabel = document.createElement('span');
    idLabel.textContent = node.id;
    css(idLabel, 'color:#667;pointer-events:none');
    const del = document.createElement('button');
    del.textContent = '×';
    css(del, 'cursor:pointer;background:none;border:none;color:#889;font-size:14px;padding:0 1px');
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => removeNode(node.id));
    head.append(name, idLabel, del);
    // Output dot (sinks have no output).
    const outType = v.types.get(node.id);
    if (!spec.sink) {
      const dot = document.createElement('span');
      dot.dataset.out = node.id;
      css(dot, `position:absolute;right:-5px;top:11px;width:10px;height:10px;border-radius:50%;cursor:crosshair;`
        + `background:${outType ? TYPE_COLORS[outType] : '#666'};border:1px solid #111`);
      dot.title = `output: ${outType ?? '?'} — drag to an input port`;
      el.appendChild(dot);
    }
    el.appendChild(head);

    // Input ports.
    for (const [port, portSpec] of Object.entries(spec.inputs)) {
      const rowEl = document.createElement('div');
      css(rowEl, 'position:relative;display:flex;align-items:center;gap:5px;padding:2px 6px 2px 10px');
      const dot = document.createElement('span');
      dot.dataset.in = `${node.id}|${port}`;
      css(dot, `position:absolute;left:-5px;top:6px;width:10px;height:10px;border-radius:50%;cursor:crosshair;`
        + `background:${TYPE_COLORS[portSpec.types[0]]};border:1px solid #111`);
      dot.title = `${port}: ${portSpec.types.join(' | ')}${portSpec.required ? '' : ' (optional)'} — click to disconnect`;
      dot.addEventListener('click', () => disconnect(node.id, port));
      const label = document.createElement('span');
      label.textContent = `${port}${portSpec.required ? '' : '?'}`;
      css(label, `color:${node.inputs?.[port] ? '#dfeef0' : '#778'}`);
      rowEl.append(dot, label);
      el.appendChild(rowEl);
    }

    // Params.
    for (const pName of Object.keys(spec.params)) {
      const rowEl = document.createElement('div');
      css(rowEl, 'display:flex;align-items:center;gap:4px;padding:2px 6px');
      const label = document.createElement('span');
      label.textContent = pName;
      css(label, 'color:#8fa5ab;width:62px;flex:none;overflow:hidden;text-overflow:ellipsis');
      label.title = spec.params[pName].description;
      rowEl.append(label, paramWidget(entry, pName));
      el.appendChild(rowEl);
    }

    layer.appendChild(el);
  }

  /** Center of a port dot in WORLD coordinates (rects are post-transform → divide back). */
  function dotCenter(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return {
      x: (r.left + r.width / 2 - c.left - panX) / zoom,
      y: (r.top + r.height / 2 - c.top - panY) / zoom,
    };
  }

  function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const dx = Math.max(30, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  function redrawEdges(): void {
    // Size the world layers to the content extent (the viewport transform handles the rest).
    let w = 600, h = 400;
    for (const e of nodes.values()) {
      w = Math.max(w, e.x + 220);
      h = Math.max(h, e.y + 200);
    }
    css(layer, `position:absolute;left:0;top:0;width:${w}px;height:${h}px`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    css(svg, 'position:absolute;left:0;top:0;pointer-events:none');
    svg.innerHTML = '';
    for (const e of nodes.values()) {
      for (const [port, ref] of Object.entries(e.node.inputs ?? {})) {
        const from = layer.querySelector(`[data-out="${CSS.escape(ref)}"]`);
        const to = layer.querySelector(`[data-in="${CSS.escape(`${e.node.id}|${port}`)}"]`);
        if (!from || !to) {
          continue;
        }
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', edgePath(dotCenter(from), dotCenter(to)));
        const outType = lastValidation?.types.get(ref);
        path.setAttribute('stroke', outType ? TYPE_COLORS[outType] : '#666');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', '0.75');
        css(path, 'pointer-events:stroke;cursor:pointer');
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${ref} → ${e.node.id}.${port} — click to disconnect`;
        path.appendChild(title);
        path.addEventListener('click', () => disconnect(e.node.id, port));
        svg.appendChild(path);
      }
    }
  }

  function render(): void {
    layer.innerHTML = '';
    const v = validate(getProgram());
    lastValidation = v;
    for (const entry of nodes.values()) {
      buildNodeEl(entry, v);
    }
    const shown = v.errors.slice(0, 3).map((i) => `${i.node ? `[${i.node}] ` : ''}${i.message}`);
    issueLine.textContent = shown.join('\n') + (v.errors.length > 3 ? `\n… ${v.errors.length - 3} more` : '');
    requestAnimationFrame(redrawEdges);
  }

  // ── Interactions: connect / drag node / pan ─────────────────────────────────────────
  let dragNode: { id: string; dx: number; dy: number } | null = null;
  let connect: { from: string; path: SVGPathElement } | null = null;
  let pan: { startX: number; startY: number; panX: number; panY: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    closeMenu();
    if (e.button === 2) {
      return;   // contextmenu handles right-click
    }
    const t = e.target as HTMLElement;
    if (e.button === 0 && t.dataset.out) {
      // Start dragging a new edge from this output; dim incompatible ports.
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('stroke', '#dfeef0');
      path.setAttribute('stroke-dasharray', '4 3');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
      connect = { from: t.dataset.out, path };
      const types = lastValidation ?? validate(getProgram());
      for (const dot of layer.querySelectorAll<HTMLElement>('[data-in]')) {
        const [toId, port] = dot.dataset.in!.split('|');
        dot.style.opacity = canConnect(connect.from, toId, port, types.types) ? '1' : '0.15';
      }
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    const dragId = e.button === 0 ? (t.dataset.drag ?? t.closest<HTMLElement>('[data-drag]')?.dataset.drag) : undefined;
    if (dragId) {
      const entry = nodes.get(dragId)!;
      const at = toWorld(e.clientX, e.clientY);
      dragNode = { id: dragId, dx: at.x - entry.x, dy: at.y - entry.y };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    // Empty canvas (left) or middle button anywhere → pan.
    const onNode = Boolean(t.closest('[data-node]'));
    if (e.button === 1 || (e.button === 0 && !onNode)) {
      pan = { startX: e.clientX, startY: e.clientY, panX, panY };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragNode) {
      const entry = nodes.get(dragNode.id)!;
      const at = toWorld(e.clientX, e.clientY);
      entry.x = Math.max(0, at.x - dragNode.dx);
      entry.y = Math.max(0, at.y - dragNode.dy);
      if (entry.el) {
        entry.el.style.left = `${entry.x}px`;
        entry.el.style.top = `${entry.y}px`;
      }
      redrawEdges();
    } else if (connect) {
      const from = layer.querySelector(`[data-out="${CSS.escape(connect.from)}"]`);
      if (from) {
        connect.path.setAttribute('d', edgePath(dotCenter(from), toWorld(e.clientX, e.clientY)));
      }
    } else if (pan) {
      panX = pan.panX + (e.clientX - pan.startX);
      panY = pan.panY + (e.clientY - pan.startY);
      applyView();
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (connect) {
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const dataIn = target?.dataset.in ?? target?.closest<HTMLElement>('[data-in]')?.dataset.in;
      const types = lastValidation ?? validate(getProgram());
      if (dataIn) {
        const [toId, port] = dataIn.split('|');
        if (canConnect(connect.from, toId, port, types.types)) {
          const entry = nodes.get(toId)!;
          entry.node.inputs = { ...entry.node.inputs, [port]: connect.from };
        }
      }
      connect.path.remove();
      connect = null;
      render();   // also restores port opacities
    }
    dragNode = null;
    if (pan) {
      pan = null;
      canvas.style.cursor = '';
    }
  });

  runBtn.addEventListener('click', () => {
    const program = getProgram();
    opts.onRun?.(program);
    void opts.execute(program);
  });

  linkBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(opts.makeLink(getProgram())).then(() => {
      linkBtn.textContent = '✓ Copied';
      setTimeout(() => { linkBtn.textContent = '🔗 Copy link'; }, 1500);
    });
  });

  render();
  return { setProgram, getProgram };
}
