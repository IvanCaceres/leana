// Leana as an app: a prompt where an objective runs in the current repository and slash commands set up
// the provider, the model and its options. Only what the active provider and model take is offered:
// the options come from the model's own facts (models.ts), and a value it does not take is refused
// with what it does take. Choices are kept in the settings file between runs.
import { createInterface, type Interface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './types.js';
import { loadConfig, saveSettings, type Settings } from './config.js';
import {
  describeModel,
  effortsOf,
  listModels,
  modelOptions,
  providers,
  type ModelInfo,
  type Provider,
} from './models.js';
import {
  dirtySessionConflict,
  elapsed,
  endingLine,
  forModel,
  providerKey,
  runSession,
  sessionsOf,
  stepsOf,
} from './session.js';
import type { Agent } from './agent.js';
import { usageLine } from './display.js';
import type { RunView, RunViewOptions } from './display.js';
import { TerminalUI } from './tui/view.js';

const usd = (perToken: number) => (perToken ? `$${(perToken * 1e6).toFixed(perToken * 1e6 < 1 ? 3 : 2)}` : 'free');
export interface AppOptions {
  base: Config;
  settings: Settings;
  jevKey: string;
  repo: string;
  configPath?: string;
  settingsPath?: string;
  write?: (text: string) => void;
  // What shows a run (the terminal UI); the status panel on stderr by default.
  view?: (o: RunViewOptions) => RunView;
  // Turns the wheel's scrolling on or off in the full-screen app; without it, /mouse does not apply.
  mouse?: (on: boolean) => void;
  // What runs a session: runSession, or a stand-in in a test.
  runSession?: typeof runSession;
}
export class App {
  settings: Settings;
  repo: string;
  allowWrite: boolean;
  allowBash: boolean;
  checkCommand: string;
  private info: ModelInfo | null = null;
  private agent: Agent | null = null;
  running = false;
  // The session the last run worked in: what is typed next continues it, until /new or /repo.
  session: string | null = null;
  // Set by /new: the next objective starts a new session even over changes earlier sessions left uncommitted.
  private fresh = false;
  // The lines the session's last run started with (its session, model, notes): a follow-up shows only what changed.
  private header = new Set<string>();
  private readonly write: (text: string) => void;
  constructor(private opts: AppOptions) {
    this.settings = {
      config: { ...opts.settings.config },
      ...(opts.settings.repo ? { repo: opts.settings.repo } : {}),
    };
    this.repo = opts.repo;
    this.allowWrite = opts.base.allowWrite;
    this.allowBash = opts.base.allowBash;
    this.checkCommand = opts.base.checkCommand;
    this.write = opts.write ?? (t => process.stdout.write(`${t}\n`));
  }
  // The config of the next run: the file's, then the app's choices, then this run's permissions.
  async config(): Promise<Config> {
    return loadConfig(this.opts.configPath, {
      ...this.settings.config,
      allowWrite: this.allowWrite,
      allowBash: this.allowBash,
      checkCommand: this.checkCommand,
    });
  }
  private async key(c?: Config): Promise<string> {
    return providerKey(c ?? (await this.config()));
  }
  async model(refresh = false): Promise<ModelInfo> {
    if (!this.info || refresh) {
      const c = await this.config();
      this.info = await describeModel(c, await this.key(c));
    }
    return this.info;
  }
  private async remember(change: Partial<Config> & Record<string, unknown>): Promise<void> {
    this.settings.config = { ...this.settings.config, ...change } as Partial<Config>;
    await loadConfig(this.opts.configPath, { ...this.settings.config }); // refuses an inconsistent combination before it is kept
    await saveSettings(this.settings, this.opts.settingsPath);
  }
  // Guidance for the run under way: it reaches the run at its next step.
  guide(text: string): boolean {
    if (!this.agent) return false;
    this.agent.guide(text);
    return true;
  }
  stop(): boolean {
    if (!this.agent) return false;
    this.agent.stop();
    return true;
  }
  readonly commands: Record<string, { args: string; help: string; run: (a: string[]) => Promise<void> }> = {
    help: { args: '', help: 'this list', run: async () => this.help() },
    status: {
      args: '',
      help: 'provider, model, repository, permissions and the options set',
      run: async () => this.status(),
    },
    provider: {
      args: '[llama|openrouter]',
      help: 'show or switch the model provider',
      run: async a => this.provider(a[0]),
    },
    models: {
      args: '[words]',
      help: "list the provider's models (OpenRouter: those whose id or name has every word)",
      run: async a => this.models(a),
    },
    model: {
      args: '[id]',
      help: 'show the active model, or switch to another',
      run: async a => (a[0] ? this.switchModel(a[0]) : this.showModel()),
    },
    info: { args: '', help: 'what the active model is and takes', run: async () => this.showModel() },
    options: {
      args: '',
      help: 'the options the active model takes, with their values',
      run: async () => this.showOptions(),
    },
    set: {
      args: '<option> <value>',
      help: 'set an option the active model takes (see /options)',
      run: async a => this.set(a[0], a.slice(1).join(' ')),
    },
    reasoning: {
      args: 'on|off',
      help: 'reason before each step (when the model can)',
      run: async a => this.set('reasoning', a[0]),
    },
    effort: {
      args: '<level>',
      help: 'how much the model reasons (the levels it takes)',
      run: async a => this.set('effort', a[0]),
    },
    budget: {
      args: '<tokens>',
      help: 'most tokens a step may reason for (when the model takes a budget)',
      run: async a => this.set('budget', a[0]),
    },
    repo: { args: '[path]', help: 'show or set the repository runs work in', run: async a => this.setRepo(a[0]) },
    allow: {
      args: 'write|bash on|off',
      help: 'let runs edit files / run shell commands (unsandboxed, with your privileges)',
      run: async a => this.allow(a[0], a[1]),
    },
    check: {
      args: '<command>|off',
      help: 'the verification command (run as a baseline and after edits)',
      run: async a => {
        this.checkCommand = a[0] === 'off' ? '' : a.join(' ');
        this.write(`check: ${this.checkCommand || 'none (the model chooses its check)'}`);
      },
    },
    steps: {
      args: '<n>',
      help: 'most steps a run takes (turns, through OpenRouter)',
      run: async a => {
        const or = (await this.config()).provider === 'openrouter';
        await this.remember(or ? { openrouterMaxTurns: Number(a[0]) } : { maxSteps: Number(a[0]) });
        this.write(`${or ? 'turns' : 'steps'}: ${a[0]}`);
      },
    },
    new: {
      args: '[objective]',
      help: 'start a new session, on top of the changes so far, with this objective or the next one typed',
      run: async a => this.startNew(a.join(' ')),
    },
    sessions: { args: '', help: "the repository's sessions, newest first", run: async () => this.sessions() },
    resume: {
      args: '[n|path] [message]',
      help: 'resume a session (1 = newest), optionally with new guidance',
      run: async a => this.resume(a),
    },
    mouse: {
      args: 'on|off',
      help: 'the mouse wheel scrolls (on), or the mouse selects text to copy (off, the default)',
      run: async a => this.mouse(a[0]),
    },
    quit: { args: '', help: 'leave', run: async () => {} },
  };
  async handle(line: string): Promise<'quit' | void> {
    const t = line.trim();
    if (!t) return;
    if (!t.startsWith('/')) return void (await (this.session ? this.followUp(t) : this.run(t)));
    const [name, ...args] = t.slice(1).split(/\s+/);
    const c = this.commands[name!.toLowerCase()] ?? (name === 'exit' ? this.commands.quit : undefined);
    if (!c) return void this.write(`No command /${name}; /help lists them.`);
    if (c === this.commands.quit) return 'quit';
    try {
      await c.run(args);
    } catch (e) {
      this.write(`/${name}: ${(e as Error).message}`);
    }
  }
  // Completion of command names, provider names, option names and their listed values.
  complete(line: string): [string[], string] {
    const parts = line.split(/\s+/);
    if (parts.length === 1) {
      const hits = Object.keys(this.commands)
        .map(c => `/${c}`)
        .filter(c => c.startsWith(line));
      return [hits, line];
    }
    const word = parts.at(-1)!;
    const cmd = parts[0]!.slice(1);
    let pool: string[] = [];
    if (cmd === 'provider') pool = providers;
    else if (cmd === 'allow') pool = parts.length === 2 ? ['write', 'bash'] : ['on', 'off'];
    else if (cmd === 'reasoning') pool = ['on', 'off'];
    else if (this.info && (cmd === 'set' || cmd === 'effort')) {
      const opts = modelOptions(this.info);
      if (cmd === 'effort') pool = effortsOf(this.info.reasoning);
      else if (parts.length === 2) pool = opts.map(o => o.name);
      else
        pool =
          opts
            .find(o => o.name === parts[1])
            ?.values.split(' | ')
            .filter(v => /^[\w.-]+$/.test(v)) ?? [];
    }
    return [pool.filter(p => p.startsWith(word)), word];
  }
  private help(): void {
    this.write(
      'Type an objective to run it in the repository. After a run, what you type continues that session; /new starts another. Commands:',
    );
    for (const [n, c] of Object.entries(this.commands))
      this.write(`  /${n}${c.args ? ` ${c.args}` : ''}`.padEnd(38) + c.help);
  }
  private async status(): Promise<void> {
    const c = await this.config();
    this.write(`provider   ${c.provider}${c.provider === 'openrouter' ? ` (${c.openrouterUrl})` : ` (${c.baseUrl})`}`);
    this.write(`model      ${c.model}`);
    this.write(`repository ${this.repo}`);
    this.write(`session    ${this.session ?? 'none yet; the next objective starts one'}`);
    this.write(
      `permissions write ${this.allowWrite ? 'on' : 'off'}, shell ${this.allowBash ? 'on' : 'off'}${this.checkCommand ? `; check: ${this.checkCommand}` : ''}; up to ${c.provider === 'openrouter' ? `${c.openrouterMaxTurns} turns` : `${c.maxSteps} steps`}`,
    );
    try {
      const m = await this.model();
      const { config, notes } = forModel(c, m);
      for (const o of modelOptions(m)) this.write(`  ${o.name.padEnd(22)} ${o.get(config)}`);
      for (const n of notes) this.write(`note: ${n}`);
    } catch (e) {
      this.write(`model facts unavailable: ${(e as Error).message}`);
    }
  }
  private async provider(name?: string): Promise<void> {
    if (!name) return void this.write(`provider: ${(await this.config()).provider} (one of ${providers.join(', ')})`);
    if (!providers.includes(name as Provider)) throw new Error(`the providers are ${providers.join(', ')}`);
    const model =
      name === 'llama'
        ? 'bonsai-27b'
        : this.settings.config.provider === 'openrouter'
          ? this.settings.config.model
          : undefined;
    await this.remember({ provider: name as Provider, ...(model ? { model } : {}) });
    this.info = null;
    this.write(
      `provider: ${name}${name === 'openrouter' && !model ? '; choose a model with /models <words> and /model <id>' : ''}`,
    );
    if (name === 'openrouter' && !(await this.key()))
      this.write(
        'OpenRouter needs an API key: set OPENROUTER_API_KEY, or providerKeyFile in the config to a file that holds it.',
      );
  }
  private async models(words: string[]): Promise<void> {
    const c = await this.config();
    const list = await listModels(c, await this.key(c), words.join(' '));
    if (!list.length) return void this.write('No model matches.');
    for (const m of list.slice(0, 25))
      this.write(
        `${m.id === c.model ? '*' : ' '} ${m.id.padEnd(48)} ${String(Math.round(m.contextLength / 1000)).padStart(5)}k ctx  ${m.reasoning.supported ? `reasons${m.reasoning.mandatory ? ' (always)' : ''}`.padEnd(16) : ''.padEnd(16)}${m.pricing ? `${usd(m.pricing.prompt)} in / ${usd(m.pricing.completion)} out per 1M` : ''}`,
      );
    if (list.length > 25) this.write(`… ${list.length - 25} more; add words to narrow it.`);
  }
  private async switchModel(id: string): Promise<void> {
    const c = await this.config();
    const candidate = { ...c, model: id };
    const m = await describeModel(candidate, await this.key(candidate));
    const { notes } = forModel(candidate, m);
    // Neither reasoning nor its effort is kept as fitted to this model: forModel fits them for each run (reasoning
    // off where it cannot reason, the nearest effort it takes), and a switch back finds the choices as they were.
    await this.remember({ model: m.id });
    this.info = m;
    this.write(`model: ${m.id}`);
    for (const n of notes) this.write(`note: ${n}`);
  }
  private async showModel(): Promise<void> {
    const m = await this.model();
    const r = m.reasoning;
    this.write(`${m.name} (${m.provider}: ${m.id})`);
    if (m.description) this.write(m.description.replace(/\s+/g, ' ').slice(0, 400));
    this.write(
      `context ${m.contextLength} tokens; replies up to ${m.maxOutput} tokens${m.pricing ? `; ${usd(m.pricing.prompt)} per 1M prompt tokens, ${usd(m.pricing.completion)} per 1M completion tokens` : ''}`,
    );
    this.write(
      `reasoning: ${!r.supported ? 'no' : `${r.mandatory ? 'always on' : `can be turned on or off${r.defaultEnabled === undefined ? '' : ` (on by default: ${r.defaultEnabled ? 'yes' : 'no'})`}`}; efforts ${effortsOf(r).join(', ') || 'none'}${r.defaultEffort ? ` (default ${r.defaultEffort})` : ''}; token budget ${r.budget ? 'yes' : 'no'}`}`,
    );
    this.write(`JSON schema enforced: ${m.structured ? 'yes' : 'no (the reply is read for a JSON object)'}`);
    this.write(`parameters: ${m.params.join(', ') || 'none listed'}`);
    for (const [k, v] of Object.entries(m.details ?? {})) this.write(`${k}: ${v}`);
  }
  private async showOptions(): Promise<void> {
    const m = await this.model();
    const c = forModel(await this.config(), m).config;
    this.write(`Options ${m.id} takes:`);
    const options = modelOptions(m);
    const width = Math.max(...options.map(o => o.values.length)) + 2;
    const now = Math.max(10, ...options.map(o => o.get(c).length));
    for (const o of options)
      this.write(`  ${o.name.padEnd(22)} ${o.get(c).padEnd(now)} ${o.values.padEnd(width)}${o.describe}`);
  }
  private async set(name?: string, value?: string): Promise<void> {
    if (!name || value === undefined || value === '')
      throw new Error('give an option and a value; /options lists what this model takes');
    const m = await this.model();
    const o = modelOptions(m).find(x => x.name === name);
    if (!o)
      throw new Error(
        `${m.id} does not take ${name}; it takes ${modelOptions(m)
          .map(x => x.name)
          .join(', ')}`,
      );
    const change = o.set(await this.config(), value);
    await this.remember(change);
    this.write(`${name}: ${o.get(await this.config())}`);
  }
  private async setRepo(path?: string): Promise<void> {
    if (!path) return void this.write(`repository: ${this.repo}`);
    this.repo = await realpath(resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')));
    this.session = null;
    this.settings.repo = this.repo;
    await saveSettings(this.settings, this.opts.settingsPath);
    this.write(`repository: ${this.repo}`);
  }
  private async allow(what?: string, value?: string): Promise<void> {
    if (!what || !['write', 'bash'].includes(what) || !value || !/^(on|off)$/.test(value))
      throw new Error('/allow write|bash on|off');
    if (what === 'write') this.allowWrite = value === 'on';
    else this.allowBash = value === 'on';
    this.write(
      `${what}: ${value}${what === 'bash' && value === 'on' ? ' (commands run unsandboxed with your user privileges)' : ''}`,
    );
  }
  private async sessions(): Promise<void> {
    const list = await sessionsOf(this.repo);
    if (!list.length) return void this.write('No sessions in this repository.');
    list.forEach((s, i) =>
      this.write(
        `${String(i + 1).padStart(2)}. ${s.status.padEnd(8)} step ${String(s.step).padStart(3)}  ${s.objective.replace(/\s+/g, ' ').slice(0, 70)}  ${s.path}`,
      ),
    );
  }
  private async resume(a: string[]): Promise<void> {
    const list = await sessionsOf(this.repo);
    const which = a[0] ?? '1';
    const target = /^\d+$/.test(which) ? list[Number(which) - 1]?.path : which;
    if (!target) throw new Error('no such session; /sessions lists them');
    const message = a.slice(1).join(' ');
    // A complete session has nothing left to resume until there is more to do: it becomes the one what is typed
    // next continues.
    if (!message && list.find(s => s.path === target)?.status === 'complete') {
      this.session = target;
      return void this.write(`Session ${target} is complete; what you type next continues it.`);
    }
    await this.go({ sessionDir: target, ...(message ? { message } : {}) });
  }
  private async run(objective: string): Promise<void> {
    if (!this.allowWrite)
      this.write('Note: write is off, so this run can read but not change files (/allow write on).');
    const over = this.fresh;
    this.fresh = false;
    if (!over) {
      const conflict = await dirtySessionConflict(this.repo);
      if (conflict)
        return void this.write(
          conflict.replace(
            / Resume that session, revert the files, or pass --allow-dirty to start over on top of them\.$/,
            ' /resume continues that session; /new <objective> starts a new one on top of its changes.',
          ),
        );
    }
    await this.go({ objective, repo: this.repo, allowDirty: true });
  }
  // What is typed after a run joins that session's objective, as a resume's message does, and the session goes on.
  private async followUp(message: string): Promise<void> {
    try {
      await this.go({ sessionDir: this.session!, message });
    } catch (e) {
      if (/pinned context exceeds budget/.test((e as Error).message))
        throw new Error(
          'This session holds all the follow-ups it can; /new starts a new session on top of its changes.',
        );
      throw e;
    }
  }
  private async startNew(objective: string): Promise<void> {
    this.session = null;
    this.fresh = true;
    if (objective) return this.run(objective);
    this.write('The next objective starts a new session, on top of the changes so far.');
  }
  private async mouse(value?: string): Promise<void> {
    if (!value || !/^(on|off)$/.test(value)) throw new Error('/mouse on|off');
    if (!this.opts.mouse)
      return void this.write('/mouse is for the full-screen app; here the terminal selects text as usual.');
    this.opts.mouse(value === 'on');
    this.write(
      value === 'on'
        ? 'mouse: the wheel scrolls; most terminals still select text while Shift is held'
        : 'mouse: drag to select text and copy it; PgUp/PgDn scroll',
    );
  }
  private async go(what: {
    objective?: string;
    repo?: string;
    sessionDir?: string;
    message?: string;
    allowDirty?: boolean;
  }): Promise<void> {
    if (!this.opts.jevKey) throw new Error('Jev needs its key: start Leana with --key-file or TYPESAFE_API_KEY');
    const following = what.sessionDir !== undefined && what.sessionDir === this.session;
    if (!following) this.header.clear();
    this.running = true;
    try {
      const outcome = await (this.opts.runSession ?? runSession)({
        config: await this.config(),
        jevKey: this.opts.jevKey,
        ...what,
        started: a => {
          this.agent = a;
        },
        out: l => {
          if (following && this.header.has(l)) return;
          this.header.add(l);
          this.write(l);
        },
        ...(this.opts.view ? { view: this.opts.view } : {}),
      });
      const s = outcome.session;
      this.session = outcome.store.path;
      this.write(
        `\n${endingLine(s)}\nElapsed: ${elapsed(outcome.elapsedMs)} for ${stepsOf(outcome.steps)}${outcome.usage.requests ? `\nUsage: ${usageLine(outcome.usage)}` : ''}\nSession: ${outcome.store.path}`,
      );
      this.write('What you type next continues this session; /new starts another.');
    } finally {
      this.agent = null;
      this.running = false;
    }
  }
}
// The prompt loop on a terminal: history, completion, and Ctrl-C that stops a run after its step
// (a second Ctrl-C leaves) or, at the prompt, clears the line.
export async function startApp(opts: AppOptions): Promise<void> {
  const app = new App(opts);
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => app.complete(line),
    historySize: 500,
    terminal: true,
  });
  const c = await app.config();
  process.stdout.write(`Leana — ${c.provider}:${c.model} in ${app.repo}. Type an objective, or /help.\n`);
  try {
    await app.model();
  } catch (e) {
    process.stdout.write(`(model facts unavailable: ${(e as Error).message})\n`);
  }
  let interrupts = 0;
  rl.on('SIGINT', () => {
    if (app.running) {
      if (++interrupts > 1) process.exit(130);
      process.stdout.write(app.stop() ? '\nStopping after the current step; Ctrl-C again to leave now.\n' : '\n');
    } else {
      rl.write(null, { ctrl: true, name: 'u' });
      process.stdout.write('\n');
      rl.prompt();
    }
  });
  rl.setPrompt('leana › ');
  rl.prompt();
  for await (const line of rl) {
    rl.pause();
    interrupts = 0;
    if (
      (await app.handle(line).catch(e => {
        process.stdout.write(`${(e as Error).message}\n`);
      })) === 'quit'
    )
      break;
    rl.resume();
    rl.prompt();
  }
  rl.close();
}

// The app as a full-screen terminal UI: the conversation, the status bar and an input box that stays. Between
// runs the input takes an objective or a /command; during a run, guidance (Enter) or a stop (Ctrl-C, which a
// second press makes leave at once). Ctrl-C twice between runs leaves.
export async function startTui(opts: AppOptions): Promise<void> {
  let ui: TerminalUI | null = null;
  const app = new App({
    ...opts,
    write: t => ui?.message(t, /^\n*(COMPLETE|PAUSED):/.test(t) ? 'outcome' : 'info'),
    view: o => ui!.run(o),
    mouse: on => ui?.setMouse(on),
  });
  const c = await app.config();
  return new Promise<void>(resolve => {
    let armed = false;
    const quit = () => {
      ui!.stop();
      resolve();
    };
    const showModel = async () => {
      const now = await app.config();
      ui!.setModel(`${now.provider}:${now.model}`);
    };
    ui = new TerminalUI({
      title: app.repo,
      model: `${c.provider}:${c.model}`,
      complete: line => app.complete(line),
      submit: line => {
        armed = false;
        if (app.running && line.startsWith('/')) {
          ui!.message(
            `${line.split(/\s/)[0]} waits until the run ends (Ctrl-C stops it after its step); the text was not sent to the run.`,
            'warn',
          );
          return;
        }
        if (app.running) {
          ui!.message(app.guide(line) ? `You: ${line} (the run takes it at its next step)` : `You: ${line}`, 'user');
          return;
        }
        ui!.message(line, 'user');
        app
          .handle(line)
          .then(r => {
            // A run stopped with Ctrl-C has ended: the next Ctrl-C asks again before leaving.
            armed = false;
            return r === 'quit' ? quit() : showModel();
          })
          .catch(e => ui!.message((e as Error).message, 'warn'));
      },
      interrupt: () => {
        if (app.running) {
          if (armed) {
            ui!.stop();
            process.exit(130);
          }
          armed = true;
          if (app.stop()) ui!.stopping();
          ui!.message('Stopping after the current step; Ctrl-C again to leave now.', 'warn');
        } else if (armed) quit();
        else {
          armed = true;
          ui!.message('Press Ctrl-C again to leave.');
        }
      },
    });
    ui.start();
    ui.message(`Leana: ${c.provider}:${c.model} in ${app.repo}. Type an objective, or /help.`);
    app.model().catch(e => ui!.message(`(model facts unavailable: ${(e as Error).message})`, 'warn'));
  });
}
