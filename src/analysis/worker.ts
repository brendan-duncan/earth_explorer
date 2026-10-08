/**
 * Analysis-graph execution Worker (TODO/geo-analysis-graph.md §4).
 *
 * Runs {@link interpret} off the main thread so LLM-authored programs near the cost budget
 * can't hitch the map. The caller ({@link "./run.ts".AnalysisRunner}) materializes sources on
 * the main thread (they need fetch + the GriddedField decode path) and posts them here —
 * every value in the protocol is plain structured-cloneable data. A persistent
 * {@link InterpreterCache} lives in the worker, so repeat runs with stable `sourceKeys`
 * replay unchanged subgraphs.
 */

import { AnalysisError, interpret, InterpreterCache, type InterpretResult } from './interpret.js';
import type { AnalysisProgram } from './ast.js';
import type { ValidationIssue } from './validate.js';
import type { Value } from './types.js';

/** Main thread → worker. */
export interface AnalysisWorkRequest {
  id: number;
  program: AnalysisProgram;
  sources: Record<string, Value>;
  sourceKeys?: Record<string, string>;
  budgetCellOps?: number;
}

/** Worker → main thread. */
export type AnalysisWorkResponse =
  | { type: 'progress'; id: number; node: string; done: number; total: number }
  | { type: 'result'; id: number; result: InterpretResult }
  | { type: 'error'; id: number; issues: ValidationIssue[]; message: string };

const cache = new InterpreterCache();

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AnalysisWorkRequest>) => void) | null;
  postMessage(message: AnalysisWorkResponse): void;
};

ctx.onmessage = (e: MessageEvent<AnalysisWorkRequest>): void => {
  const msg = e.data;
  try {
    const result = interpret(msg.program, {
      sources: msg.sources,
      sourceKeys: msg.sourceKeys,
      budgetCellOps: msg.budgetCellOps,
      cache,
      onProgress: (node, done, total) => ctx.postMessage({ type: 'progress', id: msg.id, node, done, total }),
    });
    ctx.postMessage({ type: 'result', id: msg.id, result });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id,
      issues: err instanceof AnalysisError ? err.issues : [],
      message: (err as Error)?.message ?? String(err),
    });
  }
};
