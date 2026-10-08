# 3 — El Niño Composites

*You'll learn: branching graphs (one source feeding two processing chains), the
`enso` node, filtering a stack by ENSO phase with `selectFrames`, collapsing
each branch with `timeReduce`, and differencing the branches with `math`. The
payoff is one of climate science's most famous pictures, built from nine
nodes.*

A **composite** answers "what does X *typically* look like during condition C?"
by averaging every frame where C held. Composite the SST anomaly over El Niño
months, do the same for La Niña months, subtract — and the equatorial Pacific's
ENSO dipole should appear.

```
layer(anom) ──┬─► selectFrames(elnino) ─► timeReduce(mean) ─┐
              │        ▲ oni                                ├─► math(sub) ─► display + answer
              │        │                                    │
enso ─────────┴────────┴► selectFrames(lanina) ─► timeReduce(mean) ─┘
```

## Build the trunk

1. Add a **layer** node: `layer: anom`, `start: 2016-01`, `stepMonths: 1`.
   The anomaly layer (SST minus its 1971–2000 climatology for that place and
   month) is the right raw material — the seasonal cycle is already removed, so
   what's left *is* the unusual warmth or coolness.
2. Add an **enso** node (under *sources*). No params: it's the monthly Oceanic
   Niño Index, the standard ENSO record. Its output is **teal** — a `series`.

## Branch one: El Niño months

3. Add **selectFrames** (under *transform*). Connect the anomaly layer to
   `value` — and note its second, optional input `oni?`. Set `phase: elnino`.
   The node immediately shows a validation error: *"phase needs the oni input
   (connect an enso node)"*. The phase filter can't classify months without the
   index — so connect **enso → selectFrames.oni** and watch the badge clear.
4. Add **timeReduce** with `stat: mean` and feed it the selectFrames output.
   This collapses "every El Niño month since 2016" into one average-anomaly
   map.

## Branch two: La Niña months

5. Repeat: another **selectFrames** (`phase: lanina`) fed by the *same* layer
   node and the *same* enso node — drag new edges from their output dots; one
   output can fan out to any number of inputs. Another **timeReduce**
   (`stat: mean`).

   If the canvas is getting crowded, drag node headers to arrange the two
   branches into rows, and pan/zoom as needed. Layout is yours; it never
   changes the program.

## Combine

6. Add **math** (under *combine*), `fn: sub`. Connect the El Niño mean to `a`
   and the La Niña mean to `b`. Field minus field, cell by cell — and the
   result is marked *relative*, so the display will pick a diverging colormap
   with a symmetric range automatically.
7. Add **display** (`title: SST anomaly · El Niño − La Niña`) and **answer**
   (`label: El Niño − La Niña anomaly difference`), both fed by the math node.

## Run and read

8. **▶ Run** (`done · ~33M cell-ops` — the priciest tutorial yet, still under a
   second of compute once the data is cached).

   The map is the textbook: a **broad red tongue along the equatorial eastern
   Pacific** — during El Niño that band runs a couple of degrees warmer than
   during La Niña — flanked by a cooler horseshoe to the west and off-equator.
   You built the pattern that names the phenomenon, from raw monthly grids and
   an index, with no statistics beyond averaging and subtracting.

9. The honest print: the answer's global mean is small (~+0.3 °F) — ENSO
   redistributes heat more than it creates it — while p5/p95 (≈ −1 °F/+1.8 °F)
   show the swing where the action is. And a caveat worth knowing:
   `selectFrames` classifies phase by the instantaneous ONI ±0.5 threshold, a
   simplification of the official rule (which requires the threshold to hold
   for five consecutive seasons). Fine for composites; don't cite it as an
   event catalog.

## The finished program

```json
{ "nodes": [
  { "id": "anom", "op": "layer", "params": { "layer": "anom", "start": "2016-01", "stepMonths": 1 } },
  { "id": "oni", "op": "enso" },
  { "id": "nino", "op": "selectFrames", "inputs": { "value": "anom", "oni": "oni" }, "params": { "phase": "elnino" } },
  { "id": "nina", "op": "selectFrames", "inputs": { "value": "anom", "oni": "oni" }, "params": { "phase": "lanina" } },
  { "id": "ninoMean", "op": "timeReduce", "inputs": { "value": "nino" }, "params": { "stat": "mean" } },
  { "id": "ninaMean", "op": "timeReduce", "inputs": { "value": "nina" }, "params": { "stat": "mean" } },
  { "id": "diff", "op": "math", "inputs": { "a": "ninoMean", "b": "ninaMean" }, "params": { "fn": "sub" } },
  { "id": "map", "op": "display", "inputs": { "value": "diff" }, "params": { "title": "SST anomaly · El Niño − La Niña" } },
  { "id": "ans", "op": "answer", "inputs": { "value": "diff" }, "params": { "label": "El Niño − La Niña anomaly difference" } }
] }
```

(It also ships as the built-in **El Niño − La Niña pattern**.)

**Experiments:** add `months: "12,1,2"` to both selectFrames nodes to composite
*winters* only (ENSO peaks in boreal winter — the pattern sharpens); swap the
layer to `rain` (coverage starts 2022-12, so shorten `start`) and see the
precipitation shift instead; display one branch's mean directly to see a raw
composite before differencing.

Next: [Series, Charts & Lag](./04-series-and-lag.md) — leaving maps for time
series.
