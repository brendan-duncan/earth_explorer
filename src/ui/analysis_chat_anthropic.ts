/**
 * Claude provider for the Ask tab (see {@link ./analysis_chat_provider.ts}).
 *
 * The SDK's beta tool runner drives the loop: it calls the API, executes `run_analysis`,
 * feeds the summary back, and repeats until Claude stops calling tools — so a validation
 * failure gets repaired inside the same turn. The runner also accumulates the authoritative
 * transcript (tool_use/tool_result blocks included), which is what we keep as history.
 *
 * The tool is deliberately NOT `strict`: strict-mode grammars are compiled server-side and a
 * 16-op language exceeds their limits (hit live). The schema still shapes the output, and
 * `validate` catches the rest. See `src/geo/analysis/schema.ts`.
 *
 * Browser-direct calls need `dangerouslyAllowBrowser` — the key is the user's own, pasted at
 * runtime. If this sample is ever hosted with a key of ours, swap in a proxy via `baseURL`.
 *
 * @category Analysis
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { PROVIDERS, RUN_ANALYSIS_DESCRIPTION, RUN_ANALYSIS_NAME, type ChatHooks, type ChatProvider, type ChatProviderConfig } from './analysis_chat_provider.js';
import type { AnalysisProgram } from '../analysis/ast.js';

/** Repair attempts per question before the runner gives up. */
const MAX_ITERATIONS = 8;

export function createChatProvider(config: ChatProviderConfig): ChatProvider {
  const client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true });
  let history: Anthropic.Beta.BetaMessageParam[] = [];

  return {
    async ask(question: string, hooks: ChatHooks): Promise<void> {
      history.push({ role: 'user', content: question });

      const runAnalysis = betaTool({
        name: RUN_ANALYSIS_NAME,
        description: RUN_ANALYSIS_DESCRIPTION,
        inputSchema: config.inputSchema as { type: 'object' },
        run: (input) => hooks.runTool(input),
      });

      const runner = client.beta.messages.toolRunner({
        model: PROVIDERS.anthropic.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: config.systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools: [runAnalysis],
        messages: [...history],
        max_iterations: MAX_ITERATIONS,
        stream: true,
      });

      for await (const stream of runner) {
        const turn = hooks.beginTurn();
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
            hooks.noteThinking();
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            turn.text(event.delta.text);
          }
        }
        turn.end();
      }
      history = [...runner.params.messages];
    },

    noteExternalRun(program: AnalysisProgram): void {
      history.push({
        role: 'user',
        content: `(Note: I just ran this analysis program myself in the graph editor — its results are on screen: ${JSON.stringify(program)})`,
      });
    },

    rollbackLastAsk(): void {
      history.pop();
    },
  };
}
