import { describe, it, expect } from 'vitest';
import { validate } from '../../src/analysis/validate.js';
import type { AnalysisProgram } from '../../src/analysis/ast.js';

/** The canonical correlation program from the design doc. */
function correlationProgram(): AnalysisProgram {
  return {
    nodes: [
      { id: 'sst', op: 'layer', params: { layer: 'sst' } },
      { id: 'wind', op: 'layer', params: { layer: 'wind', component: 'speed' } },
      { id: 'r', op: 'correlate', inputs: { a: 'sst', b: 'wind' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'mean r' } },
    ],
  };
}

describe('validate — structure', () => {
  it('accepts the canonical correlation program and orders it topologically', () => {
    const v = validate(correlationProgram());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.order.indexOf('sst')).toBeLessThan(v.order.indexOf('r'));
    expect(v.order.indexOf('wind')).toBeLessThan(v.order.indexOf('r'));
    expect(v.order.indexOf('r')).toBeLessThan(v.order.indexOf('show'));
    expect(v.types.get('sst')).toBe('stack');
    expect(v.types.get('r')).toBe('field');
    expect(v.types.get('show')).toBeNull();
  });

  it('rejects duplicate node ids', () => {
    const v = validate({ nodes: [
      { id: 'a', op: 'enso' },
      { id: 'a', op: 'enso' },
      { id: 'ans', op: 'answer', inputs: { value: 'a' }, params: { label: 'x' } },
    ] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects unknown ops with a hint listing the catalog', () => {
    const v = validate({ nodes: [{ id: 'x', op: 'convolve' as never }] });
    expect(v.ok).toBe(false);
    const err = v.errors.find((e) => e.message.includes('unknown op'));
    expect(err?.hint).toContain('correlate');
  });

  it('rejects a missing required param', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 't', op: 'timeReduce', inputs: { value: 's' } },   // no stat
      { id: 'show', op: 'display', inputs: { value: 't' } },
    ] });
    expect(v.errors.some((e) => e.node === 't' && e.param === 'stat')).toBe(true);
  });

  it('rejects a bad enum value and an unknown param', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 't', op: 'timeReduce', inputs: { value: 's' }, params: { stat: 'median', smooth: true } },
      { id: 'show', op: 'display', inputs: { value: 't' } },
    ] });
    expect(v.errors.some((e) => e.param === 'stat' && e.message.includes('one of'))).toBe(true);
    expect(v.errors.some((e) => e.param === 'smooth' && e.message.includes('unknown param'))).toBe(true);
  });

  it('rejects missing required inputs and dangling references', () => {
    const v = validate({ nodes: [
      { id: 'r', op: 'correlate', inputs: { a: 'ghost' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' } },
    ] });
    expect(v.errors.some((e) => e.node === 'r' && e.port === 'a' && e.message.includes('missing node'))).toBe(true);
    expect(v.errors.some((e) => e.node === 'r' && e.port === 'b' && e.message.includes('missing required input'))).toBe(true);
  });

  it('rejects cycles', () => {
    const v = validate({ nodes: [
      { id: 'a', op: 'anomaly', inputs: { value: 'b' } },
      { id: 'b', op: 'anomaly', inputs: { value: 'a' } },
      { id: 'show', op: 'display', inputs: { value: 'a' } },
    ] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('requires at least one sink', () => {
    const v = validate({ nodes: [{ id: 's', op: 'layer', params: { layer: 'sst' } }] });
    expect(v.errors.some((e) => e.message.includes('no sink'))).toBe(true);
  });

  it('rejects using a sink as an input', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'show', op: 'display', inputs: { value: 's' } },
      { id: 'ans', op: 'answer', inputs: { value: 'show' }, params: { label: 'x' } },
    ] });
    expect(v.errors.some((e) => e.node === 'ans' && e.message.includes('sinks have no output'))).toBe(true);
  });

  it('warns about nodes that reach no sink and prunes them from the order', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'stray', op: 'region', params: { preset: 'nino34' } },
      { id: 'show', op: 'display', inputs: { value: 's' } },
    ] });
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.node === 'stray')).toBe(true);
    expect(v.order).not.toContain('stray');
  });
});

describe('validate — types', () => {
  it('rejects a port type mismatch with a hint naming the producer', () => {
    const v = validate({ nodes: [
      { id: 'oni', op: 'enso' },
      { id: 't', op: 'timeReduce', inputs: { value: 'oni' }, params: { stat: 'mean' } },
      { id: 'show', op: 'display', inputs: { value: 't' } },
    ] });
    const err = v.errors.find((e) => e.node === 't' && e.port === 'value');
    expect(err?.message).toContain('expects stack');
    expect(err?.hint).toContain('series');
  });

  it('resolves areaMean polymorphically: stack → series, field → scalar', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'f', op: 'timeReduce', inputs: { value: 's' }, params: { stat: 'mean' } },
      { id: 'perFrame', op: 'areaMean', inputs: { value: 's' } },
      { id: 'oneNumber', op: 'areaMean', inputs: { value: 'f' } },
      { id: 'c', op: 'chart', inputs: { a: 'perFrame' } },
      { id: 'ans', op: 'answer', inputs: { value: 'oneNumber' }, params: { label: 'x' } },
    ] });
    expect(v.ok).toBe(true);
    expect(v.types.get('perFrame')).toBe('series');
    expect(v.types.get('oneNumber')).toBe('scalar');
  });

  it('rejects correlate(temporal) over anything but two stacks', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'f', op: 'timeReduce', inputs: { value: 's' }, params: { stat: 'mean' } },
      { id: 'r', op: 'correlate', inputs: { a: 's', b: 'f' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' } },
    ] });
    expect(v.errors.some((e) => e.node === 'r' && e.message.includes('needs two stacks'))).toBe(true);
  });

  it('rejects math over mismatched non-scalar types', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'oni', op: 'enso' },
      { id: 'm', op: 'math', inputs: { a: 's', b: 'oni' }, params: { fn: 'sub' } },
      { id: 'show', op: 'display', inputs: { value: 'm' } },
    ] });
    expect(v.errors.some((e) => e.node === 'm' && e.message.includes('matching operand types'))).toBe(true);
  });
});

describe('validate — op-specific checks', () => {
  it('selectFrames: phase without an oni input is an error', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'sel', op: 'selectFrames', inputs: { value: 's' }, params: { phase: 'elnino' } },
      { id: 'show', op: 'display', inputs: { value: 'sel' } },
    ] });
    expect(v.errors.some((e) => e.node === 'sel' && e.message.includes('oni'))).toBe(true);
  });

  it('selectFrames: with no filter params it is a rejected no-op', () => {
    const v = validate({ nodes: [
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'sel', op: 'selectFrames', inputs: { value: 's' } },
      { id: 'show', op: 'display', inputs: { value: 'sel' } },
    ] });
    expect(v.errors.some((e) => e.node === 'sel' && e.message.includes('no-op'))).toBe(true);
  });

  it('region: preset and bbox are mutually exclusive, and one is required', () => {
    const both = validate({ nodes: [
      { id: 'r', op: 'region', params: { preset: 'nino34', lonMin: 0, latMin: 0, lonMax: 10, latMax: 10 } },
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'm', op: 'mask', inputs: { value: 's', region: 'r' } },
      { id: 'show', op: 'display', inputs: { value: 'm' } },
    ] });
    expect(both.errors.some((e) => e.node === 'r' && e.message.includes('not both'))).toBe(true);

    const neither = validate({ nodes: [
      { id: 'r', op: 'region' },
      { id: 's', op: 'layer', params: { layer: 'sst' } },
      { id: 'm', op: 'mask', inputs: { value: 's', region: 'r' } },
      { id: 'show', op: 'display', inputs: { value: 'm' } },
    ] });
    expect(neither.errors.some((e) => e.node === 'r' && e.message.includes('all four'))).toBe(true);
  });
});
