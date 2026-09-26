// The orient-reason-act loop. Code orients (facts about the repository and the
// machine), the worker reasons and takes one action per step, the harness
// executes it, verifies what it can and shows the result; Jev surrounds the
// loop as a control plane: it watches for progress, triages failures, ranks
// retrieval, and gates completion claims. Nothing here decides how to
// implement anything.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Answers, Config, Message, Questions, Route, Session, ToolResult } from './types.js';
import { editRoutes } from './types.js';
import type { ProgressEvent } from './display.js';
import { Store } from './store.js';
import { ToolBox, boundedRead, hash, listRepoFiles, repositoryStatus, runCommand, safePath, sourceHashes, summarizeCheck, treeChanges, treeSnapshot } from './tools.js';
import { clip, clipEnds, evictOne, evidenceTokens, turnEntry, fenceFor, regionMessages, trimContext, mergeCoverage, rememberEdit, retireEvidence, stepMessages, newFileMessages, type FileContract } from './context.js';
import { pinReferences, referenceContext } from './references.js';
import { extractCode, schemas, stepSchema, actions } from './schema.js';
import { markupClassNames, stylesheetClasses, languageFor, detectProjects, importSpelling, inProject, projectFor, shellPrefixFor, signaturesFor, sourceFile, syntaxCheck, undeclaredPackages, unresolvedImports, type Project } from './profiles.js';
import { orient } from './orient.js';
import { renderFacts } from './render.js';
import { evidenceGate, rankExcerpts, relevance, triage, watchdog, type Jev as JevLike } from './control.js';
import type { Bonsai } from './clients.js';

// A repository file's text, or null when it cannot be read: missing (the worker
// may delete any file it wrote), outside the root, or not text. Never throws.
const readIfPresent = (root: string, path: string): Promise<string | null> => safePath(root, path).then(f => readFile(f, 'utf8')).catch(() => null);

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000) throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try { instructions = await readFile(join(root, 'AGENTS.md'), 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(instructions) > 12000) throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return { version: 1, root, objective, instructions, step: 0, tasks: [], focus: null, entries: [],
    lastCompact: -100, status: 'running', stopReason: '', writes: [], lastWriteStep: -1, lastCheckStep: -1,
    phase: 'implement', knownFiles: await listRepoFiles(root), inspectionCount: 0, lastError: null, editEvidence: [], referenceEvidence: [], completionFeedback: null, finishTriedAtCheck: -1, lastToolError: null, ledger: [], design: null, ledgerAttempts: 0, ledgerBuilt: true, ledgerComplete: 0, baselineArtifacts: {}, checkInferences: 0, checkInferredFor: -1, setupDone: false, baselineStatus: null,
    lastRoute: null, lastResultOk: false, lastWriteStale: false, repetitions: {}, coverage: {}, hashes: {}, lastPromptTokens: 0, lastCheck: null, previousCheck: null, editSnapshots: {}, transaction: [], rejectedEdits: [], lastCheckCommand: null, autoUndo: null, inspectionsSinceAction: 0, coverageByHash: {}, repetitionSteps: {}, focusReadAt: -1, autoFixKeys: {}, actions: {}, searches: {}, blockedRoute: null, editsSinceCheck: 0, readHashes: {}, writeSteps: {}, pendingRepairs: [],
    notes: '', watch: { noProgress: 0, readings: [], escalations: 0 }, blockedActions: [] };
}

type BonsaiLike = Pick<Bonsai, 'count' | 'generate'> & { generateText?: Bonsai['generateText']; lastMeta?: Bonsai['lastMeta'] };
export class Agent {
  readonly tools: ToolBox; private current = 0;
  constructor(readonly config: Config, readonly store: Store, readonly jev: JevLike, readonly bonsai: BonsaiLike, root: string, readonly log: (line: string) => void, readonly observe: (e: ProgressEvent) => void) {
    this.tools = new ToolBox(root, store.artifacts, config, (path, text) => store.snapshot(this.current, path, text));
    this.tools.commandPrefix = () => shellPrefixFor(root);
  }
  // A project's manifests' state: what its install was made from.
  private async manifestKey(p: Project): Promise<string> {
    return hash((await Promise.all(p.eco.manifests.map(f => readFile(join(this.tools.root, p.dir, f), 'utf8').catch(() => '')))).join('\u0000'));
  }
  // What a command's output depends on in the repository: the last write and the installed set.
  static world(s: Session): string { return `${s.lastWriteStep}|${s.setupKey ?? ''}|${JSON.stringify(s.setupKeys ?? {})}`; }
  static actionKey(s: Session, route: Route, args: Record<string, any>): string {
    const hashes = route === 'read_files' ? (args.files as { path: string }[]).map(f => [f.path, s.hashes[f.path] ?? null]).sort() : route === 'search_codebase' ? Object.entries(s.hashes).sort() : undefined;
    return hash(JSON.stringify({ route, args: { ...args, expectedHash: undefined, destinationHash: undefined }, hashes }));
  }

  // ---- observation: what a tool result does to the session -----------------
  async evidence(s: Session, kind: string, result: ToolResult, args?: Record<string, any>): Promise<void> {
    const artifact = await this.store.artifact(s.step, result.text);
    const limit = kind === 'read_files' || kind === 'render' ? this.config.toolChars : kind === 'bash' ? Math.min(this.config.toolChars, 2500) : kind === 'search_codebase' ? Math.min(this.config.toolChars, 1500) : Math.min(this.config.toolChars, 600);
    if (kind === 'read_files' && result.ok && args) {
      for (const f of args.files as { path: string; start: number }[]) for (const e of s.entries) if (e.kind === 'read_files' && !e.stale && new RegExp(`(^|\\n\\n)${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sha256=\\w+ totalLines=\\d+ shown=${f.start}\\.\\.`).test(e.text)) { e.stale = `superseded by the read at step ${s.step}`; e.relevance = .1; }
    }
    s.entries.push({ id: `e${s.step}`, step: s.step, kind, artifact, ...(s.currentTurn ? { turn: s.currentTurn } : {}), text: clip(result.text, limit), relevance: result.ok ? .5 : .9, verification: result.verification });
    if (result.ok && result.changed?.length && editRoutes.includes(kind as Route)) rememberEdit(s, s.step, kind, result.changed, artifact, result.text, args);
    if ((kind === 'read_files' || kind === 'search_codebase') && result.ok) s.inspectionCount++;
    if (kind === 'search_codebase' && result.ok && args) {
      let output = ''; try { output = String(JSON.parse(result.text).output ?? ''); } catch { output = result.text; }
      const lines = output.split('\n').filter(Boolean);
      const key = `${args.mode}:${args.query} in ${args.path}`; delete s.searches[key];
      s.searches[key] = output.startsWith('(no matches') ? '(no matches)' : lines.slice(0, 3).map(l => clip(l, 100)).join(' | ') + (lines.length > 3 ? ` | +${lines.length - 3} more` : '');
      for (const old of Object.keys(s.searches).slice(0, -20)) delete s.searches[old];
    }
    if (kind === 'read_files' && result.ok) {
      for (const [path, h] of Object.entries(result.hashes ?? {})) s.readHashes[path] = h;
      for (const m of result.text.matchAll(/(?:^|\n\n)(\S+) sha256=(\w+) totalLines=(\d+) shown=(\d+)\.\.(\d+)/g)) if (Number(m[5]) >= Number(m[4])) { s.coverage[m[1]!] = mergeCoverage(s.coverage[m[1]!], Number(m[3]), Number(m[4]), Number(m[5])); s.coverageByHash[`${m[1]}@${m[2]}`] = s.coverage[m[1]!]!; }
      for (const old of Object.keys(s.coverageByHash).slice(0, -40)) delete s.coverageByHash[old];
    }
    s.lastError = result.ok ? null : clip(result.text, 1500);
    for (const [path, h] of Object.entries(result.hashes ?? {})) { delete s.hashes[path]; s.hashes[path] = h; }
    for (const stale of Object.keys(s.hashes).slice(0, -20)) delete s.hashes[stale];
    if (kind === 'bash' && typeof args?.command === 'string') (s.commandRuns ??= {})[args.command.trim()] = { step: s.step, ok: result.ok, world: Agent.world(s) };
    if (result.verification) { s.editsSinceCheck = 0; if (kind === 'bash' && args?.command) s.lastCheckCommand = args.command.trim(); }
    if (s.completionFeedback && !s.completionFeedback.addressed && result.verification && result.ok && s.lastWriteStep > s.completionFeedback.step) s.completionFeedback = { ...s.completionFeedback, addressed: true, text: `The completion proposed at step ${s.completionFeedback.step} was rejected (${clip(s.completionFeedback.text, 200)}); edits and a passing verification have followed.` };
    if (result.changed?.length) s.editsSinceCheck++;
    if ((kind === 'read_files' || kind === 'search_codebase' || (kind === 'bash' && !result.changed?.length)) && result.ok) s.inspectionsSinceAction++;
    if (result.changed?.length || result.verification || kind === 'undo') s.inspectionsSinceAction = 0;
    for (const changed of result.changed ?? []) {
      if (!s.writes.includes(changed)) s.writes.push(changed);
      if (!s.knownFiles.includes(changed)) s.knownFiles.push(changed);
      s.lastWriteStep = s.step; s.writeSteps[changed] = s.step; delete s.coverage[changed]; delete s.readHashes[changed];
      for (const key of Object.keys(s.searches)) { const at = key.slice(key.lastIndexOf(' in ') + 4); if (at === '.' || at === changed || changed.startsWith(at.replace(/\/?$/, '/'))) delete s.searches[key]; }
      const header = `${changed} sha256=`;
      for (const e of s.entries) if (e.kind === 'read_files' && e.step < s.step && !e.stale && (e.text.startsWith(header) || e.text.includes(`\n\n${header}`))) { e.stale = `edited at step ${s.step}: text and line numbers no longer match ${changed}`; e.relevance = Math.min(e.relevance, .1); }
    }
    if (result.check) s.lastCheckStep = s.step;
    if (result.verification) {
      s.previousCheck = s.lastCheck;
      let output = result.text; try { output = String(JSON.parse(result.text).output ?? result.text); } catch { /* plain text */ }
      s.lastCheck = { step: s.step, ok: result.ok, text: clipEnds(output, 1500), summary: await summarizeCheck(result.text, s.root, [...s.writes, ...s.knownFiles]), fileHashes: await sourceHashes(s.root, s.writes), ...(kind === 'bash' && typeof args?.command === 'string' ? { command: args.command.trim() } : {}) };
      if (!result.ok) {
        const sites: string[] = [];
        for (const [p, named] of Object.entries(s.lastCheck.summary.files).slice(0, 5)) {
          const text = await readIfPresent(s.root, p); if (text === null) continue;
          const lines = text.split('\n');
          for (const n of named.filter(n => n <= lines.length).slice(0, 2)) { const a = Math.max(1, n - 4); const b = Math.min(lines.length, n + 4); sites.push(`${p} lines ${a}..${b} (error at ${n}):\n${lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n')}`); }
        }
        if (sites.length) { const e = s.entries.at(-1); if (e) e.text += `\nSource at the errors (sha256 in fileHashes):\n${clip(sites.join('\n'), 2400)}`; }
      }
      // How this run compares with the previous run of the same command: a fact for the worker, never a rollback.
      if (s.previousCheck?.summary.files && s.previousCheck.command === s.lastCheck.command) {
        const e = s.entries.at(-1); const was = s.previousCheck.summary; const now = s.lastCheck.summary;
        const before = Object.keys(was.files); const after = Object.keys(now.files);
        if (e && (was.code !== now.code || before.join('\n') !== after.join('\n'))) e.text += `\nCompared with the previous run at step ${s.previousCheck.step}: exit code ${was.code} -> ${now.code}; files the output names: ${before.join(', ') || 'none'} -> ${after.join(', ') || 'none'}.`;
      }
    }
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.baselineArtifacts)) s.baselineArtifacts[path] = artifact;
    retireEvidence(s);
    // Eviction is batched: any removal invalidates the cached prefix after it, so
    // the evidence is let grow to a share of the working budget and then cut well
    // below it at once, which buys several steps of a stable prefix for one reprocessing.
    let evicted = 0;
    if (evidenceTokens(s) > this.config.workingTokens * evictAt) while (evidenceTokens(s) > this.config.workingTokens * evictTo && evictOne(s)) evicted++;
    if (evicted) await this.store.log('compact', { step: s.step, removed: evicted, reason: 'evidence-share', retained: s.entries.length, trail: s.trail?.length ?? 0 });
  }
  // Execute an action, the worker's or the harness's, with the same bookkeeping.
  private async execute(s: Session, route: Route, args: Record<string, any>, kind: string): Promise<ToolResult> {
    if (kind !== 'action') await this.store.log(kind, { step: s.step, ...args });
    await this.store.log('action', { step: s.step, route, args, forced: kind.startsWith('auto') });
    const started = performance.now();
    let result: ToolResult;
    // What a shell command changed is read from the tree, never guessed from the command.
    const before = route === 'bash' ? await treeSnapshot(this.tools.root).catch(() => null) : null;
    try { result = await this.tools.execute(route, args); } catch (e) { result = { ok: false, text: `Tool error: ${(e as Error).message}` }; }
    if (route === 'bash') await this.commandEffects(s, args, result, before);
    // A written file that does not parse is a fact the worker sees at once, by the language's own tool.
    if (result.ok && editRoutes.includes(route) && result.changed?.length) {
      const facts: string[] = [];
      for (const p of result.changed) { const text = await readIfPresent(this.tools.root, p); if (text === null) continue; const problems = await syntaxCheck(this.tools.root, p, text).catch(() => [] as string[]); if (problems.length) facts.push(`${p} does not parse: ${problems.slice(0, 4).join('; ')}`); }
      if (facts.length) result.text += `\nHarness: ${facts.join(' | ')}`;
    }
    s.lastRoute = route; s.lastResultOk = result.ok;
    await this.evidence(s, route, result, args);
    this.observe({ kind: 'result', step: s.step, route, ok: result.ok, ms: performance.now() - started, chars: result.text.length, text: clip(result.text, 200) });
    await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - started, kind, artifact: s.entries.at(-1)?.artifact });
    return result;
  }

  // Every file a command created, modified or deleted is an edit of this step,
  // except what the check of record writes (a build's output is not an edit it
  // must be run again for). The file list follows the tree either way.
  private async commandEffects(s: Session, args: Record<string, any>, result: ToolResult, before: Awaited<ReturnType<typeof treeSnapshot>>): Promise<void> {
    const after = before ? await treeSnapshot(this.tools.root).catch(() => null) : null;
    if (!before || !after) { s.knownFiles = await listRepoFiles(s.root).catch(() => s.knownFiles); return; }
    const { changed, created, deleted } = await treeChanges(this.tools.root, before, after);
    if (!changed.length) return;
    s.knownFiles = [...s.knownFiles.filter(p => !deleted.includes(p)), ...created.filter(p => !s.knownFiles.includes(p))].sort();
    for (const p of deleted) { delete s.hashes[p]; delete s.coverage[p]; delete s.readHashes[p]; }
    if (args.check === true) return;
    const present = changed.filter(p => !deleted.includes(p));
    const now = await sourceHashes(s.root, present.slice(0, 40));
    result.changed = [...new Set([...(result.changed ?? []), ...changed])];
    result.hashes = { ...(result.hashes ?? {}), ...Object.fromEntries(Object.entries(now).filter(([, h]) => h !== 'unavailable')) };
    const counts = [created.length ? `created ${created.length}` : '', present.length - created.length ? `modified ${present.length - created.length}` : '', deleted.length ? `deleted ${deleted.length}` : ''].filter(Boolean).join(', ');
    result.text += `\nHarness: the command changed files (${counts}): ${clip(changed.slice(0, 30).join(', ') + (changed.length > 30 ? `, +${changed.length - 30} more` : ''), 900)}`;
    await this.store.log('bash-edit', { step: s.step, files: changed.slice(0, 200), command: clip(String(args.command ?? ''), 200) });
  }

  // ---- installs: mechanics the worker cannot do for itself -----------------
  private async installDependencies(s: Session, p: Project, install: string): Promise<boolean> {
    const eco = p.eco; const id = `${eco.id}:${p.dir}`;
    s.setupDone = true; (s.setupKeys ??= {})[id] = await this.manifestKey(p);
    const attempt = async () => {
      const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', install], this.tools.root, Math.max(this.config.commandTimeoutMs, 300000)).catch(e => ({ code: -1, output: String((e as Error).message), truncated: false, timedOut: false }));
      await this.store.log('setup', { step: s.step, command: install, code: r.code, output: clip(r.output, 800) });
      this.observe({ kind: 'warning', step: s.step, text: `setup: ${install} (exit ${r.code})` });
      await this.evidence(s, 'setup', { ok: r.code === 0, text: `Installed dependencies with ${install}: exit ${r.code}\n${clipEnds(r.output, 900)}` });
      return r;
    };
    const errors = s.setupErrors ??= {};
    let r = await attempt();
    if (r.code !== 0 && !s.autoFixKeys[`install-retry:${id}`]) { s.autoFixKeys[`install-retry:${id}`] = `step ${s.step}`; r = await attempt(); }
    if (r.code === 0) { delete errors[id]; s.setupKeys![id] = await this.manifestKey(p); s.knownFiles = await listRepoFiles(s.root).catch(() => s.knownFiles); }
    else {
      const facts = eco.installFacts ? await eco.installFacts(r.output, name => eco.lookupLatest ? eco.lookupLatest(join(this.tools.root, p.dir), name) : Promise.resolve(null)).catch(() => [] as string[]) : [];
      errors[id] = clip([p.dir === '.' ? '' : `in ${p.dir}:`, eco.errorLines(r.output), ...facts].filter(Boolean).join('\n'), 700);
    }
    s.setupError = Object.values(errors).join('\n') || null;
    return r.code === 0;
  }
  // Dependencies follow the manifests: each project's installed when its
  // manifest appears, again when it changes, once per manifest version.
  // Mechanics the worker should not spend turns discovering (a build that
  // cannot find its tools).
  private async retrySetup(s: Session): Promise<boolean> {
    const keys = s.setupKeys ??= {}; let ran = false;
    for (const p of await detectProjects(this.tools.root).catch(() => [] as Project[])) {
      const id = `${p.eco.id}:${p.dir}`; const key = await this.manifestKey(p);
      if (keys[id] === key) continue;
      const again = id in keys;
      const install = await p.eco.installCommand(this.tools.root, p.dir, again).catch(() => null);
      if (!install) { keys[id] = key; continue; }
      this.observe({ kind: 'warning', step: s.step, text: `${p.dir === '.' ? '' : `${p.dir}: `}${again ? 'manifest changed since the last install; installing again' : 'a manifest exists and nothing is installed; installing'}` });
      await this.installDependencies(s, p, install); ran = true;
    }
    return ran;
  }

  // ---- generation --------------------------------------------------------------
  private async logPrompt(s: Session, route: string, prompt: Message[], tokens: number): Promise<void> {
    const artifact = await this.store.promptArtifact(s.step, 1, prompt);
    await this.store.log('prompt', { step: s.step, route, tokens, artifact });
    this.observe({ kind: 'context', step: s.step, tokens, workingTokens: this.config.workingTokens, contextWindow: this.config.contextWindow, breakdown: Agent.breakdown(prompt), entries: s.entries.length });
  }
  static breakdown(prompt: Message[]): Record<string, number> {
    const out: Record<string, number> = { system: prompt[0]?.content.length ?? 0 };
    for (const m of prompt.slice(1)) { let parsed: any; try { parsed = JSON.parse(m.content); } catch { out.other = (out.other ?? 0) + m.content.length; continue; } for (const [k, v] of Object.entries(parsed)) out[k] = (out[k] ?? 0) + JSON.stringify(v).length; }
    return out;
  }
  // A prompt is fitted to the working budget by evicting evidence, never swapped for a generic one.
  private async fit(s: Session, build: () => Message[]): Promise<{ prompt: Message[]; tokens: number }> {
    let prompt = build(); let counted = await this.bonsai.count(prompt); let forced = 0;
    while (counted.tokens > this.config.workingTokens) { for (let i = 0; i < 3; i++) { if (!evictOne(s)) { if (!i) throw new Error('The pinned objective, orientation and notes exceed the working budget'); break; } forced++; } prompt = build(); counted = await this.bonsai.count(prompt); }
    if (forced) { s.lastCompact = s.step; await this.store.log('compact', { step: s.step, removed: forced, reason: 'hard-budget' }); }
    s.lastPromptTokens = counted.tokens;
    return { prompt, tokens: counted.tokens };
  }
  private async generateJson(s: Session, route: string, build: () => Message[], schema: any, temperature?: number): Promise<Record<string, any>> {
    const { prompt, tokens } = await this.fit(s, build);
    this.observe({ kind: 'route', step: s.step, route, tokens, entries: s.entries.length });
    await this.logPrompt(s, route, prompt, tokens);
    const args = await this.bonsai.generate(prompt, schema, temperature, { step: s.step, route });
    this.observe({ kind: 'generated', step: s.step, route, meta: this.bonsai.lastMeta ?? null, args });
    return args;
  }
  private async generateCode(s: Session, route: Route, builds: (() => Message[])[], budget: number, fence: string): Promise<{ code: string; finish: string }> {
    let prompt = builds[0]!(); let counted = await this.bonsai.count(prompt);
    for (const smaller of builds.slice(1)) { if (counted.tokens <= this.config.workingTokens) break; prompt = smaller(); counted = await this.bonsai.count(prompt); }
    if (counted.tokens > this.config.workingTokens) { const fitted = await this.fit(s, builds.at(-1)!); prompt = fitted.prompt; counted = { tokens: fitted.tokens, mode: 'fit' }; }
    s.lastPromptTokens = counted.tokens;
    this.observe({ kind: 'route', step: s.step, route, tokens: counted.tokens, entries: s.entries.length });
    await this.logPrompt(s, route, prompt, counted.tokens);
    if (this.bonsai.generateText) {
      const g = await this.bonsai.generateText(prompt, { budgetTokens: budget, context: { step: s.step, route }, fence });
      this.observe({ kind: 'generated', step: s.step, route, meta: g.meta, args: { chars: g.text.length, finish: g.finish } });
      const run = fence.match(/^`+/)?.[0].length ?? 3; const opened = g.text.match(/^\s*(`{3,})[^\n]*\n/);
      return { code: opened && opened[1]!.length >= run ? extractCode(g.text) : g.text.replace(/\s+$/, '') + '\n', finish: g.finish };
    }
    const raw = await this.bonsai.generate(prompt, { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }, this.config.codeTemperature, { step: s.step, route }, budget);
    return { code: extractCode(String(raw.content ?? '')), finish: 'stop' };
  }
  // The modules a file names in its purpose, thought or notes, as real signatures.
  private async contractsFor(s: Session, path: string, text: string): Promise<FileContract[]> {
    const mentioned = [...new Set([...text.matchAll(/(?:^|[\s"'`(,])((?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s"'`),:])/g)].map(m => m[1]!))].filter(p => p !== path && sourceFile(p));
    const out: FileContract[] = [];
    for (const p of [...mentioned, ...s.writes.slice(-8)].filter((p, i, a) => a.indexOf(p) === i && p !== path).slice(0, 10)) {
      let content: string | null = null; try { content = await readFile(await safePath(this.tools.root, p), 'utf8'); } catch { continue; }
      const exports = await signaturesFor(p, content).catch(() => [] as string[]); if (!exports.length) continue;
      out.push({ path: p, importPath: importSpelling(path, p), status: 'exists', exports });
    }
    return out;
  }
  // A file's whole content generated as code: a new file, or an existing one
  // rewritten with its current content in front of the worker.
  private async createFile(s: Session, path: string, purpose: string, thought: string, rewrite = false, range?: { start?: unknown; end?: unknown }): Promise<void> {
    let current: string | undefined;
    try { current = await readFile(await safePath(this.tools.root, path, true), 'utf8'); } catch { current = undefined; }
    if (current !== undefined && !rewrite) throw new Error(`${path} already exists; use rewrite_file to replace its whole content, or replace_lines for a small edit`);
    if (current === undefined && rewrite) throw new Error(`${path} does not exist; use create_file`);
    // A block of the file: lines start..end regenerated and spliced in, the rest untouched.
    const lines = current === undefined || current === '' ? [] : (current.endsWith('\n') ? current.slice(0, -1) : current).split('\n');
    const region = rewrite && (typeof range?.start === 'number' || typeof range?.end === 'number') ? (() => {
      const start = Math.min(Math.max(1, typeof range!.start === 'number' ? range!.start : lines.length + 1), lines.length + 1);
      const end = Math.min(typeof range!.end === 'number' ? range!.end : start - 1, lines.length);
      if (end < start - 1) throw new Error(`lines ${start}..${end} of ${path} is not a range: end must be at least start - 1 (start - 1 inserts before line start)`);
      // Line numbers name a version of the file: one the worker has not seen may have moved them. Appending needs no numbers.
      const seen = s.hashes[path];
      if (start <= lines.length && seen && seen !== hash(current!)) throw new Error(`${path} changed since the version you last saw, so lines ${start}..${end} may no longer be the lines you mean; read it again (or append with start = totalLines + 1)`);
      return { start, end };
    })() : null;
    const contracts = await this.contractsFor(s, path, `${purpose}\n${thought}\n${s.notes ?? ''}`);
    const project = await projectFor(this.tools.root, path); const declared = project ? await project.eco.declared(join(this.tools.root, project.dir)).catch(() => [] as string[]) : [];
    // A stylesheet is written against the class names the markup uses (and, when it exists, those it has no rule for yet).
    const markup: Record<string, unknown> = {};
    if (languageFor(path)?.kind === 'style') {
      const used = await markupClassNames(this.tools.root, s.knownFiles).catch(() => ({} as Record<string, string[]>));
      if (Object.keys(used).length) {
        markup.classNamesUsedByMarkup = used;
        if (current !== undefined) { const has = stylesheetClasses(current); const without = [...new Set(Object.values(used).flat())].filter(n => !has.has(n)); if (without.length) markup.classNamesWithoutRuleInThisFile = without.slice(0, 200); }
      }
    }
    const builds = region ? [0, 1].map(k => () => regionMessages(s, path, purpose, current!, region.start, region.end, contracts, declared, k, markup)) : [0, 1].map(k => () => newFileMessages(s, path, purpose, contracts, declared, k, current, markup));
    const generated = await this.generateCode(s, rewrite ? 'rewrite_file' : 'create_file', builds, this.config.createTokens, fenceFor(path));
    const finish = generated.finish; let code = generated.code;
    if (region) {
      // The block alone, without context lines the model repeated around it, spliced between the untouched lines.
      const block = trimContext(code, lines.slice(Math.max(0, region.start - 4), region.start - 1).join('\n'), lines.slice(region.end, region.end + 3).join('\n')).replace(/\n$/, '');
      const blockLines = block === '' ? [] : block.split('\n');
      code = [...lines.slice(0, region.start - 1), ...blockLines, ...lines.slice(region.end)].join('\n') + (current!.endsWith('\n') || !current ? '\n' : '');
      (region as any).lines = blockLines.length;
    }
    const ended = finish === 'length' ? `reached the ${this.config.createTokens}-token budget` : finish === 'repetition' ? 'started repeating itself and was cut at the repeat' : finish === 'eos' ? 'ended before the file was complete (the model stopped without closing the code block)' : '';
    if (ended) this.observe({ kind: 'warning', step: s.step, text: `${path}: the generated content ${ended}` });
    if (rewrite && code.replace(/\s+$/, '') === current!.replace(/\s+$/, '')) throw new Error(`the rewrite of ${path} reproduced its current content unchanged${ended ? ` and ${ended}` : ''}; nothing was written. Say in purpose exactly what must differ, or edit the lines that are wrong with replace_lines`);
    const result = rewrite
      ? await this.execute(s, 'write', { path, expectedHash: hash(current!), oldText: current!, newText: code, wholeFile: true, ...(region ? { region } : {}) }, 'rewrite')
      : await this.execute(s, 'create_file', { path, content: code }, 'create');
    if (!result.ok) throw new Error(result.text);
    // Contracts the file breaks are facts for the worker: names a repository module does not declare, packages the manifest does not declare.
    const readRepo = async (p: string) => { try { return await readFile(await safePath(this.tools.root, p), 'utf8'); } catch { return null; } };
    const facts = [...await unresolvedImports(path, code, readRepo).catch(() => [] as string[])];
    const manifest = project ? project.eco.markers.map(m => inProject(project, m)) : [];
    const present = []; for (const m of manifest) if ((await readRepo(m)) !== null) present.push(m);
    if (present.length) { const missing = await undeclaredPackages(this.tools.root, path, code, readRepo).catch(() => [] as string[]); if (missing.length) facts.push(`${path} imports ${missing.join(', ')}, which ${present.join(' or ')} does not declare: declare them (the package manager chooses the version) so they can be installed`); }
    if (ended) facts.unshift(`the generated content of ${path} ${ended}; check its end before relying on it`);
    // A file that does not parse after a generation that ran to its end: the
    // errors are in what was written, not in a cut, so the worker is told which.
    else if (/does not parse/.test(result.text)) facts.unshift(`the generation of ${path} ran to its end (${code.split('\n').length} lines, not cut off); the parse errors are in the written content`);
    if (facts.length) { const e = s.entries.at(-1); if (e) e.text += `\nHarness: ${facts.join(' | ')}`; s.lastError = facts.join(' | '); }
  }

  // ---- completion --------------------------------------------------------------
  private async completionFacts(s: Session, summary: string): Promise<Parameters<typeof evidenceGate>[2]> {
    const diff = await runCommand('git', ['diff', '--stat', 'HEAD', '--'], s.root, 10000).catch(() => null);
    const untracked = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], s.root, 10000).catch(() => null);
    const diffStat = [diff?.code === 0 ? diff.output.trim() : '', untracked?.code === 0 && untracked.output.trim() ? `untracked: ${untracked.output.trim().split('\n').slice(0, 40).join(', ')}` : ''].filter(Boolean).join('\n') || `changed files: ${s.writes.join(', ') || 'none'}`;
    const sources: Record<string, string> = {};
    for (const p of s.writes.slice(-12)) { const t = await readIfPresent(s.root, p); if (t !== null) sources[p] = clip(t, 1200); }
    // Whether the render action could run here: the worker may use it and the machine has a browser.
    const canRender = (s.allowedActions ?? []).includes('render') && Boolean((s.orientation as any)?.toolchain?.browser);
    const render = s.lastRender ? { step: s.lastRender.step, afterLastWrite: s.lastRender.step > s.lastWriteStep, ok: s.lastRender.ok, url: s.lastRender.url, facts: s.lastRender.text } : canRender ? 'never rendered: nothing is known about what the user sees' : 'cannot be rendered here (no browser, or the shell is not allowed)';
    const renderState = !canRender && !s.lastRender ? 'unavailable' as const : !s.lastRender ? 'never' as const : s.lastRender.step > s.lastWriteStep ? 'current' as const : 'stale' as const;
    return { summary: clip(summary, 1500), changedFiles: s.writes, diffStat: clip(diffStat, 2500), render, renderState, verification: { command: s.lastCheck?.command ?? s.lastCheckCommand, ok: s.lastCheck?.ok ?? null, afterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep), exitCode: s.lastCheck?.summary.code ?? null, text: clip(s.lastCheck?.text ?? '', 800) }, requirements: referenceContext(s, 2000).map(e => clip(e.text, 300)), sources };
  }

  // ---- the loop ----------------------------------------------------------------
  async run(s: Session): Promise<Session> {
    s.status = 'running'; s.stopReason = '';
    s.watch ??= { noProgress: 0, readings: [], escalations: 0 }; s.blockedActions ??= []; s.notes ??= '';
    if (s.baselineStatus === null) s.baselineStatus = await repositoryStatus(this.tools.root).then(r => r.git ? r.changed : []).catch(() => []);
    if (!s.orientation) { s.orientation = await orient(this.tools.root) as unknown as Record<string, unknown>; await this.store.log('orientation', { step: s.step, orientation: s.orientation }); }
    if (this.config.checkCommand && !s.lastCheckCommand) s.lastCheckCommand = this.config.checkCommand;
    this.tools.config.checkCommand = s.lastCheckCommand ?? '';
    const endStep = s.step + this.config.maxSteps;
    let generationFailures = 0;
    try {
      for (; s.step < endStep;) {
        s.step++; this.current = s.step; s.currentTurn = null;
        this.observe({ kind: 'step', step: s.step, phase: s.phase, maxStep: endStep });
        if (this.config.allowBash && await this.retrySetup(s)) { await this.store.save(s); continue; }
        // The files the objective names, pinned as read by the harness; a changed one is read and ranked again.
        const pinned = await pinReferences(s, this.tools.root, (query, chunks) => relevance(this.jev, s, query, chunks, 1200)).catch(() => [] as string[]);
        if (pinned.length) await this.store.log('references', { step: s.step, files: pinned, chunks: s.referenceEvidence.filter(e => pinned.includes(e.path)).length });
        // The watchdog's standing verdicts shape the step: a repeated failure blocks its identical retry; no progress for a run of steps ends the attempt or asks the user.
        const last = s.watch.readings.at(-1); const notes: string[] = [];
        if (last && last.stuck >= .9 && s.watch.noProgress >= 2) {
          s.watch.escalations++;
          if (last.needsUser >= .5 || s.watch.escalations >= 2) { s.status = 'paused'; s.stopReason = `Jev reads the session as stuck (stuck ${last.stuck.toFixed(2)}, no progress for ${s.watch.noProgress} steps)${last.needsUser >= .5 ? ' and in need of the user' : ''}. Last error: ${clip(s.lastError ?? 'none', 300)}`; break; }
          // Every earlier turn is dropped, the results kept: the facts stay, the
          // line of thought the worker would copy and anchor on goes (a turn
          // before the streak often holds the same reasoning).
          const dropped = s.entries.filter(e => e.kind === 'turn');
          if (dropped.length) { s.entries = s.entries.filter(e => !dropped.includes(e)); await this.store.log('reasoning-reset', { step: s.step, turns: dropped.map(e => e.id) }); }
          notes.push(`Jev reads no progress for ${s.watch.noProgress} steps (stuck ${last.stuck.toFixed(2)}).${dropped.length ? ' Your reasoning from those steps was set aside; their results are still shown.' : ''} Do not repeat what was tried; change the approach, or ask the user if only they can decide.`);
          s.watch.noProgress = 0;
        }
        // Scope and completion, read by Jev, stated to the worker: work beyond the objective for a run of steps, or an objective that reads as satisfied.
        const recent = s.watch.readings.slice(-3);
        if (recent.length === 3 && recent.every(r => (r.inScope ?? 1) < .3)) notes.push('Jev reads the last three steps as work the objective did not ask for. Finish what the objective asks, run your check, and finish; or ask the user whether the extra work is wanted.');
        // The harness proposes completion itself when Jev reads the objective as
        // satisfied and the check passed after the last edit: once per check,
        // judged by the evidence gate like a worker's claim; a rejection says why.
        // Never on a page that last rendered broken, and never on user-facing work that was never rendered after the last edit.
        const renderStands = !s.lastRender || (s.lastRender.ok && s.lastRender.step > s.lastWriteStep);
        const proposeFinish = Boolean(last && last.objective >= .7 && s.lastCheck?.ok && s.lastCheck.step > s.lastWriteStep && renderStands && s.finishTriedAtCheck !== s.lastCheck.step);
        if (proposeFinish) {
          s.finishTriedAtCheck = s.lastCheck!.step;
          await this.store.log('auto-finish', { step: s.step, objective: last!.objective, check: s.lastCheck!.step });
          const facts = await this.completionFacts(s, `Proposed by the harness: Jev reads the objective as satisfied (${last!.objective.toFixed(2)}) and ${s.lastCheck!.command ?? s.lastCheckCommand} passed after the last edit. Notes: ${clip(s.notes ?? '', 600)}`);
          const verdict = await evidenceGate(this.jev, s, facts);
          await this.store.log('completion', { step: s.step, proposedBy: 'harness', ...verdict });
          this.observe({ kind: 'jev', step: s.step, ms: 0, questions: 4, stateBytes: 0, route: [[verdict.route, 1]], nouls: { matches: verdict.matches, unaddressed: verdict.unaddressed, supported: verdict.supported } });
          if (verdict.accepted) { s.status = 'complete'; s.stopReason = `Complete: the objective is met by the facts and Jev's reading; ${clip(s.notes ?? '', 300)}`; break; }
          if (verdict.route === 'human') { s.status = 'paused'; s.stopReason = `Completion proposed by the harness; Jev routes it to the user for review. ${clip(s.notes ?? '', 300)}`; break; }
          notes.push(`The harness proposed completion because Jev reads the objective as likely satisfied and your check passes; the evidence gate did not accept it: ${verdict.reason}. Address that, then finish.`);
        }
        if (s.lastCheckCommand && s.lastWriteStep > (s.lastCheck?.step ?? -1) && s.editsSinceCheck >= 3) notes.push(`${s.editsSinceCheck} edits have landed since your check last ran; run it when you want them judged.`);
        const readOnly = s.readOnlyTurns ?? 0;
        if (readOnly >= 3) notes.push(`Your last ${readOnly} turns only read or searched; nothing changed. The evidence already holds what they returned. Act on it now, or say in your thought exactly which fact is still missing.`);
        if (s.setupError) notes.push(`The dependency install failed for the current manifest: ${s.setupError}. The manifest is yours to change; the install runs again by itself after the change.`);
        if (s.completionFeedback && !s.completionFeedback.addressed) notes.push(s.completionFeedback.text);
        const allowed: Route[] = [...actions].filter(a => (this.config.allowWrite || !editRoutes.includes(a as Route)) && (this.config.allowBash || (a !== 'bash' && a !== 'render'))) as Route[];
        s.allowedActions = allowed;
        // One reasoning per batch of actions, not per action: the worker names an
        // ordered list, the harness runs it back to back and stops at the first
        // failure, which is when reasoning is worth paying for again.
        let thought = ''; let batch: { action: Route; args: Record<string, any> }[] = [];
        try {
          const item = { anyOf: stepSchema.anyOf!.filter(alt => allowed.includes(alt.properties!.action!.const as Route)) };
          const gen = await this.generateJson(s, 'step', () => stepMessages(s, allowed, notes.join(' ') || undefined), { type: 'object', properties: { thought: { type: 'string' }, actions: { type: 'array', minItems: 1, maxItems: 8, items: item } }, required: ['thought', 'actions'], additionalProperties: false });
          thought = String(gen.thought ?? '').trim(); batch = (gen.actions as any[]).map(a => ({ action: String(a.action) as Route, args: (a.args ?? {}) as Record<string, any> }));
          s.lastThought = thought;
          await this.store.log('thought', { step: s.step, thought: clip(thought, 2000), actions: batch.map(b => b.action) });
        } catch (e) {
          if (++generationFailures >= 4) throw e;
          const cut = /\(length\)/.test((e as Error).message);
          const why = cut ? `your reply reached the ${this.config.maxTokens}-token limit before it closed, so nothing ran: file content inside the arguments (replace_lines or write with a large newText) does not fit. Use rewrite_file or create_file for large content, which generate it as code without that limit; keep the thought short.` : (e as Error).message;
          this.observe({ kind: 'generation_error', step: s.step, message: why }); await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${why}` }); await this.store.save(s); continue;
        }
        // The turn enters the evidence before its actions run: the prefix only grows,
        // and a file generated inside the batch already sees the reasoning behind it.
        // Reasoning copied word for word from the previous turn is the worker anchoring on its
        // own text: the earlier turns leave the prompt at once (results stay), without waiting
        // for the watchdog to read the session as stuck. Whole-thought equality, as stored:
        // turns that only open alike (a status sentence) are ordinary progress.
        const turn = turnEntry(s.step, thought, batch);
        const said = (e: { text: string }) => String(JSON.parse(e.text).thought ?? '').replace(/\s+/g, ' ').trim();
        const previous = s.entries.filter(e => e.kind === 'turn').at(-1);
        // Only the earlier copies go: they are what the worker copies from, and they sit
        // late in the prompt, so the cache breaks near its end rather than at the top.
        if (previous && said(turn).length >= 40 && said(previous) === said(turn)) {
          const dropped = s.entries.filter(e => e.kind === 'turn' && said(e) === said(turn));
          s.entries = s.entries.filter(e => !dropped.includes(e));
          await this.store.log('reasoning-reset', { step: s.step, reason: 'repeated', turns: dropped.map(e => e.id) });
        }
        s.entries.push(turn); s.currentTurn = turn.id;
        let halted = false;
        for (let i = 0; i < batch.length; i++) {
          if (i > 0) { if (s.step >= endStep) break; s.step++; this.current = s.step; this.observe({ kind: 'step', step: s.step, phase: s.phase, maxStep: endStep }); }
          const outcome = await this.perform(s, batch[i]!.action, batch[i]!.args, thought);
          turn.outcomes!.push(`${batch[i]!.action} ${outcome}${outcome === 'failed' || outcome === 'refused' ? `: ${(s.lastError ?? '').split('\n')[0]!.slice(0, 90)}` : ''}`);
          // A refused action (repeated, blocked, malformed) counts toward the four
          // in a row that end the attempt; a command that ran and failed is a result.
          if (outcome === 'ok' || outcome === 'failed') generationFailures = 0;
          if (outcome === 'refused' && ++generationFailures >= 4) throw new Error('four actions in a row could not be executed; the session needs a different approach');
          if (outcome === 'stop') { halted = true; break; }
          if ((outcome === 'failed' || outcome === 'refused') && i < batch.length - 1) { const e = s.entries.at(-1); if (e) e.text += `\nThe remaining ${batch.length - 1 - i} action(s) of this batch were not run (${batch.slice(i + 1).map(b => b.action).join(', ')}); reason about the result first.`; break; }
        }
        s.currentTurn = null;
        // A turn whose every action was refused changed nothing and is a template the
        // worker copies word for word: it leaves the prompt, the refusals stay.
        if (turn.outcomes!.length && turn.outcomes!.every(o => o.includes('refused'))) { s.entries = s.entries.filter(e => e !== turn); for (const e of s.entries) if (e.turn === turn.id) delete e.turn; }
        if (halted) break;
        s.readOnlyTurns = batch.every(b => b.action === 'read_files' || b.action === 'search_codebase') ? (s.readOnlyTurns ?? 0) + 1 : 0;
        await this.watch(s); await this.store.save(s);
      }
      if (s.status === 'running') { s.status = 'paused'; s.stopReason = `Reached the ${this.config.maxSteps}-step limit for this invocation`; }
    } catch (e) {
      s.status = 'paused'; s.stopReason = `Stopped: ${(e as Error).message}`;
    }
    await this.store.log('stop', { step: s.step, status: s.status, reason: s.stopReason });
    this.observe({ kind: 'stop', step: s.step, status: s.status, reason: s.stopReason });
    await this.store.save(s);
    return s;
  }

  // Run one action with every check the harness can make around it. Returns
  // whether it succeeded, failed, or ended the session.
  private async perform(s: Session, routeIn: Route, argsIn: Record<string, any>, thought: string): Promise<'ok' | 'failed' | 'refused' | 'stop'> {
    let route = routeIn; let args = argsIn;
    const refuse = async (why: string) => { this.observe({ kind: 'generation_error', step: s.step, message: why }); await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${why}` }); return 'refused' as const; };
    if (route === 'write' && args.expectedHash === 'new' && typeof args.path === 'string' && !(await safePath(this.tools.root, args.path, true).then(f => stat(f)).then(() => true, () => false))) { route = 'create_file'; args = { path: args.path, purpose: thought, content: String(args.newText ?? '') }; }
    const key = Agent.actionKey(s, route, args);
    if (s.blockedActions!.includes(key)) return refuse('this exact action already failed the same way and Jev read the failure as unchanged; it is not run again. Change the approach.');
    const earlier = s.actions[key];
    if (earlier !== undefined && s.entries.some(e => e.step === earlier && e.kind === route) && !(route === 'read_files' && (args.files as { path: string }[]).some(f => (s.writeSteps[f.path] ?? -1) > earlier)) && route !== 'bash' && route !== 'plan' && route !== 'render') return refuse(`this ${route} was already done at step ${earlier} and its result is in the evidence; act on it or choose another action`);
    // A command that succeeded, run again with nothing written or installed since
    // and its output still shown, prints the same thing: it is not run again.
    if (route === 'bash') { const prior = s.commandRuns?.[String(args.command ?? '').trim()]; if (prior?.ok && prior.world === Agent.world(s) && s.entries.some(e => e.step === prior.step && e.kind === 'bash')) return refuse(`this exact command already ran at step ${prior.step} and nothing has been written or installed since, so it would print the same output, which is in the evidence (e${prior.step}); act on that output or run something different`); }
    s.actions[key] = s.step;
    if (route === 'plan') { s.notes = clip(String(args.notes ?? ''), 4000); await this.store.log('plan', { step: s.step, notes: s.notes }); await this.evidence(s, 'plan', { ok: true, text: `Notes updated (${s.notes.split('\n').length} lines).` }); return 'ok'; }
    if (route === 'render') {
      if (!this.config.allowBash) return refuse('render needs --allow-bash (it starts the server).');
      const url = String(args.url ?? ''); const serve = String(args.serve ?? '');
      const shot = join(this.store.artifacts, `${String(s.step).padStart(5, '0')}-render.png`);
      const r = await renderFacts(this.tools.root, url, serve || undefined, shot, this.config.commandTimeoutMs).catch(e => ({ ok: false, text: `Render failed: ${(e as Error).message}` }) as { ok: boolean; text: string; unmatched?: string[] });
      if (r.unmatched?.length) {
        // Where each unstyled class name is used, so the stylesheet can be written without re-reading every component.
        const where: Record<string, string[]> = {};
        const hits = await runCommand('rg', ['-l', '--color', 'never', '-F', '-g', '!node_modules/**', '-g', '!dist/**', '-g', '!build/**', ...r.unmatched.flatMap((c: string) => ['-e', c]), '.'], this.tools.root, 15000).catch(() => null);
        for (const f of (hits?.output ?? '').split('\n').map(l => l.replace(/^\.\//, '')).filter(Boolean).slice(0, 40)) { const text = await readIfPresent(this.tools.root, f).then(x => x ?? ''); const used = r.unmatched!.filter((c: string) => new RegExp(`(^|[^\\w-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)); if (used.length && !/\.(?:css|scss|sass|less)$/.test(f)) where[f] = used; }
        const stylesheets = s.knownFiles.filter(f => /\.(?:css|scss|sass|less)$/.test(f) && !/(^|\/)(?:node_modules|dist|build)\//.test(f));
        r.text += `\nClass names no CSS selector matches, by the file that uses them:\n${Object.entries(where).map(([f, cs]) => `  ${f}: ${cs.join(' ')}`).join('\n') || '  (not found in the sources)'}\nStylesheets in the project: ${stylesheets.join(', ') || 'none'}.`;
      }
      await this.store.log('render', { step: s.step, url, serve, ok: r.ok, text: clip(r.text, 3000) });
      s.lastRender = { step: s.step, ok: r.ok, url, text: clip(r.text, 1800) };
      await this.evidence(s, 'render', { ok: r.ok, text: r.text }, args);
      this.observe({ kind: 'result', step: s.step, route, ok: r.ok, ms: 0, chars: r.text.length, text: clip(r.text, 200) });
      return r.ok ? 'ok' : 'failed';
    }
    if (route === 'ask_user') { s.status = 'paused'; s.stopReason = String(args.question ?? 'The worker needs a decision from the user.'); await this.store.log('ask', { step: s.step, question: s.stopReason }); return 'stop'; }
    if (route === 'finish') {
      if (s.lastCheckCommand && s.lastWriteStep > (s.lastCheck?.step ?? -1)) return refuse(`${s.lastCheckCommand} has not run since the last edit; run it, then finish.`);
      const facts = await this.completionFacts(s, String(args.summary ?? ''));
      await this.store.log('completion-facts', { step: s.step, facts: { ...facts, sources: Object.keys(facts.sources as object) } });
      const verdict = await evidenceGate(this.jev, s, facts);
      await this.store.log('completion', { step: s.step, ...verdict });
      this.observe({ kind: 'jev', step: s.step, ms: 0, questions: 4, stateBytes: 0, route: [[verdict.route, 1]], nouls: { matches: verdict.matches, unaddressed: verdict.unaddressed, supported: verdict.supported } });
      if (verdict.accepted) { s.status = 'complete'; s.stopReason = `Complete: ${clip(String(args.summary ?? ''), 400)}`; return 'stop'; }
      if (verdict.route === 'human') { s.status = 'paused'; s.stopReason = `Completion proposed; Jev routes it to the user for review: ${clip(String(args.summary ?? ''), 400)}`; return 'stop'; }
      s.completionFeedback = { step: s.step, text: `The completion proposed at step ${s.step} was not accepted: ${verdict.reason}. Address it, verify, and finish again.`, awaitingEvidence: true };
      await this.evidence(s, 'completion', { ok: false, text: s.completionFeedback.text }); return 'failed';
    }
    if (route === 'create_file' || route === 'rewrite_file') {
      try { if (route === 'create_file' && typeof args.content === 'string' && args.content.trim()) await this.execute(s, 'create_file', { path: args.path, content: args.content }, 'write-as-create'); else await this.createFile(s, String(args.path), String(args.purpose ?? ''), thought, route === 'rewrite_file', { start: args.start, end: args.end }); }
      catch (e) { return refuse((e as Error).message); }
      return s.lastResultOk ? 'ok' : 'failed';
    }
    // A command the worker marks as its verification is the check of record from then on; its result is judged like any check.
    if (route === 'bash') {
      const command = String(args.command).trim();
      const isCheck = args.check === true || command === s.lastCheckCommand;
      let result = await this.execute(s, 'bash', { ...args, command, ...(isCheck ? { check: true } : {}) }, 'action');
      if (!result.ok) {
        const output = (() => { try { return String(JSON.parse(result.text).output ?? result.text); } catch { return result.text; } })();
        const kind = await triage(this.jev, s, command, output).catch(() => ({ kind: 'unknown' as const, probability: 0 }));
        await this.store.log('triage', { step: s.step, command: clip(command, 200), ...kind });
        if (kind.kind === 'transient' && kind.probability >= .7) { result = await this.execute(s, 'bash', { ...args, command, ...(isCheck ? { check: true } : {}) }, 'auto-retry'); if (!result.ok) s.blockedActions!.push(Agent.actionKey(s, 'bash', args)); }
        else if (kind.kind === 'permission' && kind.probability >= .7) { s.status = 'paused'; s.stopReason = `The command needs the user: ${clip(command, 200)}\n${clip(output, 500)}`; return 'stop'; }
        else { const e = s.entries.at(-1); if (e) e.text += `\nJev reads this failure as: ${kind.kind} (${failureKindText(kind.kind)}).`; }
      }
      return result.ok ? 'ok' : 'failed';
    }
    const result = await this.execute(s, route, args, 'action');
    // Many search hits: Jev keeps the ones that matter for what the worker is doing.
    if (route === 'search_codebase' && result.ok) {
      let output = ''; try { output = String(JSON.parse(result.text).output ?? ''); } catch { output = result.text; }
      const lines = output.split('\n').filter(Boolean);
      if (lines.length > 12) { const ranked = await rankExcerpts(this.jev, s, String(args.query), lines).catch(() => null); if (ranked) { const e = s.entries.at(-1); if (e) e.text = `${ranked.kept.join('\n')}\n(${ranked.dropped} further hits omitted as less relevant; search narrower to see them)`; await this.store.log('retrieval-rank', { step: s.step, kept: ranked.kept.length, dropped: ranked.dropped }); } }
    }
    return result.ok ? 'ok' : 'failed';
  }
  // One watchdog reading after each meaningful action; the policy that acts on it is deterministic and lives in the loop.
  private async watch(s: Session): Promise<void> {
    const t0 = performance.now();
    let reading; try { reading = await watchdog(this.jev, s); } catch (e) { await this.store.log('watchdog-error', { step: s.step, error: (e as Error).message }); return; }
    s.watch!.readings = [...s.watch!.readings.slice(-19), reading];
    if (reading.progress < .3) s.watch!.noProgress++; else s.watch!.noProgress = 0;
    // The same failure again, with nothing changed: the identical action is not run a third time.
    if (reading.sameFailure >= .9 && s.lastRoute && !s.lastResultOk) { const last = s.entries.at(-1); if (last) { const key = Object.entries(s.actions).find(([, step]) => step === s.step)?.[0]; if (key && !s.blockedActions!.includes(key)) s.blockedActions!.push(key); } }
    await this.store.log('watchdog', { ...reading, noProgress: s.watch!.noProgress, ms: performance.now() - t0 });
    this.observe({ kind: 'jev', step: s.step, ms: performance.now() - t0, questions: 6, stateBytes: 0, route: [], nouls: { progress: reading.progress, stuck: reading.stuck, same_failure: reading.sameFailure, objective: reading.objective, needs_user: reading.needsUser, in_scope: reading.inScope } });
  }
}
// The evidence's share of the working budget that triggers a batched eviction, and the share it is cut to.
const evictAt = .45; const evictTo = .3;
const failureKindText = (k: string): string => ({ code_bug: 'the code or configuration written is wrong', wrong_assumption: 'an assumption the output disproves', bad_command: 'the command itself', environment: 'a tool or service the machine lacks', dependency: 'a package missing, unresolvable or at a version that does not exist', permission: 'permission or credentials', transient: 'a network or timing failure', insufficient_context: 'acting without reading what was needed', unknown: 'unclear' } as Record<string, string>)[k] ?? k;
export { boundedRead };
