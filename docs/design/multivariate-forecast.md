# Multivariate SST-anomaly forecaster — scope

Status: **scoped, not started** (2026-08-15).
Current model: `assets/geo/sst_anom_forecast.tflite`, trained by [`tools/geo/train_forecast.py`](../../tools/geo/train_forecast.py),
run on-device by [`src/ui/analysis_forecast.ts`](../../src/ui/analysis_forecast.ts).

## What exists

A ~47k-parameter fully-convolutional residual CNN. Input: the last **4 monthly OISST anomaly
fields** on the 360×180 (1°) analysis grid, scaled by 1/5, land zero-filled. Output: the next
month, predicted as `last_month + delta` — so it learns the *departure from persistence*, not the
field itself. Masked MSE over valid ocean cells, most recent 12 targets held out.

Scores from its sidecar (`trainedOn: 2016-01..2025-06`): **val MAE 0.4265 °C vs persistence
0.4797 °C** — an 11% edge over "tomorrow looks like today".

Two separate things are being asked of this document, and they should not be confused:

1. **A catch-up retrain.** The baked atlas now runs to 2026-06; the model has never seen the last
   12 months. That is one command and is not this document.
2. **Adding input channels.** That is this document, and it is a new model.

## The constraint that decides everything: record length and cadence

Training reads the repo's **baked** atlases, not live feeds. So a candidate channel is only cheap
if it is already baked, monthly, on a compatible grid. Measured, not assumed:

| Baked asset | Frames | Cadence | Grid | Span |
|---|---|---|---|---|
| `oisst_anom_stack` | 126 | monthly | 720×360 | 2016-01 → 2026-06 |
| `oisst_sst_stack` | 126 | monthly | 720×360 | 2016-01 → 2026-06 |
| `oisst_ice_stack` | 126 | monthly | 720×360 | 2016-01 → 2026-06 |
| `chl_stack` | **32** | **4-monthly** | 600×300 | 2016-01 → 2026-05 |
| `currents_stack` | **30** | **4-monthly** | 450×225 | 2016-09 → 2026-05 |

Chlorophyll and currents are baked at the explorer's display cadence (4 months), **not** monthly.
They cannot supply monthly channels without re-baking.

Live-only candidates, by coverage floor (from `ANALYSIS_META`):

| Layer | Floor | Monthly frames | Verdict |
|---|---|---|---|
| waves / swell / windsea / period | 2017-02 | 113 | viable, needs baking |
| precip (PERSIANN) | 2016-01 | 126 | viable, needs baking, ±60° only |
| wind (u,v), pressure, airtemp, humidity | 2022-12 | **44** | too short — see below |
| mhw | 2024-07 | 24 | too short, and ordinal |
| solar / swup / lwup / lwdown | 2026-01 | **8** | unusable |
| dhw, baa | 2016-01 | 126 | **excluded: leakage** |

**Leakage note.** DHW and the bleaching alert level are rolling functions of the SST anomaly
itself. Feeding them in looks like extra information and is mostly the target's own history
laundered through a different scale. Excluded on principle, not on record length.

**Why 44 months is not enough.** Samples = `frames − 4`, minus a 12-month holdout. The full record
gives 110 training months; the GFS-era record gives **28**. Fields are strongly
spatially autocorrelated, so the effective sample size tracks the number of independent *months*,
not the 7.1M supervised pixels. Widening the input while cutting the record to a quarter is the
textbook way to manufacture a validation score that does not survive contact with next year.

This is the painful part of the answer: **wind is the physically strongest driver available
(mixing, upwelling, evaporation) and it is the one we can least afford to include.**

## A second constraint: the runtime must stay instant

Today `forecast` needs one stack, and it is baked and already resident. Every channel added is
another `store.getStack` at forecast time. If a channel is live-only, the forecast op becomes a
network round-trip to ERDDAP per month of input — turning an on-device inference into a
multi-second remote fetch, inside an analysis graph that is meant to feel immediate.

**Therefore: every input channel must be baked.** That is a hard design rule, not a preference,
and it is what rules wind out twice over.

## Staging

### Stage 1 — free channels (recommended first)

Channels: `anom` (target + input), `sst`, `ice`. All 126 monthly frames, same 720×360 grid, same
product family, already baked, already 2×2-block-averaged to 360×180 by the training script.

- Input tensor: (180, 360, **12**) — 3 channels × 4 months, up from 4.
- Parameter change: only the first conv layer widens (4→12 input planes): ~47k → ~57k params,
  ~190 KB → ~215 KB of `.tflite`. Negligible.
- Runtime cost: the forecast op additionally pulls `oisst_sst_stack` (13.8 MB) and
  `oisst_ice_stack` (2.9 MB) on first use. Both are stacks the explorer already knows how to load.
- Physical rationale: `sst` supplies the absolute state the anomaly is a departure *from* — a
  +1 °C anomaly behaves differently in a 28 °C tropical pool than in a 5 °C subpolar gyre — and
  the seasonal cycle. `ice` supplies the ice-edge feedback that governs high-latitude SST.

### Stage 1b — subsurface (NEW, 2026-08-15: source found and baker written)

`tools/geo/bake_argo_subsurface.mjs` bakes the
Roemmich-Gilson gridded Argo climatology (`rg09`, via the keyless CORS-open Argovis API) into two
monthly atlases: `argo_t300_stack` (mean potential temperature 0–300 db) and `argo_d20_stack`
(depth of the 20 °C isotherm). Both land on the 1° analysis grid **natively** — no resample, unlike
Stage 2's currents.

This is the strongest channel candidate found so far, on the physics: the equatorial thermocline
leads Niño 3.4 by roughly two seasons, so a surface-only model is predicting the response from the
response. Coverage is 64.5°S–79.5°N, ocean only, ~31.8k of 64.8k cells; Argo does not sample
marginal seas or under ice, and those cells are absent rather than zero.

Record: 2004-01 → present (~270 months), which is **more than double** the 126-month OISST atlas.
That cuts both ways — the joint training window is still bounded by the shorter input, so pairing
it with the current SST atlas gains nothing in length unless SST is re-baked from
`ncdcOisst21Agg` (1981-09 → present, CoastWatch, no CORS → bake). Doing both would take the
trainable record from 126 months to ~270.

### Stage 2 — currents, if Stage 1 clears its gate

Advection is the actual mechanism by which an anomaly moves, and it is the highest-value channel
we could add. Cost: re-bake `bake_currents.mjs` at monthly cadence (asset grows ~4×, ~3.6 MB →
~14 MB), plus a resample from 450×225 to 360×180 — the training script's 2×2 block-mean assumes
an exact 2× grid and would need a general area-weighted resample. Two channels (u, v).

### Stage 3 — waves and precip, only if Stage 2 clears

Both need a new baking script and a bulk ERDDAP pull (113 and 126 monthly frames). Waves are a
wind proxy that gets us some of wind's physics on a long record, which is the only honest route
to that signal.

### Not scoped: wind, pressure, radiation, mhw

Revisit wind when its archive reaches ~100 months (≈2031 at the current floor), or if a longer
reanalysis with a CORS-open ERDDAP endpoint turns up. A separate short-record experiment
(2022-12→now, wind vs no-wind, same 12-month holdout) is a cheap way to *measure* whether wind
adds skill before anyone invests in baking it — but its result must not be used to claim skill for
the shipped model.

## Robustness: channel dropout

A missing channel at runtime is a shape mismatch, i.e. a hard failure. Train with **channel
dropout** — randomly zero whole channels for some fraction of training batches — so the model
degrades to roughly its univariate skill when a stack fails to load, instead of not running. Note
the ambiguity this creates: zero already means "land". Consider carrying a per-channel validity
plane if dropout proves to confuse the model near coastlines.

## Evaluation protocol (the part that decides go/no-go)

Same 12-month holdout, same persistence baseline, and an **ablation table** run with identical
seeds and splits:

| Variant | Channels | Expected |
|---|---|---|
| baseline | anom | ~0.43 °C (retrained; the 0.4265 figure is a year stale) |
| A | anom + sst | ? |
| B | anom + sst + ice | ? |
| C | + currents (Stage 2) | ? |

Report **per-held-out-month MAE**, not just the aggregate: 12 months is few enough that one
anomalous month moves the mean, and a pairwise comparison across the same 12 months is far more
informative than two summary numbers. A block bootstrap over held-out months gives an honest
interval.

**Go/no-go gate: a variant ships only if it beats the univariate baseline by ≥ 0.01 °C MAE on the
same split AND wins in ≥ 8 of the 12 held-out months.** Below that it is noise, and the extra
channels cost bytes, load time and complexity for nothing.

Be realistic about the ceiling. One-month SST anomaly is dominated by persistence — the current
model's whole edge is 11%. Extra channels plausibly buy a few percent of that. The larger prize is
**longer leads** (3–6 months, where the model currently rolls its own output and compounds its
errors) and that may be better attacked by training a direct multi-lead model than by widening the
input.

## Code changes

- `tools/geo/train_forecast.py` — load N atlases, resample each to 360×180, stack as channels,
  channel dropout, ablation loop, per-month val report. The concrete batch-1 export signature and
  the `last + delta` skip (from the anomaly channel) must survive.
- `assets/geo/sst_anom_forecast.json` — record the channel list and per-channel scales.
- `src/ui/analysis_forecast.ts` — `inputMonths` alone no longer describes the input; fetch C
  stacks via `store.getStack`, align by date, interleave into (H, W, C×M). Bump
  `FORECAST_VERSION` (and the mirrored string in `src/main.ts`).
- `src/analysis/field_store.ts` — `forecastKey` already includes the version, so a bump
  invalidates cached forecasts correctly. No signature change needed.
- `src/analysis/ast.ts` — the `forecast` op's `layer` enum stays `['anom']`; the extra layers
  are *inputs*, not targets. Worth a doc-string note so nobody assumes they became forecastable.

## Recommendation

Do the **catch-up retrain first** — it is one command, it is a strictly better model than what
ships today, and it establishes the honest baseline every ablation is measured against. Then run
Stage 1, which costs nothing but training time. Treat Stage 2 as a real project (asset re-bake +
resampling) and only start it if Stage 1 clears the gate.
