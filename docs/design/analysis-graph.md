# Geo Analysis Graph — design

A small, typed dataflow language over the GIS explorer's gridded data, with three front ends:
a JSON AST any code can build, a Claude tool that writes programs to answer natural-language
questions ("is there a correlation between sea temperature and wind?"), and (later) a node-graph
editor that renders and edits the same AST. One interpreter serves all three.

Home: analysis core in `src/analysis/`, UI + Claude front end in `src/main.ts` and `src/ui/`
(like the ENSO panel).

## Goals

- Answer correlation / trend / anomaly / composite questions over the explorer's layers,
  entirely client-side, on the CPU cells the fields already retain.
- One interpreter, three front ends: presets (the old fixed "tools"), an LLM that emits whole
  programs in one tool call, and a visual graph the user can inspect and edit.
- Results are *shown*, not just told: a correlation map becomes a displayed derived layer, a
  time series becomes a chart, exactly like today's analysis views.
- Safe by construction: no eval, no network access from programs, bounded cost, structured
  errors an LLM can self-correct from.

## Non-goals (v1)

- No control flow (loops, conditionals, recursion). Pure dataflow DAG. Every op is
  O(cells × frames) and obviously terminating; this is what keeps the interpreter trivially
  safe and the node UI clean.
- No GPU compute path (CPU cells are 720×360 at most; a per-cell temporal correlation over a
  30-frame stack is ~10M ops — fine in a worker).
- No new data sources. Programs consume the layers the explorer already knows
  (`LAYERS` + wind/currents + ENSO).

---

## 1. Value model

Edges carry one of five value types. The type tags are what make it a language: ops declare
signatures, and the graph validates before it runs.

```ts
type ValueType = 'scalar' | 'series' | 'field' | 'stack' | 'region';

/** CPU-only field — decoupled from GriddedField so it can cross a Worker boundary. */
interface CpuField {
  width: number; height: number;          // equirect, row 0 = north (GriddedField contract)
  date: string;                           // ISO date, or a span label for reductions
  values: Float32Array;                   // PHYSICAL values (already decoded), NaN = invalid
  unit: Unit;                             // see §1.1
}

interface CpuStack { frames: CpuField[]; }               // sorted by date
interface Series   { t: Float64Array; v: Float64Array; unit: Unit; label: string; }
interface Scalar   { v: number; unit: Unit; label: string; }
type Region = { kind: 'bbox'; lonMin: number; latMin: number; lonMax: number; latMax: number }
            | { kind: 'preset'; name: 'nino34' | 'gulf-stream' | 'arctic' | 'southern-ocean' | ... };
```

Decisions:

- **Physical floats, not normalized bytes.** `GriddedField` stores a normalized byte per cell;
  the analysis boundary decodes once (`decode(values[i])`, NaN where `mask` is 0) into a
  `Float32Array`. Ops then never think about `min/max/isLog`, and derived values (an anomaly,
  a correlation) aren't clamped to the source layer's display range. Only the `display` sink
  re-normalizes (into its own legend range).
- **No vector type on the edges.** Wind and currents enter the graph already resolved to a
  scalar via a `component: 'speed' | 'u' | 'v'` param on the source op. This deletes a whole
  class of type errors and the `magnitude` op.
- **Units ride the values** (`'degC' | 'm' | 'mps' | 'percent' | 'mgm3' | 'pa' | 'wm2' |
  'mmph' | 'r' | 'none'`, plus a `relative: boolean` flag for Δ-like quantities). Sinks use
  them to pick formatters (reusing the layers' `fmt`/`fmtRel` and the °F toggle rule: relative
  temps scale by 9/5 with no offset). `correlate` yields unit `'r'`; arithmetic between
  mismatched units is a validation warning, not an error (people legitimately regress pressure
  against temperature).

### 1.1 The analysis grid

All fields are resampled to a fixed **360×180 (1°)** analysis grid on entry (nearest-cell via
the same lookup `GriddedField.sample` uses). Rationale: every op sees one shape, so binary ops
never negotiate resolutions; 64,800 cells keeps per-cell temporal stats interactive; and 1° is
at or below the native resolution of every feed except OISST at stride 2 (0.5°), where nearest
sampling loses nothing that matters for correlation/trend questions. If sub-degree analysis is
ever needed, the grid becomes a program-level knob — the ops don't change.

---

## 2. The AST

A program is a flat list of nodes referencing each other by id — **not** a recursive tree.
That's deliberate: it's the natural encoding of a DAG, it's what a node editor edits, and it
sidesteps the "no recursive schemas" limit of strict structured outputs, so Claude can be
schema-constrained to emit only valid shapes.

```ts
interface AnalysisProgram {
  nodes: AnalysisNode[];      // topological order not required; interpreter sorts
}

interface AnalysisNode {
  id: string;                                  // unique within the program
  op: OpName;                                  // enum — see §3
  inputs?: Record<string, string>;             // port name → producing node id
  params?: Record<string, string | number | boolean>;
}
```

Example — "is there a correlation between sea temperature and wind?":

```json
{ "nodes": [
  { "id": "sst",  "op": "layer", "params": { "layer": "sst",  "start": "2023-01", "end": "2026-06" } },
  { "id": "wind", "op": "layer", "params": { "layer": "wind", "component": "speed",
                                              "start": "2023-01", "end": "2026-06" } },
  { "id": "r",    "op": "correlate", "inputs": { "a": "sst", "b": "wind" },
                  "params": { "mode": "temporal" } },
  { "id": "show", "op": "display", "inputs": { "value": "r" },
                  "params": { "colormap": "balance", "title": "SST × wind speed, per-cell r" } },
  { "id": "ans",  "op": "answer",  "inputs": { "value": "r" },
                  "params": { "label": "area-weighted mean |r|" } }
] }
```

Follow-up "…only during El Niño" = the same program with one node spliced in
(`selectFrames(phase: 'elnino')` between the sources and `correlate`). This
edit-the-previous-AST pattern is what makes conversational refinement cheap for both the LLM
and the node editor.

---

## 3. Op catalog (v1)

Sixteen ops. Each row is `op(inputs) → output`; params in parentheses. All spatial reductions
are **cos(lat)-weighted** (equirect cells shrink poleward; unweighted means are Arctic-dominated).
NaN cells are excluded per-op; binary ops intersect validity.

### Sources

| Op | Signature | Notes |
|---|---|---|
| `layer` | `() → stack` (layer, start?, end?, stepMonths?, component?) | Any `LAYERS` key plus `wind` / `currents`. Vector layers require `component`. Dates are `YYYY-MM`; defaults = the explorer's `SINCE_YEAR`..now at the current step. |
| `enso` | `() → series` | Monthly ONI from `src/live/enso.ts` (baked + live merge already exists). |
| `region` | `() → region` (bbox or preset) | Presets carry their own definitions (Niño 3.4 = 5°S–5°N, 170°W–120°W, matching the shader's box). |

### Transforms (shape-preserving)

| Op | Signature | Notes |
|---|---|---|
| `mask` | `(stack\|field, region) → same` | Cells outside the region → NaN. |
| `anomaly` | `(stack) → stack` | Subtract each cell's mean over the *loaded* frames. Documented distinction: the `anom` layer is vs. NOAA's 1971–2000 climatology; this op is vs. the program's own window. Output `relative: true`. |
| `lag` | `(stack\|series, months) → same` | Shifts dates; used for lead/lag correlation ("does SST lead wind by a season?"). |
| `selectFrames` | `(stack) → stack` (months?: "12,1,2", phase?: elnino\|lanina\|neutral) | Frame filter — seasonal subsets and ENSO composites. Phase resolution reuses `eventAt()`/`oniSeasons`. |

### Reductions

| Op | Signature | Notes |
|---|---|---|
| `areaMean` | `(stack) → series`, `(field) → scalar` (region?) | THE bridge from maps to time series. cos(lat)-weighted; region defaults to global-valid. |
| `timeReduce` | `(stack) → field` (stat: mean\|min\|max\|range) | Generalizes today's `buildDerived` min/max/range views. |
| `trend` | `(stack) → field` | Per-cell least-squares slope, per decade (the `showPointSeries` trend math, mapped). Unit = source unit, `relative: true`. |

### Combinators

| Op | Signature | Notes |
|---|---|---|
| `math` | `(a, b) → same` (fn: sub\|add\|mul\|div) | Same-type pairs: field∘field, series∘series, stack∘stack (date-paired), or X∘scalar. Stacks/series pair frames by nearest date within tolerance (default: half the coarser step, like the Δ view's 62-day window); unpaired frames drop. |
| `correlate` | mode `temporal`: `(a: stack, b: stack) → field` · mode `spatial`: `(a: field\|stack, b: field\|stack) → scalar` | Temporal: per-cell Pearson r across date-paired frames (≥ 8 pairs required per cell, else NaN). Spatial: one cos(lat)-weighted r across cells (stacks are `timeReduce(mean)`-ed first). Unit `'r'`. |
| `correlateSeries` | `(a: series, b: series) → scalar` (lagMonths?) | Nearest-month pairing; for ENSO-vs-anything and point/box questions. |

### Sinks (≥ 1 required per program)

| Op | Signature | Notes |
|---|---|---|
| `display` | `(field \| stack)` (colormap?, title?, min?, max?) | Pushes the result onto the map as a derived layer (see §6). Auto-legend: r → balance ±1; trends → balance symmetric about 0; else viridis over p2..p98. |
| `chart` | `(series, series?, series?)` (title?) | Line chart panel; up to 3 series, dual axis when units differ (the ENSO strip + sparkline code is the precedent). |
| `answer` | `(scalar \| series \| field)` (label) | Structured result for the caller. For a field: area-weighted mean, mean |v|, p5/p95, % valid — i.e. what an LLM needs to narrate a map it can't see. |

Everything downstream of a sink-less node is dead code — validation warns, interpreter skips.

**Statistical honesty, encoded once:** `correlate`'s `answer` payload always includes N (pairs
or cells) and a fixed caveat flag (`spatiallyAutocorrelated: true` for grid-wide stats) so the
narrating LLM says "association", not "significance". No p-values in v1 — on gridded geodata
they'd be misleading without effective-DOF correction.

---

## 4. Interpreter

`src/analysis/interpret.ts` — no DOM, no GPU, no fetch. Runs in a Worker.

1. **Validate** — unique ids, DAG (cycle check), op names exist, required inputs/params
   present, port types match. Errors are structured:
   `{ node: "r", port: "b", expected: "stack", got: "series", hint: "wrap with areaMean? no — correlate(temporal) needs two stacks" }`.
   These go back verbatim as the tool result so the LLM self-corrects in one retry, and the
   node editor renders them as red port highlights.
2. **Plan** — topological order; prune nodes not reaching a sink; sum a **cost estimate**
   (Σ cells × frames per op) and refuse programs over a budget (~200M cell-ops) with a
   structured "narrow the date range or region" error.
3. **Execute** — straight-line walk, each op a pure function `(inputs, params) → value`.
   Post progress per node (the UI shows "correlate 3/5…" like the streaming status line).
4. **Cache** — memoize node outputs keyed by `hash(op, params, inputHashes)` (the render
   graph's pooled-resource idea). Scrubbing one param in the node editor re-runs only
   downstream. Cache lives in the worker, LRU by bytes (~256 MB).

Worker protocol: `postMessage({ program, requestId })` →
`{ requestId, progress | result | error }`. Results containing fields transfer their
`Float32Array` buffers. The worker is terminable — a runaway (shouldn't exist given the cost
gate) is one `worker.terminate()` away.

---

## 5. Data acquisition — `FieldStore`

The interpreter never fetches. A main-thread `FieldStore` resolves `layer` source nodes into
`CpuStack`s before dispatch (async), then hands the worker a fully materialized program input
set. This keeps all ERDDAP/bake logic (flip probes, baked+live merge, `streamPool`) where it
already lives.

```ts
class FieldStore {
  /** Resolve a layer+range+step to CPU fields, loading what's missing. */
  getStack(req: { layer: string; start: string; end: string; stepMonths: number;
                  component?: 'speed' | 'u' | 'v' }): Promise<CpuStack>;
}
```

- **Reuses the explorer's loaders**: baked stacks via `GriddedField.loadBakedStack`, live
  frames via `loadScalar`/`loadVector` + `sampledDates` + `streamPool`, exactly as `loadLayer`
  does — factored out of the app's display path so both call one loader module.
- **CPU-only mode.** Analysis loads don't need GPU textures. Add
  `opts.cpuOnly?: boolean` to the loaders (skip `rasterToTexture` / atlas texture copies,
  return a texture-less field or a plain cells struct). Cheap change; avoids holding a second
  copy of every stack in VRAM.
- **Vector CPU cells (required change).** `loadVector` and the vector branch of
  `loadBakedStack` currently retain no CPU cells. Retain them: decode u, v into two
  `Float32Array`s (or keep the rgba bytes and decode lazily). This also upgrades the app's
  point-analysis panel for free (wind speed sparklines at a click).
- **Cache + budget.** Keyed by `(layer, component, stepMonths)` holding a date-indexed frame
  map; ranges extend incrementally. LRU at ~300 MB CPU. Independent of the display layer's
  lifecycle — switching the displayed layer no longer evicts analysis data (and conversely,
  `clearFields()` doesn't touch the store).
- **Availability metadata.** `getCatalog()` returns per-layer coverage (date floor/ceiling,
  native resolution, units, caveats like "waves have no data poleward of ±77°") — the same
  object that renders the LLM system prompt and the node editor's source-node dropdowns.

---

## 6. Explorer integration

- **`display` sink** → the explorer gains `showAnalysisResult(fields: GriddedField[], legend: LegendSpec)`:
  converts `CpuField`s via `GriddedField.fromBytes` (normalizing into the sink's legend range),
  swaps them in as a derived stack exactly like `applyView` does (owned fields, destroyed on
  replace), sets the legend/colormap, and adds an "Analysis" chip to the view row so the user
  can flip back to `abs`. A stack result stays scrubbable on the existing timeline.
- **`chart` sink** → a panel generalizing the point-analysis sparkline (same styling); axis
  labels from units, month ticks, ENSO-phase background bands when an `enso` series is present
  (reuse the ENSO panel's band drawing).
- **`answer` sink** → rendered into the chat panel (LLM path) or the status line (preset path).
- **Placement**: per the explorer's UI conventions, the whole feature lives behind one toolbar
  toggle ("⚗ Analysis") opening a right-side panel with tabs: **Ask** (chat), **Graph**
  (program view), **Presets**. No new top-level toolbar controls.

---

## 7. Claude front end

One tool, whole programs, strict schema.

- **SDK**: `@anthropic-ai/sdk`, browser client
  `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`. Key pasted at runtime, kept in
  `localStorage`. If the explorer ever needs a shared key, a tiny `/v1/messages` proxy holds
  the key instead — only `baseURL` changes.
- **Model / params**: `claude-opus-4-8`, `thinking: { type: 'adaptive' }`, streaming, tool
  runner (`client.beta.messages.toolRunner`) so multi-round repair loops (validation error →
  fixed program) need no hand-written loop.
- **The tool**: `run_analysis` with `strict: true` and an `input_schema` that IS the AST
  schema — `nodes` as an array of an `anyOf` over per-op node shapes, op names and layer keys
  as enums, `additionalProperties: false` throughout. Flat-with-id-references means no
  recursion, so strict mode holds and Claude cannot emit an op or layer that doesn't exist.
  Tool result = the `answer` payloads + validation errors + one line noting what got displayed
  ("map now shows per-cell r, balance ±1").
- **A second, trivial tool**: `get_catalog()` → `FieldStore.getCatalog()`. Also baked into the
  system prompt; the tool exists so long conversations survive prompt truncation of details.
- **System prompt**: rendered catalog (keys, units, coverage, caveats), the op cheat-sheet
  with 3 worked example programs (correlation, ENSO composite, trend), and narration rules
  (report r with N; "association" not "causation"; state the date window used; mention the map
  when a display sink fired).
- **Conversation → graph continuity**: each `run_analysis` call's program is kept; the Graph
  tab always shows the most recent one. The user editing the graph and re-running does *not*
  go through the LLM — but the edited program is appended to the conversation as a user-turn
  note so a follow-up question starts from what the user actually ran.

Cost/latency envelope: a question is one request with 1–3 tool round-trips; tool results are
sub-KB. All grid data stays in the browser.

## 8. Node editor (phase 4)

Lives in `src/ui/analysis_graph_panel.ts`. It interprets the graph live, so an edit shows its
result in milliseconds.
Scope deliberately small:

- SVG/HTML boxes + bezier edges; ports colored by `ValueType`; connections type-checked on
  drop (invalid target ports gray out while dragging — the validator run in "can-connect"
  mode).
- Param widgets from op metadata: enums → dropdowns, dates → month pickers, region → "draw a
  box on the map" (reuses the pointer plumbing; the Niño box outline shader already proves the
  overlay).
- Run button + per-node progress/error badges; node outputs show a mini-summary on hover
  (scalar value, series sparkline, field thumbnail rendered from the CpuField).
- Serialization is just the AST, so copy/paste, URL sharing (`?prog=` base64, like
  `?layer`/`?date`), and "save as preset" are free.

Until phase 4, the Graph tab shows the pretty-printed program with per-node one-liners — still
enough for the "see what the AI did" story.

## 9. Presets

`presets.ts`: named, parameterized programs — `Correlate two layers…`, `Trend map…`,
`ENSO composite…`, `Compare regions…`. Each is a function `(params) → AnalysisProgram` and a
small form. This is the no-LLM tier and doubles as the worked examples in the system prompt.

**Built-in graphs (shipped 2026-07-12):** `src/analysis/presets.ts` carries six curated
example programs surfaced in the Graph tab's dropdown (grouped above the user's saved ones),
each demonstrating a language concept: SST × wind coupling (temporal r, negative), Wind
makes waves (temporal r, positive counterpart), El Niño − La Niña pattern (phase composite
via selectFrames + math sub — browser-verified: the classic equatorial dipole emerges),
ENSO leads global warmth (correlateSeries lag comparison), Arctic sea-ice pulse
(region + areaMean chart + range map), Warm seas are deserts (spatial correlation scalar).
Every built-in is test-validated against the language (tests/geo/analysis/presets.test.ts),
so they cannot rot as ops evolve.

---

## 10. File layout

```
src/analysis/
  types.ts        // ValueType, CpuField/CpuStack/Series/Scalar/Region, Unit
  ast.ts          // AnalysisProgram/AnalysisNode, op metadata table (signatures, params)
  validate.ts     // type check + DAG + cost estimate → structured errors
  ops.ts          // pure op implementations over CPU values
  interpret.ts    // topo walk + memo cache (worker-agnostic, pure)
  worker.ts       // Worker wrapper: message protocol, transferables
  field_store.ts  // stack loading/caching (main thread; wraps the shared loaders)
  schema.ts       // JSON Schema for run_analysis (generated from the op metadata table)
tests/geo/analysis/…        // vitest: validate, ops (synthetic fields), interpret cache
src/main.ts // display/chart sinks, Analysis panel toggle
src/ui/analysis_chat.ts        // chat UI + Anthropic tool runner (phase 3)
src/ui/analysis_graph_panel.ts // node editor (phase 4)
```

The op metadata table in `ast.ts` is the single source of truth: validator signatures, the
LLM JSON schema, node-editor port/param widgets, and docs all derive from it.

## 11. Milestones

- **M1 — core engine. ✅ DONE (2026-07-12).** types/ast/validate/ops/interpret + tests on
  synthetic fields (known correlation patterns, cos-lat weighting checks, date-pairing
  tolerance). Headless.
- **M2 — data + display. ✅ DONE (2026-07-12).** `FieldStore` (provider interface over the
  explorer's loaders; vector CPU cells via `retainCells` + `GriddedField.sampleVector`),
  `display`/`chart`/`answer` sinks in the explorer, 3 presets behind the ⚗ Analysis bar
  button, `?analysis[=run]` deeplink. Browser-verified live: SST × wind temporal correlation
  renders on the map with correct legend/stats and a physically sensible result. Deviations
  from this section: the `cpuOnly` loader mode was dropped (providers create transient
  GriddedFields that the store destroys after 1° ingestion — simpler, negligible GPU churn),
  and the Worker moved to M3 (main-thread interpret is ms-scale under the cost gate; the
  worker matters once LLM-generated programs raise the ceiling).
- **M3 — Claude. ✅ DONE (2026-07-12), live LLM round-trip pending a user API key.**
  `schema.ts` (strict-compatible tool schema + sanitizer + system prompt, all generated from
  the OPS table; the prompt's worked examples are test-validated against the real language),
  the deferred Worker (`worker.ts` + `AnalysisRunner` with inline fallback — presets now run
  through it, browser-verified), and the Ask tab (`analysis_chat.ts`, lazy-loaded so the
  Anthropic SDK stays out of the startup chunk): localStorage key entry, streaming tool
  runner on claude-opus-4-8 with adaptive thinking, `{...betaTool, strict: true}`,
  full-fidelity multi-turn via `runner.params.messages`, and the collapsible program JSON
  under each run (the pre-M4 Graph view). Everything verified up to the API boundary;
  the first real conversation needs a key pasted into the panel.
- **M4 — node editor. ✅ DONE (2026-07-12).** Graph tab with an editable canvas
  (src/ui/analysis_graph_panel.ts): typed port dots, bezier edges, drag-to-connect with
  the validator as can-connect oracle (incompatible ports dim while dragging; cycles
  rejected), param widgets generated from the OPS table, live validation badges, add/delete
  nodes, node dragging with kept positions across re-runs. `?prog=` base64url deeplinks
  (encode/decodeProgram in schema.ts) auto-load + run; 🔗 Copy link; save/load/delete named
  presets in localStorage; manual graph runs are appended to the Ask conversation
  (`notifyExternalRun`) so follow-up questions start from what's on screen. Browser-verified
  via a ?prog trend-map link (graph rendered, auto-ran, correct map/legend/answer).
  Navigation + menus (added same day): the canvas is a translate+scale viewport — drag empty
  space (or middle-mouse anywhere) to pan, wheel to zoom anchored at the cursor, ⟲ resets;
  node positions live in world coordinates. Right-click replaces the add-node dropdown: on
  empty canvas a grouped op menu (sources/transform/reduce/combine/sinks, descriptions as
  tooltips) adds a node at the click point; on a node it offers delete / disconnect-inputs.
  Deviation: per-node output hover summaries deferred (needs the interpreter to expose
  per-node value summaries — M5 candidate).
- **M4.5 — ML forecast op. ✅ DONE (2026-07-12).** A 17th op: `forecast(layer: anom,
  months, from?) → stack` — a source op, so the pure/worker interpreter is untouched; the
  caller materializes it like `layer`/`enso`. Engine side: OPS entry + `FieldStore.getForecast`
  through a host-supplied `AnalysisForecaster` (version-keyed caching); everything downstream
  (validator, LLM schema/prompt, node editor) derived automatically from the OPS table.
  Explorer side: `src/ui/analysis_forecast.ts` runs a ~190 KB residual CNN (trained
  offline on the baked OISST anom stack; predicts next-month delta-from-persistence from the
  last 4 months; val MAE 0.43 °C vs 0.48 °C persistence) with **LiteRT.js** (`@litertjs/core`)
  — WebGPU accelerator, WASM fallback, lazy-loaded; WASM runtime served at
  `assets/litert-wasm/` by a vite plugin. Gotchas: export .tflite with a CONCRETE batch-1
  signature (LiteRT.js rejects dynamic dims at run()); add `@litertjs/core` to
  optimizeDeps.include (dynamic-import discovery mid-session 504s, the jolt failure mode).
  Built-in graph "SST anomaly · ML outlook"; browser-verified end-to-end.
- **M4.6 — five visualization sinks. ✅ DONE (2026-07-13, all browser-verified in one
  all-sinks ?prog run).** `scatter` (series×series by date or cell×cell with cos-lat-weighted
  fit over ALL pairs + capped plotted subsample), `histogram` (weighted fractions),
  `hovmoller` (lon|lat × time, optional region; the equatorial-band anom diagram shows the
  2020–23 La Niña / 2023–24 El Niño bands textbook-style), `annotate` (top-N extrema ≥12°
  apart → screen-space map pins via NEW `ProjectionSpec.forward` on all six projections,
  repositioned per frame, hidden on the globe), `displayVectors` (u,v → arrows rasterized
  into an equirect OffscreenCanvas → texture at shader binding 11, composited like the flow
  trails so it works in every projection AND on the globe). Panel got a generic results area
  (chart/scatter/histogram/hovmöller blocks, ids #analysis-status/-answers/-results for
  automated checks); RunSummary carries scatter fits, histogram stats, and marker
  coordinates so the LLM can narrate locations. Gotchas hit live: (1) the ?prog deeplink
  handler ran synchronously inside installAnalysisPanel while the HOST's overlay state was
  still in its TDZ — deeplinks now defer a microtask, and host-callback clears moved inside
  execute's try; (2) sampleSstColormap returns 8-BIT rgb, not 0–1 (double-scaled → all-white
  Hovmöller). Four new/extended built-ins (scatter on SST×wind, histogram on the ENSO
  composite, ENSO-propagation Hovmöller, surface-currents arrows, annotate pins on the
  forecast).
- **M5 (later) —** `selectFrames` phases if not in M1, lead/lag sweeps (`chart` of r vs lag),
  GPU compute path if grids ever grow.

## 12. Open questions

1. **Climatology for `anomaly`.** Window-relative (v1) is honest but differs from the `anom`
   layer's 1971–2000 baseline; do we also want `anomalyVsClimatology` that reuses the OISST
   anom feed as the baseline? (Cheap: it's just `math(sub)` against the anom layer… which is
   actually the same data. Likely answer: document, don't build.)
2. **Frame pairing tolerance** default: half the coarser step vs. fixed 62 days (the Δ-view
   constant). Proposal: half-step, min 16 days.
3. **Where does the proxy live** if one is ever needed: a serverless function, or a separate
   tiny package? (Decide at M3; browser-direct until then.)
