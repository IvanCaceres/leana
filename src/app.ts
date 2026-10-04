// Leana as an app: a prompt where an objective runs in the current repository and slash commands set up
// the provider, the model and its options. Only what the active provider and model take is offered:
// the options come from the model's own facts (models.ts), and a value it does not take is refused
// with what it does take. Choices are kept in the settings file between runs.
import { createInterface, type Interface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './types.js';
import { loadConfig, saveSettings, type Settings } from './config.js';
import { describeModel, effortsOf, listModels, modelOptions, providers, type ModelInfo, type Provider } from './models.js';
import { elapsed, forModel, providerKey, runSession, sessionsOf } from './session.js';
import type { Agent } from './agent.js';

const usd = (perToken: number) => perToken ? `$${(perToken * 1e6).toFixed(perToken * 1e6 < 1 ? 3 : 2)}` : 'free';
export interface AppOptions { base: Config; settings: Settings; jevKey: string; repo: string; configPath?: string; settingsPath?: string; write?: (text: string) => void }
export class App {
  settings: Settings; repo: string; allowWrite: boolean; allowBash: boolean; checkCommand: string;
  private info: ModelInfo | null = null; private agent: Agent | null = null; running = false;
  private readonly write: (text: string) => void;
  constructor(private opts: AppOptions) {
    this.settings = { config: { ...opts.settings.config }, ...(opts.settings.repo ? { repo: opts.settings.repo } : {}) };
    this.repo = opts.repo; this.allowWrite = opts.base.allowWrite; this.allowBash = opts.base.allowBash; this.checkCommand = opts.base.checkCommand;
    this.write = opts.write ?? (t => process.stdout.write(`${t}\n`));
  }
  // The config of the next run: the file's, then the app's choices, then this run's permissions.
  async config(): Promise<Config> {
    return loadConfig(this.opts.configPath, { ...this.settings.config, allowWrite: this.allowWrite, allowBash: this.allowBash, checkCommand: this.checkCommand });
  }
  private async key(c?: Config): Promise<string> { return providerKey(c ?? await this.config()); }
  async model(refresh = false): Promise<ModelInfo> {
    if (!this.info || refresh) { const c = await this.config(); this.info = await describeModel(c, await this.key(c)); }
    return this.info;
  }
  private async remember(change: Partial<Config> & Record<string, unknown>): Promise<void> {
    this.settings.config = { ...this.settings.config, ...change } as Partial<Config>;
    await loadConfig(this.opts.configPath, { ...this.settings.config }); // refuses an inconsistent combination before it is kept
    await saveSettings(this.settings, this.opts.settingsPath);
  }
  stop(): boolean { if (!this.agent) return false; this.agent.stop(); return true; }
  readonly commands: Record<string, { args: string; help: string; run: (a: string[]) => Promise<void> }> = {
    help: { args: '', help: 'this list', run: async () => this.help() },
    status: { args: '', help: 'provider, model, repository, permissions and the options set', run: async () => this.status() },
    provider: { args: '[llama|openrouter]', help: 'show or switch the model provider', run: async a => this.provider(a[0]) },
    models: { args: '[words]', help: 'list the provider\'s models (OpenRouter: those whose id or name has every word)', run: async a => this.models(a) },
    model: { args: '[id]', help: 'show the active model, or switch to another', run: async a => a[0] ? this.switchModel(a[0]) : this.showModel() },
    info: { args: '', help: 'what the active model is and takes', run: async () => this.showModel() },
    options: { args: '', help: 'the options the active model takes, with their values', run: async () => this.showOptions() },
    set: { args: '<option> <value>', help: 'set an option the active model takes (see /options)', run: async a => this.set(a[0], a.slice(1).join(' ')) },
    reasoning: { args: 'on|off', help: 'reason before each step (when the model can)', run: async a => this.set('reasoning', a[0]) },
    effort: { args: '<level>', help: 'how much the model reasons (the levels it takes)', run: async a => this.set('effort', a[0]) },
    budget: { args: '<tokens>', help: 'most tokens a step may reason for (when the model takes a budget)', run: async a => this.set('budget', a[0]) },
    repo: { args: '[path]', help: 'show or set the repository runs work in', run: async a => this.setRepo(a[0]) },
    allow: { args: 'write|bash on|off', help: 'let runs edit files / run shell commands (unsandboxed, with your privileges)', run: async a => this.allow(a[0], a[1]) },
    check: { args: '<command>|off', help: 'the verification command (run as a baseline and after edits)', run: async a => { this.checkCommand = a[0] === 'off' ? '' : a.join(' '); this.write(`check: ${this.checkCommand || 'none (the model chooses its check)'}`); } },
    steps: { args: '<n>', help: 'most steps a run takes (turns, through OpenRouter)', run: async a => { const or = (await this.config()).provider === 'openrouter'; await this.remember(or ? { openrouterMaxTurns: Number(a[0]) } : { maxSteps: Number(a[0]) }); this.write(`${or ? 'turns' : 'steps'}: ${a[0]}`); } },
    sessions: { args: '', help: 'the repository\'s sessions, newest first', run: async () => this.sessions() },
    resume: { args: '[n|path] [message]', help: 'resume a session (1 = newest), optionally with new guidance', run: async a => this.resume(a) },
    quit: { args: '', help: 'leave', run: async () => {} },
  };
  async handle(line: string): Promise<'quit' | void> {
    const t = line.trim(); if (!t) return;
    if (!t.startsWith('/')) return void await this.run(t);
    const [name, ...args] = t.slice(1).split(/\s+/); const c = this.commands[name!.toLowerCase()] ?? (name === 'exit' ? this.commands.quit : undefined);
    if (!c) return void this.write(`No command /${name}; /help lists them.`);
    if (c === this.commands.quit) return 'quit';
    try { await c.run(args); } catch (e) { this.write(`/${name}: ${(e as Error).message}`); }
  }
  // Completion of command names, provider names, option names and their listed values.
  complete(line: string): [string[], string] {
    const parts = line.split(/\s+/);
    if (parts.length === 1) { const hits = Object.keys(this.commands).map(c => `/${c}`).filter(c => c.startsWith(line)); return [hits, line]; }
    const word = parts.at(-1)!; const cmd = parts[0]!.slice(1);
    let pool: string[] = [];
    if (cmd === 'provider') pool = providers;
    else if (cmd === 'allow') pool = parts.length === 2 ? ['write', 'bash'] : ['on', 'off'];
    else if (cmd === 'reasoning') pool = ['on', 'off'];
    else if (this.info && (cmd === 'set' || cmd === 'effort')) {
      const opts = modelOptions(this.info);
      if (cmd === 'effort') pool = effortsOf(this.info.reasoning);
      else if (parts.length === 2) pool = opts.map(o => o.name);
      else pool = opts.find(o => o.name === parts[1])?.values.split(' | ').filter(v => /^[\w.-]+$/.test(v)) ?? [];
    }
    return [pool.filter(p => p.startsWith(word)), word];
  }
  private help(): void {
    this.write('Type an objective to run it in the repository, or a command:');
    for (const [n, c] of Object.entries(this.commands)) this.write(`  /${n}${c.args ? ` ${c.args}` : ''}`.padEnd(38) + c.help);
  }
  private async status(): Promise<void> {
    const c = await this.config();
    this.write(`provider   ${c.provider}${c.provider === 'openrouter' ? ` (${c.openrouterUrl})` : ` (${c.baseUrl})`}`);
    this.write(`model      ${c.model}`);
    this.write(`repository ${this.repo}`);
    this.write(`permissions write ${this.allowWrite ? 'on' : 'off'}, shell ${this.allowBash ? 'on' : 'off'}${this.checkCommand ? `; check: ${this.checkCommand}` : ''}; up to ${c.provider === 'openrouter' ? `${c.openrouterMaxTurns} turns` : `${c.maxSteps} steps`}`);
    try { const m = await this.model(); const { config, notes } = forModel(c, m); for (const o of modelOptions(m)) this.write(`  ${o.name.padEnd(22)} ${o.get(config)}`); for (const n of notes) this.write(`note: ${n}`); }
    catch (e) { this.write(`model facts unavailable: ${(e as Error).message}`); }
  }
  private async provider(name?: string): Promise<void> {
    if (!name) return void this.write(`provider: ${(await this.config()).provider} (one of ${providers.join(', ')})`);
    if (!providers.includes(name as Provider)) throw new Error(`the providers are ${providers.join(', ')}`);
    const model = name === 'llama' ? 'bonsai-27b' : this.settings.config.provider === 'openrouter' ? this.settings.config.model : undefined;
    await this.remember({ provider: name as Provider, ...(model ? { model } : {}) }); this.info = null;
    this.write(`provider: ${name}${name === 'openrouter' && !model ? '; choose a model with /models <words> and /model <id>' : ''}`);
    if (name === 'openrouter' && !(await this.key())) this.write('OpenRouter needs an API key: set OPENROUTER_API_KEY, or providerKeyFile in the config to a file that holds it.');
  }
  private async models(words: string[]): Promise<void> {
    const c = await this.config(); const list = await listModels(c, await this.key(c), words.join(' '));
    if (!list.length) return void this.write('No model matches.');
    for (const m of list.slice(0, 25)) this.write(`${m.id === c.model ? '*' : ' '} ${m.id.padEnd(48)} ${String(Math.round(m.contextLength / 1000)).padStart(5)}k ctx  ${m.reasoning.supported ? `reasons${m.reasoning.mandatory ? ' (always)' : ''}`.padEnd(16) : ''.padEnd(16)}${m.pricing ? `${usd(m.pricing.prompt)} in / ${usd(m.pricing.completion)} out per 1M` : ''}`);
    if (list.length > 25) this.write(`… ${list.length - 25} more; add words to narrow it.`);
  }
  private async switchModel(id: string): Promise<void> {
    const c = await this.config(); const candidate = { ...c, model: id };
    const m = await describeModel(candidate, await this.key(candidate));
    const { config, notes } = forModel(candidate, m);
    await this.remember({ model: m.id, thinkingEffort: config.thinkingEffort, ...(m.reasoning.supported ? {} : { stepThinking: false, codeThinking: false }) });
    this.info = m; this.write(`model: ${m.id}`); for (const n of notes) this.write(`note: ${n}`);
  }
  private async showModel(): Promise<void> {
    const m = await this.model(); const r = m.reasoning;
    this.write(`${m.name} (${m.provider}: ${m.id})`);
    if (m.description) this.write(m.description.replace(/\s+/g, ' ').slice(0, 400));
    this.write(`context ${m.contextLength} tokens; replies up to ${m.maxOutput} tokens${m.pricing ? `; ${usd(m.pricing.prompt)} per 1M prompt tokens, ${usd(m.pricing.completion)} per 1M completion tokens` : ''}`);
    this.write(`reasoning: ${!r.supported ? 'no' : `${r.mandatory ? 'always on' : `can be turned on or off${r.defaultEnabled === undefined ? '' : ` (on by default: ${r.defaultEnabled ? 'yes' : 'no'})`}`}; efforts ${effortsOf(r).join(', ') || 'none'}${r.defaultEffort ? ` (default ${r.defaultEffort})` : ''}; token budget ${r.budget ? 'yes' : 'no'}`}`);
    this.write(`JSON schema enforced: ${m.structured ? 'yes' : 'no (the reply is read for a JSON object)'}`);
    this.write(`parameters: ${m.params.join(', ') || 'none listed'}`);
    for (const [k, v] of Object.entries(m.details ?? {})) this.write(`${k}: ${v}`);
  }
  private async showOptions(): Promise<void> {
    const m = await this.model(); const c = forModel(await this.config(), m).config;
    this.write(`Options ${m.id} takes:`);
    const options = modelOptions(m); const width = Math.max(...options.map(o => o.values.length)) + 2; const now = Math.max(10, ...options.map(o => o.get(c).length));
    for (const o of options) this.write(`  ${o.name.padEnd(22)} ${o.get(c).padEnd(now)} ${o.values.padEnd(width)}${o.describe}`);
  }
  private async set(name?: string, value?: string): Promise<void> {
    if (!name || value === undefined || value === '') throw new Error('give an option and a value; /options lists what this model takes');
    const m = await this.model(); const o = modelOptions(m).find(x => x.name === name);
    if (!o) throw new Error(`${m.id} does not take ${name}; it takes ${modelOptions(m).map(x => x.name).join(', ')}`);
    const change = o.set(await this.config(), value);
    await this.remember(change); this.write(`${name}: ${o.get(await this.config())}`);
  }
  private async setRepo(path?: string): Promise<void> {
    if (!path) return void this.write(`repository: ${this.repo}`);
    this.repo = await realpath(resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')));
    this.settings.repo = this.repo; await saveSettings(this.settings, this.opts.settingsPath); this.write(`repository: ${this.repo}`);
  }
  private async allow(what?: string, value?: string): Promise<void> {
    if (!what || !['write', 'bash'].includes(what) || !value || !/^(on|off)$/.test(value)) throw new Error('/allow write|bash on|off');
    if (what === 'write') this.allowWrite = value === 'on'; else this.allowBash = value === 'on';
    this.write(`${what}: ${value}${what === 'bash' && value === 'on' ? ' (commands run unsandboxed with your user privileges)' : ''}`);
  }
  private async sessions(): Promise<void> {
    const list = await sessionsOf(this.repo);
    if (!list.length) return void this.write('No sessions in this repository.');
    list.forEach((s, i) => this.write(`${String(i + 1).padStart(2)}. ${s.status.padEnd(8)} step ${String(s.step).padStart(3)}  ${s.objective.replace(/\s+/g, ' ').slice(0, 70)}  ${s.path}`));
  }
  private async resume(a: string[]): Promise<void> {
    const list = await sessionsOf(this.repo); const which = a[0] ?? '1';
    const target = /^\d+$/.test(which) ? list[Number(which) - 1]?.path : which;
    if (!target) throw new Error('no such session; /sessions lists them');
    const message = a.slice(1).join(' ');
    await this.go({ sessionDir: target, ...(message ? { message } : {}) });
  }
  private async run(objective: string): Promise<void> {
    if (!this.allowWrite) this.write('Note: write is off, so this run can read but not change files (/allow write on).');
    await this.go({ objective, repo: this.repo });
  }
  private async go(what: { objective?: string; repo?: string; sessionDir?: string; message?: string }): Promise<void> {
    if (!this.opts.jevKey) throw new Error('Jev needs its key: start Leana with --key-file or TYPESAFE_API_KEY');
    this.running = true;
    try {
      const outcome = await runSession({ config: await this.config(), jevKey: this.opts.jevKey, ...what, started: a => { this.agent = a; }, out: l => this.write(l) });
      const s = outcome.session;
      this.write(`\n${s.status.toUpperCase()}: ${s.stopReason}\nElapsed: ${elapsed(outcome.elapsedMs)} for ${outcome.steps} steps\nSession: ${outcome.store.path}`);
    } finally { this.agent = null; this.running = false; }
  }
}
// The prompt loop on a terminal: history, completion, and Ctrl-C that stops a run after its step
// (a second Ctrl-C leaves) or, at the prompt, clears the line.
export async function startApp(opts: AppOptions): Promise<void> {
  const app = new App(opts);
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout, completer: (line: string) => app.complete(line), historySize: 500, terminal: true });
  const c = await app.config();
  process.stdout.write(`Leana — ${c.provider}:${c.model} in ${app.repo}. Type an objective, or /help.\n`);
  try { await app.model(); } catch (e) { process.stdout.write(`(model facts unavailable: ${(e as Error).message})\n`); }
  let interrupts = 0;
  rl.on('SIGINT', () => {
    if (app.running) { if (++interrupts > 1) process.exit(130); process.stdout.write(app.stop() ? '\nStopping after the current step; Ctrl-C again to leave now.\n' : '\n'); }
    else { rl.write(null, { ctrl: true, name: 'u' }); process.stdout.write('\n'); rl.prompt(); }
  });
  rl.setPrompt('leana › '); rl.prompt();
  for await (const line of rl) {
    rl.pause(); interrupts = 0;
    if (await app.handle(line).catch(e => { process.stdout.write(`${(e as Error).message}\n`); }) === 'quit') break;
    rl.resume(); rl.prompt();
  }
  rl.close();
}
