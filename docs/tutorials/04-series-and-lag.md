# 4 — Series, Charts & Lag

*You'll learn: turning maps into time series with regions and `areaMean`, the
`chart` sink, correlating two series with `correlateSeries`, and its
`lagMonths` param — the lead/lag detector. The question is a real one: does
ENSO* lead *global ocean warmth?*

It's a known result that the planet's average surface warmth peaks a few months
**after** an El Niño peaks — the Pacific charges up first, then the heat spreads
into the global mean. Let's measure that lag ourselves.

```
layer(anom) ─► areaMean ──────┬─► chart
                              ├─► correlateSeries (lag 0) ─► answer
enso ────────┬────────────────┤
             └────────────────┴─► correlateSeries (lag 4) ─► answer
```

## From a stack to a series

1. Add **layer**: `layer: anom`, `start: 2016-01`, `stepMonths: 1`.
2. Add **areaMean** (under *reduce*) and connect the layer to `value`. Leave
   the optional `region?` input unconnected — we want the global mean. Its
   output dot is **teal**: with a stack input, `areaMean` produces a `series`,
   one cos(lat)-weighted mean per month. This node is the bridge out of
   map-land; almost every time-series analysis starts with it.
3. Add **enso** — the ONI, our second series.

## See them first

4. Add **chart** (under *sinks*). Connect areaMean → `a` and enso → `b`
   (`b` and `c` are optional — up to three lines). Title it
   `Global SST anomaly vs ONI`.
5. **▶ Run.** The chart draws both series, each normalized to its own range
   with a colored min…max legend. Eyeball it before computing anything: the
   two lines clearly dance together — and if you squint, the teal line's peaks
   sit a little *right* of the amber ones. That visual hunch is what we'll
   quantify.

   *Always chart before you correlate.* r is one number; the chart shows the
   shape, the outliers, and whether "correlated" even looks plausible.

## Quantify it — and find the lag

6. Add **correlateSeries** (under *combine*): areaMean → `a`, enso → `b`.
   Leave `lagMonths` empty. Add an **answer** (`label: r at lag 0`).
7. Add a **second** correlateSeries fed by the *same two* sources, but with
   `lagMonths: 4`, and its own **answer**
   (`label: r with ONI leading by 4 months`).

   What `lagMonths` does: it shifts series `b` four months forward before
   pairing, so each pairing matches this month's global anomaly with the ONI
   from *four months ago* — testing whether **b leads a** by four months.

8. **▶ Run.** Both answers print with their sample counts, an effective sample
   size and a p-value — `r at lag 0: 0.71 (n=120 · n_eff≈18.4 · p < 0.001)`.
   The lag-4 r comes out **higher** than the lag-0 r — the ONI four months ago
   predicts today's global anomaly better than today's ONI does. You've just
   measured the ocean's thermal lag with two nodes.

   `n_eff` is the number that keeps you honest here. Both series are smooth and
   persistent, so 120 monthly pairs are nowhere near 120 independent
   observations; the p-value is computed on the discounted count, not on `n`.
   Quote r *with* n_eff and p — on short windows an impressive-looking r on a
   pair of slow series routinely fails to clear 0.05 once the discount is
   applied, and if a window is persistent enough there may be no valid test at
   all (`p n/a`), which is a different statement from "not significant".

9. To find the *best* lag, duplicate the correlateSeries node a few more times
   (right-click → combine → correlateSeries, wire the same inputs) with
   `lagMonths` 2, 6, 8 — the answers list side by side. The peak is the lag.
   (An automatic lag-sweep op that charts r against lag is on the roadmap;
   until then, this manual sweep takes a minute.)

## Regional series

10. The `region?` port is how the same pipeline answers local questions.
    Add a **region** node (`preset: nino34`) and connect it to areaMean's
    `region` input: the series becomes the Niño 3.4 box mean — essentially the
    raw ingredient of the ONI itself (correlate it against `enso` and r comes
    out near 1; a good sanity check that the pipeline is honest).
    Presets cover the common boxes (`arctic`, `tropics`, `gulf-stream`, …), or
    give explicit `lonMin/latMin/lonMax/latMax` — bounds where
    `lonMin > lonMax` wrap across the antimeridian.

## The finished program

```json
{ "nodes": [
  { "id": "anom", "op": "layer", "params": { "layer": "anom", "start": "2016-01", "stepMonths": 1 } },
  { "id": "globalMean", "op": "areaMean", "inputs": { "value": "anom" } },
  { "id": "oni", "op": "enso" },
  { "id": "c", "op": "chart", "inputs": { "a": "globalMean", "b": "oni" }, "params": { "title": "Global SST anomaly vs ONI" } },
  { "id": "now", "op": "correlateSeries", "inputs": { "a": "globalMean", "b": "oni" } },
  { "id": "lag4", "op": "correlateSeries", "inputs": { "a": "globalMean", "b": "oni" }, "params": { "lagMonths": 4 } },
  { "id": "ansNow", "op": "answer", "inputs": { "value": "now" }, "params": { "label": "r at lag 0 (same month)" } },
  { "id": "ansLag", "op": "answer", "inputs": { "value": "lag4" }, "params": { "label": "r with the ONI leading by 4 months" } }
] }
```

(Ships as the built-in **ENSO leads global warmth**.)

**Experiments:** chart the Arctic's `ice` area mean (built-in **Arctic sea-ice
pulse** adds the seasonal-range map); correlate the `nino34` SST series against
*rain* over a tropical box at a few lags — teleconnection hunting; feed
`areaMean` a `timeReduce` field instead of a stack and note the output type
flips from series to scalar (the ports recolor to amber).

Next: [Ask, Then Edit](./05-ask-and-edit.md) — let the AI write the first draft.
