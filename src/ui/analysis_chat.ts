/**
 * "Ask" tab of the analysis panel — the LLM front end of the analysis graph
 * (TODO/geo-analysis-graph.md §7).
 *
 * The model answers data questions by emitting whole analysis programs through one
 * `run_analysis` tool whose input schema IS the program AST (op names and layer keys are
 * enums). The tool executes locally via the host's `execute` callback (FieldStore +
 * interpreter — data never leaves the browser; only the program and its summary statistics
 * cross the API), results land on the map/chart exactly like preset runs, and the summary
 * goes back as the tool result to narrate. Validation failures return as structured issues
 * the provider's tool loop lets the model repair in the same turn.
 *
 * This module owns everything that is the same whichever vendor answers: the key row, the
 * transcript, the example chips, and the tool itself. The API round-trip lives behind
 * {@link ChatProvider} — see [analysis_chat_provider.ts](./analysis_chat_provider.ts) — with
 * one module per vendor, imported lazily so only the chosen vendor's SDK is ever fetched.
 *
 * API keys are pasted at runtime and kept per-vendor in localStorage (the Street View
 * sample's pattern), and calls go browser-direct. If this sample is ever hosted with a key
 * of ours, put a key-holding proxy in front instead.
 */

import { sanitizeProgram, type JsonSchema } from '../analysis/schema.js';
import {
  PROVIDERS, describeProviderError, toProviderId,
  type AssistantTurn, type ChatProvider, type CreateChatProvider, type ProviderId, type ProviderMeta,
} from './analysis_chat_provider.js';
import type { AnalysisProgram } from '../analysis/ast.js';

export interface AnalysisChatOptions {
  container: HTMLElement;
  systemPrompt: string;
  /** The run_analysis input schema (from `runAnalysisInputSchema`). */
  inputSchema: JsonSchema;
  /** Runs a sanitized program. Never throws — failures come back as `{ok:false, errors}`. */
  execute(program: AnalysisProgram): Promise<unknown>;
}

export interface AnalysisChat {
  /** Tells the conversation about a program the user ran manually (graph editor / presets),
   *  so follow-up questions start from what is actually on screen. */
  notifyExternalRun(program: AnalysisProgram): void;
}

const PROVIDER_STORAGE = 'earth_explorer_analysis_provider';

export function buildAnalysisChat(opts: AnalysisChatOptions): AnalysisChat {
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };
  const ctrl = 'background:#12141a;color:#dfeef0;border:1px solid #444;border-radius:4px;font-size:13px;padding:3px 6px';

  let providerId: ProviderId = toProviderId(localStorage.getItem(PROVIDER_STORAGE));

  // ── Orientation + example questions (shown until the first question is asked) ────────
  const intro = document.createElement('div');
  intro.textContent = 'Ask about the data in plain English — the model writes a small analysis '
    + 'program and runs it right here in your browser; results draw on the map. Try one:';
  css(intro, 'color:#8fa5ab;font-size:12px;line-height:1.5;margin-bottom:6px');

  const EXAMPLE_QUESTIONS = [
    'Is there a correlation between sea temperature and wind speed?',
    'Forecast the sea temperature anomaly 3 months from now — where will it be warmest?',
    'How has Arctic sea ice changed since 2016?',
    'Does El Niño lead global sea-surface temperature, and by how many months?',
  ];
  const examples = document.createElement('div');
  css(examples, 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px');

  // ── Provider + API key row ──────────────────────────────────────────────────────────
  // A real <form> so the password field has form context (browsers warn otherwise) and
  // Enter-in-field saves; autocomplete off keeps password managers from offering to store it.
  const keyRow = document.createElement('form');
  css(keyRow, 'display:flex;align-items:center;gap:6px;margin-bottom:4px');
  keyRow.autocomplete = 'off';

  const providerSel = document.createElement('select');
  css(providerSel, `${ctrl};height:26px;padding:0 4px`);
  providerSel.title = 'Which model answers — each keeps its own API key';
  for (const meta of Object.values(PROVIDERS)) {
    const o = document.createElement('option');
    o.value = meta.id;
    o.textContent = meta.label;
    providerSel.appendChild(o);
  }
  providerSel.value = providerId;

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.name = 'llm-api-key';
  css(keyInput, `${ctrl};flex:1`);
  keyInput.autocomplete = 'off';
  const keyBtn = document.createElement('button');
  keyBtn.type = 'submit';
  css(keyBtn, 'cursor:pointer;background:#2a2a38;color:#dfeef0;border:1px solid #444;border-radius:4px;height:26px;padding:0 10px;font-size:13px;font-family:inherit');
  keyRow.append(providerSel, keyInput, keyBtn);

  // Where to get a key for whichever vendor is selected, plus the model it will call.
  const keyHint = document.createElement('div');
  css(keyHint, 'color:#6f8288;font-size:11px;line-height:1.5;margin-bottom:6px');

  function currentMeta(): ProviderMeta {
    return PROVIDERS[providerId];
  }
  function storedKey(): string | null {
    return localStorage.getItem(currentMeta().keyStorage);
  }

  function refreshKeyRow(): void {
    const meta = currentMeta();
    const has = Boolean(storedKey());
    keyInput.placeholder = meta.keyPlaceholder;
    keyInput.style.display = has ? 'none' : 'block';
    keyBtn.textContent = has ? 'key ✓ (clear)' : 'Save key';
    keyHint.textContent = '';
    keyHint.append(
      `Calls ${meta.model} directly from this browser with your key. Get one at `,
    );
    const link = document.createElement('a');
    link.href = meta.consoleUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = meta.consoleLabel;
    css(link, 'color:#5ef0c8');
    keyHint.append(link, '.');
  }

  keyRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const meta = currentMeta();
    if (storedKey()) {
      localStorage.removeItem(meta.keyStorage);
    } else if (keyInput.value.trim()) {
      localStorage.setItem(meta.keyStorage, keyInput.value.trim());
      keyInput.value = '';
    }
    refreshKeyRow();
  });

  providerSel.addEventListener('change', () => {
    providerId = toProviderId(providerSel.value);
    localStorage.setItem(PROVIDER_STORAGE, providerId);
    keyInput.value = '';
    refreshKeyRow();
    // History is provider-native, so the conversation cannot follow the switch.
    if (provider) {
      provider = null;
      providerToken = '';
      bubble('activity', `— switched to ${currentMeta().label}; starting a new conversation —`);
    }
  });
  refreshKeyRow();

  // ── Transcript ──────────────────────────────────────────────────────────────────────
  const log = document.createElement('div');
  css(log, 'display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow-y:auto;margin-bottom:6px');

  function bubble(kind: 'user' | 'assistant' | 'activity' | 'error', text: string): HTMLDivElement {
    const b = document.createElement('div');
    const base = 'padding:5px 8px;border-radius:6px;white-space:pre-wrap;line-height:1.45;max-width:95%';
    if (kind === 'user') {
      css(b, `${base};align-self:flex-end;background:#233;color:#dfeef0`);
    } else if (kind === 'assistant') {
      css(b, `${base};align-self:flex-start;background:rgba(94,240,200,0.08);color:#dfeef0`);
    } else if (kind === 'activity') {
      css(b, 'align-self:flex-start;color:#8fa5ab;font-size:12px;padding:0 2px');
    } else {
      css(b, `${base};align-self:flex-start;background:rgba(255,95,70,0.12);color:#ffb4a4`);
    }
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  /** Collapsible pretty-printed program under an activity line — the pre-M4 "Graph" view. */
  function showProgram(program: AnalysisProgram): void {
    const details = document.createElement('details');
    css(details, 'align-self:stretch;color:#8fa5ab;font-size:12px');
    const summary = document.createElement('summary');
    summary.textContent = `▶ ran analysis program (${program.nodes.length} nodes)`;
    css(summary, 'cursor:pointer');
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(program, null, 1);
    css(pre, 'margin:3px 0 0;padding:5px;background:rgba(255,255,255,0.04);border-radius:4px;overflow-x:auto;max-height:180px;overflow-y:auto');
    details.append(summary, pre);
    log.appendChild(details);
    log.scrollTop = log.scrollHeight;
  }

  // ── Input row ───────────────────────────────────────────────────────────────────────
  const inputRow = document.createElement('div');
  css(inputRow, 'display:flex;gap:6px');
  const question = document.createElement('input');
  question.type = 'text';
  question.placeholder = 'e.g. is sea temperature correlated with wind?';
  css(question, `${ctrl};flex:1`);
  question.autocomplete = 'off';
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Ask';
  css(sendBtn, 'cursor:pointer;background:#2a2a38;color:#5ef0c8;border:1px solid #444;border-radius:4px;height:28px;padding:0 14px;font-size:13px;font-family:inherit');
  inputRow.append(question, sendBtn);

  for (const q of EXAMPLE_QUESTIONS) {
    const chip = document.createElement('button');
    chip.textContent = `“${q}”`;
    chip.title = 'Ask this';
    css(chip, 'cursor:pointer;text-align:left;background:rgba(94,240,200,0.06);color:#9fd8cf;'
      + 'border:1px solid #2e4a44;border-radius:6px;padding:5px 9px;font-size:12px;font-family:inherit;line-height:1.4');
    chip.addEventListener('click', () => {
      question.value = q;
      void send();
    });
    examples.appendChild(chip);
  }

  opts.container.append(intro, keyRow, keyHint, examples, log, inputRow);

  // ── Hooks the provider drives the transcript through ────────────────────────────────
  let thinkingNoted = false;

  function beginTurn(): AssistantTurn {
    thinkingNoted = false;
    let b: HTMLDivElement | null = null;
    return {
      text: (delta) => {
        // Created on first text so a tool-call-only turn leaves no empty bubble behind.
        if (!b) {
          b = bubble('assistant', '');
        }
        b.textContent += delta;
        log.scrollTop = log.scrollHeight;
      },
      end: () => { /* nothing to tear down — an untouched turn never made a bubble */ },
    };
  }

  function noteThinking(): void {
    if (!thinkingNoted) {
      thinkingNoted = true;
      bubble('activity', '… thinking');
    }
  }

  /** The tool: the model's programs run through the same pipeline as the presets. */
  async function runTool(input: unknown): Promise<string> {
    const program = sanitizeProgram(input);
    showProgram(program);
    return JSON.stringify(await opts.execute(program));
  }

  // ── Conversation loop ───────────────────────────────────────────────────────────────
  let provider: ChatProvider | null = null;
  /** Identifies the vendor+key the live provider was built for; a change rebuilds it. */
  let providerToken = '';
  let busy = false;

  async function resolveProvider(key: string): Promise<ChatProvider> {
    const token = `${providerId}:${key}`;
    if (provider && providerToken === token) {
      return provider;
    }
    const mod: { createChatProvider: CreateChatProvider } = providerId === 'gemini'
      ? await import('./analysis_chat_gemini.js')
      : await import('./analysis_chat_anthropic.js');
    provider = mod.createChatProvider({
      apiKey: key,
      systemPrompt: opts.systemPrompt,
      inputSchema: opts.inputSchema,
    });
    providerToken = token;
    return provider;
  }

  async function send(): Promise<void> {
    const text = question.value.trim();
    const key = storedKey();
    if (busy || !text) {
      return;
    }
    if (!key) {
      bubble('error', `Paste a ${currentMeta().label} API key first — it stays in this browser.`);
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    question.value = '';
    examples.style.display = 'none';   // the transcript takes over from the starters
    bubble('user', text);

    let active: ChatProvider | null = null;
    try {
      active = await resolveProvider(key);
      await active.ask(text, { beginTurn, noteThinking, runTool });
    } catch (e) {
      bubble('error', describeProviderError(e, currentMeta()));
      active?.rollbackLastAsk();   // let the user retry the question
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }
  sendBtn.addEventListener('click', () => { void send(); });
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void send();
    }
  });

  return {
    notifyExternalRun: (program) => {
      // Only meaningful once a conversation exists — a provider built later starts from the
      // question the user actually asks, and the panel re-notifies through normal use.
      provider?.noteExternalRun(program);
    },
  };
}
