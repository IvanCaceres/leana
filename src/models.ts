// What the active provider and model can do, read from the provider itself: the context and output
// limits, the sampling parameters it takes, and whether and how it reasons (the efforts it accepts,
// whether a token budget works, whether reasoning can be turned off). Leana offers and sends only
// what the model takes: the options the app shows, the fields a request carries and the limits the
// context is fitted to all come from here.
import type { Config } from './types.js';

export type Provider = Config['provider'];
export const providers: Provider[] = ['llama', 'openrouter'];
export interface ReasoningInfo {
  supported: boolean;
  // Cannot be turned off.
  mandatory: boolean;
  // The efforts it accepts; null: any of the provider's (OpenRouter's gateway list).
  efforts: string[] | null;
  defaultEffort?: string;
  defaultEnabled?: boolean;
  // A token budget for the thinking can be set.
  budget: boolean;
}
export interface ModelInfo {
  provider: Provider; id: string; name: string; description?: string;
  contextLength: number; maxOutput: number;
  // Request parameters it takes (OpenAI names: temperature, top_p, top_k, min_p, presence_penalty, stop, ...).
  params: string[];
  // A JSON schema can be enforced on the reply.
  structured: boolean;
  reasoning: ReasoningInfo;
  // US dollars per token.
  pricing?: { prompt: number; completion: number };
  // Facts about the model the provider reports (size, quantization, template), for display only.
  details?: Record<string, string>;
}
// The efforts OpenRouter's gateway accepts when a model lists none of its own.
export const gatewayEfforts = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
export const effortsOf = (r: ReasoningInfo): string[] => r.efforts ?? gatewayEfforts;
const root = (url: string) => url.replace(/\/v1\/?$/, '').replace(/\/$/, '');

async function getJson(url: string, key: string, timeoutMs = 15000): Promise<any> {
  const r = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) { await r.body?.cancel(); throw new Error(`HTTP ${r.status} from ${new URL(url).origin}`); }
  return r.json();
}

// llama-server: /props for the context and the chat template, /v1/models for the model's own facts.
// It takes every sampling parameter Leana sends. The template says whether the model thinks
// (enable_thinking or a <think> block) and which efforts its reasoning_effort accepts (the list the
// template checks it against); the server caps thinking by tokens (reasoning_budget_tokens).
export function llamaModelInfo(props: any, models: any, alias: string): ModelInfo {
  const template = String(props?.chat_template ?? '');
  const thinks = /enable_thinking|<think>/.test(template);
  const near = template.slice(Math.max(0, template.indexOf('reasoning_effort')), template.indexOf('reasoning_effort') + 600);
  const listed = template.includes('reasoning_effort') ? near.match(/not in \(([^)]*)\)/)?.[1] : undefined;
  const efforts = listed ? [...listed.matchAll(/['"]([\w-]+)['"]/g)].map(m => m[1]!) : [];
  const fallback = near.match(/default\(\s*['"]([\w-]+)['"]\s*\)/)?.[1];
  const ctx = Number(props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? 0);
  const m = (Array.isArray(models?.data) ? models.data : []).find((x: any) => x.id === alias) ?? models?.data?.[0];
  const meta = m?.meta ?? {};
  const details: Record<string, string> = {};
  if (props?.model_path) details.file = String(props.model_path).split('/').pop()!;
  if (meta.n_params) details.parameters = `${(meta.n_params / 1e9).toFixed(1)}B`;
  if (meta.size) details.size = `${(meta.size / 2 ** 30).toFixed(2)} GiB`;
  if (meta.n_ctx_train) details.trainedContext = String(meta.n_ctx_train);
  if (props?.build_info) details.server = String(props.build_info);
  return {
    provider: 'llama', id: String(props?.model_alias ?? m?.id ?? alias), name: String(props?.model_alias ?? m?.id ?? alias),
    contextLength: ctx || Number(meta.n_ctx_train ?? 0), maxOutput: ctx || Number(meta.n_ctx_train ?? 0),
    params: ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'stop', 'max_tokens', 'response_format'],
    structured: true,
    reasoning: { supported: thinks, mandatory: false, efforts: thinks ? efforts : [], ...(fallback && efforts.includes(fallback) ? { defaultEffort: fallback } : {}), budget: thinks },
    details,
  };
}

// OpenRouter: one entry of GET /api/v1/models, as it lists them.
export function openrouterModelInfo(m: any): ModelInfo {
  const params: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
  const r = m?.reasoning;
  const supported = Boolean(r) || params.includes('reasoning');
  const price = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const arch = m?.architecture ?? {};
  return {
    provider: 'openrouter', id: String(m.id), name: String(m.name ?? m.id), ...(m.description ? { description: String(m.description) } : {}),
    contextLength: Number(m.top_provider?.context_length ?? m.context_length ?? 0),
    maxOutput: Number(m.top_provider?.max_completion_tokens ?? m.context_length ?? 0) || Number(m.context_length ?? 0),
    params,
    structured: params.includes('structured_outputs'),
    reasoning: {
      supported, mandatory: Boolean(r?.mandatory),
      efforts: !supported ? [] : Array.isArray(r?.supported_efforts) ? r.supported_efforts.map(String) : params.includes('reasoning_effort') || r ? null : [],
      ...(r?.default_effort ? { defaultEffort: String(r.default_effort) } : {}),
      ...(typeof r?.default_enabled === 'boolean' ? { defaultEnabled: r.default_enabled } : {}),
      budget: supported && r?.supports_max_tokens !== false,
    },
    pricing: { prompt: price(m.pricing?.prompt), completion: price(m.pricing?.completion) },
    details: { ...(arch.modality ? { modality: String(arch.modality) } : {}), ...(arch.tokenizer ? { tokenizer: String(arch.tokenizer) } : {}), ...(m.knowledge_cutoff ? { knowledgeCutoff: String(m.knowledge_cutoff) } : {}) },
  };
}

// The catalogue of the provider: llama-server serves what it loaded; OpenRouter lists hundreds,
// narrowed by a query on the id and name.
export async function listModels(config: Config, key: string, query = ''): Promise<ModelInfo[]> {
  if (config.provider === 'openrouter') {
    const all = await getJson(`${config.openrouterUrl.replace(/\/$/, '')}/models`, key, 30000);
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (Array.isArray(all?.data) ? all.data : []).map(openrouterModelInfo).filter((m: ModelInfo) => q.every(w => `${m.id} ${m.name}`.toLowerCase().includes(w)));
  }
  return [await describeModel(config, key)];
}
const described = new Map<string, Promise<ModelInfo>>();
// The active model's facts, once per provider, address and model.
export function describeModel(config: Config, key: string): Promise<ModelInfo> {
  const id = `${config.provider} ${config.provider === 'openrouter' ? config.openrouterUrl : config.baseUrl} ${config.model}`;
  let p = described.get(id);
  if (!p) {
    p = (async () => {
      if (config.provider === 'openrouter') {
        const all = await getJson(`${config.openrouterUrl.replace(/\/$/, '')}/models`, key, 30000);
        const m = (Array.isArray(all?.data) ? all.data : []).find((x: any) => x.id === config.model || x.canonical_slug === config.model);
        if (!m) throw new Error(`OpenRouter lists no model "${config.model}"; leana models <words> searches its catalogue`);
        return openrouterModelInfo(m);
      }
      const [props, models] = await Promise.all([getJson(`${root(config.baseUrl)}/props`, key), getJson(`${root(config.baseUrl)}/v1/models`, key).catch(() => null)]);
      return llamaModelInfo(props, models, config.model);
    })();
    p.catch(() => described.delete(id));
    described.set(id, p);
  }
  return p;
}

// The config fitted to the model: the window is the model's, the output limit at most what it can
// write, and the working budget and file budget kept inside them (each request is checked against
// these). A larger window than the model's is never assumed.
export function fitToModel(config: Config, m: ModelInfo): Config {
  if (!m.contextLength) return config;
  const contextWindow = config.provider === 'llama' ? Math.min(config.contextWindow, m.contextLength) : m.contextLength;
  const maxTokens = Math.max(1024, Math.min(config.maxTokens, m.maxOutput || config.maxTokens, Math.floor(contextWindow / 4)));
  const workingTokens = Math.max(2000, Math.min(config.workingTokens, contextWindow - maxTokens - config.safetyTokens));
  const createTokens = Math.max(maxTokens, Math.min(config.createTokens, contextWindow - workingTokens - config.safetyTokens));
  const stepThinkingBudget = Math.min(config.stepThinkingBudget, Math.max(256, maxTokens - 512));
  return { ...config, contextWindow, maxTokens, workingTokens, createTokens, stepThinkingBudget };
}

// An option the app offers for the active model: its name, what it sets, the values it takes, and
// why it is not offered when the model does not take it.
export interface ModelOption { name: string; describe: string; values: string; get: (c: Config) => string; set: (c: Config, value: string) => Partial<Config>; }
const num = (lo: number, hi: number, integer = false) => (v: string): number => {
  const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) throw new Error(`expected ${integer ? 'an integer' : 'a number'} from ${lo} to ${hi}`); return n;
};
const onOff = (v: string): boolean => { if (/^(on|true|yes|1)$/i.test(v)) return true; if (/^(off|false|no|0)$/i.test(v)) return false; throw new Error('expected on or off'); };
export function modelOptions(m: ModelInfo): ModelOption[] {
  const out: ModelOption[] = []; const has = (p: string) => m.params.includes(p);
  const r = m.reasoning;
  if (r.supported) {
    if (r.mandatory) out.push({ name: 'reasoning', describe: 'the model always reasons before it answers (it cannot be turned off)', values: 'always on', get: () => 'always on', set: () => { throw new Error(`${m.id} always reasons; it cannot be turned off`); } });
    else {
      out.push({ name: 'reasoning', describe: 'reason before each step\'s reply', values: 'on | off', get: c => c.stepThinking ? 'on' : 'off', set: (_c, v) => ({ stepThinking: onOff(v) }) });
      out.push({ name: 'file-reasoning', describe: 'reason before writing each file', values: 'on | off', get: c => c.codeThinking ? 'on' : 'off', set: (_c, v) => ({ codeThinking: onOff(v) }) });
    }
    const efforts = effortsOf(r);
    if (efforts.length) out.push({ name: 'effort', describe: `how much the model reasons${r.defaultEffort ? ` (its default: ${r.defaultEffort})` : ''}`, values: efforts.join(' | '), get: c => c.thinkingEffort, set: (_c, v) => { if (!efforts.includes(v)) throw new Error(`${m.id} takes ${efforts.join(', ')}`); return { thinkingEffort: v }; } });
    if (r.budget) {
      const hi = Math.max(256, m.maxOutput || 32768);
      out.push({ name: 'budget', describe: 'most tokens a step may reason for', values: `256..${hi}`, get: c => String(c.stepThinkingBudget), set: (_c, v) => ({ stepThinkingBudget: num(256, hi, true)(v) }) });
      out.push({ name: 'file-budget', describe: 'most tokens the model may reason for before a file', values: `256..${hi}`, get: c => String(c.codeThinkingBudget), set: (_c, v) => ({ codeThinkingBudget: num(256, hi, true)(v) }) });
    }
  }
  if (has('temperature')) {
    out.push({ name: 'temperature', describe: 'sampling temperature of steps (without reasoning)', values: '0..2', get: c => String(c.stepTemperature), set: (_c, v) => ({ stepTemperature: num(.01, 2)(v) }) });
    if (r.supported) out.push({ name: 'reasoning-temperature', describe: 'sampling temperature of steps that reason', values: '0..2', get: c => String(c.stepThinkingTemperature), set: (_c, v) => ({ stepThinkingTemperature: num(.01, 2)(v) }) });
    out.push({ name: 'code-temperature', describe: 'sampling temperature of file content', values: '0..2', get: c => String(c.codeTemperature), set: (_c, v) => ({ codeTemperature: num(.01, 2)(v) }) });
  }
  if (has('top_p')) {
    out.push({ name: 'top-p', describe: 'nucleus sampling of steps', values: '0..1', get: c => String(c.stepTopP), set: (_c, v) => ({ stepTopP: num(.01, 1)(v) }) });
    out.push({ name: 'code-top-p', describe: 'nucleus sampling of file content', values: '0..1', get: c => String(c.codeTopP), set: (_c, v) => ({ codeTopP: num(.01, 1)(v) }) });
  }
  if (has('top_k')) {
    out.push({ name: 'top-k', describe: 'candidate tokens per step token', values: '1..200', get: c => String(c.stepTopK), set: (_c, v) => ({ stepTopK: num(1, 200, true)(v) }) });
    out.push({ name: 'code-top-k', describe: 'candidate tokens per file token', values: '1..200', get: c => String(c.codeTopK), set: (_c, v) => ({ codeTopK: num(1, 200, true)(v) }) });
  }
  if (has('min_p')) {
    out.push({ name: 'min-p', describe: 'drop step tokens less likely than this times the top one', values: '0..0.99', get: c => String(c.stepMinP), set: (_c, v) => ({ stepMinP: num(0, .99)(v) }) });
    out.push({ name: 'code-min-p', describe: 'the same for file content', values: '0..0.99', get: c => String(c.codeMinP), set: (_c, v) => ({ codeMinP: num(0, .99)(v) }) });
  }
  if (has('presence_penalty')) out.push({ name: 'code-presence-penalty', describe: 'penalty on file tokens already used', values: '0..2', get: c => String(c.codePresencePenalty), set: (_c, v) => ({ codePresencePenalty: num(0, 2)(v) }) });
  const out_ = Math.max(1024, Math.min(m.maxOutput || 65536, m.contextLength ? Math.floor(m.contextLength / 4) : 65536));
  out.push({ name: 'max-output', describe: 'most tokens one reply may have (the step reply and its reasoning)', values: `1024..${out_}`, get: c => String(c.maxTokens), set: (_c, v) => ({ maxTokens: num(1024, out_, true)(v) }) });
  if (m.contextLength) out.push({ name: 'working-tokens', describe: 'most tokens of evidence a prompt carries before older evidence is dropped', values: `4000..${Math.floor(m.contextLength / 2)}`, get: c => String(c.workingTokens), set: (_c, v) => ({ workingTokens: num(4000, Math.floor(m.contextLength / 2), true)(v) }) });
  return out;
}
// The settings the active model does not take, as one line each: a config that sets them on another
// model's account is told, not silently obeyed.
export function unsupportedSettings(c: Config, m: ModelInfo): string[] {
  const out: string[] = []; const r = m.reasoning;
  if (!r.supported && (c.stepThinking || c.codeThinking)) out.push(`${m.id} does not reason: reasoning is off for this run`);
  if (r.supported && (c.stepThinking || c.codeThinking) && !effortsOf(r).includes(c.thinkingEffort) && !(m.provider === 'llama' && !effortsOf(r).length))
    out.push(`${m.id} does not take effort ${c.thinkingEffort} (it takes ${effortsOf(r).join(', ') || 'none'})${r.budget ? ': its token budget is used instead' : ''}`);
  return out;
}
