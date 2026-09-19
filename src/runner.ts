import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bonsai, Jev } from './clients.js';
import { clip, compact, confidentChoice, decisionState, evictOne, mergeCoverage, messages, routeQuestions } from './context.js';
import { schemas } from './schema.js';
import { hash, listRepoFiles, StaleWriteError, ToolBox } from './tools.js';
import { Store } from './store.js';
import { editRoutes } from './types.js';
import type { Config, Phase, Route, Session, Task, ToolResult } from './types.js';

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000) throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try { instructions = await readFile(join(root, 'AGENTS.md'), 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(instructions) > 12000) throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return { version: 1, root, objective, instructions, step: 0, tasks: [], focus: null, entries: [],
    lastCompact: -100, status: 'running', stopReason: '', writes: [], lastWriteStep: -1, lastCheckStep: -1,
    phase: 'inspect', knownFiles: await listRepoFiles(root), inspectionCount: 0, lastError: null,
    lastRoute: null, lastResultOk: false, lastWriteStale: false, repetitions: {}, coverage: {} };
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
  constructor(readonly config: Config, readonly store: Store, readonly jev: Pick<Jev, 'decide'>,
    readonly bonsai: Pick<Bonsai, 'count' | 'generate'>, root: string,
    readonly progress: (message: string) => void = console.error) {
    this.tools = new ToolBox(root, store.artifacts, config);
  }
  async evidence(s: Session, kind: string, result: ToolResult): Promise<void> {
    const artifact = await this.store.artifact(s.step, result.text);
    s.entries.push({ id: `e${s.step}`, step: s.step, kind, artifact, text: clip(result.text, this.config.toolChars), relevance: result.ok ? .5 : .9 });
    if (kind === 'read_files' || kind === 'search_codebase') if (result.ok) s.inspectionCount++;
    if (kind === 'read_files' && result.ok) {
      // Remember which ranges were seen even after the text itself is evicted.
      for (const m of result.text.matchAll(/(?:^|\n\n)(\S+) sha256=\w+ totalLines=(\d+) shown=(\d+)\.\.(\d+)/g))
        if (Number(m[4]) >= Number(m[3])) s.coverage[m[1]!] = mergeCoverage(s.coverage[m[1]!], Number(m[2]), Number(m[3]), Number(m[4]));
    }
    s.lastError = result.ok ? null : result.text;
    for (const changed of result.changed ?? []) {
      if (!s.writes.includes(changed)) s.writes.push(changed);
      s.lastWriteStep = s.step;
      delete s.coverage[changed];
      // Earlier reads of this file no longer describe it. Keep them for
      // orientation but flag them so their text is not reused as an anchor.
      const header = `${changed} sha256=`;
      for (const e of s.entries) if (e.kind === 'read_files' && e.step < s.step && !e.text.startsWith('[superseded') &&
        (e.text.startsWith(header) || e.text.includes(`\n\n${header}`))) {
        e.text = `[superseded by the edit at step ${s.step}; re-read ${changed} before using its text or line numbers]\n${e.text}`;
        e.relevance = Math.min(e.relevance, .2);
      }
    }
    if (result.check) s.lastCheckStep = s.step;
    if (!result.ok && (kind === 'bash' || editRoutes.includes(kind as Route))) s.phase = 'implement';
    // Unbounded history lives in artifacts; the decision surface is strictly bounded.
    let evicted = 0;
    while (s.entries.length > 20) { evictOne(s); evicted++; }
    if (evicted) await this.store.log('compact', { step: s.step, removed: evicted, reason: 'entry-cap', retained: s.entries.length });
  }
  async run(s: Session): Promise<Session> {
    s.status = 'running'; s.stopReason = '';
    const endStep = s.step + this.config.maxSteps;
    let generationFailures = 0;
    let rejectedFinishes = 0;
    try {
      for (; s.step < endStep;) {
        s.step++;
        if (s.phase === 'inspect' && s.inspectionCount >= 3) s.phase = 'implement';
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
        const answers = await this.jev.decide(decisionState(s), questions, { step: s.step, phase: 'routing-and-context' });
        const criteria = (questions.route as { criteria: Record<string, string> }).criteria;
        let route = confidentChoice(answers.route, this.config) as Route | null;
        const completeOk = answers.complete?.type === 'noul' && answers.complete.noul >= this.config.completeProbability;
        if (route === 'finish' && !completeOk) {
          // Jev's completion estimate contradicts its route. Withdraw finish and
          // let it pick the next action instead of pausing the whole session.
          delete criteria.finish;
          const finishWithheld = `Completion probability ${answers.complete?.type === 'noul' ? answers.complete.noul : 0} is below ${this.config.completeProbability}. Choose the action that produces the evidence still missing for the objective.`;
          const again = await this.jev.decide(decisionState(s, { finishWithheld }), { route: questions.route! }, { step: s.step, phase: 'routing-without-finish' });
          route = confidentChoice(again.route, this.config) as Route | null;
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
        const removed = compact(s, this.config, answers);
        if (removed) await this.store.log('compact', { step: s.step, removed, reason: 'jev', retained: s.entries.length });
        let prompt = messages(s, route);
        let counted = await this.bonsai.count(prompt);
        let forced = 0;
        while (counted.tokens > this.config.workingTokens) {
          if (!evictOne(s)) throw new Error('Pinned objective, instructions and ledger exceed working context; reduce them or increase workingTokens');
          forced++;
          prompt = messages(s, route); counted = await this.bonsai.count(prompt);
        }
        if (forced) { s.lastCompact = s.step; await this.store.log('compact', { step: s.step, removed: forced, reason: 'hard-budget' }); }
        this.progress(`[${s.step}] ${route} · ${counted.tokens} prompt tokens · ${s.entries.length} evidence entries`);
        let args: Record<string, any>;
        try {
          args = await this.bonsai.generate(prompt, schemas[route]);
          generationFailures = 0;
        } catch (e) {
          if (++generationFailures >= 2) throw e;
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
        try {
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
        await this.evidence(s, route, result);
        await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - toolStarted, artifact: s.entries.at(-1)?.artifact });
        const signature = hash(JSON.stringify({ route, args, result: result.text }));
        const repeats = s.repetitions[signature] = (s.repetitions[signature] ?? 0) + 1;
        if (repeats >= 3) throw new Error('Repeated identical action and result three times; paused to prevent a loop');
        // Surface the first repetition to both models before the hard stop.
        if (repeats === 2) s.lastError = [`Step ${s.step} repeated an identical ${route} action with an identical result. A third identical repetition pauses the session: change the arguments or choose a different action.`,
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
    return s;
  }
}
