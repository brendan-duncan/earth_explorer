/**
 * The Ask tab hands Gemini the same `run_analysis` JSON Schema it hands Claude, via
 * `parametersJsonSchema`. Gemini's validator accepts nearly all of it — `anyOf`,
 * `additionalProperties`, `enum`, `items`, `required` — but rejects `const`, which
 * `toGeminiJsonSchema` rewrites to a single-value `enum`.
 *
 * Worth a test because the failure is invisible locally: a surviving `const` only shows up
 * as a 400 from a live Gemini key, which CI does not have.
 */

import { describe, it, expect } from 'vitest';
import { toGeminiJsonSchema } from '../../src/ui/analysis_chat_gemini.js';
import { runAnalysisInputSchema } from '../../src/analysis/schema.js';
import { OP_NAMES } from '../../src/analysis/ast.js';

const LAYER_KEYS = ['sst', 'wind'];

/** Collects every value of `key` anywhere in the schema tree. */
function collect(node: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const v of node) {
      collect(v, key, found);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) {
        found.push(v);
      }
      collect(v, key, found);
    }
  }
  return found;
}

describe('toGeminiJsonSchema', () => {
  it('leaves no `const` anywhere in the generated tool schema', () => {
    const source = runAnalysisInputSchema(LAYER_KEYS);
    expect(collect(source, 'const').length, 'fixture assumption: source uses const').toBeGreaterThan(0);
    expect(collect(toGeminiJsonSchema(source), 'const')).toEqual([]);
  });

  it('rewrites each op discriminator to a single-value enum', () => {
    const converted = toGeminiJsonSchema(runAnalysisInputSchema(LAYER_KEYS));
    const variants = (converted.properties as Record<string, Record<string, unknown>>)
      .nodes.items as { anyOf: Array<{ properties: Record<string, { enum?: unknown[] }> }> };
    const ops = variants.anyOf.map((v) => v.properties.op.enum);
    expect(ops).toEqual(OP_NAMES.map((op) => [op]));
  });

  it('preserves the keywords Gemini does support', () => {
    const converted = toGeminiJsonSchema(runAnalysisInputSchema(LAYER_KEYS));
    // Closed objects, the node union, and the layer-key enum all have to survive intact —
    // they are what keep the model from inventing ops, fields, or layers.
    expect(converted.additionalProperties).toBe(false);
    expect(converted.required).toEqual(['nodes']);
    expect(collect(converted, 'anyOf').length).toBe(1);
    expect(collect(converted, 'enum')).toContainEqual(LAYER_KEYS);
  });

  it('does not mutate its input', () => {
    const source = runAnalysisInputSchema(LAYER_KEYS);
    const before = JSON.stringify(source);
    toGeminiJsonSchema(source);
    expect(JSON.stringify(source)).toBe(before);
  });
});
