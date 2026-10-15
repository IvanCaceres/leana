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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './commands.js';
import { announcedElsewhere, notAnswering, startServer, type Started } from './serve.js';
export { announcedElsewhere };

const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
// On Windows browsers are not on the PATH: they are where their installers put them. Edge is Chromium too.
const windowsBrowsers = () =>
  [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter((d): d is string => Boolean(d))
    .flatMap(d => [
      join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(d, 'Chromium', 'Application', 'chrome.exe'),
      join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
export async function findBrowser(): Promise<string | null> {
  if (process.platform === 'win32') {
    const at = windowsBrowsers().find(p => existsSync(p));
    if (at) return at;
  }
  const r = await runCommand(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      `for b in ${candidates.join(' ')}; do if command -v -- "$b" >/dev/null 2>&1; then echo "$b"; exit 0; fi; done; exit 1`,
    ],
    process.cwd(),
    5000,
  ).catch(() => null);
  return r && r.code === 0 ? r.output.trim().split('\n')[0]! : null;
}
const probe = `(() => {
  const vw = window.innerWidth; const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const path = e => { const parts = []; let n = e; while (n && n.nodeType === 1 && parts.length < 4) { parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : n.classList.length ? '.' + [...n.classList].slice(0, 2).join('.') : '')); n = n.parentElement; } return parts.join(' > '); };
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 24).map(h => h.tagName.toLowerCase() + ': ' + (h.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80));
  const images = [...document.images].filter(i => i.complete && i.naturalWidth === 0).slice(0, 12).map(i => (i.getAttribute('src') || '(no src)').slice(0, 120) + (i.alt ? ' (alt "' + i.alt.slice(0, 40) + '")' : ''));
  // Horizontal overflow as a user meets it: whether the document scrolls sideways, the elements cut by the
  // viewport's edge (partly on screen), and, apart, those wholly outside it, which no one sees where they are
  // (a closed off-canvas drawer parks there: run react-demo-85 spent 200 s fixing one reported as overflowing).
  // Each listed once, by its outermost element: the descendants of a listed one lie there too.
  const placed = (keep) => { const out = []; for (const e of document.querySelectorAll('body *')) { if (!vis(e) || out.some(o => o.contains(e))) continue; const r = e.getBoundingClientRect(); if (keep(r)) out.push(e); } return out.slice(0, 8).map(e => { const r = e.getBoundingClientRect(); return path(e) + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right) + 'px'; }); };
  const overflow = placed(r => (r.right > vw + 2 && r.left < vw - 1) || (r.left < -2 && r.right > 1));
  const offscreen = placed(r => r.left >= vw - 1 || r.right <= 1);
  const scrollWidth = document.documentElement.scrollWidth;
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
  return { title: document.title, headings, images, overflow, offscreen, scrollWidth, empty, rules, classes, inline, shadow, font: body.fontFamily.slice(0, 60), background: body.backgroundColor, textLength: text.length, textHead: text.slice(0, 300), links, docHeight: document.documentElement.scrollHeight, viewport: vw + 'x' + window.innerHeight };
})()`;

interface Facts {
  title: string;
  headings: string[];
  images: string[];
  overflow: string[];
  offscreen: string[];
  scrollWidth: number;
  empty: string[];
  rules: number;
  classes: { used: number; unmatched: number; elementsUnmatched: number; sample: string[]; all: string[] };
  inline: number;
  shadow: number;
  font: string;
  background: string;
  textLength: number;
  textHead: string;
  links: string[];
  docHeight: number;
  viewport: string;
}
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  readonly events: { method: string; params: any }[] = [];
  constructor(private child: ChildProcess) {
    const out = child.stdio[4] as NodeJS.ReadableStream;
    out.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let i;
      while ((i = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.receive(raw);
      }
    });
  }
  private receive(raw: string): void {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method) this.events.push({ method: m.method, params: m.params });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.child.stdio[3] as NodeJS.WritableStream).write(msg);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 20000);
    });
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// One input of a played page, as observe takes it: press a key (down, then up), hold one for ms, type text
// into what has focus, click the element a selector names, or wait; each followed by ms of watching.
export interface PageInput {
  do: 'press' | 'hold' | 'type' | 'click' | 'wait';
  what: string;
  ms: number;
}
// The key a name means, as CDP dispatches it: its key, code and key code, and the text it types.
function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } | null {
  const named: Record<string, [string, string, number]> = {
    enter: ['Enter', 'Enter', 13],
    space: [' ', 'Space', 32],
    ' ': [' ', 'Space', 32],
    escape: ['Escape', 'Escape', 27],
    esc: ['Escape', 'Escape', 27],
    tab: ['Tab', 'Tab', 9],
    backspace: ['Backspace', 'Backspace', 8],
    shift: ['Shift', 'ShiftLeft', 16],
    control: ['Control', 'ControlLeft', 17],
    alt: ['Alt', 'AltLeft', 18],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
    arrowup: ['ArrowUp', 'ArrowUp', 38],
    arrowright: ['ArrowRight', 'ArrowRight', 39],
    arrowdown: ['ArrowDown', 'ArrowDown', 40],
    left: ['ArrowLeft', 'ArrowLeft', 37],
    up: ['ArrowUp', 'ArrowUp', 38],
    right: ['ArrowRight', 'ArrowRight', 39],
    down: ['ArrowDown', 'ArrowDown', 40],
  };
  const n = named[name.toLowerCase()] ?? named[name.toLowerCase().replace(/^key/, '')];
  if (n)
    return {
      key: n[0],
      code: n[1],
      keyCode: n[2],
      ...(n[0] === ' ' || n[0] === 'Enter' ? { text: n[0] === ' ' ? ' ' : '\r' } : {}),
    };
  if (/^[a-z]$/i.test(name))
    return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  return null;
}
// What the page shows at a moment, for comparing two moments: its text, and each canvas as a grid of
// 96x72 cells of 16 grey levels (a canvas drawn from another origin cannot be read and is left out). The
// frame counter counts animation frames from when play began.
const snapshot = `(() => {
  const canvases = [...document.querySelectorAll('canvas')].filter(c => c.width && c.height).slice(0, 4).map((c, i) => {
    const name = 'canvas' + (c.id ? '#' + c.id : c.classList.length ? '.' + c.classList[0] : i ? ':nth(' + i + ')' : '');
    try { const g = document.createElement('canvas'); g.width = 96; g.height = 72; const x = g.getContext('2d'); x.drawImage(c, 0, 0, 96, 72); const d = x.getImageData(0, 0, 96, 72).data; let s = '';
      for (let k = 0; k < d.length; k += 4) s += Math.min(15, Math.round((d[k] * .3 + d[k + 1] * .59 + d[k + 2] * .11) / 17)).toString(16);
      return { name, w: c.width, h: c.height, cells: s }; } catch { return { name, w: c.width, h: c.height, cells: null }; } });
  return { text: (document.body.innerText || '').replace(/[ \\t]+/g, ' ').slice(0, 4000), canvases, frames: window.__leanaFrames || 0, t: performance.now() };
})()`;
// Starts counting animation frames, so how fast the page draws while it is played is a fact.
const countFrames = `(() => { if (!window.__leanaFrames) { window.__leanaFrames = 0; const f = () => { window.__leanaFrames++; requestAnimationFrame(f); }; requestAnimationFrame(f); } return true; })()`;
interface Snap {
  text: string;
  canvases: { name: string; w: number; h: number; cells: string | null }[];
  frames: number;
  t: number;
}
// How two moments differ: per canvas, the share of its cells whose grey level changed and the box they
// span in canvas pixels; the lines of text that came and went.
function changes(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  for (const cb of b.canvases) {
    const ca = a.canvases.find(c => c.name === cb.name);
    if (!ca || !ca.cells || !cb.cells) {
      out.push(`${cb.name}: ${cb.cells ? 'appeared' : 'not readable (drawn from another origin)'}`);
      continue;
    }
    let n = 0;
    let x0 = 96,
      y0 = 72,
      x1 = -1,
      y1 = -1;
    for (let k = 0; k < cb.cells.length; k++)
      if (cb.cells[k] !== ca.cells[k]) {
        n++;
        const x = k % 96,
          y = Math.floor(k / 96);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const sx = cb.w / 96,
      sy = cb.h / 72;
    out.push(
      n
        ? `${cb.name} (${cb.w}x${cb.h}): ${((100 * n) / cb.cells.length).toFixed(1)}% of it changed, within x ${Math.round(x0 * sx)}..${Math.round((x1 + 1) * sx)}, y ${Math.round(y0 * sy)}..${Math.round((y1 + 1) * sy)}`
        : `${cb.name}: unchanged`,
    );
  }
  const la = new Set(
    a.text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean),
  );
  const lb = new Set(
    b.text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean),
  );
  const came = [...lb].filter(l => !la.has(l));
  const went = [...la].filter(l => !lb.has(l));
  out.push(
    came.length || went.length
      ? `text${
          came.length
            ? ` now shows ${came
                .slice(0, 4)
                .map(l => JSON.stringify(l.slice(0, 60)))
                .join(', ')}`
            : ''
        }${
          went.length
            ? `${came.length ? ';' : ''} no longer shows ${went
                .slice(0, 4)
                .map(l => JSON.stringify(l.slice(0, 60)))
                .join(', ')}`
            : ''
        }`
      : 'text unchanged',
  );
  return out;
}
// Render a URL, optionally after starting a server with `serve` in `root`
// (stopped afterwards, whatever happens). Returns facts as text and, when a
// path is given, a PNG screenshot for the session's report.
// inputs: the page is then played as its user would, input by input, and what each did is stated.
export async function renderFacts(
  root: string,
  url: string,
  serve: string | undefined,
  screenshotPath: string | null,
  timeoutMs = 60000,
  inputs: PageInput[] = [],
): Promise<{ ok: boolean; text: string; unmatched?: string[] }> {
  const browser = await findBrowser();
  if (!browser)
    return {
      ok: false,
      text: 'No browser is installed on this machine (chromium or google-chrome); the page cannot be rendered.',
    };
  let server: Started | null = null;
  try {
    if (serve && serve.trim()) {
      const wait = Math.min(timeoutMs, 45000);
      server = await startServer(root, serve, url, wait);
      if (server.ready !== true) return { ok: false, text: notAnswering(serve, url, server, wait) };
    }
    const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-extensions',
        '--remote-debugging-pipe',
        '--window-size=1280,900',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    );
    const cdp = new Cdp(child);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'])
        await cdp.send(m, {}, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      const until = Date.now() + Math.min(timeoutMs, 30000);
      while (Date.now() < until && !cdp.events.some(e => e.method === 'Page.loadEventFired')) await sleep(200);
      await sleep(1500);
      const evaluated = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId);
      const facts = evaluated?.result?.value as Facts | undefined;
      // Played: each input, then what the page did in the time after it. Exceptions are told by the input
      // after which they were thrown; one thrown while playing fails the observation, as one at load does.
      const played: string[] = [];
      const playErrors: string[] = [];
      const loadThrown = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length;
      if (facts && inputs.length) {
        const look = async (): Promise<Snap> =>
          (await cdp.send('Runtime.evaluate', { expression: snapshot, returnByValue: true }, sessionId))?.result
            ?.value as Snap;
        const thrown = () => cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length;
        await cdp.send('Runtime.evaluate', { expression: countFrames }, sessionId);
        await sleep(300);
        let before = await look();
        for (const [i, input] of inputs.slice(0, 12).entries()) {
          const ms = Math.max(0, Math.min(10000, Math.round(input.ms)));
          const errorsBefore = thrown();
          let did = '';
          if (input.do === 'press' || input.do === 'hold') {
            const k = keyOf(input.what.trim());
            if (!k)
              did = `${input.do} ${JSON.stringify(input.what)}: not a key this observer knows (Enter, Space, Escape, Tab, Backspace, Shift, arrows, a letter or a digit)`;
            else {
              await cdp.send(
                'Input.dispatchKeyEvent',
                {
                  type: 'keyDown',
                  key: k.key,
                  code: k.code,
                  windowsVirtualKeyCode: k.keyCode,
                  ...(k.text ? { text: k.text } : {}),
                },
                sessionId,
              );
              await sleep(input.do === 'hold' ? ms : 60);
              await cdp.send(
                'Input.dispatchKeyEvent',
                { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode },
                sessionId,
              );
              if (input.do === 'press') await sleep(ms);
              did =
                input.do === 'hold'
                  ? `held ${k.key === ' ' ? 'Space' : k.key} for ${ms} ms`
                  : `pressed ${k.key === ' ' ? 'Space' : k.key}, then ${ms} ms`;
            }
          } else if (input.do === 'type') {
            await cdp.send('Input.insertText', { text: input.what }, sessionId);
            await sleep(ms);
            did = `typed ${JSON.stringify(input.what.slice(0, 60))}, then ${ms} ms`;
          } else if (input.do === 'click') {
            const at = (
              await cdp
                .send(
                  'Runtime.evaluate',
                  {
                    expression: `(() => { const e = document.querySelector(${JSON.stringify(input.what)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
                    returnByValue: true,
                  },
                  sessionId,
                )
                .catch(() => null)
            )?.result?.value;
            if (!at) did = `click ${JSON.stringify(input.what)}: no element matches that selector`;
            else {
              for (const type of ['mousePressed', 'mouseReleased'])
                await cdp.send(
                  'Input.dispatchMouseEvent',
                  { type, x: at.x, y: at.y, button: 'left', clickCount: 1 },
                  sessionId,
                );
              await sleep(ms);
              did = `clicked ${input.what}, then ${ms} ms`;
            }
          } else {
            await sleep(ms);
            did = `waited ${ms} ms`;
          }
          const after = await look();
          const seconds = (after.t - before.t) / 1000;
          const errs = cdp.events
            .filter(e => e.method === 'Runtime.exceptionThrown')
            .slice(errorsBefore)
            .map(e =>
              String(e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text ?? '')
                .split('\n')[0]!
                .slice(0, 200),
            );
          if (errs.length) playErrors.push(`after input ${i + 1} (${did}): ${errs.join(' | ')}`);
          played.push(
            `${i + 1}. ${did}: ${errs.length ? `exception: ${errs.join(' | ')}; ` : ''}${after.frames - before.frames} frames drawn in ${seconds.toFixed(1)} s; ${changes(before, after).join('; ')}`,
          );
          before = after;
        }
      }
      if (screenshotPath) {
        try {
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
          await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
        } catch {
          /* the facts matter more */
        }
      }
      // The browser requests /favicon.ico by itself when a page declares no icon: that request is the browser's, not the page's.
      const own = (u: string) => !/\/favicon\.ico(?:$|\?)/.test(u);
      const errors = cdp.events
        .filter(e => e.method === 'Runtime.exceptionThrown')
        .slice(0, loadThrown)
        .map(e =>
          String(e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text ?? '')
            .split('\n')[0]!
            .slice(0, 200),
        );
      const consoleErrors = cdp.events
        .filter(
          e => e.method === 'Runtime.consoleAPICalled' && (e.params?.type === 'error' || e.params?.type === 'warning'),
        )
        .map(
          e =>
            `${e.params.type}: ${(e.params.args ?? [])
              .map((a: any) => a.value ?? a.description ?? '')
              .join(' ')
              .slice(0, 200)}`,
        );
      const logErrors = cdp.events
        .filter(
          e =>
            e.method === 'Log.entryAdded' &&
            e.params?.entry?.level === 'error' &&
            own(String(e.params.entry.url ?? '')),
        )
        .map(e => String(e.params.entry.text ?? '').slice(0, 200));
      const failed = cdp.events
        .filter(
          e =>
            e.method === 'Network.responseReceived' &&
            (e.params?.response?.status ?? 0) >= 400 &&
            own(String(e.params.response.url)),
        )
        .map(e => `${e.params.response.status} ${String(e.params.response.url).slice(0, 120)}`);
      // A request that never completed, by its URL (the requestId means nothing to the worker) and, when the
      // response came before the browser refused it (ORB blocks a cross-origin "image" whose body is not one),
      // its status and content type: an HTML 404 page served for an image URL reads as such.
      const sent = new Map(
        cdp.events
          .filter(e => e.method === 'Network.requestWillBeSent')
          .map(e => [e.params?.requestId, String(e.params?.request?.url ?? '')]),
      );
      const answered = new Map(
        cdp.events
          .filter(e => e.method === 'Network.responseReceived')
          .map(e => [e.params?.requestId, e.params?.response]),
      );
      const notLoaded = cdp.events
        .filter(e => e.method === 'Network.loadingFailed')
        .map(e => {
          const id = e.params?.requestId;
          const r = answered.get(id);
          return `failed: ${String(e.params?.errorText ?? '')} ${(sent.get(id) || String(id ?? '')).slice(0, 120)}${r ? ` (response ${r.status}${r.mimeType ? ` ${r.mimeType}` : ''})` : ''}`;
        });
      if (!facts) return { ok: false, text: `Rendered ${url} but the page could not be inspected (no document).` };
      const messages = [...consoleErrors, ...logErrors].slice(0, 12);
      const requests = [...new Set([...failed, ...notLoaded])].slice(0, 12);
      const c = facts.classes;
      const verdict = [
        errors.length ? `exceptions thrown in the page: ${errors.slice(0, 12).join(' | ')}` : '',
        playErrors.length ? `exceptions thrown while it was played: ${playErrors.join(' | ')}` : '',
        requests.length ? `requests that failed: ${requests.join(' | ')}` : '',
        facts.images.length ? `images that did not load: ${facts.images.join(' | ')}` : '',
      ].filter(Boolean);
      const ok = !verdict.length;
      const lines = [
        ok
          ? `Rendered ${url}: no exception, every request and image loaded${c.used ? `; ${c.used - c.unmatched} of the ${c.used} class names on visible elements match a CSS rule` : ''}.`
          : `RENDER FAILED for ${url}, ${verdict.length} problem(s):\n- ${verdict.join('\n- ')}`,
        messages.length ? `Console messages: ${messages.join(' | ')}` : '',
        `Page: title "${facts.title}"; ${facts.viewport}, height ${facts.docHeight}px; body font ${facts.font}; background ${facts.background}; ${facts.textLength} characters of text.`,
        `Styling: ${facts.rules} CSS rules; ${c.used - c.unmatched} of the ${c.used} class names on visible elements match a CSS selector${c.unmatched ? ` (without one: ${c.sample.join(', ')}${c.unmatched > c.sample.length ? ', …' : ''})` : ''}; ${facts.inline} elements with a style attribute; ${facts.shadow} shadow roots.`,
        facts.scrollWidth > Number(facts.viewport.split('x')[0]) + 2
          ? `The page scrolls sideways: it is ${facts.scrollWidth}px wide in a ${facts.viewport.split('x')[0]}px viewport.`
          : '',
        facts.overflow.length
          ? `Elements cut by the viewport's edge (partly on screen) in a ${facts.viewport.split('x')[0]}px viewport: ${facts.overflow.join(' | ')}`
          : '',
        facts.offscreen.length
          ? `Elements wholly outside the viewport (not on screen where they are)${facts.scrollWidth > Number(facts.viewport.split('x')[0]) + 2 ? '' : ', the page not scrolling to them'}: ${facts.offscreen.join(' | ')}`
          : '',
        `Headings: ${facts.headings.length ? facts.headings.join(' | ') : 'none'}`,
        facts.empty.length ? `Visible regions with no text or media: ${facts.empty.join(' | ')}` : '',
        `Links: ${facts.links.length ? facts.links.slice(0, 12).join(' | ') : 'none'}`,
        `Text begins: ${facts.textHead}`,
        played.length
          ? `Played as its user would (each input, then what the page did until the next):\n${played.join('\n')}`
          : '',
      ].filter(Boolean);
      return { ok, text: lines.join('\n'), ...(c.unmatched ? { unmatched: c.all } : {}) };
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  } finally {
    server?.stop();
  }
}
