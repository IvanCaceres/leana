import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults as baseDefaults, loadConfig } from '../src/config.js';
// The onset ledger makes a generation the older call-order stubs do not expect; tests enable it explicitly.
const defaults = { ...baseDefaults };
import { Bonsai, Jev, postJson, repetitionStart, validateAnswers } from '../src/clients.js';
import { fenceFor, trimContext, compactNames, confidentChoice, evictOne, mergeCoverage, relevantFiles, repoOverview, checkDelta, staleFor, clipEnds } from '../src/context.js';
import { referenceContext, rememberReferences, scopes } from '../src/references.js';
import { dirtySessionConflict } from '../src/cli.js';
import { extractCode, focusedEditSchema, samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { collectSteps, renderReport, speed } from '../src/report.js';
import { Display, describe, generationSpeed } from '../src/display.js';
import { commandWords, configFile, declaredName, lockfiles, manifestOf, shellPrefixFor, undeclaredPackages, unresolvedImports, detectEcosystem, ecosystems, importSpelling, importsFor, invalidTailwindClasses, languageFor, moduleCandidates, packageImportFor, regexDeclarations, runQualityLints, signaturesFor, sourceFile, syntaxCheck, verificationClass } from '../src/profiles.js';
import { aliasImportBinding, manifestFailures, installCommand, repositoryStatus, solutionTsconfigReferences, readOnlyCommand, checkUnusable, movePlan, namedIdentifiers, removeImportBindings, checkAdvice, assertBalancePreserved, completionSource, hash, importInsertLine, runCommand, safePath, sourceHashes, StaleWriteError, stripLiterals, ToolBox, summarizeCheck, resolveMissingNames, syntaxErrors, regression, assertNoBulkDuplication, dropDuplicateImports, exportedSignatures, importCandidates, relativeImports, statementBounds } from '../src/tools.js';
import type { Answers, Questions } from '../src/types.js';

const noop = async () => {};
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
test('Schemas reject unknown arguments and unbounded reads/tasks', () => {
  assert.throws(() => validate(schemas.bash, { command: 'pwd', purpose: 'check', unsafe: true }));
  assert.throws(() => validate(schemas.read_files, { files: [] }));
  assert.throws(() => validate(schemas.tasks, { tasks: Array(13).fill({}) }));
});
test('llama grammar compatibility keeps runtime string limits intact, and content fields carry no cap', () => {
  const wire = samplingSchema(schemas.bash);
  assert.equal(wire.properties?.command?.maxLength, undefined);
  assert.equal(schemas.bash.properties?.command?.maxLength, 2000);
  assert.throws(() => validate(schemas.bash, { command: 'x'.repeat(2001), purpose: 'test', check: false }), /string length 2001 exceeds the maximum 2000; shorten this field/);
  // Code and prose are never capped after generation: the grammar cannot enforce a length, so a cap on content is a rule that discards a finished generation.
  validate(schemas.move_lines, { source: 'a', expectedHash: 'h', start: 1, end: 2, destination: 'b', destinationHash: 'new', replacement: '', prefix: 'x'.repeat(16001) });
  validate(schemas.write, { path: 'a.ts', expectedHash: 'h', oldText: 'y'.repeat(700), newText: 'z'.repeat(30000) });
  validate(schemas.replace_lines, { path: 'a.ts', expectedHash: 'h', edits: [{ start: 1, end: 1, newText: 'n'.repeat(20000), prepend: '' }] });
  validate(schemas.finish, { summary: 's'.repeat(9000) });
  assert.deepEqual(Object.keys(schemas.create_file.properties!), ['path', 'purpose']); assert.deepEqual(Object.keys(focusedEditSchema.properties!), ['edits']);
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

test('Routing returns the argmax option with margin tolerance and survives a mismatched choice field', () => {
  const c = { ...defaults, routeProbability: .4, routeMargin: .01 };
  assert.equal(confidentChoice({ type: 'choice', choice: 'read_files', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'write', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: .5, b: .5 }, confidence: .5 }, c), null);
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

test('The panel never fills the last column, so redraws do not leak lines', () => {
  const out: string[] = [];
  const d = new Display({ write: (s: string) => out.push(s), isTTY: true, columns: 80 }, { objective: 'x'.repeat(300), session: 's', verbose: false });
  const lines = d.panel();
  assert(lines.every(l => l.length <= 79), `longest ${Math.max(...lines.map(l => l.length))}`); assert.equal(lines[0]!.length, 79);
});

test('Panel lines are flattened to one ASCII row each', () => {
  const out: string[] = [];
  const d = new Display({ write: (s: string) => out.push(s), isTTY: true, columns: 100 }, { objective: 'x', session: 's', verbose: false });
  d.update({ kind: 'generated', step: 1, route: 'bash', meta: null, args: { command: 'grep' + '\n[' + '…' + 'truncated' + '…' + ']\n' + 'x'.repeat(200) } } as any);
  for (const l of d.panel()) { assert(!l.includes('\n')); assert(l.length <= 99); assert(/^[\x20-\x7e]*$/.test(l), l); }
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
test('Import insertion uses the parser: an import-shaped line inside a string is not an import', async () => {
  const text = "#!/usr/bin/env node\nimport { a } from './a.js';\nimport type { B } from './b.js';\nconst tpl = `\nimport { fake } from './nope.js';\n`;\nexport const x = a;\n";
  assert.equal(await importInsertLine('src/x.ts', text), 4);
  assert.equal(await importInsertLine('src/y.ts', "'use strict';\nconst a = 1;\n"), 2);
  assert.equal(await importInsertLine('src/z.ts', "#!/usr/bin/env node\nconst a = 1;\n"), 2);
  assert.equal(await importInsertLine('src/w.ts', 'const a = 1;\n'), 1);
  assert.equal(await importInsertLine('notes.txt', "import { a } from './a.js';\ntext\n"), 2, 'non-TypeScript files fall back to the line scan');
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
test('The source still using a moved name is detected by the parser even after an unbalanced quote earlier in the file', async () => {
  const text = ["const re = /'/; // an apostrophe that a literal stripper mistakes for an open string", 'const other = 1;', 'function invokedAsMain(): boolean {', '  return true;', '}', 'if (invokedAsMain()) {', '  other;', '}', ''].join('\n');
  const plan = await movePlan('src/cli.ts', text, 3, 5, 'src/cli/deps.ts', '');
  assert.deepEqual(plan!.stillUsed, ['invokedAsMain']); assert.deepEqual(plan!.replacement, ['import { invokedAsMain } from "./cli/deps.js";']);
});
test('The regression verdict judges only the files that existed: a created file\'s own errors never count against it', () => {
  const f = (count: number, lines: number[] = [1]) => ({ count, syntax: 0, resolution: count, lines, samples: [] as string[] });
  const before = { errors: 12, syntax: 0, resolution: 12, byFile: { 'src/App.tsx': f(12) } };
  const after = { errors: 11, syntax: 0, resolution: 11, byFile: { 'src/App.tsx': f(10), 'src/components/FeaturesSection.tsx': f(1) } };
  assert.equal(regression(before, after, { files: ['src/components/FeaturesSection.tsx'] }), 'worse', 'judged in scope, an edited file that only added an error');
  assert.equal(regression(before, after, { files: ['src/App.tsx'] }), 'fine', 'the created sibling is outside the scope the runner passes');
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
test('Profiles carry the ecosystem, language and stack knowledge: detected from the repository, never named by the loop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-profiles-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await detectEcosystem(root), null, 'no manifest, no ecosystem');
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n'); assert.equal((await detectEcosystem(root))!.id, 'python');
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n[dependencies]\nserde = "1"\n'); assert.equal((await detectEcosystem(root))!.id, 'python', 'the first manifest found wins, in the profile order');
  await writeFile(join(root, 'package.json'), '{"name":"x"}'); assert.equal((await detectEcosystem(root))!.id, 'node');
  const py = ecosystems.find(e => e.id === 'python')!; const rs = ecosystems.find(e => e.id === 'rust')!; const go = ecosystems.find(e => e.id === 'go')!;
  // System pip refuses installs on managed machines (PEP 668): the profile keeps a project venv. The install is staged: the
  // declared dependencies as soon as the manifest exists (the project has no sources yet), the project itself once it has.
  const deps = `.venv/bin/python -c "import tomllib,sys;d=tomllib.load(open('pyproject.toml','rb'));p=d.get('project',{});x=list(p.get('dependencies',[]))\nfor v in p.get('optional-dependencies',{}).values(): x+=list(v)\nfor v in d.get('dependency-groups',{}).values(): x+=[i for i in v if isinstance(i,str)]\nprint('\\n'.join(x))" | xargs -r -d '\\n' .venv/bin/python -m pip install`;
  assert.equal(await py.installCommand(root, '.', false), `python3 -m venv .venv && ${deps} && printf '%s' 'deps' > .venv/.leana-installed`, 'no sources yet: the dependencies only, and the stage is recorded');
  await writeFile(join(root, 'requirements.txt'), 'requests>=2\n# c\nflask==3.0\n');
  assert.equal(await py.installCommand(root, '.', true), `python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt && ${deps} && printf '%s' 'deps' > .venv/.leana-installed`);

  await mkdir(join(root, '.venv', 'bin'), { recursive: true }); await writeFile(join(root, '.venv', 'bin', 'python'), ''); await writeFile(join(root, '.venv', '.leana-installed'), 'deps');
  assert.equal(await py.installCommand(root, '.', false), null, 'dependencies installed and still no sources: nothing to do');
  await mkdir(join(root, 'src', 'x'), { recursive: true }); await writeFile(join(root, 'src', 'x', '__init__.py'), '');
  assert.equal(await py.installCommand(root, '.', false), `.venv/bin/python -m pip install --no-deps -e . && printf '%s' 'project' > .venv/.leana-installed`, 'sources exist now: the project is installed, once');
  await writeFile(join(root, '.venv', '.leana-installed'), 'project');
  assert.equal(await py.installCommand(root, '.', false), null, 'installed once, not again');
  assert.equal(await py.installCommand(root, '.', true), `.venv/bin/python -m pip install -r requirements.txt && ${deps} && .venv/bin/python -m pip install --no-deps -e . && printf '%s' 'project' > .venv/.leana-installed`, 'a manifest change installs again into the same venv');
  assert.deepEqual((await py.verificationCandidates(root)).map(c => c.command), [".venv/bin/python -m compileall -q -x '\\.venv' ."], 'no test tool in the venv or the requirements: the interpreter syntax pass');
  await writeFile(join(root, '.venv', 'bin', 'pytest'), ''); await writeFile(join(root, '.venv', 'bin', 'mypy'), '');
  assert.deepEqual((await py.verificationCandidates(root)).map(c => c.command).slice(0, 2), ['.venv/bin/python -m mypy .', '.venv/bin/python -m pytest -q'], 'the tools the venv has, static before test');
  await rm(join(root, '.venv', 'bin', 'pytest')); await appendFile(join(root, 'requirements.txt'), 'pytest>=8\n');
  assert((await py.verificationCandidates(root)).some(c => c.command === '.venv/bin/python -m pytest -q'), 'a declared test runner is a candidate before it is installed');
  assert.deepEqual(await py.declared(root), ['requests@', 'flask@', 'pytest@']);
  assert.deepEqual(await rs.declared(root), ['serde@']);
  assert.equal(verificationClass('npm run typecheck', 'tsc --noEmit'), 'static'); assert.equal(verificationClass('npm run build', 'vite build'), 'build'); assert.equal(verificationClass('npm test', 'vitest run'), 'test');
  assert.equal(verificationClass('cargo clippy', ''), 'static'); assert.equal(verificationClass('go test ./...', ''), 'test'); assert.equal(verificationClass('python3 -m mypy .', ''), 'static'); assert.equal(verificationClass('make docs', ''), null);
  assert(configFile('package.json') && configFile('tsconfig.app.json') && configFile('Cargo.toml') && configFile('go.mod') && configFile('index.html') && !configFile('src/index.ts') && !configFile('src/components/Button.tsx'));
  assert.equal(languageFor('src/a.tsx')!.id, 'typescript'); assert.equal(languageFor('lib/x.rs')!.id, 'rust'); assert.equal(languageFor('app.py')!.id, 'python'); assert.equal(languageFor('styles/a.scss')!.kind, 'style'); assert.equal(languageFor('README.md'), null);
  assert(sourceFile('src/main.go') && sourceFile('web/index.html') && sourceFile('Foo.java') && !sourceFile('data.json') && !sourceFile('notes.md'));
  assert.equal(languageFor('a.ts')!.publicPrefix!('function f() {'), 'export '); assert.equal(languageFor('a.ts')!.publicPrefix!('export function f() {'), null); assert.equal(languageFor('a.rs')!.publicPrefix!('fn f() {'), 'pub '); assert.equal(languageFor('a.rs')!.publicPrefix!('pub fn f() {'), null); assert.equal(languageFor('a.py')!.publicPrefix, undefined);
  assert.equal(languageFor('a.tsx')!.callSite!('<Header>\n'), 'Header'); assert.equal(languageFor('a.ts')!.callSite!('createRoot(el)'), 'createRoot'); assert.equal(languageFor('a.rs')!.callSite!('serde_json::from_str(x)'), 'serde_json::from_str'); assert.equal(languageFor('a.py')!.callSite!('client.get(url)'), 'client.get');
});

test('Syntax gates by language: the interpreter judges a Python file when the machine has one; a language without a tool has no gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-syntax-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bad = await syntaxCheck(root, 'app/main.py', 'def broken(:\n    pass\n');
  assert.equal(bad.length, 1, `one diagnostic: ${bad.join(' | ')}`); assert.match(bad[0]!, /^app\/main\.py\(1,\d+\): error: /, 'attributed to the file, in the path(line,col) form the loop reads');
  assert.deepEqual(await syntaxCheck(root, 'app/main.py', 'def fine():\n    return 1\n'), []);
  assert.deepEqual(await syntaxCheck(root, 'x.ts', 'const a: = 1;').then(d => d.length), 1, 'TypeScript keeps the in-process parser');
  assert.deepEqual(await syntaxCheck(root, 'Main.java', 'this is not java'), [], 'no tool for the language: no verdict, never a false rejection');
});
test('A name nothing in the repository declares that a declared package exports is imported from it: test-runner globals, framework hooks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-pkg-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19' }, devDependencies: { vitest: '^3' } }));
  await mkdir(join(root, 'node_modules', 'vitest', 'dist'), { recursive: true }); await mkdir(join(root, 'node_modules', 'react'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'vitest', 'index.d.ts'), "export { describe, it, expect } from './dist/index.js';\nexport type { TestContext } from './dist/index.js';\nexport declare function vi(): void;\n");
  await writeFile(join(root, 'node_modules', 'react', 'index.d.ts'), 'export declare function useState<T>(init: T): [T, (v: T) => void];\nexport interface FC<P = {}> { (props: P): null }\n');
  assert.equal(await packageImportFor(root, 'describe'), "import { describe } from 'vitest';");
  assert.equal(await packageImportFor(root, 'vi'), "import { vi } from 'vitest';");
  assert.equal(await packageImportFor(root, 'useState'), "import { useState } from 'react';");
  assert.equal(await packageImportFor(root, 'FC'), "import type { FC } from 'react';", 'a type-only export is imported as a type');
  assert.equal(await packageImportFor(root, 'nothingExportsThis'), null);
});
test('The project linter is a quality lint at creation: its diagnostics are queued for the file, warnings and other files are not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-lint-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"name":"x"}'); await writeFile(join(root, 'eslint.config.js'), 'export default [];\n');
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true }); await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'eslint'), '#!/bin/sh\nf="$1"; while [ "$#" -gt 0 ]; do f="$1"; shift; done\necho "$f:2:7: x is assigned a value but never used [no-unused-vars]"\necho "$f:3:1: prefer const [prefer-const] warning"\necho "src/other.ts:1:1: unrelated"\nexit 1\n', { mode: 0o755 });
  const r = await runQualityLints(root, 'src/a.ts', 'export const a = 1;\nlet x = 2;\n');
  assert.deepEqual(r.diagnostics, ['src/a.ts:2:7: x is assigned a value but never used [no-unused-vars]']);
  await rm(join(root, 'eslint.config.js'));
  assert.deepEqual((await runQualityLints(root, 'src/a.ts', 'let x = 2;\n')).diagnostics, [], 'no configuration, no linter run: the project decides');
});

test('Lockfiles and manifests are known through the profiles: a package manager rewrite is never an unaccounted file, and the setup fix targets the manifest the repository has', () => {
  for (const l of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock']) assert(lockfiles().includes(l), `${l} is a lockfile`);
  assert(!lockfiles().includes('package.json') && !lockfiles().includes('pyproject.toml'));
  assert.equal(manifestOf(['src/a.py', 'requirements.txt', 'api/pyproject.toml']), 'api/pyproject.toml', 'the primary manifest, wherever it sits');
  assert.equal(manifestOf(['src/a.rs', 'Cargo.toml']), 'Cargo.toml'); assert.equal(manifestOf(['src/a.ts']), null);
});

test('A type\'s contract carries its members in any language, and a test failure carries its call chain so the fixer sees the caller', async () => {
  const py = await signaturesFor('app/models.py', 'from dataclasses import dataclass, field\n\n@dataclass\nclass Task:\n    """A task."""\n    id: str\n    title: str\n    created_at: str = field(default_factory=now)\n    _cache: dict = field(default_factory=dict)\n\n    def __post_init__(self) -> None:\n        datetime.fromisoformat(self.created_at)\n\n    def mark_done(self) -> "Task":\n        return self\n\n    def _hidden(self):\n        pass\n\nclass _Private:\n    x: int\n\ndef helper() -> None:\n    pass\n');
  assert.deepEqual(py, ['class Task\n    id: str\n    title: str\n    created_at: str\n    def __post_init__(self) -> None\n    def mark_done(self) -> "Task"', 'def helper() -> None'], `fields and public methods, dunder kept, private dropped: ${JSON.stringify(py)}`);
  const rs = await signaturesFor('src/config.rs', 'pub struct Config {\n    pub name: String,\n    port: u16,\n}\n\nimpl Config {\n    pub fn load() -> Config { todo!() }\n}\n\npub enum Mode { Fast, Safe }\n');
  assert.deepEqual(rs, ['pub struct Config\n    pub name: String,\n    port: u16,', 'pub enum Mode'], `rust fields: ${JSON.stringify(rs)}`);
  const go = await signaturesFor('pkg/s.go', 'type Server struct {\n\tPort int\n\thost string\n}\n\nfunc (s *Server) Start() error { return nil }\n');
  assert.deepEqual(go, ['type Server struct\n    Port int\n    host string', 'func (s *Server) Start() error']);
  const out = "=================================== FAILURES ===================================\n__________________ test_save_writes_valid_json_array_to_disk ___________________\n\ntests/test_repository.py:45: in test_save_writes_valid_json_array_to_disk\n    task = _make_task()\n           ^^^^^^^^^^^^\ntests/test_repository.py:29: in _make_task\n    return Task(\n<string>:9: in __init__\n    ???\nsrc/taskmanager/models.py:45: in __post_init__\n    datetime.fromisoformat(self.created_at)\nE   TypeError: fromisoformat: argument must be str\n\nsrc/taskmanager/models.py:45: TypeError\n=========================== short test summary info ============================\nFAILED tests/test_repository.py::test_save_writes_valid_json_array_to_disk - TypeError: fromisoformat: argument must be str\n1 failed, 1 passed in 0.02s";
  const s = summarizeCheck(out);
  assert.deepEqual(Object.keys(s.byFile).sort(), ['src/taskmanager/models.py', 'tests/test_repository.py']);
  const d = s.byFile['src/taskmanager/models.py']!.diagnostics![0]!;
  assert(d.includes('tests/test_repository.py:29: in _make_task\n    return Task(') && d.includes('src/taskmanager/models.py:45: in __post_init__') && d.includes('E   TypeError: fromisoformat: argument must be str'), `the chain from the test to the raise site: ${d}`);
  assert(!d.includes('___ test_save'), 'the banner is not part of it');
  const ts = summarizeCheck("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n  Types of property 'x' are incompatible.\nsrc/b.ts(1,1): error TS2304: Cannot find name 'y'.\n");
  assert.equal(ts.byFile['src/b.ts']!.diagnostics![0], "src/b.ts(1,1): error TS2304: Cannot find name 'y'.", 'a continuation of the previous error never leaks into the next');
});



test('A created file that imports a name its repository module does not declare is repaired against what the module declares (languages without a checker)', async () => {
  const files: Record<string, string> = { 'src/task_manager/repository.py': 'from .models import Task\n\nclass TaskRepository:\n    def load(self) -> list[Task]:\n        return []\n\ndef _private():\n    pass\n', 'src/task_manager/__init__.py': 'from .repository import TaskRepository\n' };
  const read = async (p: string) => files[p] ?? null;
  const errs = await unresolvedImports('tests/test_repository.py', 'from task_manager.repository import TaskRegistry, Task\nfrom task_manager import TaskRepository\nimport json\n', read);
  assert.equal(errs.length, 1); assert.match(errs[0]!, /^contract: tests\/test_repository\.py imports TaskRegistry from task_manager\.repository \(src\/task_manager\/repository\.py\), which does not declare it; it declares TaskRepository, Task\./, errs[0]);
  assert.deepEqual(await unresolvedImports('tests/test_repository.py', 'from task_manager.repository import TaskRepository\nfrom task_manager import TaskRepository\n', read), [], 'declared and re-exported names resolve');
  assert.deepEqual(await unresolvedImports('src/a.ts', "import { Nope } from './b';", async () => 'export const b = 1;'), [], 'TypeScript is left to its checker');
});

test('A check error whose head line names a repository file is that file\'s: a config the bundler could not load, an ESLint config error', () => {
  const s = summarizeCheck('failed to load config from /x/app/vite.config.ts\nerror during build:\nError [ERR_MODULE_NOT_FOUND]: Cannot find package \'@vitejs/plugin-react\' imported from /x/app/node_modules/.vite-temp/vite.config.ts.timestamp-1.mjs', '/x/app');
  assert.equal(Object.keys(s.byFile)[0], 'vite.config.ts', `the config file first, never the temp copy under node_modules: ${Object.keys(s.byFile)}`);
  const e = summarizeCheck(JSON.stringify({ command: 'npm run lint', code: 2, output: 'Oops! Something went wrong! :(\n\nESLint: 9.0.0\n\nA config object is using the "extends" key, which is not supported in flat config system. (in eslint.config.js)' }));
  assert.deepEqual(Object.keys(e.byFile), ['eslint.config.js'], 'a failed command with no recognisable diagnostic still names its file'); assert.match(e.byFile['eslint.config.js']!.diagnostics![0]!, /extends/);
  assert.equal(summarizeCheck(JSON.stringify({ command: 'x', code: 0, output: 'all good' })).errors, 0, 'a command that passed reports nothing');
  assert.deepEqual(Object.keys(summarizeCheck('error: no entry module found').byFile), ['(other)'], 'no file named, no attribution');
});
