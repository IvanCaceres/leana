import { mkdir, readFile, writeFile, cp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { channelNames, fixtureFiles, fixtureHash, benchmarkVersion, benchmarkPrompt } from './benchmark-fixture.js';
import { snapshotFiles, fileDiff } from './live-test.js';
import { hash } from './files.js';
import { runCommand } from './commands.js';

function comparisonTests(repo: string, reference: string): string {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from ${JSON.stringify(pathToFileURL(join(repo, 'src/index.mjs')).href)};
import * as reference from ${JSON.stringify(pathToFileURL(join(reference, 'src/index.mjs')).href)};
const channels = ['checkout', 'renewal', 'quotation'];
const fixedDate = '2025-02-03T04:05:06.789Z';
let seed = 123456789;
const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
const orders = Array.from({ length: 180 }, (_, i) => ({
  id: ' order-' + i + ' ', customer: ' Customer ' + (i % 11) + ' ',
  items: Array.from({ length: 1 + random(6) }, (_, n) => ({ sku: ' sku-' + n + ' ', quantity: random(9), unitPriceCents: random(20000) })),
  discountBps: [0, 1, 3333, 5000, 9999, 10000][i % 6],
  taxBps: [0, 1, 825, 2000, 3000][i % 5], shippingCents: random(1500),
  prepaid: i % 2 === 0, cycle: [undefined, null, 0, 1, 6][i % 5],
}));
orders.push({ id: 'defaults', customer: 'customer', items: [{ sku: 'free', quantity: 0, unitPriceCents: 0 }] });
orders.push({ id: 'limits', customer: 'customer', items: [{ sku: 'max', quantity: 1000, unitPriceCents: 1000000 }], taxBps: 3000, shippingCents: 100000, discountBps: 9999 });
function outcome(fn, input) {
  const copy = structuredClone(input); let clockCalls = 0;
  let result;
  try { result = { value: fn(copy, { clock: () => { clockCalls++; return new Date(fixedDate); } }) }; }
  catch (e) { result = { error: { name: e.name, message: e.message } }; }
  assert.deepEqual(copy, input, 'input mutated');
  return { ...result, clockCalls };
}
test('546 valid API comparisons, exact values and clock calls', () => {
  for (const name of channels) for (const input of orders)
    assert.deepEqual(outcome(candidate[name], input), outcome(reference[name], input), name + ' ' + input.id);
});
const base = orders[0];
const invalid = [null, undefined, [], 7, {}, { ...base, id: '' }, { ...base, id: ' ' }, { ...base, customer: null },
  { ...base, items: [] }, { ...base, items: null }, { ...base, items: [null] },
  ...['', null, 42].map(sku => ({ ...base, items: [{ sku, quantity: 1, unitPriceCents: 2 }] })),
  ...[-1, 1.5, 1001, NaN, '2'].map(quantity => ({ ...base, items: [{ sku: 'X', quantity, unitPriceCents: 2 }] })),
  ...[-1, 1.5, 1000001, Infinity, '2'].map(unitPriceCents => ({ ...base, items: [{ sku: 'X', quantity: 1, unitPriceCents }] })),
  ...[-1, 1.5, 10001, '0'].map(discountBps => ({ ...base, discountBps })),
  ...[-1, 1.5, 3001, '0'].map(taxBps => ({ ...base, taxBps })),
  ...[-1, 1.5, 100001, '0'].map(shippingCents => ({ ...base, shippingCents })),
  { ...base, id: '', items: [], taxBps: -1 },
];
test('invalid inputs preserve error type, message, precedence and no clock calls', () => {
  for (const name of channels) for (const input of invalid) {
    const expected = outcome(reference[name], input); assert.equal(expected.clockCalls, 0);
    assert.deepEqual(outcome(candidate[name], input), expected, name);
  }
});
const consumers = [
  ['receipt', 'checkoutReceipt'], ['renewal-batch', 'renewalBatch'], ['quote-email', 'quoteEmail'], ['report', 'summarizeInvoices'],
];
for (const [file, name] of consumers) {
  const actual = await import(new URL('./src/consumers/' + file + '.mjs', ${JSON.stringify(pathToFileURL(repo + '/').href)}));
  const expected = await import(new URL('./src/consumers/' + file + '.mjs', ${JSON.stringify(pathToFileURL(reference + '/').href)}));
  test('consumer ' + name + ' compatibility', () => {
    for (const order of orders.slice(0, 20)) {
      const input = name === 'renewalBatch' ? [order, { ...order, id: '' }] : name === 'summarizeInvoices'
        ? channels.map(c => reference[c](order, { clock: () => new Date(fixedDate) })) : order;
      assert.deepEqual(outcome(actual[name], input), outcome(expected[name], input));
    }
  });
}
test('default clock remains current and caller data is not retained', () => {
  for (const name of channels) {
    const start = Date.now(); const invoice = candidate[name](orders[0]); const end = Date.now();
    assert(Date.parse(invoice.issuedAt) >= start && Date.parse(invoice.issuedAt) <= end);
    invoice.lines[0].sku = 'mutated result';
    assert.notEqual(candidate[name](orders[0]).lines[0].sku, 'mutated result');
  }
});
`;
}
function architectureTests(probe: string): string {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import * as channels from ${JSON.stringify(pathToFileURL(join(probe, 'src/index.mjs')).href)};
import { validateOrder } from ${JSON.stringify(pathToFileURL(join(probe, 'src/domain/validate-order.mjs')).href)};
import { priceOrder } from ${JSON.stringify(pathToFileURL(join(probe, 'src/domain/price-order.mjs')).href)};
import { createInvoice } from ${JSON.stringify(pathToFileURL(join(probe, 'src/domain/create-invoice.mjs')).href)};
const input = { id: 'x', customer: 'A', items: [{ sku: ' a ', quantity: 3, unitPriceCents: 101 }], discountBps: 3333, taxBps: 825, shippingCents: 23 };
const pricing = { lines: [{ sku: 'a', quantity: 3, unitPriceCents: 101 }], subtotalCents: 303, discountCents: 101, shippingCents: 23, taxCents: 19, totalCents: 244 };
test('shared APIs have the required independent contracts', () => {
  assert.deepEqual(validateOrder(input), pricing.lines);
  assert.deepEqual(priceOrder(input), pricing);
  let calls = 0;
  assert.deepEqual(createInvoice(input, { clock: () => { calls++; return new Date('2025-01-01T00:00:00.000Z'); } }),
    { orderId: 'x', customer: 'A', issuedAt: '2025-01-01T00:00:00.000Z', ...pricing });
  assert.equal(calls, 1);
});
test('every channel actually uses each shared layer once', () => {
  for (const name of ['checkout', 'renewal', 'quotation']) {
    globalThis.__benchmarkCalls = {};
    channels[name](input, { clock: () => new Date('2025-01-01T00:00:00.000Z') });
    assert.deepEqual(globalThis.__benchmarkCalls, { createInvoice: 1, priceOrder: 1, validateOrder: 1 }, name);
  }
});
test('priceOrder is pure and does not consult Date or a clock', () => {
  const OriginalDate = globalThis.Date;
  globalThis.Date = class { constructor() { throw new Error('pricing used Date'); } static now() { throw new Error('pricing used Date.now'); } };
  try { assert.deepEqual(priceOrder(input), pricing); } finally { globalThis.Date = OriginalDate; }
});
`;
}
function adapterViolations(files: Record<string, string>): string[] {
  const violations: string[] = [];
  const forbidden = new Set(['items', 'quantity', 'unitPriceCents', 'discountBps', 'taxBps', 'shippingCents']);
  const rootIdentifier = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return rootIdentifier(node.expression);
    if (ts.isElementAccessExpression(node)) return rootIdentifier(node.expression);
    return null;
  };
  for (const c of channelNames) {
    const path = `src/channels/${c}.mjs`;
    if (!files[path]) {
      violations.push(`${path} missing`);
      continue;
    }
    const ast = ts.createSourceFile(path, files[path], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      const receiver = ts.isPropertyAccessExpression(node)
        ? node.expression
        : ts.isElementAccessExpression(node)
          ? node.expression
          : null;
      // Only accesses rooted in the adapter's input (order/item) are
      // duplicated business logic. Reading the corresponding field from the
      // shared invoice result is part of preserving the public API.
      if (member && forbidden.has(member) && receiver && ['order', 'item'].includes(rootIdentifier(receiver) ?? ''))
        violations.push(`${path}: adapter still accesses pricing/validation input ${member}`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return [...new Set(violations)];
}
export async function verifyBenchmark(runDir: string) {
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== benchmarkVersion ||
    manifest.fixtureHash !== fixtureHash() ||
    manifest.promptHash !== hash(benchmarkPrompt)
  )
    throw new Error('Benchmark version/hash mismatch; use the matching verifier version');
  const repo = join(runDir, 'repo');
  const verificationDir = join(runDir, 'verification');
  await rm(verificationDir, { recursive: true, force: true });
  const reference = join(verificationDir, 'reference');
  for (const [path, content] of Object.entries(fixtureFiles())) {
    await mkdir(dirname(join(reference, path)), { recursive: true });
    await writeFile(join(reference, path), content);
  }
  const after = await snapshotFiles(repo);
  const before = fixtureFiles();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => before[k] !== after[k])
    .sort();
  const protectedChanges = changed.filter(k => !k.startsWith('src/'));
  const violations = adapterViolations(after);
  const behaviorPath = join(verificationDir, 'behavior.test.mjs');
  await writeFile(behaviorPath, comparisonTests(repo, reference));
  const behavior = await runCommand(process.execPath, ['--test', behaviorPath], repo, 30000);
  await writeFile(join(runDir, 'behavior-verification.txt'), behavior.output);
  const probe = join(verificationDir, 'probe');
  await mkdir(probe, { recursive: true });
  await cp(join(repo, 'src'), join(probe, 'src'), { recursive: true, dereference: false });
  let missingModule: string | null = null;
  for (const [file, fn] of [
    ['validate-order', 'validateOrder'],
    ['price-order', 'priceOrder'],
    ['create-invoice', 'createInvoice'],
  ]) {
    const path = join(probe, `src/domain/${file}.mjs`);
    try {
      await rename(path, join(probe, `src/domain/original-${file}.mjs`));
      await writeFile(
        path,
        `import { ${fn} as original } from './original-${file}.mjs';
export function ${fn}(...args) {
  const counts = globalThis.__benchmarkCalls ??= {};
  counts.${fn} = (counts.${fn} ?? 0) + 1;
  return original(...args);
}\n`,
      );
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      missingModule = file!;
      break;
    }
  }
  const architecturePath = join(verificationDir, 'architecture.test.mjs');
  await writeFile(architecturePath, architectureTests(probe));
  const architecture = missingModule
    ? { code: 1, output: `Missing shared module: ${missingModule}\n`, timedOut: false, omitted: 0 }
    : await runCommand(process.execPath, ['--test', architecturePath], repo, 30000);
  await writeFile(join(runDir, 'architecture-verification.txt'), architecture.output + violations.join('\n') + '\n');
  const behaviorPassed = behavior.code === 0 && !behavior.timedOut;
  const architecturePassed =
    architecture.code === 0 && !architecture.timedOut && violations.length === 0;
  const result = {
    passed: behaviorPassed && architecturePassed && protectedChanges.length === 0 && changed.length > 0,
    behaviorPassed,
    architecturePassed,
    protectedFilesUnchanged: protectedChanges.length === 0,
    protectedChanges,
    violations,
    changedFiles: changed,
  };
  await writeFile(join(runDir, 'after.json'), JSON.stringify(after, null, 2) + '\n');
  await writeFile(join(runDir, 'changes.diff'), fileDiff(before, after));
  await writeFile(join(runDir, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
