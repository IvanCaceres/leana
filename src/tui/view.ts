// Leana as a full-screen terminal app: a status bar (model, step, context, tokens, cost, time), the conversation
// as blocks that scroll and fold, and an input box that stays at the bottom. Between runs the input takes an
// objective or a /command; during a run it takes guidance, which reaches the run at its next step. Frames are
// drawn at most every 16 ms, whatever arrives in between, and only the rows that changed are written.
import { dirname, join } from 'node:path';
import { actionSummary, addUsage, noUsage, usageLine, usageOf } from '../display.js';
import type { ProgressEvent, RunView, RunViewOptions, Usage } from '../display.js';
import { cells, fitTo, k, plural, row, secs } from '../text.js';
import type { Key } from './keys.js';
import { Terminal } from './terminal.js';
import { styles, Transcript, type Block, type BodyLine, type Styles, type Tone } from './transcript.js';

export interface UIOptions {
  terminal?: Terminal;
  color?: boolean;
  // A line the user entered: an objective or a command between runs, guidance during one.
  submit(line: string): void;
  // Ctrl-C: stop the run after its step, or (between runs) leave when pressed twice.
  interrupt(): void;
  // Completions of a /command being typed, and the part of the line they replace.
  complete?(line: string): [string[], string];
}
interface Status {
  title: string;
  model: string;
  state: 'idle' | 'running' | 'stopping';
  step: number;
  maxStep: number;
  turn: number;
  maxTurn: number;
  phase: string;
  context: { tokens: number; working: number } | null;
  usage: Usage;
  startedAt: number | null;
  endedMs: number | null;
  now: string;
}
const spinner = ['|', '/', '-', '\\'];
// The most of one result a block holds (a command's output can be a megabyte): what is left out is counted, and
// the file holding all of it named.
const resultChars = 200_000;
// A tool's result as the conversation shows it: whole, as the tool returned it (the model's own copy is clipped to
// its context budget; this is not). Commands and searches answer in JSON ({command, output, code, ...}): they are
// shown as the command and its exit, and the output as its lines; notes the harness added follow. saved is the file
// the result was archived to; a command's output too long to keep in memory was saved whole beside it.
export function resultView(route: string, text: string, saved?: string): { head: string; lines: string[] } {
  const [first = '', ...notes] = text.split('\n');
  let head = first;
  let lines = notes;
  let whole = saved;
  try {
    const r = JSON.parse(first);
    if (r && typeof r === 'object' && typeof r.output === 'string') {
      const output = r.output.replace(/\n$/, '').split('\n');
      head =
        route === 'bash'
          ? `$ ${String(r.command ?? '')} | exit ${r.code ?? '?'}${r.timedOut ? ' (timed out)' : ''}`
          : `${output.length} line${output.length === 1 ? '' : 's'}`;
      const said = [r.stoppedEarly, r.stoppedAtEnd].filter((x): x is string => typeof x === 'string');
      // Output too long to keep was saved whole: where, said first (it would be past the cap below).
      if (typeof r.wholeOutput === 'string') {
        whole = saved ? join(dirname(saved), r.wholeOutput.replace(/^@artifact\//, '')) : r.wholeOutput;
        output.unshift(`The whole output is saved at ${whole}; ${r.omitted} bytes of it are left out below`);
      }
      lines = [...output, ...said, ...notes];
    }
  } catch {
    /* not JSON: the first line is the head */
  }
  let room = resultChars;
  const kept: string[] = [];
  for (const l of lines) {
    if (l.length > room) break;
    kept.push(l);
    room -= l.length + 1;
  }
  const left = lines.slice(kept.length).reduce((n, l) => n + l.length + 1, 0);
  if (left > 0)
    kept.push(`... ${left} more characters of this result are not shown${whole ? `; all of it is in ${whole}` : ''}`);
  return { head, lines: kept };
}
// A diff block holds at most this many lines (a whole new file can be thousands): the rest is counted.
const diffRows = 400;
const bounded = (lines: BodyLine[]): BodyLine[] =>
  lines.length <= diffRows
    ? lines
    : [
        ...lines.slice(0, diffRows),
        { mark: '@', text: `... ${lines.length - diffRows} more lines of the diff are not shown` },
      ];
const clock = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

export class TerminalUI {
  readonly transcript = new Transcript();
  private readonly term: Terminal;
  private readonly s: Styles;
  private status: Status;
  private input = '';
  private cursor = 0;
  private history: string[] = [];
  private historyAt = -1;
  // Rows scrolled up from the end of the conversation; 0 follows it as it grows.
  private scroll = 0;
  private browsing = false;
  private selected: number | null = null;
  private live: Block | null = null;
  private pending: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  constructor(private readonly opts: UIOptions & { title: string; model: string }) {
    this.term = opts.terminal ?? new Terminal();
    this.s = styles(opts.color ?? !process.env.NO_COLOR);
    this.status = {
      title: opts.title,
      model: opts.model,
      state: 'idle',
      step: 0,
      maxStep: 0,
      turn: 0,
      maxTurn: 0,
      phase: '',
      context: null,
      usage: noUsage(),
      startedAt: null,
      endedMs: null,
      now: '',
    };
  }
  start(): void {
    this.term.enter(
      keys => this.keys(keys),
      () => this.draw(),
    );
    this.draw();
  }
  stop(): void {
    if (this.pending) clearTimeout(this.pending);
    if (this.ticker) clearInterval(this.ticker);
    this.pending = this.ticker = null;
    this.term.leave();
  }
  setMouse(on: boolean): void {
    this.term.setMouse(on);
  }
  setModel(model: string): void {
    this.status.model = model;
    this.schedule();
  }
  // Text the app prints (command output, notes, a run's outcome) as a block: its first line the title, and the
  // whole of a first line too long for a title (an outcome's summary) in the body as well.
  message(text: string, tone: Tone = 'info'): void {
    const [first = '', ...rest] = text.replace(/^\n+/, '').split('\n');
    const body = first.length > 100 ? [first, ...rest] : rest;
    this.transcript.add(tone, first, body, { collapsed: tone !== 'outcome' && body.length > 12, preview: 8 });
    this.schedule();
  }
  stopping(): void {
    if (this.status.state === 'running') this.status.state = 'stopping';
    this.schedule();
  }

  // A run shown in the conversation as it goes.
  run(o: RunViewOptions): RunView {
    const usage = noUsage();
    const st = this.status;
    Object.assign(st, {
      state: 'running',
      model: o.model ?? st.model,
      step: 0,
      maxStep: 0,
      turn: 0,
      maxTurn: 0,
      phase: '',
      context: null,
      usage,
      startedAt: Date.now(),
      endedMs: null,
      now: 'starting',
    });
    this.ticker ??= setInterval(() => this.schedule(), 250);
    this.ticker.unref?.();
    return {
      usage,
      update: e => {
        this.event(e, usage);
        this.schedule();
      },
      log: line => {
        this.transcript.add('info', line);
        this.schedule();
      },
      close: () => {
        this.endLive();
        st.state = 'idle';
        st.endedMs = st.startedAt === null ? null : Date.now() - st.startedAt;
        st.now = '';
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        this.schedule();
      },
    };
  }

  // A progress event as the conversation and the status bar show it.
  private event(e: ProgressEvent, usage: Usage): void {
    const st = this.status;
    const t = this.transcript;
    switch (e.kind) {
      case 'step':
        Object.assign(st, {
          step: e.step,
          maxStep: e.maxStep,
          turn: e.turn ?? 0,
          maxTurn: e.maxTurn ?? 0,
          phase: e.phase,
        });
        st.now = 'deciding the next step';
        break;
      case 'context':
        st.context = { tokens: e.tokens, working: e.workingTokens };
        break;
      case 'route':
        st.now = `preparing the ${e.route} prompt`;
        break;
      case 'generating':
        st.now = e.prompt
          ? `reading the prompt ${k(e.prompt.processed)}/${k(e.prompt.total)}`
          : `generating ${e.route}${e.tokens ? ` | ${plural(e.tokens, 'token')}` : ''}`;
        break;
      case 'reasoning':
        this.setLive('thought', 'Reasoning', [e.text.trim()]);
        st.now = `reasoning | ${plural(e.tokens, 'token')}`;
        break;
      case 'thinking': {
        const actions = (e.actions ?? []).map((a: any) =>
          typeof a?.action === 'string'
            ? `-> ${actionSummary(a.action, a.args && typeof a.args === 'object' ? a.args : {})}`
            : '',
        );
        this.setLive('thought', 'Thinking', [e.text.trim(), ...actions.filter(Boolean)].filter(Boolean));
        st.now = `${e.actions ? 'choosing the actions' : 'thinking'} | ${plural(e.tokens, 'token')}`;
        break;
      }
      case 'writing': {
        const first = e.from + e.lines - e.tail.length;
        this.setLive(
          'diff',
          `Writing ${e.path}`,
          e.tail.map((text, i): BodyLine => ({ mark: '+', text, number: first + i })),
        );
        st.now = `writing ${e.path} | ${plural(e.lines, 'line')} | ${plural(e.tokens, 'token')}`;
        break;
      }
      case 'thought':
        this.endLive();
        t.add(
          'thought',
          `Step ${e.step}`,
          [
            ...(e.thought.trim() ? [e.thought.trim()] : []),
            ...e.actions.map(a => `-> ${actionSummary(a.action, a.args)}`),
          ],
          { preview: 6 },
        );
        break;
      case 'generated': {
        this.endLive();
        const used = usageOf(e.meta);
        if (used) addUsage(usage, used);
        st.now = `running ${e.route}`;
        break;
      }
      case 'result': {
        const shown = resultView(e.route, e.text, e.saved);
        t.add(
          e.ok ? 'ok' : 'fail',
          `${e.route} ${e.ok ? 'ok' : 'failed'} | ${secs(e.ms)} | ${shown.head}`,
          shown.lines,
          {
            collapsed: true,
            preview: e.ok ? 0 : 6,
          },
        );
        break;
      }
      case 'edit':
        t.add(
          'diff',
          `${e.created ? 'Created' : 'Edited'} ${e.path} (+${e.added} -${e.removed})`,
          bounded(
            e.hunks.flatMap((h): BodyLine[] => [
              { mark: '@', text: `@@ -${h.oldStart} +${h.newStart} @@` },
              ...h.lines.map((l): BodyLine => ({ mark: l.kind, text: l.text, number: l.kind === '-' ? l.old : l.new })),
            ]),
          ),
          { collapsed: e.added + e.removed > 40, preview: 24 },
        );
        break;
      case 'guidance':
        t.add('info', `Step ${e.step} took your guidance; it is part of the objective now.`);
        break;
      case 'generation_error':
        this.endLive();
        t.add('warn', `No action: ${e.message}`);
        break;
      case 'warning':
        t.add('warn', e.text);
        break;
      case 'undo':
        t.add('info', `Undone: ${e.files.join(', ')}`);
        break;
      case 'stop':
        this.endLive();
        st.now = '';
        break;
      default:
        break;
    }
  }
  private setLive(tone: Tone, title: string, body: BodyLine[]): void {
    if (!this.live) this.live = this.transcript.add('live', title, body);
    this.transcript.change(this.live, { tone: tone === 'diff' ? 'diff' : 'live', title, body });
  }
  private endLive(): void {
    if (this.live) this.transcript.remove(this.live);
    this.live = null;
  }

  // Input.
  private keys(keys: Key[]): void {
    for (const key of keys) this.key(key);
    this.schedule();
  }
  private key(key: Key): void {
    if (key.name === 'ctrl') return this.ctrl(key.key);
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const page = Math.max(1, this.conversationHeight() - 2);
      return this.scrollBy(key.name === 'pageup' ? page : -page);
    }
    if (key.name === 'wheelup' || key.name === 'wheeldown') return this.scrollBy(key.name === 'wheelup' ? 3 : -3);
    if (key.name === 'tab' || key.name === 'shift-tab') return this.tab();
    if (this.browsing) return this.browse(key);
    switch (key.name) {
      case 'text':
      case 'paste':
        return this.insert(key.text);
      case 'enter':
        return this.enter();
      case 'backspace':
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor--;
        }
        return;
      case 'delete':
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        return;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      case 'right':
        this.cursor = Math.min(this.input.length, this.cursor + 1);
        return;
      case 'home':
        this.cursor = 0;
        return;
      case 'end':
        this.cursor = this.input.length;
        return;
      case 'up':
      case 'down':
        return this.recall(key.name === 'up' ? 1 : -1);
      case 'escape':
        if (this.scroll) this.scroll = 0;
        else this.setInput('');
        return;
      default:
        return;
    }
  }
  private ctrl(c: string): void {
    if (c === 'c') return this.opts.interrupt();
    if (c === 'a') this.cursor = 0;
    else if (c === 'e') this.cursor = this.input.length;
    else if (c === 'u') this.setInput(this.input.slice(this.cursor), 0);
    else if (c === 'k') this.input = this.input.slice(0, this.cursor);
    else if (c === 'w') {
      const head = this.input.slice(0, this.cursor).replace(/\S+\s*$/, '');
      this.input = head + this.input.slice(this.cursor);
      this.cursor = head.length;
    } else if (c === 'l') this.redraw();
  }
  private insert(text: string): void {
    this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
  }
  private setInput(text: string, cursor = text.length): void {
    this.input = text;
    this.cursor = cursor;
  }
  private enter(): void {
    const line = this.input.trim();
    if (!line) return;
    if (this.history[0] !== line) this.history.unshift(line);
    this.history.length = Math.min(this.history.length, 500);
    this.historyAt = -1;
    this.setInput('');
    this.scroll = 0;
    this.opts.submit(line);
  }
  private recall(dir: 1 | -1): void {
    const at = Math.max(-1, Math.min(this.history.length - 1, this.historyAt + dir));
    if (at === this.historyAt) return;
    this.historyAt = at;
    this.setInput(at < 0 ? '' : this.history[at]!);
  }
  // Tab completes a /command; anywhere else it moves between the input and browsing the conversation.
  private tab(): void {
    if (!this.browsing && this.input.startsWith('/') && this.opts.complete) {
      const [hits, part] = this.opts.complete(this.input);
      if (hits.length === 1) this.setInput(this.input.slice(0, this.input.length - part.length) + hits[0]!);
      else if (hits.length > 1) this.message(`Completions: ${hits.join('  ')}`);
      return;
    }
    this.browsing = !this.browsing;
    const foldable = this.transcript.list.filter(b => b.body.length);
    this.selected = this.browsing ? (foldable.at(-1)?.id ?? null) : null;
    this.reveal();
  }
  private browse(key: Key): void {
    const ids = this.transcript.list.filter(b => b.body.length).map(b => b.id);
    const at = this.selected === null ? -1 : ids.indexOf(this.selected);
    if (key.name === 'up' || key.name === 'down') {
      const next = Math.max(0, Math.min(ids.length - 1, at + (key.name === 'up' ? -1 : 1)));
      this.selected = ids[next] ?? null;
    } else if (key.name === 'home') this.selected = ids[0] ?? null;
    else if (key.name === 'end') this.selected = ids.at(-1) ?? null;
    else if (key.name === 'enter' || (key.name === 'text' && key.text === ' ')) {
      if (this.selected !== null) this.transcript.toggle(this.selected);
    } else if (key.name === 'text' && key.text === 'a') this.transcript.toggleAll();
    else if (key.name === 'escape') {
      this.browsing = false;
      this.selected = null;
      return;
    }
    this.reveal();
  }
  private scrollBy(rows: number): void {
    this.scroll = Math.max(0, this.scroll + rows);
  }

  // Drawing.
  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.draw();
    }, 16);
  }
  private redraw(): void {
    this.term.leave();
    this.start();
  }
  private conversationHeight(): number {
    return Math.max(1, this.term.rows - 3 - this.inputRows().length);
  }
  private inputRows(): string[] {
    return this.layoutInput().rows;
  }
  // The input as rows of the box: the prompt, then the text wrapped at the width, and where the cursor is.
  private layoutInput(): { rows: string[]; cursorRow: number; cursorCol: number } {
    const w = this.term.columns - 1;
    // What Enter does shows in the prompt: start a run (or a command), or guide the one under way.
    const prompt = this.status.state === 'idle' ? '> ' : 'guide> ';
    const room = Math.max(4, w - prompt.length);
    const chars = [...row(this.input)];
    const rows: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let line = '';
    let width = 0;
    const before = [...row(this.input.slice(0, this.cursor))].length;
    chars.forEach((c, i) => {
      const cw = cells(c);
      if (width + cw > room) {
        rows.push(line);
        line = '';
        width = 0;
      }
      if (i === before) {
        cursorRow = rows.length;
        cursorCol = width;
      }
      line += c;
      width += cw;
    });
    if (before >= chars.length) {
      if (width >= room) {
        rows.push(line);
        line = '';
        width = 0;
      }
      cursorRow = rows.length;
      cursorCol = width;
    }
    rows.push(line);
    // At most four rows: the ones around the cursor.
    const first = Math.max(0, Math.min(cursorRow - 3, rows.length - 4));
    return {
      rows: rows.slice(first, first + 4).map((r, i) => `${i + first === 0 ? prompt : ' '.repeat(prompt.length)}${r}`),
      cursorRow: cursorRow - first,
      cursorCol: cursorCol + prompt.length,
    };
  }
  // Keeps the selected block in view while browsing.
  private reveal(): void {
    if (this.selected === null) return;
    const rows = this.transcript.rows(this.term.columns - 1, this.selected, this.s);
    const height = this.conversationHeight();
    const first = rows.findIndex(r => r.block === this.selected);
    if (first < 0) return;
    const fromEnd = rows.length - first;
    if (fromEnd > this.scroll + height) this.scroll = fromEnd - height;
    else if (fromEnd <= this.scroll) this.scroll = Math.max(0, fromEnd - 1);
  }
  draw(): void {
    const w = this.term.columns - 1;
    const input = this.layoutInput();
    const height = Math.max(1, this.term.rows - 3 - input.rows.length);
    const all = this.transcript.rows(w, this.selected, this.s);
    this.scroll = Math.min(this.scroll, Math.max(0, all.length - height));
    const end = all.length - this.scroll;
    const shown = all.slice(Math.max(0, end - height), end).map(r => r.text);
    const frame = [
      this.s.inverse(fitTo(this.statusLine(w), w).padEnd(w)),
      this.s.dim(fitTo(this.nowLine(), w)),
      ...Array<string>(height - shown.length).fill(''),
      ...shown,
      this.s.dim(fitTo(this.hintLine(all.length - end), w)),
      ...input.rows.map(r => fitTo(r, w)),
    ];
    this.term.draw(
      frame,
      this.browsing ? null : { row: frame.length - input.rows.length + input.cursorRow, col: input.cursorCol },
    );
  }
  // The status bar in the width. When it does not fit, the step goes first (the turn stays), then the clock,
  // then the context shows its share alone; the model, tokens, cost and state always stay.
  private statusLine(width: number): string {
    const st = this.status;
    const share = st.context ? Math.round((100 * st.context.tokens) / st.context.working) : 0;
    const u = st.usage;
    const parts: { text: string; short?: string; drop?: 'step' | 'clock' }[] = [
      { text: `Leana | ${st.model.split(/[/:]/).pop()}` },
    ];
    if (st.maxTurn) parts.push({ text: `turn ${st.turn}/${st.maxTurn}` });
    if (st.step)
      parts.push({
        text: `step ${st.step}${st.maxStep ? `/${st.maxStep}` : ''}`,
        ...(st.maxTurn ? { drop: 'step' as const } : {}),
      });
    if (st.context)
      parts.push({
        text: `context ${k(st.context.tokens)}/${k(st.context.working)} (${share}%)`,
        short: `context ${share}%`,
      });
    if (u.requests)
      parts.push({
        text: `${k(u.input)} in${u.cached ? `, ${Math.round((100 * u.cached) / u.input)}% cached` : ''} | ${k(u.output)} out${u.cost !== null ? ` | $${u.cost.toFixed(u.cost < 1 ? 3 : 2)}` : ''}`,
      });
    const ms = st.startedAt === null ? null : (st.endedMs ?? Date.now() - st.startedAt);
    if (ms !== null) parts.push({ text: clock(ms), drop: 'clock' });
    parts.push({ text: st.state === 'idle' ? (st.startedAt === null ? 'ready' : 'done') : st.state });
    const line = (xs: typeof parts) => ` ${xs.map(p => p.text).join(' | ')} `;
    let kept = parts;
    if (cells(line(kept)) > width) kept = kept.filter(p => p.drop !== 'step');
    if (cells(line(kept)) > width) kept = kept.filter(p => p.drop !== 'clock');
    if (cells(line(kept)) > width) kept = kept.map(p => (p.short ? { text: p.short } : p));
    return line(kept);
  }
  private nowLine(): string {
    const st = this.status;
    if (st.state === 'idle') return ` ${st.title}`;
    const turn = spinner[Math.floor(Date.now() / 250) % spinner.length];
    return ` ${turn} ${st.now || 'working'}${st.phase ? ` | ${st.phase}` : ''}`;
  }
  private hintLine(below: number): string {
    const more = this.scroll ? `${below} rows below (End: Esc) | ` : '';
    if (this.browsing) return ` ${more}Up/Down: select | Enter: fold/unfold | a: all | Tab/Esc: back to input`;
    return this.status.state === 'idle'
      ? ` ${more}Enter: run an objective or /command | Tab: browse | PgUp/PgDn: scroll | Ctrl-C twice: quit`
      : ` ${more}Enter: guide the run | Tab: browse | PgUp/PgDn: scroll | Ctrl-C: stop after this step`;
  }
}
