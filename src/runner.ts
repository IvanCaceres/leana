import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bonsai, Jev } from './clients.js';
import { createFileMessages, rewriteRegionMessages, trimContext, fenceFor, focusedMessages, checkDelta, clip, compactNames, confidentChoice, decisionState, evictOne, mergeCoverage, messages, rememberEdit, retireEvidence, routeQuestions, type CreateTarget, type RegionTarget } from './context.js';
import { extractCode, focusedEditSchema, schemas } from './schema.js';
import { addPackagesCommand, aliasImportBinding, manifestFailures, missingDependencies, missingPackages, installCommand, installedPackages, runCommand, repositoryStatus, readOnlyCommand, checkUnusable, topLevelDeclarations, namedIdentifiers, removeImportBindings, checkAdvice, completionSource, hash, importInsertLine, listRepoFiles, regression, resolveMissingNames, safePath, sourceHashes, StaleWriteError, statementBounds, summarizeCheck, syntaxErrors, ToolBox } from './tools.js';
import { unaccountedFiles, auditQuestions, auditVerdict, candidates, commandLike, completionEvidence, completionState, decideStep, readyToFinish, stepQuestions, taskRecord } from './decide.js';
import { designFrom, anchorPath, candidatesFrom, checkCandidates, checkPrompt, checkSchema, checkSelectionQuestions, configLike, contractsFor, deriveDeliverables, exportedNames, importContracts, ledgerFile, ledgerPrompt, ledgerQuestions, ledgerSchema, missingExports, parseDesign, refreshLedger, structuralDiff, tierQuestions, tierState, trialFacts } from './ledger.js';
const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
import { Store } from './store.js';
import { referenceContext, rememberReferences } from './references.js';
import { editRoutes } from './types.js';
import type { Answers, Deliverable, Config, GenerationMeta, Message, Phase, Route, Session, Task, ToolResult } from './types.js';
import { lineObserver, type ProgressEvent } from './display.js';

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000) throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try { instructions = await readFile(join(root, 'AGENTS.md'), 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(instructions) > 12000) throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return { version: 1, root, objective, instructions, step: 0, tasks: [], focus: null, entries: [],
    lastCompact: -100, status: 'running', stopReason: '', writes: [], lastWriteStep: -1, lastCheckStep: -1,
    phase: 'inspect', knownFiles: await listRepoFiles(root), inspectionCount: 0, lastError: null, editEvidence: [], referenceEvidence: [], completionFeedback: null, finishTriedAtCheck: -1, lastToolError: null, moveDirection: null, pendingMoves: [], ledger: [], design: null, ledgerAttempts: 0, ledgerBuilt: false, ledgerComplete: 0, baselineArtifacts: {}, checkInferences: 0, checkInferredFor: -1, setupDone: false, baselineStatus: null,
    lastRoute: null, lastResultOk: false, lastWriteStale: false, repetitions: {}, coverage: {}, hashes: {}, lastPromptTokens: 0, lastCheck: null, previousCheck: null, editSnapshots: {}, missingNames: [], transaction: [], rejectedEdits: [], lastCheckCommand: null, pendingCheck: false, autoUndo: null, inspectionsSinceAction: 0, coverageByHash: {}, repetitionSteps: {}, focusReadAt: -1, autoFixKeys: {}, actions: {}, searches: {}, blockedRoute: null, editsSinceCheck: 0, readHashes: {}, writeSteps: {}, pendingRepairs: [] };
}
export function updateTasks(s: Session, tasks: Task[]): void {
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Task IDs must be unique');
  for (const old of s.tasks) if (!tasks.some(t => t.id === old.id)) throw new Error('Preserve existing task IDs in the ledger');
  for (const task of tasks) {
    if (task.status === 'done' && !task.evidence.trim()) throw new Error('Completed tasks require evidence');
  }
  s.tasks = tasks;
  if (!tasks.some(t => t.id === s.focus && t.status === 'pending')) s.focus = null;
}
export class Runner {
  readonly tools: ToolBox;
  private current = 0;
  constructor(readonly config: Config, readonly store: Store, readonly jev: Pick<Jev, 'decide'>,
    // generateText is the raw-code path; a worker without it (a test double, an
    // API without a completion endpoint) gets the same prompt under a one-field JSON schema.
    readonly bonsai: Pick<Bonsai, 'count' | 'generate'> & { lastMeta?: GenerationMeta | null; generateText?: Bonsai['generateText'] }, root: string,
    readonly progress: (message: string) => void = console.error,
    observer?: (e: ProgressEvent) => void) {
    this.tools = new ToolBox(root, store.artifacts, config, (path, text) => store.snapshot(this.current, path, text));
    this.observe = observer ?? lineObserver(progress, config.verbose);
  }
  readonly observe: (e: ProgressEvent) => void;
  async evidence(s: Session, kind: string, result: ToolResult, args?: Record<string, any>): Promise<void> {
    const artifact = await this.store.artifact(s.step, result.text);
    // Reads keep the full budget because edits are made from their exact text;
    // everything else is summarized more tightly, since it only informs decisions.
    const limit = kind === 'read_files' ? this.config.toolChars : kind === 'bash' ? Math.min(this.config.toolChars, 2500)
      : kind === 'search_codebase' ? Math.min(this.config.toolChars, 1500) : Math.min(this.config.toolChars, 600);
    if (kind === 'read_files' && result.ok && args) {
      // A fresh read of a range supersedes the older read of the same file and
      // start line. The older entry is flagged, not removed or rewritten: the
      // evidence list is append-only so the server can reuse the prompt prefix.
      for (const f of args.files as { path: string; start: number }[])
        for (const e of s.entries) if (e.kind === 'read_files' && !e.stale && new RegExp(`(^|\\n\\n)${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sha256=\\w+ totalLines=\\d+ shown=${f.start}\\.\\.`).test(e.text)) { e.stale = `superseded by the read at step ${s.step}`; e.relevance = .1; }
    }
    s.entries.push({ id: `e${s.step}`, step: s.step, kind, artifact, text: clip(result.text, limit), relevance: result.ok ? .5 : .9, verification: result.verification });
    // A shell command that is not read-only may have edited files (sed -i, a
    // formatter): every written or named file whose hash changed is an edit of
    // this step, so reads of it go stale and the check is due again.
    if (kind === 'bash' && typeof args?.command === 'string' && !readOnlyCommand(args.command)) {
      const named = s.knownFiles.filter(p => p.length > 3 && args.command.includes(p));
      // The baseline is the current hash, or the last check's record of it: the
      // hash map keeps only recent files, the check recorded every written one.
      const baseline = (p: string) => s.hashes[p] ?? s.lastCheck?.fileHashes?.[p];
      const watched = [...new Set([...s.writes, ...named])].filter(p => baseline(p) && baseline(p) !== 'unavailable');
      const now = await sourceHashes(s.root, watched);
      const changed = watched.filter(p => now[p] !== 'unavailable' && now[p] !== baseline(p));
      if (changed.length) {
        result.changed = [...new Set([...(result.changed ?? []), ...changed])];
        result.hashes = { ...(result.hashes ?? {}), ...Object.fromEntries(changed.map(p => [p, now[p]!])) };
        await this.store.log('bash-edit', { step: s.step, files: changed, command: clip(args.command, 200) });
      }
    }
    if (result.ok && result.changed?.length && editRoutes.includes(kind as Route)) {
      rememberEdit(s, s.step, kind, result.changed, artifact, result.text, args);
      // An edit, the harness's included, means implementation has begun: finish and edits are on the menu.
      if (s.phase === 'inspect') s.phase = 'implement';
    }
    if (kind === 'read_files' || kind === 'search_codebase') if (result.ok) s.inspectionCount++;
    if (kind === 'search_codebase' && result.ok && args) {
      // What each search found stays visible after its entry is evicted, so the
      // worker can see which symbols are located and which remain.
      let output = '';
      try { output = String(JSON.parse(result.text).output ?? ''); } catch { output = result.text; }
      const lines = output.split('\n').filter(Boolean);
      const summary = output.startsWith('(no matches') ? '(no matches)'
        : lines.slice(0, 3).map(l => clip(l, 100)).join(' | ') + (lines.length > 3 ? ` | +${lines.length - 3} more` : '');
      const key = `${args.mode}:${args.query} in ${args.path}`;
      delete s.searches[key]; s.searches[key] = summary;
      for (const old of Object.keys(s.searches).slice(0, -20)) delete s.searches[old];
    }
    if (kind === 'read_files' && result.ok) {
      rememberReferences(s, result.text);
      // Line numbers for edits must come from a read of the current version.
      for (const [path, h] of Object.entries(result.hashes ?? {})) s.readHashes[path] = h;
      // Remember which ranges were seen even after the text itself is evicted.
      for (const m of result.text.matchAll(/(?:^|\n\n)(\S+) sha256=(\w+) totalLines=(\d+) shown=(\d+)\.\.(\d+)/g))
        if (Number(m[5]) >= Number(m[4])) {
          s.coverage[m[1]!] = mergeCoverage(s.coverage[m[1]!], Number(m[3]), Number(m[4]), Number(m[5]));
          s.coverageByHash[`${m[1]}@${m[2]}`] = s.coverage[m[1]!]!;
        }
      for (const old of Object.keys(s.coverageByHash).slice(0, -40)) delete s.coverageByHash[old];
    }
    // The full result lives in the artifact and the clipped entry; lastError is a
    // pinned pointer to the failure, so it must stay small (a failing lint can print 40 KB).
    s.lastError = result.ok ? null : clip(result.text, 1500);
    // Current hashes are ground truth for expectedHash and outlive evidence eviction.
    for (const [path, h] of Object.entries(result.hashes ?? {})) { delete s.hashes[path]; s.hashes[path] = h; }
    for (const stale of Object.keys(s.hashes).slice(0, -20)) delete s.hashes[stale];
    if (kind === 'bash' && typeof args?.command === 'string') { (s.commandRuns ??= {})[args.command.trim()] = { step: s.step, ok: result.ok }; if (s.ledger.some(d => d.kind === 'verify')) await refreshLedger(s.root, s).catch(() => {}); }
    if (result.verification) { s.editsSinceCheck = 0; if (kind === 'bash' && args?.command) s.lastCheckCommand = args.command; }
    if (kind === 'move_lines' && result.ok && !s.moveDirection && args?.source && args?.destination) s.moveDirection = { source: args.source, destination: args.destination };
    // Edits followed by a passing check answer a completion rejection; the pinned
    // text must stop telling Jev the objective is unfinished.
    if (s.completionFeedback && !s.completionFeedback.addressed && result.verification && result.ok && s.lastWriteStep > s.completionFeedback.step)
      s.completionFeedback = { step: s.completionFeedback.step, addressed: true, awaitingEvidence: false, text: `The completion proposed at step ${s.completionFeedback.step} was rejected (${clip(s.completionFeedback.text.replace(/^Completion rejected /, ''), 300)}); edits at step ${s.lastWriteStep} and the passing check at step ${s.step} followed. Propose finish again with claims that match currentSource.` };
    if (result.changed?.length) { s.editsSinceCheck++; s.pendingCheck = Boolean(s.lastCheckCommand); }
    if ((kind === 'read_files' || kind === 'search_codebase' || (kind === 'bash' && typeof args?.command === 'string' && readOnlyCommand(args.command))) && result.ok) s.inspectionsSinceAction++;
    if (result.changed?.length || result.verification || kind === 'undo') s.inspectionsSinceAction = 0;
    for (const changed of result.changed ?? []) {
      if (!s.writes.includes(changed)) s.writes.push(changed);
      s.lastWriteStep = s.step; s.writeSteps[changed] = s.step;
      delete s.coverage[changed]; delete s.readHashes[changed];
      // Search results over this path, or a directory containing it, may have changed.
      for (const key of Object.keys(s.searches)) {
        const at = key.slice(key.lastIndexOf(' in ') + 4);
        if (at === '.' || at === changed || changed.startsWith(at.replace(/\/?$/, '/'))) delete s.searches[key];
      }
      // Earlier reads of this file no longer describe it. Keep them for
      // orientation but flag them so their text is not reused as an anchor.
      const header = `${changed} sha256=`;
      for (const e of s.entries) if (e.kind === 'read_files' && e.step < s.step && !e.stale &&
        (e.text.startsWith(header) || e.text.includes(`\n\n${header}`))) {
        // Flag, do not rewrite: the text stays byte-identical in the prompt (prefix
        // cache) and the tail tells both models it no longer matches the file.
        e.stale = `edited at step ${s.step}: text and line numbers no longer match ${changed}`;
        e.relevance = Math.min(e.relevance, .1);
      }
    }
    if (result.check) s.lastCheckStep = s.step;
    // The latest verification outcome defines the remaining work; keep it pinned
    // until the next check replaces it, whatever compaction does to the entry.
    if (result.verification) {
      s.previousCheck = s.lastCheck;
      s.lastCheck = { step: s.step, ok: result.ok, text: clip(result.text, 1500), summary: summarizeCheck(result.text, s.root), fileHashes: await sourceHashes(s.root, s.writes), ...(kind === 'bash' && typeof args?.command === 'string' ? { command: args.command.trim() } : {}) };
      s.pendingCheck = false;
      if (!result.ok) this.recordFailedVersions(s);
      // The edits since the previous check are now judged by this one. An
      // objective regression in the files that existed is rolled back
      // deterministically; an improvement or a pass is committed silently.
      // A file the transaction created is never rolled back: a scaffold's own
      // errors (a sibling it imports not written yet, a type to fix) are work
      // for the fixer, not grounds to discard the generation that produced it.
      // (A move into a new file is different: its destination is part of the
      // move and is removed with it when the move is rolled back.)
      const created = new Set(s.transaction.filter(t => t.route === 'create_file').flatMap(t => t.paths));
      const edited = Object.fromEntries(Object.entries(s.editSnapshots).filter(([p]) => !created.has(p)));
      const scope = { files: [...new Set([...s.transaction.flatMap(t => t.paths), ...Object.keys(edited)])].filter(p => !created.has(p)), structural: s.transaction.some(t => t.route === 'move_lines') };
      // Two checks are comparable only when they are the same command: a build's
      // failure is no baseline for the type checker's count, or the reverse.
      const comparable = !s.previousCheck?.command || !s.lastCheck.command || s.previousCheck.command === s.lastCheck.command;
      const judged = !result.ok && Object.keys(edited).length > 0 && comparable;
      const verdict = judged ? regression(s.previousCheck?.summary ?? null, s.lastCheck.summary, scope) : 'fine';
      s.autoUndo = verdict === 'worse' ? { files: edited, reason: clip(`the check went from ${s.previousCheck?.summary.errors ?? 0} errors (${s.previousCheck?.summary.syntax ?? 0} syntax) to ${s.lastCheck.summary.errors} (${s.lastCheck.summary.syntax} syntax) in scope ${scope.files.join(', ')}; first new: ${Object.entries(s.lastCheck.summary.byFile).find(([f]) => scope.files.some(p => f.endsWith(p) || p.endsWith(f)))?.[1].samples[0] ?? ''}`, 300) } : null;
      s.editSnapshots = {};
      // Anything not rolled back is committed: the transaction is closed.
      if (verdict === 'fine') s.transaction = [];
      // Resolve every name the check cannot find, so the fix is a known import line.
      let output = result.text; try { output = JSON.parse(result.text).output ?? result.text; } catch { /* plain text */ }
      const deliverables = namedIdentifiers([s.objective, ...referenceContext(s).map(e => e.text)].join('\n'));
      s.missingNames = result.ok ? [] : await resolveMissingNames(this.tools.root, output, s.writes, 40, deliverables, s.moveDirection).catch(() => []);
      await refreshLedger(this.tools.root, s).catch(() => {});
      s.pendingMoves = await this.pendingMoves(s).catch(() => []);
    }
    // A created file has no pre-edit content to restore and is never rolled
    // back, so it never enters the rollback set; it does enter the baseline so
    // the completion diff knows it was created.
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.editSnapshots) && kind !== 'create_file') s.editSnapshots[path] = artifact;
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.baselineArtifacts)) s.baselineArtifacts[path] = artifact;
    // A created file that does not parse is repaired by the harness before any
    // decision is asked; its imports of modules nobody planned become deliverables.
    if (kind === 'create_file' && result.ok && args?.path) {
      const path = String(args.path);
      s.pendingRepairs = s.pendingRepairs.filter(r => r.path !== path);
      if (result.parseErrors?.length) s.pendingRepairs.push({ path, errors: result.parseErrors, attempts: 0 });
      if (result.imports?.length && s.ledger.length) {
        const added = deriveDeliverables(s, path, result.imports, String(args.content ?? ''));
        if (added.length) {
          await this.store.log('derived', { step: s.step, importer: path, added: added.map(d => ({ id: d.id, to: d.to, detail: d.detail })) });
          this.observe({ kind: 'warning', step: s.step, text: `${path} imports ${added.map(d => d.to).join(', ')}, which no deliverable planned; added as deliverables to create` });
        }
      }
    }
    if (result.changed?.length) for (const p of result.changed) s.pendingRepairs = s.pendingRepairs.filter(r => r.path !== p || kind === 'create_file');
    // The ledger follows every edit, the harness's included, whether or not a check runs.
    if (result.ok && result.changed?.length && s.ledger.length) { await refreshLedger(this.tools.root, s).catch(() => {}); s.pendingMoves = await this.pendingMoves(s).catch(() => []); }
    // A failing check ends verification; a failing baseline during inspection
    // is context, not a reason to start editing before the code has been read.
    if (!result.ok && s.phase === 'verify' && (kind === 'bash' || editRoutes.includes(kind as Route))) s.phase = 'implement';
    // Unbounded history lives in artifacts; the decision surface is strictly bounded.
    retireEvidence(s);
    let evicted = 0;
    while (s.entries.length > 12) { evictOne(s); evicted++; }
    if (evicted) await this.store.log('compact', { step: s.step, removed: evicted, reason: 'entry-cap', retained: s.entries.length });
  }
  // Size of each section of the worker prompt, so context use is explainable.
  static breakdown(prompt: Message[]): Record<string, number> {
    const out: Record<string, number> = { system: prompt[0]?.content.length ?? 0 };
    for (const m of prompt.slice(1)) {
      let parsed: any; try { parsed = JSON.parse(m.content); } catch { out.other = (out.other ?? 0) + m.content.length; continue; }
      for (const [k, v] of Object.entries(parsed)) out[k] = (out[k] ?? 0) + JSON.stringify(v).length;
    }
    return out;
  }
  private async logPrompt(s: Session, route: Route, prompt: Message[], tokens: number, attempt: number): Promise<void> {
    const artifact = await this.store.promptArtifact(s.step, attempt, prompt);
    const breakdown = Runner.breakdown(prompt);
    await this.store.log('prompt', { step: s.step, route, attempt, artifact, tokens, workingTokens: this.config.workingTokens, contextWindow: this.config.contextWindow, breakdown });
    if (attempt === 1) this.observe({ kind: 'context', step: s.step, tokens, workingTokens: this.config.workingTokens, contextWindow: this.config.contextWindow, breakdown, entries: s.entries.length });
    this.observe({ kind: 'generating', step: s.step, route, attempt });
  }
  // One key for an action: reads are keyed with the hashes of the files they
  // name (sorted), searches with all known hashes (sorted), so recording and
  // lookup agree and key order cannot defeat repeat detection.
  static actionKey(s: Session, route: Route, args: Record<string, any>): string {
    const hashes = route === 'read_files' ? (args.files as { path: string }[]).map(f => [f.path, s.hashes[f.path] ?? null]).sort()
      : route === 'search_codebase' ? Object.entries(s.hashes).sort() : undefined;
    return hash(JSON.stringify({ route, args, hashes }));
  }
  // Execute a harness-chosen action with the same bookkeeping as a routed one.
  private async forced(s: Session, route: Route, args: Record<string, any>, kind: string): Promise<ToolResult> {
    await this.store.log(kind, { step: s.step, ...args });
    await this.store.log('action', { step: s.step, route, args, forced: true });
    this.observe({ kind: 'route', step: s.step, route, tokens: 0, entries: s.entries.length });
    this.observe({ kind: 'generated', step: s.step, route, meta: null, args });
    const started = performance.now();
    let result: ToolResult;
    try { result = await this.tools.execute(route, args); } catch (e) { result = { ok: false, text: `Tool error: ${(e as Error).message}` }; }
    s.lastRoute = route; s.lastResultOk = result.ok;
    if (result.ok && route !== s.blockedRoute) s.blockedRoute = null;
    await this.evidence(s, route, result, args);
    if (result.ok && editRoutes.includes(route)) s.transaction.push({ key: Runner.actionKey(s, route, args), identity: hash(JSON.stringify({ route, args: { ...args, expectedHash: undefined, destinationHash: undefined } })), step: s.step, route, paths: result.changed ?? [], summary: clip(JSON.stringify({ ...args, expectedHash: undefined }), 200), kind });
    this.observe({ kind: 'result', step: s.step, route, ok: result.ok, ms: performance.now() - started, chars: result.text.length, text: clip(result.text, 200) });
    await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - started, artifact: s.entries.at(-1)?.artifact });
    return result;
  }
  // The harness resolved these fixes from the check; applying them is mechanical,
  // so it does not go through the worker. Each fix set is attempted once; the
  // check that follows commits or rolls it back like any other edit.
  // Once the extraction has a direction, the plan's remaining targets are known
  // without a check error naming them: still declared in the source, absent
  // from the destination, and small enough that a misread cannot move main().
  // Ledger items of kind move whose source still declares them are the harness's
  // to perform: never against the session's direction, never a declaration so
  // large that a misclassified item could move main().
  private async pendingMoves(s: Session): Promise<Session['pendingMoves']> {
    const out: Session['pendingMoves'] = [];
    for (const d of s.ledger) {
      if (d.kind !== 'move' || d.status !== 'pending' || !d.name || !d.from || !d.to || d.optional) continue;
      const source = ledgerFile(s, d.from)!; const destination = await anchorPath(this.tools.root, source, ledgerFile(s, d.to)!);
      if (s.moveDirection && !(same(source, s.moveDirection.source) && same(destination, s.moveDirection.destination))) continue;
      let text: string; try { text = await readFile(await safePath(this.tools.root, source), 'utf8'); } catch { continue; }
      const decl = (await topLevelDeclarations(source, text)).get(d.name);
      if (decl && decl.end - decl.start < 600) out.push({ name: d.name, source, start: decl.start, end: decl.end, destination });
    }
    return out;
  }
  // The onset: read the documents the objective names, have the worker list the
  // deliverables under a schema, and let Jev classify each against the request.
  // Returns true when a step was consumed (a forced read or the build itself).
  private async buildLedger(s: Session): Promise<boolean> {
    const docs = [...new Set((s.objective.match(/\S+\.(?:md|txt|rst)\b/gi) ?? []).map(d => d.replace(/[`'",.;:)]+$/, '')))].filter(d => s.knownFiles.includes(d));
    for (const doc of docs) {
      const read = s.coverage[doc]; const total = read?.total ?? 0;
      const covered = read ? read.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0) : 0;
      if (read && (covered >= total || covered >= 750)) continue;
      const start = read ? Math.max(...read.ranges.map(([, b]) => b)) + 1 : 1;
      await this.forced(s, 'read_files', { files: [{ path: doc, start, end: start + 249 }] }, 'auto-read');
      return true;
    }
    if (s.ledgerAttempts >= 2) { s.ledgerBuilt = true; return false; }
    s.ledgerAttempts++;
    const note = s.ledger.length ? `These deliverables are already listed: ${s.ledger.map(d => `${d.kind} ${d.name ?? ''} ${d.to ?? ''}`).join('; ')}. Jev judged the list incomplete: add only the missing ones.` : undefined;
    let raw: Record<string, any> | null;
    const repository = await repositoryStatus(this.tools.root).catch(() => undefined);
    // The design is generated as text (the architect may think first) and
    // parsed leniently: a design cut by the budget keeps its complete items.
    try {
      if (this.bonsai.generateText) {
        const g = await this.generateCode(s, 'ledger' as Route, [ledgerPrompt(s, note, repository)], this.config.designTokens, null, { thinking: this.config.designThinking });
        raw = parseDesign(g.text);
        if (!raw) throw new Error(`The design reply held no JSON object (${g.finish}; ${g.text.length} characters)`);
      } else raw = await this.bonsai.generate(ledgerPrompt(s, note, repository), ledgerSchema, .1, { step: s.step, route: 'ledger' }, this.config.designTokens);
    } catch (e) { await this.store.log('ledger', { step: s.step, error: (e as Error).message }); this.observe({ kind: 'warning', step: s.step, text: `design failed: ${clip((e as Error).message, 200)}` }); s.ledgerBuilt = s.ledgerAttempts >= 2; return false; }
    const design = designFrom(raw); if (design && (!s.design || design.summary.length > s.design.summary.length)) s.design = design;
    const fresh = candidatesFrom(raw).filter(c => !s.ledger.some(d => d.kind === c.kind && d.name === c.name && d.to === c.to && d.from === c.from));
    const candidates = fresh.map((c, i) => ({ ...c, id: `d${s.ledger.length + i + 1}` }));
    if (!candidates.length) { s.ledgerBuilt = true; await this.store.log('ledger', { step: s.step, candidates: [], kept: s.ledger }); return false; }
    let kept: Deliverable[]; let complete = 0;
    if (s.design && candidates.some(c => c.kind === 'create')) {
      // A designed application: each item is judged against the design it came
      // from, one Choice per item, in requests sized for Jev's budget.
      kept = []; s.droppedCandidates ??= [];
      // A manifest or build configuration the repository lacks is part of the
      // design by construction: nothing builds or is verified without it. It
      // is kept, required and created first, and Jev is not asked about it.
      const given = candidates.filter(c => c.kind === 'create' && c.to && configLike(c.to) && !s.knownFiles.includes(c.to));
      for (const c of given) { c.required = 1; kept.push(c); }
      const asked = candidates.filter(c => !given.includes(c));
      for (let i = 0; i < Math.max(1, asked.length); i += 12) {
        const batch = asked.slice(i, i + 12); const last = i + 12 >= asked.length;
        const answers = await this.jev.decide(tierState(s, batch, last ? [...s.ledger, ...candidates] : undefined), tierQuestions(batch, last), { step: s.step, phase: 'ledger' });
        for (const c of batch) {
          const a = answers[`tier_${c.id}`]; const p = a?.type === 'choice' ? a.probabilities : {};
          const tier = a?.type === 'choice' ? a.choice : 'part_of_design';
          c.required = p.part_of_design ?? 0;
          if (tier === 'out_of_scope' && (p.out_of_scope ?? 0) >= .5) { s.droppedCandidates.push(c); continue; }
          if (tier === 'extra') c.optional = true;
          kept.push(c);
        }
        const done = answers.complete?.type === 'noul' ? answers.complete.noul : 0; complete = Math.max(complete, done);
      }
    } else {
      const answers = await this.jev.decide(decisionState(s, { candidateDeliverables: candidates.map(c => ({ id: c.id, kind: c.kind, name: c.name, from: c.from, to: c.to, detail: c.detail })) }), ledgerQuestions(candidates), { step: s.step, phase: 'ledger' });
      kept = candidates.filter(c => {
        const a = answers[`required_${c.id}`]; const p = a?.type === 'noul' ? a.noul : 0; c.required = p;
        const f = answers[`fits_${c.id}`]; const fits = f?.type === 'noul' ? f.noul : 0;
        if (p >= this.config.completeProbability) return true;
        if (fits >= this.config.completeProbability) { c.optional = true; return true; }
        return false;
      });
      complete = answers.complete?.type === 'noul' ? answers.complete.noul : 0;
    }
    s.ledger = [...s.ledger, ...kept];
    s.ledgerComplete = Math.max(s.ledgerComplete, complete);
    // A second design pass is a generation of minutes: it is spent only when
    // Jev reads the list as more likely incomplete than complete (the literal
    // Noul), not whenever the reading falls short of the completion-audit bar.
    s.ledgerBuilt = complete >= .5 || s.ledgerAttempts >= 2;
    await refreshLedger(this.tools.root, s).catch(() => {});
    s.pendingMoves = await this.pendingMoves(s).catch(() => []);
    await this.store.log('ledger', { step: s.step, candidates, kept: s.ledger, complete });
    this.observe({ kind: 'warning', step: s.step, text: `ledger: ${s.ledger.length} deliverable(s) (${s.ledger.map(d => `${d.kind} ${d.name ?? ''}`).join(', ')}); completeness ${complete.toFixed(2)}` });
    await this.evidence(s, 'ledger', { ok: true, text: `Deliverables (classified by Jev): ${s.ledger.map(d => `${d.id} ${d.kind} ${d.name ?? ''}${d.from ? ` from ${d.from}` : ''}${d.to ? ` to ${d.to}` : ''}: ${d.status}`).join('; ') || 'none identified'}` });
    return true;
  }
  // A worker move that sweeps ledger declarations along with ones the ledger
  // never asked for is the wrong range: hand back the exact ranges instead.
  private async moveOutsideLedger(s: Session, args: Record<string, any>): Promise<string | null> {
    const source = ledgerFile(s, args.source) ?? args.source;
    const wanted = s.ledger.filter(d => d.kind === 'move' && d.name && d.from && same(ledgerFile(s, d.from)!, source)).map(d => d.name!);
    if (!wanted.length) return null;
    let text: string; try { text = await readFile(await safePath(this.tools.root, source), 'utf8'); } catch { return null; }
    const decls = await topLevelDeclarations(source, text);
    const inRange = [...decls].filter(([, d]) => d.start >= args.start && d.end <= args.end).map(([n]) => n);
    const inside = inRange.filter(n => wanted.includes(n)); const outside = inRange.filter(n => !wanted.includes(n));
    if (!inside.length || !outside.length) return null;
    const ranges = wanted.flatMap(n => { const d = decls.get(n); return d ? [`${n} lines ${d.start}-${d.end}`] : []; });
    return `The range ${args.start}..${args.end} of ${source} also declares ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ` and ${outside.length - 6} more` : ''}, which the deliverables do not ask to move. Move only the deliverables' declarations: ${ranges.join('; ')}.`;
  }
  // Run a candidate check once: how it actually behaves is the evidence Jev
  // judges. A trial that fails for want of dependencies is an environment fact,
  // not a verdict on the command: install what the manifest implies, once.
  private async trialCheck(s: Session, command: string): Promise<{ code: number | null; timedOut: boolean; output: string }> {
    const run = () => runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', command], this.tools.root, this.config.commandTimeoutMs).then(t => ({ code: t.code, timedOut: t.timedOut, output: clip(t.output, 1200) })).catch(e => ({ code: -1, timedOut: false, output: clip(String((e as Error).message), 300) }));
    let trial = await run();
    // One install per manifest version: a manifest the session rewrites after a
    // failed install earns another attempt.
    const manifests = await Promise.all(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml'].map(f => readFile(join(this.tools.root, f), 'utf8').catch(() => '')));
    const setupKey = hash(manifests.join('\u0000'));
    if (trial.code !== 0 && missingDependencies(trial.output) && (!s.setupDone || s.setupKey !== setupKey)) {
      const dir = command.match(/(?:--dir|-C|--prefix)\s+(\S+)/)?.[1] ?? command.match(/^\s*cd\s+(\S+)/)?.[1] ?? '.';
      const install = await installCommand(this.tools.root, dir);
      if (install && await this.installDependencies(s, install, dir)) trial = await run();
    }
    return trial;
  }
  // A rejection whose unmet items are now done by source facts (the
  // verifications it named ran and passed, wherever the run came from) is
  // answered: the pinned text stops saying the objective is unfinished, and
  // the finish latch opens without a read or an edit.
  private settleFeedback(s: Session): void {
    const f = s.completionFeedback;
    // An item the audit contradicted although the facts already called it done
    // is answered only by an edit and a passing check, never by the same facts.
    if (!f || f.addressed || !f.unmetPending?.length || !f.unmet?.every(id => s.ledger.find(x => x.id === id)?.status === 'done')) return;
    s.completionFeedback = { ...f, addressed: true, awaitingEvidence: false, text: `The completion proposed at step ${f.step} was rejected (${clip(f.text.replace(/^Completion rejected /, ''), 300)}); the deliverables it named are done since. Propose finish again.` };
    s.finishTriedAtCheck = -1;
  }
  // The versions the check found errors in are known wrong: a repair that
  // reproduces one is refused before it lands, so a fix cannot oscillate
  // between two versions the check has already judged.
  private recordFailedVersions(s: Session): void {
    if (!s.lastCheck) return;
    for (const [file, v] of Object.entries(s.lastCheck.summary.byFile)) {
      if (!v.count) continue;
      const path = Object.keys(s.lastCheck.fileHashes ?? {}).find(p => p === file || p.endsWith(`/${file}`) || file.endsWith(`/${p}`));
      const h = path ? s.lastCheck.fileHashes![path] : undefined; if (!path || !h || h === 'unavailable') continue;
      const list = ((s.failedVersions ??= {})[path] ??= []);
      if (!list.includes(h)) { list.push(h); if (list.length > 8) list.shift(); }
    }
  }
  private async manifestKey(): Promise<string> {
    return hash((await Promise.all(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml'].map(f => readFile(join(this.tools.root, f), 'utf8').catch(() => '')))).join('\u0000'));
  }
  // One install per manifest version. A failed install that names a version or a
  // package that does not exist is repaired by code and installed again, at most
  // twice; a failure code cannot name is recorded as fix work for the manifest,
  // and its manifest version is known bad. Returns whether the install passed.
  private async installDependencies(s: Session, install: string, dir: string): Promise<boolean> {
    s.setupDone = true; s.setupKey = await this.manifestKey();
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', install], this.tools.root, Math.max(this.config.commandTimeoutMs, 300000)).catch(e => ({ code: -1, output: String((e as Error).message), truncated: false, timedOut: false }));
      await this.store.log('setup', { step: s.step, command: install, code: r.code, output: clip(r.output, 800) });
      this.observe({ kind: 'warning', step: s.step, text: `setup: ${install} (exit ${r.code})` });
      await this.evidence(s, 'setup', { ok: r.code === 0, text: `Installed dependencies with ${install}: exit ${r.code}\n${clip(r.output, 600)}` });
      s.setupError = r.code === 0 ? null : clip(r.output.split('\n').filter(l => /error|ERR|not found|notarget|E404|ETARGET|EUNSUPPORTED|peer/i.test(l)).slice(0, 6).join(' | ') || r.output, 500);
      if (r.code === 0) { s.checkInferences = 0; return true; }
      const manifest = dir === '.' ? 'package.json' : `${dir.replace(/\/$/, '')}/package.json`;
      try { const list = ((s.failedVersions ??= {})[manifest] ??= []); const h = hash(await readFile(await safePath(this.tools.root, manifest), 'utf8')); if (!list.includes(h)) list.push(h); } catch { /* no manifest */ }
      if (attempt === 2 || !(await this.repairManifest(s, r.output, dir))) return false;
      s.setupKey = await this.manifestKey();
    }
    return false;
  }
  // A manifest rewritten since the install that failed is installed again by
  // code, before any decision: the install is the check of a manifest fix, and
  // it does not depend on the budget for selecting a verification command.
  private async retrySetup(s: Session): Promise<boolean> {
    if (!s.setupError || !s.setupDone || s.setupKey === await this.manifestKey()) return false;
    const install = await installCommand(this.tools.root, '.', true);
    if (!install) return false;
    await this.installDependencies(s, install, '.');
    return true;
  }
  // The latest published version of a package, from the registry; null when
  // the registry cannot answer (offline, or the package does not exist).
  async lookupVersion(name: string): Promise<string | null> {
    const r = await runCommand('npm', ['view', name, 'version'], this.tools.root, 60000).catch(() => null);
    // The version is the line that looks like one: npm's update notice may follow it.
    const v = r && r.code === 0 ? r.output.split('\n').map(l => l.trim()).find(l => /^\d+\.\d+\.\d+/.test(l)) ?? '' : '';
    return v || null;
  }
  // A dependency the registry rejected is repaired in the manifest by code: a
  // version that does not exist becomes the latest that does, a package that
  // does not exist is dropped. Once per package name; the manifest is rewritten
  // as a whole, as a harness edit with its snapshot.
  async repairManifest(s: Session, output: string, dir = '.'): Promise<boolean> {
    const manifest = dir === '.' ? 'package.json' : `${dir.replace(/\/$/, '')}/package.json`;
    const failures = manifestFailures(output).filter(f => !s.autoFixKeys[`manifest:${f.name}`]);
    if (!failures.length) return false;
    let text: string; let pkg: any;
    try { text = await readFile(await safePath(this.tools.root, manifest), 'utf8'); pkg = JSON.parse(text); } catch { return false; }
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter(k => pkg[k] && typeof pkg[k] === 'object');
    const changes: { name: string; from: string; to: string | null }[] = [];
    for (const f of failures) {
      s.autoFixKeys[`manifest:${f.name}`] = `step ${s.step}`;
      // Every section that lists the name: the package manager reads the later one.
      const listed = sections.filter(k => f.name in pkg[k]); if (!listed.length) continue;
      const version = f.kind === 'notarget' ? await this.lookupVersion(f.name) : null;
      for (const section of listed) {
        const from = String(pkg[section][f.name]);
        if (version) pkg[section][f.name] = `^${version}`; else delete pkg[section][f.name];
        changes.push({ name: f.name, from, to: version ? `^${version}` : null });
      }
    }
    if (!changes.length) return false;
    const lines = text.split('\n'); const trailing = lines.length > 1 && lines.at(-1) === ''; const total = trailing ? lines.length - 1 : lines.length;
    const newText = JSON.stringify(pkg, null, 2);
    await this.store.log('auto-manifest', { step: s.step, path: manifest, changes });
    this.observe({ kind: 'warning', step: s.step, text: `manifest: ${changes.map(c => `${c.name} ${c.from} -> ${c.to ?? 'removed'}`).join(', ')}` });
    const result = await this.forced(s, 'replace_lines', { path: manifest, expectedHash: hash(text), edits: [{ start: 1, end: total, newText, prepend: '' }], harness: true }, 'auto-manifest');
    return result.ok;
  }
  // No configured check: select, do not generate. Code enumerates the commands
  // the repository offers (package scripts, language tools), tries them, and
  // Jev chooses among them or none; the worker proposes a command only when
  // nothing is enumerable.
  private async inferCheck(s: Session): Promise<boolean> {
    s.checkInferences++; s.checkInferredFor = s.writes.length;
    const repository = await repositoryStatus(this.tools.root);
    let cands = await checkCandidates(this.tools.root, repository);
    if (!cands.length) {
      let raw: Record<string, any>;
      try { raw = await this.bonsai.generate(checkPrompt(s, repository), checkSchema, .1, { step: s.step, route: 'check' }); } catch (e) { await this.store.log('check-inferred', { step: s.step, error: (e as Error).message }); return false; }
      const command = typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!command) { await this.store.log('check-inferred', { step: s.step, command: '', accepted: false }); return false; }
      cands = [{ command, source: `proposed by the worker: ${clip(String(raw.rationale ?? ''), 200)}` }];
    }
    const tried: { command: string; source: string; unusable: string | null; trial: ReturnType<typeof trialFacts> }[] = [];
    for (const c of cands) {
      const unusable = await checkUnusable(this.tools.root, c.command);
      if (unusable) { tried.push({ ...c, unusable, trial: null }); continue; }
      tried.push({ ...c, unusable: null, trial: trialFacts(await this.trialCheck(s, c.command)) });
      // Two commands that actually ran are enough to choose between.
      if (tried.filter(t => t.trial?.ran).length >= 2) break;
    }
    // Candidates that failed to start or did not terminate are facts, not options.
    const usable = tried.filter(t => !t.unusable && t.trial?.ran);
    if (!usable.length) { await this.store.log('check-inferred', { step: s.step, candidates: tried, accepted: false }); this.observe({ kind: 'warning', step: s.step, text: `no verification candidate ran: ${tried.map(t => `${t.command} (${t.unusable ?? t.trial?.outcome})`).join('; ')}` }); return false; }
    let chosen: typeof usable[number] | undefined; let probabilities: Record<string, number> = {}; let choice: string | null = null;
    if (usable.length === 1 && usable[0]!.trial && (usable[0]!.trial.exitCode === 0 || usable[0]!.trial.errorsListed > 0)) {
      // One candidate that ran and either passed or listed errors in the code: nothing to judge.
      chosen = usable[0]; choice = chosen!.command;
    } else {
      // A small, literal state: what the deliverables are and how each candidate behaved.
      const state = { objective: clip(s.objective, 400), deliverables: s.ledger.slice(0, 12).map(d => `${d.kind} ${d.name ?? ''}${d.to ? ` in ${d.to}` : ''}`), changedFiles: s.writes.slice(-12),
        candidates: Object.fromEntries(usable.map(t => [t.command, { command: t.command, source: t.source, outcome: t.trial!.outcome, exitCode: t.trial!.exitCode, errorsListed: t.trial!.errorsListed, outputHead: t.trial!.outputHead }])) };
      const answers = await this.jev.decide(state, checkSelectionQuestions(usable), { step: s.step, phase: 'check-selection' });
      choice = confidentChoice(answers.check, this.config);
      // Two valid candidates split the probability: the code preference decides typecheck > build > test.
      if (!choice && answers.check?.type === 'choice' && (answers.check.probabilities.none ?? 0) < .3) choice = usable[0]!.command;
      chosen = choice && choice !== 'none' ? usable.find(t => t.command === choice) : undefined;
      probabilities = answers.check?.type === 'choice' ? answers.check.probabilities : {};
    }
    await this.store.log('check-inferred', { step: s.step, candidates: tried, choice, probabilities, accepted: Boolean(chosen), command: chosen?.command });
    this.observe({ kind: 'warning', step: s.step, text: chosen ? `verification selected: ${chosen.command}${choice && choice in probabilities ? ` (Jev ${(probabilities[choice] ?? 0).toFixed(2)})` : ' (the only candidate that ran)'}` : `no verification selected among ${usable.map(t => t.command).join(', ')} (${choice ?? 'uncertain'})` });
    if (!chosen) return false;
    // From here on this command is the verification, exactly as a configured one would be.
    s.lastCheckCommand = chosen.command; s.pendingCheck = true; this.tools.config.checkCommand = chosen.command;
    return true;
  }
  // The contract a file is written against: the design, its dependencies'
  // exact exports, who imports it, and the packages it may use.
  private async createTarget(s: Session, path: string, d: Deliverable, problems?: string[]): Promise<CreateTarget> {
    const { contracts, importers } = await contractsFor(this.tools.root, s, d);
    const packages = await installedPackages(this.tools.root).catch(() => [] as string[]);
    return { path, deliverable: d, contracts, importers, packages, ...(problems?.length ? { problems } : {}) };
  }
  // Code is generated as code: a raw completion continued across requests
  // until the model stops. Without a raw path the same prompt runs under a
  // one-field schema. The result is the unwrapped code, never refused for shape.
  private async generateCode(s: Session, route: Route, prompts: Message[][], budget: number, fence: string | null, options: { thinking?: boolean } = {}): Promise<{ code: string; finish: 'stop' | 'length' | 'repetition'; text: string }> {
    // The prompt is shrunk before it is refused, never swapped for a generic one.
    let prompt = prompts[0]!; let counted = await this.bonsai.count(prompt);
    for (const smaller of prompts.slice(1)) { if (counted.tokens <= this.config.workingTokens) break; prompt = smaller; counted = await this.bonsai.count(prompt); }
    if (counted.tokens > this.config.workingTokens) throw new Error(`The ${route} prompt (${counted.tokens} tokens) exceeds the working budget; reduce the design or the contracts`);
    s.lastPromptTokens = counted.tokens;
    this.observe({ kind: 'route', step: s.step, route, tokens: counted.tokens, entries: s.entries.length });
    await this.logPrompt(s, route, prompt, counted.tokens, 1);
    if (this.bonsai.generateText) {
      const g = await this.bonsai.generateText(prompt, { budgetTokens: budget, context: { step: s.step, route }, fence, thinking: options.thinking });
      this.observe({ kind: 'generated', step: s.step, route, meta: g.meta, args: { chars: g.text.length, finish: g.finish, continuations: g.meta.continuations ?? 0 } });
      // With the fence prefilled the reply is the code itself; a reply that
      // opens its own fence anyway (the same backtick run or a longer one) is
      // unwrapped. A shorter run is content: a code block inside a document.
      const run = fence?.match(/^`+/)?.[0].length ?? 3;
      const opened = g.text.match(/^\s*(`{3,})[^\n]*\n/);
      const code = fence && !options.thinking ? (opened && opened[1]!.length >= run ? extractCode(g.text) : g.text.replace(/\s+$/, '') + '\n') : extractCode(g.text);
      return { code, finish: g.finish, text: g.text };
    }
    const raw = await this.bonsai.generate(prompt, { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }, .2, { step: s.step, route }, budget);
    this.observe({ kind: 'generated', step: s.step, route, meta: this.bonsai.lastMeta ?? null, args: { chars: String(raw.content ?? '').length, finish: 'stop' } });
    return { code: extractCode(String(raw.content ?? '')), finish: 'stop', text: String(raw.content ?? '') };
  }
  // Create a file from its contract, then execute the creation with the same
  // bookkeeping as any edit. The content is validated after it lands: a parse
  // problem or a missing promised export queues a repair, an unplanned import
  // derives a deliverable. Failures count against the deliverable, never
  // against a route: three, and the item is set aside with its reason.
  private async createFile(s: Session, target: CreateTarget, kind: string): Promise<void> {
    const d = target.deliverable;
    try {
      const { code, finish } = await this.generateCode(s, 'create_file', [createFileMessages(s, target), createFileMessages(s, target, 1)], this.config.createTokens, fenceFor(target.path));
      if (finish !== 'stop') this.observe({ kind: 'warning', step: s.step, text: `${target.path}: the content ${finish === 'length' ? `reached the ${this.config.createTokens}-token budget` : 'started repeating itself and was cut'}; the parser reports where it ends` });
      await this.forced(s, 'create_file', { path: target.path, content: code }, kind);
      if (!s.lastResultOk) throw new Error(s.entries.at(-1)?.text ?? 'create_file failed');
      // The contract is checked where it can be: every export the design
      // promised exists, the keyword added mechanically where the declaration
      // is there, the rest queued for the repair with the parse errors.
      const pending = s.pendingRepairs.find(r => r.path === target.path);
      const errors = pending ? (await missingExports(target.path, code, d.exports ?? []).catch(() => [] as string[])).map(n => `contract: ${target.path} must export ${n === 'default' ? 'a default export' : n} (${target.importers.map(i => i.path).join(', ') || 'the design'} imports it)`)
        : await this.contractRepair(s, target.path, code, d.exports ?? [], `${target.importers.map(i => i.path).join(', ') || 'the design'} imports it`);
      if (errors.length) { if (pending) pending.errors.push(...errors); else s.pendingRepairs.push({ path: target.path, errors, attempts: 0 }); }
    } catch (e) {
      d.attempts = (d.attempts ?? 0) + 1;
      if (d.attempts >= 3) { d.unresolvable = true; d.setAside = true; d.note = `set aside after ${d.attempts} failed attempts: ${clip((e as Error).message, 160)}`; }
      throw e;
    }
  }
  // A repair is a region rewrite: code chooses the region (the whole file when
  // small, else the statements around the reported lines), the worker returns
  // the corrected region as code, and it is applied as a replace_lines edit,
  // judged by the parser before it lands and by the check afterwards.
  private async rewriteRegion(s: Session, path: string, errors: string[], note: string, kind: string): Promise<boolean> {
    let text: string; try { text = await readFile(await safePath(this.tools.root, path), 'utf8'); } catch (e) { throw new Error(`${path} cannot be read for repair: ${(e as Error).message}`); }
    const lines = text.split('\n'); const trailing = lines.length > 1 && lines.at(-1) === ''; const total = trailing ? lines.length - 1 : lines.length;
    const numbers = errors.flatMap(e => [...e.matchAll(/(?:\bline\s+(\d+))|(?:\((\d+),\d+\))|(?::(\d+):\d+)/g)].map(m => Number(m[1] ?? m[2] ?? m[3]))).filter(n => n >= 1 && n <= total);
    let start = 1; let end = total;
    if (total > 200 && numbers.length) ({ start, end } = await statementBounds(path, text, Math.max(1, Math.min(...numbers) - 25), Math.min(total, Math.max(...numbers) + 25)));
    if (end - start + 1 > 400 && numbers.length) { start = Math.max(1, Math.min(...numbers) - 60); end = Math.min(total, Math.max(...numbers) + 60); }
    const region = lines.slice(start - 1, end).join('\n');
    const whole = start === 1 && end === total;
    const before = lines.slice(Math.max(0, start - 13), start - 1).join('\n'); const after = lines.slice(end, Math.min(total, end + 12)).join('\n');
    // The previous attempt's refusal, if it concerned this file, tells the worker what not to repeat.
    const previous = s.lastError && s.lastError.includes(path) && /rewrite of /.test(s.lastError) ? [`previous attempt: ${clip(s.lastError.replace(/^No action executed: /, ''), 300)}`] : [];
    // The exported declarations of the modules the file imports: a call site is
    // repaired against the callee as it is, not against a guess of it.
    const imports = kind === 'decided-fix' ? await importContracts(this.tools.root, path, text, errors).catch(() => []) : [];
    // The source line each error points at and, for a call or a JSX element
    // there, the callee's declaration from the contracts: the mismatch is then
    // stated, not left to be inferred from two places in the prompt.
    const declared = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
    const sites = errors.slice(0, 4).map(e => { const m = e.match(/(?:\((\d+),(\d+)\))|(?::(\d+):(\d+))/); if (!m) return null; const line = Number(m[1] ?? m[3]); const col = Number(m[2] ?? m[4]); const src = lines[line - 1]; if (!src) return null;
      const seg = src.slice(Math.max(0, col - 1)); const name = seg.match(/^<\s*([A-Za-z_$][\w$.]*)/)?.[1] ?? seg.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? seg.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      const callee = name ? imports.flatMap(c => c.exports).find(x => { const d = x.match(declared)?.[1]; return d === name || (name === 'default' && /^export default/.test(x)); }) ?? (name ? imports.flatMap(c => c.exports).find(x => /^export default function\b/.test(x) && imports.some(c => c.exports.includes(x) && c.importPath.split('/').pop() === name)) : undefined) : undefined;
      return { line, text: clip(src.trim(), 160), ...(callee ? { callee } : {}) }; }).filter((x): x is { line: number; text: string; callee?: string } => x !== null);
    const t: RegionTarget = { path, start, end, totalLines: total, region: whole ? text : region, before, after, errors: [...errors.slice(0, 8), ...previous.filter(p => !errors.some(e => e.startsWith('previous attempt:')))], note, ...(imports.length ? { imports } : {}), ...(sites.length ? { sites } : {}) };
    const { code } = await this.generateCode(s, 'replace_lines', [rewriteRegionMessages(s, t)], this.config.createTokens, fenceFor(path));
    // A reply that returned the whole file for a region that did not start at
    // line 1 is applied as the whole file (it begins like the file, ends like
    // the file, and is at least as long); a reply that repeated the context
    // lines is trimmed.
    const first = (lines[0] ?? '').trim(); const lastLine = [...lines.slice(0, total)].reverse().find(l => l.trim())?.trim() ?? '';
    const codeLines = code.replace(/\n$/, '').split('\n');
    const looksWhole = !whole && start > 1 && first.length > 3 && codeLines[0]!.trim() === first && codeLines.length >= total * .8 && (codeLines.at(-1)?.trim() ?? '') === lastLine;
    const newText = (whole || looksWhole ? code : trimContext(code, before, after)).replace(/\n$/, '');
    const [from, to] = looksWhole ? [1, total] : [start, end];
    if (newText === lines.slice(from - 1, to).join('\n')) throw new Error(`The rewrite of ${path} lines ${from}..${to} returned the region unchanged; the errors remain: ${errors.slice(0, 3).join('; ')}`);
    // Validated before it lands: a repair must leave the file parsing, not
    // merely move the error. (Free-path edits keep the tolerant rule.)
    const spliced = [...lines.slice(0, from - 1), ...newText.split('\n'), ...lines.slice(to)].join('\n');
    const problems = await syntaxErrors(path, spliced);
    if (problems.length) throw new Error(`The rewrite of ${path} lines ${from}..${to} would still not parse: ${problems.join('; ')}`);
    // A version the check already found errors in is known wrong: the same
    // content would fail the same way, so it is not landed or checked again.
    if ((s.failedVersions?.[path] ?? []).includes(hash(spliced))) throw new Error(`The rewrite of ${path} lines ${from}..${to} reproduces a version of the file the check already reported errors in; the errors listed are real, so produce a different fix that addresses them`);
    // A rewrite that ends early or drops a declaration loses what other files
    // import: an export the file had must still be there, or the content is wrong.
    const had = await exportedNames(path, text); const now = new Set(await exportedNames(path, spliced));
    const lost = had.filter(n => !now.has(n));
    if (lost.length) throw new Error(`The rewrite of ${path} dropped the export${lost.length > 1 ? 's' : ''} ${lost.map(n => n === 'default' ? 'default' : n).join(', ')}, which other files import; return the complete corrected ${whole || looksWhole ? 'file' : 'region'} with ${lost.length > 1 ? 'them' : 'it'} kept`);
    // Content that was rolled back is known-bad: the same rewrite is not applied twice.
    const args = { path, expectedHash: hash(text), edits: [{ start: from, end: to, newText, prepend: '' }], harness: true };
    const identity = hash(JSON.stringify({ route: 'replace_lines', args: { ...args, expectedHash: undefined, destinationHash: undefined } }));
    const bad = s.rejectedEdits.find(r => r.identity === identity);
    if (bad) throw new Error(`The rewrite of ${path} lines ${from}..${to} is the one rolled back at step ${bad.undoneAt} (${clip(bad.reason, 200)}); produce a different fix`);
    await this.forced(s, 'replace_lines', args, kind);
    // A rewrite must keep the file's contract: an export the design promised
    // that the rewrite dropped is repaired next, at most twice per file.
    if (s.lastResultOk && kind !== 'repair') {
      const d = s.ledger.find(x => x.kind === 'create' && x.to && (x.to === path || path.endsWith(`/${x.to}`) || x.to.endsWith(`/${path}`)) && x.exports?.length);
      const key = `contract:${path}`; const tries = s.fixAttempts?.[key] ?? 0;
      if (d && tries < 2 && !s.pendingRepairs.some(r => r.path === path)) {
        const missing = await this.contractRepair(s, path, spliced, d.exports!, 'other files import it');
        if (missing.length) { (s.fixAttempts ??= {})[key] = tries + 1; s.pendingRepairs.push({ path, errors: missing, attempts: 0 }); }
      }
    }
    return s.lastResultOk;
  }
  // A promised export that the file declares without the keyword is a
  // mechanical fix (prepend "export "), never a generation; only a name the
  // file does not declare at all needs the worker. Returns the errors that remain.
  private async contractRepair(s: Session, path: string, text: string, declared: string[], why: string): Promise<string[]> {
    const missing = await missingExports(path, text, declared).catch(() => [] as string[]);
    if (!missing.length) return [];
    const decls = await topLevelDeclarations(path, text).catch(() => new Map<string, { start: number; end: number; kind: string; exported: boolean }>());
    const lines = text.split('\n');
    const edits: { start: number; end: number; newText: string; prepend: string }[] = [];
    for (const n of missing) {
      const d = n === 'default' ? undefined : decls.get(n);
      if (d && !d.exported && /^(declare\s+)?(abstract\s+)?(type|interface|const|let|var|function|async\s+function|class|enum|namespace)\b/.test(lines[d.start - 1] ?? '') && !edits.some(e => e.start === d.start)) edits.push({ start: d.start, end: d.start, newText: '', prepend: 'export ' });
    }
    if (edits.length) {
      await this.forced(s, 'replace_lines', { path, expectedHash: hash(text), edits, harness: true }, 'auto-export');
      if (s.lastResultOk) { const now = await readFile(await safePath(this.tools.root, path), 'utf8').catch(() => text); return (await missingExports(path, now, declared).catch(() => [] as string[])).map(n => `contract: ${path} must export ${n === 'default' ? 'a default export' : n} (${why})`); }
    }
    return missing.map(n => `contract: ${path} must export ${n === 'default' ? 'a default export' : n} (${why})`);
  }
  // Harness-owned: a created file that does not parse or lacks a promised
  // export is rewritten before any decision, at most twice; after that the
  // check's errors carry it.
  private async repairPending(s: Session): Promise<boolean> {
    const r = s.pendingRepairs[0]; if (!r) return false;
    if (r.attempts >= 2) { s.pendingRepairs.shift(); return false; }
    r.attempts++;
    try {
      await this.rewriteRegion(s, r.path, r.errors, `Repair ${r.path}: the errors listed were reported by the parser or by the file's contract; make the file parse, provide what the contract requires, and keep its behaviour.`, 'repair');
      if (!s.lastResultOk) { r.errors = [clip(s.entries.at(-1)?.text ?? '', 400)]; return true; }
      const after = await syntaxErrors(r.path, await readFile(await safePath(this.tools.root, r.path), 'utf8')).catch(() => [] as string[]);
      if (after.length) r.errors = after; else s.pendingRepairs = s.pendingRepairs.filter(x => x !== r);
    } catch (e) {
      r.errors = [...r.errors.filter(x => !x.startsWith('previous attempt:')), `previous attempt: ${clip((e as Error).message, 300)}`];
      this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message });
      await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` });
    }
    return true;
  }
  private async forcedMove(s: Session, mv: { name: string; source: string; start: number; end: number; destination: string }): Promise<boolean> {
    const key = hash(JSON.stringify({ m: mv }));
    if (s.autoFixKeys[`move:${mv.name}`] === key) return false;
    s.autoFixKeys[`move:${mv.name}`] = key;
    let source: string; let into: string | null = null;
    try { source = await readFile(await safePath(this.tools.root, mv.source), 'utf8'); } catch { return false; }
    try { into = await readFile(await safePath(this.tools.root, mv.destination), 'utf8'); } catch { into = null; }
    const args = { source: mv.source, expectedHash: hash(source), start: mv.start, end: mv.end, destination: mv.destination, destinationHash: into === null ? 'new' : hash(into), replacement: '', prefix: '' };
    const identity = hash(JSON.stringify({ route: 'move_lines', args: { ...args, expectedHash: undefined, destinationHash: undefined } }));
    if (s.rejectedEdits.some(r => r.identity === identity)) return false;
    await this.forced(s, 'move_lines', args, 'auto-move');
    return true;
  }
  // The packages the last check could not find, imported by files this session
  // wrote, are added to the manifest and installed with one command, once per
  // package; the check then runs again. Packages only configuration imports
  // are development dependencies.
  private async installMissing(s: Session): Promise<boolean> {
    if (!s.lastCheck || s.lastCheck.ok || !s.writes.length) return false;
    try { await stat(await safePath(this.tools.root, 'package.json')); } catch { return false; }
    const texts: Record<string, string> = {};
    for (const p of s.writes) if (/\.[cm]?[jt]sx?$/.test(p)) { try { texts[p] = await readFile(await safePath(this.tools.root, p), 'utf8'); } catch { /* removed */ } }
    const found = missingPackages(s.lastCheck.summary, texts, await installedPackages(this.tools.root)).filter(m => !s.autoFixKeys[`install:${m.name}`]);
    if (!found.length) return false;
    for (const m of found) s.autoFixKeys[`install:${m.name}`] = `step ${s.step}`;
    const dev = found.filter(m => m.importers.every(configLike)); const prod = found.filter(m => !m.importers.every(configLike));
    const commands = [prod.length ? await addPackagesCommand(this.tools.root, prod.map(m => m.name), false) : '', dev.length ? await addPackagesCommand(this.tools.root, dev.map(m => m.name), true) : ''].filter(Boolean);
    await this.forced(s, 'bash', { command: commands.join(' && '), purpose: `Install ${found.map(m => m.name).join(', ')}: imported by ${[...new Set(found.flatMap(m => m.importers))].join(', ')} and not declared in package.json.` }, 'auto-install');
    // The manager rewrote the manifest: the session's view of it follows.
    try { s.hashes['package.json'] = hash(await readFile(await safePath(this.tools.root, 'package.json'), 'utf8')); } catch { /* unchanged */ }
    s.pendingCheck = Boolean(s.lastCheckCommand);
    return true;
  }
  private async autoFix(s: Session): Promise<boolean> {
    for (const mv of s.pendingMoves) if (await this.forcedMove(s, mv)) return true;
    // Only errors reported in files this session edits are the harness's to fix;
    // a failing baseline in untouched files is context, not a work order.
    const own = s.missingNames.filter(n => s.writes.some(w => w === n.inFile || w.endsWith(`/${n.inFile}`) || n.inFile.endsWith(`/${w}`)));
    const fixes = compactNames(s, 60, own);
    // A deliverable the destination needs and the source still declares is moved
    // first: the extraction the objective asked for, judged by the check that follows.
    for (const mv of fixes.moveDeclarations) if (await this.forcedMove(s, { ...mv, destination: mv.into })) return true;
    // One file per step, so the check runs between files and each fix is judged alone.
    for (const file of new Set([...Object.keys(fixes.addImports), ...Object.keys(fixes.addExportAtLines), ...Object.keys(fixes.removeImports), ...Object.keys(fixes.aliasImports), ...Object.keys(fixes.respecImports)])) {
      // Export fixes land in the declaring file, which may be one the session never
      // touched; those stay listed for the worker but are not applied unasked.
      if (!s.writes.some(w => w === file || w.endsWith(`/${file}`) || file.endsWith(`/${w}`))) continue;
      const key = hash(JSON.stringify({ i: fixes.addImports[file] ?? [], e: fixes.addExportAtLines[file] ?? [], r: fixes.removeImports[file] ?? [], a: fixes.aliasImports[file] ?? [], s: fixes.respecImports[file] ?? [] }));
      if (s.autoFixKeys[file] === key) continue;
      s.autoFixKeys[file] = key;
      let text: string;
      try { text = await readFile(await safePath(this.tools.root, file), 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      const edits: { start: number; end: number; newText: string; prepend: string }[] = [];
      for (const line of fixes.addExportAtLines[file] ?? []) {
        const l = lines[line - 1] ?? '';
        if (/^export\b/.test(l) || !/^(declare\s+)?(abstract\s+)?(type|interface|const|let|var|function|async\s+function|class|enum|namespace)\b/.test(l)) continue;
        edits.push({ start: line, end: line, newText: '', prepend: 'export ' });
      }
      const norm = (l: string) => l.trim().replace(/'/g, '"').replace(/;$/, '');
      const wanted = (fixes.addImports[file] ?? []).filter(imp => !lines.some(x => norm(x) === norm(imp)));
      if (wanted.length) {
        const start = await importInsertLine(file, text);
        edits.push({ start, end: start - 1, newText: wanted.join('\n'), prepend: '' });
      }
      if (fixes.removeImports[file]?.length) edits.push(...await removeImportBindings(file, text, fixes.removeImports[file]!, fixes.removeImportLines[file] ?? {}));
      for (const al of fixes.aliasImports[file] ?? []) { const e = await aliasImportBinding(file, text, al.name, al.actual, al.line); if (e && !edits.some(x => x.start === e.start)) edits.push(e); }
      // A module specifier that resolves nowhere is rewritten in place on its import line.
      for (const rs of fixes.respecImports[file] ?? []) {
        const at = lines.findIndex((l, i) => Math.abs(i + 1 - rs.line) <= 6 && /^\s*(import|export)\b/.test(l) && l.includes(`'${rs.from}'`) || l.includes(`"${rs.from}"`)) + 1;
        if (at > 0 && !edits.some(x => x.start === at)) edits.push({ start: at, end: at, newText: lines[at - 1]!.replace(`'${rs.from}'`, `'${rs.to}'`).replace(`"${rs.from}"`, `"${rs.to}"`), prepend: '' });
      }
      if (!edits.length) continue;
      // An identical fix already rolled back is not tried again.
      const identity = hash(JSON.stringify({ route: 'replace_lines', args: { path: file, edits, expectedHash: undefined, destinationHash: undefined } }));
      if (s.rejectedEdits.some(r => r.identity === identity)) continue;
      await this.forced(s, 'replace_lines', { path: file, expectedHash: hash(text), edits }, 'auto-fix');
      return true;
    }
    return false;
  }
  // The lines a failing check names in the edited files, read by the harness so
  // the worker never has to choose a range or spend a step on it.
  private focusRegions(s: Session): { path: string; start: number; end: number }[] {
    if (!s.lastCheck || s.lastCheck.ok) return [];
    const regions: { path: string; start: number; end: number }[] = [];
    for (const [file, v] of Object.entries(s.lastCheck.summary.byFile)) {
      const path = s.writes.find(w => w.endsWith(file) || file.endsWith(w));
      if (!path || !v.lines.length) continue;
      const line = v.lines[0]!; const start = Math.max(1, line - 8); const end = line + 12;
      const cov = s.coverage[path];
      const covered = Boolean(cov && cov.ranges.some(([a, b]) => a <= start && b >= Math.min(end, cov.total)) && s.readHashes[path] === s.hashes[path]);
      if (!covered) regions.push({ path, start, end });
      if (regions.length === 3) break;
    }
    return regions;
  }
  // Roll the files edited since the previous check back to their pre-edit content.
  async undo(s: Session, files: Record<string, string>, reason: string): Promise<void> {
    const hashes: Record<string, string> = {}; const restored: string[] = []; const removed: string[] = [];
    for (const [path, artifact] of Object.entries(files)) {
      if (artifact === '@new') {
        // The transaction created this file: rolling back means it must not exist.
        await rm(await safePath(this.tools.root, path, true), { force: true });
        removed.push(path);
        continue;
      }
      const text = await readFile(await safePath(this.store.artifacts, artifact.replace(/^@artifact\//, '')), 'utf8');
      await writeFile(await safePath(this.tools.root, path, true), text);
      hashes[path] = hash(text); restored.push(path);
    }
    const what = [restored.length ? `reverted ${restored.join(', ')} to the content before the edits` : '', removed.length ? `removed ${removed.join(', ')}, which those edits created` : ''].filter(Boolean).join(' and ');
    // The edits just reverted are now known-bad: the same edit content will not
    // be accepted again. A file creation is never among them.
    const rejected = s.transaction.filter(t => t.route !== 'create_file' && (t.paths.some(p => p in files) || !t.paths.length)).map(t => ({ ...t, undoneAt: s.step, reason }));
    s.editEvidence = s.editEvidence.filter(e => !rejected.some(r => r.step === e.step));
    s.rejectedEdits = [...s.rejectedEdits, ...rejected].slice(-20);
    // A decided fix the check rejected counts against the file version it was
    // generated from, like a refused one: after three, the fix is not offered
    // again for that version, and the errors stay work for another route.
    for (const r of rejected) if (r.kind === 'decided-fix') for (const p of r.paths) if (hashes[p]) { const k = `${p}@${hashes[p]}`; (s.fixAttempts ??= {})[k] = (s.fixAttempts[k] ?? 0) + 1; }
    s.transaction = [];
    await this.evidence(s, 'undo', { ok: true, changed: [...restored, ...removed], hashes, text: `Rolled back: ${what} made after the check at step ${s.previousCheck?.step ?? 'start'}, because the check at step ${s.lastCheck?.step} was worse (${reason}). Those exact edits are now rejected and will not run again; make a different, smaller change.` });
    // Restored content counts as read only if it was read at that hash (a write
    // needs no prior read, so not every restored version was). Reads of it that
    // the rolled-back edit flagged describe the file again.
    for (const [path, h] of Object.entries(hashes)) {
      const cov = s.coverageByHash[`${path}@${h}`];
      if (cov) { s.readHashes[path] = h; s.coverage[path] = cov; }
    }
    // A removed file is nothing the session wrote or read any more.
    for (const path of removed) { delete s.hashes[path]; delete s.readHashes[path]; delete s.coverage[path]; delete s.writeSteps[path]; s.writes = s.writes.filter(w => w !== path); }
    for (const e of s.entries) {
      if (e.kind !== 'read_files' || !e.stale?.startsWith('edited at step')) continue;
      const headers = [...e.text.matchAll(/(?:^|\n\n)(\S+) sha256=(\w+) /g)];
      if (headers.length && headers.every(m => s.hashes[m[1]!] === m[2])) { e.stale = undefined; e.relevance = .5; }
    }
    await this.store.log('undo', { step: s.step, files, rejected });
  }
  async run(s: Session): Promise<Session> {
    s.status = 'running'; s.stopReason = '';
    // What was already modified or untracked before the first step is not this session's change.
    if (s.baselineStatus === null) s.baselineStatus = await repositoryStatus(this.tools.root).then(r => r.git ? r.changed : []).catch(() => []);
    // A declared check is the verification: baseline it before any edit.
    if (this.config.checkCommand) {
      // A check that cannot run here (another repository's directory, a tool
      // not installed) is dropped; verification is then inferred from this one.
      const unusable = await checkUnusable(this.tools.root, this.config.checkCommand);
      if (unusable) {
        const text = `The configured check "${this.config.checkCommand}" cannot run here: ${unusable}. It is ignored for this session; verification will be inferred from the repository.`;
        this.observe({ kind: 'warning', step: s.step, text }); await this.store.log('check-unusable', { step: s.step, command: this.config.checkCommand, reason: unusable });
        this.config.checkCommand = ''; this.tools.config.checkCommand = '';
        s.lastCheckCommand = null; s.pendingCheck = false;
      } else {
        s.lastCheckCommand = this.config.checkCommand; if (!s.lastCheck) s.pendingCheck = true;
        const advice = await checkAdvice(this.tools.root, this.config.checkCommand);
        if (advice) { this.observe({ kind: 'warning', step: s.step, text: advice }); await this.store.log('warning', { step: s.step, text: advice }); }
      }
    } else if (s.lastCheckCommand) {
      // The check this session selected is the verification of record on resume
      // too: no other command a worker runs is mistaken for it.
      this.tools.config.checkCommand = s.lastCheckCommand;
    }
    const endStep = s.step + this.config.maxSteps;
    let generationFailures = 0;
    try {
      for (; s.step < endStep;) {
        s.step++; this.current = s.step;
        if (s.phase === 'inspect' && s.inspectionCount >= 3) s.phase = 'implement';
        this.observe({ kind: 'step', step: s.step, phase: s.phase, maxStep: endStep });
        // Harness-owned transaction cycle: roll back an objectively worse edit,
        // and verify after every edit, before any model is consulted.
        if (s.autoUndo) {
          const { files, reason } = s.autoUndo; s.autoUndo = null;
          this.observe({ kind: 'undo', step: s.step, files: Object.keys(files) });
          await this.undo(s, files, reason);
          s.pendingCheck = Boolean(s.lastCheckCommand);
          await this.store.save(s);
          continue;
        }
        this.settleFeedback(s);
        // A created file that does not parse, or lacks a promised export, is
        // repaired before it is checked: cheaper than a check, a decision and a fix.
        if (s.pendingRepairs.length && this.config.allowWrite && await this.repairPending(s)) { await this.store.save(s); continue; }
        // A manifest rewritten since a failed install is installed again by code.
        if (this.config.allowBash && await this.retrySetup(s)) { await this.store.save(s); continue; }
        // A package a written file imports and the manifest lacks is installed
        // by code: a mechanical repair, never a manifest edit to generate.
        if (this.config.allowBash && this.config.allowWrite && await this.installMissing(s)) { await this.store.save(s); continue; }
        if (s.pendingCheck && s.lastCheckCommand && this.config.allowBash) {
          s.pendingCheck = false;
          await this.forced(s, 'bash', { command: s.lastCheckCommand, purpose: 'Verification after the last edit; re-running the check command.' }, 'auto-check');
          await this.store.save(s);
          continue;
        }
        // Verification is selected once something exists to verify, and tried
        // again only when a manifest or configuration file changed since the
        // last trial: that, not the count of edits, is what makes a build behave differently.
        if (!s.lastCheckCommand && this.config.allowBash && s.writes.length && s.checkInferences < 6) {
          // The trial is repeated when configuration changed, and every few
          // files otherwise: a build with no inputs behaves differently once it has some.
          const key = hash(JSON.stringify([s.writes.filter(configLike).map(p => [p, s.hashes[p] ?? '']), Math.floor(s.writes.length / 4)]));
          if (key !== s.checkTrialKey) { s.checkTrialKey = key; if (await this.inferCheck(s)) { await this.store.save(s); continue; } }
        }
        if ((s.pendingMoves.length || (s.lastCheck && !s.lastCheck.ok)) && this.config.allowWrite && await this.autoFix(s)) { await this.store.save(s); continue; }
        // Without a ledger the worker edits by line number from a read; with one,
        // a fix is a region rewrite from text code already holds, so no read.
        if (s.lastCheck && !s.lastCheck.ok && s.focusReadAt !== s.lastCheck.step && !s.ledger.length) {
          s.focusReadAt = s.lastCheck.step;
          const regions = this.focusRegions(s);
          if (regions.length) { await this.forced(s, 'read_files', { files: regions }, 'auto-read'); await this.store.save(s); continue; }
        }
        const phase: Phase = s.phase;
        if (!s.focus) {
          const pending = s.tasks.filter(t => t.status === 'pending');
          if (pending.length === 1) s.focus = pending[0]!.id;
          if (pending.length > 1) {
            const result = await this.jev.decide({ objective: s.objective, tasks: pending }, {
              focus: { type: 'choice', instructions: 'Which unfinished task should be worked on next, considering prerequisites?',
                criteria: Object.fromEntries(pending.map(t => [t.id, t.description])) },
            }, { step: s.step, phase: 'task-selection' });
            s.focus = confidentChoice(result.focus, this.config);
            if (!s.focus) throw new Error('Jev is uncertain which task to work on; clarify task dependencies');
          }
        }
        if (this.config.ledger && !s.ledgerBuilt && await this.buildLedger(s)) { await this.store.save(s); continue; }
        // Jev decides the step from a small task record and code-enumerated actions.
        // Verification, rollback, resolved fixes and ledger moves never reach it: code owns those.
        const readyNow = readyToFinish(s);
        let route: Route | null = null; let harnessNote: string | undefined; let needsUser: number | null = null;
        let target: { path: string; start: number; end: number } | null = null; let decidedDeliverable: Deliverable | null = null;
        // A decided edit's failure counts against its deliverable, never against a route.
        const chargeDeliverable = (why: string) => { if (!decidedDeliverable) return; decidedDeliverable.attempts = (decidedDeliverable.attempts ?? 0) + 1; if (decidedDeliverable.attempts >= 3) { decidedDeliverable.unresolvable = true; decidedDeliverable.note = `set aside after ${decidedDeliverable.attempts} failed attempts: ${clip(why, 160)}`; } };
        const cands = this.config.ledger ? candidates(s, this.config, readyNow) : [];
        if (cands.length > 2) {
          const record = taskRecord(s); const stepQ = stepQuestions(cands);
          const t0 = performance.now();
          const stepAnswers = await this.jev.decide(record, stepQ, { step: s.step, phase: 'step' });
          const decision = decideStep(stepAnswers, cands, this.config); needsUser = decision.needsUser;
          this.observe({ kind: 'jev', step: s.step, ms: performance.now() - t0, questions: Object.keys(stepQ).length, stateBytes: Buffer.byteLength(JSON.stringify(record)),
            route: stepAnswers.next?.type === 'choice' ? Object.entries(stepAnswers.next.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5) : [], nouls: { stuck: decision.stuck, scope_drift: decision.scopeDrift, needs_user: decision.needsUser } });
          await this.store.log('decision', { step: s.step, chosen: decision.candidate.id, tier: decision.tier, confidence: decision.confidence, probability: decision.probability, stuck: decision.stuck, scopeDrift: decision.scopeDrift, needsUser: decision.needsUser, candidates: cands.map(c => c.id) });
          const d = decision.candidate;
          if (d.kind === 'inspect' && d.target?.path) {
            // Code reads: the range is the whole file when small, else the region the errors or the deliverable name.
            const path = d.target.path; let start = 1; let end = 250;
            const errs = s.lastCheck && !s.lastCheck.ok ? Object.entries(s.lastCheck.summary.byFile).find(([f]) => path.endsWith(f) || f.endsWith(path))?.[1].lines ?? [] : [];
            if (errs.length) { start = Math.max(1, Math.min(...errs) - 20); end = Math.max(...errs) + 30; }
            await this.forced(s, 'read_files', { files: [{ path, start, end }] }, 'decided-read');
            await this.store.save(s); continue;
          }
          if (d.kind === 'search' && d.target?.name) { await this.forced(s, 'search_codebase', { query: d.target.name, path: '.', mode: 'text' }, 'decided-search'); await this.store.save(s); continue; }
          if (d.kind === 'finish') route = 'finish';
          else if (d.kind === 'ask') route = 'ask_user';
          else if (d.kind === 'implement' && d.target?.deliverable && d.target.deliverable.kind === 'create') {
            // A file is created from its contract, as code; failures count on the deliverable.
            const dl = d.target.deliverable; const path = dl.to ?? dl.name ?? '';
            if (s.phase === 'inspect') s.phase = 'implement';
            try { await this.createFile(s, await this.createTarget(s, path, dl), 'decided-create'); }
            catch (e) { this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message }); await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` }); }
            await this.store.save(s); continue;
          } else if (d.kind === 'implement' && d.target?.deliverable) {
            const dl = d.target.deliverable; decidedDeliverable = dl;
            route = dl.kind === 'move' ? 'move_lines' : 'replace_lines';
            harnessNote = `Work on deliverable ${dl.id} only: ${dl.kind} ${dl.name ?? ''}${dl.from ? ` from ${dl.from}` : ''}${dl.to ? ` to ${dl.to}` : ''}. ${dl.detail}${dl.note ? ` Current status: ${dl.note}.` : ''} Produce the single ${route} action that advances it.`;
            const p = route === 'replace_lines' ? (ledgerFile(s, dl.to ?? dl.from) ?? null) : null;
            if (p && (s.knownFiles.includes(p) || s.writes.includes(p))) target = { path: p, start: 1, end: 250 };
          } else if (d.kind === 'verify' && d.target?.name && d.target.deliverable) {
            // The design's own verification command: run by code, judged like a check.
            const dl = d.target.deliverable; dl.attempts = (dl.attempts ?? 0) + 1;
            const vr = await this.forced(s, 'bash', { command: d.target.name, purpose: `Run ${d.target.name}: the design's verification ${dl.id} (${clip(dl.detail, 120)}).` }, 'decided-verify');
            // A verification that fails is a failing check: its errors, attributed
            // to files, are the fix work that follows; the check command itself is
            // unchanged, so the edits are still judged by the cheaper check.
            if (!vr.ok && !vr.verification) {
              s.previousCheck = s.lastCheck;
              s.lastCheck = { step: s.step, ok: false, text: clip(vr.text, 1500), summary: summarizeCheck(vr.text, s.root), fileHashes: await sourceHashes(s.root, s.writes), command: d.target.name };
              s.editSnapshots = {}; s.transaction = [];
              this.recordFailedVersions(s);
              // Three failed runs of one verification, each on inputs that changed
              // since the last, set it aside: the audit judges it, the loop does not.
              if (dl.attempts >= 3) { dl.unresolvable = true; dl.setAside = true; dl.note = `set aside after ${dl.attempts} failed runs; last: ${clip(vr.text.replace(/\s+/g, ' '), 160)}`; }
            }
            await refreshLedger(this.tools.root, s).catch(() => {});
            this.settleFeedback(s);
            await this.store.save(s); continue;
          } else if (d.kind === 'fix' && d.target?.path) {
            // A fix is a region rewrite from the text code holds: no read, no line arithmetic.
            const v = s.lastCheck && d.id !== 'fix:setup' ? Object.entries(s.lastCheck.summary.byFile).find(([f]) => d.target!.path!.endsWith(f) || f.endsWith(d.target!.path!))?.[1] : undefined;
            if (s.phase === 'inspect') s.phase = 'implement';
            const fixKey = d.id === 'fix:setup' ? `setup@${hash(s.setupError ?? '')}` : `${d.target.path}@${s.hashes[d.target.path] ?? ''}`;
            if (d.id === 'fix:setup') (s.fixAttempts ??= {})[fixKey] = (s.fixAttempts[fixKey] ?? 0) + 1;
            try {
              const ok = await this.rewriteRegion(s, d.target.path, (v?.diagnostics?.length ? v.diagnostics : v?.samples) ?? d.target.errors ?? [], d.id === 'fix:setup' ? `Fix ${d.target.path} so that dependencies install: the package manager reported the errors listed (a version that does not exist, a package that cannot be found). Use versions that exist.` : `Fix the verification errors the check reports in ${d.target.path}${v?.lines.length ? ` at lines ${v.lines.join(', ')}` : ''}; the check command was ${s.lastCheckCommand ?? 'the configured check'}.`, 'decided-fix');
              if (!ok && d.id !== 'fix:setup') (s.fixAttempts ??= {})[fixKey] = (s.fixAttempts[fixKey] ?? 0) + 1;
            } catch (e) {
              if (d.id !== 'fix:setup') (s.fixAttempts ??= {})[fixKey] = (s.fixAttempts[fixKey] ?? 0) + 1;
              this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message }); await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` });
            }
            await this.store.save(s); continue;
          } else if (d.kind === 'free' && d.id === 'fix:project') {
            harnessNote = `The verification reports errors it attributes to no file: ${(d.target?.errors ?? []).join(' | ')}. Propose the one action that addresses them: create the missing file, edit the file responsible, or run the command that shows more.`;
          }
          // A line edit needs the file as it is now: read it first, and re-decide next step.
          if (target && route === 'replace_lines' && s.readHashes[target.path] !== s.hashes[target.path]) {
            await this.forced(s, 'read_files', { files: [{ path: target.path, start: target.start, end: target.end }] }, 'decided-read');
            await this.store.save(s); continue;
          }
          if (decision.stuck >= .8 && route && editRoutes.includes(route)) harnessNote = `${harnessNote ?? ''} The last attempts did not work; take a different approach than before.`.trim();
          if (route && (editRoutes.includes(route) || route === 'finish') && s.phase === 'inspect') s.phase = 'implement';
        }
        // A deliverable still pending by source facts (a file not created, a
        // verification not passed) makes a finish pointless: the audit would only
        // say what the facts already say, so the worker is not offered it.
        const finishBlocked = s.ledger.some(d => d.status === 'pending' && !d.optional && !d.unresolvable && (d.kind !== 'verify' || Boolean(d.name && commandLike(d.name))));
        const questions = routeQuestions(s, this.config, !finishBlocked);
        // A passing check after edits, with nothing pending, is the moment to propose
        // completion: the audit judges the proposal, so the harness makes it once per
        // check rather than leaving the worker to read until it feels ready. The
        // same readiness offers the finish candidate: one policy, one place.
        const proposeFinish = readyNow && (this.config.allowBash || s.lastCheck?.ok === true);
        if (proposeFinish) s.finishTriedAtCheck = s.lastCheck!.step;
        const decided = route !== null;
        const jevStarted = performance.now();
        const state = decided || proposeFinish ? null : decisionState(s);
        const answers: Answers = decided ? { route: { type: 'choice', choice: route!, confidence: 1, probabilities: { [route!]: 1 } } } : proposeFinish ? { route: { type: 'choice', choice: 'finish', confidence: 1, probabilities: { finish: 1 } } } : await this.jev.decide(state, questions, { step: s.step, phase: 'routing-and-context' });
        if (proposeFinish && !decided) { route = 'finish'; await this.store.log('auto-finish', { step: s.step, check: s.lastCheck!.step }); }
        if (!decided && !proposeFinish) this.observe({ kind: 'jev', step: s.step, ms: performance.now() - jevStarted, questions: Object.keys(questions).length, stateBytes: Buffer.byteLength(JSON.stringify(state)),
          route: answers.route?.type === 'choice' ? Object.entries(answers.route.probabilities).sort((a, b) => b[1] - a[1]) : [],
          nouls: Object.fromEntries(Object.entries(answers).filter(([, a]) => a.type === 'noul').map(([k, a]) => [k, (a as { noul: number }).noul])) });
        const criteria = (questions.route as { criteria: Record<string, string> }).criteria;
        const routeAnswer = answers.route;
        if (!route) route = confidentChoice(routeAnswer, this.config) as Route | null;
        // finish proposes a summary, not completion. Audit that concrete proposal
        // below instead of redirecting a finish vote into unrelated inspections.
        if (!decided && !proposeFinish && (!route || !Object.hasOwn(criteria, route)) && routeAnswer?.type === 'choice') {
          // Probability spread thinly over many options is not the same as not
          // knowing. Re-ask among the leading candidates before pausing.
          const leading = Object.entries(routeAnswer.probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k).filter(k => Object.hasOwn(criteria, k)).slice(0, 2);
          if (leading.length === 2) {
            const narrowed = { ...questions.route!, criteria: Object.fromEntries(leading.map(k => [k, criteria[k]!])) };
            const again = await this.jev.decide(decisionState(s, { routingNarrowed: `Routing among ${Object.keys(criteria).length} actions was uncertain; choose among the leading candidates.` }),
              { route: narrowed }, { step: s.step, phase: 'routing-narrowed' });
            route = confidentChoice(again.route, this.config) as Route | null;
            // An edit against an inspection, after inspections have already run since
            // the last action, is not a coin flip: a failed edit returns a precise
            // error in one step, another read returns more of the same.
            const isEdit = (k: string) => editRoutes.includes(k as Route); const isLook = (k: string) => k === 'read_files' || k === 'search_codebase';
            if (again.route?.type === 'choice' && s.inspectionsSinceAction >= 2 && leading.some(isEdit) && leading.some(isLook) && (!route || isLook(route))) {
              const edit = leading.find(isEdit)!;
              if ((again.route.probabilities[edit] ?? 0) >= this.config.routeProbability * .5) {
                route = edit as Route;
                await this.store.log('tie-break', { step: s.step, route, probabilities: again.route.probabilities, rule: 'edit over inspection after inspections' });
              }
            }
            // A coin flip between two reasonable actions is not a reason to stop the
            // session: take the narrowed leader when it carries real probability.
            if (!route && again.route?.type === 'choice') {
              // Ties go to the action that changes state: edit before check, check
              // before read, read before search. The rule is logged with the choice.
              const preference = ['replace_lines', 'write', 'create_file', 'move_lines', 'bash', 'read_files', 'search_codebase', 'tasks', 'finish', 'ask_user'];
              const top = Object.entries(again.route.probabilities).sort((a, b) => (b[1] - a[1]) || (preference.indexOf(a[0]) - preference.indexOf(b[0])))[0]!;
              if (top[1] >= this.config.routeProbability * .5 && Object.hasOwn(criteria, top[0])) {
                route = top[0] as Route;
                await this.store.log('tie-break', { step: s.step, route, probabilities: again.route.probabilities, rule: 'edit > check > read > search' });
              }
            }
          }
        }
        if (!route || (!decided && !proposeFinish && !Object.hasOwn(criteria, route)))
          throw new Error('Jev route is uncertain; paused without executing an action');
        // The worker can batch related writes. Only enter verify after it has
        // selected the validation action, so a stale readiness judgement never
        // turns a write into an implementation action in the verify phase.
        if (phase === 'implement' && route === 'bash' && s.writes.length > 0 &&
          answers.ready_for_verify?.type === 'noul' && answers.ready_for_verify.noul >= .8)
          s.phase = 'verify';
        // Further edits after a passing check mean the implementation is not done.
        if (phase === 'verify' && (editRoutes.includes(route) || route === 'read_files')) s.phase = 'implement';
        const currentSource = route === 'finish' ? await completionSource(s.root,
          [...new Set([...s.writes, ...Object.keys(s.readHashes).filter(p => /\.[cm]?[jt]sx?$/.test(p))])],
          [s.objective, ...referenceContext(s).map(e => e.text)].join('\n')) : undefined;
        if (currentSource) await this.store.log('completion-source', { step: s.step, files: currentSource });
        let focusedTarget: { path: string; text: string; hash: string; start: number; end: number; note: string } | null = null;
        if (target && route === 'replace_lines' && harnessNote) {
          try { const text = await readFile(await safePath(this.tools.root, target.path), 'utf8'); focusedTarget = { path: target.path, text, hash: hash(text), start: target.start, end: Math.min(target.end, target.start + 249), note: harnessNote }; } catch { focusedTarget = null; }
        }
        let prompt = focusedTarget ? focusedMessages(s, route, focusedTarget) : messages(s, route, harnessNote, currentSource);
        let counted = await this.bonsai.count(prompt);
        let forced = 0;
        while (counted.tokens > this.config.workingTokens) {
          if (!evictOne(s)) throw new Error('Pinned objective, instructions and ledger exceed working context; reduce them or increase workingTokens');
          forced++;
          prompt = focusedTarget ? focusedMessages(s, route, focusedTarget) : messages(s, route, undefined, currentSource); counted = await this.bonsai.count(prompt);
        }
        if (forced) { s.lastCompact = s.step; await this.store.log('compact', { step: s.step, removed: forced, reason: 'hard-budget' }); }
        s.lastPromptTokens = counted.tokens;
        this.observe({ kind: 'route', step: s.step, route, tokens: counted.tokens, entries: s.entries.length });
        let args: Record<string, any>;
        await this.logPrompt(s, route, prompt, counted.tokens, 1);
        try {
          {
          args = await this.bonsai.generate(prompt, focusedTarget ? focusedEditSchema : schemas[route], .2, { step: s.step, route });
          this.observe({ kind: 'generated', step: s.step, route, meta: this.bonsai.lastMeta ?? null, args });
          // Code fills what it knows before anything is judged: a focused edit
          // gets its decided path and current hash whatever the worker echoed,
          // and a write meant to create a file that does not exist is a creation.
          if (focusedTarget) args = { path: focusedTarget.path, expectedHash: focusedTarget.hash, edits: args.edits };
          if (route === 'write' && args.expectedHash === 'new' && typeof args.path === 'string' && !(await stat(await safePath(this.tools.root, args.path, true)).then(() => true, () => false))) {
            await this.store.log('write-as-create', { step: s.step, path: args.path });
            route = 'create_file'; args = { path: args.path, content: String(args.newText ?? '') };
          }
          // An action already executed in this session yields nothing new: record a
          // generation failure naming the earlier result and let Jev route again.
          // A repeat is pointless only while its result is still in evidence; once
          // compaction has evicted that entry, re-running is how the model gets it back.
          // A search whose query is already in the pinned digest has its answer
          // in the prompt whatever happened to the entry.
          const searchKey = (a: Record<string, any>) => `${a.mode}:${a.query} in ${a.path}`;
          // Reads and searches are keyed with the current file hashes: after an
          // edit, the same read is a new action, not a repeat.
          const actionKey = (a: Record<string, any>) => Runner.actionKey(s, route as Route, a);
          // Rejected edits are matched on content, not on the file hash: after a
          // rollback the same bad edit must stay refused.
          const identityOf = (a: Record<string, any>) => hash(JSON.stringify({ route, args: { ...a, expectedHash: undefined, destinationHash: undefined } }));
          const rejected = (a: Record<string, any>) => s.rejectedEdits.find(r => r.identity === identityOf(a));
          const executed = (a: Record<string, any>): number | undefined => {
            const bad = rejected(a); if (bad) return bad.step;
            if (route === 'search_codebase' && searchKey(a) in s.searches) return s.actions[actionKey(a)] ?? 0;
            const step = s.actions[actionKey(a)];
            if (step === undefined || !s.entries.some(e => e.step === step)) return undefined;
            // Reading a file again after it changed is how line numbers are refreshed, never a repeat.
            if (route === 'read_files' && (a.files as { path: string }[]).some(f => (s.writeSteps[f.path] ?? -1) > step)) return undefined;
            return step;
          };
          const earlier = executed(args);
          if (earlier !== undefined) {
            // No hotter retry: a repeat is a stop signal, and a randomized variant of
            // an edit is not a fix. The reason reaches both models through lastError.
            const bad = rejected(args);
            const known = bad ? `it was rolled back at step ${bad.undoneAt} because ${bad.reason}`
              : route === 'search_codebase' ? `its result was ${s.searches[searchKey(args)]}` : `its result is in the evidence or in @artifact/${String(earlier).padStart(5, '0')}.txt`;
            throw new Error(`Bonsai repeated the ${route} action from step ${earlier} (${known}); not executed. Choose different arguments or another action`);
          }
          }
          if (route === 'move_lines' && s.ledger.length) { const why = await this.moveOutsideLedger(s, args); if (why) throw new Error(why); }
          // The worker may not hand a decision to the user that Jev judged the task does not need.
          if (route === 'ask_user' && needsUser !== null && needsUser < .5) throw new Error(`ask_user refused: the task does not need the user (judged ${needsUser.toFixed(2)}). Decide it yourself from the objective and the deliverables: ${clip(String(args.question ?? ''), 200)}`);
          if (route === 'move_lines' && typeof args.destination === 'string' && args.destinationHash === 'new') {
            const anchored = await anchorPath(this.tools.root, ledgerFile(s, args.source) ?? args.source, args.destination);
            if (anchored !== args.destination) { await this.store.log('anchored-path', { step: s.step, from: args.destination, to: anchored }); args = { ...args, destination: anchored }; }
          }
          generationFailures = 0;
        } catch (e) {
          // On the free path, two failures in a row on one route take it off the
          // table for the next decision, so Jev picks another way forward; four
          // in a row mean the worker cannot act on this state. A decided action
          // never blocks a route: its failure belongs to its deliverable.
          if (!decided) { if (++generationFailures >= 4) throw e; if (generationFailures >= 2) s.blockedRoute = route; }
          chargeDeliverable((e as Error).message);
          this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message });
          await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` });
          await this.store.save(s);
          continue;
        }
        // A creation chosen on the free path names only the file: the content is
        // generated as code, and only once the path is known to be free.
        if (route === 'create_file') {
          const path = String(args.path); const purpose = String(args.purpose ?? harnessNote ?? '');
          if (s.phase === 'inspect') s.phase = 'implement';
          const dl: Deliverable = s.ledger.find(d => d.kind === 'create' && d.to && same(d.to, path) && d.status !== 'done') ?? { id: 'free', kind: 'create', name: path, to: path, detail: purpose || `Create ${path} as the objective requires.`, required: 1, status: 'pending' };
          try {
            const exists = await safePath(this.tools.root, path, true).then(p => stat(p)).then(() => true, () => false);
            if (exists) throw new Error(`${path} already exists; edit it with replace_lines or write instead of creating it`);
            if (typeof args.content === 'string' && args.content.trim()) await this.forced(s, 'create_file', { path, content: args.content }, 'write-as-create');
            else await this.createFile(s, await this.createTarget(s, path, dl), 'free-create');
          } catch (e) { if (!decided) generationFailures++; this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message }); await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` }); }
          await this.store.save(s); continue;
        }
        if (route === 'finish') {
          // The worker may take seconds to summarize. Never accept a passing
          // check for files that changed while it was generating that summary.
          const now = await sourceHashes(s.root, s.writes);
          const changed = Object.keys(s.lastCheck?.fileHashes ?? {}).filter(path => now[path] !== s.lastCheck!.fileHashes![path]);
          if (changed.length) {
            s.lastCheckStep = -1;
            s.pendingCheck = Boolean(s.lastCheckCommand);
            await this.store.log('completion-stale', { step: s.step, files: changed });
            if (!s.pendingCheck || !this.config.allowBash) throw new Error(`Files changed since verification: ${changed.join(', ')}; run the check again before completion`);
            await this.store.save(s);
            continue;
          }
          if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('finish requires a summary of the final code structure and verification');
          // Completion is judged on the repository's structural diff against the
          // ledger, never on the summary: Jev classifies, per deliverable, whether
          // the change implements it, and whether the diff strays out of scope.
          await refreshLedger(this.tools.root, s).catch(() => {});
          const diff = await structuralDiff(this.tools.root, s, this.store.artifacts);
          await this.store.log('completion-diff', { step: s.step, files: diff.files.map(f => ({ ...f, hunks: f.hunks ? clip(f.hunks, 2000) : undefined })), moved: diff.moved });
          // The diff supersedes edit evidence and recent excerpts: the audit's base
          // state omits them, and the diff chunks are sized from the bytes left.
          const evidence = await completionEvidence(this.tools.root, s, diff);
          const changedFiles = diff.files.map(f => f.path);
          const implemented: Record<string, number> = {}; let outOfScope = 0; let objectiveMet: number | null = null;
          let diffSummary = clip(diff.files.map(f => `${f.path}${f.created ? ' (created)' : ''}: +${f.declarationsAdded.length}/-${f.declarationsRemoved.length} declarations, +${f.importsAdded.length}/-${f.importsRemoved.length} imports${f.hunks ? `\n${clip(f.hunks, 700)}` : ''}`).join('\n'), 6000);
          // The audit state is sized from Jev's budget: the base (diff summary,
          // source excerpts, deliverables) shrinks in stages until the evidence
          // has room, and the evidence is chunked by deliverable into the room
          // that is left; an audit never pauses on size.
          const limit = 20000; let source = currentSource;
          const baseBytes = () => Buffer.byteLength(JSON.stringify(completionState(s, {}, changedFiles, source, diffSummary)));
          if (baseBytes() > limit - 6000) source = source?.map(f => ({ path: f.path, hash: f.hash, facts: f.facts.slice(0, 6) }));
          if (baseBytes() > limit - 6000) diffSummary = clip(diffSummary, 2500);
          if (baseBytes() > limit - 6000) source = undefined;
          if (baseBytes() > limit - 6000) diffSummary = clip(diffSummary, 800);
          const room = Math.max(3000, limit - baseBytes());
          for (const d of s.ledger) if (Buffer.byteLength(evidence[d.id] ?? '') + 200 > room) evidence[d.id] = clip(evidence[d.id] ?? '', room - 400);
          const groups: Deliverable[][] = []; let group: Deliverable[] = []; let bytes = 0;
          for (const d of s.ledger) { const size = Buffer.byteLength(evidence[d.id] ?? '') + 200; if (bytes + size > room && group.length) { groups.push(group); group = []; bytes = 0; } group.push(d); bytes += size; }
          if (group.length || !groups.length) groups.push(group);
          const perItem: Record<string, { supports: number; contradicts: number; saysNothing: number }> = {}; const unmet: string[] = [];
          for (const [i, items] of groups.entries()) {
            const state = completionState(s, Object.fromEntries(items.map(d => [d.id, evidence[d.id] ?? ''])), changedFiles, source, diffSummary);
            const answers = await this.jev.decide(state, auditQuestions(items, items.length === 0 && i === 0, unaccountedFiles(s, changedFiles)), { step: s.step, phase: 'completion-check' });
            const verdict = auditVerdict(answers, items, this.config);
            Object.assign(perItem, verdict.perItem); unmet.push(...verdict.unmet); outOfScope = Math.max(outOfScope, verdict.scopeCreep); if (verdict.objectiveMet !== null) objectiveMet = verdict.objectiveMet;
            for (const d of items) implemented[d.id] = verdict.perItem[d.id]?.supports ?? 0;
          }
          const threshold = this.config.completeProbability;
          const accepted = !unmet.length && outOfScope < threshold && (objectiveMet === null || objectiveMet >= threshold);
          await this.store.log('action', { step: s.step, route, args, rejected: !accepted, perItem, outOfScope, objectiveMet, unmet });
          if (!accepted) {
            const unmetItems = s.ledger.filter(d => unmet.includes(d.id));
            const feedback = `Completion rejected (${objectiveMet !== null ? `objective met=${objectiveMet.toFixed(2)}, ` : ''}out-of-scope changes=${outOfScope.toFixed(2)}). ${unmetItems.length ? `Deliverables the evidence does not show as done: ${unmetItems.map(d => `${d.id} ${d.kind} ${d.name ?? ''}${d.to ? ` to ${d.to}` : ''} [${d.status}${d.note ? `: ${d.note}` : ''}; supports ${(perItem[d.id]?.supports ?? 0).toFixed(2)}, contradicts ${(perItem[d.id]?.contradicts ?? 0).toFixed(2)}]`).join('; ')}. ` : ''}${outOfScope >= threshold ? 'The diff contains changes the objective did not ask for; revert them. ' : ''}Continue the implementation; the harness re-proposes completion after the next passing check.`;
            await this.evidence(s, 'finish_rejected', { ok: false, text: feedback });
            s.completionFeedback = { step: s.step, text: clip(feedback, 1500), awaitingEvidence: true, unmet: [...unmet], unmetPending: unmet.filter(id => s.ledger.find(d => d.id === id)?.status !== 'done') };
            if (s.lastCheck) s.finishTriedAtCheck = s.lastCheck.step;
            s.phase = 'implement'; s.inspectionsSinceAction = 0;
            s.lastRoute = 'finish'; s.lastResultOk = false;
            await this.store.save(s);
            continue;
          }
          if (s.ledger.length) args = { ...args, summary: `${args.summary} Deliverables: ${s.ledger.map(d => `${d.kind} ${d.name ?? ''}${d.to ? ` to ${d.to}` : ''} (${d.status === 'done' ? 'done' : `supported ${(implemented[d.id] ?? 0).toFixed(2)}`})`).join('; ')}.` };
        }
        await this.store.log('action', { step: s.step, route, args });
        // Save an intent marker before effects; recovery never blindly replays an action.
        s.stopReason = `Interrupted around step ${s.step} (${route}); inspect repository and artifacts before continuing.`;
        await this.store.save(s);
        if (route === 'finish' || route === 'ask_user') {
          s.status = route === 'finish' ? 'complete' : 'paused';
          s.stopReason = route === 'finish' ? args.summary : args.question;
          break;
        }
        let result: ToolResult;
        const toolStarted = performance.now();
        // Line-addressed edits are only safe against the version that was read:
        // after any edit the numbers move, so the file must be read again first.
        const lineTarget = route === 'replace_lines' ? args.path : route === 'move_lines' ? args.source : null;
        const unread = lineTarget && s.readHashes[lineTarget] !== args.expectedHash;
        try {
          if (unread) throw new StaleWriteError(`${lineTarget} has not been read since it last changed (current sha256 ${s.hashes[lineTarget] ?? 'unknown'}); line numbers from an older read or from a check run before the edit are stale. Read the file, then edit with the numbers from that read.`);
          if (route === 'tasks') {
            const beforeTasks = JSON.stringify(s.tasks);
            updateTasks(s, args.tasks);
            const afterTasks = JSON.stringify(s.tasks);
            result = beforeTasks === afterTasks
              ? { ok: false, text: 'Task ledger unchanged; select a repository action instead of repeating this ledger.' }
              : { ok: true, text: JSON.stringify({ tasks: s.tasks }) };
          } else result = await this.tools.execute(route, args);
        } catch (e) { result = { ok: false, text: `Tool error: ${(e as Error).message}`, stale: e instanceof StaleWriteError }; }
        s.lastRoute = route; s.lastResultOk = result.ok; s.lastWriteStale = editRoutes.includes(route) && result.stale === true;
        if (s.lastWriteStale) s.inspectionsSinceAction = 0; // the recovery read must stay available
        if (!result.ok && !result.stale) chargeDeliverable(result.text);
        // A blocked route stays off the table until some other action succeeds.
        if (result.ok && route !== s.blockedRoute) s.blockedRoute = null;
        // On the free path, the same tool error twice in a row on an edit route
        // means the worker is not reading the refusal: take the route away until
        // another action lands. A decided action's failure belongs to its deliverable.
        if (!result.ok && editRoutes.includes(route)) {
          const message = result.text.slice(0, 120);
          if (!decided && s.lastToolError && s.lastToolError.route === route && s.lastToolError.message === message && s.lastToolError.step === s.step - 1) {
            s.blockedRoute = route; await this.store.log('blocked-route', { step: s.step, route, reason: 'the same refusal twice in a row', message });
          }
          s.lastToolError = { route, message, step: s.step };
        } else if (result.ok) s.lastToolError = null;
        await this.evidence(s, route, result, args);
        if (s.completionFeedback && result.ok && (result.changed?.length || route === 'read_files' || route === 'search_codebase'))
          s.completionFeedback.awaitingEvidence = false;

        this.observe({ kind: 'result', step: s.step, route, ok: result.ok, ms: performance.now() - toolStarted, chars: result.text.length, text: clip(result.text, 200) });
        // Recorded after the action so a read's key carries the hash it produced. A
        // stale-target rejection is not recorded: it is meant to be retried with the
        // same arguments once the file has been re-read.
        const key = Runner.actionKey(s, route, args);
        if (!result.stale) s.actions[key] = s.step;
        if (result.ok && editRoutes.includes(route)) s.transaction.push({ key, identity: hash(JSON.stringify({ route, args: { ...args, expectedHash: undefined, destinationHash: undefined } })), step: s.step, route, paths: result.changed ?? [], summary: clip(JSON.stringify({ ...args, expectedHash: undefined, destinationHash: undefined }), 200) });
        await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - toolStarted, artifact: s.entries.at(-1)?.artifact });
        // Identical arguments never reach execution, so key on the outcome: the same
        // kind of action producing the same result (a build with a different tail
        // length, a search for another absent symbol) is the loop worth catching.
        const signature = hash(JSON.stringify({ route, result: result.text }));
        // A read that repeats after the file was edited or restored is not a loop:
        // the same content legitimately reads the same. Count only true repeats.
        const previous = s.repetitionSteps[signature];
        if (previous !== undefined && (route === 'read_files' || route === 'search_codebase') && s.lastWriteStep > previous) s.repetitions[signature] = 0;
        s.repetitionSteps[signature] = s.step;
        const repeats = s.repetitions[signature] = (s.repetitions[signature] ?? 0) + 1;
        if (repeats >= 5) throw new Error(`The ${route} action produced an identical result five times; paused to prevent a loop`);
        // Surface the first repetition to both models; at three, take the route
        // off the free path's table until another action succeeds.
        if (repeats === 3 && !decided) s.blockedRoute = route;
        if (repeats >= 2) s.lastError = [`Step ${s.step} repeated an identical ${route} action with an identical result${repeats >= 3 ? `; ${route} is withheld until another action succeeds` : ''}. Choose a different action or arguments that can produce new information.`,
          s.lastError].filter(Boolean).join(' Last error: ');
        s.stopReason = '';
        await this.store.save(s);
      }
      if (s.status === 'running') { s.status = 'paused'; s.stopReason = `Reached the ${this.config.maxSteps}-step limit for this invocation`; }
    } catch (e) {
      s.status = 'paused'; s.stopReason = (e as Error).message;
      await this.store.log('paused', { step: s.step, reason: s.stopReason });
    }
    await this.store.log('stop', { step: s.step, status: s.status, reason: s.stopReason });
    await this.store.save(s);
    this.observe({ kind: 'stop', step: s.step, status: s.status, reason: s.stopReason });
    return s;
  }
}
