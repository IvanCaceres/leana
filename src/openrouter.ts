// The model through OpenRouter: the same three calls the llama-server client makes (count a prompt,
// generate a step's JSON reply, generate a file as code), over OpenRouter's OpenAI-compatible chat API.
// What the model takes decides what a request carries (models.ts): sampling parameters it lists, a
// JSON schema when it enforces one, reasoning as its efforts and budget allow. Both calls stream, so
// the reasoning and the reply show as they are written and a file is judged for loops as it arrives.
import { randomUUID } from 'node:crypto';
import type { Config, GenerationMeta, JsonSchema, Log, Message } from './types.js';
import { isEventStream, lineCut, post, quietly, repeatCut, streamEvents, type StreamProgress, type TextGeneration, type TextOptions, type GenerationCut } from './clients.js';
import { samplingSchema, validate } from './schema.js';
import { describeModel, effortsOf, gatewayEfforts, type ModelInfo } from './models.js';

// A reply read from a stream: its content, its reasoning, why it ended, and the usage the last event carries.
interface Reply { content: string; reasoning: string; finish?: string; usage?: any; model?: string; aborted?: boolean }

export class OpenRouter {
  lastMeta: GenerationMeta | null = null;
  // Tokens per character of a rendered prompt, from the last reply's usage (OpenRouter has no tokenizer
  // endpoint; the model's own count comes back with each reply).
  private ratio = 1 / 3.5;
  constructor(readonly config: Config, private key: string, private log: Log) {
    if (!key) throw new Error('OpenRouter needs an API key: set OPENROUTER_API_KEY, or providerKeyFile to a file that holds it.');
  }
  private get url(): string { return `${this.config.openrouterUrl.replace(/\/$/, '')}/chat/completions`; }
  model(): Promise<ModelInfo> { return describeModel(this.config, this.key); }
  // An estimate: characters of the messages times the ratio last measured, plus a few tokens a message
  // for the chat template.
  async count(messages: Message[]): Promise<{ tokens: number; mode: string }> {
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    return { tokens: Math.ceil(chars * this.ratio) + 6 * messages.length, mode: 'estimate' };
  }
  private learn(messages: Message[], usage: any): void {
    const chars = messages.reduce((n, m) => n + m.content.length, 0); const tokens = Number(usage?.prompt_tokens);
    if (chars > 2000 && Number.isFinite(tokens) && tokens > 0) this.ratio = Math.min(.6, Math.max(.15, (tokens - 6 * messages.length) / chars));
  }
  // The reasoning field of a request: the effort when the model takes it, else the budget, else on; off
  // when it can be turned off. Reasoning the model always does is left at its default, and shown.
  private reasoning(m: ModelInfo, budget: number | undefined): Record<string, unknown> {
    const r = m.reasoning; if (!r.supported) return {};
    if (!budget) return r.mandatory ? {} : { reasoning: effortsOf(r).includes('none') && r.efforts !== null ? { effort: 'none' } : { enabled: false } };
    const efforts = r.efforts ?? gatewayEfforts;
    if (efforts.includes(this.config.thinkingEffort)) return { reasoning: { effort: this.config.thinkingEffort } };
    if (r.budget) return { reasoning: { max_tokens: budget } };
    return { reasoning: { enabled: true } };
  }
  private sampling(m: ModelInfo, kind: 'step' | 'code', temperature: number): Record<string, unknown> {
    const has = (p: string) => m.params.includes(p); const c = this.config;
    return { ...(has('temperature') ? { temperature } : {}),
      ...(has('top_p') ? { top_p: kind === 'step' ? c.stepTopP : c.codeTopP } : {}), ...(has('top_k') ? { top_k: kind === 'step' ? c.stepTopK : c.codeTopK } : {}),
      ...(has('min_p') ? { min_p: kind === 'step' ? c.stepMinP : c.codeMinP } : {}), ...(kind === 'code' && has('presence_penalty') && c.codePresencePenalty > 0 ? { presence_penalty: c.codePresencePenalty } : {}) };
  }
  // One streamed chat completion: content and reasoning as they come (OpenRouter sends reasoning as
  // delta.reasoning and as reasoning_details of type reasoning.text or reasoning.summary), the finish reason,
  // and the usage of the last event. judge, when given, sees the content so far and stops the request when
  // it says so (the connection is closed; OpenRouter cancels the generation at providers that support it).
  private async chat(body: Record<string, unknown>, timeoutMs: number, progress: (p: StreamProgress) => void, judge?: (content: string, tokens: number) => boolean): Promise<Reply> {
    const abort = new AbortController();
    const response = await post(this.url, { ...body, stream: true, usage: { include: true } }, this.key, timeoutMs, 2, abort.signal);
    if (!isEventStream(response)) {
      const r = await response.json(); const c = r.choices?.[0];
      if (r.error) throw new Error(`OpenRouter: ${String(r.error.message ?? r.error.code ?? 'error').slice(0, 200)}`);
      return { content: String(c?.message?.content ?? ''), reasoning: String(c?.message?.reasoning ?? ''), finish: c?.finish_reason, usage: r.usage, model: r.model };
    }
    let content = ''; let reasoning = ''; let finish: string | undefined; let usage: any; let model: string | undefined; let tokens = 0;
    for await (const e of streamEvents(response, this.url, abort, 120000, 120000)) {
      model ??= e.model; if (e.usage) usage = e.usage;
      for (const c of e.choices ?? []) {
        if (c.finish_reason === 'error') throw new Error(`OpenRouter: the provider failed mid-stream${e.error?.message ? ` (${String(e.error.message).slice(0, 200)})` : ''}`);
        if (c.finish_reason) finish = c.finish_reason;
        const d = c.delta ?? {};
        const said = typeof d.reasoning === 'string' ? d.reasoning : Array.isArray(d.reasoning_details) ? d.reasoning_details.map((x: any) => x?.text ?? x?.summary ?? '').join('') : '';
        if (said) { reasoning += said; progress({ text: content, tokens: ++tokens, reasoning }); }
        if (typeof d.content === 'string' && d.content) {
          content += d.content; progress({ text: content, tokens: ++tokens, ...(reasoning ? { reasoning } : {}) });
          if (judge?.(content, tokens)) { abort.abort(); return { content, reasoning, finish: 'length', usage, model, aborted: true }; }
        }
      }
    }
    return { content, reasoning, finish, usage, model };
  }

  // A step's reply as JSON under schema. A model that enforces a JSON schema gets it (and only providers
  // that do are asked); one that does not is asked for a JSON object and its reply is read for one.
  async generate(messages: Message[], schema: JsonSchema, temperature = this.config.stepTemperature, context?: { step: number; route: string }, maxTokens = this.config.maxTokens, progress?: (p: StreamProgress) => void, thinking?: number): Promise<Record<string, any>> {
    const m = await this.model(); const count = await this.count(messages);
    if (count.tokens > this.config.workingTokens || count.tokens + maxTokens + this.config.safetyTokens > (m.contextLength || this.config.contextWindow))
      throw new Error('Prompt exceeds budget; generation refused');
    const requestId = randomUUID(); const start = performance.now();
    const reasons = Boolean(thinking) || m.reasoning.mandatory;
    const body: Record<string, any> = { model: this.config.model, messages, max_tokens: Math.min(maxTokens + (reasons ? thinking ?? 0 : 0), m.maxOutput || Infinity), ...this.sampling(m, 'step', temperature), ...this.reasoning(m, thinking),
      ...(m.structured ? { response_format: { type: 'json_schema', json_schema: { name: 'arguments', strict: true, schema: samplingSchema(schema) } }, provider: { require_parameters: true } } : m.params.includes('response_format') ? { response_format: { type: 'json_object' } } : {}) };
    await this.log('bonsai-request', { requestId, ...context, provider: 'openrouter', model: this.config.model, prompt: count, temperature, maxTokens: body.max_tokens, ...(body.reasoning ? { reasoning: body.reasoning } : {}), structured: m.structured });
    try {
      const r = await this.chat(body, 60000 + Number(body.max_tokens) * 120, quietly(progress));
      this.learn(messages, r.usage);
      const ms = performance.now() - start;
      this.lastMeta = { ms, usage: r.usage, timings: r.usage?.completion_tokens ? { predicted_per_second: r.usage.completion_tokens / (ms / 1000) } : undefined, finishReason: r.finish, promptTokens: count.tokens, ...(r.reasoning ? { reasoning: r.reasoning.trim() } : {}) };
      await this.log('bonsai', { requestId, ...context, provider: 'openrouter', model: r.model ?? this.config.model, ms, prompt: count, usage: r.usage, finishReason: r.finish, ...(r.reasoning ? { reasoningChars: r.reasoning.trim().length } : {}), ...(r.usage?.cost !== undefined ? { cost: r.usage.cost } : {}) });
      if (r.finish !== 'stop' && r.finish !== undefined) throw new Error(`Bonsai did not finish a JSON argument object (${r.finish})`);
      const args = parseJson(r.content);
      validate(schema, args);
      return args as Record<string, any>;
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message });
      throw e;
    }
  }

  // A file as code: the request's last message asks for it, and the reply is opened with the code fence
  // (the assistant prefill OpenRouter passes to the model), so the content is the code; the closing fence
  // is the stop sequence. A model that writes the fence again anyway has it dropped. A reply cut by its
  // output limit is continued from what was written, sent back as the start of the reply; a continuation
  // that starts the file over (a provider that ignores the prefill) ends the file there as at its budget.
  // Loops and a region's echo are judged as the text arrives, as for llama-server (repeatCut).
  async generateText(messages: Message[], options: TextOptions = {}): Promise<TextGeneration> {
    const m = await this.model(); const budget = options.budgetTokens ?? this.config.createTokens; const temperature = options.temperature ?? this.config.codeTemperature;
    const fence = options.fence === undefined ? '```' : options.fence; const context = options.context; const progress = quietly(options.progress);
    const run = fence?.match(/^`+/)?.[0] ?? '```'; const closing = `\n${run}`;
    const requestId = randomUUID(); const start = performance.now(); const count = await this.count(messages);
    await this.log('bonsai-request', { requestId, ...context, provider: 'openrouter', model: this.config.model, prompt: count, temperature, budgetTokens: budget, ...(options.think ? { thinking: options.think } : {}) });
    let text = ''; let generated = 0; let continuations = 0; let finish: TextGeneration['finish'] = 'stop'; let cut: GenerationCut | undefined; let cutFrom = ''; let reasoning = ''; let usage: any = {};
    try {
      while (true) {
        const n = Math.min(budget - generated, m.maxOutput || budget); if (n <= 0) { finish = 'length'; break; }
        const prefill = `${fence ? `${fence}\n` : ''}${text}`;
        const sent = [...messages, ...(prefill ? [{ role: 'assistant' as const, content: prefill }] : [])];
        const think = continuations === 0 ? options.think : undefined;
        const body: Record<string, any> = { model: this.config.model, messages: sent, max_tokens: Math.min(n + (think ?? 0), m.maxOutput || Infinity), ...this.sampling(m, 'code', temperature), ...this.reasoning(m, think),
          ...(fence && m.params.includes('stop') ? { stop: [closing] } : {}) };
        let judgedAt = 0;
        const prior = text;
        const r = await this.chat(body, 60000 + Number(body.max_tokens) * 120, p => progress({ ...p, text: strip(prior, p.text, run), tokens: generated + p.tokens }),
          (content, tokens) => { if (tokens - judgedAt < 8 || !content.endsWith('\n')) return false; judgedAt = tokens; return repeatCut(strip(prior, content, run), options.around, false) !== null; });
        if (r.reasoning) reasoning += r.reasoning;
        usage = { prompt_tokens: (usage.prompt_tokens ?? 0) + (r.usage?.prompt_tokens ?? 0), completion_tokens: (usage.completion_tokens ?? 0) + (r.usage?.completion_tokens ?? 0), ...(r.usage?.cost !== undefined ? { cost: (usage.cost ?? 0) + r.usage.cost } : {}) };
        if (continuations === 0) this.learn(messages, r.usage);
        generated += Number(r.usage?.completion_tokens ?? 0) || Math.ceil(r.content.length / 3.5);
        let piece = r.content;
        // A continuation that starts the file over: the provider did not take the prefill.
        if (continuations > 0 && (/^\s*`{3,}/.test(piece) || (prior && piece.trimStart().startsWith(prior.trimStart().split('\n')[0]!) && prior.trimStart().split('\n')[0]!.length > 8))) { finish = 'length'; break; }
        if (continuations === 0) piece = piece.replace(/^\s*`{3,}[^\n]*\n/, '');
        // Without a stop sequence the closing fence is found in the text.
        const close = (text + piece).indexOf(closing, Math.max(0, text.length - closing.length));
        text = close >= 0 ? (text + piece).slice(0, close) + '\n' : text + piece;
        const body_ = text;
        const repeat = repeatCut(body_, options.around);
        if (repeat) { cutFrom = body_; text = repeat.kept; cut = repeat.cut; finish = 'repetition'; break; }
        if (close >= 0 || r.finish === 'stop') break;
        if (r.finish !== 'length') { finish = r.finish === 'content_filter' ? 'eos' : 'eos'; break; }
        if (generated >= budget) { finish = 'length'; break; }
        continuations++;
      }
      if (finish === 'length' && fence && !cut && text !== '' && !text.endsWith('\n')) { const c = lineCut(text, text.length, 'budget'); cutFrom = text; text = c.kept; cut = c.cut; }
      const ms = performance.now() - start;
      this.lastMeta = { ms, usage: { prompt_tokens: usage.prompt_tokens ?? count.tokens, completion_tokens: generated }, timings: generated ? { predicted_per_second: generated / (ms / 1000) } : undefined, finishReason: finish, promptTokens: count.tokens, continuations, ...(reasoning ? { reasoning: reasoning.trim() } : {}) };
      if (cut) await this.log(finish === 'repetition' ? 'repetition-cut' : 'budget-cut', { requestId, ...context, kept: text.length, generated: cutFrom.length, cut, discardedTail: cutFrom.slice(-4000) });
      await this.log('bonsai', { requestId, ...context, provider: 'openrouter', model: this.config.model, ms, prompt: count, usage: this.lastMeta.usage, finishReason: finish, continuations, ...(reasoning ? { reasoningChars: reasoning.trim().length } : {}), ...(usage.cost !== undefined ? { cost: usage.cost } : {}) });
      return { text, finish, meta: this.lastMeta, ...(cut ? { cut } : {}) };
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message });
      throw e;
    }
  }
}
// The file text a reply adds to what came before: its first reply without a fence the model wrote again.
const strip = (prior: string, content: string, _run: string): string => prior + (prior ? content : content.replace(/^\s*`{3,}[^\n]*\n/, ''));
// The JSON object a reply holds: the whole reply, or the object inside a code fence or prose around it.
export function parseJson(text: string): unknown {
  const t = text.trim(); try { return JSON.parse(t); } catch { /* look inside */ }
  const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1]; if (fenced) { try { return JSON.parse(fenced); } catch { /* go on */ } }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new Error('Bonsai returned invalid JSON');
}
