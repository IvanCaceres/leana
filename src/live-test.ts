#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readKey } from './cli.js';
import { runCommand } from './tools.js';

const source = `export function calculateSubtotal(items) {
  return items.reduce((total, item) => total + item.priceCents, 0);
}
`;
const cases = [
  { name: 'empty cart', items: [], expected: 0 },
  { name: 'multiple units of one product', items: [{ priceCents: 1250, quantity: 3 }], expected: 3750 },
  { name: 'multiple products', items: [{ priceCents: 499, quantity: 2 }, { priceCents: 250, quantity: 3 }], expected: 1748 },
  { name: 'zero quantity', items: [{ priceCents: 999, quantity: 0 }], expected: 0 },
  { name: 'free products', items: [{ priceCents: 0, quantity: 8 }, { priceCents: 200, quantity: 2 }], expected: 400 },
];
function testSource(moduleUrl: string, independent: boolean): string {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSubtotal } from ${JSON.stringify(moduleUrl)};
const cases = ${JSON.stringify(cases)};
for (const c of cases) test(c.name, () => assert.equal(calculateSubtotal(c.items), c.expected));
${independent ? `test('additional deterministic combinations', () => {
  for (let i = 0; i < 60; i++) {
    const a = { priceCents: i * 137, quantity: i % 7 };
    const b = { priceCents: 1999 - i * 3, quantity: (i + 2) % 5 };
    assert.equal(calculateSubtotal([a, b]), a.priceCents * a.quantity + b.priceCents * b.quantity);
  }
});` : ''}
`;
}
export const visibleTests = testSource('../src/cart.mjs', false);
export async function snapshotFiles(repo: string): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.leana', '.git', 'node_modules'].includes(entry.name)) continue;
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${name}/`);
      else if (entry.isSymbolicLink()) files[name] = `Symlink -> ${await readlink(path)}\n`;
      else if (entry.isFile()) files[name] = await readFile(path, 'utf8');
    }
  }
  await visit(repo);
  return files;
}
export function fileDiff(before: Record<string, string>, after: Record<string, string>): string {
  const output: string[] = [];
  const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const emit = (prefix: string, line: string) => {
    output.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line));
    if (!line.endsWith('\n')) output.push('\\ No newline at end of file');
  };
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (before[name] === after[name]) continue;
    const oldLines = lines(before[name] ?? '');
    const newLines = lines(after[name] ?? '');
    let prefix = 0;
    while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
    const start = Math.max(0, prefix - 3);
    const tail = Math.min(3, suffix);
    const oldEnd = oldLines.length - suffix;
    const newEnd = newLines.length - suffix;
    const oldCount = oldEnd + tail - start;
    const newCount = newEnd + tail - start;
    output.push(`--- ${Object.hasOwn(before, name) ? `a/${name}` : '/dev/null'}`,
      `+++ ${Object.hasOwn(after, name) ? `b/${name}` : '/dev/null'}`,
      `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@`);
    for (let i = start; i < prefix; i++) emit(' ', oldLines[i]!);
    for (let i = prefix; i < oldEnd; i++) emit('-', oldLines[i]!);
    for (let i = prefix; i < newEnd; i++) emit('+', newLines[i]!);
    for (let i = oldEnd; i < oldEnd + tail; i++) emit(' ', oldLines[i]!);
  }
  return output.length ? output.join('\n') + '\n' : '';
}
export async function createFixture(parent: string): Promise<{ runDir: string; repo: string }> {
  await mkdir(parent, { recursive: true });
  const runDir = await mkdtemp(join(parent, 'cart-'));
  const repo = join(runDir, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'test'));
  await writeFile(join(repo, 'src/cart.mjs'), source);
  await writeFile(join(repo, 'test/cart.test.mjs'), visibleTests);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'leana-live-cart-fixture', private: true, type: 'module', scripts: { test: 'node --test test/cart.test.mjs' } }, null, 2) + '\n');
  await writeFile(join(repo, 'README.md'), '# Cart subtotal\n\ncalculateSubtotal(items) must sum priceCents * quantity for every item. Empty carts return 0. Inputs are nonnegative integer cents and quantities. Run node --test test/cart.test.mjs.\n');
  await writeFile(join(repo, 'AGENTS.md'), 'Only edit src/cart.mjs. Preserve the export and fix the implementation, not the tests. No dependencies are needed. Verify with node --test test/cart.test.mjs.\n');
  return { runDir, repo };
}
export async function verifyFixture(runDir: string): Promise<{ passed: boolean; implementationChanged: boolean; testsUnchanged: boolean; exitCode: number | null }> {
  const repo = join(runDir, 'repo');
  // Created AFTER the agent exits, from trusted in-memory test definitions outside its repository.
  const verifier = join(runDir, 'independent-verification.test.mjs');
  await writeFile(verifier, testSource(pathToFileURL(join(repo, 'src/cart.mjs')).href, true));
  const result = await runCommand(process.execPath, ['--test', verifier], runDir, 15000);
  await writeFile(join(runDir, 'verification.txt'), result.output);
  const testsUnchanged = await readFile(join(repo, 'test/cart.test.mjs'), 'utf8').then(s => s === visibleTests, () => false);
  const implementationChanged = await readFile(join(repo, 'src/cart.mjs'), 'utf8').then(s => s !== source, () => false);
  return { passed: result.code === 0 && !result.timedOut && !result.truncated && testsUnchanged && implementationChanged,
    implementationChanged, testsUnchanged, exitCode: result.code };
}
async function invokeAgent(args: string[]): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => resolveCode(code ?? 1));
  });
}
async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: {
    'key-file': { type: 'string' }, 'env-file': { type: 'string' }, config: { type: 'string' },
    'max-steps': { type: 'string', default: '16' }, 'prepare-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) {
    console.log('npm run test:live -- --key-file ~/jumanji.txt\n\nCreates a fresh cart bug fixture, calls real Jev and Bonsai, and verifies the fix independently.\nOptions: --env-file PATH, --config PATH, --max-steps N, --prepare-only\n--prepare-only creates the fixture and demonstrates failing tests without calling either API.\nRuns are retained in work/live-tests/ under the Leana project.');
    return;
  }
  if (!v['prepare-only']) {
    if (v['env-file']) process.loadEnvFile(resolve(v['env-file']));
    if (v['key-file']) await readKey(v['key-file']);
    else if (!process.env.TYPESAFE_API_KEY) throw new Error('Provide --key-file PATH or TYPESAFE_API_KEY');
    const rg = await runCommand('rg', ['--version'], process.cwd(), 5000);
    if (rg.code !== 0) throw new Error('ripgrep is required');
  }
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const { runDir, repo } = await createFixture(join(projectRoot, 'work/live-tests'));
  const before = await snapshotFiles(repo);
  await writeFile(join(runDir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
  console.log(`\nLive coding test: cart subtotal\nDisposable repository: ${repo}\n`);
  const baseline = await runCommand(process.execPath, ['--test', 'test/cart.test.mjs'], repo, 15000);
  await writeFile(join(runDir, 'baseline.txt'), baseline.output);
  if (baseline.code !== 1 || baseline.timedOut || baseline.truncated) throw new Error(`Unexpected baseline result; inspect ${join(runDir, 'baseline.txt')}`);
  console.log('BEFORE: failing tests reproduced (expected).');
  if (v['prepare-only']) { console.log(`Fixture ready. No API requests made.\nBaseline: ${join(runDir, 'baseline.txt')}`); return; }
  const task = 'Fix calculateSubtotal in src/cart.mjs to sum priceCents * quantity for every item, including empty carts, zero quantities, and free items. Read the implementation and test/cart.test.mjs. Only modify src/cart.mjs; do not modify tests or add dependencies. Run node --test test/cart.test.mjs and report the actual result. This small fix does not need a task ledger.';
  const args = ['run', task, '--repo', repo, '--allow-write', '--allow-bash', '--max-steps', v['max-steps']!];
  for (const flag of ['key-file', 'env-file', 'config'] as const) if (v[flag]) args.push(`--${flag}`, resolve(v[flag]!.replace(/^~(?=\/)/, process.env.HOME ?? '')));
  console.log('Running real Jev + Bonsai with edits and shell enabled for this fixture.\n');
  const started = performance.now();
  const agentExitCode = await invokeAgent(args);
  const after = await snapshotFiles(repo);
  await writeFile(join(runDir, 'after.json'), JSON.stringify(after, null, 2) + '\n');
  const diff = fileDiff(before, after);
  const diffPath = join(runDir, 'changes.diff');
  await writeFile(diffPath, diff);
  console.log('\nFile changes (− before, + after):\n');
  process.stdout.write(diff || '(No fixture files changed.)\n');
  const verification = await verifyFixture(runDir);
  const runNames = await readdir(join(repo, '.leana/runs')).catch(() => [] as string[]);
  const sessionPath = runNames[0] ? join(repo, '.leana/runs', runNames[0]) : null;
  const events = sessionPath ? await readFile(join(sessionPath, 'events.jsonl'), 'utf8').then(s => s.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []) : [];
  const jevCalls = events.filter(e => e.type === 'jev').length;
  const bonsaiCalls = events.filter(e => e.type === 'bonsai').length;
  const passed = agentExitCode === 0 && verification.passed && jevCalls > 0 && bonsaiCalls > 0;
  const report = { passed, agentExitCode, verification, jevCalls, bonsaiCalls, diffPath,
    actions: events.filter(e => e.type === 'action').map(e => e.data.route),
    durationSeconds: Math.round((performance.now() - started) / 100) / 10, sessionPath };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${passed ? 'PASS' : 'FAIL'}: live coding test`);
  console.log(`Independent verification: ${verification.passed ? 'passed' : 'failed'}; original tests ${verification.testsUnchanged ? 'unchanged' : 'modified or missing'}.`);
  console.log(`Live requests: ${jevCalls} Jev, ${bonsaiCalls} Bonsai.\nResults: ${join(runDir, 'result.json')}\nDiff: ${diffPath}\nVerification output: ${join(runDir, 'verification.txt')}`);
  if (agentExitCode === 2) console.log('The agent paused. Its session and reason are retained above; this run is not counted as a pass.');
  process.exitCode = passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => { console.error(`Live test: ${(e as Error).message}`); process.exitCode = 1; });
