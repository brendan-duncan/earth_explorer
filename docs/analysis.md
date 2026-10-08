# Analysis (Dataflow Programs over Geo Data)

The analysis module answers questions about gridded Earth data — *"is sea
temperature correlated with wind?"*, *"how fast is this region warming?"*,
*"what does an El Niño winter look like?"* — by running small **dataflow
programs** over the layers in [Earth Explorer](../src/main.ts)
streams. One interpreter serves three front ends:

- **Presets** — one-click forms (correlate two layers, trend map, region series);
- **Ask** — an LLM (Claude or Gemini) writes the programs from natural-language questions;
- **Graph** — a node editor where you build and edit programs visually.

> **New to the module?** The [Analysis Tutorials](./tutorials/README.md)
> are a guided path through the graph editor — start with
> [Your First Graph](./tutorials/01-first-graph.md). This page is the
> reference they build on. For the story of the app itself, see the
> [deep-dive](./deep-dive.md).

Source lives in [`src/analysis/`](../src/analysis/). Everything runs
in the browser: the data never leaves the machine — programs execute on CPU
cells the explorer already holds.

---

## The mental model

A program is a **flat list of nodes forming a DAG**. Each node applies one
operation; `inputs` reference the producing node by id. There is no control
flow — no loops, no conditionals — which is what keeps every program safe,
obviously terminating, and cheap enough to run on every edit.

```jsonc
{ "nodes": [
  { "id": "sst",  "op": "layer",     "params": { "layer": "sst",  "start": "2023-01", "stepMonths": 2 } },
  { "id": "wind", "op": "layer",     "params": { "layer": "wind", "component": "speed", "start": "2023-01", "stepMonths": 2 } },
  { "id": "r",    "op": "correlate", "inputs": { "a": "sst", "b": "wind" }, "params": { "mode": "temporal" } },
  { "id": "map",  "op": "display",   "inputs": { "value": "r" } },
  { "id": "ans",  "op": "answer",    "inputs": { "value": "r" }, "params": { "label": "SST vs wind speed" } }
] }
```

Every program needs **at least one sink** (`display`, `chart`, or `answer`) —
sinks are what produce results; anything not feeding a sink is dead code and
never runs.

### The five value types

Edges carry one of five types. Ops declare which types each port accepts, and
the validator (and the graph editor's port colors) enforce them:

| Type | What it is | Typical producer |
| --- | --- | --- |
| `stack` | time × lat/lon grid — a layer over a date range | `layer` |
| `field` | one lat/lon grid — a single moment or a reduction over time | `timeReduce`, `trend`, `correlate(temporal)` |
| `series` | one value per time step | `areaMean(stack)`, `enso` |
| `scalar` | a single number | `areaMean(field)`, `correlate(spatial)`, `correlateSeries` |
| `region` | a lon/lat box, preset, or drawn polygon | `region` |

Fields cross the analysis boundary as **decoded physical floats** (°C, m/s,
hPa…) with NaN marking land/no-data, resampled onto a fixed **1° grid**
(360 × 180). Values are never clamped to a display range — an anomaly or a
correlation can be any number; only the `display` sink maps values to colors.

### Statistical conventions, encoded once

Every op follows the same rules, so you don't have to remember to apply them:

- **Area weighting** — all spatial reductions weight cells by cos(latitude);
  equirectangular cells shrink toward the poles, and an unweighted mean would be
  dominated by the Arctic.
- **Date pairing** — when two stacks (or series) combine, frames pair by
  *nearest date* within a tolerance of half the coarser cadence (minimum
  16 days). Unpaired frames drop out.
- **Minimum samples** — per-cell temporal statistics (`correlate` temporal,
  `trend`) require **≥ 8 paired samples** per cell; cells with fewer are NaN
  (they show as no-data on the map).
- **Association, not significance** — gridded values are spatially
  autocorrelated, so the huge apparent sample counts overstate certainty. The
  engine reports r and n, never p-values, and `answer` payloads carry an
  explicit `spatiallyAutocorrelated` flag.

---

## Node reference

Twenty-five ops in five groups (`OP_NAMES` in [`ast.ts`](../src/analysis/ast.ts) is the
authority — that table generates the validator, the editor's palette and the LLM schema). *Port*
notation: `name: type` (a `?` marks an
optional port or param).

### Sources

Sources are materialized by the host (the explorer's `FieldStore`); in a
program you just name what you want.

#### `layer` → `stack`

One data layer as a stack of dated 1° fields.

| Param | Type | Notes |
| --- | --- | --- |
| `layer` | string, required | A catalog key — see the layer table below. |
| `start?` / `end?` | `YYYY-MM` | Inclusive; default = the layer's full coverage. |
| `stepMonths?` | number | Frame cadence: 4, 2, or 1 months (default 4). Finer = more statistical power, slower loads for live feeds. |
| `component?` | `speed` \| `u` \| `v` | **Required for vector layers** (wind, currents): which scalar to extract. |

Layers in the explorer's catalog:

| Key | Unit | Coverage | Notes |
| --- | --- | --- | --- |
| `sst` | °C | 1981-09 → now | Sea-surface temperature (NOAA OISST) |
| `anom` | °C (relative) | 1981-09 → now | SST anomaly vs the NOAA 1971–2000 climatology |
| `ice` | % | 1981-09 → now | Sea-ice concentration |
| `chl` | mg/m³ | 2016-01 → bake date | Chlorophyll-a; log-distributed values |
| `dhw` | °C-weeks | 2016-01 → now | Coral Reef Watch degree heating weeks (rolling 12 weeks); ocean only |
| `baa` | — | 2016-01 → now | Bleaching alert level 0–4; **ordinal**, not a continuous quantity |
| `mhw` | — | 2024-07 → now | Marine-heatwave category 0–5; **ordinal**, not a continuous quantity |
| `waves` | m | 2017-02 → now | Significant wave height (total); no coverage poleward of ±77° |
| `swell` | m | 2017-02 → now | Swell component of the sea state; same ±77° limit |
| `windsea` | m | 2017-02 → now | Wind-sea component of the sea state; same ±77° limit |
| `period` | s | 2017-02 → now | Peak wave period; same ±77° limit |
| `rain` | mm/h | 2022-12 → now | GFS rainfall *rate*, 12:00Z snapshots |
| `precip` | mm/day | 2016-01 → now | PERSIANN-CDR satellite daily *totals*; ±60° only (record starts 1983) |
| `precipmon` | mm/day | 1979-01 → bake date | GPCP v2.3 **monthly-mean** precipitation, land + ocean, on its native 2.5° grid (reads blocky at 1°). The long rainfall record — use it for anything spanning decades or ENSO events |
| `landanom` | °C (relative) | 1979-01 → bake date | GHCN-CAMS monthly 2 m **land** air-temperature anomaly vs its own 1991–2020 per-month climatology (not the SST anomaly's 1971–2000) |
| `airtemp` | °C | 2022-12 → now | GFS 2 m air temperature (covers land) |
| `skintemp` | °C | 2022-12 → now | GFS surface (ground/sea) temperature — not the 2 m air temperature |
| `humidity` | % | 2022-12 → now | GFS 2 m relative humidity |
| `pressure` | hPa | 2022-12 → now | GFS mean sea-level pressure |
| `solar` | W/m² | 2026-01 → now | Downward shortwave flux — strongly diurnal, 12:00Z only |
| `swup` | W/m² | 2026-01 → now | Upwelling (reflected) shortwave flux at the surface |
| `lwup` | W/m² | 2026-01 → now | **Surface** upwelling longwave (≈σT⁴ of the skin) — not top-of-atmosphere OLR |
| `lwdown` | W/m² | 2026-01 → now | Downward longwave flux — the greenhouse effect as a surface flux |
| `wind` | m/s (vector) | 2022-12 → now | GFS 10 m wind — set `component` |
| `currents` | m/s (vector) | 2020-01 → bake date | Baked surface currents — set `component` |

The four radiation fluxes (`solar`, `swup`, `lwup`, `lwdown`) sit on the same GFS aggregation as the
other atmosphere layers, but PacIOOS only populates them in its recent segment — dates before
~2026-01 come back as all-null grids, so their coverage floor is *not* the dataset's advertised
2022-12. `baa` and `mhw` are ordinal category scales: `mean`/`trend` over them are arithmetic on
category numbers, not on a physical quantity, so read them as "how often, how severe", not as rates.

#### `region` → `region`

A named preset, an explicit lon/lat box, or an arbitrary **polygon**. Every spatial
reduction (`areaMean`, `mask`, `histogram`, `hovmoller`) restricts through the same
point-in-region test, so a drawn shape behaves exactly like a typed box.

| Param | Notes |
| --- | --- |
| `preset?` | Named region (`nino34`, `tropics`, `gulf-stream`, …). |
| `lonMin?` / `latMin?` / `lonMax?` / `latMax?` | Explicit box; `lonMin > lonMax` wraps the antimeridian. |
| `points?` | Polygon ring as `"lon,lat lon,lat …"` (≥3 vertices, closes automatically). Takes precedence over the box params. |

Drawing an area in the explorer produces exactly this string — the readout panel's
**region** button copies it, ready to paste into a `points` param. Rings that cross
±180° are handled: vertices are unwrapped so the shape stays contiguous, and the
inside test is evaluated against the ±360° copies. For a polygon, the region's
bounding box is an envelope used only as a per-row latitude reject — the exact test
is always the ring itself.

#### `enso` → `series`

The monthly **Oceanic Niño Index** (ONI — the 3-month running mean of the
Niño 3.4 SST anomaly). The standard ENSO index: ≥ +0.5 °C leans El Niño,
≤ −0.5 °C leans La Niña.

#### `forecast` → `stack`

An **on-device ML outlook**: a small convolutional network (~190 KB, trained
offline on the repo's baked OISST anomaly stack, run in the browser with
LiteRT.js — WebGPU-accelerated, WASM fallback) rolls a layer forward month by
month from the latest observations. The output stack has one **predicted**
frame per future month; treat it as an outlook, not data. Downstream it
composes like any stack — display it, `areaMean` it, difference it against
the observed layer with `math`.

| Param | Type | Notes |
| --- | --- | --- |
| `layer` | `anom`, required | Only the SST anomaly has a trained model. |
| `months?` | number | Months ahead to predict, 1–6 (default 3). Predictions feed back in, so skill decays with distance. |
| `from?` | `YYYY-MM` | Last observed month to roll forward from (default: latest available). Useful for hindcasts — forecast from a past month, then compare against what happened. |

The model predicts a per-cell **delta from persistence** (next month = this
month + learned change) from the last 4 observed months. On the 12 held-out
validation months it reaches ~0.43 °C mean absolute error vs ~0.48 °C for
pure persistence. The host registers the model via `FieldStore`'s
`forecaster` option; without one, `forecast` nodes fail with a structured
error.

#### `region` → `region`

A lon/lat box, by preset or explicit bounds (give one or the other):

| Param | Notes |
| --- | --- |
| `preset?` | `nino34`, `tropics`, `arctic`, `southern-ocean`, `gulf-stream`, `north-atlantic`, `north-pacific` |
| `lonMin?` `latMin?` `lonMax?` `latMax?` | Degrees; `lonMin > lonMax` wraps across the antimeridian (e.g. the North Pacific preset). |

### Transforms (shape-preserving)

#### `mask` — `(value: stack|field, region: region)` → same type

Keeps only cells inside the region; everything else becomes no-data. Use it to
focus a *map* on a region (for a regional *number or series*, `areaMean` takes
a region directly).

#### `anomaly` — `(value: stack)` → `stack`

| Param | Notes |
| --- | --- |
| `baselineStart?` / `baselineEnd?` | `YYYY-MM` reference period (e.g. 1991-01 → 2020-12); must lie inside the loaded range. Default: every loaded frame. |
| `climatology?` | `window` (default) = one flat mean; `monthly` = each calendar month against its own baseline mean, removing the seasonal cycle. |
| `as?` | `difference` (default) = value − climatology; `percent` = percent of normal, (value − climatology) / climatology × 100. Cells with a climatology ≤ 0 become no-data. |

Subtracts a climatology from each frame. With no baseline the reference is
whatever window you loaded, so the same cell changes value when the range
changes; state a baseline for anything you will quote. The baseline used is
recorded on the output's note. Use `as: percent` for rainfall — a 1 mm/day
excess is a flood in a desert and noise in a monsoon, and raw differences let
the wettest places dominate every map. Output is marked relative.

#### `lag` — `(value: stack|series)` → same type

| Param | Notes |
| --- | --- |
| `months` | required; whole months to shift dates forward (negative allowed). |

The lead/lag tool: `correlate(a, lag(b, 3))` pairs a(t) with b(t−3 months),
i.e. it tests whether **b leads a** by 3 months. (For series, `correlateSeries`
has a built-in `lagMonths` that does the same thing more conveniently.)

#### `selectFrames` — `(value: stack, oni?: series)` → `stack`

Keeps only frames matching a month-of-year list and/or an ENSO phase.

| Param | Notes |
| --- | --- |
| `months?` | Comma-separated months to keep, e.g. `"12,1,2"` for December–February. |
| `phase?` | `elnino` \| `lanina` \| `neutral`. **Requires the `oni` input** (connect an `enso` node). |

Phase is classified by the instantaneous ONI ±0.5 threshold at the nearest
month — a simplification of the CPC rule (which requires five consecutive
qualifying seasons). Good enough for composites; don't cite it as an official
event classification.

#### `filter` — `(value: field|stack|series)`

Range filter — ODV's *sample filter*. Values outside the range become no-data, so every
downstream reduction sees only the part you asked about: *"area mean **where** heat stress
≥ 4 °C-weeks"*. Shape-preserving, and units are untouched — this selects values, it does
not transform them.

| Param | Notes |
| --- | --- |
| `min?` / `max?` | Inclusive bounds; at least one is required. |
| `abs?` | Compare `|value|` — for "anomaly of either sign, larger than N". |

#### `derive` — `(value: field|stack|series|scalar)`

Applies one function element-wise — ODV-style derived variables.

| Param | Notes |
| --- | --- |
| `fn` | `log10`, `ln`, `abs`, `sqrt`, `square`, `negate`, `inverse` (required). |

`log10`/`ln` are the ones that matter: log-distributed quantities (chlorophyll, rainfall)
correlate and average meaningfully in log space, whereas a Pearson r on raw values is
decided by a handful of extremes. Non-positive inputs to a log, negatives to `sqrt` and
zero to `inverse` all become no-data rather than infinities.

Units are reported honestly. `abs`/`negate` keep the unit (`abs` drops `relative`, since a
magnitude has no sign left to convert); everything else returns **dimensionless**, because
a log or a power changes the dimension and this language does not track compound units — a
retained unit label would be a lie.

#### `isoline` — `(value: field|stack, region?: region)`

The 2-D counterpart of ODV's isosurfaces: instead of colouring a depth surface, it measures
the region a contour encloses. Over a stack the output is a `series`; over a field, a
`scalar`.

| Param | Notes |
| --- | --- |
| `level` | Contour value in the layer's physical units (required). |
| `measure?` | `area` (default) — extent in million km²; `latitude` / `longitude` — the area-weighted centroid of the enclosed region, which tracks a *boundary*. |
| `below?` | Measure `value ≤ level` instead of `≥`. |

Area uses exact spherical cell areas (`R²·Δλ·|sin φ₂ − sin φ₁|`), and positions are
area-weighted so the answer is a centroid rather than a mean over grid rows — an unweighted
mean would over-count the shrinking polar cells. This is what turns a threshold into a
measurement: sea-ice extent at the conventional 15 % edge, ocean area above the 4 °C-week
bleaching threshold, or the latitude of the ice edge as it retreats.

One caveat with teeth: cells are counted whole on the 1° analysis grid, so an extent runs a
few percent above an operational figure computed at the source resolution. Read the shape of
the series, not headline agreement with a published number.

### Reductions

#### `areaMean` — `(value: stack|field, region?: region)` → `series` | `scalar`

The cos(lat)-weighted mean over valid cells, optionally inside a region. This
is **the bridge from maps to time series**: a stack becomes a series (one value
per frame), a field becomes a single number.

#### `timeReduce` — `(value: stack)` → `field` | `stack`

| Param | Notes |
| --- | --- |
| `stat` | required; `mean` \| `min` \| `max` \| `range` (= max − min; needs ≥ 2 valid frames per cell). |
| `per?` | `all` (default) → one `field`; `run` → a `stack` with one frame per run of consecutive frames. |

Per-cell reduction across frames. `range` is the seasonal-amplitude map;
`mean` is the time-average (also what `correlate(spatial)` uses internally).

`per: run` splits the stack wherever the gap between frames exceeds 1.5× its
median step, and reduces each run separately. After
`selectFrames(months: "12,1,2")` that is **one Dec–Feb mean per winter**, dated
at the run's middle frame (January), so it pairs with the ONI season centered
on the same month. Runs shorter than the longest are dropped as incomplete, so
a season missing a month doesn't pass for a full one.

#### `trend` — `(value: stack)` → `field`

Per-cell least-squares slope across the frames, reported **per decade**.
Needs ≥ 8 valid frames per cell. The "how fast is it changing" map.

### Combinators

#### `math` — `(a, b)` → same type

| Param | Notes |
| --- | --- |
| `fn` | required; `add` \| `sub` \| `mul` \| `div` (division by zero → NaN). |

Element-wise arithmetic. Operands must be the **same type** — field∘field,
stack∘stack (frames pair by nearest date), series∘series — or one operand may
be a `scalar` (broadcast). `sub` marks the result relative; `mul`/`div` drop
the unit. Validity intersects: a cell must be valid in both operands.

#### `correlate` — `(a, b)` → `field` | `scalar`

| Param | Notes |
| --- | --- |
| `mode` | required; `temporal` \| `spatial`. |

Pearson correlation, two very different questions:

- **`temporal`** — inputs must be two **stacks**. At each cell, r is computed
  across the date-paired frames → a **map of r** (unit `r`, displayed on a
  ±1 diverging scale). Asks: *where* do these two quantities move together over
  time? Cells with < 8 pairs are NaN.
- **`spatial`** — inputs are fields or stacks (stacks are time-averaged
  first). One cos(lat)-weighted r **across cells** → a single number. Asks: do
  the *geographies* of the two quantities line up?

#### `correlateSeries` — `(a: series, b: series)` → `scalar`

| Param | Notes |
| --- | --- |
| `lagMonths?` | Shift b forward N months before pairing — tests whether **b leads a** by N months. |

Pearson r between two time series, paired by nearest time. Returns NaN with
fewer than 8 pairs; the answer payload carries n.

#### `regress` — `(value: stack, predictor: series, at?: scalar|series)` → `field`

| Param | Notes |
| --- | --- |
| `output?` | `slope` (default) \| `predict` \| `skill`. |
| `at?` | Predictor value for `predict` when no `at` input is connected (e.g. `1.5`). |
| `atFrom?` | How an `at` **series** collapses: `last`, `last3` (default — mean of the final three samples, the season a forecast ends on), `mean`, or `peak` (largest magnitude). |
| `minSkill?` | `slope`/`predict` only: blank cells whose cross-validated skill (%) is below this. `0` keeps cells that beat climatology at all. |

Per-cell least-squares regression, `value(t) ≈ a + b·predictor(t)`, with each
frame paired to the nearest predictor sample. This is the statistical core of a
**teleconnection outlook**: how much a cell responds per unit of an index (usually
the ONI), how reliably, and what that implies at a forecast index value.

- **`slope`** — `b`, in the value's units per predictor unit (relative).
- **`predict`** — `a + b·x₀`. Wire `areaMean(forecast(anom), region(nino34))`
  into `at` to drive it from the on-device Niño 3.4 forecast.
- **`skill`** — cross-validated percent of variance explained against
  climatology. Each sample is predicted from a fit that **excludes the 12
  months around it**, so the other months of the same season can't leak the
  answer (plain leave-one-out would let them). ≤ 0 means the index does no
  better than the long-term normal.

`slope` and `predict` carry a standard error and p-value on the
autocorrelation-adjusted sample size (the same Bretherton et al. correction as
`correlate`), so `display(stipple)` works on them. For `predict` the test is
"is the predicted departure distinguishable from zero".

Fit one season, not all months: regressing every calendar month together mixes
seasons whose response differs. Fit seasonal means where you can, too
(`timeReduce(per: run)`), because single months carry weather noise that a
season averages out. The standard shape is:

```
layer(precipmon) → selectFrames(12,1,2) → timeReduce(mean, per: run)
  → anomaly(monthly, 1991–2020, as: percent) → regress(predictor: enso)
```

### Sinks

#### `display` — `(value: field|stack, over?: field|stack)`

Shows the result **on the explorer map**, exactly like a built-in view: the
legend gets the physical range, and a stack stays scrubbable on the timeline.
Reverting is just picking any layer or view.

Wiring the optional **`over`** input draws a *second* quantity on top of the
first. Area colour is already spent on the fill, so the overlay uses the channels
that are left — iso-lines tinted by its own colormap, plus diagonal hatching
above `overHatchAt`. It is the same compositing path the explorer's overlay
picker uses, so a program can express any two-layer view the UI can, and `?prog=`
links carry it.

| Param | Notes |
| --- | --- |
| `title?` | Legend title. |
| `colormap?` | `thermal`, `balance`, `viridis`, `ice`, `chl`, `turbo`, `grayscale` — overrides the automatic pick. |
| `min?` / `max?` | Legend range in physical units — overrides the automatic range. |
| `overTitle?` | Legend title for the `over` input. |
| `overBands?` | Iso-line count for the overlay (default 8). Set it to a class count for ordinal quantities so every line lands on a real boundary. |
| `overHatchAt?` | Hatch the overlay above this **physical** value; omit for lines only. |

Automatic legend: correlation (`r`) → `balance` fixed at ±1; relative values →
`balance` symmetric around 0 (range from the 2nd/98th percentiles); everything
else → `viridis` over the 2nd–98th percentile. The `over` input gets the same
treatment independently, so its line tint matches its own legend strip.

```jsonc
// "Where was 2019 hot, and where did coral heat stress peak?" — one map, two quantities.
{ "nodes": [
  { "id": "s",  "op": "layer",      "params": { "layer": "sst", "start": "2019-01", "end": "2019-12" } },
  { "id": "d",  "op": "layer",      "params": { "layer": "dhw", "start": "2019-01", "end": "2019-12" } },
  { "id": "sm", "op": "timeReduce", "inputs": { "value": "s" }, "params": { "stat": "mean" } },
  { "id": "dm", "op": "timeReduce", "inputs": { "value": "d" }, "params": { "stat": "max" } },
  { "id": "m",  "op": "display",    "inputs": { "value": "sm", "over": "dm" },
    "params": { "title": "SST mean 2019", "overTitle": "Peak heat stress", "overBands": 4, "overHatchAt": 4 } }
] }
```

#### `scatter` — `(a, b, c?)`

Adding the optional **`c`** input maps a third variable to dot colour, which is what makes a
property-property plot readable — the structure inside the cloud (which water mass, which
latitude, which season) is invisible when every dot is the same colour. The colour ramp is
diverging for Δ-quantities and sequential otherwise, with its range labelled beside the key.
`c` must be the same kind as `a` and `b` (all series, or all gridded).

#### `chart` — `(a: series, b?: series, c?: series)`

A line chart in the panel, up to three series (each normalized to its own
range, with a per-series colored min…max legend).

| Param | Notes |
| --- | --- |
| `title?` | Chart title (defaults to the series labels). |

#### `answer` — `(value: scalar|series|field)`

A structured numeric result rendered as text (and returned to the Ask tab's
model as its tool result). Field answers report the area-weighted mean, the
5th/95th percentiles, and coverage; series answers report mean/min/max and the
span; scalars report the value and n.

| Param | Notes |
| --- | --- |
| `label` | required; what the number answers. |

#### `scatter` — `(a, b)` · two series or two gridded inputs

A scatter plot with a least-squares line and Pearson r — shows the
relationship a correlation number summarizes (and the outliers/nonlinearity it
hides). Two **series** pair by nearest date, one dot per time step. Two
**fields/stacks** pair by grid cell (stacks are time-mean reduced first); the
fit uses every valid cell, cos(lat)-weighted, and the plot draws a capped
subsample.

| Param | Notes |
| --- | --- |
| `title?` | Plot title. |
| `maxPoints?` | Plotted-point cap in cell mode (default 3000; the fit always uses all pairs). |

#### `histogram` — `(value: field|stack)`

The value distribution over valid cells, cos(lat)-weighted (a stack pools all
its frames). Bars are fractions of the total weight; an amber line marks the
weighted mean.

| Param | Notes |
| --- | --- |
| `bins?` | 5–120 (default 40). |
| `title?` | Plot title. |

#### `hovmoller` — `(value: stack, region?: region)`

A **Hovmöller diagram**: longitude (or latitude) × time heatmap. Each frame is
averaged along the other axis — optionally restricted to a region (an
equatorial band is the classic choice) — and stacked as one row per date,
oldest at the top. The plot for *seeing propagation*: ENSO warm pools drift
visibly east along the equator. Colormap follows the display rules (`balance`
symmetric for relative values, else `viridis`), scaled to the diagram's own
2nd–98th percentiles.

| Param | Notes |
| --- | --- |
| `axis?` | `lon` (default) or `lat`. |
| `title?` | Plot title. |

#### `annotate` — `(value: field)`

Pins the field's extrema **on the map**: screen-space markers (▲ maxima, ▼
minima) with the value, tracking pan/zoom in every flat projection (hidden on
the globe). Markers are kept ≥ 12° apart so one blob doesn't soak up the whole
budget. The marker list — values and coordinates — also goes into the run
summary, so the Ask tab's model can narrate *where* things are.

| Param | Notes |
| --- | --- |
| `stat?` | `max` (default), `min`, or `both`. |
| `count?` | Markers per kind, 1–8 (default 3). |
| `label?` | What the markers show (used in the summary). |

#### `displayVectors` — `(u, v)` · each field or stack

Draws a vector field as arrows **on the map** from two scalar components
(u = eastward, v = northward; stacks are time-mean reduced). Arrows are
rasterized into the same equirect overlay space as the flow trails, so they
composite correctly in every projection and on the globe. Length scales with
magnitude (normalized to the field's 98th percentile); combine with a
`display` of the speed for a filled background.

| Param | Notes |
| --- | --- |
| `title?` | Used in the run summary. |
| `strideDeg?` | Degrees between arrows, 2–15 (default 5). |
| `scale?` | Arrow-length multiplier (default 1). |

---

## Running programs from code

The engine is headless and browser-agnostic apart from the loaders. The core
API:

```ts
import { validate } from './analysis/validate.js';
import { interpret, InterpreterCache, AnalysisError } from './analysis/interpret.js';
import { AnalysisRunner } from './analysis/run.js';           // Worker + inline fallback
import { FieldStore } from './analysis/field_store.js';
import type { AnalysisProgram } from './analysis/ast.js';
```

- **[`validate(program)`](../src/analysis/validate.ts)** — structural +
  type checking with no data. Returns structured issues
  (`{node, port, param, message, hint}`) — the same objects the graph editor
  renders as red badges and the LLM receives for self-repair.
- **[`FieldStore`](../src/analysis/field_store.ts)** — materializes the
  program's `layer`/`enso` nodes. It is configured with per-layer **providers**
  (the explorer wires its own loaders in; tests use fakes) and owns 1° ingestion,
  unit conversion, the component extraction for vector layers, and a byte-bounded
  cache whose keys double as the interpreter's `sourceKeys`.
  `resolveSources(program)` loads exactly the sources that reach a sink.
- **[`interpret(program, {sources, sourceKeys, cache})`](../src/analysis/interpret.ts)** —
  validates, **cost-gates** (the estimated Σ cells×frames must stay under a
  budget, default 200 M cell-ops — a runaway program is refused before any work),
  then executes in topological order with a memoizing cache: re-running after
  editing one node recomputes only its downstream.
- **[`AnalysisRunner`](../src/analysis/run.ts)** — the same call routed
  through a Web Worker (with an inline fallback), so heavy programs don't hitch
  the frame loop. This is what the panel uses.

```ts
const store = new FieldStore(providers, { loadOni });
const { sources, sourceKeys } = await store.resolveSources(program);
const result = await new AnalysisRunner().run(program, { sources, sourceKeys });
for (const sink of result.sinks) { /* display / chart / answer results */ }
```

Ops are defined once in the **[`OPS` metadata table](../src/analysis/ast.ts)**
(ports, params, output-type resolution). The validator, the graph editor's
widgets, and the LLM tool schema all derive from it — adding an op is one entry
there plus one implementation in [`ops.ts`](../src/analysis/ops.ts).

### The LLM surface

[`schema.ts`](../src/analysis/schema.ts) generates the Ask tab's tool:

- `runAnalysisInputSchema(layerKeys)` — a tight, closed JSON Schema (op names,
  layer keys, and enums enumerated per op) that steers the model's programs.
  It deliberately does **not** use `strict` mode: strict grammars are compiled
  server-side, and a 16-op language exceeds their size limits — the
  validate-and-repair loop provides the correctness guarantee instead;
- `sanitizeProgram(input)` — defensively strips null / empty-string placeholders;
- `renderSystemPrompt(catalog)` — the data catalog, op cheat sheet, worked
  examples (test-validated against the language), and narration rules;
- `encodeProgram` / `decodeProgram` — the base64url `?prog=` deeplink format.

### Providers

The Ask tab talks to either **Claude** or **Gemini**, chosen from a picker in the
tab's key row. Each vendor keeps its own API key in `localStorage`
(`earth_explorer_anthropic_api_key` / `earth_explorer_gemini_api_key`), pasted by the user at
runtime; the selection itself lives in `earth_explorer_analysis_provider`. Calls go
browser-direct with that key — no proxy, and no key ships with the app.

Everything that is the same either way — the transcript, the key row, the
`run_analysis` tool, and the execute pipeline behind it — lives in
[`analysis_chat.ts`](../src/ui/analysis_chat.ts). The API round-trip sits
behind the `ChatProvider` seam in
[`analysis_chat_provider.ts`](../src/ui/analysis_chat_provider.ts), with
one module per vendor, imported lazily so only the chosen vendor's SDK is ever
fetched:

| | Claude | Gemini |
| --- | --- | --- |
| Default model | `claude-opus-4-8` | `gemini-2.5-pro` |
| Tool loop | SDK beta tool runner | hand-written in the provider |
| Schema field | `input_schema` (JSON Schema) | `parametersJsonSchema` |

Two vendor differences are worth knowing. Gemini has no tool-runner equivalent,
so its provider writes the send → collect `functionCall` → run → append
`functionResponse` cycle out by hand; and its schema validator accepts JSON
Schema via `parametersJsonSchema` (so `anyOf` and `additionalProperties` survive)
but rejects `const`, which `toGeminiJsonSchema` rewrites to a single-value `enum`
— our only use of `const` is the per-op discriminator in the node union, so the
rewrite is lossless.

Conversation history is provider-native — Anthropic `messages[]` and Gemini
`contents[]` carry tool calls in incompatible shapes — so switching vendors
mid-session starts a fresh conversation rather than translating tool state.

### Built-in graphs

[`presets.ts`](../src/analysis/presets.ts) ships curated example
programs (surfaced in the graph editor's dropdown), each demonstrating a
concept: temporal correlation (SST × wind; waves × wind), phase composites
(El Niño − La Niña), series lag (`correlateSeries`), region series + seasonal
range (Arctic ice), spatial correlation (chlorophyll × SST), and the **El Niño
winter outlooks** — Dec–Feb rainfall and land temperature predicted from the
on-device Niño 3.4 forecast via `regress(predict)`, plus the cross-validated
skill map that says where to trust them. Each is validated by the test suite,
so they always reflect the current language.

---

## Costs and limits

- Analysis grid: 1° (360 × 180 = 64 800 cells per field).
- Cost gate: ~200 M cell-ops per run — roughly a 60-frame stack through a dozen
  ops. Programs over budget are refused with a "narrow the date range or use a
  coarser cadence" hint rather than freezing the page.
- Live layers (waves, wind, the GFS set) fetch one frame per month of the
  requested range from ERDDAP on first use — expect seconds-to-a-minute for
  monthly cadences over multi-year ranges. Baked layers (sst/anom/ice history,
  chl, currents) load in one shot. Materialized stacks are cached (~300 MB LRU),
  so re-runs and edits are instant.
