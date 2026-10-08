/**
 * Main-thread client for analysis-graph execution: prefers the Worker (so heavy programs
 * don't hitch the frame loop), falls back to inline {@link interpret} where module workers
 * are unavailable. Both paths share the same semantics; only the thread differs.
 *
 * @category Analysis
 */

import { AnalysisError, interpret, InterpreterCache, type InterpretResult } from './interpret.js';
import type { AnalysisProgram } from './ast.js';
import type { AnalysisWorkRequest, AnalysisWorkResponse } from './worker.js';
import type { Value } from './types.js';

/** @category Analysis */
export interface AnalysisRunOptions {
  sources: Record<string, Value>;
  sourceKeys?: Record<string, string>;
  budgetCellOps?: number;
  onProgress?: (nodeId: string, done: number, total: number) => void;
}

/** @category Analysis */
export class AnalysisRunner {
  private worker: Worker | null = null;
  private readonly inlineCache = new InterpreterCache();
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (r: InterpretResult) => void;
    reject: (e: Error) => void;
    onProgress?: (nodeId: string, done: number, total: number) => void;
  }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<AnalysisWorkResponse>) => this.handle(e.data);
      this.worker.onerror = () => {
        // Worker died (load failure, unhandled error): fail what's in flight and go inline.
        for (const p of this.pending.values()) {
          p.reject(new Error('analysis worker failed'));
        }
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  private handle(msg: AnalysisWorkResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) {
      return;
    }
    if (msg.type === 'progress') {
      p.onProgress?.(msg.node, msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'result') {
      p.resolve(msg.result);
    } else {
      p.reject(msg.issues.length > 0 ? new AnalysisError(msg.issues) : new Error(msg.message));
    }
  }

  /** Runs a program over already-materialized sources. Throws {@link AnalysisError}. */
  run(program: AnalysisProgram, opts: AnalysisRunOptions): Promise<InterpretResult> {
    if (!this.worker) {
      try {
        return Promise.resolve(interpret(program, { ...opts, cache: this.inlineCache }));
      } catch (e) {
        return Promise.reject(e as Error);
      }
    }
    const id = this.nextId++;
    const request: AnalysisWorkRequest = {
      id,
      program,
      sources: opts.sources,
      sourceKeys: opts.sourceKeys,
      budgetCellOps: opts.budgetCellOps,
    };
    return new Promise<InterpretResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress });
      this.worker!.postMessage(request);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
