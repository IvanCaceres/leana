// Running a session, for the command line and the app alike: the model client of the configured
// provider, the config fitted to what that model is, the repository lock, the live display, and the
// summary line at the end.
import { open, readFile, readdir, realpath, unlink, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Config, Log, Session } from './types.js';
import { Bonsai, Jev } from './clients.js';
import { OpenRouter } from './openrouter.js';
import { describeModel, effortsOf, fitToModel, unsupportedSettings, type ModelInfo } from './models.js';
import { Agent, newSession } from './agent.js';
import { Store, runsDir, stateDir } from './store.js';
import { runCommand } from './commands.js';
import { Display } from './display.js';

// A key file holds one key, or NAME=key (TYPESAFE_API_KEY, OPENROUTER_API_KEY, any NAME).
export async function readKey(path: string): Promise<string> {
  const value = (await readFile(path.replace(/^~(?=\/)/, homedir()), 'utf8')).trim();
  const match = value.match(/^(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*(.+)$/m);
  const key = (match?.[1] ?? value).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key || /\s/.test(key)) throw new Error('Key file must contain one key or one NAME=key assignment');
  return key;
}
// The key of the model's provider: OpenRouter's from OPENROUTER_API_KEY or providerKeyFile; a local
// llama-server's from LOCAL_API_KEY (it checks none unless started with --api-key).
export async function providerKey(config: Config): Promise<string> {
  if (config.provider === 'openrouter')
    return config.providerKeyFile ? readKey(config.providerKeyFile) : (process.env.OPENROUTER_API_KEY ?? '');
  return process.env.LOCAL_API_KEY ?? 'local';
}
export type ModelClient = Bonsai | OpenRouter;
export function modelClient(config: Config, key: string, log: Log): ModelClient {
  return config.provider === 'openrouter' ? new OpenRouter(config, key, log) : new Bonsai(config, key, log);
}
// The config a run uses with this model: limits fitted to it, an effort it takes (its default, or the
// first it lists, when the configured one is not), reasoning off when it cannot reason; and what was changed.
export function forModel(config: Config, m: ModelInfo): { config: Config; notes: string[] } {
  const notes = unsupportedSettings(config, m);
  let c = fitToModel(config, m);
  const efforts = effortsOf(m.reasoning);
  if (!m.reasoning.supported) c = { ...c, stepThinking: false, codeThinking: false };
  else if (efforts.length && !efforts.includes(c.thinkingEffort))
    c = {
      ...c,
      thinkingEffort:
        m.reasoning.defaultEffort && efforts.includes(m.reasoning.defaultEffort)
          ? m.reasoning.defaultEffort
          : efforts.includes('medium')
            ? 'medium'
            : efforts[0]!,
    };
  if (
    c.contextWindow !== config.contextWindow ||
    c.maxTokens !== config.maxTokens ||
    c.workingTokens !== config.workingTokens
  )
    notes.push(
      `limits fitted to ${m.id}: window ${c.contextWindow}, reply ${c.maxTokens}, working ${c.workingTokens} tokens`,
    );
  return { config: c, notes };
}
// A new run over files an earlier session changed re-does or fights that work.
export async function dirtySessionConflict(root: string): Promise<string | null> {
  const git = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], root, 10000).catch(
    () => null,
  );
  if (!git || git.code !== 0) return null;
  const dirty = git.output
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3).trim());
  if (!dirty.length) return null;
  const runs = runsDir(root);
  const names = (await readdir(runs).catch(() => [] as string[])).sort().reverse();
  for (const name of names) {
    const path = join(runs, name);
    let s: any;
    try {
      s = JSON.parse(await readFile(join(path, 'checkpoint.json'), 'utf8'));
    } catch {
      continue;
    }
    const touched = ((s.writes as string[]) ?? []).filter(w => dirty.includes(w));
    if (touched.length)
      return `Repository has uncommitted changes to ${touched.join(', ')} made by session ${path} (${s.status} at step ${s.step}). Resume that session, revert the files, or pass --allow-dirty to start over on top of them.`;
  }
  return null;
}
// The sessions of a repository, newest first, with their state.
export async function sessionsOf(
  root: string,
  limit = 10,
): Promise<{ path: string; status: string; step: number; objective: string }[]> {
  const runs = runsDir(root);
  const out = [];
  for (const name of (await readdir(runs).catch(() => [] as string[])).sort().reverse().slice(0, limit)) {
    try {
      const s = JSON.parse(await readFile(join(runs, name, 'checkpoint.json'), 'utf8'));
      out.push({
        path: join(runs, name),
        status: String(s.status),
        step: Number(s.step),
        objective: String(s.objective ?? ''),
      });
    } catch {
      /* no checkpoint yet */
    }
  }
  return out;
}
export interface RunRequest {
  config: Config;
  jevKey: string;
  objective?: string;
  repo?: string;
  sessionDir?: string;
  message?: string;
  allowDirty?: boolean;
  // Called with the agent once it runs, so the caller can stop it.
  started?: (agent: Agent) => void;
  out?: (line: string) => void;
}
export interface RunOutcome {
  session: Session;
  store: Store;
  elapsedMs: number;
  steps: number;
  model: ModelInfo;
  notes: string[];
}
// A run (objective and repo) or a resume (sessionDir, with an optional message), to its end or pause.
export async function runSession(req: RunRequest): Promise<RunOutcome> {
  const say = req.out ?? ((l: string) => console.error(l));
  const key = await providerKey(req.config);
  const model = await describeModel(req.config, key);
  const { config, notes } = forModel(req.config, model);
  for (const n of notes) say(`Note: ${n}`);
  let store: Store;
  let session: Session;
  if (req.sessionDir) {
    store = new Store(await realpath(resolve(req.sessionDir)));
    session = await store.load();
    if (session.status === 'complete' && !req.message)
      throw new Error('Session is complete; give a message for additional work');
    const note = `\nRecovery note: ${session.stopReason}`;
    if (session.stopReason && !session.instructions.endsWith(note)) session.instructions += note;
    const update = `\nUser update: ${req.message}`;
    if (req.message && !session.objective.includes(update)) session.objective += update;
    if (Buffer.byteLength(session.objective) > 6000 || Buffer.byteLength(session.instructions) > 12000)
      throw new Error('Resumed pinned context exceeds budget');
  } else {
    if (!req.objective?.trim()) throw new Error('An objective is needed');
    const root = await realpath(resolve(req.repo ?? '.'));
    const conflict = req.allowDirty ? null : await dirtySessionConflict(root);
    if (conflict) throw new Error(conflict);
    store = new Store(
      join(runsDir(root), `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`),
    );
    session = await newSession(root, req.objective);
  }
  await store.init();
  // One active Leana invocation per repository, including different session folders.
  await mkdir(stateDir(session.root), { recursive: true });
  const lockPath = join(stateDir(session.root), 'run.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error(`Repository is locked. If no Leana process is running, remove ${lockPath}`);
  }
  try {
    await lock.writeFile(String(process.pid));
    const log = store.log.bind(store);
    const jev = new Jev(config, req.jevKey, log);
    const client = modelClient(config, key, log);
    await store.log('start', {
      config: { ...config },
      root: session.root,
      model: {
        provider: model.provider,
        id: model.id,
        contextLength: model.contextLength,
        maxOutput: model.maxOutput,
        reasoning: model.reasoning,
        params: model.params,
      },
    });
    say(`Session: ${store.path}`);
    say(
      `Model: ${model.provider} ${model.id} | reasoning ${config.stepThinking || model.reasoning.mandatory ? `on${effortsOf(model.reasoning).length ? ` (${config.thinkingEffort})` : ''}` : 'off'} | window ${config.contextWindow} tokens, working ${config.workingTokens}${config.promptForm === 'tools' ? ' | native tool calls' : config.promptForm === 'text' ? ' | JSON replies (no tools)' : ''}`,
    );
    if (config.allowBash) say('Shell enabled: commands run unsandboxed with your user privileges.');
    const display = new Display(process.stderr, {
      objective: session.objective,
      session: basename(store.path),
      verbose: config.verbose,
      model: `${model.provider}:${model.id}`,
      name: model.provider === 'llama' ? 'Bonsai' : model.id.split('/').pop()!,
    });
    const startedAt = Date.now();
    const stepsBefore = session.step;
    const agent = new Agent(
      config,
      store,
      jev,
      client,
      session.root,
      line => display.log(line),
      e => display.update(e),
    );
    req.started?.(agent);
    let result: Session;
    try {
      result = await agent.run(session);
    } finally {
      display.close();
    }
    return {
      session: result,
      store,
      elapsedMs: Date.now() - startedAt,
      steps: result.step - stepsBefore,
      model,
      notes,
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export const elapsed = (ms: number): string => {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
};
