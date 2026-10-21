# 1 — Your First Graph

*You'll learn: the graph editor's core moves — adding nodes with right-click,
connecting typed ports, setting params, running, and reading the result — by
building a genuinely interesting map: how fast every patch of ocean has warmed
or cooled since 2016.*

The question we're answering: **"What's the sea-surface temperature trend, per
decade, everywhere on Earth?"** Four nodes: a data source, a reduction, and two
sinks.

```
layer(sst) ──► trend ──┬──► display   (the map)
                       └──► answer    (the numbers)
```

## Open the editor

1. Open the [hosted build](https://brendan-duncan.github.io/earth_explorer/), or `npm run dev` and `http://localhost:5173/`.
2. Click **⚗ Analysis** in the top bar, then the **Graph** tab. The panel widens
   into a toolbar, an issue line, and an empty canvas.
3. Try the navigation before adding anything: drag the empty canvas to pan,
   scroll to zoom (it anchors at your cursor), press **⟲** in the toolbar to
   reset.

## Add the source

4. **Right-click** anywhere on the canvas. The add-node menu opens, grouped the
   way the language is organized — *sources, transform, reduce, combine, sinks*.
   Hover any entry for a one-line description.
5. Pick **layer** (under *sources*). A node card appears at the click point with
   the explorer's first layer, `sst`, already selected.
6. Set its params (they commit when the field loses focus):
   - `start` → `2016-01`
   - `stepMonths` → `1` (monthly frames — trends like dense sampling)
   - leave `end` empty (defaults to now) and `component` at `—` (that's only
     for vector layers like wind).

   Notice the **blue dot** on the node's right edge — that's its output port,
   and blue is the color of a `stack` (time × grid). Port colors are how you
   read a graph at a glance.

## Reduce time away

7. Right-click to the right of the layer node and add **trend** (under
   *reduce*). Its input port `value` is blue too — it wants a stack.
8. **Drag from the layer's output dot onto trend's `value` dot.** While you
   drag, watch the other ports: anything that would reject the connection dims
   out. Release on the dot and a colored edge appears.

   `trend` fits a least-squares slope through every cell's monthly values and
   reports it **per decade** — turning ~120 maps into one map of "°/decade".
   Its output dot is **lavender**: a `field`, one grid with no time axis left.

## Sink it

9. Add **display** (under *sinks*) and connect `trend → display.value`. Set its
   `title` param to something like `SST trend per decade`.
10. Add **answer** and connect `trend → answer.value` too (one output can feed
    many inputs). Set `label` to `SST trend per decade`. The `label` is
    required — leave it empty and the node turns red; hover it to read the
    validation message. That red-badge feedback is live on every edit.

## Run it

11. Press **▶ Run**. The status line below walks through
    `Loading data…` (the baked OISST stack, a few seconds) → `Computing…` →
    `done · ~7M cell-ops`.

    Three things happen:
    - **The map takes over the display**: a diverging red/blue map on a
      symmetric legend — red where the ocean warmed, blue where it cooled. The
      legend range came from the data's percentiles automatically, because
      `trend` marks its output as a relative (signed) quantity.
    - **The answer line** appears: something like
      `SST trend per decade: mean +0.4°F · p5 -1.8°F · p95 +4°F · 67% coverage`,
      followed by a second line reporting how much of that map survives a
      significance test — `41% of 38214 testable cells reach p ≤ 0.05 (24%
      reach p ≤ 0.01); median n_eff ≈ 14.2`.
      (Formatting follows the explorer's °F/°C toggle.)
    - The stats line under the legend updates with the displayed field's
      min/mean/max.

12. Read it like an oceanographer: the global mean is positive (the ocean is
    warming), but the map is the real story — warming isn't uniform, and a few
    regions actually cooled over this window. That's exactly why the engine
    always offers a map next to a number.

    Now read the *second* line, which is the difference between a picture and a
    result. `trend` fits a slope in every cell whether or not there is evidence
    for it, so a fair part of any trend map is noise that happens to lean. The
    `n_eff` figure is why: sea temperature is persistent, so consecutive monthly
    frames are not independent observations, and the test discounts the frame
    count by the residuals' lag-1 autocorrelation before computing p. A cell
    with 120 frames may carry only ~14 independent samples.

    Set `display`'s `stipple` param to `0.05` and re-run. Every cell keeps its
    colour, and the ones whose warming is *not* distinguishable from zero get a
    dot screen over them. On a ten-year window that is most of the ocean — and
    seeing the pattern and its weakness at the same time is the point. The
    legend caption says which test ran and how many cells it marked.

    There is also `trend`'s `significance` param, which **removes** the failing
    cells instead of marking them. Prefer `stipple` for anything you are going
    to look at: a blanked cell is indistinguishable from missing data, and the
    estimate is gone. Reach for `significance` when you want the weak cells
    excluded from something downstream — an `areaMean` over only the cells that
    passed, say.

    Neither one marks cells that could not be tested at all (too few frames).
    *Untestable* is not *insignificant* — it is the absence of a verdict, not a
    verdict of "no effect".

13. To hand the map back to the normal explorer, just pick any layer or view in
    the top bar. Your graph stays in the editor.

## Share it

14. Press **🔗 Copy link**. The URL encodes your whole program (`?prog=…`);
    anyone opening it gets the panel on the Graph tab with this exact graph
    loaded *and already running*.
15. To keep it locally instead, type a name in the toolbar's `preset name` box
    and press **💾** — it appears in the *graphs…* dropdown under **mine**,
    next to the **built-in** examples.

## The finished program

```json
{ "nodes": [
  { "id": "layer1", "op": "layer", "params": { "layer": "sst", "start": "2016-01", "stepMonths": 1 } },
  { "id": "trend2", "op": "trend", "inputs": { "value": "layer1" } },
  { "id": "display3", "op": "display", "inputs": { "value": "trend2" }, "params": { "title": "SST trend per decade" } },
  { "id": "answer4", "op": "answer", "inputs": { "value": "trend2" }, "params": { "label": "SST trend per decade" } }
] }
```

(Your node ids will differ — they're generated as you add nodes and only need
to be unique.)

**Experiments before moving on:** change `layer` to `ice` and re-run (the
Arctic's trend map is sobering); shorten the window to `start: 2022-01` and
watch cells go gray — with fewer than 8 monthly frames per cell, `trend`
refuses to fit a line, and honest no-data beats a fake slope.

Next: [Correlation Maps](./02-correlation-maps.md) — two layers at once, and the
difference between *temporal* and *spatial* correlation.
