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
import { Bonsai, Jev, loopingLineStart, periodicStart, postJson, repetitionStart, validateAnswers } from '../src/clients.js';
import { fenceFor, trimContext, confidentChoice, evictOne, mergeCoverage, relevantFiles, repoOverview, staleFor, clipEnds } from '../src/context.js';
import { namedFiles, pinReferences, referenceContext } from '../src/references.js';
import { objectiveClauses } from '../src/control.js';
import { newSession } from '../src/agent.js';
import { dirtySessionConflict } from '../src/cli.js';
import { extractCode, focusedEditSchema, samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { collectSteps, renderReport, speed } from '../src/report.js';
import { Display, describe, generationSpeed } from '../src/display.js';
import { commandWords, configFile, declaredName, lockfiles, manifestOf, shellPrefixFor, undeclaredPackages, unresolvedImports, detectProjects, projectFor, ecosystems, importSpelling, importsFor, languageFor, moduleCandidates, regexDeclarations, signaturesFor, sourceFile, syntaxCheck, verificationClass } from '../src/profiles.js';
import { manifestFailures, installCommand, repositoryStatus, solutionTsconfigReferences, checkUnusable, checkAdvice, assertBalancePreserved, completionSource, hash, runCommand, safePath, sourceHashes, StaleWriteError, stripLiterals, ToolBox, summarizeCheck, syntaxErrors, assertNoBulkDuplication, treeChanges, treeSnapshot, dropDuplicateImports, exportedSignatures, importCandidates, relativeImports, statementBounds } from '../src/tools.js';
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
test('Schemas reject unknown arguments and unbounded reads', () => {
  assert.throws(() => validate(schemas.bash, { command: 'pwd', purpose: 'check', unsafe: true }));
  assert.throws(() => validate(schemas.read_files, { files: [] }));
});
test('llama grammar compatibility: every cap validated after generation is one the grammar enforced, and content fields carry no cap', () => {
  // A cap the sampling schema drops would discard a finished generation: none may remain in the validated schema.
  const dropped = (s: any, w: any): string[] => [...(s.maxLength !== undefined && w.maxLength === undefined ? ['maxLength'] : []), ...Object.keys(s.properties ?? {}).flatMap(k => dropped(s.properties[k], w.properties[k])), ...(s.items ? dropped(s.items, w.items) : [])];
  for (const [route, schema] of Object.entries(schemas)) assert.deepEqual(dropped(schema, samplingSchema(schema)), [], `${route} validates a cap the grammar does not enforce`);
  assert.throws(() => validate(schemas.read_files, { files: [{ path: 'x'.repeat(501), start: 1, end: 2 }] }), /string length 501 exceeds the maximum 500/);
  // Code and prose are never capped after generation: the grammar cannot enforce a length, so a cap on content is a rule that discards a finished generation.
  assert.throws(() => validate(schemas.move_lines, { source: 'a', expectedHash: 'h', start: 1, end: 2, destination: 'b', destinationHash: 'new', replacement: '' }), /unknown property replacement/, 'a move is a plain cut and paste: nothing to add around it');
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

test('Sampling comes from the config: reasoning turns and file content each send their own temperature and min_p; the defaults are what the server did before', async t => {
  const bodies: Record<string, any[]> = { chat: [], completion: [] };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') { bodies.chat!.push(b); return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"command":"pwd","purpose":"p","check":false}' } }] })); }
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: 'P' }));
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/completion') { bodies.completion!.push(b); return res.end(JSON.stringify({ content: 'x', tokens: [120], stop_type: 'word', tokens_predicted: 1, timings: {} })); }
    res.statusCode = 404; res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const plain = new Bonsai({ ...defaults, baseUrl }, 'local', noop);
  await plain.generate([{ role: 'user', content: 'u' }], schemas.bash); await plain.generateText([{ role: 'user', content: 'u' }], { fence: null });
  assert.deepEqual([bodies.chat![0].temperature, bodies.chat![0].min_p], [.2, .05]); assert.deepEqual([bodies.completion![0].temperature, bodies.completion![0].min_p], [.3, .05]);
  const varied = new Bonsai({ ...defaults, baseUrl, stepTemperature: .7, stepMinP: .1, codeTemperature: .6, codeMinP: .08 }, 'local', noop);
  await varied.generate([{ role: 'user', content: 'u' }], schemas.bash); await varied.generateText([{ role: 'user', content: 'u' }], { fence: null });
  assert.deepEqual([bodies.chat![1].temperature, bodies.chat![1].min_p], [.7, .1]); assert.deepEqual([bodies.completion![1].temperature, bodies.completion![1].min_p], [.6, .08]);
  await assert.rejects(loadConfig(undefined, { stepMinP: 1 }), /stepMinP must be between 0 and 1/);
  await assert.rejects(loadConfig(undefined, { codeTemperature: 3 }), /codeTemperature must be above 0 and at most 2/);
  const example = await loadConfig(new URL('../../leana.example.json', import.meta.url).pathname);
  assert.equal(example.codeMinP, .05, 'the example config loads');
});

test('Routing returns the argmax option with margin tolerance and survives a mismatched choice field', () => {
  const c = { ...defaults, routeProbability: .4, routeMargin: .01 };
  assert.equal(confidentChoice({ type: 'choice', choice: 'read_files', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'write', probabilities: { read_files: .41, write: .40 }, confidence: .5 }, c), 'read_files');
  assert.equal(confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: .5, b: .5 }, confidence: .5 }, c), null);
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
  // JSX closes the same tag at the same depth many times; recurring lines are code, only a back-to-back run is a loop.
  const jsx = Array.from({ length: 10 }, (_, i) => [`        <div className="card-${i}">`, `          <p>{items[${i}].text}</p>`, '        </div>']).flat().join('\n');
  assert.equal(repetitionStart(jsx), -1, 'a closing tag that recurs across a component is not a loop');
});
test('periodicStart finds a loop inside one line and leaves real content alone', async () => {
  // The shape of a run's Footer: an SVG path whose numbers fell into a cycle for 12,000 tokens.
  const head = 'export default function Footer() {\n  return <svg><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385';
  const looping = head + ' 0 0.267 0 0.4 0 0.133'.repeat(60);
  const at = periodicStart(looping); assert(at > head.length - 40 && at <= head.length + 22, `cut near the start of the cycle: ${at}`);
  assert.equal(periodicStart(looping.slice(0, head.length + 22 * 20)), -1, 'a short run is not yet a loop');
  // Real content: a path of varied numbers, a data array, a stylesheet, a divider comment.
  const path = 'd="' + Array.from({ length: 300 }, (_, i) => `L${(i * 37) % 1440},${(i * 53) % 120}`).join(' ') + '"';
  const data = '[' + Array.from({ length: 400 }, (_, i) => i * 3).join(', ') + ']';
  const css = Array.from({ length: 60 }, (_, i) => `.card--${i} { margin: ${i}px; padding: ${i * 2}px; }`).join('\n');
  const divider = `/* ${'='.repeat(76)} */\nconst a = 1;\n`;
  for (const honest of [path, data, css, divider]) assert.equal(periodicStart(honest), -1, honest.slice(0, 40));
  const { validate, schemas } = await import('../src/schema.js');
  assert.doesNotThrow(() => validate(schemas.bash, { command: `cat > src/a.ts <<'EOF'\n${'const a = 1;\n'.repeat(400)}EOF`, purpose: 'write', check: false }), 'a long command the grammar let through is not discarded afterwards');
});
test('loopingLineStart catches a loop inside one line whose values drift, which no exact cycle finds, and leaves real long lines alone', () => {
  // The shape of react-demo-24's Footer: an icon path that fell into a cycle whose signs and digits drift, so it never repeats exactly.
  const unit = ['.28', '.57', '.85', '.27', '.48', '.21', '.56', '.79', '.31', '.8', '.23', '.37', '.11', '.16'];
  // A cycle whose signs drop out at random, 2% of the time: never exact, as in the recorded loop.
  let s0 = 7; const r0 = () => (s0 = (s0 * 48271) % 2147483647) / 2147483647;
  let drift = ''; for (let i = 0; drift.length < 6000; i++) drift += `${r0() < .02 ? '' : '-'}${unit[i % unit.length]}`;
  const looping = `      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.7 9.8 8.9 11.18${drift}`;
  assert.equal(periodicStart(looping), -1, 'no exact cycle: the old check misses it');
  assert.equal(loopingLineStart(looping), 0, 'cut at the start of the looping line');
  assert.equal(loopingLineStart(`const a = 1;\n${looping}`), 13);
  // Real long lines: a varied path, a data array, minified code.
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const path = 'd="' + Array.from({ length: 700 }, () => `l${(rnd() * 40 - 20).toFixed(2)} ${(rnd() * 40 - 20).toFixed(2)}`).join('') + '"';
  const data = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${Math.floor(rnd() * 1e6)}`, score: +(rnd() * 100).toFixed(3) })));
  const minified = Array.from({ length: 400 }, (_, i) => `function f${i}(a,b){return a${['+', '*', '-'][i % 3]}b*${Math.floor(rnd() * 1000)}}`).join(';');
  for (const honest of [path, data, minified]) assert.equal(loopingLineStart(honest), -1, honest.slice(0, 40));
  assert.equal(loopingLineStart(looping.slice(0, 2500)), -1, 'a line shorter than the window is not judged');
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
  assert.deepEqual(requests[0].prompt, [...rendered].map(c => c.codePointAt(0)), 'the opening fence is part of the prompt'); assert.deepEqual(requests[0].stop, ['\n```']); assert.equal(requests[0].n_predict, 64); assert.equal(requests[0].cache_prompt, true); assert.equal(requests[0].dry_multiplier, undefined, 'no repetition penalty on code');
  assert.deepEqual(requests[1].prompt, [...requests[0].prompt, ...[...'const a = 1;\n'].map(c => c.codePointAt(0))], 'the continuation is the same ids plus the ones generated, never a re-tokenized string');
  // A chunk that loops is cut at the first repeat and reported as such; no continuation is spent on it.
  const loop = Array.from({ length: 6 }, () => ['<div className="feature">', '  <h3>Fast</h3>', '  <p>Really fast builds.</p>', '</div>']).flat().join('\n');
  script = [{ content: `const b = 2;\n${loop}\n`, stop_type: 'limit' }];
  const r = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(r.finish, 'repetition'); assert(r.text.startsWith('const b = 2;\n<div className="feature">')); assert(r.text.split('\n').length < 12, 'cut at the first repeat'); assert.equal(script.length, 0);
  // A chunk that loops inside one line is cut where the cycle starts, reported as repetition, not continued.
  script = [{ content: `const c = <path d="M0 0${' 0 0.267 0 0.4 0 0.133'.repeat(60)}`, stop_type: 'limit' }];
  const p = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(p.finish, 'repetition'); assert(p.text.length < 60, p.text); assert.equal(script.length, 0);
  // A chunk that loops inside one line with drifting values is cut at the start of that line.
  const unit = ['.28', '.57', '.85', '.27', '.48', '.21', '.56', '.79', '.31', '.8', '.23', '.37', '.11', '.16'];
  let s1 = 7; const r1 = () => (s1 = (s1 * 48271) % 2147483647) / 2147483647;
  let drift = ''; for (let i = 0; drift.length < 4000; i++) drift += `${r1() < .02 ? '' : '-'}${unit[i % unit.length]}`;
  script = [{ content: `const d = 1;\n<path d="M0 0${drift}`, stop_type: 'limit' }];
  const dl = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(dl.finish, 'repetition'); assert.equal(dl.text, 'const d = 1;\n'); assert.equal(script.length, 0);
  // What a cut discards is logged, so the next loop can be measured rather than guessed at.
  const logged: [string, any][] = [];
  const logging = new Bonsai({ ...defaults, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, maxTokens: 64, createTokens: 200, contextWindow: 4000, workingTokens: 2000, safetyTokens: 100 }, 'local', async (type, data) => { logged.push([type, data]); });
  script = [{ content: `const d = 1;\n<path d="M0 0${drift}`, stop_type: 'limit' }];
  await logging.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx', context: { step: 7, route: 'create_file' } });
  const cut = logged.find(([type]) => type === 'repetition-cut')![1];
  assert.equal(cut.step, 7); assert.equal(cut.kept, 13); assert(cut.generated > 4000 && cut.discardedTail.endsWith(drift.slice(-100)));
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
test('Profiles carry the ecosystem, language and stack knowledge: detected from the repository, never named by the loop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-profiles-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ids = async () => (await detectProjects(root)).map(p => `${p.eco.id}:${p.dir}`);
  assert.deepEqual(await ids(), [], 'no manifest, no project');
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n'); assert.deepEqual(await ids(), ['python:.']);
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n[dependencies]\nserde = "1"\n'); assert.deepEqual(await ids(), ['python:.', 'rust:.'], 'every ecosystem present is a project, not the first found');
  await writeFile(join(root, 'package.json'), '{"name":"x"}'); assert.deepEqual(await ids(), ['node:.', 'python:.', 'rust:.']);
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
test('Lockfiles and manifests are known through the profiles: a package manager rewrite is never an unaccounted file, and the setup fix targets the manifest the repository has', () => {
  for (const l of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock']) assert(lockfiles().includes(l), `${l} is a lockfile`);
  assert(!lockfiles().includes('package.json') && !lockfiles().includes('pyproject.toml'));
  assert.equal(manifestOf(['src/a.py', 'requirements.txt', 'api/pyproject.toml']), 'api/pyproject.toml', 'the primary manifest, wherever it sits');
  assert.equal(manifestOf(['src/a.rs', 'Cargo.toml']), 'Cargo.toml'); assert.equal(manifestOf(['src/a.ts']), null);
});

test('A type\'s contract carries its members in any language', async () => {
  const py = await signaturesFor('app/models.py', 'from dataclasses import dataclass, field\n\n@dataclass\nclass Task:\n    """A task."""\n    id: str\n    title: str\n    created_at: str = field(default_factory=now)\n    _cache: dict = field(default_factory=dict)\n\n    def __post_init__(self) -> None:\n        datetime.fromisoformat(self.created_at)\n\n    def mark_done(self) -> "Task":\n        return self\n\n    def _hidden(self):\n        pass\n\nclass _Private:\n    x: int\n\ndef helper() -> None:\n    pass\n');
  assert.deepEqual(py, ['class Task\n    id: str\n    title: str\n    created_at: str\n    def __post_init__(self) -> None\n    def mark_done(self) -> "Task"', 'def helper() -> None'], `fields and public methods, dunder kept, private dropped: ${JSON.stringify(py)}`);
  const rs = await signaturesFor('src/config.rs', 'pub struct Config {\n    pub name: String,\n    port: u16,\n}\n\nimpl Config {\n    pub fn load() -> Config { todo!() }\n}\n\npub enum Mode { Fast, Safe }\n');
  assert.deepEqual(rs, ['pub struct Config\n    pub name: String,\n    port: u16,', 'pub enum Mode'], `rust fields: ${JSON.stringify(rs)}`);
  const go = await signaturesFor('pkg/s.go', 'type Server struct {\n\tPort int\n\thost string\n}\n\nfunc (s *Server) Start() error { return nil }\n');
  assert.deepEqual(go, ['type Server struct\n    Port int\n    host string', 'func (s *Server) Start() error']);
});



test('A created file that imports a name its repository module does not declare is repaired against what the module declares (languages without a checker)', async () => {
  const files: Record<string, string> = { 'src/task_manager/repository.py': 'from .models import Task\n\nclass TaskRepository:\n    def load(self) -> list[Task]:\n        return []\n\ndef _private():\n    pass\n', 'src/task_manager/__init__.py': 'from .repository import TaskRepository\n' };
  const read = async (p: string) => files[p] ?? null;
  const errs = await unresolvedImports('tests/test_repository.py', 'from task_manager.repository import TaskRegistry, Task\nfrom task_manager import TaskRepository\nimport json\n', read);
  assert.equal(errs.length, 1); assert.match(errs[0]!, /^contract: tests\/test_repository\.py imports TaskRegistry from task_manager\.repository \(src\/task_manager\/repository\.py\), which does not declare it; it declares TaskRepository, Task\./, errs[0]);
  assert.deepEqual(await unresolvedImports('tests/test_repository.py', 'from task_manager.repository import TaskRepository\nfrom task_manager import TaskRepository\n', read), [], 'declared and re-exported names resolve');
  assert.deepEqual(await unresolvedImports('src/a.ts', "import { Nope } from './b';", async () => 'export const b = 1;'), [], 'TypeScript is left to its checker');
});

test('A check summary is the exit code and the repository files its output names, whatever tool printed it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-summary-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const f of ['src/a.ts', 'src/b.tsx', 'app/models.py', 'src/main.rs', 'web/src/App.tsx']) { await mkdir(join(root, f, '..'), { recursive: true }); await writeFile(join(root, f), 'x\n'); }
  await mkdir(join(root, 'node_modules', 'lib'), { recursive: true }); await writeFile(join(root, 'node_modules', 'lib', 'index.js'), 'x\n');
  const output = [
    "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    `  File "${root}/app/models.py", line 45, in __post_init__`,
    ' --> src/main.rs:4:13',
    `    at ${root}/node_modules/lib/index.js:10:7`,
    'FAIL src/b.tsx > renders',
    'src/missing.ts:9: not a file of the repository',
    'App.tsx:12:3 - error from a check run inside web/src',
    'see https://example.com/docs.html for help',
  ].join('\n');
  const s = await summarizeCheck(JSON.stringify({ command: 'check', output, code: 2 }), root, ['web/src/App.tsx']);
  assert.equal(s.code, 2);
  assert.deepEqual(s.files, { 'src/a.ts': [3], 'app/models.py': [45], 'src/main.rs': [4], 'src/b.tsx': [], 'web/src/App.tsx': [12] });
  assert.deepEqual(await summarizeCheck('all good', root), { code: null, files: {} }, 'plain text with no file named: nothing attributed');
});

test('Objective clauses come only from a list the user wrote; prose is judged whole', () => {
  assert.deepEqual(objectiveClauses('Bootstrap a React app with the latest and greatest best practices, a landing page and components'), [], 'no grammar parsing of prose');
  assert.deepEqual(objectiveClauses('Build the app:\n- a landing page\n* a pricing table\n1. a contact form\n2) tests for the form'), ['a landing page', 'a pricing table', 'a contact form', 'tests for the form']);
  assert.deepEqual(objectiveClauses('Do one thing:\n- only this'), [], 'a single item is the objective itself');
});

test('What a command changed is read from the tree: created, modified and deleted files, never dependency trees or what git ignores', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-tree-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true }); await writeFile(join(root, 'src', 'a.ts'), 'a\n'); await writeFile(join(root, 'src', 'gone.ts'), 'g\n');
  await mkdir(join(root, '.venv'), { recursive: true }); await writeFile(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  const before = (await treeSnapshot(root))!;
  const r = await runCommand('bash', ['-c', 'cat > src/App.tsx <<EOF\nexport const App = 1;\nEOF\necho more >> src/a.ts; rm src/gone.ts; mkdir -p node_modules/x dist .venv/lib; echo 1 > node_modules/x/i.js; echo 1 > .venv/lib/m.py; echo 1 > dist/out.js'], root, 10000);
  assert.equal(r.code, 0);
  let changes = await treeChanges(root, before, (await treeSnapshot(root))!);
  assert.deepEqual(changes.created.sort(), ['dist/out.js', 'src/App.tsx']); assert.deepEqual(changes.deleted, ['src/gone.ts']); assert(changes.changed.includes('src/a.ts'));
  assert(!changes.changed.some(p => p.startsWith('node_modules/') || p.startsWith('.venv/')), 'installed environments are not edits');
  if ((await runCommand('git', ['init', '-q'], root, 10000)).code === 0) {
    await writeFile(join(root, '.gitignore'), 'dist/\n');
    const again = (await treeSnapshot(root))!; await writeFile(join(root, 'dist', 'out2.js'), '2\n'); await writeFile(join(root, 'src', 'b.ts'), 'b\n');
    changes = await treeChanges(root, again, (await treeSnapshot(root))!);
    assert.deepEqual(changes.changed, ['src/b.ts'], 'build output git ignores is not an edit');
  }
});

test('Every ecosystem in every manifest directory is a project: a JavaScript frontend beside a Python backend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-projects-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web', 'src'), { recursive: true }); await mkdir(join(root, 'api', 'app'), { recursive: true }); await mkdir(join(root, 'web', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^19' } }));
  await writeFile(join(root, 'web', 'node_modules', 'dep', 'package.json'), '{}');
  await writeFile(join(root, 'api', 'requirements.txt'), 'flask==3.0\n');
  const projects = await detectProjects(root);
  assert.deepEqual(projects.map(p => `${p.eco.id}:${p.dir}`).sort(), ['node:web', 'python:api'], 'a manifest inside node_modules is not a project');
  assert.equal((await projectFor(root, 'web/src/App.tsx', projects))!.dir, 'web'); assert.equal((await projectFor(root, 'api/app/main.py', projects))!.eco.id, 'python');
  assert.equal(await projects.find(p => p.eco.id === 'node')!.eco.installCommand(root, 'web', true), 'cd web && npm install --no-audit --no-fund', 'installed in its own directory');
  assert.deepEqual(await undeclaredPackages(root, 'web/src/App.tsx', "import React from 'react';\nimport clsx from 'clsx';\n", async () => null), ['clsx'], 'the frontend file is judged by the frontend manifest');
});

test('The files the objective names are pinned by the harness; chunks that do not all fit are ranked, and a changed file is pinned again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-refs-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  const plan = Array.from({ length: 400 }, (_, i) => i === 250 ? 'The checkout page must show the order total.' : `filler line ${i + 1} of the plan`).join('\n');
  await writeFile(join(root, 'docs', 'PLAN.md'), plan);
  const s = await newSession(root, 'Implement the checkout described in PLAN.md, see src/missing.ts too.');
  assert.deepEqual(await namedFiles(root, s.objective, s.knownFiles), ['docs/PLAN.md'], 'a bare name resolves to the one known file ending with it; a missing file is not pinned');
  const queries: string[] = [];
  const rank = async (query: string, chunks: string[]) => { queries.push(query); return chunks.map(c => /order total/.test(c) ? .95 : .05); };
  assert.deepEqual(await pinReferences(s, root, rank), ['docs/PLAN.md']);
  assert(queries.length >= 1 && queries.every(q => q.includes('docs/PLAN.md')));
  const shown = referenceContext(s, 3000);
  assert(shown.some(e => /251: The checkout page must show the order total\./.test(e.text)), 'the best-ranked chunk is shown within the budget');
  assert(shown.every((e, i) => i === 0 || e.start! > shown[i - 1]!.start!), 'in document order');
  assert.deepEqual(await pinReferences(s, root, rank), [], 'unchanged: not read or ranked again');
  await writeFile(join(root, 'docs', 'PLAN.md'), 'short plan now\n');
  assert.deepEqual(await pinReferences(s, root, rank), ['docs/PLAN.md']);
  assert.deepEqual(referenceContext(s, 3000).map(e => e.text), ['1: short plan now\n2: '], 'the new version replaces the old, unranked when it fits');
});

test('move_lines is a plain cut and paste: nothing is exported, imported or rewritten around the moved lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-move-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, '.leana'), { recursive: true });
  const source = "import { x } from './x.js';\nfunction helper() {\n  return x;\n}\nexport const y = helper();\n";
  await writeFile(join(root, 'src', 'a.ts'), source);
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  const r = await tools.execute('move_lines', { source: 'src/a.ts', expectedHash: hash(source), start: 2, end: 4, destination: 'src/helper.ts', destinationHash: 'new' });
  assert.equal(r.ok, true); assert.deepEqual(r.changed, ['src/a.ts', 'src/helper.ts']);
  assert.equal(await readFile(join(root, 'src', 'a.ts'), 'utf8'), "import { x } from './x.js';\nexport const y = helper();\n");
  assert.equal(await readFile(join(root, 'src', 'helper.ts'), 'utf8'), 'function helper() {\n  return x;\n}\n');
  assert.match(r.text, /nothing else in either file was changed/);
});
