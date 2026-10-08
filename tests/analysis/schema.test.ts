import { describe, it, expect } from 'vitest';
import { decodeProgram, encodeProgram, renderSystemPrompt, runAnalysisInputSchema, sanitizeProgram } from '../../src/analysis/schema.js';
import { OP_NAMES } from '../../src/analysis/ast.js';
import { validate } from '../../src/analysis/validate.js';
import type { CatalogEntry } from '../../src/analysis/field_store.js';

const CATALOG: CatalogEntry[] = [
  { key: 'sst', unit: 'degC', vector: false, relative: false, description: 'Sea-surface temp', coverage: { start: '2016-01', end: '2026-07' } },
  { key: 'wind', unit: 'mps', vector: true, relative: false, description: 'GFS 10 m wind', coverage: { start: '2022-12', end: '2026-07' }, caveats: 'archive floor 2022-12' },
];

/** Recursively asserts the schema's shape invariants: every object is CLOSED
 *  (additionalProperties: false) and `required` only names declared properties.
 *  (The tool is not strict — strict grammars can't fit a 16-op language — but a tight,
 *  closed schema is still what steers the model.) */
function assertClosed(schema: Record<string, unknown>, path: string): void {
  if (schema.type === 'object') {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of (schema.required as string[] | undefined) ?? []) {
      expect(Object.keys(props), `${path}.required has undeclared "${name}"`).toContain(name);
    }
    for (const [k, v] of Object.entries(props)) {
      assertClosed(v, `${path}.${k}`);
    }
  }
  for (const key of ['items', 'anyOf'] as const) {
    const sub = schema[key];
    if (Array.isArray(sub)) {
      sub.forEach((s, i) => assertClosed(s as Record<string, unknown>, `${path}.${key}[${i}]`));
    } else if (sub && typeof sub === 'object') {
      assertClosed(sub as Record<string, unknown>, `${path}.${key}`);
    }
  }
}

describe('runAnalysisInputSchema', () => {
  const schema = runAnalysisInputSchema(CATALOG.map((c) => c.key));

  it('closes every object and only requires declared properties', () => {
    assertClosed(schema, '$');
  });

  it('requires exactly the required ports/params (optional ones are omitted, not padded)', () => {
    const anyOf = ((schema.properties as Record<string, Record<string, unknown>>).nodes.items as Record<string, unknown>).anyOf as Array<Record<string, unknown>>;
    const byOp = (op: string): Record<string, unknown> => anyOf.find((s) => ((s.properties as Record<string, Record<string, unknown>>).op).const === op)!;
    const layer = byOp('layer');
    expect(((layer.properties as Record<string, Record<string, unknown>>).params.required)).toEqual(['layer']);
    const display = byOp('display');
    expect(((display.properties as Record<string, Record<string, unknown>>).params.required)).toBeUndefined();
    expect((display.required as string[])).toEqual(['id', 'op', 'inputs']);   // params all-optional → not required
  });

  it('has one node shape per op, with op as a const', () => {
    const anyOf = ((schema.properties as Record<string, Record<string, unknown>>).nodes.items as Record<string, unknown>).anyOf as Array<Record<string, unknown>>;
    expect(anyOf).toHaveLength(OP_NAMES.length);
    const consts = anyOf.map((s) => ((s.properties as Record<string, Record<string, unknown>>).op).const);
    expect(consts.sort()).toEqual([...OP_NAMES].sort());
  });

  it('enumerates catalog keys on the layer param and colormaps on display', () => {
    const anyOf = ((schema.properties as Record<string, Record<string, unknown>>).nodes.items as Record<string, unknown>).anyOf as Array<Record<string, unknown>>;
    const layer = anyOf.find((s) => ((s.properties as Record<string, Record<string, unknown>>).op).const === 'layer')!;
    const layerParams = ((layer.properties as Record<string, Record<string, unknown>>).params.properties) as Record<string, Record<string, unknown>>;
    expect(layerParams.layer.enum).toEqual(['sst', 'wind']);

    const display = anyOf.find((s) => ((s.properties as Record<string, Record<string, unknown>>).op).const === 'display')!;
    const colormap = ((display.properties as Record<string, Record<string, unknown>>).params.properties as Record<string, Record<string, unknown>>).colormap;
    expect(colormap.enum).toContain('balance');
  });

  it('declares no union-typed parameters (optional = omitted, never anyOf [T, null])', () => {
    // Union-typed params were the first thing to blow the strict-grammar limits; the
    // schema now avoids them entirely so it stays cheap even as guidance.
    let unions = 0;
    const walk = (s: unknown): void => {
      if (Array.isArray(s)) {
        s.forEach(walk);
        return;
      }
      if (s && typeof s === 'object') {
        const o = s as Record<string, unknown>;
        if (o.anyOf && !(o as { anyOf: unknown[] }).anyOf.every((b) => (b as Record<string, unknown>).properties)) {
          unions++;   // the per-op node union at nodes.items is fine; value unions are not
        }
        if (Array.isArray(o.type)) {
          unions++;
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(schema);
    expect(unions).toBe(0);
  });

  it('sanitizeProgram strips null AND empty-string placeholders into a program that validates', () => {
    const program = sanitizeProgram({ nodes: [
      { id: 'a', op: 'layer', params: { layer: 'sst', start: '2020-01', end: '', stepMonths: null, component: '' } },
      { id: 'b', op: 'layer', params: { layer: 'wind', start: '', end: '', stepMonths: 4, component: 'speed' } },
      { id: 'r', op: 'correlate', inputs: { a: 'a', b: 'b' }, params: { mode: 'temporal' } },
      { id: 'show', op: 'display', inputs: { value: 'r' }, params: { title: '', colormap: '', min: null, max: null } },
      { id: 'ans', op: 'answer', inputs: { value: 'r' }, params: { label: 'r' } },
    ] });
    expect(program.nodes[0].params).toEqual({ layer: 'sst', start: '2020-01' });
    expect(program.nodes[3].params).toBeUndefined();
    const v = validate(program);
    expect(v.ok).toBe(true);
  });

  it('sanitizeProgram tolerates junk without throwing', () => {
    expect(sanitizeProgram(null).nodes).toEqual([]);
    expect(sanitizeProgram({ nodes: 'nope' }).nodes).toEqual([]);
    expect(sanitizeProgram({ nodes: [null, 42, { op: 'enso' }] }).nodes).toHaveLength(1);
  });
});

describe('encodeProgram / decodeProgram', () => {
  it('round-trips a program through a URL-safe string, unicode included', () => {
    const program = sanitizeProgram({ nodes: [
      { id: 'a', op: 'layer', params: { layer: 'sst', start: '2020-01' } },
      { id: 'ans', op: 'answer', inputs: { value: 'a' }, params: { label: 'Niño 3.4 — °C' } },
    ] });
    const encoded = encodeProgram(program);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);   // URL-safe, no padding
    expect(decodeProgram(encoded)).toEqual(program);
  });

  it('throws on garbage rather than returning a broken program', () => {
    expect(() => decodeProgram('!!!not-base64!!!')).toThrow();
  });
});

describe('renderSystemPrompt', () => {
  const prompt = renderSystemPrompt(CATALOG);

  it('lists every catalog layer with coverage and caveats', () => {
    expect(prompt).toContain('sst');
    expect(prompt).toContain('2022-12');
    expect(prompt).toContain('archive floor');
    expect(prompt).toContain('vector — set component');
  });

  it('includes the op cheat sheet and worked examples that themselves validate', () => {
    expect(prompt).toContain('correlate(');
    expect(prompt).toContain('selectFrames(');
    // Every embedded example program must sanitize + validate against the real language.
    const jsons = prompt.match(/\{"nodes":\[.*?\]\}/g) ?? [];
    expect(jsons.length).toBeGreaterThanOrEqual(3);
    for (const j of jsons) {
      const v = validate(sanitizeProgram(JSON.parse(j)));
      expect(v.errors).toEqual([]);
    }
  });
});
