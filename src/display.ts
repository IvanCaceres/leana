import type { GenerationMeta, Phase } from './types.js';
import { clip } from './context.js';

// Structured progress from the runner. The display turns it into a live panel
// on a terminal, or plain lines when output is not a terminal.
export type ProgressEvent =
  | { kind: 'step'; step: number; phase: Phase; maxStep: number }
  | { kind: 'jev'; step: number; ms: number; questions: number; stateBytes: number; route: [string, number][]; nouls: Record<string, number> }
  | { kind: 'route'; step: number; route: string; tokens: number; entries: number }
  | { kind: 'context'; step: number; tokens: number; workingTokens: number; contextWindow: number; breakdown: Record<string, number>; entries: number }
  | { kind: 'generating'; step: number; route: string; attempt: number }
  | { kind: 'generated'; step: number; route: string; meta: GenerationMeta | null; args: unknown }
  | { kind: 'generation_error'; step: number; message: string }
  | { kind: 'result'; step: number; route: string; ok: boolean; ms: number; chars: number; text: string }
  | { kind: 'undo'; step: number; files: string[] }
  | { kind: 'warning'; step: number; text: string }
  | { kind: 'stop'; step: number; status: string; reason: string };

const k = (n: number | null | undefined) => n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const secs = (ms: number | null | undefined) => ms == null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const quantile = (xs: number[], q: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * q) - 1)]! : null;
export const generationSpeed = (m: GenerationMeta | null): { generated: number | null; perSecond: number | null; promptPerSecond: number | null; cached: number | null } => {
  if (!m) return { generated: null, perSecond: null, promptPerSecond: null, cached: null };
  const generated = m.usage?.completion_tokens ?? m.timings?.predicted_n ?? null;
  return { generated, perSecond: m.timings?.predicted_per_second ?? (generated && m.ms ? generated / (m.ms / 1000) : null),
    promptPerSecond: m.timings?.prompt_per_second ?? null, cached: m.usage?.prompt_tokens_details?.cached_tokens ?? null };
};
// The same facts as plain lines, one per phase, for logs and non-terminal output.
export function describe(e: ProgressEvent, verbose: boolean): string | null {
  const p = `[${e.step}]  `;
  switch (e.kind) {
    case 'jev': return verbose ? `${p} jev ${e.ms.toFixed(0)}ms | ${e.questions} questions | state ${(e.stateBytes / 1000).toFixed(1)}k bytes | route ${e.route.map(([r, v]) => `${r} ${v.toFixed(2)}`).join(', ')} | ${Object.entries(e.nouls).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(' | ')}` : null;
    case 'route': return `[${e.step}] ${e.route} | ${e.tokens} prompt tokens | ${e.entries} evidence entries`;
    case 'context': { if (!verbose) return null; const top = Object.entries(e.breakdown).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => `${n} ${(v / 1000).toFixed(1)}k`).join(', ');
      return `${p} context ${e.tokens} tokens = ${Math.round(100 * e.tokens / e.workingTokens)}% of ${e.workingTokens} working (${Math.round(100 * e.tokens / e.contextWindow)}% of window) | chars: ${top}`; }
    case 'generated': { if (!verbose) return null; const s = generationSpeed(e.meta); const m = e.meta;
      return `${p} bonsai ${m ? secs(m.ms) : '-'} | ${s.generated ?? '?'} generated tokens${s.perSecond ? ` @ ${s.perSecond.toFixed(1)} tok/s` : ''}${s.promptPerSecond ? ` | prompt ${m?.timings?.prompt_n ?? m?.promptTokens} tokens @ ${s.promptPerSecond.toFixed(0)} tok/s` : ''}${s.cached ? ` | ${s.cached} cached` : ''} | finish ${m?.finishReason ?? '?'}\n${p} args ${clip(JSON.stringify(e.args), 300)}`; }
    case 'generation_error': return verbose ? `${p} generation failed: ${e.message}` : null;
    case 'result': return verbose ? `${p} result ${e.ok ? 'ok' : 'FAILED'} | ${e.ms.toFixed(0)}ms | ${e.chars} chars | ${clip(e.text.replace(/\s+/g, ' '), 200)}` : null;
    case 'undo': return `[${e.step}] undo | reverting ${e.files.join(', ')}`;
    case 'warning': return `warning | ${e.text}`;
    default: return null;
  }
}
export function lineObserver(write: (line: string) => void, verbose: boolean): (e: ProgressEvent) => void {
  return e => { const line = describe(e, verbose); if (line) write(line); };
}
interface Stream { write(s: string): unknown; isTTY?: boolean; columns?: number }
// A status panel redrawn in place at the bottom of the terminal, with a
// scrolling log of completed steps above it.
export class Display {
  private started = Date.now();
  private jevMs: number[] = []; private tps: number[] = []; private promptTokens = 0; private generatedTokens = 0;
  private routes: Record<string, number> = {}; private edits = 0; private checks = 0; private failures = 0; private undos = 0;
  private step = 0; private maxStep = 0; private phase = ''; private status = 'running';
  private lastJev = ''; private context = ''; private contextFill = 0; private bonsai = ''; private now = 'starting'; private last = '';
  private panelLines = 0; private timer: NodeJS.Timeout | null = null; private spin = 0;
  constructor(private out: Stream, private opts: { objective: string; session: string; verbose: boolean }) {
    if (out.isTTY) { this.timer = setInterval(() => this.render(), 1000); this.timer.unref?.(); }
  }
  private width(): number { return Math.max(60, Math.min(160, this.out.columns ?? 100)); }
  // Never fill the last column: a full-width line makes the cursor wrap, which
  // adds a row the cursor-up count does not know about and leaks lines each tick.
  // One physical row per logical line: collapse newlines and tabs, drop
  // non-ASCII (ambiguous width), and never fill the last column.
  private fit(s: string): string { const flat = s.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '?'); const w = this.width() - 1; return flat.length > w ? `${flat.slice(0, w - 3)}...` : flat; }
  log(line: string): void {
    if (!this.out.isTTY) { this.out.write(`${line}\n`); return; }
    this.clearPanel(); for (const l of line.split('\n')) this.out.write(`${this.fit(l)}\n`); this.render();
  }
  update(e: ProgressEvent): void {
    switch (e.kind) {
      case 'step': this.step = e.step; this.maxStep = e.maxStep; this.phase = e.phase; this.now = 'asking Jev for the next action'; break;
      case 'jev': this.jevMs.push(e.ms);
        this.lastJev = `${secs(e.ms)} | ${e.questions} q | state ${(e.stateBytes / 1000).toFixed(1)}k | ${e.route.slice(0, 3).map(([r, v]) => `${r} ${v.toFixed(2)}`).join(' | ')} | ${Object.entries(e.nouls).slice(0, 4).map(([n, v]) => `${n} ${v.toFixed(2)}`).join(' | ')}`; break;
      case 'route': this.routes[e.route] = (this.routes[e.route] ?? 0) + 1; this.now = `counting the ${e.route} prompt`; break;
      case 'context': { this.contextFill = e.tokens / e.workingTokens; this.promptTokens += e.tokens;
        const top = Object.entries(e.breakdown).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => `${n} ${k(v)}`).join(' | ');
        this.context = `${k(e.tokens)} / ${k(e.workingTokens)} working (${Math.round(100 * this.contextFill)}%) | window ${k(e.contextWindow)} (${Math.round(100 * e.tokens / e.contextWindow)}%) | ${e.entries} entries | ${top}`; break; }
      case 'generating': this.now = `Bonsai generating ${e.route} arguments${e.attempt > 1 ? ' (retry, hotter)' : ''}`; break;
      case 'generated': { const s = generationSpeed(e.meta); if (s.perSecond) this.tps.push(s.perSecond); if (s.generated) this.generatedTokens += s.generated;
        this.bonsai = `${e.meta ? secs(e.meta.ms) : '-'} | ${s.generated ?? '?'} tokens${s.perSecond ? ` @ ${s.perSecond.toFixed(1)} tok/s` : ''}${s.promptPerSecond ? ` | prompt @ ${s.promptPerSecond.toFixed(0)} tok/s` : ''}${s.cached ? ` | ${s.cached} cached` : ''} | ${clip(JSON.stringify(e.args), 90)}`;
        this.now = `running ${e.route}`; break; }
      case 'generation_error': this.failures++; this.last = `[${e.step}] no action: ${e.message}`; this.now = 'asking Jev for the next action'; break;
      case 'result': { if (['write', 'replace_lines', 'move_lines'].includes(e.route) && e.ok) this.edits++; if (e.route === 'bash') this.checks++; if (!e.ok) this.failures++;
        this.last = `[${e.step}] ${e.route} ${e.ok ? 'ok' : 'FAILED'} ${secs(e.ms)} -> ${k(e.chars)} chars: ${e.text.replace(/\s+/g, ' ')}`; this.now = 'asking Jev for the next action'; break; }
      case 'undo': this.undos++; this.last = `[${e.step}] undo: reverted ${e.files.join(', ')}`; break;
      case 'stop': this.status = `${e.status.toUpperCase()}: ${e.reason}`; this.now = 'stopped'; break;
    }
    const line = describe(e, this.opts.verbose);
    if (line) this.log(line); else if (this.out.isTTY) this.render();
  }
  // ASCII only: box-drawing, block and middle-dot characters are ambiguous-width
  // and some terminals render them two cells wide, which breaks in-place redraws.
  private bar(fill: number, width = 20): string { const n = Math.max(0, Math.min(width, Math.round(fill * width))); return `[${'#'.repeat(n)}${'.'.repeat(width - n)}]`; }
  panel(): string[] {
    const elapsed = Math.round((Date.now() - this.started) / 1000);
    const spinner = '|/-\\'[this.spin++ % 4];
    const routes = Object.entries(this.routes).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(' | ');
    const avgTps = this.tps.length ? this.tps.reduce((a, b) => a + b, 0) / this.tps.length : null;
    return [
      '-'.repeat(this.width() - 1),
      `Leana | ${this.opts.session} | step ${this.step}${this.maxStep ? `/${this.maxStep}` : ''} | ${this.phase} | ${this.status} | ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed`,
      `Objective  ${this.opts.objective.replace(/\s+/g, ' ')}`,
      `Jev        ${this.lastJev || '-'}`,
      `           median ${secs(quantile(this.jevMs, .5))} | p95 ${secs(quantile(this.jevMs, .95))} | ${this.jevMs.length} calls`,
      `Context    ${this.bar(this.contextFill)} ${this.context || '-'}`,
      `Bonsai     ${this.bonsai || '-'}`,
      `           avg ${avgTps ? `${avgTps.toFixed(1)} tok/s` : '-'} | ${k(this.generatedTokens)} generated | ${k(this.promptTokens)} prompt tokens sent`,
      `Now        ${this.now === 'stopped' ? '' : `${spinner} `}${this.now}`,
      `Last       ${this.last || '-'}`,
      `Totals     ${routes || '-'} | ${this.edits} edits | ${this.checks} commands | ${this.failures} failures | ${this.undos} undo`,
    ].map(l => this.fit(l));
  }
  private clearPanel(): void { if (this.panelLines) this.out.write(`\x1b[${this.panelLines}A\x1b[J`); this.panelLines = 0; }
  render(): void {
    if (!this.out.isTTY) return;
    this.clearPanel();
    const lines = this.panel();
    this.out.write(`${lines.join('\n')}\n`);
    this.panelLines = lines.length;
  }
  close(): void { if (this.timer) clearInterval(this.timer); if (this.out.isTTY) { this.clearPanel(); this.out.write(`${this.panel().join('\n')}\n`); this.panelLines = 0; } }
}
