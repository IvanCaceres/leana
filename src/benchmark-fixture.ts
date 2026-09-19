import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hash } from './tools.js';

export const benchmarkVersion = 'order-refactor-v1';
export const benchmarkPrompt = `Refactor this order-processing project to remove duplicated business logic across checkout, subscription renewal, and quotation. Preserve all existing public APIs, returned fields, error messages, rounding rules, input immutability, and injected-clock behavior.
Create three real shared modules:
- src/domain/validate-order.mjs exports validateOrder(order), returning ONLY the normalized line-item array (never an object with pricing metadata) or throwing the existing errors.
- src/domain/price-order.mjs exports priceOrder(order), using validateOrder and returning lines, subtotalCents, discountCents, shippingCents, taxCents, totalCents. It must remain pure and never call a clock.
- src/domain/create-invoice.mjs exports createInvoice(order, options = {}), using priceOrder and the optional options.clock function (default current Date). Return orderId, customer, issuedAt, and the pricing fields. Call the clock exactly once per successful invoice and never for invalid orders.
Migrate src/channels/checkout.mjs, renewal.mjs, and quotation.mjs to thin adapters that each call createInvoice once, then add their existing channel-specific fields. Remove the duplicated validation and pricing logic from all three adapters. Keep all consumers working.
Only change or add files under src/. Do not alter tests, package.json, documentation, or instructions. Do not add dependencies. The existing tests initially pass: this is a behavior-preserving refactor, not a bug fix. Read README.md for the contracts and test commands. Run node --test test/*.test.mjs from the repository root; the harness already sets the working directory, so do not cd to /workspace or another guessed path. Report the actual results. Complete every part of the refactor before finishing.`;

const validation = `  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new TypeError('order must be an object');
  if (typeof order.id !== 'string' || !order.id.trim()) throw new TypeError('id is required');
  if (typeof order.customer !== 'string' || !order.customer.trim()) throw new TypeError('customer is required');
  if (!Array.isArray(order.items) || order.items.length === 0) throw new TypeError('items must be non-empty');
  const lines = order.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new TypeError('invalid item at ' + index);
    if (typeof item.sku !== 'string' || !item.sku.trim()) throw new TypeError('sku is required at ' + index);
    if (!Number.isInteger(item.quantity) || item.quantity < 0 || item.quantity > 1000) throw new RangeError('invalid quantity at ' + index);
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0 || item.unitPriceCents > 1000000) throw new RangeError('invalid price at ' + index);
    return { sku: item.sku.trim(), quantity: item.quantity, unitPriceCents: item.unitPriceCents };
  });
  const discountBps = order.discountBps ?? 0;
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000) throw new RangeError('invalid discount');
  const taxBps = order.taxBps ?? 0;
  if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > 3000) throw new RangeError('invalid tax');
  const shippingCents = order.shippingCents ?? 0;
  if (!Number.isInteger(shippingCents) || shippingCents < 0 || shippingCents > 100000) throw new RangeError('invalid shipping');
`;
const pricing = `  const subtotalCents = lines.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  const discountCents = Math.round(subtotalCents * discountBps / 10000);
  const taxableCents = subtotalCents - discountCents + shippingCents;
  const taxCents = Math.round(taxableCents * taxBps / 10000);
  const totalCents = taxableCents + taxCents;
`;
export const channelNames = ['checkout', 'renewal', 'quotation'] as const;
function adapter(channel: typeof channelNames[number]): string {
  const extra = channel === 'checkout' ? "paymentStatus: order.prepaid ? 'paid' : 'due'" : channel === 'renewal' ? 'cycle: order.cycle ?? 1' : "expiresAt: new Date(Date.parse(issuedAt) + 7 * 86400000).toISOString()";
  return `// Public ${channel} entry point. Preserve its return shape during extraction.
export function ${channel}(order, options = {}) {
${validation}${pricing}  const clock = options.clock ?? (() => new Date());
  const issuedAt = clock().toISOString();
  return {
    channel: '${channel}',
    invoiceId: '${channel}-' + order.id,
    orderId: order.id,
    customer: order.customer,
    issuedAt,
    lines,
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents,
    ${extra},
  };
}
`;
}
export const behaviorTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { checkout, renewal, quotation } from '../src/index.mjs';
import { checkoutReceipt } from '../src/consumers/receipt.mjs';
import { renewalBatch } from '../src/consumers/renewal-batch.mjs';
import { quoteEmail } from '../src/consumers/quote-email.mjs';
import { summarizeInvoices } from '../src/consumers/report.mjs';
const clock = () => new Date('2025-01-15T10:30:00.000Z');
const order = () => ({ id: 'A-1', customer: 'Ada', items: [{ sku: ' book ', quantity: 2, unitPriceCents: 1299 }], discountBps: 1000, taxBps: 825, shippingCents: 199 });
for (const fn of [checkout, renewal, quotation]) {
  test(fn.name + ' preserves invoice totals and normalized lines', () => {
    const input = order(); const original = structuredClone(input);
    const result = fn(input, { clock });
    assert.equal(result.subtotalCents, 2598);
    assert.equal(result.discountCents, 260);
    assert.equal(result.taxCents, 209);
    assert.equal(result.totalCents, 2746);
    assert.equal(result.issuedAt, clock().toISOString());
    assert.equal(result.lines[0].sku, 'book'); assert.deepEqual(input, original);
  });
  test(fn.name + ' accepts zero quantities and full discount', () => {
    const input = order(); input.items[0].quantity = 0; input.discountBps = 10000;
    assert.equal(fn(input, { clock }).totalCents, 215);
  });
  test(fn.name + ' rejects invalid quantities before calling clock', () => {
    const input = order(); input.items[0].quantity = -1; let calls = 0;
    assert.throws(() => fn(input, { clock: () => { calls++; return clock(); } }), { name: 'RangeError', message: 'invalid quantity at 0' });
    assert.equal(calls, 0);
  });
}
test('receipt remains compatible', () => assert.equal(checkoutReceipt(order(), { clock }), 'checkout-A-1 | Ada | 2746 cents | due'));
test('renewal batch collects successes and failures', () => {
  const out = renewalBatch([order(), { ...order(), id: '' }], { clock });
  assert.equal(out.invoices.length, 1); assert.equal(out.errors[0].message, 'id is required');
});
test('quote expiry and email remain compatible', () => {
  const q = quoteEmail(order(), { clock });
  assert.equal(q.subject, 'Quote quotation-A-1'); assert.match(q.body, /2025-01-22T10:30:00.000Z/);
});
test('reports preserve grouping and totals', () => {
  const report = summarizeInvoices([checkout(order(), { clock }), renewal(order(), { clock }), quotation(order(), { clock })]);
  assert.equal(report.totalCents, 8238); assert.equal(report.byChannel.renewal.count, 1);
});
`;

export function fixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: benchmarkVersion, private: true, type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }, null, 2) + '\n',
    'AGENTS.md': 'Refactor only src/. Preserve APIs and behavior. Do not edit tests, package.json, README.md, or these instructions. No dependencies. Validate with node --test test/*.test.mjs. Read README.md for the architecture target.\n',
    'README.md': `# Order-processing refactor benchmark\n\n${benchmarkPrompt.replace('Read README.md for the contracts and test commands.', '')}\n\n## Contracts\n\nMoney uses integer cents. Discounts and taxes use integer basis points. Round discount first, then calculate tax on discounted subtotal plus shipping, using Math.round. Trim SKU only; retain customer and order ID verbatim. Retain error type, message, and validation order. Do not mutate orders, items, or options. options.clock returns a Date. Quotes expire seven days after issuedAt. Renewal's cycle defaults only for null/undefined. checkout paymentStatus follows prepaid truthiness. Default clocks must remain fresh per invocation.\n\n## Consumers\n\nsrc/index.mjs is the public barrel. Receipt, renewal batch, quotation email, and grouped report all rely on exact adapter shapes. The initial behavioral tests pass; the independent benchmark additionally verifies the shared architecture and generated edge cases.\n\n## Verification\n\nnode --test test/*.test.mjs\n`,
    'src/index.mjs': channelNames.map(c => `export { ${c} } from './channels/${c}.mjs';`).join('\n') + '\n',
    'src/consumers/receipt.mjs': `import { checkout } from '../channels/checkout.mjs';
export function checkoutReceipt(order, options) {
  const invoice = checkout(order, options);
  return [invoice.invoiceId, invoice.customer, invoice.totalCents + ' cents', invoice.paymentStatus].join(' | ');
}
`,
    'src/consumers/renewal-batch.mjs': `import { renewal } from '../channels/renewal.mjs';
export function renewalBatch(orders, options) {
  const invoices = [];
  const errors = [];
  for (const [index, order] of orders.entries()) {
    try { invoices.push(renewal(order, options)); }
    catch (error) { errors.push({ index, name: error.name, message: error.message }); }
  }
  return { invoices, errors };
}
`,
    'src/consumers/quote-email.mjs': `import { quotation } from '../channels/quotation.mjs';
export function quoteEmail(order, options) {
  const invoice = quotation(order, options);
  return { subject: 'Quote ' + invoice.invoiceId,
    body: invoice.customer + ': ' + invoice.totalCents + ' cents. Valid until ' + invoice.expiresAt + '.' };
}
`,
    'src/consumers/report.mjs': `export function summarizeInvoices(invoices) {
  const byChannel = {};
  let totalCents = 0;
  for (const invoice of invoices) {
    totalCents += invoice.totalCents;
    const group = byChannel[invoice.channel] ??= { count: 0, subtotalCents: 0, totalCents: 0 };
    group.count++;
    group.subtotalCents += invoice.subtotalCents;
    group.totalCents += invoice.totalCents;
  }
  return { count: invoices.length, totalCents, byChannel };
}
`,
    'test/behavior.test.mjs': behaviorTests,
  };
  for (const c of channelNames) files[`src/channels/${c}.mjs`] = adapter(c);
  return files;
}
export function fixtureHash(files = fixtureFiles()): string {
  return hash(JSON.stringify(Object.keys(files).sort().map(k => [k, files[k]])));
}
export async function prepareBenchmark(parent: string, label: string): Promise<{ runDir: string; repo: string }> {
  await mkdir(parent, { recursive: true });
  const runDir = await mkdtemp(join(parent, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  const repo = join(runDir, 'repo');
  const files = fixtureFiles();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await writeFile(join(runDir, 'before.json'), JSON.stringify(files, null, 2) + '\n');
  await writeFile(join(runDir, 'PROMPT.md'), benchmarkPrompt + '\n');
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ version: benchmarkVersion, fixtureHash: fixtureHash(), promptHash: hash(benchmarkPrompt), label, createdAt: new Date().toISOString() }, null, 2) + '\n');
  return { runDir, repo };
}

// Used only by offline verifier tests, never placed inside a candidate repository.
export function referenceRefactor(): Record<string, string> {
  const result: Record<string, string> = {
    'src/domain/validate-order.mjs': `export function validateOrder(order) {\n${validation}  return lines;\n}\n`,
    'src/domain/price-order.mjs': `import { validateOrder } from './validate-order.mjs';
export function priceOrder(order) {
  const lines = validateOrder(order);
  const discountBps = order.discountBps ?? 0;
  const taxBps = order.taxBps ?? 0;
  const shippingCents = order.shippingCents ?? 0;
${pricing}  return { lines, subtotalCents, discountCents, shippingCents, taxCents, totalCents };
}
`,
    'src/domain/create-invoice.mjs': `import { priceOrder } from './price-order.mjs';
export function createInvoice(order, options = {}) {
  const pricing = priceOrder(order);
  const clock = options.clock ?? (() => new Date());
  return { orderId: order.id, customer: order.customer, issuedAt: clock().toISOString(), ...pricing };
}
`,
  };
  for (const c of channelNames) {
    const extra = c === 'checkout' ? "paymentStatus: order.prepaid ? 'paid' : 'due'" : c === 'renewal' ? 'cycle: order.cycle ?? 1' : 'expiresAt: new Date(Date.parse(invoice.issuedAt) + 7 * 86400000).toISOString()';
    result[`src/channels/${c}.mjs`] = `import { createInvoice } from '../domain/create-invoice.mjs';
export function ${c}(order, options = {}) {
  const invoice = createInvoice(order, options);
  return { channel: '${c}', invoiceId: '${c}-' + order.id, ...invoice, ${extra} };
}
`;
  }
  return result;
}
