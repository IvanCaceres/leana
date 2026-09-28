import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { Answers, Config, GenerationMeta, JsonSchema, Log, Message, Questions } from './types.js';
import { samplingSchema, validate } from './schema.js';

export async function postJson(url: string, body: unknown, key: string, timeoutMs = 30000, retries = 2): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response.json();
    await response.body?.cancel();
    if (attempt < retries && [429, 500, 502, 503, 504, 529].includes(response.status)) {
      const header = response.headers.get('retry-after');
      const delay = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 250 * 2 ** attempt;
      await sleep(Math.min(10000, Math.max(100, Number.isFinite(delay) ? delay : 500)));
      continue;
    }
    // Do not echo server bodies, which can include prompts or credentials.
    throw new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
  }
}
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function validateAnswers(questions: Questions, raw: unknown): Answers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Jev: missing answers');
  const answers = raw as Answers;
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type) throw new Error(`Jev: mismatched answer ${id}`);
    if (a.type === 'noul') {
      if (!probability(a.noul)) throw new Error(`Jev: invalid Noul ${id}`);
    } else if (q.type === 'choice') {
      if (!Object.hasOwn(q.criteria, a.choice) || !probability(a.confidence) || !a.probabilities || typeof a.probabilities !== 'object')
        throw new Error(`Jev: invalid Choice ${id}`);
      const options = Object.keys(q.criteria);
      if (Object.keys(a.probabilities).length !== options.length || options.some(k => !probability(a.probabilities[k])))
        throw new Error(`Jev: invalid distribution ${id}`);
      if (Math.abs(Object.values(a.probabilities).reduce((s, p) => s + p, 0) - 1) > .02)
        throw new Error(`Jev: distribution does not sum to one: ${id}`);
      // Routing acts on the distribution; a choice field that disagrees with it
      // is reconciled to the argmax rather than failing the whole step.
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
      if (a.probabilities[top]! > a.probabilities[a.choice]! + 1e-6) a.choice = top;
    }
  }
  return answers;
}
export class Jev {
  constructor(readonly config: Config, private key: string, private log: Log) {
    if (!key) throw new Error('Set TYPESAFE_API_KEY in the environment (or use --env-file PATH).');
  }
  async decide(state: unknown, questions: Questions, context?: { step: number; phase: string }): Promise<Answers> {
    const body = { model: this.config.jevModel, state, questions };
    // Conservative UTF-8 byte caps, not characters/4; bound the hosted model request too.
    if (Buffer.byteLength(JSON.stringify(state)) > 22000 || Buffer.byteLength(JSON.stringify(body)) > 50000)
      throw new Error('Jev decision state exceeds its configured byte budget');
    const requestId = randomUUID();
    await this.log('jev-request', { requestId, ...context, model: body.model, state, questions });
    const start = performance.now();
    try {
      const result = await postJson(this.config.jevUrl, body, this.key, 15000);
      let answers: Answers;
      try { answers = validateAnswers(questions, result.answers); }
      catch (e) { await this.log('jev-invalid', { requestId, ...context, answers: result.answers }); throw e; }
      await this.log('jev', { requestId, ...context, ms: performance.now() - start, model: result.model, answers, usage: result.usage });
      return answers;
    } catch (e) {
      await this.log('jev-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message });
      throw e;
    }
  }
}
export interface TextGeneration { text: string; finish: 'stop' | 'length' | 'repetition' | 'eos'; meta: GenerationMeta; cut?: GenerationCut }
export interface TextOptions { budgetTokens?: number; temperature?: number; context?: { step: number; route: string }; fence?: string | null; thinking?: boolean; thinkingBudget?: number }
// Sampling for code. The server's defaults (top_k 20, top_p 0.95) stay; the DRY
// sampler penalises the verbatim repetition a 1-bit model falls into without
// penalising the legitimate repeats code is made of.
// No repetition penalty: code repeats itself legitimately (similar blocks, a
// rewrite that keeps most of a file), and a penalty on repeating pushes the model
// to end the generation mid-line. A loop is caught by repetitionStart instead.
export const codeSampling = { top_k: 20, top_p: .9 };
// A generation that has started repeating itself: the same block of three or
// more lines three times in a row in the recent tail, or one line six times in
// a row. Only back-to-back repetition counts: a line that recurs across a file
// (a closing tag, a brace, a return) is how code is made. Returns the line
// index at which the first repeat begins, or -1.
export function repetitionStart(text: string, tail = 80): number {
  const lines = text.split('\n'); const from = Math.max(0, lines.length - tail);
  for (let i = from, run = 1; i < lines.length; i++) {
    const l = lines[i]!.trim(); run = i > from && l.length >= 3 && l === lines[i - 1]!.trim() ? run + 1 : 1;
    if (run >= 6) return i - run + 2;
  }
  for (let size = 3; size <= 8; size++) {
    const seen = new Map<string, number>();
    for (let i = from; i + size <= lines.length; i++) {
      const w = lines.slice(i, i + size).map(l => l.trim()).join('\n');
      if (w.replace(/[\s{}()[\];,]/g, '').length < 24) continue;
      const first = seen.get(w);
      if (first !== undefined) { let n = 2; for (let j = i + size; j + size <= lines.length; j += size) { if (lines.slice(j, j + size).map(l => l.trim()).join('\n') === w) n++; else break; } if (n >= 3) return i; }
      else seen.set(w, i);
    }
  }
  return -1;
}
// A generation caught in a loop inside one line (a path, a data array, a
// string that never closes): the tail is one short unit over and over. Real
// content does not repeat a unit of 4..200 characters verbatim for 800
// characters. Returns where the repeating run starts and the unit, or null.
export function periodic(text: string, span = 800): { start: number; unit: number } | null {
  if (text.length < span) return null;
  const end = text.length;
  for (let p = 4; p <= 200; p++) {
    let i = end - 1; while (i - p >= 0 && text[i] === text[i - p]) i--;
    const run = end - 1 - i; // characters equal to the character p before them
    if (run + p >= span && (run + p) / p >= 8) return { start: i + 1, unit: p };
  }
  return null;
}
export function periodicStart(text: string, span = 800): number { return periodic(text, span)?.start ?? -1; }
// A loop inside one line with a longer unit: the recorded in-line loops (an SVG
// path, a number array) drift for a few hundred characters, then repeat one unit
// of 19 to 1,875 characters verbatim until the budget. The current line ends in
// two or more verbatim copies of a unit of up to maxPeriod characters, covering
// span characters. Measured on the recorded loops and 46,000 real long lines
// (source maps, bundles, data, icon paths, generated code): it catches every
// recorded in-line loop, and fires on fewer real lines than the deflate-ratio
// check it replaced; it does cut a real line whose unit of 201..2000 characters
// repeats verbatim over 3,000 characters (a synthesized tone as a one-line data
// URI, one paragraph pasted eight times). Returns where the line starts and the
// unit, or null.
export function cyclingLine(text: string, maxPeriod = 2000, span = 3000): { start: number; unit: number } | null {
  const start = text.lastIndexOf('\n') + 1; const end = text.length;
  if (end - start < span) return null;
  for (let p = 4; p <= maxPeriod && 2 * p <= end - start; p++) {
    let i = end - 1; while (i - p >= start && text.charCodeAt(i) === text.charCodeAt(i - p)) i--;
    const run = end - 1 - i; // characters equal to the character p before them
    if (run >= p && run + p >= span) return { start, unit: p };
  }
  return null;
}
// Where a generation was stopped inside a line, and what that line was: the
// cut is always at the start of the line, so an unfinished or looping line
// never reaches the file (a rewrite would show it as current content, and the
// model copies it back into the same loop).
// opening is the line without its indentation, at most 60 characters (truncated
// when there is more); kind 'lines' is a repeat of whole lines, 'cycle' one inside
// a single line, 'budget' an unfinished line at the token budget.
export interface GenerationCut { kind: 'cycle' | 'lines' | 'budget'; line: number; opening: string; truncated?: true; lineChars: number; unit?: number }
export function lineCut(body: string, at: number, kind: GenerationCut['kind'], unit?: number): { kept: string; cut: GenerationCut } {
  const ls = body.lastIndexOf('\n', at - 1) + 1; const le = body.indexOf('\n', ls);
  const line = body.slice(ls, le < 0 ? body.length : le); const trimmed = line.trimStart();
  return { kept: body.slice(0, ls), cut: { kind, line: body.slice(0, ls).split('\n').length, opening: trimmed.slice(0, 60), ...(trimmed.length > 60 ? { truncated: true as const } : {}), lineChars: line.length, ...(unit ? { unit } : {}) } };
}
// How long one generation request may take: a minute of slack, the prompt to
// process when it is not cached (the first chunk; a cold 30k-token prompt takes
// ~90 s at ~350 tok/s, so it is allowed at 150 tok/s), and the tokens to generate
// at half the observed speed, that speed capped so a burst of accepted drafts
// never shrinks the allowance.
export function requestTimeoutMs(promptTokens: number, generate: number, tokensPerSecond: number): number {
  const decode = Math.max(4, Math.min(tokensPerSecond, 60) * .5);
  return 60000 + Math.ceil(promptTokens / 150) * 1000 + Math.ceil(generate / decode) * 1000;
}
export class Bonsai {
  // Timing and usage of the latest generation, for live progress and reports.
  lastMeta: GenerationMeta | null = null;
  // The generation speed last observed, for request timeouts that fit the model.
  private tokensPerSecond = 20;
  constructor(readonly config: Config, private key: string, private log: Log) {}
  private get root(): string { return this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, ''); }
  // The prompt exactly as the server's chat template renders it, ending with the
  // assistant prefix, so a raw completion can continue it.
  private async render(messages: Message[], thinking = false): Promise<string> {
    const applied = await postJson(`${this.root}/apply-template`, {
      messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: thinking },
    }, this.key, 10000, 0);
    if (typeof applied.prompt !== 'string') throw new Error('Missing rendered prompt');
    return applied.prompt;
  }
  private async tokenize(text: string): Promise<number[]> {
    const result = await postJson(`${this.root}/tokenize`, { content: text, add_special: true }, this.key, 10000, 0);
    if (!Array.isArray(result.tokens)) throw new Error('Missing tokens');
    return result.tokens as number[];
  }
  private async detokenize(tokens: number[]): Promise<string> {
    const result = await postJson(`${this.root}/detokenize`, { tokens }, this.key, 10000, 0);
    if (typeof result.content !== 'string') throw new Error('Missing detokenized content');
    return result.content;
  }
  async count(messages: Message[]): Promise<{ tokens: number; mode: string }> {
    try {
      return { tokens: (await this.tokenize(await this.render(messages))).length, mode: 'llama-tokenizer' };
    } catch {
      // Conservative fallback for byte-level tokenizers; safetyTokens reserves template overhead.
      return { tokens: Buffer.byteLength(JSON.stringify(messages)), mode: 'utf8-byte-upper-bound' };
    }
  }
  // A structured, grammar-constrained generation: short arguments and designs.
  // maxTokens raises the output budget for the few generations that need it.
  async generate(messages: Message[], schema: JsonSchema, temperature = this.config.stepTemperature, context?: { step: number; route: string }, maxTokens = this.config.maxTokens): Promise<Record<string, any>> {
    const count = await this.count(messages);
    if (count.tokens > this.config.workingTokens || count.tokens + maxTokens + this.config.safetyTokens > this.config.contextWindow)
      throw new Error('Prompt exceeds budget; generation refused');
    const requestId = randomUUID();
    await this.log('bonsai-request', { requestId, ...context, prompt: count, temperature, minP: this.config.stepMinP, maxTokens });
    const start = performance.now();
    try {
    const result = await postJson(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      model: this.config.model, messages, temperature, min_p: this.config.stepMinP, max_tokens: maxTokens,
      stream: false, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'arguments', strict: true, schema: samplingSchema(schema) } },
    }, this.key, 60000 + maxTokens * 60, 0);
    const choice = result.choices?.[0];
    this.lastMeta = { ms: performance.now() - start, usage: result.usage, timings: result.timings, finishReason: choice?.finish_reason, promptTokens: count.tokens };
    await this.log('bonsai', { requestId, ...context, model: result.model, ms: this.lastMeta.ms, prompt: count, usage: result.usage, timings: result.timings, finishReason: choice?.finish_reason });
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
      throw new Error(`Bonsai did not finish a JSON argument object (${choice?.finish_reason ?? 'missing choice'})`);
    let args: unknown;
    try { args = JSON.parse(choice.message.content); } catch { throw new Error('Bonsai returned invalid JSON'); }
    validate(schema, args);
    return args as Record<string, any>;
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message });
      throw e;
    }
  }
  // Code is generated as code: a raw completion of the rendered chat prompt, no
  // JSON envelope, no grammar. The opening fence is part of the prompt and the
  // closing fence is the stop word, so the content is the code itself. When a
  // request stops at the chunk size, generation resumes from the same token
  // ids (never a re-tokenized string: this hybrid model can only reuse its
  // cache from a checkpoint on an identical prefix), until the model stops,
  // budgetTokens is spent, or the text has started repeating itself, the one
  // case where continuing would only produce more of the same.
  // With thinking, the model reasons first; a thought that outruns its budget
  // is closed by the harness so the answer still comes.
  async generateText(messages: Message[], options: TextOptions = {}): Promise<TextGeneration> {
    const budget = options.budgetTokens ?? this.config.createTokens; const temperature = options.temperature ?? this.config.codeTemperature; const context = options.context;
    const thinking = options.thinking ?? false; const thinkingBudget = options.thinkingBudget ?? 2048;
    const fence = options.fence === undefined ? '```' : options.fence;
    const requestId = randomUUID();
    const start = performance.now();
    let prompt: number[]; let promptTokens: number;
    try { prompt = await this.tokenize(await this.render(messages, thinking) + (fence && !thinking ? `${fence}\n` : '')); promptTokens = prompt.length; }
    catch (e) { await this.log('bonsai-error', { requestId, ...context, ms: 0, error: `render: ${(e as Error).message}` }); throw new Error(`The server could not render the prompt: ${(e as Error).message}`); }
    if (promptTokens > this.config.workingTokens || promptTokens + Math.min(budget, this.config.maxTokens) + this.config.safetyTokens > this.config.contextWindow)
      throw new Error('Prompt exceeds budget; generation refused');
    await this.log('bonsai-request', { requestId, ...context, prompt: { tokens: promptTokens, mode: 'llama-tokenizer' }, temperature, minP: this.config.codeMinP, budgetTokens: budget, raw: true, thinking });
    // Chunks are where a loop is checked for; a continuation reuses the cached ids, so a small one costs little.
    const chunk = Math.min(this.config.maxTokens, 1024);
    let cutFrom = ''; let text = ''; let generated = 0; let continuations = 0; let finish: TextGeneration['finish'] = 'stop'; let timings: any; let broken = false; let thoughtClosed = !thinking; let stoppingWord = ''; let cut: GenerationCut | undefined; let lastStop = ''; let lastIds: number[] = []; let lastContent = '';
    // The closing fence is the backtick run alone, whatever language opened it.
    const stopWords = fence ? [`\n${fence.match(/^`+/)?.[0] ?? '```'}`] : [];
    try {
      while (true) {
        const room = this.config.contextWindow - this.config.safetyTokens - promptTokens;
        const n = Math.min(chunk, budget - generated, room - generated);
        if (n <= 0) { finish = 'length'; break; }
        const timeout = requestTimeoutMs(continuations === 0 ? promptTokens : 0, n, this.tokensPerSecond);
        const r = await postJson(`${this.root}/completion`, { prompt, n_predict: n, temperature, ...codeSampling, min_p: this.config.codeMinP, cache_prompt: true, return_tokens: true, stream: false, ...(thoughtClosed ? { stop: stopWords } : {}) }, this.key, timeout, 0);
        if (typeof r.content !== 'string') throw new Error('Bonsai returned no content');
        const ids: number[] = Array.isArray(r.tokens) ? r.tokens : [];
        text += r.content; timings = r.timings; prompt = [...prompt, ...ids];
        if (typeof r.timings?.predicted_per_second === 'number' && r.timings.predicted_per_second > 0) this.tokensPerSecond = r.timings.predicted_per_second;
        generated += typeof r.tokens_predicted === 'number' ? r.tokens_predicted : ids.length || n;
        if (r.content.endsWith('�')) broken = true;
        const stop: string = r.stop_type ?? (r.stopped_limit ? 'limit' : r.stopped_word ? 'word' : r.stopped_eos ? 'eos' : 'none');
        lastStop = stop; lastIds = ids; lastContent = r.content;
        if (stop === 'word' && typeof r.stopping_word === 'string') stoppingWord = r.stopping_word;
        if (r.truncated) { finish = 'length'; break; }
        if (!thoughtClosed) {
          if (text.includes('</think>')) thoughtClosed = true;
          else if (generated >= thinkingBudget && stop === 'limit') { const close = await this.tokenize('\n</think>\n\n'); prompt = [...prompt, ...close]; text += '\n</think>\n\n'; thoughtClosed = true; continuations++; continue; }
        }
        // Ended by the model rather than by the closing fence: the file is not complete.
        if (stop === 'eos' && fence && thoughtClosed) { finish = 'eos'; break; }
        if (stop !== 'limit') break;
        // A tail that repeats itself is wrong content, the one case to stop
        // generating: the text is cut at the start of the line the repeat begins
        // in and reported as such. The detectors judge the text the ids spell (a
        // chunk can end inside a character).
        if (broken && thoughtClosed) { try { text = await this.detokenize(prompt.slice(promptTokens)); broken = text.endsWith('\uFFFD'); } catch { /* keep the concatenation */ } }
        const bodyStart = thinking ? text.indexOf('</think>') + 8 : 0;
        const uncut = text; const body = text.slice(bodyStart);
        if (thoughtClosed) {
          // A chunk that still ends inside a character is judged without it; the cut is at a line start anyway.
          const judged = body.replace(/\uFFFD+$/, '');
          const at = repetitionStart(judged);
          // A periodic run whose unit holds a line end repeats whole short lines (closing brackets, blank lines), not one line.
          const hit = at >= 0 ? { start: at ? judged.split('\n').slice(0, at).join('\n').length + 1 : 0, kind: 'lines' as const, unit: undefined }
            : (() => { const h = periodic(judged) ?? cyclingLine(judged); return !h ? null : judged.slice(h.start).includes('\n') ? { start: h.start, kind: 'lines' as const, unit: undefined } : { ...h, kind: 'cycle' as const }; })();
          if (hit) { const c = lineCut(body, hit.start, hit.kind, hit.unit); cutFrom = uncut; text = text.slice(0, bodyStart) + c.kept; cut = c.cut; finish = 'repetition'; break; }
        }
        if (generated >= budget) { finish = 'length'; break; }
        continuations++;
      }
      // The token ids of a stop on a word include that word; the text never does.
      // Never after a cut: the ids still spell what was cut.
      if (broken && !cut) { try {
        text = await this.detokenize(prompt.slice(promptTokens)); if (stoppingWord && text.endsWith(stoppingWord)) text = text.slice(0, -stoppingWord.length);
        // The ids of an end-of-generation stop include the end token, which the content never shows.
        if (lastStop === 'eos' && lastIds.length) { const piece = await this.detokenize(lastIds.slice(-1)); if (piece && text.endsWith(piece) && !lastContent.endsWith(piece)) text = text.slice(0, -piece.length); }
      } catch { /* keep the concatenation */ } }
      if (thinking) text = text.replace(/^[\s\S]*?<\/think>\s*/, '');
      // A file that reached the budget inside a line: that line is unfinished,
      // so it is left out like a cut one.
      if (finish === 'length' && fence && thoughtClosed && !cut && text !== '' && !text.endsWith('\n')) { const c = lineCut(text, text.length, 'budget'); cutFrom = text; text = c.kept; cut = c.cut; }
      this.lastMeta = { ms: performance.now() - start, usage: { prompt_tokens: promptTokens, completion_tokens: generated }, timings, finishReason: finish, promptTokens, continuations };
      // What a loop cut discarded, so the next detector can be measured on real loops.
      if (cut) await this.log(finish === 'repetition' ? 'repetition-cut' : 'budget-cut', { requestId, ...context, kept: text.length, generated: cutFrom.length, cut, discardedTail: cutFrom.slice(-4000) });
      await this.log('bonsai', { requestId, ...context, model: this.config.model, ms: this.lastMeta.ms, prompt: { tokens: promptTokens, mode: 'llama-tokenizer' }, usage: this.lastMeta.usage, timings, finishReason: finish, continuations, raw: true });
      return { text, finish, meta: this.lastMeta, ...(cut ? { cut } : {}) };
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: performance.now() - start, error: (e as Error).message });
      throw e;
    }
  }
}
