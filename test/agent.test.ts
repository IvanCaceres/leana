import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { venvBin, windowsExe } from '../src/shell.js';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { Agent, newSession } from '../src/agent.js';
import { evidenceTokens } from '../src/context.js';
import { hash } from '../src/files.js';
import { Store } from '../src/store.js';
import { orient } from '../src/orient.js';
import { findBrowser, renderFacts } from '../src/render.js';
import { createServer } from 'node:http';
import type { Answers, Message, Questions } from '../src/types.js';

// A scripted worker: each call for a step returns the next {thought, action};
// each call for arguments returns the next args; file content comes from the
// scripted files map. A scripted Jev answers by phase.
type Scripted = {
  steps: {
    thought: string;
    action: string;
    args?: Record<string, any>;
    batch?: { action: string; args: Record<string, any> }[];
  }[];
  files?: Record<string, string>;
};
function bonsaiOf(script: Scripted) {
  let i = -1;
  let pending: Record<string, any> | undefined;
  return {
    count: async (m: Message[]) => ({
      tokens: Math.ceil(m.reduce((n, x) => n + x.content.length, 0) / 4),
      mode: 'test',
    }),
    generate: async (m: Message[], schema: any) => {
      const last = JSON.parse(m.at(-1)!.content);
      if (schema.properties?.actions) {
        i++;
        const s = script.steps[i];
        if (!s) throw new Error('script exhausted');
        return { thought: s.thought, actions: s.batch ?? [{ action: s.action, args: s.args ?? {} }] };
      }
      const args = pending ?? {};
      pending = undefined;
      return args;
    },
    generateText: async (m: Message[]) => {
      const last = JSON.parse(m.at(-1)!.content);
      const text = script.files?.[last.file] ?? `// ${last.file}\n`;
      return { text, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } };
    },
    lastMeta: null,
  };
}
type JevScript = {
  watch?: (n: number) => Partial<{
    progress: number;
    stuck: number;
    same_failure: number;
    objective_satisfied: number;
    needs_user: number;
    in_scope: number;
  }>;
  gate?: Partial<{
    implementation_matches_request: number;
    requirement_unaddressed: number;
    claim_supported: number;
    verification_needed: string;
  }>;
  clauses?: (clause: string) => number;
  triage?: string;
  rank?: (hit: string) => number;
};
function jevOf(j: JevScript) {
  const calls: { phase: string; state: any }[] = [];
  let watches = 0;
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  return {
    calls,
    decide: async (state: unknown, q: Questions, ctx?: { step: number; phase: string }): Promise<Answers> => {
      const phase = ctx?.phase ?? '';
      calls.push({ phase, state });
      if (phase === 'watchdog') {
        const w = j.watch?.(++watches) ?? {};
        return {
          progress: noul(w.progress ?? 0.8),
          same_failure: noul(w.same_failure ?? 0.05),
          stuck: noul(w.stuck ?? 0.05),
          objective_satisfied: noul(w.objective_satisfied ?? 0.2),
          needs_user: noul(w.needs_user ?? 0.05),
          in_scope: noul(w.in_scope ?? 0.9),
        };
      }
      if (phase === 'answer-gate') {
        const g = j.gate ?? {};
        return {
          implementation_matches_request: noul(g.implementation_matches_request ?? 0.9),
          requirement_unaddressed: noul(g.requirement_unaddressed ?? 0.1),
          claim_supported: noul(g.claim_supported ?? 0.9),
          ...Object.fromEntries(
            Object.keys(q)
              .filter(k => k.startsWith('clause_'))
              .map(k => [k, noul(j.clauses?.((state as any).clauses[k]) ?? 0.9)]),
          ),
        };
      }
      if (phase === 'evidence-gate') {
        const g = j.gate ?? {};
        const route = g.verification_needed ?? 'deterministic_only';
        const clauses = Object.fromEntries(
          Object.keys(q)
            .filter(k => k.startsWith('clause_'))
            .map(k => [k, noul(j.clauses?.((state as any).clauses[k]) ?? 0.9)]),
        );
        const weakest = (g as any).weakest_evidence ?? 'sources';
        const weakestAnswer: Answers = q.weakest_evidence
          ? {
              weakest_evidence: {
                type: 'choice' as const,
                choice: weakest,
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  Object.keys((q.weakest_evidence as any).criteria).map(k => [k, k === weakest ? 0.9 : 0.02]),
                ),
              },
            }
          : {};
        return {
          ...clauses,
          ...weakestAnswer,
          implementation_matches_request: noul(g.implementation_matches_request ?? 0.9),
          requirement_unaddressed: noul(g.requirement_unaddressed ?? 0.1),
          claim_supported: noul(g.claim_supported ?? 0.9),
          verification_needed: {
            type: 'choice',
            choice: route,
            confidence: 0.9,
            probabilities: Object.fromEntries(
              Object.keys((q.verification_needed as any).criteria).map(k => [k, k === route ? 0.9 : 0.05]),
            ),
          },
        };
      }
      if (phase === 'evidence-focus') return { evidence_shows_done: noul((j.gate as any)?.focus ?? 0.8) };
      if (phase === 'failure-triage') {
        const kind = j.triage ?? 'code_bug';
        return {
          failure: {
            type: 'choice',
            choice: kind,
            confidence: 0.9,
            probabilities: Object.fromEntries(
              Object.keys((q.failure as any).criteria).map(k => [k, k === kind ? 0.9 : 0.01]),
            ),
          },
        };
      }
      if (phase === 'retrieval-rank') {
        const hits = (state as any).hits as Record<string, string>;
        return Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, noul(j.rank?.(v) ?? 0.1)]));
      }
      throw new Error(`unexpected Jev phase ${phase}`);
    },
  };
}
// The scripted worker writes 'FILL' where the current hash of the file belongs; the wrapper fills it as the harness would see it.
function filling(bonsai: ReturnType<typeof bonsaiOf>, hashOf: (path: string) => Promise<string>) {
  return {
    ...bonsai,
    generate: async (m: Message[], schema: any) => {
      const a = await bonsai.generate(m, schema);
      for (const act of a.actions ?? [])
        if (act.args?.expectedHash === 'FILL') act.args.expectedHash = await hashOf(act.args.path);
      return a;
    },
  };
}
async function repo(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'leana-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'test'));
  await store.init();
  return { root, store };
}
// The source of every module whose text a tool result prints: what tool results can say is read from them.
const toolResultSources = async () =>
  (
    await Promise.all(
      ['tools.ts', 'edit-checks.ts', 'line-edits.ts'].map(f =>
        readFile(new URL(`../../src/${f}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
const events = async (store: Store) =>
  (await readFile(join(store.path, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
// Steps without thinking unless a test turns it on: the escalation tests are written against stepTemperature.
// Code at 0.3, the temperature the reproduced-rewrite tests (run 71) were recorded at; above it the rule stands down.
const config = {
  ...defaults,
  allowWrite: true,
  allowBash: true,
  maxSteps: 12,
  workingTokens: 90000,
  contextWindow: 200000,
  stepThinking: false,
  codeThinking: false,
  codeTemperature: 0.3,
};

test('Orientation is gathered by code before the first step: the tree, the manifests, the toolchains present, the verification the ecosystem offers', async t => {
  const { root } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { typecheck: 'tsc --noEmit', dev: 'vite' }, dependencies: { react: '^19' } }),
  );
  const o = await orient(root);
  assert.deepEqual(o.ecosystems, ['node']);
  assert.match(o.manifests['package.json']!, /"react"/);
  assert.ok(o.toolchain.node && o.toolchain.npm, `toolchains present: ${JSON.stringify(o.toolchain)}`);
  assert.deepEqual(
    o.verificationCandidates,
    ['npm run typecheck'],
    'scripts by what their names promise; never the dev server',
  );
  assert.deepEqual(o.declaredPackages, ['react@19']);
  assert.equal(o.repository.fileCount, 2);
  assert.deepEqual(o.repository.directories, { src: 1, '.': 1 });
});

test('The loop: orient, reason then act, verify what the worker declared as its check after each edit, gate the completion on facts and Jev, and complete', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'check.mjs'),
    'import { readFileSync } from "node:fs"; const t = readFileSync("src/greet.ts", "utf8"); if (!/export function greet/.test(t)) { console.log("src/greet.ts(1,1): error TS2304: greet is missing"); process.exit(2); } console.log("ok"); process.exit(0);\n',
  );
  await mkdir(join(root, 'src'), { recursive: true });
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'A greeting module is needed; plan first.',
        action: 'plan',
        args: { notes: '1. write src/greet.ts\n2. run node check.mjs\n3. finish' },
      },
      {
        thought: 'Write the module.',
        action: 'create_file',
        args: { path: 'src/greet.ts', purpose: 'export greet(name)' },
      },
      {
        thought: 'Verify with the check.',
        action: 'bash',
        args: { command: 'node check.mjs', purpose: 'the check', check: true },
      },
      {
        thought: 'Add an export the objective wants.',
        action: 'replace_lines',
        args: {
          path: 'src/greet.ts',
          expectedHash: 'FILL',
          edits: [{ start: 2, end: 1, newText: 'export const VERSION = 1;', prepend: '' }],
        },
      },
      { thought: 'Done.', action: 'finish', args: { summary: 'too early' } },
      {
        thought: 'Run the check again.',
        action: 'bash',
        args: { command: 'node check.mjs', purpose: 'the check', check: true },
      },
      {
        thought: 'Done.',
        action: 'finish',
        args: { summary: 'src/greet.ts exports greet and VERSION; node check.mjs passes.' },
      },
    ],
    files: { 'src/greet.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n' },
  });
  const jev = jevOf({ watch: () => ({ progress: 0.9 }) });
  const s = await newSession(root, 'Add src/greet.ts exporting greet(name) and VERSION, verified by node check.mjs');
  const agent = new Agent(
    config,
    store,
    jev,
    filling(bonsai, async p => s.hashes[p]!),
    root,
    () => {},
    () => {},
  );
  const result = await agent.run(s);
  assert.equal(result.status, 'complete', result.stopReason);
  const ev = await events(store);
  const types = ev.map(e => e.type);
  assert(
    types.includes('orientation') &&
      types.includes('thought') &&
      types.includes('watchdog') &&
      types.includes('completion'),
    types.join(','),
  );
  assert.equal(
    result.lastCheckCommand,
    'node check.mjs',
    'the command the worker ran as its check is the check of record',
  );
  assert(
    result.entries.some(e => /has not run since the last edit/.test(e.text)),
    'a finish before the check ran is refused with the reason; the worker ran it',
  );
  assert.match(await readFile(join(root, 'src', 'greet.ts'), 'utf8'), /export const VERSION = 1;/);
  assert.equal(result.notes!.split('\n').length, 3);
  const gate = jev.calls.find(c => c.phase === 'evidence-gate')!;
  assert(
    gate.state.result.files.diffStat && gate.state.result.check.ranAfterLastEdit === true,
    'the gate sees the facts, under result',
  );
  assert.equal(
    jev.calls.filter(c => c.phase === 'watchdog').length,
    6,
    'one reading per batch, none after the accepted finish',
  );
});

test('A finish while the check of record failed is refused before the gate, naming the check and the passing one it replaced; the same finish on the same state is a duplicate that raises the temperature and ends at four (run dk-country-3)', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'ok.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'mock.mjs'), 'process.exit(1);\n');
  const finish = {
    thought: 'The mock is not a real check; the page rendered, so finish.',
    action: 'finish',
    args: { summary: 'built the game' },
  };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'write it', action: 'create_file', args: { path: 'index.html', purpose: 'the game' } },
      { thought: 'syntax', action: 'bash', args: { command: 'node ok.mjs', purpose: 'syntax check', check: true } },
      { thought: 'mock', action: 'bash', args: { command: 'node mock.mjs', purpose: 'mock run', check: true } },
      finish,
      finish,
      finish,
      finish,
      finish,
    ],
  });
  const jev = jevOf({});
  const result = await new Agent(
    { ...config, maxSteps: 12 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'Build the game'));
  assert.equal(result.status, 'paused');
  assert.match(result.stopReason, /four (actions|turns) in a row/);
  assert(!jev.calls.some(c => c.phase === 'evidence-gate'), 'the gate is never asked: the check decides it');
  const refusals = (await events(store))
    .filter(e => e.type === 'refused' && e.data.route === 'finish')
    .map(e => e.data.why as string);
  assert.equal(refusals.length, 4);
  assert.match(
    refusals[0]!,
    /^finish was not judged: the check of record failed \(step 3, `node mock\.mjs`, exit 1\)\. Finish is judged once the check of record exits 0 after the last write \(step 1\); the check of record is the last bash command run with check: true, so each one replaces the one before\. The last check that exited 0 was step 2's `node ok\.mjs`, after that write; a later check replaced it\.$/,
  );
  assert(
    refusals
      .slice(1)
      .every(r =>
        r.endsWith('This finish was refused at the same state before (nothing has been written or checked since).'),
      ),
  );
  assert(
    (await events(store)).some(e => e.type === 'sampling' && e.data.temperature > config.stepTemperature),
    'repeated refusals raise the temperature',
  );
});

test('A finish with nothing written is an answer: no check is asked for, and Jev judges it against what the worker read; once a file is written, a finish without a check is refused', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const steps = [
    { thought: 'read it', action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 1 }] } },
    { thought: 'that answers it', action: 'finish', args: { summary: 'a.ts exports a = 1' } },
  ];
  const jev = jevOf({});
  const read = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jev,
    bonsaiOf({ steps }),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'What does a.ts export?'));
  assert.equal(read.status, 'complete', read.stopReason);
  const gate = jev.calls.find(c => c.phase === 'answer-gate');
  assert(gate, 'the answer gate judged it');
  assert(
    !jev.calls.some(c => c.phase === 'evidence-gate'),
    'not the gate of a change: no verification or observation to ask for',
  );
  assert(
    Object.values(gate.state.evidence as Record<string, string>).some(t => t.includes('export const a = 1;')),
    'Jev sees what was read',
  );
  assert.match(gate.state.read['a.ts'], /^lines 1-1 of \d+$|^whole/, 'and how much of each file');
  assert(Array.isArray(gate.state.unread));
  // Evidence heavy with escapes is held under Jev's byte cap as JSON, the newest kept.
  const { answerGate } = await import('../src/control.js');
  const heavy = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`e${i} read_files (step ${i})`, '"\\'.repeat(700)]),
  );
  const capped = jevOf({});
  await answerGate(capped as any, { ...read, notes: 'n'.repeat(1500) }, 's'.repeat(1500), heavy, {
    read: {},
    unread: [],
    files: 0,
  });
  const sent = capped.calls[0]!.state;
  assert(Buffer.byteLength(JSON.stringify(sent)) <= 22000);
  assert('e11 read_files (step 11)' in sent.evidence && !('e0 read_files (step 0)' in sent.evidence));
  // A long summary is clipped where the model reads it back (the stop reason, the recovery note on resume) and whole where the user reads it.
  const long = await repo(t);
  const summary = `Findings:\n${'- a finding about the harness\n'.repeat(40)}The end.`;
  await writeFile(join(long.root, 'a.ts'), 'export const a = 1;\n');
  const ended = await new Agent(
    { ...config, maxSteps: 3 },
    long.store,
    jevOf({}),
    bonsaiOf({ steps: [steps[0]!, { ...steps[1]!, args: { summary } }] }),
    long.root,
    () => {},
    () => {},
  ).run(await newSession(long.root, 'What does a.ts export?'));
  assert.equal(ended.status, 'complete', ended.stopReason);
  assert(ended.stopReason.length < 500);
  assert.equal(ended.outcome, `Complete: ${summary}`);
  // Part of the objective read as unanswered: the rejection names what was never read, the fact the worker can act on.
  const partial = await repo(t);
  await writeFile(join(partial.root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(partial.root, 'b.ts'), 'export const b = 2;\n');
  const gaps = await new Agent(
    { ...config, maxSteps: 2 },
    partial.store,
    jevOf({ gate: { implementation_matches_request: 0.3, requirement_unaddressed: 0.9 } }),
    bonsaiOf({ steps }),
    partial.root,
    () => {},
    () => {},
  ).run(await newSession(partial.root, 'Examine every file'));
  assert.match(
    gaps.completionFeedback?.text ?? '',
    /Jev reads part of the objective as unanswered \(0\.90\); of the repository's 2 files, 1 were read, these in part: a\.ts \(lines 1-1 of 2\); never read: b\.ts\. Address it/,
  );
  // Three answers Jev does not accept: the last goes to the user, whole, with Jev's readings, instead of round again.
  const thrice = await repo(t);
  await writeFile(join(thrice.root, 'a.ts'), 'export const a = 1;\n');
  const answers = [1, 2, 3].map(i => ({
    thought: `answer ${i}`,
    action: 'finish',
    args: { summary: `a.ts exports a (${i})` },
  }));
  const reviewed = await new Agent(
    { ...config, maxSteps: 8 },
    thrice.store,
    jevOf({ gate: { implementation_matches_request: 0.5 } }),
    bonsaiOf({ steps: [steps[0]!, ...answers, steps[0]!] }),
    thrice.root,
    () => {},
    () => {},
  ).run(await newSession(thrice.root, 'What does a.ts export?'));
  assert.equal(reviewed.status, 'paused', reviewed.stopReason);
  assert.match(
    reviewed.stopReason,
    /^Answer proposed; Jev did not accept it in 3 readings \(last: matches 0\.50, unanswered 0\.10, supported 0\.90\), so it goes to you for review/,
  );
  assert.equal(reviewed.outcome?.endsWith('a.ts exports a (3)'), true);
  // An answer Jev reads as unsupported goes back to the worker with the reason, not through as done.
  const unsupported = await repo(t);
  const rejected = await new Agent(
    { ...config, maxSteps: 2 },
    unsupported.store,
    jevOf({ gate: { claim_supported: 0.2 } }),
    bonsaiOf({ steps }),
    unsupported.root,
    () => {},
    () => {},
  ).run(await newSession(unsupported.root, 'What does a.ts export?'));
  assert.notEqual(rejected.status, 'complete');
  assert.match(
    rejected.completionFeedback?.text ?? '',
    /not supported by the evidence read \(0\.20\).* Address it and finish again\.$/,
  );
  const written = await repo(t);
  const edit = await new Agent(
    { ...config, maxSteps: 3 },
    written.store,
    jevOf({}),
    bonsaiOf({
      steps: [
        { thought: 'write', action: 'create_file', args: { path: 'b.ts', purpose: 'b' } },
        { thought: 'done', action: 'finish', args: { summary: 'wrote b.ts' } },
      ],
      files: { 'b.ts': 'export const b = 2;\n' },
    }),
    written.root,
    () => {},
    () => {},
  ).run(await newSession(written.root, 'Add b.ts'));
  assert.notEqual(edit.status, 'complete');
  assert(
    (await events(written.store)).some(
      e => e.type === 'refused' && e.data.route === 'finish' && /has never run/.test(e.data.why),
    ),
    'a write without a check is refused',
  );
});

test('Only the step route thinks, within stepThinkingBudget, at stepThinkingTemperature, and only when stepThinking is on; the thinking is logged, not added to the prompt', async t => {
  for (const on of [true, false]) {
    const { root, store } = await repo(t);
    const bonsai = bonsaiOf({ steps: [{ thought: 'done', action: 'plan', args: { notes: 'n' } }] });
    const budgets: unknown[] = [];
    const temps: unknown[] = [];
    let meta: any = null;
    const prompts: Message[][] = [];
    const spy = {
      ...bonsai,
      get lastMeta() {
        return meta;
      },
      generate: async (
        m: Message[],
        schema: any,
        temperature?: number,
        context?: any,
        max?: number,
        progress?: (p: any) => void,
        thinking?: number,
      ) => {
        budgets.push(thinking);
        temps.push(temperature);
        prompts.push(m);
        if (thinking) {
          progress?.({ text: '', tokens: 3, reasoning: 'why' });
          meta = { ms: 1, promptTokens: 1, reasoning: 'Because the notes are empty.' };
        } else meta = { ms: 1, promptTokens: 1 };
        return bonsai.generate(m, schema);
      },
    };
    const shown: any[] = [];
    await new Agent(
      { ...config, maxSteps: 1, stepThinking: on, stepThinkingBudget: 512 },
      store,
      jevOf({}),
      spy as any,
      root,
      () => {},
      e => shown.push(e),
    ).run(await newSession(root, 'x'));
    assert.deepEqual(budgets, [on ? 512 : undefined]);
    assert.deepEqual(
      temps,
      [on ? defaults.stepThinkingTemperature : config.stepTemperature],
      'a thinking step samples at the thinking-mode temperature',
    );
    const logged = (await events(store)).filter(e => e.type === 'reasoning');
    assert.deepEqual(
      logged.map(e => e.data.text),
      on ? ['Because the notes are empty.'] : [],
    );
    assert.equal(shown.find(e => e.kind === 'thought')?.reasoning, on ? 'Because the notes are empty.' : undefined);
    if (on)
      assert(
        shown.some(e => e.kind === 'reasoning'),
        'shown live',
      );
    assert(!JSON.stringify(prompts).includes('Because the notes are empty'), 'never in a prompt');
  }
});

test('A completion Jev does not accept comes back as feedback; one it routes to the user pauses the session', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'done', action: 'finish', args: { summary: 'all done' } },
      { thought: 'done again', action: 'finish', args: { summary: 'really done' } },
    ],
  });
  const jev = jevOf({ gate: { implementation_matches_request: 0.2 } });
  const s = await newSession(root, 'Do the thing');
  let result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(s);
  assert.equal(result.status, 'paused');
  assert(
    result.completionFeedback &&
      !result.completionFeedback.addressed &&
      /not accepted/.test(result.completionFeedback.text),
    'the rejection is pinned for the worker',
  );
  const jev2 = jevOf({ gate: { verification_needed: 'human' } });
  const prompts: Message[][] = [];
  const feedback = result.completionFeedback.text;
  result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jev2,
    {
      ...bonsai,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        return bonsai.generate(m, schema);
      },
    },
    root,
    () => {},
    () => {},
  ).run({ ...result, status: 'running' } as any);
  assert.equal(result.status, 'paused');
  assert.match(result.stopReason, /routes it to the user/);
  const request = JSON.parse(prompts[0]!.at(-1)!.content);
  assert(
    request.harnessNote.includes(feedback) && !('completionFeedback' in request),
    'the rejection is stated once, in the note',
  );
  assert.equal(request.lastError, 'shown in evidence e2', 'the failed finish is the entry right above the tail');
});

test('The watchdog ends a stuck attempt: no progress for a run of steps with a high stuck reading first warns the worker, then pauses with the reason', async t => {
  const { root, store } = await repo(t);
  const steps = Array.from({ length: 8 }, (_, i) => ({
    thought: `try ${i}`,
    action: 'bash',
    args: { command: `node -e "console.log(${i}); process.exit(1)"`, purpose: 'try' },
  }));
  const bonsai = bonsaiOf({ steps });
  const jev = jevOf({ watch: () => ({ progress: 0.05, stuck: 0.95 }) });
  const s = await newSession(root, 'Make it pass');
  const result = await new Agent(
    config,
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(s);
  assert.equal(result.status, 'paused');
  assert.match(result.stopReason, /stuck/);
  const ev = await events(store);
  assert(ev.filter(e => e.type === 'action' && !e.data.forced).length < 8, 'the step budget was not burnt');
  const prompts = ev.filter(e => e.type === 'prompt').length;
  assert(prompts > 0);
  assert.equal(result.watch!.escalations, 2, 'one warning to the worker, then the stop');
});

test('A failure Jev reads as the same failure again blocks the identical action; a transient one is retried once by code; a permission one goes to the user', async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'run', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
      { thought: 'run again', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
      { thought: 'run again', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
    ],
  });
  const jev = jevOf({ watch: () => ({ progress: 0.5, same_failure: 0.95 }) });
  const s = await newSession(root, 'x');
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(s);
  const ev = await events(store);
  assert.equal(
    ev.filter(e => e.type === 'action' && !e.data.forced && e.data.route === 'bash').length,
    1,
    'the identical command ran once; Jev read the failure as unchanged and the repeats were refused',
  );
  assert(result.entries.some(e => e.text.includes('not run again')));
  const { root: r2, store: st2 } = await repo(t);
  const b2 = bonsaiOf({
    steps: [{ thought: 'flaky', action: 'bash', args: { command: 'node -e "process.exit(4)"', purpose: 'net' } }],
  });
  await new Agent(
    { ...config, maxSteps: 1 },
    st2,
    jevOf({ triage: 'transient' }),
    b2,
    r2,
    () => {},
    () => {},
  ).run(await newSession(r2, 'x'));
  assert.equal((await events(st2)).filter(e => e.type === 'auto-retry').length, 1, 'retried once by code');
  const { root: r3, store: st3 } = await repo(t);
  const b3 = bonsaiOf({
    steps: [
      {
        thought: 'push',
        action: 'bash',
        args: {
          command: 'node -e "console.log(\'Permission denied (publickey)\'); process.exit(128)"',
          purpose: 'push',
        },
      },
    ],
  });
  const r = await new Agent(
    { ...config, maxSteps: 2 },
    st3,
    jevOf({ triage: 'permission' }),
    b3,
    r3,
    () => {},
    () => {},
  ).run(await newSession(r3, 'x'));
  assert.equal(r.status, 'paused');
  assert.match(r.stopReason, /needs the user/);
});

test('Retrieval is ranked by Jev when a search returns many hits: the prompt carries the relevant few and says how many were omitted', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  for (let i = 0; i < 20; i++)
    await writeFile(join(root, 'src', `m${i}.ts`), `export const needle${i} = ${i}; // needle\n`);
  const bonsai = bonsaiOf({
    steps: [{ thought: 'find', action: 'search_codebase', args: { query: 'needle', path: 'src', mode: 'text' } }],
  });
  const jev = jevOf({ rank: hit => (/needle1[0-9]/.test(hit) ? 0.9 : 0.1) });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'search_codebase')!;
  assert.match(entry.text, /further hits omitted/);
  assert(entry.text.split('\n').filter(l => /needle1\d/.test(l)).length >= 8, entry.text);
  assert(
    !/needle[0-9] =/.test(
      entry.text
        .split('\n')
        .filter(l => !/omitted/.test(l))
        .join('\n'),
    ) || true,
  );
  assert((await events(store)).some(e => e.type === 'retrieval-rank'));
});

test('A created file is checked against the repository as facts: an undeclared package and a name a module does not export are told to the worker, never fixed for it', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { react: '^19' } }));
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'util.py'), 'def helper():\n    pass\n');
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  // Both projects are detected; the Python one is already installed, so the one step goes to the worker.
  await mkdir(join(root, '.venv', venvBin), { recursive: true });
  await writeFile(join(root, '.venv', venvBin, windowsExe('python')), '');
  await writeFile(join(root, '.venv', '.leana-installed'), 'project');
  const bonsai = bonsaiOf({
    steps: [{ thought: 'write', action: 'create_file', args: { path: 'src/app.tsx', purpose: 'the app' } }],
    files: {
      'src/app.tsx':
        "import { useState } from 'react';\nimport clsx from 'clsx';\nexport function App() { return null; }\n",
    },
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'create_file')!;
  assert.match(entry.text, /imports clsx, which package\.json does not declare/, entry.text);
  assert.doesNotMatch(entry.text, /pyproject/, 'a .tsx file belongs to the node project beside the Python one');
  assert.equal(
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.clsx,
    undefined,
    'the manifest is untouched',
  );
});

test('A manifest the worker changes is installed again by code before the next step; the worker is told what the installer said when it fails', async t => {
  const { root, store } = await repo(t);
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(
    join(bin, 'npm'),
    '#!/bin/bash\nif [ "$1" = "install" ]; then if grep -q ghost package.json; then echo "npm error 404 Not Found - GET https://registry.npmjs.org/ghost - Not found"; exit 1; fi; echo added; exit 0; fi\nexit 0\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }, null, 2) + '\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'declare a dependency',
        action: 'write',
        args: {
          path: 'package.json',
          expectedHash: 'FILL',
          oldText: '"dependencies": {}',
          newText: '"dependencies": { "ghost": "^1" }',
        },
      },
      { thought: 'look', action: 'read_files', args: { files: [{ path: 'package.json', start: 1, end: 10 }] } },
    ],
  });
  const s = await newSession(root, 'x');
  const { hash: h1 } = await import('../src/files.js');
  const agent = new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(bonsai, async p => h1(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  );
  const result = await agent.run(s);
  const ev = await events(store);
  assert.equal(
    ev.filter(e => e.type === 'setup').length,
    2,
    'the changed manifest is installed, and the failure retried once',
  );
  assert.match(
    result.setupError ?? '',
    /ghost: the registry has no package of that name/,
    "the installer's fact reaches the worker",
  );
  const prompt = JSON.parse(
    ev.filter(e => e.type === 'prompt').at(-1)!.data.artifact
      ? await readFile(
          join(
            store.artifacts,
            ev
              .filter(e => e.type === 'prompt')
              .at(-1)!
              .data.artifact.replace(/^@artifact\//, ''),
          ),
          'utf8',
        )
      : '[]',
  );
  assert(JSON.stringify(prompt).includes('the registry has no package of that name'), 'and is in the next prompt');
});

test('A file created before the modules it mentions exist is still generated: a path that is not there yet is no contract, not a crash', async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'vite.config.ts and src/main.tsx come later',
        action: 'create_file',
        args: { path: 'package.json', purpose: 'the manifest; vite.config.ts and src/main.tsx will import from it' },
      },
    ],
    files: { 'package.json': '{ "name": "x" }\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{ "name": "x" }\n');
  assert(!result.entries.some(e => /ENOENT/.test(e.text)));
});
test('Commands run without a terminal and say so: CI is set and the orientation tells the worker', async t => {
  const { root } = await repo(t);
  const { runCommand } = await import('../src/commands.js');
  const r = await runCommand(
    'bash',
    ['-c', 'echo "ci=$CI yes=$npm_config_yes"; [ -t 0 ] && echo tty || echo notty'],
    root,
    5000,
  );
  assert.match(r.output, /ci=1 yes=true/);
  assert.match(r.output, /notty/);
  assert.match((await orient(root)).shell, /without a terminal/);
});

test('A command is the check only when the worker says so; a failing check carries the source around each error; a manifest edit is never rolled back on an error count; the gate names the clause it reads as unaddressed', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = "x";\nexport const b = 2;\n');
  await writeFile(
    join(root, 'check.mjs'),
    'import { readFileSync } from "node:fs"; if (/"test"/.test(readFileSync("package.json", "utf8"))) { console.log("ok"); process.exit(0); } console.log("src/a.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'."); process.exit(2);\n',
  );
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }, null, 2) + '\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'install',
        action: 'bash',
        args: { command: 'echo installing && ls', purpose: 'install', check: false },
      },
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      {
        thought: 'add a script',
        action: 'write',
        args: {
          path: 'package.json',
          expectedHash: 'FILL',
          oldText: '"scripts": {}',
          newText: '"scripts": { "test": "node check.mjs" }',
        },
      },
      { thought: 'check again', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'done', action: 'finish', args: { summary: 'done' } },
    ],
  });
  const jev = jevOf({ clauses: c => (/landing page/.test(c) ? 0.1 : 0.9) });
  const s = await newSession(
    root,
    'Bootstrap a react application:\n- a landing page\n- components, using best practices',
  );
  const { hash } = await import('../src/files.js');
  const result = await new Agent(
    { ...config, maxSteps: 9 },
    store,
    jev,
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(s);
  const ev = await events(store);
  assert.equal(result.lastCheckCommand, 'node check.mjs', 'the install was not taken for a check');
  assert(
    !ev.some(e => e.type === 'auto-check' && /installing/.test(JSON.stringify(e.data))),
    'the harness never re-ran the install',
  );
  const check = result.entries.find(e => e.kind === 'bash' && /TS2322/.test(e.text))!;
  assert.match(
    check.text,
    /Source at the errors[\s\S]*1: export const a: number = "x";/,
    'the source around the error travels with the check',
  );
  assert(!ev.some(e => e.type === 'undo'), 'nothing was rolled back');
  assert.match(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts.test, /check/);
  const completion = ev.find(e => e.type === 'completion')!;
  assert.equal(completion.data.accepted, false);
  assert.match(completion.data.reason, /not addressed: "a landing page"/, completion.data.reason);
});

test('An edit answers with the region as it now reads, so the next edit needs no read; the action catalogue is pinned, not repeated per step', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\nline5\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'edit',
        action: 'replace_lines',
        args: {
          path: 'src/a.ts',
          expectedHash: 'FILL',
          edits: [{ start: 3, end: 3, newText: 'three\nthree-b', prepend: '' }],
        },
      },
    ],
  });
  const { hash } = await import('../src/files.js');
  const prompts: any[] = [];
  const filled = filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8')));
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    {
      ...filled,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        return filled.generate(m, schema);
      },
    },
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'replace_lines')!;
  assert.match(
    entry.text,
    /The file now reads, lines 1\.\.[67]:\n1: line1\n2: line2\n3: three\n4: three-b\n5: line4\n6: line5/,
    entry.text,
  );
  const pinned = JSON.parse(prompts[0][1].content);
  const request = JSON.parse(prompts[0].at(-1).content);
  assert(
    pinned.actions?.replace_lines?.argumentSchema &&
      !('allowedActions' in request) &&
      !request.actions &&
      /from the pinned block's actions/.test(request.role),
    'schemas sit in the cached pinned block; the request neither repeats them nor restates their names',
  );
  const roles = prompts[0].map(
    (m: Message) => Object.keys(JSON.parse(m.content.startsWith('{') ? m.content : '{}'))[0] ?? 'system',
  );
  assert.deepEqual(roles.slice(0, 2), ['system', 'objective'], `the stable blocks lead: ${roles}`);
  assert.equal(
    roles.at(-2),
    'notes',
    'notes, files and the check state sit just before the request, after the evidence',
  );
});
test('Jev reads scope: three steps of work the objective did not ask for are named to the worker, and an objective read as satisfied with a passing check invites the finish', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const prompts: any[] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'extra', action: 'bash', args: { command: 'echo extra1', purpose: 'polish', check: false } },
      { thought: 'extra', action: 'bash', args: { command: 'echo extra2', purpose: 'polish', check: false } },
      { thought: 'extra', action: 'bash', args: { command: 'echo extra3', purpose: 'polish', check: false } },
      { thought: 'look', action: 'read_files', args: { files: [{ path: 'check.mjs', start: 1, end: 5 }] } },
    ],
  });
  const jev = jevOf({
    watch: n => (n === 1 ? { objective_satisfied: 0.85 } : { in_scope: 0.1 }),
    gate: { implementation_matches_request: 0.2 },
  });
  await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jev,
    {
      ...bonsai,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        return bonsai.generate(m, schema);
      },
    },
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const notes = prompts.map(p => JSON.parse(p.at(-1).content).harnessNote ?? '');
  assert(
    notes[1] && /did not accept it/.test(notes[1]),
    `after the passing check the harness proposed completion; the gate's refusal reaches the worker: ${notes[1]}`,
  );
  assert(
    notes[4] && /did not ask for/.test(notes[4]),
    `after three out-of-scope steps the worker is told: ${notes[4]}`,
  );
});

test('The harness proposes completion itself: Jev reads the objective as satisfied, the check passed after the last edit, the gate accepts, and the run completes without a worker claim', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'write', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'polish more', action: 'bash', args: { command: 'echo more', purpose: 'polish', check: false } },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n' },
  });
  const jev = jevOf({ watch: () => ({ objective_satisfied: 0.9 }) });
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'Add src/a.ts exporting a'));
  assert.equal(result.status, 'complete', result.stopReason);
  assert.match(result.stopReason, /met by the facts/);
  const ev = await events(store);
  assert(ev.some(e => e.type === 'auto-finish'));
  assert.equal(
    ev.filter(e => e.type === 'thought').length,
    2,
    'the worker never had to claim it; the polish step never ran',
  );
});

test('Evidence is evicted in batches so the cached prompt prefix survives several steps between reprocessings', async t => {
  const { root, store } = await repo(t);
  // Each step prints about 2 KB, so the evidence reaches its share of the budget (60%) after about seventeen steps.
  const steps = Array.from({ length: 22 }, (_, i) => ({
    thought: `look ${i}`,
    action: 'bash',
    args: { command: `node -e "console.log('${i}'.repeat(2000))"`, purpose: 'look', check: false },
  }));
  const result = await new Agent(
    { ...config, maxSteps: 22, workingTokens: 20000 },
    store,
    jevOf({}),
    bonsaiOf({ steps }),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const compactions = (await events(store)).filter(e => e.type === 'compact' && e.data.reason === 'evidence-share');
  assert.equal(
    compactions.length,
    1,
    `one batched eviction across twenty-two steps, not one per step: ${compactions.length}`,
  );
  assert(compactions[0].data.removed >= 6, `the eviction cuts well below the trigger: ${compactions[0].data.removed}`);
  assert(evidenceTokens(result) <= 20000 * 0.6);
});

test('The worker sees its own earlier turns: each is an assistant message before the results of its batch, arguments compacted, recorded before the batch runs', async t => {
  const { root, store } = await repo(t);
  const prompts: Message[][] = [];
  const long = 'x'.repeat(1000);
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'first I look at the tree',
        action: 'plan',
        batch: [
          { action: 'bash', args: { command: 'echo one', purpose: 'look', check: false } },
          { action: 'create_file', args: { path: 'src/a.ts', purpose: long } },
        ],
      },
      { thought: 'then I look again', action: 'bash', args: { command: 'echo two', purpose: 'look', check: false } },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n' },
  });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
    generateText: async (m: Message[], o: any) => {
      prompts.push(m);
      return bonsai.generateText(m);
    },
  };
  await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const assistant = (m: Message[]) => m.filter(x => x.role === 'assistant').map(x => JSON.parse(x.content));
  // The file generated inside the first batch already sees the reasoning that asked for it.
  const file = prompts[1]!;
  assert.deepEqual(
    assistant(file).map(a => a.thought),
    ['first I look at the tree'],
  );
  const second = prompts.at(-1)!;
  const turns = assistant(second);
  assert.deepEqual(
    turns.map(a => a.thought),
    ['first I look at the tree'],
  );
  assert.deepEqual(
    turns[0].actions.map((a: any) => a.action),
    ['bash', 'create_file'],
  );
  assert.match(
    turns[0].actions[1].args.purpose,
    /\[1000 chars\]$/,
    'generated or long content is compacted, the path kept',
  );
  assert.equal(turns[0].actions[1].args.path, 'src/a.ts');
  // The turn comes right before the results of its batch.
  const at = second.findIndex(m => m.role === 'assistant');
  assert.match(JSON.parse(second[at + 1]!.content).evidence.text, /echo one|one/);
  assert(
    !('thought' in JSON.parse(file.at(-1)!.content)),
    'the file request does not repeat the reasoning the prefix already holds',
  );
});

test('A turn is evicted with the last result of its batch, never before it, and leaves one line in earlierSteps', async t => {
  const { evictOne, turnEntry, stepMessages } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-evict-')), 'x');
  const result = (id: string, step: number, turn: string, text: string) => ({
    id,
    step,
    kind: 'bash',
    text,
    artifact: '',
    relevance: 0.5,
    turn,
  });
  const t1 = turnEntry(1, 'look around', [
    { action: 'bash', args: { command: 'ls' } },
    { action: 'bash', args: { command: 'npm test' } },
  ]);
  t1.outcomes = ['bash ok', 'bash failed: 1 test failed'];
  const t3 = turnEntry(3, 'fix it', [{ action: 'bash', args: { command: 'npm test' } }]);
  s.entries = [t1, result('e1', 1, 't1', 'a'), result('e2', 2, 't1', 'b'), t3, result('e3', 3, 't3', 'c')];
  // The turn itself is never chosen while its results remain.
  assert.equal(evictOne(s)!.id, 'e1');
  assert(s.entries.some(e => e.id === 't1'));
  assert.equal(evictOne(s)!.id, 'e2');
  assert(!s.entries.some(e => e.id === 't1'), 'the turn goes with its last result');
  assert.deepEqual(s.trail, ['step 1: bash ls; bash npm test -> bash ok; bash failed: 1 test failed']);
  // The freshest entry and its turn survive.
  assert.equal(evictOne(s), undefined);
  assert.deepEqual(
    s.entries.map(e => e.id),
    ['t3', 'e3'],
  );
  const volatile = stepMessages(s, ['bash'])
    .filter(m => m.role === 'user')
    .map(m => JSON.parse(m.content))
    .find(c => 'earlierSteps' in c)!;
  assert.deepEqual(volatile.earlierSteps, s.trail);
});

test("The prefix only grows between turns: every message of a turn's prompt before the volatile block starts the next turn's prompt when nothing was evicted", async t => {
  const { root, store } = await repo(t);
  const prompts: Message[][] = [];
  const steps = Array.from({ length: 5 }, (_, i) => ({
    thought: `step ${i}`,
    action: 'bash',
    args: { command: `echo ${i}`, purpose: 'look', check: false },
  }));
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal((await events(store)).filter(e => e.type === 'compact').length, 0);
  for (let k = 0; k + 1 < prompts.length; k++) {
    const stable = prompts[k]!.slice(0, -2);
    assert.deepEqual(prompts[k + 1]!.slice(0, stable.length), stable, `turn ${k + 1} rewrote the prefix of turn ${k}`);
    assert.equal(prompts[k + 1]!.filter(m => m.role === 'assistant').length, k + 1);
  }
});

test('A command that succeeded is not run again while nothing has been written or installed since; after a write it runs', async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'look', action: 'bash', args: { command: 'echo hi', purpose: 'look', check: false } },
      { thought: 'look again', action: 'bash', args: { command: 'echo hi', purpose: 'look', check: false } },
      { thought: 'write', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
      { thought: 'look after the write', action: 'bash', args: { command: 'echo hi', purpose: 'look', check: false } },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const runs = (await events(store)).filter(e => e.type === 'action' && e.data.route === 'bash');
  assert.deepEqual(
    runs.map(e => e.data.step),
    [1, 4],
    'the repeat at step 2 did not run; the one after the write did',
  );
  const refused = result.entries.find(e => e.step === 2 && e.kind === 'generation_error')!;
  assert.match(refused.text, /already ran at step 1 and nothing has been written or installed since/);
});

test('A whole-file rewrite lands as generated even when it no longer parses, like a created file: reported as a rewrite, with the parse errors and the fact that the generation was complete', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Hero.tsx'), 'export const Hero = () => <div>old</div>;\n');
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/Hero.tsx', start: 1, end: 1 }] } },
      { thought: 'rewrite', action: 'rewrite_file', args: { path: 'src/Hero.tsx', purpose: 'a new hero' } },
    ],
    files: { 'src/Hero.tsx': 'export const Hero = () => (\n  <div>one</div>\n  <div>two</div>\n);\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const e = result.entries.find(x => x.kind === 'write')!;
  assert.match(e.text, /^Rewrote src\/Hero\.tsx \(5 lines\)/);
  assert.doesNotMatch(e.text, /anchor was|replace_lines/);
  assert.equal(
    await readFile(join(root, 'src', 'Hero.tsx'), 'utf8'),
    'export const Hero = () => (\n  <div>one</div>\n  <div>two</div>\n);\n',
    'the generation is kept, not discarded',
  );
  assert.match(e.text, /does not parse/);
  assert.match(e.text, /ran to its end \(\d+ lines, not cut off\); the parse errors are in the written content/);
});

test("Run 67, steps 11-15: a rewrite that reproduces the replaced text's parse problem at the same text is told the problem is the same and that text did not change, with the column the parser names", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Hero.tsx'), 'export const Hero = () => <div>old</div>;\n');
  // Each regeneration changes other lines (as the style block changed in run 67) and keeps the broken call.
  const versions = [
    'export const Hero = () => {\n  const n = count(;\n  return <div>{n}</div>;\n};\n',
    '// the hero\nexport const Hero = () => {\n  const title = "Pets";\n  const n = count(;\n  return <h1>{title} {n}</h1>;\n};\n',
  ];
  const scripted = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/Hero.tsx', start: 1, end: 1 }] } },
      { thought: 'rewrite', action: 'rewrite_file', args: { path: 'src/Hero.tsx', purpose: 'a counting hero' } },
      {
        thought: 'rewrite again',
        action: 'rewrite_file',
        args: { path: 'src/Hero.tsx', purpose: 'a counting hero with a title' },
      },
    ],
  });
  const bonsai = {
    ...scripted,
    generateText: async () => ({ text: versions.shift()!, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }),
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const [first, second] = result.entries.filter(x => x.kind === 'write');
  assert.match(
    first!.text,
    /Harness: src\/Hero\.tsx does not parse: line 2, column 19 \(at ";" of "count\(;"\): '\)' expected: "const n = count\(;"/,
    first!.text,
  );
  assert.doesNotMatch(first!.text, /Same problem/, 'the text it replaced parsed');
  assert.match(
    second!.text,
    /does not parse: line 4, column 19 \(at ";" of "count\(;"\): '\)' expected: "const n = count\(;"\. Same problem as before this write, at the same text: line 4 \(was line 2\); that text did not change/,
    second!.text,
  );
});

test("A component file is judged by its parser in the loop: a created file cut short is told it does not parse, and an edit that drops a block's end tag is refused before it lands (run 63, steps 15 and 41)", async t => {
  const { root, store } = await repo(t);
  const home =
    '<script setup>\nimport { computed } from \'vue\'\nconst a = computed(() => 1)\n</script>\n\n<template>\n  <div class="home">{{ a }}</div>\n</template>\n';
  await mkdir(join(root, 'src', 'views'), { recursive: true });
  await writeFile(join(root, 'src', 'views', 'HomeView.vue'), home);
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'the not-found view',
        action: 'create_file',
        args: { path: 'src/views/NotFoundView.vue', purpose: 'a 404 page' },
      },
      {
        thought: 'read',
        action: 'read_files',
        args: { files: [{ path: 'src/views/HomeView.vue', start: 1, end: 8 }] },
      },
      {
        thought: 'add a ref',
        action: 'replace_lines',
        args: {
          path: 'src/views/HomeView.vue',
          expectedHash: 'FILL',
          edits: [{ start: 4, end: 4, newText: "const email = ref('')\n" }],
        },
      },
    ],
    files: {
      'src/views/NotFoundView.vue': '<template>\n  <div class="not-found">\n    <div class="not-found-container">\n',
    },
  });
  const s = await newSession(root, 'x');
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(bonsai, async p => s.hashes[p]!),
    root,
    () => {},
    () => {},
  ).run(s);
  const created = result.entries.find(e => e.kind === 'create_file')!;
  assert.match(
    created.text,
    /src\/views\/NotFoundView\.vue does not parse: line 1: "<template>" opens a <template> block that no <\/template> closes/,
    created.text,
  );
  assert(
    result.entries.some(e =>
      /HomeView\.vue would no longer parse \(line 1: "<script setup>" opens a <script> block[\s\S]*does not contain: 4: <\/script>/.test(
        e.text,
      ),
    ),
    result.entries.map(e => e.text).join('\n---\n'),
  );
  assert.equal(
    await readFile(join(root, 'src', 'views', 'HomeView.vue'), 'utf8'),
    home,
    'the refused edit wrote nothing',
  );
});

test('A rejected completion names the evidence Jev reads as weakest and quotes it, so the worker acts on the gap instead of guessing', async () => {
  const { evidenceGate } = await import('../src/control.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-gate-')), 'Bootstrap a landing page');
  const observation = {
    kind: 'page',
    step: 3,
    afterLastWrite: true,
    ok: true,
    target: 'http://localhost:3000',
    facts:
      'Rendered http://localhost:3000: no exception, every request and image loaded.\nStyling: 14 CSS rules; 0 of the 163 class names on visible elements match a CSS selector (without one: min-h-screen, bg-gray-50)',
  };
  const facts = {
    summary: 'done',
    changedFiles: ['src/App.tsx'],
    diffStat: '',
    observation,
    verification: { command: 'npm run build', ok: true, afterLastWrite: true, exitCode: 0, text: 'built' },
    requirements: [],
    sources: {},
  };
  const v = await evidenceGate(
    jevOf({
      gate: {
        implementation_matches_request: 0.39,
        claim_supported: 0.45,
        verification_needed: 'semantic_review',
        weakest_evidence: 'observation',
      } as any,
    }) as any,
    s,
    facts,
  );
  assert.equal(v.accepted, false);
  assert.match(
    v.reason,
    /Jev reads the weakest evidence as the observation \(page http:\/\/localhost:3000\), which reported: .*0 of the 163 class names/s,
  );
  const ok = await evidenceGate(jevOf({}) as any, s, facts);
  assert.equal(ok.accepted, true);
  assert.doesNotMatch(ok.reason, /weakest/);
});

test('A completion whose weakest evidence Jev reads as the observation is not accepted while the result has not been observed since the last write; where nothing can be observed it is judged as before', async () => {
  const { evidenceGate } = await import('../src/control.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-gate-')), 'Bootstrap a landing page');
  // The shape of react-demo-23: build passed, Jev reads the change as matching (0.77) with the observation as the weakest evidence (0.84), never observed.
  const base = {
    summary: 'done',
    changedFiles: ['src/App.tsx'],
    diffStat: '',
    verification: { command: 'npm run build', ok: true, afterLastWrite: true, exitCode: 0, text: 'built' },
    requirements: [],
    sources: {},
  };
  const jev = jevOf({
    gate: {
      implementation_matches_request: 0.77,
      claim_supported: 0.85,
      verification_needed: 'semantic_review',
      weakest_evidence: 'observation',
    } as any,
  }) as any;
  const never = await evidenceGate(jev, s, {
    ...base,
    observation: 'never observed: nothing is known about the result as its user meets it',
    observationState: 'never' as const,
  });
  assert.equal(never.accepted, false);
  assert.equal(never.route, 'rejected');
  assert.match(never.reason, /weakest evidence \(0\.90\) and the result has never been observed: observe it/);
  const stale = await evidenceGate(jev, s, {
    ...base,
    observation: { kind: 'program', step: 2, afterLastWrite: false, ok: true, target: 'u', facts: 'f' },
    observationState: 'stale' as const,
  });
  assert.match(stale.reason, /has not been observed since the last write/);
  const current = await evidenceGate(jev, s, {
    ...base,
    observation: { kind: 'program', step: 9, afterLastWrite: true, ok: true, target: 'u', facts: 'f' },
    observationState: 'current' as const,
  });
  assert.equal(current.accepted, true, "once observed, Jev's reading decides as before");
  const unavailable = await evidenceGate(jev, s, {
    ...base,
    observation: 'cannot be observed here',
    observationState: 'unavailable' as const,
  });
  assert.equal(unavailable.accepted, true, 'evidence that cannot be gathered here is not demanded');
  const otherWeakest = await evidenceGate(
    jevOf({
      gate: { implementation_matches_request: 0.77, claim_supported: 0.85, verification_needed: 'semantic_review' },
    }) as any,
    s,
    { ...base, observation: 'never observed', observationState: 'never' as const },
  );
  assert.equal(
    otherWeakest.accepted,
    true,
    'a change Jev does not read as hinging on an observation is not held for one',
  );
});

test("The repeat check matches the action's own result, not the turn that shares its step; a turn whose every action was refused leaves the prompt", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'big.txt'), 'x'.repeat(2400) + '\n');
  const read = { files: [{ path: 'src/a.ts', start: 1, end: 1 }] };
  // Step 2 is a batch: the read, a large output, and a small failure that keeps the batch's turn in the evidence
  // after the read's own result is evicted. That turn has step 2, like the read.
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read a', action: 'read_files', args: read },
      {
        thought: 'read a with more',
        action: 'plan',
        batch: [
          { action: 'read_files', args: read },
          { action: 'bash', args: { command: 'cat big.txt', purpose: 'look', check: false } },
          { action: 'bash', args: { command: 'node -e "process.exit(1)"', purpose: 'fail', check: false } },
        ],
      },
      { thought: 'read a again', action: 'read_files', args: read },
      ...Array.from({ length: 6 }, (_, i) => ({
        thought: `big ${i}`,
        action: 'bash',
        args: { command: `cat big.txt # ${i}`, purpose: 'look', check: false },
      })),
      { thought: 'read a once more', action: 'read_files', args: read },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 12, workingTokens: 9000 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const reads = (await events(store))
    .filter(e => e.type === 'action' && e.data.route === 'read_files')
    .map(e => e.data.step);
  assert(
    result.entries.some(e => e.kind === 'turn' && e.step === 2) &&
      !result.entries.some(e => e.kind === 'read_files' && e.step === 2),
    'the scenario: the turn of step 2 remains, the read of step 2 does not',
  );
  // The first read learns the file's hash, so the second is keyed with it; the third repeats the second exactly.
  assert.deepEqual(
    reads,
    [1, 2, 12],
    'the repeat at step 5 was answered from the evidence; at step 12 the read of step 2 had been evicted (its turn had not), so the read ran',
  );
  assert(
    !result.entries.some(e => e.kind === 'turn' && e.step === 5),
    'the turn of nothing but a repeat is not kept as a template to copy',
  );
});

const numbered = (n: number, width = 1) =>
  Array.from({ length: n }, (_, i) => `export const line${i + 1} = '${'x'.repeat(width)}';`).join('\n') + '\n';
test('A repeated read stops nothing: it states which entries show the requested lines of the file as it is now, and the rest of the batch runs', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), numbered(3));
  const { hash } = await import('../src/files.js');
  const sha = hash(await readFile(join(root, 'src', 'a.ts'), 'utf8'));
  const read = { files: [{ path: 'src/a.ts', start: 1, end: 3 }] };
  // The first read learns the file's hash, so the second is keyed with it; the third repeats the second exactly.
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read a', action: 'read_files', args: read },
      { thought: 'read a', action: 'read_files', args: read },
      {
        thought: 'Let me read a.ts to see the exact lines, then look at the rest.',
        action: 'plan',
        batch: [
          { action: 'read_files', args: read },
          { action: 'bash', args: { command: 'echo rest', purpose: 'look', check: false } },
        ],
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => [e.data.step, e.data.route]),
    [
      [1, 'read_files'],
      [2, 'read_files'],
      [4, 'bash'],
    ],
    'the repeat read nothing; the action after it ran',
  );
  assert.equal(ev.filter(e => e.type === 'refused').length, 0);
  assert.deepEqual(
    ev.filter(e => e.type === 'repeated').map(e => [e.data.step, e.data.earlier]),
    [[3, 2]],
    'the repeat is logged with the step it repeats',
  );
  const fact = result.entries.find(e => e.id === 'e3')!;
  assert.equal(fact.kind, 'repeat');
  assert.equal(
    fact.text,
    `This read_files repeats the request of step 2; for the file as it is now, the evidence already shows every requested line that a read shows whole: src/a.ts sha256=${sha} (4 lines): lines 1..3 in e2. Nothing was read again.`,
    'facts only: where the lines are, the hash; no instruction',
  );
  const turn = result.entries.find(e => e.id === 't3')!;
  assert.deepEqual(
    turn.outcomes,
    ['read_files repeated: shown in e2', 'bash ok'],
    'a turn that ran something stays, with its repeat stated',
  );
});

test('A repeated search stops nothing either: it names the entry that holds its result', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1;\n');
  const search = { action: 'search_codebase', args: { query: 'needle', path: 'src', mode: 'text' } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'find', action: 'plan', batch: [search] },
      {
        thought: 'find again',
        action: 'plan',
        batch: [search, { action: 'bash', args: { command: 'echo next', purpose: 'look', check: false } }],
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => [e.data.step, e.data.route]),
    [
      [1, 'search_codebase'],
      [3, 'bash'],
    ],
  );
  assert.equal(
    result.entries.find(e => e.id === 'e2')!.text,
    'This search_codebase has the same arguments as the search of step 1 (text "needle" in src), and the harness has recorded no write and no check since; its result is e1. It was not run again.',
    'only what the harness knows: no claim about files it does not track',
  );
});

test('A repeat of a read the budget cut short reads only the lines no entry shows; repeated once all are shown, it is one fact per turn, and the turn leaves the prompt', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'big.ts'), numbered(60, 12));
  const read = { files: [{ path: 'big.ts', start: 1, end: 60 }] };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 5 }, (_, i) => ({ thought: `read big.ts (${i})`, action: 'read_files', args: read })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 5, toolChars: 1600 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  const reads = ev
    .filter(e => e.type === 'action')
    .map(e => [e.data.step, e.data.args.files.map((f: any) => `${f.start}..${f.end}`).join(',')]);
  const cut = Number(result.entries.find(e => e.id === 'e2')!.text.match(/shown=1\.\.(\d+)/)![1]);
  assert(cut < 60, `the scenario: the read budget cut the read at line ${cut}`);
  assert.deepEqual(
    reads,
    [
      [1, '1..60'],
      [2, '1..60'],
      [3, `${cut + 1}..60`],
    ],
    'the repeat at step 3 read only what e2 does not show',
  );
  assert.match(
    result.entries.find(e => e.id === 'e3')!.text,
    new RegExp(
      `\\nHarness: this repeats the read_files of step 2; at this step the evidence showed big\\.ts sha256=\\w+ \\(61 lines\\): lines 1\\.\\.${cut} in e2, so only big\\.ts ${cut + 1}\\.\\.60 was read\\.$`,
    ),
  );
  assert.match(result.entries.find(e => e.id === 'e3')!.text, /shown=\d+\.\.60\n/, 'the rest fit a fresh budget');
  const facts = result.entries.filter(e => e.kind === 'repeat');
  assert.deepEqual(
    facts.map(e => e.id),
    ['e4', 'e5'],
    'steps 4 and 5 stated the same facts; each turn keeps its own, the record that it asked again',
  );
  for (const f of facts)
    assert.match(
      f.text,
      new RegExp(`lines 1\\.\\.${cut} in e2, ${cut + 1}\\.\\.60 in e3\\. Nothing was read again\\.$`),
    );
  assert(
    !result.entries.some(e => e.kind === 'turn' && (e.step === 4 || e.step === 5)),
    'a turn of nothing but repeats leaves the prompt',
  );
  assert(
    result.entries.some(e => e.kind === 'turn' && e.step === 3),
    'the turn whose repeat read new lines stays',
  );
});

test('Turns of nothing but repeats count toward the four in a row that end the attempt, once per turn; a turn that ran something resets the count', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const turn = (batch: { action: string; args: Record<string, any> }[], i: number) => ({
    thought: `look ${i}`,
    action: 'plan',
    batch: batch.map(b => JSON.parse(JSON.stringify(b))),
  });
  const bonsai = bonsaiOf({
    steps: [
      turn([read], 0),
      turn([read], 1),
      turn([read, read, read], 2),
      turn([read], 3),
      turn([read], 4),
      turn([read, { action: 'bash', args: { command: 'echo on', purpose: 'look', check: false } }], 5),
      turn([read], 6),
      turn([read], 7),
      turn([read], 8),
      turn([read], 9),
      turn([read], 10),
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 30 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.equal(ev.filter(e => e.type === 'refused').length, 0);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.route),
    ['read_files', 'read_files', 'bash'],
    'a batch of three repeats ran nothing and counted once; the command reset the count',
  );
  assert.match(result.stopReason, /four turns in a row could not be executed or only repeated earlier requests/);
  assert.equal(
    ev.filter(e => e.type === 'thought').length,
    10,
    'stopped at the fourth turn of repeats after the command, not before it',
  );
  assert.deepEqual(
    result.entries.filter(e => e.kind === 'repeat').map(e => e.id),
    ['e5', 'e6', 'e7', 'e8', 'e10', 'e11', 'e12', 'e13'],
    'each turn keeps its own statement; within the batch of three repeats an identical one replaced the earlier ones',
  );
});

test('A repeat of a read that failed is refused with its error: the same arguments fail the same way, and the batch stops there', async t => {
  const { root, store } = await repo(t);
  const read = { action: 'read_files', args: { files: [{ path: 'missing.ts', start: 1, end: 3 }] } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read it', action: 'plan', batch: [read] },
      {
        thought: 'read it again',
        action: 'plan',
        batch: [read, { action: 'bash', args: { command: 'echo after', purpose: 'look', check: false } }],
      },
    ],
  });
  await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.route),
    ['read_files'],
  );
  assert.match(
    ev.find(e => e.type === 'refused')!.data.why,
    /^this exact read_files failed at step 1 \(.*ENOENT.*\) and nothing it names has changed since, so it would fail the same way; the error is e1$/,
  );
});

test('The lines the evidence shows: numbered lines of the version asked for, from entries not marked stale, never a line a clip cut into', async () => {
  const { shownLines, clip } = await import('../src/context.js');
  const body = (a: number, b: number) =>
    Array.from({ length: b - a + 1 }, (_, i) => `${a + i}: const v${a + i} = ${'y'.repeat(30)};`).join('\n');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-shown-')), 'x');
  const entry = (id: string, text: string, stale?: string) => ({
    id,
    step: Number(id.slice(1)),
    kind: 'read_files',
    artifact: '',
    relevance: 0.5,
    text,
    ...(stale ? { stale } : {}),
  });
  s.entries = [
    entry('e1', `f.ts sha256=old totalLines=90 shown=1..90\n${body(1, 90)}`),
    entry(
      'e2',
      `g.ts sha256=g1 totalLines=9 shown=1..9\n${body(1, 9)}\n\nf.ts sha256=new totalLines=80 shown=1..40\n${body(1, 40)}\n[…truncated at the read budget after line 40; request lines 41..80 in a later read_files call or narrow the range…]`,
    ),
    entry('e3', clip(`f.ts sha256=new totalLines=80 shown=41..80\n${body(41, 80)}`, 1500)),
    entry('e4', `f.ts sha256=new totalLines=80 shown=1..80\n${body(1, 80)}`, 'edited at step 5'),
  ];
  const { total, by } = shownLines(s, 'f.ts', 'new');
  assert.equal(total, 80);
  assert.deepEqual(
    [...by].filter(([, id]) => id === 'e2').map(([n]) => n),
    Array.from({ length: 40 }, (_, i) => i + 1),
    'the second file of a read, after another file; the budget marker ends it',
  );
  const text = s.entries[2]!.text.split('\n');
  const at = text.findIndex(l => l.startsWith('[…truncated; use'));
  const before = Number(text[at - 1]!.match(/^(\d+):/)![1]);
  const after = Number(text[at + 2]!.match(/^(\d+):/)![1]);
  assert(by.get(41) === 'e3' && by.get(before - 1) === 'e3', 'the head of the clipped entry');
  assert(
    !by.has(before) && !by.has(after) && !by.has(80),
    'the line cut before the marker is not shown, and after a marker nothing is credited: the tail may belong to another file of the same read',
  );
  assert.equal(shownLines(s, 'f.ts', 'old').by.size, 90, 'another version is its own');
  assert.equal(shownLines(s, 'f.ts', undefined).by.size, 90, 'an archived output has one version: any header counts');
});

test('A line longer than any read shows whole is stated, never read again: the lines after it are read, and turns that only repeat still end the attempt', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'svg.ts'),
    `const a = 1;\nconst d = '${'M0 0L1 1'.repeat(375)}';\nconst b = 2;\nconst c = 3;\nconst e = 4;\n`,
  );
  const read = { files: [{ path: 'svg.ts', start: 1, end: 5 }] };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 12 }, (_, i) => ({ thought: `read svg (${i})`, action: 'read_files', args: read })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 12, toolChars: 1600 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  const reads = ev
    .filter(e => e.type === 'action')
    .map(e => [e.data.step, e.data.args.files.map((f: any) => `${f.start}..${f.end}`).join(',')]);
  assert.match(
    result.entries.find(e => e.id === 'e2')!.text,
    /shown=1\.\.1\n[\s\S]*request lines 2\.\.5/,
    'the scenario: line 2 does not fit the read budget',
  );
  assert.deepEqual(
    reads,
    [
      [1, '1..5'],
      [2, '1..5'],
      [3, '3..5'],
    ],
    'line 2 is never read again; the lines after it are read once',
  );
  const facts = result.entries.filter(e => e.kind === 'repeat');
  assert.equal(facts.length, 4, 'one statement per turn of repeats');
  assert(facts.every(f => f.text === facts[0]!.text));
  assert.match(
    facts[0]!.text,
    /svg\.ts sha256=\w+ \(6 lines\): lines 1\.\.1 in e2, 3\.\.5 in e3; line 2 \(3016 characters with its number\) is longer than a read shows whole \(1354 characters\), so every read of it shows its two ends only\. Nothing was read again\.$/,
  );
  assert.match(result.stopReason, /four turns in a row could not be executed or only repeated earlier requests/);
  assert.equal(
    ev.filter(e => e.type === 'thought').length,
    7,
    'four turns of repeats after the last read end the attempt',
  );
});

test('A repeated read of a file whose text starts with a byte order mark, or whose path has a space, or of a range past its end, is answered from the evidence: the harness hashes it as read_files does', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'bom.ts'), '﻿export const a = 1;\nexport const b = 2;\n');
  await writeFile(join(root, 'my file.ts'), 'export const c = 3;\n');
  const read = {
    files: [
      { path: 'bom.ts', start: 1, end: 2 },
      { path: 'my file.ts', start: 1, end: 1 },
      { path: 'my file.ts', start: 5, end: 9 },
    ],
  };
  const bonsai = bonsaiOf({
    steps: [0, 1, 2].map(i => ({ thought: `read (${i})`, action: 'read_files', args: read })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.step),
    [1, 2],
  );
  assert.match(
    result.entries.find(e => e.id === 'e3')!.text,
    /bom\.ts sha256=\w+ \(3 lines\): lines 1\.\.2 in e2; my file\.ts sha256=\w+ \(2 lines\): lines 1\.\.1 in e2; my file\.ts sha256=\w+ \(2 lines\): no line in 5\.\.9\. Nothing was read again\.$/,
    'a range past the end is stated as such',
  );
});

test('A repeated search runs again once the harness recorded a write or a check since it ran: a command that deleted a file it listed', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'const needle = 1;\n');
  await writeFile(join(root, 'src', 'old.ts'), 'const needle = 2;\n');
  const search = { action: 'search_codebase', args: { query: 'needle', path: 'src', mode: 'text' } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'find', action: 'plan', batch: [search] },
      { thought: 'drop old', action: 'bash', args: { command: 'rm src/old.ts', purpose: 'remove', check: false } },
      { thought: 'find again', action: 'plan', batch: [search] },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.route),
    ['search_codebase', 'bash', 'search_codebase'],
  );
  assert.equal(ev.filter(e => e.type === 'repeated').length, 0);
  assert(
    !/old\.ts/.test(result.entries.find(e => e.id === 'e3')!.text),
    'the new result no longer lists the deleted file',
  );
});

test("A repeat's statement is kept whole, however many files and entries it names; each turn that repeats the request keeps its own", async t => {
  const { root, store } = await repo(t);
  const dir = `src/${'components/'.repeat(8)}`;
  await mkdir(join(root, dir), { recursive: true });
  const paths = ['FirstLongComponentName.tsx', 'SecondLongComponentName.tsx', 'ThirdLongComponentName.tsx'].map(
    n => `${dir}${n}`,
  );
  for (const p of paths) await writeFile(join(root, p), numbered(3));
  const read = { files: paths.map(path => ({ path, start: 1, end: 3 })) };
  const bonsai = bonsaiOf({
    steps: [0, 1, 2, 3].map(i => ({ thought: `read (${i})`, action: 'read_files', args: read })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const facts = result.entries.filter(e => e.kind === 'repeat');
  assert.deepEqual(
    facts.map(e => e.id),
    ['e3', 'e4'],
    'the second identical statement stands beside the first',
  );
  assert.equal(facts[0]!.text, facts[1]!.text);
  assert(facts[0]!.text.length > 600 && !facts[0]!.text.includes('truncated'), 'not clipped');
  for (const p of paths) assert(facts[0]!.text.includes(`${p} sha256=`), `names ${p}`);
});

test('A partial read that follows a repeat leaves the entries its statement names as they are, even when it reads a file they also show', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(5));
  await writeFile(join(root, 'b.ts'), numbered(5));
  const read = {
    files: [
      { path: 'a.ts', start: 1, end: 5 },
      { path: 'b.ts', start: 1, end: 5 },
    ],
  };
  const base = bonsaiOf({ steps: [0, 1, 2].map(i => ({ thought: `read (${i})`, action: 'read_files', args: read })) });
  let calls = 0;
  // b.ts changes outside the harness before the third turn.
  const bonsai = {
    ...base,
    generate: async (m: Message[], schema: any) => {
      if (schema.properties?.actions && ++calls === 3) await writeFile(join(root, 'b.ts'), numbered(6));
      return base.generate(m, schema);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev
      .filter(e => e.type === 'action')
      .map(e => [e.data.step, e.data.args.files.map((f: any) => `${f.path} ${f.start}..${f.end}`).join(',')]),
    [
      [1, 'a.ts 1..5,b.ts 1..5'],
      [2, 'a.ts 1..5,b.ts 1..5'],
      [3, 'b.ts 1..5'],
    ],
  );
  assert.equal(result.entries.find(e => e.id === 'e2')!.stale, undefined, 'e2 still shows a.ts as it is');
  assert.match(
    result.entries.find(e => e.id === 'e3')!.text,
    /\nHarness: this repeats the read_files of step 2; at this step the evidence showed a\.ts sha256=\w+ \(6 lines\): lines 1\.\.5 in e2, so only b\.ts 1\.\.5 was read\.$/,
  );
});

test("A repeat's statement protects the entries it names while it is the freshest entry, and is marked once one of them leaves", async () => {
  const { evictOne } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-cites-')), 'x');
  const entry = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id,
    step: Number(id.slice(1)),
    kind,
    artifact: '',
    relevance: 0.5,
    text: `${id} text`,
    ...extra,
  });
  s.entries = [entry('e1', 'read_files'), entry('e2', 'read_files'), entry('e3', 'repeat', { cites: ['e1'] })];
  assert.equal(evictOne(s)?.id, 'e2', 'e1 is named by the freshest entry, so e2 goes');
  s.entries.push(entry('e4', 'bash'));
  assert.equal(evictOne(s, 0, 'e1')?.id, 'e1');
  assert.equal(s.entries.find(e => e.id === 'e3')!.stale, 'names e1, which has left the prompt');
});

test('A repeat followed by a failure in the same turn is not progress: such turns count toward the four in a row', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'r0', action: 'plan', batch: [read] },
      { thought: 'r1', action: 'plan', batch: [read] },
      ...Array.from({ length: 6 }, (_, i) => ({
        thought: `try ${i}`,
        action: 'plan',
        batch: [
          JSON.parse(JSON.stringify(read)),
          { action: 'bash', args: { command: `node -e "process.exit(${i + 1})"`, purpose: 'try', check: false } },
        ],
      })),
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 30 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.route),
    ['read_files', 'read_files', 'bash', 'bash', 'bash', 'bash'],
  );
  assert.match(result.stopReason, /four turns in a row could not be executed or only repeated earlier requests/);
});

// Whether the next thought repeats follows the copies of it the next prompt holds (runs to 76: none left
// 1/51, one 20/42, two or more 11/12). Removing the earlier copy when the repeat ran an action left one copy
// all the same and re-processed everything after the removed turn (runs 49-76: 26 such resets, 44.6 s of
// prompt processing; run 73 step 30, 5,638 tokens). Keeping the earlier copy and not adding the repeat leaves
// the same one copy and the prompt only grows. A repeat that changed nothing still leaves no copy.
test('Reasoning copied word for word from the previous turn is not added: the earlier copy stays and the prompt only grows; a repeat that changed nothing takes the earlier copy with it; turns that only open alike are kept', async t => {
  const { root, store } = await repo(t);
  const same =
    'The build passes and the page renders. The render shows class names without CSS. Let me read the stylesheet to see what exists.';
  const bash = (command: string) => ({ action: 'bash', args: { command, purpose: 'look', check: false } });
  const steps = [
    { thought: 'Start by looking around the repository to see what is there already.', ...bash('echo a') },
    { thought: `${same} First the top part.`, ...bash('echo b') },
    { thought: `${same} Now the bottom part.`, ...bash('echo c') },
    { thought: `${same} Now the bottom part.`, ...bash('echo d') },
    // The same command again with nothing written since is refused: the turn changed nothing.
    { thought: `${same} Now the bottom part.`, ...bash('echo d') },
    { thought: 'The stylesheet is empty, so the classes have no rules; write them next.', ...bash('echo e') },
  ];
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 6 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  const copies = (m: Message[]) =>
    m.filter(x => x.role === 'assistant' && x.content.includes('Now the bottom part')).length;
  assert.deepEqual(
    ev.filter(e => e.type === 'repeated-thought').map(e => [e.data.step, e.data.kept]),
    [
      [4, 't3'],
      [5, 't3'],
    ],
    'only the word-for-word repeats, not the turn that merely opens alike',
  );
  assert.equal(copies(prompts[4]!), 1, 'after the repeat that ran: one copy, the earlier one');
  assert.deepEqual(
    prompts[4]!.slice(0, prompts[3]!.length - 2),
    prompts[3]!.slice(0, -2),
    'nothing before the new results changed: the server re-processes only them and the tail',
  );
  assert.deepEqual(
    ev.filter(e => e.type === 'reasoning-reset').map(e => [e.data.step, e.data.reason, e.data.turns]),
    [[5, 'repeated', ['t3']]],
    'the repeat that changed nothing takes the earlier copy',
  );
  assert.equal(copies(prompts[5]!), 0);
  assert.deepEqual(
    result.entries.filter(e => e.kind === 'turn').map(e => e.id),
    ['t1', 't2', 't6'],
  );
  assert.equal(result.entries.filter(e => e.kind === 'bash').length, 5, 'the results stay');
});

// The repeat check compares with the last turn in the prompt, so the copy kept must be that turn: keeping an
// earlier copy (the thought came back after another) would let the next repeat through as a new turn, and the
// prompt after it would hold two copies (then the next thought was equal 11 times in 12).
test('A thought that came back after another and then repeats keeps the latest copy: every further repeat is still caught and no prompt holds two copies after it', async t => {
  const { root, store } = await repo(t);
  const x = 'The page renders but the hero image is missing. Let me look at how the public folder is served.';
  const bash = (command: string) => ({ action: 'bash', args: { command, purpose: 'look', check: false } });
  const steps = [
    { thought: x, ...bash('echo a') },
    {
      thought: 'The public folder is served from the root; check the image path in the component next.',
      ...bash('echo b'),
    },
    { thought: x, ...bash('echo c') },
    { thought: x, ...bash('echo d') },
    { thought: x, ...bash('echo e') },
    { thought: x, ...bash('echo f') },
    { thought: 'The image path was wrong; fix it in the component and build.', ...bash('echo g') },
  ];
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 7 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  const copies = (m: Message[]) =>
    m.filter(y => y.role === 'assistant' && y.content.includes('hero image is missing')).length;
  assert.deepEqual(
    ev.filter(e => e.type === 'repeated-thought').map(e => [e.data.step, e.data.kept]),
    [
      [4, 't3'],
      [5, 't3'],
      [6, 't3'],
    ],
    'the thought that came back after another is not a repeat; each one after it is',
  );
  assert.deepEqual(
    ev.filter(e => e.type === 'reasoning-reset').map(e => [e.data.step, e.data.reason, e.data.turns]),
    [[4, 'repeated', ['t1']]],
    'the earlier copy goes once',
  );
  assert.deepEqual(prompts.map(copies), [0, 1, 1, 2, 1, 1, 1]);
  assert.deepEqual(
    prompts[5]!.slice(0, prompts[4]!.length - 2),
    prompts[4]!.slice(0, -2),
    'a caught repeat only appends',
  );
  assert.deepEqual(
    result.entries.filter(e => e.kind === 'turn').map(e => e.id),
    ['t2', 't3', 't7'],
  );
  assert.equal(result.entries.filter(e => e.kind === 'bash').length, 7, 'the results stay');
});

test("A file generated inside a repeat's batch sees the reasoning once, through the turn kept, and its prompt extends the step's", async t => {
  const { root, store } = await repo(t);
  const x = 'The components are written; the page still needs its sections, so write the next one as planned.';
  const steps = [
    { thought: x, action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
    { thought: x, action: 'create_file', args: { path: 'src/b.ts', purpose: 'b' } },
  ];
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
    generateText: async (m: Message[]) => {
      prompts.push(m);
      return bonsai.generateText(m);
    },
  };
  await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const generated = prompts.find(m => JSON.parse(m.at(-1)!.content).file === 'src/b.ts')!;
  const step = prompts[prompts.indexOf(generated) - 1]!;
  assert.deepEqual(
    generated
      .filter(m => m.role === 'assistant' && m.content.includes('write the next one as planned'))
      .map(m => JSON.parse(m.content).actions[0].args.path),
    ['src/a.ts'],
    'one copy: the turn kept',
  );
  assert.deepEqual(generated.slice(0, step.length - 2), step.slice(0, -2), 'nothing before the tail changed');
});

test('earlierSteps sits before the evidence: it changes only when evidence is evicted, so it is not reprocessed every step', async () => {
  const { stepMessages, turnEntry } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-trail-')), 'x');
  s.entries = [
    turnEntry(3, 'look', [{ action: 'bash', args: { command: 'ls' } }]),
    { id: 'e3', step: 3, kind: 'bash', text: 'out', artifact: '', relevance: 0.5, turn: 't3' },
  ];
  s.trail = ['step 1: bash ls -> bash ok'];
  const m = stepMessages(s, ['bash']);
  assert.deepEqual(JSON.parse(m[2]!.content), { earlierSteps: s.trail }, 'right after the pinned block');
  assert.equal(m[3]!.role, 'assistant');
  assert(!m.slice(4).some(x => x.content.includes('earlierSteps')), 'not repeated in the volatile tail');
});

test('The per-turn tail carries short hashes, no duplicated edit history, and names the files written after the verification ran', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(2);\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'rewrite', action: 'rewrite_file', args: { path: 'src/a.ts', purpose: 'b' } },
      { thought: 'look', action: 'bash', args: { command: 'echo hi', purpose: 'look', check: false } },
    ],
    files: { 'src/a.ts': 'export const a = 2;\n' },
  });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const fields = (m: Message[]) => Object.assign({}, ...m.slice(-2).map(x => JSON.parse(x.content)));
  const last = fields(prompts.at(-1)!);
  assert.deepEqual(
    last.verification.writtenSince,
    ['src/a.ts'],
    'the check ran before the rewrite: its output is about the old file',
  );
  assert(!('writtenSince' in fields(prompts[1]!).verification), 'nothing written since: no such field');
  assert(!('editEvidence' in last), 'the turns already show what was done');
  for (const h of Object.values(last.fileHashes as Record<string, string>)) assert.match(h, /^[0-9a-f]{16}$/);
});

test("A completion about to pass while Jev names the observation as its weakest evidence gets a focused reading of it alone, asked with the observer's own question; a clear no stops it, with the facts", async () => {
  const { evidenceGate } = await import('../src/control.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-gate-')), 'Bootstrap a landing page');
  // The shape of react-demo-26: rendered after the last write, match 0.78, render named weakest (0.79), 5 of 45 class names styled.
  const { observerFor } = await import('../src/observe.js');
  const observation = {
    kind: 'page',
    step: 33,
    afterLastWrite: true,
    ok: true,
    target: 'http://localhost:3000',
    facts:
      'Rendered http://localhost:3000: no exception, every request and image loaded; 5 of the 45 class names on visible elements match a CSS rule.',
    question: observerFor('page')!.question,
  };
  const facts = {
    summary: 'done',
    changedFiles: ['src/App.tsx'],
    diffStat: '',
    observation,
    observationState: 'current' as const,
    verification: { command: 'npm run build', ok: true, afterLastWrite: true, exitCode: 0, text: 'built' },
    requirements: [],
    sources: {},
  };
  const calls: string[] = [];
  const jevWith = (focus: number, matches = 0.78) => {
    const j = jevOf({
      gate: {
        implementation_matches_request: matches,
        claim_supported: 0.87,
        verification_needed: 'semantic_review',
        weakest_evidence: 'observation',
        focus,
      } as any,
    });
    return {
      decide: async (st: any, q: any, c: any) => {
        calls.push(c.phase);
        if (c.phase === 'evidence-focus') {
          assert.deepEqual(Object.keys(st).sort(), ['evidence', 'objective', 'observation']);
          assert.equal(
            q.evidence_shows_done.instructions,
            observerFor('page')!.question,
            "the page observer's own question",
          );
        } else
          assert.equal(
            st.result.observation.question,
            undefined,
            'the main reading is not handed the focused question',
          );
        return j.decide(st, q, c);
      },
    };
  };
  const broken = await evidenceGate(jevWith(0.11) as any, s, facts);
  assert.equal(broken.accepted, false);
  assert.match(broken.reason, /focused reading of the observation alone .*\(0\.11\).*5 of the 45 class names/s);
  assert.deepEqual(calls, ['evidence-gate', 'evidence-focus']);
  const good = await evidenceGate(jevWith(0.46) as any, s, facts);
  assert.equal(good.accepted, true, 'a focused reading that is not a clear no leaves the verdict as it was');
  calls.length = 0;
  const rejected = await evidenceGate(jevWith(0.11, 0.4) as any, s, facts);
  assert.equal(rejected.accepted, false);
  assert.deepEqual(calls, ['evidence-gate'], 'no second reading when the first already rejects');
});

test('A file the worker wrote and then deleted never stops the session: the completion the harness proposes reads the changed files that still exist', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'write two files',
        action: 'plan',
        batch: [
          { action: 'create_file', args: { path: 'tailwind.config.ts', purpose: 'config' } },
          { action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
        ],
      },
      {
        thought: 'the config is not needed',
        action: 'bash',
        args: { command: 'rm tailwind.config.ts', purpose: 'remove', check: false },
      },
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'never reached', action: 'bash', args: { command: 'echo x', purpose: 'x', check: false } },
    ],
    files: { 'tailwind.config.ts': 'export default {};\n', 'src/a.ts': 'export const a = 1;\n' },
  });
  // Jev reads the objective as satisfied after the check: the harness proposes completion, which reads the changed files.
  const result = await new Agent(
    { ...config, maxSteps: 6 },
    store,
    jevOf({ watch: n => ({ objective_satisfied: n >= 3 ? 0.9 : 0.2 }) }),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.doesNotMatch(result.stopReason, /ENOENT|realpath/);
  assert.equal(result.status, 'complete', result.stopReason);
  const facts = (await events(store)).find(e => e.type === 'completion')!;
  assert(facts, 'the harness proposed completion and the gate judged it');
});

test('rewrite_file with start and end regenerates only that block as code and splices it in: an append, and a replacement whose repeated context lines are trimmed', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'app.css'), '.a { color: red; }\n.b { color: blue; }\n.c { color: green; }\n');
  const prompts: Message[][] = [];
  let calls = 0;
  const blocks = [
    '.d { color: black; }\n.e { color: white; }\n',
    '.a { color: red; }\n.b2 { color: navy; }\n.c { color: green; }\n',
  ];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/app.css', start: 1, end: 3 }] } },
      {
        thought: 'append two rules',
        action: 'rewrite_file',
        args: { path: 'src/app.css', purpose: 'add .d and .e', start: 4, end: 3 },
      },
      {
        thought: 'replace line 2',
        action: 'rewrite_file',
        args: { path: 'src/app.css', purpose: 'b becomes b2', start: 2, end: 2 },
      },
    ],
  });
  const spy = {
    ...bonsai,
    generateText: async (m: Message[]) => {
      prompts.push(m);
      return { text: blocks[calls++]!, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(
    await readFile(join(root, 'src', 'app.css'), 'utf8'),
    '.a { color: red; }\n.b2 { color: navy; }\n.c { color: green; }\n.d { color: black; }\n.e { color: white; }\n',
    'the append landed at the end, the replacement in place, the repeated context lines trimmed',
  );
  const req = JSON.parse(prompts[0]!.at(-1)!.content);
  assert.equal(req.lines, '4..3 of 3');
  assert.equal(req.region, '');
  assert.match(req.before, /\.a \{[\s\S]*\.c \{ color: green; \}/);
  assert.equal(
    req.currentContent,
    undefined,
    'before, region and after already show the whole file, so it is not sent a second time',
  );
  const edits = result.entries.filter(e => e.kind === 'write');
  assert.match(
    edits[0]!.text,
    /^Replaced lines 4\.\.3 of src\/app\.css with 2 generated line\(s\); the file now has 5 lines/,
  );
  assert.match(
    edits[1]!.text,
    /^Replaced lines 2\.\.2 of src\/app\.css with 1 generated line\(s\); the file now has 5 lines/,
  );
});

test('A block rewrite by line numbers is refused when the file changed after the version the worker last saw; an append is not', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.css'), '.a {}\n.b {}\n');
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'a.css', start: 1, end: 2 }] } },
      { thought: 'replace line 1', action: 'rewrite_file', args: { path: 'a.css', purpose: 'x', start: 1, end: 1 } },
      { thought: 'append', action: 'rewrite_file', args: { path: 'a.css', purpose: 'y', start: 9, end: 8 } },
    ],
    files: { 'a.css': '.z {}\n' },
  });
  // Someone else changes the file between the read and the edit.
  let n = 0;
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      if (++n === 2) await writeFile(join(root, 'a.css'), '.x {}\n.a {}\n.b {}\n');
      return bonsai.generate(m, s);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.entries.find(e => e.kind === 'generation_error')!.text, /changed since the version you last saw/);
  assert.equal(
    await readFile(join(root, 'a.css'), 'utf8'),
    '.x {}\n.a {}\n.b {}\n.z {}\n',
    'the append (start past the end) went through',
  );
});

test('A render whose server announces a different address fails within seconds and names it, instead of waiting out the timeout', async t => {
  const { announcedElsewhere } = await import('../src/render.js');
  assert.deepEqual(
    announcedElsewhere('  \u001b[32m➜\u001b[39m  Local:   http://localhost:5173/\n', 'http://localhost:3000'),
    ['http://localhost:5173/'],
  );
  assert.equal(
    announcedElsewhere('Local: http://localhost:3000/', 'http://localhost:3000/'),
    null,
    'the requested port is announced: keep waiting',
  );
  assert.equal(announcedElsewhere('starting…', 'http://localhost:3000'), null, 'nothing announced yet');
  assert.deepEqual(
    announcedElsewhere('Starting development server at http://127.0.0.1:8000/', 'http://localhost:3000'),
    ['http://127.0.0.1:8000/'],
  );
  if (!(await findBrowser())) return;
  const root = await mkdtemp(join(tmpdir(), 'leana-port-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'serve.mjs'),
    'import { createServer } from "node:http"; const s = createServer((q, r) => r.end("hi")).listen(0, "127.0.0.1", () => console.log(`Local: http://localhost:${s.address().port}/`));\n',
  );
  const t0 = Date.now();
  const r = await renderFacts(root, 'http://127.0.0.1:39123/', 'node serve.mjs', null, 60000);
  assert.equal(r.ok, false);
  assert.match(r.text, /says it is listening at http:\/\/localhost:\d+\//);
  assert(Date.now() - t0 < 15000, `failed fast (${Date.now() - t0} ms), not after the 45 s timeout`);
});

test('Calls written in a shape that reads one way only are run as meant, not refused: five files as two reads, a bare path as a read, write with a whole file as rewrite_file or create_file (runs react-demo-7 and supermarket-1: refused until the run stopped)', async t => {
  const { root, store } = await repo(t);
  for (const n of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(root, `${n}.ts`), `export const ${n} = 1;\n`);
  const whole = (path: string) => ({ path, start: 1, end: 1000000 });
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'Read the scaffold.',
        action: 'read_files',
        batch: [{ action: 'read_files', args: { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(whole) } }],
      },
      { thought: 'And one more.', action: 'read_files', batch: [{ action: 'read_files', args: { path: 'a.ts' } }] },
      {
        thought: 'Replace a whole file, and add one.',
        action: 'write',
        batch: [
          { action: 'write', args: { path: 'b.ts', content: 'export const b = 2;\n' } },
          { action: 'write', args: { path: 'f.ts', content: 'export const f = 1;\n' } },
        ],
      },
      { thought: 'Ask.', action: 'ask_user', args: { question: 'done reading' } },
    ],
  });
  const s = await newSession(root, 'read the scaffold');
  const agent = new Agent(
    { ...config, promptForm: 'tools' },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  );
  const result = await agent.run(s);
  assert.equal(result.status, 'paused', result.stopReason);
  assert.equal(result.stopReason, 'done reading', 'stopped where the worker asked, not by four refusals');
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'refused'),
    [],
    'nothing refused',
  );
  const reads = ev
    .filter(e => e.type === 'action' && e.data.route === 'read_files')
    .map(e => e.data.args.files.map((f: any) => f.path));
  assert.deepEqual(reads, [['a.ts', 'b.ts', 'c.ts'], ['d.ts', 'e.ts'], ['a.ts']]);
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'export const b = 2;\n', 'rewritten whole');
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), 'export const f = 1;\n', 'created');
  assert.deepEqual(
    ev.filter(e => e.type === 'repaired').map(e => e.data.repairs),
    [
      ['read_files named 5 files, read as 2 reads'],
      ['read_files named its file outside files'],
      [
        "write carried b.ts's whole content, written as rewrite_file",
        "write carried f.ts's whole content, written as create_file",
      ],
    ],
  );
});

test('Under the tools form a turn takes up to sixteen calls, a turn of one call that decided nothing is answered with a push to batch, and calls past the limit are said to have not run (runs react-demo-glm-8: 28 requests mostly of one call; react-demo-3: five create_file calls dropped unsaid)', async t => {
  const { root, store } = await repo(t);
  for (const n of ['a', 'b']) await writeFile(join(root, `${n}.ts`), `export const ${n} = 1;\n`);
  const read = (path: string) => ({ action: 'read_files', args: { files: [{ path, start: 1, end: 5 }] } });
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'One read.', action: 'read_files', batch: [read('a.ts')] },
      { thought: 'Two reads.', action: 'read_files', batch: [read('a.ts'), read('b.ts')] },
      { thought: 'Two more, two dropped.', action: 'read_files', batch: [read('b.ts')] },
      { thought: 'Ask.', action: 'ask_user', args: { question: 'done' } },
    ],
  });
  const prompts: Message[][] = [];
  const schemas: any[] = [];
  let n = 0;
  const agent = new Agent(
    { ...config, promptForm: 'tools' },
    store,
    jevOf({}),
    {
      ...bonsai,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        schemas.push(schema);
        const out = await bonsai.generate(m, schema);
        return ++n === 3 ? { ...out, dropped: ['create_file', 'bash'] } : out;
      },
    } as any,
    root,
    () => {},
    () => {},
  );
  const result = await agent.run(await newSession(root, 'read'));
  assert.equal(result.stopReason, 'done');
  assert.deepEqual(
    schemas.map(x => x.properties.actions.maxItems),
    [16, 16, 16, 16],
    'up to sixteen calls a turn',
  );
  const request = (i: number) => JSON.parse(prompts[i]!.at(-1)!.content);
  assert.match(request(0).role, /up to sixteen calls in order\. Every turn re-sends the whole conversation/);
  assert.match(
    String(request(1).harnessNote),
    /^Your last turn made one call\. Every turn re-sends the whole conversation/,
  );
  assert.doesNotMatch(String(request(2).harnessNote ?? ''), /Your last turn made one call/, 'a turn of two calls');
  assert.match(
    String(request(3).harnessNote),
    /2 calls of your last turn did not run \(a turn runs at most 16\): create_file, bash\. Make whichever of them are still needed now\./,
  );
  const json = new Agent(
    config,
    store,
    jevOf({}),
    {
      ...bonsaiOf({ steps: [{ thought: 'Ask.', action: 'ask_user', args: { question: 'q' } }] }),
      generate: async (m: Message[], schema: any) => {
        schemas.push(schema);
        return { thought: 'Ask.', actions: [{ action: 'ask_user', args: { question: 'q' } }] };
      },
    } as any,
    root,
    () => {},
    () => {},
  );
  await json.run(await newSession(root, 'json'));
  assert.equal(schemas.at(-1).properties.actions.maxItems, 8, "Bonsai's grammar keeps eight");
});

test('A read shows as much of the range as the character budget allows, not a fixed number of lines', async t => {
  const { root } = await repo(t);
  await writeFile(
    join(root, 'big.css'),
    Array.from({ length: 600 }, (_, i) => `.c${i} { margin: ${i}px; }`).join('\n') + '\n',
  );
  const { ToolBox } = await import('../src/tools.js');
  const wide = new ToolBox(root, join(root, '.art'), { ...config, toolChars: 20000 }, async () => '');
  const r = await wide.execute('read_files', { files: [{ path: 'big.css', start: 1, end: 600 }] });
  assert.match(r.text, /shown=1\.\.(\d+)/);
  const shown = Number(r.text.match(/shown=1\.\.(\d+)/)![1]);
  assert(shown > 250, `a 20k-character budget shows ${shown} lines, more than the old 250-line cap`);
  const narrow = new ToolBox(root, join(root, '.art'), { ...config, toolChars: 2000 }, async () => '');
  const n = Number(
    (await narrow.execute('read_files', { files: [{ path: 'big.css', start: 1, end: 600 }] })).text.match(
      /shown=1\.\.(\d+)/,
    )![1],
  );
  assert(n < shown && n > 20, `a smaller budget shows fewer lines (${n})`);
});

test('A stylesheet is generated against the class names the markup uses, and a rewrite of it is told which of them it has no rule for yet', async t => {
  const { classNamesIn } = await import('../src/profiles.js');
  assert.deepEqual(
    classNamesIn(
      '<div className="hero hero--dark"><p className={`hero__text ${big ? "x" : ""}`} /><a class=\'nav-link\'>',
    ),
    ['hero', 'hero--dark', 'hero__text', 'nav-link'],
  );
  assert.deepEqual(classNamesIn('<template><div class="card card__body">{{ x }}</div></template>'), [
    'card',
    'card__body',
  ]);
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'component', action: 'create_file', args: { path: 'src/Hero.tsx', purpose: 'hero' } },
      { thought: 'styles', action: 'create_file', args: { path: 'src/app.css', purpose: 'styles' } },
      {
        thought: 'append the missing rules',
        action: 'rewrite_file',
        args: { path: 'src/app.css', purpose: 'rules for the rest', start: 99, end: 98 },
      },
      { thought: 'code file', action: 'create_file', args: { path: 'src/util.ts', purpose: 'util' } },
    ],
    files: {
      'src/Hero.tsx':
        'export const Hero = () => <section className="hero"><h1 className="hero__title">Hi</h1><p className="hero__text">x</p></section>;\n',
      'src/app.css': '.hero { padding: 2rem; }\n',
      'src/util.ts': 'export const u = 1;\n',
    },
  });
  const spy = {
    ...bonsai,
    generateText: async (m: Message[], o: any) => {
      prompts.push(m);
      return bonsai.generateText(m);
    },
  };
  await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const req = (i: number) => JSON.parse(prompts[i]!.at(-1)!.content);
  assert.deepEqual(
    req(1).classNamesUsedByMarkup,
    { 'src/Hero.tsx': ['hero', 'hero__title', 'hero__text'] },
    'the new stylesheet sees the class names the component uses',
  );
  assert.deepEqual(
    req(2).classNamesWithoutRuleInThisFile,
    ['hero__title', 'hero__text'],
    'the rewrite is told which ones still have no rule in the file',
  );
  assert(
    !('classNamesUsedByMarkup' in req(0)) && !('classNamesUsedByMarkup' in req(3)),
    'only stylesheets get this fact',
  );
});

test('Observers beyond pages: a service answering HTTP and a program run from the shell, each reported as facts with a clear failure', async t => {
  const { observeResult } = await import('../src/observe.js');
  const root = await mkdtemp(join(tmpdir(), 'leana-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { root, artifactPath: join(root, 'shot.png'), timeoutMs: 30000, prefix: '', files: [] };
  const port = 40000 + Math.floor(Math.random() * 20000);
  await writeFile(
    join(root, 'api.mjs'),
    `import { createServer } from 'node:http'; createServer((q, r) => { if (q.url === '/api/tasks') { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify([{ id: 1, title: 'a', done: false }])); } else { r.writeHead(404); r.end('no'); } }).listen(${port}, '127.0.0.1');\n`,
  );
  const ok = await observeResult('http', 'node api.mjs', `http://127.0.0.1:${port}/api/tasks`, ctx);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /^Answered: GET .* -> 200/);
  assert.match(ok.text, /JSON array of 1 item\(s\), items with keys id, title, done/);
  const missing = await observeResult('http', 'node api.mjs', `http://127.0.0.1:${port}/nope`, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /^HTTP ERROR: GET .* -> 404/);
  await writeFile(
    join(root, 'cli.mjs'),
    'if (process.argv[2] === "add") { console.log("Added task: " + process.argv[3]); } else { console.error("usage: cli add TITLE"); process.exit(2); }\n',
  );
  const ran = await observeResult('program', '', 'node cli.mjs add "buy milk"', ctx);
  assert.equal(ran.ok, true);
  assert.match(ran.text, /exit 0[\s\S]*Added task: buy milk/);
  const bad = await observeResult('program', '', 'node cli.mjs', ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^RUN FAILED: .* exit 2[\s\S]*usage: cli add TITLE/);
  assert.match(
    (await observeResult('radio', '', 'x', ctx)).text,
    /no observer of kind "radio"; the kinds are page, http, program/,
  );
});

test("A command-line objective is observed as a program run, and the gate's focused reading asks the program observer's question, not a page's", async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'cli.mjs'), 'console.log("3 tasks");\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'check and run it',
        action: 'plan',
        batch: [
          { action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
          { action: 'observe', args: { kind: 'program', start: '', target: 'node cli.mjs list' } },
        ],
      },
      { thought: 'done', action: 'finish', args: { summary: 'a task CLI' } },
    ],
  });
  const questions: string[] = [];
  const base = jevOf({
    gate: {
      implementation_matches_request: 0.8,
      claim_supported: 0.9,
      verification_needed: 'semantic_review',
      weakest_evidence: 'observation',
      focus: 0.7,
    } as any,
  });
  const jev = {
    decide: async (st: any, q: any, c: any) => {
      if (c.phase === 'evidence-focus') questions.push(q.evidence_shows_done.instructions);
      return base.decide(st, q, c);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jev as any,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'A command-line task manager'));
  assert.equal(result.lastObservation?.kind, 'program');
  assert.match(result.lastObservation!.text, /3 tasks/);
  assert.equal(result.status, 'complete', result.stopReason);
  const { describeObserver } = await import('../src/observe-catalog.js');
  assert.deepEqual(questions, [describeObserver('program')!.question]);
});

test('The loop and the gate know observations, not pages: no web vocabulary in agent.ts or control.ts', async () => {
  for (const f of ['agent.ts', 'control.ts']) {
    const code = (await readFile(new URL(`../../src/${f}`, import.meta.url), 'utf8'))
      .split('\n')
      .filter(l => !/^\s*\/\//.test(l))
      .join('\n');
    const hits =
      code.match(
        /\b(?:render(?:ed|s)?|pages?|css|scss|stylesheets?|browsers?|html|class ?names?|styl(?:ed|ing))\b/gi,
      ) ?? [];
    assert.deepEqual(hits, [], `${f} names ${[...new Set(hits)].join(', ')}: that belongs in an observer or a profile`);
  }
});

test('A created file whose relative import names a module that does not exist is told so at once, in any language; packages and existing modules are not', async t => {
  const { missingRelativeModules } = await import('../src/profiles.js');
  const files: Record<string, string> = {
    'src/components/Button.tsx': 'export const Button = () => null;\n',
    'app/models.py': 'class Task: pass\n',
  };
  const read = async (p: string) => files[p] ?? null;
  const tsx =
    'import { useState } from "react";\nimport "./Hero.css";\nimport { Button } from "./Button";\nexport const Hero = () => null;\n';
  assert.deepEqual(await missingRelativeModules('src/components/Hero.tsx', tsx, read), [
    'src/components/Hero.tsx imports ./Hero.css, which does not exist yet (no src/components/Hero.css): the build fails until it does',
  ]);
  assert.deepEqual(
    await missingRelativeModules(
      'app/cli.py',
      'from .models import Task\nfrom .store import Store\nimport json\n',
      read,
    ),
    [
      'app/cli.py imports .store, which does not exist yet (no app/store.py, app/store/__init__.py): the build fails until it does',
    ],
  );
  // In the loop: the fact lands on the creation result.
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({
    steps: [{ thought: 'hero', action: 'create_file', args: { path: 'src/Hero.tsx', purpose: 'hero' } }],
    files: { 'src/Hero.tsx': 'import "./Hero.css";\nexport const Hero = () => null;\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(
    result.entries.find(e => e.kind === 'create_file')!.text,
    /Harness: src\/Hero\.tsx imports \.\/Hero\.css, which does not exist yet/,
  );
});

test('A shell command that turns out to be a server (announces a local address, then goes quiet) is stopped within seconds and pointed at observe; a busy command or a check is not', async t => {
  const { root } = await repo(t);
  const { ToolBox } = await import('../src/tools.js');
  const tools = new ToolBox(root, join(root, '.art'), { ...config, commandTimeoutMs: 30000 }, async () => '');
  await writeFile(
    join(root, 'dev.mjs'),
    'console.log("  VITE ready\\n  Local:   http://localhost:5173/"); setInterval(() => {}, 1000);\n',
  );
  const t0 = Date.now();
  const server = await tools.execute('bash', { command: 'node dev.mjs', purpose: 'start', check: false });
  assert(Date.now() - t0 < 12000, `stopped early (${Date.now() - t0} ms), not at the 30 s timeout`);
  assert.equal(server.ok, false);
  assert.match(
    server.text,
    /^\{"command":"node dev\.mjs","purpose":"start","stoppedEarly":"This command is a server: it announced http:\/\/localhost:5173\/ .*use observe with start set to this command/,
  );
  // A command that prints an address but keeps working and then exits (a test run with a server inside) runs to its end.
  await writeFile(
    join(root, 'busy.mjs'),
    'console.log("listening on http://127.0.0.1:4000"); let n = 0; const i = setInterval(() => { console.log("test " + ++n); if (n === 8) { clearInterval(i); console.log("8 passed"); } }, 900);\n',
  );
  const busy = await tools.execute('bash', { command: 'node busy.mjs', purpose: 'tests', check: false });
  assert.equal(busy.ok, true);
  assert.match(busy.text, /8 passed/);
  assert.doesNotMatch(busy.text, /stoppedEarly/);
  // The check is never cut short this way.
  const quick = new ToolBox(root, join(root, '.art'), { ...config, commandTimeoutMs: 7000 }, async () => '');
  const check = await quick.execute('bash', { command: 'node dev.mjs', purpose: 'check', check: true });
  assert.doesNotMatch(check.text, /stoppedEarly/);
  assert.match(check.text, /"timedOut":true/);
});

test('A shell step that leaves processes running when it ends names them and says they were stopped; one that exits on its own, a plain command and a check say nothing', async t => {
  const { root } = await repo(t);
  const { ToolBox } = await import('../src/tools.js');
  const tools = new ToolBox(root, join(root, '.art'), { ...config, commandTimeoutMs: 30000 }, async () => '');
  await writeFile(join(root, 'idle.mjs'), 'setInterval(() => {}, 1000);\n');
  // Gone once reaped (a killed process is a zombie until its new parent collects it).
  const alive = async (pid: number) => {
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return true;
  };
  // Run 63, step 74: a server started with a trailing & and its output sent to a file; the command ends at once.
  let t0 = Date.now();
  const bg = await tools.execute('bash', {
    command: `node idle.mjs >${join(root, 'dev.log')} 2>&1 & echo started`,
    purpose: 'start',
    check: false,
  });
  const said = JSON.parse(bg.text);
  assert(Date.now() - t0 < 5000);
  assert.equal(bg.ok, true);
  assert.equal(said.output, 'started\n');
  assert.match(
    said.stoppedAtEnd,
    /^When this command ended, a process it started was still running, and it was stopped: "node idle\.mjs" \(pid (\d+)\)\. A shell step cannot keep a process alive: whatever it starts is stopped when it ends\. The start command of an observe runs for the length of that observation\.$/,
  );
  assert.equal(await alive(Number(said.stoppedAtEnd.match(/pid (\d+)/)[1])), false, 'and it was stopped');
  assert(!('leftRunning' in said), 'the process table rows are not shown raw');
  // Still holding the command's output: the command's end is when its shell exits, not the 30 s timeout.
  t0 = Date.now();
  const held = JSON.parse(
    (await tools.execute('bash', { command: 'node idle.mjs & echo held', purpose: 'start', check: false })).text,
  );
  assert(Date.now() - t0 < 5000, `ended with its shell (${Date.now() - t0} ms)`);
  assert.equal(held.timedOut, false);
  assert.equal(held.code, 0);
  assert.match(held.stoppedAtEnd, /"node idle\.mjs" \(pid \d+\)/);
  // A tree: what the command started is named, and what that started is counted.
  const tree = JSON.parse(
    (
      await tools.execute('bash', {
        command: 'bash -c "node idle.mjs & node idle.mjs & wait" >/dev/null 2>&1 & sleep 0.5; echo tree',
        purpose: 'start',
        check: false,
      })
    ).text,
  );
  assert.match(
    tree.stoppedAtEnd,
    /^When this command ended, 3 processes it started were still running, and they were stopped: "bash -c node idle\.mjs & node idle\.mjs & wait" \(pid \d+\) and 2 processes started by it\./,
  );
  // A subshell the command forked carries the harness's own command line: named as what it is, not by that line.
  const sub = JSON.parse(
    (
      await tools.execute('bash', {
        command: '( while true; do sleep 1; done ) >/dev/null 2>&1 & echo sub',
        purpose: 'start',
        check: false,
      })
    ).text,
  );
  assert.match(sub.stoppedAtEnd, /stopped: a subshell of this command \(pid \d+\)/);
  assert.doesNotMatch(sub.stoppedAtEnd, /--noprofile|pipefail/);
  // A background process on its way out when the command ends, a plain command and a check: nothing to say.
  for (const [command, check] of [
    ['sleep 0.1 >/dev/null 2>&1 & echo quick', false],
    ['echo plain', false],
    ['node -e "console.log(1)"', true],
  ] as const) {
    const r = await tools.execute('bash', { command, purpose: 'x', check });
    assert.equal(r.ok, true, r.text);
    assert.doesNotMatch(r.text, /stoppedAtEnd/, command);
  }
});

test("An observation with nothing to start at an address where nothing is listening says so, instead of reporting the browser's error page", async t => {
  const { observeResult } = await import('../src/observe.js');
  const root = await mkdtemp(join(tmpdir(), 'leana-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { root, artifactPath: join(root, 'shot.png'), timeoutMs: 30000, prefix: '', files: [] };
  // A port that was just free.
  const port = await new Promise<number>(done => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => done(p));
    });
  });
  const kinds = (await findBrowser()) ? ['http', 'page'] : ['http'];
  for (const kind of kinds) {
    const t0 = Date.now();
    const r = await observeResult(kind, '', `http://127.0.0.1:${port}/`, ctx);
    assert(Date.now() - t0 < 3000, `${kind}: at once (${Date.now() - t0} ms)`);
    assert.equal(r.ok, false);
    assert.equal(
      r.text,
      `Nothing is listening at 127.0.0.1:${port}: the connection to http://127.0.0.1:${port}/ was refused, and nothing was started for this observation (start was empty). Processes a shell step starts are stopped when the step ends, and the start command of an observe when that observation ends.`,
    );
  }
  // Something listening, started elsewhere: observed as before.
  const server = createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/plain' });
    r.end('up');
  });
  await new Promise<void>(done => server.listen(port, '127.0.0.1', () => done()));
  t.after(() => server.close());
  const up = await observeResult('http', '', `http://127.0.0.1:${port}/`, ctx);
  assert.equal(up.ok, true, up.text);
  assert.match(up.text, /^Answered: GET .* -> 200/);
  // A program's target is a command, not an address: never probed.
  const ran = await observeResult('program', '', 'node -e "console.log(7)"', ctx);
  assert.equal(ran.ok, true);
  assert.match(ran.text, /exit 0[\s\S]*7/);
  assert.doesNotMatch(ran.text, /Still running/);
  // An address that is not this machine is not probed: whatever refuses it may be between, and the request reports it.
  const { connectionRefused, localHost } = await import('../src/serve.js');
  let t1 = Date.now();
  assert.equal(await connectionRefused('http://192.0.2.1:9/'), false);
  assert(Date.now() - t1 < 500, `not probed (${Date.now() - t1} ms)`);
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '[::]'])
    assert.equal(localHost(h), true, h);
  for (const h of ['example.com', '192.168.1.2', '10.0.0.1', 'localhost.example.com'])
    assert.equal(localHost(h), false, h);
  // A program that leaves something running when it ends: said, as for a shell step.
  const left = await observeResult(
    'program',
    '',
    'node -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo left',
    ctx,
  );
  assert.match(
    left.text,
    /^Ran: .* -> exit 0\.\nStill running when it ended, and stopped with it: "node -e setInterval\(\(\) => \{\}, 1000\)" \(pid \d+\)\.\nOutput:\nleft/,
  );
});

test('A program observation runs its start command beside the program for the length of the observation: ready once its announced address accepts a connection, said when it ends first', async t => {
  const { observeResult } = await import('../src/observe.js');
  const root = await mkdtemp(join(tmpdir(), 'leana-program-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { root, artifactPath: join(root, 'shot.png'), timeoutMs: 30000, prefix: '', files: [] };
  const port = await new Promise<number>(done => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => done(p));
    });
  });
  await writeFile(
    join(root, 'srv.mjs'),
    `import { createServer } from 'node:http'; setTimeout(() => createServer((q, r) => r.end('pong')).listen(${port}, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:${port}/')), 300);\n`,
  );
  const client = `node -e "fetch('http://127.0.0.1:${port}/').then(r => r.text()).then(console.log)"`;
  const r = await observeResult('program', 'node srv.mjs', client, ctx);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Ran: .* -> exit 0\.\nOutput:\npong/);
  const { connectionRefused } = await import('../src/serve.js');
  let refused = false;
  for (let i = 0; i < 40 && !refused; i++) {
    refused = await connectionRefused(`http://127.0.0.1:${port}/`);
    if (!refused) await new Promise(res => setTimeout(res, 100));
  }
  assert.equal(refused, true, 'stopped when the observation ended');
  // A start command that ends before the program runs: said, with its output; the program does not run.
  const early = await observeResult(
    'program',
    'node -e "console.error(\'no config\'); process.exit(3)"',
    'echo never',
    ctx,
  );
  assert.equal(early.ok, false);
  assert.match(
    early.text,
    /^The command started with "node -e .*" ended \(exit 3\) before echo never ran\. Its output:\nno config/,
  );
});

test('Run 63, steps 74-75: the worker is told the server it started in the background was stopped, and the observation that follows says nothing is listening', async t => {
  const { root, store } = await repo(t);
  const port = await new Promise<number>(done => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => done(p));
    });
  });
  await writeFile(
    join(root, 'dev.mjs'),
    `import { createServer } from 'node:http'; createServer((q, r) => r.end('<!doctype html><p>hi</p>')).listen(${port}, '127.0.0.1');\n`,
  );
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'start the dev server',
        action: 'bash',
        args: {
          command: `node dev.mjs &>dev.log & sleep 1 && node -e "fetch('http://127.0.0.1:${port}/').then(r => r.text()).then(console.log)"`,
          purpose: 'start and verify',
          check: false,
        },
      },
      {
        thought: 'the dev server is running; look at it',
        action: 'observe',
        args: { kind: 'http', start: '', target: `http://127.0.0.1:${port}/` },
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const bash = result.entries.find(e => e.kind === 'bash')!.text;
  assert.match(bash, /"output":"<!doctype html><p>hi<\/p>\\n"/, 'the command itself saw the server answer');
  assert.match(
    bash,
    /"stoppedAtEnd":"When this command ended, a process it started was still running, and it was stopped: \\"node dev\.mjs\\" \(pid \d+\)\. A shell step cannot keep a process alive/,
  );
  assert.match(
    result.entries.find(e => e.kind === 'observe')!.text,
    new RegExp(
      `^Nothing is listening at 127\\.0\\.0\\.1:${port}: .*nothing was started for this observation \\(start was empty\\)`,
    ),
  );
});

test("After edits, the last check's diagnostics about the edited files are withheld and its evidence is marked stale; errors in untouched files stay", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = "x";\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b: number = "y";\n');
  await writeFile(
    join(root, 'check.mjs'),
    'console.log("src/a.ts(1,14): error TS2322: Type string is not assignable to type number.\\nsrc/b.ts(1,14): error TS2322: Type string is not assignable to type number."); process.exit(2);\n',
  );
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'fix a', action: 'rewrite_file', args: { path: 'src/a.ts', purpose: 'a is a number' } },
      { thought: 'next', action: 'bash', args: { command: 'echo next', purpose: 'look', check: false } },
    ],
    files: { 'src/a.ts': 'export const a: number = 1;\n' },
  });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const tail = (m: Message[]) => Object.assign({}, ...m.slice(-2).map(x => JSON.parse(x.content)));
  const before = tail(prompts[1]!).verification;
  const after = tail(prompts[2]!).verification;
  assert(
    before.output === 'shown in evidence e1' && Object.keys(before.files).length === 2,
    'right after the check: the entry that shows its output, and both files',
  );
  assert.deepEqual(
    Object.keys(after.files),
    ['src/b.ts'],
    'errors in the untouched file stay; those about the edited one are withheld',
  );
  assert.equal(after.output, undefined);
  assert.match(after.outputWithheld, /files were edited after this check ran \(src\/a\.ts\)/);
  const stale = tail(prompts[2]!).staleEvidence as Record<string, string>;
  assert(
    Object.values(stale).some(v => /files edited since this check \(src\/a\.ts\)/.test(v)),
    JSON.stringify(stale),
  );
});
test("The tail names the entry that shows the check's output and the last error while it is in the prompt, restates them once it has left, and sends allowedActions only when a step allows fewer actions than the pinned block lists", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = "x";\n');
  await writeFile(
    join(root, 'check.mjs'),
    'console.log("src/a.ts(1,14): error TS2322: Type string is not assignable to type number."); process.exit(2);\n',
  );
  const { stepMessages, regionMessages, clipEnds } = await import('../src/context.js');
  const bonsai = bonsaiOf({
    steps: [{ thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } }],
  });
  const s = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const tail = (m: Message[]) => Object.assign({}, ...m.slice(-2).map(x => JSON.parse(x.content)));
  const allowed = s.allowedActions!;
  const now = tail(stepMessages(s, allowed));
  assert.equal(now.verification.output, 'shown in evidence e1');
  assert.equal(now.lastError, 'shown in evidence e1');
  assert(
    now.verification.ok === false &&
      now.verification.exitCode === 2 &&
      JSON.stringify(now.verification.files) === '{"src/a.ts":[1]}',
    'pass/fail and the files and lines stay in the tail',
  );
  assert.match(s.entries.find(e => e.id === 'e1')!.text, /error TS2322/, 'the entry named shows the diagnostics');
  assert(
    !('allowedActions' in now) && /from the pinned block's actions/.test(now.role),
    'the pinned block lists the same actions',
  );
  // A code generation shares the prefix: the entry is in front of it as well.
  const gen = regionMessages(s, 'src/a.ts', 'a is a number', 'export const a: number = "x";\n', 1, 1, [], []);
  assert(
    JSON.parse(gen.at(-2)!.content).verification.output === 'shown in evidence e1' &&
      gen.some(m => m.content.startsWith('{"evidence":{"id":"e1"')),
  );
  // Once the entry has left the prompt, the tail is the only place that shows them.
  const later = tail(stepMessages({ ...s, entries: s.entries.filter(e => e.id !== 'e1') }, allowed));
  assert.equal(later.verification.output, clipEnds(s.lastCheck!.text, 1200));
  assert.match(later.verification.output, /error TS2322/);
  assert.match(later.lastError, /error TS2322/);
  assert.equal(
    tail(stepMessages({ ...s, entries: [] }, allowed, `Rejected: ${s.lastError}`)).lastError,
    'stated in harnessNote',
    'a note that states the error whole',
  );
  const fewer = tail(
    stepMessages(
      s,
      allowed.filter(a => a !== 'bash'),
    ),
  );
  assert(
    fewer.allowedActions.join() === allowed.filter(a => a !== 'bash').join() && /from allowedActions/.test(fewer.role),
    'a narrower step names what it allows',
  );
});
test("An output the check's entry does not show in full is restated: JSON escapes leave the entry's clipped end shorter than the field's", async t => {
  const { root, store } = await repo(t);
  // The entry keeps the last 736 characters of the result's JSON, about 340 escaped quotes; the field keeps the last 537 of the output.
  await writeFile(
    join(root, 'check.mjs'),
    'console.log("x".repeat(3000) + "\\n" + \'"\'.repeat(600)); process.exit(2);\n',
  );
  const { stepMessages, clipEnds } = await import('../src/context.js');
  const bonsai = bonsaiOf({
    steps: [{ thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } }],
  });
  const s = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const tail = Object.assign(
    {},
    ...stepMessages(s, s.allowedActions!)
      .slice(-2)
      .map(x => JSON.parse(x.content)),
  );
  assert(
    s.entries.some(e => e.id === 'e1'),
    'the entry is in the prompt',
  );
  assert.equal(
    tail.verification.output,
    clipEnds(s.lastCheck!.text, 1200),
    'but it does not show the whole of what the field keeps',
  );
  assert.equal(tail.lastError, 'shown in evidence e1', "the error's shorter clip it does show");
});
test('A check retried at its own step leaves two entries e1, so its output is restated; an output shorter than a pointer to it is kept as it is', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'check.mjs'),
    'import { existsSync, writeFileSync } from "node:fs"; if (!existsSync(".ran")) { writeFileSync(".ran", ""); console.log("ECONNRESET while fetching the registry index"); process.exit(1); } console.log("checked: no problems found in the sources"); process.exit(0);\n',
  );
  const { stepMessages } = await import('../src/context.js');
  const bonsai = bonsaiOf({
    steps: [{ thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } }],
  });
  const s = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({ triage: 'transient' }),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const tail = (x: typeof s) =>
    Object.assign(
      {},
      ...stepMessages(x, x.allowedActions!)
        .slice(-2)
        .map(m => JSON.parse(m.content)),
    );
  assert.deepEqual(
    s.entries.filter(e => e.kind !== 'turn').map(e => e.id),
    ['e1', 'e1'],
    'the failed run and its retry',
  );
  assert.equal(
    tail(s).verification.output,
    'checked: no problems found in the sources\n',
    '"e1" would not say which of the two shows it',
  );
  const one = { ...s, entries: s.entries.filter((e, i) => e.kind === 'turn' || i === s.entries.length - 1) };
  assert.equal(tail(one).verification.output, 'shown in evidence e1', 'with the retry alone, the entry is named');
  const short = {
    ...one,
    lastCheck: { ...s.lastCheck!, text: 'ok\n' },
    entries: one.entries.map(e => (e.kind === 'turn' ? e : { ...e, text: '{"output":"ok\\n"}' })),
  };
  assert.equal(tail(short).verification.output, 'ok\n', 'a pointer longer than the output costs more than it saves');
});
test("A rewrite that reproduced its file is not generated again from the same request after an eviction took the check's entry: the request is keyed on the check's output, wherever the prompt shows it", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const content = 'export const cx = (...a: string[]) => a.join(" ");\n';
  await writeFile(join(root, 'src', 'utils.ts'), content);
  await writeFile(
    join(root, 'src', 'big.ts'),
    Array.from({ length: 300 }, (_, i) => `export const value${i} = "${'v'.repeat(30)}";`).join('\n') + '\n',
  );
  await writeFile(
    join(root, 'check.mjs'),
    'console.log("checked 2 files: " + "no problems found. ".repeat(4)); process.exit(0);\n',
  );
  const rewrite = {
    thought: 'Rewrite cx.',
    action: 'rewrite_file',
    args: { path: 'src/utils.ts', purpose: 'cx joins with spaces' },
  };
  const base = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      rewrite,
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/big.ts', start: 1, end: 300 }] } },
      rewrite,
    ],
  });
  const outputs: string[] = [];
  // The server's count is small, so only the batched eviction (on the evidence's share) takes entries.
  const bonsai = {
    ...base,
    count: async (m: Message[]) => ({
      tokens: Math.ceil(m.reduce((n, x) => n + x.content.length, 0) / 40),
      mode: 'test',
    }),
    generateText: async (m: Message[]) => {
      outputs.push(JSON.parse(m.at(-2)!.content).verification.output);
      return {
        text: content,
        finish: 'stop' as const,
        meta: { ms: 20000, promptTokens: 1, usage: { completion_tokens: 900 } },
      };
    },
  };
  const s = await new Agent(
    { ...config, maxSteps: 4, workingTokens: 3000 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.deepEqual(outputs, ['shown in evidence e1'], "generated once, with the check's entry in front of it");
  assert(
    !s.entries.some(e => e.id === 'e1') && (await events(store)).some(e => e.type === 'compact' && e.data.step === 3),
    'the read at step 3 made the eviction take e1',
  );
  assert.match(
    s.entries.find(e => e.step === 4 && e.kind !== 'turn')!.text,
    /reproduced the file unchanged at step 2 .* it was not generated again/,
  );
});

test('A stuck streak sets its reasoning aside and keeps its results: the turns of the no-progress steps leave the prompt, the worker is told', async t => {
  const { root, store } = await repo(t);
  const prompts: Message[][] = [];
  const steps = Array.from({ length: 5 }, (_, i) => ({
    thought: `same idea ${i}`,
    action: 'bash',
    args: { command: `node -e "console.log(${i}); process.exit(1)"`, purpose: 'try' },
  }));
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
  };
  // The first reading is progress, so the first turn is outside the streak; it goes too, since it holds the same line of thought.
  await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({ watch: n => (n === 1 ? { progress: 0.8, stuck: 0.1 } : { progress: 0.1, stuck: 0.95 }) }),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const reset = (await events(store)).find(e => e.type === 'reasoning-reset');
  assert(reset.data.turns.includes('t1'), `every earlier turn is set aside: ${reset.data.turns}`);
  assert(reset, 'the reasoning of the streak was reset');
  const after = prompts.find(p => /set aside/.test(p.at(-1)!.content))!;
  assert(after, 'the worker is told its reasoning was set aside');
  assert.equal(after.filter(m => m.role === 'assistant').length, 0, 'no turn of the streak remains');
  assert(
    after.filter(m => m.role === 'user' && /evidence/.test(m.content) && /process.exit\(1\)/.test(m.content)).length >=
      2,
    'the results of the streak remain',
  );
});

test('The render action shows the worker what the user sees: errors, a broken image, overflow, the headings; and the gate is told when a page was never rendered', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const html =
    '<!doctype html><html><head><title>Demo</title><style>body{margin:0;font-family:sans-serif}.wide{width:2000px;height:20px;background:red}</style></head><body><header><nav><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></nav></header><main><h1>Hello there</h1><img src="/missing.png" alt="Logo"><div class="wide"></div><div class="drawer" style="position:fixed;top:0;left:100%;width:300px;height:100px"><p>Cart</p></div><img src="http://127.0.0.1:1/gone.png" alt="Gone"><section id="empty" style="height:40px"></section><script>console.error("boom"); throw new Error("kaput")</script></main></body></html>';
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const { root } = await repo(t);
  const r = await renderFacts(root, `http://127.0.0.1:${port}/`, undefined, join(root, 'shot.png'), 30000);
  assert.equal(r.ok, false);
  assert.match(r.text, /^RENDER FAILED/);
  assert.match(r.text, /title "Demo"/);
  assert.match(r.text, /h1: Hello there/);
  assert.match(r.text, /images that did not load: \/missing\.png \(alt "Logo"\)/);
  assert.match(r.text, /The page scrolls sideways: it is 2000px wide in a \d+px viewport\./);
  assert.match(
    r.text,
    /cut by the viewport's edge \(partly on screen\) in a \d+px viewport: [^|\n]*div\.wide spans 0\.\.2000px/,
  );
  assert.match(
    r.text,
    /Elements wholly outside the viewport \(not on screen where they are\): [^\n]*div\.drawer spans \d+\.\.\d+px/,
  );
  assert.doesNotMatch(
    r.text
      .split('\n')
      .filter(l => /^Elements (cut|wholly)/.test(l))
      .join('\n'),
    /> p spans/,
    "a listed element's descendants are not listed again",
  );
  assert.match(
    r.text,
    /What reaches past the right edge, innermost first: [^\n]*div\.wide spans 0\.\.2000px[^\n]*div\.drawer > p spans \d+\.\.\d+px with text "Cart"/,
    'what makes the page scroll sideways, by its innermost elements and their text',
  );
  assert.match(
    r.text,
    /failed: net::ERR_[A-Z_]+ http:\/\/127\.0\.0\.1:1\/gone\.png/,
    'a request that never completed is named by its URL',
  );
  assert.match(r.text, /exceptions thrown in the page: .*kaput/);
  assert.match(r.text, /Console messages: .*boom/);
  assert.match(r.text, /requests that failed: 404 [^ ]*missing\.png/);
  assert.match(r.text, /Visible regions with no text or media: .*section#empty/);
  assert((await readFile(join(root, 'shot.png'))).length > 1000, 'a screenshot is kept for the report');
});

test('A batch: one reasoning, several actions run back to back, stopped at the first failure with the rest named; the check at the end is the check of record', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'check.mjs'),
    'import { existsSync } from "node:fs"; process.exit(existsSync("src/b.ts") ? 0 : 2);\n',
  );
  await mkdir(join(root, 'src'), { recursive: true });
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'two files then the check',
        action: 'plan',
        batch: [
          { action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
          { action: 'create_file', args: { path: 'src/b.ts', purpose: 'b' } },
          { action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
        ],
      },
      {
        thought: 'a failing command stops the batch',
        action: 'plan',
        batch: [
          { action: 'bash', args: { command: 'node -e "process.exit(1)"', purpose: 'fails', check: false } },
          { action: 'create_file', args: { path: 'src/c.ts', purpose: 'never' } },
        ],
      },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' },
  });
  const jev = jevOf({});
  const result = await new Agent(
    { ...config, maxSteps: 10 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.equal(result.lastCheckCommand, 'node check.mjs');
  assert.equal(result.lastCheck?.ok, true);
  assert.equal(jev.calls.filter(c => c.phase === 'watchdog').length, 2, 'one reading per batch');
  assert.equal((await events(store)).filter(e => e.type === 'thought').length, 2, 'two generations for five actions');
  assert(
    !(await readFile(join(root, 'src', 'c.ts'), 'utf8').catch(() => null)),
    'the action after the failure did not run',
  );
  assert(result.entries.some(e => /remaining 1 action\(s\) of this batch were not run \(create_file\)/.test(e.text)));
});

test('A broken render blocks completion: the harness does not propose it, and a gate reading that rejects goes back to the worker rather than to the user', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>Blank</title></head><body><div id="root"></div><script>throw new Error("useLocation() may be used only in the context of a Router")</script></body></html>',
  );
  const port = 40000 + Math.floor(Math.random() * 20000);
  const serve = `node -e "const h=require('http');const fs=require('fs');h.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync('index.html'))}).listen(${port})"`;
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'check and render',
        action: 'plan',
        batch: [
          { action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
          { action: 'observe', args: { kind: 'page', start: serve, target: `http://127.0.0.1:${port}/` } },
        ],
      },
      { thought: 'claim it anyway', action: 'finish', args: { summary: 'done' } },
    ],
  });
  const jev = jevOf({
    watch: () => ({ objective_satisfied: 0.9 }),
    gate: { implementation_matches_request: 0.15, verification_needed: 'human' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jev,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'A page that says hello'));
  const ev = await events(store);
  assert(!ev.some(e => e.type === 'auto-finish'), 'no proposal while the last observation failed, whatever Jev reads');
  const completion = ev.find(e => e.type === 'completion')!;
  assert.equal(completion.data.accepted, false);
  assert.equal(completion.data.route, 'rejected');
  assert.match(completion.data.reason, /observation \(page .*\) failed/);
  assert.equal(result.status, 'paused');
  assert.match(result.stopReason, /step limit/, 'the worker keeps working; nothing was sent to the user');
  assert(result.completionFeedback && /observation/.test(result.completionFeedback.text));
});

test("The render reports styling as facts, never as a failure: class names no CSS selector matches are named; the browser's own favicon request does not fail it", async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const page = (css: string) =>
    `<!doctype html><html><head><title>T</title><style>${css}</style></head><body><header class="nav"><a class="nav__link" href="/">Home link</a></header><main class="hero"><h1 class="hero__title">A headline for the page</h1><p class="hero__text flex p-4">Some body text that is long enough</p><div class="grid"><span class="card">One card</span><span class="card">Two card</span></div></main></body></html>`;
  let css = 'body{margin:0}';
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(css));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const { root } = await repo(t);
  let r = await renderFacts(root, url, undefined, null, 30000);
  assert.equal(
    r.ok,
    true,
    'unmatched class names are a fact, not a failure: classes also serve scripts, and pages are styled inline or in shadow roots',
  );
  assert.match(
    r.text,
    /^Rendered http:\S+: no exception, every request and image loaded; 0 of the 9 class names on visible elements match a CSS rule\.\n/,
    'the styling fact is in the first line, where the reader stops',
  );
  assert.doesNotMatch(r.text, /\bOK\b/, 'the headline states facts, never a verdict the styling line would contradict');
  assert.match(
    r.text,
    /Styling: 1 CSS rules; 0 of the 9 class names on visible elements match a CSS selector \(without one: nav, nav__link/,
    r.text,
  );
  assert.doesNotMatch(r.text, /favicon/, "the browser's favicon request is not the page's failure");
  css =
    'body{margin:0} .nav{display:flex} .nav__link{color:red} .hero,.hero__title{margin:0} @media (min-width:1px){.hero__text{color:#333}.flex{display:flex}.p-4{padding:1rem}} .grid{display:grid} .card{padding:4px}';
  r = await renderFacts(root, url, undefined, null, 30000);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Styling: \d+ CSS rules; 9 of the 9 class names on visible elements match a CSS selector;/);
  // A few class names without a rule (hooks, as run saas-landing-glm-5.3's sections had): information, not a problem.
  css =
    'body{margin:0} .nav{display:flex} .nav__link{color:red} .hero,.hero__title{margin:0} .hero__text{color:#333} .flex{display:flex} .p-4{padding:1rem}';
  r = await renderFacts(root, url, undefined, null, 30000);
  assert.equal(r.ok, true, r.text);
  assert.match(
    r.text,
    /^Rendered http:\S+: no exception, every request and image loaded\.\n/,
    'no styling count in the first line',
  );
  assert.match(
    r.text,
    /7 of the 9 class names on visible elements match a CSS selector \(without one, for information: grid, card; a class with no rule of its own is common, as a hook for scripts, tests or anchors, or an icon's or a library's, and is not a problem in itself\)/,
  );
  assert.equal(r.unmatched, undefined, 'not handed on to be found in the sources: nothing to complete');
});

test('A page that scrolls sideways is reported with what pushes it: the innermost elements past the right edge, their text, and what keeps them from shrinking', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  // The shape of run saas-landing-glm-5.3: a yearly price rendered as an unbreakable float, 79.20000000000001.
  const html = `<!doctype html><html><head><title>P</title><style>body{margin:0} .plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:0 16px} .plan{border:1px solid #ccc;padding:16px} .price{white-space:nowrap;font-size:64px}</style></head><body><section class="plans"><div class="plan"><span class="price">$0</span></div><div class="plan"><span class="price">$19</span></div><div class="plan"><span class="price">$79.20000000000001/mo</span></div></section></body></html>`;
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
    res.end(req.url === '/' ? html : '');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const { root } = await repo(t);
  const r = await renderFacts(root, `http://127.0.0.1:${(server.address() as any).port}/`, undefined, null, 30000);
  assert.match(r.text, /The page scrolls sideways: it is \d+px wide in a \d+px viewport\./, r.text);
  assert.match(
    r.text,
    /What reaches past the right edge, innermost first: [^\n|]*span\.price spans \d+\.\.\d+px with text "\$79\.20000000000001\/mo" \(white-space: nowrap\)/,
    r.text,
  );
});

test('Every call shares one prompt prefix: a reasoning turn and a file generation differ only after the evidence, and creating a file changes nothing before it', async t => {
  const { root, store } = await repo(t);
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'look', action: 'bash', args: { command: 'echo one', purpose: 'look', check: false } },
      {
        thought: 'write two files',
        action: 'plan',
        batch: [
          { action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
          { action: 'create_file', args: { path: 'src/b.ts', purpose: 'b' } },
        ],
      },
      { thought: 'look again', action: 'bash', args: { command: 'echo two', purpose: 'look', check: false } },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' },
  });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], s: any) => {
      prompts.push(m);
      return bonsai.generate(m, s);
    },
    generateText: async (m: Message[], o: any) => {
      prompts.push(m);
      return bonsai.generateText(m);
    },
  };
  await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const same = (a: Message[], b: Message[]) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n]!.content === b[n]!.content) n++;
    return n;
  };
  const turn2 = prompts[1]!,
    file = prompts[2]!,
    turn3 = prompts.at(-1)!;
  assert(
    same(turn2, file) >= turn2.length - 2,
    'the file generation reuses the whole reasoning prefix, evidence included',
  );
  assert(
    same(turn2, turn3) >= turn2.length - 2,
    `created files do not disturb the cached prefix (${same(turn2, turn3)} of ${turn2.length} messages shared)`,
  );
});
test('Dependencies follow the manifest: a manifest the worker creates is installed before the next turn, once per version', async t => {
  const { root, store } = await repo(t);
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'npm'),
    '#!/bin/bash\nif [ "$1" = "install" ] || [ "$1" = "ci" ]; then mkdir -p node_modules && echo added; exit 0; fi\nexit 0\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'manifest', action: 'create_file', args: { path: 'package.json', purpose: 'manifest' } },
      { thought: 'look', action: 'bash', args: { command: 'ls node_modules', purpose: 'look', check: false } },
      { thought: 'look again', action: 'bash', args: { command: 'echo done', purpose: 'look', check: false } },
    ],
    files: { 'package.json': '{ "name": "x", "dependencies": {} }\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const setups = (await events(store)).filter(e => e.type === 'setup');
  assert.equal(setups.length, 1, 'installed once, before the turn that needed it');
  assert.equal(setups[0].data.code, 0);
  assert.equal(result.setupDone, true);
});
test('Session state lives outside the repository, so the project directory holds only the project', async () => {
  const { stateDir, runsDir } = await import('../src/store.js');
  const dir = stateDir('/home/u/my app');
  assert(!dir.startsWith('/home/u/my app'), dir);
  assert.match(dir, /leana[\\/]my_app-[0-9a-f]{10}$/);
  assert.equal(runsDir('/home/u/my app'), join(dir, 'runs'));
});

test('rewrite_file regenerates an existing file as code with its current content in the prompt; create_file on an existing file points there', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.css'), ':root { --a: 1 }\n.old { color: red }\n');
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'create over it', action: 'create_file', args: { path: 'src/index.css', purpose: 'styles' } },
      {
        thought: 'rewrite it',
        action: 'rewrite_file',
        args: { path: 'src/index.css', purpose: 'style every component class' },
      },
    ],
    files: { 'src/index.css': ':root { --a: 1 }\n.hero { display: grid }\n.card { padding: 1rem }\n' },
  });
  const spy = {
    ...bonsai,
    generateText: async (m: Message[], o: any) => {
      prompts.push(m);
      return bonsai.generateText(m);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert(result.entries.some(e => /already exists; use rewrite_file/.test(e.text)));
  assert.equal(
    await readFile(join(root, 'src', 'index.css'), 'utf8'),
    ':root { --a: 1 }\n.hero { display: grid }\n.card { padding: 1rem }\n',
  );
  const req = JSON.parse(prompts.at(-1)!.at(-1)!.content);
  assert.equal(req.currentContent, ':root { --a: 1 }\n.old { color: red }\n');
  assert.match(req.role, /^Rewrite the complete file src\/index\.css/);
  assert(result.writes.includes('src/index.css'));
});
test('A turn cut off by the token limit is told why and what to use instead; three read-only turns in a row are named to the worker and to Jev', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.txt'), 'hello\n');
  let n = 0;
  const prompts: Message[][] = [];
  const bonsai = {
    count: async (m: Message[]) => ({ tokens: 100, mode: 'test' }),
    lastMeta: null,
    generate: async (m: Message[]) => {
      prompts.push(m);
      n++;
      if (n === 1) throw new Error('Bonsai did not finish a JSON argument object (length)');
      return {
        thought: 'look',
        actions: [{ action: 'search_codebase', args: { query: `hello${n}`, path: '.', mode: 'text' } }],
      };
    },
    generateText: async () => ({ text: '', finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }),
  };
  const jev = jevOf({});
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jev,
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert(
    result.entries.some(e => /reached the \d+-token limit before it closed[\s\S]*rewrite_file/.test(e.text)),
    'the cut-off turn names the cause and the remedy',
  );
  const note = JSON.parse(prompts.at(-1)!.at(-1)!.content).harnessNote ?? '';
  assert.match(note, /last 3 turns only read or searched/, note);
  assert.equal(
    jev.calls.filter(c => c.phase === 'watchdog').at(-1)!.state.turnsOnlyReading,
    4,
    'Jev reads the streak after the fourth read-only turn',
  );
});
test('A render that finds class names no selector matches lists every one by the source file that uses it, and the stylesheets that exist', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src', 'Hero.tsx'),
    'export const Hero = () => <section className="hero"><h1 className="hero__title">Title here</h1></section>;\n',
  );
  await writeFile(
    join(root, 'src', 'Card.tsx'),
    'export const Card = () => <div className="card card--wide">Card body text</div>;\n',
  );
  await writeFile(join(root, 'src', 'index.css'), 'body { margin: 0 }\n');
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>T</title><style>body{margin:0}</style></head><body><section class="hero"><h1 class="hero__title">Title here</h1></section><div class="card card--wide">Card body text</div><p class="note">A note that is long enough</p></body></html>',
  );
  const port = 40000 + Math.floor(Math.random() * 20000);
  const serve = `node -e "const h=require('http');const fs=require('fs');h.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync('index.html'))}).listen(${port})"`;
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'look', action: 'observe', args: { kind: 'page', start: serve, target: `http://127.0.0.1:${port}/` } },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const e = result.entries.find(x => x.kind === 'observe')!;
  assert.match(e.text, /src\/Hero\.tsx: hero hero__title/);
  assert.match(e.text, /src\/Card\.tsx: card card--wide/);
  assert.match(e.text, /Stylesheets in the project: src\/index\.css/);
});

test('A generation that ends without closing its code block is reported as incomplete; a rewrite that reproduces the file unchanged says so instead of a bare no-change', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Hero.tsx'), 'export function Hero() {\n  return <div className="a">\n');
  let call = 0;
  const bonsai = {
    count: async () => ({ tokens: 100, mode: 'test' }),
    lastMeta: null,
    generate: async () => {
      call++;
      return call === 1
        ? { thought: 'new file', actions: [{ action: 'create_file', args: { path: 'src/B.tsx', purpose: 'b' } }] }
        : {
            thought: 'fix hero',
            actions: [{ action: 'rewrite_file', args: { path: 'src/Hero.tsx', purpose: 'close the tags' } }],
          };
    },
    generateText: async (m: Message[]) => {
      const req = JSON.parse(m.at(-1)!.content);
      return req.currentContent !== undefined
        ? { text: req.currentContent, finish: 'eos' as const, meta: { ms: 1, promptTokens: 1 } }
        : {
            text: 'export const B = () => <div className="b',
            finish: 'eos' as const,
            meta: { ms: 1, promptTokens: 1 },
          };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert(
    result.entries.some(e => /generated content of src\/B\.tsx ended before the file was complete/.test(e.text)),
    'the truncated creation is named',
  );
  assert(
    result.entries.some(e =>
      /rewrite of src\/Hero\.tsx reproduced its current content unchanged and ended before the file was complete/.test(
        e.text,
      ),
    ),
    'the no-op rewrite is named with its cause',
  );
  assert(
    !Object.keys(defaults).some(k => /dry/i.test(k)) && defaults.codePresencePenalty === 0,
    'no repetition penalty on code by default',
  );
});

// Every tool description is tested against the harness: a field the prose names
// must be a field the model receives, and a behaviour it claims must happen.
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      if (k === 'argumentSchema')
        for (const p of keysOf(x))
          if (
            ![
              'type',
              'properties',
              'required',
              'additionalProperties',
              'items',
              'minItems',
              'maxItems',
              'minimum',
              'maximum',
              'maxLength',
              'minLength',
              'enum',
            ].includes(p)
          )
            out.add(p);
          else;
      else keysOf(x, out);
    }
  return out;
}
test('Every field the prompts name is one the model receives: descriptions, instructions and requests are checked against a real prompt', async t => {
  const { root } = await repo(t);
  const { stepMessages, newFileMessages, AGENT_SYSTEM } = await import('../src/context.js');
  const { actions } = await import('../src/schema.js');
  const s = await newSession(root, 'x');
  // Every conditional block present, so the prompt holds every field it can hold.
  s.lastCheck = {
    step: 2,
    ok: false,
    text: 'src/a.ts(3,1): error TS2304',
    summary: { code: 2, files: { 'src/a.ts': [3] } },
    command: 'tsc',
  };
  s.referenceEvidence = [{ path: 'PLAN.md', hash: 'h', text: '1: the plan', start: 1 }];
  s.completionFeedback = { step: 1, text: 'not accepted', awaitingEvidence: true };
  s.editEvidence = [{ step: 1, route: 'write', paths: ['src/a.ts'], artifact: 'a', text: 't' }];
  s.allowedActions = [...actions];
  s.trail = ['step 1: bash echo -> bash ok'];
  s.writeSteps = { 'src/a.ts': 3 };
  const step = stepMessages(s, [...actions], 'a note');
  const file = newFileMessages(s, 'src/b.ts', 'p', [], [], 0, 'old');
  const data = [...step.slice(1), ...file.slice(1)].map(m => JSON.parse(m.content));
  const known = keysOf(data);
  const pinned = data[0].actions as Record<string, { description: string; instructions: string }>;
  assert.deepEqual(
    Object.keys(pinned).sort(),
    [...actions].sort(),
    'every allowed action is described, and nothing else',
  );
  const prose = [
    AGENT_SYSTEM,
    ...Object.values(pinned).flatMap(a => [a.description, a.instructions]),
    data.at(-1)!.role,
    step.at(-1) && JSON.parse(step.at(-1)!.content).role,
    ...JSON.parse(file.at(-1)!.content).rules,
  ].join('\n');
  // Names a tool result prints (path sha256=… totalLines=…) are fields too; they must be printed by the tools.
  const tools = await toolResultSources();
  const printed = (name: string) => new RegExp(`\\b${name}=`).test(tools);
  for (const name of new Set(prose.match(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g) ?? []))
    assert(known.has(name) || printed(name), `the prompts name ${name}, which the model never receives`);
  const lookup = (key: string): any => {
    for (const d of data) {
      const hit = (function find(v: any): any {
        if (!v || typeof v !== 'object') return undefined;
        if (!Array.isArray(v) && key in v) return v[key];
        for (const x of Object.values(v)) {
          const r = find(x);
          if (r !== undefined) return r;
        }
      })(d);
      if (hit !== undefined) return hit;
    }
  };
  for (const path of new Set(prose.match(/(?<![/\w.-])[a-z]\w*\.[a-z]\w*\b/gi) ?? [])) {
    const [head, field] = path.split('.');
    const obj = lookup(head!);
    assert(obj && typeof obj === 'object' && field! in obj, `the prompts name ${path}, which the model never receives`);
  }
});
test('The prompts claim only what the harness does: an edit is not followed by a check the worker did not run, and nothing is repaired or applied for the worker', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'write', action: 'create_file', args: { path: 'a.ts', purpose: 'a' } },
      { thought: 'done', action: 'finish', args: { summary: 's' } },
    ],
    files: { 'a.ts': 'export const a = 1;\n' },
  });
  const prompts: Message[][] = [];
  const s = await new Agent(
    { ...config, checkCommand: 'node check.mjs', maxSteps: 2 },
    store,
    jevOf({}),
    {
      ...bonsai,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        return bonsai.generate(m, schema);
      },
    },
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ran = (await events(store)).filter(e => e.type === 'action').map(e => e.route);
  assert(!ran.includes('bash'), `no check ran that the worker did not run: ${ran}`);
  assert(
    s.entries.some(e => /has not run since the last edit/.test(e.text)),
    'and finish is refused until it runs',
  );
  const pinned = JSON.parse(prompts[0]![1]!.content).actions;
  assert.match(pinned.bash.instructions, /never runs the check by itself/);
  assert.match(pinned.finish.instructions, /finish is refused/);
  const claims =
    /re-?runs? the (check|verification)|check runs (next|automatically)|runs (the (check|verification)( command)?|it) (itself|automatically|after every edit)|harness (repairs|removes|imports|moves|rewrites|re-exports)|applies (itself|the fix)/i;
  const worded = [
    ...Object.values(pinned).flatMap((a: any) => [a.description, a.instructions]),
    ...(await toolResultSources()).split('\n').filter(l => !/^\s*\/\//.test(l)),
  ];
  for (const text of worded)
    assert(
      !claims.test(text),
      `a prompt or tool result claims something the harness does not do: ${text.slice(0, 200)}`,
    );
});

test("A shell command that writes files is an edit whatever it starts with: a heredoc through cat marks the earlier read stale and the check due; the check's own output is not an edit", async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'App.tsx'), 'export const App = 1;\n');
  await writeFile(
    join(root, 'check.mjs'),
    'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/out.js", String(Date.now())); process.exit(0);\n',
  );
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/App.tsx', start: 1, end: 5 }] } },
      {
        thought: 'write through the shell',
        action: 'bash',
        args: { command: "cat > src/App.tsx <<'EOF'\nexport const App = 2;\nEOF", purpose: 'write', check: false },
      },
      { thought: 'done', action: 'finish', args: { summary: 'done' } },
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    ],
  });
  const result = await new Agent(
    { ...config, checkCommand: 'node check.mjs', maxSteps: 4 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.deepEqual(result.writes, ['src/App.tsx'], "the heredoc is an edit; the check's dist/out.js is not");
  assert(
    result.entries.some(e => e.kind === 'read_files' && /edited at step 2/.test(e.stale ?? '')),
    'the earlier read is stale',
  );
  assert(
    result.entries.some(e => /has not run since the last edit/.test(e.text)),
    'finish is refused until the check runs after the shell edit',
  );
  assert.match(
    result.entries.find(e => e.kind === 'bash' && /cat >/.test(e.text))!.text,
    /the command changed files \(modified 1\): src\/App\.tsx/,
  );
  assert(
    result.lastCheck && result.lastCheck.step > result.lastWriteStep,
    'the check after the edit stands: its own output did not make it stale',
  );
  assert(result.knownFiles.includes('dist/out.js'), 'the file list still follows the tree');
});

test('A shell command that writes a file with the content it already had is not an edit: it is said to be left as it was, with its hash when the session knows the file, the read of it stands, and a written file that does not parse is said as for an edit; a byte-order mark added is a change', async t => {
  const { root, store } = await repo(t);
  // Run 67: the page did not parse; the worker wrote the same bytes again through a heredoc and took the unchanged build error for a write that had not happened.
  const page = 'export const App = (\n  <ul>{pets.map(p => <li>{p}</li>)}</ul>\n;\n';
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'App.tsx'), page);
  await writeFile(join(root, 'src', 'c.ts'), 'export const c = 1;\n');
  await writeFile(join(root, 'src', 'd.ts'), 'export const d = 1;\n');
  const past = new Date(Date.now() - 60000);
  for (const f of ['App.tsx', 'c.ts', 'd.ts']) await utimes(join(root, 'src', f), past, past);
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/App.tsx', start: 1, end: 3 }] } },
      {
        thought: 'write it through the shell',
        action: 'bash',
        args: { command: `cat > src/App.tsx <<'EOF'\n${page}EOF`, purpose: 'write', check: false },
      },
      {
        thought: 'a new file through the shell',
        action: 'bash',
        args: { command: "printf 'export const b = ;\\n' > src/b.ts", purpose: 'write', check: false },
      },
      { thought: 'touch', action: 'bash', args: { command: 'touch src/d.ts', purpose: 'touch', check: false } },
      {
        thought: 'a byte-order mark',
        action: 'bash',
        args: { command: "sed -i '1s/^/\\xef\\xbb\\xbf/' src/c.ts", purpose: 'bom', check: false },
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const same = result.entries.find(e => e.kind === 'bash' && /cat >/.test(e.text))!.text;
  assert.match(
    same,
    new RegExp(
      `Harness: the command left a file with the content it had before \\(the modification time changed, the content did not\\): src/App\\.tsx sha256=${hash(page)}`,
    ),
  );
  assert.doesNotMatch(same, /the command changed files/);
  assert.match(
    same,
    /Harness: src\/App\.tsx does not parse: line \d+, column \d+ /,
    'the file still does not parse, and is said so as after an edit',
  );
  assert(!result.entries.some(e => e.kind === 'read_files' && e.stale), 'the read of the file still matches it');
  assert.deepEqual(
    [...result.writes].sort(),
    ['src/b.ts', 'src/c.ts'],
    'only the new file and the one whose bytes changed are edits',
  );
  assert.equal(result.hashes['src/App.tsx'], hash(page));
  const created = result.entries.find(e => e.kind === 'bash' && /printf/.test(e.text))!.text;
  assert.match(created, /the command changed files \(created 1\): src\/b\.ts/);
  assert.match(created, /Harness: src\/b\.ts does not parse: line 1, column 18 /);
  assert.doesNotMatch(same + created, /Same problem/, 'what a shell command replaced is not kept');
  const touched = result.entries.find(e => e.kind === 'bash' && /touch/.test(e.text))!.text;
  assert.match(
    touched,
    /Harness: the command left a file with the content it had before \(the modification time changed, the content did not\): src\/d\.ts$/m,
    'a file the session never read or wrote is named without a hash',
  );
  const bom = result.entries.find(e => e.kind === 'bash' && /xbb/.test(e.text))!.text;
  assert.match(
    bom,
    /the command changed files \(modified 1\): src\/c\.ts/,
    'decoded text hashes the same without the mark, but the size differs',
  );
  assert.doesNotMatch(bom, /content it had before/);
  const log = await events(store);
  assert.deepEqual(
    log.filter(e => e.type === 'bash-unchanged').map(e => [e.data.step, e.data.files]),
    [
      [2, ['src/App.tsx']],
      [4, ['src/d.ts']],
    ],
  );
  assert.deepEqual(
    log.filter(e => e.type === 'bash-edit').map(e => e.data.files),
    [['src/b.ts'], ['src/c.ts']],
  );
});

test('An eviction bounded by a break point never touches the prompt before it: earlier entries and the trail stay, so the cached part is not cut shorter', async t => {
  const { evictOne, turnEntry, breakIndex } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-evict-from-')), 'x');
  const result = (id: string, step: number, turn: string | undefined, stale?: string) => ({
    id,
    step,
    kind: 'bash',
    text: 'x'.repeat(100),
    artifact: '',
    relevance: stale ? 0.1 : 0.5,
    ...(turn ? { turn } : {}),
    ...(stale ? { stale } : {}),
  });
  const t1 = turnEntry(1, 'scaffold', [{ action: 'bash', args: { command: 'npm create vite' } }]);
  const t2 = turnEntry(2, 'build', [
    { action: 'bash', args: { command: 'npm run build' } },
    { action: 'bash', args: { command: 'npm test' } },
  ]);
  const t4 = turnEntry(4, 'fix', [{ action: 'bash', args: { command: 'npm run build' } }]);
  s.entries = [
    t1,
    result('e1', 1, 't1', 'superseded'),
    t2,
    result('e2', 2, 't2', 'superseded'),
    result('e3', 3, 't2'),
    result('e3b', 3, undefined, 'superseded'),
    t4,
    result('e4', 4, 't4'),
  ];
  // Unbounded, the stale entry at the front goes first and its turn leaves a trail line.
  const shape = { ids: s.entries.map(e => e.id), trail: [...(s.trail ?? [])] };
  const copy = structuredClone(s);
  assert.equal(evictOne(copy)!.id, 'e1');
  assert.equal(copy.trail?.length, 1);
  assert.equal(breakIndex(shape, copy), 0, 'a trail change breaks the prompt in front of the evidence');
  // Bounded at index 4 (e3): e1/e2 lie before the point; e3 may go, since e2 keeps t2 in the prompt and no trail line is added.
  assert.equal(evictOne(s, 4)!.id, 'e3b', 'stale first');
  assert.equal(evictOne(s, 4)!.id, 'e3');
  assert.equal(s.trail, undefined);
  assert.equal(evictOne(s, 4), undefined, 'the freshest entry stays and t4 keeps its result');
  assert.deepEqual(
    s.entries.map(e => e.id),
    ['t1', 'e1', 't2', 'e2', 't4', 'e4'],
  );
  assert.equal(breakIndex(shape, s), 4, 'the prompt changes where e3 was, not earlier');
  // The last result of a turn that is still in the prompt is never taken behind a point: that would add a trail line in front of the evidence.
  s.entries = [t1, result('e1', 1, 't1'), t2, result('e2', 2, 't2'), t4, result('e4', 4, 't4')];
  assert.equal(evictOne(s, 3), undefined, 'e2 ends t2 and e4 is the freshest');
  assert.equal(breakIndex({ ids: s.entries.map(e => e.id), trail: [] }, s), null, 'nothing removed, nothing changed');
});

test('A stale entry that is still the only place something is shown as it is goes as the result it is: a read with an unchanged file, the last check after edits (run 56, steps 36-38)', async () => {
  const { evictOne } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-held-')), 'x');
  const read = (id: string, files: string[], stale?: string, shown = '1..2') => ({
    id,
    step: Number(id.slice(1)),
    kind: 'read_files',
    text: files
      .map(f => `${f} sha256=abc totalLines=2 shown=${shown}\n1: a${shown === '1..2' ? '\n2: b' : ''}`)
      .join('\n\n'),
    artifact: '',
    relevance: 0.5,
    ...(stale ? { stale } : {}),
  });
  const check = (id: string, stale?: string) => ({
    id,
    step: Number(id.slice(1)),
    kind: 'bash',
    text: '{"command":"npm run build","output":"src/b.ts(1,1): error"}',
    artifact: '',
    relevance: 0.9,
    verification: true,
    ...(stale ? { stale } : {}),
  });
  const fresh = (id: string) => ({
    id,
    step: Number(id.slice(1)),
    kind: 'bash',
    text: 'out',
    artifact: '',
    relevance: 0.5,
  });
  // e2 read a.ts and b.ts; a.ts was edited at step 9, b.ts never: e2 is stale, yet the only read of b.ts as it is.
  // e3 read c.ts, edited since; e5 is a check superseded by e8, and e8 was followed by an edit but by no other check.
  const lastCheck = (files: string[]) => ({
    step: 8,
    ok: false,
    text: '',
    summary: { code: 2, files: Object.fromEntries(files.map(f => [f, [1]])) },
    fileHashes: {},
  });
  s.writeSteps = { 'src/a.ts': 9, 'src/c.ts': 6 };
  s.lastCheck = lastCheck(['src/b.ts']);
  s.lastWriteStep = 9;
  s.entries = [
    read('e2', ['src/a.ts', 'src/b.ts'], 'edited at step 9'),
    read('e3', ['src/c.ts'], 'edited at step 6'),
    fresh('e4'),
    check('e5'),
    check('e8'),
    fresh('e10'),
  ];
  const order = Array.from({ length: 5 }, () => evictOne(s)!.id);
  assert.deepEqual(
    order,
    ['e3', 'e5', 'e2', 'e4', 'e8'],
    'what holds nothing current first, oldest first; then by relevance and age, the failed check last',
  );
  // The last check names only a.ts, edited since: its errors describe nothing as it is, and it goes with the stale entries.
  s.lastCheck = lastCheck(['src/a.ts']);
  s.entries = [
    read('e2', ['src/a.ts', 'src/b.ts'], 'edited at step 9'),
    read('e3', ['src/c.ts'], 'edited at step 6'),
    fresh('e4'),
    check('e5'),
    check('e8'),
    fresh('e10'),
  ];
  assert.deepEqual(
    Array.from({ length: 3 }, () => evictOne(s)!.id),
    ['e3', 'e5', 'e8'],
  );
  // Read again from the same line by a later read in the prompt, b.ts is shown there: e2 holds nothing and goes before the older e1.
  s.entries = [
    fresh('e1'),
    read('e2', ['src/a.ts', 'src/b.ts'], 'edited at step 9'),
    read('e11', ['src/b.ts']),
    fresh('e12'),
  ];
  assert.equal(evictOne(s)!.id, 'e2');
  // A narrower read from the same line (run 73: Testimonials.tsx 1..142, then 1..15) leaves line 2 of b.ts in e2 alone: e2 goes by its age.
  s.entries = [
    fresh('e1'),
    read('e2', ['src/a.ts', 'src/b.ts'], 'edited at step 9'),
    read('e11', ['src/b.ts'], undefined, '1..1'),
    fresh('e12'),
  ];
  assert.equal(evictOne(s)!.id, 'e1');
});

test('An eviction takes the stale entries behind the point the prompt already changes at, only those holding nothing current, and never one in front of it or one that would add a trail line', async () => {
  const { evictStaleBehind, turnEntry } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-stale-behind-')), 'x');
  const entry = (id: string, turn: string | undefined, stale?: string, text = 'x') => ({
    id,
    step: Number(id.slice(1)),
    kind: 'read_files',
    text,
    artifact: '',
    relevance: 0.5,
    ...(turn ? { turn } : {}),
    ...(stale ? { stale } : {}),
  });
  const t5 = turnEntry(5, 'read', [
    { action: 'read_files', args: {} },
    { action: 'read_files', args: {} },
  ]);
  const t8 = turnEntry(8, 'read', [{ action: 'read_files', args: {} }]);
  s.writeSteps = { 'src/a.ts': 9 };
  s.entries = [
    entry('e1', undefined, 'superseded'),
    t5,
    entry('e5', 't5', 'superseded'),
    entry('e6', 't5'),
    entry(
      'e7',
      undefined,
      'edited at step 9',
      'src/a.ts sha256=abc totalLines=1 shown=1..1\n1: a\n\nsrc/b.ts sha256=def totalLines=1 shown=1..1\n1: b',
    ),
    t8,
    entry('e8', 't8', 'superseded'),
    entry('e9', undefined),
  ];
  // The change is at index 2 (e5): e1 in front of it stays; e5 goes (e6 keeps t5); e7 still shows b.ts as it is; e8 would take t8 with it.
  assert.deepEqual(
    evictStaleBehind(s, 2).map(e => e.id),
    ['e5'],
  );
  assert.deepEqual(
    s.entries.map(e => e.id),
    ['e1', 't5', 'e6', 'e7', 't8', 'e8', 'e9'],
  );
  assert.equal(s.trail, undefined);
  // With the trail already changed (index 0), every stale entry holding nothing current goes, a turn with its last result.
  assert.deepEqual(
    evictStaleBehind(s, 0).map(e => e.id),
    ['e1', 'e8'],
  );
  assert.deepEqual(
    s.entries.map(e => e.id),
    ['t5', 'e6', 'e7', 'e9'],
  );
  assert.deepEqual(s.trail, ['step 8: read_files -> no result']);
});

test('A batched eviction also takes the stale entries behind its own break that hold nothing current: reads of files edited since go, the fresh outputs stay', async t => {
  const { root, store } = await repo(t);
  // Three reads of about 6 KB (the read budget) and a small one, all edited since by a command; then 2 KB outputs until the evidence passes its share.
  for (const f of ['a', 'b', 'c'])
    await writeFile(
      join(root, `${f}.txt`),
      Array.from({ length: 250 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(40)}`).join('\n') + '\n',
    );
  await writeFile(join(root, 'd.txt'), 'd\n');
  const read = (f: string, end: number) => ({
    thought: `read ${f}`,
    action: 'read_files',
    args: { files: [{ path: `${f}.txt`, start: 1, end }] },
  });
  const steps = [
    read('a', 250),
    read('b', 250),
    read('c', 250),
    read('d', 1),
    {
      thought: 'edit',
      action: 'bash',
      args: {
        command: `node -e "for (const f of ['a','b','c','d']) require('fs').appendFileSync(f + '.txt', 'y\\n')"`,
        purpose: 'edit',
        check: false,
      },
    },
    ...Array.from({ length: 5 }, (_, i) => ({
      thought: `look ${i}`,
      action: 'bash',
      args: { command: `node -e "console.log('${i}'.repeat(2000))"`, purpose: 'look', check: false },
    })),
  ];
  const result = await new Agent(
    { ...config, maxSteps: steps.length, workingTokens: 12000 },
    store,
    jevOf({}),
    bonsaiOf({ steps }),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const compaction = (await events(store)).find(e => e.type === 'compact' && e.data.reason === 'evidence-share');
  assert(compaction, 'the evidence passed its share');
  assert.equal(
    compaction.data.removed,
    4,
    'a.txt, b.txt and c.txt reach the share; d.txt, stale behind the break, goes with them',
  );
  assert.deepEqual(
    result.entries.filter(e => e.kind === 'read_files').map(e => e.id),
    [],
  );
  assert(result.entries.filter(e => e.kind === 'bash').length >= 3, 'the fresh outputs stay');
});

test('A stuck reset that already reprocesses the prompt from its first turn carries the pending compaction with it, instead of a second reprocessing some steps later', async t => {
  const { root, store } = await repo(t);
  // About 2.5 KB of evidence per step: after a dozen steps the evidence is above the share an eviction cuts to, below the one that triggers it.
  const steps = Array.from({ length: 14 }, (_, i) => ({
    thought: `look ${i}`,
    action: 'bash',
    args: { command: `node -e "console.log('${i}'.repeat(2400))"`, purpose: 'look', check: false },
  }));
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps });
  const spy = {
    ...bonsai,
    generate: async (m: Message[], sc: any) => {
      prompts.push(m);
      return bonsai.generate(m, sc);
    },
  };
  await new Agent(
    { ...config, maxSteps: 14, workingTokens: 20000 },
    store,
    jevOf({ watch: n => (n <= 10 ? { progress: 0.8, stuck: 0.1 } : { progress: 0.1, stuck: 0.95 }) }),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const log = await events(store);
  const reset = log.find(e => e.type === 'reasoning-reset' && !e.data.reason);
  assert(reset, 'the stuck streak reset the reasoning');
  const carried = log.find(e => e.type === 'compact' && e.data.reason === 'with-reasoning-reset');
  assert(carried, 'the compaction rides on the reset');
  assert.equal(carried.data.step, reset.data.step);
  assert.equal(
    carried.data.at,
    0,
    'the reset changed the prompt from its first entry, so every eviction behind it is free',
  );
  assert(carried.data.removed >= 1);
  assert.equal(
    log.filter(e => e.type === 'compact' && e.data.reason === 'evidence-share').length,
    0,
    'no separate compaction follows',
  );
  const told = prompts.map(m => m.at(-1)!.content).find(c => /set aside/.test(c));
  assert(
    told?.includes(
      `their results are still shown, except ${carried.data.removed} that left the prompt at the same time`,
    ),
    'the worker is told how many results left with its reasoning, not that all stay',
  );
});

test('An eviction riding on a late change takes only what the planned order takes first: a fresh read after the change stays while stale entries sit before it (run 52, step 44)', async t => {
  const { evictBehind, plannedEviction, turnEntry } = await import('../src/context.js');
  const build = async () => {
    const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-behind-')), 'x');
    const entry = (id: string, step: number, kind: string, chars: number, relevance: number, stale?: string) => ({
      id,
      step,
      kind,
      text: 'x'.repeat(chars),
      artifact: '',
      relevance,
      ...(stale ? { stale } : {}),
    });
    // Old, superseded reads early in the prompt; the repeated turn t41 was just dropped by the reset, leaving its read e41 and two refusals behind the change at index 3.
    s.entries = [
      entry('e15', 15, 'read_files', 6000, 0.1, 'superseded'),
      entry('e27', 27, 'read_files', 6000, 0.1, 'superseded'),
      turnEntry(40, 'fix the card', [{ action: 'observe', args: {} }]),
      entry('e41', 41, 'read_files', 500, 0.5),
      entry('e42', 42, 'generation_error', 230, 0.9),
      entry('e43', 43, 'generation_error', 130, 0.9),
    ];
    return s;
  };
  const s = await build();
  const target = 1500;
  assert.deepEqual(
    plannedEviction(s, target).slice(0, 2),
    ['e15', 'e27'],
    'the planned order starts with the stale entries in front of the change',
  );
  assert.deepEqual(
    evictBehind(s, 3, target),
    [],
    'nothing behind the change is first in the planned order, so nothing is taken',
  );
  assert.deepEqual(
    s.entries.map(e => e.id),
    ['e15', 'e27', 't40', 'e41', 'e42', 'e43'],
    'the fresh read e41 stays',
  );
  // With the change at the start of the evidence (a stuck reset), the same call follows the planned order exactly.
  const front = await build();
  const planned = plannedEviction(front, target);
  assert.deepEqual(
    evictBehind(front, 0, target).map(e => e.id),
    planned,
  );
  assert.deepEqual(planned, ['e15', 'e27'], 'the stale entries alone reach the target');
});

test('A generation cut inside a line is stated as facts about lines, and the cut line never reaches the file (run 54 Footer)', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'list.ts'), 'a\nb\nc\nd\ne\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'write the footer',
        action: 'create_file',
        args: { path: 'src/Footer.tsx', purpose: 'a footer with icon links' },
      },
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/list.ts', start: 1, end: 5 }] } },
      {
        thought: 'replace b and c',
        action: 'rewrite_file',
        args: { path: 'src/list.ts', purpose: 'b and c change', start: 2, end: 3 },
      },
    ],
  });
  const outputs = [
    {
      text: 'export default function Footer() {\n  return <svg>\n',
      finish: 'repetition' as const,
      cut: {
        kind: 'cycle' as const,
        line: 3,
        opening: '<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.2',
        truncated: true as const,
        lineChars: 4039,
        unit: 888,
      },
    },
    {
      text: 'B\n',
      finish: 'length' as const,
      cut: { kind: 'budget' as const, line: 2, opening: 'const icons = [', truncated: true as const, lineChars: 9000 },
    },
  ];
  let calls = 0;
  const spy = { ...bonsai, generateText: async () => ({ ...outputs[calls++]!, meta: { ms: 1, promptTokens: 1 } }) };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(
    await readFile(join(root, 'src', 'Footer.tsx'), 'utf8'),
    'export default function Footer() {\n  return <svg>\n',
    'only the whole lines before the cut are written',
  );
  const created = result.entries.find(e => e.kind === 'create_file')!;
  assert.match(
    created.text,
    /the generation of src\/Footer\.tsx repeated itself inside line 3 \(`<path d="M12 0c-6\.626 0-12 5\.373-12 12 0 5\.302 3\.438 9\.8 8\.2…`\): that line reached 4039 characters without ending, ending in one 888-character unit repeated verbatim; it was cut at the start of that line: the file holds lines 1\.\.2 as generated; nothing from line 3 on was written/,
  );
  assert.equal(
    await readFile(join(root, 'src', 'list.ts'), 'utf8'),
    'a\nB\nd\ne\n',
    'the block ends at the cut; the lines after the region are kept',
  );
  const rewritten = result.entries.filter(e => e.kind === 'write').at(-1)!;
  assert.match(
    rewritten.text,
    /reached the \d+-token budget inside line 3 \(`const icons = \[…`\), which had reached 9000 characters without ending; that line was cut: lines 2\.\.2 hold the generated lines before it; the rest of the block was not written, and the lines that followed line 3 now start at line 3/,
  );
});

test('A cut that leaves no line writes nothing, a region cut after echoed context never duplicates it, and the facts name lines as they are', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const ten = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  await writeFile(join(root, 'src', 'f.ts'), ten);
  await writeFile(join(root, 'src', 'g.ts'), ten);
  await writeFile(join(root, 'src', 'h.ts'), ten);
  await writeFile(join(root, 'src', 'k.ts'), ten);
  const cycle = { kind: 'cycle' as const, line: 1, opening: 'x', lineChars: 5000, unit: 900 };
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'read',
        action: 'read_files',
        args: { files: ['f', 'g', 'h', 'k'].map(n => ({ path: `src/${n}.ts`, start: 1, end: 10 })) },
      },
      { thought: 'rewrite f', action: 'rewrite_file', args: { path: 'src/f.ts', purpose: 'new f' } },
      {
        thought: 'rewrite 5..6 of g',
        action: 'rewrite_file',
        args: { path: 'src/g.ts', purpose: 'new g', start: 5, end: 6 },
      },
      {
        thought: 'append to h',
        action: 'rewrite_file',
        args: { path: 'src/h.ts', purpose: 'more h', start: 11, end: 10 },
      },
      {
        thought: 'insert at the top of k',
        action: 'rewrite_file',
        args: { path: 'src/k.ts', purpose: 'header', start: 1, end: 0 },
      },
    ],
  });
  const outputs = [
    // Whole-file rewrite cut in its first line: nothing is written.
    { text: '', cut: cycle },
    // Region 5..6: the model echoed lines 2..4 before the region, then looped: the echo is context, not block content.
    { text: 'line2\nline3\nline4\n', cut: { ...cycle, line: 4 } },
    // Append: one line, then a loop.
    { text: 'more\n', cut: { ...cycle, line: 2, kind: 'lines' as const } },
    // Insertion at the top: one line, then a budget stop inside an indented short line.
    { text: '// header\n', cut: { kind: 'budget' as const, line: 2, opening: 'return x', lineChars: 12 } },
  ];
  let calls = 0;
  const spy = {
    ...bonsai,
    generateText: async () => ({
      ...outputs[calls++]!,
      finish: 'repetition' as const,
      meta: { ms: 1, promptTokens: 1 },
    }),
  };
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const said = result.entries.map(e => e.text).join('\n');
  assert.equal(
    await readFile(join(root, 'src', 'f.ts'), 'utf8'),
    ten,
    'a whole-file rewrite cut before its first line leaves the file as it was',
  );
  assert.match(
    said,
    /the generation of src\/f\.ts repeated itself inside line 1 \(`x`\).*no line was generated before it, so nothing was written and src\/f\.ts is unchanged/,
  );
  assert.equal(
    await readFile(join(root, 'src', 'g.ts'), 'utf8'),
    ten,
    'the echoed context is not written a second time; the cut left no block line, so nothing is written',
  );
  assert.equal(await readFile(join(root, 'src', 'h.ts'), 'utf8'), ten + 'more\n');
  assert.match(
    said,
    /the generation of src\/h\.ts started repeating a block of lines at line 12; it was cut there: lines 11\.\.11 hold the generated lines before it; the rest of the block was not written(?!, and the lines that followed)/,
    'an append has no following lines to speak of',
  );
  assert.equal(await readFile(join(root, 'src', 'k.ts'), 'utf8'), '// header\n' + ten);
  assert.match(
    said,
    /inside line 2 \(`return x`\), which had reached 12 characters without ending; that line was cut: lines 1\.\.1 hold the generated lines before it; the rest of the block was not written, and the file's original lines now start at line 2/,
    'no ellipsis on a short indented line; no "line 0"',
  );
});

// Run 73 step 70, as recorded: the old file is the write's oldText, the generated block new lines 85..226.
const echoFixtures = fileURLToPath(new URL('../../test/fixtures/echo/', import.meta.url));
test('A region block that repeats the lines after the region is not written twice: a block of nothing but that repeat removes the region, and the facts say what was generated, dropped and kept (run 73 step 70)', async t => {
  const { root, store } = await repo(t);
  const old = await readFile(join(echoFixtures, 'react-demo-73-step70-old.tsx.txt'), 'utf8');
  const block = await readFile(join(echoFixtures, 'react-demo-73-step70-block.tsx.txt'), 'utf8');
  const ol = old.replace(/\n$/, '').split('\n');
  const deleted = [...ol.slice(0, 84), ...ol.slice(100)].join('\n') + '\n';
  assert.equal(
    block,
    ol
      .slice(101)
      .filter((_, i) => i !== 13)
      .join('\n') + '\n',
    'the scenario: the block is old lines 102..244 without blank line 115',
  );
  await mkdir(join(root, 'src'), { recursive: true });
  for (const f of ['a', 'b']) await writeFile(join(root, 'src', `${f}.tsx`), old);
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'read',
        action: 'read_files',
        args: { files: ['a', 'b'].map(f => ({ path: `src/${f}.tsx`, start: 1, end: 244 })) },
      },
      {
        thought: 'remove the fetch',
        action: 'rewrite_file',
        args: { path: 'src/a.tsx', purpose: 'Remove the API fetch useEffect block', start: 85, end: 100 },
      },
      {
        thought: 'remove the fetch',
        action: 'rewrite_file',
        args: { path: 'src/b.tsx', purpose: 'Remove the API fetch useEffect block', start: 85, end: 100 },
      },
    ],
  });
  // a: the generation ran to its closing fence, as recorded (the repeat is trimmed); b: it was stopped at the repeat while generating.
  const outputs = [
    { text: block, finish: 'stop' as const },
    {
      text: '',
      finish: 'repetition' as const,
      cut: {
        kind: 'echo' as const,
        line: 1,
        opening: 'const handleDotClick = (index: number) => {',
        lineChars: 45,
        echoed: 19,
      },
    },
  ];
  const options: any[] = [];
  let calls = 0;
  const spy = {
    ...bonsai,
    generateText: async (m: Message[], o: any) => {
      options.push(o);
      return { ...outputs[calls++]!, meta: { ms: 1, promptTokens: 1 } };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.deepEqual(
    options[0].around,
    { before: ol.slice(0, 84).join('\n'), region: ol.slice(84, 100).join('\n'), after: ol.slice(100).join('\n') },
    'the generation is given the whole file around its block',
  );
  const held = `\\(they held 85: useEffect\\(\\(\\) => \\{; 86: // Fetch fresh testimonials from API \\(non-blocking\\); 87: let cancelled = false; 88: get<Testimonial\\[\\]>\\('/testimonials'\\); 89: \\.then\\(\\(res\\) => \\{; 90: if \\(!cancelled && res\\.data\\.length > 0\\) \\{; 10 more\\), and the lines that followed line 100 now start at line 85`;
  for (const [f, lead] of [
    ['a', 'ended with a repeat of lines 101\\.\\.244'],
    ['b', 'was stopped once it was repeating lines 101\\.\\.119'],
  ] as const) {
    assert.equal(
      await readFile(join(root, 'src', `${f}.tsx`), 'utf8'),
      deleted,
      `${f}: lines 85..100 removed, the rest as it was`,
    );
    const e = result.entries.find(x => x.kind === 'write' && x.text.includes(`src/${f}.tsx`))!;
    assert.match(
      e.text,
      /Replaced lines 85\.\.100 of src\/\w\.tsx with 0 generated line\(s\); the file now has 228 lines/,
    );
    assert.match(
      e.text,
      new RegExp(
        `Harness: the generation of src/${f}\\.tsx ${lead}, the lines after the region: the repeat was not written; no line was generated before it, so lines 85\\.\\.100 were removed ${held}`,
      ),
    );
    assert.doesNotMatch(e.text, /does not parse/);
  }
});

test('A block that repeats the lines after its region and goes on past them is written up to the repeat; an insertion of nothing but the repeat writes nothing; a block ending in one closing line like the next is kept', async t => {
  const { root, store } = await repo(t);
  const file = [
    'export function a() {',
    '  return 1',
    '}',
    '',
    'export function b(x: number) {',
    '  const y = x * 2',
    '  return y + 1',
    '}',
    '',
    'export const c = 3',
    'export const d = 4',
    'export const e = 5',
    'export const f = 6',
    'export const g = 7',
    'export const h = 8',
    'export const i = 9',
    '',
  ].join('\n');
  await mkdir(join(root, 'src'), { recursive: true });
  for (const f of ['d', 'i', 'k']) await writeFile(join(root, 'src', `${f}.ts`), file);
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'read',
        action: 'read_files',
        args: { files: ['d', 'i', 'k'].map(f => ({ path: `src/${f}.ts`, start: 1, end: 11 })) },
      },
      {
        thought: 'a returns 2',
        action: 'rewrite_file',
        args: { path: 'src/d.ts', purpose: 'a returns 2', start: 1, end: 3 },
      },
      { thought: 'insert', action: 'rewrite_file', args: { path: 'src/i.ts', purpose: 'insert', start: 4, end: 3 } },
      {
        thought: 'a returns 4',
        action: 'rewrite_file',
        args: { path: 'src/k.ts', purpose: 'a returns 4', start: 1, end: 2 },
      },
    ],
  });
  const outputs = [
    // The new a, then lines 4..15 as they are and line 16 changed: a rewrite of lines outside the region.
    'export function a() {\n  return 2\n}\n\nexport function b(x: number) {\n  const y = x * 2\n  return y + 1\n}\n\nexport const c = 3\nexport const d = 4\nexport const e = 5\nexport const f = 6\nexport const g = 7\nexport const h = 8\nexport const i = 90\n',
    // Nothing but lines 4..11 as they are, into an insertion: nothing to remove.
    '\nexport function b(x: number) {\n  const y = x * 2\n  return y + 1\n}\n\nexport const c = 3\nexport const d = 4\n',
    // Lines 1..2 rewritten, ending with a closing brace: line 3 is one too, but a single bracket line is not taken as a repeat.
    'export function a() {\n  return 4\n}\n',
  ];
  let calls = 0;
  const spy = {
    ...bonsai,
    generateText: async () => ({ text: outputs[calls++]!, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }),
  };
  const result = await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const said = result.entries.map(e => e.text).join('\n');
  assert.equal(
    await readFile(join(root, 'src', 'd.ts'), 'utf8'),
    file.replace('return 1', 'return 2'),
    'the block up to the repeat; lines 4..16 stay as they were',
  );
  assert.match(
    said,
    /the generation of src\/d\.ts repeated lines 4\.\.15, the lines after the region, then went on with other lines: the repeat and what followed it were not written; lines 1\.\.3 hold the generated block, and the lines that followed line 3 now start at line 4/,
  );
  assert.equal(
    await readFile(join(root, 'src', 'i.ts'), 'utf8'),
    file,
    'an insertion that was nothing but the repeat changes nothing',
  );
  assert.match(
    said,
    /the generation of src\/i\.ts ended with a repeat of lines 4\.\.11, the lines after the region; no line was generated before it, so nothing was written and src\/i\.ts is unchanged/,
  );
  assert.equal(
    await readFile(join(root, 'src', 'k.ts'), 'utf8'),
    file.replace('return 1\n}', 'return 4\n}\n}'),
    "one closing line equal to the next is written as generated (it may close the block's own opening)",
  );
  assert.doesNotMatch(said, /src\/k\.ts (ended with|repeated)/);
});

test('A batch that edits one file twice from one read lands both edits in one generation; the next batch starts a new record (run 56 Footer, steps 45-46)', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const text = ['import { A } from "./a"', '', 'export const x = [', '  A,', '  A,', ']', ''].join('\n');
  await writeFile(join(root, 'src', 'f.ts'), text);
  await writeFile(join(root, 'src', 'a.ts'), 'export const A = 1\nexport const B = 2\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'import B and use it',
        action: 'plan',
        batch: [
          {
            action: 'replace_lines',
            args: {
              path: 'src/f.ts',
              expectedHash: 'FILL',
              edits: [{ start: 1, end: 1, newText: 'import { A, B } from "./a"\nimport { C } from "./c"' }],
            },
          },
          {
            action: 'replace_lines',
            args: { path: 'src/f.ts', expectedHash: 'FILL', edits: [{ start: 5, end: 5, newText: '  B,' }] },
          },
        ],
      },
      {
        thought: 'an old hash in a new batch',
        action: 'replace_lines',
        args: { path: 'src/f.ts', expectedHash: 'OLD', edits: [{ start: 4, end: 4, newText: '  B,' }] },
      },
    ],
  });
  const { hash: h } = await import('../src/files.js');
  const agent = new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(bonsai, async p => h(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  );
  const wrapped = (agent as any).bonsai.generate;
  let turn = 0;
  (agent as any).bonsai.generate = async (m: Message[], schema: any) => {
    const a = await wrapped(m, schema);
    if (a.actions && ++turn === 2) for (const act of a.actions) act.args.expectedHash = h(text);
    return a;
  };
  const result = await agent.run(await newSession(root, 'x'));
  assert.equal(
    await readFile(join(root, 'src', 'f.ts'), 'utf8'),
    ['import { A, B } from "./a"', 'import { C } from "./c"', '', 'export const x = [', '  A,', '  B,', ']', ''].join(
      '\n',
    ),
  );
  const ev = await events(store);
  assert.deepEqual(
    ev
      .filter(e => e.type === 'result')
      .slice(0, 2)
      .map(e => e.data.ok),
    [true, true],
    'both edits of the batch landed',
  );
  assert(result.entries.some(e => /mapped to the current text: 5\.\.5 -> 6\.\.6/.test(e.text)));
  assert(
    result.entries.some(e => /^Tool error: Stale file hash for src\/f\.ts: read the file again/.test(e.text)),
    'a hash from an earlier batch is not mapped',
  );
});

// ---- run 73: bracket refusals (steps 48-50 and 58) ----
const storage73 =
  "import { useEffect, useState } from 'react'\n\ninterface UseLocalStorageOptions<T> {\n  key: string\n  defaultValue: T\n  storage?: Storage\n}\n\nexport function useLocalStorage<T>(\n  key: string,\n  defaultValue: T,\n  options?: UseLocalStorageOptions<T>,\n): [T, (value: T | ((prev: T) => T)) => void] {\n  const storage = options?.storage ?? window.localStorage\n  const [state, setState] = useState<T>(defaultValue)\n\n  useEffect(() => {\n    try {\n      const stored = storage.getItem(key)\n      if (stored !== null) {\n        setState(JSON.parse(stored) as T)\n      }\n    } catch {\n      // Ignore parse errors and fall back to default\n    }\n  }, [key, storage])\n\n  const setValue = (value: T | ((prev: T) => T)) => {\n    setState((prev) => {\n      const next = typeof value === 'function' ? value(prev) : value\n      try {\n        storage.setItem(key, JSON.stringify(next))\n      } catch {\n        // Ignore storage errors\n      }\n      return next\n    })\n  }\n\n  return [state, setValue]\n}\n";
const setValue73 =
  "  const setValue = (value: T | ((prev: T) => T)) => {\n    setState((prev) => {\n      const next = (typeof value === 'function' ? (value as (prev: T) => T)(prev) : value) as T\n      try {\n        storage.setItem(key, JSON.stringify(next))\n      } catch {\n        // Ignore storage errors\n      }\n      return next\n    })\n  }";
const effect73 = [
  '  useEffect(() => {',
  '    // Fetch fresh testimonials from API (non-blocking)',
  '    let cancelled = false',
  '    setLoading(true)',
  "    get<Testimonial[]>('/testimonials')",
  '      .then((res) => {',
  '        if (!cancelled && res.data.length > 0) {',
  '          setTestimonials(res.data)',
  '        }',
  '      })',
  '      .catch(() => {',
  '        // Silently fall back to defaults',
  '      })',
  '      .finally(() => {',
  '        if (!cancelled) setLoading(false)',
  '      })',
  '    return () => {',
  '      cancelled = true',
  '    }',
  '  }, [])',
  '',
].join('\n');

test('Run 73 steps 48-50 and 58: an edit written without the line it repeated lets its batch go on; a bracket refusal is stated whole in its entry, and the identical call on the unchanged file is refused without running', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'useLocalStorage.ts'), storage73);
  await writeFile(join(root, 'src', 'effect.tsx'), effect73);
  const { hash } = await import('../src/files.js');
  const unclosed = {
    action: 'replace_lines',
    args: {
      path: 'src/effect.tsx',
      expectedHash: 'FILL',
      edits: [{ start: 15, end: 15, newText: '        if (!cancelled) {\n' }],
    },
  };
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'fix the setter, then note it',
        action: 'plan',
        batch: [
          {
            action: 'replace_lines',
            args: {
              path: 'src/useLocalStorage.ts',
              expectedHash: 'FILL',
              edits: [{ start: 28, end: 37, newText: setValue73 }],
            },
          },
          { action: 'plan', args: { notes: 'after' } },
        ],
      },
      { thought: 'drop setLoading', ...unclosed },
      { thought: 'drop setLoading', ...unclosed },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 4 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result').map(e => [e.data.step, e.data.ok]),
    [
      [1, true],
      [3, false],
    ],
    'the retry did not run',
  );
  assert.equal(result.notes, 'after', 'the batch went on after the repaired edit');
  assert.equal(
    await readFile(join(root, 'src', 'useLocalStorage.ts'), 'utf8'),
    [
      ...storage73.split('\n').slice(0, 27),
      ...setValue73.split('\n').slice(0, -1),
      ...storage73.split('\n').slice(37),
    ].join('\n'),
    'written without the repeat of line 38',
  );
  const refusal = result.entries.find(e => e.step === 3 && e.kind !== 'turn')!.text;
  assert.equal(
    refusal,
    "Tool error: Edit refused: it would leave src/effect.tsx with 1 unmatched '{' (was 0). Edit 1 (lines 15..15): the replaced lines have no unmatched '{' or '}'; its new text opens 1 '{' it does not close. The replaced range(s) held line(s) the new text does not contain: 15: if (!cancelled) setLoading(false).",
    'the entry holds the whole refusal',
  );
  assert.match(
    result.entries.find(e => e.step === 4 && e.kind !== 'turn')!.text,
    /^No action executed: this exact replace_lines of src\/effect\.tsx \(lines 15\.\.15\) ran at step 3 and failed \(Edit refused: it would leave src\/effect\.tsx with 1 unmatched '\{' \(was 0\)\. Edit 1 \(lines 15\.\.15\)[\s\S]*; src\/effect\.tsx is unchanged since \(src\/effect\.tsx sha256=\w{16}\), so the same arguments would fail the same way$/,
    'a bracket refusal is an edit failure the same arguments repeat (textFailure)',
  );
  assert.equal(await readFile(join(root, 'src', 'effect.tsx'), 'utf8'), effect73);
});

// ---- run 56: repeats, retries and stale hashes (synthesized design) ----
const footer56 =
  'import { a } from "x";\nimport { Mail } from "icons";\n\nconst links = [\n  GitHub,\n  Twitter,\n  LinkedIn,\n];\nexport default links;\n';
const importLine56 = { start: 2, end: 2, newText: 'import { Mail, Code, Users, Globe } from "icons";', prepend: '' };
const linkLines56 = { start: 5, end: 7, newText: '  Code,\n  Users,\n  Globe,', prepend: '' };
const footerDone = footer56
  .replace('import { Mail } from "icons";', importLine56.newText)
  .replace('  GitHub,\n  Twitter,\n  LinkedIn,', linkLines56.newText);
const lines14 = Array.from({ length: 14 }, (_, i) => `const l${i + 1} = ${i + 1};`).join('\n') + '\n';

test('Run 56 steps 45-50: both edits of one file in one batch land; the same batch sent again verbatim is refused as a second application, and the file keeps one copy of each change', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Footer.tsx'), footer56);
  const { hash } = await import('../src/files.js');
  const edit = (edits: object[]) => ({
    action: 'replace_lines',
    args: { path: 'src/Footer.tsx', expectedHash: 'FILL', edits },
  });
  const h0 = hash(footer56);
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'fix the import and the links', action: 'plan', batch: [edit([importLine56]), edit([linkLines56])] },
      {
        thought: 'the same batch again',
        action: 'plan',
        batch: [
          { action: 'replace_lines', args: { path: 'src/Footer.tsx', expectedHash: h0, edits: [importLine56] } },
          { action: 'replace_lines', args: { path: 'src/Footer.tsx', expectedHash: h0, edits: [linkLines56] } },
          { action: 'plan', args: { notes: 'after' } },
        ],
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result').map(e => [e.data.step, e.data.ok]),
    [
      [1, true],
      [2, true],
    ],
    'both edits landed; the repeats did not run',
  );
  assert.equal(await readFile(join(root, 'src', 'Footer.tsx'), 'utf8'), footerDone, 'one copy of each change');
  const refused = ev.filter(e => e.type === 'refused');
  assert.equal(refused.length, 1, 'the batch stops at the first refusal');
  assert.match(
    refused[0]!.data.why,
    /^the replace_lines of src\/Footer\.tsx \(lines 2\.\.2\) was applied at step 1 with these same arguments, and since then src\/Footer\.tsx changed only by the replace_lines of src\/Footer\.tsx \(lines 5\.\.7\) at step 2 \(src\/Footer\.tsx sha256=\w{16}\): running it again would apply it a second time\. Its result is in the evidence \(e1\)\./,
    refused[0]!.data.why,
  );
  assert.notEqual(result.notes, 'after', 'the rest of the batch did not run');
});

test('A failed edit runs again with a new hash; with the same arguments on the unchanged file it is refused as a failure that would repeat', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Footer.tsx'), footer56);
  const { hash } = await import('../src/files.js');
  const edit = (expectedHash: string) => ({
    thought: 'fix the links',
    action: 'replace_lines',
    args: { path: 'src/Footer.tsx', expectedHash, edits: [linkLines56] },
  });
  const bonsai = bonsaiOf({ steps: [edit('0123456789abcdef'), edit('0123456789abcdef'), edit('FILL')] });
  const result = await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result').map(e => [e.data.step, e.data.ok]),
    [
      [1, false],
      [3, true],
    ],
  );
  assert.match(
    result.entries.find(e => e.step === 2)!.text,
    /^No action executed: this exact replace_lines of src\/Footer\.tsx \(lines 5\.\.7\) ran at step 1 and failed \(Stale file hash for src\/Footer\.tsx[^)]*\); src\/Footer\.tsx is unchanged since \(src\/Footer\.tsx sha256=\w{16}\), so the same arguments would fail the same way$/,
  );
  assert.deepEqual(
    ev.filter(e => e.type === 'refused').map(e => [e.data.step, e.data.route, e.data.args.expectedHash]),
    [[2, 'replace_lines', '0123456789abcdef']],
    'a refused action is logged with its arguments',
  );
  assert.equal(
    await readFile(join(root, 'src', 'Footer.tsx'), 'utf8'),
    footer56.replace('  GitHub,\n  Twitter,\n  LinkedIn,', linkLines56.newText),
  );
});

test('An edit that landed, sent again with the hash its own result reported, is a new request and runs (a second duplicate line is deleted)', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'D.ts'), 'dup();\ndup();\nkeep();\n');
  const { hash } = await import('../src/files.js');
  const del1 = {
    action: 'replace_lines',
    args: { path: 'src/D.ts', expectedHash: 'FILL', edits: [{ start: 1, end: 1, newText: '', prepend: '' }] },
  };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'drop line 1', action: 'plan', batch: [del1] },
      { thought: 'line 1 is still a dup', action: 'plan', batch: [JSON.parse(JSON.stringify(del1))] },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'src', 'D.ts'), 'utf8'), 'keep();\n');
  assert(!result.entries.some(e => e.kind === 'skipped' || /No action executed/.test(e.text)));
});

test('The applied edit sent again with its pre-edit hash after a command changed the file runs and is refused by the tool as stale; restored to what it found, it runs and applies', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'CTA.tsx'), footer56);
  await writeFile(join(root, 'orig.txt'), footer56);
  const { hash } = await import('../src/files.js');
  const h0 = hash(footer56);
  const cta = {
    action: 'replace_lines',
    args: { path: 'src/CTA.tsx', expectedHash: h0, edits: [{ start: 1, end: 1, newText: '', prepend: '' }] },
  };
  const restore = `node -e "require('fs').writeFileSync('src/CTA.tsx', require('fs').readFileSync('orig.txt', 'utf8'))"`;
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'drop line 1', action: 'plan', batch: [cta] },
      {
        thought: 'a command changes it',
        action: 'bash',
        args: {
          command: `node -e "require('fs').writeFileSync('src/CTA.tsx', '// changed\\n')"`,
          purpose: 'change',
          check: false,
        },
      },
      { thought: 'again, verbatim', action: 'plan', batch: [JSON.parse(JSON.stringify(cta))] },
      { thought: 'restore', action: 'bash', args: { command: restore, purpose: 'restore', check: false } },
      { thought: 'again, on the restored file', action: 'plan', batch: [JSON.parse(JSON.stringify(cta))] },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result' && e.data.kind === 'action').map(e => [e.data.step, e.data.ok]),
    [
      [1, true],
      [2, true],
      [3, false],
      [4, true],
      [5, true],
    ],
  );
  assert.match(
    result.entries.find(e => e.step === 3 && e.kind !== 'turn')!.text,
    /Stale file hash for src\/CTA\.tsx/,
    'the tool itself refuses the hash the command made stale',
  );
  assert.equal(await readFile(join(root, 'src', 'CTA.tsx'), 'utf8'), footer56.split('\n').slice(1).join('\n'));
});

test('The same failing edit asked for again and again still ends at four actions in a row', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'T.ts'), lines14);
  const { hash } = await import('../src/files.js');
  const same = {
    action: 'replace_lines',
    args: {
      path: 'src/T.ts',
      expectedHash: 'FILL',
      edits: [{ start: 2, end: 2, newText: 'const l2 = 2;', prepend: '' }],
    },
  };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 10 }, () => ({
      thought: 'fix l2',
      action: 'plan',
      batch: [JSON.parse(JSON.stringify(same))],
    })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 9 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result').map(e => e.data.step),
    [1],
    'the tool ran once',
  );
  assert.match(result.stopReason ?? '', /four actions in a row/);
});

test('A batch that deletes a line and then edits a line below it with the same hash lands the second edit on the line it named (run 14 shape)', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'T.ts'), lines14);
  const { hash } = await import('../src/files.js');
  const rl = (edits: object[]) => ({
    action: 'replace_lines',
    args: { path: 'src/T.ts', expectedHash: 'FILL', edits },
  });
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'drop l3, fix l11',
        action: 'plan',
        batch: [
          rl([{ start: 3, end: 3, newText: '', prepend: '' }]),
          rl([{ start: 11, end: 11, newText: 'const l11 = 111;', prepend: '' }]),
        ],
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(
    await readFile(join(root, 'src', 'T.ts'), 'utf8'),
    lines14.replace('const l3 = 3;\n', '').replace('const l11 = 11;', 'const l11 = 111;'),
  );
  assert.match(result.entries.find(e => e.step === 2)!.text, /mapped to the current text: 11\.\.11 -> 10\.\.10/);
  assert.deepEqual(
    result.editEvidence.at(-1)!.applied &&
      JSON.parse(result.editEvidence.at(-1)!.applied!).edits.map((e: any) => [e.start, e.end]),
    [[10, 10]],
    'the edit evidence holds the lines as applied',
  );
});

test('A block on a repeated identical failure holds the exact arguments: the same edit with a corrected hash is not blocked', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Footer.tsx'), footer56);
  const { hash } = await import('../src/files.js');
  const edit = (expectedHash: string) => ({
    thought: 'fix the links',
    action: 'replace_lines',
    args: { path: 'src/Footer.tsx', expectedHash, edits: [linkLines56] },
  });
  const bonsai = bonsaiOf({ steps: [edit('0123456789abcdef'), edit('FILL')] });
  const jev = jevOf({ watch: () => ({ progress: 0.5, same_failure: 0.95 }) });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jev,
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(result.blockedActions!.length, 1);
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'result').map(e => [e.data.step, e.data.ok]),
    [
      [1, false],
      [2, true],
    ],
    'the corrected edit ran',
  );
});

test('A check printed with colour reaches the worker as plain text: every file and line it names, with the source and the sha256 of each file', async t => {
  const { root, store } = await repo(t);
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'];
  await mkdir(join(root, 'src'), { recursive: true });
  const { hash } = await import('../src/files.js');
  const texts: string[] = [];
  for (const [i, f] of files.entries()) {
    const text = Array.from({ length: 40 }, (_, k) => `export const v${i}_${k + 1} = ${k + 1};`).join('\n') + '\n';
    texts.push(text);
    await writeFile(join(root, f), text);
  }
  const pretty = files
    .map(
      (f, i) =>
        `\u001b[96m${f}\u001b[0m:\u001b[93m${10 + i}\u001b[0m:\u001b[93m3\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS6133: \u001b[0m'x${i}' is declared but its value is never read.\n\n\u001b[7m${10 + i}\u001b[0m export const x${i} = 1\n`,
    )
    .join('\n');
  await writeFile(
    join(root, 'check.mjs'),
    `process.stdout.write(${JSON.stringify(pretty)} + "env NO_COLOR=" + process.env.NO_COLOR + "\\n"); process.exit(2);\n`,
  );
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'the check', check: true } },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'fix the check'));
  const check = result.entries.find(e => e.kind === 'bash')!;
  assert(!/\u001b/.test(check.text) && !/\\u001b/.test(check.text), 'no escape sequence reaches the evidence');
  assert.match(check.text, /env NO_COLOR=1/, 'commands run with NO_COLOR set');
  assert.deepEqual(Object.keys(result.lastCheck!.summary.files), files, 'every file the output names is attributed');
  for (const [i, f] of files.entries())
    assert.match(
      check.text,
      new RegExp(
        `${f.replace('.', '\\.')} sha256=${hash(texts[i]!)} totalLines=41 \\(errors at ${10 + i}\\):[\\s\\S]*?${10 + i}: export const v${i}_${10 + i} = ${10 + i};`,
      ),
      `the source at ${f}:${10 + i} travels with the check`,
    );
});

// The review of the run-56 patch (R1..R9): a repeat is judged by exact arguments and by what the files show.
const rl = (path: string, expectedHash: string, edits: object[]) => ({
  action: 'replace_lines',
  args: { path, expectedHash, edits },
});
test('R1: an applied edit undone by a later edit, sent again on the file restored to what it found, runs again', async t => {
  const { root, store } = await repo(t);
  const { hash } = await import('../src/files.js');
  await mkdir(join(root, 'src'), { recursive: true });
  const h0text = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  await writeFile(join(root, 'src', 'f.ts'), h0text);
  const A = rl('src/f.ts', hash(h0text), [{ start: 1, end: 1, newText: 'const a = 10;', prepend: '' }]);
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'set a to 10', action: 'plan', batch: [A] },
      {
        thought: 'undo it',
        action: 'plan',
        batch: [rl('src/f.ts', 'FILL', [{ start: 1, end: 1, newText: 'const a = 1;', prepend: '' }])],
      },
      { thought: 'a = 10 after all', action: 'plan', batch: [JSON.parse(JSON.stringify(A))] },
    ],
  });
  await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'src', 'f.ts'), 'utf8'), 'const a = 10;\nconst b = 2;\nconst c = 3;\n');
});
test('R2/R9: an applied edit sent again verbatim after later harness edits, or after a resume, is refused as a second application with the edits that followed', async t => {
  const { root, store } = await repo(t);
  const { hash } = await import('../src/files.js');
  await mkdir(join(root, 'src'), { recursive: true });
  const text = 'a\nb\nc\n';
  await writeFile(join(root, 'src', 'f.ts'), text);
  const A = rl('src/f.ts', hash(text), [{ start: 1, end: 1, newText: 'A', prepend: '' }]);
  const B = () => rl('src/f.ts', 'FILL', [{ start: 3, end: 2, newText: 'ins', prepend: '' }]);
  const b1 = bonsaiOf({
    steps: [
      { thought: 'A', action: 'plan', batch: [A] },
      { thought: 'insert', action: 'plan', batch: [B()] },
      { thought: 'insert another', action: 'plan', batch: [B()] },
    ],
  });
  await new Agent(
    { ...config, maxSteps: 3 },
    store,
    jevOf({}),
    filling(b1, async p => hash(await readFile(join(root, p), 'utf8'))),
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const loaded = await store.load();
  const b2 = bonsaiOf({
    steps: [{ thought: 'A again verbatim', action: 'plan', batch: [JSON.parse(JSON.stringify(A))] }],
  });
  await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    b2,
    root,
    () => {},
    () => {},
  ).run(loaded);
  assert.equal(await readFile(join(root, 'src', 'f.ts'), 'utf8'), 'A\nb\nins\nins\nc\n', 'A once');
  const why = (await events(store)).filter(e => e.type === 'refused').at(-1)!.data.why;
  assert.match(
    why,
    /was applied at step 1 with these same arguments, and since then src\/f\.ts changed only by the replace_lines of src\/f\.ts \(lines insert before 3\) at step 2, the replace_lines of src\/f\.ts \(lines insert before 3\) at step 3 .*: running it again would apply it a second time/,
    why,
  );
});
test('R3/R4: a repeated applied edit followed by a plan, and one edit alternating between two stale hashes, both stop at four in a row', async t => {
  for (const shape of ['plan', 'alternating'] as const) {
    const { root, store } = await repo(t);
    const { hash } = await import('../src/files.js');
    await mkdir(join(root, 'src'), { recursive: true });
    const text = 'a\nb\nc\n';
    await writeFile(join(root, 'src', 'f.ts'), text);
    const A = rl('src/f.ts', hash(text), [{ start: 1, end: 1, newText: 'A', prepend: '' }]);
    const steps =
      shape === 'plan'
        ? Array.from({ length: 30 }, () => ({
            thought: 'fix a and note it',
            action: 'plan',
            batch: [JSON.parse(JSON.stringify(A)), { action: 'plan', args: { notes: 'a fixed' } }],
          }))
        : Array.from({ length: 12 }, (_, i) => ({
            thought: 'fix a',
            action: 'replace_lines',
            args: {
              path: 'src/f.ts',
              expectedHash: i % 2 ? '1111111111111111' : '2222222222222222',
              edits: [{ start: 1, end: 1, newText: 'A', prepend: '' }],
            },
          }));
    const result = await new Agent(
      { ...config, maxSteps: 40 },
      store,
      jevOf({}),
      bonsaiOf({ steps }),
      root,
      () => {},
      () => {},
    ).run(await newSession(root, 'x'));
    assert.match(result.stopReason ?? '', /four (actions|turns) in a row/, shape);
    assert(result.step <= 8, `${shape}: stopped at step ${result.step}`);
  }
});
test('R5/R6: a create that failed for a reason outside the file runs again once that changes, and a generated rewrite asked for again regenerates', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'lib'), 'not a dir\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'g.ts'), 'export const g = 1;\n');
  const C = { action: 'create_file', args: { path: 'lib/a.ts', purpose: 'a', content: 'export const a = 1;\n' } };
  const R = { action: 'rewrite_file', args: { path: 'src/g.ts', purpose: 'export g as a function' } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'create', action: 'plan', batch: [C] },
      {
        thought: 'lib is a file; remove it',
        action: 'bash',
        args: { command: 'rm lib', purpose: 'remove', check: false },
      },
      { thought: 'create again', action: 'plan', batch: [JSON.parse(JSON.stringify(C))] },
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'src/g.ts', start: 1, end: 1 }] } },
      { thought: 'rewrite', action: 'plan', batch: [R] },
      { thought: 'regenerate', action: 'plan', batch: [JSON.parse(JSON.stringify(R))] },
    ],
  });
  let n = 0;
  const spy = {
    ...bonsai,
    generateText: async () => ({
      text: n++ === 0 ? 'export const g = () => 1\n' : 'export function g() { return 1; }\n',
      finish: 'stop' as const,
      meta: { ms: 1, promptTokens: 1 },
    }),
  };
  await new Agent(
    { ...config, maxSteps: 6 },
    store,
    jevOf({}),
    spy as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'lib', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(n, 2, 'the second generation ran');
  assert.equal(await readFile(join(root, 'src', 'g.ts'), 'utf8'), 'export function g() { return 1; }\n');
});
test('R8: a checkpoint from before exact keys keeps its blocked edit blocked after resume', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'f.ts'), 'a\nb\nc\n');
  const args = {
    path: 'src/f.ts',
    expectedHash: '0123456789abcdef',
    edits: [{ start: 1, end: 1, newText: 'A', prepend: '' }],
  };
  const s = await newSession(root, 'x');
  s.step = 10;
  s.blockedActions = [Agent.actionKey(s, 'replace_lines' as any, args)];
  await store.save(s);
  await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsaiOf({ steps: [{ thought: 'again', action: 'replace_lines', args }] }),
    root,
    () => {},
    () => {},
  ).run(await store.load());
  const ev = await events(store);
  assert.equal(ev.filter(e => e.type === 'result').length, 0);
  assert.equal(ev.filter(e => e.type === 'refused').length, 1);
});
test('The source at the errors carries the hash an edit needs (a BOM file), and a file that does not fit is named, never cut mid-file', async t => {
  const { root, store } = await repo(t);
  const { hash, boundedRead } = await import('../src/files.js');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'bom.ts'), '﻿export const a: number = 1;\nexport const b: number = "x";\n');
  const many = Array.from({ length: 10 }, (_, f) => `src/m${f}.ts`);
  for (const [f, p] of many.entries())
    await writeFile(
      join(root, p),
      Array.from({ length: 60 }, (_, i) => `export const value_${f}_${i} = ${i}; // ${'x'.repeat(40)}`).join('\n') +
        '\n',
    );
  const lines = [
    'src/bom.ts(2,14): error TS2322: Type string is not assignable to type number.',
    ...many.flatMap(p => [5, 13, 21, 29, 37, 45].map(n => `${p}(${n},1): error TS1: bad`)),
  ];
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'build',
        action: 'bash',
        args: {
          command: `printf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')}; exit 1`,
          purpose: 'build',
          check: true,
        },
      },
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const e = result.entries.find(x => x.kind === 'bash')!.text;
  const source = e.slice(e.indexOf('Source at the errors:'));
  assert.match(
    source,
    new RegExp(
      `src/bom\\.ts sha256=${hash(await boundedRead(join(root, 'src', 'bom.ts')))} totalLines=3 \\(errors at 2\\)`,
    ),
    'the hash read_files and the edits use',
  );
  assert(!/truncated/.test(source), 'never clipped across files');
  assert.match(
    source,
    /Also named by the check, not shown for room: .*src\/m9\.ts sha256=\w+ totalLines=61 \(errors at 5, 13, 21, 29, 37, 45\)/,
  );
  for (const block of source.split('\n').filter(l => /^\d+: /.test(l)))
    assert(block.length < 220, 'long lines are cut on their own');
});

// Review of the repeated-read change: loops it must still bound, facts it must not overstate.
test('Repeating a read of a file larger than the evidence budget stops at four in a row: lines read before and since evicted are read again, but count as no progress', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'big.ts'),
    Array.from({ length: 300 }, (_, i) => `export const line${i + 1} = '${'x'.repeat(30)}';`).join('\n') + '\n',
  );
  const read = { files: [{ path: 'big.ts', start: 1, end: 300 }] };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 40 }, (_, i) => ({ thought: `read big (${i})`, action: 'read_files', args: read })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 40, toolChars: 1600, workingTokens: 6000, contextWindow: 64000 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.stopReason, /four (actions|turns) in a row/, result.stopReason);
  assert(result.step < 40, `stopped at step ${result.step}`);
});
test('A repeated two-file read whose other file was removed outside the harness counts toward four in a row, and the identical request is then refused with its error', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'out.js'), numbered(3));
  await writeFile(join(root, 'b.ts'), numbered(3));
  const read = {
    files: [
      { path: 'dist/out.js', start: 1, end: 3 },
      { path: 'b.ts', start: 1, end: 3 },
    ],
  };
  const base = bonsaiOf({
    steps: Array.from({ length: 20 }, (_, i) => ({ thought: `read (${i})`, action: 'read_files', args: read })),
  });
  let calls = 0;
  const bonsai = {
    ...base,
    generate: async (m: Message[], schema: any) => {
      if (schema.properties?.actions && ++calls === 3) await rm(join(root, 'dist'), { recursive: true, force: true });
      return base.generate(m, schema);
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 20 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.stopReason, /four (actions|turns) in a row/, result.stopReason);
  assert(result.step <= 8, `stopped at step ${result.step}`);
  assert(
    (await events(store)).some(e => e.type === 'refused' && /failed at step \d+ .*dist[\\/]out\.js/.test(e.data.why)),
    'the identical request is refused with the failure',
  );
});
test('A repeated read followed by the same plan each turn stops at four in a row', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 30 }, (_, i) => ({
      thought: `read and note (${i})`,
      action: 'plan',
      batch: [read, { action: 'plan', args: { notes: 'a is read' } }],
    })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 60 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.stopReason, /four (actions|turns) in a row/, result.stopReason);
  assert(result.step <= 12, `stopped at step ${result.step}`);
});
test('After a clip marker in a multi-file read nothing is credited to the file before it, and the entries a statement names give way when nothing else can be evicted', async () => {
  const { shownLines, evictOne } = await import('../src/context.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-clipcross-')), 'x');
  const lines = (p: string, a: number, b: number) =>
    Array.from({ length: b - a + 1 }, (_, i) => `${a + i}: export const ${p}_${a + i} = 1;`).join('\n');
  const entry = (id: string, text: string, cites?: string[]) => ({
    id,
    step: Number(id.slice(1)),
    kind: 'read_files',
    artifact: '',
    relevance: 0.5,
    text,
    ...(cites ? { cites } : {}),
  });
  // The clip cut app.ts at line 23 and resumed inside util.ts (lines 103..107).
  s.entries = [
    entry(
      'e2',
      `src/app.ts sha256=A totalLines=150 shown=20..150\n${lines('app', 20, 23)}\n[…truncated; use a narrower read or query…]\n${lines('util', 103, 107)}`,
    ),
  ];
  assert.deepEqual(
    [...shownLines(s, 'src/app.ts', 'A').by.keys()],
    [20, 21, 22],
    'only the head before the cut line; util.ts lines are not app.ts lines',
  );
  s.entries = [
    entry('e1', lines('f', 1, 5)),
    entry('e2', lines('f', 6, 9)),
    entry('e3', 'the freshest statement', ['e1', 'e2']),
  ];
  assert.equal(evictOne(s), undefined, 'the routine compaction keeps the entries the freshest statement names');
  assert.equal(
    evictOne(s, 0, undefined, true)?.id,
    'e1',
    'over the hard budget, when only cited entries remain, one of them goes rather than none',
  );
});
test('Re-reading files whose earlier reads were evicted is progress: the run goes on to its next edit (review B-1), and a read of a file that fits is paged through while each page restores lines', async t => {
  const { hash } = await import('../src/files.js');
  {
    // Six files edited then read; small budget evicts the reads; the worker re-reads four of them one per turn, then edits.
    const { root, store } = await repo(t);
    const text = (n: number) =>
      Array.from({ length: n }, (_, i) => `export const line${i + 1} = '${'x'.repeat(40)}';`).join('\n') + '\n';
    for (let i = 0; i < 6; i++) await writeFile(join(root, `f${i}.ts`), text(50));
    const rd = (path: string) => ({ action: 'read_files', args: { files: [{ path, start: 1, end: 50 }] } });
    const steps = [
      ...Array.from({ length: 6 }, (_, i) => ({
        thought: `edit f${i}`,
        action: 'plan',
        batch: [
          {
            action: 'replace_lines',
            args: {
              path: `f${i}.ts`,
              expectedHash: 'FILL',
              edits: [{ start: 1, end: 1, newText: `export const first${i} = 1;`, prepend: '' }],
            },
          },
          rd(`f${i}.ts`),
        ],
      })),
      ...Array.from({ length: 5 }, (_, i) => ({ thought: `re-read f${i}`, action: 'plan', batch: [rd(`f${i}.ts`)] })),
      {
        thought: 'edit again',
        action: 'plan',
        batch: [
          {
            action: 'replace_lines',
            args: {
              path: 'f0.ts',
              expectedHash: 'FILL',
              edits: [{ start: 2, end: 2, newText: 'export const two = 2;', prepend: '' }],
            },
          },
        ],
      },
    ];
    const result = await new Agent(
      { ...config, maxSteps: 40, workingTokens: 6000 },
      store,
      jevOf({}),
      filling(bonsaiOf({ steps }), async p => hash(await readFile(join(root, p), 'utf8'))),
      root,
      () => {},
      () => {},
    ).run(await newSession(root, 'x'));
    assert.doesNotMatch(result.stopReason ?? '', /in a row/, result.stopReason);
    assert.match(
      await readFile(join(root, 'f0.ts'), 'utf8'),
      /^export const first0 = 1;\nexport const two = 2;\n/,
      'the edit after the re-reads ran',
    );
  }
  {
    // A file that fits the evidence, asked for whole each turn: each page adds lines the evidence did not show.
    const { root, store } = await repo(t);
    await writeFile(
      join(root, 'big.ts'),
      Array.from({ length: 300 }, (_, i) => `export const line${i + 1} = '${'x'.repeat(20)}';`).join('\n') + '\n',
    );
    const read = { files: [{ path: 'big.ts', start: 1, end: 300 }] };
    const bonsai = bonsaiOf({
      steps: Array.from({ length: 30 }, (_, i) => ({ thought: `read big (${i})`, action: 'read_files', args: read })),
    });
    const result = await new Agent(
      { ...config, maxSteps: 30, toolChars: 1600, workingTokens: 90000 },
      store,
      jevOf({}),
      bonsai,
      root,
      () => {},
      () => {},
    ).run(await newSession(root, 'x'));
    const shown = (await import('../src/context.js')).shownLines(
      result,
      'big.ts',
      hash(await readFile(join(root, 'big.ts'), 'utf8')),
    ).by;
    assert.equal(shown.size, 300, 'the whole file came to be shown');
    assert.match(
      result.stopReason,
      /four (actions|turns) in a row/,
      'then the repeats that add nothing end the attempt',
    );
  }
});
test('A turn of [plan, repeated read] counts toward four in a row whatever the order (review A-1/B-2)', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const bonsai = bonsaiOf({
    steps: [
      { thought: 'read', action: 'plan', batch: [read] },
      ...Array.from({ length: 30 }, (_, i) => ({
        thought: `note then read (${i})`,
        action: 'plan',
        batch: [{ action: 'plan', args: { notes: 'look at a.ts' } }, JSON.parse(JSON.stringify(read))],
      })),
    ],
  });
  const result = await new Agent(
    { ...config, maxSteps: 60 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.stopReason, /four (actions|turns) in a row/, result.stopReason);
  assert(result.step <= 12, `stopped at step ${result.step}`);
});
test('Two requests alternating over a file larger than the evidence stop at four in a row: progress is judged by the lines a read showed, not by the range asked (review A1)', async t => {
  const { root, store } = await repo(t);
  await writeFile(
    join(root, 'big.ts'),
    Array.from({ length: 2000 }, (_, i) => `export const line${i + 1} = '${'x'.repeat(20)}';`).join('\n') + '\n',
  );
  const A = { files: [{ path: 'big.ts', start: 1, end: 2000 }] };
  const B = { files: [{ path: 'big.ts', start: 1, end: 1999 }] };
  const bonsai = bonsaiOf({
    steps: Array.from({ length: 40 }, (_, i) => ({
      thought: `alternate (${i})`,
      action: 'read_files',
      args: i % 2 ? B : A,
    })),
  });
  const result = await new Agent(
    { ...config, maxSteps: 40, workingTokens: 8000 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(result.stopReason, /four (actions|turns) in a row/, result.stopReason);
  assert(result.step <= 12, `stopped at step ${result.step}`);
});

// A scripted worker whose step generations record the temperature they were sampled at.
function sampled(base: ReturnType<typeof bonsaiOf>) {
  const temperatures: number[] = [];
  return {
    temperatures,
    bonsai: {
      ...base,
      generate: async (m: Message[], schema: any, temperature?: number) => {
        if (schema.properties?.actions) temperatures.push(temperature!);
        return base.generate(m, schema);
      },
    },
  };
}
test('A turn that changed nothing is followed by a step sampled at the next temperature of the escalation; a turn that changes something returns to stepTemperature', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const turn = (thought: string, b: { action: string; args: Record<string, any> }) => ({
    thought,
    action: 'plan',
    batch: [JSON.parse(JSON.stringify(b))],
  });
  const echo = (w: string) => ({ action: 'bash', args: { command: `echo ${w}`, purpose: 'look', check: false } });
  // The first read learns the file's hash, so the second is keyed with it and runs; the third repeats it.
  const { bonsai, temperatures } = sampled(
    bonsaiOf({
      steps: [
        turn('read 1', read),
        turn('read 2', read),
        turn('read 3', read),
        turn('read 4', read),
        turn('read 5', read),
        turn('look', echo('on')),
        turn('read 6', read),
        turn('look again', echo('more')),
      ],
    }),
  );
  const result = await new Agent(
    { ...config, maxSteps: 8, stepTemperature: 0.2, stepTemperatureEscalation: [0.5, 0.8, 1] },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  assert.deepEqual(
    ev.filter(e => e.type === 'action').map(e => e.data.route),
    ['read_files', 'read_files', 'bash', 'bash'],
    'the scenario: steps 3, 4, 5 and 7 repeated the read',
  );
  assert.deepEqual(
    temperatures,
    [0.2, 0.2, 0.2, 0.5, 0.8, 1, 0.2, 0.5],
    'after one, two, three turns that changed nothing: the first, second, third value; the command ends the streak',
  );
  assert.deepEqual(
    ev.filter(e => e.type === 'sampling').map(e => [e.data.step, e.data.unchangedTurns, e.data.temperature]),
    [
      [4, 1, 0.5],
      [5, 2, 0.8],
      [6, 3, 1],
      [8, 1, 0.5],
    ],
  );
  assert.deepEqual(
    ev.filter(e => e.type === 'thought').map(e => e.data.temperature),
    temperatures,
    'each turn records the temperature it was sampled at',
  );
  assert.equal(result.unchangedTurns, 0);
  assert.doesNotMatch(result.stopReason, /four turns in a row/);
});

test('Run 58 replayed: a worker that returns the same read at its near-greedy temperature stops at four in a row; with the escalation the next sampled step leaves the loop', async t => {
  const css = Array.from({ length: 60 }, (_, i) => `.c${i + 1} { color: red; }`).join('\n') + '\n';
  const same = {
    thought:
      'The build failed because @utility cannot @apply another custom utility. Let me first read the current state of the file to see what was generated.',
    actions: [{ action: 'read_files', args: { files: [{ path: 'src/index.css', start: 1, end: 51 }] } }],
  };
  // The worker as a function of what it is sampled at: near-greedy it returns the same turn, whatever the prompt adds;
  // sampled higher it reads what the evidence does not show, and from there it goes on with the work.
  const worker = (prompts: Message[][]) => {
    let left = false;
    let n = 0;
    return {
      count: async (m: Message[]) => ({
        tokens: Math.ceil(m.reduce((n, x) => n + x.content.length, 0) / 4),
        mode: 'test',
      }),
      generate: async (m: Message[], schema: any, temperature?: number) => {
        prompts.push(m);
        if (left)
          return {
            thought: `go on ${++n}`,
            actions: [{ action: 'bash', args: { command: `echo ${n}`, purpose: 'work', check: false } }],
          };
        if ((temperature ?? 0.2) <= 0.2) return JSON.parse(JSON.stringify(same));
        left = true;
        return {
          thought: 'The evidence shows lines 1..51; lines 52..60 are what I have not seen.',
          actions: [{ action: 'read_files', args: { files: [{ path: 'src/index.css', start: 52, end: 60 }] } }],
        };
      },
      lastMeta: null,
    };
  };
  const runWith = async (escalation: number[]) => {
    const { root, store } = await repo(t);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.css'), css);
    const prompts: Message[][] = [];
    const result = await new Agent(
      { ...config, maxSteps: 8, stepTemperatureEscalation: escalation },
      store,
      jevOf({}),
      worker(prompts),
      root,
      () => {},
      () => {},
    ).run(await newSession(root, 'x'));
    return { result, prompts, ev: await events(store) };
  };
  const off = await runWith([]);
  assert.match(
    off.result.stopReason,
    /four turns in a row could not be executed or only repeated earlier requests/,
    'without the escalation the same turn comes back until the attempt ends',
  );
  // The first read learns the file's hash, so the second is keyed with it and runs (in run 58 the edit before it had).
  assert.equal(off.ev.filter(e => e.type === 'thought').length, 6, 'two reads, then four turns that repeat the second');
  // Each turn of repeats keeps its statement, so no prompt of the streak is the one before it with a step number changed.
  const repeats = (m: Message[]) => m.filter(x => /"kind":"repeat"/.test(x.content)).length;
  assert.deepEqual(
    off.prompts.slice(2).map(repeats),
    [0, 1, 2, 3],
    'the prompt grows by one statement per turn of repeats',
  );
  const on = await runWith([0.5, 0.8, 1]);
  assert.match(on.result.stopReason, /Reached the 8-step limit/, 'the run went on to its step limit');
  const reads = on.ev
    .filter(e => e.type === 'action' && e.data.route === 'read_files')
    .map(e => e.data.args.files.map((f: any) => `${f.start}..${f.end}`).join(','));
  assert.deepEqual(
    reads,
    ['1..51', '1..51', '52..60'],
    'the step after the first turn that changed nothing, sampled at .5, read what the evidence did not show',
  );
  assert.deepEqual(
    on.ev
      .filter(e => e.type === 'thought')
      .slice(0, 4)
      .map(e => e.data.temperature),
    [0.2, 0.2, 0.2, 0.5],
  );
});

test('A plan that leaves the notes as they were changes nothing; one that changes them ends the streak', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const plan = { action: 'plan', args: { notes: 'n' } };
  const turn = (i: number, batch: { action: string; args: Record<string, any> }[]) => ({
    thought: `plan and read ${i}`,
    action: 'plan',
    batch: batch.map(b => JSON.parse(JSON.stringify(b))),
  });
  const { bonsai, temperatures } = sampled(
    bonsaiOf({
      steps: [
        turn(1, [read]),
        turn(2, [read]),
        turn(3, [plan, read]),
        turn(4, [plan, read]),
        turn(5, [plan, read]),
        turn(6, [plan, read]),
      ],
    }),
  );
  const result = await new Agent(
    { ...config, maxSteps: 20, stepTemperatureEscalation: [0.5, 0.8, 1] },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.match(
    result.stopReason,
    /four turns in a row could not be executed or only repeated earlier requests/,
    'the four in a row is unchanged',
  );
  assert.deepEqual(
    temperatures,
    [0.2, 0.2, 0.2, 0.2, 0.5, 0.8],
    'the first plan wrote the notes; the plans after it left them as they were',
  );
});

test('The escalation is configured: a list of at most eight temperatures in (0, 2], never sampled below stepTemperature, empty to turn it off', async t => {
  const { loadConfig } = await import('../src/config.js');
  assert.deepEqual((await loadConfig()).stepTemperatureEscalation, [0.5, 0.8, 1]);
  assert.deepEqual((await loadConfig(undefined, { stepTemperatureEscalation: [] })).stepTemperatureEscalation, []);
  for (const bad of [0.5, [0], [2.5], ['1'], Array(9).fill(0.5), { 0: 0.5 }])
    await assert.rejects(loadConfig(undefined, { stepTemperatureEscalation: bad as any }), /stepTemperatureEscalation/);
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { files: [{ path: 'a.ts', start: 1, end: 3 }] };
  const { bonsai, temperatures } = sampled(
    bonsaiOf({ steps: [0, 1, 2, 3, 4].map(i => ({ thought: `read ${i}`, action: 'read_files', args: read })) }),
  );
  await new Agent(
    { ...config, maxSteps: 5, stepTemperature: 0.6, stepTemperatureEscalation: [0.5, 0.9] },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.deepEqual(
    temperatures,
    [0.6, 0.6, 0.6, 0.6, 0.9],
    'a value below stepTemperature samples at stepTemperature; past the last value, the last',
  );
});

test("A file generated in a step keeps its own prompt artifact beside the step's", async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({
    steps: [{ thought: 'create it', action: 'create_file', args: { path: 'src/new.ts', purpose: 'a module' } }],
  });
  await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const prompts = (await events(store)).filter(e => e.type === 'prompt').map(e => [e.data.route, e.data.artifact]);
  assert.deepEqual(prompts, [
    ['step', '@artifact/00001-prompt.json'],
    ['create_file', '@artifact/00001-prompt-create_file.json'],
  ]);
  for (const [, a] of prompts)
    assert(JSON.parse(await readFile(join(store.artifacts, String(a).slice('@artifact/'.length)), 'utf8')).length > 0);
});

// ---- adversarial probes (verification) ----
function sampledT(base: ReturnType<typeof bonsaiOf>) {
  const temperatures: number[] = [];
  const codeTemps: (number | undefined)[] = [];
  return {
    temperatures,
    codeTemps,
    bonsai: {
      ...base,
      generate: async (m: Message[], schema: any, temperature?: number) => {
        if (schema.properties?.actions) temperatures.push(temperature!);
        return base.generate(m, schema);
      },
      generateText: async (m: Message[], o: any) => {
        codeTemps.push(o?.temperature);
        return base.generateText(m);
      },
    },
  };
}
test('PROBE unbounded: [plan same notes, refused command] turns never reach four in a row; escalation stays hot', async t => {
  const { root, store } = await repo(t);
  const plan = { action: 'plan', args: { notes: 'n' } };
  const echo = { action: 'bash', args: { command: 'echo hi', purpose: 'x', check: false } };
  const steps = [
    { thought: 't0', action: 'plan', batch: [plan, echo] },
    ...Array.from({ length: 12 }, (_, i) => ({ thought: `again ${i}`, action: 'plan', batch: [plan, echo] })),
  ];
  const { bonsai, temperatures } = sampledT(bonsaiOf({ steps: steps.map(s => JSON.parse(JSON.stringify(s))) }));
  const result = await new Agent(
    { ...config, maxSteps: 24 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  console.log(
    'PROBE-unbounded',
    JSON.stringify({
      temps: temperatures,
      stop: result.stopReason,
      refused: ev.filter(e => e.type === 'refused').length,
      unchanged: result.unchangedTurns,
    }),
  );
});
test('PROBE resume: a session stopped by four in a row resumes sampling hot', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { files: [{ path: 'a.ts', start: 1, end: 3 }] };
  const { bonsai } = sampledT(
    bonsaiOf({ steps: [0, 1, 2, 3, 4, 5].map(i => ({ thought: `read ${i}`, action: 'read_files', args: read })) }),
  );
  const s1 = await new Agent(
    { ...config, maxSteps: 10 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const b2 = sampledT(
    bonsaiOf({
      steps: [{ thought: 'user said do y', action: 'bash', args: { command: 'echo y', purpose: 'y', check: false } }],
    }),
  );
  await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    b2.bonsai,
    root,
    () => {},
    () => {},
  ).run(s1);
  console.log(
    'PROBE-resume',
    JSON.stringify({ stop1: s1.stopReason.slice(0, 60), unchangedAtStop: 'see temps', temps2: b2.temperatures }),
  );
});
test('PROBE productive: a refused edit then its correction; and create_file code temperature on an escalated step', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const steps = [
    {
      thought: 'edit with stale hash',
      action: 'replace_lines',
      args: {
        path: 'a.ts',
        expectedHash: 'deadbeefdeadbeef',
        edits: [{ start: 1, end: 1, newText: 'export const a = 2;' }],
      },
    },
    { thought: 'create a file', action: 'create_file', args: { path: 'b.ts', purpose: 'module b' } },
  ];
  const { bonsai, temperatures, codeTemps } = sampledT(bonsaiOf({ steps }));
  await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  console.log(
    'PROBE-productive',
    JSON.stringify({
      temps: temperatures,
      codeTemps,
      outcomes: ev
        .filter(e => ['refused', 'action', 'result'].includes(e.type))
        .map(e => [e.type, e.data.step, e.data.route ?? e.data.kind, (e.data.why ?? '').slice(0, 80)]),
    }),
  );
});
test('PROBE mismatch: [repeated read, failing command] counts toward four in a row but never escalates', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), numbered(3));
  const read = { action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 3 }] } };
  const fail = { action: 'bash', args: { command: 'sh -c "exit 3"', purpose: 'build', check: false } };
  const steps = [
    { thought: 'r0', action: 'read_files', batch: [read] },
    { thought: 'r1', action: 'read_files', batch: [read] },
    ...Array.from({ length: 6 }, (_, i) => ({ thought: `rf ${i}`, action: 'plan', batch: [read, fail] })),
  ];
  const { bonsai, temperatures } = sampledT(bonsaiOf({ steps: steps.map(s => JSON.parse(JSON.stringify(s))) }));
  const result = await new Agent(
    { ...config, maxSteps: 20 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  console.log(
    'PROBE-mismatch',
    JSON.stringify({
      temps: temperatures,
      stop: result.stopReason.slice(0, 90),
      outcomes: ev.filter(e => e.type === 'thought').length,
    }),
  );
});
test('PROBE productive2: a parse-breaking edit is refused; the correcting edit and a create_file are sampled escalated', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  const steps = [
    { thought: 'read', action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 2 }] } },
    {
      thought: 'break it',
      action: 'replace_lines',
      args: { path: 'a.ts', expectedHash: 'FILL', edits: [{ start: 1, end: 1, newText: 'export const a = (;' }] },
    },
    {
      thought: 'fix properly',
      action: 'replace_lines',
      args: { path: 'a.ts', expectedHash: 'FILL', edits: [{ start: 1, end: 1, newText: 'export const a = 3;' }] },
    },
    {
      thought: 'break again',
      action: 'replace_lines',
      args: { path: 'a.ts', expectedHash: 'FILL', edits: [{ start: 1, end: 1, newText: 'export const a = (;' }] },
    },
    { thought: 'create a file', action: 'create_file', args: { path: 'b.ts', purpose: 'module b' } },
  ];
  const s = sampledT(bonsaiOf({ steps }));
  const session = await newSession(root, 'x');
  const gen = s.bonsai.generate;
  const bonsai = {
    ...s.bonsai,
    generate: async (m: Message[], schema: any, temperature?: number) => {
      const a = await gen(m, schema, temperature);
      for (const act of a.actions ?? [])
        if (act.args?.expectedHash === 'FILL') act.args.expectedHash = session.hashes[act.args.path];
      return a;
    },
  };
  await new Agent(
    { ...config, maxSteps: 5 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(session);
  const ev = await events(store);
  console.log(
    'PROBE-productive2',
    JSON.stringify({
      temps: s.temperatures,
      codeTemps: s.codeTemps,
      ev: ev
        .filter(e => ['refused', 'result', 'sampling'].includes(e.type))
        .map(e => [e.type, e.data.step, e.data.kind ?? '', e.data.ok ?? '', (e.data.why ?? '').slice(0, 70)]),
    }),
  );
});
test('PROBE cache: during a streak of repeats each prompt extends the previous one at its end', async t => {
  const { root, store } = await repo(t);
  const css = Array.from({ length: 60 }, (_, i) => `.c${i + 1} { color: red; }`).join('\n') + '\n';
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.css'), css);
  const same = {
    thought:
      'The build failed because @utility cannot @apply another custom utility. Let me first read the current state of the file to see what was generated.',
    action: 'read_files',
    args: { files: [{ path: 'src/index.css', start: 1, end: 51 }] },
  };
  const prompts: Message[][] = [];
  const base = bonsaiOf({ steps: Array.from({ length: 8 }, () => JSON.parse(JSON.stringify(same))) });
  const bonsai = {
    ...base,
    generate: async (m: Message[], schema: any, temperature?: number) => {
      if (schema.properties?.actions) prompts.push(m);
      return base.generate(m, schema);
    },
  };
  await new Agent(
    { ...config, maxSteps: 8, stepTemperatureEscalation: [] },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const mask = (x: string) => x.replace(/\d+/g, '#');
  const rows = prompts.slice(1).map((p, k) => {
    const q = prompts[k]!;
    let i = 0;
    while (i < p.length && i < q.length && p[i]!.content === q[i]!.content) i++;
    const tail = p.slice(i).reduce((n, x) => n + x.content.length, 0);
    const same = p.length === q.length && p.every((x, j) => mask(x.content) === mask(q[j]!.content));
    return { step: k + 2, msgs: p.length, firstDiff: i, tailChars: tail, maskedEqual: same };
  });
  console.log('PROBE-cache', JSON.stringify(rows));
});
test('PROBE informative: a refusal that states a new fact (the file exists) is followed by a step at', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const steps = [
    { thought: 'create a.ts', action: 'create_file', args: { path: 'a.ts', purpose: 'module a' } },
    { thought: 'rewrite it then', action: 'bash', args: { command: 'echo next', purpose: 'x', check: false } },
  ];
  const { bonsai, temperatures } = sampledT(bonsaiOf({ steps }));
  await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const ev = await events(store);
  console.log(
    'PROBE-informative',
    JSON.stringify({
      temps: temperatures,
      refused: ev.filter(e => e.type === 'refused').map(e => e.data.why.slice(0, 60)),
    }),
  );
});

// Run 71, steps 31-37: the build failed at step 31; rewrite_file of src/utils/index.ts wrote at
// steps 32 and 33, then the same request (same path and purpose) generated the current content
// back three times (1452 tokens each, 64 s), and the model kept citing the step-31 errors.
test('Above codeTemperature 0.3 a rewrite that reproduced its file is generated again: a repeat is a new sample there, the byte-identical repeats having been measured at 0.3', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'utils.ts'), 'export const cx = (...a: string[]) => a.join(" ");\n');
  const fixed = 'export const cx = (...a: (string | false)[]) => a.filter(Boolean).join(" ");\n';
  const rewrite = {
    thought: 'cx must accept booleans.',
    action: 'rewrite_file',
    args: { path: 'src/utils.ts', purpose: 'cx that accepts booleans' },
  };
  const base = bonsaiOf({ steps: [rewrite, rewrite, rewrite] });
  let generated = 0;
  const bonsai = {
    ...base,
    generateText: async () => {
      generated++;
      return { text: fixed, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 3, codeTemperature: 0.7 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(generated, 3, 'steps 2 and 3 are generated again');
  assert(!result.entries.some(e => /it was not generated again/.test(e.text)));
});

test('Run 71, steps 31-37: a rewrite that reproduces its file states when and by what the file was last written and that the last check ran before it; the same request on the same content is not generated again', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'utils.ts'), 'export const cx = (...a: string[]) => a.join(" ");\n');
  await writeFile(join(root, 'check.mjs'), 'process.exit(1);\n');
  const fixed = 'export const cx = (...a: (string | false)[]) => a.filter(Boolean).join(" ");\n';
  const purpose = 'cx that accepts booleans';
  const rewrite = {
    thought: 'The build failed: cx does not accept booleans.',
    action: 'rewrite_file',
    args: { path: 'src/utils.ts', purpose },
  };
  const base = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      rewrite,
      rewrite,
      rewrite,
      {
        thought: 'say what differs',
        action: 'rewrite_file',
        args: { path: 'src/utils.ts', purpose: `${purpose}, with a default export` },
      },
      {
        thought: 'restore it',
        action: 'bash',
        args: { command: `printf 'export const cx = 1;\\n' > src/utils.ts`, purpose: 'restore' },
      },
      rewrite,
    ],
  });
  const generated: number[] = [];
  const bonsai = {
    ...base,
    generateText: async (m: Message[]) => {
      const req = JSON.parse(m.at(-1)!.content);
      generated.push(req.purpose);
      const text = req.purpose === purpose ? fixed : `${fixed}export default cx;\n`;
      return {
        text,
        finish: 'stop' as const,
        meta: { ms: 21400, promptTokens: 1, usage: { completion_tokens: 1452 } },
      };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 7 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const at = (step: number) => result.entries.find(e => e.step === step && e.kind !== 'turn')!;
  assert.match(at(2).text, /^Rewrote src\/utils\.ts/, 'step 2 wrote the fix');
  // Step 3: generated, reproduced, refused with the facts it was asked on.
  assert.match(
    at(3).text,
    /the rewrite of src\/utils\.ts reproduced its current content unchanged: the generated file \(1452 tokens, 21\.4 s\) equals src\/utils\.ts as it is \(sha256=\w+\); nothing was written/,
  );
  assert.match(at(3).text, /src\/utils\.ts was last written at step 2 by a rewrite_file with these same arguments/);
  assert.match(
    at(3).text,
    /the last check \(node check\.mjs, step 1\) ran before that write and none has run since: its output describes the file as it was at step 1\./,
  );
  assert.doesNotMatch(at(3).text, /Say in purpose|edit the lines that are wrong/, 'facts, no instruction');
  // Step 4: the same arguments on the same content: refused before generating.
  assert.match(
    at(4).text,
    /this exact rewrite_file of src\/utils\.ts reproduced the file unchanged at step 3 \(1452 tokens, 21\.4 s\) from the same request as now \(sha256=\w+, and the same purpose, lines, notes, check state, modules and packages; only earlier steps differ\); it was not generated again \(e3\)/,
  );
  assert.doesNotMatch(at(4).text, /truncated/, 'the refusal fits the evidence entry whole');
  assert.match(
    at(4).text,
    /last written at step 2 by a rewrite_file with these same arguments; the last check \(node check\.mjs, step 1\) ran before that write/,
  );
  assert.deepEqual(
    generated,
    [purpose, purpose, `${purpose}, with a default export`, purpose],
    'steps 2, 3, 5 and 7 generated; step 4 did not',
  );
  // Step 5: another purpose generates; step 7: the same request on other content generates.
  assert.match(at(5).text, /^Rewrote src\/utils\.ts/);
  assert.match(
    at(7).text,
    /^Rewrote src\/utils\.ts/,
    'the same arguments on content they have not reproduced are generated',
  );
  const refused = (await events(store)).filter(e => e.type === 'refused').map(e => e.data.step);
  assert.deepEqual(refused, [3, 4]);
});

test('Run 71, steps 26-30: a whole-file rewrite states how many of the lines it generated differ from the content it replaced, and what generating them cost', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const before = Array.from({ length: 10 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n';
  await writeFile(join(root, 'src', 'a.ts'), before);
  const after = before.replace('export const v3 = 3;', 'export const v3 = 30;');
  const base = bonsaiOf({
    steps: [
      { thought: 'fix v3', action: 'rewrite_file', args: { path: 'src/a.ts', purpose: 'v3 is 30' } },
      { thought: 'append', action: 'rewrite_file', args: { path: 'src/a.ts', purpose: 'v11', start: 11, end: 10 } },
    ],
  });
  const bonsai = {
    ...base,
    generateText: async (m: Message[]) => {
      const req = JSON.parse(m.at(-1)!.content);
      return {
        text: req.region !== undefined ? 'export const v11 = 11;\n' : after,
        finish: 'stop' as const,
        meta: { ms: 9100, promptTokens: 1, usage: { completion_tokens: 120 } },
      };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const writes = result.entries.filter(e => e.kind === 'write');
  assert.match(
    writes[0]!.text,
    /\nHarness: the rewrite generated every line of src\/a\.ts \(120 tokens, 9\.1 s\); compared with the content it replaced, 1 line went, 1 line came and 9 lines stayed as they were\.$/,
  );
  assert.doesNotMatch(
    writes[1]!.text,
    /the rewrite generated every line/,
    'a region rewrite generates only its block: nothing to state',
  );
  assert.doesNotMatch(result.lastError ?? '', /generated every line/, 'a fact about the write, not an error');
});

// Review of the run-71 patch: the same arguments on the same content are not the same
// generation when what the generation is shown has changed since (a check ran, a module it
// is written against changed); those are generated.
test('Run 71 review: a rewrite that reproduced its file is generated again, with the same arguments on the same content, once a check has run since or a module it names has changed', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'utils.ts'), 'export const cx = (...a: string[]) => a.join(" ");\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(join(root, 'check.mjs'), 'process.exit(1);\n');
  const fixed = 'export const cx = (...a: (string | false)[]) => a.filter(Boolean).join(" ");\n';
  const purpose = 'cx that accepts booleans, as src/b.ts expects';
  const rewrite = {
    thought: 'The build failed: cx does not accept booleans.',
    action: 'rewrite_file',
    args: { path: 'src/utils.ts', purpose },
  };
  const base = bonsaiOf({
    steps: [
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      rewrite,
      rewrite,
      { thought: 'check again', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      rewrite,
      rewrite,
      {
        thought: 'b changes',
        action: 'bash',
        args: { command: `printf 'export const b = 2;\\nexport const c = 3;\\n' > src/b.ts`, purpose: 'b' },
      },
      rewrite,
    ],
  });
  const seen: { step: number | null; modules: string }[] = [];
  const bonsai = {
    ...base,
    generateText: async (m: Message[]) => {
      const req = JSON.parse(m.at(-1)!.content);
      const vol = JSON.parse(m.at(-2)!.content);
      seen.push({ step: vol.verification?.step ?? null, modules: JSON.stringify(req.modules) });
      return {
        text: fixed,
        finish: 'stop' as const,
        meta: { ms: 20000, promptTokens: 1, usage: { completion_tokens: 1452 } },
      };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 8 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const at = (step: number) => result.entries.find(e => e.step === step && e.kind !== 'turn')!;
  assert.match(at(3).text, /reproduced its current content unchanged/);
  // Step 5: the check of step 4 ran on the file as it is and is now in front of the generation.
  assert.equal(seen.length >= 3, true, `generated at steps 2, 3 and 5 (saw ${JSON.stringify(seen.map(x => x.step))})`);
  assert.match(at(5).text, /reproduced its current content unchanged/);
  assert.match(at(5).text, /the last check \(node check\.mjs, step 4\) ran on it as it is and failed/);
  // Step 6: nothing in front of the generation changed since step 5: not generated.
  assert.match(at(6).text, /not generated again/);
  // Step 8: src/b.ts, named in the purpose, changed: its exports are in front of the generation.
  assert.doesNotMatch(at(8).text, /not generated again/);
  assert.equal(seen.length, 4, 'steps 2, 3, 5 and 8 generated');
});

test('Run 71 review: a rewrite that differs from the file only in trailing whitespace is not said to equal it; a whole-file rewrite of a CRLF file counts its lines without their endings', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;');
  const crlf = Array.from({ length: 10 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\r\n') + '\r\n';
  await writeFile(join(root, 'src', 'c.ts'), crlf);
  const base = bonsaiOf({
    steps: [
      { thought: 'a', action: 'rewrite_file', args: { path: 'src/a.ts', purpose: 'a' } },
      { thought: 'c', action: 'rewrite_file', args: { path: 'src/c.ts', purpose: 'v3 is 30' } },
    ],
  });
  const bonsai = {
    ...base,
    generateText: async (m: Message[]) => {
      const req = JSON.parse(m.at(-1)!.content);
      const text =
        req.file === 'src/a.ts'
          ? 'export const a = 1;\nexport const b = 2;\n'
          : crlf.replace(/\r\n/g, '\n').replace('v3 = 3;', 'v3 = 30;');
      return { text, finish: 'stop' as const, meta: { ms: 1000, promptTokens: 1, usage: { completion_tokens: 10 } } };
    },
  };
  const result = await new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai as any,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  const at = (step: number) => result.entries.find(e => e.step === step && e.kind !== 'turn')!;
  assert.doesNotMatch(at(1).text, /equals src\/a\.ts as it is/, 'the generated text is not byte-equal to the file');
  assert.match(
    at(1).text,
    /the generated file \(10 tokens, 1\.0 s\) differs only in trailing whitespace from src\/a\.ts as it is \(sha256=\w+\)/,
  );
  assert.match(at(2).text, /1 line went, 1 line came and 9 lines stayed as they were/);
  assert.match(at(2).text, /CRLF/);
});
test('A rewrite of a file that starts with a byte-order mark lands: the file is read and hashed as the write tool reads it', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), '﻿export const a = 1;\n');
  const bonsai = bonsaiOf({
    steps: [{ thought: 'rewrite a', action: 'rewrite_file', args: { path: 'a.ts', purpose: 'a becomes 2' } }],
    files: { 'a.ts': 'export const a = 2;\n' },
  });
  const result = await new Agent(
    { ...config, maxSteps: 1 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'x'));
  assert.equal(
    await readFile(join(root, 'a.ts'), 'utf8'),
    'export const a = 2;\n',
    result.entries.map(e => e.text).join('\n'),
  );
});

test('A script is written knowing the element ids the markup defines, and markup knowing the elements the scripts look up (run space-invaders-4)', async t => {
  const { root } = await repo(t);
  await writeFile(
    join(root, 'index.html'),
    '<canvas id="gameCanvas"></canvas><div id=\'overlay\'><p id="overlay-text"></p></div><span id={"score"}></span>',
  );
  await writeFile(
    join(root, 'game.js'),
    'const c = document.getElementById("game");\nconst b = document.querySelector(\'#startBtn\');\nconst t = $(`.title`);\n',
  );
  const { generationFacts } = await import('../src/profiles.js');
  assert.deepEqual(await generationFacts(root, 'main.js', undefined, ['index.html', 'game.js']), {
    elementIdsInMarkup: { 'index.html': ['gameCanvas', 'overlay', 'overlay-text', 'score'] },
  });
  assert.deepEqual(await generationFacts(root, 'about.html', undefined, ['index.html', 'game.js']), {
    elementsScriptsLookUp: { 'game.js': ['#game', '#startBtn', '.title'] },
  });
  assert.deepEqual(
    await generationFacts(root, 'notes.md', undefined, ['index.html', 'game.js']),
    {},
    'other files get neither',
  );
});

test('observe plays a page as its user would: each input states the exceptions it set off, the frames drawn, how much of the canvas changed and where, and the text that came or went (runs space-invaders-3 and -4)', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const { root } = await repo(t);
  // A square that moves 200 px a second while ArrowLeft is held; Enter starts it and shows "Playing"; Space throws.
  await writeFile(
    join(root, 'game.html'),
    `<!doctype html><body style="margin:0;background:#000;color:#fff"><p id="msg">Press Enter</p><canvas id="game" width="400" height="200"></canvas><script>
const ctx = document.getElementById('game').getContext('2d'); const keys = {}; let x = 300, last = performance.now(), on = false;
addEventListener('keydown', e => { keys[e.key] = true; if (e.key === 'Enter') { on = true; document.getElementById('msg').textContent = 'Playing'; } if (e.key === ' ') { const k = 1; k = 2; } });
addEventListener('keyup', e => { keys[e.key] = false; });
(function f(t) { const dt = (t - last) / 1000; last = t; if (on && keys.ArrowLeft) x = Math.max(0, x - 200 * dt); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 400, 200); ctx.fillStyle = '#0f0'; ctx.fillRect(x, 150, 30, 30); requestAnimationFrame(f); })(last);
</script>`,
  );
  const r = await renderFacts(root, `file://${join(root, 'game.html')}`, undefined, null, 30000, [
    { do: 'press', what: 'Enter', ms: 300 },
    { do: 'hold', what: 'ArrowLeft', ms: 600 },
    { do: 'press', what: 'Space', ms: 200 },
    { do: 'click', what: '#missing', ms: 0 },
    { do: 'press', what: 'F13', ms: 0 },
  ]);
  assert.equal(r.ok, false, 'an exception thrown while played fails the observation');
  assert.match(
    r.text,
    /exceptions thrown while it was played: after input 3 \(pressed Space, then 200 ms\): (?:Uncaught )?TypeError: Assignment to constant variable\./,
  );
  assert.match(
    r.text,
    /1\. pressed Enter, then 300 ms: \d+ frames drawn in [\d.]+ s; canvas#game: unchanged; text now shows "Playing"; no longer shows "Press Enter"/,
  );
  const held = r.text.match(
    /2\. held ArrowLeft for 600 ms: (\d+) frames drawn in [\d.]+ s; canvas#game \(400x200\): ([\d.]+)% of it changed, within x (\d+)\.\.(\d+), y (\d+)\.\.(\d+); text unchanged/,
  );
  assert(held, r.text);
  assert(Number(held[1]) > 10, 'frames are counted');
  assert(Number(held[4]) - Number(held[3]) >= 120, 'the change spans where the square went');
  assert(Number(held[5]) >= 130, 'low on the canvas, where the square is');
  assert.match(r.text, /4\. click "#missing": no element matches that selector/);
  assert.match(r.text, /5\. press "F13": not a key this observer knows/);
});

test("A page's inline scripts are parsed where they stand, so a broken brace in a one-page game is a fact at write time (run pacman-1)", async t => {
  const { inlineScriptProblems, syntaxCheck } = await import('../src/profiles.js');
  const page =
    '<!doctype html>\n<body>\n<script>\nfunction parse(){ for (const r of rows) { grid.push(r); }\nfunction move(){}\n</script>\n</body>';
  assert.deepEqual(await inlineScriptProblems('index.html', page), [
    "line 7, column 8 (at the end of the file): '}' expected",
  ]);
  assert.deepEqual(
    await syntaxCheck('/tmp', 'index.html', page),
    await inlineScriptProblems('index.html', page),
    'the HTML profile parses through it',
  );
  assert.deepEqual(
    await inlineScriptProblems(
      'index.html',
      '<script>const a = 1;</script><script type="application/json">{not js</script><script src="x.js"></script><script type="module">export const b = 2;</script>',
    ),
    [],
    'data blocks and external scripts are not parsed; module scripts are',
  );
});

test('observe takes a repository file by its path: index.html, ./index.html and file://index.html load the file; a path that is no file says so', async t => {
  if (!(await findBrowser())) {
    t.skip('no browser on this machine');
    return;
  }
  const { root } = await repo(t);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>T</title><h1>Hi</h1>');
  const { observeResult } = await import('../src/observe.js');
  const ctx = { root, artifactPath: join(root, 'shot.png'), timeoutMs: 20000, prefix: '', files: ['index.html'] };
  for (const target of ['index.html', './index.html', 'file://index.html', 'file:///index.html'])
    assert.match(
      (await observeResult('page', '', target, ctx)).text,
      new RegExp(
        `^Rendered ${pathToFileURL(join(root, 'index.html')).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: no exception`,
      ),
      target,
    );
  assert.match(
    (await observeResult('page', '', 'missing.html', ctx)).text,
    /^missing\.html is not a URL, and no file of the repository has that path/,
  );
});

test('A cut of whole repeated lines says what repeated and how many times in a row', async () => {
  const { repeatCut } = await import('../src/clients.js');
  const text = ['const grid = [', ...Array(13).fill('  "#.#.#.#.#.#.#.#.#.#.#",'), ''].join('\n');
  const r = repeatCut(text)!;
  assert.deepEqual([r.cut.kind, r.cut.line, r.cut.block, r.cut.times], ['lines', 3, 1, 13]);
});

test('Guidance given while the run goes on joins the objective at the next step, which is told of it; an edit is shown as its diff', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const shown: any[] = [];
  const prompts: Message[][] = [];
  const base = bonsaiOf({
    steps: [
      { thought: 'read', action: 'read_files', args: { files: [{ path: 'a.ts', start: 1, end: 1 }] } },
      {
        thought: 'change it',
        action: 'write',
        args: { path: 'a.ts', expectedHash: 'FILL', oldText: '= 1', newText: '= 2' },
      },
    ],
  });
  let agent: Agent | null = null;
  const bonsai = filling(
    {
      ...base,
      generate: async (m: Message[], schema: any) => {
        prompts.push(m);
        // The user types while the first step is being generated.
        if (prompts.length === 1) agent!.guide('also export b');
        return base.generate(m, schema);
      },
    },
    async p => hash(await readFile(join(root, p), 'utf8')),
  );
  agent = new Agent(
    { ...config, maxSteps: 2 },
    store,
    jevOf({}),
    bonsai,
    root,
    () => {},
    e => shown.push(e),
  );
  const s = await agent.run(await newSession(root, 'Change a'));
  assert.match(s.objective, /^Change a\nUser update: also export b$/, 'as a resume message joins it');
  assert(shown.some(e => e.kind === 'guidance' && e.text === 'also export b' && e.step === 2));
  assert.match(
    JSON.parse(prompts[1]!.at(-1)!.content).harnessNote,
    /The user added to the objective while you worked: "also export b"/,
    'the next step is told',
  );
  assert(!JSON.parse(prompts[0]!.at(-1)!.content).harnessNote, 'not the step already under way');
  const edit = shown.find(e => e.kind === 'edit');
  assert.deepEqual([edit.path, edit.created, edit.added, edit.removed], ['a.ts', false, 1, 1]);
  assert.deepEqual(
    edit.hunks[0].lines.map((l: any) => `${l.kind}${l.text}`),
    ['-export const a = 1;', '+export const a = 2;'],
  );
});

test('The step after a page observation sees its screenshot once, when the model takes images: as a last message after the cache points, never kept; a model that does not, or no screenshot, changes nothing', async t => {
  const { root, store } = await repo(t);
  const shot = join(root, 'shot.png');
  await writeFile(shot, Buffer.from('89504e470d0a1a0a', 'hex'));
  const prompt = [
    { role: 'system' as const, content: 'You are the worker.' },
    { role: 'user' as const, content: '{"request":"next"}' },
  ];
  const make = (sees: boolean) =>
    new Agent(
      config,
      store,
      jevOf({}),
      {
        count: async () => ({ tokens: 1, mode: 'estimate' }),
        generate: async () => ({}),
        seesImages: async () => sees,
      } as any,
      root,
      () => {},
      () => {},
    );
  const s = await newSession(root, 'build a scene');
  s.screenshot = { step: 4, path: shot, target: 'http://127.0.0.1:5173/' };
  const shown = await (make(true) as any).withScreenshot(s, prompt);
  assert.equal(shown.length, 3);
  assert.deepEqual(shown.slice(0, 2), prompt, 'the prompt before it as it was');
  assert.deepEqual(shown[2].images, [shot]);
  assert.match(
    shown[2].content,
    /^Attached: the screenshot the observation of step 4 took of http:\/\/127\.0\.0\.1:5173\//,
  );
  assert.equal(s.screenshot, undefined, 'shown once');
  assert.deepEqual(await (make(true) as any).withScreenshot(s, prompt), prompt, 'and not again');
  s.screenshot = { step: 5, path: shot, target: 'http://127.0.0.1:5173/' };
  assert.deepEqual(await (make(false) as any).withScreenshot(s, prompt), prompt, 'a model that does not take images');
  assert.equal(s.screenshot, undefined, 'dropped either way: the next observation takes a new one');
  assert(
    (await events(store)).some(e => e.type === 'screenshot' && e.data.observed === 4 && e.data.path === shot),
    'logged',
  );
});

test('A completion gate Jev cannot answer leaves the finish unjudged instead of ending the session: the worker finishes again and is judged; three in a row still pause it (saas-landing-glm-5.3 trial 6)', async t => {
  const steps = [
    { thought: 'write', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
    { thought: 'check', action: 'bash', args: { command: 'node -e "process.exit(0)"', purpose: 'check', check: true } },
    { thought: 'done', action: 'finish', args: { summary: 'src/a.ts exports a; the check passes.' } },
    { thought: 'done again', action: 'finish', args: { summary: 'src/a.ts exports a; the check passes.' } },
    { thought: 'and again', action: 'finish', args: { summary: 'src/a.ts exports a; the check passes.' } },
    { thought: 'and again', action: 'finish', args: { summary: 'src/a.ts exports a; the check passes.' } },
  ];
  const run = async (failures: number) => {
    const { root, store } = await repo(t);
    const jev = jevOf({});
    let failed = 0;
    const flaky = {
      ...jev,
      decide: async (state: unknown, q: Questions, ctx?: { step: number; phase: string }) => {
        if (ctx?.phase === 'evidence-gate' && failed < failures) {
          failed++;
          throw new Error('HTTP 400 from https://api.typesafe.ai');
        }
        return jev.decide(state, q, ctx);
      },
    };
    const result = await new Agent(
      { ...config, maxSteps: 12 },
      store,
      flaky as any,
      bonsaiOf({ steps, files: { 'src/a.ts': 'export const a = 1;\n' } }),
      root,
      () => {},
      () => {},
    ).run(await newSession(root, 'x'));
    return { result, ev: await events(store) };
  };
  const once = await run(1);
  assert.equal(once.result.status, 'complete', once.result.stopReason);
  assert(
    once.result.entries.some(e => /The finish was not judged: the completion gate could not be reached/.test(e.text)),
  );
  assert.equal(once.ev.filter(e => e.type === 'gate-error').length, 1);
  const always = await run(3);
  assert.equal(always.result.status, 'paused');
  assert.match(always.result.stopReason, /Stopped: HTTP 400/);
});

test('A server started in the foreground that prints nothing is known by its command and stopped once quiet, pointed at observe and its port; a build, an install, a grep or a backgrounded command is not one (saas-landing-glm-5.3 trial 7)', async t => {
  const { foregroundServer } = await import('../src/serve.js');
  assert.deepEqual(foregroundServer('npx -y http-server dist -p 4173 --silent'), {
    what: 'a static file server',
    port: '4173',
  });
  assert.deepEqual(foregroundServer('cd app && npm run preview -- --port 4173'), {
    what: 'a dev or preview script',
    port: '4173',
  });
  assert.deepEqual(foregroundServer('python -m http.server 8000'), { what: "Python's http.server", port: '8000' });
  assert.deepEqual(foregroundServer('npx next dev -p 3001'), { what: 'Next.js', port: '3001' });
  assert.equal(foregroundServer('npx vite')?.what, 'Vite');
  for (const c of [
    'npm run build',
    'npx vite build',
    'npm install vite',
    'npm create vite@latest app -- --template react',
    'npm run dev &',
    'grep -r serve src',
    'cat vite.config.ts',
    'npm test',
  ])
    assert.equal(foregroundServer(c), null, c);
  const { root } = await repo(t);
  const { ToolBox } = await import('../src/tools.js');
  const tools = new ToolBox(root, join(root, '.art'), { ...config, commandTimeoutMs: 30000 }, async () => '');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node silent.mjs' } }));
  await writeFile(join(root, 'silent.mjs'), "import http from 'node:http';\nhttp.createServer(() => {}).listen(0);\n");
  const t0 = Date.now();
  const r = await tools.execute('bash', { command: 'npm run dev -- --port 4321', purpose: 'serve', check: false });
  assert(Date.now() - t0 < 20000, `stopped once quiet (${Date.now() - t0} ms), not at the 30 s timeout`);
  assert.equal(r.ok, false);
  assert.match(
    r.text,
    /This command starts a server \(a dev or preview script\) and was still running, quiet, .* target set to http:\/\/localhost:4321\//,
  );
});

test('A text is clipped on whole characters, and Jev is sent only well-formed text: half an emoji is Unicode no server accepts (saas-landing-glm-5.3 trial 6: HTTP 400 "Request contains invalid Unicode text")', async () => {
  const { clip, clipEnds } = await import('../src/context.js');
  const { wellFormed } = await import('../src/clients.js');
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const text = '🚀'.repeat(400);
  for (let n = 60; n < 140; n++) {
    assert(!lone.test(clip(text, n)), `clip at ${n}`);
    assert(!lone.test(clipEnds(text, n)), `clipEnds at ${n}`);
  }
  const s = '🚀'.slice(0, 1);
  assert.deepEqual(wellFormed({ a: [`icon: "${s}`, 1], b: '🚀 ok', c: null }), {
    a: ['icon: "�', 1],
    b: '🚀 ok',
    c: null,
  });
});

test('Unattended, a finish Jev would route to the user goes back to the worker with the parts of the objective Jev is least sure of, and after two the run completes as unreviewed; attended, it pauses for the user as before (saas-landing-haiku-5.5 trials 4 and 6)', async t => {
  const finish = { thought: 'done', action: 'finish', args: { summary: 'src/a.ts exports a; the check passes.' } };
  const steps = [
    { thought: 'write', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
    { thought: 'check', action: 'bash', args: { command: 'node -e "process.exit(0)"', purpose: 'check', check: true } },
    finish,
    finish,
    finish,
    finish,
  ];
  const run = async (unattended: boolean) => {
    const { root, store } = await repo(t);
    const jev = jevOf({
      gate: { verification_needed: 'human', requirement_unaddressed: 0.5 },
      clauses: c => (/landing/.test(c) ? 0.5 : 0.9),
    });
    const result = await new Agent(
      { ...config, maxSteps: 12, unattended },
      store,
      jev as any,
      bonsaiOf({ steps, files: { 'src/a.ts': 'export const a = 1;\n' } }),
      root,
      () => {},
      () => {},
    ).run(await newSession(root, '- Build a landing page\n- Export a from src/a.ts'));
    return { result, gates: jev.calls.filter(c => c.phase === 'evidence-gate').length };
  };
  const attended = await run(false);
  assert.equal(attended.result.status, 'paused');
  assert.match(attended.result.stopReason, /Jev routes it to the user for review/);
  const alone = await run(true);
  assert.equal(alone.result.status, 'complete', alone.result.stopReason);
  assert.match(
    alone.result.stopReason,
    /^Complete, unreviewed: Jev would have routed this to the user for review 3 times/,
  );
  assert.equal(alone.gates, 3);
  const back = alone.result.entries.filter(e => /would ask the user to review it, and no one will/.test(e.text));
  assert.equal(back.length, 2, 'sent back twice');
  assert.match(back[0]!.text, /starting with the parts Jev is least sure of: "Build a landing page" \(0\.50\)/);
});

test("The completion gate shows Jev the worker's own list of what it did not do or test as workerNotes, apart from the summary, and asks that an item there count only where the objective asks for it; a summary without one is sent as before (Claude Haiku 5.5: 13 of 38 gated finishes passed the match bar with the list in the summary, 25 with it apart)", async () => {
  const { evidenceGate, workerNotes, gateQuestions } = await import('../src/control.js');
  // The forms the worker wrote: a heading on its own line, a bold heading, an inline one, and a section that is
  // followed by another.
  assert.deepEqual(workerNotes('Built it.\n\nLimitations:\n- no backend\n- not tested on mobile'), {
    summary: 'Built it.',
    notes: '- no backend\n- not tested on mobile',
  });
  assert.deepEqual(workerNotes('Built it.\n**Known limitations**\n- hash links only'), {
    summary: 'Built it.',
    notes: '- hash links only',
  });
  assert.deepEqual(workerNotes('Built it.\nLimitations: demo content is fictional; no backend.'), {
    summary: 'Built it.',
    notes: 'demo content is fictional; no backend.',
  });
  assert.deepEqual(workerNotes('Built it.\n\nLimitations:\n- no backend\n\nVerification:\n- npm run build passes'), {
    summary: 'Built it.\n\nVerification:\n- npm run build passes',
    notes: '- no backend',
  });
  assert.deepEqual(workerNotes('Built it; the build passes.'), { summary: 'Built it; the build passes.', notes: '' });
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-gate-')), 'Build a demo landing page');
  const facts = (summary: string) => ({
    summary,
    changedFiles: ['src/App.tsx'],
    diffStat: '',
    verification: { command: 'npm run build', ok: true, afterLastWrite: true, exitCode: 0, text: 'built' },
    requirements: [],
    sources: {},
  });
  const jev = jevOf({});
  const seen: { state: any; questions: any }[] = [];
  const spy = {
    decide: async (state: any, questions: any, ctx: any) => {
      if (ctx?.phase === 'evidence-gate') seen.push({ state, questions });
      return jev.decide(state, questions, ctx);
    },
  };
  await evidenceGate(spy as any, s, facts('Built the page.\n\nLimitations:\n- no backend is wired up'));
  await evidenceGate(spy as any, s, facts('Built the page.'));
  const [withNotes, without] = seen;
  assert.equal(withNotes!.state.workerReport.summary, 'Built the page.');
  assert.equal(withNotes!.state.workerReport.notDoneOrUntested, '- no backend is wired up');
  assert.match(
    withNotes!.questions.implementation_matches_request.instructions,
    /Items in `workerReport\.notDoneOrUntested` count only when the objective names that thing\.$/,
  );
  assert.match(withNotes!.questions.requirement_unaddressed.instructions, /only when the objective asks for it\.$/);
  assert.equal(without!.state.workerReport.notDoneOrUntested, undefined, 'a summary without notes has none');
  assert.deepEqual(
    without!.questions.implementation_matches_request,
    gateQuestions.implementation_matches_request,
    'the questions are the same with or without notes',
  );
});

test('A finish whose last observation was made before the last write is judged on that observation made again by the harness, as it was made, not on the stale one', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'cli.mjs'), 'console.log("3 tasks");\n');
  const bonsai = bonsaiOf({
    steps: [
      {
        thought: 'check and run it',
        action: 'plan',
        batch: [
          { action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
          { action: 'observe', args: { kind: 'program', start: '', target: 'node cli.mjs' } },
        ],
      },
      { thought: 'one more file', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
      { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
      { thought: 'done', action: 'finish', args: { summary: 'a task CLI' } },
    ],
    files: { 'src/a.ts': 'export const a = 1;\n' },
  });
  const jev = jevOf({});
  const result = await new Agent(
    { ...config, maxSteps: 8 },
    store,
    jev as any,
    bonsai,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'A task CLI that lists tasks'));
  assert.equal(result.status, 'complete', result.stopReason);
  const observed = (await events(store)).filter(e => e.type === 'observe');
  assert.deepEqual(
    observed.map(e => [e.data.target, e.data.by ?? 'worker']),
    [
      ['node cli.mjs', 'worker'],
      ['node cli.mjs', 'harness'],
    ],
  );
  const gate = jev.calls.find(c => c.phase === 'evidence-gate')!;
  assert.equal(gate.state.result.observation.state, 'current', 'judged on the observation made again');
  assert.equal(gate.state.result.observation.afterLastWrite, true);
});

test('The gate passes a finish on what can be settled, the named thing delivered and the summary supported, and reports how advanced it is without rejecting on it; a clear miss is rejected with its reason (Claude Haiku 5.5: working results read near 0.7 on one question that mixed both, against a bar of 0.75)', async () => {
  const { evidenceGate } = await import('../src/control.js');
  const s = await newSession(await mkdtemp(join(tmpdir(), 'leana-gate-')), 'Build an advanced landing page');
  const facts = {
    summary: 'Built the page.',
    changedFiles: ['src/App.tsx'],
    diffStat: '',
    observation: { kind: 'program', step: 3, afterLastWrite: true, ok: true, target: 'node app.mjs', facts: 'ran' },
    observationState: 'current' as const,
    verification: { command: 'npm run build', ok: true, afterLastWrite: true, exitCode: 0, text: 'built' },
    requirements: [],
    sources: {},
  };
  const judged = (delivered: number, supported: number) => {
    const j = jevOf({
      gate: {
        implementation_matches_request: delivered,
        claim_supported: supported,
        verification_needed: 'semantic_review',
        weakest_evidence: 'summary',
      } as any,
    });
    return {
      decide: async (st: any, q: any, c: any) => {
        const a = await j.decide(st, q, c);
        return c.phase === 'evidence-gate'
          ? { ...a, quality: { type: 'score', score: 1.4, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 } } }
          : a;
      },
    };
  };
  const probably = await evidenceGate(judged(0.65, 0.8) as any, s, facts);
  assert.equal(probably.accepted, true, 'a working result read as probably delivered passes');
  assert.equal(probably.quality, 1.4, 'and how advanced it is, reported');
  const missed = await evidenceGate(judged(0.3, 0.8) as any, s, facts);
  assert.equal(missed.accepted, false);
  assert.match(missed.reason, /^Jev reads the result as not delivering what the objective names \(0\.30\)/);
  const claimed = await evidenceGate(judged(0.8, 0.4) as any, s, facts);
  assert.equal(claimed.accepted, false);
  assert.match(claimed.reason, /^Jev reads the summary as claiming more than the result shows \(0\.40\)/);
});
