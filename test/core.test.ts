import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults as baseDefaults, loadConfig } from '../src/config.js';
// The onset ledger makes a generation the older call-order stubs do not expect; tests enable it explicitly.
const defaults = { ...baseDefaults, ledger: false };
import { Bonsai, Jev, postJson, validateAnswers } from '../src/clients.js';
import { compactNames, confidentChoice, decisionState, evictOne, mergeCoverage, messages, promptFields, relevantFiles, repoOverview, checkDelta, routeDescriptions, routeQuestions, staleFor } from '../src/context.js';
import { newSession, Runner, updateTasks } from '../src/runner.js';
import { referenceContext, rememberReferences, scopes } from '../src/references.js';
import { anchorPath, candidatesFrom, completionQuestions, diffChunks, ledgerQuestions, ledgerSchema, refreshLedger, structuralDiff } from '../src/ledger.js';
import { dirtySessionConflict } from '../src/cli.js';
import { samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { collectSteps, renderReport, speed } from '../src/report.js';
import { Display, describe, generationSpeed } from '../src/display.js';
import { movePlan, namedIdentifiers, removeImportBindings, checkAdvice, assertBalancePreserved, completionSource, hash, importInsertLine, runCommand, safePath, sourceHashes, StaleWriteError, stripLiterals, ToolBox, summarizeCheck, resolveMissingNames, syntaxErrors, regression, assertNoBulkDuplication } from '../src/tools.js';
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
test('llama grammar compatibility keeps runtime string limits intact', () => {
  const wire = samplingSchema(schemas.bash);
  assert.equal(wire.properties?.command?.maxLength, undefined);
  assert.equal(schemas.bash.properties?.command?.maxLength, 2000);
  assert.throws(() => validate(schemas.bash, { command: 'x'.repeat(2001), purpose: 'test' }), /string length 2001 exceeds the maximum 2000; shorten this field/);
  validate(schemas.move_lines, { source: 'a', expectedHash: 'h', start: 1, end: 2, destination: 'b', destinationHash: 'new', replacement: '', prefix: 'import x;\n'.repeat(700) });
  assert.throws(() => validate(schemas.move_lines, { source: 'a', expectedHash: 'h', start: 1, end: 2, destination: 'b', destinationHash: 'new', replacement: '', prefix: 'x'.repeat(16001) }), /args.prefix: string length 16001 exceeds/);
});
test('Filesystem boundary rejects traversal, secrets and escaping symlinks', async t => {
  const { root } = await fixture(t);
  await symlink(tmpdir(), join(root, 'outside'));
  await assert.rejects(safePath(root, '../escape', true));
  await assert.rejects(safePath(root, 'outside/new', true));
  await assert.rejects(safePath(root, '.env'));
  await assert.rejects(safePath(root, '.git/config'));
});
test('Writes enforce capability, exact hash, unique match and new-file semantics', async t => {
  const { root, store } = await fixture(t);
  const path = join(root, 'a.ts'); await writeFile(path, 'one\ntwo\n');
  const args = { path: 'a.ts', expectedHash: hash('one\ntwo\n'), oldText: 'two', newText: 'three' };
  await assert.rejects(new ToolBox(root, store.artifacts, defaults).execute('write', args));
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  assert((await tools.execute('write', args)).ok); assert.equal(await readFile(path, 'utf8'), 'one\nthree\n');
  await assert.rejects(tools.execute('write', { ...args, expectedHash: 'new', oldText: '' }), /only valid for a new file/);
  await assert.rejects(tools.execute('write', { ...args, expectedHash: hash('one\nthree\n'), oldText: 'three', newText: 'three' }), /no change/);
  await assert.rejects(tools.execute('write', args), /Stale/);
  await assert.rejects(tools.execute('write', { ...args, expectedHash: hash('one\nthree\n'), oldText: '\n' }), /exactly once/);
  await assert.rejects(tools.execute('write', { path: 'nested/', expectedHash: 'new', oldText: '', newText: 'bad' }), /regular file path/);
  await tools.execute('write', { path: 'nested/new.ts', expectedHash: 'new', oldText: '', newText: 'new' });
  assert.equal(await readFile(join(root, 'nested/new.ts'), 'utf8'), 'new');
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
  const c = { ...defaults, workingTokens: 2000, maxSteps: 1 };
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
  assert.deepEqual(offered[0]!.sort(), ['ask_user', 'bash', 'finish', 'move_lines', 'read_files', 'replace_lines', 'write']);
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
    else { assert(q.objective_met); assert(q.out_of_scope); }
    return answersFor(q, 'finish');
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async (_m: unknown, schema: unknown) => {
    assert.equal(schema, schemas.finish); return { summary: 'Verified the requested work.' };
  } };
  const result = await new Runner({ ...defaults, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.deepEqual(calls.map(c => c.phase), ['routing-and-context', 'completion-check']);
  assert(calls[1]!.state.diff, 'the audit sees the structural diff');
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
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => selected === 'read_files'
    ? { files: [{ path: 'value.mjs', start: 1, end: 10 }] }
    : selected === 'write' ? { path: 'value.mjs', expectedHash: s.hashes['value.mjs'], oldText: 'value = 1', newText: 'value = 2' }
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
test('After three edits without a check, edit routes are withheld until a verification runs', async t => {
  const { session: s } = await fixture(t);
  const c = { ...defaults, allowWrite: true, allowBash: true };
  s.phase = 'implement'; s.inspectionCount = 3; s.writes = ['a.ts']; s.editsSinceCheck = 3;
  let route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert(!('write' in route.criteria)); assert(!('replace_lines' in route.criteria)); assert(!('move_lines' in route.criteria));
  assert.match(route.criteria.bash!, /Three edits/); assert('read_files' in route.criteria);
  s.editsSinceCheck = 2;
  route = routeQuestions(s, c).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria);
  s.editsSinceCheck = 3;
  route = routeQuestions(s, { ...c, allowBash: false }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria);
  const { root, store } = await fixture(t);
  const runner = new Runner(c, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 9; await runner.evidence(s, 'bash', { ok: false, verification: true, text: 'failed' });
  assert.equal(s.editsSinceCheck, 0);
  s.step = 10; await runner.evidence(s, 'write', { ok: true, changed: ['a.ts'], text: 'Updated' });
  assert.equal(s.editsSinceCheck, 1);
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
  assert.deepEqual(s.byFile['src/cli.ts'], { count: 2, syntax: 2, resolution: 0, lines: [3832, 3839], samples: ["src/cli.ts(3832,1): error TS1005: ':' expected.", 'src/cli.ts(3839,17): error TS1109: Expression expected.'] });
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
  assert(html.includes('"predicted_per_second":35.5')); assert(html.includes('implementation worker in Leana')); assert(html.includes('"instructions":"Choose ONE valid next action'));
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
  const grouped = { addImports: { 'b.ts': ['import { z } from "./z.js";'] }, addExportAtLines: {}, removeImports: {}, removeImportLines: {}, moveDeclarations: [], unresolved: [], total: 1 };
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
  assert.equal(last[0], 'phase'); assert.deepEqual(last.slice(-3), ['selectedAction', 'actionInstructions', 'argumentSchema']);
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

test('When edits are withheld pending verification, bash re-runs the last check command without generation', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'check.mjs'), "console.error('a.ts(1,1): error TS2304: Cannot find name x.'); process.exit(1);\n");
  session.phase = 'implement'; session.inspectionCount = 3; session.writes = ['a.ts']; session.editsSinceCheck = 3; session.lastCheckCommand = 'node check.mjs';
  let generated = 0;
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => { generated++; return { command: 'grep -n x a.ts', purpose: 'look' }; } };
  const offered: string[][] = [];
  const jev = { decide: async (_s: unknown, q: Questions) => { offered.push(Object.keys((q.route as any).criteria)); return answersFor(q, 'bash', .1); } };
  const result = await new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(generated, 0); assert(!offered[0]!.includes('replace_lines'));
  assert.equal(result.entries[0]!.kind, 'bash'); assert.match(result.entries[0]!.text, /node check\.mjs/); assert.equal(result.editsSinceCheck, 0); assert.equal(result.lastCheck!.step, 1);
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert(events.some(e => e.type === 'auto-check' && e.data.command === 'node check.mjs'));
  assert(!events.some(e => e.type === 'prompt'), 'no worker prompt was built for the automatic check');
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
  assert.equal(state.missingNames.total, 40); assert(Object.values(state.missingNames.addImports).flat().length <= 36); assert.deepEqual(Object.keys(state.missingNames), ['addImports', 'addExportAtLines', 'removeImports', 'removeImportLines', 'moveDeclarations', 'unresolved', 'total']);
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
  const f = (count: number, syntax = 0) => ({ count, syntax, lines: [], samples: [] });
  const before = sum(210, 0, { 'src/a.ts': f(10), 'tests/t.ts': f(200) }); const after = sum(162, 0, { 'src/a.ts': f(12), 'tests/t.ts': f(150) });
  assert.equal(regression(before, after, { files: ['sdk/src/a.ts'] }), 'worse', 'in-scope increase is a regression even when the total fell');
  assert.equal(regression(before, after), 'fine');
  assert.equal(regression(before, sum(159, 0, { 'src/a.ts': f(9), 'tests/t.ts': f(150) }), { files: ['sdk/src/a.ts'] }), 'fine');
});

test('Bulk duplication of existing lines is refused, small overlaps are not', async t => {
  const header = Array.from({ length: 8 }, (_, i) => `import { name${i} } from "./module${i}.js";`).join('\n');
  const before = `${header}\nconst x = 1;\n`;
  assert.throws(() => assertNoBulkDuplication(before, header.split('\n'), 'cli.ts'), /already contains the line "import \{ name0 \}/);
  assert.throws(() => assertNoBulkDuplication(before, ['import { name0 } from "./module0.js";'], 'cli.ts'), /an import or export is never added twice/);
  const body = Array.from({ length: 8 }, (_, i) => `const value${i} = compute(${i});`).join('\n');
  assert.throws(() => assertNoBulkDuplication(body, body.split('\n'), 'x.ts'), /would insert a block that x\.ts already contains/);
  assertNoBulkDuplication(body, ['const value0 = compute(0);'], 'x.ts');
  // Shared idioms scattered through a file are not a paste: only a contiguous run is.
  const idioms = ['  if (!value) return;', '  const next = await step();', '  results.push(next);', '  count += 1;', '  if (count > limit) break;'];
  const spread = idioms.flatMap(l => [l, '  // separate context']).join('\n');
  assertNoBulkDuplication(spread, idioms, 'y.ts');
  assert.throws(() => assertNoBulkDuplication(idioms.join('\n'), idioms, 'y.ts'), /already contains/);
  // A move's destination is exempt from the count rule (moved code may repeat idioms) but never gains a second import.
  assertNoBulkDuplication(idioms.join('\n'), idioms, 'deps.ts', false);
  assert.throws(() => assertNoBulkDuplication(before, ['import { name1 } from "./module1.js";'], 'deps.ts', false), /never added twice/);
  const { root, store } = await fixture(t);
  await writeFile(join(root, 'cli.ts'), before);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  await assert.rejects(tools.execute('replace_lines', { path: 'cli.ts', expectedHash: hash(before), edits: [{ start: 1, end: 1, newText: `${header}\nimport { name0 } from "./module0.js";`, prepend: '' }] }), /already contains/);
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), before);
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
test('Rolling back a transaction that created a file removes the file and forgets it', async t => {
  const { root, store, session: s } = await fixture(t);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const created = await tools.execute('write', { path: 'src/cli/deps.ts', expectedHash: 'new', oldText: '', newText: 'export const x = 1;\n' });
  assert.equal(created.snapshots?.['src/cli/deps.ts'], '@new');
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  const moved = await tools.execute('move_lines', { source: 'a.ts', expectedHash: hash('const a = 1;\n'), start: 1, end: 1, destination: 'src/cli/fresh.ts', destinationHash: 'new', prefix: '', replacement: '' });
  assert.equal(moved.snapshots?.['src/cli/fresh.ts'], '@new');
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 2; s.writes = ['src/cli/deps.ts']; s.hashes['src/cli/deps.ts'] = 'h'; s.readHashes['src/cli/deps.ts'] = 'h'; s.coverage['src/cli/deps.ts'] = { total: 1, ranges: [[1, 1]] } as any; s.writeSteps['src/cli/deps.ts'] = 2;
  s.transaction = [{ key: 'k', identity: 'i', step: 2, route: 'write', paths: ['src/cli/deps.ts'], summary: 'created' }];
  s.editEvidence = [{ step: 2, route: 'write', paths: ['src/cli/deps.ts'], artifact: '', text: 'created deps.ts' }];
  await runner.undo(s, { 'src/cli/deps.ts': '@new' }, 'worse');
  assert.deepEqual(s.editEvidence, [], 'rolled-back changes cannot support completion');
  await assert.rejects(readFile(join(root, 'src/cli/deps.ts'), 'utf8'), /ENOENT/);
  assert(!('src/cli/deps.ts' in s.hashes) && !('src/cli/deps.ts' in s.readHashes) && !('src/cli/deps.ts' in s.coverage) && !s.writes.includes('src/cli/deps.ts'));
  assert.match(s.entries.at(-1)!.text, /removed src\/cli\/deps\.ts, which those edits created/); assert.equal(s.rejectedEdits.length, 1);
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
  assert.deepEqual(facts[0]!.facts, [{ line: 1, kind: 'import', name: 'Deps', imported: 'Dependencies', from: './deps.js', typeOnly: true }]);
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
  const check = "a.ts(1,22): error TS6133: 'writeSync' is declared but its value is never read.\na.ts(4,3): error TS6133: 'planComponents' is declared but its value is never read.\na.ts(6,15): error TS6133: 'Only' is declared but its value is never read.\na.ts(8,7): error TS6133: 'unusedLocal' is declared but its value is never read.";
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
  assert.deepEqual(phases, ['routing-and-context', 'completion-check'], 'Jev routed once, the harness overrode it with finish, then the audit ran');
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

test('A write anchor longer than six lines is refused with the line number for replace_lines', async t => {
  const { root, store } = await fixture(t);
  const text = Array.from({ length: 12 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const block = text.split('\n').slice(3, 11).join('\n');
  await assert.rejects(tools.execute('write', { path: 'a.ts', expectedHash: hash(text), oldText: block, newText: `export ${block}` }), /oldText is 8 lines; a write anchor is at most 6\. That block starts at line 4: use replace_lines/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), text);
  const ok = await tools.execute('write', { path: 'a.ts', expectedHash: hash(text), oldText: 'const v4 = 4;', newText: 'export const v4 = 4;' });
  assert(ok.ok);
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
test('A large range whose new text is mostly identical is refused with the lines that differ', async t => {
  const { root, store } = await fixture(t);
  const lines = Array.from({ length: 20 }, (_, i) => `  key${i}: (signal?: AbortSignal) => run${i}(signal),`);
  const text = ['const deps = {', ...lines, '};', ''].join('\n');
  await writeFile(join(root, 'a.ts'), text);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const retyped = lines.map((l, i) => i === 4 ? '  key4: (signal: AbortSignal) => run4(signal),' : l).join('\n');
  await assert.rejects(tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(text), edits: [{ start: 2, end: 21, newText: retyped, prepend: '' }] }), /rewrites 20 lines of which only 1 change \(line 6\); edit only those lines/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), text);
  const ok = await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(text), edits: [{ start: 6, end: 6, newText: '  key4: (signal: AbortSignal) => run4(signal),', prepend: '' }] });
  assert(ok.ok);
  // A genuine rewrite (most lines change) is not a retype.
  const now = await readFile(join(root, 'a.ts'), 'utf8');
  const rewritten = lines.map((_, i) => `  key${i}: () => ${i},`).join('\n');
  assert((await tools.execute('replace_lines', { path: 'a.ts', expectedHash: hash(now), edits: [{ start: 2, end: 21, newText: rewritten, prepend: '' }] })).ok);
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
  s.ledger = candidatesFrom({ deliverables: [{ kind: 'move', name: 'K', from: 'src/a.ts', to: 'src/b.ts', detail: 'move K' }] });
  s.moveDirection = { source: 'src/b.ts', destination: 'src/a.ts' }; // a direction that forbids the harness move, so the audit is exercised
  const jev = { decide: async (_st: unknown, q: Questions, ctx?: { phase: string }) => {
    if (ctx?.phase === 'completion-check') { const a = answersFor(q, 'finish', .9) as Answers; a.implemented_d1 = { type: 'noul', noul: .2 }; return a; }
    return answersFor(q, 'finish', .9);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'K was moved.' }) };
  const runner = new Runner({ ...defaults, allowWrite: true, allowBash: true, maxSteps: 1 }, store, jev, bonsai, root, () => {});
  await runner.evidence(s, 'bash', { ok: true, check: true, verification: true, text: 'passed' }, { command: 'node --check src/a.ts' });
  const result = await runner.run(s);
  assert.equal(result.status, 'paused');
  assert.match(result.entries.at(-1)!.text, /Completion rejected \(objective met=0\.90, out-of-scope changes=0\.10\)\. Deliverables not implemented: d1 move K to src\/b\.ts \[pending: still declared in src\/a\.ts lines 1-1\]/);
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
