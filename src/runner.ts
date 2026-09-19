import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bonsai, Jev } from './clients.js';
import { clip, compact, confidentChoice, decisionState, evictOne, messages, routeQuestions } from './context.js';
import { schemas } from './schema.js';
import { hash, listRepoFiles, ToolBox } from './tools.js';
import { Store } from './store.js';
import type { Config, Phase, Route, Session, Task, ToolResult } from './types.js';

export async function newSession(root: string, objective: string): Promise<Session> {
  if (!objective.trim() || Buffer.byteLength(objective) > 6000) throw new Error('Objective must be 1..6000 UTF-8 bytes');
  let instructions = '';
  try { instructions = await readFile(join(root, 'AGENTS.md'), 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(instructions) > 12000) throw new Error('Root AGENTS.md exceeds 12 KB pinned instruction budget');
  return { version: 1, root, objective, instructions, step: 0, tasks: [], focus: null, entries: [],
    lastCompact: -100, status: 'running', stopReason: '', writes: [], lastWriteStep: -1, lastCheckStep: -1,
    phase: 'inspect', knownFiles: await listRepoFiles(root), inspectionCount: 0, lastError: null,
    lastRoute: null, lastResultOk: false, repetitions: {} };
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
    s.lastError = result.ok ? null : result.text;
    if (result.changed) {
      if (!s.writes.includes(result.changed)) s.writes.push(result.changed);
      s.lastWriteStep = s.step;
    }
    if (result.check) s.lastCheckStep = s.step;
    if (!result.ok && (kind === 'bash' || kind === 'write')) s.phase = 'implement';
    // Unbounded history lives in artifacts; the decision surface is strictly bounded.
    let evicted = 0;
    while (s.entries.length > 20) { evictOne(s); evicted++; }
    if (evicted) await this.store.log('compact', { step: s.step, removed: evicted, reason: 'entry-cap', retained: s.entries.length });
  }
  async run(s: Session): Promise<Session> {
    s.status = 'running'; s.stopReason = '';
    const endStep = s.step + this.config.maxSteps;
    let generationFailures = 0;
    try {
      for (; s.step < endStep;) {
        s.step++;
        if (s.phase === 'inspect' && s.inspectionCount >= 3) s.phase = 'implement';
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
        const route = confidentChoice(answers.route, this.config) as Route | null;
        if (!route || !Object.hasOwn((questions.route as { criteria: object }).criteria, route))
          throw new Error('Jev route is uncertain; paused without executing an action');
        // The worker can batch related writes. Only enter verify after it has
        // selected the validation action, so a stale readiness judgement never
        // turns a write into an implementation action in the verify phase.
        if (s.phase === 'implement' && route === 'bash' && s.writes.length > 0 &&
          answers.ready_for_verify?.type === 'noul' && answers.ready_for_verify.noul >= .8)
          s.phase = 'verify';
        if (route === 'finish' && !(answers.complete?.type === 'noul' && answers.complete.noul >= this.config.completeProbability))
          throw new Error('Jev completion evidence is insufficient; paused for review');
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
        } catch (e) { result = { ok: false, text: `Tool error: ${(e as Error).message}` }; }
        s.lastRoute = route; s.lastResultOk = result.ok;
        await this.evidence(s, route, result);
        await this.store.log('result', { step: s.step, ok: result.ok, ms: performance.now() - toolStarted, artifact: s.entries.at(-1)?.artifact });
        const signature = hash(JSON.stringify({ route, args, result: result.text }));
        s.repetitions[signature] = (s.repetitions[signature] ?? 0) + 1;
        if (s.repetitions[signature]! >= 3) throw new Error('Repeated identical action and result three times; paused to prevent a loop');
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
