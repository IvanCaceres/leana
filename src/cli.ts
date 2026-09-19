#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { Bonsai, Jev } from './clients.js';
import { newSession, Runner } from './runner.js';
import { Store } from './store.js';
import { runCommand } from './tools.js';

export async function readKey(path: string): Promise<string> {
  const value = (await readFile(path.replace(/^~(?=\/)/, homedir()), 'utf8')).trim();
  const match = value.match(/^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+)$/m);
  const key = (match?.[1] ?? value).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key || /\s/.test(key)) throw new Error('Key file must contain one key or a TYPESAFE_API_KEY assignment');
  return key;
}
async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, config: { type: 'string' }, 'key-file': { type: 'string' },
    'env-file': { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-bash': { type: 'boolean' },
    'max-steps': { type: 'string' }, message: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, ...rest] = positionals;
  if (v.help || !command) {
    console.log(`Leana — Jev-directed local coding agent\n\n  leana doctor [--config file] [--key-file file]\n  leana run "objective" --repo path [--allow-write] [--allow-bash]\n  leana resume session-directory [--message "new guidance"]\n\nOptions: --key-file PATH, --env-file PATH, --config PATH, --max-steps N\nDefault: read-only tools; shell is disabled. --allow-bash permits unsandboxed\ncommands with your user privileges, including file changes outside the repository.\nJev receives the objective, task ledger and bounded excerpts of repository evidence.\nSessions and action logs are stored under REPO/.leana/runs/.`);
    return;
  }
  if (!['run', 'resume', 'doctor'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (v['env-file']) process.loadEnvFile(resolve(v['env-file']));
  const config = await loadConfig(v.config, {
    ...(v['allow-write'] ? { allowWrite: true } : {}), ...(v['allow-bash'] ? { allowBash: true } : {}),
    ...(v['max-steps'] ? { maxSteps: Number(v['max-steps']) } : {}),
  });
  const key = v['key-file'] ? await readKey(v['key-file']) : process.env.TYPESAFE_API_KEY ?? '';
  const localKey = process.env.LOCAL_API_KEY ?? 'local';
  if (command === 'doctor') {
    const log = async (type: string, data: unknown) => console.log(JSON.stringify({ type, data }));
    const rg = await runCommand('rg', ['--version'], process.cwd(), 5000);
    if (rg.code !== 0) throw new Error('ripgrep is required');
    const bonsai = new Bonsai(config, localKey, log);
    const result = await bonsai.generate([{ role: 'user', content: 'Return {"ok":true} as JSON.' }], {
      type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
    });
    if (result.ok !== true) throw new Error('Local model smoke check failed');
    console.log('Bonsai JSON generation: OK');
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
    if (session.stopReason) session.instructions += `\nRecovery note: ${session.stopReason}`;
    if (v.message) session.objective += `\nUser update: ${v.message}`;
    if (Buffer.byteLength(session.objective) > 6000 || Buffer.byteLength(session.instructions) > 12000) throw new Error('Resumed pinned context exceeds budget');
  } else {
    if (rest.length !== 1) throw new Error('run requires one quoted objective');
    const root = await realpath(resolve(v.repo ?? '.'));
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
    if (config.allowBash) console.error('Shell enabled: commands run unsandboxed with your user privileges.');
    const result = await new Runner(config, store, jev, bonsai, session.root).run(session);
    console.log(`\n${result.status.toUpperCase()}: ${result.stopReason}\nSession: ${store.path}`);
    if (result.status !== 'complete') process.exitCode = 2;
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href)
  main().catch(e => { console.error(`Leana: ${(e as Error).message}`); process.exitCode = 1; });
