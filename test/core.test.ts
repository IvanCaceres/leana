import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults as baseDefaults, loadConfig } from '../src/config.js';
// The onset ledger makes a generation the older call-order stubs do not expect; tests enable it explicitly.
const defaults = { ...baseDefaults, ledger: false };
import { Bonsai, Jev, postJson, repetitionStart, validateAnswers } from '../src/clients.js';
import { createFileMessages, fenceFor, SYSTEM, focusedMessages, rewriteRegionMessages, trimContext, pinnedBlock, compactNames, confidentChoice, decisionState, evictOne, mergeCoverage, messages, promptFields, relevantFiles, repoOverview, checkDelta, routeDescriptions, routeQuestions, staleFor } from '../src/context.js';
import { newSession, Runner, updateTasks } from '../src/runner.js';
import { referenceContext, rememberReferences, scopes } from '../src/references.js';
import { unaccountedFiles, auditQuestions, auditVerdict, candidates, commandLike, completionEvidence, decideStep, readyToFinish, runnableForever, stepQuestions, taskRecord } from '../src/decide.js';
import { designFrom, anchorPath, candidatesFrom, checkCandidates, checkSchema, completionQuestions, configLike, contractsFor, creationOrder, deriveDeliverables, diffChunks, exportNames, importContracts, ledgerQuestions, ledgerSchema, missingExports, parseDesign, readyCreates, refreshLedger, structuralDiff, trialFacts, usageOf, usageSnippets } from '../src/ledger.js';
import { dirtySessionConflict } from '../src/cli.js';
import { extractCode, focusedEditSchema, samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { collectSteps, renderReport, speed } from '../src/report.js';
import { Display, describe, generationSpeed } from '../src/display.js';
import { addPackagesCommand, aliasImportBinding, manifestFailures, missingDependencies, missingPackages, installCommand, repositoryStatus, readOnlyCommand, checkUnusable, movePlan, namedIdentifiers, removeImportBindings, checkAdvice, assertBalancePreserved, completionSource, hash, importInsertLine, runCommand, safePath, sourceHashes, StaleWriteError, stripLiterals, ToolBox, summarizeCheck, resolveMissingNames, syntaxErrors, regression, assertNoBulkDuplication, dropDuplicateImports, exportedSignatures, importCandidates, relativeImports, statementBounds } from '../src/tools.js';
import type { Answers, Questions } from '../src/types.js';

const noop = async () => {};
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'leana-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'test')); await store.init();
  return { root, store, session: await newSession(root, 'Fix the bounded test fixture and verify it.') };
}
function answersFor(q: Questions, route = 'read_files', complete = .99): Answers {
  return Object.fromEntries(Object.entries(q).map(([id, question]) => [id, question.type === 'noul'
    ? { type: 'noul', noul: id === 'complete' || id === 'objective_met' || id.startsWith('supported_') || id.startsWith('implemented_') || id.startsWith('required_') ? complete : .1 }
    : 'supports' in question.criteria ? { type: 'choice', choice: 'supports', confidence: 1, probabilities: { supports: complete, contradicts: 1 - complete, says_nothing: 0 } }
    : { type: 'choice', choice: route, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, k === route ? 1 : 0])) }])) as Answers;
}
test('Jev validates distribution, answer types, membership and finite probabilities', () => {
  const q: Questions = { r: { type: 'choice', instructions: 'route', criteria: { a: 'A', b: 'B' } }, n: { type: 'noul', instructions: 'yes?' } };
  const valid = { r: { type: 'choice', choice: 'a', probabilities: { a: .8, b: .2 }, confidence: .5 }, n: { type: 'noul', noul: .9 } };
  assert.deepEqual(validateAnswers(q, valid), valid);
  assert.throws(() => validateAnswers(q, { ...valid, n: { type: 'noul', noul: NaN } }));
  assert.throws(() => validateAnswers(q, { ...valid, r: { ...valid.r, choice: 'c' } }));
  assert.throws(() => validateAnswers(q, { ...valid, r: { ...valid.r, probabilities: { a: .4, b: .4 } } }));
  assert.equal((validateAnswers(q, { ...valid, r: { ...valid.r, choice: 'b' } }) as any).r.choice, 'a');
  assert.throws(() => validateAnswers(q, {}));
});
test('Routing uses choice probability and margin, not confidence as correctness', () => {
  assert.equal(confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: .51, b: .49 }, confidence: .99 }, defaults), null);
  assert.equal(confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: .8, b: .2 }, confidence: .3 }, defaults), 'a');
});
test('Configuration rejects impossible context reserves and unknown options', async () => {
  await assert.rejects(loadConfig(undefined, { contextWindow: 12000 }));
  await assert.rejects(loadConfig(undefined, { maxSteps: 2.5 }));
  await assert.rejects(loadConfig(undefined, { routeProbability: 1 }));
});
test('Jev HTTP request uses documented state/questions wire shape', async t => {
  let seen: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-test', answers: { ok: { type: 'noul', noul: .99 } } }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const c = { ...defaults, jevUrl: `http://127.0.0.1:${address.port}/v1/systemone` };
  const result = await new Jev(c, 'test-key', noop).decide({ evidence: 'passed' }, { ok: { type: 'noul', instructions: 'Passed?' } });
  assert.equal(result.ok?.type, 'noul');
  assert.equal(seen.auth, 'Bearer test-key'); assert.equal(seen.path, '/v1/systemone');
  assert.deepEqual(seen.body.state, { evidence: 'passed' }); assert.equal(seen.body.model, 'jev-latest');
});
test('HTTP retries transient responses but never retries authentication errors', async t => {
  let requests = 0; let status = 529;
  const server = createServer((_req, res) => {
    requests++;
    if (status === 529 && requests > 1) { res.end('{"ok":true}'); return; }
    res.statusCode = status; res.setHeader('retry-after', '0'); res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  assert.deepEqual(await postJson(url, {}, 'test', 1000), { ok: true }); assert.equal(requests, 2);
  status = 401; requests = 0; await assert.rejects(postJson(url, {}, 'test', 1000)); assert.equal(requests, 1);
});
test('Decision previews shrink to a byte cap even for multibyte source text', async t => {
  const { session } = await fixture(t);
  session.entries = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, step: i, kind: 'read', artifact: `${i}.txt`, text: '🪴'.repeat(3000), relevance: .5 }));
  const state = decisionState(session);
  assert(Buffer.byteLength(JSON.stringify(state)) <= 22000);
  assert(JSON.stringify(state).includes(session.objective));
});
test('Completion and disabled tools are omitted from available routes', async t => {
  const { session: s } = await fixture(t);
  s.lastWriteStep = 2; s.lastCheckStep = 1;
  const q = routeQuestions(s, defaults).route!;
  assert(q.type === 'choice');
  assert(!('finish' in q.criteria)); assert(!('write' in q.criteria)); assert(!('bash' in q.criteria));
});
test('Routing is phase-scoped and exposes deterministic exact files', async t => {
  const { session: s } = await fixture(t);
  s.knownFiles = ['README.md', 'src/index.mjs', 'test/behavior.test.mjs'];
  let route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice');
  assert(!('write' in route.criteria)); assert(!('bash' in route.criteria)); assert(!('finish' in route.criteria));
  const state = decisionState(s) as any;
  assert(!('files' in state) && !('directories' in state), 'routing state carries no file listings'); assert.equal(state.phase, 'inspect');
  s.phase = 'implement'; s.inspectionCount = 3;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria); assert('bash' in route.criteria); assert(!('finish' in route.criteria));
  assert.match(route.criteria.read_files!, /has not been read; 3 inspections/); assert.match(route.criteria.search_codebase!, /3 inspections/);
  s.writes = ['src/domain/price-order.mjs'];
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria); assert('bash' in route.criteria); assert(!('finish' in route.criteria));
  s.step = 5; s.lastRoute = 'bash'; s.lastResultOk = true; s.lastCheckStep = 4; s.lastWriteStep = 3;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria); assert(!('bash' in route.criteria)); assert.match(route.criteria.read_files!, /not yet in the evidence/); assert('finish' in route.criteria);
  s.lastRoute = 'write'; s.lastResultOk = false; s.lastWriteStale = true;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('write' in route.criteria)); assert('bash' in route.criteria); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria);
  s.lastWriteStale = false;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria); assert(!('tasks' in route.criteria)); assert('read_files' in route.criteria);
  s.writes = []; s.lastWriteStale = true;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('write' in route.criteria)); assert('bash' in route.criteria); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria);
  s.writes = ['src/domain/price-order.mjs'];
  s.lastResultOk = true; s.lastWriteStale = false;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('bash' in route.criteria); assert('write' in route.criteria); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria);
  s.step = 9; s.lastRoute = 'bash'; s.lastResultOk = true; s.lastCheckStep = 8; s.lastWriteStep = 7;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('bash' in route.criteria)); assert('write' in route.criteria); assert('read_files' in route.criteria); assert('finish' in route.criteria);
  s.lastRoute = 'tasks'; s.lastResultOk = true; s.phase = 'implement'; s.writes = [];
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('tasks' in route.criteria)); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria);
  s.phase = 'verify'; s.lastCheckStep = 4; s.lastWriteStep = 3;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('finish' in route.criteria); assert('write' in route.criteria); assert('read_files' in route.criteria); assert(!('search_codebase' in route.criteria)); assert(!('tasks' in route.criteria));
  route = routeQuestions(s, { ...defaults, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('write' in route.criteria)); assert('read_files' in route.criteria);
  s.lastCheckStep = 2;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert(!('finish' in route.criteria)); assert(!('write' in route.criteria)); assert(!('read_files' in route.criteria)); assert('bash' in route.criteria);
});
test('Schemas reject unknown arguments and unbounded reads/tasks', () => {
  assert.throws(() => validate(schemas.bash, { command: 'pwd', purpose: 'check', unsafe: true }));
  assert.throws(() => validate(schemas.read_files, { files: [] }));
  assert.throws(() => validate(schemas.tasks, { tasks: Array(13).fill({}) }));
});
test('llama grammar compatibility keeps runtime string limits intact, and content fields carry no cap', () => {
  const wire = samplingSchema(schemas.bash);
  assert.equal(wire.properties?.command?.maxLength, undefined);
  assert.equal(schemas.bash.properties?.command?.maxLength, 2000);
  assert.throws(() => validate(schemas.bash, { command: 'x'.repeat(2001), purpose: 'test' }), /string length 2001 exceeds the maximum 2000; shorten this field/);
  // Code and prose are never capped after generation: the grammar cannot enforce a length, so a cap on content is a rule that discards a finished generation.
  validate(schemas.move_lines, { source: 'a', expectedHash: 'h', start: 1, end: 2, destination: 'b', destinationHash: 'new', replacement: '', prefix: 'x'.repeat(16001) });
  validate(schemas.write, { path: 'a.ts', expectedHash: 'h', oldText: 'y'.repeat(700), newText: 'z'.repeat(30000) });
  validate(schemas.replace_lines, { path: 'a.ts', expectedHash: 'h', edits: [{ start: 1, end: 1, newText: 'n'.repeat(20000), prepend: '' }] });
  validate(schemas.finish, { summary: 's'.repeat(9000) });
  assert.deepEqual(Object.keys(schemas.create_file.properties!), ['path', 'purpose']); assert.deepEqual(Object.keys(focusedEditSchema.properties!), ['edits']);
});
test('Filesystem boundary rejects traversal, secrets and escaping symlinks', async t => {
  const { root } = await fixture(t);
  await symlink(tmpdir(), join(root, 'outside'));
  await assert.rejects(safePath(root, '../escape', true));
  await assert.rejects(safePath(root, 'outside/new', true));
  await assert.rejects(safePath(root, '.env'));
  await assert.rejects(safePath(root, '.git/config'));
});
test('Writes replace anchors in existing files; creation is create_file\'s alone, exclusive, validated after it lands', async t => {
  const { root, store } = await fixture(t);
  const path = join(root, 'a.ts'); await writeFile(path, 'one\ntwo\n');
  const args = { path: 'a.ts', expectedHash: hash('one\ntwo\n'), oldText: 'two', newText: 'three' };
  await assert.rejects(new ToolBox(root, store.artifacts, defaults).execute('write', args));
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  assert((await tools.execute('write', args)).ok); assert.equal(await readFile(path, 'utf8'), 'one\nthree\n');
  await assert.rejects(tools.execute('write', { ...args, expectedHash: 'new', oldText: '' }), (e: any) => e instanceof StaleWriteError && /not a hash/.test(e.message));
  await assert.rejects(tools.execute('write', { ...args, expectedHash: hash('one\nthree\n'), oldText: 'three', newText: 'three' }), /no change/);
  await assert.rejects(tools.execute('write', args), /Stale/);
  await assert.rejects(tools.execute('write', { ...args, expectedHash: hash('one\nthree\n'), oldText: '\n' }), /exactly once/);
  await assert.rejects(tools.execute('write', { path: 'missing.ts', expectedHash: 'h', oldText: 'a', newText: 'b' }), (e: any) => e instanceof StaleWriteError && /create_file/.test(e.message));
  await assert.rejects(tools.execute('create_file', { path: 'nested/', content: 'bad' }), /regular file path/);
  await assert.rejects(tools.execute('create_file', { path: 'nested/new.ts', content: '  \n' }), /no content/);
  const created = await tools.execute('create_file', { path: 'nested/new.ts', content: 'export const n = 1;\n' });
  assert(created.ok); assert.equal(await readFile(join(root, 'nested/new.ts'), 'utf8'), 'export const n = 1;\n');
  assert.deepEqual(created.snapshots, { 'nested/new.ts': '@new' }); assert.deepEqual(created.parseErrors, []); assert.deepEqual(created.imports, []);
  await assert.rejects(tools.execute('create_file', { path: 'nested/new.ts', content: 'again' }), (e: any) => !(e instanceof StaleWriteError) && /already exists/.test(e.message));
  // A created file is never refused for its shape: parse problems and relative imports are reported for the harness.
  const broken = await tools.execute('create_file', { path: 'src/B.tsx', content: 'import { X } from "./x";\nimport type { T } from "../types";\nimport "./b.css";\nexport const B = () => <div>\n' });
  assert(broken.ok); assert(broken.parseErrors!.length > 0); assert.deepEqual(broken.imports, [{ spec: './x', names: ['X'] }, { spec: '../types', names: ['T'], typeOnly: true }, { spec: './b.css', names: [] }]); assert.match(broken.text, /does not parse yet/);
  const json = await tools.execute('create_file', { path: 'tsconfig.json', content: '{ "compilerOptions": { "lib": ["ES2020" "DOM"] } }\n' });
  assert(json.ok); assert.match(json.parseErrors!.join(' '), /expected/);
  const jsonc = await tools.execute('create_file', { path: 'tsconfig.base.json', content: '{\n  // comments allowed\n  "compilerOptions": { "strict": true },\n}\n' });
  assert.deepEqual(jsonc.parseErrors, []);
});
test('Read ranges, artifact retrieval and literal search work without shell permission', async t => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'literal .* string\nnext');
  const tools = new ToolBox(root, store.artifacts, defaults);
  const read = await tools.execute('read_files', { files: [{ path: 'a.ts', start: 1, end: 1 }] });
  assert(read.text.includes('sha256=')); assert(!read.text.includes('2: next'));
  assert((await tools.execute('search_codebase', { mode: 'text', path: '.', query: '.*' })).text.includes('literal'));
  const artifact = await store.artifact(1, 'retained');
  assert((await tools.execute('read_files', { files: [{ path: artifact, start: 1, end: 1 }] })).text.includes('retained'));
  assert((await tools.execute('search_codebase', { mode: 'text', path: '@artifacts', query: 'retained' })).text.includes('00001.txt'));
  assert((await tools.execute('read_files', { files: [{ path: 'a.ts', start: 1, end: 300 }] })).text.includes('shown=1..2'), 'an oversized range is clamped, not refused');
  await assert.rejects(tools.execute('read_files', { files: [{ path: 'test/*.test.mjs', start: 1, end: 2 }] }), /exact regular file paths/);
});
test('Long source lines cannot create unbounded read results and invalid UTF-8 is rejected', async t => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'long.txt'), 'x'.repeat(100000));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  const tools = new ToolBox(root, store.artifacts, defaults);
  const result = await tools.execute('read_files', { files: [{ path: 'long.txt', start: 1, end: 1 }] });
  assert(result.text.length < 20200); assert(result.text.includes('truncated'));
  await assert.rejects(tools.execute('read_files', { files: [{ path: 'invalid.txt', start: 1, end: 1 }] }));
});
test('Repeated identical tool results pause rather than creating an infinite loop', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'same.txt'), 'unchanged');
  const bonsai = { count: async () => ({ tokens: 100, mode: 'test' }),
    generate: async () => ({ files: [{ path: 'same.txt', start: 1, end: 1 }] }) };
  const offered: string[][] = [];
  const jev = { decide: async (_s: unknown, q: Questions) => { offered.push(Object.keys((q.route as any).criteria)); return answersFor(q, 'read_files'); } };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  // step 1 runs; 2 and 3 fail as repeats; step 4 is routed without read_files, so Jev's read_files answer is uncertain and the session pauses.
  assert.equal(result.status, 'paused'); assert.equal(result.step, 4); assert.match(result.stopReason, /route is uncertain/);
  assert.deepEqual(result.entries.map(e => e.kind), ['read_files', 'generation_error', 'generation_error']);
  assert(offered[2]!.includes('read_files')); assert(!offered[3]!.includes('read_files')); assert(offered[3]!.includes('search_codebase'));
});
test('Commands have enforced time/output caps and no inherited API credentials', async t => {
  const { root } = await fixture(t);
  const output = await runCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(100000))'], root, 3000, 1000);
  assert(output.truncated); assert.equal(Buffer.byteLength(output.output), 1000);
  const timeout = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 50);
  assert(timeout.timedOut);
  process.env.LEANA_TEST_SECRET = 'hidden';
  try {
    const env = await runCommand(process.execPath, ['-e', 'console.log(process.env.LEANA_TEST_SECRET ?? "absent")'], root, 1000);
    assert.equal(env.output.trim(), 'absent');
  } finally { delete process.env.LEANA_TEST_SECRET; }
});
test('Successful validation commands count as checks while diagnostics do not', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'check.test.mjs'), "import test from 'node:test'; test('ok', () => {});\n");
  const tools = new ToolBox(root, join(root, '.artifacts'), { ...defaults, allowBash: true });
  const check = await tools.execute('bash', { command: 'node --test check.test.mjs', purpose: 'Run focused validation.' });
  assert.equal(check.ok, true); assert.equal(check.check, true);
  const diagnostic = await tools.execute('bash', { command: 'pwd', purpose: 'Inspect the current directory.' });
  assert.equal(diagnostic.ok, true); assert.equal(diagnostic.check, false);
  const maskedFailure = await tools.execute('bash', { command: 'printf output | (exit 7)', purpose: 'Confirm a failing pipeline is reported.' });
  assert.equal(maskedFailure.ok, false); assert.equal(maskedFailure.check, false);
});
test('Task ledger cannot silently drop unfinished work', async t => {
  const { session } = await fixture(t);
  updateTasks(session, [{ id: 'a', description: 'A', status: 'pending', evidence: '' }]);
  assert.throws(() => updateTasks(session, [{ id: 'b', description: 'B', status: 'pending', evidence: '' }]));
  assert.throws(() => updateTasks(session, [{ id: 'a', description: 'A', status: 'done', evidence: '' }]));
});
test('End-to-end orchestration executes only Jev-selected actions and persists completion', async t => {
  const { root, store, session } = await fixture(t); await writeFile(join(root, 'README.md'), 'Hello');
  let calls = 0;
  const jev = { decide: async (_state: unknown, q: Questions) => {
    const first = calls++ === 0;
    if (first) { session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; }
    return answersFor(q, first ? 'read_files' : 'finish');
  } };
  const bonsai = { count: async () => ({ tokens: 100, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.read_files
    ? { files: [{ path: 'README.md', start: 1, end: 10 }] } : { summary: 'Read README.' } };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'complete'); assert.equal(result.step, 2);
  assert.equal((await store.load()).status, 'complete'); assert.equal(result.entries.length, 1);
});
test('Hard prompt limit evicts evidence and never compacts the pinned objective', async t => {
  const { root, store, session } = await fixture(t);
  session.phase = 'verify'; session.lastCheckStep = 0; session.lastWriteStep = -1;
  session.entries = Array.from({ length: 5 }, (_, i) => ({ id: `e-${i}`, step: -i, kind: 'read', artifact: '', relevance: .1, text: 'x'.repeat(2000) }));
  const c = { ...defaults, workingTokens: 3500, maxSteps: 1 };
  const bonsai = { count: async (m: any) => ({ tokens: JSON.stringify(m).length, mode: 'test' }),
    generate: async (m: any) => { assert(JSON.stringify(m).includes(session.objective)); return { summary: 'done' }; } };
  const result = await new Runner(c, store, { decide: async (_s, q) => answersFor(q, 'finish') }, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'complete', result.stopReason); assert.equal(result.entries.length, 0);
});
test('Uncertain routing and API failure pause before generation or tools', async t => {
  const { root, store, session } = await fixture(t);
  const bonsai = { count: async () => { throw new Error('Must not run'); }, generate: async () => { throw new Error('Must not run'); } };
  const result = await new Runner(defaults, store, { decide: async () => { throw new Error('HTTP 401'); } }, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.equal(result.stopReason, 'HTTP 401'); assert.equal(result.entries.length, 0);
});
test('Malformed generated arguments are rejected by Bonsai before effects', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"command":"pwd"}' } }] }));
    else { res.statusCode = 404; res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const bonsai = new Bonsai({ ...defaults, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` }, 'local', noop);
  await assert.rejects(bonsai.generate([{ role: 'user', content: 'test' }], schemas.bash), /missing purpose/);
});

test('Reads are cut at line boundaries within the evidence budget and report the last line shown', async t => {
  const { root, store } = await fixture(t);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${'y'.repeat(60)}`);
  await writeFile(join(root, 'big.ts'), lines.join('\n'));
  const tools = new ToolBox(root, store.artifacts, { ...defaults, toolChars: 2000 });
  const one = await tools.execute('read_files', { files: [{ path: 'big.ts', start: 1, end: 200 }] });
  assert(one.text.length <= 2000);
  const shown = Number(one.text.match(/shown=1\.\.(\d+)/)?.[1]);
  assert(shown > 10 && shown < 200);
  assert(one.text.includes(`\n${shown}: line ${shown} `)); assert(!one.text.includes(`\n${shown + 1}: `));
  assert.match(one.text, new RegExp(`request lines ${shown + 1}\\.\\.200`));
  const tail = one.text.split('\n').at(-2)!;
  assert.match(tail, /y{60}$/);
  const three = await tools.execute('read_files', { files: [{ path: 'big.ts', start: 1, end: 100 }, { path: 'big.ts', start: 101, end: 150 }, { path: 'big.ts', start: 151, end: 200 }] });
  assert(three.text.length <= 2000); assert.equal(three.text.match(/sha256=/g)?.length, 3);
  const fits = await tools.execute('read_files', { files: [{ path: 'big.ts', start: 5, end: 6 }] });
  assert(fits.text.includes('shown=5..6')); assert(!fits.text.includes('truncated'));
  const beyond = await tools.execute('read_files', { files: [{ path: 'big.ts', start: 500, end: 501 }] });
  assert(beyond.text.includes('(no lines in range)'));
});
test('Write failures distinguish stale or unread targets from replacement mistakes', async t => {
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'alpha\nbeta\nbeta\n');
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const h = hash('alpha\nbeta\nbeta\n');
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: 'new', oldText: '', newText: 'x' }), (e: any) => e instanceof StaleWriteError);
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: hash('other'), oldText: 'alpha', newText: 'x' }), (e: any) => e instanceof StaleWriteError);
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: h, oldText: 'gamma', newText: 'x' }), (e: any) => !(e instanceof StaleWriteError) && /not found/.test(e.message));
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: h, oldText: 'beta', newText: 'x' }), (e: any) => !(e instanceof StaleWriteError) && /matches 2 times/.test(e.message));
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: h, oldText: 'alpha', newText: 'alpha' }), (e: any) => !(e instanceof StaleWriteError) && /newText equals oldText/.test(e.message));
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'alpha\nbeta\nbeta\n');
});
test('A successful write flags earlier reads of that file as stale without rewriting or dropping them', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowWrite: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'read_files', { ok: true, text: 'src/a.ts sha256=abc totalLines=1 shown=1..1\n1: one' });
  s.step = 2; await runner.evidence(s, 'read_files', { ok: true, text: 'src/b.ts sha256=def totalLines=1 shown=1..1\n1: two\n\nsrc/a.ts sha256=abc totalLines=1 shown=1..1\n1: one' });
  s.step = 3; await runner.evidence(s, 'read_files', { ok: true, text: 'src/c.ts sha256=ghi totalLines=1 shown=1..1\n1: three' });
  const before = messages(s, 'write');
  s.step = 4; await runner.evidence(s, 'write', { ok: true, changed: ['src/a.ts'], text: 'Updated src/a.ts; sha256=new' });
  assert.match(s.entries[0]!.stale!, /^edited at step 4: text and line numbers no longer match src\/a\.ts/); assert.equal(s.entries[0]!.text, 'src/a.ts sha256=abc totalLines=1 shown=1..1\n1: one'); assert.equal(s.entries[0]!.relevance, .1);
  assert(s.entries[1]!.stale); assert.equal(s.entries[2]!.stale, undefined); assert.equal(s.entries[2]!.relevance, .5);
  assert.equal(s.entries.length, 4);
  // the earlier prompt messages are byte-identical after the edit; the flag lives in the tail
  const after = messages(s, 'write');
  assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
  assert.deepEqual(Object.keys(JSON.parse(after.at(-1)!.content).staleEvidence), ['e1', 'e2']);
});

test('A passing check in verify lets Jev return to implementation instead of repeating the check', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  session.phase = 'verify'; session.writes = ['a.ts']; session.lastWriteStep = 1; session.lastCheckStep = 2; session.step = 2; session.inspectionCount = 3;
  const offered: string[][] = [];
  const jev = { decide: async (_s: unknown, q: Questions) => { offered.push(Object.keys((q.route as any).criteria)); return answersFor(q, 'write', .1); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }),
    generate: async () => ({ path: 'a.ts', expectedHash: hash('one\n'), oldText: 'one', newText: 'two' }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(offered[0]!.sort(), ['ask_user', 'bash', 'create_file', 'finish', 'move_lines', 'read_files', 'replace_lines', 'write']);
  assert.equal(result.phase, 'implement'); assert.equal(result.lastResultOk, true); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'two\n');
  assert.equal(result.lastWriteStep, 3); assert.equal(result.lastCheckStep, 2);
});
test('Stale write failures force a read while replacement mistakes keep write available', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  session.phase = 'implement'; session.inspectionCount = 3;
  const offered: string[][] = [];
  let attempt = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => { offered.push(Object.keys((q.route as any).criteria)); return answersFor(q, 'write', .1); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ++attempt === 1
    ? { path: 'a.ts', expectedHash: hash('one\n'), oldText: 'one', newText: 'one' }
    : { path: 'a.ts', expectedHash: 'new', oldText: '', newText: 'x' } };
  const result = await new Runner({ ...defaults, allowWrite: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /route is uncertain/);
  assert(offered[1]!.includes('write')); assert(!offered[1]!.includes('tasks'));
  assert.equal(offered.length, 4); assert(!offered[2]!.includes('write')); assert(offered[2]!.includes('read_files')); assert(offered[3]!.length <= 3);
  assert.equal(result.lastWriteStale, true);
});
test('The second identical action and result warns both models before the third pauses', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'same.txt'), 'unchanged');
  const seen: (string | null)[] = []; const prompts: string[] = [];
  // Different arguments (a growing end line on a one-line file) that produce the identical result.
  let end = 0;
  const bonsai = { count: async () => ({ tokens: 100, mode: 'test' }),
    generate: async (m: any) => { prompts.push(JSON.stringify(m)); return { files: [{ path: 'same.txt', start: 1, end: ++end }] }; } };
  const jev = { decide: async (state: any, q: Questions) => { seen.push(state.lastError); return answersFor(q, 'read_files'); } };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  // identical results: warning at 2, route withheld at 3 (Jev's read_files answer then fails routing), so the session pauses at step 4.
  assert.equal(result.status, 'paused'); assert.equal(result.step, 4); assert.match(result.stopReason, /route is uncertain/);
  // five decide calls: steps 1-4 plus the narrowed re-route at step 4.
  assert.deepEqual(seen.map(e => e === null ? null : /repeated an identical read_files action/.test(e)), [null, null, true, true, true]);
  assert.match(prompts[2]!, /Choose a different action or arguments/); assert.match(seen[3]!, /withheld until another action succeeds/);
  assert.equal(result.blockedRoute, 'read_files');
});
test('A finish vote goes to a concrete completion audit instead of being redirected into reads', async t => {
  const { root, store, session } = await fixture(t);
  session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; session.step = 1;
  const calls: { phase: string; state: any }[] = [];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    calls.push({ phase: ctx!.phase, state });
    if (ctx!.phase === 'routing-and-context') assert(!q.objective_met, 'completion is evaluated on the diff, not during routing');
    else { assert(q.objective_met, 'no deliverables listed: the objective as a whole is judged'); assert(q.scope_creep); }
    return answersFor(q, 'finish');
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => {
    assert.equal(schema, schemas.finish); return { summary: 'Verified the requested work.' };
  } };
  const result = await new Runner({ ...defaults, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(calls.map(c => c.phase), ['routing-and-context', 'completion-check']);
  assert(calls[1]!.state.evidence !== undefined, 'the audit sees per-deliverable evidence');
  assert.equal(result.status, 'complete'); assert.equal(result.entries.length, 0);
});

test('Repeated completion rejections return to inspection and allow later supported completion', async t => {
  const { root, store, session } = await fixture(t);
  session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; session.step = 1; session.writes = ['deps.ts'];
  await writeFile(join(root, 'deps.ts'), 'export const deps = 1;\n');
  const checks: any[] = [];
  let selected = 'finish';
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'completion-check') { checks.push({ state, q }); return answersFor(q, 'finish', checks.length < 3 ? .2 : .99); }
    selected = session.step === 3 ? 'read_files' : session.step === 5 ? 'search_codebase' : 'finish';
    if (selected !== 'finish') {
      assert.equal(state.phase, 'implement');
      assert.equal(state.completionFeedback.awaitingEvidence, true);
      assert(q.route?.type === 'choice');
      assert(!('finish' in q.route.criteria));
      assert('read_files' in q.route.criteria && 'search_codebase' in q.route.criteria);
    }
    return answersFor(q, selected, .99);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => selected === 'read_files'
    ? { files: [{ path: 'deps.ts', start: 1, end: 10 }] }
    : selected === 'search_codebase' ? { query: 'deps', path: '.', mode: 'text' }
    : { summary: 'Imported deps from cli.ts and verified.' } };
  const result = await new Runner({ ...defaults, maxSteps: 5 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(checks.length, 3);
  assert.match(checks[0].state.tasks, /worker claims/);
  assert.deepEqual(checks[0].state.changedFiles, ['deps.ts']); assert.equal(typeof checks[0].q.objective_met.instructions, 'string');
  assert.equal(result.status, 'complete');
  assert.equal(result.entries.filter(e => e.kind === 'finish_rejected').length, 2);
  assert.match(result.completionFeedback!.text, /Completion rejected \(objective met=0\.20/);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'action' && e.data.rejected === true && e.data.route === 'finish'));
});
test('A supported completion summary still finishes', async t => {
  const { root, store, session } = await fixture(t);
  session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; session.step = 1;
  const phases: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => { phases.push(ctx!.phase); return answersFor(q, 'finish', .95); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'Done.' }) };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'complete'); assert.deepEqual(phases, ['routing-and-context', 'completion-check']);
});

test('An incomplete but passing implementation continues through an edit and verification to completion', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'value.mjs'), 'export const value = 1;\n');
  s.objective = 'Change value to 2 and verify syntax.';
  s.phase = 'implement'; s.step = 1; s.lastCheckStep = 1;
  s.lastCheck = { step: 1, ok: true, text: 'syntax passed', summary: summarizeCheck('') };
  let selected = 'finish'; let audits = 0;
  const jev = { decide: async (_state: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx?.phase === 'completion-check') {
      audits++;
      const done = (await readFile(join(root, 'value.mjs'), 'utf8')).includes('value = 2');
      return answersFor(q, 'finish', done ? .99 : .2);
    }
    selected = s.step === 3 ? 'read_files' : s.step === 4 ? 'write' : 'finish';
    return answersFor(q, selected);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.read_files
    ? { files: [{ path: 'value.mjs', start: 1, end: 10 }] }
    : schema === schemas.write ? { path: 'value.mjs', expectedHash: s.hashes['value.mjs'], oldText: 'value = 1', newText: 'value = 2' }
    : { summary: s.step === 2 ? 'The syntax check passes but value is still 1.' : 'Changed value to 2 and verified syntax.' } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node --check value.mjs', maxSteps: 5 }, store, jev, bonsai, root, () => {}).run(s);
  assert.equal(result.status, 'complete', result.stopReason);
  assert.equal(audits, 2); assert.equal(result.lastWriteStep, 4); assert.equal(result.lastCheckStep, 5);
  assert.equal(await readFile(join(root, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
});

test('move_lines cuts a range into a new or existing file with hash checks and no retyping', async t => {
  const { root, store } = await fixture(t);
  const source = ['import a from "a";', 'const keep = 1;', 'interface Deps {', '  x: number;', '}', 'const DEFAULTS: Deps = {', '  x: 1,', '};', 'export { keep };', ''].join('\n');
  await writeFile(join(root, 'cli.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const base = { source: 'cli.ts', expectedHash: hash(source), start: 3, end: 8, destination: 'cli/deps.ts', destinationHash: 'new', replacement: 'import { DEFAULTS, type Deps } from "./cli/deps.js";', prefix: 'import type { X } from "../x.js";' };
  await assert.rejects(tools.execute('move_lines', { ...base, expectedHash: hash('other') }), (e: any) => e instanceof StaleWriteError);
  await assert.rejects(tools.execute('move_lines', { ...base, end: 40 }), /exceeds cli.ts/);
  await assert.rejects(tools.execute('move_lines', { ...base, destination: 'cli.ts' }), /must differ/);
  await assert.rejects(tools.execute('move_lines', { ...base, destinationHash: hash('x') }), (e: any) => e instanceof StaleWriteError && /destinationHash=new/.test(e.message), 'a missing destination still needs destinationHash=new');
  const moved = await tools.execute('move_lines', base);
  assert.deepEqual(moved.changed, ['cli.ts', 'cli/deps.ts']);
  const remaining = await readFile(join(root, 'cli.ts'), 'utf8');
  assert.equal(remaining, ['import a from "a";', 'const keep = 1;', 'import { DEFAULTS, type Deps } from "./cli/deps.js";', 'export { keep };', ''].join('\n'));
  const created = await readFile(join(root, 'cli/deps.ts'), 'utf8');
  // The extraction is completed by the harness: moved declarations are exported.
  assert.equal(created, ['import type { X } from "../x.js";', '', 'export interface Deps {', '  x: number;', '}', 'export const DEFAULTS: Deps = {', '  x: 1,', '};', ''].join('\n'));
  assert.match(moved.text, /Exported Deps, DEFAULTS/);
  assert(moved.text.includes(`cli.ts sha256=${hash(remaining)} totalLines=5`)); assert(moved.text.includes(`cli/deps.ts sha256=${hash(created)}`));
  await assert.rejects(tools.execute('move_lines', { ...base, expectedHash: hash(remaining), start: 2, end: 2 }), (e: any) => e instanceof StaleWriteError && /exists/.test(e.message));
  const appended = await tools.execute('move_lines', { ...base, expectedHash: hash(remaining), destinationHash: hash(created), start: 2, end: 2, replacement: '', prefix: 'ignored for existing files' });
  // keep is still re-exported by cli.ts, so the harness imports it from the destination; the prefix is ignored for an existing file.
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), ['import a from "a";', 'import { DEFAULTS, type Deps } from "./cli/deps.js";', 'import { keep } from "./cli/deps.js";', 'export { keep };', ''].join('\n'));
  assert.equal(await readFile(join(root, 'cli/deps.ts'), 'utf8'), `${created}\nexport const keep = 1;\n`);
  assert.match(appended.text, /cli\.ts now imports keep from the destination/);
  assert(appended.ok);
  await assert.rejects(new ToolBox(root, store.artifacts, defaults).execute('move_lines', base), /Writes disabled/);
});
test('move_lines is offered exactly where write is offered', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('move_lines' in route.criteria));
  s.phase = 'implement'; s.inspectionCount = 3;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('move_lines' in route.criteria); assert('write' in route.criteria);
  route = routeQuestions(s, defaults).route!;
  assert(route.type === 'choice'); assert(!('move_lines' in route.criteria));
  s.lastRoute = 'move_lines'; s.lastResultOk = false; s.lastWriteStale = true;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('move_lines' in route.criteria)); assert(!('write' in route.criteria)); assert('read_files' in route.criteria);
  s.phase = 'verify'; s.writes = ['a.ts']; s.lastWriteStep = 3; s.lastCheckStep = 4; s.lastRoute = 'bash'; s.lastResultOk = true;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert.match(route.criteria.move_lines!, /return to implementation/);
  assert(schemas.move_lines.required!.includes('destinationHash'));
});
test('Both models receive a relevance-ranked file subset, a directory overview and read coverage instead of the raw listing', async t => {
  const { session: s } = await fixture(t);
  s.objective = 'Read docs/plan.md then extract DEFAULT_DEPENDENCIES from sdk/typescript/src/cli.ts into sdk/typescript/src/cli/deps.ts';
  s.knownFiles = [...Array.from({ length: 400 }, (_, i) => `.github/workflows/w${i}.yml`), 'docs/plan.md', 'docs/other.md',
    'sdk/typescript/src/cli.ts', 'sdk/typescript/src/api.ts', 'sdk/python/setup.py', 'README.md'].sort();
  const files = relevantFiles(s);
  assert.deepEqual(files.slice(0, 2), ['sdk/typescript/src/cli.ts', 'docs/plan.md']);
  assert(files.includes('sdk/typescript/src/api.ts')); assert(!files.some(f => f.startsWith('.github')));
  assert(files.length < 20);
  const overview = repoOverview(s);
  assert.equal(overview['.github/workflows/'], 400); assert.equal(overview['sdk/typescript/'], 2); assert.equal(overview['.'], 1);
  s.coverage = { 'sdk/typescript/src/cli.ts': mergeCoverage(mergeCoverage(undefined, 9464, 1, 195), 9464, 196, 373) };
  assert.deepEqual(s.coverage['sdk/typescript/src/cli.ts'], { total: 9464, ranges: [[1, 373]] });
  assert.deepEqual(mergeCoverage({ total: 9464, ranges: [[1, 373]] }, 9464, 1100, 1180), { total: 9464, ranges: [[1, 373], [1100, 1180]] });
  assert.deepEqual(mergeCoverage({ total: 9464, ranges: [[1, 373]] }, 9000, 1, 10), { total: 9000, ranges: [[1, 10]] });
  const state = decisionState(s) as any;
  assert.deepEqual(state.readCoverage, { 'sdk/typescript/src/cli.ts': 'read 1-373 of 9464 lines' });
  assert(!('files' in state) && !('knownFiles' in state), 'the full repository listing stays out of routing');
  const prompt = promptFields(messages(s, 'read_files'));
  assert.deepEqual(prompt.readCoverage, { 'sdk/typescript/src/cli.ts': 'read 1-373 of 9464 lines' }); assert.equal(prompt.files.length, files.length); assert(!('knownFiles' in prompt));
  assert(Buffer.byteLength(JSON.stringify(messages(s, 'read_files'))) < 8000);
});
test('Read results update coverage and an edit resets it for the changed file', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowWrite: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'read_files', { ok: true, text: 'a.ts sha256=x totalLines=500 shown=1..180\n1: a\n\nb.ts sha256=y totalLines=10 shown=1..10\n1: b' });
  s.step = 2; await runner.evidence(s, 'read_files', { ok: true, text: 'a.ts sha256=x totalLines=500 shown=181..300\n181: a' });
  s.step = 3; await runner.evidence(s, 'read_files', { ok: true, text: 'a.ts sha256=x totalLines=500 shown=600..599\n(no lines in range)' });
  assert.deepEqual(s.coverage, { 'a.ts': { total: 500, ranges: [[1, 300]] }, 'b.ts': { total: 10, ranges: [[1, 10]] } });
  s.step = 4; await runner.evidence(s, 'move_lines', { ok: true, changed: ['a.ts', 'c.ts'], text: 'Moved' });
  assert.deepEqual(Object.keys(s.coverage), ['b.ts']); assert.deepEqual(s.writes, ['a.ts', 'c.ts']);
  assert.match(s.entries[0]!.stale!, /^edited at step 4/);
});

test('move_lines refuses a range that cuts through a block and names the line to read next', async t => {
  const { root, store } = await fixture(t);
  const source = ['interface Deps {', '  x: number;', '}', 'const DEFAULTS: Deps = {', '  x: 1,', '};', 'const later = [1,', '  2];', ''].join('\n');
  await writeFile(join(root, 'cli.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const base = { source: 'cli.ts', expectedHash: hash(source), destination: 'cli/deps.ts', destinationHash: 'new', replacement: '', prefix: '' };
  await assert.rejects(tools.execute('move_lines', { ...base, start: 1, end: 4 }), /not a complete block: 1 more '\{' than '\}'\. The block starting at line 1 closes at line 6: retry with end=6/);
  await assert.rejects(tools.execute('move_lines', { ...base, start: 5, end: 6 }), /1 more '\}' than '\{'\. The block ending at line 6 opens at line 4: retry with start=4/);
  await assert.rejects(tools.execute('move_lines', { ...base, start: 4, end: 4 }), /retry with end=6/);
  await assert.rejects(tools.execute('move_lines', { ...base, start: 7, end: 7 }), /1 more '\[' than '\]'/);
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), source);
  assert((await tools.execute('move_lines', { ...base, start: 1, end: 6 })).ok);
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), 'const later = [1,\n  2];\n');
});
test('Thinly spread routing is re-asked among the leading candidates before pausing', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'Hello');
  const calls: { phase: string; criteria: string[]; state: any }[] = [];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    const keys = Object.keys((q.route as any).criteria); calls.push({ phase: ctx!.phase, criteria: keys, state });
    if (ctx!.phase === 'routing-narrowed') return answersFor(q, 'read_files');
    const spread = { search_codebase: .34, read_files: .33, ask_user: .33 };
    return { ...answersFor(q, 'search_codebase'), route: { type: 'choice', choice: 'search_codebase', confidence: .5, probabilities: Object.fromEntries(keys.map(k => [k, spread[k as keyof typeof spread] ?? 0])) } } as Answers;
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'README.md', start: 1, end: 1 }] }) };
  const result = await new Runner({ ...defaults, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(calls.length, 2); assert.equal(calls[1]!.phase, 'routing-narrowed');
  assert.deepEqual(calls[1]!.criteria, ['search_codebase', 'read_files']); assert.match(calls[1]!.state.routingNarrowed, /uncertain/);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0]!.kind, 'read_files'); assert.match(result.stopReason, /step limit/);
});

test('Current file hashes are pinned in the worker prompt after reads and edits', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  session.phase = 'implement'; session.inspectionCount = 3;
  const prompts: any[] = [];
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    const prompt = promptFields(m); prompts.push(prompt);
    return schema === schemas.read_files ? { files: [{ path: 'a.ts', start: 1, end: 1 }] }
      : { path: 'a.ts', expectedHash: prompt.fileHashes['a.ts'], oldText: 'one', newText: 'two' };
  } };
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, n++ === 0 ? 'read_files' : 'write', .1) };
  const result = await new Runner({ ...defaults, allowWrite: true, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(prompts[0].fileHashes, {}); assert.deepEqual(prompts[1].fileHashes, { 'a.ts': hash('one\n') });
  assert.equal(result.lastResultOk, true); assert.deepEqual(result.hashes, { 'a.ts': hash('two\n') }); assert.equal(result.lastPromptTokens, 10);
});

test('A failing command with a huge output leaves lastError and the decision state bounded', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; s.writes = ['a.ts'];
  await runner.evidence(s, 'bash', { ok: false, text: JSON.stringify({ command: 'lint', output: 'src/x.ts(1,1): error TS6133\n'.repeat(2000), code: 2 }) });
  assert(s.lastError!.length <= 1500); assert.match(s.lastError!, /truncated/);
  assert(Buffer.byteLength(JSON.stringify(decisionState(s))) <= 22000);
  assert(JSON.stringify(messages(s, 'write')).length < 12000);
  await store.save(s);
  const big = await store.load(); big.lastError = 'x'.repeat(50000); await store.save(big);
  assert((await store.load()).lastError!.length <= 1500);
});

test('An already-satisfied objective can be checked and finished without an edit', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 3; s.step = 4;
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('bash' in route.criteria); assert(!('finish' in route.criteria));
  s.lastRoute = 'bash'; s.lastResultOk = true; s.lastCheckStep = 3;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('finish' in route.criteria); assert(!('bash' in route.criteria)); assert(s.writes.length === 0);
  s.step = 5;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('finish' in route.criteria); assert('bash' in route.criteria);
});
test('A no-match search names the path searched and suggests the repository root', async t => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.ts'), 'needle');
  const tools = new ToolBox(root, store.artifacts, defaults);
  const scoped = await tools.execute('search_codebase', { mode: 'text', path: 'src/a.ts', query: 'absent' });
  assert(scoped.ok); assert.match(scoped.text, /no matches under src\/a\.ts; .* search path \\"\.\\" to check/);
  assert.match((await tools.execute('search_codebase', { mode: 'text', path: '.', query: 'absent' })).text, /no matches in the repository/);
});
test('run refuses to start over uncommitted files an earlier session changed', async t => {
  const { root, store, session } = await fixture(t);
  const git = async (...args: string[]) => { const r = await runCommand('git', args, root, 10000); assert.equal(r.code, 0, r.output); };
  await git('init', '-q'); await git('config', 'user.email', 't@t'); await git('config', 'user.name', 't');
  await writeFile(join(root, 'a.ts'), 'one\n'); await git('add', 'a.ts'); await git('commit', '-q', '-m', 'init');
  assert.equal(await dirtySessionConflict(root), null);
  await writeFile(join(root, 'a.ts'), 'two\n');
  assert.equal(await dirtySessionConflict(root), null);
  session.writes = ['a.ts']; session.status = 'paused'; session.step = 9; await store.save(session);
  assert.match((await dirtySessionConflict(root))!, /uncommitted changes to a\.ts made by session .*paused at step 9.*Resume that session/);
  await git('checkout', '--', 'a.ts');
  assert.equal(await dirtySessionConflict(root), null);
});

test('The latest verification outcome stays pinned in both prompts until the next check', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'check.test.mjs'), "import test from 'node:test'; test('ok', () => { throw new Error('boom ' + 'x'.repeat(5000)); });\n");
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowBash: true });
  const failed = await tools.execute('bash', { command: 'node --test check.test.mjs', purpose: 'check' });
  assert.equal(failed.ok, false); assert.equal(failed.verification, true); assert.equal(failed.check, false);
  assert.equal((await tools.execute('bash', { command: 'pwd', purpose: 'diagnostic' })).verification, false);
  const runner = new Runner({ ...defaults, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 3; await runner.evidence(s, 'bash', failed);
  assert.equal(s.lastCheck!.step, 3); assert.equal(s.lastCheck!.ok, false); assert(s.lastCheck!.text.length <= 1500);
  s.step = 4; await runner.evidence(s, 'read_files', { ok: true, text: 'a.ts sha256=x totalLines=1 shown=1..1\n1: a' });
  assert.equal(s.lastError, null); assert.equal(s.lastCheck!.step, 3);
  s.entries = [];
  assert.equal((decisionState(s) as any).lastCheck.step, 3);
  assert.equal(promptFields(messages(s, 'write')).lastCheck.ok, false);
  s.step = 5; await runner.evidence(s, 'bash', { ok: true, verification: true, check: true, text: 'passed' });
  assert.equal(s.lastCheck!.step, 5); assert.equal(s.lastCheck!.ok, true); assert.equal(s.lastCheck!.text, 'passed');
  s.step = 6; await runner.evidence(s, 'bash', { ok: true, text: 'ls output' });
  assert.equal(s.lastCheck!.step, 5);
});

test('Routing returns the argmax option with margin tolerance and survives a mismatched choice field', () => {
  const c = { ...defaults, routeProbability: .4, routeMargin: .01 };
  assert.equal(confidentChoice({ type: 'choice', choice: 'read_files', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'write', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: .5, b: .5 }, confidence: .5 }, c), null);
});

test('Arguments identical to an executed action are refused without a second generation', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'interface CliDependencies {}\nconst DEFAULT_DEPENDENCIES = 1;\n');
  const calls: number[] = [];
  let n = 0;
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: any, _s: unknown, temperature = .2) => {
    calls.push(temperature); n++;
    return { query: n === 3 ? 'const DEFAULT_DEPENDENCIES' : 'interface CliDependencies', path: '.', mode: 'text' };
  } };
  const result = await new Runner({ ...defaults, maxSteps: 3 }, store, { decide: async (_s, q) => answersFor(q, 'search_codebase') }, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /step limit/);
  assert.deepEqual(result.entries.map(e => e.kind), ['search_codebase', 'generation_error', 'search_codebase']);
  assert.match(result.entries[1]!.text, /repeated the search_codebase action from step 1 \(its result was .*interface CliDependencies/);
  assert.match(result.entries[2]!.text, /DEFAULT_DEPENDENCIES/);
  assert.deepEqual(calls, [.2, .2, .2], 'no hotter retry');
  assert.equal(Object.keys(result.actions).length, 2);
});

test('replace_lines rewrites or deletes a line range by number with hash checks and reports the shift', async t => {
  const { root, store } = await fixture(t);
  const source = 'import {\n  a,\n  b,\n  c,\n} from "./x.js";\nconst keep = 1;\n';
  await writeFile(join(root, 'f.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const one = (start: number, end: number, newText: string) => ({ edits: [{ start, end, newText, prepend: '' }] });
  await assert.rejects(tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash('other'), ...one(1, 5, 'x') }), (e: any) => e instanceof StaleWriteError);
  await assert.rejects(tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), ...one(2, 3, '  a,\n  b,') }), /every newText equals the current lines \(2\.\.3\)/);
  // one unchanged range inside a batch is skipped and reported, the rest applies
  const mixed = await tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), edits: [{ start: 2, end: 2, newText: '  a,\n', prepend: '' }, { start: 6, end: 6, newText: 'const keep = 1; // kept', prepend: '' }] });
  assert.match(mixed.text, /Replaced 1 range\(s\) 6\.\.6 of f\.ts; .*Skipped 1 unchanged range\(s\): 2\.\.2\./);
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), source.replace('const keep = 1;', 'const keep = 1; // kept'));
  await writeFile(join(root, 'f.ts'), source);
  await assert.rejects(tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), ...one(1, 9, '') }), /exceeds f.ts/);
  await assert.rejects(tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), edits: [{ start: 2, end: 3, newText: '', prepend: '' }, { start: 3, end: 4, newText: '', prepend: '' }] }), /overlap/);
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), source);
  // Several deletions numbered as read, applied bottom-up: remove b and c, and rewrite the last line.
  const r = await tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), edits: [{ start: 3, end: 3, newText: '', prepend: '' }, { start: 6, end: 6, newText: 'const keep = 2;', prepend: '' }, { start: 4, end: 4, newText: '', prepend: '' }] });
  const after = 'import {\n  a,\n} from "./x.js";\nconst keep = 2;\n';
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), after);
  assert.deepEqual(r.changed, ['f.ts']); assert.deepEqual(r.hashes, { 'f.ts': hash(after) }); assert.match(r.text, /Replaced 3 range\(s\) 3\.\.3, 4\.\.4, 6\.\.6 of f\.ts; .*totalLines=5\. Line numbers below the first edit shifted by -2/);
  const d = await tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(after), ...one(1, 3, 'import { a } from "./x.js";') });
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), 'import { a } from "./x.js";\nconst keep = 2;\n'); assert.match(d.text, /shifted by -2/);
  await assert.rejects(new ToolBox(root, store.artifacts, defaults).execute('replace_lines', { path: 'f.ts', expectedHash: 'x', ...one(1, 1, '') }), /Writes disabled/);
  assert.throws(() => validate(schemas.replace_lines, { path: 'f.ts', expectedHash: 'x', start: 1, end: 1, newText: '' }), /missing edits/);
  assert.throws(() => validate(schemas.replace_lines, { path: 'f.ts', expectedHash: 'x', edits: [{ start: 1, end: 1, newText: '' }] }), /missing prepend/);
  const { session: s } = await fixture(t); s.phase = 'implement'; s.inspectionCount = 3;
  const route = routeQuestions(s, { ...defaults, allowWrite: true }).route!;
  assert(route.type === 'choice'); assert('replace_lines' in route.criteria);
  assert(!('replace_lines' in (routeQuestions(s, defaults).route as any).criteria));
});
test('A repeat of an action whose evidence was evicted is executed again', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  let n = 0;
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => { n++; return { files: [{ path: 'a.ts', start: 1, end: 1 }] }; } };
  const jev = { decide: async (_s: unknown, q: Questions) => { session.entries = []; return answersFor(q, 'read_files'); } };
  const result = await new Runner({ ...defaults, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(n, 2); assert.equal(result.entries.length, 1); assert.equal(result.entries[0]!.kind, 'read_files'); assert.equal(result.entries[0]!.step, 2);
});

test('Searches are pinned as a digest in both prompts after their entries are gone', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner(defaults, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'search_codebase', { ok: true, text: JSON.stringify({ output: 'src/cli.ts:1103:interface CliDependencies {\n', code: 0 }) }, { mode: 'text', query: 'interface CliDependencies', path: 'src' });
  s.step = 2; await runner.evidence(s, 'search_codebase', { ok: true, text: JSON.stringify({ output: ['a:1:x', 'a:2:x', 'a:3:x', 'a:4:x', 'a:5:x'].join('\n'), code: 0 }) }, { mode: 'text', query: 'x', path: '.' });
  s.step = 3; await runner.evidence(s, 'search_codebase', { ok: true, text: JSON.stringify({ output: '(no matches in the repository)', code: 1 }) }, { mode: 'text', query: 'absent', path: '.' });
  s.entries = [];
  assert.deepEqual(s.searches, {
    'text:interface CliDependencies in src': 'src/cli.ts:1103:interface CliDependencies {',
    'text:x in .': 'a:1:x | a:2:x | a:3:x | +2 more',
    'text:absent in .': '(no matches)',
  });
  assert.deepEqual((decisionState(s) as any).searched, s.searches);
  assert.deepEqual(promptFields(messages(s, 'search_codebase')).searched, s.searches);
});
test('Four consecutive generation failures pause; two only block the route once', async t => {
  const { root, store, session } = await fixture(t);
  const offered: string[][] = [];
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => { throw new Error('Bonsai returned invalid JSON'); } };
  const jev = { decide: async (_s: unknown, q: Questions) => { const keys = Object.keys((q.route as any).criteria); offered.push(keys); return answersFor(q, keys.includes('read_files') ? 'read_files' : 'search_codebase'); } };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.equal(result.step, 4); assert.equal(result.stopReason, 'Bonsai returned invalid JSON');
  // the block follows the most recent route that failed twice: read is blocked at step 3, then search at step 4.
  assert.deepEqual(offered.map(k => k.includes('read_files')), [true, true, false, true]); assert(!offered[3]!.includes('search_codebase'));
  assert.equal(result.entries.filter(e => e.kind === 'generation_error').length, 3);
});

test('Bracket balance ignores strings and comments so escape sequences do not block a move', async t => {
  const code = 'const a = "\\u001B[?25l"; // {\nconst b = `x${y}[`; /* ( */ f(\'[\')';
  const stripped = stripLiterals(code);
  assert.equal(stripped.length, code.length); assert(!stripped.includes('[')); assert(!stripped.includes('{')); assert.match(stripped, /f\( +\)$/); assert.equal(stripped.split('\n').length, 2);
  const { root, store } = await fixture(t);
  const source = ['const PROGRESS = 1_000;', 'const HIDE_CURSOR = "\\u001B[?25l";', 'const SHOW_CURSOR = "\\u001B[?25h";', 'type Writable = Pick<X, "write"> & {', '  end?(): void; // }', '};', 'rest();', ''].join('\n');
  await writeFile(join(root, 'cli.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const r = await tools.execute('move_lines', { source: 'cli.ts', expectedHash: hash(source), start: 1, end: 6, destination: 'cli/deps.ts', destinationHash: 'new', replacement: '', prefix: '' });
  assert(r.ok); assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), 'rest();\n');
});
test('A search already in the digest is treated as executed even after its entry was evicted', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'interface CliDependencies {}\n');
  const notes: string[] = [];
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any) => { const n = promptFields(m).harnessNote as string | undefined; if (n) notes.push(n); return { query: 'interface CliDependencies', path: '.', mode: 'text' }; } };
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => { if (n++ === 1) session.entries = []; return answersFor(q, 'search_codebase'); } };
  const result = await new Runner({ ...defaults, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['generation_error']);
  assert.match(result.entries[0]!.text, /its result was \.\/a\.ts:1:interface CliDependencies \{/); assert.equal(notes.length, 0);
  assert.equal(Object.keys(result.searches).length, 1);
});
test('A blocked route stays blocked until another route succeeds', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'x\n');
  const offered: string[][] = [];
  let reads = 0;
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => {
    if (schema === schemas.search_codebase) throw new Error('Bonsai returned invalid JSON');
    return { files: [{ path: ++reads > 1 ? 'a.ts' : 'missing.ts', start: 1, end: 1 }] }; // first read fails on a missing file, second succeeds
  } };
  const jev = { decide: async (_s: unknown, q: Questions) => { const keys = Object.keys((q.route as any).criteria); offered.push(keys); return answersFor(q, keys.includes('search_codebase') ? 'search_codebase' : 'read_files'); } };
  const result = await new Runner({ ...defaults, maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  // steps 1-2 search fails twice -> blocked; step 3 read fails (still blocked); step 4 read succeeds (unblocks); step 5 search fails; step 6 search fails -> blocked again.
  assert.deepEqual(offered.map(k => k.includes('search_codebase')), [true, true, false, false, true, true]);
  assert.equal(result.blockedRoute, 'search_codebase'); assert.equal(result.status, 'paused'); assert.match(result.stopReason, /step limit/);
});

test('Edits that cut through a declaration are refused on every edit route', async t => {
  assertBalancePreserved('a { b }', 'a { c }', 'x'); assertBalancePreserved('a {', 'a', 'x'); assertBalancePreserved('', 'f(1)', 'x');
  assert.throws(() => assertBalancePreserved('a { b }', 'a { b', 'x'), /leave x with 1 unmatched '\{' \(was 0\)/);
  const { root, store } = await fixture(t);
  const source = 'import { a } from "./x.js";\ninterface Deps {\n  x: number;\n}\nconst D: Deps = {\n  x: 1,\n};\n';
  await writeFile(join(root, 'f.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  await assert.rejects(tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), edits: [{ start: 1, end: 2, newText: '', prepend: '' }] }), /Edit refused.*1 unmatched '\}'/);
  await assert.rejects(tools.execute('write', { path: 'f.ts', expectedHash: hash(source), oldText: 'const D: Deps = {', newText: 'const D: Deps = ' }), /Edit refused/);
  await assert.rejects(tools.execute('move_lines', { source: 'f.ts', expectedHash: hash(source), start: 2, end: 4, destination: 'g.ts', destinationHash: 'new', replacement: '', prefix: 'function broken() {' }), /Edit refused.*g\.ts/);
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), source);
  assert((await tools.execute('replace_lines', { path: 'f.ts', expectedHash: hash(source), edits: [{ start: 1, end: 1, newText: '' }, { start: 2, end: 4, newText: '' }] })).ok);
  assert.equal(await readFile(join(root, 'f.ts'), 'utf8'), 'const D: Deps = {\n  x: 1,\n};\n');
});
test('A read repeated after the file changed is a new action and stale search digests are dropped', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  session.phase = 'implement'; session.inspectionCount = 3;
  session.searches = { 'text:one in a.ts': 'a.ts:1:one', 'text:one in .': 'a.ts:1:one', 'text:zzz in other.ts': '(no matches)' };
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, ['read_files', 'write', 'read_files'][n++] ?? 'read_files', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => schema === schemas.read_files
    ? { files: [{ path: 'a.ts', start: 1, end: 1 }] } : { path: 'a.ts', expectedHash: (promptFields(m).fileHashes as any)['a.ts'], oldText: 'one', newText: 'two' } };
  const result = await new Runner({ ...defaults, allowWrite: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['read_files', 'write', 'read_files']);
  assert.match(result.entries[2]!.text, /1: two/);
  assert.deepEqual(Object.keys(result.searches), ['text:zzz in other.ts']);
  assert.equal(result.editsSinceCheck, 1);
});
test('Line-addressed edits require a read of the current version and snapshot the previous content', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\n');
  session.phase = 'implement'; session.inspectionCount = 3;
  const routes = ['read_files', 'replace_lines', 'replace_lines', 'read_files', 'replace_lines'];
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, routes[n++]!, .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    const p = promptFields(m) as any;
    if (schema === schemas.read_files) return { files: [{ path: 'a.ts', start: 1, end: 3 }] };
    return { path: 'a.ts', expectedHash: p.fileHashes['a.ts'], edits: [{ start: 1, end: 1, newText: '', prepend: '' }] };
  } };
  const result = await new Runner({ ...defaults, allowWrite: true, maxSteps: 5 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => [e.kind, e.text.startsWith('Tool error') ? 'err' : 'ok']),
    [['read_files', 'ok'], ['replace_lines', 'ok'], ['replace_lines', 'err'], ['read_files', 'ok'], ['replace_lines', 'ok']]);
  assert.match(result.entries[2]!.text, /has not been read since it last changed \(current sha256 [0-9a-f]{64}\)/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'three\n');
  // the second read was not treated as a repeat of the first, because a.ts changed in between
  assert.equal(result.entries[3]!.step, 4);
  const files = (await readdir(store.artifacts)).filter(f => f.endsWith('-a.ts')).sort();
  assert.deepEqual(files, ['00002-a.ts', '00005-a.ts']);
  assert.equal(await readFile(join(store.artifacts, '00002-a.ts'), 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(await readFile(join(store.artifacts, '00005-a.ts'), 'utf8'), 'two\nthree\n');
});
test('The pinned check is flagged stale for files edited after it', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 3; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'src/a.ts(4,1): error TS6133' });
  assert.deepEqual(staleFor(s), []);
  s.step = 4; await runner.evidence(s, 'replace_lines', { ok: true, changed: ['src/a.ts'], text: 'Replaced' });
  assert.deepEqual(staleFor(s), ['src/a.ts']);
  assert.deepEqual((decisionState(s) as any).lastCheck.staleFor, ['src/a.ts']);
  assert.deepEqual(promptFields(messages(s, 'bash')).lastCheck.staleFor, ['src/a.ts']);
  s.step = 5; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'still failing' });
  assert.deepEqual(staleFor(s), []);
});

test('A current check is not re-run: bash is withheld right after it and annotated otherwise', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 3; s.writes = ['deps.ts']; s.writeSteps = { 'deps.ts': 14 }; s.step = 22;
  s.lastCheck = { step: 21, ok: false, text: 'errors', summary: summarizeCheck('errors') }; s.lastRoute = 'bash'; s.lastResultOk = false;
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('bash' in route.criteria)); assert('replace_lines' in route.criteria); assert('read_files' in route.criteria);
  assert.equal(route.criteria.read_files, routeDescriptions.read_files);
  s.lastRoute = 'read_files'; s.lastResultOk = true; s.step = 23;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert.match(route.criteria.bash!, /check from step 21 is current/);
  s.writeSteps = { 'deps.ts': 23 }; s.step = 24;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert.equal(route.criteria.bash, routeDescriptions.bash);
});

test('Check summaries count errors per file, single out syntax errors, and keep the lines named', () => {
  const output = ['$ tsc --noEmit', 'src/cli.ts(3832,1): error TS1005: \':\' expected.', "src/cli.ts(3839,17): error TS1109: Expression expected.",
    "src/cli/deps.ts(4,10): error TS6133: 'x' is declared but its value is never read.", 'src/cli/deps.ts(9,3): error TS2554: Expected 2 arguments, but got 1.',
    'tests-ts/a.test.ts(1,1): error TS7006: implicit any', 'warning: unrelated'].join('\n');
  const s = summarizeCheck(JSON.stringify({ command: 'lint', output, code: 1 }));
  assert.equal(s.errors, 5); assert.equal(s.syntax, 2);
  assert.deepEqual(Object.keys(s.byFile), ['src/cli.ts', 'src/cli/deps.ts', 'tests-ts/a.test.ts']);
  assert.deepEqual(s.byFile['src/cli.ts'], { count: 2, syntax: 2, resolution: 0, lines: [3832, 3839], samples: ["src/cli.ts(3832,1): error TS1005: ':' expected.", 'src/cli.ts(3839,17): error TS1109: Expression expected.'], diagnostics: ["src/cli.ts(3832,1): error TS1005: ':' expected.", 'src/cli.ts(3839,17): error TS1109: Expression expected.'] });
  assert.equal(s.byFile['src/cli/deps.ts']!.syntax, 0);
  assert.equal(summarizeCheck('all good').errors, 0);
});
test('An edit that makes the check objectively worse is rolled back deterministically and re-verified', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const x = f(1, 2);\n');
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('a.ts', 'utf8'); if (t.startsWith('import { f }')) { console.error(\"a.ts(1,1): error TS1005: ')' expected.\"); } else { console.error('a.ts(1,7): error TS2304: Cannot find name f.'); } process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  const asked: any[] = [];
  const routes = ['bash', 'read_files', 'replace_lines', 'read_files'];
  let n = 0;
  const jev = { decide: async (state: any, q: Questions) => { if (q.undo) asked.push(state); return answersFor(q, routes[n++] ?? 'read_files', .1); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    const p = promptFields(m);
    if (schema === schemas.read_files) return { files: [{ path: 'a.ts', start: 1, end: 1 }] };
    if (schema === schemas.bash) return { command: 'node check.mjs', purpose: 'check' };
    return { path: 'a.ts', expectedHash: p.fileHashes['a.ts'], edits: [{ start: 1, end: 1, newText: 'import { f } from "./f.js";', prepend: '' }] };
  } };
  // 1 check (semantic error) · 2 forced focus read · 3 read · 4 edit (breaks) · 5 forced check (syntax) · 6 forced undo · 7 forced re-check
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 7 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['bash', 'read_files', 'read_files', 'replace_lines', 'bash', 'undo', 'bash']);
  assert.equal(asked.length, 0, 'an objective regression is not put to a vote');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const x = f(1, 2);\n');
  assert.match(result.entries[5]!.text, /reverted a\.ts .* went from 1 errors \(0 syntax\) to 1 \(1 syntax\)/);
  assert.equal(result.lastCheck!.summary.syntax, 0); assert.deepEqual(result.editSnapshots, {});
  assert.equal(result.hashes['a.ts'], hash('const x = f(1, 2);\n'));
  assert.equal(result.readHashes['a.ts'], hash('const x = f(1, 2);\n'), 'the restored content was read before the edit, so no re-read is required');
});

test('No rollback without edits since the previous check, none after a passing check, deterministic on new syntax errors', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowBash: true, allowWrite: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'a.ts(1,1): error TS2304: x' });
  assert.equal(s.autoUndo, null); assert(!('undo' in routeQuestions(s, defaults)));
  s.step = 2; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00002-a.ts' }, text: 'Updated' });
  s.step = 3; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00003-a.ts' }, text: 'Updated' });
  assert.deepEqual(s.editSnapshots, { 'a.ts': '@artifact/00002-a.ts' });
  s.step = 4; await runner.evidence(s, 'bash', { ok: true, verification: true, check: true, text: 'passed' });
  assert.equal(s.autoUndo, null); assert.deepEqual(s.editSnapshots, {}); assert.equal(s.previousCheck!.step, 1);
  s.step = 5; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00005-a.ts' }, text: 'Updated' });
  s.step = 6; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'a.ts(2,1): error TS1005: \')\' expected.' });
  const au = s.autoUndo as any;
  assert.deepEqual(au?.files, { 'a.ts': '@artifact/00005-a.ts' }); assert.match(au.reason, /went from 0 errors \(0 syntax\) to 1 \(1 syntax\)/);
  assert(!('undo' in routeQuestions(s, defaults)));
});

test('Reports and verbose progress expose prompts, Jev exchanges, latency, speed and context use', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'Hello');
  const lines: string[] = [];
  const bonsai = { count: async () => ({ tokens: 3000, mode: 'test' }), lastMeta: null as any,
    generate: async function (this: any, _m: unknown, schema: unknown) {
      this.lastMeta = { ms: 2000, usage: { completion_tokens: 70, prompt_tokens: 3000 }, timings: { predicted_per_second: 35.5, prompt_per_second: 430, prompt_n: 3000 }, finishReason: 'stop', promptTokens: 3000 };
      return schema === schemas.read_files ? { files: [{ path: 'README.md', start: 1, end: 1 }] } : { summary: 'Read it.' };
    } };
  const jev = { decide: async (state: unknown, q: Questions, ctx?: { step: number; phase: string }) => { await store.log('jev-request', { requestId: `r${ctx!.step}-${ctx!.phase}`, ...ctx, model: 'jev', state, questions: q }); const a = answersFor(q, 'read_files'); await store.log('jev', { requestId: `r${ctx!.step}-${ctx!.phase}`, ...ctx, ms: 412, model: 'jev', answers: a, usage: { input_tokens: 900 } }); return a; } };
  await store.log('start', { config: { ...defaults, workingTokens: 12000 }, root });
  const result = await new Runner({ ...defaults, verbose: true, maxSteps: 1 }, store, jev, bonsai, root, m => lines.push(m)).run(session);
  assert.equal(result.step, 1);
  const text = lines.join('\n');
  assert.match(text, /jev \d+ms \| \d+ questions \| state [\d.]+k bytes \| route read_files 1\.00/);
  assert.match(text, /context 3000 tokens = 25% of 12000 working \(6% of window\) \| chars: /);
  assert.match(text, /bonsai 2\.0s \| 70 generated tokens @ 35\.5 tok\/s \| prompt 3000 tokens @ 430 tok\/s \| finish stop/);
  assert.match(text, /args \{"files"/); assert.match(text, /result ok \| \d+ms \| \d+ chars \| README\.md sha256=/);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const prompt = events.find(e => e.type === 'prompt');
  assert.equal(prompt.data.step, 1); assert.equal(prompt.data.artifact, '@artifact/00001-prompt.json'); assert(prompt.data.breakdown.objective > 10); assert(prompt.data.breakdown.system > 100);
  const saved = JSON.parse(await readFile(join(store.artifacts, '00001-prompt.json'), 'utf8'));
  assert.equal(saved[0].role, 'system'); assert(JSON.parse(saved.at(-1).content).selectedAction === 'read_files');
  await store.log('bonsai-request', { requestId: 'b1', step: 1, route: 'read_files', prompt: { tokens: 3000 }, temperature: .2 });
  await store.log('bonsai', { requestId: 'b1', step: 1, route: 'read_files', ms: 2000, usage: { completion_tokens: 70, prompt_tokens: 3000 }, timings: { predicted_per_second: 35.5, prompt_per_second: 430 }, finishReason: 'stop' });
  const html = await renderReport(store.path);
  assert(html.includes('<title>Leana session report</title>')); assert(html.includes('"route":"read_files"')); assert(html.includes('00001-prompt.json'));
  assert(html.includes('"predicted_per_second":35.5')); assert(html.includes('the worker in Leana')); assert(html.includes('"instructions":"Choose ONE valid next action'));
  assert(html.includes('README.md sha256=')); assert(!html.includes('</script>' + '</script>'));
  const steps = collectSteps((await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)));
  assert.equal(steps.length, 1); assert.equal(steps[0]!.jev.length, 1); assert.equal(steps[0]!.jev[0]!.ms, 412); assert.equal(steps[0]!.prompts[0]!.tokens, 3000);
  assert.deepEqual(speed(steps[0]!.bonsai[0]!), { generation: 35.5, prompt: 430, generated: 70 });
  assert.deepEqual(speed({ ms: 1000, usage: { completion_tokens: 40 } }), { generation: 40, prompt: null, generated: 40 });
  assert.equal(await readFile(join(store.path, 'report.html'), 'utf8'), html);
  assert(!html.includes('http-equiv="refresh"'), 'a finished session does not auto-refresh');
});

test('The terminal display redraws a status panel in place and falls back to lines off a terminal', () => {
  const tty: string[] = []; const plain: string[] = [];
  const d = new Display({ write: (s: string) => tty.push(s), isTTY: true, columns: 120 }, { objective: 'Move the block', session: 'run-1', verbose: false });
  const p = new Display({ write: (s: string) => plain.push(s), isTTY: false }, { objective: 'Move the block', session: 'run-1', verbose: true });
  const meta = { ms: 2000, usage: { completion_tokens: 70, prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 500 } }, timings: { predicted_per_second: 35.5, prompt_per_second: 430 }, finishReason: 'stop', promptTokens: 3000 };
  const events = [
    { kind: 'step', step: 1, phase: 'inspect', maxStep: 80 },
    { kind: 'jev', step: 1, ms: 412, questions: 3, stateBytes: 4200, route: [['read_files', .8], ['search_codebase', .2]], nouls: { complete: .02 } },
    { kind: 'route', step: 1, route: 'read_files', tokens: 3000, entries: 0 },
    { kind: 'context', step: 1, tokens: 3000, workingTokens: 12000, contextWindow: 48000, breakdown: { system: 400, evidence: 2, files: 1200 }, entries: 0 },
    { kind: 'generating', step: 1, route: 'read_files', attempt: 1 },
    { kind: 'generated', step: 1, route: 'read_files', meta, args: { files: [{ path: 'a.ts', start: 1, end: 1 }] } },
    { kind: 'result', step: 1, route: 'read_files', ok: true, ms: 12, chars: 114, text: 'a.ts sha256=x' },
    { kind: 'stop', step: 1, status: 'paused', reason: 'step limit' },
  ] as const;
  for (const e of events) { d.update(e as any); p.update(e as any); }
  d.close();
  const panel = d.panel().join('\n');
  assert.match(panel, /step 1\/80 \| inspect \| PAUSED: step limit/); assert.match(panel, /Jev +412ms \| 3 q \| state 4\.2k \| read_files 0\.80 \| search_codebase 0\.20 \| complete 0\.02/);
  assert.match(panel, /median 412ms \| p95 412ms \| 1 calls/); assert.match(panel, /Context +\[#####\.{15}\] 3\.0k \/ 12\.0k working \(25%\) \| window 48\.0k \(6%\) \| 0 entries \| files 1\.2k/);
  assert.match(panel, /Bonsai +2\.0s \| 70 tokens @ 35\.5 tok\/s \| prompt @ 430 tok\/s \| 500 cached/); assert.match(panel, /avg 35\.5 tok\/s \| 70 generated \| 3\.0k prompt tokens sent/);
  assert.match(panel, /Last +\[1\] read_files ok 12ms -> 114 chars: a\.ts sha256=x/); assert.match(panel, /Totals +read_files 1 \| 0 edits \| 0 commands \| 0 failures \| 0 undo/);
  assert(tty.some(s => s.includes('\x1b[') && s.includes('A\x1b[J')), 'panel is cleared with cursor movement before redraw');
  assert(tty.some(s => s.startsWith('[1] read_files | 3000 prompt tokens')), 'the step line scrolls above the panel');
  assert.deepEqual(plain.filter(s => s.includes('bonsai 2.0s')).length, 1); assert(plain.every(s => !s.includes('\x1b[')));
  assert(d.panel().every(l => /^[\x20-\x7e]*$/.test(l)), 'panel is ASCII only');
  assert.equal(describe({ kind: 'stop', step: 1, status: 'paused', reason: 'x' }, true), null);
  assert.deepEqual(generationSpeed(null), { generated: null, perSecond: null, promptPerSecond: null, cached: null });
});

test('An exact tie in the narrowed routing pass is broken by the stated preference instead of pausing', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'Hello');
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    const keys = Object.keys((q.route as any).criteria);
    const spread: Record<string, number> = ctx!.phase === 'routing-narrowed' ? { search_codebase: .5, read_files: .5 } : { search_codebase: .34, read_files: .33, ask_user: .33 };
    return { ...answersFor(q, 'search_codebase'), route: { type: 'choice', choice: 'search_codebase', confidence: .5, probabilities: Object.fromEntries(keys.map(k => [k, spread[k] ?? 0])) } } as Answers;
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.read_files ? { files: [{ path: 'README.md', start: 1, end: 1 }] } : { query: 'Hello', path: '.', mode: 'text' } };
  const result = await new Runner({ ...defaults, routeProbability: .5, routeMargin: .01, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0]!.kind, 'read_files', 'read beats search on a tie'); assert.match(result.stopReason, /step limit/);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.find(e => e.type === 'tie-break')?.data, { step: 1, route: 'read_files', probabilities: { search_codebase: .5, read_files: .5 }, rule: 'edit > check > read > search' });
});

test('Names a check cannot find are resolved to import lines from the other edited file or from declarations', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'sdk/src/cli'), { recursive: true });
  await writeFile(join(root, 'sdk/src/cli.ts'), 'import { a, type Finding } from "./models.js";\nimport type {\n  Long,\n} from "./long.js";\nimport { cwd } from "node:process";\nimport { Readable, Writable as NodeWritable } from "node:stream";\ntype Writable = Pick<NodeWritable, "write">;\ntype SignalName = "SIGINT";\nexport function exportEnvironment() {}\nconst x = 1;\n');
  await writeFile(join(root, 'sdk/src/cli/deps.ts'), 'const y: Finding = 1;\n');
  const output = ['src/cli/deps.ts(1,10): error TS2304: Cannot find name \'Finding\'.', 'src/cli/deps.ts(2,1): error TS2304: Cannot find name \'Long\'.', 'src/cli/deps.ts(3,1): error TS2304: Cannot find name \'cwd\'.',
    'src/cli/deps.ts(4,1): error TS2304: Cannot find name \'SignalName\'.', 'src/cli/deps.ts(5,1): error TS2304: Cannot find name \'exportEnvironment\'.', 'src/cli/deps.ts(6,1): error TS2304: Cannot find name \'Nowhere\'.', 'src/cli/deps.ts(7,1): error TS2304: Cannot find name \'Writable\'.', 'src/cli.ts(1,1): error TS6133: \'a\' is declared but its value is never read.'].join('\n');
  const names = await resolveMissingNames(root, output, ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts']);
  const by = Object.fromEntries(names.map(n => [n.name, n]));
  assert.deepEqual(Object.keys(by), ['a', 'Finding', 'Long', 'cwd', 'SignalName', 'exportEnvironment', 'Nowhere', 'Writable']);
  assert.equal(by.Writable!.importLine, 'import type { Writable } from "../cli.js";'); assert.match(by.Writable!.note!, /not exported yet.*cli\.ts:7/);
  assert.equal(by.Finding!.importLine, 'import type { Finding } from "../models.js";'); assert.equal(by.Finding!.importedBy, 'sdk/src/cli.ts'); assert.equal(by.Finding!.inFile, 'sdk/src/cli/deps.ts');
  assert.equal(by.Long!.importLine, 'import type { Long } from "../long.js";');
  assert.equal(by.cwd!.importLine, 'import { cwd } from "node:process";');
  assert.equal(by.SignalName!.importLine, 'import type { SignalName } from "../cli.js";'); assert.equal(by.SignalName!.exported, false); assert.match(by.SignalName!.note!, /not exported yet: add export to the declaration at sdk\/src\/cli\.ts:8/);
  assert.equal(by.exportEnvironment!.importLine, 'import { exportEnvironment } from "../cli.js";'); assert.equal(by.exportEnvironment!.exported, true); assert.equal(by.exportEnvironment!.note, undefined);
  assert.equal(by.Nowhere!.importLine, undefined); assert.match(by.Nowhere!.note!, /no import or declaration found/);
});
test('missingNames are pinned after a failing check and cleared by a passing one', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'import { z } from "./z.js";\n'); await writeFile(join(root, 'b.ts'), 'z;\n');
  s.writes = ['a.ts', 'b.ts'];
  const runner = new Runner({ ...defaults, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 2; await runner.evidence(s, 'bash', { ok: false, verification: true, text: JSON.stringify({ output: "b.ts(1,1): error TS2304: Cannot find name 'z'." }) });
  assert.deepEqual(s.missingNames, [{ name: 'z', inFile: 'b.ts', importedBy: 'a.ts', importLine: 'import { z } from "./z.js";' }]);
  const grouped = { addImports: { 'b.ts': ['import { z } from "./z.js";'] }, addExportAtLines: {}, removeImports: {}, removeImportLines: {}, aliasImports: {}, respecImports: {}, moveDeclarations: [], unresolved: [], total: 1 };
  const pinned = { addImports: { 'b.ts': ['import { z } from "./z.js";'] }, total: 1 };
  assert.deepEqual((decisionState(s) as any).missingNames, grouped); assert.deepEqual(promptFields(messages(s, 'replace_lines')).missingNames, pinned);
  s.step = 3; await runner.evidence(s, 'bash', { ok: true, verification: true, check: true, text: 'passed' });
  assert.deepEqual(s.missingNames, []);
});
test('The panel never fills the last column, so redraws do not leak lines', () => {
  const out: string[] = [];
  const d = new Display({ write: (s: string) => out.push(s), isTTY: true, columns: 80 }, { objective: 'x'.repeat(300), session: 's', verbose: false });
  const lines = d.panel();
  assert(lines.every(l => l.length <= 79), `longest ${Math.max(...lines.map(l => l.length))}`); assert.equal(lines[0]!.length, 79);
});

test('An edit that was rolled back is never generated again verbatim, and the reason is pinned', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const x = f(1, 2);\n');
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('a.ts', 'utf8'); if (t.startsWith('import { f }')) { console.error(\"a.ts(1,1): error TS1005: ')' expected.\"); } else { console.error('a.ts(1,7): error TS2304: Cannot find name f.'); } process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  // 1 check · 2 forced focus read · 3 read · 4 edit (bad) · 5 forced check (worse) · 6 forced undo · 7 forced re-check · 8 read · 9 the same edit again -> refused -> generation error
  const routes = ['bash', 'read_files', 'replace_lines', 'read_files', 'replace_lines'];
  let n = 0; const notes: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, routes[n++] ?? 'bash', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    const p = promptFields(m); if (p.harnessNote) notes.push(p.harnessNote as string);
    if (schema === schemas.read_files) return { files: [{ path: 'a.ts', start: 1, end: 1 }] };
    if (schema === schemas.bash) return { command: 'node check.mjs', purpose: 'check' };
    return { path: 'a.ts', expectedHash: p.fileHashes['a.ts'], edits: [{ start: 1, end: 1, newText: 'import { f } from "./f.js";', prepend: '' }] };
  } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 9 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['bash', 'read_files', 'read_files', 'replace_lines', 'bash', 'undo', 'bash', 'read_files', 'generation_error']);
  assert.equal(result.rejectedEdits.length, 1); assert.equal(result.rejectedEdits[0]!.step, 4); assert.equal(result.rejectedEdits[0]!.undoneAt, 6);
  assert.match(result.rejectedEdits[0]!.reason, /1 syntax/);
  assert.equal(notes.length, 0, 'no retry prompt is built for a rejected edit');
  assert.match(result.entries[8]!.text, /repeated the replace_lines action from step 4 \(it was rolled back at step 6 because .*syntax/);
  assert.deepEqual(result.transaction, []);
  const prompt = promptFields(messages(result, 'replace_lines'));
  assert.equal(prompt.rejectedEdits.length, 1); assert.match(prompt.rejectedEdits[0].args, /"edits"/);
  assert.equal((decisionState(result) as any).rejectedEdits.length, 1);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const x = f(1, 2);\n');
});

test('The worker prompt is one user message per pinned block and per evidence entry, volatile fields last', async t => {
  const { session: s } = await fixture(t);
  s.entries = [{ id: 'e1', step: 1, kind: 'read_files', artifact: '@artifact/00001.txt', text: 'a', relevance: .5 }, { id: 'e2', step: 2, kind: 'bash', artifact: '@artifact/00002.txt', text: 'b', relevance: .5 }];
  const prompt = messages(s, 'read_files');
  assert.equal(prompt.length, 5); assert.equal(prompt[0]!.role, 'system'); assert(prompt.slice(1).every(m => m.role === 'user'));
  assert.deepEqual(Object.keys(JSON.parse(prompt[1]!.content)), ['objective', 'repositoryInstructions', 'directories', 'fileCount', 'files']);
  assert.deepEqual(JSON.parse(prompt[2]!.content), { evidence: { id: 'e1', kind: 'read_files', artifact: '@artifact/00001.txt', text: 'a' } });
  assert.deepEqual(JSON.parse(prompt[3]!.content).evidence.id, 'e2');
  const last = Object.keys(JSON.parse(prompt[4]!.content));
  assert.equal(last[0], 'role'); assert.equal(last[1], 'phase'); assert.deepEqual(last.slice(-3), ['selectedAction', 'actionInstructions', 'argumentSchema']);
  // appending evidence leaves every earlier message byte-identical, so the server can resume from that boundary
  s.entries.push({ id: 'e3', step: 3, kind: 'bash', artifact: '', text: 'c', relevance: .5 });
  const next = messages(s, 'read_files');
  assert.deepEqual(next.slice(0, 4), prompt.slice(0, 4)); assert.equal(next.length, 6);
  s.writes.push('src/new.ts'); s.tasks = [{ id: 't', description: 'd', status: 'pending', evidence: '' }];
  assert.equal(messages(s, 'read_files')[1]!.content, prompt[1]!.content, 'writes and tasks do not disturb the pinned block');
  const merged = promptFields(next);
  assert.equal((merged.evidence as unknown[]).length, 3); assert.equal(merged.selectedAction, 'read_files'); assert.equal(merged.objective, s.objective);
});

test('Edits that would leave a TypeScript or JavaScript file unparseable are refused with the parser message', async t => {
  const { root, store } = await fixture(t);
  const src = 'export function f(a: number) {\n  return a + 1;\n}\nconst x = f(1);\n';
  await writeFile(join(root, 'a.ts'), src); await writeFile(join(root, 'b.js'), 'function g() { return 1 }\n'); await writeFile(join(root, 'notes.md'), 'a {\n');
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  await assert.rejects(tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(src), edits: [{ start: 2, end: 2, newText: '  return a +;', prepend: '' }] }), /would no longer parse \(line 2: Expression expected/);
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: hash(src), oldText: 'return a + 1;', newText: 'return a +;' }), /would no longer parse \(line 2: Expression expected/);
  await assert.rejects(tools.execute('write', { path: 'b.js', expectedHash: hash('function g() { return 1 }\n'), oldText: 'return 1', newText: 'return 1 1' }), /b\.js would no longer parse \(line 1: /);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), src);
  const ok = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(src), edits: [{ start: 1, end: 1, newText: 'import { y } from "./y.js";\nexport function f(a: number) {', prepend: '' }] });
  assert(ok.ok); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'import { y } from "./y.js";\n' + src);
  // non-code files are not parsed, and a file that is already broken can still be edited
  assert((await tools.execute('write', { path: 'notes.md', expectedHash: hash('a {\n'), oldText: 'a {', newText: 'b {' })).ok);
  await writeFile(join(root, 'broken.ts'), 'const a = ;\nconst b = ;\n');
  assert((await tools.execute('write', { path: 'broken.ts', expectedHash: hash('const a = ;\nconst b = ;\n'), oldText: 'const a = ;', newText: 'const a = 1;' })).ok);
  assert.deepEqual(await syntaxErrors('x.py', 'def f(:'), []);
  await assert.rejects(tools.execute('move_lines', { source: 'a.ts', expectedHash: hash('import { y } from "./y.js";\n' + src), start: 2, end: 3, destination: 'c.ts', destinationHash: 'new', replacement: '', prefix: '' }), /not a complete block|would no longer parse/);
});
test('The resolver covers not-exported and wrong-module errors with the declaration line to fix', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'sdk/src/cli'), { recursive: true });
  await writeFile(join(root, 'sdk/src/cli.ts'), 'type Writable = 1;\nexport type Other = 2;\n');
  await writeFile(join(root, 'sdk/src/models.ts'), 'export interface Finding { a: 1 }\n');
  await writeFile(join(root, 'sdk/src/cli/deps.ts'), 'import type { Writable } from "../cli.js";\nimport type { Finding } from "../api.js";\n');
  const output = ['src/cli/deps.ts(1,15): error TS2459: Module \'"../cli.js"\' declares \'Writable\' locally, but it is not exported.',
    'src/cli/deps.ts(2,15): error TS2305: Module \'"../api.js"\' has no exported member \'Finding\'.',
    'src/cli/deps.ts(3,1): error TS2552: Cannot find name \'Othr\'. Did you mean \'Other\'?'].join('\n');
  const by = Object.fromEntries((await resolveMissingNames(root, output, ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts'])).map(n => [n.name, n]));
  assert.equal(by.Writable!.declaredIn, 'sdk/src/cli.ts:1'); assert.equal(by.Writable!.exported, false); assert.match(by.Writable!.note!, /already imported from \.\.\/cli\.js; add the export keyword to the declaration at sdk\/src\/cli\.ts:1/); assert.equal(by.Writable!.importLine, undefined);
  assert.equal(by.Finding!.importLine, 'import type { Finding } from "../models.js";'); assert.match(by.Finding!.note!, /\.\.\/api\.js does not export it; replace that import with this one$/);
  assert.match(by.Othr!.note!, /no import or declaration found/);
});

test('replace_lines can prefix lines in place, so exporting declarations needs only their line numbers', async t => {
  const { root, store } = await fixture(t);
  const src = 'type Writable = Pick<X, "write"> & {\n  end?(): void;\n};\ntype SignalName = "SIGINT";\nfunction exportEnvironment() {}\nconst keep = 1;\n';
  await writeFile(join(root, 'cli.ts'), src);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const r = await tools.execute('replace_lines', { path: 'cli.ts', expectedHash: hash(src), edits: [
    { start: 1, end: 1, newText: '', prepend: 'export ' }, { start: 4, end: 5, newText: 'ignored when prepend is set', prepend: 'export ' }, { start: 6, end: 6, newText: '', prepend: '' } ] });
  assert(r.ok);
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), 'export type Writable = Pick<X, "write"> & {\n  end?(): void;\n};\nexport type SignalName = "SIGINT";\nexport function exportEnvironment() {}\n');
  assert.match(r.text, /Replaced 3 range\(s\) 1\.\.1, 4\.\.5, 6\.\.6/);
  // a prefix that is already there is a no-op and is skipped, not an error
  const now = await readFile(join(root, 'cli.ts'), 'utf8');
  await assert.rejects(tools.execute('replace_lines', { path: 'cli.ts', expectedHash: hash(now), edits: [{ start: 4, end: 4, newText: 'export type SignalName = "SIGINT";', prepend: '' }] }), /every newText equals/);
});
test('Not-exported errors resolve to a ready prepend edit on the declaration line', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'sdk/src/cli'), { recursive: true });
  await writeFile(join(root, 'sdk/src/cli.ts'), 'const a = 1;\ntype Writable = 1;\n');
  const output = 'src/cli/deps.ts(1,15): error TS2459: Module \'"../cli.js"\' declares \'Writable\' locally, but it is not exported.';
  const [n] = await resolveMissingNames(root, output, ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts']);
  assert.match(n!.note!, /replace_lines edit \{ start: 2, end: 2, newText: "", prepend: "export " \} on sdk\/src\/cli\.ts/);
});

test('The check command is remembered from the last verification', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'x' }, { command: 'pnpm lint', purpose: 'p' });
  assert.equal(s.lastCheckCommand, 'pnpm lint');
  s.step = 2; await runner.evidence(s, 'bash', { ok: true, verification: false, text: 'y' }, { command: 'ls', purpose: 'p' });
  assert.equal(s.lastCheckCommand, 'pnpm lint');
});
test('The decision state shrinks optional lists and the evidence tail before pausing', async t => {
  const { session: s } = await fixture(t);
  s.missingNames = Array.from({ length: 40 }, (_, i) => ({ name: `Name${i}`, inFile: 'deps.ts', importLine: `import { Name${i} } from "../m${i}.js";`, note: 'x'.repeat(400) }));
  s.entries = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, step: i, kind: 'read_files', artifact: '', text: 'y'.repeat(6000), relevance: .5 }));
  s.searches = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`text:q${i} in .`, 'z'.repeat(300)]));
  const state = decisionState(s) as any;
  assert(Buffer.byteLength(JSON.stringify(state)) <= 22000);
  assert.equal(state.missingNames.total, 40); assert(Object.values(state.missingNames.addImports).flat().length <= 36); assert.deepEqual(Object.keys(state.missingNames), ['addImports', 'addExportAtLines', 'removeImports', 'removeImportLines', 'aliasImports', 'respecImports', 'moveDeclarations', 'unresolved', 'total']);
  assert.equal(state.evidenceCount, 20); assert(state.evidence.length <= 8); assert(state.objective.includes('Fix'));
});
test('Panel lines are flattened to one ASCII row each', () => {
  const out: string[] = [];
  const d = new Display({ write: (s: string) => out.push(s), isTTY: true, columns: 100 }, { objective: 'x', session: 's', verbose: false });
  d.update({ kind: 'generated', step: 1, route: 'bash', meta: null, args: { command: 'grep' + '\n[' + '…' + 'truncated' + '…' + ']\n' + 'x'.repeat(200) } } as any);
  for (const l of d.panel()) { assert(!l.includes('\n')); assert(l.length <= 99); assert(/^[\x20-\x7e]*$/.test(l), l); }
});

test('Loading an older checkpoint recovers the check command from the pinned bash result', async t => {
  const { store, session } = await fixture(t);
  session.lastCheck = { step: 3, ok: false, text: JSON.stringify({ command: 'pnpm --dir sdk/typescript lint', purpose: 'p', output: 'x', code: 1 }), summary: summarizeCheck('x') };
  (session as any).lastCheckCommand = undefined;
  await store.save(session);
  assert.equal((await store.load()).lastCheckCommand, 'pnpm --dir sdk/typescript lint');
});

test('The prompt tail and evidence are bounded regardless of the working budget', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, workingTokens: 40000, contextWindow: 60000 }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.missingNames = Array.from({ length: 60 }, (_, i) => ({ name: `N${i}`, inFile: 'sdk/deps.ts', declaredIn: `sdk/cli.ts:${100 + i}`, exported: false, note: 'y'.repeat(300) }));
  s.rejectedEdits = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, identity: `k${i}`, step: i, undoneAt: i + 1, route: 'replace_lines', summary: 'a'.repeat(200), reason: 'b'.repeat(400) }));
  s.searches = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`text:q${i} in .`, 'z'.repeat(300)]));
  for (let i = 1; i <= 16; i++) { s.step = i; await runner.evidence(s, i % 4 === 0 ? 'bash' : i % 4 === 1 ? 'search_codebase' : 'read_files', { ok: true, text: `f${i}.ts sha256=h totalLines=9 shown=1..9\n` + 'x'.repeat(9000) }); }
  assert.equal(s.entries.length, 12);
  const byKind = Object.fromEntries(s.entries.map(e => [e.kind, e.text.length]));
  assert(byKind.read_files! <= defaults.toolChars && byKind.read_files! > 5000); assert(byKind.bash! <= 2500); assert(byKind.search_codebase! <= 1500);
  const prompt = messages(s, 'replace_lines');
  const tail = prompt.at(-1)!.content;
  assert(tail.length < 6000, `tail ${tail.length}`);
  const fields = JSON.parse(tail);
  assert.equal(fields.missingNames.total, 60); assert.deepEqual(fields.missingNames.addExportAtLines['sdk/cli.ts'].slice(0, 3), [100, 101, 102]); assert.equal(fields.missingNames.addExportAtLines['sdk/cli.ts'].length, 60);
  assert.equal(fields.rejectedEdits.length, 3); assert.equal(Object.keys(fields.searched).length, 10);
  const state = decisionState(s) as any;
  assert(Buffer.byteLength(JSON.stringify(state)) < 12000, `state ${Buffer.byteLength(JSON.stringify(state))}`);
});
test('A fresh read of the same range flags the older copy as stale so it is evicted first', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner(defaults, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  const read = (step: number, path: string, start: number) => runner.evidence(s, 'read_files', { ok: true, text: `${path} sha256=h totalLines=9 shown=${start}..${start + 4}\n${start}: line` }, { files: [{ path, start, end: start + 4 }] });
  s.step = 1; await read(1, 'a.ts', 1); s.step = 2; await read(2, 'a.ts', 6); s.step = 3; await read(3, 'b.ts', 1); s.step = 4; await read(4, 'a.ts', 1);
  assert.deepEqual(s.entries.map(e => e.id), ['e1', 'e2', 'e3', 'e4']);
  assert.match(s.entries[0]!.stale!, /superseded by the read at step 4/); assert.equal(s.entries[1]!.stale, undefined);
  while (s.entries.length > 3) evictOne(s);
  assert.deepEqual(s.entries.map(e => e.id), ['e2', 'e3', 'e4'], 'the stale copy is evicted first');
});

test('Loading a checkpoint collapses superseded reads to their header line', async t => {
  const { store, session } = await fixture(t);
  session.entries = [{ id: 'e1', step: 1, kind: 'read_files', artifact: '', relevance: .2, text: '[superseded by the edit at step 4; re-read a.ts]\na.ts sha256=abc totalLines=2 shown=1..2\n1: one\n2: two' }];
  await store.save(session);
  const loaded = await store.load();
  assert.equal(loaded.entries[0]!.text, '[superseded by the edit at step 4; re-read a.ts]\na.ts sha256=abc totalLines=2 shown=1..2'); assert.equal(loaded.entries[0]!.relevance, .1);
});

test('Regression rule: judged in scope, exempting structural moves, keeping net progress with a new syntax error', () => {
  const sum = (errors: number, syntax = 0, byFile: Record<string, { count: number; syntax: number; lines: number[]; samples: string[] }> = {}) => ({ errors, syntax, byFile });
  assert.equal(regression(null, sum(50)), 'fine');
  assert.equal(regression(sum(305), sum(696)), 'worse');
  assert.equal(regression(sum(100), sum(101)), 'worse'); assert.equal(regression(sum(100), sum(101), { structural: true }), 'fine');
  assert.equal(regression(sum(100), sum(90)), 'fine'); assert.equal(regression(sum(100), sum(100)), 'fine');
  // net progress with one new syntax error is kept; no progress with a new syntax error is not
  assert.equal(regression(sum(16), sum(1, 1)), 'fine'); assert.equal(regression(sum(1), sum(1, 1)), 'worse'); assert.equal(regression(sum(696), sum(687, 6)), 'fine');
  // Fewer syntax errors is progress whatever the total does: a file that did not parse was not checked at all.
  assert.equal(regression(sum(1, 1), sum(4, 0)), 'fine', 'a repaired parse surfaces the errors that were always there'); assert.equal(regression(sum(2, 1), sum(2, 1)), 'fine');
  const f = (count: number, syntax = 0) => ({ count, syntax, lines: [], samples: [] });
  const before = sum(210, 0, { 'src/a.ts': f(10), 'tests/t.ts': f(200) }); const after = sum(162, 0, { 'src/a.ts': f(12), 'tests/t.ts': f(150) });
  assert.equal(regression(before, after, { files: ['sdk/src/a.ts'] }), 'worse', 'in-scope increase is a regression even when the total fell');
  assert.equal(regression(before, after), 'fine');
  assert.equal(regression(before, sum(159, 0, { 'src/a.ts': f(9), 'tests/t.ts': f(150) }), { files: ['sdk/src/a.ts'] }), 'fine');
  // Progress in the edited file is progress whatever appears elsewhere: the
  // check reached its next stage (the bundler after tsc) or other files.
  assert.equal(regression(sum(1, 0, { 'src/components/Button.tsx': f(1) }), sum(2, 0, { '(other)': f(2) }), { files: ['src/components/Button.tsx'] }), 'fine', 'the fix removed its file\'s only error; the build stage\'s errors are new work');
  assert.equal(regression(sum(2, 0, { 'src/a.ts': f(2) }), sum(4, 0, { 'src/a.ts': f(1), 'src/b.ts': f(3) }), { files: ['src/a.ts'] }), 'fine');
  assert.equal(regression(sum(1, 0, { 'src/a.ts': f(1) }), sum(3, 0, { 'src/a.ts': f(1), '(other)': f(2) }), { files: ['src/a.ts'] }), 'worse', 'no progress in the edited file and more errors is still a regression');
});
test('A decided fix the check rolled back counts against the file version it came from', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 2;\n'); const before = 'const a = 1;\n';
  const artifact = await store.snapshot(3, 'a.ts', before);
  session.transaction = [{ key: 'k', identity: 'i', step: 3, route: 'replace_lines', paths: ['a.ts'], summary: '{}', kind: 'decided-fix' }, { key: 'k2', identity: 'i2', step: 4, route: 'replace_lines', paths: ['b.ts'], summary: '{}' }];
  session.lastCheck = { step: 5, ok: false, text: 'x', summary: summarizeCheck('a.ts(1,1): error TS2322: bad') }; session.previousCheck = { step: 2, ok: true, text: '', summary: summarizeCheck('') };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  await runner.undo(session, { 'a.ts': artifact }, 'worse');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), before);
  assert.deepEqual(session.fixAttempts, { [`a.ts@${hash(before)}`]: 1 }, 'the rolled-back decided fix counts against the restored version; the free edit does not');
});

test('Duplicate import lines are dropped from an insertion; a pasted block the file already has is refused', async t => {
  const header = Array.from({ length: 8 }, (_, i) => `import { name${i} } from "./module${i}.js";`).join('\n');
  const before = `${header}\nconst x = 1;\n`;
  const { kept, dropped } = dropDuplicateImports(before, [...header.split('\n'), 'import { fresh } from "./fresh.js";']);
  assert.deepEqual(kept, ['import { fresh } from "./fresh.js";']); assert.equal(dropped.length, 8);
  assert.equal(dropDuplicateImports(before, ["import { name0 } from './module0.js'"]).dropped.length, 1, 'quote style and semicolons do not matter');
  const body = Array.from({ length: 8 }, (_, i) => `const value${i} = compute(${i});`).join('\n');
  assert.throws(() => assertNoBulkDuplication(body, body.split('\n'), 'x.ts'), /would insert a block that x\.ts already contains/);
  assertNoBulkDuplication(body, ['const value0 = compute(0);'], 'x.ts');
  // Shared idioms scattered through a file are not a paste: only a contiguous run is.
  const idioms = ['  if (!value) return;', '  const next = await step();', '  results.push(next);', '  count += 1;', '  if (count > limit) break;'];
  const spread = idioms.flatMap(l => [l, '  // separate context']).join('\n');
  assertNoBulkDuplication(spread, idioms, 'y.ts');
  assert.throws(() => assertNoBulkDuplication(idioms.join('\n'), idioms, 'y.ts'), /already contains/);
  assertNoBulkDuplication(idioms.join('\n'), idioms, 'deps.ts', false);
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'cli.ts'), before);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  // An insertion whose only new lines are imports the file already has is a no-op, named as such.
  await assert.rejects(tools.execute('replace_lines', { path: 'cli.ts', expectedHash: hash(before), edits: [{ start: 9, end: 8, newText: 'import { name0 } from "./module0.js";', prepend: '' }] }), /only new lines were imports cli\.ts already has/);
  // An insertion mixing a duplicate with a new import lands with the duplicate dropped: repaired, not refused.
  const r = await tools.execute('replace_lines', { path: 'cli.ts', expectedHash: hash(before), edits: [{ start: 9, end: 8, newText: 'import { name0 } from "./module0.js";\nimport { fresh } from "./fresh.js";', prepend: '' }] });
  assert(r.ok); assert.match(r.text, /Dropped 1 import line/); const now = await readFile(join(root, 'cli.ts'), 'utf8');
  assert.equal(now.split('\n').filter(l => l.includes('name0')).length, 1); assert(now.includes('import { fresh } from "./fresh.js";'));
  const w = await tools.execute('write', { path: 'cli.ts', expectedHash: hash(now), oldText: 'const x = 1;', newText: 'import { name1 } from "./module1.js";\nconst x = 2;' });
  assert(w.ok); assert.match(w.text, /Dropped 1 import line/); assert.equal((await readFile(join(root, 'cli.ts'), 'utf8')).split('\n').filter(l => l.includes('name1')).length, 1);
});
test('After an edit the harness runs the check itself, rolls back an objective regression, and re-verifies', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  // check.mjs reports 1 error for the original file and 40 for the edited one
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('a.ts', 'utf8'); const n = t.includes('BAD') ? 40 : 1; for (let i = 0; i < n; i++) console.error(`a.ts(${i + 1},1): error TS2304: Cannot find name x${i}.`); process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  const jevCalls: string[] = []; const routes = ['bash', 'read_files', 'replace_lines', 'read_files'];
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => { jevCalls.push(ctx!.phase); const a = answersFor(q, routes[n++] ?? 'read_files', .1) as any; if (q.undo) a.undo = { type: 'noul', noul: 0 }; return a; } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    if (schema === schemas.bash) return { command: 'node check.mjs', purpose: 'check' };
    if (schema === schemas.read_files) return { files: [{ path: 'a.ts', start: 1, end: 1 }] };
    return { path: 'a.ts', expectedHash: promptFields(m).fileHashes['a.ts'], edits: [{ start: 1, end: 1, newText: 'const a = BAD;', prepend: '' }] };
  } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 7 }, store, jev, bonsai, root, () => {}).run(session);
  // 1 check(1 error) · 2 forced focus read · 3 read · 4 edit · 5 forced check (40 errors) · 6 forced undo · 7 forced re-check (1 error)
  assert.deepEqual(result.entries.map(e => e.kind), ['bash', 'read_files', 'read_files', 'replace_lines', 'bash', 'undo', 'bash']);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\n');
  assert.match(result.entries[5]!.text, /went from 1 errors \(0 syntax\) to 40 \(0 syntax\)/);
  assert.equal(result.lastCheck!.summary.errors, 1); assert.equal(result.rejectedEdits.length, 1);
  assert.deepEqual(jevCalls, ['routing-and-context', 'routing-and-context', 'routing-and-context'], 'no Jev call for the forced read, check, undo or re-check');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.type === 'auto-check').length, 2); assert(events.some(e => e.type === 'action' && e.data.forced));
});
test('An improving check is committed, an in-scope increase is rolled back, and a structural move is exempt', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  const errs = (n: number, extra = '') => Array.from({ length: n }, (_, i) => `a.ts(${i + 1},1): error TS2304: x`).join('\n') + extra;
  s.step = 1; await runner.evidence(s, 'bash', { ok: false, verification: true, text: errs(100) }, { command: 'node check.mjs', purpose: 'p' });
  s.step = 2; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00002-a.ts' }, text: 'Updated' });
  assert.equal(s.pendingCheck, true);
  s.step = 3; await runner.evidence(s, 'bash', { ok: false, verification: true, text: errs(80) }, { command: 'node check.mjs', purpose: 'p' });
  assert.equal(s.autoUndo, null); assert.deepEqual(s.transaction, []); assert.equal(s.pendingCheck, false);
  // a repair edit that raises the in-scope count by one is a regression, whatever happens in other files
  s.step = 4; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00004-a.ts' }, text: 'Updated' });
  s.step = 5; await runner.evidence(s, 'bash', { ok: false, verification: true, text: errs(81) + '\n' + Array.from({ length: 50 }, (_, i) => `tests/t.ts(${i + 1},1): error TS7006: y`).join('\n') }, { command: 'node check.mjs', purpose: 'p' });
  const au = s.autoUndo as any; assert.deepEqual(au?.files, { 'a.ts': '@artifact/00004-a.ts' }); assert.match(au.reason, /in scope a\.ts/);
  s.autoUndo = null;
  // a structural move is judged only on syntax: the count may rise until its follow-ups land
  s.step = 6; await runner.evidence(s, 'move_lines', { ok: true, changed: ['a.ts', 'b.ts'], snapshots: { 'a.ts': '@artifact/00006-a.ts' }, text: 'Moved' });
  (s.transaction as any[]).push({ key: 'k', identity: 'k', step: 6, route: 'move_lines', paths: ['a.ts', 'b.ts'], summary: 'move' });
  s.step = 7; await runner.evidence(s, 'bash', { ok: false, verification: true, text: errs(120) + '\nb.ts(1,1): error TS2304: z' }, { command: 'node check.mjs', purpose: 'p' });
  assert.equal(s.autoUndo, null); assert.deepEqual(s.transaction, []);
  // but new syntax errors with no net progress still roll a move back
  s.step = 8; await runner.evidence(s, 'move_lines', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': '@artifact/00008-a.ts' }, text: 'Moved' });
  (s.transaction as any[]).push({ key: 'k2', identity: 'k2', step: 8, route: 'move_lines', paths: ['a.ts'], summary: 'move' });
  s.step = 9; await runner.evidence(s, 'bash', { ok: false, verification: true, text: errs(121) + "\na.ts(5,1): error TS1005: ')' expected." }, { command: 'node check.mjs', purpose: 'p' });
  assert.deepEqual((s.autoUndo as any)?.files, { 'a.ts': '@artifact/00008-a.ts' });
});

test('Four inspections do not force an edit before the needed source has been located', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 6; s.inspectionsSinceAction = 4; s.writes = ['a.ts'];
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria); assert('replace_lines' in route.criteria);
  s.inspectionsSinceAction = 3;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria);
  s.inspectionsSinceAction = 4; s.phase = 'inspect';
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria);
});

test('The harness applies resolved import and export fixes itself, then verifies them', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'sdk/src/cli'), { recursive: true });
  await writeFile(join(root, 'sdk/src/cli.ts'), '#!/usr/bin/env node\nimport { a } from "./a.js";\nimport {\n  b,\n} from "./b.js";\ntype Writable = 1;\nconst keep = 1;\nfunction exportEnvironment() {}\n');
  await writeFile(join(root, 'sdk/src/cli/deps.ts'), 'import type { Writable } from "../cli.js";\nimport { exportEnvironment } from "../cli.js";\nconst x: Finding = 1;\n');
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const cli = readFileSync('sdk/src/cli.ts', 'utf8'); const deps = readFileSync('sdk/src/cli/deps.ts', 'utf8'); const out = [];\nif (!cli.includes('export type Writable')) out.push(\"src/cli/deps.ts(1,15): error TS2459: Module '\\\"../cli.js\\\"' declares 'Writable' locally, but it is not exported.\");\nif (!cli.includes('export function exportEnvironment')) out.push(\"src/cli/deps.ts(2,10): error TS2459: Module '\\\"../cli.js\\\"' declares 'exportEnvironment' locally, but it is not exported.\");\nif (!deps.includes('import type { Finding }')) out.push(\"src/cli/deps.ts(3,10): error TS2304: Cannot find name 'Finding'.\");\nfor (const l of out) console.error(l); process.exit(out.length ? 1 : 0);\n");
  await writeFile(join(root, 'sdk/src/models.ts'), 'export interface Finding { a: 1 }\n');
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts'];
  const jevCalls: number[] = [];
  const jev = { decide: async (state: any, q: Questions) => { jevCalls.push(state.step ?? -1); return answersFor(q, 'read_files', .1); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'sdk/src/cli.ts', start: 1, end: 3 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  // 1 baseline check (3 errors) · 2 auto-fix cli.ts (exports) · 3 forced check · 4 auto-fix deps.ts (import) · 5 forced check (passes)
  const kinds = result.entries.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 5), ['bash', 'replace_lines', 'bash', 'replace_lines', 'bash'], kinds.join(','));
  assert.equal(await readFile(join(root, 'sdk/src/cli.ts'), 'utf8'), '#!/usr/bin/env node\nimport { a } from "./a.js";\nimport {\n  b,\n} from "./b.js";\nexport type Writable = 1;\nconst keep = 1;\nexport function exportEnvironment() {}\n');
  assert.equal(await readFile(join(root, 'sdk/src/cli/deps.ts'), 'utf8'), 'import type { Writable } from "../cli.js";\nimport { exportEnvironment } from "../cli.js";\nimport type { Finding } from "../models.js";\nconst x: Finding = 1;\n');
  assert.equal(result.lastCheck!.ok, true); assert.equal(result.missingNames.length, 0);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.type === 'auto-fix').length, 2);
  assert(jevCalls.length <= 2, `Jev was consulted ${jevCalls.length} times; the baseline, fixes and verification needed none`);
});
test('After a failing check the harness reads the named lines of edited files before the worker is asked', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n');
  await writeFile(join(root, 'check.mjs'), "console.error('a.ts(30,7): error TS2322: bad'); process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  const jevStates: any[] = [];
  const jev = { decide: async (state: any, q: Questions) => { jevStates.push(state); return answersFor(q, 'read_files', .1); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'a.ts', start: 1, end: 5 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['bash', 'read_files', 'read_files']);
  assert.match(result.entries[1]!.text, /shown=22\.\.42/); assert.equal(result.readHashes['a.ts'], result.hashes['a.ts']);
  assert.equal(jevStates.length, 1, 'only the third step consulted Jev');
  assert.equal(result.focusReadAt, 1);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.find(e => e.type === 'auto-read')?.data.files, [{ path: 'a.ts', start: 22, end: 42 }]);
});
test('The routing state stays under budget without pausing, whatever the session holds', async t => {
  const { session: s } = await fixture(t);
  s.objective = 'x'.repeat(5000);
  s.entries = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, step: i, kind: 'read_files', artifact: '', text: 'y'.repeat(6000), relevance: .5, stale: i < 5 ? 'old' : undefined }));
  s.missingNames = Array.from({ length: 80 }, (_, i) => ({ name: `N${i}`, inFile: 'deps.ts', importLine: `import { N${i} } from "../m${i}.js";` }));
  s.lastError = 'e'.repeat(10000);
  s.lastCheck = { step: 3, ok: false, text: 't'.repeat(1500), summary: summarizeCheck(Array.from({ length: 300 }, (_, i) => `f${i % 30}.ts(${i},1): error TS2304: x`).join('\n')) };
  const state = decisionState(s) as any;
  assert(Buffer.byteLength(JSON.stringify(state)) <= 22000);
  assert.equal(state.evidence[0].stale, undefined); assert(state.evidence.length <= 8); assert.equal(state.missingNames.total, 80);
});

test('Errors the check does not attribute to a file always count toward the regression verdict', () => {
  // A test runner's failure lines carry no file path; the scope filter must not drop them.
  const before = summarizeCheck('ok');
  const after = summarizeCheck('AssertionError [ERR_ASSERTION]: expected 1 to be 2\nnot ok 3 - prices are rounded\n# fail 1');
  assert.equal(after.errors, 2); assert.equal(after.byFile['(other)']?.count, 2);
  assert.equal(regression(before, after, { files: ['src/a.ts'] }), 'worse');
  assert.equal(regression(after, after, { files: ['src/a.ts'] }), 'fine');
  // With attribution, out-of-scope files are still ignored but the unattributed bucket is not.
  const f = (count: number) => ({ count, syntax: 0, lines: [1], samples: [] as string[] });
  const b = { errors: 3, syntax: 0, byFile: { 'src/a.ts': f(1), 'tests/t.ts': f(2) } };
  const a = { errors: 4, syntax: 0, byFile: { 'src/a.ts': f(1), 'tests/t.ts': f(1), '(other)': f(2) } };
  assert.equal(regression(b, a, { files: ['src/a.ts'] }), 'worse');
  // Path matching is segment-safe: cli.ts does not stand for deps-cli.ts.
  assert.equal(regression({ errors: 0, syntax: 0, byFile: {} }, { errors: 2, syntax: 0, byFile: { 'src/deps-cli.ts': f(2), 'src/cli.ts': f(0) } }, { files: ['cli.ts'], structural: true }), 'fine');
});
test('A created file is never rolled back and never a rejected edit; a mixed transaction is judged on its edits; a move into a new destination is still undone whole', async t => {
  const { root, store, session: s } = await fixture(t);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true }, (p, text) => store.snapshot(s.step, p, text));
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  const moved = await tools.execute('move_lines', { source: 'a.ts', expectedHash: hash('const a = 1;\n'), start: 1, end: 1, destination: 'src/cli/fresh.ts', destinationHash: 'new', prefix: '', replacement: '' });
  assert.equal(moved.snapshots?.['src/cli/fresh.ts'], '@new');
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  // A failing baseline, then a created file whose own errors raise the count: committed, not rolled back.
  s.step = 1; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'a.ts(1,1): error TS2304: x' }, { command: 'node check.mjs', purpose: 'p' });
  s.step = 2; const created = await tools.execute('create_file', { path: 'src/cli/deps.ts', content: 'import { y } from "./y";\nexport const x = y;\n' });
  await runner.evidence(s, 'create_file', created, { path: 'src/cli/deps.ts', content: 'x' });
  s.transaction.push({ key: 'k', identity: 'i', step: 2, route: 'create_file', paths: ['src/cli/deps.ts'], summary: 'created' });
  assert.deepEqual(s.editSnapshots, {}, 'a creation has nothing to restore'); assert.equal(s.baselineArtifacts['src/cli/deps.ts'], '@new', 'but the completion diff knows it was created');
  s.step = 3; await runner.evidence(s, 'bash', { ok: false, verification: true, text: "a.ts(1,1): error TS2304: x\nsrc/cli/deps.ts(1,19): error TS2307: Cannot find module './y'" }, { command: 'node check.mjs', purpose: 'p' });
  assert.equal(s.autoUndo, null); assert.deepEqual(s.transaction, []); assert.equal(await readFile(join(root, 'src/cli/deps.ts'), 'utf8'), 'import { y } from "./y";\nexport const x = y;\n');
  // A mixed transaction is judged on the edited file only: the edit is reverted, the created file stays.
  s.step = 4; const snap = await store.snapshot(4, 'a.ts', 'const a = 1;\n'); await writeFile(join(root, 'a.ts'), 'const a = BAD;\n');
  await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], snapshots: { 'a.ts': snap }, text: 'Updated' });
  (s.transaction as any[]).push({ key: 'k2', identity: 'i2', step: 4, route: 'write', paths: ['a.ts'], summary: 'edit' });
  s.step = 5; const other = await tools.execute('create_file', { path: 'src/cli/more.ts', content: 'export const m = 1;\n' }); await runner.evidence(s, 'create_file', other, { path: 'src/cli/more.ts', content: 'x' });
  (s.transaction as any[]).push({ key: 'k3', identity: 'i3', step: 5, route: 'create_file', paths: ['src/cli/more.ts'], summary: 'created' });
  s.step = 6; await runner.evidence(s, 'bash', { ok: false, verification: true, text: "a.ts(1,1): error TS2304: x\na.ts(1,11): error TS2304: BAD\nsrc/cli/deps.ts(1,19): error TS2307: Cannot find module './y'" }, { command: 'node check.mjs', purpose: 'p' });
  const undo = s.autoUndo as any; assert.deepEqual(Object.keys(undo?.files ?? {}), ['a.ts'], 'only the edited file is rolled back');
  s.step = 7; await runner.undo(s, undo.files, 'worse'); s.autoUndo = null;
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\n'); assert.equal(await readFile(join(root, 'src/cli/more.ts'), 'utf8'), 'export const m = 1;\n');
  assert(s.rejectedEdits.length === 1 && s.rejectedEdits.every(r => r.route !== 'create_file'), 'a creation is never a rejected edit');
  // The destination a move created is part of the move: undone with it.
  s.step = 8; await runner.undo(s, moved.snapshots!, 'worse');
  await assert.rejects(readFile(join(root, 'src/cli/fresh.ts'), 'utf8'), /ENOENT/); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\n');
});
test('Undo restores read state only for versions that were read, and un-flags reads the rolled-back edit made stale', async t => {
  const { root, store, session: s } = await fixture(t);
  const text = 'const a = 1;\nconst b = 2;\n';
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true }, (p, t) => store.snapshot(s.step, p, t));
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'read_files', await tools.execute('read_files', { files: [{ path: 'a.ts', start: 1, end: 2 }] }), { files: [] });
  const h = hash(text); assert.equal(s.readHashes['a.ts'], h);
  s.step = 2; const edited = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: h, edits: [{ start: 1, end: 1, newText: 'const a = BAD;', prepend: '' }] });
  await runner.evidence(s, 'replace_lines', edited, {});
  assert.match(s.entries[0]!.stale ?? '', /^edited at step 2/);
  s.step = 3; await runner.undo(s, edited.snapshots!, 'worse');
  assert.equal(s.entries[0]!.stale, undefined, 'the read describes the file again'); assert.equal(s.readHashes['a.ts'], h);
  // A file restored to a version that was written but never read is not marked read.
  await writeFile(join(root, 'b.ts'), 'let b = 1;\n');
  const written = await tools.execute('write', { path: 'b.ts', expectedHash: hash('let b = 1;\n'), oldText: 'let b = 1;', newText: 'let b = 2;' });
  s.step = 4; await runner.evidence(s, 'write', written, {});
  const written2 = await tools.execute('write', { path: 'b.ts', expectedHash: hash('let b = 2;\n'), oldText: 'let b = 2;', newText: 'let b = 3;' });
  s.step = 5; await runner.evidence(s, 'write', written2, {});
  s.step = 6; await runner.undo(s, written2.snapshots!, 'worse');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'let b = 2;\n'); assert(!('b.ts' in s.readHashes), 'never read at that version');
});
test('replace_lines deletes blank lines and never treats a deletion as a no-op', async t => {
  const { root, store } = await fixture(t);
  const before = 'const a = 1;\n\nconst b = 2;\n';
  await writeFile(join(root, 'a.ts'), before);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(before), edits: [{ start: 2, end: 2, newText: '', prepend: '' }] });
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
  const after = 'const a = 1;\nconst b = 2;\n';
  await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(after), edits: [{ start: 3, end: 2, newText: 'const c = 3;', prepend: '' }] });
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'appending after a trailing newline adds one line');
  // The documented append form, start = totalLines + 1, where totalLines counts the trailing empty element.
  const three = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(three), edits: [{ start: 5, end: 4, newText: 'const d = 4;', prepend: '' }] });
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n', 'no blank line and the final newline is kept');
  await assert.rejects(tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash('const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n'), edits: [{ start: 1, end: 1, newText: 'const a = 1;', prepend: '' }] }), /no change/i);
});
test('A stale line-edit keeps read_files offered even past the inspection cap, and the cap resets', async t => {
  const { session: s } = await fixture(t);
  s.phase = 'implement'; s.inspectionCount = 3; s.writes = ['a.ts']; s.inspectionsSinceAction = 5;
  s.lastRoute = 'replace_lines'; s.lastResultOk = false; s.lastWriteStale = true;
  const q = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(q.type === 'choice'); assert('read_files' in q.criteria, 'the recovery read must be reachable'); assert(!('replace_lines' in q.criteria));
});
test('Import insertion uses the parser: an import-shaped line inside a string is not an import', async () => {
  const text = "#!/usr/bin/env node\nimport { a } from './a.js';\nimport type { B } from './b.js';\nconst tpl = `\nimport { fake } from './nope.js';\n`;\nexport const x = a;\n";
  assert.equal(await importInsertLine('src/x.ts', text), 4);
  assert.equal(await importInsertLine('src/y.ts', "'use strict';\nconst a = 1;\n"), 2);
  assert.equal(await importInsertLine('src/z.ts', "#!/usr/bin/env node\nconst a = 1;\n"), 2);
  assert.equal(await importInsertLine('src/w.ts', 'const a = 1;\n'), 1);
  assert.equal(await importInsertLine('notes.txt', "import { a } from './a.js';\ntext\n"), 2, 'non-TypeScript files fall back to the line scan');
});
test('Auto-fix touches only files this session edited, and a failing baseline during inspection does not skip reading', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n'); await writeFile(join(root, 'other.ts'), 'const o = helper();\n'); await writeFile(join(root, 'lib.ts'), 'export function helper() { return 1; }\n');
  await writeFile(join(root, 'check.mjs'), "console.error('other.ts(1,11): error TS2304: Cannot find name \\'helper\\'.'); process.exit(1);\n");
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'read_files', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'a.ts', start: 1, end: 1 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries[0]!.kind, 'bash'); assert(!result.entries.some(e => e.kind === 'replace_lines'), 'no auto-fix in a file the session never edited');
  assert.equal(await readFile(join(root, 'other.ts'), 'utf8'), 'const o = helper();\n');
  assert.equal(result.phase, 'inspect', 'a failing baseline is context, not a reason to start editing before reading');
  assert.equal(result.missingNames.length, 1, 'the resolved fix stays visible to the models');
});

test('Superseded failures cannot evict every success and recreate the repeated-read loop', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner(defaults, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  // Reproduce the paused run's mixture of high-priority checks and generation errors.
  for (let step = 1; step <= 15; step++) {
    s.step = step;
    if (step % 3 === 0) await runner.evidence(s, 'generation_error', { ok: false, text: 'Repeated edit; not executed' });
    else await runner.evidence(s, 'bash', { ok: false, verification: true, text: JSON.stringify({ command: 'lint', output: 'a.ts(1,1): error TS2304: Cannot find name x.', code: 1 }) }, { command: 'lint' });
  }
  s.step = 16;
  await runner.evidence(s, 'move_lines', { ok: true, changed: ['a.ts', 'deps.ts'], text: 'Moved Dependencies from a.ts to deps.ts' });
  s.step = 17;
  await runner.evidence(s, 'bash', { ok: true, verification: true, check: true, text: 'lint passed' }, { command: 'lint' });
  for (let step = 18; step <= 20; step++) {
    s.step = step;
    await runner.evidence(s, 'read_files', { ok: true, text: `a.ts sha256=abc totalLines=250 shown=${step}..${step}\n${step}: code` }, { files: [{ path: 'a.ts', start: step, end: step }] });
  }
  assert(s.entries.some(e => e.step === 17), 'the passing check survives new reads');
  assert(s.entries.some(e => e.step === 18), 'a fresh read survives the next read so duplicate detection can find it');
  const state = decisionState(s) as any;
  assert(state.evidence.every((e: any) => !e.excerpt.includes('Cannot find name') && e.kind !== 'generation_error'));
  const finalPrompt = promptFields(messages(s, 'finish'));
  assert(finalPrompt.evidence.every((e: any) => !e.text.includes('Cannot find name') && e.kind !== 'generation_error'), 'the final summary does not see superseded failures as current evidence');
  s.entries = [];
  assert.match((decisionState(s) as any).editEvidence[0].text, /Moved Dependencies/);
  assert.match(promptFields(messages(s, 'finish')).editEvidence[0].text, /Moved Dependencies/);
});

test('Legacy resume recovers only confirmed edits, excludes rollbacks, and retires obsolete checks', async t => {
  const { store, session: s } = await fixture(t);
  s.step = 9; s.lastWriteStep = 7; s.lastCheckStep = 8; s.lastCheckCommand = 'lint';
  s.lastCheck = { step: 8, ok: true, text: 'passed', summary: summarizeCheck('passed') };
  s.entries = [
    { id: 'e1', step: 1, kind: 'bash', text: '{"command":"lint","output":"failed"}', artifact: '', relevance: .9 },
    { id: 'e2', step: 2, kind: 'bash', text: '{"command":"diagnostic","output":"failed"}', artifact: '', relevance: .9 },
    { id: 'e3', step: 3, kind: 'generation_error', text: 'old attempt', artifact: '', relevance: .9 },
  ];
  for (const step of [4, 5, 6, 7]) {
    await store.log('action', { step, route: 'write', args: { path: 'a.ts' } });
    const artifact = await store.artifact(step, `Applied edit ${step}`);
    if (step !== 6) await store.log('result', { step, ok: step !== 5, artifact });
  }
  await store.log('undo', { step: 8, rejected: [{ step: 7 }] });
  delete (s as any).editEvidence;
  await store.save(s);
  const recovered = await store.load();
  assert.deepEqual(recovered.editEvidence.map(e => e.step), [4]);
  assert.equal(recovered.editEvidence[0]!.text, 'Applied edit 4');
  assert(recovered.entries[0]!.stale); assert(!recovered.entries[1]!.stale, 'unrelated diagnostics are not superseded by lint');
  assert(recovered.entries[2]!.stale);
  await store.save(recovered);
  assert.deepEqual((await store.load()).editEvidence, recovered.editEvidence, 'reload must not duplicate evidence');
});

test('Legacy checkpoints without an event log still resume without inventing edit evidence', async t => {
  const { store, session } = await fixture(t);
  delete (session as any).editEvidence;
  await store.save(session);
  assert.deepEqual((await store.load()).editEvidence, []);
});


test('Referenced plan requirements survive eviction and restart, and guide source facts for a short objective', async t => {
  const { root, store, session: s } = await fixture(t);
  s.objective = 'Read plan.md. Perform only Step 1 substep 1';
  const preamble = Array.from({ length: 90 }, (_, i) => `Background paragraph ${i}.`).join('\n');
  const plan = `${preamble}\n**Step 0 — Baseline**\n1. Run all tests.\n**Step 1 — Extract leaves**\n1. Extract CliDependencies and DEFAULT_DEPENDENCIES into deps.ts.\n   Update main to use deps.DEFAULT_DEPENDENCIES.\n2. Extract OtherTask into other.ts.\n**Step 10 — Later work**\n1. Do not include this task.\n`;
  await writeFile(join(root, 'plan.md'), plan);
  await writeFile(join(root, 'cli.ts'), `${'// unrelated\n'.repeat(300)}type CliDependencies = {};\nconst DEFAULT_DEPENDENCIES = {};\n`);
  const runner = new Runner(defaults, store, {} as any, {} as any, root, () => {});
  const args = { files: [{ path: 'plan.md', start: 78, end: 110 }] };
  await runner.evidence(s, 'read_files', await runner.tools.execute('read_files', args), args);
  const refs = referenceContext(s);
  assert.match(JSON.stringify(refs), /CliDependencies/);
  assert(!JSON.stringify(refs).includes('OtherTask'));
  assert(!JSON.stringify(refs).includes('Step 0'));
  s.entries = [];
  await store.save(s);
  const resumed = await store.load();
  assert.deepEqual(referenceContext(resumed), refs);
  assert.match(JSON.stringify(decisionState(resumed)), /CliDependencies/);
  assert.match(JSON.stringify(promptFields(messages(resumed, 'search_codebase')).referenceEvidence), /DEFAULT_DEPENDENCIES/);
  const facts = await completionSource(root, ['cli.ts'], [resumed.objective, ...referenceContext(resumed).map(e => e.text)].join('\n'));
  assert(facts[0]!.facts.some(f => f.name === 'CliDependencies' && f.line === 301));
  resumed.hashes['plan.md'] = 'changed';
  assert.deepEqual(referenceContext(resumed), [], 'changed requirements need a fresh read');
});

test('Only observed referenced documents are pinned and reference budgets also bound multibyte text', async t => {
  const { session: s } = await fixture(t);
  s.objective = 'Read plan.md and implement the requested feature';
  rememberReferences(s, 'other.md sha256=123 totalLines=1 shown=1..1\n1: unrelated');
  assert.deepEqual(s.referenceEvidence, []);
  for (let start = 1; start < 1000; start += 24)
    rememberReferences(s, `plan.md sha256=123 totalLines=1000 shown=${start}..${start + 23}\n` + Array.from({ length: 24 }, (_, i) => `${start + i}: ${'🪴'.repeat(200)}`).join('\n'));
  assert(Buffer.byteLength(JSON.stringify(s.referenceEvidence)) < 12500);
  assert(Buffer.byteLength(JSON.stringify(referenceContext(s))) < 6100);
  assert(Buffer.byteLength(JSON.stringify(decisionState(s))) <= 22000);
});

test('Legacy completion pauses resume implementation with the observed plan requirements', async t => {
  const { store, session: s } = await fixture(t);
  s.objective = 'Read plan.md. Perform only Step 1 substep 1';
  s.status = 'paused'; s.phase = 'verify'; s.inspectionsSinceAction = 4;
  s.stopReason = 'Completion was not established by tool evidence twice; paused for review';
  s.entries = [{ id: 'e1', step: 1, kind: 'read_files', artifact: '', relevance: .5,
    text: 'plan.md sha256=123 totalLines=4 shown=1..4\n1: **Step 1 — Extract leaves**\n2: 1. Extract Dependencies.\n3: 2. Later work.\n4: end' }];
  delete (s as any).referenceEvidence; delete (s as any).completionFeedback;
  await store.save(s);
  const loaded = await store.load();
  assert.equal(loaded.phase, 'implement'); assert.equal(loaded.completionFeedback?.awaitingEvidence, true);
  assert.match(JSON.stringify(decisionState(loaded)), /Extract Dependencies/);
  const q = routeQuestions(loaded, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(q.type === 'choice'); assert('read_files' in q.criteria && 'search_codebase' in q.criteria);
  assert(!('finish' in q.criteria));
});

test('A later failing check or pending verification withholds finish despite an earlier pass', async t => {
  const { session: s } = await fixture(t);
  s.phase = 'implement'; s.step = 4; s.lastCheckStep = 1;
  s.lastCheck = { step: 3, ok: false, text: 'failed', summary: summarizeCheck('failed') };
  const hasFinish = () => 'finish' in (routeQuestions(s, defaults).route as { criteria: Record<string, string> }).criteria;
  assert(!hasFinish());
  s.lastCheck.ok = true; assert(hasFinish());
  s.pendingCheck = true; assert(!hasFinish());
});



test('Completion reads real current declarations and imports, not lookalikes inside comments or strings', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'cli.ts'), `import type { Dependencies as Deps } from './deps.js';\nconst template = "export interface Fake {}";\n// export const GHOST = 1;\n`);
  await writeFile(join(root, 'deps.ts'), 'export interface Dependencies {}\nexport const DEFAULTS = {};\nconst PRIVATE = 1;\n');
  const facts = await completionSource(root, ['cli.ts', 'deps.ts'], 'Extract Dependencies as Deps with DEFAULTS PRIVATE Fake GHOST.');
  assert.deepEqual(facts[0]!.facts, [{ line: 1, endLine: 1, kind: 'import', name: 'Deps', imported: 'Dependencies', from: './deps.js', typeOnly: true }]);
  assert.deepEqual(facts[1]!.facts.map(f => [f.name, f.exported]), [['Dependencies', true], ['DEFAULTS', true], ['PRIVATE', false]]);
  assert.equal(facts[1]!.hash, hash(await readFile(join(root, 'deps.ts'))));
  const missing = await completionSource(root, ['missing.ts', '../outside.ts'], 'Missing');
  assert(missing.every(f => f.error && !f.hash && !f.facts.length));
});

test('Fresh source facts establish completion even when rollback history lost the original extraction', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'cli.mjs'), "import { Dependency, DEFAULTS } from './deps.mjs';\n");
  await writeFile(join(root, 'deps.mjs'), 'export class Dependency {}\nexport const DEFAULTS = {};\n');
  s.objective = 'Extract Dependency and DEFAULTS into deps.mjs, import both in cli.mjs, and verify.';
  s.phase = 'implement'; s.step = 3; s.lastWriteStep = 2; s.writes = ['cli.mjs', 'deps.mjs'];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    if (ctx?.phase === 'completion-check') {
      assert.deepEqual(state.editEvidence, [], 'the history does not prove the extraction');
      assert(state.currentSource[0].facts.some((f: any) => f.kind === 'import' && f.name === 'Dependency'));
      assert(state.currentSource[1].facts.some((f: any) => f.exported && f.name === 'DEFAULTS'));
    }
    return answersFor(q, 'finish');
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (prompt: any) => {
    assert.equal(promptFields(prompt).currentSource.length, 2);
    return { summary: 'cli.mjs imports Dependency and DEFAULTS from deps.mjs. Verification passed.' };
  } };
  const runner = new Runner({ ...defaults, maxSteps: 1 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'node --check passed' }, { command: 'node --check deps.mjs' });
  assert.deepEqual(s.lastCheck!.fileHashes, await sourceHashes(root, s.writes));
  assert.equal((await runner.run(s)).status, 'complete');
});

test('Files changed during final-summary generation must be reverified before completion', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'deps.mjs'), 'export const DEFAULTS = {};\n');
  s.objective = 'Export DEFAULTS and verify.'; s.phase = 'implement'; s.step = 3; s.lastWriteStep = 2; s.writes = ['deps.mjs'];
  let generated = 0; let audited = 0;
  const jev = { decide: async (_state: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx?.phase === 'completion-check') { audited++; assert.equal(s.lastCheck!.step, 5); }
    return answersFor(q, 'finish');
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => {
    if (++generated === 1) await writeFile(join(root, 'deps.mjs'), 'export const DEFAULTS = {};\n// external edit\n');
    return { summary: 'DEFAULTS is exported and verification passed.' };
  } };
  const runner = new Runner({ ...defaults, allowBash: true, maxSteps: 3 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'passed' }, { command: 'node --check deps.mjs' });
  const result = await runner.run(s);
  assert.equal(result.status, 'complete'); assert.equal(generated, 2); assert.equal(audited, 1);
  assert.match(await readFile(join(store.path, 'events.jsonl'), 'utf8'), /completion-stale/);
});

test('Legacy passing checks without file versions are re-run once on resume', async t => {
  const { store, session: s } = await fixture(t);
  s.status = 'paused'; s.writes = ['deps.ts']; s.lastWriteStep = 1; s.lastCheckStep = 2;
  s.lastCheckCommand = 'lint'; s.lastCheck = { step: 2, ok: true, text: 'passed', summary: summarizeCheck('passed') };
  await store.save(s);
  assert.equal((await store.load()).pendingCheck, true);
  s.lastCheck.fileHashes = { 'deps.ts': 'abc' }; await store.save(s);
  assert.equal((await store.load()).pendingCheck, false);
});

test('Completion source evidence stays bounded and reports omitted facts', async t => {
  const { root } = await fixture(t);
  const names = Array.from({ length: 100 }, (_, i) => `Name${i}`);
  const paths = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
  for (const path of paths) await writeFile(join(root, path), names.map(n => `export const ${n} = 1;`).join('\n'));
  const facts = await completionSource(root, paths, names.join(' '));
  assert(Buffer.byteLength(JSON.stringify(facts)) < 7000);
  assert(facts.every(f => f.omitted! > 0));
});

test('Unresolved names decide before the plain count: removing one is progress even when types surface further errors', () => {
  // Step 88 of the 31-minute run: replacing an any-typed import from a test file with the real module
  // removed a TS7016 and revealed a TS18047; the count rose 1 -> 2 and the correct fix was rolled back.
  const before = summarizeCheck("src/cli/deps.ts(44,26): error TS7016: Could not find a declaration file for module '../../x.mjs'.");
  const after = summarizeCheck("src/cli/deps.ts(200,47): error TS18047: 'stdout' is possibly 'null'.\nsrc/cli/deps.ts(210,3): error TS2322: Type 'x' is not assignable.");
  assert.equal(before.resolution, 1); assert.equal(after.resolution, 0);
  assert.equal(regression(before, after, { files: ['sdk/typescript/src/cli/deps.ts'] }), 'fine');
  // Deleting an import that is still used adds an unresolved name: worse when the total does not fall.
  const flat = summarizeCheck("src/cli.ts(505,5): error TS2304: Cannot find name 'stripVTControlCharacters'.\nsrc/cli.ts(9,1): error TS6133: 'x' is declared but its value is never read.");
  assert.equal(regression(after, flat, { files: ['sdk/typescript/src/cli.ts', 'sdk/typescript/src/cli/deps.ts'] }), 'worse');
  // Removing fourteen unused imports and breaking one used binding is progress the resolver completes (15 -> 2 in the paused run).
  const fifteen = summarizeCheck(Array.from({ length: 15 }, (_, i) => `src/cli.ts(${i + 1},1): error TS6133: 'n${i}' is declared but its value is never read.`).join('\n'));
  const two = summarizeCheck("src/cli.ts(3836,17): error TS2304: Cannot find name 'componentPlanSchema'.\nsrc/cli/deps.ts(3,1): error TS6133: 'resolve' is declared but its value is never read.");
  assert.equal(regression(fifteen, two, { files: ['sdk/typescript/src/cli.ts', 'sdk/typescript/src/cli/deps.ts'] }), 'fine');
  // A structural move legitimately leaves unresolved names behind.
  const many = summarizeCheck(Array.from({ length: 30 }, (_, i) => `src/cli.ts(${i + 1},1): error TS2304: Cannot find name 'CliDependencies'.`).join('\n'));
  assert.equal(regression(summarizeCheck('ok'), many, { files: ['sdk/typescript/src/cli.ts'], structural: true }), 'fine');
  assert.equal(regression(summarizeCheck('ok'), many, { files: ['sdk/typescript/src/cli.ts'] }), 'worse');
});
test('The check advice names incremental tsc and the non-incremental command to use', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'sdk', 'typescript'), { recursive: true });
  await writeFile(join(root, 'sdk', 'typescript', 'tsconfig.json'), '{ "compilerOptions": { "incremental": true, "noEmit": true } }\n');
  const advice = await checkAdvice(root, 'pnpm --dir sdk/typescript lint');
  assert.match(advice ?? '', /incremental mode/); assert.match(advice ?? '', /pnpm --dir sdk\/typescript exec tsc --noEmit --incremental false/);
  assert.equal(await checkAdvice(root, 'pnpm --dir sdk/typescript exec tsc --noEmit --incremental false'), null);
  assert.equal(await checkAdvice(root, 'npm test'), null);
  await writeFile(join(root, 'sdk', 'typescript', 'tsconfig.json'), '{ "compilerOptions": { "noEmit": true } }\n');
  assert.equal(await checkAdvice(root, 'pnpm --dir sdk/typescript lint'), null);
});
test('A name declared in several files, or only in test files, is reported as ambiguous rather than guessed', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true }); await mkdir(join(root, 'plugins', 'tests'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'import { execFile as execFileCallback } from "node:child_process";\nconst other = 1;\n');
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'const x = execFile();\n');
  await writeFile(join(root, 'src', 'github.ts'), 'const execFile = promisify(execFileCallback);\n');
  await writeFile(join(root, 'src', 'targets.ts'), 'const execFile = promisify(execFileCallback);\n');
  await writeFile(join(root, 'plugins', 'tests', 'test_inventory.mjs'), 'const execFile = promisify(nodeExecFile);\nconst onlyHere = 1;\n');
  const names = await resolveMissingNames(root, "src/cli/deps.ts(1,11): error TS2304: Cannot find name 'execFile'.\nsrc/cli/deps.ts(2,1): error TS2304: Cannot find name 'onlyHere'.", ['src/cli.ts', 'src/cli/deps.ts']);
  assert.equal(names[0]!.importLine, undefined); assert.match(names[0]!.note ?? '', /declared in several files \(src\/github\.ts, src\/targets\.ts\)/);
  assert.match(names[1]!.importLine ?? '', /plugins\/tests\/test_inventory\.mjs/, 'a test file is used only when nothing else declares the name');
  // Declared once in the source of the move: that declaration wins, with the export it needs.
  await writeFile(join(root, 'src', 'cli.ts'), 'import { execFile as execFileCallback } from "node:child_process";\nconst execFile = promisify(execFileCallback);\n');
  const own = await resolveMissingNames(root, "src/cli/deps.ts(1,11): error TS2304: Cannot find name 'execFile'.", ['src/cli.ts', 'src/cli/deps.ts']);
  assert.equal(own[0]!.importLine, 'import { execFile } from "../cli.js";'); assert.equal(own[0]!.declaredIn, 'src/cli.ts:2'); assert.equal(own[0]!.exported, false);
});
test('Auto-fix never edits a file the session did not touch and never re-applies a rolled-back fix', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'import { x } from "./third.js";\nconst a = x;\n'); await writeFile(join(root, 'third.ts'), 'const x = 1;\n');
  // The check blames a.ts for an import whose declaration in third.ts lacks export.
  await writeFile(join(root, 'check.mjs'), "console.error(`a.ts(1,10): error TS2459: Module '\"./third.js\"' declares 'x' locally, but it is not exported.`); process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'read_files', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'a.ts', start: 1, end: 2 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(await readFile(join(root, 'third.ts'), 'utf8'), 'const x = 1;\n', 'third.ts is not the session\'s to edit');
  assert(!result.entries.some(e => e.kind === 'replace_lines'));
  assert.equal(result.missingNames.length, 1, 'the fix stays listed for the worker');
  // A fix identical to one that was rolled back is skipped.
  const { root: r2, store: s2, session: sess } = await fixture(t);
  await writeFile(join(r2, 'b.ts'), 'const b = y;\n'); await writeFile(join(r2, 'lib.ts'), 'export const y = 1;\n');
  await writeFile(join(r2, 'check.mjs'), "console.error(`b.ts(1,11): error TS2304: Cannot find name 'y'.`); process.exit(1);\n");
  sess.phase = 'implement'; sess.inspectionCount = 3; sess.writes = ['b.ts'];
  const edits = [{ start: 1, end: 0, newText: 'import { y } from "./lib.js";', prepend: '' }];
  sess.rejectedEdits = [{ key: 'k', identity: hash(JSON.stringify({ route: 'replace_lines', args: { path: 'b.ts', edits, expectedHash: undefined, destinationHash: undefined } })), step: 1, route: 'replace_lines', summary: '', undoneAt: 2, reason: 'worse' }];
  const r = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 3 }, s2, jev, { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'b.ts', start: 1, end: 1 }] }) }, r2, () => {}).run(sess);
  assert.equal(await readFile(join(r2, 'b.ts'), 'utf8'), 'const b = y;\n'); assert(!r.entries.some(e => e.kind === 'replace_lines'));
});

test('Unused import bindings are removed by the harness without dropping a binding still in use', async t => {
  const { root, store, session } = await fixture(t);
  const text = 'import { existsSync, writeSync } from "node:fs";\nimport {\n  componentPlanSchema,\n  planComponents,\n} from "./component-plan.js";\nimport type { Only } from "./only.js";\nimport def from "./def.js";\nconst unusedLocal = 1;\nexport const a = existsSync("x") && componentPlanSchema && def;\n';
  await writeFile(join(root, 'a.ts'), text);
  const check = "a.ts(1,22): error TS6133: 'writeSync' is declared but its value is never read.\na.ts(4,3): error TS6133: 'planComponents' is declared but its value is never read.\na.ts(6,15): error TS6196: 'Only' is declared but never used.\na.ts(8,7): error TS6133: 'unusedLocal' is declared but its value is never read.";
  const names = await resolveMissingNames(root, check, ['a.ts']);
  assert.deepEqual(names.map(n => [n.name, n.kind, n.line]), [['writeSync', 'unused', 1], ['planComponents', 'unused', 4], ['Only', 'unused', 6]], 'a local const is not an import');
  const edits = await removeImportBindings('a.ts', text, ['writeSync', 'planComponents', 'Only']);
  assert.deepEqual(edits, [
    { start: 1, end: 1, newText: 'import { existsSync } from "node:fs";', prepend: '' },
    { start: 2, end: 5, newText: 'import { componentPlanSchema } from "./component-plan.js";', prepend: '' },
    { start: 6, end: 6, newText: '', prepend: '' },
  ]);
  // End to end: the check names the unused bindings, the harness removes them, the check passes, no worker edit.
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('a.ts', 'utf8'); const errs = []; if (t.includes('writeSync')) errs.push(`a.ts(1,22): error TS6133: 'writeSync' is declared but its value is never read.`); if (t.includes('planComponents')) errs.push(`a.ts(4,3): error TS6133: 'planComponents' is declared but its value is never read.`); if (errs.length) { console.error(errs.join('\\n')); process.exit(1); }\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts'];
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'read_files', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'a.ts', start: 1, end: 2 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'import { existsSync } from "node:fs";\nimport { componentPlanSchema } from "./component-plan.js";\nimport type { Only } from "./only.js";\nimport def from "./def.js";\nconst unusedLocal = 1;\nexport const a = existsSync("x") && componentPlanSchema && def;\n');
  assert.deepEqual(result.entries.map(e => e.kind).slice(0, 3), ['bash', 'replace_lines', 'bash']); assert.equal(result.lastCheck?.ok, true);
});

test('After four inspections with every edited file read at its current version, reads leave the menu', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 6; s.inspectionsSinceAction = 4; s.writes = ['a.ts']; s.hashes['a.ts'] = 'h1';
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria, 'a.ts not yet read at its current version');
  s.readHashes['a.ts'] = 'h1';
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('read_files' in route.criteria)); assert(!('search_codebase' in route.criteria)); assert('replace_lines' in route.criteria);
  s.readHashes['a.ts'] = 'stale';
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria, 'edited since the last read: the read is needed again');
});
test('A passing check after edits proposes finish once without asking Jev to route, and a rejection is retired by later edits', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts']; session.step = 4; session.lastWriteStep = 3;
  session.editEvidence = [{ step: 3, route: 'write', path: 'a.ts', summary: 'edited' } as any];
  session.completionFeedback = { step: 2, text: 'Completion rejected (lowest claim support=0.3, deliverable coverage=0.4). The objective is still unfinished.', awaitingEvidence: false };
  const phases: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => { phases.push(ctx!.phase); const a = answersFor(q, 'read_files', .9) as any; if (q.stop_condition) a.stop_condition = { type: 'noul', noul: .05 }; return a; } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'a.ts exports a. The check passed.' } : { files: [{ path: 'a.ts', start: 1, end: 1 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  // step 4: baseline check passes (after the edit at 3) -> step 5: harness proposes finish, audited, accepted
  assert.equal(result.status, 'complete'); assert.equal(result.stopReason, 'a.ts exports a. The check passed.');
  assert.deepEqual(phases, ['completion-check'], 'the harness proposed finish without asking Jev to route, then the audit ran');
  assert.match(result.completionFeedback?.text ?? '', /^The completion proposed at step 2 was rejected/); assert.equal(result.completionFeedback?.addressed, true);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'auto-finish'));
});

test('A deliverable still declared in the move source is reported as something to move, never imported back', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'type Writable = { write(s: string): void };\ntype Other = string;\nexport const x = 1;\n');
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const HIDE_CURSOR = "x";\nexport function f(w: Writable, o: Other) {}\n');
  const plan = 'Step 1\n2. Extract `Writable`, `SignalName`, terminal constants (`HIDE_CURSOR`), `invokedAsMain()` -> src/cli/deps.ts.';
  const names = namedIdentifiers(plan);
  assert(names.has('Writable') && names.has('HIDE_CURSOR') && names.has('invokedAsMain') && names.has('SignalName') && !names.has('Extract'));
  const check = "src/cli/deps.ts(2,22): error TS2304: Cannot find name 'Writable'.\nsrc/cli/deps.ts(2,35): error TS2304: Cannot find name 'Other'.";
  const out = await resolveMissingNames(root, check, ['src/cli.ts', 'src/cli/deps.ts'], 40, names);
  assert.equal(out[0]!.importLine, undefined); assert.equal(out[0]!.declaredIn, 'src/cli.ts:1'); assert.equal(out[0]!.kind, 'move'); assert.deepEqual(out[0]!.move, { source: 'src/cli.ts', start: 1, end: 1 }); assert.match(out[0]!.note ?? '', /the harness moves it into src\/cli\/deps\.ts/);
  assert.equal(out[1]!.importLine, 'import type { Other } from "../cli.js";', 'a helper that is not a deliverable is imported as before');
  const fixes = compactNames({ missingNames: out } as any, 40);
  assert.deepEqual(fixes.addImports, { 'src/cli/deps.ts': ['import type { Other } from "../cli.js";'] }); assert.deepEqual(fixes.addExportAtLines, { 'src/cli.ts': [2] }, 'the export fix belongs to the imported helper only, at its own line');
  assert.deepEqual(fixes.moveDeclarations, [{ name: 'Writable', source: 'src/cli.ts', start: 1, end: 1, into: 'src/cli/deps.ts' }]); assert.deepEqual(fixes.unresolved, []);
});

test('Before any edit, a source file read at its current version counts as located for the inspection cap', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 8; s.inspectionsSinceAction = 6;
  s.hashes['docs/plan.md'] = 'p'; s.readHashes['docs/plan.md'] = 'p';
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('read_files' in route.criteria, 'only a document was read: the source is not located');
  s.hashes['src/cli.ts'] = 'h'; s.readHashes['src/cli.ts'] = 'h';
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('read_files' in route.criteria)); assert('move_lines' in route.criteria);
});
test('An uncertain vote between an edit and a read goes to the edit once inspections have run', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  session.phase = 'implement'; session.inspectionCount = 3; session.inspectionsSinceAction = 2; session.hashes['a.ts'] = hash('const a = 1;\n'); session.readHashes['a.ts'] = session.hashes['a.ts']!;
  const phases: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    phases.push(ctx!.phase);
    const keys = Object.keys(q.route!.type === 'choice' ? q.route!.criteria : {});
    if (ctx!.phase === 'routing-narrowed') return { route: { type: 'choice', choice: 'read_files', confidence: .1, probabilities: { read_files: .55, write: .45 } } } as Answers;
    const p: Record<string, number> = Object.fromEntries(keys.map(k => [k, 0])); p.write = .33; p.read_files = .28; p.search_codebase = .12; p.replace_lines = .27;
    return { route: { type: 'choice', choice: 'write', confidence: .2, probabilities: p } } as Answers;
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ path: 'a.ts', expectedHash: session.hashes['a.ts'], oldText: 'const a = 1;', newText: 'const a = 2;' }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries[0]!.kind, 'write'); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 2;\n');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'tie-break')?.data.rule, 'edit over inspection after inspections');
});

test('A long anchor that matches is applied; the result notes that replace_lines addresses blocks by number', async t => {
  const { root, store } = await fixture(t);
  const text = Array.from({ length: 12 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const block = text.split('\n').slice(3, 11).join('\n');
  const r = await tools.execute('write', { path: 'a.ts', expectedHash: hash(text), oldText: block, newText: `export ${block}` });
  assert(r.ok); assert.match(r.text, /anchor was 8 lines; replace_lines addresses a block by line number/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), text.replace(block, `export ${block}`));
});
test('Retyping a block in place with a change is a rewrite, not a paste, and a redundant prepend keyword is refused up front', async t => {
  const { root, store } = await fixture(t);
  const block = ['type Writable = Pick<NodeJS.WriteStream, "write"> & {', '  on?(event: "error", listener: (error: Error) => void): unknown;', '  off?(event: "error", listener: (error: Error) => void): unknown;', '  once?(event: "close", listener: () => void): unknown;', '  isTTY?: boolean;', '  columns?: number;', '};'];
  const text = ['const a = 1;', ...block, 'const b = 2;', ''].join('\n');
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const retyped = [`export ${block[0]}`, ...block.slice(1)].join('\n');
  const r = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(text), edits: [{ start: 2, end: 8, newText: retyped, prepend: '' }] });
  assert(r.ok); assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), ['const a = 1;', ...retyped.split('\n'), 'const b = 2;', ''].join('\n'));
  // Pasting the same block elsewhere is still refused.
  const now = await readFile(join(root, 'a.ts'), 'utf8');
  await assert.rejects(tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(now), edits: [{ start: 10, end: 9, newText: block.join('\n'), prepend: '' }] }), /already contains/);
  // prepend "export const " on a const line: refused with the right prefix named.
  await assert.rejects(tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(now), edits: [{ start: 1, end: 1, newText: '', prepend: 'export const ' }] }), /already starts with "const".*use prepend "export "/);
  // write keeps the same rule: a short anchor rewritten with export is fine.
  const w = await tools.execute('write', { path: 'a.ts', expectedHash: hash(now), oldText: 'const b = 2;', newText: 'export const b = 2;' });
  assert(w.ok);
});

test('An objective naming several substeps pins every one of them, so the plan text for each is in scope', async t => {
  const { session: s } = await fixture(t);
  const plan = ['# Plan', '', '**Step 1 — Lift pure leaves out of `main()`** (no behavior changes)', '1. Extract `CliDependencies` type + `DEFAULT_DEPENDENCIES` factory →', '   `src/cli/deps.ts`. Update `main()`\'s default arg to `deps.DEFAULT_DEPENDENCIES`.', '2. Extract `Writable`, `SignalName`, terminal constants (`PROGRESS_REFRESH_MILLISECONDS`,', '   `HIDE_CURSOR`, `SHOW_CURSOR`, `DUPLICATE_SIGNAL_WINDOW_MS`), `invokedAsMain()`,', '   `isJsonObject()` → `src/cli/deps.ts`.', '3. Extract all `z` option schemas → `src/cli/options.ts`.', '', '**Step 2 — Later**', '1. Something else.'];
  const read = `docs/plan.md sha256=abc totalLines=${plan.length} shown=1..${plan.length}\n${plan.map((l, i) => `${i + 1}: ${l}`).join('\n')}`;
  assert.deepEqual(scopes('Read docs/plan.md. Perform only Step 1 substep 1 and substep 2').map(r => r.key), ['step 1 substep 1', 'step 1 substep 2']);
  assert.deepEqual(scopes('Do step 1 substeps 1-3').map(r => r.item), ['1', '2', '3']);
  assert.deepEqual(scopes('Do step 1 substep 2 and 3, then step 2 item 1').map(r => r.key), ['step 1 substep 2', 'step 1 substep 3', 'step 2 substep 1']);
  s.objective = 'Read docs/plan.md. Perform only Step 1 substep 1 and substep 2';
  rememberReferences(s, read);
  const scoped = s.referenceEvidence.filter(e => e.scope);
  assert.deepEqual(scoped.map(e => e.scope), ['step 1 substep 1', 'step 1 substep 2']);
  assert.match(scoped[1]!.text, /invokedAsMain\(\)/); assert.match(scoped[1]!.text, /isJsonObject\(\)/); assert(!/option schemas/.test(scoped[1]!.text), 'the excerpt ends before substep 3');
  const served = referenceContext(s);
  assert.deepEqual(served.map(e => e.scope), ['step 1 substep 1', 'step 1 substep 2'], 'both requested substeps are served, nothing unscoped');
  s.objective = 'Read docs/plan.md. Perform only Step 1 substep 2';
  assert.deepEqual(referenceContext(s).map(e => e.scope), ['step 1 substep 2']);
});

test('The same edit refusal twice in a row takes that route off the menu until another action succeeds', async t => {
  const { root, store, session } = await fixture(t);
  const text = 'export function main() {}\nconst a = 1;\n';
  await writeFile(join(root, 'a.ts'), text);
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts']; session.hashes['a.ts'] = hash(text); session.readHashes['a.ts'] = hash(text);
  const offered: string[][] = [];
  const jev = { decide: async (_s: unknown, q: Questions) => { const keys = Object.keys(q.route!.type === 'choice' ? q.route!.criteria : {}); offered.push(keys); return answersFor(q, keys.includes('replace_lines') ? 'replace_lines' : 'read_files', .1); } };
  let n = 0;
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.replace_lines
    ? { path: 'a.ts', expectedHash: hash(text), edits: [{ start: 1, end: 1, newText: '', prepend: 'export ' }, { start: 2, end: 2, newText: `// attempt ${++n}`, prepend: '' }] }
    : { files: [{ path: 'a.ts', start: 1, end: 2 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['replace_lines', 'replace_lines', 'read_files']);
  assert(offered[0]!.includes('replace_lines') && offered[1]!.includes('replace_lines') && !offered[2]!.includes('replace_lines'), 'blocked after the second identical refusal');
  assert.equal(result.blockedRoute, null, 'the successful read at step 3 lifts the block');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'blocked-route')?.data.step, 2);
});

test('A deliverable the destination needs is moved by the harness, in every resolver branch, with its full range', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  const iface = ['interface CliDependencies {', '  create(config: string): number;', '  other?: boolean;', '}'].join('\n');
  await writeFile(join(root, 'src', 'cli.ts'), `import { x } from "./x.js";\n${iface}\nexport const keep = 1;\nexport function main(deps: CliDependencies) { return deps; }\n`);
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const DEFAULT_DEPENDENCIES: CliDependencies = { create: () => 1 };\n');
  await writeFile(join(root, 'docs', 'plan.md').replace('/docs/', '/'), '');
  session.objective = 'Extract `CliDependencies` and `DEFAULT_DEPENDENCIES` into src/cli/deps.ts.';
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['src/cli.ts', 'src/cli/deps.ts'];
  // The not-exported branch: deps.ts imported it back by hand; the harness moves instead of exporting.
  const notExported = await resolveMissingNames(root, `src/cli/deps.ts(1,10): error TS2459: Module '"../cli.js"' declares 'CliDependencies' locally, but it is not exported.`, ['src/cli.ts', 'src/cli/deps.ts'], 40, namedIdentifiers(session.objective));
  assert.equal(notExported[0]!.kind, 'move'); assert.deepEqual(notExported[0]!.move, { source: 'src/cli.ts', start: 2, end: 5 });
  // End to end from a failing check: the harness moves the interface, the check passes, no worker edit.
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const d = readFileSync('src/cli/deps.ts', 'utf8'); if (!d.includes('interface CliDependencies')) { console.error(`src/cli/deps.ts(1,43): error TS2304: Cannot find name 'CliDependencies'.`); process.exit(1); }\n");
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'read_files', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'src/cli.ts', start: 1, end: 3 }] }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind).slice(0, 3), ['bash', 'move_lines', 'bash']);
  const deps = await readFile(join(root, 'src', 'cli', 'deps.ts'), 'utf8'); const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
  assert.match(deps, /export interface CliDependencies \{\n  create\(config: string\): number;\n  other\?: boolean;\n\}/); assert(!cli.includes('interface CliDependencies'));
  assert.match(cli, /import type \{ CliDependencies \} from ".\/cli\/deps.js";/, 'the source imports what it still uses');
  assert.equal(result.lastCheck?.ok, true);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'auto-move'));
});
test('A large range whose new text is mostly identical is applied, with a note naming the lines that changed', async t => {
  const { root, store } = await fixture(t);
  const lines = Array.from({ length: 20 }, (_, i) => `  key${i}: (signal?: AbortSignal) => run${i}(signal),`);
  const text = ['const deps = {', ...lines, '};', ''].join('\n');
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const retyped = lines.map((l, i) => i === 4 ? '  key4: (signal: AbortSignal) => run4(signal),' : l).join('\n');
  const r = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(text), edits: [{ start: 2, end: 21, newText: retyped, prepend: '' }] });
  assert(r.ok); assert.match(r.text, /rewrote 20 lines of which only 1 changed \(line 6\)/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), ['const deps = {', ...retyped.split('\n'), '};', ''].join('\n'));
  const now = await readFile(join(root, 'a.ts'), 'utf8');
  const rewritten = lines.map((_, i) => `  key${i}: () => ${i},`).join('\n');
  const g = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(now), edits: [{ start: 2, end: 21, newText: rewritten, prepend: '' }] });
  assert(g.ok); assert(!/rewrote/.test(g.text), 'a genuine rewrite carries no note');
});
test('The source still using a moved name is detected by the parser even after an unbalanced quote earlier in the file', async () => {
  const text = ["const re = /'/; // an apostrophe that a literal stripper mistakes for an open string", 'const other = 1;', 'function invokedAsMain(): boolean {', '  return true;', '}', 'if (invokedAsMain()) {', '  other;', '}', ''].join('\n');
  const plan = await movePlan('src/cli.ts', text, 3, 5, 'src/cli/deps.ts', '');
  assert.deepEqual(plan!.stillUsed, ['invokedAsMain']); assert.deepEqual(plan!.replacement, ['import { invokedAsMain } from "./cli/deps.js";']);
});
test('Deliverables never move against the session\'s extraction direction; the source imports them instead', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'import { x } from "./x.js";\nif (invokedAsMain()) { x; }\n');
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export function invokedAsMain(): boolean { return true; }\n');
  const check = "src/cli.ts(2,5): error TS2304: Cannot find name 'invokedAsMain'.";
  const names = namedIdentifiers('Extract `invokedAsMain()` to src/cli/deps.ts');
  const back = await resolveMissingNames(root, check, ['src/cli.ts', 'src/cli/deps.ts'], 40, names, { source: 'src/cli.ts', destination: 'src/cli/deps.ts' });
  assert.equal(back[0]!.kind, undefined); assert.equal(back[0]!.importLine, 'import { invokedAsMain } from "./cli/deps.js";');
  const free = await resolveMissingNames(root, check, ['src/cli.ts', 'src/cli/deps.ts'], 40, names, null);
  assert.equal(free[0]!.kind, 'move', 'without a known direction the old rule applies');
});
test('A stale destination hash does not refuse a move whose source is current, and the cap needs only one fresh edited file', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\nconst b = 2;\n'); await writeFile(join(root, 'd.ts'), 'export const z = 0;\n');
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const r = await tools.execute('move_lines', { source: 'a.ts', expectedHash: hash('const a = 1;\nconst b = 2;\n'), start: 2, end: 2, destination: 'd.ts', destinationHash: 'stale', replacement: '', prefix: '' });
  assert(r.ok); assert.match(r.text, /destinationHash was stale/); assert.equal(await readFile(join(root, 'd.ts'), 'utf8'), 'export const z = 0;\n\nexport const b = 2;\n');
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 6; s.inspectionsSinceAction = 4; s.writes = ['a.ts', 'd.ts']; s.hashes['a.ts'] = 'h1'; s.hashes['d.ts'] = 'h2'; s.readHashes['a.ts'] = 'h1';
  const route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('read_files' in route.criteria), 'a.ts is fresh; d.ts was changed by the harness and need not be re-read');
});


test('The onset ledger: the referenced document is read by the harness, the worker lists typed deliverables, Jev keeps the required ones, and the harness performs the moves', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true }); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'plan.md'), '# Plan\n\nPart A: Move the terminal constants HIDE_CURSOR and SHOW_CURSOR from src/cli.ts into src/cli/deps.ts. Relocate isJsonObject as well; leave main() where it is.\n\nPart B: later work, out of scope.\n');
  await writeFile(join(root, 'src', 'cli.ts'), 'const HIDE_CURSOR = "h";\nconst SHOW_CURSOR = "s";\nfunction isJsonObject(v: unknown): boolean { return typeof v === "object"; }\nexport function main() { return [HIDE_CURSOR, SHOW_CURSOR, isJsonObject(1)]; }\n');
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const DEFAULT_DEPENDENCIES = {};\n');
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.objective = 'Read docs/plan.md. Do only Part A of the plan.'; session.knownFiles.push('docs/plan.md');
  const phases: string[] = [];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    phases.push(ctx!.phase);
    if (ctx!.phase === 'ledger') {
      assert.equal(state.candidateDeliverables.length, 4);
      const a: Answers = { complete: { type: 'noul', noul: .9 } };
      for (const c of state.candidateDeliverables) a[`required_${c.id}`] = { type: 'noul', noul: c.name === 'main' ? .1 : .92 };
      return a;
    }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    if (schema === ledgerSchema) {
      assert.match(JSON.stringify(m), /Part A: Move the terminal constants/, 'the plan excerpt reaches the worker');
      return { deliverables: [
        { kind: 'move', name: 'HIDE_CURSOR', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'Move the terminal constant HIDE_CURSOR' },
        { kind: 'move', name: 'SHOW_CURSOR', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'Move the terminal constant SHOW_CURSOR' },
        { kind: 'move', name: 'isJsonObject', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'Relocate isJsonObject' },
        { kind: 'modify', name: 'main', from: 'src/cli.ts', to: '', detail: 'leave main() where it is' } ] };
    }
    if (schema === schemas.finish) return { summary: 'Part A is done and the check passed.' };
    return { files: [{ path: 'src/cli.ts', start: 1, end: 4 }] };
  } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 16 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(result.status, 'complete', `${result.stopReason} | steps: ${kinds.join(',')} | ledger: ${JSON.stringify(result.ledger.map(d => [d.name, d.status]))} | pending: ${JSON.stringify(result.pendingMoves)}`);
  assert.equal(kinds[0], 'bash'); assert.equal(kinds[1], 'read_files', 'the harness read the referenced document itself'); assert.equal(kinds[2], 'ledger');
  assert.deepEqual(result.ledger.map(d => [d.kind, d.name, d.status]), [['move', 'HIDE_CURSOR', 'done'], ['move', 'SHOW_CURSOR', 'done'], ['move', 'isJsonObject', 'done']], 'the main() item was classified as not required');
  assert.equal(kinds.filter(k => k === 'move_lines').length, 3);
  const deps = await readFile(join(root, 'src', 'cli', 'deps.ts'), 'utf8'); const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
  assert.match(deps, /export function isJsonObject/); assert(!/const HIDE_CURSOR =/.test(cli)); assert.match(cli, /from ".\/cli\/deps.js";/);
  assert.equal(result.status, 'complete', result.stopReason); assert.match(result.stopReason, /Deliverables: move HIDE_CURSOR to src\/cli\/deps.ts \(done\)/);
  assert(phases.includes('ledger') && phases.includes('completion-check'));
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'ledger')?.data.kept.length, 3); assert(events.some(e => e.type === 'completion-diff'));
});
test('Ledger statuses come from source facts for every kind', async t => {
  const { root, session: s } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'import { z } from "./z.js";\nconst keep = 1;\nexport const shown = 2;\nfunction gone() {}\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const moved = 3;\n');
  s.ledger = candidatesFrom({ deliverables: [
    { kind: 'move', name: 'moved', from: 'src/a.ts', to: 'src/b.ts', detail: 'moved already' },
    { kind: 'move', name: 'keep', from: 'src/a.ts', to: 'src/b.ts', detail: 'still to move' },
    { kind: 'move', name: 'ghost', from: 'src/a.ts', to: 'src/b.ts', detail: 'nowhere' },
    { kind: 'create', name: 'src/c.ts', from: '', to: 'src/c.ts', detail: 'new file' },
    { kind: 'export', name: 'keep', from: 'src/a.ts', to: '', detail: 'export keep' },
    { kind: 'export', name: 'shown', from: 'src/a.ts', to: '', detail: 'export shown' },
    { kind: 'import', name: 'z', from: './z.js', to: 'src/a.ts', detail: 'import z' },
    { kind: 'delete', name: 'gone', from: 'src/a.ts', to: '', detail: 'delete gone' },
    { kind: 'verify', name: 'node check.mjs', from: '', to: '', detail: 'check passes' },
    { kind: 'modify', name: 'main', from: 'src/a.ts', to: '', detail: 'change behaviour' } ] });
  s.lastCheck = { step: 4, ok: true, text: 'ok', summary: summarizeCheck('') }; s.lastWriteStep = 3;
  await refreshLedger(root, s);
  assert.deepEqual(s.ledger.map(d => `${d.name}:${d.status}`), ['moved:done', 'keep:pending', 'ghost:unknown', 'src/c.ts:pending', 'keep:pending', 'shown:done', 'z:done', 'gone:pending', 'node check.mjs:done', 'main:unknown']);
  assert.match(s.ledger[1]!.note ?? '', /still declared in src\/a\.ts lines 2-2/);
});
test('The structural diff reports declarations moved between files and chunks by file for the audit', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const before = 'import { x } from "./x.js";\nconst A = 1;\nexport function f() { return A; }\n';
  const artifact = await store.snapshot(1, 'src/a.ts', before);
  await writeFile(join(root, 'src', 'a.ts'), 'import { x } from "./x.js";\nimport { A } from "./b.js";\nexport function f() { return A; }\n');
  await writeFile(join(root, 'src', 'b.ts'), 'export const A = 1;\n');
  s.writes = ['src/a.ts', 'src/b.ts']; s.baselineArtifacts = { 'src/a.ts': artifact, 'src/b.ts': '@new' };
  const diff = await structuralDiff(root, s, store.artifacts);
  assert.deepEqual(diff.moved, [{ name: 'A', from: 'src/a.ts', to: 'src/b.ts' }]);
  assert.deepEqual(diff.files[0]!.declarationsRemoved, ['A']); assert.deepEqual(diff.files[0]!.importsAdded, ['A from ./b.js']); assert.match(diff.files[0]!.hunks ?? '', /^--- src\/a\.ts \(before\)/m);
  assert.equal(diff.files[1]!.created, true); assert.match(diff.files[1]!.declarationsAdded[0]!, /^A \(VariableStatement, exported, lines 1-1\)/);
  const items = candidatesFrom({ deliverables: [{ kind: 'move', name: 'A', from: 'src/a.ts', to: 'src/b.ts', detail: 'move A' }, { kind: 'verify', name: 'check', from: '', to: '', detail: 'passes' }] });
  const chunks = diffChunks(diff, items, 400);
  assert(chunks.length >= 2, 'a small budget splits the files'); assert.deepEqual(chunks[0]!.items.map(i => i.name), ['A', 'check'], 'the move rides with its files, the file-less item with the first chunk');
  assert(chunks.every(c => Buffer.byteLength(JSON.stringify(c.files)) <= 400 || c.files.length === 1));
  assert.deepEqual(Object.keys(completionQuestions(items, true)), ['implemented_d1', 'implemented_d2', 'objective_met', 'out_of_scope']);
  assert.deepEqual(Object.keys(completionQuestions(items, false)), ['implemented_d1', 'implemented_d2', 'out_of_scope']);
});
test('A finish is rejected on the diff when a deliverable is unmet, and the feedback names it with its source status', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'const K = 1;\nexport const done = 2;\n'); await writeFile(join(root, 'src', 'b.ts'), 'export const other = 0;\n');
  s.objective = 'Move K from src/a.ts to src/b.ts.'; s.phase = 'implement'; s.step = 3; s.lastWriteStep = 2; s.writes = ['src/a.ts', 'src/b.ts']; s.inspectionCount = 3;
  // An item judged by the diff (a modification) reaches the audit; one pending by
  // source facts never does, since finish is not offered while facts say no.
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'modify', name: 'K', from: 'src/a.ts', to: 'src/a.ts', detail: 'change K' }] });
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx?.phase === 'completion-check') { const a = answersFor(q, 'finish', .9) as Answers; a.d_d1 = { type: 'choice', choice: 'contradicts', confidence: .7, probabilities: { supports: .2, contradicts: .7, says_nothing: .1 } }; return a; }
    return answersFor(q, 'finish', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'K was moved.' }) };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'passed' }, { command: 'node --check src/a.ts' });
  const result = await runner.run(s);
  assert.equal(result.status, 'paused');
  assert.match(result.entries.at(-1)!.text, /Completion rejected \(out-of-scope changes=0\.\d\d\)\. Deliverables the evidence does not show as done: d1 modify K to src\/a\.ts \[unknown: judged from the diff at completion; supports 0\.20/);
  assert.equal(result.completionFeedback?.awaitingEvidence, true);
});

test('Ledger items with worker-invented paths or parenthesised names are repaired from the session\'s files, and junk items do not block the harness finish', async t => {
  const { root, session: s } = await fixture(t);
  await mkdir(join(root, 'sdk', 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'sdk', 'src', 'cli.ts'), 'const DEFAULTS = 1;\nfunction invokedAsMain() { return true; }\n');
  await writeFile(join(root, 'sdk', 'src', 'cli', 'deps.ts'), 'export const X = 0;\n');
  s.writes = ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts'];
  s.ledger = candidatesFrom({ deliverables: [
    { kind: 'move', name: 'invokedAsMain()', from: 'src/cli/main.ts', to: 'src/cli/deps.ts', detail: 'move' },
    { kind: 'move', name: 'DEFAULTS', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'move' },
    { kind: 'create', name: 'src/cli/deps.ts', from: '', to: '', detail: 'create the module' },
    { kind: 'import', name: 'deps', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'nonsense' } ] });
  assert.equal(s.ledger[0]!.name, 'invokedAsMain');
  await refreshLedger(root, s);
  assert.deepEqual(s.ledger.map(d => [d.name, d.from, d.to, d.status]), [
    ['invokedAsMain', 'sdk/src/cli.ts', 'sdk/src/cli/deps.ts', 'pending'], ['DEFAULTS', 'sdk/src/cli.ts', 'sdk/src/cli/deps.ts', 'pending'],
    ['src/cli/deps.ts', undefined, 'sdk/src/cli/deps.ts', 'done'], ['deps', 'sdk/src/cli.ts', 'sdk/src/cli/deps.ts', 'unknown']]);
});

test('Duplicate and conflicting import bindings are removed at the reported line, keeping the first import', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  const text = 'import { type JsonObject, type JsonValue } from "../config.js";\nimport type { CliDependencies } from "../cli.js";\nimport type { JsonObject } from "../config.js";\nexport interface CliDependencies { a: JsonObject; b: JsonValue }\n';
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), text);
  const check = "src/cli/deps.ts(1,15): error TS2300: Duplicate identifier 'JsonObject'.\nsrc/cli/deps.ts(2,15): error TS2440: Import declaration conflicts with local declaration of 'CliDependencies'.\nsrc/cli/deps.ts(3,15): error TS2300: Duplicate identifier 'JsonObject'.";
  const names = await resolveMissingNames(root, check, ['src/cli/deps.ts']);
  assert.deepEqual(names.map(n => [n.name, n.kind, n.line]), [['JsonObject', 'unused', 3], ['CliDependencies', 'unused', 2]]);
  const fixes = compactNames({ missingNames: names } as any, 40);
  const edits = await removeImportBindings('src/cli/deps.ts', text, fixes.removeImports['src/cli/deps.ts']!, fixes.removeImportLines['src/cli/deps.ts']);
  assert.deepEqual(edits, [{ start: 2, end: 2, newText: '', prepend: '' }, { start: 3, end: 3, newText: '', prepend: '' }], 'line 1 keeps JsonObject');
});
test('A move into an existing destination never duplicates a binding it already imports and drops an import the move supersedes', async t => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  const source = 'import { type JsonObject, type JsonValue } from "./config.js";\nexport interface CliDependencies { a: JsonObject; b: JsonValue }\nexport const rest = 1;\n';
  const existing = 'import type { JsonObject } from "../config.js";\nimport type { CliDependencies } from "../cli.js";\nexport const DEFAULTS: CliDependencies = {} as CliDependencies;\n';
  await writeFile(join(root, 'src', 'cli.ts'), source); await writeFile(join(root, 'src', 'cli', 'deps.ts'), existing);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const r = await tools.execute('move_lines', { source: 'src/cli.ts', expectedHash: hash(source), start: 2, end: 2, destination: 'src/cli/deps.ts', destinationHash: hash(existing), replacement: '', prefix: '' });
  assert(r.ok, r.text);
  const deps = await readFile(join(root, 'src', 'cli', 'deps.ts'), 'utf8');
  assert.equal(deps, 'import type { JsonObject } from "../config.js";\nimport { type JsonValue } from "../config.js";\nexport const DEFAULTS: CliDependencies = {} as CliDependencies;\n\nexport interface CliDependencies { a: JsonObject; b: JsonValue }\n');
});

test('A worker move that sweeps up declarations the ledger never asked for is refused with the exact ranges', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'interface CliDependencies {\n  a: number;\n}\nconst DEFAULT_DEPENDENCIES: CliDependencies = { a: 1 };\nexport const OPTION = 2;\nexport function runCodexSkillCommand() { return DEFAULT_DEPENDENCIES; }\n');
  await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const X = 0;\n');
  session.phase = 'implement'; session.inspectionCount = 3; session.hashes['src/cli.ts'] = hash(await readFile(join(root, 'src', 'cli.ts'), 'utf8')); session.readHashes['src/cli.ts'] = session.hashes['src/cli.ts']!;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'CliDependencies', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'm' }, { kind: 'move', name: 'DEFAULT_DEPENDENCIES', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'm' }] });
  session.moveDirection = { source: 'src/cli/deps.ts', destination: 'src/cli.ts' }; // keeps the harness from moving them itself in this test
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'move_lines', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ source: 'src/cli.ts', expectedHash: session.hashes['src/cli.ts'], start: 1, end: 6, destination: 'src/cli/deps.ts', destinationHash: hash('export const X = 0;\n'), replacement: '', prefix: '' }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries[0]!.kind, 'generation_error');
  assert.match(result.entries[0]!.text, /also declares OPTION, runCodexSkillCommand, which the deliverables do not ask to move\. Move only the deliverables' declarations: CliDependencies lines 1-3; DEFAULT_DEPENDENCIES lines 4-4\./);
  assert.match(await readFile(join(root, 'src', 'cli.ts'), 'utf8'), /^interface CliDependencies/, 'nothing moved');
});
test('An invented ledger source path is repaired from the repository when the declaration is unique there', async t => {
  const { root, session: s } = await fixture(t);
  await mkdir(join(root, 'sdk', 'src', 'cli'), { recursive: true }); await mkdir(join(root, 'sdk', 'tests-ts'), { recursive: true });
  await writeFile(join(root, 'sdk', 'src', 'cli.ts'), 'interface CliDependencies { a: number }\n'); await writeFile(join(root, 'sdk', 'src', 'cli', 'deps.ts'), 'export const X = 0;\n');
  await writeFile(join(root, 'sdk', 'tests-ts', 'cli.test.ts'), 'interface CliDependencies { fake: true }\n');
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'CliDependencies', from: 'src/cli/main.ts', to: 'sdk/src/cli/deps.ts', detail: 'm' }] });
  await refreshLedger(root, s);
  assert.equal(s.ledger[0]!.from, 'sdk/src/cli.ts'); assert.equal(s.ledger[0]!.status, 'pending'); assert(!s.ledger[0]!.unresolvable);
  // A name declared in two modules: the file the plan names wins, then the sibling items' file.
  await writeFile(join(root, 'sdk', 'src', 'api.ts'), 'const DEFAULTS = 1;\n'); await writeFile(join(root, 'sdk', 'src', 'cli.ts'), 'interface CliDependencies { a: number }\nconst DEFAULTS = 2;\n');
  s.knownFiles.push('sdk/src/api.ts');
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'CliDependencies', from: 'src/cli/main.ts', to: 'sdk/src/cli/deps.ts', detail: 'm' }, { kind: 'move', name: 'DEFAULTS', from: 'src/cli/main.ts', to: 'sdk/src/cli/deps.ts', detail: 'm' }] });
  await refreshLedger(root, s);
  assert.equal(s.ledger[1]!.from, 'sdk/src/cli.ts', 'sibling resolution'); assert.equal(s.ledger[1]!.status, 'pending');
  s.objective = 'Extract DEFAULTS from src/api.ts into src/cli/deps.ts';
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'DEFAULTS', from: 'lib/nowhere.ts', to: 'sdk/src/cli/deps.ts', detail: 'm' }] });
  await refreshLedger(root, s);
  assert.equal(s.ledger[0]!.from, 'sdk/src/api.ts', 'the file the objective names wins');
});
test('An untouched importer that lost a name to a move gets it back through a re-export the harness adds to the edited module', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'sdk', 'src', 'cli'), { recursive: true }); await mkdir(join(root, 'sdk', 'tests-ts'), { recursive: true });
  await writeFile(join(root, 'sdk', 'src', 'cli.ts'), 'import { DEFAULT_DEPENDENCIES } from "./cli/deps.js";\nexport const main = DEFAULT_DEPENDENCIES;\n');
  await writeFile(join(root, 'sdk', 'src', 'cli', 'deps.ts'), 'export const DEFAULT_DEPENDENCIES = {};\nexport function runCodexSkillCommand() {}\n');
  await writeFile(join(root, 'sdk', 'tests-ts', 'cli.test.ts'), 'import { runCodexSkillCommand } from "../src/cli.js";\n');
  const check = `tests-ts/cli.test.ts(1,10): error TS2305: Module '"../src/cli.js"' has no exported member 'runCodexSkillCommand'.`;
  const names = await resolveMissingNames(root, check, ['sdk/src/cli.ts', 'sdk/src/cli/deps.ts']);
  assert.equal(names[0]!.kind, 'reexport'); assert.equal(names[0]!.inFile, 'sdk/src/cli.ts'); assert.equal(names[0]!.importLine, 'export { runCodexSkillCommand } from "./cli/deps.js";');
  const fixes = compactNames({ missingNames: names } as any, 40);
  assert.deepEqual(fixes.addImports, { 'sdk/src/cli.ts': ['export { runCodexSkillCommand } from "./cli/deps.js";'] });
});

test('A destination that matches no file is anchored to the source\'s package, for the ledger and for worker moves', async t => {
  const { root, session: s } = await fixture(t);
  await mkdir(join(root, 'sdk', 'typescript', 'src'), { recursive: true });
  await writeFile(join(root, 'sdk', 'typescript', 'src', 'cli.ts'), 'const A = 1;\n');
  assert.equal(await anchorPath(root, 'sdk/typescript/src/cli.ts', 'src/cli/deps.ts'), 'sdk/typescript/src/cli/deps.ts');
  assert.equal(await anchorPath(root, 'sdk/typescript/src/cli.ts', 'sdk/typescript/src/cli.ts'), 'sdk/typescript/src/cli.ts', 'an existing path is left alone');
  assert.equal(await anchorPath(root, 'a.ts', 'lib/x.ts'), 'lib/x.ts', 'a root-level source anchors at the root');
  s.knownFiles.push('sdk/typescript/src/cli.ts');
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'A', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'm' }] });
  await refreshLedger(root, s);
  assert.equal(s.ledger[0]!.to, 'sdk/typescript/src/cli/deps.ts'); assert.equal(s.ledger[0]!.status, 'pending');
});
test('The completion audit state stays under the Jev budget with a large diff and long edit history', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  const big = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  const artifact = await store.snapshot(1, 'src/a.ts', 'export const a = 1;\n');
  await writeFile(join(root, 'src', 'a.ts'), big); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  s.objective = 'Add many constants to src/a.ts.'; s.phase = 'implement'; s.step = 3; s.lastWriteStep = 2; s.writes = ['src/a.ts']; s.baselineArtifacts = { 'src/a.ts': artifact }; s.inspectionCount = 3;
  s.editEvidence = Array.from({ length: 20 }, (_, i) => ({ step: i, route: 'write', paths: ['src/a.ts'], artifact: '', text: 'x'.repeat(400), applied: 'y'.repeat(600) } as any));
  const sizes: number[] = [];
  const jev = { decide: async (state: unknown, q: Questions, ctx?: { phase: string }) => { sizes.push(Buffer.byteLength(JSON.stringify(state))); if (Buffer.byteLength(JSON.stringify(state)) > 22000) throw new Error('Jev decision state exceeds its configured byte budget'); return answersFor(q, 'finish', .9); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'done' }) };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'passed' }, { command: 'node check.mjs' });
  const result = await runner.run(s);
  assert.equal(result.status, 'complete', result.stopReason); assert(sizes.every(n => n <= 22000), `state sizes ${sizes.join(',')}`);
});

test('The completion audit of a designed application with many created files stays under the Jev budget by shrinking its base and chunking the evidence', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  const paths = Array.from({ length: 20 }, (_, i) => `src/components/C${i}.tsx`);
  const design = { summary: 'A landing page with twenty components. '.repeat(20), conventions: 'React 19, TypeScript, Tailwind; named exports; '.repeat(10), deliverables: paths.map(p => ({ kind: 'create', name: p, from: '', to: p, detail: `Create ${p}: a substantial, accessible, responsive component with several props and a documented contract.`, contents: ['a heading', 'a paragraph', 'a call to action', 'responsive layout', 'accessible markup'], exports: [`export function ${p.slice(15, -4)}(props: Props): JSX.Element`], dependsOn: [] })) };
  for (const p of paths) await writeFile(join(root, p), `import type { ReactNode } from "react";\nexport type Props = { title: string; children?: ReactNode; className?: string };\n${Array.from({ length: 12 }, (_, i) => `export const helper${i} = (x: number) => x * ${i};`).join('\n')}\nexport function ${p.slice(15, -4)}(props: Props) {\n  return <section className={props.className}><h2>{props.title}</h2>{props.children}</section>;\n}\n`);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  s.objective = 'Bootstrap an advanced react application with a landing page and components.'; s.phase = 'implement'; s.step = 40; s.lastWriteStep = 39; s.inspectionCount = 3;
  s.writes = paths; s.baselineArtifacts = Object.fromEntries(paths.map(p => [p, '@new'])); s.knownFiles.push(...paths);
  s.design = designFrom(design); s.ledger = candidatesFrom(design); s.ledgerBuilt = true; await refreshLedger(root, s);
  assert(s.ledger.every(d => d.status === 'done'));
  const sizes: number[] = []; const phases: string[] = [];
  const jev = { decide: async (state: unknown, q: Questions, ctx?: { phase: string }) => { phases.push(ctx!.phase); const n = Buffer.byteLength(JSON.stringify(state)); sizes.push(n); if (n > 22000) throw new Error('Jev decision state exceeds its configured byte budget'); return answersFor(q, 'finish', .9); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'done' }) };
  const runner = new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'passed' }, { command: 'node check.mjs' });
  const result = await runner.run(s);
  assert.equal(result.status, 'complete', result.stopReason);
  assert(sizes.every(n => n <= 22000), `state sizes ${sizes.join(',')}`);
  assert(phases.filter(p => p === 'completion-check').length >= 2, `the evidence of twenty items is chunked across calls: ${phases.join(',')}`);
});
test('A configured check that cannot run in this repository is dropped, and the worker\'s own build then counts as verification', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.mjs'), 'export const a = 1;\n');
  assert.match((await checkUnusable(root, 'pnpm --dir sdk/typescript exec tsc --noEmit')) ?? '', /directory sdk\/typescript does not exist/);
  assert.match((await checkUnusable(root, 'definitely-not-a-tool-xyz --check')) ?? '', /not installed/);
  assert.equal(await checkUnusable(root, 'node --check a.mjs'), null);
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.mjs']; session.step = 2; session.lastWriteStep = 2;
  session.editEvidence = [{ step: 2, route: 'write', paths: ['a.mjs'], artifact: '', text: 'edited' } as any];
  const routes = ['bash', 'read_files']; let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => answersFor(q, ctx?.phase === 'completion-check' ? 'finish' : routes[n++] ?? 'read_files', .9) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.bash ? { command: 'node --check a.mjs', purpose: 'syntax' } : schema === schemas.finish ? { summary: 'a.mjs is valid.' } : schema === checkSchema ? { command: '', rationale: 'none' } : { files: [{ path: 'a.mjs', start: 1, end: 1 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'pnpm --dir sdk/typescript exec tsc --noEmit --incremental false', maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'check-unusable')?.data.reason, 'its directory sdk/typescript does not exist in this repository');
  assert.equal(result.entries[0]!.kind, 'bash'); assert.equal(result.lastCheck?.ok, true, 'the worker\'s node --check counted as the verification');
  assert.equal(result.status, 'complete', result.stopReason);
});
test('With no check configured, code enumerates the repository\'s verification candidates and tries them; a lone candidate that ran is selected without asking', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'node check.mjs', dev: 'vite', format: 'prettier --write .' } })); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'src.mjs'), 'export const hello = "Hello World";\n');
  session.objective = 'Make src.mjs say Hello World and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['src.mjs']; session.step = 2; session.lastWriteStep = 2;
  session.editEvidence = [{ step: 2, route: 'write', paths: ['src.mjs'], artifact: '', text: 'edited' } as any];
  const phases: string[] = [];
  const jev = { decide: async (_state: any, q: Questions, ctx?: { phase: string }) => { phases.push(ctx!.phase); assert.notEqual(ctx!.phase, 'check-selection', 'a single candidate that ran needs no judgment'); return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: any, schema: unknown) => {
    assert.notEqual(schema, checkSchema, 'the worker is not asked when candidates are enumerable');
    if (schema === schemas.finish) return { summary: 'done' };
    return { files: [{ path: 'src.mjs', start: 1, end: 1 }] };
  } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['bash'], `the selected check is the only action before completion; steps: ${result.entries.map(e => e.kind).join(',')}`);
  assert.equal(result.lastCheckCommand, 'npm run build'); assert.equal(result.lastCheck?.ok, true); assert.equal(result.status, 'complete', result.stopReason);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const inferred = events.find(e => e.type === 'check-inferred');
  assert.deepEqual(inferred.data.candidates.map((c: any) => c.command), ['npm run build'], 'servers and formatters are never candidates'); assert.equal(inferred.data.candidates[0].trial.outcome, 'ran and passed'); assert.equal(inferred.data.accepted, true);
});
test('Check selection: two candidates that ran go to Jev as one Choice with a none option; startup failures never do', async t => {
  const status = { git: false, changed: [], changedCount: 0, scripts: { typecheck: 'node tc.mjs', test: 'node test.mjs', dev: 'vite', start: 'node server.js', 'lint:fix': 'eslint --fix .', watch: 'tsc --watch' }, topLevel: [], packages: [] };
  const { root, store, session } = await fixture(t);
  assert.deepEqual((await checkCandidates(root, status)).map(c => c.command), ['npm run typecheck', 'npm run test']);
  const f = trialFacts({ code: 1, timedOut: false, output: 'sh: line 1: tsc: command not found' })!; assert.equal(f.ran, false); assert.equal(f.startupFailure, true); assert.equal(f.outcome, 'failed to start');
  const g = trialFacts({ code: 2, timedOut: false, output: 'src/a.ts(1,1): error TS2304: x\nsrc/a.ts(2,1): error TS2304: y' })!; assert.equal(g.ran, true); assert.equal(g.errorsListed, 2); assert.equal(g.outcome, 'ran and reported errors in the code');
  assert.equal(trialFacts({ code: 0, timedOut: false, output: 'ok' })!.outcome, 'ran and passed'); assert.equal(trialFacts({ code: null, timedOut: true, output: '' })!.outcome, 'did not terminate');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { typecheck: 'node tc.mjs', test: 'node test.mjs' } }));
  await writeFile(join(root, 'tc.mjs'), 'console.error("src.mjs(1,1): error TS2304: x"); process.exit(2);\n'); await writeFile(join(root, 'test.mjs'), 'process.exit(0);\n'); await writeFile(join(root, 'src.mjs'), 'export const a = 1;\n');
  session.objective = 'Change src.mjs and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['src.mjs']; session.step = 2; session.lastWriteStep = 2;
  session.editEvidence = [{ step: 2, route: 'write', paths: ['src.mjs'], artifact: '', text: 'edited' } as any];
  let seen: any = null; let answer = 'none';
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'check-selection') { seen = { state, q }; const keys = Object.keys((q.check as any).criteria); return { check: { type: 'choice', choice: answer, confidence: .9, probabilities: Object.fromEntries(keys.map(k => [k, k === answer ? .9 : .1 / (keys.length - 1)])) } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src.mjs', start: 1, end: 1 }] } };
  let result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(Object.keys((seen.q.check as any).criteria), ['npm run typecheck', 'npm run test', 'none'], 'options are the commands themselves plus none');
  assert.equal(seen.state.candidates['npm run typecheck'].outcome, 'ran and reported errors in the code'); assert.equal(seen.state.candidates['npm run test'].outcome, 'ran and passed'); assert(Buffer.byteLength(JSON.stringify(seen.state)) < 3000, 'a small, literal state');
  assert.equal(result.lastCheckCommand, null, 'none selected: no verification yet');
  answer = 'npm run test'; session.checkTrialKey = undefined; session.checkInferences = 0;
  result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.lastCheckCommand, 'npm run test'); assert.equal(result.status, 'complete', result.stopReason);
});
test('The completion diff takes the repository\'s view of change from git, including files a scaffold created', async t => {
  const { root, store, session: s } = await fixture(t);
  await runCommand('git', ['init', '-q'], root, 10000); await runCommand('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], root, 10000);
  await writeFile(join(root, 'tracked.ts'), 'export const before = 1;\n');
  await runCommand('git', ['add', 'tracked.ts'], root, 10000); await runCommand('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add'], root, 10000);
  await writeFile(join(root, 'tracked.ts'), 'export const after = 2;\n'); await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'App.jsx'), 'export default function App() { return <h1>Hello World</h1>; }\n');
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true }); await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'ignored');
  const status = await repositoryStatus(root);
  assert(status.git); assert.deepEqual(status.changed.sort(), ['src/App.jsx', 'tracked.ts']);
  const diff = await structuralDiff(root, s, store.artifacts);
  const byPath = Object.fromEntries(diff.files.map(f => [f.path, f]));
  assert.deepEqual(byPath['tracked.ts']!.declarationsRemoved, ['before']); assert.match(byPath['tracked.ts']!.declarationsAdded[0]!, /^after /); assert.match(byPath['tracked.ts']!.hunks ?? '', /-export const before/);
  assert.equal(byPath['src/App.jsx']!.created, true); assert(!('node_modules/x/index.js' in byPath));
  // Files already untracked or modified when the session began are not the session's changes.
  s.baselineStatus = ['src/App.jsx'];
  const later = await structuralDiff(root, s, store.artifacts);
  assert.deepEqual(later.files.map(f => f.path), ['tracked.ts'], 'the pre-existing untracked file is excluded');
  s.writes = ['src/App.jsx'];
  assert(( await structuralDiff(root, s, store.artifacts)).files.some(f => f.path === 'src/App.jsx'), 'unless the session wrote it');
});
test('Read-only shell commands are inspections: they run and count toward the inspection cap', async t => {
  assert(readOnlyCommand('ls -la && cat src/App.jsx && cat package.json')); assert(readOnlyCommand('node -e "require(\'fs\').readFileSync(\'src/App.jsx\',\'utf8\')" && echo OK'));
  assert(!readOnlyCommand('npm run build 2>&1 | tail -20')); assert(!readOnlyCommand('ls && rm -rf dist'));
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  session.phase = 'implement'; session.inspectionCount = 3; session.inspectionsSinceAction = 4; session.hashes['a.ts'] = hash('const a = 1;\n'); session.readHashes['a.ts'] = session.hashes['a.ts']!;
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'bash', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ command: 'ls -la && cat a.ts', purpose: 'look' }) };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries[0]!.kind, 'bash'); assert.match(result.entries[0]!.text, /const a = 1/); assert.equal(result.inspectionsSinceAction, 5, 'a generated command is executed, never discarded by a count');
});
test('Repository status lists nested packages, and a package script is enumerated, tried once and selected', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'sdk', 'typescript', 'src'), { recursive: true });
  await writeFile(join(root, 'sdk', 'typescript', 'package.json'), JSON.stringify({ scripts: { lint: 'node check.mjs' } })); await writeFile(join(root, 'sdk', 'typescript', 'tsconfig.json'), '{}');
  await writeFile(join(root, 'sdk', 'typescript', 'check.mjs'), 'console.log("ok"); process.exit(0);\n'); await writeFile(join(root, 'sdk', 'typescript', 'src', 'a.ts'), 'export const a = 1;\n');
  const status = await repositoryStatus(root);
  assert.deepEqual(status.packages, [{ dir: 'sdk/typescript', scripts: { lint: 'node check.mjs' }, tools: ['package.json', 'tsconfig.json'] }]);
  assert.deepEqual((await checkCandidates(root, status)).map(c => c.command), ['cd sdk/typescript && npm run lint']);
  session.objective = 'Change a in sdk/typescript/src/a.ts and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['sdk/typescript/src/a.ts']; session.step = 2; session.lastWriteStep = 2;
  session.editEvidence = [{ step: 2, route: 'write', paths: ['sdk/typescript/src/a.ts'], artifact: '', text: 'edited' } as any];
  const jev = { decide: async (_state: any, q: Questions, ctx?: { phase: string }) => answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: any, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'sdk/typescript/src/a.ts', start: 1, end: 1 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const inferred = events.filter(e => e.type === 'check-inferred'); assert.equal(inferred.length, 1, 'tried once'); assert.equal(inferred[0].data.candidates[0].trial.exitCode, 0); assert.match(inferred[0].data.candidates[0].trial.outputHead, /ok/);
  assert.equal(result.lastCheckCommand, 'cd sdk/typescript && npm run lint'); assert.equal(result.status, 'complete', result.stopReason);
});
test('With no check at all, the harness still performs the ledger\'s moves and refreshes the ledger after each edit', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'const HIDE_CURSOR = "h";\nfunction isJsonObject(v: unknown) { return typeof v === "object"; }\nexport function main() { return [HIDE_CURSOR, isJsonObject(1)]; }\n');
  session.objective = 'Move HIDE_CURSOR and isJsonObject into src/cli/deps.ts.'; session.phase = 'implement'; session.inspectionCount = 3; session.knownFiles.push('src/cli.ts');
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'HIDE_CURSOR', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'm' }, { kind: 'move', name: 'isJsonObject', from: 'src/cli/main.ts', to: 'src/cli/deps.ts', detail: 'm' }] });
  session.ledgerBuilt = true;
  await refreshLedger(root, session); session.pendingMoves = [{ name: 'HIDE_CURSOR', source: 'src/cli.ts', start: 1, end: 1, destination: 'src/cli/deps.ts' }];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => answersFor(q, ctx?.phase === 'completion-check' ? 'finish' : 'read_files', .9) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === checkSchema ? { command: '', rationale: 'no tooling' } : schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src/cli.ts', start: 1, end: 3 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(kinds.filter(k => k === 'move_lines').length, 2, `steps: ${kinds.join(',')}`);
  assert.deepEqual(result.ledger.map(d => [d.name, d.from, d.status]), [['HIDE_CURSOR', 'src/cli.ts', 'done'], ['isJsonObject', 'src/cli.ts', 'done']], 'the second item was repaired from its sibling after the first move created the destination');
  assert.match(await readFile(join(root, 'src', 'cli', 'deps.ts'), 'utf8'), /export function isJsonObject/);
});

test('The task record Jev decides on is small and made of facts, and the candidates are enumerated by code', async t => {
  const { root, session: s } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'const A = 1;\nexport const B = 2;\n'); await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const X = 0;\n');
  s.knownFiles.push('src/cli.ts', 'src/cli/deps.ts'); s.writes = ['src/cli.ts']; s.hashes['src/cli.ts'] = 'h'; s.step = 9; s.lastWriteStep = 8;
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'A', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'move A' }, { kind: 'modify', name: 'B', from: 'src/cli.ts', to: 'src/cli.ts', detail: 'double B' }, { kind: 'verify', name: 'node check.mjs', from: '', to: '', detail: 'passes' }] });
  await refreshLedger(root, s);
  s.lastCheck = { step: 9, ok: false, text: 'x', summary: summarizeCheck('src/cli.ts(2,14): error TS2322: bad') }; s.lastCheckCommand = 'node check.mjs';
  s.entries = [{ id: 'e9', step: 9, kind: 'bash', artifact: '', text: 'x'.repeat(5000), relevance: .5 }];
  const record = taskRecord(s);
  assert(Buffer.byteLength(JSON.stringify(record)) < 3000, `record is ${Buffer.byteLength(JSON.stringify(record))} bytes`);
  assert.deepEqual(Object.keys(record), ['objective', 'deliverables', 'verification', 'changes', 'lastAction', 'progress']);
  assert.equal(record.verification.lastResult, 'failed'); assert.equal(record.verification.errors, 1); assert.equal(record.lastAction!.summary.length, 241);
  const c = candidates(s, { ...defaults, allowWrite: true }, false);
  const ids = c.map(x => x.id);
  assert(ids.includes('implement:d2'), 'the modify deliverable is the worker\'s'); assert(!ids.includes('implement:d1') || !s.pendingMoves.length, 'a move the harness performs is never offered');
  assert(ids.includes('fix:src/cli.ts')); assert(!ids.includes('inspect:src/cli.ts'), 'a file this session wrote is never offered as a read: code holds it'); assert(ids.includes('inspect:src/cli/deps.ts')); assert(ids.includes('ask') && ids.includes('free'));
  assert(!ids.includes('implement:d3'), 'verification is code\'s own');
  const q = stepQuestions(c); assert.deepEqual(Object.keys(q), ['next', 'stuck', 'scope_drift', 'needs_user']);
  const d = decideStep({ next: { type: 'choice', choice: 'inspect:src/cli/deps.ts', confidence: .4, probabilities: { 'inspect:src/cli/deps.ts': .45, 'fix:src/cli.ts': .3, free: .25 } }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } }, c, defaults);
  assert.equal(d.tier, 'cautious'); assert.equal(d.candidate.kind, 'inspect', 'a cheap inspection proceeds on a middling read');
  const e = decideStep({ next: { type: 'choice', choice: 'fix:src/cli.ts', confidence: .3, probabilities: { 'fix:src/cli.ts': .35, 'inspect:src/cli/deps.ts': .33, free: .32 } } }, c, defaults);
  assert.equal(e.tier, 'escalate'); assert.equal(e.candidate.kind, 'free', 'an uncertain edit choice escalates to the worker');
  const f = decideStep({ next: { type: 'choice', choice: 'fix:src/cli.ts', confidence: .9, probabilities: { 'fix:src/cli.ts': .9 } }, needs_user: { type: 'noul', noul: .9 } }, c, defaults);
  assert.equal(f.candidate.kind, 'ask', 'a confident need for the user overrides');
});
test('Jev\'s step decision drives the loop: code executes inspections, the worker gets a focused note for a deliverable, and uncertainty escalates', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const greeting = "hi";\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.objective = 'Make greeting say Hello World in src/a.ts.'; session.knownFiles.push('src/a.ts'); session.phase = 'implement'; session.inspectionCount = 3;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'modify', name: 'greeting', from: 'src/a.ts', to: 'src/a.ts', detail: 'greeting must be Hello World' }] }); session.ledgerBuilt = true; session.lastCheckCommand = 'node check.mjs';
  const phases: string[] = []; const notes: string[] = []; let turn = 0;
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    phases.push(ctx!.phase);
    if (ctx!.phase === 'step') {
      turn++;
      const ids = Object.keys((q.next as any).criteria);
      const pick = turn === 1 ? ids.find(i => i.startsWith('inspect:'))! : turn === 2 ? 'implement:d1' : 'free';
      const conf = turn === 3 ? .1 : .9;
      return { next: { type: 'choice', choice: pick, confidence: conf, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? (turn === 3 ? .3 : .9) : (turn === 3 ? .7 / (ids.length - 1) : .1 / (ids.length - 1))])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers;
    }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (m: any, schema: unknown) => {
    const last = JSON.parse(m[m.length - 1].content); const note = last.task ?? promptFields(m).harnessNote; if (note) notes.push(note);
    if (schema === focusedEditSchema) return { edits: [{ start: 1, end: 1, newText: 'export const greeting = "Hello World";', prepend: '' }] };
    if (schema === schemas.finish) return { summary: 'greeting says Hello World.' };
    return { files: [{ path: 'src/a.ts', start: 1, end: 1 }] };
  } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(kinds[0], 'read_files', `code executed the inspection; steps: ${kinds.join(',')}`);
  assert.equal(kinds[1], 'replace_lines', 'the deliverable went to the worker as an edit'); assert.match(notes[0] ?? '', /^Work on deliverable d1 only: modify greeting/);
  assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), 'export const greeting = "Hello World";\n');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const decisions = events.filter(e => e.type === 'decision').map(e => [e.data.chosen, e.data.tier]);
  assert.deepEqual(decisions.slice(0, 2).map(d => d[1]), ['act', 'act']); assert.equal(decisions[2]?.[1], 'escalate');
  assert(phases.includes('completion-check') && !phases.includes('routing-and-context'), 'after the passing check the harness proposed finish itself instead of routing');
  assert.equal(result.status, 'complete', result.stopReason);
  assert(events.every(e => e.type !== 'jev-request' || e.data.phase !== 'step' || Buffer.byteLength(JSON.stringify(e.data.state)) < 4000), 'every step state is small');
});
test('Completion is a set of citation checks: bounded evidence per deliverable, three-way judgments, and a contradiction rejects', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src', 'cli'), { recursive: true });
  await writeFile(join(root, 'src', 'cli.ts'), 'import { A } from "./cli/deps.js";\nexport const main = A;\n'); await writeFile(join(root, 'src', 'cli', 'deps.ts'), 'export const A = 1;\n');
  s.writes = ['src/cli.ts', 'src/cli/deps.ts']; s.baselineArtifacts = { 'src/cli/deps.ts': '@new' }; s.knownFiles.push('src/cli.ts', 'src/cli/deps.ts');
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'A', from: 'src/cli.ts', to: 'src/cli/deps.ts', detail: 'move A' }, { kind: 'create', name: 'src/cli/deps.ts', from: '', to: 'src/cli/deps.ts', detail: 'new module' }] });
  await refreshLedger(root, s);
  const evidence = await completionEvidence(root, s, await structuralDiff(root, s, store.artifacts));
  assert.match(evidence.d1!, /^src\/cli\/deps\.ts lines 1-1:\nexport const A = 1;\nsrc\/cli\.ts no longer declares A\.\nsrc\/cli\.ts imports it: import \{ A \} from "\.\/cli\/deps\.js";/);
  assert.match(evidence.d2!, /^src\/cli\/deps\.ts exists \(2 lines\)/);
  const q = auditQuestions(s.ledger); assert.deepEqual(Object.keys(q), ['d_d1', 'd_d2'], 'no scope question when every changed file is a deliverable'); assert.deepEqual(Object.keys((q.d_d1 as any).criteria), ['supports', 'contradicts', 'says_nothing']);
  assert.deepEqual(Object.keys(auditQuestions(s.ledger, false, ['src/stray.ts'])), ['d_d1', 'd_d2', 'scope_creep']);
  const yes = auditVerdict({ d_d1: { type: 'choice', choice: 'supports', confidence: .9, probabilities: { supports: .9, contradicts: .05, says_nothing: .05 } }, d_d2: { type: 'choice', choice: 'says_nothing', confidence: .5, probabilities: { supports: .3, contradicts: .1, says_nothing: .6 } }, scope_creep: { type: 'noul', noul: .1 } }, s.ledger, defaults);
  assert(yes.accepted, 'a fact-done item that the evidence does not address still counts');
  const no = auditVerdict({ d_d1: { type: 'choice', choice: 'contradicts', confidence: .8, probabilities: { supports: .1, contradicts: .8, says_nothing: .1 } }, d_d2: { type: 'choice', choice: 'supports', confidence: .9, probabilities: { supports: .9, contradicts: .05, says_nothing: .05 } }, scope_creep: { type: 'noul', noul: .1 } }, s.ledger, defaults);
  assert(!no.accepted); assert.deepEqual(no.unmet, ['d1']);
});

test('A decided edit is executed in the inspect phase: Jev\'s decision is not re-validated against the phase menu', async t => {
  const { root, store, session } = await fixture(t);
  session.objective = 'Bootstrap a react app.'; session.phase = 'inspect'; session.inspectionCount = 0;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'package.json', from: '', to: 'package.json', detail: 'the package manifest' }, { kind: 'create', name: 'src/App.tsx', from: '', to: 'src/App.tsx', detail: 'the app' }] }); session.ledgerBuilt = true;
  const phases: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    phases.push(ctx!.phase);
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); return { next: { type: 'choice', choice: 'implement:d1', confidence: .98, probabilities: Object.fromEntries(ids.map(i => [i, i === 'implement:d1' ? .98 : .02 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .05 }, scope_drift: { type: 'noul', noul: .05 }, needs_user: { type: 'noul', noul: .02 } } as Answers; }
    return answersFor(q, 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: any) => schema?.properties?.content ? { content: '```json\n{ "name": "demo" }\n```' } : { files: [{ path: 'package.json', start: 1, end: 1 }] } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.entries[0]?.kind, 'create_file', result.stopReason); assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{ "name": "demo" }\n');
  assert.deepEqual(phases, ['step'], 'no routing question after a decision'); assert.equal(result.phase, 'implement');
});

test('Items that fit an open-ended objective without being required become optional: offered after required work, never blocking completion', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'index.html'), '<h1>Hello</h1>\n');
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'index.html', from: '', to: 'index.html', detail: 'the page' }, { kind: 'create', name: 'src/components/StatCounter.tsx', from: '', to: 'src/components/StatCounter.tsx', detail: 'a counter' }] });
  s.ledger[1]!.optional = true; s.knownFiles.push('index.html');
  await refreshLedger(root, s);
  assert.deepEqual(s.ledger.map(d => [d.name, d.status, Boolean(d.optional)]), [['index.html', 'done', false], ['src/components/StatCounter.tsx', 'pending', true]]);
  const c = candidates(s, { ...defaults, allowWrite: true }, false);
  assert(c.some(x => x.id === 'implement:d2' && /Optional: a reasonable addition/.test(x.description)), 'with required work done, the optional item is offered and labelled');
  s.ledger[0]!.status = 'pending';
  assert(!candidates(s, { ...defaults, allowWrite: true }, false).some(x => x.id === 'implement:d2'), 'required work comes first');
  s.ledger[0]!.status = 'done';
  const verdict = auditVerdict({ d_d1: { type: 'choice', choice: 'supports', confidence: .9, probabilities: { supports: .9, contradicts: .05, says_nothing: .05 } }, d_d2: { type: 'choice', choice: 'contradicts', confidence: .9, probabilities: { supports: .05, contradicts: .9, says_nothing: .05 } }, scope_creep: { type: 'noul', noul: .1 } }, s.ledger, defaults);
  assert(verdict.accepted, 'an unbuilt optional item does not block completion');
  assert.equal(taskRecord(s).deliverables[1]!.optional, true);
});

test('Probability spread among pending deliverables is a preference, not doubt: the decision acts on the top one', () => {
  const c: import('../src/decide.js').Candidate[] = [...['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(id => ({ id: `implement:${id}`, kind: 'implement' as const, description: id })), { id: 'ask', kind: 'ask' as const, description: 'ask' }, { id: 'free', kind: 'free' as const, description: 'free' }];
  const probs = { 'implement:d1': .3, 'implement:d2': .2, 'implement:d3': .15, 'implement:d4': .1, 'implement:d5': .1, 'implement:d6': .05, ask: .05, free: .05 };
  const d = decideStep({ next: { type: 'choice', choice: 'implement:d1', confidence: .28, probabilities: probs } }, c, defaults);
  assert.equal(d.tier, 'act'); assert.equal(d.candidate.id, 'implement:d1');
  const spreadToFree = decideStep({ next: { type: 'choice', choice: 'free', confidence: .3, probabilities: { 'implement:d1': .3, free: .4, ask: .3 } } }, c, defaults);
  assert.equal(spreadToFree.candidate.kind, 'free', 'a genuine lean to the worker still escalates');
});
test('A check trial that fails for missing dependencies triggers one code-owned install from the manifest, then the trial is repeated', async t => {
  const { root, store, session } = await fixture(t);
  assert(missingDependencies('sh: line 1: tsc: command not found')); assert(missingDependencies("Error: Cannot find module 'vite'")); assert(!missingDependencies('src/a.ts(1,1): error TS2304: x'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { typecheck: 'node check.mjs' } }));
  assert.equal(await installCommand(root), 'npm install --no-audit --no-fund');
  await writeFile(join(root, 'package-lock.json'), '{}'); assert.equal(await installCommand(root), 'npm ci --no-audit --no-fund');
  await mkdir(join(root, 'node_modules'), { recursive: true }); assert.equal(await installCommand(root), null, 'already installed');
  await rm(join(root, 'node_modules'), { recursive: true }); await rm(join(root, 'package-lock.json'));
  // A fake npm on PATH records the install and creates node_modules; check.mjs works only once that exists.
  const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'npm'), `#!/bin/bash\nif [ "$1" = "install" ]; then mkdir -p node_modules && echo installed > .installed; exit 0; fi\nif [ "$1" = "run" ]; then [ -d node_modules ] && exec node check.mjs; echo "sh: line 1: tsc: command not found"; exit 127; fi\n`, { mode: 0o755 });
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n'); await writeFile(join(root, 'src.mjs'), 'export const a = 1;\n');
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  session.objective = 'Make src.mjs export a and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['src.mjs']; session.step = 2; session.lastWriteStep = 2;
  session.editEvidence = [{ step: 2, route: 'write', paths: ['src.mjs'], artifact: '', text: 'edited' } as any];
  const jev = { decide: async (_state: any, q: Questions, ctx?: { phase: string }) => { assert.notEqual(ctx!.phase, 'check-selection'); return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9); } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src.mjs', start: 1, end: 1 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(await readFile(join(root, '.installed'), 'utf8'), 'installed\n'); assert.equal(result.setupDone, true);
  assert.equal(result.lastCheckCommand, 'npm run typecheck'); assert.equal(result.status, 'complete', result.stopReason);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'setup')?.data.command, 'npm install --no-audit --no-fund');
  const inferred = events.find(e => e.type === 'check-inferred'); assert.equal(inferred.data.candidates[0].trial.outcome, 'ran and passed', 'the trial Jev would see ran after the install');
});
test('A worker-proposed ask_user is refused when Jev judged the task does not need the user', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  session.objective = 'Change a to 2.'; session.phase = 'implement'; session.inspectionCount = 3; session.knownFiles.push('a.ts'); session.hashes['a.ts'] = hash('const a = 1;\n'); session.readHashes['a.ts'] = session.hashes['a.ts']!;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'modify', name: 'a', from: 'a.ts', to: 'a.ts', detail: 'a = 2' }] }); session.ledgerBuilt = true;
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); return { next: { type: 'choice', choice: 'free', confidence: .2, probabilities: Object.fromEntries(ids.map(i => [i, i === 'free' ? .4 : .6 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .12 } } as Answers; }
    return answersFor(q, 'ask_user', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ question: 'Should I set a to 2?' }) };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /step limit/);
  assert.equal(result.entries[0]?.kind, 'generation_error'); assert.match(result.entries[0]!.text, /ask_user refused: the task does not need the user \(judged 0\.12\)/);
});

test('The regression verdict judges only the files that existed: a created file\'s own errors never count against it', () => {
  const f = (count: number, lines: number[] = [1]) => ({ count, syntax: 0, resolution: count, lines, samples: [] as string[] });
  const before = { errors: 12, syntax: 0, resolution: 12, byFile: { 'src/App.tsx': f(12) } };
  const after = { errors: 11, syntax: 0, resolution: 11, byFile: { 'src/App.tsx': f(10), 'src/components/FeaturesSection.tsx': f(1) } };
  assert.equal(regression(before, after, { files: ['src/components/FeaturesSection.tsx'] }), 'worse', 'judged in scope, an edited file that only added an error');
  assert.equal(regression(before, after, { files: ['src/App.tsx'] }), 'fine', 'the created sibling is outside the scope the runner passes');
});
test('A relative module that resolves nowhere is re-pointed at the one file of that name, mechanically', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true }); await writeFile(join(root, 'src', 'types.ts'), 'export type BadgeProps = { children: string };\n');
  const badge = "import type { BadgeProps } from './types'\nimport type { ReactNode } from 'react'\nexport function Badge(p: BadgeProps): ReactNode { return p.children }\n";
  await writeFile(join(root, 'src', 'components', 'Badge.tsx'), badge);
  const names = await resolveMissingNames(root, "src/components/Badge.tsx(1,33): error TS2307: Cannot find module './types' or its corresponding type declarations.", ['src/components/Badge.tsx']);
  assert.deepEqual(names.map(n => [n.name, n.kind, n.importLine, n.line]), [["./types", 'respec', '../types', 1]]);
  const fixes = compactNames({ missingNames: names } as any, 40);
  assert.deepEqual(fixes.respecImports, { 'src/components/Badge.tsx': [{ from: './types', to: '../types', line: 1 }] });
  // A module nobody has is not re-pointed; an ambiguous one is not guessed.
  assert.deepEqual(await resolveMissingNames(root, "src/components/Badge.tsx(1,33): error TS2307: Cannot find module './nothing'.", ['src/components/Badge.tsx']), []);
  await writeFile(join(root, 'src', 'components', 'types.tsx'), 'export type BadgeProps = {};\n');
  assert.deepEqual(await resolveMissingNames(root, "src/components/Badge.tsx(1,33): error TS2307: Cannot find module '../lib/types'.", ['src/components/Badge.tsx']), []);
  await rm(join(root, 'src', 'components', 'types.tsx'));
  // End to end: the harness applies the rewrite itself after the failing check, then verifies.
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('src/components/Badge.tsx', 'utf8'); if (t.includes(\"from './types'\")) { console.error(\"src/components/Badge.tsx(1,33): error TS2307: Cannot find module './types' or its corresponding type declarations.\"); process.exit(1); } process.exit(0);\n");
  s.phase = 'implement'; s.inspectionCount = 3; s.writes = ['src/components/Badge.tsx']; s.hashes['src/components/Badge.tsx'] = hash(badge);
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => answersFor(q, ctx?.phase === 'completion-check' ? 'finish' : 'read_files', .9) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src/components/Badge.tsx', start: 1, end: 3 }] } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(s);
  const kinds = result.entries.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 3), ['bash', 'replace_lines', 'bash'], `steps: ${kinds.join(',')}`);
  assert.equal(await readFile(join(root, 'src', 'components', 'Badge.tsx'), 'utf8'), badge.replace("'./types'", "'../types'")); assert.equal(result.lastCheck?.ok, true);
});
test('A missing JSX namespace resolves to a type import of it from react, applied by the harness', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'Badge.tsx'), 'import type { P } from "./types";\nexport default function Badge(p: P): JSX.Element { return <span />; }\n');
  const names = await resolveMissingNames(root, "src/Badge.tsx(2,39): error TS2503: Cannot find namespace 'JSX'.", ['src/Badge.tsx']);
  assert.deepEqual(names.map(n => [n.name, n.importLine]), [['JSX', 'import type { JSX } from "react";']]);
  assert.deepEqual(compactNames({ missingNames: names } as any, 40).addImports, { 'src/Badge.tsx': ['import type { JSX } from "react";'] });
});
test('A wrong-module error with the checker\'s hint is repaired as an aliased import, usage untouched', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  const app = 'import { Navbar } from "./components/Navbar";\nimport { CTASection, type Props } from "./components/CTASection";\nexport const App = () => [Navbar, CTASection];\n';
  await writeFile(join(root, 'src', 'App.tsx'), app); await writeFile(join(root, 'src', 'components', 'CTASection.tsx'), 'export const CtaSection = 1;\nexport type Props = {};\n');
  const names = await resolveMissingNames(root, `src/App.tsx(2,10): error TS2724: '"./components/CTASection"' has no exported member named 'CTASection'. Did you mean 'CtaSection'?`, ['src/App.tsx', 'src/components/CTASection.tsx']);
  assert.deepEqual(names.map(n => [n.name, n.kind, n.importLine, n.line]), [['CTASection', 'alias', 'CtaSection', 2]]);
  const fixes = compactNames({ missingNames: names } as any, 40);
  assert.deepEqual(fixes.aliasImports, { 'src/App.tsx': [{ name: 'CTASection', actual: 'CtaSection', line: 2 }] });
  const edit = await aliasImportBinding('src/App.tsx', app, 'CTASection', 'CtaSection', 2);
  assert.deepEqual(edit, { start: 2, end: 2, newText: 'import { CtaSection as CTASection, type Props } from "./components/CTASection";', prepend: '' });
});
test('A blocked route never hides decided work; a deliverable set aside after three failed creations is', async t => {
  const { session: s } = await fixture(t);
  s.lastCheck = { step: 5, ok: false, text: 'x', summary: summarizeCheck("src/App.tsx(6,1): error TS2724: '\"./c\"' has no exported member 'X'.") };
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'modify', name: 'App', from: 'src/App.tsx', to: 'src/App.tsx', detail: 'm' }, { kind: 'create', name: 'src/new.ts', from: '', to: 'src/new.ts', detail: 'c' }] });
  s.knownFiles.push('src/App.tsx');
  let ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(ids.includes('fix:src/App.tsx') && ids.includes('implement:d1') && ids.includes('implement:d2'));
  s.blockedRoute = 'replace_lines';
  ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(ids.includes('fix:src/App.tsx') && ids.includes('implement:d1') && ids.includes('implement:d2'), 'a free-path route block is not a reason to withhold decided work');
  s.ledger[1]!.attempts = 3;
  ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(!ids.includes('implement:d2'), 'three failed creations set the item aside');
  s.ledger[0]!.attempts = 3; s.hashes['src/App.tsx'] = 'h'; s.fixAttempts = { 'src/App.tsx@h': 3 };
  ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(!ids.includes('implement:d1') && !ids.includes('fix:src/App.tsx'), 'three failed edits set the item aside, and three failed rewrites of one version of a file withhold its fix');
  s.hashes['src/App.tsx'] = 'changed';
  assert(candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id).includes('fix:src/App.tsx'), 'a changed file may be fixed again');
});
test('A decided fix is a region rewrite: code picks the region, the worker returns corrected code, the harness validates it before it lands, and no read is spent', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  // A Button.tsx-shaped file: the return's closing ");" is missing before the function's brace.
  const lines = ['import React from "react";', 'export function Button({ children }: { children: React.ReactNode }) {', '  return (', '    <button type="button">', '      {children}', '    </button>', '}', ''];
  const cta = lines.join('\n'); await writeFile(join(root, 'src', 'components', 'Button.tsx'), cta); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.objective = 'Fix the landing page.'; session.phase = 'implement'; session.inspectionCount = 3; session.knownFiles.push('src/components/Button.tsx');
  session.writes = ['src/components/Button.tsx']; session.hashes['src/components/Button.tsx'] = hash(cta); // written, never read at this version
  session.lastCheck = { step: 3, ok: false, text: "src/components/Button.tsx(7,1): error TS1005: ')' expected.", summary: summarizeCheck("src/components/Button.tsx(7,1): error TS1005: ')' expected.") }; session.lastCheckCommand = 'node check.mjs'; session.lastWriteStep = 2;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/components/Button.tsx', from: '', to: 'src/components/Button.tsx', detail: 'button' }] }); session.ledgerBuilt = true; await refreshLedger(root, session);
  const prompts: any[] = []; let attempt = 0;
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('fix:'))!; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const stillBroken = [...lines.slice(0, 5), '  );', '}', ''].join('\n'); const truncated = 'import React from "react";\nconst helper = 1;\n'; const good = [...lines.slice(0, 6), '  );', '}', ''].join('\n');
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'fixed' } : { files: [{ path: 'src/components/Button.tsx', start: 1, end: 1 }] },
    generateText: async (m: any) => { prompts.push(m); attempt++; return { text: attempt === 1 ? stillBroken : attempt === 2 ? truncated : good, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(kinds[0], 'generation_error', `steps: ${kinds.join(',')}`); assert.match(result.entries[0]!.text, /would still not parse/);
  assert.equal(kinds[1], 'generation_error'); assert.match(result.entries[1]!.text, /dropped the export Button, which other files import/, 'a rewrite that ends early and parses is still wrong content');
  assert.match(JSON.parse(prompts[2][2].content).errors.join(' | '), /previous attempt: The rewrite of src\/components\/Button\.tsx dropped the export Button/, 'the next attempt is told what went wrong');
  assert.equal(kinds[2], 'replace_lines'); assert.equal(await readFile(join(root, 'src', 'components', 'Button.tsx'), 'utf8'), good);
  assert.equal(kinds[3], 'bash', 'the check runs after the repair as after any edit'); assert.equal(result.lastCheck?.ok, true);
  assert.equal(result.fixAttempts?.[`src/components/Button.tsx@${hash(cta)}`], 2, 'failed rewrites count against the file version');
  assert(!kinds.includes('read_files'), 'no read: code holds the file');
  const req = JSON.parse(prompts[0][2].content);
  assert.equal(prompts[0].length, 3); assert.equal(prompts[0][0].content, SYSTEM); assert.equal(req.file, 'src/components/Button.tsx'); assert.equal(req.content, cta, 'a small file is rewritten whole, with its opener in view');
  assert.match(req.errors.join(' '), /'\)' expected/); assert(!('editEvidence' in req) && !('rejectedEdits' in req), 'no history in a repair prompt');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'decided-fix'));
});
test('Scope creep is asked only about files no deliverable names, and not at all when every changed file is a deliverable', async t => {
  const { session: s } = await fixture(t);
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/App.tsx', from: '', to: 'src/App.tsx', detail: 'app', contents: [] }, { kind: 'modify', name: 'main', from: 'src/main.tsx', to: 'src/main.tsx', detail: 'm', contents: [] }] });
  assert.deepEqual(unaccountedFiles(s, ['src/App.tsx', 'src/main.tsx', 'package-lock.json']), []);
  assert.deepEqual(unaccountedFiles(s, ['src/App.tsx', 'src/legacy.ts']), ['src/legacy.ts']);
  assert(!('scope_creep' in auditQuestions(s.ledger, false, [])), 'nothing to ask');
  assert.match((auditQuestions(s.ledger, false, ['src/legacy.ts']).scope_creep as any).instructions, /`unaccountedFiles`/);
  const v = auditVerdict({ d_d1: { type: 'choice', choice: 'supports', confidence: 1, probabilities: { supports: 1, contradicts: 0, says_nothing: 0 } }, d_d2: { type: 'choice', choice: 'supports', confidence: 1, probabilities: { supports: 1, contradicts: 0, says_nothing: 0 } } }, s.ledger, defaults);
  assert(v.accepted); assert.equal(v.scopeCreep, 0);
});
test('The ledger carries a design, exports and dependencies, and a file to create is prompted as code with its contracts', async t => {
  const { root, session } = await fixture(t);
  const raw = { summary: 'A marketing landing page with a hero, three feature cards and a footer.', conventions: 'React 18 with TypeScript, Vite, CSS modules; named exports; no placeholders.',
    deliverables: [{ kind: 'create', name: 'src/components/Hero.tsx', from: '', to: 'src/components/Hero.tsx', detail: 'the hero section', contents: ['a headline and subheadline from props', 'a primary CTAButton', 'responsive layout'], exports: ['export function Hero(props: HeroProps): JSX.Element'], dependsOn: ['src/components/CTAButton.tsx'] }, { kind: 'create', name: 'src/components/CTAButton.tsx', from: '', to: 'src/components/CTAButton.tsx', detail: 'the button', contents: ['label and onClick props'], exports: ['export function CTAButton(props: { label: string; onClick(): void }): JSX.Element'], dependsOn: [] }] };
  assert.deepEqual(designFrom(raw), { summary: raw.summary, conventions: raw.conventions });
  const items = candidatesFrom(raw); assert.deepEqual(items[0]!.contents, raw.deliverables[0]!.contents); assert.deepEqual(items[0]!.dependsOn, ['src/components/CTAButton.tsx']); assert.deepEqual(items[1]!.exports, raw.deliverables[1]!.exports);
  session.design = designFrom(raw); session.ledger = items;
  // Before the dependency exists, its contract comes from the design; Hero is not ready, CTAButton is.
  assert.deepEqual(readyCreates(session).map(d => d.to), ['src/components/CTAButton.tsx']);
  let c = await contractsFor(root, session, items[0]!);
  assert.deepEqual(c.contracts, [{ path: 'src/components/CTAButton.tsx', importPath: './CTAButton', status: 'planned', exports: raw.deliverables[1]!.exports }]);
  await mkdir(join(root, 'src', 'components'), { recursive: true }); await writeFile(join(root, 'src', 'components', 'CTAButton.tsx'), 'export interface CTAProps { label: string; onClick(): void }\nexport const CTAButton = (p: CTAProps) => null;\nconst internal = 1;\n');
  session.knownFiles.push('src/components/CTAButton.tsx'); await refreshLedger(root, session);
  assert.deepEqual(readyCreates(session).map(d => d.to), ['src/components/Hero.tsx'], 'once the dependency exists the dependant is ready');
  c = await contractsFor(root, session, items[0]!);
  assert.equal(c.contracts[0]!.status, 'exists'); assert.match(c.contracts[0]!.exports.join('\n'), /export interface CTAProps/); assert.match(c.contracts[0]!.exports.join('\n'), /export const CTAButton = \(p: CTAProps\) =>$/m); assert(!c.contracts[0]!.exports.join('\n').includes('internal'));
  // The dependency's own prompt shows how its existing importer uses it.
  await writeFile(join(root, 'src', 'components', 'Hero.tsx'), 'import { CTAButton } from "./CTAButton";\nexport function Hero() {\n  return <div><CTAButton\n    label="Go"\n    onClick={() => track({ id: 1 })}\n  /></div>;\n}\n');
  const back = await contractsFor(root, session, items[1]!);
  assert.deepEqual(back.importers, [{ path: 'src/components/Hero.tsx', expects: raw.deliverables[1]!.exports, usage: ['<CTAButton label="Go" onClick={() => track({ id: 1 })} />'] }]);
  assert(!back.contracts.some(x => configLike(x.path)), 'a build configuration is never offered as a module to import');
  await rm(join(root, 'src', 'components', 'Hero.tsx'));
  const m = createFileMessages(session, { path: 'src/components/Hero.tsx', deliverable: items[0]!, contracts: c.contracts, importers: [], packages: ['react@18.2.0'] });
  assert.equal(m.length, 4); assert.equal(m[0]!.content, SYSTEM); const pinned = JSON.parse(m[1]!.content); const design = JSON.parse(m[2]!.content); const req = JSON.parse(m[3]!.content);
  assert.equal(pinned.objective, session.objective); assert.equal(design.design.summary, raw.summary); assert.deepEqual(design.installedPackages, ['react@18.2.0']);
  assert.deepEqual(req.mustContain, raw.deliverables[0]!.contents); assert.deepEqual(req.mustExport, items[0]!.exports); assert.equal(req.dependencies[0].import, './CTAButton'); assert.match(req.rules.join(' '), /no placeholders, TODOs/);
  assert.equal(taskRecord(session).design?.summary, raw.summary);
  assert.equal(fenceFor('src/components/Hero.tsx'), '```tsx'); assert.equal(fenceFor('README.md'), '````md');
  assert.match(createFileMessages(session, { path: 'src/components/CTAButton.tsx', deliverable: items[1]!, contracts: [], importers: back.importers, packages: [] })[3]!.content, /declare that export to accept exactly those props or arguments/);
  assert.deepEqual(usageSnippets('const a = <FeatureCard key={feature.id} feature={feature} />; const b = <FeatureCard {...x}>\n  child\n</FeatureCard>;', 'FeatureCard'), ['<FeatureCard key={feature.id} feature={feature} />', '<FeatureCard {...x}>']);
  assert.deepEqual(usageSnippets('export function formatPrice(n: number) { return n; }\nconst p = formatPrice(total, { currency: "USD" }); obj.formatPrice(1);', 'formatPrice'), ['formatPrice(total, { currency: "USD" })'], 'the declaration and a member call are not usages');
  assert.deepEqual(usageSnippets('nothing here', 'X'), []);
});
test('Creation names only the path; content is generated as code and never validated for length', () => {
  validate(schemas.create_file, { path: 'src/pages/LandingPage.tsx', purpose: 'the landing page' });
  assert.throws(() => validate(schemas.create_file, { path: 'a.tsx', purpose: 'p', content: 'x' }), /unknown property content/);
  validate(schemas.write, { path: 'a.ts', expectedHash: 'h', oldText: 'y'.repeat(700), newText: 'z' });
  assert.equal(extractCode('Here you go:\n```tsx\nexport const A = 1;\n```\nDone.'), 'export const A = 1;\n');
  assert.equal(extractCode('```\nline\n'), 'line\n', 'a block cut short by the budget has no closing fence');
  assert.equal(extractCode('plain text with no fence'), 'plain text with no fence\n');
});

test('repetitionStart finds a looping tail and leaves honest repetition alone', () => {
  const block = ['  <li>Item</li>', '  <li>Item</li>', '  <li>Item</li>'];
  const looping = ['const a = 1;', ...Array.from({ length: 5 }, () => ['<div className="feature">', '  <h3>Fast</h3>', '  <p>Really fast builds.</p>', '</div>']).flat()].join('\n');
  const at = repetitionStart(looping); assert(at >= 1 && at <= 5, `first repeat at ${at}`);
  assert.equal(repetitionStart(['const a = 1;', ...block, 'const b = 2;'].join('\n')), -1, 'three identical lines are not a loop'); assert.equal(repetitionStart(['const a = 1;', ...Array.from({ length: 6 }, () => '  <li>Item</li>')].join('\n')), 2, 'six identical substantive lines are, from the second');
  const honest = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  assert.equal(repetitionStart(honest), -1);
  assert.equal(repetitionStart(Array.from({ length: 12 }, () => '}').join('\n')), -1, 'closing braces are not content');
});
test('parseDesign reads the JSON block from a design reply and repairs one the budget cut', () => {
  const full = 'Analysis first.\n```json\n{"summary":"An app","conventions":"TS","deliverables":[{"kind":"create","name":"a.ts","from":"","to":"a.ts","detail":"d","contents":[],"exports":[],"dependsOn":[]}]}\n```\n';
  assert.equal(parseDesign(full)!.deliverables.length, 1);
  const cut = '```json\n{"summary":"An app","conventions":"TS","deliverables":[{"kind":"create","name":"a.ts","from":"","to":"a.ts","detail":"d","contents":[],"exports":[],"dependsOn":[]},{"kind":"create","name":"b.ts","from":"","to":"b.ts","detail":"a \\"quoted\\" one","contents":["x"],"exports":[],"dependsOn":["a.ts"]},{"kind":"create","name":"c.ts","from":"","to":"c.ts","det';
  const repaired = parseDesign(cut)!;
  assert.equal(repaired.summary, 'An app'); assert.deepEqual(repaired.deliverables.map((d: any) => d.name), ['a.ts', 'b.ts'], 'complete items are kept, the cut one is dropped');
  const early = '{"summary":"Only a summary so far","conventions":"conv';
  assert.deepEqual(parseDesign(early), { summary: 'Only a summary so far', conventions: '', deliverables: [] });
  assert.equal(parseDesign('no json here'), null);
  assert.equal(parseDesign('{"summary":"s","conventions":"c","deliverables":[]}')!.summary, 's', 'bare JSON without a fence');
});
test('generateText continues by token ids with the fence prefilled, stops on the closing fence, cuts a loop, and repairs a broken character', async t => {
  // A mock llama-server: tokens are character codes; /completion replies from a script and records the prompts it received.
  const requests: any[] = []; let script: { content: string; stop_type: string; tokens?: number[] }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: `<|im_start|>system\n${b.messages[0].content}<|im_end|>\n<|im_start|>assistant\n${b.chat_template_kwargs?.enable_thinking ? '' : '<think>\n\n</think>\n\n'}` }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/detokenize') return res.end(JSON.stringify({ content: String.fromCodePoint(...b.tokens).replace(/�/g, 'é') }));
    if (req.url === '/completion') { requests.push(b); const r = script.shift()!; return res.end(JSON.stringify({ content: r.content, tokens: r.tokens ?? [...r.content].map(c => c.codePointAt(0)), stop_type: r.stop_type, tokens_predicted: r.tokens?.length ?? [...r.content].length, timings: { predicted_per_second: 30 } })); }
    res.statusCode = 404; res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const bonsai = new Bonsai({ ...defaults, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, maxTokens: 64, createTokens: 200, contextWindow: 4000, workingTokens: 2000, safetyTokens: 100 }, 'local', noop);
  // Two chunks: the first stops at the chunk size, the second at the closing fence.
  script = [{ content: 'const a = 1;\n', stop_type: 'limit' }, { content: 'export { a };', stop_type: 'word' }];
  const g = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', context: { step: 1, route: 'create_file' } });
  assert.equal(g.text, 'const a = 1;\nexport { a };'); assert.equal(g.finish, 'stop'); assert.equal(g.meta.continuations, 1); assert.equal(g.meta.usage.completion_tokens, 26);
  const rendered = '<|im_start|>system\nS<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n```ts\n';
  assert.deepEqual(requests[0].prompt, [...rendered].map(c => c.codePointAt(0)), 'the opening fence is part of the prompt'); assert.deepEqual(requests[0].stop, ['\n```']); assert.equal(requests[0].n_predict, 64); assert.equal(requests[0].cache_prompt, true); assert(requests[0].dry_multiplier > 0);
  assert.deepEqual(requests[1].prompt, [...requests[0].prompt, ...[...'const a = 1;\n'].map(c => c.codePointAt(0))], 'the continuation is the same ids plus the ones generated, never a re-tokenized string');
  // A chunk that loops is cut at the first repeat and reported as such; no continuation is spent on it.
  const loop = Array.from({ length: 6 }, () => ['<div className="feature">', '  <h3>Fast</h3>', '  <p>Really fast builds.</p>', '</div>']).flat().join('\n');
  script = [{ content: `const b = 2;\n${loop}\n`, stop_type: 'limit' }];
  const r = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(r.finish, 'repetition'); assert(r.text.startsWith('const b = 2;\n<div className="feature">')); assert(r.text.split('\n').length < 12, 'cut at the first repeat'); assert.equal(script.length, 0);
  // A chunk ending in a broken character is re-derived from the token ids.
  script = [{ content: 'caf�', stop_type: 'limit', tokens: [99, 97, 102, 233] }, { content: ' au lait', stop_type: 'eos' }];
  const d = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null });
  assert.equal(d.text, 'café au lait'); assert.equal(d.finish, 'stop');
  // With thinking, the reply is rendered without the empty thought block, the thought is stripped, and an overlong thought is closed by the harness.
  script = [{ content: '<think>plan the files', stop_type: 'limit' }, { content: 'here is the design', stop_type: 'eos' }];
  const th = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null, thinking: true, thinkingBudget: 10, budgetTokens: 200 });
  assert.equal(th.text, 'here is the design'); assert.equal(requests.at(-1).prompt.slice(-11).map((c: number) => String.fromCodePoint(c)).join(''), '\n</think>\n\n', 'the thought was closed before the answer was asked for');
  // The budget ends a generation cleanly as length, not as an error.
  script = Array.from({ length: 6 }, () => ({ content: 'x'.repeat(64), stop_type: 'limit' }));
  const l = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null, budgetTokens: 200 });
  assert.equal(l.finish, 'length'); assert(l.text.length >= 200 && l.text.length <= 256, `generated ${l.text.length} characters`);
});
test('A created file that does not parse or lacks a promised export is repaired by the harness before it is checked, from a prompt that shows the whole small file', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.objective = 'Bootstrap a component library.'; session.phase = 'implement'; session.inspectionCount = 3;
  session.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'src/Button.tsx', from: '', to: 'src/Button.tsx', detail: 'the button', contents: ['a button'], exports: ['export function Button(): JSX.Element', "export type ButtonVariant = 'primary' | 'secondary'"], dependsOn: [] }] }); session.ledgerBuilt = true; session.design = { summary: 's', conventions: 'c' };
  const broken = 'export function Button() {\n  return (\n    <button type="button">Go</button>\n}\n'; // missing ");" and the promised type
  const fixed = "export type ButtonVariant = 'primary' | 'secondary';\nexport function Button() {\n  return (\n    <button type=\"button\">Go</button>\n  );\n}\n";
  const prompts: any[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); return { next: { type: 'choice', choice: 'implement:d1', confidence: .95, probabilities: Object.fromEntries(ids.map(i => [i, i === 'implement:d1' ? .95 : .05 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src/Button.tsx', start: 1, end: 1 }] },
    generateText: async (m: any) => { prompts.push(m); return { text: prompts.length === 1 ? broken : fixed, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 4), ['bash', 'create_file', 'replace_lines', 'bash'], `baseline, creation, repair, check; steps: ${kinds.join(',')}`);
  assert.match(result.entries[1]!.text, /does not parse yet/);
  assert.equal(await readFile(join(root, 'src', 'Button.tsx'), 'utf8'), fixed); assert.deepEqual(result.pendingRepairs, []);
  const createReq = JSON.parse(prompts[0][3].content); assert.equal(createReq.file, 'src/Button.tsx'); assert.deepEqual(createReq.mustExport, session.ledger[0]!.exports);
  const repairReq = JSON.parse(prompts[1][2].content);
  assert.equal(repairReq.content, broken, 'the whole file, opener included'); assert.match(repairReq.errors.join(' | '), /expected/); assert.match(repairReq.errors.join(' | '), /contract: src\/Button\.tsx must export ButtonVariant/);
  assert.equal(result.status, 'complete', result.stopReason);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'repair')); assert(!events.some(e => e.type === 'undo'), 'a created file is never rolled back');
});
test('Unplanned relative imports become derived deliverables with usage contracts; planned modules become dependencies; dropped candidates come back with their design', async t => {
  const { session: s } = await fixture(t);
  s.ledger = candidatesFrom({ deliverables: [
    { kind: 'create', name: 'src/pages/Landing.tsx', from: '', to: 'src/pages/Landing.tsx', detail: 'page', contents: [], exports: [], dependsOn: [] },
    { kind: 'create', name: 'src/types/index.ts', from: '', to: 'src/types/index.ts', detail: 'types', contents: [], exports: ['export type Feature = { id: string }'], dependsOn: [] } ] });
  s.droppedCandidates = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/context/ThemeContext.tsx', from: '', to: 'src/context/ThemeContext.tsx', detail: 'theme context from the design', contents: ['ThemeProvider', 'useTheme hook'], exports: ['export function ThemeProvider(props: { children: React.ReactNode }): JSX.Element'], dependsOn: [] }] });
  const text = 'import { Feature } from "../types";\nimport { Button } from "../components/Button";\nimport { useTheme } from "../context/ThemeContext";\nimport { features } from "../data/features";\nimport "./landing.css";\nexport function Landing() { const t = useTheme(); return <Button variant="primary" size="lg">{features.map(f => f.id)}</Button>; }\n';
  const imports = await relativeImports('src/pages/Landing.tsx', text);
  const added = deriveDeliverables(s, 'src/pages/Landing.tsx', imports, text);
  assert.deepEqual(s.ledger[0]!.dependsOn, ['src/types/index.ts', 'src/components/Button.tsx', 'src/context/ThemeContext.tsx', 'src/data/features.ts', 'src/pages/landing.css'], 'the importer now depends on what it imports');
  assert.deepEqual(added.map(d => [d.to, d.derived, d.status]), [['src/components/Button.tsx', true, 'pending'], ['src/context/ThemeContext.tsx', true, 'pending'], ['src/data/features.ts', true, 'pending'], ['src/pages/landing.css', true, 'pending']]);
  assert.equal(added[1]!.detail, 'theme context from the design', 'a dropped design candidate returns with its contents, not a stub'); assert.deepEqual(s.droppedCandidates, []);
  assert.match(added[0]!.contents!.join(' '), /React component <Button> rendered with props variant, size/); assert.match(added[2]!.contents!.join(' '), /features/);
  assert.deepEqual(added[0]!.exports, ['export function Button(props)']); assert.equal(added[0]!.importer, 'src/pages/Landing.tsx'); assert.equal(added[0]!.spec, '../components/Button');
  assert.deepEqual(await missingExports('src/components/Button.tsx', 'export default function Button() { return null; }\n', added[0]!.exports!), ['Button'], 'a default export does not satisfy a named contract');
  assert.deepEqual(await missingExports('src/components/Button.tsx', 'export function Button() { return null; }\n', added[0]!.exports!), []);
  const typed = deriveDeliverables(s, 'src/components/Card.tsx', [{ spec: '../shapes', names: ['Shape'], typeOnly: true }], 'const s: Shape = x;');
  assert.deepEqual(typed[0]!.exports, ['export type Shape']); assert.match(typed[0]!.contents!.join(' '), /imported with import type/);
  assert.equal(usageOf('const x = fn(a, b);', 'fn'), 'function fn called as fn(a, b)'); assert.equal(usageOf('let v: Feature = f;', 'Feature'), 'type Feature used in a type annotation');
  // Depth one: a derived file's own unplanned imports are its fix work, not new files; the cap holds.
  const again = deriveDeliverables(s, 'src/components/Button.tsx', [{ spec: './styles', names: ['s'] }], '');
  assert.deepEqual(again, []);
  assert.deepEqual(importCandidates('src/pages/Landing.tsx', '../types'), ['src/types', 'src/types.ts', 'src/types.tsx', 'src/types.js', 'src/types.jsx', 'src/types.mjs', 'src/types.cjs', 'src/types.json', 'src/types/index.ts', 'src/types/index.tsx', 'src/types/index.js', 'src/types/index.jsx']);
  assert.deepEqual(importCandidates('src/a.ts', './b.js'), ['src/b.js', 'src/b.ts']);
});
test('Creation order puts configuration first, then dependency depth; readiness offers what can be written now and falls back to the order', async t => {
  const { session: s } = await fixture(t);
  assert(configLike('package.json') && configLike('tsconfig.json') && configLike('vite.config.ts') && configLike('index.html') && !configLike('src/index.html') && !configLike('src/App.tsx'));
  s.ledger = candidatesFrom({ deliverables: [
    { kind: 'create', name: 'src/App.tsx', from: '', to: 'src/App.tsx', detail: 'app', contents: [], exports: [], dependsOn: ['src/components/Navbar.tsx', 'src/pages/Landing.tsx'] },
    { kind: 'create', name: 'src/pages/Landing.tsx', from: '', to: 'src/pages/Landing.tsx', detail: 'page', contents: [], exports: [], dependsOn: ['src/components/Button.tsx', 'src/types/index.ts'] },
    { kind: 'create', name: 'src/components/Button.tsx', from: '', to: 'src/components/Button.tsx', detail: 'button', contents: [], exports: [], dependsOn: ['../types'] },
    { kind: 'create', name: 'src/components/Navbar.tsx', from: '', to: 'src/components/Navbar.tsx', detail: 'nav', contents: [], exports: [], dependsOn: [] },
    { kind: 'create', name: 'src/types/index.ts', from: '', to: 'src/types/index.ts', detail: 'types', contents: [], exports: [], dependsOn: [] },
    { kind: 'create', name: 'package.json', from: '', to: 'package.json', detail: 'manifest', contents: [], exports: [], dependsOn: [] },
    { kind: 'create', name: 'src/main.tsx', from: '', to: 'src/main.tsx', detail: 'entry', contents: [], exports: [], dependsOn: ['src/App.tsx'] } ] });
  s.ledger[3]!.optional = true; // an optional dependency of a required page never deadlocks the order
  assert.deepEqual(creationOrder(s).map(d => d.to), ['package.json', 'src/types/index.ts', 'src/components/Button.tsx', 'src/pages/Landing.tsx', 'src/App.tsx', 'src/main.tsx', 'src/components/Navbar.tsx'], 'required before optional, configuration before source, then depth');
  assert.deepEqual(readyCreates(s).map(d => d.to), ['package.json', 'src/types/index.ts', 'src/components/Navbar.tsx']);
  const c = candidates(s, { ...defaults, allowWrite: true }, false);
  assert.deepEqual(c.filter(x => x.kind === 'implement').map(x => x.id), ['implement:d6'], 'one file at a time: the head of the order');
  assert.match(c[0]!.description, /Implement deliverable d6/);
  s.ledger[5]!.status = 'done'; s.ledger[4]!.status = 'done';
  const button = candidates(s, { ...defaults, allowWrite: true }, false).find(x => x.kind === 'implement')!;
  assert.equal(button.id, 'implement:d3', 'with its types in place the button comes first, in design order'); assert.match(button.description, /imported by src\/pages\/Landing\.tsx, which cannot be created before it/);
  s.ledger[2]!.status = 'done';
  assert.equal(candidates(s, { ...defaults, allowWrite: true }, false).find(x => x.kind === 'implement')!.id, 'implement:d2', 'the page follows its components');
  s.ledger[1]!.status = 'done';
  const next = candidates(s, { ...defaults, allowWrite: true }, false).find(x => x.kind === 'implement')!;
  assert.equal(next.id, 'implement:d4'); assert.match(next.description, /optional/);
  // A cycle or a dependency the design left out still yields work: the order itself.
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'a.ts', from: '', to: 'a.ts', detail: 'a', contents: [], exports: [], dependsOn: ['b.ts'] }, { kind: 'create', name: 'b.ts', from: '', to: 'b.ts', detail: 'b', contents: [], exports: [], dependsOn: ['a.ts'] }] });
  assert.deepEqual(readyCreates(s).map(d => d.to).sort(), ['a.ts', 'b.ts']);
});
test('Fix candidates are withheld for files whose only errors name modules a pending deliverable provides; ask falls through when the user is not needed', async t => {
  const { session: s } = await fixture(t);
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/App.tsx', from: '', to: 'src/App.tsx', detail: 'app', contents: [], exports: [], dependsOn: [] }, { kind: 'create', name: 'src/components/Footer.tsx', from: '', to: 'src/components/Footer.tsx', detail: 'footer', contents: [], exports: [], dependsOn: [] }] });
  s.ledger[0]!.status = 'done'; s.knownFiles.push('src/App.tsx');
  s.lastCheck = { step: 3, ok: false, text: 'x', summary: summarizeCheck("src/App.tsx(4,20): error TS2307: Cannot find module './components/Footer' or its corresponding type declarations.") };
  let ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(!ids.includes('fix:src/App.tsx'), 'the module is on its way'); assert(ids.includes('implement:d2'));
  s.lastCheck = { step: 3, ok: false, text: 'x', summary: summarizeCheck("src/App.tsx(4,20): error TS2307: Cannot find module './components/Footer'.\nsrc/App.tsx(9,3): error TS2322: Type 'string' is not assignable to type 'number'.") };
  ids = candidates(s, { ...defaults, allowWrite: true }, false).map(c => c.id);
  assert(ids.includes('fix:src/App.tsx'), 'a real error in the file is fix work');
  s.lastCheck = { step: 3, ok: false, text: 'x', summary: summarizeCheck('error: Could not resolve entry module "index.html".') };
  const pending = candidates(s, { ...defaults, allowWrite: true }, false);
  assert(!pending.some(x => x.id === 'fix:project'), 'a project-level error while files are still to be created is a consequence, not work');
  const d = decideStep({ next: { type: 'choice', choice: 'ask', confidence: .9, probabilities: { ask: .6, 'implement:d2': .3, free: .1 } }, needs_user: { type: 'noul', noul: .2 }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 } }, pending, defaults);
  assert.equal(d.candidate.id, 'implement:d2', 'asking while the user is not needed falls through to the next action instead of generating a question to refuse');
  s.ledger[1]!.status = 'done';
  const c = candidates(s, { ...defaults, allowWrite: true }, false); const project = c.find(x => x.id === 'fix:project')!;
  assert.equal(project.kind, 'free'); assert.match(project.description, /not attributed to any file/);
});
test('With a design, each candidate is judged as part of it, extra, or out of scope; the design is generated as text and parsed leniently', async t => {
  const { root, store, session } = await fixture(t);
  session.objective = 'Bootstrap an advanced react application with a landing page.';
  const design = { summary: 'A Vite React app with a landing page: hero, features and footer.', conventions: 'React 18, TypeScript, Tailwind; named exports.', deliverables: [
    { kind: 'create', name: 'package.json', from: '', to: 'package.json', detail: 'manifest', contents: ['scripts'], exports: [], dependsOn: [] },
    { kind: 'create', name: 'src/pages/Landing.tsx', from: '', to: 'src/pages/Landing.tsx', detail: 'the page', contents: ['hero'], exports: ['export function Landing(): JSX.Element'], dependsOn: ['src/components/Footer.tsx'] },
    { kind: 'create', name: 'src/components/Footer.tsx', from: '', to: 'src/components/Footer.tsx', detail: 'footer', contents: ['links'], exports: ['export function Footer(): JSX.Element'], dependsOn: [] },
    { kind: 'create', name: 'README.md', from: '', to: 'README.md', detail: 'docs', contents: ['setup'], exports: [], dependsOn: [] },
    { kind: 'create', name: 'src/legacy/Old.tsx', from: '', to: 'src/legacy/Old.tsx', detail: 'a page for a later phase', contents: [], exports: [], dependsOn: [] } ] };
  const text = `<think>Which files does a Vite app need?</think>\nHere is the design.\n\`\`\`json\n${JSON.stringify(design)}\n\`\`\`\n`;
  let seen: any = null;
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'ledger') {
      seen = { state, q };
      const tier = (id: string) => id === 'd4' || id === 'd1' ? 'extra' : id === 'd5' ? 'out_of_scope' : 'part_of_design';
      const a: Answers = { complete: { type: 'noul', noul: .9 } };
      for (const id of Object.keys(state.items)) { const c = tier(id); a[`tier_${id}`] = { type: 'choice', choice: c, confidence: .9, probabilities: { part_of_design: c === 'part_of_design' ? .9 : .05, extra: c === 'extra' ? .9 : .05, out_of_scope: c === 'out_of_scope' ? .9 : .05 } }; }
      return a;
    }
    return answersFor(q, 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => { throw new Error('the design is not a grammar-constrained generation'); },
    generateText: async (_m: any, o: any) => { assert.equal(o.thinking, true, 'the architect thinks first'); assert.equal(o.fence, null); return { text, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(Object.keys(seen.q).filter(k => k.startsWith('tier_')), ['tier_d2', 'tier_d3', 'tier_d4', 'tier_d5'], 'a manifest the repository lacks is part of the design by construction: Jev is not asked');
  assert.deepEqual(Object.keys((seen.q.tier_d2 as any).criteria), ['part_of_design', 'extra', 'out_of_scope']); assert.equal(seen.state.design.summary, design.summary); assert.deepEqual(Object.keys(seen.state), ['objective', 'design', 'items', 'allItems']); assert.equal(seen.state.allItems.length, 5); assert.match((seen.q.complete as any).instructions, /`allItems`/);
  assert.deepEqual(result.ledger.map(d => [d.to, d.optional ?? false]), [['package.json', false], ['src/pages/Landing.tsx', false], ['src/components/Footer.tsx', false], ['README.md', true]], 'part of the design blocks completion, extra is optional, the manifest is required whatever Jev would have said');
  assert.equal(result.ledger[0]!.required, 1);
  assert.deepEqual(result.droppedCandidates!.map(d => d.to), ['src/legacy/Old.tsx']); assert.equal(result.design!.summary, design.summary); assert.equal(result.ledgerBuilt, true);
  assert.deepEqual(result.ledger[1]!.dependsOn, ['src/components/Footer.tsx']); assert.deepEqual(result.ledger[2]!.exports, ['export function Footer(): JSX.Element']);
});
test('A write meant to create a file that does not exist is executed as a creation; one aimed at an existing file stays a stale write that forces a read', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'one\n');
  session.phase = 'implement'; session.inspectionCount = 3;
  let n = 0;
  const jev = { decide: async (_s: unknown, q: Questions) => answersFor(q, 'write', .1) };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ++n === 1 ? { path: 'src/new.ts', expectedHash: 'new', oldText: '', newText: 'export const n = 1;\n' } : { path: 'a.ts', expectedHash: 'new', oldText: '', newText: 'x' } };
  const result = await new Runner({ ...defaults, allowWrite: true, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['create_file', 'write']); assert.equal(await readFile(join(root, 'src/new.ts'), 'utf8'), 'export const n = 1;\n');
  assert.match(result.entries[1]!.text, /not a hash/); assert.equal(result.lastWriteStale, true);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.find(e => e.type === 'write-as-create')?.data.path, 'src/new.ts');
});
test('A focused edit takes its path and hash from the harness, whatever the worker echoed', async t => {
  const { root, store, session } = await fixture(t); const schemas_seen: unknown[] = [];
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const greeting = "hi";\n'); await writeFile(join(root, 'tsconfig.json'), '{}\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  session.objective = 'Make greeting say Hello World in src/a.ts.'; session.knownFiles.push('src/a.ts', 'tsconfig.json'); session.phase = 'implement'; session.inspectionCount = 3;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'modify', name: 'greeting', from: 'src/a.ts', to: 'src/a.ts', detail: 'greeting must be Hello World' }] }); session.ledgerBuilt = true; session.lastCheckCommand = 'node check.mjs';
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('inspect:')) ?? 'implement:d1'; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: any, schema: unknown) => {
    if (schema === focusedEditSchema) { schemas_seen.push(schema); return { path: 'tsconfig.json', expectedHash: 'wrong', edits: [{ start: 1, end: 1, newText: 'export const greeting = "Hello World";', prepend: '' }] } as any; }
    if (schema === schemas.finish) return { summary: 'done' };
    return { files: [{ path: 'src/a.ts', start: 1, end: 1 }] };
  } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind).slice(0, 3), ['read_files', 'replace_lines', 'bash']);
  assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), 'export const greeting = "Hello World";\n'); assert.equal(await readFile(join(root, 'tsconfig.json'), 'utf8'), '{}\n');
  assert.equal(schemas_seen.length, 1, 'the focused edit is generated under the edits-only schema, so prompt and grammar agree');
});
test('One finish policy: repairs, pending tasks, unaddressed rejections and a failing check each withhold completion', async t => {
  const { session: s } = await fixture(t);
  s.lastCheck = { step: 5, ok: true, text: 'ok', summary: summarizeCheck('') }; s.lastWriteStep = 4; s.editEvidence = [{ step: 4, route: 'write', paths: ['a.ts'], artifact: '', text: 'e' }];
  assert.equal(readyToFinish(s), true);
  s.pendingRepairs = [{ path: 'a.ts', errors: ['x'], attempts: 0 }]; assert.equal(readyToFinish(s), false); s.pendingRepairs = [];
  s.tasks = [{ id: 't', description: 'd', status: 'pending', evidence: '' }]; assert.equal(readyToFinish(s), false); s.tasks = [];
  s.completionFeedback = { step: 3, text: 'no', awaitingEvidence: true }; assert.equal(readyToFinish(s), false); s.completionFeedback = null;
  s.finishTriedAtCheck = 5; assert.equal(readyToFinish(s), false); s.finishTriedAtCheck = -1;
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/b.ts', from: '', to: 'src/b.ts', detail: 'b' }] }); s.ledger[0]!.status = 'pending'; assert.equal(readyToFinish(s), false, 'a required file still to be created is a fact, not a question for the audit'); s.ledger[0]!.optional = true; assert.equal(readyToFinish(s), true); s.ledger = [];
  s.lastCheck.ok = false; assert.equal(readyToFinish(s), false);
});
test('Contract helpers: export names from declaration heads, missing exports, exported signatures, statement bounds and context trimming', async t => {
  assert.deepEqual(exportNames(['export function Button(props: ButtonProps): JSX.Element', "export type ButtonVariant = 'a' | 'b'", 'export default App', 'default: Footer', 'useTheme', 'export const features: Feature[]']), ['Button', 'ButtonVariant', 'default', 'useTheme', 'features']);
  assert.deepEqual(exportNames(['export Hero', 'export { Button, Card as FeatureCard }', 'export * from "./x"', 'export abstract class Base']), ['Hero', 'Button', 'FeatureCard', 'Base'], 'the forms the harness and designs write are read as names, never as the word export');
  const text = 'export interface P { a: number }\nexport function Button(p: P) { return p; }\nconst hidden = 1;\nexport { hidden as shown };\nexport default Button;\nexport const long = () => {\n  return 1;\n};\n';
  assert.deepEqual(await missingExports('b.tsx', text, ['export function Button(p: P)', 'export type Missing = 1', 'export default Button', 'shown']), ['Missing']);
  const sigs = await exportedSignatures('b.tsx', text);
  assert.deepEqual(sigs, ['export interface P { a: number }', 'export function Button(p: P)', 'export { hidden as shown };', 'export default Button', 'export const long = () =>']);
  const file = 'const a = 1;\nfunction f() {\n  return (\n    1\n  );\n}\nconst b = 2;\n';
  assert.deepEqual(await statementBounds('f.ts', file, 3, 4), { start: 2, end: 6 }, 'expanded to the statements containing the lines');
  const gaps = 'const a = 1;\n\n\nfunction f() {\n  return 1;\n}\n\n\nconst b = 2;\n';
  assert.deepEqual(await statementBounds('g.ts', gaps, 2, 7), { start: 4, end: 6 }, 'bounds on blank lines move to the statement edges inside the range');
  assert.equal(trimContext('  beforeLine2\n  region1\n  region2\n  afterLine1\n', '  beforeLine1\n  beforeLine2', '  afterLine1\n  afterLine2'), '  region1\n  region2\n');
  assert.equal(trimContext('  region1\n', '', ''), '  region1\n');
  assert.equal(trimContext('  if (x) {\n    y();\n  }\n', '  const a = 1;\n  {', '}\n\nexport default f;'), '  if (x) {\n    y();\n  }\n', 'a lone bracket line matching the context is the region\'s own, not repeated context');
});
test('A region rewrite on a large file replaces only the statements around the errors, leaves the rest byte for byte, and never mistakes a region reply for the whole file', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  // 260 lines: 50 small statements, one of them (around line 120) broken.
  const stmts = Array.from({ length: 52 }, (_, i) => i === 23 ? [`export function f${i}() {`, `  return (`, `    ${i}`, `}`, ''] : [`export function f${i}() {`, `  return ${i};`, `}`, '', '']).flat();
  const text = ['import { x } from "./x";', ...stmts].join('\n') + '\n'; const total = text.split('\n').length; assert(total > 200);
  const broken = text.split('\n').findIndex(l => l === '    23') + 1;
  await writeFile(join(root, 'src', 'big.ts'), text);
  session.objective = 'Fix it.'; session.phase = 'implement'; session.inspectionCount = 3; session.knownFiles.push('src/big.ts'); session.writes = ['src/big.ts']; session.hashes['src/big.ts'] = hash(text);
  session.lastCheck = { step: 3, ok: false, text: `src/big.ts(${broken + 1},1): error TS1005: ')' expected.`, summary: summarizeCheck(`src/big.ts(${broken + 1},1): error TS1005: ')' expected.`) }; session.lastCheckCommand = 'node check.mjs'; session.lastWriteStep = 2;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/big.ts', from: '', to: 'src/big.ts', detail: 'big' }] }); session.ledgerBuilt = true; await refreshLedger(root, session);
  const prompts: any[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('fix:'))!; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'fixed' } : { files: [{ path: 'src/big.ts', start: 1, end: 1 }] },
    generateText: async (m: any) => { prompts.push(m); const req = JSON.parse(m[2].content); const region: string = req.region.text; return { text: `${req.contextBefore.text.split('\n').slice(-2).join('\n')}\n${region.replace('    23\n}', '    23\n  );\n}')}\n`, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(kinds[0], 'replace_lines', `steps: ${kinds.join(',')}`);
  const req = JSON.parse(prompts[0][2].content);
  assert(req.region && req.region.firstLine > 1 && req.region.lastLine < total, `a bounded region, not the whole file: ${req.region.firstLine}..${req.region.lastLine} of ${total}`);
  assert(req.region.firstLine <= broken - 25 + 5 && req.region.lastLine >= broken + 25 - 5, 'the region surrounds the reported line'); assert(req.contextBefore && req.contextAfter);
  assert.match(req.rules.join(' '), /contextBefore and contextAfter are shown for orientation only/);
  const after = await readFile(join(root, 'src', 'big.ts'), 'utf8');
  assert.equal(after, text.replace('    23\n}', '    23\n  );\n}'), 'only the broken statement changed; the repeated context lines were trimmed; everything else is byte-identical');
  assert.equal((await syntaxErrors('src/big.ts', after)).length, 0);
});
test('A markdown file that opens with a code block keeps it: only a fence at least as long as the prefilled one is unwrapped', async t => {
  const { root, store, session } = await fixture(t);
  session.objective = 'Document it.'; session.phase = 'implement'; session.inspectionCount = 3;
  session.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'README.md', from: '', to: 'README.md', detail: 'docs', contents: ['install'], exports: [], dependsOn: [] }, { kind: 'create', name: 'src/a.ts', from: '', to: 'src/a.ts', detail: 'a', contents: [], exports: [], dependsOn: [] }] }); session.ledgerBuilt = true; session.design = { summary: 's', conventions: 'c' };
  const readme = '```bash\nnpm install\n```\n\n# Title\n\nMore text.\n'; const wrapped = '```ts\nexport const a = 1;\n```\n';
  const fences: (string | null | undefined)[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('implement:'))!; return { next: { type: 'choice', choice: pick, confidence: .95, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .95 : .05 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'README.md', start: 1, end: 1 }] }),
    generateText: async (_m: any, o: any) => { fences.push(o.fence); return { text: o.fence === '````md' ? readme : wrapped, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, maxSteps: 2 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(result.entries.map(e => e.kind), ['create_file', 'create_file'], result.stopReason);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), readme, 'a shorter fence inside a document is content');
  assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n', 'a fence the model re-emitted is unwrapped');
  assert.deepEqual(fences, ['````md', '```ts']);
});
test('A repair that fails twice is given up to the check: the file stays, a fix candidate takes over, and finish is not proposed while it does not parse', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'; const t = readFileSync('src/a.ts', 'utf8'); if (t.includes('return (')) { console.error(\"src/a.ts(2,1): error TS1005: ')' expected.\"); process.exit(1); } process.exit(0);\n");
  session.objective = 'Make a.'; session.phase = 'implement'; session.inspectionCount = 3;
  session.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'src/a.ts', from: '', to: 'src/a.ts', detail: 'a', contents: [], exports: ['export function a(): number'], dependsOn: [] }] }); session.ledgerBuilt = true; session.design = { summary: 's', conventions: 'c' };
  const broken = 'export function a() {\n  return (\n}\n'; let gens = 0; const kinds: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); kinds.push(ids.join(',')); const pick = ids.find(i => i.startsWith('implement:')) ?? ids.find(i => i.startsWith('fix:')) ?? 'free'; return { next: { type: 'choice', choice: pick, confidence: .95, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .95 : .05 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'src/a.ts', start: 1, end: 1 }] }),
    generateText: async () => { gens++; return { text: broken, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, checkCommand: 'node check.mjs', maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const steps = result.entries.map(e => e.kind);
  // baseline check, creation, two failed repairs (returned unchanged), the check, then the fix candidate takes over
  assert.deepEqual(steps.slice(0, 5), ['bash', 'create_file', 'generation_error', 'generation_error', 'bash'], `steps: ${steps.join(',')}`);
  assert.deepEqual(result.pendingRepairs, [], 'given up after two attempts'); assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), broken, 'the file stays for the fixer');
  assert(kinds.at(-1)!.includes('fix:src/a.ts'), 'the check\'s error makes it fix work'); assert.equal(readyToFinish(result), false); assert.notEqual(result.status, 'complete');
  assert(gens >= 3);
});
test('A failed dependency install is fix work for the manifest: the harness rewrites it, installs again for the new manifest, and selects the check', async t => {
  const { root, store, session } = await fixture(t);
  const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
  // A fake npm: the install fails while the manifest asks for the version that does not exist, `npm view` knows the real one.
  await writeFile(join(bin, 'npm'), `#!/bin/bash\nif [ "$1" = "install" ]; then if grep -q '\\^8.0.0' package.json; then echo "npm error code ETARGET"; echo "npm error notarget No matching version found for bogus-plugin@^8.0.0."; exit 1; fi; mkdir -p node_modules && exit 0; fi\nif [ "$1" = "view" ]; then echo "7.37.5"; exit 0; fi\nif [ "$1" = "run" ]; then [ -d node_modules ] && exec node check.mjs; echo "sh: line 1: tsc: command not found"; exit 127; fi\n`, { mode: 0o755 });
  const bad = JSON.stringify({ name: 'demo', scripts: { typecheck: 'node check.mjs' }, devDependencies: { 'bogus-plugin': '^8.0.0' } }, null, 2) + '\n';
  const good = JSON.stringify({ name: 'demo', scripts: { typecheck: 'node check.mjs' }, devDependencies: { 'bogus-plugin': '^7.37.5' } }, null, 2) + '\n';
  await writeFile(join(root, 'package.json'), bad); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n'); await writeFile(join(root, 'src.mjs'), 'export const a = 1;\n');
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  session.objective = 'Bootstrap and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['package.json', 'src.mjs']; session.step = 2; session.lastWriteStep = 2; session.hashes['package.json'] = hash(bad);
  session.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'package.json', from: '', to: 'package.json', detail: 'manifest', contents: [], exports: [], dependsOn: [] }, { kind: 'create', name: 'src.mjs', from: '', to: 'src.mjs', detail: 'src', contents: [], exports: [], dependsOn: [] }] }); session.ledgerBuilt = true; session.design = { summary: 's', conventions: 'c' };
  await refreshLedger(root, session);
  const prompts: any[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.includes('fix:setup') ? 'fix:setup' : ids.find(i => i.startsWith('implement:')) ?? 'free'; return { next: { type: 'choice', choice: pick, confidence: .95, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .95 : .05 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'done' } : { files: [{ path: 'src.mjs', start: 1, end: 1 }] },
    generateText: async (m: any) => { prompts.push(m); return { text: good, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const setups = events.filter(e => e.type === 'setup'); assert.equal(setups.length, 2, `one install per manifest version; steps: ${result.entries.map(e => e.kind).join(',')}`); assert.equal(setups[0].data.code, 1); assert.equal(setups[1].data.code, 0);
  const repair = events.find(e => e.type === 'auto-manifest'); assert.deepEqual(repair?.data.changes, [{ name: 'bogus-plugin', from: '^8.0.0', to: '^7.37.5' }], 'the version that does not exist becomes the one the registry has, by code');
  assert.equal(prompts.length, 0, 'no generation is spent on a manifest the registry can correct'); assert.equal(await readFile(join(root, 'package.json'), 'utf8'), good);
  assert.equal(result.setupError, null); assert.equal(result.lastCheckCommand, 'npm run typecheck'); assert.equal(result.lastCheck?.ok, true); assert.equal(result.status, 'complete', result.stopReason);
  assert.match(result.autoFixKeys['manifest:bogus-plugin'] ?? '', /^step \d+$/);
});

test('A check summary keeps each diagnostic whole, with the continuation lines tsc prints, beside the clipped sample the decision state shows', () => {
  const output = ["src/components/Features.tsx(10,41): error TS2322: Type '{ key: string; feature: Feature; }' is not assignable to type 'IntrinsicAttributes & FeatureCardProps'.",
    "  Property 'feature' does not exist on type 'IntrinsicAttributes & FeatureCardProps'.",
    "src/components/CTA.tsx(69,13): error TS2322: Type '{ children: string; type: string; }' is not assignable to type 'IntrinsicAttributes & ButtonProps'.",
    "  Property 'type' does not exist on type 'IntrinsicAttributes & ButtonProps'.", '', 'Found 2 errors.'].join('\n');
  const s = summarizeCheck(JSON.stringify({ command: 'npm run typecheck', output, code: 2 }));
  assert.equal(s.errors, 2);
  const f = s.byFile['src/components/Features.tsx']!;
  assert.equal(f.diagnostics!.length, 1); assert.match(f.diagnostics![0]!, /Property 'feature' does not exist on type 'IntrinsicAttributes & FeatureCardProps'\.$/);
  assert.match(f.diagnostics![0]!, /^src\/components\/Features\.tsx\(10,41\): error TS2322: Type '\{ key: string; feature: Feature; \}' is not assignable/, 'the head is not cut in the middle');
  assert(f.samples[0]!.length <= 140 && f.samples[0]!.includes('truncated'), 'the sample stays short for the decision state');
  assert.match(s.byFile['src/components/CTA.tsx']!.diagnostics![0]!, /\n {2}Property 'type' does not exist/, 'a continuation line joins the diagnostic it belongs to, not the next file');
  assert.equal(summarizeCheck('x.ts(1,1): error TS1005: expected.\n' + 'y'.repeat(2000)).byFile['x.ts']!.diagnostics![0], 'x.ts(1,1): error TS1005: expected.', 'an unindented line is not a continuation');
});
test('importContracts lists the exported declarations of the modules a file imports, the ones the diagnostics name first, within a size budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-contracts-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'src', 'components', 'FeatureCard.tsx'), 'export type FeatureCardProps = {\n  title: string;\n  description: string;\n};\nexport function FeatureCard(props: FeatureCardProps) {\n  return <article>{props.title}</article>;\n}\n');
  await writeFile(join(root, 'src', 'components', 'Section.tsx'), 'export function Section({ id, children }: { id: string; children: React.ReactNode }) {\n  return <section id={id}>{children}</section>;\n}\n');
  await writeFile(join(root, 'src', 'data.ts'), 'export const features = [{ id: "a", title: "A", description: "a" }];\n');
  await writeFile(join(root, 'src', 'index.css'), 'body {}\n');
  const text = 'import "../index.css";\nimport { Section } from "./Section";\nimport { features } from "../data";\nimport { FeatureCard } from "./FeatureCard";\nimport { missing } from "./Missing";\nexport function Features() { return <Section id="f">{features.map(f => <FeatureCard key={f.id} feature={f} />)}</Section>; }\n';
  const contracts = await importContracts(root, 'src/components/Features.tsx', text, ["src/components/Features.tsx(6,1): error TS2322: Type '{ feature: X }' is not assignable to type 'IntrinsicAttributes & FeatureCardProps'."]);
  assert.deepEqual(contracts.map(c => c.path), ['src/components/FeatureCard.tsx', 'src/components/Section.tsx', 'src/data.ts'], 'the module whose export the error names comes first; a stylesheet and a missing module are not contracts');
  assert.equal(contracts[0]!.importPath, './FeatureCard');
  assert.match(contracts[0]!.exports.join('\n'), /export type FeatureCardProps = \{\n {2}title: string;\n {2}description: string;\n\};/);
  assert.match(contracts[0]!.exports.join('\n'), /export function FeatureCard\(props: FeatureCardProps\)/);
  const small = await importContracts(root, 'src/components/Features.tsx', text, [], 10);
  assert.equal(small.length, 1, 'the budget keeps at least one module and stops there');
  assert.deepEqual(await importContracts(root, 'src/components/Features.tsx', 'export const x = 1;\n'), []);
  const { session } = await fixture(t);
  const req = JSON.parse(rewriteRegionMessages(session, { path: 'src/components/Features.tsx', start: 1, end: 6, totalLines: 6, region: text, before: '', after: '', errors: ['e'], note: 'fix', imports: contracts })[2]!.content);
  assert.equal(req.imports[0].importPath, './FeatureCard'); assert.match(req.rules.join(' '), /make the call sites in this file match those declarations/);
  assert(!('imports' in JSON.parse(rewriteRegionMessages(session, { path: 'a.ts', start: 1, end: 1, totalLines: 1, region: 'x', before: '', after: '', errors: [], note: 'n' })[2]!.content)));
});
test('A decided fix sees the whole diagnostic and the callee\'s contract, and a rewrite that reproduces a version the check already failed is refused without a check', async t => {
  const { root, store, session } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'src', 'components', 'FeatureCard.tsx'), 'export type FeatureCardProps = {\n  title: string;\n  description: string;\n};\nexport function FeatureCard(props: FeatureCardProps) {\n  return <article>{props.title}</article>;\n}\n');
  await writeFile(join(root, 'src', 'data.ts'), 'export const features = [{ id: "a", title: "A", description: "a" }];\n');
  const shape = (call: string) => `import { features } from "../data";\nimport { FeatureCard } from "./FeatureCard";\n\nexport function Features() {\n  return (\n    <div>\n      {features.map((feature) => (\n        ${call}\n      ))}\n    </div>\n  );\n}\n`;
  const a = shape('<FeatureCard key={feature.id} feature={feature} />'); const b = shape('<FeatureCard key={feature.id} item={feature} />'); const good = shape('<FeatureCard key={feature.id} title={feature.title} description={feature.description} />');
  await writeFile(join(root, 'src', 'components', 'Features.tsx'), a);
  // A check that reports, as tsc does, the property that does not exist.
  await writeFile(join(root, 'check.mjs'), `import { readFileSync } from "node:fs";\nconst t = readFileSync("src/components/Features.tsx", "utf8"); const m = t.match(/ (feature|item)=\\{/);\nif (m) { console.log("src/components/Features.tsx(8,9): error TS2322: Type '{ key: string; " + m[1] + ": Feature; }' is not assignable to type 'IntrinsicAttributes & FeatureCardProps'.\\n  Property '" + m[1] + "' does not exist on type 'IntrinsicAttributes & FeatureCardProps'."); process.exit(2); }\n`);
  session.objective = 'Fix the landing page.'; session.phase = 'implement'; session.inspectionCount = 3; session.knownFiles.push('src/components/Features.tsx');
  session.writes = ['src/components/Features.tsx']; session.hashes['src/components/Features.tsx'] = hash(a); session.lastCheckCommand = 'node check.mjs'; session.lastWriteStep = 2;
  session.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'src/components/Features.tsx', from: '', to: 'src/components/Features.tsx', detail: 'features' }] }); session.ledgerBuilt = true; await refreshLedger(root, session);
  session.pendingCheck = true; // the check runs first and records the failed version
  const prompts: any[] = []; let attempt = 0;
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('fix:'))!; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; }
    return answersFor(q, ctx!.phase === 'completion-check' ? 'finish' : 'read_files', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.finish ? { summary: 'fixed' } : { files: [] },
    generateText: async (m: any) => { prompts.push(m); attempt++; return { text: attempt === 1 ? b : attempt === 2 ? a : good, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 6 }, store, jev, bonsai, root, () => {}).run(session);
  const kinds = result.entries.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 6), ['bash', 'replace_lines', 'bash', 'generation_error', 'replace_lines', 'bash'], `steps: ${kinds.join(',')}`);
  assert.match(result.entries[3]!.text, /reproduces a version of the file the check already reported errors in/, 'version a failed at the first check: generating it again is refused before any check is spent');
  assert.equal(await readFile(join(root, 'src', 'components', 'Features.tsx'), 'utf8'), good); assert.equal(result.lastCheck?.ok, true);
  assert.deepEqual(result.failedVersions?.['src/components/Features.tsx'], [hash(a), hash(b)]);
  const first = JSON.parse(prompts[0][2].content);
  assert.match(first.errors[0], /\n {2}Property 'feature' does not exist on type 'IntrinsicAttributes & FeatureCardProps'\.$/, 'the repair prompt carries the diagnostic whole');
  assert(!first.errors[0].includes('truncated'));
  assert.equal(first.imports[0].importPath, './FeatureCard'); assert.match(first.imports[0].exports.join('\n'), /FeatureCardProps = \{\n {2}title: string;/, 'the callee\'s props are in the prompt');
  assert.equal(first.imports[1].importPath, '../data');
  const third = JSON.parse(prompts[2][2].content);
  assert.match(third.errors.join(' | '), /previous attempt: The rewrite of src\/components\/Features\.tsx lines 1\.\.12 reproduces a version/);
});

test('A package a written file imports and the manifest lacks is installed by code, once, and the check runs again', async t => {
  const output = ["src/components/Icon.tsx(1,24): error TS2307: Cannot find module 'lucide-react' or its corresponding type declarations.",
    "src/data.ts(1,20): error TS2307: Cannot find module './missing' or its corresponding type declarations.",
    "src/util.ts(2,1): error TS2307: Cannot find module 'node:fs/promises'.",
    "src/other.ts(2,1): error TS2307: Cannot find module 'react-dom/client'.",
    'error during build:', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@tailwindcss/vite' imported from /x/node_modules/.vite-temp/vite.config.ts.mjs",
    "Error: Cannot find package 'unused-pkg'"].join('\n');
  const summary = summarizeCheck(JSON.stringify({ command: 'npm run build', output, code: 1 }));
  const texts = { 'src/components/Icon.tsx': 'import { Rocket } from "lucide-react";\n', 'vite.config.ts': "import tailwindcss from '@tailwindcss/vite'\nimport react from '@vitejs/plugin-react'\n", 'src/other.ts': "import { createRoot } from 'react-dom/client';\n", 'src/util.ts': "import { readFile } from 'node:fs/promises';\n" };
  const found = missingPackages(summary, texts, ['react@19.0.0', 'react-dom@19.0.0', 'vite@5.0.0']);
  assert.deepEqual(found.sort((a, b) => a.name.localeCompare(b.name)), [{ name: '@tailwindcss/vite', importers: ['vite.config.ts'] }, { name: 'lucide-react', importers: ['src/components/Icon.tsx'] }], 'relative, built-in, declared and unimported names are not candidates');
  const root = await mkdtemp(join(tmpdir(), 'leana-add-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await addPackagesCommand(root, ['lucide-react'], false), "npm install --no-audit --no-fund 'lucide-react'");
  assert.equal(await addPackagesCommand(root, ['@tailwindcss/vite'], true), "npm install --save-dev --no-audit --no-fund '@tailwindcss/vite'");
  await writeFile(join(root, 'pnpm-lock.yaml'), ''); assert.equal(await addPackagesCommand(root, ['a', 'b'], true), "pnpm add -D 'a' 'b'");
  // In the loop: the install is a forced bash step before any model is consulted, once per package, and the check is due again.
  const { root: repo, store, session } = await fixture(t);
  await mkdir(join(repo, 'src', 'components'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { react: '^19.0.0' } }));
  await writeFile(join(repo, 'src', 'components', 'Icon.tsx'), texts['src/components/Icon.tsx']); await writeFile(join(repo, 'vite.config.ts'), texts['vite.config.ts']);
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['package.json', 'src/components/Icon.tsx', 'vite.config.ts']; session.lastCheckCommand = 'npm run build';
  session.lastCheck = { step: 2, ok: false, text: output, summary };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, { decide: async (_s: unknown, q: Questions) => answersFor(q, 'read_files', .9) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({ files: [] }) }, repo, () => {});
  const ran: string[] = [];
  (runner as any).tools.execute = async (route: string, args: any) => { ran.push(`${route}: ${args.command}`); return { ok: true, text: 'added 2 packages' }; };
  const result = await runner.run(session);
  assert.deepEqual(ran, ["bash: npm install --no-audit --no-fund 'lucide-react' && npm install --save-dev --no-audit --no-fund '@tailwindcss/vite'"], 'runtime imports are dependencies, configuration imports are development dependencies');
  assert.equal(result.autoFixKeys['install:lucide-react'], 'step 1'); assert.equal(result.pendingCheck, true);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'auto-install' && /lucide-react/.test(e.data.purpose)));
  // The same names are not installed twice, whatever the next check says.
  ran.length = 0; result.pendingCheck = false;
  await runner.run({ ...result, step: result.step, status: 'running' } as any).catch(() => {});
  assert(!ran.some(r => r.includes('lucide-react')), 'an install is attempted once per package');
});

test('A verify deliverable that names a command is done only when that command passed after the last edit, is run by code once the check passes, and cites its own run at the audit', async t => {
  assert(commandLike('npm run build') && commandLike('cd web && pnpm test') && commandLike('tsc --noEmit') && !commandLike('the build succeeds') && !commandLike('Typecheck passes'));
  assert(runnableForever('npm run dev') && runnableForever('vite preview') && runnableForever('tsc --watch') && !runnableForever('npm run build'));
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { typecheck: 'node -e 0', build: 'node -e 0' } }));
  s.objective = 'Build the app.'; s.phase = 'implement'; s.inspectionCount = 3; s.step = 6; s.writes = ['a.ts']; s.lastWriteStep = 5; s.editEvidence = [{ step: 5, route: 'create_file', paths: ['a.ts'], artifact: '', text: 'created' } as any];
  s.ledger = candidatesFrom({ deliverables: [
    { kind: 'create', name: 'a.ts', from: '', to: 'a.ts', detail: 'a' },
    { kind: 'verify', name: 'npm run typecheck', from: '', to: '', detail: 'types pass' },
    { kind: 'verify', name: 'npm run build', from: '', to: '', detail: 'the production build completes' },
    { kind: 'verify', name: 'the app renders', from: '', to: '', detail: 'described, not a command' } ] }); s.ledgerBuilt = true;
  s.lastCheckCommand = 'npm run typecheck'; s.commandRuns = { 'npm run typecheck': { step: 6, ok: true }, 'npm run build': { step: 3, ok: true } };
  s.lastCheck = { step: 6, ok: true, text: 'ok', summary: summarizeCheck('') };
  await refreshLedger(root, s);
  const status = Object.fromEntries(s.ledger.map(d => [d.name, `${d.status}: ${d.note}`]));
  assert.equal(status['npm run typecheck'], 'done: npm run typecheck at step 6 passed');
  assert.equal(status['npm run build'], 'pending: npm run build at step 3 passed (before later edits)', 'a passing check is not this command\'s run');
  assert.equal(status['the app renders'], 'done: last check at step 6 passed', 'a described verification follows the check');
  const offered = candidates(s, { ...defaults, allowWrite: true, allowBash: true }, readyToFinish(s));
  assert.deepEqual(offered.filter(c => c.kind === 'verify').map(c => [c.id, c.target?.name]), [['verify:d3', 'npm run build']], 'the command not run since the last edit is offered; the one that ran is not');
  assert(!offered.some(c => c.id === 'finish'), 'finish is not proposed while a required verification is pending');
  const evidence = await completionEvidence(root, s, { files: [], moved: [] } as any);
  assert.equal(evidence['d3'], 'npm run build at step 3: passed (before later edits)'); assert.equal(evidence['d2'], 'npm run typecheck at step 6: passed (after the last edit)');
  // Decided: the harness runs the command itself, records the run, and the item is done.
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => { if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.find(i => i.startsWith('verify:'))!; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; } return answersFor(q, 'read_files', .9); } };
  const runner = new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  const ran: string[] = []; (runner as any).tools.execute = async (route: string, args: any) => { ran.push(`${route}: ${args.command}`); return { ok: true, text: JSON.stringify({ command: args.command, output: 'built', code: 0 }), verification: true, check: true }; };
  s.completionFeedback = { step: 4, text: 'Completion rejected: d3 not shown as done', awaitingEvidence: true, unmet: ['d3'], unmetPending: ['d3'] };
  const result = await runner.run(s);
  assert.deepEqual(ran, ['bash: npm run build']);
  assert.equal(result.completionFeedback!.addressed, true); assert.equal(result.completionFeedback!.awaitingEvidence, false, 'the verification the rejection named has run: no read or edit is needed before the next proposal');
  assert.equal(result.finishTriedAtCheck, -1, 'the finish latch opens with it');
  assert.equal(result.commandRuns!['npm run build']!.ok, true); assert.equal(result.ledger.find(d => d.name === 'npm run build')!.status, 'done');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'decided-verify' && e.data.command === 'npm run build'));
});

test('manifestFailures reads the package the registry rejected; a package that does not exist is dropped, and an install failure code cannot name is capped fix work for the worker', async t => {
  assert.deepEqual(manifestFailures("npm error code ETARGET\nnpm error notarget No matching version found for eslint-plugin-react@^8.0.0.\nnpm error notarget In most cases"), [{ name: 'eslint-plugin-react', kind: 'notarget' }]);
  assert.deepEqual(manifestFailures("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fno-such-pkg - Not found\nnpm error 404  '@scope/no-such-pkg@^1.0.0' is not in this registry."), [{ name: '@scope/no-such-pkg', kind: 'notfound' }]);
  assert.deepEqual(manifestFailures('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree'), []);
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '^19.0.0', '@scope/no-such-pkg': '^1.0.0' }, devDependencies: { vite: '^6.0.0' } }, null, 2) + '\n');
  session.writes = ['package.json']; session.hashes['package.json'] = hash(await readFile(join(root, 'package.json'), 'utf8')); session.step = 3;
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  (runner as any).lookupVersion = async () => { throw new Error('the registry is not consulted for a package that does not exist'); };
  assert.equal(await runner.repairManifest(session, "npm error 404  '@scope/no-such-pkg@^1.0.0' is not in this registry.", '.'), true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), { name: 'demo', dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^6.0.0' } });
  assert.equal(await runner.repairManifest(session, "npm error 404  '@scope/no-such-pkg@^1.0.0' is not in this registry.", '.'), false, 'once per package name');
  assert.equal(await runner.repairManifest(session, 'npm error code ERESOLVE', '.'), false);
  // A failure code cannot name goes to the worker, three times per manifest version at most.
  session.setupError = 'ERESOLVE unable to resolve dependency tree'; session.phase = 'implement';
  const offered = (fa: number) => { session.fixAttempts = { [`setup@${hash(session.setupError!)}`]: fa }; return candidates(session, { ...defaults, allowWrite: true, allowBash: true }, false).some(c => c.id === 'fix:setup'); };
  assert.equal(offered(2), true); assert.equal(offered(3), false);
});
test('A check summary attributes a diagnostic whose file appears only on a continuation line, relative to the repository, and never to node_modules', () => {
  const output = ['> demo@1.0.0 build', '> tsc --noEmit && vite build', '', 'vite v6.4.3 building for production...', '✗ Build failed in 21ms', 'error during build:',
    '[vite:build-html] Unable to parse HTML; parse5 error code disallowed-content-in-noscript-in-head', ' at /home/u/repo/index.html:10:7', '8  |      <title>Demo</title>', '9  |      <noscript>', '10 |        <p>Enable JavaScript.</p>', '   |        ^^^', 'file: /home/u/repo/index.html',
    '    at handleParseError (file:///home/u/repo/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:36308:9)', '    at Parser.onParseError (file:///home/u/repo/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:36221:7)'].join('\n');
  const s = summarizeCheck(JSON.stringify({ command: 'npm run build', output, code: 1 }), '/home/u/repo');
  assert.equal(s.errors, 1, 'the bundler\'s "error during build:" heading is not a diagnostic');
  assert.deepEqual(s.byFile['index.html']?.lines, [10]); assert.equal(s.byFile['index.html']?.count, 1); assert.match(s.byFile['index.html']!.diagnostics![0]!, /^\[vite:build-html\] Unable to parse HTML/);
  assert.match(s.byFile['index.html']!.diagnostics![0]!, /\n at \/home\/u\/repo\/index\.html:10:7\n8 {2}\|/, 'the code frame stays in the diagnostic');
  assert.equal(s.byFile['(other)'], undefined);
  assert.equal(summarizeCheck(JSON.stringify({ command: 'x', output: 'error: something\n at /elsewhere/other.ts:3:1' }), '/home/u/repo').byFile['(other)']?.count, 1, 'a path outside the repository is not attributed');
  const rust = summarizeCheck('error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:4:13\n  |\n4 |     let y = x;');
  assert.deepEqual(rust.byFile['src/main.rs'], { count: 1, syntax: 0, resolution: 0, lines: [4], samples: ['error[E0425]: cannot find value `x` in this scope'], diagnostics: ['error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:4:13\n  |\n4 |     let y = x;'] });
});
test('A shell command that edits a written file is tracked as an edit: hashes and write step move, reads of it go stale, and the check is due again', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'index.html'), '<html>\n<p>one</p>\n</html>\n'); await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  s.writes = ['index.html', 'a.ts']; s.hashes['index.html'] = hash('<html>\n<p>one</p>\n</html>\n'); s.hashes['a.ts'] = hash('export const a = 1;\n'); s.readHashes['index.html'] = s.hashes['index.html']; s.lastWriteStep = 2; s.step = 5; s.lastCheckCommand = 'node check.mjs';
  s.entries.push({ id: 'e3', step: 3, kind: 'read_files', text: 'index.html sha256=x totalLines=3 shown=1..3\n1: <html>', artifact: '', relevance: .5 });
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  await writeFile(join(root, 'index.html'), '<html>\n</html>\n'); // what `sed -i '2d' index.html` did
  await runner.evidence(s, 'bash', { ok: true, text: JSON.stringify({ command: "sed -i '2d' index.html", output: '', code: 0 }) }, { command: "sed -i '2d' index.html", purpose: 'remove the line' });
  assert.equal(s.hashes['index.html'], hash('<html>\n</html>\n')); assert.equal(s.hashes['a.ts'], hash('export const a = 1;\n'));
  assert.equal(s.lastWriteStep, 5); assert.equal(s.writeSteps['index.html'], 5); assert.equal(s.pendingCheck, true); assert.equal(s.readHashes['index.html'], undefined);
  assert.match(s.entries[0]!.stale ?? '', /edited at step 5/);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.find(e => e.type === 'bash-edit')?.data.files, ['index.html']);
  // A read-only command touches nothing.
  s.pendingCheck = false; await runner.evidence(s, 'bash', { ok: true, text: '{}' }, { command: 'cat index.html', purpose: 'look' }); assert.equal(s.pendingCheck, false);
});
test('A design verification that fails becomes the failing check: its errors are attributed to the file, the fix is offered, and the check command stays the cheaper one', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'index.html'), '<html>\n<head>\n<noscript><p>x</p></noscript>\n</head>\n</html>\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'build.mjs'), `import { readFileSync } from "node:fs";\nif (/<head>[\\s\\S]*<noscript>[\\s\\S]*<\\/head>/.test(readFileSync("index.html", "utf8"))) { console.log("error during build:\\n[vite:build-html] Unable to parse HTML; parse5 error code disallowed-content-in-noscript-in-head\\n at ${root}/index.html:3:11"); process.exit(1); }\n`);
  s.objective = 'Build the app.'; s.phase = 'implement'; s.inspectionCount = 3; s.step = 6; s.writes = ['index.html']; s.hashes['index.html'] = hash(await readFile(join(root, 'index.html'), 'utf8')); s.lastWriteStep = 5; s.editEvidence = [{ step: 5, route: 'create_file', paths: ['index.html'], artifact: '', text: 'created' } as any];
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'index.html', from: '', to: 'index.html', detail: 'page' }, { kind: 'verify', name: 'node build.mjs', from: '', to: '', detail: 'the production build completes' }] }); s.ledgerBuilt = true;
  s.lastCheckCommand = 'node check.mjs'; s.lastCheck = { step: 6, ok: true, text: 'ok', summary: summarizeCheck('') };
  await refreshLedger(root, s);
  const seen: string[][] = [];
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => { if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); seen.push(ids); const pick = ids.find(i => i.startsWith('verify:')) ?? ids.find(i => i.startsWith('fix:')) ?? 'ask'; assert(!ids.includes('fix:project'), `the bundler heading is not unattributed work: ${ids.join(',')}`); return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .05 } } as Answers; } return answersFor(q, 'read_files', .9); } };
  const prompts: any[] = [];
  const bonsai = { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}), generateText: async (m: any) => { prompts.push(m); return { text: '<html>\n<head>\n</head>\n<body><noscript><p>x</p></noscript></body>\n</html>\n', finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 4 }, store, jev, bonsai, root, () => {}).run(s);
  const kinds = result.entries.map(e => e.kind);
  assert.equal(kinds[0], 'bash', `steps: ${kinds.join(',')}`);
  assert.deepEqual(seen[0], ['verify:d2', 'ask', 'free']); assert(seen[1]!.includes('fix:index.html'), `after the failed build the fix is offered: ${seen[1]!.join(',')}`);
  assert.equal(kinds[1], 'replace_lines', `the region rewrite of index.html lands: ${result.entries[1]!.text.slice(0, 300)}`); assert.equal(kinds[2], 'bash', 'then the cheaper check runs'); assert.equal(result.lastCheckCommand, 'node check.mjs');
  assert.match(JSON.parse(prompts[0][2].content).errors[0], /disallowed-content-in-noscript-in-head\n at .*index\.html:3:11/, 'the fix prompt carries the bundler diagnostic whole');
  assert.equal(kinds[3], 'bash', 'the verification runs again once its inputs changed'); assert.equal(result.ledger.find(d => d.kind === 'verify')!.status, 'done');
});

test('The worker is offered finish only when the harness would propose it, and a repair or creation prompt shows the types a contract names one hop out', async t => {
  const { root, session: s } = await fixture(t);
  s.phase = 'implement'; s.lastCheck = { step: 3, ok: true, text: 'ok', summary: summarizeCheck('') }; s.lastCheckStep = 3; s.lastWriteStep = 2; s.step = 4;
  assert('finish' in (routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }, true).route as any).criteria);
  assert(!('finish' in (routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }, false).route as any).criteria));
  assert('finish' in (routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route as any).criteria, 'the default keeps the older callers whole');
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'src', 'types.ts'), 'export type Theme = "light" | "dark";\nexport type ThemeToggleProps = {\n  theme: Theme;\n  onToggle: () => void;\n};\nexport type Unrelated = { x: number };\n');
  await writeFile(join(root, 'src', 'components', 'ThemeToggle.tsx'), 'import type { ThemeToggleProps } from "../types";\nexport function ThemeToggle(props: ThemeToggleProps) {\n  return <button onClick={props.onToggle}>{props.theme}</button>;\n}\n');
  const app = 'import { ThemeToggle } from "./components/ThemeToggle";\nexport function App() {\n  return <ThemeToggle>x</ThemeToggle>;\n}\n';
  const contracts = await importContracts(root, 'src/App.tsx', app, ["src/App.tsx(3,11): error TS2559: Type '{ children: string; }' has no properties in common with type 'IntrinsicAttributes'."]);
  assert.deepEqual(contracts.map(c => [c.path, c.importPath]), [['src/components/ThemeToggle.tsx', './components/ThemeToggle'], ['src/types.ts', './types']]);
  assert.deepEqual(contracts[1]!.exports, ['export type ThemeToggleProps = {\n  theme: Theme;\n  onToggle: () => void;\n};'], 'only the type the signature names, not the whole module');
  // A creation prompt gets the same hop through its designed dependency.
  s.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'src/App.tsx', from: '', to: 'src/App.tsx', detail: 'app', contents: [], exports: ['export function App(): JSX.Element'], dependsOn: ['src/components/ThemeToggle.tsx'] }, { kind: 'create', name: 'src/components/ThemeToggle.tsx', from: '', to: 'src/components/ThemeToggle.tsx', detail: 'toggle', contents: [], exports: [], dependsOn: [] }] }); s.design = { summary: 's', conventions: 'c' }; s.knownFiles.push('src/components/ThemeToggle.tsx', 'src/types.ts');
  await refreshLedger(root, s);
  const c = await contractsFor(root, s, s.ledger[0]!);
  assert.deepEqual(c.contracts.map(x => x.path), ['src/components/ThemeToggle.tsx', 'src/types.ts']); assert.match(c.contracts[1]!.exports.join('\n'), /ThemeToggleProps/); assert(!c.contracts[1]!.exports.join('\n').includes('Unrelated'));
});

test('A rejection whose unmet item was already done by source facts is not settled by those facts: no finish is re-proposed until an edit and a passing check', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  s.objective = 'Write a.ts.'; s.phase = 'implement'; s.inspectionCount = 3; s.step = 6; s.writes = ['a.ts']; s.lastWriteStep = 4; s.editEvidence = [{ step: 4, route: 'create_file', paths: ['a.ts'], artifact: '', text: 'created' } as any];
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'a.ts', from: '', to: 'a.ts', detail: 'a substantial module' }] }); s.ledgerBuilt = true;
  s.lastCheckCommand = 'node check.mjs'; s.lastCheck = { step: 5, ok: true, text: 'ok', summary: summarizeCheck(''), command: 'node check.mjs' }; s.lastCheckStep = 5; s.finishTriedAtCheck = 5;
  await refreshLedger(root, s); assert.equal(s.ledger[0]!.status, 'done');
  // The audit contradicted an item the facts call done: unmet, but not pending.
  s.completionFeedback = { step: 5, text: 'Completion rejected: d1 is a stub', awaitingEvidence: true, unmet: ['d1'], unmetPending: [] };
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => { if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); assert(!ids.includes('finish'), `finish is not offered again on the same facts: ${ids.join(',')}`); return { next: { type: 'choice', choice: 'ask', confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === 'ask' ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: .9 } } as Answers; } assert.notEqual(ctx!.phase, 'completion-check', 'no audit is spent on unchanged facts'); return answersFor(q, 'ask_user', .9); } };
  const finishes: number[] = [];
  const bonsai = { count: async () => ({ tokens: 1, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => { if (schema === schemas.finish) finishes.push(1); return schema === schemas.ask_user ? { question: 'what next?' } : {}; } };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 3 }, store, jev, bonsai, root, () => {}).run(s);
  assert.equal(finishes.length, 0, 'no finish summary is generated'); assert.equal(result.completionFeedback!.addressed, undefined); assert.equal(result.finishTriedAtCheck, 5);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(!events.some(e => e.type === 'auto-finish'));
});
test('An install failure code cannot name is capped by that failure, each rewritten manifest is installed again without spending the check-inference budget, and the version lookup ignores npm notices', async t => {
  const { root, store, session } = await fixture(t);
  const bin = join(root, 'bin'); await mkdir(bin, { recursive: true });
  // The install always fails with a peer conflict; `npm view` answers with a notice after the version.
  await writeFile(join(bin, 'npm'), `#!/bin/bash\nif [ "$1" = "install" ]; then echo "npm error code ERESOLVE"; echo "npm error ERESOLVE unable to resolve dependency tree"; echo "npm error peer eslint@\\"^8\\" from eslint-plugin-react-hooks@4.6.2"; exit 1; fi\nif [ "$1" = "view" ]; then echo "7.37.5"; echo "npm notice New major version of npm available! 10.8.2 -> 11.0.0"; exit 0; fi\nif [ "$1" = "run" ]; then echo "sh: line 1: tsc: command not found"; exit 127; fi\n`, { mode: 0o755 });
  const manifest = (minor: number) => JSON.stringify({ name: 'demo', scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { 'eslint-plugin-react-hooks': `^4.${minor}.0`, eslint: '^9.0.0' } }, null, 2) + '\n';
  await writeFile(join(root, 'package.json'), manifest(6)); await writeFile(join(root, 'src.mjs'), 'export const a = 1;\n');
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; t.after(() => { process.env.PATH = oldPath; });
  session.objective = 'Bootstrap and verify.'; session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['package.json', 'src.mjs']; session.step = 2; session.lastWriteStep = 2; session.hashes['package.json'] = hash(manifest(6));
  session.ledger = candidatesFrom({ summary: 's', conventions: 'c', deliverables: [{ kind: 'create', name: 'package.json', from: '', to: 'package.json', detail: 'manifest', contents: [], exports: [], dependsOn: [] }, { kind: 'create', name: 'src.mjs', from: '', to: 'src.mjs', detail: 'src', contents: [], exports: [], dependsOn: [] }] }); session.ledgerBuilt = true; session.design = { summary: 's', conventions: 'c' };
  await refreshLedger(root, session);
  let minor = 6; const picks: string[] = [];
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); const pick = ids.includes('fix:setup') ? 'fix:setup' : 'ask'; picks.push(pick); return { next: { type: 'choice', choice: pick, confidence: .95, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .95 : .05 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: pick === 'ask' ? .9 : .05 } } as Answers; }
    return answersFor(q, 'ask_user', .9);
  } };
  // The worker returns a fresh, valid manifest every time; it still conflicts.
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => schema === schemas.ask_user ? { question: 'which eslint?' } : {}, generateText: async () => ({ text: manifest(++minor), finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }) };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 12 }, store, jev, bonsai, root, () => {}).run(session);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const fixes = events.filter(e => e.type === 'decided-fix').length; const setups = events.filter(e => e.type === 'setup').length;
  assert.equal(fixes, 3, `three manifest rewrites against one install error, then no more: picks ${picks.join(',')}`);
  assert.equal(setups, 4, 'the first install, then one per landed rewrite, none skipped for want of inference budget');
  assert.equal(result.fixAttempts![`setup@${hash(result.setupError!)}`], 3); assert.match(result.setupError!, /ERESOLVE/);
  assert.equal(result.failedVersions!['package.json']!.length, 4, 'every manifest version an install rejected is known bad');
  assert(picks.slice(3).every(p => p === 'ask'), 'after the cap the loop asks instead of rewriting');
  // The lookup takes the version line, not npm's notice; both sections listing a name are repaired.
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, jev, bonsai, root, () => {});
  assert.equal(await runner.lookupVersion('anything'), '7.37.5');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'eslint-plugin-react': '^7.0.0' }, devDependencies: { 'eslint-plugin-react': '^8.0.0' } }, null, 2) + '\n');
  const s2 = await fixture(t); s2.session.step = 9;
  assert.equal(await runner.repairManifest(s2.session, 'npm error notarget No matching version found for eslint-plugin-react@^8.0.0.', '.'), true);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); assert.equal(pkg.dependencies['eslint-plugin-react'], '^7.37.5'); assert.equal(pkg.devDependencies['eslint-plugin-react'], '^7.37.5');
});
test('A verification that fails three times on changed inputs is set aside, and a fix that reproduces a version the build rejected is refused', async t => {
  const { root, store, session: s } = await fixture(t);
  await writeFile(join(root, 'index.html'), '<html>\n<head>\n<noscript><p>x</p></noscript>\n</head>\n</html>\n'); await writeFile(join(root, 'check.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'build.mjs'), `console.log("error during build:\\n[vite:build-html] Unable to parse HTML; parse5 error code disallowed-content-in-noscript-in-head\\n at ${root}/index.html:3:11"); process.exit(1);\n`);
  s.objective = 'Build the app.'; s.phase = 'implement'; s.inspectionCount = 3; s.step = 6; s.writes = ['index.html']; s.hashes['index.html'] = hash(await readFile(join(root, 'index.html'), 'utf8')); s.lastWriteStep = 5; s.editEvidence = [{ step: 5, route: 'create_file', paths: ['index.html'], artifact: '', text: 'created' } as any];
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'create', name: 'index.html', from: '', to: 'index.html', detail: 'page' }, { kind: 'verify', name: 'node build.mjs', from: '', to: '', detail: 'the production build completes' }] }); s.ledgerBuilt = true;
  s.lastCheckCommand = 'node check.mjs'; s.lastCheck = { step: 6, ok: true, text: 'ok', summary: summarizeCheck(''), command: 'node check.mjs' }; s.lastCheckStep = 6;
  await refreshLedger(root, s);
  const seen: string[][] = [];
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => { if (ctx!.phase === 'step') { const ids = Object.keys((q.next as any).criteria); seen.push(ids); const pick = ids.find(i => i.startsWith('verify:')) ?? ids.find(i => i.startsWith('fix:') && i !== 'fix:project') ?? 'ask'; return { next: { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? .9 : .1 / (ids.length - 1)])) }, stuck: { type: 'noul', noul: .1 }, scope_drift: { type: 'noul', noul: .1 }, needs_user: { type: 'noul', noul: pick === 'ask' ? .9 : .05 } } as Answers; } return answersFor(q, 'ask_user', .9); } };
  let n = 0; const versions = ['<html>\n<head>\n</head>\n<body><noscript><p>x</p></noscript></body>\n</html>\n', '<html>\n<head>\n<noscript><p>x</p></noscript>\n</head>\n</html>\n', '<html>\n<head>\n</head>\n<body><noscript><p>y</p></noscript></body>\n</html>\n', '<html>\n<head></head>\n<body><noscript><p>z</p></noscript></body>\n</html>\n'];
  const bonsai = { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({ question: 'help?' }), generateText: async () => ({ text: versions[n++ % versions.length]!, finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }) };
  const result = await new Runner({ ...defaults, ledger: true, allowWrite: true, allowBash: true, maxSteps: 14 }, store, jev, bonsai, root, () => {}).run(s);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.type === 'decided-verify').length, 3, `three failed runs, each after the inputs changed: ${result.entries.map(e => e.step + ':' + e.kind).join(',')}`);
  const v = result.ledger.find(d => d.kind === 'verify')!; assert.equal(v.unresolvable, true); assert.match(v.note ?? '', /set aside after 3 failed runs/);
  assert(result.entries.some(e => e.kind === 'generation_error' && /reproduces a version of the file the check already reported errors in/.test(e.text)), 'the second version is the one the build rejected first: refused, not landed');
  assert(!seen.at(-1)!.some(i => i.startsWith('verify:')), 'a verification set aside is not offered again');
});
test('Shell edits are watched for every written file, not only the recently hashed ones, and checks of different commands are not compared for regression', async t => {
  const { root, store, session: s } = await fixture(t);
  const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
  for (const f of files) await writeFile(join(root, f), `export const ${f.slice(0, -3)} = 1;\n`);
  s.writes = [...files]; s.step = 30; s.lastWriteStep = 28; s.lastCheckCommand = 'node check.mjs';
  const all = await sourceHashes(root, files);
  for (const f of files.slice(5)) s.hashes[f] = all[f]!; // the hash map holds only the last twenty
  s.lastCheck = { step: 29, ok: true, text: 'ok', summary: summarizeCheck(''), fileHashes: all, command: 'node check.mjs' };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}) }, root, () => {});
  await writeFile(join(root, 'f0.ts'), 'export const f0 = 2;\n');
  await runner.evidence(s, 'bash', { ok: true, text: '{}' }, { command: "sed -i 's/1/2/' f0.ts", purpose: 'bump' });
  assert.equal(s.writeSteps['f0.ts'], 30, 'the earliest written file is still watched'); assert.equal(s.pendingCheck, true);
  // A build's failure is no baseline for the type checker: the edit is not judged against it.
  const { session: s2 } = await fixture(t);
  s2.writes = ['a.ts']; s2.editSnapshots = { 'a.ts': '@artifact/x' }; s2.transaction = [{ key: 'k', identity: 'i', step: 3, route: 'replace_lines', paths: ['a.ts'], summary: '{}' }];
  s2.lastCheck = { step: 2, ok: false, text: 'x', summary: summarizeCheck('other.ts(1,1): error TS2322: a\nother.ts(2,1): error TS2322: b'), command: 'npm run build' };
  await runner.evidence(s2, 'bash', { ok: false, verification: true, text: JSON.stringify({ command: 'npm run typecheck', output: 'a.ts(1,1): error TS2322: new', code: 2 }) }, { command: 'npm run typecheck' });
  assert.equal(s2.autoUndo, null, 'not comparable: no rollback');
  const { session: s3 } = await fixture(t);
  s3.writes = ['a.ts']; s3.editSnapshots = { 'a.ts': '@artifact/x' }; s3.transaction = [{ key: 'k', identity: 'i', step: 3, route: 'replace_lines', paths: ['a.ts'], summary: '{}' }];
  s3.lastCheck = { step: 2, ok: true, text: 'ok', summary: summarizeCheck(''), command: 'npm run typecheck' };
  await runner.evidence(s3, 'bash', { ok: false, verification: true, text: JSON.stringify({ command: 'npm run typecheck', output: 'a.ts(1,1): error TS2322: new', code: 2 }) }, { command: 'npm run typecheck' });
  assert.notEqual(s3.autoUndo, null, 'the same command, more errors in the edited file: rolled back');
});
test('A repair prompt names the source line each error points at and the callee declared there, and a check summary reads a bundler heading and a file line', async t => {
  const { root, store, session: s } = await fixture(t);
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await writeFile(join(root, 'src', 'components', 'Header.tsx'), 'export default function Header() {\n  return <header>x</header>;\n}\n');
  const app = ['import Header from "./components/Header";', 'export function App() {', '  return (', '    <Header>', '      <span>child</span>', '    </Header>', '  );', '}', ''].join('\n');
  await writeFile(join(root, 'src', 'App.tsx'), app); s.writes = ['src/App.tsx']; s.hashes['src/App.tsx'] = hash(app); s.step = 4;
  const prompts: any[] = [];
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 'test' }), generate: async () => ({}), generateText: async (m: any) => { prompts.push(m); return { text: app.replace('<Header>\n      <span>child</span>\n    </Header>', '<Header />'), finish: 'stop' as const, meta: { ms: 1, promptTokens: 1 } }; } }, root, () => {});
  await (runner as any).rewriteRegion(s, 'src/App.tsx', ["src/App.tsx(4,5): error TS2559: Type '{ children: Element; }' has no properties in common with type 'IntrinsicAttributes'."], 'fix', 'decided-fix');
  const req = JSON.parse(prompts[0][2].content);
  assert.deepEqual(req.errorSites, [{ line: 4, text: '<Header>', callee: 'export default function Header()' }]); assert.match(req.rules.join(' '), /a component declared without props accepts neither props nor children/);
  const vite = summarizeCheck(JSON.stringify({ command: 'npm run build', output: 'error during build:\n[vite:css] Cannot apply unknown utility class `bg-brand`\nfile: /home/u/repo/src/index.css:12:3\n', code: 1 }), '/home/u/repo');
  assert.equal(vite.errors, 1); assert.deepEqual(vite.byFile['src/index.css']?.lines, [12], 'the heading introduces the line that follows, whatever it says, and the file line attributes it');
  assert.equal(summarizeCheck(JSON.stringify({ command: 'x', output: 'error during build:\n', code: 1 })).errors, 1, 'a heading nothing follows is the diagnostic');
});
