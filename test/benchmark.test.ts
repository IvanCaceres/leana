import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { prepareBenchmark, referenceRefactor, fixtureHash, fixtureFiles } from '../src/benchmark-fixture.js';
import { verifyBenchmark } from '../src/benchmark-verify.js';
import { comparisonMarkdown, summarizeEvents } from '../src/benchmark-metrics.js';
import { runCommand } from '../src/tools.js';
import { Jev } from '../src/clients.js';
import { Store } from '../src/store.js';
import { defaults } from '../src/config.js';

async function fixture(t: any) {
  const parent = await mkdtemp(join(tmpdir(), 'leana-refactor-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return prepareBenchmark(parent, 'test');
}
async function installReference(repo: string) {
  for (const [path, content] of Object.entries(referenceRefactor())) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
}
test('Refactor fixture starts behaviorally correct but fails the required architecture', async t => {
  const { repo, runDir } = await fixture(t);
  const baseline = await runCommand(process.execPath, ['--test', 'test/behavior.test.mjs'], repo, 30000);
  assert.equal(baseline.code, 0, baseline.output);
  const result = await verifyBenchmark(runDir);
  assert.equal(result.behaviorPassed, true);
  assert.equal(result.architecturePassed, false);
  assert.equal(result.passed, false);
});
test('Reference refactor passes behavior, real shared-layer invocation, and integrity checks', async t => {
  const { repo, runDir } = await fixture(t);
  await installReference(repo);
  const result = await verifyBenchmark(runDir);
  if (!result.passed) {
    assert.fail(JSON.stringify(result) + '\n' + await readFile(join(runDir, 'behavior-verification.txt'), 'utf8') + '\n' + await readFile(join(runDir, 'architecture-verification.txt'), 'utf8'));
  }
  assert.equal(result.changedFiles.length, 6);
});
test('Reading pricing fields from the shared invoice is not an input-access violation', async t => {
  const { repo, runDir } = await fixture(t);
  await installReference(repo);
  const path = join(repo, 'src/channels/quotation.mjs');
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace('...invoice,', 'orderId: invoice.orderId, customer: invoice.customer, issuedAt: invoice.issuedAt, lines: invoice.lines, subtotalCents: invoice.subtotalCents, discountCents: invoice.discountCents, shippingCents: invoice.shippingCents, taxCents: invoice.taxCents, totalCents: invoice.totalCents,'));
  const result = await verifyBenchmark(runDir);
  assert.equal(result.behaviorPassed, true);
  assert.equal(result.architecturePassed, true, JSON.stringify(result.violations));
});
test('Unused shared modules cannot satisfy the refactor verifier', async t => {
  const { repo, runDir } = await fixture(t);
  await installReference(repo);
  for (const c of ['checkout', 'renewal', 'quotation'])
    await writeFile(join(repo, `src/channels/${c}.mjs`), fixtureFiles()[`src/channels/${c}.mjs`]!);
  const result = await verifyBenchmark(runDir);
  assert.equal(result.behaviorPassed, true);
  assert.equal(result.architecturePassed, false);
  assert(result.violations.length > 0);
});
test('Behavior regressions and test edits fail even after successful extraction', async t => {
  const { repo, runDir } = await fixture(t);
  await installReference(repo);
  const path = join(repo, 'src/domain/price-order.mjs');
  await writeFile(path, (await readFile(path, 'utf8')).replace('Math.round(subtotalCents', 'Math.floor(subtotalCents'));
  await writeFile(join(repo, 'test/behavior.test.mjs'), '// removed tests\n');
  const result = await verifyBenchmark(runDir);
  assert.equal(result.behaviorPassed, false);
  assert.equal(result.protectedFilesUnchanged, false);
  assert.equal(result.passed, false);
});
test('Fixture hashes are stable and comparison rejects incompatible tasks', () => {
  assert.equal(fixtureHash(), fixtureHash(Object.fromEntries(Object.entries(fixtureFiles()).reverse())));
  const report = { version: 'v1', fixtureHash: 'same', promptHash: 'task', label: 'cline', verification: { passed: true }, agentCompleted: null, wallSeconds: null, metrics: null };
  assert.match(comparisonMarkdown([report, { ...report, label: 'leana' }]), /unknown/);
  assert.throws(() => comparisonMarkdown([report, { ...report, promptHash: 'different' }]), /Cannot compare/);
});
test('Metrics count compaction causes, repeated requests, usage and distinct provider calls', () => {
  const event = (type: string, data: any) => ({ at: '2026-09-19T00:00:00Z', type, data });
  const m = summarizeEvents([
    event('jev-request', { questions: { route: {}, complete: {} } }),
    event('jev', { requestId: 'j1', ms: 200, usage: { input_tokens: 100, output_tokens: 10 } }),
    event('bonsai-request', {}), event('bonsai', { requestId: 'b1', ms: 1000, usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200 } } }),
    event('bonsai-error', { requestId: 'b1', ms: 1001 }),
    event('action', { route: 'read_files', args: { start: 1, path: 'a' } }),
    event('action', { route: 'read_files', args: { path: 'a', start: 1 } }),
    event('compact', { reason: 'jev', removed: 5 }), event('compact', { reason: 'entry-cap', removed: 1 }),
  ]);
  assert.equal(m.jevQuestionCount, 2); assert.equal(m.bonsaiLatency.count, 1);
  assert.equal(m.bonsaiPromptTokens, 1000); assert.equal(m.bonsaiCachedPromptTokens, 200);
  assert.equal(m.repeatedReadRequests, 1); assert.equal(m.evictedEntries, 6);
});
test('Every Jev question, choices, state, answer and error is readable without credentials', async t => {
  const { runDir } = await fixture(t);
  const store = new Store(join(runDir, 'log-test')); await store.init();
  let fail = false;
  const server = createServer((_req, res) => {
    if (fail) { res.statusCode = 401; res.end('{}'); }
    else res.end(JSON.stringify({ model: 'jev-test', answers: {
      route: { type: 'choice', choice: 'read', probabilities: { read: .9, write: .1 }, confidence: .8 },
      compact: { type: 'noul', noul: .7 },
    }, usage: { input_tokens: 10, output_tokens: 4 } }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r)); t.after(() => server.close());
  const jev = new Jev({ ...defaults, jevUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/systemone` }, 'secret-test-token', store.log.bind(store));
  const q = { route: { type: 'choice' as const, instructions: 'Which action advances the task?', criteria: { read: 'Read source', write: 'Edit source' } }, compact: { type: 'noul' as const, instructions: 'Is old evidence redundant?' } };
  await jev.decide({ objective: 'extract pricing' }, q, { step: 3, phase: 'routing-and-context' });
  fail = true; await assert.rejects(jev.decide({ objective: 'extract pricing' }, q, { step: 4, phase: 'routing-and-context' }));
  const text = await readFile(join(store.path, 'jev-decisions.md'), 'utf8');
  for (const expected of ['Step 3', 'Which action advances the task?', 'read: Read source', 'extract pricing', 'selected read', 'P(yes) = 0.7', 'HTTP 401']) assert(text.includes(expected));
  assert(!text.includes('secret-test-token'));
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.type), ['jev-request', 'jev', 'jev-request', 'jev-error']);
  assert.equal(events[0].data.requestId, events[1].data.requestId);
});
