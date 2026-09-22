import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bonsai, Jev } from './clients.js';
import { focusedCreateMessages, focusedMessages, checkDelta, clip, compactNames, confidentChoice, decisionState, evictOne, mergeCoverage, messages, rememberEdit, retireEvidence, routeQuestions, staleFor } from './context.js';
import { schemas } from './schema.js';
import { aliasImportBinding, missingDependencies, installCommand, runCommand, repositoryStatus, readOnlyCommand, checkUnusable, topLevelDeclarations, namedIdentifiers, removeImportBindings, checkAdvice, completionSource, hash, importInsertLine, listRepoFiles, regression, resolveMissingNames, safePath, sourceHashes, StaleWriteError, summarizeCheck, ToolBox } from './tools.js';
import { unaccountedFiles, auditQuestions, auditVerdict, candidates, completionEvidence, completionState, decideStep, stepQuestions, taskRecord } from './decide.js';
import { designFrom, anchorPath, candidatesFrom, checkPrompt, checkQuestions, checkSchema, completionQuestions, diffChunks, ledgerFile, ledgerPrompt, ledgerQuestions, ledgerSchema, refreshLedger, structuralDiff } from './ledger.js';
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
    lastRoute: null, lastResultOk: false, lastWriteStale: false, repetitions: {}, coverage: {}, hashes: {}, lastPromptTokens: 0, lastCheck: null, previousCheck: null, editSnapshots: {}, missingNames: [], transaction: [], rejectedEdits: [], lastCheckCommand: null, pendingCheck: false, autoUndo: null, inspectionsSinceAction: 0, coverageByHash: {}, repetitionSteps: {}, focusReadAt: -1, autoFixKeys: {}, actions: {}, searches: {}, blockedRoute: null, editsSinceCheck: 0, readHashes: {}, writeSteps: {} };
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
    readonly bonsai: Pick<Bonsai, 'count' | 'generate'> & { lastMeta?: GenerationMeta | null }, root: string,
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
      s.lastCheck = { step: s.step, ok: result.ok, text: clip(result.text, 1500), summary: summarizeCheck(result.text), fileHashes: await sourceHashes(s.root, s.writes) };
      s.pendingCheck = false;
      // The edits since the previous check are now judged by this one. An
      // objective regression is rolled back deterministically; a small increase
      // is put to Jev; an improvement or a pass is committed silently.
      const scope = { files: [...new Set([...s.transaction.flatMap(t => t.paths), ...Object.keys(s.editSnapshots)])], structural: s.transaction.some(t => t.route === 'move_lines'), created: Object.values(s.editSnapshots).some(a => a === '@new') };
      const verdict = (s.transaction.length || Object.keys(s.editSnapshots).length) && !result.ok ? regression(s.previousCheck?.summary ?? null, s.lastCheck.summary, scope) : 'fine';
      s.autoUndo = verdict === 'worse' ? { files: { ...s.editSnapshots }, reason: clip(`the check went from ${s.previousCheck?.summary.errors ?? 0} errors (${s.previousCheck?.summary.syntax ?? 0} syntax) to ${s.lastCheck.summary.errors} (${s.lastCheck.summary.syntax} syntax) in scope ${scope.files.join(', ')}; first new: ${Object.entries(s.lastCheck.summary.byFile).find(([f]) => scope.files.some(p => f.endsWith(p) || p.endsWith(f)))?.[1].samples[0] ?? ''}`, 300) } : null;
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
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.editSnapshots)) s.editSnapshots[path] = artifact;
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.baselineArtifacts)) s.baselineArtifacts[path] = artifact;
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
  private async forced(s: Session, route: Route, args: Record<string, any>, kind: string): Promise<void> {
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
    if (result.ok && editRoutes.includes(route)) s.transaction.push({ key: Runner.actionKey(s, route, args), identity: hash(JSON.stringify({ route, args: { ...args, expectedHash: undefined, destinationHash: undefined } })), step: s.step, route, paths: result.changed ?? [], summary: clip(JSON.stringify({ ...args, expectedHash: undefined }), 200) });
    this.observe({ kind: 'result', step: s.step, route, ok: result.ok, ms: performance.now() - started, chars: result.text.length, text: clip(result.text, 200) });
    await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - started, artifact: s.entries.at(-1)?.artifact });
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
    let raw: Record<string, any>;
    const repository = await repositoryStatus(this.tools.root).catch(() => undefined);
    try { raw = await this.bonsai.generate(ledgerPrompt(s, note, repository), ledgerSchema, .1, { step: s.step, route: 'ledger' }); }
    catch (e) { await this.store.log('ledger', { step: s.step, error: (e as Error).message }); s.ledgerBuilt = s.ledgerAttempts >= 2; return false; }
    const design = designFrom(raw); if (design && (!s.design || design.summary.length > s.design.summary.length)) s.design = design;
    const fresh = candidatesFrom(raw).filter(c => !s.ledger.some(d => d.kind === c.kind && d.name === c.name && d.to === c.to && d.from === c.from));
    const candidates = fresh.map((c, i) => ({ ...c, id: `d${s.ledger.length + i + 1}` }));
    if (!candidates.length) { s.ledgerBuilt = true; await this.store.log('ledger', { step: s.step, candidates: [], kept: s.ledger }); return false; }
    const answers = await this.jev.decide(decisionState(s, { candidateDeliverables: candidates.map(c => ({ id: c.id, kind: c.kind, name: c.name, from: c.from, to: c.to, detail: c.detail })) }), ledgerQuestions(candidates), { step: s.step, phase: 'ledger' });
    const kept = candidates.filter(c => {
      const a = answers[`required_${c.id}`]; const p = a?.type === 'noul' ? a.noul : 0; c.required = p;
      const f = answers[`fits_${c.id}`]; const fits = f?.type === 'noul' ? f.noul : 0;
      if (p >= this.config.completeProbability) return true;
      if (fits >= this.config.completeProbability) { c.optional = true; return true; }
      return false;
    });
    s.ledger = [...s.ledger, ...kept];
    const complete = answers.complete?.type === 'noul' ? answers.complete.noul : 0;
    s.ledgerComplete = Math.max(s.ledgerComplete, complete);
    s.ledgerBuilt = complete >= this.config.completeProbability || s.ledgerAttempts >= 2;
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
  // No configured check: the worker proposes one from the repository and Jev
  // classifies it before it becomes the verification.
  private async inferCheck(s: Session): Promise<boolean> {
    s.checkInferences++; s.checkInferredFor = s.writes.length;
    const repository = await repositoryStatus(this.tools.root);
    let raw: Record<string, any>;
    try { raw = await this.bonsai.generate(checkPrompt(s, repository), checkSchema, .1, { step: s.step, route: 'check' }); } catch (e) { await this.store.log('check-inferred', { step: s.step, error: (e as Error).message }); return false; }
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) { await this.store.log('check-inferred', { step: s.step, command: '', accepted: false }); return false; }
    const unusable = await checkUnusable(this.tools.root, command);
    // Run the candidate once: how it actually behaves is the best evidence Jev can get.
    const run = () => runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', command], this.tools.root, this.config.commandTimeoutMs).then(t => ({ code: t.code, timedOut: t.timedOut, output: clip(t.output, 1200) })).catch(e => ({ code: -1, timedOut: false, output: clip(String((e as Error).message), 300) }));
    let trial = unusable ? null : await run();
    // A trial that fails for want of dependencies is an environment fact, not a
    // verdict on the command: install what the manifest implies, once, and try again.
    if (trial && trial.code !== 0 && missingDependencies(trial.output) && !s.setupDone) {
      const dir = command.match(/(?:--dir|-C|--prefix)\s+(\S+)/)?.[1] ?? command.match(/^\s*cd\s+(\S+)/)?.[1] ?? '.';
      const install = await installCommand(this.tools.root, dir);
      if (install) {
        s.setupDone = true;
        const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', install], this.tools.root, Math.max(this.config.commandTimeoutMs, 300000)).catch(e => ({ code: -1, output: String((e as Error).message), truncated: false, timedOut: false }));
        await this.store.log('setup', { step: s.step, command: install, code: r.code, output: clip(r.output, 800) });
        this.observe({ kind: 'warning', step: s.step, text: `setup: ${install} (exit ${r.code})` });
        await this.evidence(s, 'setup', { ok: r.code === 0, text: `Installed dependencies with ${install}: exit ${r.code}\n${clip(r.output, 600)}` });
        if (r.code === 0) trial = await run();
      }
    }
    const answers = unusable ? null : await this.jev.decide(decisionState(s, { candidateCheck: { command, rationale: raw.rationale, trial }, repository }), checkQuestions(), { step: s.step, phase: 'check-inference' });
    const valid = answers?.valid?.type === 'noul' ? answers.valid.noul : 0;
    const accepted = !unusable && valid >= this.config.completeProbability;
    await this.store.log('check-inferred', { step: s.step, command, rationale: raw.rationale, unusable, trial, valid, accepted });
    this.observe({ kind: 'warning', step: s.step, text: accepted ? `verification inferred: ${command} (Jev ${valid.toFixed(2)})` : `verification candidate rejected: ${command} (${unusable ?? `Jev ${valid.toFixed(2)}`})` });
    if (!accepted) return false;
    // From here on this command is the verification, exactly as a configured one would be.
    s.lastCheckCommand = command; s.pendingCheck = true; this.tools.config.checkCommand = command;
    return true;
  }
  // A file to create is prompted from the design: what it must contain, the
  // conventions, and the exports of the files near it that it may import.
  private async createMessages(s: Session, path: string, d: Deliverable): Promise<Message[]> {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const related: { path: string; exports: string[] }[] = [];
    for (const f of [...s.writes, ...s.knownFiles].filter(f => f !== path && /\.[cm]?[jt]sx?$/.test(f) && (dir === '' || f.startsWith(dir.split('/')[0]!))).slice(0, 12)) {
      try { const text = await readFile(await safePath(this.tools.root, f), 'utf8'); const decls = await topLevelDeclarations(f, text); const exports = [...decls].filter(([, v]) => v.exported).map(([n]) => n).slice(0, 12); if (exports.length) related.push({ path: f, exports }); } catch { /* skip */ }
    }
    return focusedCreateMessages(s, path, d, related);
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
    for (const file of new Set([...Object.keys(fixes.addImports), ...Object.keys(fixes.addExportAtLines), ...Object.keys(fixes.removeImports), ...Object.keys(fixes.aliasImports)])) {
      // Export fixes land in the declaring file, which may be one the session never
      // touched; those stay listed for the worker but are not applied unasked.
      if (!s.writes.some(w => w === file || w.endsWith(`/${file}`) || file.endsWith(`/${w}`))) continue;
      const key = hash(JSON.stringify({ i: fixes.addImports[file] ?? [], e: fixes.addExportAtLines[file] ?? [], r: fixes.removeImports[file] ?? [], a: fixes.aliasImports[file] ?? [] }));
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
    // The edits just reverted are now known-bad: the same edit content will not be accepted again.
    const rejected = s.transaction.filter(t => t.paths.some(p => p in files) || !t.paths.length).map(t => ({ ...t, undoneAt: s.step, reason }));
    s.editEvidence = s.editEvidence.filter(e => !rejected.some(r => r.step === e.step));
    s.rejectedEdits = [...s.rejectedEdits, ...rejected].slice(-20);
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
        if (s.pendingCheck && s.lastCheckCommand && this.config.allowBash) {
          s.pendingCheck = false;
          await this.forced(s, 'bash', { command: s.lastCheckCommand, purpose: 'Verification after the last edit; re-running the check command.' }, 'auto-check');
          await this.store.save(s);
          continue;
        }
        // Resolved fixes after a failing check; the plan's remaining targets after any check.
        // Verification is inferred after edits; later attempts wait for the change set to grow.
        if (!s.lastCheckCommand && this.config.allowBash && s.writes.length && s.checkInferences < 6 && (s.checkInferredFor < 0 || s.writes.length - s.checkInferredFor >= (s.checkInferences < 2 ? 1 : 3)) && await this.inferCheck(s)) { await this.store.save(s); continue; }
        if ((s.pendingMoves.length || (s.lastCheck && !s.lastCheck.ok)) && this.config.allowWrite && await this.autoFix(s)) { await this.store.save(s); continue; }
        if (s.lastCheck && !s.lastCheck.ok && s.focusReadAt !== s.lastCheck.step) {
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
        const readyNow = Boolean(s.lastCheck?.ok && s.editEvidence.length && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck && !s.autoUndo
          && staleFor(s).length === 0 && !s.missingNames.length && !s.pendingMoves.length && !s.ledger.some(d => d.status === 'pending' && d.kind === 'move' && !d.optional) && s.finishTriedAtCheck !== s.lastCheck.step);
        let route: Route | null = null; let harnessNote: string | undefined; let needsUser: number | null = null;
        let target: { path: string; start: number; end: number } | null = null; let createTarget: { path: string; deliverable: Deliverable } | null = null;
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
          else if (d.kind === 'implement' && d.target?.deliverable) {
            const dl = d.target.deliverable;
            route = dl.kind === 'move' ? 'move_lines' : dl.kind === 'create' ? 'write' : 'replace_lines';
            harnessNote = `Work on deliverable ${dl.id} only: ${dl.kind} ${dl.name ?? ''}${dl.from ? ` from ${dl.from}` : ''}${dl.to ? ` to ${dl.to}` : ''}. ${dl.detail}${dl.note ? ` Current status: ${dl.note}.` : ''} Produce the single ${route} action that advances it.`;
            const p = route === 'replace_lines' ? (ledgerFile(s, dl.to ?? dl.from) ?? null) : null;
            if (p && s.knownFiles.includes(p)) target = { path: p, start: 1, end: 250 };
            if (route === 'write' && dl.kind === 'create') { const path = dl.to ?? dl.name ?? ''; if (path) { createTarget = { path, deliverable: dl }; target = { path, start: 1, end: 1 }; } }
          } else if (d.kind === 'fix' && d.target?.path) {
            route = 'replace_lines';
            const v = s.lastCheck ? Object.entries(s.lastCheck.summary.byFile).find(([f]) => d.target!.path!.endsWith(f) || f.endsWith(d.target!.path!))?.[1] : undefined;
            harnessNote = `Fix the verification errors in ${d.target.path} at lines ${(v?.lines ?? []).join(', ')}: ${(v?.samples ?? []).join(' | ')}. Edit only those lines.`;
            const lines = v?.lines ?? []; target = { path: d.target.path, start: lines.length ? Math.max(1, Math.min(...lines) - 25) : 1, end: lines.length ? Math.max(...lines) + 40 : 250 };
          }
          // A line edit needs the file as it is now: read it first, and re-decide next step.
          if (target && route === 'replace_lines' && s.readHashes[target.path] !== s.hashes[target.path]) {
            await this.forced(s, 'read_files', { files: [{ path: target.path, start: target.start, end: target.end }] }, 'decided-read');
            await this.store.save(s); continue;
          }
          if (decision.stuck >= .8 && route && editRoutes.includes(route)) harnessNote = `${harnessNote ?? ''} The last attempts did not work; take a different approach than before.`.trim();
          if (route && (editRoutes.includes(route) || route === 'finish') && s.phase === 'inspect') s.phase = 'implement';
        }
        const questions = routeQuestions(s, this.config);
        // A passing check after edits, with nothing pending, is the moment to propose
        // completion: the audit judges the proposal, so the harness makes it once per
        // check rather than leaving the worker to read until it feels ready.
        const readyToFinish = Boolean(s.lastCheck?.ok && s.editEvidence.length && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck && !s.autoUndo
          && staleFor(s).length === 0 && !s.missingNames.length && !s.pendingMoves.length && !s.ledger.some(d => d.status === 'pending' && d.kind === 'move') && s.finishTriedAtCheck !== s.lastCheck.step && 'finish' in (questions.route as { criteria: Record<string, string> }).criteria);
        if (readyToFinish) s.finishTriedAtCheck = s.lastCheck!.step;
        const decided = route !== null;
        const jevStarted = performance.now();
        const state = decided ? null : decisionState(s);
        const answers: Answers = decided ? { route: { type: 'choice', choice: route!, confidence: 1, probabilities: { [route!]: 1 } } } : await this.jev.decide(state, questions, { step: s.step, phase: 'routing-and-context' });
        if (readyToFinish) { answers.route = { type: 'choice', choice: 'finish', confidence: 1, probabilities: { finish: 1 } }; await this.store.log('auto-finish', { step: s.step, check: s.lastCheck!.step }); }
        if (!decided) this.observe({ kind: 'jev', step: s.step, ms: performance.now() - jevStarted, questions: Object.keys(questions).length, stateBytes: Buffer.byteLength(JSON.stringify(state)),
          route: answers.route?.type === 'choice' ? Object.entries(answers.route.probabilities).sort((a, b) => b[1] - a[1]) : [],
          nouls: Object.fromEntries(Object.entries(answers).filter(([, a]) => a.type === 'noul').map(([k, a]) => [k, (a as { noul: number }).noul])) });
        const criteria = (questions.route as { criteria: Record<string, string> }).criteria;
        const routeAnswer = answers.route;
        if (!route) route = confidentChoice(routeAnswer, this.config) as Route | null;
        // finish proposes a summary, not completion. Audit that concrete proposal
        // below instead of redirecting a finish vote into unrelated inspections.
        if (!decided && (!route || !Object.hasOwn(criteria, route)) && routeAnswer?.type === 'choice') {
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
              const preference = ['replace_lines', 'write', 'move_lines', 'bash', 'read_files', 'search_codebase', 'tasks', 'finish', 'ask_user'];
              const top = Object.entries(again.route.probabilities).sort((a, b) => (b[1] - a[1]) || (preference.indexOf(a[0]) - preference.indexOf(b[0])))[0]!;
              if (top[1] >= this.config.routeProbability * .5 && Object.hasOwn(criteria, top[0])) {
                route = top[0] as Route;
                await this.store.log('tie-break', { step: s.step, route, probabilities: again.route.probabilities, rule: 'edit > check > read > search' });
              }
            }
          }
        }
        if (!route || (!decided && !Object.hasOwn(criteria, route)))
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
        let prompt = focusedTarget ? focusedMessages(s, route, focusedTarget) : createTarget ? await this.createMessages(s, createTarget.path, createTarget.deliverable) : messages(s, route, harnessNote, currentSource);
        let counted = await this.bonsai.count(prompt);
        let forced = 0;
        while (counted.tokens > this.config.workingTokens) {
          if (!evictOne(s)) throw new Error('Pinned objective, instructions and ledger exceed working context; reduce them or increase workingTokens');
          forced++;
          prompt = messages(s, route, undefined, currentSource); counted = await this.bonsai.count(prompt);
        }
        if (forced) { s.lastCompact = s.step; await this.store.log('compact', { step: s.step, removed: forced, reason: 'hard-budget' }); }
        s.lastPromptTokens = counted.tokens;
        this.observe({ kind: 'route', step: s.step, route, tokens: counted.tokens, entries: s.entries.length });
        let args: Record<string, any>;
        // When edits are withheld until a verification runs and Jev routes to bash,
        // the required command is already known: run it, do not ask the worker to
        // guess one (it reaches for greps, which never count as the check).
        const autoCheck = route === 'bash' && s.editsSinceCheck >= 3 && s.lastCheckCommand;
        if (!autoCheck) await this.logPrompt(s, route, prompt, counted.tokens, 1);
        try {
          if (autoCheck) {
            args = { command: s.lastCheckCommand, purpose: 'Required verification after edits; re-running the last check command.' };
            this.observe({ kind: 'generated', step: s.step, route, meta: null, args });
            await this.store.log('auto-check', { step: s.step, command: s.lastCheckCommand });
          } else {
          args = await this.bonsai.generate(prompt, schemas[route], .2, { step: s.step, route });
          this.observe({ kind: 'generated', step: s.step, route, meta: this.bonsai.lastMeta ?? null, args });
          // An action already executed in this session yields nothing new: record a
          // generation failure naming the earlier result and let Jev route again.
          // A repeat is pointless only while its result is still in evidence; once
          // compaction has evicted that entry, re-running is how the model gets it back.
          // A search whose query is already in the pinned digest has its answer
          // in the prompt whatever happened to the entry.
          const searchKey = (a: Record<string, any>) => `${a.mode}:${a.query} in ${a.path}`;
          // Reads and searches are keyed with the current file hashes: after an
          // edit, the same read is a new action, not a repeat.
          const actionKey = (a: Record<string, any>) => Runner.actionKey(s, route, a);
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
          if (target && editRoutes.includes(route) && typeof args.path === 'string' && !(args.path === target.path || args.path.endsWith(`/${target.path}`) || target.path.endsWith(`/${args.path}`)))
            throw new Error(`The decided action is an edit of ${target.path}; the generated arguments edit ${args.path} instead. Produce the ${route} for ${target.path} only.`);
          if (route === 'move_lines' && s.ledger.length) { const why = await this.moveOutsideLedger(s, args); if (why) throw new Error(why); }
          // The worker may not hand a decision to the user that Jev judged the task does not need.
          if (route === 'ask_user' && needsUser !== null && needsUser < .5) throw new Error(`ask_user refused: the task does not need the user (judged ${needsUser.toFixed(2)}). Decide it yourself from the objective and the deliverables: ${clip(String(args.question ?? ''), 200)}`);
          if (route === 'bash' && typeof args.command === 'string' && readOnlyCommand(args.command) && s.inspectionsSinceAction >= 4 && (s.ledger.length || Object.keys(s.readHashes).length))
            throw new Error(`Read-only command refused: ${s.inspectionsSinceAction} inspections have run since the last action and the evidence already holds these files. Edit, run the build or tests, or finish.`);
          if (route === 'move_lines' && typeof args.destination === 'string' && args.destinationHash === 'new') {
            const anchored = await anchorPath(this.tools.root, ledgerFile(s, args.source) ?? args.source, args.destination);
            if (anchored !== args.destination) { await this.store.log('anchored-path', { step: s.step, from: args.destination, to: anchored }); args = { ...args, destination: anchored }; }
          }
          generationFailures = 0;
        } catch (e) {
          // Two failures in a row on one route: keep the session going by taking
          // that route off the table for the next decision, so Jev picks another
          // way forward. Four in a row means the worker cannot act on this state.
          if (++generationFailures >= 4) throw e;
          if (generationFailures >= 2) s.blockedRoute = route;
          this.observe({ kind: 'generation_error', step: s.step, message: (e as Error).message });
          await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${(e as Error).message}` });
          await this.store.save(s);
          continue;
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
          const base = (extra: Record<string, unknown>) => decisionState(s, { tasks: 'omitted: task entries are worker claims, not evidence', editEvidence: [], evidence: [], currentSource, lastCheck: s.lastCheck && { step: s.lastCheck.step, ok: s.lastCheck.ok, errors: s.lastCheck.summary.errors }, ...extra });
          const baseBytes = Buffer.byteLength(JSON.stringify(base({})));
          const evidence = await completionEvidence(this.tools.root, s, diff);
          const changedFiles = diff.files.map(f => f.path);
          const implemented: Record<string, number> = {}; let outOfScope = 0; let objectiveMet: number | null = null;
          const diffSummary = clip(diff.files.map(f => `${f.path}${f.created ? ' (created)' : ''}: +${f.declarationsAdded.length}/-${f.declarationsRemoved.length} declarations, +${f.importsAdded.length}/-${f.importsRemoved.length} imports${f.hunks ? `\n${clip(f.hunks, 700)}` : ''}`).join('\n'), 6000);
          // Chunk by deliverable when the evidence would exceed Jev's budget; each call carries only its items' evidence.
          const groups: Deliverable[][] = []; let group: Deliverable[] = []; let bytes = 0;
          for (const d of s.ledger) { const size = Buffer.byteLength(evidence[d.id] ?? '') + 200; if (bytes + size > 14000 && group.length) { groups.push(group); group = []; bytes = 0; } group.push(d); bytes += size; }
          if (group.length || !groups.length) groups.push(group);
          const perItem: Record<string, { supports: number; contradicts: number; saysNothing: number }> = {}; const unmet: string[] = [];
          for (const [i, items] of groups.entries()) {
            const state = completionState(s, Object.fromEntries(items.map(d => [d.id, evidence[d.id] ?? ''])), changedFiles, currentSource, diffSummary);
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
            s.completionFeedback = { step: s.step, text: clip(feedback, 1500), awaitingEvidence: true };
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
        // A blocked route stays off the table until some other action succeeds.
        if (result.ok && route !== s.blockedRoute) s.blockedRoute = null;
        // The same tool error twice in a row on an edit route means the worker is
        // not reading the refusal: take the route away until another action lands.
        if (!result.ok && editRoutes.includes(route)) {
          const message = result.text.slice(0, 120);
          if (s.lastToolError && s.lastToolError.route === route && s.lastToolError.message === message && s.lastToolError.step === s.step - 1) {
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
        // off the table until another action succeeds, as for generation failures.
        if (repeats === 3) s.blockedRoute = route;
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
