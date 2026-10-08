# Analysis Tutorials

A step-by-step series for the **analysis graph** — the dataflow language that
answers questions about Earth Explorer's data ("is sea temperature
correlated with wind?", "how fast is the ocean warming?"). The tutorials focus
on the **graph editor**, the visual front end where you build and edit analysis
programs node by node.

These tutorials are the *guided path*; the
[Analysis module guide](../analysis.md) is the *reference* — every
node type, param, and statistical convention is documented there. The story of
the app itself is in the [deep-dive](../deep-dive.md).

> **Setup.** Everything runs inside the app: open the
> [hosted build](https://brendan-duncan.github.io/earth_explorer/) (or `npm run dev` and `http://localhost:5173/`), and click the
> **⚗ Analysis** button in the top bar. No build steps, no API keys (only
> tutorial 5's Ask tab wants one), and the data streams from public NOAA/NASA
> feeds — nothing to install.

## The path

| # | Tutorial | You'll learn |
| --- | --- | --- |
| 1 | [Your First Graph](./01-first-graph.md) | The editor itself: right-click to add nodes, drag ports to connect, set params, run, read the map + answer, share a link. Builds a "how fast is the ocean warming" trend map. |
| 2 | [Correlation Maps](./02-correlation-maps.md) | Temporal vs spatial correlation — the same formula asking two different questions. Builds SST × wind, flips it to a single spatial number, and reads both honestly. |
| 3 | [El Niño Composites](./03-enso-composites.md) | Branching graphs: filter one stack two ways by ENSO phase, average each branch, subtract. The classic ENSO dipole from first principles. |
| 4 | [Series, Charts & Lag](./04-series-and-lag.md) | From maps to time series: regions, `areaMean`, the chart sink, and `correlateSeries` with lags — does ENSO *lead* global ocean warmth? |
| 5 | [Ask, Then Edit](./05-ask-and-edit.md) | The AI front end: let Claude write the program, inspect it in the Graph tab, tweak it yourself, and keep the conversation in sync. |

Each tutorial ends with the finished program as JSON — compare against yours,
or use it to recover if you get lost (the **Graph** tab's built-in dropdown also
carries finished versions of several of these).

## Cheat sheet

- **Right-click empty canvas** → add a node (grouped by sources / transform /
  reduce / combine / sinks). **Right-click a node** → delete / disconnect.
- **Drag an output dot** (right edge) onto an input dot (left edge) to connect.
  Ports that would reject the connection dim while you drag.
- **Drag empty canvas** (or middle-mouse anywhere) to pan, **wheel** to zoom,
  **⟲** to reset the view.
- **Click an input dot or an edge** to disconnect it.
- Port colors are the value types: <span>stack</span> blue, field lavender,
  series teal, scalar amber, region green.
- Red-bordered nodes have validation errors — hover for the message; the line
  above the canvas shows the first few.
- **▶ Run** executes; results appear below the panel and (for `display` sinks)
  on the map itself. Pick any layer or view in the top bar to hand the map back.
- **🔗 Copy link** produces a URL that reopens and reruns the exact program
  (`?prog=`); **💾** saves it as a named preset in the browser.
