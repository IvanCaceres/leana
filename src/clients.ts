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
export class Bonsai {
  // Timing and usage of the latest generation, for live progress and reports.
  lastMeta: GenerationMeta | null = null;
  constructor(readonly config: Config, private key: string, private log: Log) {}
  async count(messages: Message[]): Promise<{ tokens: number; mode: string }> {
    const root = this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    try {
      const applied = await postJson(`${root}/apply-template`, {
        messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false },
      }, this.key, 10000, 0);
      if (typeof applied.prompt !== 'string') throw new Error('Missing rendered prompt');
      const result = await postJson(`${root}/tokenize`, { content: applied.prompt, add_special: true }, this.key, 10000, 0);
      if (!Array.isArray(result.tokens)) throw new Error('Missing tokens');
      return { tokens: result.tokens.length, mode: 'llama-tokenizer' };
    } catch {
      // Conservative fallback for byte-level tokenizers; safetyTokens reserves template overhead.
      return { tokens: Buffer.byteLength(JSON.stringify(messages)), mode: 'utf8-byte-upper-bound' };
    }
  }
  async generate(messages: Message[], schema: JsonSchema, temperature = .2, context?: { step: number; route: string }): Promise<Record<string, any>> {
    const count = await this.count(messages);
    if (count.tokens > this.config.workingTokens || count.tokens + this.config.maxTokens + this.config.safetyTokens > this.config.contextWindow)
      throw new Error('Prompt exceeds budget; generation refused');
    const requestId = randomUUID();
    await this.log('bonsai-request', { requestId, ...context, prompt: count, temperature });
    const start = performance.now();
    try {
    const result = await postJson(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      model: this.config.model, messages, temperature, max_tokens: this.config.maxTokens,
      stream: false, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'arguments', strict: true, schema: samplingSchema(schema) } },
    }, this.key, 180000, 0);
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
}
