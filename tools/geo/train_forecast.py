"""Trains the SST-anomaly forecaster behind the analysis graph's `forecast` op.

Data: the repo's baked OISST atlases (assets/geo/oisst_<var>_stack.png + .json, produced by
bake_oisst_stack.mjs) — monthly 720x360 frames, red byte = value in [min, max], alpha >= 128 =
valid. Only the OISST family is usable as INPUT: it is the one baked set that is monthly over the
full record (126 frames, 2016-01..). chl and currents are baked at the explorer's 4-month display
cadence, and every other layer is live-only — a live channel would turn this on-device inference
into per-month ERDDAP round-trips. See TODO/multivariate-forecast.md.

Model: a tiny residual CNN on the 1-degree (360x180) analysis grid. Input = the last
INPUT_MONTHS months of each channel (per-channel affine to ~[-1,1], land = 0); output =
last observed ANOMALY + predicted delta, i.e. it learns the departure from persistence. Loss is
masked MSE over valid ocean cells; the last 12 targets are held out for validation.

Channels beyond `anom` are dropped at random during training (CHANNEL_DROPOUT) so that a stack
which fails to load at runtime degrades toward univariate skill instead of a shape mismatch.

Ablation: `--ablate` trains the channel ladder against one split and one seed and prints a
per-held-out-month table. A wider variant is only EXPORTED if it clears the gate agreed in
TODO/multivariate-forecast.md: >= GATE_MAE_GAIN degC better on aggregate MAE *and* better in at
least GATE_MONTHS of the 12 held-out months. Anything less is noise, and the extra channels would
cost bytes and load time for nothing.

Outputs float32 assets/geo/sst_anom_forecast.tflite + a sidecar json with the channel list, the
per-channel normalization constants and the validation metrics. The .tflite is exported with a
CONCRETE batch-1 signature — LiteRT.js rejects dynamic (-1) dims at run().

After retraining, bump FORECAST_VERSION in samples/lib/analysis_forecast.ts and the forecaster
registration in samples/geo_gis_explorer.ts (cache keys include it), and mirror any channel
change into CHANNELS there.

Usage (any Python 3.10+):
    python -m venv .tfenv && .tfenv/Scripts/pip install tensorflow-cpu pillow numpy
    .tfenv/Scripts/python tools/geo/train_forecast.py              # train the shipped config
    .tfenv/Scripts/python tools/geo/train_forecast.py --ablate     # + the channel ladder
    .tfenv/Scripts/python tools/geo/train_forecast.py --channels anom,sst
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
OUT_TFLITE = REPO / "assets/geo/sst_anom_forecast.tflite"
OUT_META = REPO / "assets/geo/sst_anom_forecast.json"

INPUT_MONTHS = 4
VAL_MONTHS = 12      # hold out the most recent N targets
W, H = 360, 180      # analysis grid
CHANNEL_DROPOUT = 0.15
GATE_MAE_GAIN = 0.01   # degC an extra channel must buy on aggregate val MAE
GATE_MONTHS = 8        # ...and in at least this many of the VAL_MONTHS held-out months

# Per-channel encoding: x = (physical - offset) / scale, chosen to land in ~[-1, 1]. `anom` keeps
# its historical 1/5 scaling so the residual skip stays in the units the op returns. The list here
# is the SHIPPED config; --channels overrides it.
CHANNELS = {
    "anom": {"atlas": "oisst_anom_stack", "offset": 0.0, "scale": 5.0},
    "sst": {"atlas": "oisst_sst_stack", "offset": 15.0, "scale": 20.0},
    "ice": {"atlas": "oisst_ice_stack", "offset": 0.5, "scale": 0.5},
}
DEFAULT_CHANNELS = ["anom", "sst", "ice"]
ABLATION_LADDER = [["anom"], ["anom", "sst"], ["anom", "sst", "ice"]]

parser = argparse.ArgumentParser()
parser.add_argument("--channels", default=",".join(DEFAULT_CHANNELS))
parser.add_argument("--ablate", action="store_true", help="train the channel ladder and gate")
parser.add_argument("--epochs", type=int, default=300)
parser.add_argument("--no-export", action="store_true")
args = parser.parse_args()


def load_atlas(name: str) -> tuple[np.ndarray, list[str]]:
    """One baked atlas -> (frames, H, W) physical values with NaN where invalid, plus its dates."""
    spec = CHANNELS[name]
    meta = json.loads((REPO / f"assets/geo/{spec['atlas']}.json").read_text())
    frames, aw, ah = meta["frames"], meta["width"], meta["height"]
    vmin, vmax = meta["min"], meta["max"]
    Image.MAX_IMAGE_PIXELS = None
    px = np.asarray(Image.open(REPO / f"assets/geo/{spec['atlas']}.png").convert("RGBA"), dtype=np.uint8)
    assert px.shape == (ah * frames, aw, 4), (name, px.shape)
    red = px[..., 0].astype(np.float32).reshape(frames, ah, aw)
    valid = (px[..., 3] >= 128).reshape(frames, ah, aw)
    phys = vmin + red / 255.0 * (vmax - vmin)
    phys[~valid] = np.nan
    if ah == H and aw == W:
        # The full-record atlases (1981→) are baked straight onto the 1° analysis grid.
        grid = phys.astype(np.float32)
    else:
        # 2x2 valid-mean down to the analysis grid (the older 0.5° atlases); a channel on another
        # grid would need a general area-weighted resample (see Stage 2).
        assert ah == 2 * H and aw == 2 * W, f"{name}: {aw}x{ah} is neither the analysis grid nor 2x it"
        blocks = phys.reshape(frames, H, 2, W, 2)
        bvalid = valid.reshape(frames, H, 2, W, 2)
        cnt = bvalid.sum(axis=(2, 4))
        s = np.where(bvalid, blocks, 0.0).sum(axis=(2, 4))
        grid = np.where(cnt > 0, s / np.maximum(cnt, 1), np.nan).astype(np.float32)
    print(f"  {name}: {frames} frames {aw}x{ah} [{vmin}, {vmax}] {meta['dates'][0]}..{meta['dates'][-1]}"
          f" valid {np.isfinite(grid).mean():.3f}")
    return grid, [d[:7] for d in meta["dates"]]


def build_samples(channels: list[str], grids: dict[str, np.ndarray]):
    """X = (N, H, W, months*channels) month-major, Y = next anomaly, M = target validity."""
    anom = grids["anom"]
    n = anom.shape[0]
    xs, ys, ms = [], [], []
    for t in range(INPUT_MONTHS - 1, n - 1):
        planes = []
        for m in range(t - INPUT_MONTHS + 1, t + 1):        # month-major: [m0c0, m0c1, ..., m3cN]
            for c in channels:
                spec = CHANNELS[c]
                v = (grids[c][m] - spec["offset"]) / spec["scale"]
                planes.append(np.nan_to_num(v, nan=0.0))
        tgt = anom[t + 1] / CHANNELS["anom"]["scale"]
        xs.append(np.stack(planes, axis=-1).astype(np.float32))
        ys.append(np.nan_to_num(tgt, nan=0.0).astype(np.float32)[..., None])
        ms.append(np.isfinite(tgt).astype(np.float32)[..., None])
    return np.stack(xs), np.stack(ys), np.stack(ms)


def make_model(n_channels: int, tf):
    """Residual CNN. The skip is the LAST month's anomaly plane, so the net predicts a delta."""
    planes = INPUT_MONTHS * n_channels
    inp = tf.keras.Input(shape=(H, W, planes))
    x = ChannelDropout(n_channels, CHANNEL_DROPOUT)(inp)
    h = tf.keras.layers.Conv2D(48, 5, padding="same", activation="relu")(x)
    h = tf.keras.layers.Conv2D(48, 3, padding="same", activation="relu")(h)
    h = tf.keras.layers.Conv2D(48, 3, padding="same", activation="relu")(h)
    delta = tf.keras.layers.Conv2D(1, 3, padding="same")(h)
    last_anom = inp[..., (INPUT_MONTHS - 1) * n_channels: (INPUT_MONTHS - 1) * n_channels + 1]
    out = tf.keras.layers.Add()([last_anom, delta])
    return tf.keras.Model(inp, out)


import tensorflow as tf  # noqa: E402  (imported after the cheap failure points)


class ChannelDropout(tf.keras.layers.Layer):
    """Zeroes an entire non-anomaly channel (all of its months at once) during training.

    Per-plane dropout would teach the model to interpolate a missing MONTH, which never happens:
    at runtime a stack either loads or it does not. Dropping the channel across every month is the
    failure the runtime can actually produce, and training against it is what lets the model fall
    back toward univariate skill instead of returning nonsense.
    """

    def __init__(self, n_channels: int, rate: float, **kw):
        super().__init__(**kw)
        self.n_channels = n_channels
        self.rate = rate

    def call(self, x, training=None):
        if not training or self.rate <= 0 or self.n_channels < 2:
            return x
        b = tf.shape(x)[0]
        # One keep/drop decision per (sample, channel); channel 0 (anom) is never dropped.
        keep = tf.cast(tf.random.uniform([b, 1, 1, self.n_channels]) >= self.rate, x.dtype)
        keep = tf.concat([tf.ones_like(keep[..., :1]), keep[..., 1:]], axis=-1)
        mask = tf.tile(keep, [1, 1, 1, INPUT_MONTHS])          # month-major tiling
        return x * tf.reshape(mask, [b, 1, 1, INPUT_MONTHS * self.n_channels])

    def get_config(self):
        return {**super().get_config(), "n_channels": self.n_channels, "rate": self.rate}


def masked_mse(y_true, y_pred):
    return tf.square(y_true - y_pred)


def train_variant(channels: list[str], grids: dict[str, np.ndarray], dates: list[str], epochs: int):
    """Trains one channel set. Returns the model and its per-held-out-month val MAE (degC)."""
    X, Y, M = build_samples(channels, grids)
    n_val = VAL_MONTHS
    n_train = len(X) - n_val
    scale = CHANNELS["anom"]["scale"]
    tf.keras.utils.set_random_seed(7)   # same seed for every variant: the split and init are fixed
    model = make_model(len(channels), tf)
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss=masked_mse, weighted_metrics=["mae"])
    early = tf.keras.callbacks.EarlyStopping(monitor="val_mae", patience=25, restore_best_weights=True)
    model.fit(
        X[:n_train], Y[:n_train], sample_weight=M[:n_train],
        validation_data=(X[n_train:], Y[n_train:], M[n_train:]),
        epochs=epochs, batch_size=8, verbose=2, callbacks=[early],
    )
    pred = model.predict(X[n_train:], verbose=0)
    err = np.abs(pred - Y[n_train:]) * M[n_train:]
    per_month = (err.sum(axis=(1, 2, 3)) / M[n_train:].sum(axis=(1, 2, 3)) * scale)
    return model, per_month, X.shape[-1], dates[-n_val:]


print("loading atlases")
requested = [c.strip() for c in args.channels.split(",") if c.strip()]
needed = sorted({c for v in (ABLATION_LADDER if args.ablate else [requested]) for c in v})
for c in needed:
    if c not in CHANNELS:
        sys.exit(f"unknown channel {c!r}; known: {', '.join(CHANNELS)}")
loaded = {c: load_atlas(c) for c in needed}
grids = {c: g for c, (g, _) in loaded.items()}
date_sets = {c: d for c, (_, d) in loaded.items()}

# Channels must describe the SAME months. The OISST atlases are baked together and always have,
# but an assumption that silently shifts one channel by a month would look like a modelling result.
common = [d for d in date_sets["anom"] if all(d in date_sets[c] for c in needed)]
if any(date_sets[c] != date_sets["anom"] for c in needed):
    print(f"  aligning to {len(common)} shared months")
    for c in needed:
        idx = [date_sets[c].index(d) for d in common]
        grids[c] = grids[c][idx]
dates = common

# Persistence baseline: predict(t+1) = anomaly(t). The number every variant must beat.
_, Yp, Mp = build_samples(["anom"], grids)
n_val = VAL_MONTHS
pers_pred = np.stack([grids["anom"][t] / CHANNELS["anom"]["scale"]
                      for t in range(INPUT_MONTHS - 1, len(dates) - 1)])[..., None]
pers_err = np.abs(np.nan_to_num(pers_pred[-n_val:], nan=0.0) - Yp[-n_val:]) * Mp[-n_val:]
pers_month = pers_err.sum(axis=(1, 2, 3)) / Mp[-n_val:].sum(axis=(1, 2, 3)) * CHANNELS["anom"]["scale"]
pers_mae = float(pers_month.mean())
print(f"persistence val MAE: {pers_mae:.4f} degC over {dates[-n_val:][0]}..{dates[-1]}")

variants = ABLATION_LADDER if args.ablate else [requested]
results = []
for chans in variants:
    print(f"\n=== training [{', '.join(chans)}] ===")
    model, per_month, planes, val_dates = train_variant(chans, grids, dates, args.epochs)
    mae = float(per_month.mean())
    print(f"  val MAE {mae:.4f} degC ({planes} input planes, {model.count_params()} params)")
    results.append({"channels": chans, "model": model, "per_month": per_month, "mae": mae})

base = results[0]
print("\n=== ablation ===")
print(f"{'channels':28} {'val MAE':>9} {'vs base':>9} {'months won':>11}")
print(f"{'persistence':28} {pers_mae:9.4f} {pers_mae - base['mae']:+9.4f} {'-':>11}")
for r in results:
    won = int((r["per_month"] < base["per_month"]).sum())
    print(f"{','.join(r['channels']):28} {r['mae']:9.4f} {base['mae'] - r['mae']:+9.4f}"
          f" {won if r is not base else '-':>11}")
print("\nper held-out month (degC MAE)")
print(f"{'month':9} {'persist':>8} " + " ".join(f"{','.join(r['channels'])[:12]:>12}" for r in results))
for i, d in enumerate(dates[-n_val:]):
    print(f"{d:9} {pers_month[i]:8.4f} " + " ".join(f"{r['per_month'][i]:12.4f}" for r in results))

# The gate: a wider variant ships only if it is better by a margin AND consistently, not on
# aggregate alone — 12 months is few enough that one anomalous month moves the mean.
best = base
for r in results[1:]:
    gain = base["mae"] - r["mae"]
    won = int((r["per_month"] < base["per_month"]).sum())
    passed = gain >= GATE_MAE_GAIN and won >= GATE_MONTHS
    print(f"gate [{','.join(r['channels'])}]: gain {gain:+.4f} degC (need >= {GATE_MAE_GAIN}),"
          f" won {won}/{n_val} (need >= {GATE_MONTHS}) -> {'PASS' if passed else 'fail'}")
    if passed and r["mae"] < best["mae"]:
        best = r
print(f"\nexporting [{', '.join(best['channels'])}]")

if args.no_export:
    sys.exit(0)

# Export with a CONCRETE batch-1 signature, training=False so ChannelDropout is a no-op in the
# graph: LiteRT.js rejects dynamic (-1) dims at run().
model = best["model"]
planes = INPUT_MONTHS * len(best["channels"])
run_fn = tf.function(lambda x: model(x, training=False))
concrete = run_fn.get_concrete_function(tf.TensorSpec([1, H, W, planes], tf.float32))
converter = tf.lite.TFLiteConverter.from_concrete_functions([concrete], run_fn)
tfl = converter.convert()
OUT_TFLITE.write_bytes(tfl)
n_train = len(dates) - 1 - (INPUT_MONTHS - 1) - VAL_MONTHS
OUT_META.write_text(json.dumps({
    "version": 2,
    "inputMonths": INPUT_MONTHS,
    # Plane order is MONTH-MAJOR: [m0c0, m0c1, ..., m3cN]. analysis_forecast.ts must match.
    "channels": [{"layer": c, **{k: CHANNELS[c][k] for k in ("offset", "scale")}} for c in best["channels"]],
    "width": W,
    "height": H,
    "trainedOn": f"{dates[0]}..{dates[n_train + INPUT_MONTHS - 1]}",
    "valWindow": f"{dates[-VAL_MONTHS]}..{dates[-1]}",
    "valMaeC": round(best["mae"], 4),
    "persistenceMaeC": round(pers_mae, 4),
    "ablation": [{"channels": r["channels"], "valMaeC": round(r["mae"], 4)} for r in results],
    "source": "trained on the repo's baked NOAA OISST v2.1 atlases",
}, indent=2) + "\n")
print(f"wrote {OUT_TFLITE} ({len(tfl)} bytes) + sidecar")
