// Starting what an observation looks at: a command that runs in the repository
// root and keeps running (a dev server, a service), waited on until its URL
// answers, and stopped afterwards whatever happens. Shared by every observer
// that needs something running.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { bashPath, killTree, missingBash, runMark, shellEnv } from './shell.js';

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
export interface Started { ready: true | string[] | false; log: () => string; stop: () => void; exited?: () => number | string | null }
// Starts `command` and waits for `url` to answer: true when it does, the
// addresses the server announced when it listens elsewhere, false on timeout.
// With no URL (what is observed is a program run beside it) it is ready once an
// address it announced on this machine accepts a connection, or, announcing
// none, once it has run for a few seconds; false when it exits first or no
// announced address accepts a connection in time.
export async function startServer(root: string, command: string, url: string | null, timeoutMs: number): Promise<Started> {
  const out: string[] = [];
  const mark = runMark();
  const child: ChildProcess = spawn(bashPath(), ['--noprofile', '--norc', '-c', command], { cwd: root, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: shellEnv({ ...process.env, CI: '1', FORCE_COLOR: '0', BROWSER: 'none', ...(mark ? { LEANA_RUN: mark } : {}) }) });
  child.stdout?.on('data', d => out.push(String(d))); child.stderr?.on('data', d => out.push(String(d)));
  child.on('error', (e: NodeJS.ErrnoException) => out.push(e.code === 'ENOENT' ? missingBash() : String(e.message)));
  const stop = () => { if (child.pid) { killTree(child.pid, 'SIGTERM', mark); if (process.platform !== 'win32') setTimeout(() => killTree(child.pid), 2000).unref(); } };
  const exited = () => child.exitCode ?? child.signalCode ?? (child.pid ? null : 'not started');
  const ready = url ? await waitForUrl(url, timeoutMs, () => announcedElsewhere(out.join(''), url)) : await waitForStart(timeoutMs, () => out.join(''), exited);
  return { ready, log: () => out.join(''), stop, exited };
}
async function waitForStart(timeoutMs: number, log: () => string, exited: () => number | string | null): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited() !== null) return false;
    const at = localAddresses(log());
    if (at.length) { for (const a of at) if (await connection(new URL(a), 1000) === 'connected') return true; }
    else if (Date.now() - t0 >= 3000) return true;
    await sleep(250);
  }
  return false;
}
// What a start that did not answer at the URL is reported as.
export function notAnswering(command: string, url: string, started: Started, timeoutMs: number): string {
  return Array.isArray(started.ready)
    ? `The server started with "${command}" says it is listening at ${started.ready.join(', ')}, and nothing answered at ${url}. Its output:\n${started.log().slice(-1500)}`
    : `The server started with "${command}" did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s. Its output:\n${started.log().slice(-1500)}`;
}
// Where a URL's connections go ("localhost:5173").
export function listeningAt(url: string): string | null {
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`; } catch { return null; }
}
// Whether a host name is this machine: localhost, loopback, or the unspecified address.
export const localHost = (host: string): boolean => /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1?|0:0:0:0:0:0:0:[01])$/i.test(host.replace(/^\[|\]$/g, ''));
// Whether nothing is listening where a URL's connections go on this machine: true
// only when every address of the host refused the connection. An answer, a timeout,
// an unknown host, or a host that is not this machine (whose refusal can come from
// anything between) is false, left to whoever makes the request to report.
export async function connectionRefused(url: string, timeoutMs = 2000): Promise<boolean> {
  let u: URL; try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || !localHost(u.hostname)) return false;
  return await connection(u, timeoutMs) === 'refused';
}
// What a TCP connection to where a URL's connections go meets.
async function connection(u: URL, timeoutMs: number): Promise<'connected' | 'refused' | 'other'> {
  const host = u.hostname.replace(/^\[|\]$/g, ''); const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return new Promise(done => {
    const socket = connect({ host, port, autoSelectFamily: true, timeout: timeoutMs });
    const end = (r: 'connected' | 'refused' | 'other') => { socket.destroy(); done(r); };
    socket.once('connect', () => end('connected')); socket.once('timeout', () => end('other'));
    socket.once('error', (e: NodeJS.ErrnoException) => end(e.code === 'ECONNREFUSED' ? 'refused' : 'other'));
  });
}
