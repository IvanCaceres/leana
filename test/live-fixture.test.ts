import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, verifyFixture } from '../src/live-test.js';
import { runCommand } from '../src/commands.js';

async function fixture(t: any) {
  const parent = await mkdtemp(join(tmpdir(), 'leana-live-fixture-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return createFixture(parent);
}
test('Live fixture starts failing and independent verifier rejects the bug', async t => {
  const { repo, runDir } = await fixture(t);
  const baseline = await runCommand(process.execPath, ['--test', 'test/cart.test.mjs'], repo, 15000);
  assert.equal(baseline.code, 1);
  assert.match(baseline.output, /multiple units of one product/);
  assert.equal((await verifyFixture(runDir)).passed, false);
});
test('Independent live verifier accepts the real fix and creates verification output', async t => {
  const { repo, runDir } = await fixture(t);
  const path = join(repo, 'src/cart.mjs');
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace('total + item.priceCents', 'total + item.priceCents * item.quantity'),
  );
  const result = await verifyFixture(runDir);
  assert.equal(result.passed, true);
  assert.equal(result.testsUnchanged, true);
  assert.match(await readFile(join(runDir, 'verification.txt'), 'utf8'), /additional deterministic combinations/);
});
test('Replacing visible tests with passing assertions cannot pass independent validation', async t => {
  const { repo, runDir } = await fixture(t);
  await writeFile(join(repo, 'test/cart.test.mjs'), 'import assert from "node:assert/strict"; assert.ok(true);');
  const result = await verifyFixture(runDir);
  assert.equal(result.passed, false);
  assert.equal(result.testsUnchanged, false);
});
