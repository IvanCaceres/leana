import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { Answers, Config, GenerationMeta, JsonSchema, Log, Message, Questions } from './types.js';
import { samplingSchema, validate } from './schema.js';

// A POST whose successful reply is left to the caller to read (the timeout covers the reading too); the
// transient statuses are retried before any of a reply is read. signal: the caller's own abort.
export async function post(
  url: string,
  body: unknown,
  key: string,
  timeoutMs = 30000,
  retries = 2,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (attempt < retries && [429, 500, 502, 503, 504, 529].includes(response.status)) {
      const header = response.headers.get('retry-after');
      const delay = header
        ? Number.isFinite(Number(header))
          ? Number(header) * 1000
          : Date.parse(header) - Date.now()
        : 250 * 2 ** attempt;
      await sleep(Math.min(10000, Math.max(100, Number.isFinite(delay) ? delay : 500)));
      continue;
    }
    throw httpError(response.status, url);
  }
}
// Do not echo server bodies, which can include prompts or credentials.
const httpError = (status: unknown, url: string) => new Error(`HTTP ${status} from ${new URL(url).origin}`);
export async function postJson(url: string, body: unknown, key: string, timeoutMs = 30000, retries = 2): Promise<any> {
  return (await post(url, body, key, timeoutMs, retries)).json();
}
// Whether a reply is a server-sent event stream; anything else (a server or mock that ignores `stream`) is read as JSON.
export const isEventStream = (r: Response) => /^text\/event-stream\b/i.test(r.headers.get('content-type') ?? '');
// The data of each event of a server-sent event stream, as it arrives. A character split across reads is
// decoded once whole and a line split across reads once ended; comments (llama-server's keep-alive pings)
// and other fields are skipped, and an event the stream ends inside of is never delivered.
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
    }
  }
}
// One event's JSON; an event that is not JSON fails without echoing it, and an error the server sends inside
// the stream (after the headers, so with status 200) fails as the HTTP error it is unstreamed.
function streamEvent(data: string, url: string): any {
  let e: any;
  try {
    e = JSON.parse(data);
  } catch {
    throw new Error(`Bonsai sent a stream event that is not JSON (from ${new URL(url).origin})`);
  }
  if (e?.error) throw httpError(e.error.code ?? 500, url);
  return e;
}
// The events of a streamed reply as they come, until [DONE] or the end of the stream. The request's own
// deadline covers the whole stream; each event also pushes back a shorter one, since a server whose decoding
// hangs keeps sending its keep-alive comments every 30 s, which keep the read (and undici's idle timeout)
// alive: the stream is aborted as a request is at its deadline (abort, the request's signal) when no event
// has come for firstMs (the prompt's processing) and then for gapMs (a minute; a token takes 25 ms). A
// connection that drops mid-stream fails as one that drops before its reply, the error an unstreamed request
// gives a server that dies generating ('fetch failed'; undici says 'terminated' once the headers have come).
export async function* streamEvents(
  response: Response,
  url: string,
  abort: AbortController,
  firstMs: number,
  gapMs = 60000,
): AsyncGenerator<any> {
  let timer: NodeJS.Timeout | undefined;
  const wait = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => abort.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ms,
    );
    timer.unref();
  };
  wait(firstMs);
  try {
    for await (const data of sseData(response.body!)) {
      if (data === '[DONE]') return;
      wait(gapMs);
      yield streamEvent(data, url);
    }
  } catch (e) {
    throw e instanceof TypeError && e.message === 'terminated' ? new TypeError('fetch failed', { cause: e }) : e;
  } finally {
    clearTimeout(timer);
  }
}
// What a streamed generation has produced so far, for live progress: its text (the reply's JSON for a
// structured generation, the code for a raw one), its tokens, and the decoding speed when the server says it;
// before the first token, how far the server has read the prompt (total and cached tokens, and those read so
// far, the cached ones included), from the events return_progress asks for.
export interface StreamProgress {
  text: string;
  tokens: number;
  perSecond?: number;
  prompt?: { total: number; cache: number; processed: number };
  reasoning?: string;
}
// A progress callback that cannot fail the generation it reports on: it only draws.
export const quietly =
  <T>(f?: (x: T) => void) =>
  (x: T) => {
    try {
      f?.(x);
    } catch {
      /* a display error is not the generation's */
    }
  };
// A streamed chat completion rebuilt as the reply the server sends unstreamed: the content its deltas spell,
// the finish reason, and the model, usage and timings its last events carry. A server that does not honour
// stream_options sends no usage; it is made from the timings, as the server builds it (usage_json_oaicompat).
// A stream that ends before its finish reason is a reply cut short, and fails before anything is logged of it.
async function chatFromStream(
  response: Response,
  url: string,
  abort: AbortController,
  firstMs: number,
  progress: (p: StreamProgress) => void,
): Promise<any> {
  let content = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: any;
  let timings: any;
  let model: any;
  let deltas = 0;
  for await (const e of streamEvents(response, url, abort, firstMs)) {
    model ??= e.model;
    if (e.usage) usage = e.usage;
    if (e.timings) timings = e.timings;
    if (e.prompt_progress) progress({ text: content, tokens: deltas, prompt: e.prompt_progress });
    for (const c of e.choices ?? []) {
      if (c.finish_reason) finish = c.finish_reason;
      // Every token adds to the JSON text, so the deltas count the tokens.
      if (typeof c.delta?.content === 'string' && c.delta.content) {
        content += c.delta.content;
        progress({ text: content, tokens: ++deltas, ...(reasoning ? { reasoning } : {}) });
      }
      // The model's own thinking, which the server parses out of the reply ahead of the content.
      if (typeof c.delta?.reasoning_content === 'string' && c.delta.reasoning_content) {
        reasoning += c.delta.reasoning_content;
        progress({ text: content, tokens: ++deltas, reasoning });
      }
    }
  }
  if (!finish) throw new Error(`Bonsai's stream ended before the generation did (from ${new URL(url).origin})`);
  usage ??= timings && {
    completion_tokens: timings.predicted_n,
    prompt_tokens: timings.cache_n + timings.prompt_n,
    total_tokens: timings.predicted_n + timings.cache_n + timings.prompt_n,
    prompt_tokens_details: { cached_tokens: timings.cache_n },
  };
  return {
    model,
    choices: [{ finish_reason: finish, message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
    usage,
    timings,
  };
}
// Written into the thinking before the </think> the server forces at the budget, so the reply that follows is
// read as the thinking's conclusion; also how a forced stop is recognised in the logs.
export const thinkingBudgetMessage = '\n\nThe thinking budget is spent; the answer follows from the thinking so far.\n';
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
      if (
        !Object.hasOwn(q.criteria, a.choice) ||
        !probability(a.confidence) ||
        !a.probabilities ||
        typeof a.probabilities !== 'object'
      )
        throw new Error(`Jev: invalid Choice ${id}`);
      const options = Object.keys(q.criteria);
      if (Object.keys(a.probabilities).length !== options.length || options.some(k => !probability(a.probabilities[k])))
        throw new Error(`Jev: invalid distribution ${id}`);
      if (Math.abs(Object.values(a.probabilities).reduce((s, p) => s + p, 0) - 1) > 0.02)
        throw new Error(`Jev: distribution does not sum to one: ${id}`);
      // Routing acts on the distribution; a choice field that disagrees with it
      // is reconciled to the argmax rather than failing the whole step.
      const top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
      if (a.probabilities[top]! > a.probabilities[a.choice]! + 1e-6) a.choice = top;
    }
  }
  return answers;
}
// A value with each string's unpaired surrogates replaced by U+FFFD, as String.prototype.toWellFormed does.
export function wellFormed<T>(v: T): T {
  if (typeof v === 'string')
    return v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�') as T;
  if (Array.isArray(v)) return v.map(wellFormed) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)])) as T;
  return v;
}
export class Jev {
  constructor(
    readonly config: Config,
    private key: string,
    private log: Log,
  ) {
    if (!key) throw new Error('Set TYPESAFE_API_KEY in the environment (or use --env-file PATH).');
  }
  async decide(stateIn: unknown, questions: Questions, context?: { step: number; phase: string }): Promise<Answers> {
    // Every string well-formed: a text cut anywhere in the state (one of many slices) can end on half an emoji,
    // and TypeSafe refuses the whole request ("Request contains invalid Unicode text", HTTP 400).
    const state = wellFormed(stateIn);
    const body = { model: this.config.jevModel, state, questions };
    // Conservative UTF-8 byte caps, not characters/4; bound the hosted model request too.
    if (Buffer.byteLength(JSON.stringify(state)) > 22000 || Buffer.byteLength(JSON.stringify(body)) > 50000)
      throw new Error('Jev decision state exceeds its configured byte budget');
    const requestId = randomUUID();
    await this.log('jev-request', { requestId, ...context, model: body.model, state, questions });
    const start = performance.now();
    try {
      // A dropped connection or a timeout is tried once more (post retries only the transient statuses); a 4xx
      // refuses this request as it is, so it is not.
      const result = await postJson(this.config.jevUrl, body, this.key, 15000).catch(e =>
        /^HTTP 4\d\d /.test((e as Error).message)
          ? Promise.reject(e)
          : sleep(500).then(() => postJson(this.config.jevUrl, body, this.key, 15000)),
      );
      let answers: Answers;
      try {
        answers = validateAnswers(questions, result.answers);
      } catch (e) {
        await this.log('jev-invalid', { requestId, ...context, answers: result.answers });
        throw e;
      }
      await this.log('jev', {
        requestId,
        ...context,
        ms: performance.now() - start,
        model: result.model,
        answers,
        usage: result.usage,
        // Priced from the tokens the reply reports: Jev bills input only.
        ...(typeof result.usage?.input_tokens === 'number'
          ? { costUsd: (result.usage.input_tokens * (this.config.jevUsdPerMillionInput ?? 0)) / 1e6 }
          : {}),
      });
      return answers;
    } catch (e) {
      await this.log('jev-error', {
        requestId,
        ...context,
        ms: performance.now() - start,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}
export interface TextGeneration {
  text: string;
  finish: 'stop' | 'length' | 'repetition' | 'eos';
  meta: GenerationMeta;
  cut?: GenerationCut;
}
// around: the generation is the block of a region of a file, which is as it is before the region,
// in it and after it; a block that starts reproducing the lines after it is stopped (echoOf).
export interface Around {
  before: string;
  region: string;
  after: string;
}
// progress: called as the text arrives (each token of a stream, each chunk otherwise); kept out of context, which is logged.
// think: the model reasons first, up to that many tokens, in its own <think> block, then writes the code (planFirst).
export interface TextOptions {
  budgetTokens?: number;
  temperature?: number;
  context?: { step: number; route: string };
  fence?: string | null;
  thinking?: boolean;
  thinkingBudget?: number;
  around?: Around;
  progress?: (p: StreamProgress) => void;
  think?: number;
}
// Sampling for code: codeTemperature, codeTopP, codeTopK, codeMinP, sent with each request.
// No repetition penalty: code repeats itself legitimately (similar blocks, a
// rewrite that keeps most of a file), and a penalty on repeating pushes the model
// to end the generation mid-line. A loop is caught by repetitionStart instead.
// A generation that has started repeating itself: the same block of three to
// eight lines three times back to back in the recent tail, or one line twelve
// times in a row. Only back-to-back repetition counts: a line that recurs across
// a file (a closing tag, a brace, a return) is how code is made, and so is data
// whose rows repeat a few times (run pacman-1: a maze with ten identical rows, and
// one whose three-row pattern came twice after an earlier occurrence, were cut as
// loops four times, and the worker spent 50 steps writing around "the harness's
// truncation"). The block once counted a match anywhere earlier as one of the
// three; the one recorded block loop (react-demo-82) repeated 18 times in a row.
// A loop never ends, so a higher count costs a few lines of it. Returns the line
// index at which the first repeat begins, or -1.
export function repetitionStart(text: string, tail = 80): number {
  const lines = text.split('\n');
  const from = Math.max(0, lines.length - tail);
  for (let i = from, run = 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    run = i > from && l.length >= 3 && l === lines[i - 1]!.trim() ? run + 1 : 1;
    if (run >= 12) return i - run + 2;
  }
  for (let size = 3; size <= 8; size++) {
    for (let i = from; i + 3 * size <= lines.length; i++) {
      const ws = lines.slice(i, i + size).map(l => l.trim());
      const w = ws.join('\n');
      if (w.replace(/[\s{}()[\];,]/g, '').length < 24) continue;
      // A block that is itself a shorter block repeated (identical rows) is the shorter block's run: judged by its own count.
      if ([1, 2, 3, 4].some(d => d < size && size % d === 0 && ws.every((l, k) => l === ws[k % d]))) continue;
      let n = 1;
      for (
        let j = i + size;
        j + size <= lines.length &&
        lines
          .slice(j, j + size)
          .map(l => l.trim())
          .join('\n') === w;
        j += size
      )
        n++;
      if (n >= 3) return i + size;
    }
  }
  return -1;
}
// How a run of whole lines repeats from line index at: the smallest block (1..8 lines) that recurs back to
// back there, and how many times in a row it came (counting the occurrence just before at, the first).
export function repeatRun(lines: string[], at: number): { size: number; times: number } | null {
  const t = lines.map(l => l.trim());
  for (let size = 1; size <= 8; size++) {
    const first = at - size;
    if (first < 0) continue;
    const w = t.slice(first, at).join('\n');
    if (t.slice(at, at + size).join('\n') !== w) continue;
    let times = 1;
    for (let j = first + size; j + size <= t.length && t.slice(j, j + size).join('\n') === w; j += size) times++;
    if (times >= 2) return { size, times };
  }
  return null;
}
// A generation caught in a loop inside one line (a path, a data array, a
// string that never closes): the tail is one short unit over and over. Real
// content does not repeat a unit of 4..200 characters verbatim for 800
// characters. Returns where the repeating run starts and the unit, or null.
export function periodic(text: string, span = 800): { start: number; unit: number } | null {
  if (text.length < span) return null;
  const end = text.length;
  for (let p = 4; p <= 200; p++) {
    let i = end - 1;
    while (i - p >= 0 && text[i] === text[i - p]) i--;
    const run = end - 1 - i; // characters equal to the character p before them
    if (run + p >= span && (run + p) / p >= 8) return { start: i + 1, unit: p };
  }
  return null;
}
export function periodicStart(text: string, span = 800): number {
  return periodic(text, span)?.start ?? -1;
}
// The lines of a text that hold anything, trimmed, with each one's index among all its lines.
export function contentLines(text: string): { t: string; i: number }[] {
  const out: { t: string; i: number }[] = [];
  text.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t) out.push({ t, i });
  });
  return out;
}
// A line that says something beyond brackets and separators: a single matching line of
// brackets or a few characters is ambiguous (a block's own closing brace looks like the next one).
export const substantive = (line: string) => line.trim().replace(/[{}()[\];,]/g, '').length >= 8;
// A block generated for a region of a file that reproduces the lines after the region, which stay
// in the file. Lines are compared trimmed and without blank lines, as a copy is made: run 73 step
// 70 was to delete lines 85..100 and generated lines 102..244 instead (1510 tokens, 44 s), leaving
// out blank lines 101 and 115, which a line-for-line comparison never matches.
// A repeat is the first ten lines after the region, one of them substantive, in order anywhere
// in the block, when the file holds that run only once. Measured with the first five: none of the
// 928 changed hunks of the recorded whole-file rewrites, replayed as region rewrites of the old
// file (with 0, 3 or 10 unchanged lines around them), holds them, and none of the six recorded
// region blocks that have lines after them; taking every line boundary of 712 real files as a
// block end, a block of 10 lines holds them 0.03% of the time and one of 80 lines 0.81%, each
// time a run the file holds twice (in the block and after it), which the once-only condition
// excludes. The first three lines instead: one hunk (0.11%) and 0.27% to 2.64% of those blocks.
// Ten rather than five: a block that legitimately opens like the lines after it (a card given its
// sibling's icon, an effect moved above the handlers) would otherwise be taken for a repeat and
// its region removed; run 73's repeat had 16 such lines in its first 128 tokens. A shorter repeat
// is judged once the generation has ended, at the block's end. The three recorded repeats all
// start with lines the file holds once.
// Once the generation has ended (ended), a repeat at the block's end counts at any length when
// it is two or more lines or one substantive line, as for context repeated around a region;
// one that is the whole block needs a substantive line, since emptying the block removes the
// region: a region of closing lines regenerated as it is, before the same closing lines, stays.
// Returns the block line (1-based) the repeat starts at, taking the blank lines before it with
// it, how many of the lines after the region, from the first, it reproduced, and
// whether the block went on past them with other lines.
export interface Echo {
  line: number;
  echoed: number;
  diverged: boolean;
}
export function echoOf(block: string, around: Around, ended = true): Echo | null {
  const g = contentLines(block);
  const f = contentLines(around.after);
  if (!g.length || !f.length) return null;
  const gt = g.map(x => x.t);
  const ft = f.map(x => x.t);
  const run = 10;
  const key = ft.slice(0, run);
  const file = contentLines(`${around.before}\n${around.region}\n${around.after}`).map(x => x.t);
  let times = 0;
  for (let i = 0; i + run <= file.length && times < 2; i++) if (key.every((t, k) => file[i + k] === t)) times++;
  let at =
    key.length === run && key.some(substantive) && times === 1
      ? gt.findIndex((_, p) => key.every((t, k) => gt[p + k] === t))
      : -1;
  if (at < 0 && ended)
    for (let n = Math.min(gt.length, ft.length); n > 0; n--)
      if (
        gt.slice(-n).every((t, k) => t === ft[k]) &&
        (n >= 2 || substantive(gt.at(-1)!)) &&
        (n < gt.length || gt.some(substantive))
      ) {
        at = gt.length - n;
        break;
      }
  if (at < 0) return null;
  let m = 0;
  while (at + m < gt.length && m < ft.length && gt[at + m] === ft[m]) m++;
  return { line: at ? g[at - 1]!.i + 2 : 1, echoed: f[m - 1]!.i + 1, diverged: at + m < gt.length };
}
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
  const start = text.lastIndexOf('\n') + 1;
  const end = text.length;
  if (end - start < span) return null;
  for (let p = 4; p <= maxPeriod && 2 * p <= end - start; p++) {
    let i = end - 1;
    while (i - p >= start && text.charCodeAt(i) === text.charCodeAt(i - p)) i--;
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
// a single line, 'budget' an unfinished line at the token budget, 'echo' a region's
// block reproducing the lines after the region (echoed and diverged as echoOf says).
export interface GenerationCut {
  kind: 'cycle' | 'lines' | 'budget' | 'echo';
  line: number;
  opening: string;
  truncated?: true;
  lineChars: number;
  unit?: number;
  echoed?: number;
  diverged?: true;
  block?: number;
  times?: number;
}
export function lineCut(
  body: string,
  at: number,
  kind: GenerationCut['kind'],
  unit?: number,
): { kept: string; cut: GenerationCut } {
  // At 0 the cut line is the first (lastIndexOf from -1 would find a line break at 0 and keep it).
  const ls = at ? body.lastIndexOf('\n', at - 1) + 1 : 0;
  const le = body.indexOf('\n', ls);
  const line = body.slice(ls, le < 0 ? body.length : le);
  const trimmed = line.trimStart();
  return {
    kept: body.slice(0, ls),
    cut: {
      kind,
      line: body.slice(0, ls).split('\n').length,
      opening: trimmed.slice(0, 60),
      ...(trimmed.length > 60 ? { truncated: true as const } : {}),
      lineChars: line.length,
      ...(unit ? { unit } : {}),
    },
  };
}
// Where a generation that has started repeating itself is cut, judged on its text so far as at the end of a
// chunk: a repeat of whole lines, a loop inside one line, or (around a region) a repeat of the lines after the
// region, which wins when it starts no later. The kept text and the cut, or null. lines false leaves out
// repeats of whole lines (repetitionStart's, and a periodic run across lines), for a stream judged between
// chunk ends (streamCheck): only a loop inside the line being written, and an echo.
export function repeatCut(body: string, around?: Around, lines = true): { kept: string; cut: GenerationCut } | null {
  // A chunk that still ends inside a character is judged without it; the cut is at a line start anyway.
  const judged = body.replace(/\uFFFD+$/, '');
  const at = lines ? repetitionStart(judged) : -1;
  // A periodic run whose unit holds a line end repeats whole short lines (closing brackets, blank lines), not one line.
  const lineStart = (n: number) => (n ? judged.split('\n').slice(0, n).join('\n').length + 1 : 0);
  const loop = (h: { start: number; unit: number } | null) =>
    !h
      ? null
      : !judged.slice(h.start).includes('\n')
        ? { ...h, kind: 'cycle' as const }
        : lines
          ? { start: h.start, kind: 'lines' as const, unit: undefined }
          : null;
  const hit =
    at >= 0
      ? { start: lineStart(at), kind: 'lines' as const, unit: undefined }
      : lines
        ? loop(periodic(judged) ?? cyclingLine(judged))
        : (loop(periodic(judged)) ?? loop(cyclingLine(judged)));
  // A block that has started reproducing the lines after its region, judged on its whole lines, is cut where the repeat starts.
  const echo = around ? echoOf(judged.slice(0, judged.lastIndexOf('\n') + 1), around, false) : null;
  if (echo && (!hit || lineStart(echo.line - 1) <= hit.start)) {
    const c = lineCut(body, lineStart(echo.line - 1), 'echo');
    return {
      kept: c.kept,
      cut: { ...c.cut, echoed: echo.echoed, ...(echo.diverged ? { diverged: true as const } : {}) },
    };
  }
  if (!hit) return null;
  const c = lineCut(body, hit.start, hit.kind, hit.unit);
  // A run of whole lines is stated by what repeated: its block and how many times in a row (whole lines only, the last may be unfinished).
  const run =
    hit.kind === 'lines'
      ? repeatRun(
          judged
            .slice(0, judged.lastIndexOf('\n') + 1)
            .split('\n')
            .slice(0, -1),
          c.cut.line - 1,
        )
      : null;
  return run ? { kept: c.kept, cut: { ...c.cut, block: run.size, times: run.times } } : c;
}
// One /completion reply, streamed or not: the text, the token ids, and the stop fields. exact is false when
// the ids are not all there (a stream drops the id of a token that ends inside a character); aborted when the
// client stopped the stream on a repeat.
interface Completion {
  content: string;
  tokens: number[];
  tokens_predicted?: number;
  stop_type?: string;
  stopped_limit?: boolean;
  stopped_word?: boolean;
  stopped_eos?: boolean;
  stopping_word?: string;
  truncated?: boolean;
  timings?: any;
  exact?: boolean;
  aborted?: boolean;
}
// When a stream is judged for repeats (repeatCut): wholly where a chunk would have ended (the first event with
// text at or past each chunk's worth of tokens), so it is stopped no later than the chunks would have stopped
// it; and in between only for a loop inside the line being written or a region's echo, which stop it sooner,
// at a line end once `tokens` tokens have come since the last judgement and inside a line each time it grows
// by `chars` characters (a loop inside one line never ends it). Repeats of whole lines are left to the chunk
// ends: one line six times in a row is also how a legitimate file can look (react-demo-40 step 6, eight
// identical decorative <div> lines, which ended before its first chunk end), and judged at every line end it
// is cut; a loop of whole lines runs on to the next chunk end, as it did. Replayed over 1,077 recorded
// generations (the 77 region rewrites with the model's own ids, 999 files re-tokenized, a legitimate fixture),
// streamed and chunked: 1,065 identical (text, finish, cut, usage, logged cut); the other 12 (11 loops inside
// a line and run 73's echo) keep the same text and cut at the same line, stop sooner (5,863 tokens fewer in
// all) and so report the shorter line or echo they reached; none stops later, no file is cut that the chunks
// keep. 59,467 judgements over the 999: 0.01 ms each on average, 2.5 ms at most, 36 ms for the costliest file.
const streamCheck = { tokens: 8, chars: 256 };
// How long one generation request may take: a minute of slack, the prompt to
// process when it is not cached (the first chunk; a cold 30k-token prompt takes
// ~90 s at ~350 tok/s, so it is allowed at 150 tok/s), and the tokens to generate
// at half the observed speed, that speed capped so a burst of accepted drafts
// never shrinks the allowance.
export function requestTimeoutMs(promptTokens: number, generate: number, tokensPerSecond: number): number {
  const decode = Math.max(4, Math.min(tokensPerSecond, 60) * 0.5);
  return 60000 + Math.ceil(promptTokens / 150) * 1000 + Math.ceil(generate / decode) * 1000;
}
export class Bonsai {
  // Timing and usage of the latest generation, for live progress and reports.
  lastMeta: GenerationMeta | null = null;
  // The generation speed last observed, for request timeouts that fit the model.
  private tokensPerSecond = 20;
  // The latest prompt rendered, with its token count once counted, by the messages it renders: a step
  // prompt is counted to fit it and was counted again when sent, an /apply-template and a /tokenize
  // round trip (30 ms on average over 791 step requests of runs 49-76; 1.4 s of run 73, 2.0 s of run
  // 76), and a code-generation prompt is counted, then rendered again for its ids.
  private rendered: { key: string; prompt: string; tokens?: number } | null = null;
  // The text that opens a user message in the server's chat template, once found (userDelimiter).
  private userStart?: Promise<string | null>;
  // Whether the server streams, once a step reply has shown it (an event stream, or JSON from a server or
  // mock that ignores `stream`). A code generation is streamed only then: a stream cannot be continued by
  // its token ids (it drops the id of a token that ends inside a character), so a streamed generation is one
  // request to the budget, judged for repeats as it arrives; until then it is the chunked request it was.
  streams?: boolean;
  constructor(
    readonly config: Config,
    private key: string,
    private log: Log,
  ) {}
  private get root(): string {
    return this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  }
  // The prompt exactly as the server's chat template renders it, ending with the
  // assistant prefix, so a raw completion can continue it.
  private async render(
    messages: Message[],
    thinking = false,
  ): Promise<{ key: string; prompt: string; tokens?: number }> {
    const key = JSON.stringify([thinking, messages]);
    if (this.rendered?.key === key) return this.rendered;
    const applied = await postJson(
      `${this.root}/apply-template`,
      {
        // Effort medium with thinking: xhigh, the template's default, would prepend a sentence to the system message.
        messages,
        add_generation_prompt: true,
        chat_template_kwargs: {
          enable_thinking: thinking,
          ...(thinking ? { reasoning_effort: this.config.thinkingEffort } : {}),
        },
      },
      this.key,
      10000,
      0,
    );
    if (typeof applied.prompt !== 'string') throw new Error('Missing rendered prompt');
    return (this.rendered = { key, prompt: applied.prompt });
  }
  // The text that opens a user message: what a rendered user message has before its content once the
  // system message before it has ended, trimmed (the server's autoparser takes its own the same way after
  // an assistant message, detect_user_start_marker in common/chat-diff-analyzer.cpp). For this model's
  // template that is '<|im_start|>user', the delimiter the server's chat path sends itself from a fixed
  // list (common/chat.cpp:1192). Null when the rendering does not show it (a template that folds the
  // system message into the first user message); generations then go without.
  private userDelimiter(): Promise<string | null> {
    const system = 'LEANA-SYSTEM-MARK';
    const user = 'LEANA-USER-MARK';
    return (this.userStart ??= postJson(
      `${this.root}/apply-template`,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        add_generation_prompt: false,
      },
      this.key,
      10000,
      0,
    ).then(
      r => {
        const p = r?.prompt;
        if (typeof p !== 'string') return null;
        const i = p.indexOf(system);
        const j = p.indexOf(user);
        if (i < 0 || j < i) return null;
        const end = p.slice(j + user.length);
        const between = p.slice(i + system.length, j);
        return end.trim() && between.startsWith(end) ? between.slice(end.length).trim() || null : null;
      },
      () => {
        this.userStart = undefined;
        return null;
      },
    ));
  }
  private async tokenize(text: string): Promise<number[]> {
    const result = await postJson(`${this.root}/tokenize`, { content: text, add_special: true }, this.key, 10000, 0);
    if (!Array.isArray(result.tokens)) throw new Error('Missing tokens');
    return result.tokens as number[];
  }
  private async detokenize(tokens: number[], retries = 0): Promise<string> {
    const result = await postJson(`${this.root}/detokenize`, { tokens }, this.key, 10000, retries);
    if (typeof result.content !== 'string') throw new Error('Missing detokenized content');
    return result.content;
  }
  // One /completion request read as it streams, rebuilt as the reply the server sends unstreamed. The stream
  // differs from that reply in two places (server-context.cpp process_token, send_final_response): a token
  // that ends inside a character sends no event, so its id never comes (the next event carries the whole
  // character but only its own id, and tokens_predicted counts the gap); and at a stop by the token limit the
  // text held back as the start of the stop word (a line break before the closing fence) is never sent,
  // though its ids were, so it is detokenized. repeated judges the text as if the request had stopped there
  // (lines: wholly, at the first event with text at or past each `chunk` tokens; otherwise as streamCheck
  // says); when it finds a repeat the request is aborted (the server cancels the slot's task at its next
  // token) and the reply ends there, as at a limit. firstMs: how long the prompt may take (streamEvents).
  private async completionStream(
    response: Response,
    url: string,
    abort: AbortController,
    firstMs: number,
    chunk: number,
    progress: (p: StreamProgress) => void,
    repeated: (text: string, lines: boolean) => boolean,
  ): Promise<Completion> {
    let content = '';
    const tokens: number[] = [];
    let n = 0;
    let held: number[] = [];
    let exact = true;
    let timings: any;
    let final: any;
    let judgedAt = 0;
    let judgedLength = 0;
    let chunkEnd = chunk;
    let stopped = false;
    for await (const e of streamEvents(response, url, abort, firstMs)) {
      if (e.timings) timings = e.timings;
      if (e.stop) {
        final = e;
        break;
      }
      if (e.prompt_progress) {
        progress({ text: content, tokens: n, prompt: e.prompt_progress });
        continue;
      } // its tokens are not generated ones
      const ids: number[] = Array.isArray(e.tokens) ? e.tokens : [];
      const piece = typeof e.content === 'string' ? e.content : '';
      const predicted = typeof e.tokens_predicted === 'number' ? e.tokens_predicted : n + ids.length;
      if (predicted > n + ids.length) exact = false;
      n = predicted;
      tokens.push(...ids);
      if (piece) {
        content += piece;
        held = [];
      } else held.push(...ids);
      progress({
        text: content,
        tokens: n,
        ...(typeof e.timings?.predicted_per_second === 'number' ? { perSecond: e.timings.predicted_per_second } : {}),
      });
      // Only text with nothing held back is judged: at a chunk's end it is the text its unstreamed reply has.
      if (!piece) continue;
      const lines = n >= chunkEnd;
      if (
        lines ||
        (piece.includes('\n')
          ? n - judgedAt >= streamCheck.tokens
          : content.length - Math.max(judgedLength, content.lastIndexOf('\n')) >= streamCheck.chars)
      ) {
        if (lines) chunkEnd = (Math.floor(n / chunk) + 1) * chunk;
        judgedAt = n;
        judgedLength = content.length;
        if (repeated(content, lines)) {
          stopped = true;
          break;
        }
      }
    }
    // Leaving the loop cancels the reply; the abort makes sure its connection closes, which the server takes as a cancel.
    if (stopped) {
      abort.abort();
      return { content, tokens, tokens_predicted: n, stop_type: 'limit', timings, exact, aborted: true };
    }
    if (!final) throw new Error(`Bonsai's stream ended before the generation did (from ${new URL(url).origin})`);
    // Tokens after the last event ended inside a character: the unstreamed text ends in a replacement character
    // there (complete characters inside those tokens, if any, are not known). A held tail is detokenized as
    // the unstreamed reply would show it. A server that cannot, even when asked again, leaves it out (as a
    // failed detokenize leaves a chunk's concatenation): the last line, whole but without its line break, is
    // then cut as unfinished at the budget, which keeps the generation rather than failing it.
    const lost = typeof final.tokens_predicted === 'number' ? final.tokens_predicted - n : 0;
    let tail = final.stop_type === 'limit' && held.length ? await this.detokenize(held, 2).catch(() => '') : '';
    if (lost > 0) {
      exact = false;
      tail += '\uFFFD';
    }
    return {
      content: content + tail,
      tokens,
      tokens_predicted: final.tokens_predicted,
      stop_type: final.stop_type,
      stopping_word: final.stopping_word,
      truncated: final.truncated,
      timings: final.timings ?? timings,
      exact,
    };
  }
  // The thought before a file's code: a raw completion of the prompt rendered with thinking at effort medium
  // (its template opens <think>), stopped at </think> or at budget tokens, at the thinking-mode sampling the
  // steps use (stepThinkingTemperature, stepTopP, stepTopK, stepMinP). Streamed when the server streams, so
  // the reasoning shows as it is written. The code that follows is a request of its own at the code sampling.
  private async planFirst(
    messages: Message[],
    budget: number,
    context: { step: number; route: string } | undefined,
    progress: (p: StreamProgress) => void,
  ): Promise<{ text: string; forced: boolean; tokens: number; ms: number }> {
    const start = performance.now();
    const ids = await this.tokenize((await this.render(messages, true)).prompt);
    const userStart = await this.userDelimiter();
    const url = `${this.root}/completion`;
    const abort = new AbortController();
    const live = this.streams === true;
    const response = await post(
      url,
      {
        prompt: ids,
        n_predict: budget,
        temperature: this.config.stepThinkingTemperature,
        top_p: this.config.stepTopP,
        top_k: this.config.stepTopK,
        min_p: this.config.stepMinP,
        cache_prompt: true,
        return_tokens: true,
        stop: ['</think>'],
        ...(live ? { stream: true, return_progress: true } : { stream: false }),
        ...(userStart ? { message_delimiters: [{ role: 'user', delimiter: userStart }] } : {}),
      },
      this.key,
      requestTimeoutMs(ids.length, budget, this.tokensPerSecond),
      0,
      abort.signal,
    );
    const r: Completion = isEventStream(response)
      ? await this.completionStream(
          response,
          url,
          abort,
          requestTimeoutMs(ids.length, 0, this.tokensPerSecond),
          Infinity,
          p => progress({ text: '', tokens: p.tokens, ...(p.prompt ? { prompt: p.prompt } : { reasoning: p.text }) }),
          () => false,
        )
      : await response.json();
    if (typeof r.content !== 'string') throw new Error('Bonsai returned no thought');
    const stop: string =
      r.stop_type ?? (r.stopped_limit ? 'limit' : r.stopped_word ? 'word' : r.stopped_eos ? 'eos' : 'none');
    const tokens = typeof r.tokens_predicted === 'number' ? r.tokens_predicted : (r.tokens ?? []).length;
    await this.log('bonsai-think', { ...context, ms: performance.now() - start, tokens, stop, timings: r.timings });
    return {
      text: r.content.replace(/<\/think>\s*$/, ''),
      forced: stop === 'limit',
      tokens,
      ms: performance.now() - start,
    };
  }
  // A local server's model is never shown images (Bonsai reads text).
  async seesImages(): Promise<boolean> {
    return false;
  }
  async count(messages: Message[]): Promise<{ tokens: number; mode: string }> {
    try {
      const r = await this.render(messages);
      r.tokens ??= (await this.tokenize(r.prompt)).length;
      return { tokens: r.tokens, mode: 'llama-tokenizer' };
    } catch {
      // Conservative fallback for byte-level tokenizers; safetyTokens reserves template overhead.
      return { tokens: Buffer.byteLength(JSON.stringify(messages)), mode: 'utf8-byte-upper-bound' };
    }
  }
  // A structured, grammar-constrained generation: short arguments and designs.
  // maxTokens raises the output budget for the few generations that need it.
  // Streamed: progress is called with the reply's JSON text as it arrives, and before it with the prompt's
  // processing. stream, stream_options and return_progress are delivery options; the prompt, the grammar and
  // the sampling are those of the unstreamed request.
  // thinking: the model's own reasoning before the reply, up to that many tokens (the step route only, see
  // Agent.generateJson). The template opens <think> instead of pre-filling an empty block; the JSON grammar
  // holds only after </think>, which the server forces at the budget (reasoning_budget_tokens, with
  // reasoning_budget_message written before it); reasoning_format's default splits the thinking into
  // reasoning_content. Effort is thinkingEffort, the same for every request: xhigh and low put a sentence
  // in the system message, so requests of two efforts would share no cached prefix.
  async generate(
    messages: Message[],
    schema: JsonSchema,
    temperature = this.config.stepTemperature,
    context?: { step: number; route: string },
    maxTokens = this.config.maxTokens,
    progress?: (p: StreamProgress) => void,
    thinking?: number,
  ): Promise<Record<string, any>> {
    const count = await this.count(messages);
    if (
      count.tokens > this.config.workingTokens ||
      count.tokens + maxTokens + this.config.safetyTokens > this.config.contextWindow
    )
      throw new Error('Prompt exceeds budget; generation refused');
    const requestId = randomUUID();
    await this.log('bonsai-request', {
      requestId,
      ...context,
      prompt: count,
      temperature,
      topP: this.config.stepTopP,
      topK: this.config.stepTopK,
      minP: this.config.stepMinP,
      maxTokens,
      ...(thinking ? { thinking } : {}),
    });
    const start = performance.now();
    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const abort = new AbortController();
      const response = await post(
        url,
        {
          model: this.config.model,
          messages,
          temperature,
          top_p: this.config.stepTopP,
          top_k: this.config.stepTopK,
          min_p: this.config.stepMinP,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          return_progress: true,
          chat_template_kwargs: { enable_thinking: Boolean(thinking) },
          ...(thinking
            ? {
                reasoning_effort: this.config.thinkingEffort,
                reasoning_budget_tokens: thinking,
                reasoning_budget_message: thinkingBudgetMessage,
              }
            : {}),
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'arguments', strict: true, schema: samplingSchema(schema) },
          },
        },
        this.key,
        60000 + maxTokens * 60,
        0,
        abort.signal,
      );
      this.streams = isEventStream(response);
      const result = this.streams
        ? await chatFromStream(
            response,
            url,
            abort,
            requestTimeoutMs(count.tokens, 0, this.tokensPerSecond),
            quietly(progress),
          )
        : await response.json();
      const choice = result.choices?.[0];
      const reasoning =
        typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.trim() : '';
      this.lastMeta = {
        ms: performance.now() - start,
        usage: result.usage,
        timings: result.timings,
        finishReason: choice?.finish_reason,
        promptTokens: count.tokens,
        ...(thinking ? { reasoning } : {}),
      };
      await this.log('bonsai', {
        requestId,
        ...context,
        model: result.model,
        ms: this.lastMeta.ms,
        prompt: count,
        usage: result.usage,
        timings: result.timings,
        finishReason: choice?.finish_reason,
        ...(thinking
          ? { reasoningChars: reasoning.length, reasoningForced: reasoning.includes(thinkingBudgetMessage.trim()) }
          : {}),
      });
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
        throw new Error(`Bonsai did not finish a JSON argument object (${choice?.finish_reason ?? 'missing choice'})`);
      let args: unknown;
      try {
        args = JSON.parse(choice.message.content);
      } catch {
        throw new Error('Bonsai returned invalid JSON');
      }
      validate(schema, args);
      return args as Record<string, any>;
    } catch (e) {
      await this.log('bonsai-error', {
        requestId,
        ...context,
        ms: performance.now() - start,
        error: (e as Error).message,
      });
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
    const budget = options.budgetTokens ?? this.config.createTokens;
    const temperature = options.temperature ?? this.config.codeTemperature;
    const context = options.context;
    const thinking = options.thinking ?? false;
    const thinkingBudget = options.thinkingBudget ?? 2048;
    const fence = options.fence === undefined ? '```' : options.fence;
    const requestId = randomUUID();
    const start = performance.now();
    let prompt: number[];
    let promptTokens: number;
    let plan: { text: string; forced: boolean; tokens: number; ms: number } | undefined;
    // While the steps think, a file is rendered as they are and its thought left empty (the template's own
    // non-thinking prefill): the effort's sentence is in the system message every request shares, so a file
    // rendered without it would have the server process the whole prompt again.
    const shared = this.config.stepThinking && !thinking && Boolean(fence);
    try {
      prompt = await this.tokenize(
        (await this.render(messages, thinking || shared)).prompt +
          (shared ? '\n</think>\n\n' : '') +
          (fence && !thinking ? `${fence}\n` : ''),
      );
      promptTokens = prompt.length;
    } catch (e) {
      await this.log('bonsai-error', { requestId, ...context, ms: 0, error: `render: ${(e as Error).message}` });
      throw new Error(`The server could not render the prompt: ${(e as Error).message}`);
    }
    // The model's own reasoning before the code (options.think tokens at most), the way its coding scores
    // were measured: then the code is generated after the closed thought, inside the opened fence, as
    // before. A thought that reaches its budget is closed after the budget message.
    if (options.think && fence && !thinking) {
      try {
        plan = await this.planFirst(messages, options.think, context, quietly(options.progress));
        prompt = await this.tokenize(
          `${(await this.render(messages, true)).prompt}${plan.text}${plan.forced ? thinkingBudgetMessage : '\n'}</think>\n\n${fence}\n`,
        );
        promptTokens = prompt.length;
      } catch (e) {
        await this.log('bonsai-error', { requestId, ...context, ms: 0, error: `think: ${(e as Error).message}` });
        throw e;
      }
    }
    if (
      promptTokens > this.config.workingTokens ||
      promptTokens + Math.min(budget, this.config.maxTokens) + this.config.safetyTokens > this.config.contextWindow
    )
      throw new Error('Prompt exceeds budget; generation refused');
    // The server checkpoints this hybrid model's recurrent state, the only points a later request can
    // resume from, at each user-message start it processes and 516 and 4 tokens before the prompt end
    // (server-context.cpp 3433-3519, with --checkpoint-min-step 0). A chat request finds those starts by
    // the delimiters of its template; a raw completion only by the message_delimiters it is sent
    // (4175-4193). Without them the request after a code generation resumed at the step request's
    // checkpoint and processed the batch's earlier results again: 107k tokens over runs 49-76 by a
    // replay of the server's checkpoint logic (6.7k in run 73, 2.2k in run 76, 16.4k in run 51, whose
    // compaction was processed twice). Only user starts are checkpointed (is_user_start,
    // common/chat.h:173), so the user delimiter alone gives a code-generation prompt the checkpoints a
    // chat request of it gets. Each costs about 98 ms (a 150 MiB state copy and the batch break before
    // it, fitted over 1,044 logged requests) and 541 more are made: 139 s saved, 53 s spent, 40 s of it
    // on the 411 at a code request's own start, which the server always makes and no later request
    // resumes from, the next one diverging before it (0 of 779 for a step request's own). At most 94
    // are alive at once (88 without), under the cap of 128, so the cap still never drops the low restore
    // points an eviction falls back to.
    const userStart = await this.userDelimiter();
    await this.log('bonsai-request', {
      requestId,
      ...context,
      prompt: { tokens: promptTokens, mode: 'llama-tokenizer' },
      temperature,
      topP: this.config.codeTopP,
      topK: this.config.codeTopK,
      minP: this.config.codeMinP,
      presencePenalty: this.config.codePresencePenalty,
      budgetTokens: budget,
      raw: true,
      thinking,
      userStart,
    });
    // Chunks are where a loop is checked for; a continuation reuses the cached ids, so a small one costs little
    // (one token to process: 124 ms, the median of 263 recorded continuations). A region's block is checked
    // every 128 tokens (about 2.7 s of generation, so about 5% more time) for a repeat of the lines after it,
    // which otherwise runs on to the file's end (run 73 step 70: 1510 tokens, 44 s, stopped after 128). Each
    // continuation also leaves a server checkpoint of the recurrent state (149.6 MiB of host memory, one of
    // at most 128), which the next request drops as it diverges before it.
    // A streamed generation needs no chunks: it is judged as it arrives (where each chunk would have ended, and
    // sooner for a loop inside a line or an echo, streamCheck) and stopped at a repeat, so it is one request to
    // the budget, with no continuation to pay for and no ids to send back. Over the 1,077 recorded generations
    // replayed: 1,941 requests become 1,077, and the 864 continuations and their checkpoints go (the 77 region
    // rewrites alone, in 128-token chunks: 319 requests become 77). A chunked stream would have continued 2 of
    // them from ids it never received. Thinking keeps its chunks: an overlong thought is closed between two. A stopped stream relies on the server cancelling the
    // slot's task when its client goes (llama-server checks the connection before each write and cancels at
    // the next token, ~50 ms); a proxy that kept the upstream connection open would let the slot run on to
    // the budget, where a chunk ran on at most to its own end.
    const live = this.streams === true && !thinking;
    const step = Math.min(this.config.maxTokens, options.around ? 128 : 1024);
    const chunk = live ? Infinity : step;
    const progress = quietly(options.progress);
    let cutFrom = '';
    let text = '';
    let generated = 0;
    let continuations = 0;
    let finish: TextGeneration['finish'] = 'stop';
    let timings: any;
    let broken = false;
    let thoughtClosed = !thinking;
    let stoppingWord = '';
    let cut: GenerationCut | undefined;
    let lastStop = '';
    let lastIds: number[] = [];
    let lastContent = '';
    let exact = true;
    // The closing fence is the backtick run alone, whatever language opened it.
    const stopWords = fence ? [`\n${fence.match(/^`+/)?.[0] ?? '```'}`] : [];
    try {
      while (true) {
        const room = this.config.contextWindow - this.config.safetyTokens - promptTokens;
        const n = Math.min(chunk, budget - generated, room - generated);
        if (n <= 0) {
          finish = 'length';
          break;
        }
        // A streamed request has the time the chunks it replaces had together (a minute of slack each), so a
        // generation slower than the last one is not lost to its deadline; a hang is caught by streamEvents.
        const timeout =
          requestTimeoutMs(continuations === 0 ? promptTokens : 0, n, this.tokensPerSecond) +
          (live ? 60000 * (Math.ceil(n / step) - 1) : 0);
        const prior = text.length;
        const url = `${this.root}/completion`;
        const abort = new AbortController();
        const response = await post(
          url,
          {
            prompt,
            n_predict: n,
            temperature,
            top_p: this.config.codeTopP,
            top_k: this.config.codeTopK,
            min_p: this.config.codeMinP,
            presence_penalty: this.config.codePresencePenalty,
            cache_prompt: true,
            return_tokens: true,
            ...(live ? { stream: true, timings_per_token: true, return_progress: true } : { stream: false }),
            ...(thoughtClosed ? { stop: stopWords } : {}),
            ...(userStart ? { message_delimiters: [{ role: 'user', delimiter: userStart }] } : {}),
          },
          this.key,
          timeout,
          0,
          abort.signal,
        );
        const streamed = isEventStream(response);
        // A server that streams chat but answers this as JSON is not judged until the reply ends: later generations go back to chunks.
        if (live && !streamed) this.streams = false;
        const r: Completion = streamed
          ? await this.completionStream(
              response,
              url,
              abort,
              requestTimeoutMs(promptTokens, 0, this.tokensPerSecond),
              step,
              p => progress({ ...p, text: text + p.text, tokens: generated + p.tokens }),
              (t, lines) => repeatCut(text + t, options.around, lines) !== null,
            )
          : await response.json();
        if (typeof r.content !== 'string') throw new Error('Bonsai returned no content');
        const ids: number[] = Array.isArray(r.tokens) ? r.tokens : [];
        text += r.content;
        timings = r.timings;
        prompt = [...prompt, ...ids];
        if (r.exact === false) exact = false;
        if (typeof r.timings?.predicted_per_second === 'number' && r.timings.predicted_per_second > 0)
          this.tokensPerSecond = r.timings.predicted_per_second;
        generated += typeof r.tokens_predicted === 'number' ? r.tokens_predicted : ids.length || n;
        if (!streamed) progress({ text, tokens: generated, perSecond: r.timings?.predicted_per_second });
        if (r.content.endsWith('�')) broken = true;
        const stop: string =
          r.stop_type ?? (r.stopped_limit ? 'limit' : r.stopped_word ? 'word' : r.stopped_eos ? 'eos' : 'none');
        lastStop = stop;
        lastIds = ids;
        lastContent = r.content;
        if (stop === 'word' && typeof r.stopping_word === 'string') stoppingWord = r.stopping_word;
        // The server matches a stop word within one request: a closing fence whose line break ended the
        // previous chunk (the recorded fences are two tokens, the line break then the backticks) and whose
        // backticks start this one is not seen, and what the model wrote after it would be written too.
        const split =
          thoughtClosed && prior && stopWords[0] ? text.indexOf(stopWords[0], prior - stopWords[0].length + 1) : -1;
        if (split >= 0 && split < prior) {
          text = text.slice(0, split);
          finish = 'stop';
          broken = false;
          break;
        }
        if (r.truncated) {
          finish = 'length';
          break;
        }
        if (!thoughtClosed) {
          if (text.includes('</think>')) thoughtClosed = true;
          else if (generated >= thinkingBudget && stop === 'limit') {
            const close = await this.tokenize('\n</think>\n\n');
            prompt = [...prompt, ...close];
            text += '\n</think>\n\n';
            thoughtClosed = true;
            continuations++;
            continue;
          }
        }
        // Ended by the model rather than by the closing fence: the file is not complete.
        if (stop === 'eos' && fence && thoughtClosed) {
          finish = 'eos';
          break;
        }
        // A stream stopped at a repeat ends as a chunk ends at its limit, and is judged and cut as one.
        if (stop !== 'limit') break;
        // A tail that repeats itself is wrong content, the one case to stop
        // generating: the text is cut at the start of the line the repeat begins
        // in and reported as such. The detectors judge the text the ids spell (a
        // chunk can end inside a character).
        if (broken && exact && thoughtClosed) {
          try {
            text = await this.detokenize(prompt.slice(promptTokens));
            broken = text.endsWith('\uFFFD');
          } catch {
            /* keep the concatenation */
          }
        }
        const bodyStart = thinking ? text.indexOf('</think>') + 8 : 0;
        const uncut = text;
        const body = text.slice(bodyStart);
        const repeat = thoughtClosed ? repeatCut(body, options.around) : null;
        if (repeat) {
          cutFrom = uncut;
          text = text.slice(0, bodyStart) + repeat.kept;
          cut = repeat.cut;
          finish = 'repetition';
          break;
        }
        if (generated >= budget) {
          finish = 'length';
          break;
        }
        // Continued by the ids generated, which a stream may not hold all of (a server that caps n_predict
        // below the request's): what it generated is kept, as at the budget.
        if (!exact || r.aborted) {
          finish = 'length';
          break;
        }
        continuations++;
      }
      // The token ids of a stop on a word include that word; the text never does.
      // Never after a cut: the ids still spell what was cut.
      if (broken && exact && !cut) {
        try {
          text = await this.detokenize(prompt.slice(promptTokens));
          if (stoppingWord && text.endsWith(stoppingWord)) text = text.slice(0, -stoppingWord.length);
          // The ids of an end-of-generation stop include the end token, which the content never shows.
          if (lastStop === 'eos' && lastIds.length) {
            const piece = await this.detokenize(lastIds.slice(-1));
            if (piece && text.endsWith(piece) && !lastContent.endsWith(piece)) text = text.slice(0, -piece.length);
          }
        } catch {
          /* keep the concatenation */
        }
      }
      if (thinking) text = text.replace(/^[\s\S]*?<\/think>\s*/, '');
      // A file that reached the budget inside a line: that line is unfinished,
      // so it is left out like a cut one.
      if (finish === 'length' && fence && thoughtClosed && !cut && text !== '' && !text.endsWith('\n')) {
        const c = lineCut(text, text.length, 'budget');
        cutFrom = text;
        text = c.kept;
        cut = c.cut;
      }
      this.lastMeta = {
        ms: performance.now() - start,
        usage: { prompt_tokens: promptTokens, completion_tokens: generated + (plan?.tokens ?? 0) },
        timings,
        finishReason: finish,
        promptTokens,
        continuations,
        ...(plan ? { reasoning: plan.text.trim() } : {}),
      };
      // What a loop cut discarded, so the next detector can be measured on real loops.
      if (cut)
        await this.log(finish === 'repetition' ? 'repetition-cut' : 'budget-cut', {
          requestId,
          ...context,
          kept: text.length,
          generated: cutFrom.length,
          cut,
          discardedTail: cutFrom.slice(-4000),
        });
      await this.log('bonsai', {
        requestId,
        ...context,
        model: this.config.model,
        ms: this.lastMeta.ms,
        prompt: { tokens: promptTokens, mode: 'llama-tokenizer' },
        usage: this.lastMeta.usage,
        timings,
        finishReason: finish,
        continuations,
        raw: true,
        ...(plan
          ? {
              reasoningChars: plan.text.trim().length,
              reasoningForced: plan.forced,
              reasoningTokens: plan.tokens,
              reasoningMs: Math.round(plan.ms),
            }
          : {}),
      });
      return { text, finish, meta: this.lastMeta, ...(cut ? { cut } : {}) };
    } catch (e) {
      await this.log('bonsai-error', {
        requestId,
        ...context,
        ms: performance.now() - start,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}
