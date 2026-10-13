// The model through OpenRouter: the same three calls the llama-server client makes (count a prompt,
// generate a step's reply, generate a file as code), over OpenRouter's OpenAI-compatible chat API.
// What the model takes decides what a request carries (models.ts): sampling parameters it lists,
// reasoning as its efforts and budget allow. A step is the model's own tool calling when it takes tools
// (its text the thought, each call an action; the prompt is in the tools form, Session.form), else one
// JSON reply. A file is the reply's fenced code block. Both stream, so the reasoning and the reply show
// as they are written and a file is judged for loops as it arrives.
// Prompt caching is OpenRouter's, across providers: the prompt's cache points (context.ts) are marked with
// cache_control on their text, the form OpenRouter takes for every provider (Anthropic, Gemini and Qwen read it,
// OpenAI's explicit mode gets it translated; providers that cache on their own cache whatever is marked), and a
// run's requests carry one session_id, so they stay on the provider whose cache holds the prefix. A model is marked
// only when it caches (models.ts, cachesPrompts); a provider that refuses the markers is asked again without them,
// and the run goes on unmarked.
import { randomUUID } from 'node:crypto';
import type { Config, GenerationMeta, JsonSchema, Log, Message } from './types.js';
import { isEventStream, lineCut, post, quietly, repeatCut, streamEvents, type StreamProgress, type TextGeneration, type TextOptions, type GenerationCut } from './clients.js';
import { actions, samplingSchema, validate } from './schema.js';
import { cachesPrompts, describeModel, effortsOf, gatewayEfforts, type ModelInfo } from './models.js';
import { AGENT_SYSTEM, actionTool, agentSystem, cachePoints } from './context.js';

// One tool call of a reply, its arguments as the text the model wrote.
interface Call { id: string; name: string; args: string }
// A reply read from a stream: its text, its tool calls, its reasoning, why it ended, and the usage the last event carries.
interface Reply { content: string; calls: Call[]; reasoning: string; finish?: string; usage?: any; model?: string; aborted?: boolean }
// The tool a model that takes tools but not the tools form replies through for any other JSON reply: its
// parameters are the reply's schema, so the reply comes as the tool's arguments.
const replyTool = 'reply';
// The actions a step's reply schema offers ({thought, actions: [{action, args}]}), or null for any other schema.
function stepActions(schema: JsonSchema): string[] | null {
  const alts = schema.properties?.actions?.items?.anyOf;
  if (!schema.properties?.thought || !Array.isArray(alts)) return null;
  const names = alts.map(a => a.properties?.action?.const).filter((n): n is string => typeof n === 'string');
  return names.length === alts.length ? names : null;
}
const chars = (m: Message): number => m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);

export class OpenRouter {
  lastMeta: GenerationMeta | null = null;
  // Tokens per character of a rendered prompt, from the last reply's usage (OpenRouter has no tokenizer
  // endpoint; the model's own count comes back with each reply).
  private ratio = 1 / 3.5;
  // The run's requests as one session for OpenRouter's provider routing; whether its markers are still sent.
  private readonly session = randomUUID(); private marking = true;
  constructor(readonly config: Config, private key: string, private log: Log) {
    if (!key) throw new Error('OpenRouter needs an API key: set OPENROUTER_API_KEY, or providerKeyFile to a file that holds it.');
  }
  private get url(): string { return `${this.config.openrouterUrl.replace(/\/$/, '')}/chat/completions`; }
  model(): Promise<ModelInfo> { return describeModel(this.config, this.key); }
  // An estimate: characters of the messages times the ratio last measured, plus a few tokens a message
  // for the chat template.
  async count(messages: Message[]): Promise<{ tokens: number; mode: string }> {
    const total = messages.reduce((n, m) => n + chars(m), 0);
    return { tokens: Math.ceil(total * this.ratio) + 6 * messages.length, mode: 'estimate' };
  }
  private learn(messages: Message[], usage: any): void {
    const total = messages.reduce((n, m) => n + chars(m), 0); const tokens = Number(usage?.prompt_tokens);
    if (total > 2000 && Number.isFinite(tokens) && tokens > 0) this.ratio = Math.min(.6, Math.max(.15, (tokens - 6 * messages.length) / total));
  }
  // The reasoning field of a request: the effort when the model takes it, else the budget, else on; off
  // when it can be turned off. Reasoning the model always does is left at its default, and shown.
  private reasoning(m: ModelInfo, budget: number | undefined): Record<string, unknown> {
    const r = m.reasoning; if (!r.supported) return {};
    const efforts = r.efforts ?? gatewayEfforts;
    // A model that always reasons does so at the configured effort when it takes one, else at its own default.
    if (!budget) return r.mandatory ? (efforts.includes(this.config.thinkingEffort) ? { reasoning: { effort: this.config.thinkingEffort } } : {}) : { reasoning: effortsOf(r).includes('none') && r.efforts !== null ? { effort: 'none' } : { enabled: false } };
    if (efforts.includes(this.config.thinkingEffort)) return { reasoning: { effort: this.config.thinkingEffort } };
    if (r.budget) return { reasoning: { max_tokens: budget } };
    return { reasoning: { enabled: true } };
  }
  // The messages as this model gets them: the agent's system message without Bonsai's name, and, when
  // the reply's schema is enforced neither by the provider nor through a tool, the schema stated there.
  private messages(messages: Message[], schema?: JsonSchema): Message[] {
    return messages.map((m, i) => {
      if (m.role !== 'system' || i !== 0) return m;
      const content = m.content === AGENT_SYSTEM ? agentSystem() : m.content;
      return { ...m, content: schema ? `${content}\n\nReply with one JSON object and nothing else, valid under this JSON schema:\n${JSON.stringify(schema)}` : content };
    });
  }
  private sampling(m: ModelInfo, kind: 'step' | 'code', temperature: number): Record<string, unknown> {
    const has = (p: string) => m.params.includes(p); const c = this.config;
    return { ...(has('temperature') ? { temperature } : {}),
      ...(has('top_p') ? { top_p: kind === 'step' ? c.stepTopP : c.codeTopP } : {}), ...(has('top_k') ? { top_k: kind === 'step' ? c.stepTopK : c.codeTopK } : {}),
      ...(has('min_p') ? { min_p: kind === 'step' ? c.stepMinP : c.codeMinP } : {}), ...(kind === 'code' && has('presence_penalty') && c.codePresencePenalty > 0 ? { presence_penalty: c.codePresencePenalty } : {}) };
  }
  // One streamed chat completion: text, tool calls and reasoning as they come (OpenRouter sends reasoning as
  // delta.reasoning and as reasoning_details of type reasoning.text or reasoning.summary; a call's arguments
  // in pieces by its index), the finish reason, and the usage of the last event. show makes the text progress
  // reports of them. judge, when given, sees the text so far and stops the request when it says so (the
  // connection is closed; OpenRouter cancels the generation at providers that support it).
  private async chat(body: Record<string, unknown>, timeoutMs: number, progress: (p: StreamProgress) => void, judge?: (content: string, tokens: number) => boolean, show: (content: string, calls: Call[]) => string = (c, calls) => calls[0]?.args || c): Promise<Reply> {
    const abort = new AbortController();
    const response = await post(this.url, { ...body, stream: true, usage: { include: true } }, this.key, timeoutMs, 2, abort.signal);
    if (!isEventStream(response)) {
      const r = await response.json(); const c = r.choices?.[0];
      if (r.error) throw new Error(`OpenRouter: ${String(r.error.message ?? r.error.code ?? 'error').slice(0, 200)}`);
      const calls = (Array.isArray(c?.message?.tool_calls) ? c.message.tool_calls : []).map((t: any, i: number) => ({ id: String(t?.id ?? `call_${i}`), name: String(t?.function?.name ?? ''), args: String(t?.function?.arguments ?? '') }));
      return { content: String(c?.message?.content ?? ''), calls, reasoning: String(c?.message?.reasoning ?? ''), finish: c?.finish_reason, usage: r.usage, model: r.model };
    }
    let content = ''; const calls: Call[] = []; let reasoning = ''; let finish: string | undefined; let usage: any; let model: string | undefined; let tokens = 0;
    for await (const e of streamEvents(response, this.url, abort, 120000, 120000)) {
      model ??= e.model; if (e.usage) usage = e.usage;
      for (const c of e.choices ?? []) {
        if (c.finish_reason === 'error') throw new Error(`OpenRouter: the provider failed mid-stream${e.error?.message ? ` (${String(e.error.message).slice(0, 200)})` : ''}`);
        if (c.finish_reason) finish = c.finish_reason;
        const d = c.delta ?? {};
        const said = typeof d.reasoning === 'string' ? d.reasoning : Array.isArray(d.reasoning_details) ? d.reasoning_details.map((x: any) => x?.text ?? x?.summary ?? '').join('') : '';
        if (said) { reasoning += said; progress({ text: show(content, calls), tokens: ++tokens, reasoning }); }
        if (typeof d.content === 'string' && d.content) {
          content += d.content; progress({ text: show(content, calls), tokens: ++tokens, ...(reasoning ? { reasoning } : {}) });
          if (judge?.(content, tokens)) { abort.abort(); return { content, calls, reasoning, finish: 'length', usage, model, aborted: true }; }
        }
        for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
          // A piece names its call by index; one without an index belongs to the last call (or starts the first).
          const i = Number.isInteger(t?.index) ? t.index : Math.max(0, calls.length - 1);
          const call = calls[i] ??= { id: '', name: '', args: '' };
          if (t?.id) call.id = String(t.id); if (t?.function?.name) call.name += String(t.function.name); if (t?.function?.arguments) call.args += String(t.function.arguments);
          progress({ text: show(content, calls), tokens: ++tokens, ...(reasoning ? { reasoning } : {}) });
        }
      }
    }
    return { content, calls: calls.filter(Boolean), reasoning, finish, usage, model };
  }
  // The messages with their cache points marked, when the model caches and marking is on: the point's text as one
  // content part carrying cache_control. extra is appended after them, unmarked (a continuation).
  private cacheable(m: ModelInfo, original: Message[], messages: Message[], extra: Message[] = []): { messages: unknown[]; marked: boolean } {
    const points = this.config.promptCache === 'auto' && this.marking && cachesPrompts(m) ? new Set(cachePoints(original)) : new Set<number>();
    const out = messages.map((x, i) => points.has(i) && x.content ? { ...x, content: [{ type: 'text', text: x.content, cache_control: { type: 'ephemeral' } }] } : x);
    return { messages: [...out, ...extra], marked: points.size > 0 };
  }
  private routing(): Record<string, unknown> { return this.config.promptCache === 'auto' ? { session_id: this.session } : {}; }
  // A request whose markers a provider refused (HTTP 400) is sent again without them, and marking stops for the run.
  private async unmarkedOnRefusal<T>(marked: boolean, send: (unmarked: boolean) => Promise<T>, context?: { step: number; route: string }): Promise<T> {
    try { return await send(false); } catch (e) {
      if (!marked || !/^HTTP 400\b/.test((e as Error).message)) throw e;
      this.marking = false; await this.log('cache-markers-off', { ...context, model: this.config.model, error: (e as Error).message });
      return send(true);
    }
  }
  private budgetCheck(count: { tokens: number }, maxTokens: number, m: ModelInfo): void {
    if (count.tokens > this.config.workingTokens || count.tokens + maxTokens + this.config.safetyTokens > (m.contextLength || this.config.contextWindow))
      throw new Error('Prompt exceeds budget; generation refused');
  }
  private async logged(requestId: string, context: { step: number; route: string } | undefined, ms: number, count: { tokens: number; mode: string }, r: Reply): Promise<void> {
    await this.log('bonsai', { requestId, ...context, provider: 'openrouter', model: r.model ?? this.config.model, ms, prompt: count, usage: r.usage, finishReason: r.finish, ...(r.reasoning ? { reasoningChars: r.reasoning.trim().length } : {}), ...(r.usage?.cost !== undefined ? { cost: r.usage.cost } : {}) });
  }

  // A step's reply. Under the tools form (a model that takes tools) a step is the model's own tool calling: each
  // action of the step is a tool, with its description, instructions and schema; the reply's text is the thought
  // and its calls, in order, are the actions. A call's arguments are not judged here: the agent refuses a bad call
  // alone (argsProblem), or one whose arguments are not JSON by the problem given with it. A model that reasons
  // may refuse a required tool call (Anthropic's do), so it chooses; a reply that calls none acts on nothing.
  // Any other reply is JSON under schema: enforced by a model that enforces a JSON schema (and only providers
  // that do are asked); through the reply tool for one that takes tools; else stated in its system message. That
  // reply is read from the tool's arguments, else from the text (a model may answer in text).
  async generate(messages: Message[], schema: JsonSchema, temperature = this.config.stepTemperature, context?: { step: number; route: string }, maxTokens = this.config.maxTokens, progress?: (p: StreamProgress) => void, thinking?: number): Promise<Record<string, any>> {
    const m = await this.model(); const count = await this.count(messages); this.budgetCheck(count, maxTokens, m);
    const requestId = randomUUID(); const start = performance.now();
    const reasons = Boolean(thinking) || m.reasoning.mandatory;
    const step = stepActions(schema);
    const via = step && this.config.promptForm === 'tools' && m.params.includes('tools') ? 'native' : m.structured ? 'schema' : m.params.includes('tools') ? 'tool' : 'prompt';
    const choose = (forced: unknown) => m.params.includes('tool_choice') ? { tool_choice: reasons ? 'auto' : forced } : {};
    const prepared = this.messages(messages, via === 'prompt' ? schema : undefined); const cached = this.cacheable(m, messages, prepared);
    const body: Record<string, any> = { model: this.config.model, messages: cached.messages, ...this.routing(),
      // Reasoning counts against max_tokens: a model that reasons gets its budget on top of the reply's. A native step
      // writes files in its calls, so it has a file's budget (createTokens) on top as well.
      max_tokens: Math.min(maxTokens + (via === 'native' ? this.config.createTokens : 0) + (reasons ? thinking ?? this.config.stepThinkingBudget : 0), m.maxOutput || Infinity), ...this.sampling(m, 'step', temperature), ...this.reasoning(m, thinking),
      ...(via === 'native' ? { tools: step!.map(actionTool), ...choose('required') }
        : via === 'schema' ? { response_format: { type: 'json_schema', json_schema: { name: 'arguments', strict: true, schema: samplingSchema(schema) } }, provider: { require_parameters: true } }
        : via === 'tool' ? { tools: [{ type: 'function', function: { name: replyTool, description: 'Your reply: every reply is this one call, its arguments the whole reply.', parameters: schema } }], ...choose({ type: 'function', function: { name: replyTool } }) }
        : m.params.includes('response_format') ? { response_format: { type: 'json_object' } } : {}) };
    await this.log('bonsai-request', { requestId, ...context, provider: 'openrouter', model: this.config.model, prompt: count, temperature, maxTokens: body.max_tokens, ...(body.reasoning ? { reasoning: body.reasoning } : {}), structured: m.structured, via, cacheMarked: cached.marked });
    let reply = '';
    // As it streams, a native step is shown as the step reply it becomes, so its thought and actions show as they are written.
    const asStep = (content: string, calls: Call[]) => !content.trim() && !calls.length ? '' : `{"thought":${JSON.stringify(content.trim())},"actions":[${calls.map(c => `{"action":${JSON.stringify(c.name)},"args":${c.args || '{'}`).join('},')}`;
    try {
      const r = await this.unmarkedOnRefusal(cached.marked, unmarked => this.chat(unmarked ? { ...body, messages: prepared } : body, 60000 + Number(body.max_tokens) * 120, quietly(progress), undefined, via === 'native' ? asStep : undefined), context);
      reply = via === 'native' ? [r.content, ...r.calls.map(c => `${c.name}(${c.args})`)].filter(Boolean).join('\n') : r.calls[0]?.args || r.content;
      this.learn(messages, r.usage);
      const ms = performance.now() - start;
      this.lastMeta = { ms, usage: r.usage, timings: r.usage?.completion_tokens ? { predicted_per_second: r.usage.completion_tokens / (ms / 1000) } : undefined, finishReason: r.finish, promptTokens: count.tokens, ...(r.reasoning ? { reasoning: r.reasoning.trim() } : {}) };
      await this.logged(requestId, context, ms, count, r);
      // A tool call ends as tool_calls (or stop, by some providers).
      // A native step cut by its limit keeps the calls it finished; the one it was writing is not run.
      const cut = via === 'native' && r.finish === 'length' && r.calls.length > 0;
      if (r.finish !== 'stop' && r.finish !== 'tool_calls' && r.finish !== undefined && !cut) throw new Error(`The model did not finish a JSON argument object (${r.finish})`);
      if (via === 'native') {
        if (!r.calls.length) throw new Error(r.content.trim() ? `The reply called no tool, so nothing ran; a step acts by calling the tools. It said: ${JSON.stringify(r.content.trim().slice(0, 200))}` : 'The reply was empty: no text and no tool call');
        const most = schema.properties!.actions!.maxItems ?? 8;
        if (r.calls.length > most) await this.log('calls-dropped', { requestId, ...context, calls: r.calls.length, kept: most, dropped: r.calls.slice(most).map(c => c.name) });
        return { thought: r.content.trim(), actions: r.calls.slice(0, most).map(c => {
          let args: unknown; try { args = c.args.trim() ? JSON.parse(c.args) : {}; } catch { return { action: c.name, args: {}, problem: cut && c === r.calls.at(-1) ? `the reply reached its ${body.max_tokens}-token output limit inside this ${c.name} call (${c.args.length} characters of arguments), so it was cut off and not run; a large file goes in a call of its own, or in blocks (rewrite_file with start and end)` : `the arguments of the ${c.name} call are not JSON: ${JSON.stringify(c.args.slice(0, 160))}` }; }
          return args && typeof args === 'object' && !Array.isArray(args) ? { action: c.name, args } : { action: c.name, args: {}, problem: `the arguments of the ${c.name} call are not an object` };
        }) };
      }
      const args = parseJson(reply);
      try { validate(schema, args); } catch (e) { throw new Error(`The reply does not match the reply schema (${(e as Error).message}): ${shape(args)}; the schema requires ${(schema.required ?? []).join(', ')}`); }
      return args as Record<string, any>;
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message, ...(reply ? { reply: clipReply(reply) } : {}) });
      throw e;
    }
  }

  // A file as code: the request's last message asks for it as the reply's one fenced code block, and the code is
  // that block's lines (no reply is pre-filled: a model that reasons, or a provider, may not take one). A reply
  // with no code block writes nothing. Under the tools form the tools are sent as the transcript holds calls of
  // them, and none may be called. A reply cut by its output limit is continued: the reply so far is sent back,
  // up to its last whole line, and the model is asked for the rest; a continuation that starts the file over
  // ends the file there as at its budget. Loops and a region's echo are judged as the code arrives, as for
  // llama-server (repeatCut).
  async generateText(messages: Message[], options: TextOptions = {}): Promise<TextGeneration> {
    const m = await this.model(); const budget = options.budgetTokens ?? this.config.createTokens; const temperature = options.temperature ?? this.config.codeTemperature;
    const context = options.context; const progress = quietly(options.progress);
    const requestId = randomUUID(); const start = performance.now(); const count = await this.count(messages);
    const transcript = messages.some(x => x.tool_calls?.length) && m.params.includes('tools');
    const tools = transcript ? { tools: actions.map(actionTool), ...(m.params.includes('tool_choice') ? { tool_choice: 'none' } : {}) } : {};
    await this.log('bonsai-request', { requestId, ...context, provider: 'openrouter', model: this.config.model, prompt: count, temperature, budgetTokens: budget, ...(options.think ? { thinking: options.think } : {}) });
    let text = ''; let opening = '```'; let generated = 0; let continuations = 0; let finish: TextGeneration['finish'] = 'stop'; let cut: GenerationCut | undefined; let cutFrom = ''; let reasoning = ''; let usage: any = {}; let last = '';
    try {
      while (true) {
        const n = Math.min(budget - generated, m.maxOutput || budget); if (n <= 0) { finish = 'length'; break; }
        // A continuation goes on after the last whole line written.
        const lastLine = text.replace(/\n$/, '').split('\n').at(-1) ?? '';
        const extra: Message[] = continuations === 0 ? [] : [{ role: 'assistant' as const, content: `${opening}\n${text}` },
          { role: 'user' as const, content: `Your reply stopped at the output limit. Reply with the rest of the code as one fenced code block: it goes on right after the line ${JSON.stringify(lastLine)}, without repeating anything written so far.` }];
        const prepared = this.messages(messages); const cached = this.cacheable(m, messages, prepared, extra);
        const think = continuations === 0 ? options.think : undefined;
        const body: Record<string, any> = { model: this.config.model, messages: cached.messages, ...this.routing(), max_tokens: Math.min(n + (think ?? 0), m.maxOutput || Infinity), ...this.sampling(m, 'code', temperature), ...this.reasoning(m, think), ...tools };
        let judgedAt = 0; const prior = text;
        const r = await this.unmarkedOnRefusal(cached.marked, unmarked => this.chat(unmarked ? { ...body, messages: [...prepared, ...extra] } : body, 60000 + Number(body.max_tokens) * 120, p => progress({ ...p, text: prior + codeOf(p.text).code, tokens: generated + p.tokens }),
          (content, tokens) => { if (tokens - judgedAt < 8 || !content.endsWith('\n')) return false; judgedAt = tokens; return repeatCut(prior + codeOf(content).code, options.around, false) !== null; }, c => c), context);
        last = r.content;
        if (r.reasoning) reasoning += r.reasoning;
        usage = { prompt_tokens: (usage.prompt_tokens ?? 0) + (r.usage?.prompt_tokens ?? 0), completion_tokens: (usage.completion_tokens ?? 0) + (r.usage?.completion_tokens ?? 0), ...(r.usage?.cost !== undefined ? { cost: (usage.cost ?? 0) + r.usage.cost } : {}),
          prompt_tokens_details: { cached_tokens: (usage.prompt_tokens_details?.cached_tokens ?? 0) + (r.usage?.prompt_tokens_details?.cached_tokens ?? 0), cache_write_tokens: (usage.prompt_tokens_details?.cache_write_tokens ?? 0) + (r.usage?.prompt_tokens_details?.cache_write_tokens ?? 0) } };
        if (continuations === 0) this.learn(messages, r.usage);
        generated += Number(r.usage?.completion_tokens ?? 0) || Math.ceil(r.content.length / 3.5);
        const block = codeOf(r.content);
        if (!block.opened) {
          if (continuations === 0 && !r.aborted) throw new Error(r.calls.length ? `The reply called ${r.calls.map(c => c.name).join(', ')} instead of writing the code, so nothing was written` : r.content.trim() ? `The reply holds no fenced code block, so nothing was written; it begins: ${JSON.stringify(r.content.trim().slice(0, 160))}` : 'The reply was empty, so nothing was written');
          if (continuations > 0) { finish = 'length'; break; }
        }
        if (continuations === 0) opening = block.fence;
        let piece = block.code;
        if (continuations > 0) {
          // The line it went on after, written again, is dropped; a continuation that starts the file over ends it.
          const first = (t: string) => t.split('\n').find(l => l.trim())?.trim() ?? '';
          if (first(piece) && first(piece) === first(prior) && first(prior).length > 8) { finish = 'length'; break; }
          if (lastLine.trim() && piece.split('\n')[0]!.trim() === lastLine.trim()) piece = piece.slice(piece.indexOf('\n') + 1);
        }
        text = prior + piece;
        const repeat = repeatCut(text, options.around);
        if (repeat) { cutFrom = text; text = repeat.kept; cut = repeat.cut; finish = 'repetition'; break; }
        if (block.closed || r.finish === 'stop' || r.finish === 'tool_calls') { if (text && !text.endsWith('\n')) text += '\n'; break; }
        if (r.finish !== 'length') { finish = 'eos'; break; }
        if (generated >= budget) { finish = 'length'; break; }
        // Continued after the last whole line.
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        continuations++;
      }
      if (finish === 'length' && !cut && text !== '' && !text.endsWith('\n')) { const c = lineCut(text, text.length, 'budget'); cutFrom = text; text = c.kept; cut = c.cut; }
      const ms = performance.now() - start;
      this.lastMeta = { ms, usage: { prompt_tokens: usage.prompt_tokens ?? count.tokens, completion_tokens: generated, prompt_tokens_details: usage.prompt_tokens_details }, timings: generated ? { predicted_per_second: generated / (ms / 1000) } : undefined, finishReason: finish, promptTokens: count.tokens, continuations, ...(reasoning ? { reasoning: reasoning.trim() } : {}) };
      if (cut) await this.log(finish === 'repetition' ? 'repetition-cut' : 'budget-cut', { requestId, ...context, kept: text.length, generated: cutFrom.length, cut, discardedTail: cutFrom.slice(-4000) });
      await this.log('bonsai', { requestId, ...context, provider: 'openrouter', model: this.config.model, ms, prompt: count, usage: this.lastMeta.usage, finishReason: finish, continuations, ...(reasoning ? { reasoningChars: reasoning.trim().length } : {}), ...(usage.cost !== undefined ? { cost: usage.cost } : {}) });
      return { text, finish, meta: this.lastMeta, ...(cut ? { cut } : {}) };
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message, ...(last ? { reply: clipReply(last) } : {}) });
      throw e;
    }
  }
}
const clipReply = (reply: string): string => reply.length > 4000 ? `${reply.slice(0, 2000)}\n…\n${reply.slice(-2000)}` : reply;
// The code of a reply: the lines of its first fenced code block (opened by a line of three or more backticks or
// tildes, closed by a line of at least as many of the same), its opening line, and whether it was opened and closed.
export function codeOf(text: string): { code: string; fence: string; opened: boolean; closed: boolean } {
  const lines = text.split('\n');
  const open = lines.findIndex(l => /^ {0,3}(`{3,}[^`]*|~{3,}.*)$/.test(l.trimEnd()));
  if (open < 0) return { code: '', fence: '```', opened: false, closed: false };
  const run = lines[open]!.trim().match(/^(`+|~+)/)![1]!;
  const close = new RegExp(`^ {0,3}${run[0] === '`' ? '`' : '~'}{${run.length},}\\s*$`);
  const end = lines.findIndex((l, i) => i > open && close.test(l));
  const body = lines.slice(open + 1, end < 0 ? undefined : end);
  return { code: end >= 0 ? (body.length ? `${body.join('\n')}\n` : '') : body.join('\n'), fence: lines[open]!.trim(), opened: true, closed: end >= 0 };
}
// The JSON object a reply holds: the whole reply, or the object inside a code fence or prose around it.
export function parseJson(text: string): unknown {
  const t = text.trim(); try { return JSON.parse(t); } catch { /* look inside */ }
  const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1]; if (fenced) { try { return JSON.parse(fenced); } catch { /* go on */ } }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new Error(t ? `The reply is not one JSON object; it begins: ${JSON.stringify(t.slice(0, 160))}` : 'The reply was empty');
}
// What a reply that missed the schema holds, so the model sees what it wrote: its keys, or its type.
function shape(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `it is ${Array.isArray(v) ? 'an array' : typeof v}`;
  return `it has ${Object.keys(v).length ? `the keys ${Object.keys(v).join(', ')}` : 'no keys'}`;
}
