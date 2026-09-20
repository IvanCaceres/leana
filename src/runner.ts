import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bonsai, Jev } from './clients.js';
import { checkDelta, clip, compactNames, confidentChoice, decisionState, evictOne, mergeCoverage, messages, routeQuestions } from './context.js';
import { schemas } from './schema.js';
import { hash, importInsertLine, listRepoFiles, regression, resolveMissingNames, safePath, StaleWriteError, summarizeCheck, ToolBox } from './tools.js';
import { Store } from './store.js';
import { editRoutes } from './types.js';
import type { Config, GenerationMeta, Message, Phase, Route, Session, Task, ToolResult } from './types.js';
import { lineObserver, type ProgressEvent } from './display.js';

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000) throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try { instructions = await readFile(join(root, 'AGENTS.md'), 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(instructions) > 12000) throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return { version: 1, root, objective, instructions, step: 0, tasks: [], focus: null, entries: [],
    lastCompact: -100, status: 'running', stopReason: '', writes: [], lastWriteStep: -1, lastCheckStep: -1,
    phase: 'inspect', knownFiles: await listRepoFiles(root), inspectionCount: 0, lastError: null,
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
    s.entries.push({ id: `e${s.step}`, step: s.step, kind, artifact, text: clip(result.text, limit), relevance: result.ok ? .5 : .9 });
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
    if (result.changed?.length) { s.editsSinceCheck++; s.pendingCheck = Boolean(s.lastCheckCommand); }
    if ((kind === 'read_files' || kind === 'search_codebase') && result.ok) s.inspectionsSinceAction++;
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
      s.lastCheck = { step: s.step, ok: result.ok, text: clip(result.text, 1500), summary: summarizeCheck(result.text) };
      s.pendingCheck = false;
      // The edits since the previous check are now judged by this one. An
      // objective regression is rolled back deterministically; a small increase
      // is put to Jev; an improvement or a pass is committed silently.
      const scope = { files: [...new Set([...s.transaction.flatMap(t => t.paths), ...Object.keys(s.editSnapshots)])], structural: s.transaction.some(t => t.route === 'move_lines') };
      const verdict = (s.transaction.length || Object.keys(s.editSnapshots).length) && !result.ok ? regression(s.previousCheck?.summary ?? null, s.lastCheck.summary, scope) : 'fine';
      s.autoUndo = verdict === 'worse' ? { files: { ...s.editSnapshots }, reason: clip(`the check went from ${s.previousCheck?.summary.errors ?? 0} errors (${s.previousCheck?.summary.syntax ?? 0} syntax) to ${s.lastCheck.summary.errors} (${s.lastCheck.summary.syntax} syntax) in scope ${scope.files.join(', ')}; first new: ${Object.entries(s.lastCheck.summary.byFile).find(([f]) => scope.files.some(p => f.endsWith(p) || p.endsWith(f)))?.[1].samples[0] ?? ''}`, 300) } : null;
      s.editSnapshots = {};
      // Anything not rolled back is committed: the transaction is closed.
      if (verdict === 'fine') s.transaction = [];
      // Resolve every name the check cannot find, so the fix is a known import line.
      let output = result.text; try { output = JSON.parse(result.text).output ?? result.text; } catch { /* plain text */ }
      s.missingNames = result.ok ? [] : await resolveMissingNames(this.tools.root, output, s.writes).catch(() => []);
    }
    for (const [path, artifact] of Object.entries(result.snapshots ?? {})) if (!(path in s.editSnapshots)) s.editSnapshots[path] = artifact;
    // A failing check ends verification; a failing baseline during inspection
    // is context, not a reason to start editing before the code has been read.
    if (!result.ok && s.phase === 'verify' && (kind === 'bash' || editRoutes.includes(kind as Route))) s.phase = 'implement';
    // Unbounded history lives in artifacts; the decision surface is strictly bounded.
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
  private async autoFix(s: Session): Promise<boolean> {
    // Only errors reported in files this session edits are the harness's to fix;
    // a failing baseline in untouched files is context, not a work order.
    const own = s.missingNames.filter(n => s.writes.some(w => w === n.inFile || w.endsWith(`/${n.inFile}`) || n.inFile.endsWith(`/${w}`)));
    const fixes = compactNames(s, 60, own);
    // One file per step, so the check runs between files and each fix is judged alone.
    for (const file of new Set([...Object.keys(fixes.addImports), ...Object.keys(fixes.addExportAtLines)])) {
      const key = hash(JSON.stringify({ i: fixes.addImports[file] ?? [], e: fixes.addExportAtLines[file] ?? [] }));
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
      if (!edits.length) continue;
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
    // A declared check is the verification: baseline it before any edit.
    if (this.config.checkCommand) { s.lastCheckCommand = this.config.checkCommand; if (!s.lastCheck) s.pendingCheck = true; }
    const endStep = s.step + this.config.maxSteps;
    let generationFailures = 0;
    let rejectedFinishes = 0;
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
        if (s.lastCheck && !s.lastCheck.ok && this.config.allowWrite && await this.autoFix(s)) { await this.store.save(s); continue; }
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
        const questions = routeQuestions(s, this.config);
        const jevStarted = performance.now();
        const state = decisionState(s);
        const answers = await this.jev.decide(state, questions, { step: s.step, phase: 'routing-and-context' });
        this.observe({ kind: 'jev', step: s.step, ms: performance.now() - jevStarted, questions: Object.keys(questions).length, stateBytes: Buffer.byteLength(JSON.stringify(state)),
          route: answers.route?.type === 'choice' ? Object.entries(answers.route.probabilities).sort((a, b) => b[1] - a[1]) : [],
          nouls: Object.fromEntries(Object.entries(answers).filter(([, a]) => a.type === 'noul').map(([k, a]) => [k, (a as { noul: number }).noul])) });
        const criteria = (questions.route as { criteria: Record<string, string> }).criteria;
        let routeAnswer = answers.route;
        let route = confidentChoice(routeAnswer, this.config) as Route | null;
        const completeOk = answers.complete?.type === 'noul' && answers.complete.noul >= this.config.completeProbability;
        if (route === 'finish' && !completeOk) {
          // Jev's completion estimate contradicts its route. Withdraw finish and
          // let it pick the next action instead of pausing the whole session.
          delete criteria.finish;
          const finishWithheld = `Completion probability ${answers.complete?.type === 'noul' ? answers.complete.noul : 0} is below ${this.config.completeProbability}. Choose the action that produces the evidence still missing for the objective.`;
          const again = await this.jev.decide(decisionState(s, { finishWithheld }), { route: questions.route! }, { step: s.step, phase: 'routing-without-finish' });
          routeAnswer = again.route; route = confidentChoice(routeAnswer, this.config) as Route | null;
        }
        if ((!route || !Object.hasOwn(criteria, route)) && routeAnswer?.type === 'choice') {
          // Probability spread thinly over many options is not the same as not
          // knowing. Re-ask among the leading candidates before pausing.
          const leading = Object.entries(routeAnswer.probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k).filter(k => Object.hasOwn(criteria, k)).slice(0, 2);
          if (leading.length === 2) {
            const narrowed = { ...questions.route!, criteria: Object.fromEntries(leading.map(k => [k, criteria[k]!])) };
            const again = await this.jev.decide(decisionState(s, { routingNarrowed: `Routing among ${Object.keys(criteria).length} actions was uncertain; choose among the leading candidates.` }),
              { route: narrowed }, { step: s.step, phase: 'routing-narrowed' });
            route = confidentChoice(again.route, this.config) as Route | null;
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
        if (!route || !Object.hasOwn(criteria, route))
          throw new Error('Jev route is uncertain; paused without executing an action');
        // The worker can batch related writes. Only enter verify after it has
        // selected the validation action, so a stale readiness judgement never
        // turns a write into an implementation action in the verify phase.
        if (phase === 'implement' && route === 'bash' && s.writes.length > 0 &&
          answers.ready_for_verify?.type === 'noul' && answers.ready_for_verify.noul >= .8)
          s.phase = 'verify';
        // Further edits after a passing check mean the implementation is not done.
        if (phase === 'verify' && (editRoutes.includes(route) || route === 'read_files')) s.phase = 'implement';
        let prompt = messages(s, route);
        let counted = await this.bonsai.count(prompt);
        let forced = 0;
        while (counted.tokens > this.config.workingTokens) {
          if (!evictOne(s)) throw new Error('Pinned objective, instructions and ledger exceed working context; reduce them or increase workingTokens');
          forced++;
          prompt = messages(s, route); counted = await this.bonsai.count(prompt);
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
          // The summary is a worker claim. Only tool evidence and the harness's
          // own changed-file record may support it; the task ledger is excluded
          // because Bonsai writes both and can mark work done that never happened.
          const check = await this.jev.decide(decisionState(s, { tasks: 'omitted: task entries are worker claims, not evidence', proposedSummary: args.summary }), {
            supported: { type: 'noul', instructions: 'Is every claim in proposedSummary established by the supplied tool evidence and changedFiles? Answer no if any claimed file change, import, extraction, or verification has no matching tool result, or if changedFiles lacks a file the objective requires to change.' },
          }, { step: s.step, phase: 'completion-check' });
          const supported = check.supported?.type === 'noul' ? check.supported.noul : 0;
          if (supported < this.config.completeProbability) {
            await this.store.log('action', { step: s.step, route, args, rejected: true, supported });
            if (++rejectedFinishes >= 2) throw new Error('Completion summary was not supported by tool evidence twice; paused for review');
            await this.evidence(s, 'finish_rejected', { ok: false, text: `Completion rejected: the summary claims work the tool evidence does not establish (P(supported)=${supported}). Produce the missing change or verification before finishing. Summary: ${args.summary}` });
            await this.store.save(s);
            continue;
          }
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
        await this.evidence(s, route, result, args);
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
