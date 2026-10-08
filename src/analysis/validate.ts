/**
 * Structural + type validation for analysis programs (TODO/geo-analysis-graph.md §4).
 *
 * Everything checkable without data is checked here: ids, op names, params, port wiring,
 * cycles, port types (via each op's `resolve`), and the at-least-one-sink rule. Errors are
 * STRUCTURED — node/port/param plus a hint — because they are returned verbatim to the LLM
 * front end as tool results (one-shot self-correction) and rendered by the node editor as
 * red port highlights. Cost gating needs materialized data and lives in `interpret.ts`.
 *
 * @category Analysis
 */

import { OPS, type AnalysisNode, type AnalysisProgram } from './ast.js';
import type { ValueType } from './types.js';

/** One problem found in a program. @category Analysis */
export interface ValidationIssue {
  node?: string;
  port?: string;
  param?: string;
  message: string;
  hint?: string;
}

/** @category Analysis */
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Execution order: topological, pruned to nodes that reach a sink. Empty when `!ok`. */
  order: string[];
  /** Resolved output type per node (`null` = sink). Populated for every resolvable node. */
  types: Map<string, ValueType | null>;
}

/** Validates a program. Never throws — all problems land in `errors` / `warnings`. */
export function validate(program: AnalysisProgram): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const types = new Map<string, ValueType | null>();

  // ── Ids + op names ────────────────────────────────────────────────────────────────
  const byId = new Map<string, AnalysisNode>();
  for (const node of program.nodes) {
    if (!node.id) {
      errors.push({ message: 'node with empty id', hint: 'every node needs a unique id' });
      continue;
    }
    if (byId.has(node.id)) {
      errors.push({ node: node.id, message: `duplicate node id "${node.id}"` });
      continue;
    }
    byId.set(node.id, node);
    if (!(node.op in OPS)) {
      errors.push({ node: node.id, message: `unknown op "${node.op}"`, hint: `one of: ${Object.keys(OPS).join(', ')}` });
    }
  }
  if (program.nodes.length === 0) {
    errors.push({ message: 'empty program' });
  }

  // ── Params + input wiring (per node, structure only) ─────────────────────────────
  for (const node of byId.values()) {
    const spec = OPS[node.op];
    if (!spec) {
      continue;
    }
    const params = node.params ?? {};
    for (const [name, value] of Object.entries(params)) {
      const p = spec.params[name];
      if (!p) {
        errors.push({ node: node.id, param: name, message: `unknown param "${name}" on ${node.op}`, hint: `known: ${Object.keys(spec.params).join(', ') || '(none)'}` });
        continue;
      }
      if (typeof value !== p.type) {
        errors.push({ node: node.id, param: name, message: `param "${name}" must be a ${p.type}, got ${typeof value}` });
        continue;
      }
      if (p.enum && !p.enum.includes(value as string)) {
        errors.push({ node: node.id, param: name, message: `param "${name}" must be one of ${p.enum.join(', ')}`, hint: `got "${String(value)}"` });
      }
    }
    for (const [name, p] of Object.entries(spec.params)) {
      if (p.required && params[name] === undefined) {
        errors.push({ node: node.id, param: name, message: `missing required param "${name}" on ${node.op}` });
      }
    }

    const inputs = node.inputs ?? {};
    for (const [port, ref] of Object.entries(inputs)) {
      const portSpec = spec.inputs[port];
      if (!portSpec) {
        errors.push({ node: node.id, port, message: `unknown input port "${port}" on ${node.op}`, hint: `known: ${Object.keys(spec.inputs).join(', ') || '(none — this op takes no inputs)'}` });
        continue;
      }
      const producer = byId.get(ref);
      if (!producer) {
        errors.push({ node: node.id, port, message: `input "${port}" references missing node "${ref}"` });
        continue;
      }
      const producerSpec = OPS[producer.op];
      if (producerSpec?.sink) {
        errors.push({ node: node.id, port, message: `input "${port}" references sink "${ref}" — sinks have no output` });
      }
    }
    for (const [port, portSpec] of Object.entries(spec.inputs)) {
      if (portSpec.required && inputs[port] === undefined) {
        errors.push({ node: node.id, port, message: `missing required input "${port}" on ${node.op}`, hint: portSpec.description });
      }
    }

    const err = spec.check?.(params, inputs);
    if (err) {
      errors.push({ node: node.id, message: `${node.op}: ${err}` });
    }
  }

  // ── At least one sink ─────────────────────────────────────────────────────────────
  const sinkIds = [...byId.values()].filter((n) => OPS[n.op]?.sink).map((n) => n.id);
  if (sinkIds.length === 0 && program.nodes.length > 0) {
    errors.push({ message: 'program has no sink', hint: 'add a display, chart, or answer node — otherwise nothing is produced' });
  }

  // ── Topological order (Kahn) + cycle detection ────────────────────────────────────
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of byId.values()) {
    indegree.set(node.id, 0);
  }
  for (const node of byId.values()) {
    for (const ref of Object.values(node.inputs ?? {})) {
      if (!byId.has(ref)) {
        continue;   // already reported
      }
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      const list = dependents.get(ref) ?? [];
      list.push(node.id);
      dependents.set(ref, list);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const topo: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const d = (indegree.get(dep) ?? 1) - 1;
      indegree.set(dep, d);
      if (d === 0) {
        queue.push(dep);
      }
    }
  }
  if (topo.length < byId.size) {
    const stuck = [...byId.keys()].filter((id) => !topo.includes(id));
    errors.push({ message: `cycle involving: ${stuck.join(', ')}`, hint: 'programs are DAGs — a node cannot (transitively) feed itself' });
  }

  // ── Type resolution in topo order ─────────────────────────────────────────────────
  for (const id of topo) {
    const node = byId.get(id)!;
    const spec = OPS[node.op];
    if (!spec) {
      continue;
    }
    const inputTypes: Record<string, ValueType> = {};
    let incomplete = false;
    for (const [port, ref] of Object.entries(node.inputs ?? {})) {
      const portSpec = spec.inputs[port];
      const t = types.get(ref);
      if (!portSpec || t === undefined || t === null) {
        incomplete = true;   // wiring error already reported
        continue;
      }
      if (!portSpec.types.includes(t)) {
        errors.push({
          node: id, port,
          message: `input "${port}" of ${node.op} expects ${portSpec.types.join(' | ')}, got ${t}`,
          hint: `"${ref}" produces a ${t}`,
        });
        incomplete = true;
        continue;
      }
      inputTypes[port] = t;
    }
    // Required ports missing were already reported; a node with incomplete inputs cannot resolve.
    const requiredMissing = Object.entries(spec.inputs).some(([port, p]) => p.required && (node.inputs ?? {})[port] === undefined);
    if (incomplete || requiredMissing) {
      continue;
    }
    const resolved = spec.resolve(inputTypes, node.params ?? {});
    if (resolved !== null && typeof resolved === 'object') {
      errors.push({ node: id, message: `${node.op}: ${resolved.error}` });
      continue;
    }
    types.set(id, resolved);
  }

  // ── Reachability: prune nodes that feed no sink ───────────────────────────────────
  const reachable = new Set<string>(sinkIds);
  const walk = [...sinkIds];
  while (walk.length > 0) {
    const node = byId.get(walk.pop()!);
    for (const ref of Object.values(node?.inputs ?? {})) {
      if (byId.has(ref) && !reachable.has(ref)) {
        reachable.add(ref);
        walk.push(ref);
      }
    }
  }
  for (const id of byId.keys()) {
    if (!reachable.has(id)) {
      warnings.push({ node: id, message: `"${id}" does not reach any sink — it will not run` });
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    order: ok ? topo.filter((id) => reachable.has(id)) : [],
    types,
  };
}
