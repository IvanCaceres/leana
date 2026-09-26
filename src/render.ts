// What the user will see: a page rendered in a headless browser, reported as
// facts a text-only worker can act on. The render fails only on what is
// unambiguous: exceptions thrown, responses with a 4xx or 5xx status, requests
// or images that did not load. Everything else is a fact for the worker and
// Jev to judge, never a verdict: console messages, elements that overflow the
// viewport, the heading outline, sections without text, and how the page is
// styled (CSS rules, class names a selector matches, inline styles, shadow
// roots), since pages are styled in more ways than one. The browser is driven
// over Chrome's debugging pipe; no library, no network port.
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { runCommand } from './tools.js';

const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
export async function findBrowser(): Promise<string | null> {
  const r = await runCommand('bash', ['--noprofile', '--norc', '-c', `for b in ${candidates.join(' ')}; do if command -v -- "$b" >/dev/null 2>&1; then echo "$b"; exit 0; fi; done; exit 1`], process.cwd(), 5000).catch(() => null);
  return r && r.code === 0 ? r.output.trim().split('\n')[0]! : null;
}
const probe = `(() => {
  const vw = window.innerWidth; const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const path = e => { const parts = []; let n = e; while (n && n.nodeType === 1 && parts.length < 4) { parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : '')); n = n.parentElement; } return parts.join(' > '); };
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 24).map(h => h.tagName.toLowerCase() + ': ' + (h.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80));
  const images = [...document.images].filter(i => i.complete && i.naturalWidth === 0).slice(0, 12).map(i => (i.getAttribute('src') || '(no src)').slice(0, 120) + (i.alt ? ' (alt "' + i.alt.slice(0, 40) + '")' : ''));
  const overflow = [...document.querySelectorAll('body *')].filter(vis).filter(e => { const r = e.getBoundingClientRect(); return r.right > vw + 2 || r.left < -2; }).slice(0, 8).map(e => { const r = e.getBoundingClientRect(); return path(e) + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right) + 'px of a ' + vw + 'px viewport'; });
  const empty = [...document.querySelectorAll('section, main, article, header, footer')].filter(vis).filter(e => (e.textContent || '').trim().length < 20 && !e.querySelector('img,svg,canvas,video')).slice(0, 6).map(path);
  const rules = [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0);
  // Every class name a selector mentions, walking nested rules (@media, @supports, @layer).
  const selected = new Set(); const walk = list => { for (const r of list) { if (r.selectorText) for (const m of r.selectorText.matchAll(/\\.((?:\\\\.|[\\w-])+)/g)) selected.add(m[1].replace(/\\\\(.)/g, '$1')); if (r.cssRules) walk(r.cssRules); } };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { /* cross-origin */ } }
  const used = new Map(); for (const e of document.querySelectorAll('body [class]')) { if (!vis(e)) continue; for (const c of e.classList) used.set(c, (used.get(c) || 0) + 1); }
  const unmatched = [...used.keys()].filter(c => !selected.has(c));
  const classes = { used: used.size, unmatched: unmatched.length, elementsUnmatched: [...used.entries()].filter(([c]) => !selected.has(c)).reduce((n, [, k]) => n + k, 0), sample: unmatched.slice(0, 20), all: unmatched.slice(0, 300) };
  const all = document.querySelectorAll('body *'); let inline = 0; let shadow = 0; for (const e of all) { if (e.hasAttribute('style')) inline++; if (e.shadowRoot) shadow++; }
  const body = getComputedStyle(document.body);
  const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const links = [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 30).map(a => ((a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) || '(no text)') + ' -> ' + (a.getAttribute('href') || '').slice(0, 60));
  return { title: document.title, headings, images, overflow, empty, rules, classes, inline, shadow, font: body.fontFamily.slice(0, 60), background: body.backgroundColor, textLength: text.length, textHead: text.slice(0, 300), links, docHeight: document.documentElement.scrollHeight, viewport: vw + 'x' + window.innerHeight };
})()`;

interface Facts { title: string; headings: string[]; images: string[]; overflow: string[]; empty: string[]; rules: number; classes: { used: number; unmatched: number; elementsUnmatched: number; sample: string[]; all: string[] }; inline: number; shadow: number; font: string; background: string; textLength: number; textHead: string; links: string[]; docHeight: number; viewport: string }
class Cdp {
  private id = 0; private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(); private buffer = '';
  readonly events: { method: string; params: any }[] = [];
  constructor(private child: ChildProcess) {
    const out = child.stdio[4] as NodeJS.ReadableStream;
    out.on('data', (chunk: Buffer) => { this.buffer += chunk.toString('utf8'); let i; while ((i = this.buffer.indexOf('\0')) >= 0) { const raw = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1); this.receive(raw); } });
  }
  private receive(raw: string): void {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && this.pending.has(m.id)) { const p = this.pending.get(m.id)!; this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    else if (m.method) this.events.push({ method: m.method, params: m.params });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id; const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0';
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); (this.child.stdio[3] as NodeJS.WritableStream).write(msg); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); } }, 20000); });
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Waits for the URL to answer. A server that announces its own address and it
// is another port is not going to answer at this one: after a short grace the
// wait ends with the addresses it announced, instead of running out the clock.
async function waitForUrl(url: string, timeoutMs: number, elsewhere?: () => string[] | null): Promise<true | string[] | false> {
  const until = Date.now() + timeoutMs; let seenAt = 0;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return true; } catch { /* not yet */ }
    const other = elsewhere?.() ?? null;
    if (other?.length) { seenAt ||= Date.now(); if (Date.now() - seenAt > 3000) return other; }
    await sleep(500);
  }
  return false;
}
// Addresses on this machine a server's output says it listens at, when none has the requested URL's port.
export function announcedElsewhere(output: string, url: string): string[] | null {
  let port: string; try { const u = new URL(url); port = u.port || (u.protocol === 'https:' ? '443' : '80'); } catch { return null; }
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const found = [...new Set([...plain.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d+))?[^\s'"]*/g)].map(m => m[0].replace(/[.,;)]+$/, '')))];
  if (!found.length) return null;
  const ports = found.map(f => f.match(/:(\d+)(?:\/|$)/)?.[1] ?? (f.startsWith('https') ? '443' : '80'));
  return ports.includes(port) ? null : found.slice(0, 4);
}
// Render a URL, optionally after starting a server with `serve` in `root`
// (stopped afterwards, whatever happens). Returns facts as text and, when a
// path is given, a PNG screenshot for the session's report.
export async function renderFacts(root: string, url: string, serve: string | undefined, screenshotPath: string | null, timeoutMs = 60000): Promise<{ ok: boolean; text: string; unmatched?: string[] }> {
  const browser = await findBrowser(); if (!browser) return { ok: false, text: 'No browser is installed on this machine (chromium or google-chrome); the page cannot be rendered.' };
  let server: ChildProcess | null = null; const serverLog: string[] = [];
  try {
    if (serve && serve.trim()) {
      server = spawn('bash', ['--noprofile', '--norc', '-c', serve], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', BROWSER: 'none' } });
      server.stdout?.on('data', d => serverLog.push(String(d))); server.stderr?.on('data', d => serverLog.push(String(d)));
      const waited = await waitForUrl(url, Math.min(timeoutMs, 45000), () => announcedElsewhere(serverLog.join(''), url));
      if (waited !== true) return { ok: false, text: waited ? `The server started with "${serve}" says it is listening at ${waited.join(', ')}, and nothing answered at ${url}. Its output:\n${serverLog.join('').slice(-1500)}` : `The server started with "${serve}" did not answer at ${url} within ${Math.round(Math.min(timeoutMs, 45000) / 1000)}s. Its output:\n${serverLog.join('').slice(-1500)}` };
    }
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions', '--remote-debugging-pipe', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const cdp = new Cdp(child);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await cdp.send(m, {}, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      const until = Date.now() + Math.min(timeoutMs, 30000);
      while (Date.now() < until && !cdp.events.some(e => e.method === 'Page.loadEventFired')) await sleep(200);
      await sleep(1500);
      const evaluated = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId);
      const facts = evaluated?.result?.value as Facts | undefined;
      if (screenshotPath) { try { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId); await writeFile(screenshotPath, Buffer.from(shot.data, 'base64')); } catch { /* the facts matter more */ } }
      // The browser requests /favicon.ico by itself when a page declares no icon: that request is the browser's, not the page's.
      const own = (u: string) => !/\/favicon\.ico(?:$|\?)/.test(u);
      const errors = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => String(e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text ?? '').split('\n')[0]!.slice(0, 200));
      const consoleErrors = cdp.events.filter(e => e.method === 'Runtime.consoleAPICalled' && (e.params?.type === 'error' || e.params?.type === 'warning')).map(e => `${e.params.type}: ${(e.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
      const logErrors = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error' && own(String(e.params.entry.url ?? ''))).map(e => String(e.params.entry.text ?? '').slice(0, 200));
      const failed = cdp.events.filter(e => e.method === 'Network.responseReceived' && (e.params?.response?.status ?? 0) >= 400 && own(String(e.params.response.url))).map(e => `${e.params.response.status} ${String(e.params.response.url).slice(0, 120)}`);
      const notLoaded = cdp.events.filter(e => e.method === 'Network.loadingFailed').map(e => `failed: ${String(e.params?.errorText ?? '')} ${String(e.params?.requestId ?? '')}`.slice(0, 160));
      if (!facts) return { ok: false, text: `Rendered ${url} but the page could not be inspected (no document).` };
      const messages = [...consoleErrors, ...logErrors].slice(0, 12); const requests = [...new Set([...failed, ...notLoaded])].slice(0, 12);
      const c = facts.classes;
      const verdict = [
        errors.length ? `exceptions thrown in the page: ${errors.slice(0, 12).join(' | ')}` : '',
        requests.length ? `requests that failed: ${requests.join(' | ')}` : '',
        facts.images.length ? `images that did not load: ${facts.images.join(' | ')}` : '',
      ].filter(Boolean);
      const ok = !verdict.length;
      const lines = [
        ok ? `Rendered ${url}: no exception, every request and image loaded${c.used ? `; ${c.used - c.unmatched} of the ${c.used} class names on visible elements match a CSS rule` : ''}.` : `RENDER FAILED for ${url}, ${verdict.length} problem(s):\n- ${verdict.join('\n- ')}`,
        messages.length ? `Console messages: ${messages.join(' | ')}` : '',
        `Page: title "${facts.title}"; ${facts.viewport}, height ${facts.docHeight}px; body font ${facts.font}; background ${facts.background}; ${facts.textLength} characters of text.`,
        `Styling: ${facts.rules} CSS rules; ${c.used - c.unmatched} of the ${c.used} class names on visible elements match a CSS selector${c.unmatched ? ` (without one: ${c.sample.join(', ')}${c.unmatched > c.sample.length ? ', …' : ''})` : ''}; ${facts.inline} elements with a style attribute; ${facts.shadow} shadow roots.`,
        facts.overflow.length ? `Elements overflowing the viewport horizontally: ${facts.overflow.join(' | ')}` : '',
        `Headings: ${facts.headings.length ? facts.headings.join(' | ') : 'none'}`,
        facts.empty.length ? `Visible regions with no text or media: ${facts.empty.join(' | ')}` : '',
        `Links: ${facts.links.length ? facts.links.slice(0, 12).join(' | ') : 'none'}`,
        `Text begins: ${facts.textHead}`,
      ].filter(Boolean);
      return { ok, text: lines.join('\n'), ...(c.unmatched ? { unmatched: c.all } : {}) };
    } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  } finally {
    if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-server!.pid!, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); }
  }
}
