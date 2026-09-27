// Starting what an observation looks at: a command that runs in the repository
// root and keeps running (a dev server, a service), waited on until its URL
// answers, and stopped afterwards whatever happens. Shared by every observer
// that needs something running.
import { spawn, type ChildProcess } from 'node:child_process';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Waits for the URL to answer. A server that announces its own address and it
// is another port is not going to answer at this one: after a short grace the
// wait ends with the addresses it announced, instead of running out the clock.
export async function waitForUrl(url: string, timeoutMs: number, elsewhere?: () => string[] | null): Promise<true | string[] | false> {
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

// Local addresses a process's output says it is listening at (a dev server's
// "Local: http://localhost:5173/", Django's "Starting development server at …").
export function localAddresses(output: string): string[] {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  return [...new Set([...plain.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/g)].map(m => m[0].replace(/[.,;)]+$/, '')))];
}
export interface Started { ready: true | string[] | false; log: () => string; stop: () => void }
// Starts `command` and waits for `url` to answer: true when it does, the
// addresses the server announced when it listens elsewhere, false on timeout.
export async function startServer(root: string, command: string, url: string, timeoutMs: number): Promise<Started> {
  const out: string[] = [];
  const child: ChildProcess = spawn('bash', ['--noprofile', '--norc', '-c', command], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', BROWSER: 'none' } });
  child.stdout?.on('data', d => out.push(String(d))); child.stderr?.on('data', d => out.push(String(d)));
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref(); } };
  const ready = await waitForUrl(url, timeoutMs, () => announcedElsewhere(out.join(''), url));
  return { ready, log: () => out.join(''), stop };
}
// What a start that did not answer at the URL is reported as.
export function notAnswering(command: string, url: string, started: Started, timeoutMs: number): string {
  return Array.isArray(started.ready)
    ? `The server started with "${command}" says it is listening at ${started.ready.join(', ')}, and nothing answered at ${url}. Its output:\n${started.log().slice(-1500)}`
    : `The server started with "${command}" did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s. Its output:\n${started.log().slice(-1500)}`;
}
