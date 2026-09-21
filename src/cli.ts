#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, readdir, realpath, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { Bonsai, Jev, postJson } from './clients.js';
import { newSession, Runner } from './runner.js';
import { Store } from './store.js';
import { runCommand } from './tools.js';
import { renderReport } from './report.js';
import { Display } from './display.js';
import { basename } from 'node:path';

export async function readKey(path: string): Promise<string> {
  const value = (await readFile(path.replace(/^~(?=\/)/, homedir()), 'utf8')).trim();
  const match = value.match(/^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+)$/m);
  const key = (match?.[1] ?? value).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key || /\s/.test(key)) throw new Error('Key file must contain one key or a TYPESAFE_API_KEY assignment');
  return key;
}
// A new run over files an earlier session changed re-does or fights that work.
export async function dirtySessionConflict(root: string): Promise<string | null> {
  const git = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], root, 10000).catch(() => null);
  if (!git || git.code !== 0) return null;
  const dirty = git.output.split('\n').filter(Boolean).map(l => l.slice(3).trim());
  if (!dirty.length) return null;
  const runs = join(root, '.leana', 'runs');
  const names = (await readdir(runs).catch(() => [] as string[])).sort().reverse();
  for (const name of names) {
    const path = join(runs, name);
    let s: any;
    try { s = JSON.parse(await readFile(join(path, 'checkpoint.json'), 'utf8')); } catch { continue; }
    const touched = (s.writes as string[] ?? []).filter(w => dirty.includes(w));
    if (touched.length) return `Repository has uncommitted changes to ${touched.join(', ')} made by session ${path} (${s.status} at step ${s.step}). Resume that session, revert the files, or pass --allow-dirty to start over on top of them.`;
  }
  return null;
}
async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, config: { type: 'string' }, 'key-file': { type: 'string' },
    'env-file': { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-bash': { type: 'boolean' },
    'max-steps': { type: 'string' }, message: { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'allow-dirty': { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' }, follow: { type: 'boolean' }, check: { type: 'string' },
  } });
  const [command, ...rest] = positionals;
  if (v.help || !command) {
    console.log(`Leana — Jev-directed local coding agent\n\n  leana doctor [--config file] [--key-file file]\n  leana run "objective" --repo path [--allow-write] [--allow-bash]\n  leana resume session-directory [--message "new guidance"]\n  leana report session-directory [--follow]   write report.html with prompts, Jev decisions, latency, tokens and context use\n\nOptions: --key-file PATH, --env-file PATH, --config PATH, --max-steps N, --allow-dirty, --verbose,\n         --check "command" (the verification; run as a baseline first and after every edit)\nDefault: read-only tools; shell is disabled. --allow-bash permits unsandboxed\ncommands with your user privileges, including file changes outside the repository.\nJev receives the objective, task ledger and bounded excerpts of repository evidence.\nSessions and action logs are stored under REPO/.leana/runs/.`);
    return;
  }
  if (!['run', 'resume', 'doctor', 'report'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'report') {
    if (rest.length !== 1) throw new Error('report requires a session-directory');
    const dir = await realpath(resolve(rest[0]!));
    const write = async () => { await renderReport(dir); return join(dir, 'report.html'); };
    console.log(await write());
    if (v.follow) {
      const { stat } = await import('node:fs/promises');
      let last = (await stat(join(dir, 'events.jsonl'))).size;
      setInterval(async () => { const size = (await stat(join(dir, 'events.jsonl')).catch(() => ({ size: last }))).size; if (size !== last) { last = size; await write(); } }, 3000);
      console.error('Following the session; press Ctrl-C to stop.');
    }
    return;
  }
  if (v['env-file']) process.loadEnvFile(resolve(v['env-file']));
  const config = await loadConfig(v.config, {
    ...(v['allow-write'] ? { allowWrite: true } : {}), ...(v['allow-bash'] ? { allowBash: true } : {}),
    ...(v['max-steps'] ? { maxSteps: Number(v['max-steps']) } : {}), ...(v.verbose ? { verbose: true } : {}), ...(v.check ? { checkCommand: v.check } : {}),
  });
  const key = v['key-file'] ? await readKey(v['key-file']) : process.env.TYPESAFE_API_KEY ?? '';
  const localKey = process.env.LOCAL_API_KEY ?? 'local';
  if (command === 'doctor') {
    // Raw events only when asked; the summary lines are the point of doctor.
    const log = async (type: string, data: unknown) => { if (config.verbose) console.log(JSON.stringify({ type, data })); };
    const rg = await runCommand('rg', ['--version'], process.cwd(), 5000);
    if (rg.code !== 0) throw new Error('ripgrep is required');
    const bonsai = new Bonsai(config, localKey, log);
    const result = await bonsai.generate([{ role: 'user', content: 'Return {"ok":true} as JSON.' }], {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    });
    if (result.ok !== true) throw new Error('Local model smoke check failed');
    console.log('Bonsai JSON generation: OK');
    // Prefix-cache probe: a long prompt, then the same prompt changed in the
    // middle. A server that can resume from a checkpoint reuses the shared
    // prefix; one that cannot reprocesses everything on every step.
    // A fresh nonce per run: the server keeps earlier prompt states in host memory
    // and would otherwise restore a previous doctor run's prompt instead of proving
    // it can resume from a checkpoint inside this one.
    // The harness sends its prompt as several user messages, because llama.cpp
    // checkpoints hybrid and sliding-window models only at user-message starts.
    // Probe that exact shape: eight messages, then the same with the sixth changed.
    const nonce = randomUUID();
    const block = (i: number, mark = '') => ({ role: 'user', content: `Block ${i} (${nonce}${mark}): ` + Array.from({ length: 40 }, (_, j) => `the harness records evidence ${i}.${j} about the repository`).join('; ') });
    const probe = async (blocks: unknown[]) => {
      const r = await postJson(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, { model: config.model, messages: [{ role: 'system', content: 'Reply with one word.' }, ...blocks],
        max_tokens: 1, temperature: 0, stream: false, cache_prompt: true, chat_template_kwargs: { enable_thinking: false } }, localKey, 180000, 0);
      return { total: r.usage?.prompt_tokens ?? 0, cached: r.usage?.prompt_tokens_details?.cached_tokens ?? r.timings?.cache_n ?? 0, ms: r.timings?.prompt_ms ?? 0 };
    };
    const blocks = Array.from({ length: 8 }, (_, i) => block(i));
    const first = await probe(blocks);
    const changed = await probe(blocks.map((b, i) => i === 5 ? block(i, ' changed') : b));
    const share = first.total ? Math.round(100 * changed.cached / first.total) : 0;
    console.log(`Bonsai prefix cache: ${changed.cached} of ${changed.total} prompt tokens reused after changing message 6 of 8 (${share}%, ideal about 62%); prompt processing ${changed.ms.toFixed(0)} ms after the change, ${first.ms.toFixed(0)} ms for the full prompt`);
    if (share < 40) console.log('  The server is not resuming from the message boundary before the change. Start llama-server with --checkpoint-min-step 0 --ctx-checkpoints 128 so a checkpoint is created at the start of every user message (the default spacing of 8192 tokens skips them); keep cache_prompt enabled.');
    const jev = new Jev(config, key, log);
    const a = await jev.decide({ test: 'The build exited with code zero. No changes are needed.' }, {
      successful: { type: 'noul', instructions: 'Did the build succeed?' },
      next: { type: 'choice', instructions: 'Which next action fits the stated test?', criteria: { report: 'Report successful completion.', debug: 'Debug a failed build.' } },
    });
    console.log(`Jev typed API: OK (${JSON.stringify(a)})`);
    return;
  }
  let store: Store;
  let session;
  if (command === 'resume') {
    if (rest.length !== 1) throw new Error('resume requires a session-directory');
    store = new Store(await realpath(resolve(rest[0]!))); session = await store.load();
    if (session.status === 'complete' && !v.message) throw new Error('Session is complete; provide --message for additional work');
    const note = `\nRecovery note: ${session.stopReason}`;
    if (session.stopReason && !session.instructions.endsWith(note)) session.instructions += note;
    const update = `\nUser update: ${v.message}`;
    if (v.message && !session.objective.includes(update)) session.objective += update;
    if (Buffer.byteLength(session.objective) > 6000 || Buffer.byteLength(session.instructions) > 12000) throw new Error('Resumed pinned context exceeds budget');
  } else {
    if (rest.length !== 1) throw new Error('run requires one quoted objective');
    if (v.message) throw new Error('--message applies to resume; pass the objective for run as the quoted argument');
    const root = await realpath(resolve(v.repo ?? '.'));
    const conflict = v['allow-dirty'] ? null : await dirtySessionConflict(root);
    if (conflict) throw new Error(conflict);
    store = new Store(join(root, '.leana', 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
    session = await newSession(root, rest[0]!);
  }
  await store.init();
  // One active Leana invocation per repository, including different session folders.
  const lockPath = join(session.root, '.leana', 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new Error(`Repository is locked. If no Leana process is running, remove ${lockPath}`); }
  try {
    await lock.writeFile(String(process.pid));
    const log = store.log.bind(store);
    const jev = new Jev(config, key, log);
    const bonsai = new Bonsai(config, localKey, log);
    await store.log('start', { config, root: session.root });
    console.error(`Session: ${store.path}`);
    console.error(`Jev questions and answers: ${join(store.path, 'jev-decisions.md')}`);
    console.error(`Report: node dist/src/cli.js report ${store.path} --follow`);
    if (config.allowBash) console.error('Shell enabled: commands run unsandboxed with your user privileges.');
    // A live panel on a terminal; plain lines otherwise (logs, CI, pipes).
    const display = new Display(process.stderr, { objective: session.objective, session: basename(store.path), verbose: config.verbose });
    let result;
    const startedAt = Date.now(); const stepsBefore = session.step;
    try { result = await new Runner(config, store, jev, bonsai, session.root, line => display.log(line), e => display.update(e)).run(session); }
    finally { display.close(); }
    // Wall-clock for this invocation and, when the session was resumed, since its first event.
    const fmt = (ms: number) => { const sec = Math.round(ms / 1000); return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`; };
    let since = '';
    try {
      const first = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n')[0];
      const at = first ? Date.parse(JSON.parse(first).at) : NaN;
      if (Number.isFinite(at) && at < startedAt - 5000) since = `; ${fmt(Date.now() - at)} since the session began`;
    } catch { /* no event log */ }
    console.log(`\n${result.status.toUpperCase()}: ${result.stopReason}\nElapsed: ${fmt(Date.now() - startedAt)} for ${result.step - stepsBefore} steps (${result.step} in total)${since}\nSession: ${store.path}`);
    if (result.status !== 'complete') process.exitCode = 2;
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href)
  main().catch(e => { console.error(`Leana: ${(e as Error).message}`); process.exitCode = 1; });
