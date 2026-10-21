# 2 — Correlation Maps

*You'll learn: what Pearson r means on gridded data, how `correlate`'s two
modes ask two different questions, how vector layers work (`component`), and
how the editor's live validation catches a type error the moment you create
one.*

The question: **"Does wind cool the sea surface?"** Physically it should — wind
drives evaporation and stirs cool water up from below — so where the two are
genuinely coupled, months with stronger wind should be months with cooler
water.

## Temporal correlation: a map of r

1. Open the Graph tab and build:

   - **layer** → `layer: sst`, `start: 2023-01`, `stepMonths: 2`
   - **layer** → `layer: wind`, `start: 2023-01`, `stepMonths: 2`, and —
     because wind is a *vector* layer — `component: speed`. Forget the
     component and the run stops with a structured error naming the node:
     vector layers need to know which scalar you want (`speed`, `u`, or `v`).
   - **correlate** (under *combine*) → `mode: temporal`; connect the SST layer
     to input `a` and wind to `b`.
   - **display** and **answer**, both fed by the correlate node.

2. **▶ Run.** The wind months stream from the live GFS feed, so the first run
   takes a while (watch the status line); they're cached afterwards.

3. Reading the result:

   - The map is r per cell, on a **fixed ±1 balance scale** — the engine knows
     `r` and always displays it the same way. Broad blue across the tropics and
     subtropics: **negative correlation, wind up → temperature down**. Exactly
     the physics we guessed.
   - The answer:
     `correlation of sst vs wind: mean -0.18 · p5 -0.72 · p95 0.53 · 66% coverage`,
     plus the caveat line `(gridded r — read as association, not significance)`.

4. What r *means* here: at each cell, take the ~20 date-paired (SST, wind)
   month-values and ask how consistently they move together. r = −1: every
   windier-than-usual month was cooler-than-usual, proportionally. r = 0: no
   linear relationship. The per-cell requirement of **≥ 8 pairs** is why short
   windows produce gray cells.

5. And what it *doesn't* mean: not causation (a shared season can correlate two
   strangers), and not "significance" — neighboring cells move together, so the
   64 800 cells are far fewer than 64 800 independent samples. That's why the
   engine reports n and refuses to print p-values.

## Break it on purpose: switching to spatial

6. Change the correlate node's `mode` to `spatial`. **The display node
   instantly turns red.** Hover it: *"input `value` of display expects
   field | stack, got scalar"* — spatial correlation produces a single number,
   and you can't draw a number as a map. This is the type system working: the
   editor told you at edit time, not at run time.
7. Right-click the display node → **✕ delete node**. The graph is valid again
   (the answer sink is still there — every program needs at least one sink).
8. **▶ Run.** One number: the *spatial* correlation between the two
   time-averaged maps. It answers a totally different question — not "do they
   move together over time" but **"do their geographies look alike?"** Windy
   regions (the Southern Ocean) and warm regions (the tropics) are mostly
   different places, so expect a negative number here too — but for an
   unrelated reason. Keeping the two modes straight is the main skill of this
   tutorial:

   | | temporal | spatial |
   | --- | --- | --- |
   | Pairs | frames over time, per cell | cells across the map |
   | Output | a map of r | one number |
   | Question | do they wiggle together in time? | do their patterns coincide? |

## The positive counterpart

9. Rebuild the temporal version (put `mode` back and re-add the display — or
   load the built-in **SST × wind coupling** from the *graphs…* dropdown), then
   change the first layer to `waves`. Wave height vs wind speed is the same
   program shape with opposite physics: the map comes back **strongly positive
   nearly everywhere**, because wind *makes* waves. Comparing the two maps —
   same code, mirrored sign — is the fastest way to build intuition for what a
   correlation map is showing you. (This pair ships as the built-ins
   **SST × wind coupling** and **Wind makes waves**.)

## The finished temporal program

```json
{ "nodes": [
  { "id": "sst", "op": "layer", "params": { "layer": "sst", "start": "2023-01", "stepMonths": 2 } },
  { "id": "wind", "op": "layer", "params": { "layer": "wind", "component": "speed", "start": "2023-01", "stepMonths": 2 } },
  { "id": "r", "op": "correlate", "inputs": { "a": "sst", "b": "wind" }, "params": { "mode": "temporal" } },
  { "id": "map", "op": "display", "inputs": { "value": "r" }, "params": { "title": "r · SST × wind speed" } },
  { "id": "ans", "op": "answer", "inputs": { "value": "r" }, "params": { "label": "per-cell r: SST vs wind speed" } }
] }
```

**Experiments:** correlate `airtemp` × `humidity` (GFS layers cover land too);
insert a **mask** node with a `region` preset between a layer and the correlate
to focus one basin; try `mode: spatial` between `chl` and `sst` — the built-in
**Warm seas are deserts** — and see why one number is sometimes exactly enough.

Next: [El Niño Composites](./03-enso-composites.md) — graphs that branch.
