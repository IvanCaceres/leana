import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults, loadConfig } from '../src/config.js';
import { Bonsai, Jev, postJson, validateAnswers } from '../src/clients.js';
import { compact, confidentChoice, decisionState, mergeCoverage, messages, relevantFiles, repoOverview, routeQuestions } from '../src/context.js';
import { newSession, Runner, updateTasks } from '../src/runner.js';
import { samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { hash, runCommand, safePath, StaleWriteError, ToolBox } from '../src/tools.js';
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
    ? { type: 'noul', noul: id === 'complete' || id === 'supported' ? complete : .1 }
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
  assert.throws(() => validateAnswers(q, { ...valid, r: { ...valid.r, choice: 'b' } }));
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
test('Compaction preserves objective/tasks/latest evidence and enforces cooldown', async t => {
  const { session: s } = await fixture(t);
  s.step = 12; s.tasks = [{ id: 'fix', description: 'Fix bug', status: 'pending', evidence: '' }];
  s.entries = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, step: i, kind: 'read', artifact: `${i}.txt`, text: 'source', relevance: i === 1 ? .99 : .1 }));
  const q: Answers = { compact: { type: 'noul', noul: .99 } };
  assert.equal(compact(s, defaults, q), 4);
  assert(s.entries.some(e => e.id === 'e1')); assert(s.entries.some(e => e.id === 'e9'));
  assert.equal(s.tasks[0]?.status, 'pending'); assert(s.objective.includes('Fix'));
  s.entries.push(...[10, 11].map(i => ({ id: `e${i}`, step: i, kind: 'read', artifact: '', text: 'fresh', relevance: .5 })));
  assert.equal(compact(s, defaults, q), 0);
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
  assert.deepEqual(state.files, ['test/behavior.test.mjs']); assert.equal(state.fileCount, 3); assert.equal(state.phase, 'inspect');
  s.phase = 'implement'; s.inspectionCount = 3;
  route = routeQuestions(s, { ...defaults, allowWrite: true, allowBash: true }).route!;
  assert(route.type === 'choice'); assert('write' in route.criteria); assert(!('bash' in route.criteria));
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
  assert(route.type === 'choice'); assert(!('write' in route.criteria)); assert(!('bash' in route.criteria)); assert('read_files' in route.criteria); assert('search_codebase' in route.criteria);
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
  assert.throws(() => validate(schemas.bash, { command: 'x'.repeat(2001), purpose: 'test' }), /string length/);
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
  await assert.rejects(tools.execute('read_files', { files: [{ path: 'a.ts', start: 1, end: 300 }] }));
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
  const result = await new Runner(defaults, store, { decide: async (_s, q) => answersFor(q, 'read_files') }, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.equal(result.step, 3); assert.match(result.stopReason, /Repeated/);
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
  assert.equal(result.status, 'complete'); assert.equal(result.entries.length, 0);
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
test('A successful write marks earlier reads of that file as superseded without dropping other evidence', async t => {
  const { root, store, session: s } = await fixture(t);
  const runner = new Runner({ ...defaults, allowWrite: true }, store, { decide: async () => ({}) }, { count: async () => ({ tokens: 1, mode: 't' }), generate: async () => ({}) }, root, () => {});
  s.step = 1; await runner.evidence(s, 'read_files', { ok: true, text: 'src/a.ts sha256=abc totalLines=1 shown=1..1\n1: one' });
  s.step = 2; await runner.evidence(s, 'read_files', { ok: true, text: 'src/b.ts sha256=def totalLines=1 shown=1..1\n1: two\n\nsrc/a.ts sha256=abc totalLines=1 shown=1..1\n1: one' });
  s.step = 3; await runner.evidence(s, 'read_files', { ok: true, text: 'src/c.ts sha256=ghi totalLines=1 shown=1..1\n1: three' });
  s.step = 4; await runner.evidence(s, 'write', { ok: true, changed: ['src/a.ts'], text: 'Updated src/a.ts; sha256=new' });
  assert.match(s.entries[0]!.text, /^\[superseded by the edit at step 4; re-read src\/a\.ts/); assert.equal(s.entries[0]!.relevance, .2);
  assert.match(s.entries[1]!.text, /^\[superseded/);
  assert.match(s.entries[2]!.text, /^src\/c\.ts/); assert.equal(s.entries[2]!.relevance, .5);
  assert.equal(s.entries.length, 4);
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
  assert.deepEqual(offered[0]!.sort(), ['ask_user', 'bash', 'finish', 'move_lines', 'read_files', 'write']);
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
  assert.equal(offered.length, 3); assert(!offered[2]!.includes('write')); assert(offered[2]!.includes('read_files'));
  assert.equal(result.lastWriteStale, true);
});
test('The second identical action and result warns both models before the third pauses', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'same.txt'), 'unchanged');
  const seen: (string | null)[] = []; const prompts: string[] = [];
  const bonsai = { count: async () => ({ tokens: 100, mode: 'test' }),
    generate: async (m: any) => { prompts.push(JSON.stringify(m)); return { files: [{ path: 'same.txt', start: 1, end: 1 }] }; } };
  const jev = { decide: async (state: any, q: Questions) => { seen.push(state.lastError); return answersFor(q, 'read_files'); } };
  const result = await new Runner(defaults, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(result.status, 'paused'); assert.equal(result.step, 3);
  assert.deepEqual(seen.map(e => e === null ? null : /repeated an identical read_files action/.test(e)), [null, null, true]);
  assert.match(prompts[2]!, /A third identical repetition pauses the session/);
});
test('Finish with insufficient completion evidence re-routes without finish instead of pausing', async t => {
  const { root, store, session } = await fixture(t);
  await writeFile(join(root, 'README.md'), 'Hello');
  session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; session.step = 1;
  const calls: { phase: string; criteria: string[]; state: any }[] = [];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    calls.push({ phase: ctx!.phase, criteria: Object.keys((q.route as any).criteria), state });
    return answersFor(q, ctx!.phase === 'routing-without-finish' ? 'read_files' : 'finish', .4);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ files: [{ path: 'README.md', start: 1, end: 1 }] }) };
  const result = await new Runner({ ...defaults, maxSteps: 1 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(calls.length, 2); assert(calls[0]!.criteria.includes('finish')); assert(!calls[1]!.criteria.includes('finish'));
  assert.equal(calls[1]!.phase, 'routing-without-finish'); assert.match(calls[1]!.state.finishWithheld, /0\.4 is below 0\.9/);
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /step limit/); assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.kind, 'read_files'); assert.equal(result.phase, 'implement');
});

test('A completion summary unsupported by tool evidence is rejected and the loop continues; a second rejection pauses', async t => {
  const { root, store, session } = await fixture(t);
  session.phase = 'verify'; session.lastCheckStep = 1; session.lastWriteStep = -1; session.step = 1; session.writes = ['deps.ts'];
  const checks: any[] = [];
  const jev = { decide: async (state: any, q: Questions, ctx?: { phase: string }) => {
    if (ctx!.phase === 'completion-check') { checks.push({ state, q }); return { supported: { type: 'noul', noul: .2 } } as Answers; }
    return answersFor(q, 'finish', .99);
  } };
  const bonsai = { count: async () => ({ tokens: 10, mode: 'test' }), generate: async () => ({ summary: 'Imported deps from cli.ts and verified.' }) };
  const result = await new Runner({ ...defaults, maxSteps: 5 }, store, jev, bonsai, root, () => {}).run(session);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].state.proposedSummary, 'Imported deps from cli.ts and verified.'); assert.match(checks[0].state.tasks, /worker claims/);
  assert.deepEqual(checks[0].state.changedFiles, ['deps.ts']); assert.equal(typeof checks[0].q.supported.instructions, 'string');
  assert.equal(result.status, 'paused'); assert.match(result.stopReason, /not supported by tool evidence twice/);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0]!.kind, 'finish_rejected');
  assert.match(result.lastError!, /Completion rejected.*P\(supported\)=0\.2/);
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

test('move_lines cuts a range into a new or existing file with hash checks and no retyping', async t => {
  const { root, store } = await fixture(t);
  const source = ['import a from "a";', 'const keep = 1;', 'interface Deps {', '  x: number;', '}', 'const DEFAULTS: Deps = {', '  x: 1,', '};', 'export { keep };', ''].join('\n');
  await writeFile(join(root, 'cli.ts'), source);
  const tools = new ToolBox(root, store.artifacts, { ...defaults, allowWrite: true });
  const base = { source: 'cli.ts', expectedHash: hash(source), start: 3, end: 8, destination: 'cli/deps.ts', destinationHash: 'new', replacement: 'import { DEFAULTS, type Deps } from "./cli/deps.js";', prefix: 'import type { X } from "../x.js";' };
  await assert.rejects(tools.execute('move_lines', { ...base, expectedHash: hash('other') }), (e: any) => e instanceof StaleWriteError);
  await assert.rejects(tools.execute('move_lines', { ...base, end: 40 }), /exceeds cli.ts/);
  await assert.rejects(tools.execute('move_lines', { ...base, destination: 'cli.ts' }), /must differ/);
  await assert.rejects(tools.execute('move_lines', { ...base, destinationHash: hash('x') }), (e: any) => e instanceof StaleWriteError && /destinationHash=new/.test(e.message));
  const moved = await tools.execute('move_lines', base);
  assert.deepEqual(moved.changed, ['cli.ts', 'cli/deps.ts']);
  const remaining = await readFile(join(root, 'cli.ts'), 'utf8');
  assert.equal(remaining, ['import a from "a";', 'const keep = 1;', 'import { DEFAULTS, type Deps } from "./cli/deps.js";', 'export { keep };', ''].join('\n'));
  const created = await readFile(join(root, 'cli/deps.ts'), 'utf8');
  assert.equal(created, ['import type { X } from "../x.js";', 'interface Deps {', '  x: number;', '}', 'const DEFAULTS: Deps = {', '  x: 1,', '};', ''].join('\n'));
  assert(moved.text.includes(`cli.ts sha256=${hash(remaining)} totalLines=5`)); assert(moved.text.includes(`cli/deps.ts sha256=${hash(created)}`));
  await assert.rejects(tools.execute('move_lines', { ...base, expectedHash: hash(remaining), start: 2, end: 2 }), (e: any) => e instanceof StaleWriteError && /exists/.test(e.message));
  const appended = await tools.execute('move_lines', { ...base, expectedHash: hash(remaining), destinationHash: hash(created), start: 2, end: 2, replacement: '', prefix: 'ignored for existing files' });
  assert.equal(await readFile(join(root, 'cli.ts'), 'utf8'), ['import a from "a";', 'import { DEFAULTS, type Deps } from "./cli/deps.js";', 'export { keep };', ''].join('\n'));
  assert.equal(await readFile(join(root, 'cli/deps.ts'), 'utf8'), `${created}\nconst keep = 1;\n`);
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
  assert.equal(state.fileCount, s.knownFiles.length); assert(!('knownFiles' in state));
  const prompt = JSON.parse(messages(s, 'read_files')[1]!.content);
  assert.deepEqual(prompt.readCoverage, state.readCoverage); assert.equal(prompt.files.length, files.length); assert(!('knownFiles' in prompt));
  assert(Buffer.byteLength(messages(s, 'read_files')[1]!.content) < 6000);
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
  assert.match(s.entries[0]!.text, /^\[superseded by the edit at step 4/);
});
