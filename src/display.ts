import type { GenerationMeta, Phase } from './types.js';
import type { Hunk } from './diff.js';
import { k, secs, plural, short, row, plain, fitTo, wrap } from './text.js';

// Structured progress from the runner. The display turns it into a live panel
// on a terminal, or plain lines when output is not a terminal.
export type ProgressEvent =
  | { kind: 'step'; step: number; phase: Phase; maxStep: number; turn?: number; maxTurn?: number }
  | {
      kind: 'jev';
      step: number;
      ms: number;
      questions: number;
      stateBytes: number;
      route: [string, number][];
      nouls: Record<string, number>;
    }
  | { kind: 'route'; step: number; route: string; tokens: number; entries: number }
  | {
      kind: 'context';
      step: number;
      tokens: number;
      workingTokens: number;
      contextWindow: number;
      breakdown: Record<string, number>;
      entries: number;
    }
  // tokens: generated so far; prompt: before the first, how far the server has read the prompt (cached tokens included in processed).
  | {
      kind: 'generating';
      step: number;
      route: string;
      attempt: number;
      tokens?: number;
      prompt?: { total: number; cache: number; processed: number };
    }
  // A step reply as it streams: its thought so far, and once its actions have begun each as far as it has come
  // (its own thought, then its route and arguments), and its tokens.
  | { kind: 'reasoning'; step: number; text: string; tokens: number }
  | { kind: 'thinking'; step: number; text: string; actions?: unknown[]; tokens: number }
  // A step's reply once it is complete and valid: the whole thought and the actions it chose.
  | {
      kind: 'thought';
      step: number;
      thought: string;
      actions: { action: string; args: Record<string, any> }[];
      reasoning?: string;
    }
  // A file's content as it is generated: its lines so far and the last of them (open: the last is still being
  // written; from: the file line the block starts at).
  | {
      kind: 'writing';
      step: number;
      route: string;
      path: string;
      from: number;
      lines: number;
      tokens: number;
      perSecond?: number;
      tail: string[];
      open: boolean;
    }
  // file: what a code generation produced (the lines of its text, before it is written).
  | {
      kind: 'generated';
      step: number;
      route: string;
      meta: GenerationMeta | null;
      args: unknown;
      file?: { path: string; from: number; lines: number };
    }
  | { kind: 'generation_error'; step: number; message: string }
  | { kind: 'result'; step: number; route: string; ok: boolean; ms: number; chars: number; text: string }
  | { kind: 'undo'; step: number; files: string[] }
  | { kind: 'warning'; step: number; text: string }
  // An edit as it landed: the file's diff against the content it had (created: it had none).
  | { kind: 'edit'; step: number; path: string; created: boolean; added: number; removed: number; hunks: Hunk[] }
  // Guidance the user gave while the run went on, as it reaches the run.
  | { kind: 'guidance'; step: number; text: string }
  | { kind: 'stop'; step: number; status: string; reason: string };
const quantile = (xs: number[], q: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * q) - 1)]! : null;
export const generationSpeed = (
  m: GenerationMeta | null,
): { generated: number | null; perSecond: number | null; promptPerSecond: number | null; cached: number | null } => {
  if (!m) return { generated: null, perSecond: null, promptPerSecond: null, cached: null };
  const generated = m.usage?.completion_tokens ?? m.timings?.predicted_n ?? null;
  return {
    generated,
    perSecond: m.timings?.predicted_per_second ?? (generated && m.ms ? generated / (m.ms / 1000) : null),
    promptPerSecond: m.timings?.prompt_per_second ?? null,
    cached: m.usage?.prompt_tokens_details?.cached_tokens ?? null,
  };
};
// The value a JSON text that is still being written spells so far: a string up to its last whole character (an
// escape or a surrogate pair cut off waits for the rest), a key without its value and an unfinished number or
// literal left out, and what is open closed. Undefined before a value has begun. A step reply read so streams its
// thought, then each action as far as it has come: the grammar emits properties in the schema's order (thought,
// then actions; in each action its own thought, then its route, then its arguments).
export function partialJson(text: string): any {
  const open: string[] = []; // the closers of the open arrays and objects, innermost last
  let safe = 0;
  let closing = ''; // the longest prefix that closes into a value, and what closes it
  const mark = (at: number) => {
    safe = at;
    closing = [...open].reverse().join('');
  };
  let expect: 'value' | 'key' | 'comma' = 'value';
  const parse = () => {
    try {
      return JSON.parse(text.slice(0, safe) + closing);
    } catch {
      return undefined;
    }
  };
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++;
      continue;
    }
    if (expect === 'comma') {
      if (c === ',') {
        expect = open.at(-1) === '}' ? 'key' : 'value';
        i++;
        continue;
      }
      if (c !== open.at(-1)) return parse();
      open.pop();
      mark(++i);
      continue;
    }
    if (expect === 'key') {
      if (c === '}' && open.at(-1) === '}') {
        open.pop();
        mark(++i);
        expect = 'comma';
        continue;
      }
      if (c !== '"') return parse();
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      for (j++; j < text.length && /\s/.test(text[j]!); j++);
      if (j >= text.length) break;
      if (text[j] !== ':') return parse();
      i = j + 1;
      expect = 'value';
      continue;
    }
    if (c === '{' || c === '[') {
      open.push(c === '{' ? '}' : ']');
      mark(++i);
      expect = c === '{' ? 'key' : 'value';
      continue;
    }
    if (c === ']' && open.at(-1) === ']') {
      open.pop();
      mark(++i);
      expect = 'comma';
      continue;
    }
    if (c === '"') {
      // Inside a string every whole character is a place to close it, but the first half of a surrogate pair.
      const closers = `"${[...open].reverse().join('')}`;
      let j = i + 1;
      const at = (n: number, high: boolean) => {
        if (!high) {
          safe = n;
          closing = closers;
        }
      };
      while (j < text.length && text[j] !== '"') {
        if (text[j] !== '\\') {
          const high = text[j]! >= '\ud800' && text[j]! <= '\udbff';
          at(++j, high);
          continue;
        }
        const e = text[j + 1];
        if (e === undefined) break;
        if (e !== 'u') {
          at((j += 2), false);
          continue;
        }
        const hex = text.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        const code = parseInt(hex, 16);
        at((j += 6), code >= 0xd800 && code <= 0xdbff);
      }
      if (j >= text.length || text[j] !== '"') break;
      mark((i = j + 1));
      expect = 'comma';
      continue;
    }
    // A number or a literal, whole once something follows it.
    const token = /^[-+0-9.eEa-z]+/.exec(text.slice(i, i + 40))?.[0];
    if (!token) return parse();
    if (i + token.length >= text.length) break;
    mark((i += token.length));
    expect = 'comma';
  }
  return parse();
}
// The last n lines of a text being written, how many lines it has (an unfinished last line counts), and
// whether the last is unfinished.
export function tailLines(text: string, n: number): { lines: number; tail: string[]; open: boolean } {
  const all = text.replace(/\r?\n$/, '').split(/\r?\n/);
  return { lines: text ? all.length : 0, tail: text ? all.slice(-n) : [], open: text !== '' && !text.endsWith('\n') };
}
// One action as a short phrase: its route and what it acts on, as far as its arguments have come.
export function actionSummary(action: string, a: Record<string, any>): string {
  const range = (x: any) => (x?.start !== undefined ? ` ${x.start}..${x.end ?? ''}` : '');
  const list = (x: unknown): any[] => (Array.isArray(x) ? x : []);
  const what =
    action === 'read_files'
      ? list(a.files)
          .map((f: any) => `${f?.path ?? ''}${range(f)}`)
          .join(', ')
      : action === 'bash'
        ? a.command
        : action === 'search_codebase'
          ? `${a.query === undefined ? '' : JSON.stringify(a.query)}${a.path === undefined ? '' : ` in ${a.path}`}`
          : action === 'move_lines'
            ? `${a.source ?? ''}${range(a)}${a.destination === undefined ? '' : ` -> ${a.destination}`}`
            : action === 'replace_lines'
              ? `${a.path ?? ''} ${list(a.edits)
                  .map((x: any) => `${x?.start ?? ''}..${x?.end ?? ''}`)
                  .join(', ')}`
              : a.path !== undefined
                ? `${a.path}${range(a)}`
                : action === 'plan'
                  ? a.notes
                  : action === 'finish'
                    ? a.summary
                    : action === 'ask_user'
                      ? a.question
                      : action === 'observe'
                        ? [a.kind, a.target].filter(x => x !== undefined).join(' ')
                        : '';
  const flat = plain(String(what ?? ''));
  return flat ? `${action} ${short(flat, 200)}` : action;
}
// The same facts as plain lines, one per phase, for logs and non-terminal output.
export function describe(e: ProgressEvent, verbose: boolean): string | null {
  const p = `[${e.step}]  `;
  switch (e.kind) {
    case 'jev':
      return verbose
        ? `${p} jev ${e.ms.toFixed(0)}ms | ${e.questions} questions | state ${(e.stateBytes / 1000).toFixed(1)}k bytes | route ${e.route.map(([r, v]) => `${r} ${v.toFixed(2)}`).join(', ')} | ${Object.entries(
            e.nouls,
          )
            .map(([n, v]) => `${n} ${v.toFixed(2)}`)
            .join(' | ')}`
        : null;
    case 'route':
      return `[${e.step}] ${e.route} | ${e.tokens} prompt tokens | ${e.entries} evidence entries`;
    case 'context': {
      if (!verbose) return null;
      const top = Object.entries(e.breakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, v]) => `${n} ${(v / 1000).toFixed(1)}k`)
        .join(', ');
      return `${p} context ${e.tokens} tokens = ${Math.round((100 * e.tokens) / e.workingTokens)}% of ${e.workingTokens} working (${Math.round((100 * e.tokens) / e.contextWindow)}% of window) | chars: ${top}`;
    }
    // A code generation is recorded by what it produced, how it ended (a cut is told in the warning after it)
    // and what it cost; a step's arguments are its thought and actions, printed whole after it.
    case 'generated': {
      const s = generationSpeed(e.meta);
      const m = e.meta;
      const f = e.file;
      // The thought before a file's code (codeThinking), printed whole above what was generated.
      const thought = f && m?.reasoning ? `[${e.step}] reasoning for ${f.path}: ${plain(m.reasoning)}` : null;
      const file = f
        ? `[${e.step}] generated ${f.path}${f.from > 1 ? ` from line ${f.from}` : ''} | ${plural(f.lines, 'line')} | ${s.generated == null ? '? tokens' : plural(s.generated, 'token')} | ${m ? secs(m.ms) : '-'}${s.perSecond ? ` | ${s.perSecond.toFixed(1)} tok/s` : ''}${m?.finishReason && m.finishReason !== 'stop' ? ` | ${m.finishReason}` : ''}`
        : null;
      if (!verbose) return [thought, file].filter(Boolean).join('\n') || null;
      return [
        thought,
        file,
        `${p} bonsai ${m ? secs(m.ms) : '-'} | ${s.generated ?? '?'} generated tokens${s.perSecond ? ` @ ${s.perSecond.toFixed(1)} tok/s` : ''}${s.promptPerSecond ? ` | prompt ${m?.timings?.prompt_n ?? m?.promptTokens} tokens @ ${s.promptPerSecond.toFixed(0)} tok/s` : ''}${s.cached ? ` | ${s.cached} cached` : ''} | finish ${m?.finishReason ?? '?'}`,
        e.route === 'step' ? null : `${p} args ${short(JSON.stringify(e.args), 300)}`,
      ]
        .filter(l => l !== null)
        .join('\n');
    }
    // Why nothing ran: a reply that failed or was cut short, a refused action, a lost connection.
    case 'generation_error':
      return `[${e.step}] no action: ${e.message}`;
    case 'result':
      return verbose
        ? `${p} result ${e.ok ? 'ok' : 'FAILED'} | ${e.ms.toFixed(0)}ms | ${e.chars} chars | ${short(e.text.replace(/\s+/g, ' '), 200)}`
        : null;
    case 'undo':
      return `[${e.step}] undo | reverting ${e.files.join(', ')}`;
    // The step's thought whole, and what it chose; never a reply still being written.
    // The model's own thinking first, when it thought before replying (stepThinking).
    case 'thought':
      return `${e.reasoning ? `[${e.step}] reasoning: ${plain(e.reasoning)}\n` : ''}[${e.step}] thought: ${plain(e.thought)}\n[${e.step}] actions: ${e.actions.map(a => actionSummary(a.action, a.args)).join(' | ')}`;
    case 'warning':
      return `warning | ${e.text}`;
    case 'edit':
      return `[${e.step}] ${e.created ? 'created' : 'edited'} ${e.path} (+${e.added} -${e.removed})`;
    case 'guidance':
      return `[${e.step}] the user added: ${plain(e.text)}`;
    default:
      return null;
  }
}
export function lineObserver(write: (line: string) => void, verbose: boolean): (e: ProgressEvent) => void {
  return e => {
    const line = describe(e, verbose);
    if (line) write(line);
  };
}
interface Stream {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}
// The rows the generation under way takes under the panel: a thought's last rows and its actions, or a file's last lines.
export const liveHeight = 7;
// What a run's generations consumed, as the provider reported it: requests, prompt tokens (cached: of them, read
// from the provider's cache), completion tokens, and the cost when the provider states one (OpenRouter does).
export interface Usage {
  requests: number;
  input: number;
  cached: number;
  output: number;
  cost: number | null;
}
export const noUsage = (): Usage => ({ requests: 0, input: 0, cached: 0, output: 0, cost: null });
// One request's usage as the provider reported it, or null.
export function usageOf(meta: GenerationMeta | null | undefined): Usage | null {
  const u = meta?.usage;
  if (!u || typeof u.prompt_tokens !== 'number') return null;
  const cost = Number(u.cost);
  return {
    requests: 1,
    input: u.prompt_tokens,
    cached: Number(u.prompt_tokens_details?.cached_tokens) || 0,
    output: Number(u.completion_tokens) || 0,
    cost: Number.isFinite(cost) && u.cost !== undefined ? cost : null,
  };
}
export function addUsage(total: Usage, u: Usage): void {
  total.requests += u.requests;
  total.input += u.input;
  total.cached += u.cached;
  total.output += u.output;
  if (u.cost !== null) total.cost = (total.cost ?? 0) + u.cost;
}
const dollars = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
// Usage in words: "12.3k in (10.1k cached, 82%) | 1.2k out | $0.004", with the request count for a total.
export function usageLine(u: Usage, requests = true): string {
  const share = u.input ? Math.round((100 * u.cached) / u.input) : 0;
  return `${requests ? `${u.requests} request${u.requests === 1 ? '' : 's'} | ` : ''}${k(u.input)} in${u.cached ? ` (${k(u.cached)} cached, ${share}%)` : ''} | ${k(u.output)} out${u.cost !== null ? ` | ${dollars(u.cost)}` : ''}`;
}
// A status panel redrawn in place at the bottom of the terminal, with a
// scrolling log of completed steps above it.
// What shows a run as it goes: every progress event and log line, the usage it adds up, and its end.
export interface RunView {
  update(e: ProgressEvent): void;
  log(line: string): void;
  close(): void;
  readonly usage: Usage;
}
export interface RunViewOptions {
  objective: string;
  session: string;
  verbose: boolean;
  model?: string;
  name?: string;
}
export class Display implements RunView {
  private started = Date.now();
  private jevMs: number[] = [];
  private tps: number[] = [];
  // What the run's generations consumed so far, and the last one's, as the provider reported them.
  readonly usage: Usage = noUsage();
  private lastUsage = '';
  private generatedTokens = 0;
  private routes: Record<string, number> = {};
  private edits = 0;
  private checks = 0;
  private failures = 0;
  private undos = 0;
  private step = 0;
  private maxStep = 0;
  private turn = 0;
  private maxTurn = 0;
  private phase = '';
  private status = 'running';
  private lastJev = '';
  private context = '';
  private contextFill = 0;
  private bonsai = '';
  private now = 'starting';
  private last = '';
  private panelLines = 0;
  private timer: NodeJS.Timeout | null = null;
  // What is being generated, shown live under the panel: a step's thought, or a file's last lines. Once one
  // has been shown its rows stay (blank between generations), so the panel does not jump as they start and end.
  private live: Extract<ProgressEvent, { kind: 'reasoning' | 'thinking' | 'writing' }> | null = null;
  private liveShown = false;
  // The model's name in the panel: Bonsai's own, or the last part of another model's id.
  private get who(): string {
    return this.opts.name ?? 'Bonsai';
  }
  constructor(
    private out: Stream,
    private opts: RunViewOptions,
  ) {
    if (out.isTTY) {
      this.timer = setInterval(() => this.render(), 1000);
      this.timer.unref?.();
    }
  }
  private width(): number {
    return Math.max(20, this.out.columns ?? 100);
  }
  // Never fill the last column: a full-width line makes the cursor wrap, which
  // adds a row the cursor-up count does not know about and leaks lines each tick.
  // One physical row per logical line (row), its width counted in cells.
  private fit(s: string): string {
    return fitTo(row(s), this.width() - 1);
  }
  log(line: string): void {
    this.print(line, false);
  }
  // Lines that scroll above the panel: fitted to one row each, or word-wrapped (a step's thought and actions, a
  // generation's outcome, a warning), whose rows are indented under the text after their label. They are never
  // redrawn, so wrapping them does not change what the cursor-up count must know.
  private print(line: string, wrapped: boolean): void {
    if (!this.out.isTTY) {
      this.out.write(`${line}\n`);
      return;
    }
    const rows = line.split('\n').flatMap(l => {
      if (!wrapped) return [this.fit(l)];
      const flat = row(l);
      return wrap(flat, this.width() - 1, /^\[\d+\] \w+: |^warning \| |^\[\d+\] /.exec(flat)?.[0].length ?? 0);
    });
    this.clearPanel();
    this.out.write(`${rows.join('\n')}\n`);
    this.render();
  }
  update(e: ProgressEvent): void {
    switch (e.kind) {
      case 'step':
        this.step = e.step;
        this.maxStep = e.maxStep;
        this.turn = e.turn ?? 0;
        this.maxTurn = e.maxTurn ?? 0;
        this.phase = e.phase;
        this.now = 'asking Jev for the next action';
        break;
      case 'jev':
        this.jevMs.push(e.ms);
        this.lastJev = `${secs(e.ms)} | ${e.questions} q | state ${(e.stateBytes / 1000).toFixed(1)}k | ${e.route
          .slice(0, 3)
          .map(([r, v]) => `${r} ${v.toFixed(2)}`)
          .join(' | ')} | ${Object.entries(e.nouls)
          .slice(0, 4)
          .map(([n, v]) => `${n} ${v.toFixed(2)}`)
          .join(' | ')}`;
        break;
      case 'route':
        this.routes[e.route] = (this.routes[e.route] ?? 0) + 1;
        this.now = `counting the ${e.route} prompt`;
        break;
      case 'context': {
        this.contextFill = e.tokens / e.workingTokens;
        const top = Object.entries(e.breakdown)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([n, v]) => `${n} ${k(v)}`)
          .join(' | ');
        this.context = `${k(e.tokens)} / ${k(e.workingTokens)} working (${Math.round(100 * this.contextFill)}%) | window ${k(e.contextWindow)} (${Math.round((100 * e.tokens) / e.contextWindow)}%) | ${e.entries} entries | ${top}`;
        break;
      }
      case 'generating': {
        const p = e.prompt;
        this.now = p
          ? `${this.who} reading the ${e.route} prompt | ${k(p.processed - p.cache)} / ${k(p.total - p.cache)} tokens${p.cache ? ` | ${k(p.cache)} cached` : ''}`
          : `${e.route === 'create_file' || e.route === 'rewrite_file' ? `${this.who} writing the file as code` : `${this.who} generating ${e.route} arguments${e.attempt > 1 ? ' (retry)' : ''}`}${e.tokens ? ` | ${plural(e.tokens, 'token')}` : ''}`;
        break;
      }
      case 'reasoning':
        this.live = e;
        this.liveShown = true;
        this.now = `${this.who} reasoning | ${plural(e.tokens, 'token')}`;
        break;
      case 'thinking':
        this.live = e;
        this.liveShown = true;
        this.now = `${this.who} ${e.actions ? 'choosing the actions' : 'thinking'} | ${plural(e.tokens, 'token')}`;
        break;
      case 'writing':
        this.live = e;
        this.liveShown = true;
        this.now = `${this.who} writing ${e.path}${e.from > 1 ? ` from line ${e.from}` : ''} | ${plural(e.lines, 'line')} | ${plural(e.tokens, 'token')}${e.perSecond ? ` | ${e.perSecond.toFixed(1)} tok/s` : ''}`;
        break;
      case 'thought':
        this.live = null;
        break;
      case 'generated': {
        this.live = null;
        const s = generationSpeed(e.meta);
        if (s.perSecond) this.tps.push(s.perSecond);
        if (s.generated) this.generatedTokens += s.generated;
        const used = usageOf(e.meta);
        if (used) {
          addUsage(this.usage, used);
          this.lastUsage = usageLine(used, false);
        }
        this.bonsai = `${e.meta ? secs(e.meta.ms) : '-'} | ${s.generated ?? '?'} tokens${s.perSecond ? ` @ ${s.perSecond.toFixed(1)} tok/s` : ''}${s.promptPerSecond ? ` | prompt @ ${s.promptPerSecond.toFixed(0)} tok/s` : ''}${s.cached ? ` | ${s.cached} cached` : ''} | ${short(JSON.stringify(e.args), 90)}`;
        this.now = `running ${e.route}`;
        break;
      }
      case 'generation_error':
        this.live = null;
        this.failures++;
        this.last = `[${e.step}] no action: ${e.message}`;
        this.now = 'asking Jev for the next action';
        break;
      case 'result': {
        this.live = null;
        if (['create_file', 'write', 'replace_lines', 'move_lines'].includes(e.route) && e.ok) this.edits++;
        if (e.route === 'bash') this.checks++;
        if (!e.ok) this.failures++;
        this.last = `[${e.step}] ${e.route} ${e.ok ? 'ok' : 'FAILED'} ${secs(e.ms)} -> ${k(e.chars)} chars: ${e.text.replace(/\s+/g, ' ')}`;
        this.now = 'asking Jev for the next action';
        break;
      }
      case 'undo':
        this.undos++;
        this.last = `[${e.step}] undo: reverted ${e.files.join(', ')}`;
        break;
      case 'stop':
        this.live = null;
        this.status = `${e.status.toUpperCase()}: ${e.reason}`;
        this.now = 'stopped';
        break;
    }
    const line = describe(e, this.opts.verbose);
    if (line) this.print(line, e.kind === 'thought' || e.kind === 'warning' || e.kind === 'generated');
    else if (this.out.isTTY) this.render();
  }
  // ASCII only: box-drawing, block and middle-dot characters are ambiguous-width
  // and some terminals render them two cells wide, which breaks in-place redraws.
  private bar(fill: number, width = 20): string {
    const n = Math.max(0, Math.min(width, Math.round(fill * width)));
    return `[${'#'.repeat(n)}${'.'.repeat(width - n)}]`;
  }
  // The panel, never taller than the screen less the cursor's row: a taller one scrolls its top rows into the
  // scrollback at every redraw (the cursor cannot move up past the screen). The live rows take what the
  // screen leaves them; on a screen too short for the panel itself its top rows go.
  panel(): string[] {
    const elapsed = Math.round((Date.now() - this.started) / 1000);
    // Turned by the clock, so it turns at one speed however often the panel is drawn.
    const spinner = '|/-\\'[elapsed % 4];
    const routes = Object.entries(this.routes)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`)
      .join(' | ');
    const avgTps = this.tps.length ? this.tps.reduce((a, b) => a + b, 0) / this.tps.length : null;
    const rows = [
      '-'.repeat(this.width() - 1),
      `Leana | ${this.opts.session}${this.opts.model ? ` | ${this.opts.model}` : ''} | ${this.maxTurn ? `turn ${this.turn}/${this.maxTurn} | step ${this.step}` : `step ${this.step}${this.maxStep ? `/${this.maxStep}` : ''}`} | ${this.phase} | ${this.status} | ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed`,
      `Objective  ${this.opts.objective.replace(/\s+/g, ' ')}`,
      `Jev        ${this.lastJev || '-'}`,
      `           median ${secs(quantile(this.jevMs, 0.5))} | p95 ${secs(quantile(this.jevMs, 0.95))} | ${this.jevMs.length} calls`,
      `Context    ${this.bar(this.contextFill)} ${this.context || '-'}`,
      `${this.who.slice(0, 10).padEnd(11)}${this.bonsai || '-'}`,
      `           avg ${avgTps ? `${avgTps.toFixed(1)} tok/s` : '-'} | ${k(this.generatedTokens)} generated | last ${this.lastUsage || '-'}`,
      `Usage      ${this.usage.requests ? usageLine(this.usage) : '-'}`,
      `Now        ${this.now === 'stopped' ? '' : `${spinner} `}${this.now}`,
      `Last       ${this.last || '-'}`,
      `Totals     ${routes || '-'} | ${this.edits} edits | ${this.checks} commands | ${this.failures} failures | ${this.undos} undo`,
    ].map(l => this.fit(l));
    const screen = this.out.rows ? Math.max(1, this.out.rows - 1) : Infinity;
    const height = this.liveShown ? Math.max(0, Math.min(liveHeight, screen - rows.length)) : 0;
    const live = this.liveRows(height).map(l => fitTo(l, this.width() - 1));
    return rows.concat(live, Array<string>(height - live.length).fill('')).slice(-screen);
  }
  // The generation under way in `height` rows: the last rows of the thought as it is written and each action as
  // far as it has come (the latest kept when they do not all fit), or the file's last lines, numbered as in the
  // file, a line still being written shown by its end. Never the whole of either.
  private liveRows(height: number): string[] {
    const e = this.live;
    const w = this.width() - 1 - 11;
    if (!e || height <= 0) return [];
    const label = (s: string) => s.padEnd(11);
    if (e.kind === 'writing') {
      const shown = e.tail.slice(-height);
      const first = e.from + e.lines - shown.length;
      return shown.map(
        (l, i) =>
          `${label(i ? '' : 'Writing')}${String(first + i).padStart(5)} | ${fitTo(row(l.replace(/\t/g, '  ')), w - 8, e.open && i === shown.length - 1)}`,
      );
    }
    // The model's own thinking, by its last rows: it can run to stepThinkingBudget tokens.
    if (e.kind === 'reasoning') {
      const rows = e.text.trim() ? wrap(plain(e.text), w) : [];
      return rows.slice(-height).map((r, i) => `${label(i ? '' : 'Reasoning')}${r}`);
    }
    const actions = (e.actions ?? [])
      .map(
        (a: any, i) =>
          `${label(`Action ${i + 1}`)}${fitTo(typeof a?.action === 'string' ? actionSummary(a.action, a.args && typeof a.args === 'object' ? a.args : {}) : '', w)}`,
      )
      .slice(-height);
    const thought = e.text.trim() ? wrap(plain(e.text), w) : [];
    return thought
      .slice(thought.length - Math.min(thought.length, height - actions.length))
      .map((r, i) => `${label(i ? '' : 'Thinking')}${r}`)
      .concat(actions);
  }
  private clearPanel(): void {
    if (this.panelLines) this.out.write(`\x1b[${this.panelLines}A\x1b[J`);
    this.panelLines = 0;
  }
  // In one write, the clearing with the drawing, so a redraw at streaming rates does not flicker.
  render(): void {
    if (!this.out.isTTY) return;
    const clear = this.panelLines ? `\x1b[${this.panelLines}A\x1b[J` : '';
    const lines = this.panel();
    this.out.write(`${clear}${lines.join('\n')}\n`);
    this.panelLines = lines.length;
  }
  // The last panel stays on screen, without the rows kept for generations.
  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.out.isTTY) {
      this.clearPanel();
      this.liveShown = false;
      this.out.write(`${this.panel().join('\n')}\n`);
      this.panelLines = 0;
    }
  }
}
