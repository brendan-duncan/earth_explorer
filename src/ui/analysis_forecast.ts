/**
 * The explorer's {@link AnalysisForecaster} implementation: a small convolutional network
 * (trained offline on the repo's baked NOAA OISST anomaly stack, exported as .tflite) run
 * ON-DEVICE with LiteRT.js. `forecast` nodes roll the SST anomaly forward one month at a
 * time: the last {@link inputMonths} observed 1° fields go in as channels, the predicted
 * month comes out, and predictions feed back in for multi-month outlooks.
 *
 * Everything is lazy: the ~9 MB LiteRT WASM runtime and the model load on the first
 * forecast node, never at explorer startup. Compilation prefers the WebGPU accelerator
 * (LiteRT owns its own GPUDevice — tensors cross as CPU arrays, negligible at 360×180)
 * and falls back to XNNPACK WASM where WebGPU compilation fails.
 */

import { loadLiteRt, loadAndCompile, Tensor, type CompiledModel } from '@litertjs/core';
import { AnalysisError } from '../analysis/interpret.js';
import { addMonthsToDate, type CpuField, type CpuStack } from '../analysis/types.js';
import type { FieldStore, ForecastRequest } from '../analysis/field_store.js';
import modelUrl from '../../assets/geo/sst_anom_forecast.tflite?url';

/**
 * Model contract — mirrors the sidecar `assets/geo/sst_anom_forecast.json` written by the
 * training script. Bump the version (here AND in the explorer's forecaster registration)
 * whenever the model is retrained, so cached forecasts don't survive a weights change.
 */
export const FORECAST_VERSION = 'sst-anom-v2';
const inputMonths = 4;   // observed months in, as channels
const scale = 5;         // degC → [-1, 1]
const W = 360;
const H = 180;

let compiled: Promise<{ model: CompiledModel; accelerator: 'webgpu' | 'wasm' }> | null = null;

/** Loads the WASM runtime + model once; prefers WebGPU, falls back to XNNPACK/WASM. */
function getModel(): Promise<{ model: CompiledModel; accelerator: 'webgpu' | 'wasm' }> {
  compiled ??= (async () => {
    await loadLiteRt(new URL('./assets/litert-wasm/', window.location.href).href);
    const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
    try {
      return { model: await loadAndCompile(bytes, { accelerator: 'webgpu' }), accelerator: 'webgpu' as const };
    } catch {
      return { model: await loadAndCompile(bytes, { accelerator: 'wasm' }), accelerator: 'wasm' as const };
    }
  })();
  return compiled;
}

/**
 * Materializes one `forecast` node: fetches the last observed months through the store
 * (so baked/live merging and caching stay in one place) and rolls the model forward.
 */
export async function runForecast(req: ForecastRequest, store: FieldStore): Promise<CpuStack> {
  const end = req.from ?? new Date().toISOString().slice(0, 7);
  const start = addMonthsToDate(`${end}-01`, -(inputMonths + 2)).slice(0, 7);
  const observed = await store.getStack({ layer: req.layer, start, end, stepMonths: 1 });
  const frames = observed.frames.slice(-inputMonths);
  if (frames.length < inputMonths) {
    throw new AnalysisError([{
      message: `forecast needs ${inputMonths} observed months ending ${end}, found ${frames.length}`,
      hint: 'set from to a month with data (the anom layer starts 2016-01)',
    }]);
  }
  const last = frames[frames.length - 1];
  if (last.width !== W || last.height !== H) {
    throw new AnalysisError([{ message: `forecast model expects ${W}×${H} fields, got ${last.width}×${last.height}` }]);
  }

  // Channels-last input [1, H, W, months]: scaled to ~[-1, 1], land/no-data = 0.
  const cells = W * H;
  const input = new Float32Array(cells * inputMonths);
  for (let c = 0; c < inputMonths; c++) {
    const v = frames[c].values;
    for (let i = 0; i < cells; i++) {
      input[i * inputMonths + c] = Number.isFinite(v[i]) ? v[i] / scale : 0;
    }
  }
  const oceanMask = last.values;   // NaN = land, matching every input frame

  const { model, accelerator } = await getModel();
  const out: CpuField[] = [];
  for (let k = 1; k <= req.months; k++) {
    let tensor = new Tensor(input.slice(), [1, H, W, inputMonths]);
    if (accelerator === 'webgpu') {
      tensor = await tensor.moveTo('webgpu');
    }
    const outputs = await model.run(tensor);
    tensor.delete();
    const hostOut = outputs[0].accelerator === 'wasm' ? outputs[0] : await outputs[0].moveTo('wasm');
    const pred = hostOut.toTypedArray() as Float32Array;
    hostOut.delete();

    const values = new Float32Array(cells);
    for (let i = 0; i < cells; i++) {
      values[i] = Number.isFinite(oceanMask[i]) ? pred[i] * scale : NaN;
    }
    out.push({
      width: W, height: H,
      date: addMonthsToDate(last.date, k),
      values,
      unit: last.unit,
      relative: last.relative,
    });

    // Slide the window: drop the oldest channel, append the (scaled) prediction.
    for (let i = 0; i < cells; i++) {
      const base = i * inputMonths;
      for (let c = 0; c < inputMonths - 1; c++) {
        input[base + c] = input[base + c + 1];
      }
      input[base + inputMonths - 1] = Number.isFinite(oceanMask[i]) ? pred[i] : 0;
    }
  }
  return { frames: out };
}
