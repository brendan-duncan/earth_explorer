/**
 * Gemini provider for the Ask tab (see {@link ./analysis_chat_provider.ts}).
 *
 * Two things differ from the Claude path:
 *
 * 1. **No tool runner.** The Gemini SDK streams a turn but does not drive the tool loop, so
 *    the send → collect `functionCall` parts → run → append `functionResponse` → repeat
 *    cycle is written out below, bounded by the same iteration budget. That loop is what
 *    lets the model repair a rejected program without the user asking again.
 * 2. **Schema dialect.** Function parameters go through `parametersJsonSchema`, which takes
 *    real JSON Schema (`anyOf`, `additionalProperties`, and `$ref` all survive) rather than
 *    the OpenAPI-subset `parameters` field. The one keyword it does not accept is `const`,
 *    which {@link toGeminiJsonSchema} rewrites — see there.
 *
 * Model parts are pushed back into history verbatim so `thoughtSignature` values survive the
 * round trip; Gemini needs them to keep reasoning coherent across a function call.
 *
 * The key is the user's own, pasted at runtime. Google's SDK warns against browser-side keys
 * for production — that warning is about *your* key, not one the user chose to paste into
 * their own browser, but the same proxy advice applies if this sample is ever hosted with a
 * key of ours.
 *
 * @category Analysis
 */

import { GoogleGenAI, type Content, type FunctionCall, type Part } from '@google/genai';
import { PROVIDERS, RUN_ANALYSIS_DESCRIPTION, RUN_ANALYSIS_NAME, type ChatHooks, type ChatProvider, type ChatProviderConfig } from './analysis_chat_provider.js';
import type { JsonSchema } from '../analysis/schema.js';
import type { AnalysisProgram } from '../analysis/ast.js';

/** Repair attempts per question before we stop looping. Matches the Claude runner's budget. */
const MAX_ITERATIONS = 8;

/**
 * Generous enough that thinking plus a whole program plus the narration fit. Gemini 2.5
 * counts thinking tokens against this, so the Claude-side 16k would truncate mid-program.
 */
const MAX_OUTPUT_TOKENS = 32768;

/**
 * Rewrites the bits of our JSON Schema that Gemini's validator rejects.
 *
 * Only one rewrite is needed: `const: X` becomes `enum: [X]`. Our schema uses `const` purely
 * as the per-op discriminator inside the `anyOf` node union (`schema.ts` → `nodeSchema`), and
 * a single-value `enum` says exactly the same thing in a keyword Gemini supports. Everything
 * else in the schema — `anyOf`, `additionalProperties`, `enum`, `items`, `required` — passes
 * through untouched.
 */
export function toGeminiJsonSchema(schema: JsonSchema): JsonSchema {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'const') {
        out.enum = [v];
      } else {
        out[key] = convert(v);
      }
    }
    return out;
  };
  return convert(schema) as JsonSchema;
}

/**
 * Appends a model part, merging consecutive plain-text parts. Streaming delivers text in
 * fragments; storing each fragment as its own part would bloat history and split sentences
 * across part boundaries. Parts carrying a thought signature are never merged — the signature
 * is bound to its exact part.
 */
function appendPart(parts: Part[], part: Part): void {
  const last = parts[parts.length - 1];
  const mergeable = (p: Part | undefined): boolean =>
    p !== undefined && p.text !== undefined && !p.thought && !p.thoughtSignature
    && !p.functionCall && !p.functionResponse && !p.inlineData;
  if (mergeable(last) && mergeable(part)) {
    last!.text = `${last!.text ?? ''}${part.text ?? ''}`;
    return;
  }
  parts.push(part);
}

export function createChatProvider(config: ChatProviderConfig): ChatProvider {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const history: Content[] = [];

  const generationConfig = {
    systemInstruction: config.systemPrompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Summaries, not raw reasoning — enough to drive the transcript's "… thinking" marker
    // and to carry the signatures the next turn needs.
    thinkingConfig: { includeThoughts: true },
    tools: [{
      functionDeclarations: [{
        name: RUN_ANALYSIS_NAME,
        description: RUN_ANALYSIS_DESCRIPTION,
        parametersJsonSchema: toGeminiJsonSchema(config.inputSchema),
      }],
    }],
  };

  return {
    async ask(question: string, hooks: ChatHooks): Promise<void> {
      history.push({ role: 'user', parts: [{ text: question }] });

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const stream = await ai.models.generateContentStream({
          model: PROVIDERS.gemini.model,
          contents: history,
          config: generationConfig,
        });

        const modelParts: Part[] = [];
        const calls: FunctionCall[] = [];
        const turn = hooks.beginTurn();
        try {
          for await (const chunk of stream) {
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
              appendPart(modelParts, part);
              if (part.thought) {
                hooks.noteThinking();
              } else if (part.text) {
                turn.text(part.text);
              }
              if (part.functionCall) {
                calls.push(part.functionCall);
              }
            }
          }
        } finally {
          turn.end();
        }

        if (modelParts.length === 0) {
          // No candidate at all — a safety block or an empty completion. Nothing to loop on.
          return;
        }
        history.push({ role: 'model', parts: modelParts });
        if (calls.length === 0) {
          return;
        }

        const results: Part[] = [];
        for (const call of calls) {
          const output = await hooks.runTool(call.args);
          results.push({
            functionResponse: {
              ...(call.id === undefined ? {} : { id: call.id }),
              name: call.name ?? RUN_ANALYSIS_NAME,
              response: { output },
            },
          });
        }
        history.push({ role: 'user', parts: results });
      }
    },

    noteExternalRun(program: AnalysisProgram): void {
      history.push({
        role: 'user',
        parts: [{
          text: `(Note: I just ran this analysis program myself in the graph editor — its results are on screen: ${JSON.stringify(program)})`,
        }],
      });
    },

    rollbackLastAsk(): void {
      history.pop();
    },
  };
}
