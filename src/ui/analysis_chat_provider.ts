/**
 * Provider seam for the analysis panel's "Ask" tab — the part that differs between LLM
 * vendors, kept apart from the chat UI so adding a vendor never touches the transcript,
 * the key row, or the tool that runs the programs.
 *
 * The {@link PROVIDERS} table is deliberately data-only: the Ask tab renders its picker and
 * key row from it *before* any vendor SDK is fetched, and only pulls in the chosen
 * provider's module (and its SDK) once the user actually asks something. Picking Gemini
 * therefore never downloads the Anthropic SDK, and vice versa.
 *
 * A provider owns its own conversation history — Anthropic `messages[]` and Gemini
 * `contents[]` carry tool calls in incompatible shapes, and translating mid-conversation
 * tool state between them buys the user nothing. Switching providers starts a fresh
 * conversation instead.
 *
 * @category Analysis
 */

import type { JsonSchema } from '../analysis/schema.js';
import type { AnalysisProgram } from '../analysis/ast.js';

/** Vendors the Ask tab can talk to. */
export type ProviderId = 'anthropic' | 'gemini';

/** Everything the Ask tab needs to offer a provider without loading its SDK. */
export interface ProviderMeta {
  id: ProviderId;
  /** Shown in the picker. */
  label: string;
  /** Model the provider module talks to — surfaced in the key hint so the cost is no surprise. */
  model: string;
  /** localStorage key holding this vendor's API key. Keys are per-vendor, never shared. */
  keyStorage: string;
  keyPlaceholder: string;
  /** Where a user gets a key, shown under the key row. */
  consoleLabel: string;
  consoleUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    model: 'claude-opus-4-8',
    // Pre-dates the picker; kept verbatim so existing users don't have to re-paste a key.
    keyStorage: 'earth_explorer_anthropic_api_key',
    keyPlaceholder: 'Anthropic API key (stored locally)',
    consoleLabel: 'console.anthropic.com',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    // Pro rather than Flash: writing a correct DAG first try is a reasoning task, and a
    // weaker model spends the repair loop's iterations instead of the free tier's requests.
    // Swap to 'gemini-2.5-flash' for a much larger daily quota at some accuracy cost.
    model: 'gemini-2.5-pro',
    keyStorage: 'earth_explorer_gemini_api_key',
    keyPlaceholder: 'Google AI Studio API key (stored locally)',
    consoleLabel: 'aistudio.google.com',
    consoleUrl: 'https://aistudio.google.com/apikey',
  },
};

/** The default provider, and the one a stored selection falls back to. */
export const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/** Narrows an untrusted (localStorage) value to a known provider. */
export function toProviderId(value: string | null): ProviderId {
  return value === 'anthropic' || value === 'gemini' ? value : DEFAULT_PROVIDER;
}

/**
 * The `run_analysis` tool description. Shared so both vendors see the same contract — the
 * op semantics themselves live in the system prompt (`renderSystemPrompt`).
 */
export const RUN_ANALYSIS_DESCRIPTION =
  'Run a dataflow analysis program over the explorer\'s data layers. Display sinks draw on '
  + 'the map the user is looking at; the returned JSON carries the answer payloads (or '
  + 'structured validation errors to fix and retry).';

export const RUN_ANALYSIS_NAME = 'run_analysis';

/** One assistant turn's text sink. The chat owns the bubble; the provider just fills it. */
export interface AssistantTurn {
  /** Appends streamed text. */
  text(delta: string): void;
  /** Closes the turn. A turn that received no text leaves no bubble behind (tool-only turns). */
  end(): void;
}

/** What a provider may do to the transcript while `ask` runs. */
export interface ChatHooks {
  /** Opens a bubble for a new model turn. */
  beginTurn(): AssistantTurn;
  /** Notes that the model started reasoning. Providers call it freely; the chat shows one marker per turn. */
  noteThinking(): void;
  /**
   * Runs one `run_analysis` call through the host's pipeline (sanitize → validate → execute)
   * and returns the JSON summary to hand back as the tool result. Never throws: validation
   * failures come back as structured issues for the model to repair in the same turn.
   */
  runTool(input: unknown): Promise<string>;
}

export interface ChatProviderConfig {
  apiKey: string;
  systemPrompt: string;
  /** The `run_analysis` input schema (from `runAnalysisInputSchema`), as plain JSON Schema. */
  inputSchema: JsonSchema;
}

export interface ChatProvider {
  /**
   * Asks a question and drives the tool loop to completion. Throws on transport or auth
   * failure — the chat renders that through {@link describeProviderError}.
   */
  ask(question: string, hooks: ChatHooks): Promise<void>;
  /** Records a program the user ran by hand, so follow-ups start from what is on screen. */
  noteExternalRun(program: AnalysisProgram): void;
  /** Drops the last user turn so a failed question can be retried cleanly. */
  rollbackLastAsk(): void;
}

/** A provider module's entry point. Both modules export this under the same name. */
export type CreateChatProvider = (config: ChatProviderConfig) => ChatProvider;

/**
 * Maps a thrown provider error onto something worth showing a user. Both vendors report the
 * same three failures that are actually the user's to fix — a bad key, a key without access,
 * and an exhausted quota — just with different wording and status codes.
 */
export function describeProviderError(error: unknown, meta: ProviderMeta): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/\b401\b|authentication|API_KEY_INVALID|api[_ ]key not valid/i.test(msg)) {
    return `Authentication failed — check the ${meta.label} API key.`;
  }
  if (/\b403\b|permission|PERMISSION_DENIED/i.test(msg)) {
    return `That ${meta.label} key exists but lacks access to ${meta.model}.`;
  }
  if (/\b429\b|quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) {
    return `${meta.label} rate limit or quota reached for ${meta.model} — wait a moment and retry.`;
  }
  return msg;
}
