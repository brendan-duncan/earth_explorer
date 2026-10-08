import { describe, it, expect } from 'vitest';
import { FieldStore, type AnalysisForecaster, type AnalysisFrame, type AnalysisLayerProvider } from '../../src/analysis/field_store.js';
import { AnalysisError } from '../../src/analysis/interpret.js';
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH, type SeriesValue } from '../../src/analysis/types.js';
import type { AnalysisProgram } from '../../src/analysis/ast.js';

/** A fake provider frame sampling a `(lon, lat) → value|null` function. */
function scalarFrame(date: string, fn: (lon: number, lat: number) => number | null): AnalysisFrame & { destroyed: boolean } {
  return {
    meta: { date, vector: false },
    sample: fn,
    destroyed: false,
    destroy(): void {
      this.destroyed = true;
    },
  };
}

function vectorFrame(date: string, fn: (lon: number, lat: number) => { u: number; v: number } | null): AnalysisFrame & { destroyed: boolean } {
  return {
    meta: { date, vector: true },
    sample: () => null,
    sampleVector: fn,
    destroyed: false,
    destroy(): void {
      this.destroyed = true;
    },
  };
}

interface FakeProvider extends AnalysisLayerProvider {
  calls: Array<{ start: string; end: string; stepMonths: number }>;
}

function makeProvider(frames: AnalysisFrame[], overrides: Partial<AnalysisLayerProvider> = {}): FakeProvider {
  const p: FakeProvider = {
    unit: 'degC',
    description: 'fake layer',
    coverage: { start: '2020-01', end: '2024-12' },
    calls: [],
    getFrames(range, stepMonths) {
      p.calls.push({ ...range, stepMonths });
      return Promise.resolve(frames);
    },
    ...overrides,
  };
  return p;
}

describe('FieldStore — ingestion', () => {
  it('resamples a frame onto the 1° grid as physical floats with NaN validity', async () => {
    const frame = scalarFrame('2024-01-01', (_lon, lat) => (lat > 0 ? lat : null));
    const store = new FieldStore({ sst: makeProvider([frame]) });
    const stack = await store.getStack({ layer: 'sst' });
    expect(stack.frames).toHaveLength(1);
    const f = stack.frames[0];
    expect(f.width).toBe(ANALYSIS_WIDTH);
    expect(f.height).toBe(ANALYSIS_HEIGHT);
    expect(f.values[0]).toBeCloseTo(89.5, 4);                   // north pole row center
    expect(f.values[f.values.length - 1]).toBeNaN();            // south: provider returned null
    expect(f.unit).toBe('degC');
    expect(frame.destroyed).toBe(true);                         // ownership transferred
  });

  it('applies the provider unit conversion at ingestion', async () => {
    const frame = scalarFrame('2024-01-01', () => 300);         // Kelvin
    const store = new FieldStore({ airtemp: makeProvider([frame], { convert: (v) => v - 273.15 }) });
    const stack = await store.getStack({ layer: 'airtemp' });
    expect(stack.frames[0].values[0]).toBeCloseTo(26.85, 3);
  });

  it('extracts vector components (speed, u, v)', async () => {
    const frames = (): AnalysisFrame[] => [vectorFrame('2024-01-01', () => ({ u: 3, v: 4 }))];
    const store = new FieldStore({
      wind: {
        unit: 'mps', vector: true, description: 'wind', coverage: { start: '2022-12' },
        getFrames: () => Promise.resolve(frames()),
      },
    });
    const speed = await store.getStack({ layer: 'wind', component: 'speed' });
    expect(speed.frames[0].values[0]).toBeCloseTo(5, 5);
    const u = await store.getStack({ layer: 'wind', component: 'u' });
    expect(u.frames[0].values[0]).toBeCloseTo(3, 5);
    const v = await store.getStack({ layer: 'wind', component: 'v' });
    expect(v.frames[0].values[0]).toBeCloseTo(4, 5);
  });

  it('does not destroy frames a provider marks as shared', async () => {
    const frame = scalarFrame('2024-01-01', () => 1);
    const store = new FieldStore({ sst: makeProvider([frame], { sharedFrames: true }) });
    await store.getStack({ layer: 'sst' });
    expect(frame.destroyed).toBe(false);
  });

  it('sorts ingested frames by date', async () => {
    const frames = [scalarFrame('2024-03-01', () => 3), scalarFrame('2024-01-01', () => 1)];
    const store = new FieldStore({ sst: makeProvider(frames) });
    const stack = await store.getStack({ layer: 'sst' });
    expect(stack.frames.map((f) => f.date)).toEqual(['2024-01-01', '2024-03-01']);
  });
});

describe('FieldStore — requests and caching', () => {
  it('fills defaults from provider coverage and reports them in the sourceKey', () => {
    const store = new FieldStore({ sst: makeProvider([]) }, { defaultStepMonths: 2 });
    expect(store.sourceKey({ layer: 'sst' })).toBe('sst||2020-01|2024-12|2mo');
    expect(store.sourceKey({ layer: 'sst', start: '2023-01', end: '2023-12', stepMonths: 1 })).toBe('sst||2023-01|2023-12|1mo');
  });

  it('caches stacks per normalized request — one provider load for repeat requests', async () => {
    const provider = makeProvider([scalarFrame('2024-01-01', () => 1)]);
    const store = new FieldStore({ sst: provider });
    await store.getStack({ layer: 'sst' });
    await store.getStack({ layer: 'sst' });
    expect(provider.calls).toHaveLength(1);
    await store.getStack({ layer: 'sst', start: '2023-01' });   // different request → new load
    expect(provider.calls).toHaveLength(2);
  });

  it('rejects unknown layers, missing vector components, and backwards ranges', async () => {
    const store = new FieldStore({
      sst: makeProvider([]),
      wind: { unit: 'mps', vector: true, description: 'wind', coverage: { start: '2022-12' }, getFrames: () => Promise.resolve([]) },
    });
    await expect(store.getStack({ layer: 'nope' })).rejects.toThrow(/unknown layer/);
    await expect(store.getStack({ layer: 'wind' })).rejects.toThrow(/vector field/);
    await expect(store.getStack({ layer: 'sst', component: 'u' })).rejects.toThrow(/scalar/);
    await expect(store.getStack({ layer: 'sst', start: '2024-06', end: '2024-01' })).rejects.toThrow(/empty date range/);
  });

  it('exposes the catalog with resolved coverage', () => {
    const store = new FieldStore({ sst: makeProvider([], { caveats: 'ocean only' }) });
    const [entry] = store.catalog();
    expect(entry.key).toBe('sst');
    expect(entry.coverage.end).toBe('2024-12');
    expect(entry.caveats).toBe('ocean only');
  });
});

describe('FieldStore — resolveSources', () => {
  const program: AnalysisProgram = {
    nodes: [
      { id: 'a', op: 'layer', params: { layer: 'sst', start: '2024-01', end: '2024-06' } },
      { id: 'oni', op: 'enso' },
      { id: 'mean', op: 'areaMean', inputs: { value: 'a' } },
      { id: 'r', op: 'correlateSeries', inputs: { a: 'mean', b: 'oni' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'r' } },
      { id: 'stray', op: 'layer', params: { layer: 'unfetchable' } },   // reaches no sink
    ],
  };
  const oni: SeriesValue = { t: new Float64Array([0]), v: new Float64Array([1]), unit: 'degC', relative: true, label: 'ONI' };

  it('materializes exactly the reachable sources, with stable keys', async () => {
    const provider = makeProvider([scalarFrame('2024-01-01', () => 1)]);
    const store = new FieldStore({ sst: provider }, { loadOni: () => Promise.resolve(oni) });
    const { sources, sourceKeys } = await store.resolveSources(program);
    expect(Object.keys(sources).sort()).toEqual(['a', 'oni']);   // "stray" never loads
    expect(sources.a.kind).toBe('stack');
    expect(sources.oni.kind).toBe('series');
    expect(sourceKeys.a).toBe('sst||2024-01|2024-06|4mo');
    expect(provider.calls).toHaveLength(1);
  });

  it('loads the ONI series once across programs', async () => {
    let loads = 0;
    const store = new FieldStore({ sst: makeProvider([scalarFrame('2024-01-01', () => 1)]) }, {
      loadOni: () => { loads++; return Promise.resolve(oni); },
    });
    await store.resolveSources(program);
    await store.resolveSources(program);
    expect(loads).toBe(1);
  });

  it('fails with a structured issue naming the node for a bad layer key', async () => {
    const store = new FieldStore({ sst: makeProvider([]) }, { loadOni: () => Promise.resolve(oni) });
    const bad: AnalysisProgram = { nodes: [
      { id: 'x', op: 'layer', params: { layer: 'sst2' } },
      { id: 'show', op: 'display', inputs: { value: 'x' } },
    ] };
    try {
      await store.resolveSources(bad);
      throw new Error('expected AnalysisError');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalysisError);
      expect((e as AnalysisError).issues[0].node).toBe('x');
      expect((e as AnalysisError).issues[0].hint).toContain('sst');
    }
  });

  it('rejects enso nodes when no ONI loader is configured', async () => {
    const store = new FieldStore({ sst: makeProvider([scalarFrame('2024-01-01', () => 1)]) });
    await expect(store.resolveSources(program)).rejects.toThrow(/no ONI loader/);
  });
});

describe('FieldStore — forecast sources', () => {
  const forecastProgram: AnalysisProgram = { nodes: [
    { id: 'fc', op: 'forecast', params: { layer: 'anom', months: 2 } },
    { id: 'show', op: 'display', inputs: { value: 'fc' } },
  ] };

  function makeForecaster(): AnalysisForecaster & { calls: Array<{ layer: string; months: number; from?: string }> } {
    const frame = (date: string): { width: number; height: number; date: string; values: Float32Array; unit: 'degC'; relative: boolean } => ({
      width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT, date,
      values: new Float32Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT),
      unit: 'degC', relative: true,
    });
    const f: AnalysisForecaster & { calls: Array<{ layer: string; months: number; from?: string }> } = {
      version: 'test1',
      layers: ['anom'],
      calls: [],
      run(req) {
        f.calls.push({ ...req });
        return Promise.resolve({ frames: Array.from({ length: req.months }, (_, i) => frame(`2027-0${i + 1}-01`)) });
      },
    };
    return f;
  }

  it('materializes forecast nodes through the forecaster, with the model version in the key', async () => {
    const forecaster = makeForecaster();
    const store = new FieldStore({ anom: makeProvider([]) }, { forecaster });
    const { sources, sourceKeys } = await store.resolveSources(forecastProgram);
    expect(sources.fc.kind).toBe('stack');
    expect((sources.fc as { kind: 'stack'; stack: { frames: unknown[] } }).stack.frames).toHaveLength(2);
    expect(sourceKeys.fc).toBe('forecast|test1|anom|latest|2mo');
    expect(forecaster.calls).toEqual([{ layer: 'anom', months: 2, from: undefined }]);
  });

  it('caches forecasts per request — one model run for repeat programs', async () => {
    const forecaster = makeForecaster();
    const store = new FieldStore({ anom: makeProvider([]) }, { forecaster });
    await store.resolveSources(forecastProgram);
    await store.resolveSources(forecastProgram);
    expect(forecaster.calls).toHaveLength(1);
    await store.getForecast({ layer: 'anom', months: 2, from: '2026-06' });   // different request
    expect(forecaster.calls).toHaveLength(2);
  });

  it('rejects forecast nodes without a forecaster, and layers the model cannot predict', async () => {
    const bare = new FieldStore({ anom: makeProvider([]) });
    await expect(bare.resolveSources(forecastProgram)).rejects.toThrow(/no forecast model/);
    const store = new FieldStore({ anom: makeProvider([]) }, { forecaster: makeForecaster() });
    await expect(store.getForecast({ layer: 'sst', months: 3 })).rejects.toThrow(/no forecast model for layer/);
  });
});
