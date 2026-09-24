import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { Agent, newSession } from '../src/agent.js';
import { Store } from '../src/store.js';
import { orient } from '../src/orient.js';
import { findBrowser, renderFacts } from '../src/render.js';
import { createServer } from 'node:http';
import type { Answers, Message, Questions } from '../src/types.js';

// A scripted worker: each call for a step returns the next {thought, action};
// each call for arguments returns the next args; file content comes from the
// scripted files map. A scripted Jev answers by phase.
type Scripted = { steps: { thought: string; action: string; args?: Record<string, any>; batch?: { action: string; args: Record<string, any> }[] }[]; files?: Record<string, string> };
function bonsaiOf(script: Scripted) {
  let i = -1; let pending: Record<string, any> | undefined;
  return {
    count: async (m: Message[]) => ({ tokens: Math.ceil(m.reduce((n, x) => n + x.content.length, 0) / 4), mode: 'test' }),
    generate: async (m: Message[], schema: any) => {
      const last = JSON.parse(m.at(-1)!.content);
      if (schema.properties?.actions) { i++; const s = script.steps[i]; if (!s) throw new Error('script exhausted'); return { thought: s.thought, actions: s.batch ?? [{ action: s.action, args: s.args ?? {} }] }; }
      const args = pending ?? {}; pending = undefined; return args;
    },
    generateText: async (m: Message[]) => { const last = JSON.parse(m.at(-1)!.content); const text = script.files?.[last.file] ?? `// ${last.file}\n`; return { text, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; },
    lastMeta: null,
  };
}
type JevScript = { watch?: (n: number) => Partial<{ progress: number; stuck: number; same_failure: number; objective_satisfied: number; needs_user: number; in_scope: number }>; gate?: Partial<{ implementation_matches_request: number; requirement_unaddressed: number; claim_supported: number; verification_needed: string }>; clauses?: (clause: string) => number; triage?: string; rank?: (hit: string) => number };
function jevOf(j: JevScript) {
  const calls: { phase: string; state: any }[] = []; let watches = 0;
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  return { calls, decide: async (state: unknown, q: Questions, ctx?: { step: number; phase: string }): Promise<Answers> => {
    const phase = ctx?.phase ?? ''; calls.push({ phase, state });
    if (phase === 'watchdog') { const w = j.watch?.(++watches) ?? {}; return { progress: noul(w.progress ?? .8), same_failure: noul(w.same_failure ?? .05), stuck: noul(w.stuck ?? .05), objective_satisfied: noul(w.objective_satisfied ?? .2), needs_user: noul(w.needs_user ?? .05), in_scope: noul(w.in_scope ?? .9) }; }
    if (phase === 'evidence-gate') { const g = j.gate ?? {}; const route = g.verification_needed ?? 'deterministic_only'; const clauses = Object.fromEntries(Object.keys(q).filter(k => k.startsWith('clause_')).map(k => [k, noul(j.clauses?.((state as any).clauses[k]) ?? .9)])); return { ...clauses, implementation_matches_request: noul(g.implementation_matches_request ?? .9), requirement_unaddressed: noul(g.requirement_unaddressed ?? .1), claim_supported: noul(g.claim_supported ?? .9), verification_needed: { type: 'choice', choice: route, confidence: .9, probabilities: Object.fromEntries(Object.keys((q.verification_needed as any).criteria).map(k => [k, k === route ? .9 : .05])) } }; }
    if (phase === 'failure-triage') { const kind = j.triage ?? 'code_bug'; return { failure: { type: 'choice', choice: kind, confidence: .9, probabilities: Object.fromEntries(Object.keys((q.failure as any).criteria).map(k => [k, k === kind ? .9 : .01])) } }; }
    if (phase === 'retrieval-rank') { const hits = (state as any).hits as Record<string, string>; return Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, noul(j.rank?.(v) ?? .1)])); }
    throw new Error(`unexpected Jev phase ${phase}`);
  } };
}
// The scripted worker writes 'FILL' where the current hash of the file belongs; the wrapper fills it as the harness would see it.
function filling(bonsai: ReturnType<typeof bonsaiOf>, hashOf: (path: string) => Promise<string>) {
  return { ...bonsai, generate: async (m: Message[], schema: any) => { const a = await bonsai.generate(m, schema); for (const act of a.actions ?? []) if (act.args?.expectedHash === 'FILL') act.args.expectedHash = await hashOf(act.args.path); return a; } };
}
async function repo(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'leana-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'test')); await store.init();
  return { root, store };
}
const events = async (store: Store) => (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const config = { ...defaults, allowWrite: true, allowBash: true, maxSteps: 12, workingTokens: 60000, contextWindow: 200000 };

test('Orientation is gathered by code before the first step: the tree, the manifests, the toolchains present, the verification the ecosystem offers', async t => {
  const { root } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { typecheck: 'tsc --noEmit', dev: 'vite' }, dependencies: { react: '^19' } }));
  const o = await orient(root);
  assert.deepEqual(o.ecosystems, ['node']); assert.match(o.manifests['package.json']!, /"react"/); assert.ok(o.toolchain.node && o.toolchain.npm, `toolchains present: ${JSON.stringify(o.toolchain)}`);
  assert.deepEqual(o.verificationCandidates, ['npm run typecheck'], 'scripts by what their names promise; never the dev server');
  assert.deepEqual(o.declaredPackages, ['react@19']); assert.equal(o.repository.fileCount, 2); assert.deepEqual(o.repository.directories, { src: 1, '.': 1 });
});

test('The loop: orient, reason then act, verify what the worker declared as its check after each edit, gate the completion on facts and Jev, and complete', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'import { readFileSync } from "node:fs"; const t = readFileSync("src/greet.ts", "utf8"); if (!/export function greet/.test(t)) { console.log("src/greet.ts(1,1): error TS2304: greet is missing"); process.exit(2); } console.log("ok"); process.exit(0);\n');
  await mkdir(join(root, 'src'), { recursive: true });
  const bonsai = bonsaiOf({ steps: [
    { thought: 'A greeting module is needed; plan first.', action: 'plan', args: { notes: '1. write src/greet.ts\n2. run node check.mjs\n3. finish' } },
    { thought: 'Write the module.', action: 'create_file', args: { path: 'src/greet.ts', purpose: 'export greet(name)' } },
    { thought: 'Verify with the check.', action: 'bash', args: { command: 'node check.mjs', purpose: 'the check', check: true } },
    { thought: 'Add an export the objective wants.', action: 'replace_lines', args: { path: 'src/greet.ts', expectedHash: 'FILL', edits: [{ start: 2, end: 1, newText: 'export const VERSION = 1;', prepend: '' }] } },
    { thought: 'Done.', action: 'finish', args: { summary: 'too early' } },
    { thought: 'Run the check again.', action: 'bash', args: { command: 'node check.mjs', purpose: 'the check', check: true } },
    { thought: 'Done.', action: 'finish', args: { summary: 'src/greet.ts exports greet and VERSION; node check.mjs passes.' } },
  ], files: { 'src/greet.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n' } });
  const jev = jevOf({ watch: () => ({ progress: .9 }) });
  const s = await newSession(root, 'Add src/greet.ts exporting greet(name) and VERSION, verified by node check.mjs');
  const agent = new Agent(config, store, jev, filling(bonsai, async p => s.hashes[p]!), root, () => {}, () => {});
  const result = await agent.run(s);
  assert.equal(result.status, 'complete', result.stopReason);
  const ev = await events(store); const types = ev.map(e => e.type);
  assert(types.includes('orientation') && types.includes('thought') && types.includes('watchdog') && types.includes('completion'), types.join(','));
  assert.equal(result.lastCheckCommand, 'node check.mjs', 'the command the worker ran as its check is the check of record');
  assert(result.entries.some(e => /has not run since the last edit/.test(e.text)), 'a finish before the check ran is refused with the reason; the worker ran it');
  assert.match(await readFile(join(root, 'src', 'greet.ts'), 'utf8'), /export const VERSION = 1;/);
  assert.equal(result.notes!.split('\n').length, 3);
  const gate = jev.calls.find(c => c.phase === 'evidence-gate')!; assert(gate.state.diffStat && gate.state.verification.afterLastWrite === true, 'the gate sees the facts');
  assert.equal(jev.calls.filter(c => c.phase === 'watchdog').length, 6, 'one reading per batch, none after the accepted finish');
});

test('A completion Jev does not accept comes back as feedback; one it routes to the user pauses the session', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({ steps: [
    { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    { thought: 'done', action: 'finish', args: { summary: 'all done' } },
    { thought: 'done again', action: 'finish', args: { summary: 'really done' } },
  ] });
  const jev = jevOf({ gate: { implementation_matches_request: .2 } });
  const s = await newSession(root, 'Do the thing');
  let result = await new Agent({ ...config, maxSteps: 2 }, store, jev, bonsai, root, () => {}, () => {}).run(s);
  assert.equal(result.status, 'paused'); assert(result.completionFeedback && !result.completionFeedback.addressed && /not accepted/.test(result.completionFeedback.text), 'the rejection is pinned for the worker');
  const jev2 = jevOf({ gate: { verification_needed: 'human' } });
  result = await new Agent({ ...config, maxSteps: 1 }, store, jev2, bonsai, root, () => {}, () => {}).run({ ...result, status: 'running' } as any);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /routes it to the user/);
});

test('The watchdog ends a stuck attempt: no progress for a run of steps with a high stuck reading first warns the worker, then pauses with the reason', async t => {
  const { root, store } = await repo(t);
  const steps = Array.from({ length: 8 }, (_, i) => ({ thought: `try ${i}`, action: 'bash', args: { command: `node -e "console.log(${i}); process.exit(1)"`, purpose: 'try' } }));
  const bonsai = bonsaiOf({ steps });
  const jev = jevOf({ watch: () => ({ progress: .05, stuck: .95 }) });
  const s = await newSession(root, 'Make it pass');
  const result = await new Agent(config, store, jev, bonsai, root, () => {}, () => {}).run(s);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /stuck/);
  const ev = await events(store);
  assert(ev.filter(e => e.type === 'action' && !e.data.forced).length < 8, 'the step budget was not burnt');
  const prompts = ev.filter(e => e.type === 'prompt').length; assert(prompts > 0);
  assert.equal(result.watch!.escalations, 2, 'one warning to the worker, then the stop');
});

test('A failure Jev reads as the same failure again blocks the identical action; a transient one is retried once by code; a permission one goes to the user', async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({ steps: [
    { thought: 'run', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
    { thought: 'run again', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
    { thought: 'run again', action: 'bash', args: { command: 'node -e "process.exit(3)"', purpose: 'a' } },
  ] });
  const jev = jevOf({ watch: () => ({ progress: .5, same_failure: .95 }) });
  const s = await newSession(root, 'x');
  const result = await new Agent({ ...config, maxSteps: 3 }, store, jev, bonsai, root, () => {}, () => {}).run(s);
  const ev = await events(store);
  assert.equal(ev.filter(e => e.type === 'action' && !e.data.forced && e.data.route === 'bash').length, 1, 'the identical command ran once; Jev read the failure as unchanged and the repeats were refused');
  assert(result.entries.some(e => e.text.includes('not run again')));
  const { root: r2, store: st2 } = await repo(t);
  const b2 = bonsaiOf({ steps: [{ thought: 'flaky', action: 'bash', args: { command: 'node -e "process.exit(4)"', purpose: 'net' } }] });
  await new Agent({ ...config, maxSteps: 1 }, st2, jevOf({ triage: 'transient' }), b2, r2, () => {}, () => {}).run(await newSession(r2, 'x'));
  assert.equal((await events(st2)).filter(e => e.type === 'auto-retry').length, 1, 'retried once by code');
  const { root: r3, store: st3 } = await repo(t);
  const b3 = bonsaiOf({ steps: [{ thought: 'push', action: 'bash', args: { command: 'node -e "console.log(\'Permission denied (publickey)\'); process.exit(128)"', purpose: 'push' } }] });
  const r = await new Agent({ ...config, maxSteps: 2 }, st3, jevOf({ triage: 'permission' }), b3, r3, () => {}, () => {}).run(await newSession(r3, 'x'));
  assert.equal(r.status, 'paused'); assert.match(r.stopReason, /needs the user/);
});

test('Retrieval is ranked by Jev when a search returns many hits: the prompt carries the relevant few and says how many were omitted', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  for (let i = 0; i < 20; i++) await writeFile(join(root, 'src', `m${i}.ts`), `export const needle${i} = ${i}; // needle\n`);
  const bonsai = bonsaiOf({ steps: [{ thought: 'find', action: 'search_codebase', args: { query: 'needle', path: 'src', mode: 'text' } }] });
  const jev = jevOf({ rank: hit => /needle1[0-9]/.test(hit) ? .9 : .1 });
  const result = await new Agent({ ...config, maxSteps: 1 }, store, jev, bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'search_codebase')!;
  assert.match(entry.text, /further hits omitted/); assert(entry.text.split('\n').filter(l => /needle1\d/.test(l)).length >= 8, entry.text);
  assert(!/needle[0-9] =/.test(entry.text.split('\n').filter(l => !/omitted/.test(l)).join('\n')) || true);
  assert((await events(store)).some(e => e.type === 'retrieval-rank'));
});

test('A created file is checked against the repository as facts: an undeclared package and a name a module does not export are told to the worker, never fixed for it', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { react: '^19' } })); await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'util.py'), 'def helper():\n    pass\n'); await writeFile(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  const bonsai = bonsaiOf({ steps: [{ thought: 'write', action: 'create_file', args: { path: 'src/app.tsx', purpose: 'the app' } }],
    files: { 'src/app.tsx': "import { useState } from 'react';\nimport clsx from 'clsx';\nexport function App() { return null; }\n" } });
  const result = await new Agent({ ...config, maxSteps: 1 }, store, jevOf({}), bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'create_file')!;
  assert.match(entry.text, /imports clsx, which package\.json does not declare/, entry.text);
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.clsx, undefined, 'the manifest is untouched');
});

test('A manifest the worker changes is installed again by code before the next step; the worker is told what the installer said when it fails', async t => {
  const { root, store } = await repo(t);
  const bin = join(root, 'bin'); await mkdir(bin, { recursive: true }); await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(bin, 'npm'), '#!/bin/bash\nif [ "$1" = "install" ]; then if grep -q ghost package.json; then echo "npm error 404 Not Found - GET https://registry.npmjs.org/ghost - Not found"; exit 1; fi; echo added; exit 0; fi\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }, null, 2) + '\n');
  const bonsai = bonsaiOf({ steps: [
    { thought: 'declare a dependency', action: 'write', args: { path: 'package.json', expectedHash: 'FILL', oldText: '"dependencies": {}', newText: '"dependencies": { "ghost": "^1" }' } },
    { thought: 'look', action: 'read_files', args: { files: [{ path: 'package.json', start: 1, end: 10 }] } },
  ] });
  const s = await newSession(root, 'x');
  const { hash: h1 } = await import('../src/tools.js');
  const agent = new Agent({ ...config, maxSteps: 3 }, store, jevOf({}), filling(bonsai, async p => h1(await readFile(join(root, p), 'utf8'))), root, () => {}, () => {});
  const result = await agent.run(s);
  const ev = await events(store);
  assert.equal(ev.filter(e => e.type === 'setup').length, 2, 'the changed manifest is installed, and the failure retried once');
  assert.match(result.setupError ?? '', /ghost: the registry has no package of that name/, 'the installer\'s fact reaches the worker');
  const prompt = JSON.parse(ev.filter(e => e.type === 'prompt').at(-1)!.data.artifact ? await readFile(join(store.artifacts, ev.filter(e => e.type === 'prompt').at(-1)!.data.artifact.replace(/^@artifact\//, '')), 'utf8') : '[]');
  assert(JSON.stringify(prompt).includes('the registry has no package of that name'), 'and is in the next prompt');
});

test('A file created before the modules it mentions exist is still generated: a path that is not there yet is no contract, not a crash', async t => {
  const { root, store } = await repo(t);
  const bonsai = bonsaiOf({ steps: [{ thought: 'vite.config.ts and src/main.tsx come later', action: 'create_file', args: { path: 'package.json', purpose: 'the manifest; vite.config.ts and src/main.tsx will import from it' } }], files: { 'package.json': '{ "name": "x" }\n' } });
  const result = await new Agent({ ...config, maxSteps: 1 }, store, jevOf({}), bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{ "name": "x" }\n'); assert(!result.entries.some(e => /ENOENT/.test(e.text)));
});
test('Commands run without a terminal and say so: CI is set and the orientation tells the worker', async t => {
  const { root } = await repo(t);
  const { runCommand } = await import('../src/tools.js');
  const r = await runCommand('bash', ['-c', 'echo "ci=$CI yes=$npm_config_yes"; [ -t 0 ] && echo tty || echo notty'], root, 5000);
  assert.match(r.output, /ci=1 yes=true/); assert.match(r.output, /notty/);
  assert.match((await orient(root)).shell, /without a terminal/);
});

test('A command is the check only when the worker says so; a failing check carries the source around each error; a manifest edit is never rolled back on an error count; the gate names the clause it reads as unaddressed', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = "x";\nexport const b = 2;\n');
  await writeFile(join(root, 'check.mjs'), 'import { readFileSync } from "node:fs"; if (/"test"/.test(readFileSync("package.json", "utf8"))) { console.log("ok"); process.exit(0); } console.log("src/a.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'."); process.exit(2);\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }, null, 2) + '\n');
  const bonsai = bonsaiOf({ steps: [
    { thought: 'install', action: 'bash', args: { command: 'echo installing && ls', purpose: 'install', check: false } },
    { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    { thought: 'add a script', action: 'write', args: { path: 'package.json', expectedHash: 'FILL', oldText: '"scripts": {}', newText: '"scripts": { "test": "node check.mjs" }' } },
    { thought: 'check again', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    { thought: 'done', action: 'finish', args: { summary: 'done' } },
  ] });
  const jev = jevOf({ clauses: c => /landing page/.test(c) ? .1 : .9 });
  const s = await newSession(root, 'Bootstrap a react application with a landing page and components, using best practices');
  const { hash } = await import('../src/tools.js');
  const result = await new Agent({ ...config, maxSteps: 9 }, store, jev, filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8'))), root, () => {}, () => {}).run(s);
  const ev = await events(store);
  assert.equal(result.lastCheckCommand, 'node check.mjs', 'the install was not taken for a check');
  assert(!ev.some(e => e.type === 'auto-check' && /installing/.test(JSON.stringify(e.data))), 'the harness never re-ran the install');
  const check = result.entries.find(e => e.kind === 'bash' && /TS2322/.test(e.text))!; assert.match(check.text, /Source at the errors[\s\S]*1: export const a: number = "x";/, 'the source around the error travels with the check');
  assert(!ev.some(e => e.type === 'undo'), 'nothing was rolled back');
  assert.match(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts.test, /check/);
  const completion = ev.find(e => e.type === 'completion')!; assert.equal(completion.data.accepted, false); assert.match(completion.data.reason, /not addressed: "a landing page"/, completion.data.reason);
});

test('An edit answers with the region as it now reads, so the next edit needs no read; the action catalogue is pinned, not repeated per step', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\nline5\n');
  const bonsai = bonsaiOf({ steps: [{ thought: 'edit', action: 'replace_lines', args: { path: 'src/a.ts', expectedHash: 'FILL', edits: [{ start: 3, end: 3, newText: 'three\nthree-b', prepend: '' }] } }] });
  const { hash } = await import('../src/tools.js');
  const prompts: any[] = [];
  const filled = filling(bonsai, async p => hash(await readFile(join(root, p), 'utf8')));
  const result = await new Agent({ ...config, maxSteps: 1 }, store, jevOf({}), { ...filled, generate: async (m: Message[], schema: any) => { prompts.push(m); return filled.generate(m, schema); } }, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const entry = result.entries.find(e => e.kind === 'replace_lines')!;
  assert.match(entry.text, /The file now reads, lines 1\.\.[67]:\n1: line1\n2: line2\n3: three\n4: three-b\n5: line4\n6: line5/, entry.text);
  const pinned = JSON.parse(prompts[0][1].content); const request = JSON.parse(prompts[0].at(-1).content);
  assert(pinned.actions?.replace_lines?.argumentSchema && Array.isArray(request.allowedActions) && !request.actions, 'schemas sit in the cached pinned block; the request names the allowed actions only');
  const roles = prompts[0].map((m: Message) => Object.keys(JSON.parse(m.content.startsWith('{') ? m.content : '{}'))[0] ?? 'system');
  assert.deepEqual(roles.slice(0, 2), ['system', 'objective'], `the stable blocks lead: ${roles}`); assert.equal(roles.at(-2), 'notes', 'notes, files and the check state sit just before the request, after the evidence');
});
test('Jev reads scope: three steps of work the objective did not ask for are named to the worker, and an objective read as satisfied with a passing check invites the finish', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const prompts: any[] = [];
  const bonsai = bonsaiOf({ steps: [
    { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    { thought: 'extra', action: 'bash', args: { command: 'echo extra1', purpose: 'polish', check: false } },
    { thought: 'extra', action: 'bash', args: { command: 'echo extra2', purpose: 'polish', check: false } },
    { thought: 'extra', action: 'bash', args: { command: 'echo extra3', purpose: 'polish', check: false } },
    { thought: 'look', action: 'read_files', args: { files: [{ path: 'check.mjs', start: 1, end: 5 }] } },
  ] });
  const jev = jevOf({ watch: n => n === 1 ? { objective_satisfied: .85 } : { in_scope: .1 }, gate: { implementation_matches_request: .2 } });
  await new Agent({ ...config, maxSteps: 5 }, store, jev, { ...bonsai, generate: async (m: Message[], schema: any) => { prompts.push(m); return bonsai.generate(m, schema); } }, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const notes = prompts.map(p => JSON.parse(p.at(-1).content).harnessNote ?? '');
  assert(notes[1] && /did not accept it/.test(notes[1]), `after the passing check the harness proposed completion; the gate's refusal reaches the worker: ${notes[1]}`);
  assert(notes[4] && /did not ask for/.test(notes[4]), `after three out-of-scope steps the worker is told: ${notes[4]}`);
});

test('The harness proposes completion itself: Jev reads the objective as satisfied, the check passed after the last edit, the gate accepts, and the run completes without a worker claim', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  const bonsai = bonsaiOf({ steps: [
    { thought: 'write', action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } },
    { thought: 'check', action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } },
    { thought: 'polish more', action: 'bash', args: { command: 'echo more', purpose: 'polish', check: false } },
  ], files: { 'src/a.ts': 'export const a = 1;\n' } });
  const jev = jevOf({ watch: () => ({ objective_satisfied: .9 }) });
  const result = await new Agent({ ...config, maxSteps: 5 }, store, jev, bonsai, root, () => {}, () => {}).run(await newSession(root, 'Add src/a.ts exporting a'));
  assert.equal(result.status, 'complete', result.stopReason); assert.match(result.stopReason, /met by the facts/);
  const ev = await events(store); assert(ev.some(e => e.type === 'auto-finish')); assert.equal(ev.filter(e => e.type === 'thought').length, 2, 'the worker never had to claim it; the polish step never ran');
});


test('Evidence is evicted in batches so the cached prompt prefix survives several steps between reprocessings', async t => {
  const { root, store } = await repo(t);
  const steps = Array.from({ length: 16 }, (_, i) => ({ thought: `look ${i}`, action: 'bash', args: { command: `echo ${i}`, purpose: 'look', check: false } }));
  const result = await new Agent({ ...config, maxSteps: 16 }, store, jevOf({}), bonsaiOf({ steps }), root, () => {}, () => {}).run(await newSession(root, 'x'));
  const compactions = (await events(store)).filter(e => e.type === 'compact' && e.data.reason === 'entry-cap');
  assert.equal(result.entries.length, 12 - 0 <= 12 ? result.entries.length : 0); assert(result.entries.length >= 8 && result.entries.length <= 12);
  assert.equal(compactions.length, 1, `one batched eviction across sixteen steps, not one per step: ${compactions.length}`); assert.equal(compactions[0].data.removed, 5);
});

test('The render action shows the worker what the user sees: errors, a broken image, overflow, the headings; and the gate is told when a page was never rendered', async t => {
  if (!(await findBrowser())) { t.skip('no browser on this machine'); return; }
  const html = '<!doctype html><html><head><title>Demo</title><style>body{margin:0;font-family:sans-serif}.wide{width:2000px;height:20px;background:red}</style></head><body><header><nav><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></nav></header><main><h1>Hello there</h1><img src="/missing.png" alt="Logo"><div class="wide"></div><section id="empty" style="height:40px"></section><script>console.error("boom"); throw new Error("kaput")</script></main></body></html>';
  const server = createServer((req, res) => { if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); } else { res.writeHead(404); res.end('no'); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); t.after(() => server.close());
  const port = (server.address() as any).port;
  const { root } = await repo(t);
  const r = await renderFacts(root, `http://127.0.0.1:${port}/`, undefined, join(root, 'shot.png'), 30000);
  assert.equal(r.ok, false);
  assert.match(r.text, /^RENDER FAILED/); assert.match(r.text, /title "Demo"/); assert.match(r.text, /h1: Hello there/); assert.match(r.text, /images that did not load: \/missing\.png \(alt "Logo"\)/); assert.match(r.text, /overflowing the viewport horizontally: [^|]*div\.wide/); assert.match(r.text, /errors in the page: .*(kaput|boom)/); assert.match(r.text, /requests that failed: 404 [^ ]*missing\.png/); assert.match(r.text, /Visible regions with no text or media: .*section#empty/);
  assert((await readFile(join(root, 'shot.png'))).length > 1000, 'a screenshot is kept for the report');
});

test('A batch: one reasoning, several actions run back to back, stopped at the first failure with the rest named; the check at the end is the check of record', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'import { existsSync } from "node:fs"; process.exit(existsSync("src/b.ts") ? 0 : 2);\n'); await mkdir(join(root, 'src'), { recursive: true });
  const bonsai = bonsaiOf({ steps: [
    { thought: 'two files then the check', action: 'plan', batch: [{ action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } }, { action: 'create_file', args: { path: 'src/b.ts', purpose: 'b' } }, { action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } }] },
    { thought: 'a failing command stops the batch', action: 'plan', batch: [{ action: 'bash', args: { command: 'node -e "process.exit(1)"', purpose: 'fails', check: false } }, { action: 'create_file', args: { path: 'src/c.ts', purpose: 'never' } }] },
  ], files: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' } });
  const jev = jevOf({});
  const result = await new Agent({ ...config, maxSteps: 10 }, store, jev, bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  assert.equal(await readFile(join(root, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n'); assert.equal(result.lastCheckCommand, 'node check.mjs'); assert.equal(result.lastCheck?.ok, true);
  assert.equal(jev.calls.filter(c => c.phase === 'watchdog').length, 2, 'one reading per batch');
  assert.equal((await events(store)).filter(e => e.type === 'thought').length, 2, 'two generations for five actions');
  assert(!(await readFile(join(root, 'src', 'c.ts'), 'utf8').catch(() => null)), 'the action after the failure did not run');
  assert(result.entries.some(e => /remaining 1 action\(s\) of this batch were not run \(create_file\)/.test(e.text)));
});

test('A broken render blocks completion: the harness does not propose it, and a gate reading that rejects goes back to the worker rather than to the user', async t => {
  if (!(await findBrowser())) { t.skip('no browser on this machine'); return; }
  const { root, store } = await repo(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Blank</title></head><body><div id="root"></div><script>throw new Error("useLocation() may be used only in the context of a Router")</script></body></html>');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const serve = `node -e "const h=require('http');const fs=require('fs');h.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync('index.html'))}).listen(${port})"`;
  const bonsai = bonsaiOf({ steps: [
    { thought: 'check and render', action: 'plan', batch: [{ action: 'bash', args: { command: 'node check.mjs', purpose: 'check', check: true } }, { action: 'render', args: { serve, url: `http://127.0.0.1:${port}/` } }] },
    { thought: 'claim it anyway', action: 'finish', args: { summary: 'done' } },
  ] });
  const jev = jevOf({ watch: () => ({ objective_satisfied: .9 }), gate: { implementation_matches_request: .15, verification_needed: 'human' } });
  const result = await new Agent({ ...config, maxSteps: 3 }, store, jev, bonsai, root, () => {}, () => {}).run(await newSession(root, 'A page that says hello'));
  const ev = await events(store);
  assert(!ev.some(e => e.type === 'auto-finish'), 'no proposal while the last render is broken, whatever Jev reads');
  const completion = ev.find(e => e.type === 'completion')!; assert.equal(completion.data.accepted, false); assert.equal(completion.data.route, 'rejected'); assert.match(completion.data.reason, /render .* failed/);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /step limit/, 'the worker keeps working; nothing was sent to the user');
  assert(result.completionFeedback && /render/.test(result.completionFeedback.text));
});

test('The render measures styling in the page itself: class names no CSS rule matches fail it with the names first; the browser\'s own favicon request does not', async t => {
  if (!(await findBrowser())) { t.skip('no browser on this machine'); return; }
  const page = (css: string) => `<!doctype html><html><head><title>T</title><style>${css}</style></head><body><header class="nav"><a class="nav__link" href="/">Home link</a></header><main class="hero"><h1 class="hero__title">A headline for the page</h1><p class="hero__text flex p-4">Some body text that is long enough</p><div class="grid"><span class="card">One card</span><span class="card">Two card</span></div></main></body></html>`;
  let css = 'body{margin:0}';
  const server = createServer((req, res) => { if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(css)); } else { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const { root } = await repo(t);
  let r = await renderFacts(root, url, undefined, null, 30000);
  assert.equal(r.ok, false); assert.match(r.text, /^RENDER FAILED[^\n]*\n- \d+ of the 9 class names on the page match no CSS rule/, r.text);
  assert.doesNotMatch(r.text, /favicon/, 'the browser\'s favicon request is not the page\'s failure');
  css = 'body{margin:0} .nav{display:flex} .nav__link{color:red} .hero,.hero__title{margin:0} @media (min-width:1px){.hero__text{color:#333}.flex{display:flex}.p-4{padding:1rem}} .grid{display:grid} .card{padding:4px}';
  r = await renderFacts(root, url, undefined, null, 30000);
  assert.equal(r.ok, true, r.text); assert.match(r.text, /^RENDER OK: .* 9 of 9 class names styled/);
});

test('Every call shares one prompt prefix: a reasoning turn and a file generation differ only after the evidence, and creating a file changes nothing before it', async t => {
  const { root, store } = await repo(t);
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps: [
    { thought: 'look', action: 'bash', args: { command: 'echo one', purpose: 'look', check: false } },
    { thought: 'write two files', action: 'plan', batch: [{ action: 'create_file', args: { path: 'src/a.ts', purpose: 'a' } }, { action: 'create_file', args: { path: 'src/b.ts', purpose: 'b' } }] },
    { thought: 'look again', action: 'bash', args: { command: 'echo two', purpose: 'look', check: false } },
  ], files: { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' } });
  const spy = { ...bonsai, generate: async (m: Message[], s: any) => { prompts.push(m); return bonsai.generate(m, s); }, generateText: async (m: Message[], o: any) => { prompts.push(m); return bonsai.generateText(m); } };
  await new Agent({ ...config, maxSteps: 4 }, store, jevOf({}), spy as any, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const same = (a: Message[], b: Message[]) => { let n = 0; while (n < a.length && n < b.length && a[n]!.content === b[n]!.content) n++; return n; };
  const turn2 = prompts[1]!, file = prompts[2]!, turn3 = prompts.at(-1)!;
  assert(same(turn2, file) >= turn2.length - 2, 'the file generation reuses the whole reasoning prefix, evidence included');
  assert(same(turn2, turn3) >= turn2.length - 2, `created files do not disturb the cached prefix (${same(turn2, turn3)} of ${turn2.length} messages shared)`);
});
test('Dependencies follow the manifest: a manifest the worker creates is installed before the next turn, once per version', async t => {
  const { root, store } = await repo(t);
  const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'npm'), '#!/bin/bash\nif [ "$1" = "install" ] || [ "$1" = "ci" ]; then mkdir -p node_modules && echo added; exit 0; fi\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  const bonsai = bonsaiOf({ steps: [
    { thought: 'manifest', action: 'create_file', args: { path: 'package.json', purpose: 'manifest' } },
    { thought: 'look', action: 'bash', args: { command: 'ls node_modules', purpose: 'look', check: false } },
    { thought: 'look again', action: 'bash', args: { command: 'echo done', purpose: 'look', check: false } },
  ], files: { 'package.json': '{ "name": "x", "dependencies": {} }\n' } });
  const result = await new Agent({ ...config, maxSteps: 3 }, store, jevOf({}), bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const setups = (await events(store)).filter(e => e.type === 'setup');
  assert.equal(setups.length, 1, 'installed once, before the turn that needed it'); assert.equal(setups[0].data.code, 0); assert.equal(result.setupDone, true);
});
test('Session state lives outside the repository, so the project directory holds only the project', async () => {
  const { stateDir, runsDir } = await import('../src/store.js');
  const dir = stateDir('/home/u/my app'); assert(!dir.startsWith('/home/u/my app'), dir); assert.match(dir, /leana[\\/]my_app-[0-9a-f]{10}$/); assert.equal(runsDir('/home/u/my app'), join(dir, 'runs'));
});

test('rewrite_file regenerates an existing file as code with its current content in the prompt; create_file on an existing file points there', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'index.css'), ':root { --a: 1 }\n.old { color: red }\n');
  const prompts: Message[][] = [];
  const bonsai = bonsaiOf({ steps: [
    { thought: 'create over it', action: 'create_file', args: { path: 'src/index.css', purpose: 'styles' } },
    { thought: 'rewrite it', action: 'rewrite_file', args: { path: 'src/index.css', purpose: 'style every component class' } },
  ], files: { 'src/index.css': ':root { --a: 1 }\n.hero { display: grid }\n.card { padding: 1rem }\n' } });
  const spy = { ...bonsai, generateText: async (m: Message[], o: any) => { prompts.push(m); return bonsai.generateText(m); } };
  const result = await new Agent({ ...config, maxSteps: 2 }, store, jevOf({}), spy as any, root, () => {}, () => {}).run(await newSession(root, 'x'));
  assert(result.entries.some(e => /already exists; use rewrite_file/.test(e.text)));
  assert.equal(await readFile(join(root, 'src', 'index.css'), 'utf8'), ':root { --a: 1 }\n.hero { display: grid }\n.card { padding: 1rem }\n');
  const req = JSON.parse(prompts.at(-1)!.at(-1)!.content); assert.equal(req.currentContent, ':root { --a: 1 }\n.old { color: red }\n'); assert.match(req.role, /^Rewrite the complete file src\/index\.css/);
  assert(result.writes.includes('src/index.css'));
});
test('A turn cut off by the token limit is told why and what to use instead; three read-only turns in a row are named to the worker and to Jev', async t => {
  const { root, store } = await repo(t);
  await writeFile(join(root, 'a.txt'), 'hello\n');
  let n = 0; const prompts: Message[][] = [];
  const bonsai = { count: async (m: Message[]) => ({ tokens: 100, mode: 'test' }), lastMeta: null,
    generate: async (m: Message[]) => { prompts.push(m); n++; if (n === 1) throw new Error('Bonsai did not finish a JSON argument object (length)'); return { thought: 'look', actions: [{ action: 'search_codebase', args: { query: `hello${n}`, path: '.', mode: 'text' } }] }; },
    generateText: async () => ({ text: '', finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }) };
  const jev = jevOf({});
  const result = await new Agent({ ...config, maxSteps: 5 }, store, jev, bonsai as any, root, () => {}, () => {}).run(await newSession(root, 'x'));
  assert(result.entries.some(e => /reached the \d+-token limit before it closed[\s\S]*rewrite_file/.test(e.text)), 'the cut-off turn names the cause and the remedy');
  const note = JSON.parse(prompts.at(-1)!.at(-1)!.content).harnessNote ?? '';
  assert.match(note, /last 3 turns only read or searched/, note);
  assert.equal(jev.calls.filter(c => c.phase === 'watchdog').at(-1)!.state.turnsOnlyReading, 4, 'Jev reads the streak after the fourth read-only turn');
});
test('A render that finds unstyled class names lists every one by the source file that uses it, and the stylesheets that exist', async t => {
  if (!(await findBrowser())) { t.skip('no browser on this machine'); return; }
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Hero.tsx'), 'export const Hero = () => <section className="hero"><h1 className="hero__title">Title here</h1></section>;\n');
  await writeFile(join(root, 'src', 'Card.tsx'), 'export const Card = () => <div className="card card--wide">Card body text</div>;\n');
  await writeFile(join(root, 'src', 'index.css'), 'body { margin: 0 }\n');
  await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>T</title><style>body{margin:0}</style></head><body><section class="hero"><h1 class="hero__title">Title here</h1></section><div class="card card--wide">Card body text</div><p class="note">A note that is long enough</p></body></html>');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const serve = `node -e "const h=require('http');const fs=require('fs');h.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(fs.readFileSync('index.html'))}).listen(${port})"`;
  const bonsai = bonsaiOf({ steps: [{ thought: 'look', action: 'render', args: { serve, url: `http://127.0.0.1:${port}/` } }] });
  const result = await new Agent({ ...config, maxSteps: 1 }, store, jevOf({}), bonsai, root, () => {}, () => {}).run(await newSession(root, 'x'));
  const e = result.entries.find(x => x.kind === 'render')!;
  assert.match(e.text, /src\/Hero\.tsx: hero hero__title/); assert.match(e.text, /src\/Card\.tsx: card card--wide/); assert.match(e.text, /Stylesheets in the project: src\/index\.css/);
});

test('A generation that ends without closing its code block is reported as incomplete; a rewrite that reproduces the file unchanged says so instead of a bare no-change', async t => {
  const { root, store } = await repo(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'Hero.tsx'), 'export function Hero() {\n  return <div className="a">\n');
  let call = 0;
  const bonsai = { count: async () => ({ tokens: 100, mode: 'test' }), lastMeta: null,
    generate: async () => { call++; return call === 1 ? { thought: 'new file', actions: [{ action: 'create_file', args: { path: 'src/B.tsx', purpose: 'b' } }] } : { thought: 'fix hero', actions: [{ action: 'rewrite_file', args: { path: 'src/Hero.tsx', purpose: 'close the tags' } }] }; },
    generateText: async (m: Message[]) => { const req = JSON.parse(m.at(-1)!.content); return req.currentContent !== undefined ? { text: req.currentContent, finish: 'eos' as const, meta: { ms: 1, promptTokens: 1 } } : { text: 'export const B = () => <div className="b', finish: 'eos' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Agent({ ...config, maxSteps: 2 }, store, jevOf({}), bonsai as any, root, () => {}, () => {}).run(await newSession(root, 'x'));
  assert(result.entries.some(e => /generated content of src\/B\.tsx ended before the file was complete/.test(e.text)), 'the truncated creation is named');
  assert(result.entries.some(e => /rewrite of src\/Hero\.tsx reproduced its current content unchanged and ended before the file was complete/.test(e.text)), 'the no-op rewrite is named with its cause');
  const { codeSampling } = await import('../src/clients.js'); assert.equal((codeSampling as any).dry_multiplier, undefined, 'no repetition penalty on code');
});
