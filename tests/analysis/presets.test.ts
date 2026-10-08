import { describe, it, expect } from 'vitest';
import { BUILTIN_ANALYSES } from '../../src/analysis/presets.js';
import { validate } from '../../src/analysis/validate.js';
import { decodeProgram, encodeProgram } from '../../src/analysis/schema.js';
import { OPS } from '../../src/analysis/ast.js';

describe('BUILTIN_ANALYSES', () => {
  it('has unique names and non-empty descriptions', () => {
    const names = BUILTIN_ANALYSES.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const b of BUILTIN_ANALYSES) {
      expect(b.description.length).toBeGreaterThan(20);
    }
  });

  for (const b of BUILTIN_ANALYSES) {
    describe(b.name, () => {
      it('validates against the language with no errors or warnings', () => {
        const v = validate(b.program);
        expect(v.errors).toEqual([]);
        expect(v.warnings).toEqual([]);   // no dead nodes in shipped examples
      });

      it('has at least one sink and survives a ?prog round-trip', () => {
        expect(b.program.nodes.some((n) => OPS[n.op].sink)).toBe(true);
        expect(decodeProgram(encodeProgram(b.program))).toEqual(b.program);
      });
    });
  }
});
