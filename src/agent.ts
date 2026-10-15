// The orient-reason-act loop. Code orients (facts about the repository and the
// machine), the worker reasons and takes one action per step, the harness
// executes it, verifies what it can and shows the result; Jev surrounds the
// loop as a control plane: it watches for progress, triages failures, ranks
// retrieval, and gates completion claims. Nothing here decides how to
// implement anything.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Answers, Config, EditAttempt, Entry, Message, Questions, Route, Session, ToolResult } from './types.js';
import { editRoutes } from './types.js';
import { liveHeight, partialJson, tailLines, type ProgressEvent } from './display.js';
import { Store } from './store.js';
import { ToolBox } from './tools.js';
import { boundedRead, hash, listRepoFiles, safePath, treeChanges, treeSnapshot, TreeHashes } from './files.js';
import { droppedLines } from './edit-checks.js';
import { repositoryStatus, sourceHashes, summarizeCheck } from './repository.js';
import { runCommand } from './commands.js';
import {
  breakIndex,
  clip,
  clipEnds,
  lineDiff,
  evictBehind,
  evictOne,
  evictStaleBehind,
  evidenceTokens,
  turnEntry,
  fenceFor,
  regionMessages,
  trimContext,
  mergeCoverage,
  rememberEdit,
  retireEvidence,
  stepMessages,
  newFileMessages,
  shownLines,
  lineRanges,
  volatile,
  type FileContract,
} from './context.js';
import { pinReferences, referenceContext } from './references.js';
import { extractCode, schemas, stepSchema, actions, validate, withDefaults, toolSchema } from './schema.js';
import {
  generationFacts,
  missingRelativeModules,
  parseFact,
  parseInProcess,
  detectProjects,
  importSpelling,
  inProject,
  projectFor,
  shellPrefixFor,
  signaturesFor,
  sourceFile,
  undeclaredPackages,
  unresolvedImports,
  type Project,
} from './profiles.js';
import { orient } from './orient.js';
import { observeResult, observerFor } from './observe.js';
import {
  answerGate,
  evidenceGate,
  rankExcerpts,
  relevance,
  triage,
  watchdog,
  type AnswerCoverage,
  type GateVerdict,
  type Jev as JevLike,
} from './control.js';
import type { Around, Bonsai, Echo, GenerationCut, StreamProgress } from './clients.js';
import { repeatCut } from './clients.js';
// A worker's turn: its reasoning and the ordered actions it named (problem: what is wrong with the call itself).
type Batch = { action: Route; args: Record<string, any>; problem?: string }[];
interface Turn {
  thought: string;
  batch: Batch;
}
// An invocation's budget: turns under the tools form (maxTurns), else steps (endStep); failures counts the
// generations and actions in a row that could not run.
interface RunBudget {
  maxTurns: number;
  endStep: number;
  turns: number;
  failures: number;
}
// What running one action came to.
type Outcome = 'ok' | 'failed' | 'refused' | 'stop';
type WatchReading = NonNullable<Session['watch']>['readings'][number];
// A turn's thought as it is compared for repeats: its whitespace collapsed.
const saidIn = (e: { text: string }) =>
  String(JSON.parse(e.text).thought ?? '')
    .replace(/\s+/g, ' ')
    .trim();

// A repository file's text, or null when it cannot be read: missing (the worker
// may delete any file it wrote), outside the root, or not text. Never throws.
// A session's ending that quotes the worker's summary (or notes): clipped in the stop reason the
// model reads back on resume, whole in the outcome the user reads.
function ending(s: Session, prefix: string, text: string, limit: number): void {
  s.stopReason = `${prefix}${clip(text, limit)}`;
  s.outcome = `${prefix}${text}`;
}
// What an answer rests on: the evidence the worker gathered (reads, searches, commands, observations)
// still in its working set, newest first within a budget that keeps Jev's packet under its cap.
function answerEvidence(s: Session, budget = 14000): Record<string, string> {
  const out: [string, string][] = [];
  for (const e of [...s.entries].reverse()) {
    if (!['read_files', 'search_codebase', 'bash', 'observe'].includes(e.kind)) continue;
    const text = clip(e.text, 1500);
    if (text.length > budget) break;
    out.unshift([`${e.id} ${e.kind} (step ${e.step})`, text]);
    budget -= text.length;
  }
  return Object.fromEntries(out);
}
// What an answer covered, from the reads the session recorded: each file and how much of it, and the
// repository's files (git's, else the tree's) never read.
async function answerCoverage(s: Session): Promise<AnswerCoverage> {
  const tracked = await runCommand('git', ['ls-files'], s.root, 10000).catch(() => null);
  const files =
    tracked?.code === 0
      ? tracked.output
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
      : await listRepoFiles(s.root).catch(() => [] as string[]);
  const read: Record<string, string> = {};
  for (const [p, c] of Object.entries(s.coverage).sort(([a], [b]) => a.localeCompare(b))) {
    const lines = c.ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
    read[p] =
      lines >= c.total
        ? `whole (${c.total} lines)`
        : `lines ${c.ranges.map(([a, b]) => `${a}-${b}`).join(', ')} of ${c.total}`;
  }
  return { read, unread: files.filter(f => !(f in read)), files: files.length };
}
const readIfPresent = (root: string, path: string): Promise<string | null> =>
  safePath(root, path)
    .then(f => readFile(f, 'utf8'))
    .catch(() => null);

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000)
    throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try {
    instructions = await readFile(join(root, 'AGENTS.md'), 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (Buffer.byteLength(instructions) > 12000)
    throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return {
    version: 1,
    root,
    objective,
    instructions,
    step: 0,
    tasks: [],
    focus: null,
    entries: [],
    lastCompact: -100,
    status: 'running',
    stopReason: '',
    writes: [],
    lastWriteStep: -1,
    lastCheckStep: -1,
    phase: 'implement',
    knownFiles: await listRepoFiles(root),
    inspectionCount: 0,
    lastError: null,
    editEvidence: [],
    referenceEvidence: [],
    completionFeedback: null,
    finishTriedAtCheck: -1,
    lastToolError: null,
    ledger: [],
    design: null,
    ledgerAttempts: 0,
    ledgerBuilt: true,
    ledgerComplete: 0,
    baselineArtifacts: {},
    checkInferences: 0,
    checkInferredFor: -1,
    setupDone: false,
    baselineStatus: null,
    lastRoute: null,
    lastResultOk: false,
    lastWriteStale: false,
    repetitions: {},
    coverage: {},
    hashes: {},
    lastPromptTokens: 0,
    lastCheck: null,
    previousCheck: null,
    editSnapshots: {},
    transaction: [],
    rejectedEdits: [],
    lastCheckCommand: null,
    autoUndo: null,
    inspectionsSinceAction: 0,
    coverageByHash: {},
    repetitionSteps: {},
    focusReadAt: -1,
    autoFixKeys: {},
    actions: {},
    searches: {},
    blockedRoute: null,
    editsSinceCheck: 0,
    readHashes: {},
    writeSteps: {},
    pendingRepairs: [],
    notes: '',
    watch: { noProgress: 0, readings: [], escalations: 0 },
    blockedActions: [],
  };
}

// The model client: llama-server's (Bonsai) or OpenRouter's, which make the same calls.
type BonsaiLike = Pick<Bonsai, 'count' | 'generate'> & {
  generateText?: Bonsai['generateText'];
  lastMeta?: Bonsai['lastMeta'] | null;
};
export class Agent {
  readonly tools: ToolBox;
  private current = 0;
  // Set by stop(): the run pauses before its next step (the step under way finishes; its result is kept).
  private stopRequested = false;
  stop(): void {
    this.stopRequested = true;
  }
  // The entries a harness statement being recorded names (see repeat): kept from supersession and eviction while it is the freshest entry.
  private citing: string[] = [];
  // Whether the last refusal was of a request already made (the same arguments on the same state), not a new fact.
  private duplicate = false;
  // The tree's content hashes by file signature: what a shell command did to a file's content, not only to its modification time.
  private treeHashes = new TreeHashes();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly jev: JevLike,
    readonly bonsai: BonsaiLike,
    root: string,
    readonly log: (line: string) => void,
    readonly observe: (e: ProgressEvent) => void,
  ) {
    this.tools = new ToolBox(root, store.artifacts, config, (path, text) => store.snapshot(this.current, path, text));
    this.tools.commandPrefix = () => shellPrefixFor(root);
    this.tools.parse = (path, text) =>
      parseInProcess(root, path, text).then(
        r => r ?? [],
        () => [],
      );
  }
  // A project's manifests' state: what its install was made from.
  private async manifestKey(p: Project): Promise<string> {
    return hash(
      (
        await Promise.all(p.eco.manifests.map(f => readFile(join(this.tools.root, p.dir, f), 'utf8').catch(() => '')))
      ).join('\u0000'),
    );
  }
  // What a command's output depends on in the repository: the last write and the installed set.
  static world(s: Session): string {
    return `${s.lastWriteStep}|${s.setupKey ?? ''}|${JSON.stringify(s.setupKeys ?? {})}`;
  }
  // exact keeps the file hash an edit carries: the key of these very arguments.
  static actionKey(s: Session, route: Route, args: Record<string, any>, exact = false): string {
    const hashes =
      route === 'read_files'
        ? (args.files as { path: string }[]).map(f => [f.path, s.hashes[f.path] ?? null]).sort()
        : route === 'search_codebase'
          ? Object.entries(s.hashes).sort()
          : undefined;
    return hash(
      JSON.stringify({
        route,
        args: exact ? args : { ...args, expectedHash: undefined, destinationHash: undefined },
        hashes,
      }),
    );
  }
  // The files an edit acts on.
  static targets(route: Route, args: Record<string, any>): string[] {
    return editRoutes.includes(route)
      ? [
          ...new Set(
            [args.path, args.source, args.destination].filter(
              (p): p is string => typeof p === 'string' && p.length > 0,
            ),
          ),
        ]
      : [];
  }
  // The successful edits recorded after `from` that take every one of its files from the
  // hash `from` left to the hash it has now, in order; null when something else changed them.
  static editsSince(
    s: Session,
    paths: string[],
    from: EditAttempt,
    now: Record<string, string | null>,
  ): EditAttempt[] | null {
    const out: EditAttempt[] = [];
    const at = { ...from.after };
    const later = Object.values(s.attempts ?? {})
      .filter(a => a.ok && a.step > from.step)
      .sort((x, y) => x.step - y.step);
    for (const a of later) {
      const touched = Object.keys(a.before).filter(p => paths.includes(p));
      if (!touched.length) continue;
      if (touched.some(p => a.before[p] !== at[p])) return null;
      for (const p of touched) at[p] = a.after[p] ?? null;
      out.push(a);
    }
    return paths.every(p => (at[p] ?? null) === (now[p] ?? null)) ? out : null;
  }
  private async diskHashes(paths: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(
      await Promise.all(
        paths.map(
          async p => [p, await readIfPresent(this.tools.root, p).then(t => (t === null ? null : hash(t)))] as const,
        ),
      ),
    );
  }
  // An action as the worker would recognise it: route, path, ranges or anchor.
  static describe(route: Route, a: Record<string, any>): string {
    const range = (x: { start?: number; end?: number }) =>
      x.end === (x.start ?? 0) - 1 ? `insert before ${x.start}` : `${x.start}..${x.end}`;
    if (route === 'replace_lines')
      return `replace_lines of ${a.path} (lines ${((a.edits as { start: number; end: number }[]) ?? []).map(range).join(', ')})`;
    if (route === 'write')
      return `write of ${a.path} (anchor ${JSON.stringify(clip(String(a.oldText ?? '').split('\n')[0] ?? '', 60))})`;
    if (route === 'move_lines') return `move_lines of ${a.source} lines ${a.start}..${a.end} to ${a.destination}`;
    if (route === 'create_file' || route === 'rewrite_file')
      return `${route} of ${a.path}${a.start !== undefined ? ` (lines ${a.start}..${a.end})` : ''}`;
    return route;
  }

  // ---- observation: what a tool result does to the session -----------------
  async evidence(s: Session, kind: string, result: ToolResult, args?: Record<string, any>): Promise<void> {
    const artifact = await this.store.artifact(s.step, result.text);
    const limit =
      kind === 'repeat'
        ? result.text.length
        : kind === 'read_files' || kind === 'observe'
          ? this.config.toolChars
          : kind === 'bash'
            ? Math.min(this.config.toolChars, 2500)
            : kind === 'search_codebase'
              ? Math.min(this.config.toolChars, 1500)
              : Math.min(this.config.toolChars, 600);
    if (kind === 'read_files' && result.ok && args) {
      for (const f of args.files as { path: string; start: number }[])
        for (const e of s.entries)
          if (
            e.kind === 'read_files' &&
            !e.stale &&
            !this.citing.includes(e.id) &&
            new RegExp(
              `(^|\\n\\n)${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sha256=\\w+ totalLines=\\d+ shown=${f.start}\\.\\.`,
            ).test(e.text)
          )
            e.stale = `superseded by the read at step ${s.step}`;
    }
    s.entries.push({
      id: `e${s.step}`,
      step: s.step,
      kind,
      artifact,
      ...(s.currentTurn ? { turn: s.currentTurn } : {}),
      ...(this.citing.length ? { cites: [...this.citing] } : {}),
      text: clip(result.text, limit),
      relevance: result.ok ? 0.5 : 0.9,
      verification: result.verification,
    });
    if (result.ok && result.changed?.length && editRoutes.includes(kind as Route))
      rememberEdit(s, s.step, kind, result.changed, artifact, result.text, result.applied ?? args);
    if ((kind === 'read_files' || kind === 'search_codebase') && result.ok) s.inspectionCount++;
    if (kind === 'search_codebase' && result.ok && args) {
      let output = '';
      try {
        output = String(JSON.parse(result.text).output ?? '');
      } catch {
        output = result.text;
      }
      const lines = output.split('\n').filter(Boolean);
      const key = `${args.mode}:${args.query} in ${args.path}`;
      delete s.searches[key];
      s.searches[key] = output.startsWith('(no matches')
        ? '(no matches)'
        : lines
            .slice(0, 3)
            .map(l => clip(l, 100))
            .join(' | ') + (lines.length > 3 ? ` | +${lines.length - 3} more` : '');
      for (const old of Object.keys(s.searches).slice(0, -20)) delete s.searches[old];
    }
    if (kind === 'read_files' && result.ok) {
      for (const [path, h] of Object.entries(result.hashes ?? {})) s.readHashes[path] = h;
      for (const m of result.text.matchAll(/(?:^|\n\n)(\S+) sha256=(\w+) totalLines=(\d+) shown=(\d+)\.\.(\d+)/g))
        if (Number(m[5]) >= Number(m[4])) {
          s.coverage[m[1]!] = mergeCoverage(s.coverage[m[1]!], Number(m[3]), Number(m[4]), Number(m[5]));
          s.coverageByHash[`${m[1]}@${m[2]}`] = s.coverage[m[1]!]!;
        }
      for (const old of Object.keys(s.coverageByHash).slice(0, -40)) delete s.coverageByHash[old];
    }
    s.lastError = result.ok ? null : clip(result.text, 1500);
    for (const [path, h] of Object.entries(result.hashes ?? {})) {
      delete s.hashes[path];
      s.hashes[path] = h;
    }
    for (const stale of Object.keys(s.hashes).slice(0, -20)) delete s.hashes[stale];
    if (kind === 'bash' && typeof args?.command === 'string')
      (s.commandRuns ??= {})[args.command.trim()] = { step: s.step, ok: result.ok, world: Agent.world(s) };
    if (result.verification) {
      s.editsSinceCheck = 0;
      if (kind === 'bash' && args?.command) s.lastCheckCommand = args.command.trim();
    }
    if (
      s.completionFeedback &&
      !s.completionFeedback.addressed &&
      result.verification &&
      result.ok &&
      s.lastWriteStep > s.completionFeedback.step
    )
      s.completionFeedback = {
        ...s.completionFeedback,
        addressed: true,
        text: `The completion proposed at step ${s.completionFeedback.step} was rejected (${clip(s.completionFeedback.text, 200)}); edits and a passing verification have followed.`,
      };
    if (result.changed?.length) s.editsSinceCheck++;
    if (
      (kind === 'read_files' || kind === 'search_codebase' || (kind === 'bash' && !result.changed?.length)) &&
      result.ok
    )
      s.inspectionsSinceAction++;
    if (result.changed?.length || result.verification || kind === 'undo') s.inspectionsSinceAction = 0;
    for (const changed of result.changed ?? []) {
      if (!s.writes.includes(changed)) s.writes.push(changed);
      if (!s.knownFiles.includes(changed)) s.knownFiles.push(changed);
      s.lastWriteStep = s.step;
      s.writeSteps[changed] = s.step;
      delete s.coverage[changed];
      delete s.readHashes[changed];
      for (const key of Object.keys(s.searches)) {
        const at = key.slice(key.lastIndexOf(' in ') + 4);
        if (at === '.' || at === changed || changed.startsWith(at.replace(/\/?$/, '/'))) delete s.searches[key];
      }
      const header = `${changed} sha256=`;
      for (const e of s.entries)
        if (
          e.kind === 'read_files' &&
          e.step < s.step &&
          !e.stale &&
          (e.text.startsWith(header) || e.text.includes(`\n\n${header}`))
        )
          e.stale = `edited at step ${s.step}: text and line numbers no longer match ${changed}`;
    }
    if (result.check) s.lastCheckStep = s.step;
    if (result.verification) {
      s.previousCheck = s.lastCheck;
      let output = result.text;
      try {
        output = String(JSON.parse(result.text).output ?? result.text);
      } catch {
        /* plain text */
      }
      s.lastCheck = {
        step: s.step,
        ok: result.ok,
        text: clipEnds(output, 1500),
        summary: await summarizeCheck(result.text, s.root, [...s.writes, ...s.knownFiles]),
        fileHashes: await sourceHashes(s.root, s.writes),
        ...(kind === 'bash' && typeof args?.command === 'string' ? { command: args.command.trim() } : {}),
      };
      if (result.ok)
        s.lastPassedCheck = { step: s.step, ...(s.lastCheck.command ? { command: s.lastCheck.command } : {}) };
      if (!result.ok) {
        // Every line the output names, in every file it names, as the file reads now (read
        // as read_files and the edits read it, so its sha256 is the hash an edit carries):
        // the context around each line narrows until the files fit, a long line is cut on
        // its own, and a file that still does not fit is named with its hash and lines.
        const named: [string, string, string[], number[]][] = [];
        for (const [p, at] of Object.entries(s.lastCheck.summary.files)) {
          const text = await safePath(s.root, p)
            .then(f => boundedRead(f))
            .catch(() => null);
          if (text === null) continue;
          const lines = text.split('\n');
          const ns = at.filter(n => n <= lines.length);
          if (ns.length) named.push([p, hash(text), lines, ns]);
        }
        const header = ([p, h, lines, ns]: (typeof named)[number]) =>
          `${p} sha256=${h} totalLines=${lines.length} (errors at ${ns.join(', ')})`;
        const listing = (f: (typeof named)[number], radius: number) => {
          const [, , lines, ns] = f;
          const keep = [
            ...new Set(
              ns
                .flatMap(n => Array.from({ length: 2 * radius + 1 }, (_, k) => n - radius + k))
                .filter(k => k >= 1 && k <= lines.length),
            ),
          ].sort((a, b) => a - b);
          return `${header(f)}:\n${keep.map((k, i) => `${i && k !== keep[i - 1]! + 1 ? '…\n' : ''}${k}: ${clip(lines[k - 1]!, 200)}`).join('\n')}`;
        };
        let sites = '';
        for (const radius of [4, 2, 1, 0]) {
          const shownFiles: string[] = [];
          const rest: string[] = [];
          let used = 0;
          for (const f of named) {
            const block = listing(f, radius);
            if (!rest.length && used + block.length + 1 <= 2400) {
              shownFiles.push(block);
              used += block.length + 1;
            } else rest.push(header(f));
          }
          sites = [
            ...shownFiles,
            ...(rest.length ? [`Also named by the check, not shown for room: ${rest.join('; ')}`] : []),
          ].join('\n');
          if (!rest.length) break;
        }
        if (sites) {
          const e = s.entries.at(-1);
          if (e) e.text += `\nSource at the errors:\n${sites}`;
        }
      }
      // How this run compares with the previous run of the same command: a fact for the worker, never a rollback.
      if (s.previousCheck?.summary.files && s.previousCheck.command === s.lastCheck.command) {
        const e = s.entries.at(-1);
        const was = s.previousCheck.summary;
        const now = s.lastCheck.summary;
        const before = Object.keys(was.files);
        const after = Object.keys(now.files);
        if (e && (was.code !== now.code || before.join('\n') !== after.join('\n')))
          e.text += `\nCompared with the previous run at step ${s.previousCheck.step}: exit code ${was.code} -> ${now.code}; files the output names: ${before.join(', ') || 'none'} -> ${after.join(', ') || 'none'}.`;
      }
    }
    for (const [path, artifact] of Object.entries(result.snapshots ?? {}))
      if (!(path in s.baselineArtifacts)) s.baselineArtifacts[path] = artifact;
    retireEvidence(s);
    // Eviction is batched: any removal invalidates the cached prefix after it, so
    // the evidence is let grow to a share of the working budget and then cut well
    // below it at once, which buys several steps of a stable prefix for one reprocessing.
    let evicted = 0;
    if (evidenceTokens(s) > this.config.workingTokens * evictAt) {
      const before = Agent.shape(s);
      while (evidenceTokens(s) > this.config.workingTokens * evictTo && evictOne(s)) evicted++;
      if (evicted) evicted += evictStaleBehind(s, breakIndex(before, s) ?? 0).length;
    }
    if (evicted)
      await this.store.log('compact', {
        step: s.step,
        removed: evicted,
        reason: 'evidence-share',
        retained: s.entries.length,
        trail: s.trail?.length ?? 0,
      });
  }
  // Execute an action, the worker's or the harness's, with the same bookkeeping.
  private async execute(s: Session, route: Route, args: Record<string, any>, kind: string): Promise<ToolResult> {
    if (kind !== 'action') await this.store.log(kind, { step: s.step, ...args });
    await this.store.log('action', { step: s.step, route, args, forced: kind.startsWith('auto') });
    const started = performance.now();
    let result: ToolResult;
    // What a shell command changed is read from the tree, never guessed from the command.
    const before = route === 'bash' ? await treeSnapshot(this.tools.root).catch(() => null) : null;
    // The content the command's files have before it runs (the check's writes are not edits; nothing is compared for it).
    if (before && args.check !== true) await this.treeHashes.fill(this.tools.root, before).catch(() => {});
    // The text an edit replaces, so a parse problem it leaves can be compared with the one it had.
    const replaced = new Map<string, string | null>();
    if (editRoutes.includes(route))
      for (const p of Agent.targets(route, args))
        replaced.set(p, await readIfPresent(this.tools.root, p).catch(() => null));
    this.tools.step = s.step;
    try {
      result = await this.tools.execute(route, args);
    } catch (e) {
      result = { ok: false, text: `Tool error: ${(e as Error).message}` };
    }
    if (route === 'bash') await this.commandEffects(s, args, result, before);
    // A written file that does not parse is a fact the worker sees at once, by the language's own tool.
    if (result.ok && editRoutes.includes(route) && result.changed?.length) {
      const facts = await this.parseFacts(result.changed, replaced);
      if (facts.length) result.text += `\nHarness: ${facts.join(' | ')}`;
    }
    s.lastRoute = route;
    s.lastResultOk = result.ok;
    await this.evidence(s, route, result, args);
    this.observe({
      kind: 'result',
      step: s.step,
      route,
      ok: result.ok,
      ms: performance.now() - started,
      chars: result.text.length,
      text: clip(result.text, 200),
    });
    await this.store.log('result', {
      step: s.step,
      ok: result.ok,
      ms: performance.now() - started,
      kind,
      artifact: s.entries.at(-1)?.artifact,
    });
    return result;
  }

  // Every file a command created, modified or deleted is an edit of this step,
  // except what the check of record writes (a build's output is not an edit it
  // must be run again for). The file list follows the tree either way.
  // A file the command wrote with the content it already had is not an edit (its
  // reads stand, nothing is due to run again for it) and is said to be one written
  // unchanged. A written file that does not parse is said as for an edit.
  private async commandEffects(
    s: Session,
    args: Record<string, any>,
    result: ToolResult,
    before: Awaited<ReturnType<typeof treeSnapshot>>,
  ): Promise<void> {
    const after = before ? await treeSnapshot(this.tools.root).catch(() => null) : null;
    if (!before || !after) {
      s.knownFiles = await listRepoFiles(s.root).catch(() => s.knownFiles);
      return;
    }
    const { changed: touched, created, deleted } = await treeChanges(this.tools.root, before, after);
    if (!touched.length) return;
    s.knownFiles = [
      ...s.knownFiles.filter(p => !deleted.includes(p)),
      ...created.filter(p => !s.knownFiles.includes(p)),
    ].sort();
    for (const p of deleted) {
      delete s.hashes[p];
      delete s.coverage[p];
      delete s.readHashes[p];
    }
    if (args.check === true) return;
    const modified = touched.filter(p => !created.includes(p) && !deleted.includes(p));
    const was = new Map(modified.map(p => [p, this.treeHashes.at(p, before.get(p))]));
    await this.treeHashes.fill(this.tools.root, new Map(modified.map(p => [p, after.get(p)!]))).catch(() => {});
    const size = (sig: string | undefined) => sig?.slice(0, sig.indexOf(':'));
    // Equal sizes too: the text hashed is decoded, and a byte-order mark is not part of it.
    const unchanged = modified.filter(
      p =>
        was.get(p) && size(before.get(p)) === size(after.get(p)) && this.treeHashes.at(p, after.get(p)) === was.get(p),
    );
    const changed = touched.filter(p => !unchanged.includes(p));
    const present = changed.filter(p => !deleted.includes(p));
    if (changed.length) {
      const now = await sourceHashes(s.root, present.slice(0, 40));
      result.changed = [...new Set([...(result.changed ?? []), ...changed])];
      result.hashes = {
        ...(result.hashes ?? {}),
        ...Object.fromEntries(Object.entries(now).filter(([, h]) => h !== 'unavailable')),
      };
      const counts = [
        created.length ? `created ${created.length}` : '',
        present.length - created.length ? `modified ${present.length - created.length}` : '',
        deleted.length ? `deleted ${deleted.length}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      result.text += `\nHarness: the command changed files (${counts}): ${clip(changed.slice(0, 30).join(', ') + (changed.length > 30 ? `, +${changed.length - 30} more` : ''), 900)}`;
      await this.store.log('bash-edit', {
        step: s.step,
        files: changed.slice(0, 200),
        command: clip(String(args.command ?? ''), 200),
      });
    }
    if (unchanged.length) {
      result.hashes = { ...(result.hashes ?? {}), ...Object.fromEntries(unchanged.map(p => [p, was.get(p)!])) };
      const one = unchanged.length === 1;
      // The hash where the session has one to compare it with (a file it read or wrote); the path alone otherwise.
      const seen = (p: string) => p in s.hashes || p in s.readHashes;
      result.text += `\nHarness: the command left ${one ? 'a file' : `${unchanged.length} files`} with the content ${one ? 'it' : 'they'} had before (the modification time changed, the content did not): ${clip(
        unchanged
          .slice(0, 30)
          .map(p => (seen(p) ? `${p} sha256=${was.get(p)}` : p))
          .join(', ') + (unchanged.length > 30 ? `, +${unchanged.length - 30} more` : ''),
        900,
      )}`;
      await this.store.log('bash-unchanged', {
        step: s.step,
        files: unchanged.slice(0, 200),
        command: clip(String(args.command ?? ''), 200),
      });
    }
    // What a shell command replaced is not kept (only its hash), so no problem is compared with one it had.
    const facts = await this.parseFacts([...present, ...unchanged].slice(0, 20), new Map());
    if (facts.length) result.text += `\nHarness: ${facts.join(' | ')}`;
  }
  // A written file that does not parse, by the language's own parser: a fact the worker sees at once,
  // with the problems the text it replaced (when known) had on the same lines.
  private async parseFacts(paths: string[], replaced: Map<string, string | null>): Promise<string[]> {
    const facts: string[] = [];
    for (const p of paths) {
      const text = await readIfPresent(this.tools.root, p);
      if (text === null) continue;
      const fact = await parseFact(this.tools.root, p, replaced.get(p) ?? null, text).catch(() => null);
      if (fact) facts.push(fact);
    }
    return facts;
  }

  // ---- installs: mechanics the worker cannot do for itself -----------------
  private async installDependencies(s: Session, p: Project, install: string): Promise<boolean> {
    const eco = p.eco;
    const id = `${eco.id}:${p.dir}`;
    s.setupDone = true;
    (s.setupKeys ??= {})[id] = await this.manifestKey(p);
    const attempt = async () => {
      const r = await runCommand(
        'bash',
        ['--noprofile', '--norc', '-o', 'pipefail', '-c', install],
        this.tools.root,
        Math.max(this.config.commandTimeoutMs, 300000),
      ).catch(e => ({ code: -1, output: String((e as Error).message), truncated: false, timedOut: false }));
      await this.store.log('setup', { step: s.step, command: install, code: r.code, output: clip(r.output, 800) });
      this.observe({ kind: 'warning', step: s.step, text: `setup: ${install} (exit ${r.code})` });
      await this.evidence(s, 'setup', {
        ok: r.code === 0,
        text: `Installed dependencies with ${install}: exit ${r.code}\n${clipEnds(r.output, 900)}`,
      });
      return r;
    };
    const errors = (s.setupErrors ??= {});
    let r = await attempt();
    if (r.code !== 0 && !s.autoFixKeys[`install-retry:${id}`]) {
      s.autoFixKeys[`install-retry:${id}`] = `step ${s.step}`;
      r = await attempt();
    }
    if (r.code === 0) {
      delete errors[id];
      s.setupKeys![id] = await this.manifestKey(p);
      s.knownFiles = await listRepoFiles(s.root).catch(() => s.knownFiles);
    } else {
      const facts = eco.installFacts
        ? await eco
            .installFacts(r.output, name =>
              eco.lookupLatest ? eco.lookupLatest(join(this.tools.root, p.dir), name) : Promise.resolve(null),
            )
            .catch(() => [] as string[])
        : [];
      errors[id] = clip(
        [p.dir === '.' ? '' : `in ${p.dir}:`, eco.errorLines(r.output), ...facts].filter(Boolean).join('\n'),
        700,
      );
    }
    s.setupError = Object.values(errors).join('\n') || null;
    return r.code === 0;
  }
  // Dependencies follow the manifests: each project's installed when its
  // manifest appears, again when it changes, once per manifest version.
  // Mechanics the worker should not spend turns discovering (a build that
  // cannot find its tools).
  private async retrySetup(s: Session): Promise<boolean> {
    const keys = (s.setupKeys ??= {});
    let ran = false;
    for (const p of await detectProjects(this.tools.root).catch(() => [] as Project[])) {
      const id = `${p.eco.id}:${p.dir}`;
      const key = await this.manifestKey(p);
      if (keys[id] === key) continue;
      const again = id in keys;
      const install = await p.eco.installCommand(this.tools.root, p.dir, again).catch(() => null);
      if (!install) {
        keys[id] = key;
        continue;
      }
      this.observe({
        kind: 'warning',
        step: s.step,
        text: `${p.dir === '.' ? '' : `${p.dir}: `}${again ? 'manifest changed since the last install; installing again' : 'a manifest exists and nothing is installed; installing'}`,
      });
      await this.installDependencies(s, p, install);
      ran = true;
    }
    return ran;
  }

  // ---- generation --------------------------------------------------------------
  private async logPrompt(s: Session, route: string, prompt: Message[], tokens: number): Promise<void> {
    const artifact = await this.store.promptArtifact(s.step, 1, prompt, route === 'step' ? undefined : route);
    await this.store.log('prompt', { step: s.step, route, tokens, artifact });
    this.observe({
      kind: 'context',
      step: s.step,
      tokens,
      workingTokens: this.config.workingTokens,
      contextWindow: this.config.contextWindow,
      breakdown: Agent.breakdown(prompt),
      entries: s.entries.length,
    });
  }
  static breakdown(prompt: Message[]): Record<string, number> {
    const out: Record<string, number> = { system: prompt[0]?.content.length ?? 0 };
    for (const m of prompt.slice(1)) {
      let parsed: any;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        out.other = (out.other ?? 0) + m.content.length;
        continue;
      }
      for (const [k, v] of Object.entries(parsed)) out[k] = (out[k] ?? 0) + JSON.stringify(v).length;
    }
    return out;
  }
  // A prompt is fitted to the working budget by evicting evidence, never swapped for a generic one.
  private async fit(s: Session, build: () => Message[]): Promise<{ prompt: Message[]; tokens: number }> {
    let prompt = build();
    let counted = await this.bonsai.count(prompt);
    let forced = 0;
    const before = Agent.shape(s);
    while (counted.tokens > this.config.workingTokens) {
      for (let i = 0; i < 3; i++) {
        if (!evictOne(s, 0, undefined, true)) {
          if (!i) throw new Error('The pinned objective, orientation and notes exceed the working budget');
          break;
        }
        forced++;
      }
      prompt = build();
      counted = await this.bonsai.count(prompt);
    }
    if (forced) {
      s.lastCompact = s.step;
      await this.store.log('compact', { step: s.step, removed: forced, reason: 'hard-budget' });
      if (await this.compactBehind(s, before, 'hard-budget')) {
        prompt = build();
        counted = await this.bonsai.count(prompt);
      }
    }
    s.lastPromptTokens = counted.tokens;
    return { prompt, tokens: counted.tokens };
  }
  static shape(s: Session): { ids: string[]; trail: string[] } {
    return { ids: s.entries.map(e => e.id), trail: [...(s.trail ?? [])] };
  }
  // A removal (a reset, a forced eviction) already makes the prompt change at one
  // point, and the server reprocesses everything after it. What the next batched
  // eviction would take first is taken now when it lies behind that point, so its
  // reprocessing is not paid a second time (evictBehind); so are the stale entries behind
  // it that hold nothing current (evictStaleBehind). Nothing else is taken.
  private async compactBehind(s: Session, before: { ids: string[]; trail: string[] }, reason: string): Promise<number> {
    const at = breakIndex(before, s);
    if (at === null) return 0;
    const removed = evictBehind(s, at, this.config.workingTokens * evictTo).length + evictStaleBehind(s, at).length;
    if (removed)
      await this.store.log('compact', {
        step: s.step,
        removed,
        reason: `with-${reason}`,
        at,
        retained: s.entries.length,
        trail: s.trail?.length ?? 0,
      });
    return removed;
  }
  private async generateJson(
    s: Session,
    route: string,
    build: () => Message[],
    schema: any,
    temperature?: number,
  ): Promise<Record<string, any>> {
    const { prompt, tokens } = await this.fit(s, build);
    this.observe({ kind: 'route', step: s.step, route, tokens, entries: s.entries.length });
    await this.logPrompt(s, route, prompt, tokens);
    this.observe({ kind: 'generating', step: s.step, route, attempt: 1 });
    // As it streams: how far the prompt has been read, then a step's thought and actions so far; any other reply only its token count.
    // The step's reply may follow the model's own thinking (stepThinking); no other route thinks.
    const thinking = route === 'step' && this.config.stepThinking ? this.config.stepThinkingBudget : undefined;
    const args = await this.bonsai.generate(
      prompt,
      schema,
      temperature,
      { step: s.step, route },
      undefined,
      every(100, (p: StreamProgress) => {
        const reply = route === 'step' && !p.prompt ? partialJson(p.text) : undefined;
        this.observe(
          p.reasoning && !p.text
            ? { kind: 'reasoning', step: s.step, text: p.reasoning, tokens: p.tokens }
            : typeof reply?.thought === 'string'
              ? {
                  kind: 'thinking',
                  step: s.step,
                  text: reply.thought,
                  tokens: p.tokens,
                  ...(Array.isArray(reply.actions) ? { actions: reply.actions } : {}),
                }
              : {
                  kind: 'generating',
                  step: s.step,
                  route,
                  attempt: 1,
                  ...(p.prompt ? { prompt: p.prompt } : { tokens: p.tokens }),
                },
        );
      }),
      thinking,
    );
    // The thinking is kept in the log, not in the prompt: the turn holds the reply, whose thought is its summary.
    const reasoning = this.bonsai.lastMeta?.reasoning;
    if (reasoning)
      await this.store.log('reasoning', { step: s.step, chars: reasoning.length, text: clip(reasoning, 16000) });
    this.observe({ kind: 'generated', step: s.step, route, meta: this.bonsai.lastMeta ?? null, args });
    return args;
  }
  // With what the generation cost (its milliseconds and completion tokens, when the client reports
  // them). `chosen` is told the request as it will be sent before anything is generated: the hash
  // of the prompt's last two messages (the notes, file list and check state, and the file's own
  // request: its content, purpose, lines, modules and packages) with the sampling settings. Only
  // the earlier steps in front of them are left out, and the check's output is read restated where
  // the prompt names the entry that shows it: an eviction of that entry moves the output into the
  // tail, which changes where it is shown, not what is asked. It may throw to generate nothing.
  // around: the file before, in and after a region whose block is generated. path and from (the file line
  // the generated lines start at) name what is being written, for live progress only.
  private async generateCode(
    s: Session,
    route: Route,
    path: string,
    from: number,
    builds: (() => Message[])[],
    budget: number,
    fence: string,
    chosen?: (request: string) => void,
    around?: Around,
  ): Promise<{ code: string; finish: string; cut?: GenerationCut; ms?: number; tokens?: number; request: string }> {
    let prompt = builds[0]!();
    let counted = await this.bonsai.count(prompt);
    for (const smaller of builds.slice(1)) {
      if (counted.tokens <= this.config.workingTokens) break;
      prompt = smaller();
      counted = await this.bonsai.count(prompt);
    }
    if (counted.tokens > this.config.workingTokens) {
      const fitted = await this.fit(s, builds.at(-1)!);
      prompt = fitted.prompt;
      counted = { tokens: fitted.tokens, mode: 'fit' };
    }
    const request = hash(
      JSON.stringify({
        tail: [...volatile(s, false), prompt.at(-1)],
        temperature: this.config.codeTemperature,
        topP: this.config.codeTopP,
        topK: this.config.codeTopK,
        minP: this.config.codeMinP,
        presence: this.config.codePresencePenalty,
        budget,
      }),
    );
    chosen?.(request);
    s.lastPromptTokens = counted.tokens;
    this.observe({ kind: 'route', step: s.step, route, tokens: counted.tokens, entries: s.entries.length });
    await this.logPrompt(s, route, prompt, counted.tokens);
    this.observe({ kind: 'generating', step: s.step, route, attempt: 1 });
    // As it is written: how far the prompt has been read, then the file's lines so far and the last of them.
    const progress = every(100, (p: StreamProgress) =>
      this.observe(
        p.prompt
          ? { kind: 'generating', step: s.step, route, attempt: 1, prompt: p.prompt }
          : p.reasoning && !p.text
            ? { kind: 'reasoning', step: s.step, text: p.reasoning, tokens: p.tokens }
            : {
                kind: 'writing',
                step: s.step,
                route,
                path,
                from,
                ...tailLines(p.text, liveHeight),
                tokens: p.tokens,
                ...(p.perSecond ? { perSecond: p.perSecond } : {}),
              },
      ),
    );
    if (this.bonsai.generateText) {
      // The model thinks before the code (codeThinking); its thought is logged, never put in a prompt.
      const g = await this.bonsai.generateText(prompt, {
        budgetTokens: budget,
        context: { step: s.step, route },
        fence,
        ...(around ? { around } : {}),
        progress,
        ...(this.config.codeThinking ? { think: this.config.codeThinkingBudget } : {}),
      });
      if (g.meta?.reasoning)
        await this.store.log('reasoning', {
          step: s.step,
          route,
          path,
          chars: g.meta.reasoning.length,
          text: clip(g.meta.reasoning, 16000),
        });
      this.observe({
        kind: 'generated',
        step: s.step,
        route,
        meta: g.meta,
        args: { chars: g.text.length, finish: g.finish },
        file: { path, from, lines: tailLines(g.text, 0).lines },
      });
      const run = fence.match(/^`+/)?.[0].length ?? 3;
      const opened = g.text.match(/^\s*(`{3,})[^\n]*\n/);
      // A cut keeps whole lines only; the kept text ends at the start of the cut line.
      const code =
        opened && opened[1]!.length >= run ? extractCode(g.text) : g.cut ? g.text : g.text.replace(/\s+$/, '') + '\n';
      return { code, finish: g.finish, ...(g.cut ? { cut: g.cut } : {}), ...cost(g.meta), request };
    }
    const raw = await this.bonsai.generate(
      prompt,
      {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
      this.config.codeTemperature,
      { step: s.step, route },
      budget,
      every(100, (p: StreamProgress) =>
        this.observe({ kind: 'generating', step: s.step, route, attempt: 1, tokens: p.tokens }),
      ),
    );
    return { code: extractCode(String(raw.content ?? '')), finish: 'stop', ...cost(this.bonsai.lastMeta), request };
  }
  // The modules a file names in its purpose, thought or notes, as real signatures.
  private async contractsFor(s: Session, path: string, text: string): Promise<FileContract[]> {
    const mentioned = [
      ...new Set(
        [...text.matchAll(/(?:^|[\s"'`(,])((?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z]{1,5})(?=$|[\s"'`),:])/g)].map(m => m[1]!),
      ),
    ].filter(p => p !== path && sourceFile(p));
    const out: FileContract[] = [];
    for (const p of [...mentioned, ...s.writes.slice(-8)]
      .filter((p, i, a) => a.indexOf(p) === i && p !== path)
      .slice(0, 10)) {
      let content: string | null = null;
      try {
        content = await readFile(await safePath(this.tools.root, p), 'utf8');
      } catch {
        continue;
      }
      const exports = await signaturesFor(p, content).catch(() => [] as string[]);
      if (!exports.length) continue;
      out.push({ path: p, importPath: importSpelling(path, p), status: 'exists', exports });
    }
    return out;
  }
  // A file's whole content generated as code: a new file, or an existing one
  // rewritten with its current content in front of the worker.
  // given: the content the model wrote in its call (the tools form), written instead of a generation; a repeat in it is cut as a generation's is.
  private async createFile(
    s: Session,
    path: string,
    purpose: string,
    thought: string,
    rewrite = false,
    range?: { start?: unknown; end?: unknown },
    exact?: string,
    given?: string,
  ): Promise<void> {
    const current = await this.currentContent(path, rewrite);
    // A block of the file: lines start..end regenerated and spliced in, the rest untouched.
    const lines =
      current === undefined || current === ''
        ? []
        : (current.endsWith('\n') ? current.slice(0, -1) : current).split('\n');
    const region: Region | null =
      rewrite && (typeof range?.start === 'number' || typeof range?.end === 'number')
        ? regionOf(s, path, current!, lines, range!)
        : null;
    const project = await projectFor(this.tools.root, path);
    const sha = current === undefined ? undefined : hash(current);
    // The file around a region's block, all of it: a block may repeat any number of the lines that stay.
    const around = region
      ? {
          before: lines.slice(0, region.start - 1).join('\n'),
          region: lines.slice(region.start - 1, region.end).join('\n'),
          after: lines.slice(region.end).join('\n'),
        }
      : undefined;
    const echoesAfter = around && /\S/.test(around.after) ? around : undefined;
    const generated =
      given !== undefined
        ? fromCall(given, echoesAfter)
        : await this.generateCode(
            s,
            rewrite ? 'rewrite_file' : 'create_file',
            path,
            region?.start ?? 1,
            await this.generationRequest(s, path, purpose, thought, current, region, project),
            this.config.createTokens,
            fenceFor(path),
            this.reproductionGuard(s, path, sha, region, range, rewrite ? exact : undefined),
            echoesAfter,
          );
    const finish = generated.finish;
    const cut = generated.cut;
    const { code, echo, blockCount } = region
      ? spliceRegion(generated.code, region, lines, current!, around!, cut)
      : { code: generated.code, echo: null, blockCount: 0 };
    // A cut is stated as facts about lines: which line, how it opens, how long it
    // grew, and which lines were written; the cut line itself never is.
    const written = region ? blockCount : code === '' ? 0 : code.replace(/\n$/, '').split('\n').length;
    const { lead, ended } = this.generationOutcome(path, region, lines, written, finish, cut, echo);
    // A cut before any line was generated writes nothing: the file stays as it was. A block that was
    // nothing but a repeat of the lines after the region empties it, which removes its lines; an
    // insertion has none, so nothing changes.
    if (written === 0 && (echo ? region!.end < region!.start : cut))
      throw new Error(
        `the generation of ${path} ${lead}; no line was generated before it, so nothing was written${current !== undefined ? ` and ${path} is unchanged` : ''}`,
      );
    if (ended) this.observe({ kind: 'warning', step: s.step, text: `${path}: the generated content ${ended}` });
    // What the generation cost, as the client measured it.
    const spent =
      generated.ms === undefined
        ? ''
        : ` (${generated.tokens !== undefined ? `${generated.tokens} tokens, ` : ''}${(generated.ms / 1000).toFixed(1)} s)`;
    // A rewrite that reproduced the file is stated with where the file's content came from
    // and whether the last check has seen it: the facts a request to change it was made on.
    if (rewrite && code.replace(/\s+$/, '') === current!.replace(/\s+$/, ''))
      this.refuseReproduction(s, path, code, current!, sha!, region, generated, spent, ended, exact, given);
    const result = rewrite
      ? await this.execute(
          s,
          'write',
          {
            path,
            expectedHash: hash(current!),
            oldText: current!,
            newText: code,
            wholeFile: true,
            ...(region ? { region } : {}),
          },
          'rewrite',
        )
      : await this.execute(s, 'create_file', { path, content: code }, 'create');
    if (!result.ok) throw new Error(result.text);
    await this.stateContractFacts(s, path, code, project, result, { cut, echo, ended, finish });
    // A whole-file rewrite generates every line: how many of them differ from the content it
    // replaced, and what generating them cost, is a fact about the write (region rewrites and
    // creations generate only what is new).
    if (rewrite && !region) noteRewriteDiff(s, path, current!, code, spent);
  }
  // Read as the edit tools read it (a byte-order mark is not part of the text), so the hash a
  // rewrite carries is the one the write checks; a missing file is one to create.
  private async currentContent(path: string, rewrite: boolean): Promise<string | undefined> {
    let current: string | undefined;
    try {
      current = await boundedRead(await safePath(this.tools.root, path, true));
    } catch (e: any) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') current = undefined;
      else throw new Error(`${path} cannot be read as text: ${e?.message ?? e}`);
    }
    if (current !== undefined && !rewrite)
      throw new Error(
        `${path} already exists; use rewrite_file to replace its whole content, or replace_lines for a small edit`,
      );
    if (current === undefined && rewrite) throw new Error(`${path} does not exist; use create_file`);
    return current;
  }
  // The facts a generation is written against: the modules it names, the declared packages, what the repository says this kind of file is written against.
  private async generationRequest(
    s: Session,
    path: string,
    purpose: string,
    thought: string,
    current: string | undefined,
    region: Region | null,
    project: Awaited<ReturnType<typeof projectFor>>,
  ): Promise<(() => Message[])[]> {
    const contracts = await this.contractsFor(s, path, `${purpose}\n${thought}\n${s.notes ?? ''}`);
    const declared = project
      ? await project.eco.declared(join(this.tools.root, project.dir)).catch(() => [] as string[])
      : [];
    const markup = await generationFacts(this.tools.root, path, current, s.knownFiles).catch(
      () => ({}) as Record<string, unknown>,
    );
    return region
      ? [0, 1].map(
          k => () =>
            regionMessages(s, path, purpose, current!, region.start, region.end, contracts, declared, k, markup),
        )
      : [0, 1].map(k => () => newFileMessages(s, path, purpose, contracts, declared, k, current, markup));
  }
  // A rewrite whose exact arguments already reproduced this very content, from the same request
  // in front of the generation (only the earlier steps differ), is not generated again: code is
  // sampled at a low temperature, and across 73 recorded runs every repeat of the same request on
  // the same content returned the same text byte for byte (run 71, steps 34, 36 and 37: 1452
  // tokens three times, from prompts of 29k and 15k tokens whose last two messages were
  // identical). A check that ran since, a module or package that changed, other notes: another
  // request, which is generated. That was measured at codeTemperature 0.3; above it a repeat can come
  // out otherwise (at 0.7, the instruct-mode setting, it is a new sample), and so does one after a thought
  // sampled at the thinking-mode temperature (codeThinking), so it is generated.
  // The guard sees each request before it is sent and refuses the one that reproduced the file.
  private reproductionGuard(
    s: Session,
    path: string,
    sha: string | undefined,
    region: Region | null,
    range: { start?: unknown; end?: unknown } | undefined,
    exact: string | undefined,
  ): (request: string) => void {
    const deterministic = this.config.codeTemperature <= 0.3 && !this.config.codeThinking;
    const known = exact && deterministic ? s.reproduced?.[exact] : undefined;
    return request => {
      if (!known || known.sha !== sha || known.request !== request) return;
      const was =
        known.ms === undefined
          ? ''
          : ` (${known.tokens !== undefined ? `${known.tokens} tokens, ` : ''}${(known.ms / 1000).toFixed(1)} s)`;
      const shown = s.entries.some(e => e.step === known.step && e.kind !== 'turn')
        ? `e${known.step}`
        : 'its result has left the evidence';
      throw Object.assign(
        new Error(
          `this exact ${Agent.describe('rewrite_file', { path, ...(region ? { start: range!.start, end: range!.end } : {}) })} reproduced the file unchanged at step ${known.step}${was} from the same request as now (sha256=${sha}, and the same purpose, lines, notes, check state, modules and packages; only earlier steps differ); it was not generated again (${shown}). ${Agent.provenance(s, path, sha!, exact)}`,
        ),
        { duplicate: true },
      );
    };
  }
  // How a generation ended, as facts about lines: lead names the cut or the repeat of the lines after the
  // region, ended adds what was and was not written ('' for a generation that closed its block).
  private generationOutcome(
    path: string,
    region: Region | null,
    lines: string[],
    written: number,
    finish: string,
    cut: GenerationCut | undefined,
    echo: Echo | null,
  ): { lead: string; ended: string } {
    const at = region ? region.start + written : written + 1;
    const opening = cut ? ` (\`${cut.opening}${cut.truncated ? '…' : ''}\`)` : '';
    // A repeat of the lines after the region is stated as the lines it repeated, which stay as they were.
    const repeat = echo
      ? `lines ${region!.end + 1}..${region!.end + echo.echoed}, the lines after the region${echo.diverged ? ', then went on with other lines' : ''}`
      : '';
    const where = echo ? `after the block and a repeat of ${repeat}` : `inside line ${at}`;
    const cutLine = !cut
      ? ''
      : cut.kind === 'echo'
        ? `was stopped once it was repeating ${repeat}`
        : cut.kind === 'cycle'
          ? `repeated itself ${where}${echo ? '' : opening}: that line reached ${cut.lineChars} characters without ending${cut.unit ? `, ending in one ${cut.unit}-character unit repeated verbatim` : ''}; it was cut at the start of that line`
          : cut.kind === 'lines'
            ? `started repeating ${cut.block && cut.times ? `${cut.block === 1 ? 'one line' : `a block of ${cut.block} lines`} (from \`${cut.opening}${cut.truncated ? '…' : ''}\`), which came ${cut.times} times in a row, ` : 'a block of lines '}${echo ? where : `at line ${at}`}; it was cut there`
            : `reached the ${this.config.createTokens}-token budget ${where}${echo ? '' : opening}, which had reached ${cut.lineChars} characters without ending; that line was cut`;
    const lead = cut ? cutLine : echo ? `${echo.diverged ? 'repeated' : 'ended with a repeat of'} ${repeat}` : '';
    const followed =
      !region || region.end >= lines.length
        ? ''
        : region.end === 0
          ? `, and the file's original lines now start at line ${at}`
          : `, and the lines that followed line ${region.end} now start at line ${at}`;
    // An emptied region is stated with the lines it held, as replace_lines states the lines a replacement drops.
    const kept = echo
      ? `the repeat${echo.diverged ? ' and what followed it were' : ' was'} not written; ${written ? `lines ${region!.start}..${at - 1} hold the generated block` : `no line was generated before it, so lines ${region!.start}..${region!.end} were removed (they held ${droppedLines(lines, [region!], () => []).join('; ')})`}${followed}`
      : !cut
        ? ''
        : region
          ? `lines ${region.start}..${at - 1} hold the generated lines before it; the rest of the block was not written${followed}`
          : `the file holds lines 1..${written} as generated; nothing from line ${at} on was written`;
    const ended =
      cut || echo
        ? `${lead}: ${kept}`
        : finish === 'length'
          ? `reached the ${this.config.createTokens}-token budget`
          : finish === 'repetition'
            ? 'started repeating itself and was cut at the repeat'
            : finish === 'eos'
              ? 'ended before the file was complete (the model stopped without closing the code block)'
              : '';
    return { lead, ended };
  }
  // A rewrite that reproduced the file is refused with where the file's content came from; a generated one is
  // remembered by its exact arguments, so the same request on the same content is not generated again.
  private refuseReproduction(
    s: Session,
    path: string,
    code: string,
    current: string,
    sha: string,
    region: Region | null,
    generated: Generated,
    spent: string,
    ended: string,
    exact: string | undefined,
    given: string | undefined,
  ): never {
    if (exact && given === undefined) {
      (s.reproduced ??= {})[exact] = {
        step: s.step,
        sha,
        request: generated.request,
        ...(generated.ms !== undefined ? { ms: generated.ms } : {}),
        ...(generated.tokens !== undefined ? { tokens: generated.tokens } : {}),
      };
      for (const old of Object.keys(s.reproduced).slice(0, -20)) delete s.reproduced[old];
    }
    // Equal once trailing whitespace is set aside: said as equal only when it is byte for byte.
    const equal =
      code === current
        ? region
          ? 'equal them'
          : 'equals'
        : region
          ? 'differ from them only in trailing whitespace'
          : 'differs only in trailing whitespace from';
    const made = given === undefined ? 'generated' : 'written';
    throw new Error(
      `the rewrite of ${path} reproduced its current content unchanged${ended ? ` and ${ended}` : ''}: ${region ? `the ${made} lines ${region.start}..${region.end}${spent} ${equal}` : `the ${made} file${spent} ${equal} ${path}`} as it is (sha256=${sha}); nothing was written. ${Agent.provenance(s, path, sha, exact)}`,
    );
  }
  // Contracts the file breaks are facts for the worker: names a repository module does not declare, packages
  // the manifest does not declare; and how the generation ended, when it did not close its block.
  private async stateContractFacts(
    s: Session,
    path: string,
    code: string,
    project: Awaited<ReturnType<typeof projectFor>>,
    result: ToolResult,
    how: { cut: GenerationCut | undefined; echo: Echo | null; ended: string; finish: string },
  ): Promise<void> {
    const readRepo = async (p: string) => {
      try {
        return await readFile(await safePath(this.tools.root, p), 'utf8');
      } catch {
        return null;
      }
    };
    const facts = [
      ...(await missingRelativeModules(path, code, readRepo).catch(() => [] as string[])),
      ...(await unresolvedImports(path, code, readRepo).catch(() => [] as string[])),
    ];
    const manifest = project ? project.eco.markers.map(m => inProject(project, m)) : [];
    const present = [];
    for (const m of manifest) if ((await readRepo(m)) !== null) present.push(m);
    if (present.length) {
      const missing = await undeclaredPackages(this.tools.root, path, code, readRepo).catch(() => [] as string[]);
      if (missing.length)
        facts.push(
          `${path} imports ${missing.join(', ')}, which ${present.join(' or ')} does not declare: declare them (the package manager chooses the version) so they can be installed`,
        );
    }
    const { cut, echo, ended, finish } = how;
    if (ended)
      facts.unshift(
        cut || echo
          ? `the generation of ${path} ${ended}`
          : `the generated content of ${path} ${ended}; check its end before relying on it`,
      );
    // A file that does not parse after a generation that ran to its end: the
    // errors are in what was written, not in a cut, so the worker is told which.
    if (!cut && finish === 'stop' && /does not parse/.test(result.text))
      facts.splice(
        echo ? 1 : 0,
        0,
        `the generation of ${path} ran to its end (${code.split('\n').length} lines, not cut off); the parse errors are in the written content`,
      );
    if (facts.length) {
      const e = s.entries.at(-1);
      if (e) e.text += `\nHarness: ${facts.join(' | ')}`;
      s.lastError = facts.join(' | ');
    }
  }
  // Where a file's current content came from, and whether the last check has run on it:
  // the step that last wrote it (and the action, when the harness recorded it; the same
  // arguments as the request being answered, when they are), and the last check's step
  // relative to that write, with the lines of the file it names when it ran after it.
  static provenance(s: Session, path: string, sha: string, exact?: string): string {
    const w = s.writeSteps[path];
    const by =
      w === undefined
        ? undefined
        : [
            s.writers?.[path],
            ...Object.values(s.attempts ?? {})
              .filter(a => a.ok)
              .map(a => ({ step: a.step, what: a.what, exact: a.exact, sha: a.after[path] })),
          ].find(a => a && a.step === w && a.sha === sha);
    const wrote =
      w === undefined
        ? `no write of ${path} is recorded in this session`
        : `${path} was last written at step ${w}${by ? (exact !== undefined && by.exact === exact ? ' by a rewrite_file with these same arguments' : ` by the ${by.what}`) : ''}`;
    const c = s.lastCheck;
    const command = c?.command ?? s.lastCheckCommand ?? 'the check';
    if (!c) return `${wrote}; no check has run yet.`;
    // Strictly before, as the verification block's writtenSince reads it (a check's own writes are not edits).
    if (w !== undefined && c.step < w)
      return `${wrote}; the last check (${command}, step ${c.step}) ran before that write and none has run since: its output describes the file as it was at step ${c.step}.`;
    const named =
      Object.entries(c.summary.files).find(
        ([f]) => f === path || f.endsWith(`/${path}`) || path.endsWith(`/${f}`),
      )?.[1] ?? [];
    return `${wrote}; the last check (${command}, step ${c.step}) ran on it as it is and ${c.ok ? 'passed' : 'failed'}, naming ${named.length ? `line${named.length > 1 ? 's' : ''} ${named.join(', ')} of ${path}` : `no line of ${path}`}.`;
  }

  // ---- completion --------------------------------------------------------------
  private async completionFacts(s: Session, summary: string): Promise<Parameters<typeof evidenceGate>[2]> {
    const diff = await runCommand('git', ['diff', '--stat', 'HEAD', '--'], s.root, 10000).catch(() => null);
    const untracked = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], s.root, 10000).catch(
      () => null,
    );
    const diffStat =
      [
        diff?.code === 0 ? diff.output.trim() : '',
        untracked?.code === 0 && untracked.output.trim()
          ? `untracked: ${untracked.output.trim().split('\n').slice(0, 40).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n') || `changed files: ${s.writes.join(', ') || 'none'}`;
    const sources: Record<string, string> = {};
    for (const p of s.writes.slice(-12)) {
      const t = await readIfPresent(s.root, p);
      if (t !== null) sources[p] = clip(t, 1200);
    }
    // Whether the result can be observed here (the shell runs what is observed), and the last observation of it.
    const canObserve = (s.allowedActions ?? []).includes('observe');
    const o = s.lastObservation;
    const observation = o
      ? {
          kind: o.kind,
          step: o.step,
          afterLastWrite: o.step > s.lastWriteStep,
          ok: o.ok,
          target: o.target,
          facts: o.text,
          question: observerFor(o.kind)?.question,
        }
      : canObserve
        ? 'never observed: nothing is known about the result as its user meets it'
        : 'cannot be observed here (the shell is not allowed)';
    const observationState =
      !canObserve && !o
        ? ('unavailable' as const)
        : !o
          ? ('never' as const)
          : o.step > s.lastWriteStep
            ? ('current' as const)
            : ('stale' as const);
    return {
      summary: clip(summary, 1500),
      changedFiles: s.writes,
      diffStat: clip(diffStat, 2500),
      observation,
      observationState,
      verification: {
        command: s.lastCheck?.command ?? s.lastCheckCommand,
        ok: s.lastCheck?.ok ?? null,
        afterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep),
        exitCode: s.lastCheck?.summary.code ?? null,
        text: clip(s.lastCheck?.text ?? '', 800),
      },
      requirements: referenceContext(s, 2000).map(e => clip(e.text, 300)),
      sources,
    };
  }

  // ---- the loop ----------------------------------------------------------------
  async run(s: Session): Promise<Session> {
    const run = await this.begin(s);
    try {
      while (run.maxTurns ? run.turns < run.maxTurns : s.step < run.endStep) {
        if (this.stopRequested) {
          s.status = 'paused';
          s.stopReason = 'Stopped by the user; resume to continue.';
          break;
        }
        s.step++;
        this.current = s.step;
        s.currentTurn = null;
        run.turns++;
        this.observe({ kind: 'step', step: s.step, phase: s.phase, ...this.counted(run) });
        if (this.config.allowBash && (await this.retrySetup(s))) {
          s.unchangedTurns = 0;
          await this.store.save(s);
          continue;
        }
        await this.pinObjectiveFiles(s);
        const notes = await this.standingNotes(s);
        if (notes === 'stop') break;
        const allowed: Route[] = [...actions].filter(
          a =>
            (this.config.allowWrite || !editRoutes.includes(a as Route)) &&
            (this.config.allowBash || (a !== 'bash' && a !== 'observe')),
        ) as Route[];
        s.allowedActions = allowed;
        const next = await this.nextTurn(s, allowed, notes, run);
        if (!next) {
          await this.store.save(s);
          continue;
        }
        if ((await this.runTurn(s, next, allowed, run)) === 'stop') break;
        await this.watch(s);
        await this.store.save(s);
      }
      if (s.status === 'running') {
        s.status = 'paused';
        s.stopReason = run.maxTurns
          ? `Reached the ${run.maxTurns}-turn limit for this invocation`
          : `Reached the ${this.config.maxSteps}-step limit for this invocation`;
      }
    } catch (e) {
      s.status = 'paused';
      s.stopReason = `Stopped: ${(e as Error).message}`;
    }
    await this.store.log('stop', { step: s.step, status: s.status, reason: s.stopReason });
    this.observe({ kind: 'stop', step: s.step, status: s.status, reason: s.stopReason });
    await this.store.save(s);
    return s;
  }

  // The session made ready for an invocation, and the invocation's budget.
  private async begin(s: Session): Promise<RunBudget> {
    s.status = 'running';
    s.stopReason = '';
    delete s.outcome;
    s.answerRejections = 0;
    // The prompt is written for this run's model (a session resumed with another model is shown to it in its form).
    if (this.config.promptForm === 'json') delete s.form;
    else s.form = this.config.promptForm;
    s.watch ??= { noProgress: 0, readings: [], escalations: 0 };
    s.blockedActions ??= [];
    s.notes ??= '';
    if (s.baselineStatus === null)
      s.baselineStatus = await repositoryStatus(this.tools.root)
        .then(r => (r.git ? r.changed : []))
        .catch(() => []);
    if (!s.orientation) {
      s.orientation = (await orient(this.tools.root)) as unknown as Record<string, unknown>;
      await this.store.log('orientation', { step: s.step, orientation: s.orientation });
    }
    if (this.config.checkCommand && !s.lastCheckCommand) s.lastCheckCommand = this.config.checkCommand;
    this.tools.config.checkCommand = s.lastCheckCommand ?? '';
    // A new invocation starts from the base temperature, as the four in a row starts from zero.
    s.unchangedTurns = 0;
    // The limit of an invocation: Bonsai's counts actions (maxSteps); under the tools form it counts turns
    // (openrouterMaxTurns), since a model that batches its calls runs several actions a turn.
    const maxTurns = s.form === 'tools' ? this.config.openrouterMaxTurns : 0;
    return {
      maxTurns,
      endStep: maxTurns ? Number.MAX_SAFE_INTEGER : s.step + this.config.maxSteps,
      turns: 0,
      failures: 0,
    };
  }
  private counted(run: RunBudget): { maxStep: number; turn?: number; maxTurn?: number } {
    return run.maxTurns ? { maxStep: 0, turn: run.turns, maxTurn: run.maxTurns } : { maxStep: run.endStep };
  }
  // The files the objective names, pinned as read by the harness; a changed one is read and ranked again.
  private async pinObjectiveFiles(s: Session): Promise<void> {
    const pinned = await pinReferences(s, this.tools.root, (query, chunks) =>
      relevance(this.jev, s, query, chunks, 1200),
    ).catch(() => [] as string[]);
    if (pinned.length)
      await this.store.log('references', {
        step: s.step,
        files: pinned,
        chunks: s.referenceEvidence.filter(e => pinned.includes(e.path)).length,
      });
  }

  // What the harness states to the worker this step, from the watchdog's standing readings and the session's
  // state; 'stop' when a reading ends the session instead.
  private async standingNotes(s: Session): Promise<string[] | 'stop'> {
    // The watchdog's standing verdicts shape the step: a repeated failure blocks its identical retry; no progress for a run of steps ends the attempt or asks the user.
    const last = s.watch!.readings.at(-1);
    const notes: string[] = [];
    if (last && last.stuck >= 0.9 && s.watch!.noProgress >= 2 && (await this.escalate(s, last, notes)) === 'stop')
      return 'stop';
    // Scope and completion, read by Jev, stated to the worker: work beyond the objective for a run of steps, or an objective that reads as satisfied.
    const recent = s.watch!.readings.slice(-3);
    if (recent.length === 3 && recent.every(r => (r.inScope ?? 1) < 0.3))
      notes.push(
        'Jev reads the last three steps as work the objective did not ask for. Finish what the objective asks, run your check, and finish; or ask the user whether the extra work is wanted.',
      );
    if ((await this.proposeCompletion(s, last, notes)) === 'stop') return 'stop';
    if (s.lastCheckCommand && s.lastWriteStep > (s.lastCheck?.step ?? -1) && s.editsSinceCheck >= 3)
      notes.push(`${s.editsSinceCheck} edits have landed since your check last ran; run it when you want them judged.`);
    const readOnly = s.readOnlyTurns ?? 0;
    if (readOnly >= 3)
      notes.push(
        `Your last ${readOnly} turns only read or searched; nothing changed. The evidence already holds what they returned. Act on it now, or say in your thought exactly which fact is still missing.`,
      );
    if (s.setupError)
      notes.push(
        `The dependency install failed for the current manifest: ${s.setupError}. The manifest is yours to change; the install runs again by itself after the change.`,
      );
    if (s.completionFeedback && !s.completionFeedback.addressed) notes.push(s.completionFeedback.text);
    return notes;
  }
  // No progress for a run of steps with a high stuck reading: the second time, or when the user is needed, the
  // session pauses; the first time the worker's reasoning from the streak is set aside and it is told.
  private async escalate(s: Session, last: WatchReading, notes: string[]): Promise<'stop' | undefined> {
    s.watch!.escalations++;
    if (last.needsUser >= 0.5 || s.watch!.escalations >= 2) {
      s.status = 'paused';
      ending(
        s,
        `Jev reads the session as stuck (stuck ${last.stuck.toFixed(2)}, no progress for ${s.watch!.noProgress} steps)${last.needsUser >= 0.5 ? ' and in need of the user' : ''}. Last error: `,
        s.lastError ?? 'none',
        300,
      );
      return 'stop';
    }
    // Every earlier turn is dropped, the results kept: the facts stay, the
    // line of thought the worker would copy and anchor on goes (a turn
    // before the streak often holds the same reasoning).
    // The results the compaction riding on it takes are said, so the note stays a fact.
    const dropped = s.entries.filter(e => e.kind === 'turn');
    const before = Agent.shape(s);
    let removed = 0;
    if (dropped.length) {
      s.entries = s.entries.filter(e => !dropped.includes(e));
      await this.store.log('reasoning-reset', { step: s.step, turns: dropped.map(e => e.id) });
      removed = await this.compactBehind(s, before, 'reasoning-reset');
    }
    notes.push(
      `Jev reads no progress for ${s.watch!.noProgress} steps (stuck ${last.stuck.toFixed(2)}).${dropped.length ? ` Your reasoning from those steps was set aside; their results are still shown${removed ? `, except ${removed} that left the prompt at the same time` : ''}.` : ''} Do not repeat what was tried; change the approach, or ask the user if only they can decide.`,
    );
    s.watch!.noProgress = 0;
    return undefined;
  }
  // The harness proposes completion itself when Jev reads the objective as
  // satisfied and the check passed after the last edit: once per check,
  // judged by the evidence gate like a worker's claim; a rejection says why.
  // Never while the last observation of the result failed or predates the last edit.
  private async proposeCompletion(
    s: Session,
    last: WatchReading | undefined,
    notes: string[],
  ): Promise<'stop' | undefined> {
    const observationStands = !s.lastObservation || (s.lastObservation.ok && s.lastObservation.step > s.lastWriteStep);
    const proposeFinish = Boolean(
      last &&
      last.objective >= 0.7 &&
      s.lastCheck?.ok &&
      s.lastCheck.step > s.lastWriteStep &&
      observationStands &&
      s.finishTriedAtCheck !== s.lastCheck.step,
    );
    if (!proposeFinish) return undefined;
    s.finishTriedAtCheck = s.lastCheck!.step;
    await this.store.log('auto-finish', { step: s.step, objective: last!.objective, check: s.lastCheck!.step });
    const facts = await this.completionFacts(
      s,
      `Proposed by the harness: Jev reads the objective as satisfied (${last!.objective.toFixed(2)}) and ${s.lastCheck!.command ?? s.lastCheckCommand} passed after the last edit. Notes: ${clip(s.notes ?? '', 600)}`,
    );
    const verdict = await evidenceGate(this.jev, s, facts);
    await this.store.log('completion', { step: s.step, proposedBy: 'harness', ...verdict });
    this.observe({
      kind: 'jev',
      step: s.step,
      ms: 0,
      questions: 4,
      stateBytes: 0,
      route: [[verdict.route, 1]],
      nouls: { matches: verdict.matches, unaddressed: verdict.unaddressed, supported: verdict.supported },
    });
    if (verdict.accepted) {
      s.status = 'complete';
      ending(s, "Complete: the objective is met by the facts and Jev's reading; ", s.notes ?? '', 300);
      return 'stop';
    }
    if (verdict.route === 'human') {
      s.status = 'paused';
      ending(s, 'Completion proposed by the harness; Jev routes it to the user for review. ', s.notes ?? '', 300);
      return 'stop';
    }
    notes.push(
      `The harness proposed completion because Jev reads the objective as likely satisfied and your check passes; the evidence gate did not accept it: ${verdict.reason}. Address that, then finish.`,
    );
    return undefined;
  }

  // The worker's next turn: one reasoning and an ordered batch of actions, sampled at the temperature of the
  // streak of turns that changed nothing. A generation that fails is recorded as evidence (null); the fourth
  // failure in a row ends the invocation.
  private async nextTurn(s: Session, allowed: Route[], notes: string[], run: RunBudget): Promise<Turn | null> {
    // A turn that changed nothing leaves the state as it was: it leaves the prompt, and
    // only the harness's statements about it are added, so the prompt is (nearly) the one
    // that produced it, and near-greedy sampling of it returns that turn again (run 58: the
    // same 196 tokens at steps 54 and 55). Each further step of such a streak is sampled at
    // the next temperature of the escalation; a turn that changes something ends it.
    const streak = s.unchangedTurns ?? 0;
    const escalation = this.config.stepTemperatureEscalation ?? [];
    // A step that thinks samples at the thinking-mode temperature; the escalation never goes below the base.
    const base = this.config.stepThinking ? this.config.stepThinkingTemperature : this.config.stepTemperature;
    const temperature =
      streak && escalation.length ? Math.max(base, escalation[Math.min(streak, escalation.length) - 1]!) : base;
    if (temperature !== base) await this.store.log('sampling', { step: s.step, unchangedTurns: streak, temperature });
    try {
      const item = {
        anyOf: stepSchema.anyOf!.filter(alt => allowed.includes(alt.properties!.action!.const as Route)),
      };
      const gen = await this.generateJson(
        s,
        'step',
        () => stepMessages(s, allowed, notes.join(' ') || undefined),
        {
          type: 'object',
          properties: {
            thought: { type: 'string' },
            actions: { type: 'array', minItems: 1, maxItems: 8, items: item },
          },
          required: ['thought', 'actions'],
          additionalProperties: false,
        },
        temperature,
      );
      const thought = String(gen.thought ?? '').trim();
      const batch: Batch = (gen.actions as any[]).map(a => ({
        action: String(a.action) as Route,
        args: (a.args ?? {}) as Record<string, any>,
        ...(typeof a.problem === 'string' ? { problem: a.problem } : {}),
      }));
      s.lastThought = thought;
      await this.store.log('thought', {
        step: s.step,
        thought: clip(thought, 2000),
        actions: batch.map(b => b.action),
        temperature,
      });
      this.observe({
        kind: 'thought',
        step: s.step,
        thought,
        actions: batch,
        ...(this.bonsai.lastMeta?.reasoning ? { reasoning: this.bonsai.lastMeta.reasoning } : {}),
      });
      return { thought, batch };
    } catch (e) {
      if (++run.failures >= 4) throw e;
      const cut = /\(length\)/.test((e as Error).message);
      const why =
        cut && s.form === 'tools'
          ? 'your reply reached its output limit before its first call was complete, so nothing ran: a large file goes in a call of its own, or in blocks (rewrite_file with start and end); keep the text before the calls short.'
          : cut
            ? `your reply reached the ${this.config.maxTokens}-token limit before it closed, so nothing ran: file content inside the arguments (replace_lines or write with a large newText) does not fit. Use rewrite_file or create_file for large content, which generate it as code without that limit; keep the thought short.`
            : (e as Error).message;
      this.observe({ kind: 'generation_error', step: s.step, message: why });
      await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${why}` });
      return null;
    }
  }

  // A turn: recorded in the evidence, its batch run back to back until the first failure, then judged as a
  // whole. 'stop' when an action ended the session.
  private async runTurn(s: Session, next: Turn, allowed: Route[], run: RunBudget): Promise<'stop' | undefined> {
    const { thought, batch } = next;
    const { turn, repeated } = await this.recordTurn(s, thought, batch);
    // The batch's edits are recorded from its first action on: a later action of
    // the batch that carries a hash from before one of them is mapped through them.
    this.tools.journal = [];
    let halted = false;
    const outcomes: string[] = [];
    const duplicates: boolean[] = [];
    const startFailures = run.failures;
    const notesBefore: string | undefined = s.notes;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) {
        if (s.step >= run.endStep) break;
        s.step++;
        this.current = s.step;
        this.observe({ kind: 'step', step: s.step, phase: s.phase, ...this.counted(run) });
      }
      const { action, problem } = batch[i]!;
      const args = await this.callArguments(s, batch[i]!);
      this.duplicate = false;
      const outcome = await this.perform(
        s,
        action,
        args,
        thought,
        problem ?? (s.form === 'tools' ? argsProblem(action, args, allowed, s.hashes) : undefined),
      );
      outcomes.push(outcome);
      duplicates.push(outcome === 'repeated' || (outcome === 'refused' && this.duplicate));
      turn.outcomes!.push(
        `${action} ${outcome}${outcome === 'failed' || outcome === 'refused' ? `: ${(s.lastError ?? '').split('\n')[0]!.slice(0, 90)}` : outcome === 'repeated' ? `: shown in ${s.entries.at(-1)?.cites?.join(', ') || 'no entry'}` : ''}`,
      );
      // A refused action (blocked, malformed) counts toward the four in a row that
      // end the attempt; a command that ran and failed is a result, except after a
      // repeat in the same turn. A repeated read stops nothing: the batch goes on,
      // and the turn is judged as a whole below.
      if ((outcome === 'ok' && !(action === 'plan' && s.notes === notesBefore)) || outcome === 'failed')
        run.failures = 0;
      if (outcome === 'refused' && ++run.failures >= 4)
        throw new Error('four actions in a row could not be executed; the session needs a different approach');
      if (outcome === 'stop') {
        halted = true;
        break;
      }
      if ((outcome === 'failed' || outcome === 'refused') && i < batch.length - 1) {
        const e = s.entries.at(-1);
        if (e)
          e.text += `\nThe remaining ${batch.length - 1 - i} action(s) of this batch were not run (${batch
            .slice(i + 1)
            .map(b => b.action)
            .join(', ')}); reason about the result first.`;
        break;
      }
    }
    s.currentTurn = null;
    await this.judgeTurn(s, { turn, repeated, batch, outcomes, duplicates, startFailures, notesBefore, halted }, run);
    return halted ? 'stop' : undefined;
  }
  // Under the tools form a call may leave out the fields that have a default; they are filled in, then the
  // call is checked alone. A write without a hash edits the file as it is now (its exact anchor is the guard),
  // or creates it when there is none.
  private async callArguments(s: Session, call: Batch[number]): Promise<Record<string, any>> {
    const args = s.form === 'tools' ? withDefaults(call.action, call.args) : call.args;
    if (
      s.form === 'tools' &&
      call.action === 'write' &&
      args.expectedHash === undefined &&
      typeof args.path === 'string'
    )
      args.expectedHash =
        (await this.diskHashes([args.path]).catch(() => ({}) as Record<string, string | null>))[args.path] ?? 'new';
    return args;
  }
  // The turn enters the evidence before its actions run: the prefix only grows,
  // and a file generated inside the batch already sees the reasoning behind it.
  // Reasoning copied word for word from the previous turn is the worker anchoring on its
  // own text, without waiting for the watchdog to read the session as stuck. Whole-thought
  // equality, as stored: turns that only open alike (a status sentence) are ordinary progress.
  // Whether the next thought repeats follows the copies the next prompt holds (runs to 76:
  // none 1/51, one 20/42, two or more 11/12), so a repeat is not added: the previous turn stays
  // and the prompt only grows. Removing the earlier copy left the same one copy and
  // re-processed everything after it (runs 49-76: 26 resets of turns that ran an action,
  // 44.6 s; run 73 step 30, 5,638 tokens). Its results follow as those of a turn that left.
  private async recordTurn(s: Session, thought: string, batch: Batch): Promise<{ turn: Entry; repeated: boolean }> {
    const turn = turnEntry(s.step, thought, batch, s.form === 'tools');
    const previous = s.entries.filter(e => e.kind === 'turn').at(-1);
    const repeated = Boolean(previous && saidIn(turn).length >= 40 && saidIn(previous) === saidIn(turn));
    if (repeated) {
      await this.store.log('repeated-thought', { step: s.step, kept: previous!.id });
      await this.dropCopies(s, turn, previous);
    } else s.entries.push(turn);
    s.currentTurn = turn.id;
    return { turn, repeated };
  }
  // The copies of the thought but kept leave the prompt (results stay). The copy kept is the previous
  // turn, the last one in the prompt: it is the one the next thought is compared with, so a further
  // repeat is caught. An earlier copy (the thought came back after another) goes.
  private async dropCopies(s: Session, turn: Entry, kept?: Entry): Promise<void> {
    const dropped = s.entries.filter(e => e.kind === 'turn' && e !== kept && saidIn(e) === saidIn(turn));
    if (!dropped.length) return;
    const before = Agent.shape(s);
    s.entries = s.entries.filter(e => !dropped.includes(e));
    await this.store.log('reasoning-reset', { step: s.step, reason: 'repeated', turns: dropped.map(e => e.id) });
    await this.compactBehind(s, before, 'reasoning-reset');
  }
  // A turn judged as a whole once its batch has run: whether it leaves the prompt, whether it counts toward the
  // four in a row that end the attempt, and whether it changed nothing or only read.
  private async judgeTurn(
    s: Session,
    t: {
      turn: Entry;
      repeated: boolean;
      batch: Batch;
      outcomes: string[];
      duplicates: boolean[];
      startFailures: number;
      notesBefore: string | undefined;
      halted: boolean;
    },
    run: RunBudget,
  ): Promise<void> {
    const { turn, batch, outcomes, duplicates, notesBefore } = t;
    // A turn whose every action was refused or repeated what the evidence shows changed
    // nothing and is a template the worker copies word for word: it leaves the prompt, the
    // refusals and the repeats' facts stay. A turn of repeats, and of a failure after them,
    // counts once toward the four in a row (a refusal among them has counted already).
    // A repeat that changed nothing takes the earlier copies with it after its batch, so none is
    // left (then the next thought differed 50 times in 51): the re-processing the reset still pays.
    if (outcomes.length && outcomes.every(o => o === 'refused' || o === 'repeated')) {
      s.entries = s.entries.filter(e => e !== turn);
      for (const e of s.entries) if (e.turn === turn.id) delete e.turn;
      if (t.repeated) await this.dropCopies(s, turn);
    }
    // Judged as a whole, whatever the order: a turn whose repeats came with nothing but
    // failures and notes counts once from where the turn began (a plan or a failure inside
    // it does not reset the count).
    if (
      outcomes.includes('repeated') &&
      outcomes.every((o, k) => o === 'repeated' || o === 'failed' || (o === 'ok' && batch[k]!.action === 'plan')) &&
      (run.failures = t.startFailures + 1) >= 4
    )
      throw new Error(
        'four turns in a row could not be executed or only repeated earlier requests; the session needs a different approach',
      );
    // An action that ended the session leaves the streaks as they were.
    if (t.halted) return;
    // Changed nothing: no action ran (each was refused or repeated what the evidence shows)
    // but a plan that left the notes as they were.
    s.unchangedTurns =
      outcomes.length &&
      s.notes === notesBefore &&
      outcomes.every((o, k) => duplicates[k] || (o === 'ok' && batch[k]!.action === 'plan'))
        ? (s.unchangedTurns ?? 0) + 1
        : 0;
    s.readOnlyTurns = batch.every(b => b.action === 'read_files' || b.action === 'search_codebase')
      ? (s.readOnlyTurns ?? 0) + 1
      : 0;
  }

  // Run one action with every check the harness can make around it. Returns
  // whether it succeeded, failed, or ended the session.
  // problem: what is wrong with the call itself (an action that is not one, arguments its schema refuses). Under the
  // tools form each call is checked alone, so one bad call is refused alone; any other reply was checked whole.
  private async perform(
    s: Session,
    routeIn: Route,
    argsIn: Record<string, any>,
    thought: string,
    problem?: string,
  ): Promise<'ok' | 'failed' | 'refused' | 'repeated' | 'stop'> {
    let route = routeIn;
    let args = argsIn;
    const refuse = async (why: string, duplicate = false) => {
      this.duplicate = duplicate;
      this.observe({ kind: 'generation_error', step: s.step, message: why });
      await this.store.log('refused', { step: s.step, route, args, why });
      await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${why}` });
      return 'refused' as const;
    };
    if (problem) return refuse(problem);
    if (
      route === 'write' &&
      args.expectedHash === 'new' &&
      typeof args.path === 'string' &&
      !(await safePath(this.tools.root, args.path, true)
        .then(f => stat(f))
        .then(
          () => true,
          () => false,
        ))
    ) {
      route = 'create_file';
      args = { path: args.path, purpose: thought, content: String(args.newText ?? '') };
    }
    const key = Agent.actionKey(s, route, args);
    const exact = Agent.actionKey(s, route, args, true);
    const what = Agent.describe(route, args);
    // Blocked by exact arguments; a checkpoint from before exact keys blocked by the arguments without the hash.
    if (s.blockedActions!.includes(exact) || (!s.attempts?.[exact] && s.blockedActions!.includes(key)))
      return refuse(
        `this exact ${what} already failed the same way and Jev read the failure as unchanged; it is not run again. Change the approach.`,
        true,
      );
    const earlier = s.actions[key];
    const paths = Agent.targets(route, args);
    const now = paths.length ? await this.diskHashes(paths) : {};
    const prior = paths.length ? s.attempts?.[exact] : undefined;
    const state = (h: Record<string, string | null>) =>
      paths.map(p => `${p} ${h[p] === null || h[p] === undefined ? 'absent' : `sha256=${h[p]}`}`).join(', ');
    const same = (x: Record<string, string | null>, y: Record<string, string | null>) =>
      paths.every(p => (x[p] ?? null) === (y[p] ?? null));
    const shown = (step: number) =>
      s.entries.some(e => e.step === step && e.kind !== 'turn')
        ? `its result is in the evidence (e${step})`
        : 'its result has left the evidence';
    // An edit asked for with exactly the arguments of an earlier run, file hash included,
    // repeats that run when the files show it: one that succeeded, on files as it left them
    // (or changed since only by the harness's own later edits), would apply its change a
    // second time (an insertion doubles, a deletion takes the next line); one the tool
    // refused for what the file's text is (a stale hash, an anchor, a guard) would be refused
    // the same way while the files are unchanged. Anything else runs: other arguments are
    // another request, a file restored to what the edit found takes it again, and a
    // generated file (create_file without content, rewrite_file) differs on every run.
    const generated =
      (route === 'create_file' && !(typeof args.content === 'string' && args.content.trim())) ||
      (route === 'rewrite_file' && !(s.form === 'tools' && typeof args.content === 'string'));
    if (prior && !generated) {
      const files = paths.length > 1 ? 'these files' : paths[0]!;
      if (prior.ok && !same(now, prior.before)) {
        const later = same(now, prior.after) ? [] : Agent.editsSince(s, paths, prior, now);
        if (later)
          return refuse(
            `the ${what} was applied at step ${prior.step} with these same arguments, and ${later.length ? `since then ${files} changed only by ${later.map(a => `the ${a.what} at step ${a.step}`).join(', ')}` : `${files} ${paths.length > 1 ? 'are' : 'is'} as it left them`} (${state(now)}): running it again would apply it a second time. ${shown(prior.step)[0]!.toUpperCase()}${shown(prior.step).slice(1)}.`,
            true,
          );
      }
      if (!prior.ok && textFailure.test(prior.error ?? '') && same(now, prior.after))
        return refuse(
          `this exact ${what} ran at step ${prior.step} and failed (${clip(prior.error ?? '', 200)}); ${files} ${paths.length > 1 ? 'are' : 'is'} unchanged since (${state(now)}), so the same arguments would fail the same way`,
          true,
        );
    } else if (
      (route === 'read_files' || route === 'search_codebase') &&
      earlier !== undefined &&
      (route === 'read_files' || s.entries.some(e => e.step === earlier && e.kind === route)) &&
      !(
        route === 'read_files' && (args.files as { path: string }[]).some(f => (s.writeSteps[f.path] ?? -1) > earlier)
      ) &&
      !(route === 'search_codebase' && (s.lastWriteStep > earlier || s.lastCheckStep > earlier))
    ) {
      // The same arguments failed then, and nothing they name has changed since: they would fail the same way.
      const failed = s.entries.find(e => e.step === earlier && e.kind === route && e.text.startsWith('Tool error'));
      if (failed)
        return refuse(
          `this exact ${route} failed at step ${earlier} (${clip(failed.text.split('\n')[0]!.replace(/^Tool error: /, ''), 200)}) and nothing it names has changed since, so it would fail the same way; the error is e${earlier}`,
          true,
        );
      return this.repeat(s, route, args, earlier, thought);
    }
    // A command that succeeded, run again with nothing written or installed since
    // and its output still shown, prints the same thing: it is not run again.
    if (route === 'bash') {
      const ran = s.commandRuns?.[String(args.command ?? '').trim()];
      if (ran?.ok && ran.world === Agent.world(s) && s.entries.some(e => e.step === ran.step && e.kind === 'bash'))
        return refuse(
          `this exact command already ran at step ${ran.step} and nothing has been written or installed since, so it would print the same output, which is in the evidence (e${ran.step}); act on that output or run something different`,
          true,
        );
    }
    s.actions[key] = s.step;
    const step = s.step;
    const outcome = await this.act(s, route, args, thought);
    // Recorded after it ran, with what it found and what it left; a refusal inside the
    // action (a generation that failed, a create over an existing file) is a failed run.
    if (paths.length && outcome !== 'stop') {
      const attempt: EditAttempt = {
        step,
        ok: outcome === 'ok',
        exact,
        what,
        ...(typeof args.expectedHash === 'string' ? { sent: args.expectedHash } : {}),
        ...(outcome === 'ok'
          ? {}
          : { error: (s.lastError ?? '').split('\n')[0]!.replace(/^(Tool error|No action executed): /, '') }),
        before: now,
        after: await this.diskHashes(paths),
      };
      (s.attempts ??= {})[exact] = attempt;
      if (attempt.ok)
        for (const p of paths)
          if (attempt.after[p] !== attempt.before[p])
            (s.writers ??= {})[p] = { step, what, exact, sha: attempt.after[p] ?? null };
    }
    return outcome;
  }
  // A read or a search asked again while its answer is still in the evidence has no side
  // effect to prevent, so nothing stops: the batch goes on. What the request asks that the
  // evidence does not show at the file's current hash (lines a read budget or a clip cut
  // off, a file changed outside the harness) is read now, and only that; when the evidence
  // already shows all of it, the answer is where: the entries, the lines, the hash. A line
  // longer than any read shows whole is cut by every read, so it is stated, never read again.
  private async repeat(
    s: Session,
    route: 'read_files' | 'search_codebase',
    args: Record<string, any>,
    earlier: number,
    thought: string,
  ): Promise<'ok' | 'failed' | 'refused' | 'repeated' | 'stop'> {
    if (route === 'search_codebase')
      return this.answer(
        s,
        route,
        args,
        earlier,
        [`e${earlier}`],
        [],
        `This search_codebase has the same arguments as the search of step ${earlier} (${args.mode} ${JSON.stringify(String(args.query ?? ''))} in ${args.path}), and the harness has recorded no write and no check since; its result is e${earlier}. It was not run again.`,
      );
    const where: string[] = [];
    const missing: { path: string; start: number; end: number }[] = [];
    const cited = new Set<string>();
    const files = args.files as { path: string; start: number; end: number }[];
    // Each file as read_files reads it (the same decoding, so the same sha256); an archived output never changes.
    const texts = new Map<string, string | null>();
    for (const p of new Set(files.map(f => f.path)))
      texts.set(
        p,
        await (
          p.startsWith('@artifact/')
            ? safePath(this.tools.artifacts, p.slice(10)).then(f => boundedRead(f, 8 * 1024 * 1024))
            : safePath(this.tools.root, p).then(f => boundedRead(f))
        ).catch(() => null),
      );
    for (const f of files) {
      const text = texts.get(f.path) ?? null;
      if (text === null) {
        missing.push({ path: f.path, start: f.start, end: f.end });
        continue;
      }
      const lines = text.split('\n');
      const sha = f.path.startsWith('@artifact/') ? undefined : hash(text);
      const { by } = shownLines(s, f.path, sha);
      const want = Array.from(
        { length: Math.max(0, Math.min(f.end, lines.length) - f.start + 1) },
        (_, k) => f.start + k,
      );
      // The most of one line a read shows: a read of that range alone (read_files' own budget).
      const budget = Math.max(400, this.config.toolChars - f.path.length - 240);
      // Measured as a read shows it: with its "n: " prefix.
      const width = (n: number) => `${n}: ${lines[n - 1]}`.length;
      const long = want.filter(n => !by.has(n) && width(n) > budget);
      for (const [a, b] of lineRanges(want.filter(n => !by.has(n) && !long.includes(n))))
        missing.push({ path: f.path, start: a, end: b });
      const runs: string[] = [];
      for (const [a, b] of lineRanges(want.filter(n => by.has(n)))) {
        let from = a;
        for (let n = a + 1; n <= b + 1; n++)
          if (n > b || by.get(n) !== by.get(from)) {
            runs.push(`${from}..${n - 1} in ${by.get(from)}`);
            cited.add(by.get(from)!);
            from = n;
          }
      }
      const parts = [
        ...(!want.length ? [`no line in ${f.start}..${f.end}`] : []),
        ...(runs.length ? [`lines ${runs.join(', ')}`] : []),
        ...(long.length
          ? [
              `${long.length > 1 ? 'lines' : 'line'} ${long.map(n => `${n} (${width(n)} characters with its number)`).join(', ')} ${long.length > 1 ? 'are' : 'is'} longer than a read shows whole (${budget} characters), so every read of ${long.length > 1 ? 'them' : 'it'} shows ${long.length > 1 ? 'their' : 'its'} two ends only`,
            ]
          : []),
      ];
      if (parts.length)
        where.push(`${f.path}${sha ? ` sha256=${sha}` : ''} (${lines.length} lines): ${parts.join('; ')}`);
    }
    if (!missing.length)
      return this.answer(
        s,
        route,
        args,
        earlier,
        [...cited],
        where,
        `This read_files repeats the request of step ${earlier}; for the file${where.length > 1 ? 's' : ''} as ${where.length > 1 ? 'they are' : 'it is'} now, the evidence already shows every requested line that a read shows whole: ${where.join('; ')}. Nothing was read again.`,
      );
    // The rest of the request, read as any read is, under a fresh read budget. The entries the
    // statement names stay as they are (this read does not supersede them, nor evict them).
    // The rest is read one contiguous range per file (the first gap): gaps left by eviction
    // are read in whole pages, never as many slivers sharing one read budget.
    const firstGaps = missing.filter((m, k) => missing.findIndex(x => x.path === m.path) === k);
    await this.store.log('repeated', { step: s.step, route, args, earlier, shown: where, read: firstGaps });
    // The lines some read of this run returned before this one, at each file's current hash
    // (taken now: this read adds to the same record).
    const coveredBefore = new Map(
      firstGaps.map(m => {
        const t = texts.get(m.path);
        const ranges =
          t && !m.path.startsWith('@artifact/')
            ? s.coverageByHash[`${m.path}@${hash(t)}`]?.ranges.map(r => [...r] as [number, number])
            : undefined;
        return [m.path, ranges ?? []] as const;
      }),
    );
    const step = s.step;
    this.citing = [...cited];
    let outcome: Awaited<ReturnType<Agent['act']>>;
    try {
      outcome = await this.act(s, 'read_files', { files: firstGaps }, thought);
    } finally {
      this.citing = [];
    }
    s.actions[Agent.actionKey(s, 'read_files', { files: firstGaps })] = step;
    const e = s.entries.at(-1);
    // A rest that failed (a file removed outside the harness) is the request failing: the next
    // identical request finds this failure and is refused with it, and this turn counts.
    if (outcome === 'failed') {
      s.actions[Agent.actionKey(s, 'read_files', args)] = step;
      return 'repeated';
    }
    if (e?.step === step && e.kind === 'read_files')
      e.text += `\nHarness: this repeats the read_files of step ${earlier}; ${where.length ? `at this step the evidence showed ${where.join('; ')}, so ` : ''}only ${firstGaps.map(m => `${m.path} ${m.start}..${m.end}`).join(', ')} ${firstGaps.length > 1 ? 'were' : 'was'} read${
        missing.length > firstGaps.length
          ? ` (the first gap of each file; ${missing
              .filter(m => !firstGaps.includes(m))
              .map(m => `${m.path} ${m.start}..${m.end}`)
              .join(', ')} not yet)`
          : ''
      }.`;
    // Progress is a read that makes the evidence show the whole request again (a re-read after
    // eviction, the rest of a clipped read), or one that returned lines no read of this run
    // returned before (the first pass through a file larger than a read). A read the budget cut
    // that returned only lines read before is the same request cycling through a file larger
    // than the evidence: no progress, so four of them end the attempt.
    const restored =
      missing.length === firstGaps.length &&
      firstGaps.every(m => {
        const t = texts.get(m.path);
        const shown = shownLines(s, m.path, m.path.startsWith('@artifact/') || !t ? undefined : hash(t)).by;
        for (let n = m.start; n <= m.end; n++) if (shown.get(n) !== e?.id) return false;
        return true;
      });
    // Judged by the lines this read showed whole, not by the range asked: a large range always
    // holds lines never read, but a read budget shows only its first page.
    const newlyShown = firstGaps.some(m => {
      const t = texts.get(m.path);
      if (m.path.startsWith('@artifact/') || !t) return true;
      const shown = shownLines(s, m.path, hash(t)).by;
      const was = coveredBefore.get(m.path) ?? [];
      for (let n = m.start; n <= m.end; n++)
        if (shown.get(n) === e?.id && !was.some(([a, b]) => n >= a && n <= b)) return true;
      return false;
    });
    if (outcome === 'ok' && !restored && !newlyShown) return 'repeated';
    // A read that showed none of those lines whole added nothing to the evidence: it counts as a repeat.
    if (
      outcome === 'ok' &&
      !firstGaps.some(m => {
        const t = texts.get(m.path);
        const { by } = shownLines(s, m.path, m.path.startsWith('@artifact/') || !t ? undefined : hash(t));
        for (let n = m.start; n <= m.end; n++) if (by.get(n) === e?.id) return true;
        return false;
      })
    )
      return 'repeated';
    return outcome;
  }
  // The statement that answers a repeat, as evidence of its own, marked when an entry it names
  // leaves. Each turn that repeats a request keeps its own statement, an identical one included:
  // a turn of repeats leaves the prompt, so its statement is the one record that the request was
  // made again, and one that replaced the previous turn's copy left the prompt as it was but for
  // a step number (run 58, steps 54 and 55: the same turn came back word for word). Within one
  // turn an identical statement replaces the earlier one (nothing after it is cached yet).
  private async answer(
    s: Session,
    route: 'read_files' | 'search_codebase',
    args: Record<string, any>,
    earlier: number,
    cites: string[],
    shown: string[],
    text: string,
  ): Promise<'repeated'> {
    await this.store.log('repeated', { step: s.step, route, args, earlier, shown });
    const copy = s.entries
      .map(e => e.kind === 'repeat' && e.text === text && Boolean(s.currentTurn) && e.turn === s.currentTurn)
      .lastIndexOf(true);
    if (copy >= 0) s.entries.splice(copy, 1);
    this.citing = cites;
    try {
      await this.evidence(s, 'repeat', { ok: true, text });
    } finally {
      this.citing = [];
    }
    const e = s.entries.at(-1);
    if (e?.kind === 'repeat') e.relevance = 0.2;
    this.observe({ kind: 'result', step: s.step, route, ok: true, ms: 0, chars: text.length, text: clip(text, 200) });
    return 'repeated';
  }
  private async act(s: Session, route: Route, args: Record<string, any>, thought: string): Promise<Outcome> {
    switch (route) {
      case 'plan':
        return this.actPlan(s, args);
      case 'observe':
        return this.actObserve(s, route, args);
      case 'ask_user':
        return this.actAskUser(s, args);
      case 'finish':
        return this.actFinish(s, args);
      case 'create_file':
      case 'rewrite_file':
        return this.actWriteFile(s, route, args, thought);
      case 'bash':
        return this.actBash(s, args);
      default:
        return this.actTool(s, route, args);
    }
  }
  // An action that is not run: the reason is the evidence, and a duplicate of an earlier refusal is marked so.
  private async refuseAction(
    s: Session,
    route: Route,
    args: Record<string, any>,
    why: string,
    duplicate = false,
  ): Promise<'refused'> {
    this.duplicate = duplicate;
    this.observe({ kind: 'generation_error', step: s.step, message: why });
    await this.store.log('refused', { step: s.step, route, args, why });
    await this.evidence(s, 'generation_error', { ok: false, text: `No action executed: ${why}` });
    return 'refused' as const;
  }
  private async actPlan(s: Session, args: Record<string, any>): Promise<Outcome> {
    s.notes = clip(String(args.notes ?? ''), 4000);
    await this.store.log('plan', { step: s.step, notes: s.notes });
    await this.evidence(s, 'plan', { ok: true, text: `Notes updated (${s.notes.split('\n').length} lines).` });
    return 'ok';
  }
  private async actObserve(s: Session, route: Route, args: Record<string, any>): Promise<Outcome> {
    if (!this.config.allowBash)
      return this.refuseAction(s, route, args, 'observe needs --allow-bash (it starts and runs what it observes).');
    const kind = String(args.kind ?? '');
    const start = String(args.start ?? '');
    const target = String(args.target ?? '');
    const artifactPath = join(this.store.artifacts, `${String(s.step).padStart(5, '0')}-observe.png`);
    const prefix = await shellPrefixFor(this.tools.root).catch(() => '');
    const inputs = Array.isArray(args.inputs)
      ? (args.inputs as any[])
          .filter(i => i && typeof i === 'object')
          .map(i => ({ do: String(i.do) as any, what: String(i.what ?? ''), ms: Number(i.ms) || 0 }))
      : [];
    const r = await observeResult(kind, start, target, {
      root: this.tools.root,
      artifactPath,
      timeoutMs: this.config.commandTimeoutMs,
      prefix,
      files: s.knownFiles,
      inputs,
    });
    await this.store.log('observe', {
      step: s.step,
      kind,
      start,
      target,
      ...(inputs.length ? { inputs } : {}),
      ok: r.ok,
      text: clip(r.text, 4000),
    });
    s.lastObservation = { step: s.step, kind, ok: r.ok, target, text: clip(r.text, 2600) };
    await this.evidence(s, 'observe', { ok: r.ok, text: r.text }, args);
    this.observe({
      kind: 'result',
      step: s.step,
      route,
      ok: r.ok,
      ms: 0,
      chars: r.text.length,
      text: clip(r.text, 200),
    });
    return r.ok ? 'ok' : 'failed';
  }
  private async actAskUser(s: Session, args: Record<string, any>): Promise<Outcome> {
    s.status = 'paused';
    s.stopReason = String(args.question ?? 'The worker needs a decision from the user.');
    await this.store.log('ask', { step: s.step, question: s.stopReason });
    return 'stop';
  }

  // The worker's completion claim: refused before the gate when the check of record does not stand, else judged
  // by the gate of a change or, with nothing written, checked or observed, the gate of an answer.
  private async actFinish(s: Session, args: Record<string, any>): Promise<Outcome> {
    const blocked = this.finishBlocked(s);
    if (blocked) return this.refuseAction(s, 'finish', args, blocked.why, blocked.again);
    // Nothing written, checked or observed: the finish is an answer, judged against what the worker
    // read (see answerGate). A check or an observation is evidence the gate of a change reads.
    const answer = s.lastWriteStep < 0 && !s.lastCheck && !s.lastObservation;
    const summary = String(args.summary ?? '');
    const verdict = answer ? await this.judgeAnswer(s, summary) : await this.judgeChange(s, summary);
    await this.store.log('completion', { step: s.step, ...verdict });
    this.observe({
      kind: 'jev',
      step: s.step,
      ms: 0,
      questions: 4,
      stateBytes: 0,
      route: [[verdict.route, 1]],
      nouls: { matches: verdict.matches, unaddressed: verdict.unaddressed, supported: verdict.supported },
    });
    return this.settleFinish(s, summary, verdict, answer);
  }
  // Why a finish is refused before the gate runs, or null. A check of record that failed after the last write,
  // or none at all, is a rejection the gate makes from code whatever Jev reads, so it is stated before the gate
  // runs, with what decides it: which command the check of record is and how it is replaced. The same finish on
  // the same state is a duplicate (again), so a streak of them raises the sampling temperature and ends at four
  // in a row. (Run dk-country-3: the check of record was a throwaway Node mock that failed; told only "the
  // verification did not pass after the last edit", the worker finished the same way 40 times.)
  // With nothing written there is nothing for a check to verify: a read-only objective goes to the
  // gate on what was read. (A review that changed nothing was refused six times, then paused as stuck.)
  private finishBlocked(s: Session): { why: string; again: boolean } | null {
    if (s.lastCheckCommand && s.lastWriteStep > (s.lastCheck?.step ?? -1))
      return { why: `${s.lastCheckCommand} has not run since the last edit; run it, then finish.`, again: false };
    if (!((!s.lastCheck && s.lastWriteStep >= 0) || s.lastCheck?.ok === false)) return null;
    const c = s.lastCheck;
    const quote = (x?: string) => `\`${clip((x ?? '').replace(/\s+/g, ' '), 120)}\``;
    const passed =
      s.lastPassedCheck && s.lastPassedCheck.step > s.lastWriteStep && s.lastPassedCheck.step !== c?.step
        ? ` The last check that exited 0 was step ${s.lastPassedCheck.step}'s ${quote(s.lastPassedCheck.command)}, after that write; a later check replaced it.`
        : '';
    const state = `${c?.step ?? -1}:${s.lastWriteStep}`;
    const again = s.finishRefused === state;
    s.finishRefused = state;
    return {
      why: `finish was not judged: the check of record ${c ? `failed (step ${c.step}, ${quote(c.command ?? s.lastCheckCommand ?? '')}, exit ${c.summary.code ?? 'unknown'})` : 'has never run: no bash command has been run with check: true in this session'}. Finish is judged once the check of record exits 0 after the last write${s.lastWriteStep >= 0 ? ` (step ${s.lastWriteStep})` : ''}; the check of record is the last bash command run with check: true, so each one replaces the one before.${passed}${again ? ` This finish was refused at the same state before (nothing has been written or checked since).` : ''}`,
      again,
    };
  }
  private async judgeAnswer(s: Session, summary: string): Promise<GateVerdict> {
    const evidence = answerEvidence(s);
    const coverage = await answerCoverage(s);
    await this.store.log('completion-facts', {
      step: s.step,
      facts: {
        answer: true,
        summary: clip(summary, 1500),
        evidence: Object.keys(evidence),
        read: coverage.read,
        unread: coverage.unread.length,
        files: coverage.files,
      },
    });
    return answerGate(this.jev, s, summary, evidence, coverage);
  }
  private async judgeChange(s: Session, summary: string): Promise<GateVerdict> {
    const facts = await this.completionFacts(s, summary);
    await this.store.log('completion-facts', {
      step: s.step,
      facts: { ...facts, sources: Object.keys(facts.sources as object) },
    });
    return evidenceGate(this.jev, s, facts);
  }
  // What a verdict does: an accepted finish completes the session; a third answer not accepted, or a claim Jev
  // routes to the user, pauses it for review; any other rejection goes back to the worker as feedback.
  private async settleFinish(s: Session, summary: string, verdict: GateVerdict, answer: boolean): Promise<Outcome> {
    if (verdict.accepted) {
      s.status = 'complete';
      ending(s, 'Complete: ', summary, 400);
      return 'stop';
    }
    // An answer has no check or observation left to settle it: after answerReviews rejections it goes to the user,
    // whose question it is, with Jev's readings, rather than round again. (Run 40c9a982: 45 answers to "form deep
    // insights" rejected with flat readings, unaddressed near 0.8, while all 61 files had been read.)
    if (answer && (s.answerRejections = (s.answerRejections ?? 0) + 1) >= answerReviews) {
      s.status = 'paused';
      ending(
        s,
        `Answer proposed; Jev did not accept it in ${answerReviews} readings (last: matches ${verdict.matches.toFixed(2)}, unanswered ${verdict.unaddressed.toFixed(2)}, supported ${verdict.supported.toFixed(2)}), so it goes to you for review; resume with guidance to continue: `,
        summary,
        400,
      );
      return 'stop';
    }
    if (verdict.route === 'human') {
      s.status = 'paused';
      ending(s, 'Completion proposed; Jev routes it to the user for review: ', summary, 400);
      return 'stop';
    }
    s.completionFeedback = {
      step: s.step,
      text: `The completion proposed at step ${s.step} was not accepted: ${verdict.reason}. ${answer ? 'Address it' : 'Address it, verify,'} and finish again.`,
      awaitingEvidence: true,
    };
    await this.evidence(s, 'completion', { ok: false, text: s.completionFeedback.text });
    return 'failed';
  }

  private async actWriteFile(s: Session, route: Route, args: Record<string, any>, thought: string): Promise<Outcome> {
    // Under the tools form the content is the model's own, written in its call; it is written as generated content is, with the same facts.
    const given = s.form === 'tools' && typeof args.content === 'string' ? args.content : undefined;
    try {
      if (given === undefined && route === 'create_file' && typeof args.content === 'string' && args.content.trim())
        await this.execute(s, 'create_file', { path: args.path, content: args.content }, 'write-as-create');
      else
        await this.createFile(
          s,
          String(args.path),
          String(args.purpose ?? ''),
          thought,
          route === 'rewrite_file',
          { start: args.start, end: args.end },
          Agent.actionKey(s, route, args, true),
          given,
        );
    } catch (e) {
      return this.refuseAction(s, route, args, (e as Error).message, (e as { duplicate?: boolean }).duplicate === true);
    }
    return s.lastResultOk ? 'ok' : 'failed';
  }
  // A command the worker marks as its verification is the check of record from then on; its result is judged
  // like any check. A failure is triaged by Jev: a transient one is retried once by code, a permission one goes
  // to the user, any other is stated to the worker.
  private async actBash(s: Session, args: Record<string, any>): Promise<Outcome> {
    const command = String(args.command).trim();
    const isCheck = args.check === true || command === s.lastCheckCommand;
    let result = await this.execute(s, 'bash', { ...args, command, ...(isCheck ? { check: true } : {}) }, 'action');
    if (!result.ok) {
      const output = (() => {
        try {
          return String(JSON.parse(result.text).output ?? result.text);
        } catch {
          return result.text;
        }
      })();
      const kind = await triage(this.jev, s, command, output).catch(() => ({
        kind: 'unknown' as const,
        probability: 0,
      }));
      await this.store.log('triage', { step: s.step, command: clip(command, 200), ...kind });
      if (kind.kind === 'transient' && kind.probability >= 0.7) {
        result = await this.execute(s, 'bash', { ...args, command, ...(isCheck ? { check: true } : {}) }, 'auto-retry');
        if (!result.ok) s.blockedActions!.push(Agent.actionKey(s, 'bash', args, true));
      } else if (kind.kind === 'permission' && kind.probability >= 0.7) {
        s.status = 'paused';
        s.stopReason = `The command needs the user: ${clip(command, 200)}\n${clip(output, 500)}`;
        return 'stop';
      } else {
        const e = s.entries.at(-1);
        if (e) e.text += `\nJev reads this failure as: ${kind.kind} (${failureKindText(kind.kind)}).`;
      }
    }
    return result.ok ? 'ok' : 'failed';
  }
  // Any other tool. Many search hits: Jev keeps the ones that matter for what the worker is doing.
  private async actTool(s: Session, route: Route, args: Record<string, any>): Promise<Outcome> {
    const result = await this.execute(s, route, args, 'action');
    if (route === 'search_codebase' && result.ok) {
      let output = '';
      try {
        output = String(JSON.parse(result.text).output ?? '');
      } catch {
        output = result.text;
      }
      const lines = output.split('\n').filter(Boolean);
      if (lines.length > 12) {
        const ranked = await rankExcerpts(this.jev, s, String(args.query), lines).catch(() => null);
        if (ranked) {
          const e = s.entries.at(-1);
          if (e)
            e.text = `${ranked.kept.join('\n')}\n(${ranked.dropped} further hits omitted as less relevant; search narrower to see them)`;
          await this.store.log('retrieval-rank', { step: s.step, kept: ranked.kept.length, dropped: ranked.dropped });
        }
      }
    }
    return result.ok ? 'ok' : 'failed';
  }
  // One watchdog reading after each meaningful action; the policy that acts on it is deterministic and lives in the loop.
  private async watch(s: Session): Promise<void> {
    const t0 = performance.now();
    let reading;
    try {
      reading = await watchdog(this.jev, s);
    } catch (e) {
      await this.store.log('watchdog-error', { step: s.step, error: (e as Error).message });
      return;
    }
    s.watch!.readings = [...s.watch!.readings.slice(-19), reading];
    if (reading.progress < 0.3) s.watch!.noProgress++;
    else s.watch!.noProgress = 0;
    // The same failure again, with nothing changed: the identical action is not run a third time.
    // Blocked by its exact arguments: the same edit sent with a corrected hash is another action.
    if (reading.sameFailure >= 0.9 && s.lastRoute && !s.lastResultOk) {
      const attempt = Object.values(s.attempts ?? {}).find(a => a.step === s.step);
      const key = attempt ? attempt.exact : Object.entries(s.actions).find(([, step]) => step === s.step)?.[0];
      if (key && !s.blockedActions!.includes(key)) s.blockedActions!.push(key);
    }
    await this.store.log('watchdog', { ...reading, noProgress: s.watch!.noProgress, ms: performance.now() - t0 });
    this.observe({
      kind: 'jev',
      step: s.step,
      ms: performance.now() - t0,
      questions: 6,
      stateBytes: 0,
      route: [],
      nouls: {
        progress: reading.progress,
        stuck: reading.stuck,
        same_failure: reading.sameFailure,
        objective: reading.objective,
        needs_user: reading.needsUser,
        in_scope: reading.inScope,
      },
    });
  }
}
// The block of a file a rewrite regenerates: lines start..end (end = start - 1 inserts before start); lines is
// set to the number of lines the generated block holds once it is spliced in.
interface Region {
  start: number;
  end: number;
  lines?: number;
}
// A file's content as generated (or as the model wrote it in its call), how the generation ended, and the request
// it answered (empty for content the model wrote).
interface Generated {
  code: string;
  finish: string;
  cut?: GenerationCut;
  ms?: number;
  tokens?: number;
  request: string;
}
// The lines of an existing file a rewrite's range names, checked against the file and against the version the
// worker last saw.
function regionOf(
  s: Session,
  path: string,
  current: string,
  lines: string[],
  range: { start?: unknown; end?: unknown },
): Region {
  const start = Math.min(
    Math.max(1, typeof range.start === 'number' ? range.start : lines.length + 1),
    lines.length + 1,
  );
  const end = Math.min(typeof range.end === 'number' ? range.end : start - 1, lines.length);
  if (end < start - 1)
    throw new Error(
      `lines ${start}..${end} of ${path} is not a range: end must be at least start - 1 (start - 1 inserts before line start)`,
    );
  // Line numbers name a version of the file: one the worker has not seen may have moved them. Appending needs no numbers.
  const seen = s.hashes[path];
  if (start <= lines.length && seen && seen !== hash(current))
    throw new Error(
      `${path} changed since the version you last saw, so lines ${start}..${end} may no longer be the lines you mean; read it again (or append with start = totalLines + 1)`,
    );
  return { start, end };
}
// The content the model wrote in its call (the tools form), with a repeat cut as a generation's is.
function fromCall(given: string, around: Around | undefined): Generated {
  const looped = repeatCut(given, around);
  return {
    code: looped ? looped.kept : given,
    finish: looped ? 'repetition' : 'stop',
    ...(looped ? { cut: looped.cut } : {}),
    request: '',
  };
}
// The block alone, without lines around the region the model repeated, spliced between the untouched lines.
function spliceRegion(
  generated: string,
  region: Region,
  lines: string[],
  current: string,
  around: Around,
  cut: GenerationCut | undefined,
): { code: string; echo: Echo | null; blockCount: number } {
  const trimmed = trimContext(generated, around, Boolean(cut));
  // What the block repeated of the lines after the region: stopped there while it was generated, or trimmed once it ended.
  // Either way the block before the repeat is whole: the model had moved on to the lines that follow it.
  const echo =
    cut?.kind === 'echo' ? { line: cut.line, echoed: cut.echoed!, diverged: Boolean(cut.diverged) } : trimmed.echo;
  const block = trimmed.text.replace(/\n$/, '');
  const blockLines = block === '' ? [] : block.split('\n');
  const code =
    [...lines.slice(0, region.start - 1), ...blockLines, ...lines.slice(region.end)].join('\n') +
    (current.endsWith('\n') || !current ? '\n' : '');
  region.lines = blockLines.length;
  return { code, echo, blockCount: blockLines.length };
}
// A whole-file rewrite's line diff against the content it replaced, added to its result.
function noteRewriteDiff(s: Session, path: string, current: string, code: string, spent: string): void {
  const { removed, added, exact: counted } = lineDiff(current, code);
  const total = code === '' ? 0 : code.replace(/\n$/, '').split('\n').length;
  // Lines are compared without their endings: a CRLF file rewritten with LF endings is said so once.
  const endings =
    /\r\n/.test(current) && !/\r\n/.test(code)
      ? ` (compared without line endings: its CRLF line endings were written as LF)`
      : '';
  const most = counted ? '' : 'at most ';
  const least = counted ? '' : 'at least ';
  const e = s.entries.at(-1);
  if (e?.kind === 'write')
    e.text += `\nHarness: the rewrite generated every line of ${path}${spent}; compared with the content it replaced${endings}, ${most}${nLines(removed)} went, ${most}${nLines(added)} came and ${least}${nLines(total - added)} stayed as ${total - added === 1 ? 'it was' : 'they were'}.`;
}

const nLines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
// At most one call per ms milliseconds: a stream delivers 40 to 290 tokens a second, and each live event redraws the panel.
const every = <T>(ms: number, f: (x: T) => void) => {
  let last = -Infinity;
  return (x: T) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      f(x);
    }
  };
};
// What a generation cost, from the client's metadata.
const cost = (
  meta: { ms?: number; usage?: { completion_tokens?: number } } | null | undefined,
): { ms?: number; tokens?: number } => ({
  ...(typeof meta?.ms === 'number' ? { ms: meta.ms } : {}),
  ...(typeof meta?.usage?.completion_tokens === 'number' ? { tokens: meta.usage.completion_tokens } : {}),
});
// Edit failures that depend only on the arguments and the target file's text: with the
// same arguments and the file unchanged, the tool refuses them again.
const textFailure =
  /Stale file hash|oldText must match|would no longer parse|unmatched '|already contains|produced no change|Range \d+\.\.\d+ (must|exceeds)|Ranges \d+\.\.\d+ and \d+\.\.\d+ overlap|already exists|does not exist: write replaces|does not exist; use destinationHash|exists: read it and use its sha256|produced no content|is not a hash|already starts with|is blank; prepend|is an insertion/;
// The evidence's share of the working budget that triggers a batched eviction, and the share it is cut to.
// Each eviction reprocesses what it keeps, so the gap between the two sets how often that is paid:
// replayed over 28 runs at 32k, .6 against .45 halves the evictions and keeps more evidence on average.
// Cutting to .25 replayed 152 s shorter over runs 49-76 (0.8% of their time, inside the run-to-run
// spread) and takes fresh evidence more often (22% of what it evicts at .2, against 9%), which the
// replay cannot price: run 63 lost a render observation the model was acting on. So .3 stays.
// A file request too large for the peak is fitted by a forced eviction, which cuts to evictTo as well.
const evictAt = 0.6;
const evictTo = 0.3;
// The answers Jev may reject in an invocation before the last goes to the user.
const answerReviews = 3;
const failureKindText = (k: string): string =>
  (
    ({
      code_bug: 'the code or configuration written is wrong',
      wrong_assumption: 'an assumption the output disproves',
      bad_command: 'the command itself',
      environment: 'a tool or service the machine lacks',
      dependency: 'a package missing, unresolvable or at a version that does not exist',
      permission: 'permission or credentials',
      transient: 'a network or timing failure',
      insufficient_context: 'acting without reading what was needed',
      unknown: 'unclear',
    }) as Record<string, string>
  )[k] ?? k;
export { boundedRead };
// What is wrong with one call: an action that is not one of the step's, or arguments its schema refuses.
// A missing hash says the one the file has as last reported (fileHashes), when there is one.
export function argsProblem(
  action: string,
  args: Record<string, any>,
  allowed: readonly string[],
  hashes: Record<string, string> = {},
): string | undefined {
  const alt = stepSchema.anyOf!.find(a => a.properties!.action!.const === action);
  if (!alt || !allowed.includes(action))
    return `${action} is not an action of this step; the actions are ${allowed.join(', ')}`;
  try {
    validate(toolSchema(action as Route), args, `${action} arguments`);
  } catch (e) {
    const file = String(args.path ?? args.source ?? '');
    const known = hashes[file];
    const hint = /missing (expectedHash)$/.test((e as Error).message)
      ? ` (expectedHash is the sha256 of ${file || 'the file'} as last read or edited${known ? `: fileHashes has ${file} sha256=${known}` : '; read it first'})`
      : '';
    return `${(e as Error).message}${hint}`;
  }
  return undefined;
}
