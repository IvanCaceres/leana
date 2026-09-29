// Observing the result as its user does: what no build, type check or test
// shows. Each observer knows one kind of result (a page in a browser, a service
// answering HTTP, a program run from the shell), produces facts about it, and
// owns the question the completion gate asks about those facts. The loop and the
// gate only know "an observation"; everything particular to a kind of result
// lives in its observer, as ecosystem knowledge lives in the profiles.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBrowser, renderFacts } from './render.js';
import { connectionRefused, listeningAt, localAddresses, notAnswering, startServer } from './serve.js';
import { commandShell, describeProcesses, runCommand } from './tools.js';
import { describeObserver, observerKinds } from './observe-catalog.js';
const described = (kind: string) => describeObserver(kind)!;

export interface ObserveContext { root: string; artifactPath: string; timeoutMs: number; prefix: string; files: string[] }
export interface Observation { ok: boolean; text: string }
export interface Observer {
  // kind, what it shows (for the action catalogue), and the gate's focused question about it: see observe-catalog.ts.
  kind: string; what: string; question: string;
  available(): Promise<boolean>;
  observe(start: string, target: string, ctx: ObserveContext): Promise<Observation>;
}
const clipEnds = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .55))}\n…\n${text.slice(text.length - Math.floor(limit * .45))}`;

// A page loaded in a headless browser.
const page: Observer = {
  ...described('page'),
  available: async () => Boolean(await findBrowser().catch(() => null)),
  async observe(start, target, ctx) {
    const r = await renderFacts(ctx.root, target, start || undefined, ctx.artifactPath, ctx.timeoutMs);
    if (!r.unmatched?.length) return r;
    // Where each class name without a CSS rule is used, so the stylesheet can be completed without re-reading every component.
    const styles = /\.(?:css|scss|sass|less|styl)$/;
    const where: Record<string, string[]> = {};
    const hits = await runCommand('rg', ['-l', '--color', 'never', '-F', '-g', '!node_modules/**', '-g', '!dist/**', '-g', '!build/**', ...r.unmatched.flatMap(c => ['-e', c]), '.'], ctx.root, 15000).catch(() => null);
    for (const f of (hits?.output ?? '').split('\n').map(l => l.replace(/^\.\//, '')).filter(Boolean).slice(0, 40)) {
      if (styles.test(f)) continue;
      const text = await readFile(join(ctx.root, f), 'utf8').catch(() => '');
      const used = r.unmatched.filter(c => new RegExp(`(^|[^\\w-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text));
      if (used.length) where[f] = used;
    }
    const stylesheets = ctx.files.filter(f => styles.test(f) && !/(^|\/)(?:node_modules|dist|build)\//.test(f));
    return { ok: r.ok, text: `${r.text}\nClass names no CSS selector matches, by the file that uses them:\n${Object.entries(where).map(([f, cs]) => `  ${f}: ${cs.join(' ')}`).join('\n') || '  (not found in the sources)'}\nStylesheets in the project: ${stylesheets.join(', ') || 'none'}.` };
  },
};

// A service answering HTTP: one request to a URL.
const http: Observer = {
  ...described('http'),
  available: async () => true,
  async observe(start, target, ctx) {
    const wait = Math.min(ctx.timeoutMs, 45000);
    const started = start.trim() ? await startServer(ctx.root, start, target, wait) : null;
    try {
      if (started && started.ready !== true) return { ok: false, text: notAnswering(start, target, started, wait) };
      const t0 = performance.now();
      let r: Response; try { r = await fetch(target, { signal: AbortSignal.timeout(Math.min(ctx.timeoutMs, 30000)) }); } catch (e) { return { ok: false, text: `Nothing answered at ${target}: ${(e as Error).message}` }; }
      const body = await r.text().catch(() => '');
      let shape = '';
      try { const j = JSON.parse(body); shape = Array.isArray(j) ? `JSON array of ${j.length} item(s)${j[0] && typeof j[0] === 'object' ? `, items with keys ${Object.keys(j[0]).slice(0, 12).join(', ')}` : ''}` : j && typeof j === 'object' ? `JSON object with keys ${Object.keys(j).slice(0, 20).join(', ')}` : `JSON ${typeof j}`; } catch { /* not JSON */ }
      const ok = r.status < 400;
      return { ok, text: [`${ok ? 'Answered' : 'HTTP ERROR'}: GET ${target} -> ${r.status} ${r.statusText} in ${Math.round(performance.now() - t0)} ms; content-type ${r.headers.get('content-type') ?? 'none'}; ${body.length} characters.`, shape, `Body begins: ${clipEnds(body, 1500)}`].filter(Boolean).join('\n') };
    } finally { started?.stop(); }
  },
};

// A program run from the shell, as its user would run it.
const program: Observer = {
  ...described('program'),
  available: async () => true,
  async observe(start, target, ctx) {
    // What start names runs beside the program for the length of the observation (a service the program talks to).
    const wait = Math.min(ctx.timeoutMs, 45000);
    const started = start.trim() ? await startServer(ctx.root, start, null, wait) : null;
    try {
      if (started && started.ready !== true) {
        const code = started.exited?.() ?? null;
        return { ok: false, text: `${code !== null ? `The command started with "${start}" ended (${typeof code === 'number' ? `exit ${code}` : code}) before ${target} ran` : `The command started with "${start}" announced ${localAddresses(started.log()).slice(0, 3).join(', ')}, and nothing accepted a connection there within ${Math.round(wait / 1000)}s; ${target} did not run`}. Its output:\n${started.log().slice(-1500) || '(no output)'}` };
      }
      const r = await runCommand(commandShell[0]!, [...commandShell.slice(1), `${ctx.prefix}${target}`], ctx.root, ctx.timeoutMs).catch(e => ({ code: -1, output: String((e as Error).message), truncated: false, timedOut: false }));
      const ok = r.code === 0 && !r.timedOut;
      const left = 'leftRunning' in r && r.leftRunning?.length ? `\nStill running when it ended, and stopped with it: ${describeProcesses(r.leftRunning)}.` : '';
      return { ok, text: `${ok ? 'Ran' : 'RUN FAILED'}: ${target} -> exit ${r.code}${r.timedOut ? ' (timed out)' : ''}.${left}\nOutput:\n${clipEnds(r.output || '(no output)', 3000)}` };
    } finally { started?.stop(); }
  },
};

export const observers: Observer[] = [page, http, program];
export { observerKinds };
export const observerFor = (kind: string): Observer | undefined => observers.find(o => o.kind === kind);
export async function observeResult(kind: string, start: string, target: string, ctx: ObserveContext): Promise<Observation> {
  const o = observerFor(kind);
  if (!o) return { ok: false, text: `There is no observer of kind "${kind}"; the kinds are ${observerKinds.join(', ')}.` };
  if (!target.trim()) return { ok: false, text: `observe needs a target: the URL to load (page, http) or the command to run (program).` };
  if (!(await o.available())) return { ok: false, text: `The ${kind} observer cannot run on this machine${kind === 'page' ? ' (no chromium or google-chrome is installed)' : ''}.` };
  // Nothing to start and nothing accepting connections at the address: that is the whole observation.
  if (!start.trim() && await connectionRefused(target)) return { ok: false, text: `Nothing is listening at ${listeningAt(target)}: the connection to ${target} was refused, and nothing was started for this observation (start was empty). Processes a shell step starts are stopped when the step ends, and the start command of an observe when that observation ends.` };
  return o.observe(start, target, ctx).catch(e => ({ ok: false, text: `The ${kind} observation failed: ${(e as Error).message}` }));
}
