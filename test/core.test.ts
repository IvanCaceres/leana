import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  bashPath,
  runMark,
  shellEnv,
  stopMarked,
  venvBin,
  windowsArgs,
  windowsExe,
  windowsLeft,
} from '../src/shell.js';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaults as baseDefaults, loadConfig } from '../src/config.js';
// The onset ledger makes a generation the older call-order stubs do not expect; tests enable it explicitly.
const defaults = { ...baseDefaults };
import {
  Bonsai,
  Jev,
  cyclingLine,
  echoOf,
  lineCut,
  periodic,
  periodicStart,
  postJson,
  requestTimeoutMs,
  repetitionStart,
  validateAnswers,
} from '../src/clients.js';
import {
  fenceFor,
  trimContext,
  confidentChoice,
  evictOne,
  mergeCoverage,
  relevantFiles,
  repoOverview,
  staleFor,
  clip,
  clipEnds,
  lineDiff,
  shownIn,
} from '../src/context.js';
import { namedFiles, pinReferences, referenceContext } from '../src/references.js';
import { objectiveClauses } from '../src/control.js';
import { newSession } from '../src/agent.js';
import { dirtySessionConflict } from '../src/cli.js';
import { extractCode, focusedEditSchema, samplingSchema, schemas, validate } from '../src/schema.js';
import { Store } from '../src/store.js';
import { collectSteps, renderReport, speed } from '../src/report.js';
import { addUsage, Display, describe, generationSpeed, noUsage, usageLine, usageOf } from '../src/display.js';
import {
  commandWords,
  configFile,
  declaredName,
  lockfiles,
  manifestOf,
  shellPrefixFor,
  undeclaredPackages,
  unresolvedImports,
  detectProjects,
  projectFor,
  ecosystems,
  importSpelling,
  importsFor,
  languageFor,
  moduleCandidates,
  regexDeclarations,
  signaturesFor,
  sourceFile,
  syntaxCheck,
  verificationClass,
  blockBalance,
  componentFormats,
  componentProblems,
  parseFact,
  parseInProcess,
} from '../src/profiles.js';
import {
  manifestFailures,
  installCommand,
  repositoryStatus,
  solutionTsconfigReferences,
  checkUnusable,
  checkAdvice,
  completionSource,
  sourceHashes,
  summarizeCheck,
} from '../src/repository.js';
import {
  assertBalancePreserved,
  StaleWriteError,
  stripLiterals,
  assertNoBulkDuplication,
  dropDuplicateImports,
  rangeEchoes,
} from '../src/edit-checks.js';
import { fileLimit, hash, safePath, treeChanges, treeSnapshot, TreeHashes } from '../src/files.js';
import { runCommand, describeProcesses, groupProcesses } from '../src/commands.js';
import { ToolBox } from '../src/tools.js';
import {
  syntaxErrors,
  exportedSignatures,
  importCandidates,
  problemAt,
  problemKey,
  relativeImports,
  statementBounds,
} from '../src/code.js';
import type { Answers, Questions } from '../src/types.js';

const noop = async () => {};
function answersFor(q: Questions, route = 'read_files', complete = 0.99): Answers {
  return Object.fromEntries(
    Object.entries(q).map(([id, question]) => [
      id,
      question.type === 'noul'
        ? {
            type: 'noul',
            noul:
              id === 'complete' ||
              id === 'objective_met' ||
              id.startsWith('supported_') ||
              id.startsWith('implemented_') ||
              id.startsWith('required_')
                ? complete
                : 0.1,
          }
        : 'supports' in question.criteria
          ? {
              type: 'choice',
              choice: 'supports',
              confidence: 1,
              probabilities: { supports: complete, contradicts: 1 - complete, says_nothing: 0 },
            }
          : {
              type: 'choice',
              choice: route,
              confidence: 1,
              probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, k === route ? 1 : 0])),
            },
    ]),
  ) as Answers;
}
test('Jev validates distribution, answer types, membership and finite probabilities', () => {
  const q: Questions = {
    r: { type: 'choice', instructions: 'route', criteria: { a: 'A', b: 'B' } },
    n: { type: 'noul', instructions: 'yes?' },
  };
  const valid = {
    r: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.5 },
    n: { type: 'noul', noul: 0.9 },
  };
  assert.deepEqual(validateAnswers(q, valid), valid);
  assert.throws(() => validateAnswers(q, { ...valid, n: { type: 'noul', noul: NaN } }));
  assert.throws(() => validateAnswers(q, { ...valid, r: { ...valid.r, choice: 'c' } }));
  assert.throws(() => validateAnswers(q, { ...valid, r: { ...valid.r, probabilities: { a: 0.4, b: 0.4 } } }));
  assert.equal((validateAnswers(q, { ...valid, r: { ...valid.r, choice: 'b' } }) as any).r.choice, 'a');
  assert.throws(() => validateAnswers(q, {}));
});
test('Routing uses choice probability and margin, not confidence as correctness', () => {
  assert.equal(
    confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: 0.51, b: 0.49 }, confidence: 0.99 }, defaults),
    null,
  );
  assert.equal(
    confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.3 }, defaults),
    'a',
  );
});
test('Configuration rejects impossible context reserves and unknown options', async () => {
  await assert.rejects(loadConfig(undefined, { contextWindow: 12000 }));
  await assert.rejects(loadConfig(undefined, { maxSteps: 2.5 }));
  await assert.rejects(loadConfig(undefined, { routeProbability: 1 }));
});
test('Jev HTTP request uses documented state/questions wire shape', async t => {
  let seen: any;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-test', answers: { ok: { type: 'noul', noul: 0.99 } } }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const c = { ...defaults, jevUrl: `http://127.0.0.1:${address.port}/v1/systemone` };
  const result = await new Jev(c, 'test-key', noop).decide(
    { evidence: 'passed' },
    { ok: { type: 'noul', instructions: 'Passed?' } },
  );
  assert.equal(result.ok?.type, 'noul');
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.path, '/v1/systemone');
  assert.deepEqual(seen.body.state, { evidence: 'passed' });
  assert.equal(seen.body.model, 'jev-latest');
});
test('HTTP retries transient responses but never retries authentication errors', async t => {
  let requests = 0;
  let status = 529;
  const server = createServer((_req, res) => {
    requests++;
    if (status === 529 && requests > 1) {
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = status;
    res.setHeader('retry-after', '0');
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  assert.deepEqual(await postJson(url, {}, 'test', 1000), { ok: true });
  assert.equal(requests, 2);
  status = 401;
  requests = 0;
  await assert.rejects(postJson(url, {}, 'test', 1000));
  assert.equal(requests, 1);
});
test('Schemas reject unknown arguments and unbounded reads', () => {
  assert.throws(() => validate(schemas.bash, { command: 'pwd', purpose: 'check', unsafe: true }));
  assert.throws(() => validate(schemas.read_files, { files: [] }));
});
test('llama grammar compatibility: every cap validated after generation is one the grammar enforced, and content fields carry no cap', () => {
  // A cap the sampling schema drops would discard a finished generation: none may remain in the validated schema.
  const dropped = (s: any, w: any): string[] => [
    ...(s.maxLength !== undefined && w.maxLength === undefined ? ['maxLength'] : []),
    ...Object.keys(s.properties ?? {}).flatMap(k => dropped(s.properties[k], w.properties[k])),
    ...(s.items ? dropped(s.items, w.items) : []),
  ];
  for (const [route, schema] of Object.entries(schemas))
    assert.deepEqual(
      dropped(schema, samplingSchema(schema)),
      [],
      `${route} validates a cap the grammar does not enforce`,
    );
  assert.throws(
    () => validate(schemas.read_files, { files: [{ path: 'x'.repeat(501), start: 1, end: 2 }] }),
    /string length 501 exceeds the maximum 500/,
  );
  // Code and prose are never capped after generation: the grammar cannot enforce a length, so a cap on content is a rule that discards a finished generation.
  assert.throws(
    () =>
      validate(schemas.move_lines, {
        source: 'a',
        expectedHash: 'h',
        start: 1,
        end: 2,
        destination: 'b',
        destinationHash: 'new',
        replacement: '',
      }),
    /unknown property replacement/,
    'a move is a plain cut and paste: nothing to add around it',
  );
  validate(schemas.write, { path: 'a.ts', expectedHash: 'h', oldText: 'y'.repeat(700), newText: 'z'.repeat(30000) });
  validate(schemas.replace_lines, {
    path: 'a.ts',
    expectedHash: 'h',
    edits: [{ start: 1, end: 1, newText: 'n'.repeat(20000), prepend: '' }],
  });
  validate(schemas.finish, { summary: 's'.repeat(9000) });
  assert.deepEqual(Object.keys(schemas.create_file.properties!), ['path', 'purpose']);
  assert.deepEqual(Object.keys(focusedEditSchema.properties!), ['edits']);
});
test('Malformed generated arguments are rejected by Bonsai before effects', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions')
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"command":"pwd"}' } }] }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const bonsai = new Bonsai(
    { ...defaults, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` },
    'local',
    noop,
  );
  await assert.rejects(bonsai.generate([{ role: 'user', content: 'test' }], schemas.bash), /missing purpose/);
});

test('Sampling comes from the config: reasoning turns and file content each send their own temperature and min_p; the defaults are what the server did before', async t => {
  const bodies: Record<string, any[]> = { chat: [], completion: [] };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      bodies.chat!.push(b);
      return res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"command":"pwd","purpose":"p","check":false}' } }],
        }),
      );
    }
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: 'P' }));
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/completion') {
      bodies.completion!.push(b);
      return res.end(
        JSON.stringify({ content: 'x', tokens: [120], stop_type: 'word', tokens_predicted: 1, timings: {} }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const plain = new Bonsai({ ...defaults, baseUrl }, 'local', noop);
  await plain.generate([{ role: 'user', content: 'u' }], schemas.bash);
  await plain.generateText([{ role: 'user', content: 'u' }], { fence: null });
  assert.deepEqual([bodies.chat![0].temperature, bodies.chat![0].min_p], [0.2, 0.05]);
  assert.deepEqual(
    [
      bodies.completion![0].temperature,
      bodies.completion![0].min_p,
      bodies.completion![0].top_p,
      bodies.completion![0].top_k,
      bodies.completion![0].presence_penalty,
    ],
    [0.3, 0.05, 0.9, 20, 0],
    'code: the sampling of the runs that worked, the presence penalty off',
  );
  const varied = new Bonsai(
    { ...defaults, baseUrl, stepTemperature: 0.7, stepMinP: 0.1, codeTemperature: 0.6, codeMinP: 0.08 },
    'local',
    noop,
  );
  await varied.generate([{ role: 'user', content: 'u' }], schemas.bash);
  await varied.generateText([{ role: 'user', content: 'u' }], { fence: null });
  assert.deepEqual([bodies.chat![1].temperature, bodies.chat![1].min_p], [0.7, 0.1]);
  assert.deepEqual([bodies.completion![1].temperature, bodies.completion![1].min_p], [0.6, 0.08]);
  await assert.rejects(loadConfig(undefined, { stepMinP: 1 }), /stepMinP must be between 0 and 1/);
  await assert.rejects(loadConfig(undefined, { codeTemperature: 3 }), /codeTemperature must be above 0 and at most 2/);
  const example = await loadConfig(fileURLToPath(new URL('../../leana.example.json', import.meta.url)));
  assert.equal(example.codeMinP, 0.05, 'the example config loads');
});

test('Routing returns the argmax option with margin tolerance and survives a mismatched choice field', () => {
  const c = { ...defaults, routeProbability: 0.4, routeMargin: 0.01 };
  assert.equal(
    confidentChoice(
      { type: 'choice', choice: 'read_files', probabilities: { read_files: 0.41, write: 0.4 }, confidence: 0.5 },
      c,
    ),
    'read_files',
  );
  assert.equal(
    confidentChoice(
      { type: 'choice', choice: 'write', probabilities: { read_files: 0.41, write: 0.4 }, confidence: 0.5 },
      c,
    ),
    'read_files',
  );
  assert.equal(
    confidentChoice({ type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 }, c),
    null,
  );
});

test('The terminal display redraws a status panel in place and falls back to lines off a terminal', () => {
  const tty: string[] = [];
  const plain: string[] = [];
  const d = new Display(
    { write: (s: string) => tty.push(s), isTTY: true, columns: 120 },
    { objective: 'Move the block', session: 'run-1', verbose: false },
  );
  const p = new Display(
    { write: (s: string) => plain.push(s), isTTY: false },
    { objective: 'Move the block', session: 'run-1', verbose: true },
  );
  const meta = {
    ms: 2000,
    usage: { completion_tokens: 70, prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 500 } },
    timings: { predicted_per_second: 35.5, prompt_per_second: 430 },
    finishReason: 'stop',
    promptTokens: 3000,
  };
  const events = [
    { kind: 'step', step: 1, phase: 'inspect', maxStep: 80 },
    {
      kind: 'jev',
      step: 1,
      ms: 412,
      questions: 3,
      stateBytes: 4200,
      route: [
        ['read_files', 0.8],
        ['search_codebase', 0.2],
      ],
      nouls: { complete: 0.02 },
    },
    { kind: 'route', step: 1, route: 'read_files', tokens: 3000, entries: 0 },
    {
      kind: 'context',
      step: 1,
      tokens: 3000,
      workingTokens: 12000,
      contextWindow: 48000,
      breakdown: { system: 400, evidence: 2, files: 1200 },
      entries: 0,
    },
    { kind: 'generating', step: 1, route: 'read_files', attempt: 1 },
    { kind: 'generated', step: 1, route: 'read_files', meta, args: { files: [{ path: 'a.ts', start: 1, end: 1 }] } },
    { kind: 'result', step: 1, route: 'read_files', ok: true, ms: 12, chars: 114, text: 'a.ts sha256=x' },
    { kind: 'stop', step: 1, status: 'paused', reason: 'step limit' },
  ] as const;
  for (const e of events) {
    d.update(e as any);
    p.update(e as any);
  }
  d.close();
  const panel = d.panel().join('\n');
  assert.match(panel, /step 1\/80 \| inspect \| PAUSED: step limit/);
  assert.match(
    panel,
    /Jev +412ms \| 3 q \| state 4\.2k \| read_files 0\.80 \| search_codebase 0\.20 \| complete 0\.02/,
  );
  assert.match(panel, /median 412ms \| p95 412ms \| 1 calls/);
  assert.match(
    panel,
    /Context +\[#####\.{15}\] 3\.0k \/ 12\.0k working \(25%\) \| window 48\.0k \(6%\) \| 0 entries \| files 1\.2k/,
  );
  assert.match(panel, /Bonsai +2\.0s \| 70 tokens @ 35\.5 tok\/s \| prompt @ 430 tok\/s \| 500 cached/);
  assert.match(panel, /avg 35\.5 tok\/s \| 70 generated \| last 3\.0k in \(500 cached, 17%\) \| 70 out/);
  assert.match(
    panel,
    /Usage +1 request \| 3\.0k in \(500 cached, 17%\) \| 70 out$/m,
    'what the provider reported; no cost from llama-server',
  );
  // A provider that states the cost (OpenRouter): the requests summed, the cost with them.
  const total = noUsage();
  for (const cost of [0.0021, 0.0042])
    addUsage(
      total,
      usageOf({
        ms: 1,
        promptTokens: 1,
        usage: { prompt_tokens: 50000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 45000 }, cost },
      })!,
    );
  assert.equal(usageLine(total), '2 requests | 100.0k in (90.0k cached, 90%) | 1.8k out | $0.006');
  assert.equal(usageOf({ ms: 1, promptTokens: 1 }), null, 'no usage reported: nothing counted');
  assert.match(panel, /Last +\[1\] read_files ok 12ms -> 114 chars: a\.ts sha256=x/);
  assert.match(panel, /Totals +read_files 1 \| 0 edits \| 0 commands \| 0 failures \| 0 undo/);
  assert(
    tty.some(s => s.includes('\x1b[') && s.includes('A\x1b[J')),
    'panel is cleared with cursor movement before redraw',
  );
  assert(
    tty.some(s => s.startsWith('[1] read_files | 3000 prompt tokens')),
    'the step line scrolls above the panel',
  );
  assert.deepEqual(plain.filter(s => s.includes('bonsai 2.0s')).length, 1);
  assert(plain.every(s => !s.includes('\x1b[')));
  assert(
    d.panel().every(l => /^[\x20-\x7e]*$/.test(l)),
    'panel is ASCII only',
  );
  assert.equal(describe({ kind: 'stop', step: 1, status: 'paused', reason: 'x' }, true), null);
  assert.deepEqual(generationSpeed(null), { generated: null, perSecond: null, promptPerSecond: null, cached: null });
});

test('The panel never fills the last column, so redraws do not leak lines', () => {
  const out: string[] = [];
  const d = new Display(
    { write: (s: string) => out.push(s), isTTY: true, columns: 80 },
    { objective: 'x'.repeat(300), session: 's', verbose: false },
  );
  const lines = d.panel();
  assert(
    lines.every(l => l.length <= 79),
    `longest ${Math.max(...lines.map(l => l.length))}`,
  );
  assert.equal(lines[0]!.length, 79);
});

test('Panel lines are flattened to one row each, counting any non-ASCII character as two cells', () => {
  const out: string[] = [];
  const d = new Display(
    { write: (s: string) => out.push(s), isTTY: true, columns: 100 },
    { objective: 'x', session: 's', verbose: false },
  );
  d.update({
    kind: 'generated',
    step: 1,
    route: 'bash',
    meta: null,
    args: { command: 'grep' + '\n[' + '…' + 'truncated' + '…' + ']\n' + '修'.repeat(200) },
  } as any);
  for (const l of d.panel()) {
    assert(!/[\x00-\x1f\x7f-\x9f]/.test(l), l);
    assert([...l].reduce((n, c) => n + (c < '\x7f' ? 1 : 2), 0) <= 99, l);
  }
});

test('Creation names only the path; content is generated as code and never validated for length', () => {
  validate(schemas.create_file, { path: 'src/pages/LandingPage.tsx', purpose: 'the landing page' });
  assert.throws(
    () => validate(schemas.create_file, { path: 'a.tsx', purpose: 'p', content: 'x' }),
    /unknown property content/,
  );
  validate(schemas.write, { path: 'a.ts', expectedHash: 'h', oldText: 'y'.repeat(700), newText: 'z' });
  assert.equal(extractCode('Here you go:\n```tsx\nexport const A = 1;\n```\nDone.'), 'export const A = 1;\n');
  assert.equal(extractCode('```\nline\n'), 'line\n', 'a block cut short by the budget has no closing fence');
  assert.equal(extractCode('plain text with no fence'), 'plain text with no fence\n');
});

test('repetitionStart finds a looping tail and leaves honest repetition alone', () => {
  const block = ['  <li>Item</li>', '  <li>Item</li>', '  <li>Item</li>'];
  const looping = [
    'const a = 1;',
    ...Array.from({ length: 5 }, () => [
      '<div className="feature">',
      '  <h3>Fast</h3>',
      '  <p>Really fast builds.</p>',
      '</div>',
    ]).flat(),
  ].join('\n');
  const at = repetitionStart(looping);
  assert(at >= 1 && at <= 5, `first repeat at ${at}`);
  assert.equal(
    repetitionStart(['const a = 1;', ...block, 'const b = 2;'].join('\n')),
    -1,
    'three identical lines are not a loop',
  );
  assert.equal(
    repetitionStart(['const a = 1;', ...Array.from({ length: 10 }, () => '  <li>Item</li>')].join('\n')),
    -1,
    'ten identical rows are data (run pacman-1: maze rows)',
  );
  assert.equal(
    repetitionStart(['const a = 1;', ...Array.from({ length: 12 }, () => '  <li>Item</li>')].join('\n')),
    2,
    'twelve identical substantive lines are a loop, from the second',
  );
  // A three-row pattern twice in a row after an earlier occurrence is data, not a block repeated three times back to back (run pacman-1 steps 2 and 6).
  const rows = ['##.#.##.##.##.##.##.##.##.#', '##.#.##.##.##.##.##.##.##.#', '##.#...##.##.##.##...##.##.#'];
  assert.equal(
    repetitionStart(['const m = [', ...rows, '##.##.##.##.##.##.##.##.##.#', ...rows, ...rows, '];'].join('\n')),
    -1,
  );
  const honest = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  assert.equal(repetitionStart(honest), -1);
  assert.equal(repetitionStart(Array.from({ length: 12 }, () => '}').join('\n')), -1, 'closing braces are not content');
  // JSX closes the same tag at the same depth many times; recurring lines are code, only a back-to-back run is a loop.
  const jsx = Array.from({ length: 10 }, (_, i) => [
    `        <div className="card-${i}">`,
    `          <p>{items[${i}].text}</p>`,
    '        </div>',
  ])
    .flat()
    .join('\n');
  assert.equal(repetitionStart(jsx), -1, 'a closing tag that recurs across a component is not a loop');
});
test('periodicStart finds a loop inside one line and leaves real content alone', async () => {
  // The shape of a run's Footer: an SVG path whose numbers fell into a cycle for 12,000 tokens.
  const head =
    'export default function Footer() {\n  return <svg><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385';
  const looping = head + ' 0 0.267 0 0.4 0 0.133'.repeat(60);
  const at = periodicStart(looping);
  assert(at > head.length - 40 && at <= head.length + 22, `cut near the start of the cycle: ${at}`);
  assert.equal(periodicStart(looping.slice(0, head.length + 22 * 20)), -1, 'a short run is not yet a loop');
  // Real content: a path of varied numbers, a data array, a stylesheet, a divider comment.
  const path = 'd="' + Array.from({ length: 300 }, (_, i) => `L${(i * 37) % 1440},${(i * 53) % 120}`).join(' ') + '"';
  const data = '[' + Array.from({ length: 400 }, (_, i) => i * 3).join(', ') + ']';
  const css = Array.from({ length: 60 }, (_, i) => `.card--${i} { margin: ${i}px; padding: ${i * 2}px; }`).join('\n');
  const divider = `/* ${'='.repeat(76)} */\nconst a = 1;\n`;
  for (const honest of [path, data, css, divider]) assert.equal(periodicStart(honest), -1, honest.slice(0, 40));
  const { validate, schemas } = await import('../src/schema.js');
  assert.doesNotThrow(
    () =>
      validate(schemas.bash, {
        command: `cat > src/a.ts <<'EOF'\n${'const a = 1;\n'.repeat(400)}EOF`,
        purpose: 'write',
        check: false,
      }),
    'a long command the grammar let through is not discarded afterwards',
  );
});
test('A generation request is allowed the time to process a cold prompt, and a burst of fast decoding never shrinks its allowance', () => {
  // react-demo-42 step 28: a 31,767-token rewrite prompt after an eviction was aborted at 72 s, before its ~85 s of prompt processing ended.
  const cold = requestTimeoutMs(31767, 1024, 35);
  assert(cold >= 60000 + 212000, `a cold 31.8k prompt gets its processing time (${cold} ms)`);
  assert.equal(
    requestTimeoutMs(0, 1024, 35),
    60000 + 59000,
    'a continuation, whose prompt is cached, gets decode time only',
  );
  assert.equal(
    requestTimeoutMs(0, 1024, 123),
    requestTimeoutMs(0, 1024, 60),
    'a measured 123 tok/s from accepted drafts counts as 60',
  );
});
// Recorded generations of this model (fixtures/cycling): in-line loops as the chunk that showed them ended, and a Footer that finished normally.
const cycling = fileURLToPath(new URL('../../test/fixtures/cycling/', import.meta.url));
const cyclingMeta = JSON.parse(readFileSync(`${cycling}meta.json`, 'utf8')) as {
  loops: { file: string; id: string; tokens: number; previousBoundaryChars: number; cutAt: number }[];
  legit: { file: string; why: string }[];
};
const cyclingStart = (text: string) => cyclingLine(text)?.start ?? -1;
test('cyclingLine cuts each recorded in-line loop at the start of its line, at the first 1024-token chunk that shows the cycle over 3,000 characters', () => {
  for (const l of cyclingMeta.loops) {
    const text = readFileSync(`${cycling}loops/${l.file}`, 'utf8');
    assert.equal(cyclingStart(text), l.cutAt, `${l.id} at ${l.tokens} tokens`);
    assert.equal(text[l.cutAt - 1], '\n', `${l.id}: the cut is a line start`);
    assert.equal(
      cyclingStart(text.slice(0, l.previousBoundaryChars)),
      -1,
      `${l.id} one chunk earlier: not yet a cycle over 3,000 characters`,
    );
  }
  const footer = readFileSync(`${cycling}loops/react-demo-54-step14.txt`, 'utf8');
  assert.equal(footer.slice(0, 3845).split('\n').length, 99);
  assert.equal(cyclingLine(footer)!.unit, 888, 'run 54 Footer line 99 repeats one 888-character unit');
  for (const f of cyclingMeta.legit) {
    const text = readFileSync(`${cycling}legit/${f.file}`, 'utf8');
    for (let e = 64; e <= text.length; e += 16)
      assert.equal(cyclingStart(text.slice(0, e)), -1, `${f.file} (${f.why}) at ${e}`);
  }
});
test('a periodic run is cut at the start of its line, and the cut reports the line, its opening, its uncut length and the unit', () => {
  // Run 54 step 13 as generated: periodicStart fired mid-line and left 2,172 characters of line 99 in the file, which every later rewrite copied back into the loop.
  const body = readFileSync(`${cycling}loops/react-demo-54-step13-uncut.txt`, 'utf8');
  const hit = periodic(body)!;
  assert.equal(hit.start, 6017);
  assert.equal(hit.unit, 118);
  const { kept, cut } = lineCut(body, hit.start, 'cycle', hit.unit);
  assert.equal(kept.length, 3845);
  assert(kept.endsWith('\n'));
  assert.deepEqual(
    { line: cut.line, lineChars: cut.lineChars, unit: cut.unit },
    { line: 99, lineChars: 4039, unit: 118 },
  );
  assert(cut.opening.startsWith('<path d="M12 0c-6.626'), cut.opening);
  assert.equal(
    lineCut('a\nbcd', 2, 'cycle').kept,
    'a\n',
    'a run that starts exactly at a line start keeps the lines before it',
  );
  assert.equal(lineCut('abc', 1, 'cycle').kept, '', 'a run in the first line keeps nothing');
});
test('cyclingLine: the rule on synthetic lines, and real long lines it leaves alone', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const num = () => (rnd() * 20 - 10).toFixed(3);
  const unit = Array.from({ length: 66 }, () => `${num()} ${num()}`).join('c'); // ~870 characters, no inner period
  const head = '      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.7 9.8 8.9 11.18';
  const looping = head + unit.repeat(4);
  assert.equal(cyclingStart(looping), 0, 'a unit repeated verbatim, ~3,500 characters: cut at the line start');
  assert.equal(cyclingStart(`const a = 1;\n${looping}`), 13);
  assert.equal(cyclingStart(head + unit + unit.slice(0, 700)), -1, 'less than two full copies is not yet a cycle');
  const filler = Array.from({ length: 90 }, () => `${num()} ${num()}`).join('l'); // ~1,200 varied characters
  assert.equal(
    cyclingStart(head + filler + unit.repeat(3)),
    -1,
    'three copies of ~870 characters (~2,600) are under the 3,000-character span',
  );
  assert.equal(cyclingStart(head + filler + unit.repeat(4)), 0, 'four copies (~3,500) are a cycle');
  assert.equal(cyclingStart(`${looping}\n  </svg>`), -1, 'a line that ended is not judged');
  const big = Array.from({ length: 170 }, () => `${num()} ${num()}`).join('c'); // ~2,300 characters
  assert.equal(cyclingStart(head + big + big), -1, 'a unit longer than 2,000 characters is not looked for');
  const varied = 'd="' + Array.from({ length: 700 }, () => `l${num()} ${num()}`).join('') + '"';
  const data = JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `item-${Math.floor(rnd() * 1e6)}`,
      score: +(rnd() * 100).toFixed(3),
    })),
  );
  const minified = Array.from(
    { length: 400 },
    (_, i) => `function f${i}(a,b){return a${['+', '*', '-'][i % 3]}b*${Math.floor(rnd() * 1000)}}`,
  ).join(';');
  const classes = `<div className="${Array.from({ length: 300 }, (_, i) => ['flex', 'items-center', `gap-${i % 12}`, `md:px-${i % 9}`, 'hover:bg-slate-100'][i % 5]).join(' ')}">`;
  for (const honest of [varied, data, minified, classes]) assert.equal(cyclingStart(honest), -1, honest.slice(0, 40));
});
test('generateText continues by token ids with the fence prefilled, stops on the closing fence, cuts a loop, and repairs a broken character', async t => {
  // A mock llama-server: tokens are character codes; /completion replies from a script and records the prompts it received.
  const requests: any[] = [];
  let script: { content: string; stop_type: string; tokens?: number[] }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/apply-template')
      return res.end(
        JSON.stringify({
          prompt: `<|im_start|>system\n${b.messages[0].content}<|im_end|>\n<|im_start|>assistant\n${b.chat_template_kwargs?.enable_thinking ? '' : '<think>\n\n</think>\n\n'}`,
        }),
      );
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/detokenize')
      return res.end(JSON.stringify({ content: String.fromCodePoint(...b.tokens).replace(/�/g, 'é') }));
    if (req.url === '/completion') {
      requests.push(b);
      const r = script.shift()!;
      return res.end(
        JSON.stringify({
          content: r.content,
          tokens: r.tokens ?? [...r.content].map(c => c.codePointAt(0)),
          stop_type: r.stop_type,
          tokens_predicted: r.tokens?.length ?? [...r.content].length,
          timings: { predicted_per_second: 30 },
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const bonsai = new Bonsai(
    {
      ...defaults,
      stepThinking: false,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      maxTokens: 64,
      createTokens: 200,
      contextWindow: 4000,
      workingTokens: 2000,
      safetyTokens: 100,
    },
    'local',
    noop,
  );
  // Two chunks: the first stops at the chunk size, the second at the closing fence.
  script = [
    { content: 'const a = 1;\n', stop_type: 'limit' },
    { content: 'export { a };', stop_type: 'word' },
  ];
  const g = await bonsai.generateText([{ role: 'system', content: 'S' }], {
    fence: '```ts',
    context: { step: 1, route: 'create_file' },
  });
  assert.equal(g.text, 'const a = 1;\nexport { a };');
  assert.equal(g.finish, 'stop');
  assert.equal(g.meta.continuations, 1);
  assert.equal(g.meta.usage.completion_tokens, 26);
  const rendered = '<|im_start|>system\nS<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n```ts\n';
  assert.deepEqual(
    requests[0].prompt,
    [...rendered].map(c => c.codePointAt(0)),
    'the opening fence is part of the prompt',
  );
  assert.deepEqual(requests[0].stop, ['\n```']);
  assert.equal(requests[0].n_predict, 64);
  assert.equal(requests[0].cache_prompt, true);
  assert.equal(requests[0].dry_multiplier, undefined, 'no repetition penalty on code');
  assert.deepEqual(
    requests[1].prompt,
    [...requests[0].prompt, ...[...'const a = 1;\n'].map(c => c.codePointAt(0))],
    'the continuation is the same ids plus the ones generated, never a re-tokenized string',
  );
  // A closing fence split across two chunks (its line break ends one, its backticks start the next) is not
  // seen by the server, which matches a stop word within one request: the text ends where the fence starts.
  script = [
    { content: 'const a = 1;\n', stop_type: 'limit' },
    { content: '```\n\nThat is the file.', stop_type: 'eos' },
  ];
  const split = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  assert.deepEqual(
    { text: split.text, finish: split.finish, left: script.length },
    { text: 'const a = 1;', finish: 'stop', left: 0 },
  );
  // A chunk that loops is cut at the first repeat and reported as such; no continuation is spent on it.
  const loop = Array.from({ length: 6 }, () => [
    '<div className="feature">',
    '  <h3>Fast</h3>',
    '  <p>Really fast builds.</p>',
    '</div>',
  ])
    .flat()
    .join('\n');
  script = [{ content: `const b = 2;\n${loop}\n`, stop_type: 'limit' }];
  const r = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(r.finish, 'repetition');
  assert(r.text.startsWith('const b = 2;\n<div className="feature">'));
  assert(r.text.split('\n').length < 12, 'cut at the first repeat');
  assert.equal(script.length, 0);
  assert.equal(r.cut?.kind, 'lines');
  assert(r.text.endsWith('\n'), 'whole lines only');
  // A chunk that loops inside one line is cut at the start of that line, reported as repetition, not continued.
  script = [{ content: `const c = <path d="M0 0${' 0 0.267 0 0.4 0 0.133'.repeat(60)}`, stop_type: 'limit' }];
  const p = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(p.finish, 'repetition');
  assert.equal(p.text, '', 'the looping line never reaches the file');
  assert.equal(script.length, 0);
  assert.deepEqual({ kind: p.cut?.kind, line: p.cut?.line, unit: p.cut?.unit }, { kind: 'cycle', line: 1, unit: 22 });
  // A long unit (as recorded: 19 to 1,875 characters) repeated verbatim over 3,000 characters is cut at the start of its line.
  let s1 = 7;
  const r1 = () => (s1 = (s1 * 48271) % 2147483647) / 2147483647;
  const unit = Array.from({ length: 66 }, () => `${(r1() * 20 - 10).toFixed(3)} ${(r1() * 20 - 10).toFixed(3)}`).join(
    'c',
  );
  const drift = `<path d="M0 0${unit.repeat(4)}`;
  script = [{ content: `const d = 1;\n${drift}`, stop_type: 'limit' }];
  const dl = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(dl.finish, 'repetition');
  assert.equal(dl.text, 'const d = 1;\n');
  assert.equal(script.length, 0);
  assert.equal(dl.cut?.line, 2);
  assert.equal(dl.cut?.unit, unit.length);
  assert(dl.cut!.opening.startsWith('<path d="M0 0'));
  // What a cut discards is logged, so the next loop can be measured rather than guessed at.
  const logged: [string, any][] = [];
  const logging = new Bonsai(
    {
      ...defaults,
      stepThinking: false,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      maxTokens: 64,
      createTokens: 200,
      contextWindow: 4000,
      workingTokens: 2000,
      safetyTokens: 100,
    },
    'local',
    async (type, data) => {
      logged.push([type, data]);
    },
  );
  script = [{ content: `const d = 1;\n<path d="M0 0${drift}`, stop_type: 'limit' }];
  await logging.generateText([{ role: 'system', content: 'S' }], {
    fence: '```tsx',
    context: { step: 7, route: 'create_file' },
  });
  const cut = logged.find(([type]) => type === 'repetition-cut')![1];
  assert.equal(cut.step, 7);
  assert.equal(cut.kept, 13);
  assert(cut.generated > 3000 && cut.discardedTail.endsWith(drift.slice(-100)));
  assert.equal(cut.cut.line, 2);
  // A chunk that ends inside a character, followed by a looping line: the detectors judge the repaired text, and the cut stays cut.
  script = [
    {
      content: 'const s = "caf�',
      stop_type: 'limit',
      tokens: [...'const s = "caf'].map(c => c.codePointAt(0)!).concat(233),
    },
    { content: `";\n${drift}`, stop_type: 'limit' },
  ];
  const bc = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.equal(bc.finish, 'repetition');
  assert.equal(bc.text, 'const s = "café";\n', 'the repair of the broken character does not restore the cut line');
  // Short lines repeated (closing braces) are found by the periodic check across line ends and reported as repeating lines, not as one line.
  script = [{ content: `function f() {\n  if (a) {\n${'    }\n'.repeat(200)}`, stop_type: 'limit' }];
  const ml = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  assert.equal(ml.finish, 'repetition');
  assert.equal(ml.text, 'function f() {\n  if (a) {\n');
  assert.equal(ml.cut?.kind, 'lines');
  assert.equal(ml.cut?.unit, undefined);
  // An end-of-generation stop after a repaired character: the end token in the ids is not written into the text.
  script = [
    {
      content: 'const s = "caf�',
      stop_type: 'limit',
      tokens: [...'const s = "caf'].map(c => c.codePointAt(0)!).concat(233),
    },
    {
      content: '";\nexport default s;\n',
      stop_type: 'eos',
      tokens: [...'";\nexport default s;\n'].map(c => c.codePointAt(0)!).concat(151645),
    },
  ];
  const eo = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null });
  assert.equal(eo.text, 'const s = "café";\nexport default s;\n');
  // A fenced file that reaches the budget inside a line: the unfinished line is left out and reported.
  script = [{ content: `const a = 1;\nconst b = "${'x'.repeat(60)}`, stop_type: 'limit' }];
  const bl = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', budgetTokens: 40 });
  assert.equal(bl.finish, 'length');
  assert.equal(bl.text, 'const a = 1;\n');
  assert.deepEqual(
    { kind: bl.cut?.kind, line: bl.cut?.line, lineChars: bl.cut?.lineChars },
    { kind: 'budget', line: 2, lineChars: 71 },
  );
  // A chunk ending in a broken character is re-derived from the token ids.
  script = [
    { content: 'caf�', stop_type: 'limit', tokens: [99, 97, 102, 233] },
    { content: ' au lait', stop_type: 'eos' },
  ];
  const d = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null });
  assert.equal(d.text, 'café au lait');
  assert.equal(d.finish, 'stop');
  // With thinking, the reply is rendered without the empty thought block, the thought is stripped, and an overlong thought is closed by the harness.
  script = [
    { content: '<think>plan the files', stop_type: 'limit' },
    { content: 'here is the design', stop_type: 'eos' },
  ];
  const th = await bonsai.generateText([{ role: 'system', content: 'S' }], {
    fence: null,
    thinking: true,
    thinkingBudget: 10,
    budgetTokens: 200,
  });
  assert.equal(th.text, 'here is the design');
  assert.equal(
    requests
      .at(-1)
      .prompt.slice(-11)
      .map((c: number) => String.fromCodePoint(c))
      .join(''),
    '\n</think>\n\n',
    'the thought was closed before the answer was asked for',
  );
  // The budget ends a generation cleanly as length, not as an error.
  script = Array.from({ length: 6 }, () => ({ content: 'x'.repeat(64), stop_type: 'limit' }));
  const l = await bonsai.generateText([{ role: 'system', content: 'S' }], { fence: null, budgetTokens: 200 });
  assert.equal(l.finish, 'length');
  assert(l.text.length >= 200 && l.text.length <= 256, `generated ${l.text.length} characters`);
  // A region's block is checked every 128 tokens for a repeat of the lines after the region, and stopped at it:
  // the kept text ends where the repeat starts, and nothing more is asked for.
  const wide = new Bonsai(
    {
      ...defaults,
      stepThinking: false,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      maxTokens: 8192,
      createTokens: 12000,
      contextWindow: 64000,
      workingTokens: 32000,
      safetyTokens: 100,
    },
    'local',
    noop,
  );
  const around = {
    before: 'import { x } from "./x"\n\nexport function a() {',
    region: '  return x(0)',
    after:
      '}\n\nexport function b(n: number) {\n  return x(n) * 2\n}\n\nexport const c = b(3)\nexport const d = 4\nexport const e = 5\nexport const f = 6\nexport const g = 7\nexport const h = 8\nexport const i = 9',
  };
  script = [
    { content: '  return x(1)\n}\n\nexport function b(n: number) {\n', stop_type: 'limit' },
    {
      content:
        '  return x(n) * 2\n}\n\nexport const c = b(3)\nexport const d = 4\nexport const e = 5\nexport const f = 6\nexport const g = 7\nexport const h = 8\nexport const i = 90\nexport',
      stop_type: 'limit',
    },
  ];
  const ec = await wide.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', around });
  assert.deepEqual(
    requests.slice(-2).map(r => r.n_predict),
    [128, 128],
  );
  assert.equal(script.length, 0, 'stopped: no third chunk');
  assert.equal(ec.finish, 'repetition');
  assert.equal(ec.text, '  return x(1)\n');
  assert.deepEqual(
    { kind: ec.cut?.kind, line: ec.cut?.line, echoed: ec.cut?.echoed, diverged: ec.cut?.diverged },
    { kind: 'echo', line: 2, echoed: 12, diverged: true },
    'lines 1..12 after the region, then other text',
  );
  // Four lines of it and the closing fence: not stopped (the end of the block is for trimContext to judge); without a region, chunks of 1024.
  script = [{ content: '  return x(1)\n}\n\nexport function b(n: number) {\n  return x(n) * 2\n}', stop_type: 'word' }];
  const four = await wide.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', around });
  assert.equal(four.finish, 'stop');
  assert.equal(four.cut, undefined);
  // A block that starts with the repeat, blank line first: nothing is kept, and the cut is at line 1.
  script = [
    {
      content:
        '\n}\n\nexport function b(n: number) {\n  return x(n) * 2\n}\n\nexport const c = b(3)\nexport const d = 4\nexport const e = 5\nexport const f = 6\nexport const g = 7\nexport const h = 8\n',
      stop_type: 'limit',
    },
  ];
  const whole = await wide.generateText([{ role: 'system', content: 'S' }], {
    fence: '```ts',
    around: { ...around, after: `\n${around.after}` },
  });
  assert.equal(whole.text, '');
  assert.deepEqual(
    { kind: whole.cut?.kind, line: whole.cut?.line, echoed: whole.cut?.echoed },
    { kind: 'echo', line: 1, echoed: 13 },
  );
  script = [{ content: 'const a = 1', stop_type: 'word' }];
  await wide.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  assert.equal(requests.at(-1).n_predict, 1024);
});
test("A code generation sends the user-message delimiter of the server's template, found from the server's rendering, so its prompt is checkpointed where a chat request of it would be", async t => {
  // A mock llama-server with a ChatML template (as this model's): tokens are character codes. mode 'folded' renders
  // the system message into the first user message, and 'down' fails the probe once.
  const completions: any[] = [];
  const probes: any[] = [];
  let mode = 'chatml';
  const logged: [string, any][] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/apply-template') {
      if (b.add_generation_prompt === false) {
        probes.push(b);
        if (mode === 'down') {
          mode = 'chatml';
          res.statusCode = 500;
          return res.end('{}');
        }
      }
      const ms: any[] = b.messages;
      const gen = b.add_generation_prompt === false ? '' : '<|im_start|>assistant\n<think>\n\n</think>\n\n';
      if (mode === 'folded')
        return res.end(
          JSON.stringify({
            prompt: `<start_of_turn>user\n${ms.map(m => m.content).join('\n\n')}<end_of_turn>\n${gen}`,
          }),
        );
      return res.end(
        JSON.stringify({ prompt: ms.map(m => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') + gen }),
      );
    }
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/completion') {
      completions.push(b);
      const stop = completions.length % 2 ? 'limit' : 'word';
      return res.end(
        JSON.stringify({
          content: 'const a = 1;\n',
          tokens: [...'const a = 1;\n'].map(c => c.codePointAt(0)),
          stop_type: stop,
          tokens_predicted: 13,
          timings: {},
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const config = {
    ...defaults,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    maxTokens: 64,
    createTokens: 200,
    contextWindow: 4000,
    workingTokens: 2000,
    safetyTokens: 100,
  };
  const bonsai = new Bonsai(config, 'local', async (type, data) => {
    logged.push([type, data]);
  });
  const messages = [
    { role: 'system' as const, content: 'S' },
    { role: 'user' as const, content: '{"objective":"o"}' },
    { role: 'assistant' as const, content: '{"thought":"t"}' },
    { role: 'user' as const, content: '{"notes":"n"}' },
    { role: 'user' as const, content: '{"role":"Write the file"}' },
  ];
  await bonsai.generateText(messages, { fence: '```ts' });
  assert.equal(completions.length, 2, 'a chunk and its continuation');
  for (const c of completions)
    assert.deepEqual(
      c.message_delimiters,
      [{ role: 'user', delimiter: '<|im_start|>user' }],
      'the continuation carries it too',
    );
  // The server matches the delimiter's tokens in the prompt: they stand at the start of each user message and nowhere else.
  const sent = String.fromCodePoint(...completions[0].prompt);
  const at = (x: string) => {
    const out: number[] = [];
    for (let i = sent.indexOf(x); i >= 0; i = sent.indexOf(x, i + 1)) out.push(i);
    return out;
  };
  assert.deepEqual(
    at('<|im_start|>user'),
    at('<|im_start|>').filter((_, k) => messages[k]?.role === 'user'),
  );
  assert.equal(logged.find(([type]) => type === 'bonsai-request')![1].userStart, '<|im_start|>user');
  await bonsai.generateText(messages, { fence: '```ts' });
  assert.equal(probes.length, 1, 'found once');
  assert.deepEqual(
    probes[0].messages.map((m: any) => m.role),
    ['system', 'user'],
  );
  // A template that shows no user-message start of its own (the system message folded into the first user message): no delimiters, as before.
  mode = 'folded';
  completions.length = 0;
  await new Bonsai(config, 'local', noop).generateText(messages, { fence: '```ts' });
  assert(completions.every(c => !('message_delimiters' in c)));
  // A probe that fails sends none and is asked again at the next generation.
  mode = 'down';
  completions.length = 0;
  const again = new Bonsai(config, 'local', noop);
  await again.generateText(messages, { fence: '```ts' });
  assert(completions.every(c => !('message_delimiters' in c)));
  await again.generateText(messages, { fence: '```ts' });
  assert.deepEqual(completions.at(-1).message_delimiters, [{ role: 'user', delimiter: '<|im_start|>user' }]);
});
test('A prompt counted to fit it is not rendered and tokenized again when it is sent; a code-generation prompt counted first is rendered once', async t => {
  const calls: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const b = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    calls[req.url!] = (calls[req.url!] ?? 0) + 1;
    if (req.url === '/apply-template')
      return res.end(
        JSON.stringify({
          prompt:
            b.messages.map((m: any) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') +
            (b.add_generation_prompt === false ? '' : '<|im_start|>assistant\n'),
        }),
      );
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/v1/chat/completions')
      return res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"command":"pwd","purpose":"p","check":false}' } }],
        }),
      );
    if (req.url === '/completion')
      return res.end(
        JSON.stringify({ content: 'x', tokens: [120], stop_type: 'word', tokens_predicted: 1, timings: {} }),
      );
    res.statusCode = 404;
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const logged: [string, any][] = [];
  const bonsai = new Bonsai(
    { ...defaults, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, stepThinking: false },
    'local',
    async (type, data) => {
      logged.push([type, data]);
    },
  );
  const a = [
    { role: 'system' as const, content: 'S' },
    { role: 'user' as const, content: 'step a' },
  ];
  const b = [
    { role: 'system' as const, content: 'S' },
    { role: 'user' as const, content: 'step b' },
  ];
  const counted = await bonsai.count(a);
  await bonsai.generate(a, schemas.bash);
  assert.deepEqual([calls['/apply-template'], calls['/tokenize']], [1, 1], 'counted once for the fit and the request');
  assert.deepEqual(logged.find(([type]) => type === 'bonsai-request')![1].prompt, counted);
  // Only the latest prompt is held: an equal copy of it is not counted again, a different one is, and so is an older one after it.
  await bonsai.count(JSON.parse(JSON.stringify(a)));
  await bonsai.count(b);
  await bonsai.count(a);
  assert.deepEqual([calls['/apply-template'], calls['/tokenize']], [3, 3]);
  // A prompt edited in place after its count is a different prompt.
  b[1]!.content = 'step b, edited';
  await bonsai.count(b);
  assert.deepEqual([calls['/apply-template'], calls['/tokenize']], [4, 4]);
  // A code-generation prompt: counted, then tokenized with its fence for the ids, rendered once (plus the delimiter's probe, once).
  await bonsai.count(a);
  await bonsai.generateText(a, { fence: '```ts' });
  assert.deepEqual([calls['/apply-template'], calls['/tokenize']], [5 + 1, 6]);
});
test('echoOf and trimContext: a block repeating the lines after its region, compared without blank lines, is cut where the repeat starts; single bracket lines and runs the file holds twice are not taken', () => {
  const echoes = fileURLToPath(new URL('../../test/fixtures/echo/', import.meta.url));
  const old = readFileSync(`${echoes}react-demo-73-step70-old.tsx.txt`, 'utf8').replace(/\n$/, '').split('\n');
  const block = readFileSync(`${echoes}react-demo-73-step70-block.tsx.txt`, 'utf8');
  const around = {
    before: old.slice(0, 84).join('\n'),
    region: old.slice(84, 100).join('\n'),
    after: old.slice(100).join('\n'),
  };
  // Run 73 step 70: old lines 102..244 without blank lines 101 and 115; line for line only its first line matches.
  assert.deepEqual(
    trimContext(block, around),
    { text: '', echo: { line: 1, echoed: 144, diverged: false } },
    'nothing but the repeat: the region is emptied',
  );
  const lines = block.split('\n');
  assert.equal(
    echoOf(lines.slice(0, 10).join('\n') + '\n', around, false),
    null,
    'while generating: nine lines with content are not enough',
  );
  assert.deepEqual(
    echoOf(lines.slice(0, 11).join('\n') + '\n', around, false),
    { line: 1, echoed: 12, diverged: false },
    'ten are (block line 5 is blank)',
  );
  // The recorded one-line repeats stay: `return (` across a blank line (react-demo-43 step 18) and `</html>` (react-demo-42 step 33).
  assert.equal(
    trimContext('export default function Footer() {\n  return (\n', {
      before: 'import x from "./x"',
      region: 'export default function Footer() {',
      after: '\n  return (\n    <footer>\n    </footer>\n  )\n}',
    }).echo,
    null,
  );
  assert.equal(
    trimContext('<body>\n</body>\n</html>\n', { before: '<html>', region: '<body></body>', after: '</html>' }).echo,
    null,
  );
  // Context lines repeated before the region go, with the blank line after them; two closing lines at the end go too (two lines are not ambiguous).
  assert.deepEqual(
    trimContext('  const a = compute(1)\n\n  const b = 2\n    </div>\n  </div>\n', {
      before: 'function f() {\n  const a = compute(1)',
      region: '  const b = 1',
      after: '    </div>\n  </div>\n)',
    }),
    { text: '  const b = 2\n', echo: { line: 2, echoed: 2, diverged: false } },
  );
  // A region of closing lines regenerated as it is, before the same closing lines: emptying the block would remove the region, so it stays.
  assert.deepEqual(
    trimContext('    </div>\n  </div>\n', {
      before: '<div>\n  <div>\n    <div>\n      <p>hi</p>',
      region: '    </div>\n  </div>',
      after: '  </div>\n</div>\n)',
    }),
    { text: '    </div>\n  </div>\n', echo: null },
  );
  // The ten first lines after the region, when the file holds them twice (repeated markup: here in the region too), are not a repeat while generating.
  const item =
    '<li className="card">\n  <h3>Fast builds</h3>\n  <p>Seconds, not minutes.</p>\n  <a href="/docs">Docs</a>\n  <span>New</span>\n  <img src="/fast.png" alt="" />\n  <small>Since 2026</small>\n  <em>Beta</em>\n  <b>Free</b>\n</li>';
  assert.equal(
    echoOf(
      `<ul>\n${item}\n<li className="card">\n`,
      { before: '<section>', region: `<ul>\n${item}`, after: `${item}\n</ul>\n</section>` },
      false,
    ),
    null,
  );
  assert.equal(
    echoOf(
      `<ul>\n${item}\n<li className="card">\n`,
      { before: '<section>', region: '<ul>', after: `${item}\n</ul>\n</section>` },
      false,
    )?.line,
    2,
    'held once: it is',
  );
});
test('Profiles carry the ecosystem, language and stack knowledge: detected from the repository, never named by the loop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = async () => (await detectProjects(root)).map(p => `${p.eco.id}:${p.dir}`);
  assert.deepEqual(await ids(), [], 'no manifest, no project');
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  assert.deepEqual(await ids(), ['python:.']);
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n[dependencies]\nserde = "1"\n');
  assert.deepEqual(await ids(), ['python:.', 'rust:.'], 'every ecosystem present is a project, not the first found');
  await writeFile(join(root, 'package.json'), '{"name":"x"}');
  assert.deepEqual(await ids(), ['node:.', 'python:.', 'rust:.']);
  const py = ecosystems.find(e => e.id === 'python')!;
  const rs = ecosystems.find(e => e.id === 'rust')!;
  const go = ecosystems.find(e => e.id === 'go')!;
  // System pip refuses installs on managed machines (PEP 668): the profile keeps a project venv. The install is staged: the
  // declared dependencies as soon as the manifest exists (the project has no sources yet), the project itself once it has.
  const vpy = `.venv/${venvBin}/python`;
  const deps = `${vpy} -c "import tomllib,sys;d=tomllib.load(open('pyproject.toml','rb'));p=d.get('project',{});x=list(p.get('dependencies',[]))\nfor v in p.get('optional-dependencies',{}).values(): x+=list(v)\nfor v in d.get('dependency-groups',{}).values(): x+=[i for i in v if isinstance(i,str)]\nprint('\\n'.join(x))" | xargs -r -d '\\n' ${vpy} -m pip install`;
  assert.equal(
    await py.installCommand(root, '.', false),
    `python3 -m venv .venv && ${deps} && printf '%s' 'deps' > .venv/.leana-installed`,
    'no sources yet: the dependencies only, and the stage is recorded',
  );
  await writeFile(join(root, 'requirements.txt'), 'requests>=2\n# c\nflask==3.0\n');
  assert.equal(
    await py.installCommand(root, '.', true),
    `python3 -m venv .venv && ${vpy} -m pip install -r requirements.txt && ${deps} && printf '%s' 'deps' > .venv/.leana-installed`,
  );

  await mkdir(join(root, '.venv', venvBin), { recursive: true });
  await writeFile(join(root, '.venv', venvBin, windowsExe('python')), '');
  await writeFile(join(root, '.venv', '.leana-installed'), 'deps');
  assert.equal(
    await py.installCommand(root, '.', false),
    null,
    'dependencies installed and still no sources: nothing to do',
  );
  await mkdir(join(root, 'src', 'x'), { recursive: true });
  await writeFile(join(root, 'src', 'x', '__init__.py'), '');
  assert.equal(
    await py.installCommand(root, '.', false),
    `${vpy} -m pip install --no-deps -e . && printf '%s' 'project' > .venv/.leana-installed`,
    'sources exist now: the project is installed, once',
  );
  await writeFile(join(root, '.venv', '.leana-installed'), 'project');
  assert.equal(await py.installCommand(root, '.', false), null, 'installed once, not again');
  assert.equal(
    await py.installCommand(root, '.', true),
    `${vpy} -m pip install -r requirements.txt && ${deps} && ${vpy} -m pip install --no-deps -e . && printf '%s' 'project' > .venv/.leana-installed`,
    'a manifest change installs again into the same venv',
  );
  assert.deepEqual(
    (await py.verificationCandidates(root)).map(c => c.command),
    [`${vpy} -m compileall -q -x '\\.venv' .`],
    'no test tool in the venv or the requirements: the interpreter syntax pass',
  );
  await writeFile(join(root, '.venv', venvBin, windowsExe('pytest')), '');
  await writeFile(join(root, '.venv', venvBin, windowsExe('mypy')), '');
  assert.deepEqual(
    (await py.verificationCandidates(root)).map(c => c.command).slice(0, 2),
    [`${vpy} -m mypy .`, `${vpy} -m pytest -q`],
    'the tools the venv has, static before test',
  );
  await rm(join(root, '.venv', venvBin, windowsExe('pytest')));
  await appendFile(join(root, 'requirements.txt'), 'pytest>=8\n');
  assert(
    (await py.verificationCandidates(root)).some(c => c.command === `${vpy} -m pytest -q`),
    'a declared test runner is a candidate before it is installed',
  );
  assert.deepEqual(await py.declared(root), ['requests@', 'flask@', 'pytest@']);
  assert.deepEqual(await rs.declared(root), ['serde@']);
  assert.equal(verificationClass('npm run typecheck', 'tsc --noEmit'), 'static');
  assert.equal(verificationClass('npm run build', 'vite build'), 'build');
  assert.equal(verificationClass('npm test', 'vitest run'), 'test');
  assert.equal(verificationClass('cargo clippy', ''), 'static');
  assert.equal(verificationClass('go test ./...', ''), 'test');
  assert.equal(verificationClass('python3 -m mypy .', ''), 'static');
  assert.equal(verificationClass('make docs', ''), null);
  assert(
    configFile('package.json') &&
      configFile('tsconfig.app.json') &&
      configFile('Cargo.toml') &&
      configFile('go.mod') &&
      configFile('index.html') &&
      !configFile('src/index.ts') &&
      !configFile('src/components/Button.tsx'),
  );
  assert.equal(languageFor('src/a.tsx')!.id, 'typescript');
  assert.equal(languageFor('lib/x.rs')!.id, 'rust');
  assert.equal(languageFor('app.py')!.id, 'python');
  assert.equal(languageFor('styles/a.scss')!.kind, 'style');
  assert.equal(languageFor('README.md'), null);
  assert(
    sourceFile('src/main.go') &&
      sourceFile('web/index.html') &&
      sourceFile('Foo.java') &&
      !sourceFile('data.json') &&
      !sourceFile('notes.md'),
  );
  assert.equal(languageFor('a.ts')!.publicPrefix!('function f() {'), 'export ');
  assert.equal(languageFor('a.ts')!.publicPrefix!('export function f() {'), null);
  assert.equal(languageFor('a.rs')!.publicPrefix!('fn f() {'), 'pub ');
  assert.equal(languageFor('a.rs')!.publicPrefix!('pub fn f() {'), null);
  assert.equal(languageFor('a.py')!.publicPrefix, undefined);
  assert.equal(languageFor('a.tsx')!.callSite!('<Header>\n'), 'Header');
  assert.equal(languageFor('a.ts')!.callSite!('createRoot(el)'), 'createRoot');
  assert.equal(languageFor('a.rs')!.callSite!('serde_json::from_str(x)'), 'serde_json::from_str');
  assert.equal(languageFor('a.py')!.callSite!('client.get(url)'), 'client.get');
});

test('Syntax gates by language: the interpreter judges a Python file when the machine has one; a language without a tool has no gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = await syntaxCheck(root, 'app/main.py', 'def broken(:\n    pass\n');
  assert.equal(bad.length, 1, `one diagnostic: ${bad.join(' | ')}`);
  assert.match(
    bad[0]!,
    /^app\/main\.py\(1,\d+\): error: /,
    'attributed to the file, in the path(line,col) form the loop reads',
  );
  assert.deepEqual(await syntaxCheck(root, 'app/main.py', 'def fine():\n    return 1\n'), []);
  assert.deepEqual(
    await syntaxCheck(root, 'x.ts', 'const a: = 1;').then(d => d.length),
    1,
    'TypeScript keeps the in-process parser',
  );
  assert.deepEqual(
    await syntaxCheck(root, 'Main.java', 'this is not java'),
    [],
    'no tool for the language: no verdict, never a false rejection',
  );
});
test('Lockfiles and manifests are known through the profiles: a package manager rewrite is never an unaccounted file, and the setup fix targets the manifest the repository has', () => {
  for (const l of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock'])
    assert(lockfiles().includes(l), `${l} is a lockfile`);
  assert(!lockfiles().includes('package.json') && !lockfiles().includes('pyproject.toml'));
  assert.equal(
    manifestOf(['src/a.py', 'requirements.txt', 'api/pyproject.toml']),
    'api/pyproject.toml',
    'the primary manifest, wherever it sits',
  );
  assert.equal(manifestOf(['src/a.rs', 'Cargo.toml']), 'Cargo.toml');
  assert.equal(manifestOf(['src/a.ts']), null);
});

test("A type's contract carries its members in any language", async () => {
  const py = await signaturesFor(
    'app/models.py',
    'from dataclasses import dataclass, field\n\n@dataclass\nclass Task:\n    """A task."""\n    id: str\n    title: str\n    created_at: str = field(default_factory=now)\n    _cache: dict = field(default_factory=dict)\n\n    def __post_init__(self) -> None:\n        datetime.fromisoformat(self.created_at)\n\n    def mark_done(self) -> "Task":\n        return self\n\n    def _hidden(self):\n        pass\n\nclass _Private:\n    x: int\n\ndef helper() -> None:\n    pass\n',
  );
  assert.deepEqual(
    py,
    [
      'class Task\n    id: str\n    title: str\n    created_at: str\n    def __post_init__(self) -> None\n    def mark_done(self) -> "Task"',
      'def helper() -> None',
    ],
    `fields and public methods, dunder kept, private dropped: ${JSON.stringify(py)}`,
  );
  const rs = await signaturesFor(
    'src/config.rs',
    'pub struct Config {\n    pub name: String,\n    port: u16,\n}\n\nimpl Config {\n    pub fn load() -> Config { todo!() }\n}\n\npub enum Mode { Fast, Safe }\n',
  );
  assert.deepEqual(
    rs,
    ['pub struct Config\n    pub name: String,\n    port: u16,', 'pub enum Mode'],
    `rust fields: ${JSON.stringify(rs)}`,
  );
  const go = await signaturesFor(
    'pkg/s.go',
    'type Server struct {\n\tPort int\n\thost string\n}\n\nfunc (s *Server) Start() error { return nil }\n',
  );
  assert.deepEqual(go, ['type Server struct\n    Port int\n    host string', 'func (s *Server) Start() error']);
});

test('A created file that imports a name its repository module does not declare is repaired against what the module declares (languages without a checker)', async () => {
  const files: Record<string, string> = {
    'src/task_manager/repository.py':
      'from .models import Task\n\nclass TaskRepository:\n    def load(self) -> list[Task]:\n        return []\n\ndef _private():\n    pass\n',
    'src/task_manager/__init__.py': 'from .repository import TaskRepository\n',
  };
  const read = async (p: string) => files[p] ?? null;
  const errs = await unresolvedImports(
    'tests/test_repository.py',
    'from task_manager.repository import TaskRegistry, Task\nfrom task_manager import TaskRepository\nimport json\n',
    read,
  );
  assert.equal(errs.length, 1);
  assert.match(
    errs[0]!,
    /^contract: tests\/test_repository\.py imports TaskRegistry from task_manager\.repository \(src\/task_manager\/repository\.py\), which does not declare it; it declares TaskRepository, Task\./,
    errs[0],
  );
  assert.deepEqual(
    await unresolvedImports(
      'tests/test_repository.py',
      'from task_manager.repository import TaskRepository\nfrom task_manager import TaskRepository\n',
      read,
    ),
    [],
    'declared and re-exported names resolve',
  );
  assert.deepEqual(
    await unresolvedImports('src/a.ts', "import { Nope } from './b';", async () => 'export const b = 1;'),
    [],
    'TypeScript is left to its checker',
  );
});

test('A check summary is the exit code and the repository files its output names, whatever tool printed it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const f of ['src/a.ts', 'src/b.tsx', 'app/models.py', 'src/main.rs', 'web/src/App.tsx']) {
    await mkdir(join(root, f, '..'), { recursive: true });
    await writeFile(join(root, f), 'x\n');
  }
  await mkdir(join(root, 'node_modules', 'lib'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'lib', 'index.js'), 'x\n');
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
  assert.deepEqual(s.files, {
    'src/a.ts': [3],
    'app/models.py': [45],
    'src/main.rs': [4],
    'src/b.tsx': [],
    'web/src/App.tsx': [12],
  });
  assert.deepEqual(
    await summarizeCheck('all good', root),
    { code: null, files: {} },
    'plain text with no file named: nothing attributed',
  );
});

test('Objective clauses come only from a list the user wrote; prose is judged whole', () => {
  assert.deepEqual(
    objectiveClauses(
      'Bootstrap a React app with the latest and greatest best practices, a landing page and components',
    ),
    [],
    'no grammar parsing of prose',
  );
  assert.deepEqual(
    objectiveClauses('Build the app:\n- a landing page\n* a pricing table\n1. a contact form\n2) tests for the form'),
    ['a landing page', 'a pricing table', 'a contact form', 'tests for the form'],
  );
  assert.deepEqual(objectiveClauses('Do one thing:\n- only this'), [], 'a single item is the objective itself');
});

test('What a command changed is read from the tree: created, modified and deleted files, never dependency trees or what git ignores', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'a\n');
  await writeFile(join(root, 'src', 'gone.ts'), 'g\n');
  await mkdir(join(root, '.venv'), { recursive: true });
  await writeFile(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  const before = (await treeSnapshot(root))!;
  const r = await runCommand(
    'bash',
    [
      '-c',
      'cat > src/App.tsx <<EOF\nexport const App = 1;\nEOF\necho more >> src/a.ts; rm src/gone.ts; mkdir -p node_modules/x dist .venv/lib; echo 1 > node_modules/x/i.js; echo 1 > .venv/lib/m.py; echo 1 > dist/out.js',
    ],
    root,
    10000,
  );
  assert.equal(r.code, 0);
  let changes = await treeChanges(root, before, (await treeSnapshot(root))!);
  assert.deepEqual(changes.created.sort(), ['dist/out.js', 'src/App.tsx']);
  assert.deepEqual(changes.deleted, ['src/gone.ts']);
  assert(changes.changed.includes('src/a.ts'));
  assert(
    !changes.changed.some(p => p.startsWith('node_modules/') || p.startsWith('.venv/')),
    'installed environments are not edits',
  );
  if ((await runCommand('git', ['init', '-q'], root, 10000)).code === 0) {
    await writeFile(join(root, '.gitignore'), 'dist/\n');
    const again = (await treeSnapshot(root))!;
    await writeFile(join(root, 'dist', 'out2.js'), '2\n');
    await writeFile(join(root, 'src', 'b.ts'), 'b\n');
    changes = await treeChanges(root, again, (await treeSnapshot(root))!);
    assert.deepEqual(changes.changed, ['src/b.ts'], 'build output git ignores is not an edit');
  }
});

test("A file's content hash is known by its size and modification time: rewritten with the same bytes it hashes the same under a new signature; a signature not hashed is unknown, never guessed", async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-treehash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'same.svelte'), '{@each pets as pet}\n');
  await writeFile(join(root, 'src', 'other.ts'), 'a\n');
  await writeFile(join(root, 'big.txt'), Buffer.alloc(fileLimit + 1, 'a'));
  const past = new Date(Date.now() - 60000);
  for (const f of ['src/same.svelte', 'src/other.ts']) await utimes(join(root, f), past, past);
  const hashes = new TreeHashes();
  const before = (await treeSnapshot(root))!;
  await hashes.fill(root, before);
  assert.equal(
    hashes.at('src/same.svelte', before.get('src/same.svelte')),
    hash('{@each pets as pet}\n'),
    'the hash read_files shows',
  );
  assert.equal(hashes.at('big.txt', before.get('big.txt')), null, 'past the whole-file limit: not known');
  const r = await runCommand(
    'bash',
    ['-c', "cat > src/same.svelte <<'EOF'\n{@each pets as pet}\nEOF\nprintf 'b\\n' > src/other.ts"],
    root,
    10000,
  );
  assert.equal(r.code, 0);
  const after = (await treeSnapshot(root))!;
  assert.notEqual(after.get('src/same.svelte'), before.get('src/same.svelte'), 'the write moved the modification time');
  assert.equal(
    hashes.at('src/same.svelte', after.get('src/same.svelte')),
    null,
    'a signature not hashed yet is not known',
  );
  await hashes.fill(root, new Map(['src/same.svelte', 'src/other.ts'].map(p => [p, after.get(p)!])));
  assert.equal(
    hashes.at('src/same.svelte', after.get('src/same.svelte')),
    hash('{@each pets as pet}\n'),
    'same bytes, same hash',
  );
  assert.equal(hashes.at('src/other.ts', after.get('src/other.ts')), hash('b\n'));
  assert.equal(
    hashes.at('src/same.svelte', before.get('src/same.svelte')),
    null,
    'only the signature last hashed is answered',
  );
  // A signature the file no longer has (it changed after the snapshot) is not recorded against that snapshot.
  const stale = (await treeSnapshot(root))!;
  await writeFile(join(root, 'src', 'other.ts'), 'changed since the snapshot\n');
  await hashes.fill(root, new Map([['src/other.ts', stale.get('src/other.ts')!]]));
  assert.equal(
    hashes.at('src/other.ts', stale.get('src/other.ts')),
    hash('b\n'),
    'already hashed at that signature: not read again',
  );
  await hashes.fill(root, new Map([['src/other.ts', '2:1']]));
  assert.equal(hashes.at('src/other.ts', '2:1'), null, 'the file on disk does not have that signature');
});

test('Every ecosystem in every manifest directory is a project: a JavaScript frontend beside a Python backend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web', 'src'), { recursive: true });
  await mkdir(join(root, 'api', 'app'), { recursive: true });
  await mkdir(join(root, 'web', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^19' } }));
  await writeFile(join(root, 'web', 'node_modules', 'dep', 'package.json'), '{}');
  await writeFile(join(root, 'api', 'requirements.txt'), 'flask==3.0\n');
  const projects = await detectProjects(root);
  assert.deepEqual(
    projects.map(p => `${p.eco.id}:${p.dir}`).sort(),
    ['node:web', 'python:api'],
    'a manifest inside node_modules is not a project',
  );
  assert.equal((await projectFor(root, 'web/src/App.tsx', projects))!.dir, 'web');
  assert.equal((await projectFor(root, 'api/app/main.py', projects))!.eco.id, 'python');
  assert.equal(
    await projects.find(p => p.eco.id === 'node')!.eco.installCommand(root, 'web', true),
    'cd web && npm install --no-audit --no-fund',
    'installed in its own directory',
  );
  assert.deepEqual(
    await undeclaredPackages(
      root,
      'web/src/App.tsx',
      "import React from 'react';\nimport clsx from 'clsx';\n",
      async () => null,
    ),
    ['clsx'],
    'the frontend file is judged by the frontend manifest',
  );
});

test('The files the objective names are pinned by the harness; chunks that do not all fit are ranked, and a changed file is pinned again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  const plan = Array.from({ length: 400 }, (_, i) =>
    i === 250 ? 'The checkout page must show the order total.' : `filler line ${i + 1} of the plan`,
  ).join('\n');
  await writeFile(join(root, 'docs', 'PLAN.md'), plan);
  const s = await newSession(root, 'Implement the checkout described in PLAN.md, see src/missing.ts too.');
  assert.deepEqual(
    await namedFiles(root, s.objective, s.knownFiles),
    ['docs/PLAN.md'],
    'a bare name resolves to the one known file ending with it; a missing file is not pinned',
  );
  const queries: string[] = [];
  const rank = async (query: string, chunks: string[]) => {
    queries.push(query);
    return chunks.map(c => (/order total/.test(c) ? 0.95 : 0.05));
  };
  assert.deepEqual(await pinReferences(s, root, rank), ['docs/PLAN.md']);
  assert(queries.length >= 1 && queries.every(q => q.includes('docs/PLAN.md')));
  const shown = referenceContext(s, 3000);
  assert(
    shown.some(e => /251: The checkout page must show the order total\./.test(e.text)),
    'the best-ranked chunk is shown within the budget',
  );
  assert(
    shown.every((e, i) => i === 0 || e.start! > shown[i - 1]!.start!),
    'in document order',
  );
  assert.deepEqual(await pinReferences(s, root, rank), [], 'unchanged: not read or ranked again');
  await writeFile(join(root, 'docs', 'PLAN.md'), 'short plan now\n');
  assert.deepEqual(await pinReferences(s, root, rank), ['docs/PLAN.md']);
  assert.deepEqual(
    referenceContext(s, 3000).map(e => e.text),
    ['1: short plan now\n2: '],
    'the new version replaces the old, unranked when it fits',
  );
});

test('move_lines is a plain cut and paste: nothing is exported, imported or rewritten around the moved lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-move-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.leana'), { recursive: true });
  const source = "import { x } from './x.js';\nfunction helper() {\n  return x;\n}\nexport const y = helper();\n";
  await writeFile(join(root, 'src', 'a.ts'), source);
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  const r = await tools.execute('move_lines', {
    source: 'src/a.ts',
    expectedHash: hash(source),
    start: 2,
    end: 4,
    destination: 'src/helper.ts',
    destinationHash: 'new',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ['src/a.ts', 'src/helper.ts']);
  assert.equal(
    await readFile(join(root, 'src', 'a.ts'), 'utf8'),
    "import { x } from './x.js';\nexport const y = helper();\n",
  );
  assert.equal(await readFile(join(root, 'src', 'helper.ts'), 'utf8'), 'function helper() {\n  return x;\n}\n');
  assert.match(r.text, /nothing else in either file was changed/);
});

test('a refused replace_lines states the facts of the edit: the lines it drops, and a whole file sent as one line', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.leana'), { recursive: true });
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  // Run 46, step 76: wrapping <Routes> in a router, the new text lost the </Route> that closed the layout route.
  const app =
    "import { Routes, Route } from 'react-router-dom'\nimport { AppLayout } from './AppLayout'\nimport { Landing } from './Landing'\n\nexport default function App() {\n  return (\n    <Routes>\n      <Route element={<AppLayout />}>\n        <Route path=\"/\" element={<Landing />} />\n      </Route>\n    </Routes>\n  )\n}\n";
  await writeFile(join(root, 'src', 'App.tsx'), app);
  await assert.rejects(
    tools.execute('replace_lines', {
      path: 'src/App.tsx',
      expectedHash: hash(app),
      edits: [
        {
          start: 7,
          end: 11,
          newText:
            '    <BrowserRouter>\n      <Routes>\n        <Route element={<AppLayout />}>\n          <Route path="/" element={<Landing />} />\n      </Routes>\n    </BrowserRouter>',
        },
      ],
    }),
    /would no longer parse[\s\S]*held line\(s\) the new text does not contain: 10: <\/Route>\.$/,
    'the dropped closing tag is named with its line number',
  );
  // Run 46, step 78: the whole new main.tsx sent as a replacement of line 1.
  const main =
    "import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\nconst queryClient = new QueryClient({\n  defaultOptions: {\n    queries: {\n      staleTime: 5 * 60 * 1000,\n      retry: 2,\n    },\n  },\n})\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)\n";
  await writeFile(join(root, 'src', 'main.tsx'), main);
  await assert.rejects(
    tools.execute('replace_lines', {
      path: 'src/main.tsx',
      expectedHash: hash(main),
      edits: [
        {
          start: 1,
          end: 1,
          newText:
            "import { BrowserRouter } from 'react-router-dom'\n" +
            main.replace(/\n$/, '').replace('<App />', '<BrowserRouter><App /></BrowserRouter>'),
        },
      ],
    }),
    /already contains[\s\S]*This edit replaces 1 line\(s\) \(1\.\.1\) with 15; the other 13 line\(s\) of src\/main\.tsx stay as they are\. rewrite_file replaces a whole file\.$/,
  );
  assert.equal(await readFile(join(root, 'src', 'main.tsx'), 'utf8'), main, 'nothing was written');
});

// Run 73: useLocalStorage.ts before step 50, and Testimonials.tsx's fetch effect before step 58
// (its lines 85..104, numbered from 1 here).
const storage73 =
  "import { useEffect, useState } from 'react'\n\ninterface UseLocalStorageOptions<T> {\n  key: string\n  defaultValue: T\n  storage?: Storage\n}\n\nexport function useLocalStorage<T>(\n  key: string,\n  defaultValue: T,\n  options?: UseLocalStorageOptions<T>,\n): [T, (value: T | ((prev: T) => T)) => void] {\n  const storage = options?.storage ?? window.localStorage\n  const [state, setState] = useState<T>(defaultValue)\n\n  useEffect(() => {\n    try {\n      const stored = storage.getItem(key)\n      if (stored !== null) {\n        setState(JSON.parse(stored) as T)\n      }\n    } catch {\n      // Ignore parse errors and fall back to default\n    }\n  }, [key, storage])\n\n  const setValue = (value: T | ((prev: T) => T)) => {\n    setState((prev) => {\n      const next = typeof value === 'function' ? value(prev) : value\n      try {\n        storage.setItem(key, JSON.stringify(next))\n      } catch {\n        // Ignore storage errors\n      }\n      return next\n    })\n  }\n\n  return [state, setValue]\n}\n";
const setValue73 =
  "  const setValue = (value: T | ((prev: T) => T)) => {\n    setState((prev) => {\n      const next = (typeof value === 'function' ? (value as (prev: T) => T)(prev) : value) as T\n      try {\n        storage.setItem(key, JSON.stringify(next))\n      } catch {\n        // Ignore storage errors\n      }\n      return next\n    })\n  }";
const effect73 = [
  '  useEffect(() => {',
  '    // Fetch fresh testimonials from API (non-blocking)',
  '    let cancelled = false',
  '    setLoading(true)',
  "    get<Testimonial[]>('/testimonials')",
  '      .then((res) => {',
  '        if (!cancelled && res.data.length > 0) {',
  '          setTestimonials(res.data)',
  '        }',
  '      })',
  '      .catch(() => {',
  '        // Silently fall back to defaults',
  '      })',
  '      .finally(() => {',
  '        if (!cancelled) setLoading(false)',
  '      })',
  '    return () => {',
  '      cancelled = true',
  '    }',
  '  }, [])',
  '',
].join('\n');

test("A bracket refusal states each range's facts: what its replaced lines leave unmatched and the line outside that matches it, what its new text leaves unmatched, and a neighbouring line the new text repeats; never a cause nobody measured", async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-brackets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  const refusal = async (
    path: string,
    text: string,
    args: Record<string, any>,
    route: 'replace_lines' | 'write' = 'replace_lines',
  ) => {
    await writeFile(join(root, path), text);
    const e = await tools.execute(route, { path, expectedHash: hash(text), ...args }).then(
      () => null,
      (x: Error) => x,
    );
    assert(e, `${path}: refused`);
    assert.equal(await readFile(join(root, path), 'utf8'), text, 'nothing was written');
    assert(`Tool error: ${e.message}`.length <= 600, 'the whole refusal fits the error entry');
    assert.doesNotMatch(e.message, /cuts through|cover whole/);
    return e.message;
  };
  // Run 73 step 58: the replaced line closed what it opened; the new text opens a brace it never closes.
  assert.equal(
    await refusal('src/effect.tsx', effect73, {
      edits: [
        { start: 4, end: 4, newText: '' },
        { start: 15, end: 15, newText: '         if (!cancelled) {\n' },
      ],
    }),
    "Edit refused: it would leave src/effect.tsx with 1 unmatched '{' (was 0). Edit 2 (lines 15..15): the replaced lines have no unmatched '{' or '}'; its new text opens 1 '{' it does not close. The replaced range(s) held line(s) the new text does not contain: 4: setLoading(true); 15: if (!cancelled) setLoading(false).",
  );
  // Run 66 step 22: the new entries dropped the "];" that closed the array line 1 opens (the lines it lists all changed).
  const authors =
    "const authors = [\n  { id: 1, name: 'Sarah Mitchell' },\n  { id: 2, name: 'James Chen' },\n];\n\nconst articles = [];\n";
  assert.equal(
    await refusal('src/mockData.js', authors, {
      edits: [
        {
          start: 2,
          end: 4,
          newText:
            "  { id: 1, name: 'Sarah Mitchell', avatar: 'a.png' },\n  { id: 2, name: 'James Chen', avatar: 'b.png' },\n",
        },
      ],
    }),
    "Edit refused: it would leave src/mockData.js with 1 unmatched '[' (was 0). Edit 1 (lines 2..4): the replaced lines close 1 ']' that line 1 opens; its new text has no unmatched '[' or ']'. The replaced range(s) held line(s) the new text does not contain: 2: { id: 1, name: 'Sarah Mitchell' },; 3: { id: 2, name: 'James Chen' },; 4: ];.",
  );
  // Run 76 step 10: line numbers from before step 7; the new text of 6..6 is line 7 as it is (and edit 1 only adds an import line 3 already has).
  const vite =
    "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n})\n";
  assert.equal(
    await refusal('vite.config.ts', vite, {
      edits: [
        {
          start: 1,
          end: 2,
          newText:
            "import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'",
        },
        { start: 6, end: 6, newText: '  plugins: [react(), tailwindcss()],' },
      ],
    }),
    "Edit refused: it would leave vite.config.ts with 1 unmatched '}' (was 0), 1 unmatched ')' (was 0). Edit 2 (lines 6..6): the replaced lines open 1 '{' that line 8 closes and open 1 '(' that line 8 closes; its new text has no unmatched '{', '}', '(' or ')', and is \"  plugins: [react(), tailwindcss()],\", which is line 7 as it is, the line after the range. The replaced range(s) held line(s) the new text does not contain: 6: export default defineConfig({.",
  );
  // Run 52 step 35: an insertion replaces nothing; the rule it restores lost its closing brace as well.
  assert.equal(
    await refusal(
      'src/Hero.css',
      '.hero {\n  position: relative;\n}\n\n  max-width: 1200px;\n  margin: 0 auto;\n\n.hero__content {\n  z-index: 2;\n}\n',
      { edits: [{ start: 5, end: 4, newText: '.hero__container {\n' }] },
    ),
    "Edit refused: it would leave src/Hero.css with 1 unmatched '{' (was 0). Edit 1 (insert before line 5): its new text opens 1 '{' it does not close.",
  );
  // Run 50 step 22: an anchor's new text ending in stray brackets, stated as the lines the anchor spans.
  assert.equal(
    await refusal(
      'index.html',
      '<!doctype html>\n<html>\n  <head>\n    <title>demo</title>\n  </head>\n</html>\n',
      {
        oldText: '    <title>demo</title>',
        newText: '    <title>Nova</title>\n    <meta name="description" content="Nova"}}},{',
      },
      'write',
    ),
    "Edit refused: it would leave index.html with 2 unmatched '}' (was 0). The anchor (lines 4..4): the replaced lines have no unmatched '{' or '}'; its new text opens 1 '{' it does not close and closes 3 '}' it does not open.",
  );
});

test('New text that repeats the lines just outside its range is written without the repeat when the repeat alone breaks the file and the range moved by the repeat does not also fit; one that breaks it anyway is refused, one that passes is written as sent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-echo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  // Run 73 step 50: the new text of 28..37 ends with "  }", line 38, which stays: the range drawn one line
  // short or the text one line long, the same file either way. Recorded: refused, then a 10.6 s whole-file rewrite.
  await writeFile(join(root, 'src', 'useLocalStorage.ts'), storage73);
  const r = await tools.execute('replace_lines', {
    path: 'src/useLocalStorage.ts',
    expectedHash: hash(storage73),
    edits: [{ start: 28, end: 37, newText: setValue73 }],
  });
  assert.equal(r.ok, true);
  const lines = storage73.split('\n');
  assert.equal(
    await readFile(join(root, 'src', 'useLocalStorage.ts'), 'utf8'),
    [...lines.slice(0, 27), ...setValue73.split('\n').slice(0, -1), ...lines.slice(37)].join('\n'),
    'lines 28..37 hold the new text without its last line; line 38 closes it as before',
  );
  assert.match(
    r.text,
    /^Replaced 1 range\(s\) 28\.\.37 of src\/useLocalStorage\.ts; sha256=\w+ totalLines=42\. Edit 1 \(lines 28\.\.37\): its new text ends with "  \}", which is line 38 as it is, the line after the range; that line was not written, since with it src\/useLocalStorage\.ts would have 1 unmatched '\}' \(was 0\)\. /,
  );
  assert.deepEqual(
    r.applied?.edits,
    [{ start: 28, end: 37, newText: setValue73.split('\n').slice(0, -1).join('\n') }],
    'the edit is recorded as written',
  );
  // Run 62 step 35 (a parse refusal): one range starts with the line before it, another ends with the line after
  // it; without them both ranges are deletions, which is what the worker's rewrite at step 36 then did.
  const app =
    'import { BrowserRouter, Routes, Route } from "react-router-dom";\nimport Navbar from "./components/Navbar";\n\nexport default function App() {\n  return (\n    <BrowserRouter>\n      <div className="app">\n        <Navbar />\n        <Routes />\n      </div>\n    </BrowserRouter>\n  );\n}\n';
  await writeFile(join(root, 'src', 'App.tsx'), app);
  const p = await tools.execute('replace_lines', {
    path: 'src/App.tsx',
    expectedHash: hash(app),
    edits: [
      { start: 1, end: 1, newText: 'import { Routes, Route } from "react-router-dom";' },
      { start: 6, end: 6, newText: '  return (' },
      { start: 11, end: 11, newText: '  );' },
    ],
  });
  assert.equal(p.ok, true);
  assert.equal(
    await readFile(join(root, 'src', 'App.tsx'), 'utf8'),
    app.replace('BrowserRouter, ', '').replace('    <BrowserRouter>\n', '').replace('    </BrowserRouter>\n', ''),
  );
  assert.match(
    p.text,
    /Edit 2 \(lines 6\.\.6\): its new text is "  return \(", which is line 5 as it is, the line before the range; edit 3 \(lines 11\.\.11\): its new text is "  \);", which is line 12 as it is, the line after the range; those lines were not written, since with them src\/App\.tsx would no longer parse\./,
  );
  // A repeat that is not what breaks the file stays in the refusal's facts (run 76 step 10, above); one in an
  // edit that passes both checks is written as sent (run 71 step 41 duplicated "subtitle,"): the checks decide.
  const hero = 'export function Hero({\n  title,\n  subtitle,\n}: Props) {\n  return subtitle\n}\n';
  await writeFile(join(root, 'src', 'Hero.tsx'), hero);
  const h = await tools.execute('replace_lines', {
    path: 'src/Hero.tsx',
    expectedHash: hash(hero),
    edits: [{ start: 2, end: 2, newText: '  subtitle,' }],
  });
  assert.equal(await readFile(join(root, 'src', 'Hero.tsx'), 'utf8'), hero.replace('  title,', '  subtitle,'));
  assert.doesNotMatch(h.text, /not written/);
  // Line numbers one too high (as run 76 step 10's were): the text starts with line 3 because it is meant for 3..5.
  // Without the repeat the brackets match and the file parses, but "return sum" is gone; the text on 3..5
  // passes too. Two files, so the edit is refused with its facts.
  const total =
    'export function total(items: number[]) {\n  let sum = 0\n  for (const n of items) {\n    sum += n\n  }\n  return sum\n}\n';
  await writeFile(join(root, 'src', 'total.ts'), total);
  const off = await tools
    .execute('replace_lines', {
      path: 'src/total.ts',
      expectedHash: hash(total),
      edits: [{ start: 4, end: 6, newText: '  for (const n of items) {\n    sum += n * 2\n  }' }],
    })
    .then(
      () => null,
      (e: Error) => e.message,
    );
  assert.equal(
    off,
    "Edit refused: it would leave src/total.ts with 1 unmatched '{' (was 0). Edit 1 (lines 4..6): the replaced lines close 1 '}' that line 3 opens; its new text has no unmatched '{' or '}', and starts with \"  for (const n of items) {\", which is line 3 as it is, the line before the range. The replaced range(s) held line(s) the new text does not contain: 4: sum += n; 6: return sum.",
  );
  assert.equal(await readFile(join(root, 'src', 'total.ts'), 'utf8'), total);
  // "<b>c</b>" can replace line 3 or follow it, and both parse: a parse refusal states the repeat too, last, when it has room.
  const para = 'export const P = () => (\n  <p>\n    <b>a</b>\n  </p>\n)\n';
  await writeFile(join(root, 'src', 'p.tsx'), para);
  const q = await tools
    .execute('replace_lines', {
      path: 'src/p.tsx',
      expectedHash: hash(para),
      edits: [{ start: 3, end: 3, newText: '    <b>c</b>\n  </p>' }],
    })
    .then(
      () => '',
      (e: Error) => e.message,
    );
  assert.match(
    q,
    /^Edit refused: src\/p\.tsx would no longer parse \(.* The replaced range\(s\) held line\(s\) the new text does not contain: 3: <b>a<\/b>\. Edit 1 \(lines 3\.\.3\): its new text ends with " {2}<\/p>", which is line 4 as it is, the line after the range\.$/,
  );
  assert.equal(await readFile(join(root, 'src', 'p.tsx'), 'utf8'), para);
  // Moved one line down, this text would follow "if (x) {": one reading, written with the blank line it ends with.
  const gate = 'export function f() {\n  if (x) {\n    go()\n  }\n}\n';
  await writeFile(join(root, 'src', 'gate.ts'), gate);
  assert.equal(
    (
      await tools.execute('replace_lines', {
        path: 'src/gate.ts',
        expectedHash: hash(gate),
        edits: [{ start: 2, end: 3, newText: '  if (y) {\n    go()\n\n  }' }],
      })
    ).ok,
    true,
  );
  assert.equal(
    await readFile(join(root, 'src', 'gate.ts'), 'utf8'),
    'export function f() {\n  if (y) {\n    go()\n\n  }\n}\n',
  );
  // The repeat is exact and has some text, and never lines another range of the call replaces.
  assert.deepEqual(
    rangeEchoes(['a', '}', '}'], { start: 2, end: 1 }, ['x', '}']),
    { head: 0, tail: 1 },
    'an insertion before line 2 sits between lines 1 and 2',
  );
  assert.deepEqual(
    rangeEchoes(['a', '', 'b'], { start: 1, end: 1 }, ['c', '']),
    { head: 0, tail: 0 },
    'a blank line is no repeat',
  );
  assert.deepEqual(
    rangeEchoes(['a', 'b', '  }'], { start: 2, end: 2 }, ['b2', '}']),
    { head: 0, tail: 0 },
    'compared as they are, indentation included',
  );
  assert.deepEqual(rangeEchoes(['a', 'b', 'c', 'd'], { start: 2, end: 2 }, ['a', 'B', 'c']), { head: 1, tail: 1 });
  assert.deepEqual(
    rangeEchoes(['a', 'b', 'c', 'd'], { start: 2, end: 2 }, ['a', 'B', 'c'], n => n === 3),
    { head: 1, tail: 0 },
    'line 3 belongs to another range',
  );
});

// Run 63, step 41: HomeView.vue as it was before the edit (its first thirteen
// lines from the artifact, the template shortened).
const homeView =
  "<script setup>\nimport { computed } from 'vue'\nimport { useRouter } from 'vue-router'\nimport { useNewsStore } from '../stores/news.js'\nimport { categories } from '../data/categories.js'\n\nconst router = useRouter()\nconst newsStore = useNewsStore()\n\nconst featuredArticles = computed(() => newsStore.featuredArticles)\nconst latestArticles = computed(() => newsStore.latestArticles)\nconst trendingArticles = computed(() => newsStore.trendingArticles)\n</script>\n\n<template>\n  <div class=\"home\">\n    <section class=\"hero\">\n      <h1 class=\"hero-title\">The Daily Chronicle</h1>\n    </section>\n  </div>\n</template>\n";
const step41 = [
  { start: 2, end: 2, newText: "import { computed, ref } from 'vue'", prepend: '' },
  {
    start: 13,
    end: 13,
    newText:
      "const email = ref('')\n\nfunction handleNewsletter() {\n  console.log('Newsletter subscribed:', email.value)\n  email.value = ''\n}\n",
    prepend: '',
  },
];
const format = (path: string) => componentFormats.find(f => f.extension.test(path))!;

test('A component file without its compiler installed is judged by its top-level block balance: valid layouts pass, an unclosed or unopened block is named with its line', () => {
  const valid: [string, string][] = [
    ['a.vue', homeView],
    [
      'a.vue',
      '<!-- a comment with <template> in it -->\n<script>\nexport default { name: "A" }\n</script>\n<script setup lang="ts">\nconst open: string = "<template>"\nif (1 < 2 && open) {}\n</script>\n<template>\n  <template v-if="a > b"><p>x</p></template>\n  <template #item="{ row }">{{ row.a<row.b }}</template>\n  <Comp />\n  <template v-slot:empty />\n</template>\n<style scoped lang="scss">\n.a { .b { color: red } }\n</style>\n<i18n lang="json">\n{ "en": { "hi": "<template>" } }\n</i18n>\n',
    ],
    ['a.vue', '<template lang="pug">\ndiv\n  p hello\n</template>\n'],
    ['a.vue', '<script>\nexport default {}\n</script>\n\n\n'],
    [
      'a.svelte',
      '<script context="module">\n  export const prerender = true\n</script>\n<script lang="ts">\n  let count: number = 0\n  const s = "</style>"\n</script>\n\n<svelte:head><title>x</title></svelte:head>\n{#if count > 1}\n  <p>many</p>\n{:else}\n  <p>few</p>\n{/if}\n<button on:click={() => count++}>+</button>\n\n<style>\n  p { color: red }\n</style>\n',
    ],
    ['a.svelte', '<h1>Hello</h1>\n<p>no script at all</p>\n'],
    [
      'a.astro',
      '---\nimport Layout from "../layouts/Layout.astro"\nconst tag = "<script>"\n---\n<Layout title="x">\n  <main><h1>{tag}</h1></main>\n  <script>\n    console.log("</div>")\n  </script>\n</Layout>\n<style>\n  h1 { color: red }\n</style>\n',
    ],
    // Tags inside an expression or a text-only element are strings, not blocks.
    [
      'a.vue',
      '<template>\n  <p>{{ \'<template>\' }} {{ "</template>" }}</p>\n  <textarea><template></textarea>\n  <textarea v-model="a" />\n</template>\n',
    ],
    [
      'a.svelte',
      "<p>{'<style>'} {\"</style>\"} {a > 0 ? '<script>' : `</script>${'{'}`}</p>\n{#each items as i}<li>{i}</li>{/each}\n<textarea><style></textarea>\n",
    ],
    ['a.astro', "\n---\nconst a = 1\n---\n<p>{a > 0 ? '<style>' : ''}</p>\n<ul>{[1, 2].map(i => <li>{i}</li>)}</ul>\n"],
  ];
  for (const [path, text] of valid)
    assert.deepEqual(blockBalance(text, format(path)), [], `${path}: ${text.slice(0, 40)}`);
  const broken = homeView.split('\n');
  broken.splice(12, 1, "const email = ref('')");
  assert.deepEqual(blockBalance(broken.join('\n'), format('a.vue')), [
    'line 1: "<script setup>" opens a <script> block that no </script> closes before the file ends',
  ]);
  assert.deepEqual(
    blockBalance('<template>\n  <div class="not-found">\n    <div class="not-found-container">\n', format('a.vue')),
    ['line 1: "<template>" opens a <template> block that no </template> closes before the file ends'],
    'run 63, step 15: a generation cut after five lines',
  );
  assert.deepEqual(blockBalance('<template>\n  <div />\n</template>\n</script>\n', format('a.vue')), [
    'line 4: "</script>" ends a <script> block that is not open',
  ]);
  assert.deepEqual(blockBalance('<script>\n  let a = 1\n</script>\n<main />\n<style>\n  p {}\n', format('a.svelte')), [
    'line 5: "<style>" opens a <style> block that no </style> closes before the file ends',
  ]);
  assert.deepEqual(
    blockBalance('<main>\n  <p>hi</p>\n</section>\n', format('a.svelte')),
    [],
    "Svelte markup outside script and style is not a block: its elements are the compiler's to judge",
  );
  assert.deepEqual(blockBalance('---\nconst a = 1\n<main />\n', format('a.astro')), [
    'line 1: the frontmatter fence --- is not closed by a second --- line',
  ]);
  assert.deepEqual(
    blockBalance('\n---\nconst a = 1\n<main />\n', format('a.astro')),
    ['line 2: the frontmatter fence --- is not closed by a second --- line'],
    'the fence is the first line that is not blank',
  );
  assert.deepEqual(
    blockBalance("<p>{a('}</p>\n<style>\n  p {}\n", format('a.svelte')),
    ['line 2: "<style>" opens a <style> block that no </style> closes before the file ends'],
    'an expression that never closes is not skipped: the tags after it are judged',
  );
  assert.deepEqual(
    blockBalance('<template>\n  <p>{{ a }}</p>\n</template>\n<script>\nexport default {}\n', format('a.vue')),
    ['line 4: "<script>" opens a <script> block that no </script> closes before the file ends'],
  );
  // Linear on hostile input: tens of thousands of stray end tags or unclosed expressions.
  let t0 = performance.now();
  blockBalance('</div>\n'.repeat(40000), format('a.vue'));
  blockBalance("{ '\n<style>\n".repeat(20000), format('a.svelte'));
  blockBalance('<template>\n' + '  <p>{{ a\n'.repeat(20000), format('a.vue'));
  assert(performance.now() - t0 < 1000, `block balance took ${Math.round(performance.now() - t0)} ms`);
});

test("A component file is judged by the compiler its project installed, resolved from the file's own project; a compiler whose parse is not the known one leaves the block balance", async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-sfc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A stand-in for @vue/compiler-sfc in a nested project: parse(source, { filename }) returns { errors } with loc.start.line.
  const vue = join(root, 'web', 'node_modules', '@vue', 'compiler-sfc');
  await mkdir(vue, { recursive: true });
  await writeFile(join(vue, 'package.json'), JSON.stringify({ name: '@vue/compiler-sfc', main: 'index.cjs' }));
  await writeFile(
    join(vue, 'index.cjs'),
    'exports.parse = (source, o) => ({ descriptor: {}, errors: source.split("\\n").flatMap((l, i) => /BROKEN/.test(l) ? [{ message: "Element is missing end tag.", loc: { start: { line: i + 1 } } }] : []), filename: o.filename });\n',
  );
  assert.deepEqual(
    await componentProblems(root, 'web/src/A.vue', '<template>\n  <div BROKEN>\n</template>\n'),
    ['line 2: Element is missing end tag: "<div BROKEN>"'],
    "the compiler's message, with the line it names",
  );
  assert.deepEqual(await componentProblems(root, 'web/src/A.vue', '<template>\n  <div />\n</template>\n'), []);
  assert.deepEqual(
    await componentProblems(root, 'other/A.vue', '<template>\n  <div BROKEN>\n</template>\n'),
    [],
    'a file outside that project does not resolve its compiler: block balance, which sees nothing wrong at the top level',
  );
  assert.deepEqual(await parseInProcess(root, 'web/src/A.vue', '<template>\n<div BROKEN>\n</template>\n'), [
    'line 2: Element is missing end tag: "<div BROKEN>"',
  ]);
  // pnpm does not hoist @vue/compiler-sfc: vue/compiler-sfc, which the Vite plugin loads, is resolved first.
  const pn = join(root, 'pn', 'node_modules', 'vue');
  await mkdir(join(pn, 'compiler-sfc'), { recursive: true });
  await writeFile(
    join(pn, 'package.json'),
    JSON.stringify({ name: 'vue', exports: { './compiler-sfc': { require: './compiler-sfc/index.cjs' } } }),
  );
  await writeFile(
    join(pn, 'compiler-sfc', 'index.cjs'),
    'exports.parse = source => ({ descriptor: {}, errors: /<div>\\n<\\/template>/.test(source) ? [{ message: "Element is missing end tag.", loc: { start: { line: 2 } } }] : [] });\n',
  );
  assert.deepEqual(
    await componentProblems(root, 'pn/src/A.vue', '<template>\n<div>\n</template>\n'),
    ['line 2: Element is missing end tag: "<div>"'],
    'an unclosed element inside the template, which block balance does not judge',
  );
  // svelte/compiler: parse throws an error with start.line; script content in a preprocessor's language is not given to it.
  const svelte = join(root, 'node_modules', 'svelte');
  await mkdir(join(svelte, 'compiler'), { recursive: true });
  await writeFile(
    join(svelte, 'package.json'),
    JSON.stringify({ name: 'svelte', exports: { './compiler': { require: './compiler/index.cjs' } } }),
  );
  await writeFile(
    join(svelte, 'compiler', 'index.cjs'),
    'exports.parse = source => { const i = source.split("\\n").findIndex(l => /BROKEN|: number/.test(l)); if (i >= 0) throw Object.assign(new Error("Expected token >\\nhttps://svelte.dev/e/expected_token"), { start: { line: i + 1, column: 0 } }); return { html: {} }; };\n',
  );
  assert.deepEqual(
    await componentProblems(
      root,
      'src/A.svelte',
      '<script lang="ts">\n  let count: number = 0\n</script>\n<p>{count}</p>\n',
    ),
    [],
    'TypeScript in <script lang="ts"> is blanked, lines kept',
  );
  assert.deepEqual(await componentProblems(root, 'src/A.svelte', '<script>\n  let count = 0\n</script>\n<p BROKEN\n'), [
    'line 4: Expected token >: "<p BROKEN"',
  ]);
  // A package of that name without the known parse (another major's API) is not trusted for a verdict.
  const odd = join(root, 'odd', 'node_modules', '@vue', 'compiler-sfc');
  await mkdir(odd, { recursive: true });
  await writeFile(join(odd, 'package.json'), JSON.stringify({ name: '@vue/compiler-sfc', main: 'index.cjs' }));
  await writeFile(
    join(odd, 'index.cjs'),
    'exports.parse = o => { if (typeof o !== "object") throw new TypeError("options"); return {}; };\n',
  );
  assert.deepEqual(await componentProblems(root, 'odd/A.vue', '<script>\nexport default {}\n'), [
    'line 1: "<script>" opens a <script> block that no </script> closes before the file ends',
  ]);
  assert.deepEqual(
    await parseInProcess(root, 'index.html', '<html><body></div>'),
    [],
    'HTML markup is not judged (the browser recovers, the page observation is its check); only its inline scripts are parsed',
  );
  assert.deepEqual(
    await syntaxCheck(root, 'src/B.vue', '<template>\n<p>x</p>\n'),
    ['line 1: "<template>" opens a <template> block that no </template> closes before the file ends'],
    'the fact after a write comes from the same parser',
  );
});

// Run 67, steps 11-15: `{@each ...}` where Svelte's block is `{#each ...}`; the compiler stops at "each" (0-based column 6, offset in the file).
const run67Page = (indent: string, above = '') =>
  `<script lang="ts">\n${indent}let pets: { emoji: string }[] = $state([{ emoji: "🐕" }]);\n</script>\n${above}\n<div class="grid">\n${indent}${indent}{@each pets as pet}\n${indent}${indent}${indent}<span>{pet.emoji}</span>\n${indent}${indent}{/@each}\n</div>\n`;
async function svelteStandIn(root: string): Promise<void> {
  // A stand-in for svelte/compiler: parse throws, as Svelte 5 does, an error whose position is an offset into the text it was given, less a leading byte-order mark.
  const svelte = join(root, 'node_modules', 'svelte');
  await mkdir(join(svelte, 'compiler'), { recursive: true });
  await writeFile(
    join(svelte, 'package.json'),
    JSON.stringify({ name: 'svelte', exports: { './compiler': { require: './compiler/index.cjs' } } }),
  );
  await writeFile(
    join(svelte, 'compiler', 'index.cjs'),
    'exports.parse = source => { source = source.replace(/^\\ufeff/, ""); const i = source.indexOf("{@"); if (i < 0) return { html: {} }; const at = i + 2; const line = source.slice(0, at).split("\\n").length; throw Object.assign(new Error("Expected \'html\', \'render\', \'attach\', \'const\', or \'debug\'\\nhttps://svelte.dev/e/expected_tag"), { position: [at, at], start: { line, column: at - source.lastIndexOf("\\n", at - 1) - 1, character: at } }); };\n',
  );
}

test("A parse problem names its line, the column the parser gives and the text that starts there, and the line's text: TypeScript, a Svelte compiler's offset (run 67), a Vue compiler's 1-based column", async t => {
  assert.deepEqual(await syntaxErrors('a.ts', 'const a = 1;\nconst b = foo(;\n'), [
    'line 2, column 15 (at ";" of "foo(;"): \')\' expected: "const b = foo(;"',
  ]);
  assert.deepEqual(
    await syntaxErrors('a.ts', 'const x = {\n  a: 1\n'),
    ["line 3, column 1 (at the end of the file): '}' expected"],
    'a position past the last text is the end of the file, and an empty line is not quoted',
  );
  // Run 93 step 11: creating vitest-env.d.ts failed with TypeScript's "Debug Failure. Output generation failed".
  assert.deepEqual(
    await syntaxErrors('vitest-env.d.ts', '/// <reference types="vite/client" />\ndeclare module \'*.css\'\n'),
    [],
  );
  assert.equal(
    (await syntaxErrors('types.d.ts', 'declare const x: {\n')).length,
    1,
    'a broken declaration file is still judged',
  );
  assert.deepEqual(await syntaxErrors('a.json', '{"a": 1,, }'), [
    'line 1, column 9 (at "," of "1,,"): Property assignment expected: "{\\"a\\": 1,, }"',
  ]);
  assert.equal(
    problemAt('a\nb\n', 'm.', { offset: 0, line: 2 }),
    'line 2: m: "b"',
    'an offset that is not on the line the parser names is not used',
  );
  assert.equal(problemAt('a\n', 'm', {}), 'm');
  for (let k = 20; k < 40; k++)
    assert.doesNotMatch(
      problemAt(`${'🐶'.repeat(30)}\n`, 'm', { line: 1, column: k }),
      /\\ud[89a-f]/i,
      'the quoted run never splits a character outside the basic plane',
    );
  assert.doesNotMatch(problemAt(`x${'🐶'.repeat(60)}\n`, 'm', { line: 1 }), /\\ud[89a-f]/i, 'nor the quoted line');
  assert.equal(
    problemKey('line 160, column 7 (at "each" of "{@each"): E: "{@each pets as pet}"'),
    problemKey('line 167, column 5 (at "each" of "{@each"): E: "{@each pets as pet}"'),
    'the same message at the same text, wherever the lines moved',
  );
  const root = await mkdtemp(join(tmpdir(), 'leana-at-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await svelteStandIn(root);
  // The script is TypeScript, blanked before the compiler reads it: offsets after it are kept (the emoji is two UTF-16 units, blanked as two).
  assert.deepEqual(await componentProblems(root, 'src/routes/+page.svelte', run67Page('  ')), [
    "line 6, column 7 (at \"each\" of \"{@each\"): Expected 'html', 'render', 'attach', 'const', or 'debug': \"{@each pets as pet}\"",
  ]);
  assert.deepEqual(
    await componentProblems(root, 'src/routes/+page.svelte', '\ufeff' + run67Page('  ')),
    await componentProblems(root, 'src/routes/+page.svelte', run67Page('  ')),
    'a leading byte-order mark, which Svelte drops before it places its errors, does not move the column',
  );
  const vue = join(root, 'web', 'node_modules', '@vue', 'compiler-sfc');
  await mkdir(vue, { recursive: true });
  await writeFile(join(vue, 'package.json'), JSON.stringify({ name: '@vue/compiler-sfc', main: 'index.cjs' }));
  await writeFile(
    join(vue, 'index.cjs'),
    'exports.parse = source => { const offset = source.indexOf("{{ x }<"); if (offset < 0) return { descriptor: {}, errors: [] }; const line = source.slice(0, offset).split("\\n").length; return { descriptor: {}, errors: [{ message: "Interpolation end sign was not found.", loc: { start: { offset, line, column: offset - source.lastIndexOf("\\n", offset - 1) } } }] }; };\n',
  );
  assert.deepEqual(await componentProblems(root, 'web/src/A.vue', '<template>\n  <p>{{ x }</p>\n</template>\n'), [
    'line 2, column 6 (at "{{" of "<p>{{"): Interpolation end sign was not found: "<p>{{ x }</p>"',
  ]);
});

test('Run 67, steps 13-15: a write that leaves the file with the problem the replaced text had, the same message at the same text, is told so with both lines; a new problem, a new file or the end of the file is not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-same-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await svelteStandIn(root);
  const path = 'src/routes/+page.svelte';
  // The regeneration reindented the file and added lines above the loop: the problem moved from line 6 to line 7, at the same text.
  const fact = await parseFact(root, path, run67Page('  '), run67Page('\t', '<h1>Pets</h1>\n<p>for sale</p>'));
  assert.equal(
    fact,
    `${path} does not parse: line 7, column 5 (at "each" of "{@each"): Expected 'html', 'render', 'attach', 'const', or 'debug': "{@each pets as pet}". Same problem as before this write, at the same text: line 7 (was line 6); that text did not change`,
  );
  assert.equal(
    await parseFact(root, path, null, run67Page('  ')),
    `${path} does not parse: line 6, column 7 (at "each" of "{@each"): Expected 'html', 'render', 'attach', 'const', or 'debug': "{@each pets as pet}"`,
    'a created file has nothing it replaced',
  );
  assert.doesNotMatch(
    (await parseFact(
      root,
      path,
      run67Page('  '),
      run67Page('  ').replace('{@each pets as pet}', '{@each pets as p}'),
    ))!,
    /Same problem/,
    'the same message at different text is a different problem',
  );
  assert.equal(
    await parseFact(
      root,
      path,
      run67Page('  '),
      run67Page('  ').replace('{@each', '{#each').replace('{/@each', '{/each'),
    ),
    null,
    'a file that parses has no fact',
  );
  assert.doesNotMatch(
    (await parseFact(root, 'a.ts', 'const x = {\n  a: 1\n', 'const x = {\n  b: 2\n'))!,
    /Same problem/,
    'a problem at the end of the file names no text',
  );
  assert.match(
    (await parseFact(root, 'a.ts', 'const b = foo(;\n', '// two\nconst b = foo(;\n'))!,
    /: "const b = foo\(;"\. Same problem as before this write, at the same text: line 2 \(was line 1\); that text did not change$/,
  );
});

test('A problem at text that another line also reads is not the same problem: the first of two identical broken lines fixed, a stray brace deleted in one place and added in another', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-same2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Two identical broken lines, the first fixed: the second is the same problem at its own line, never the fixed one's.
  const two = (a: string) => `function f() {\n  ${a}\n}\nfunction g() {\n  foo(;\n}\n`;
  const fixedFirst = await parseFact(root, 'a.ts', two('foo(;'), two('foo();'));
  assert.match(
    fixedFirst!,
    /line 5, column 7 [^|]*Same problem as before this write, at the same text: line 5 \(was line 5\); that text did not change$/,
    'TypeScript reported both; the second is unchanged',
  );
  const moved = await parseFact(
    root,
    'a.ts',
    'function a() {\n  return 1;\n}\n}\nfunction b() {\n  return 2;\n}\n',
    'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n}\nexport {}\n',
  );
  assert.match(moved!, /line 7, column 1 \(at "}"\): Declaration or statement expected/);
  assert.doesNotMatch(moved!, /Same problem/, 'the brace at line 7 is new text');
});

test('Run 63, step 41: a replace_lines that overwrites the </script> closing <script setup> is refused with the line it drops; a repair of a file already broken is not blocked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-sfc-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'views'), { recursive: true });
  await writeFile(join(root, 'src', 'views', 'HomeView.vue'), homeView);
  const tools = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  tools.parse = (path, text) => parseInProcess(root, path, text).then(r => r ?? []);
  await assert.rejects(
    tools.execute('replace_lines', { path: 'src/views/HomeView.vue', expectedHash: hash(homeView), edits: step41 }),
    /^Error: Edit refused: src\/views\/HomeView\.vue would no longer parse \(line 1: "<script setup>" opens a <script> block that no <\/script> closes before the file ends\)\.[\s\S]*held line\(s\) the new text does not contain: 2: import \{ computed \} from 'vue'; 13: <\/script>\.$/,
  );
  assert.equal(await readFile(join(root, 'src', 'views', 'HomeView.vue'), 'utf8'), homeView, 'nothing was written');
  // The edit it meant: insert before line 13.
  const r = await tools.execute('replace_lines', {
    path: 'src/views/HomeView.vue',
    expectedHash: hash(homeView),
    edits: [step41[0], { ...step41[1], end: 12 }],
  });
  assert.equal(r.ok, true);
  const fixed = await readFile(join(root, 'src', 'views', 'HomeView.vue'), 'utf8');
  assert.match(fixed, /email\.value = ''\n\}\n<\/script>\n/);
  // Already broken (the state after step 41): an edit that leaves it no worse lands, so the repair is never blocked.
  const broken = homeView.split('\n');
  broken.splice(12, 1, "const email = ref('')");
  await writeFile(join(root, 'src', 'views', 'HomeView.vue'), broken.join('\n'));
  const repair = await tools.execute('replace_lines', {
    path: 'src/views/HomeView.vue',
    expectedHash: hash(broken.join('\n')),
    edits: [{ start: 2, end: 2, newText: "import { computed, ref } from 'vue'" }],
  });
  assert.equal(repair.ok, true);
  // A ToolBox without the profiles' parser keeps the TypeScript-only gate: the loop is what wires the component parser in.
  const plain = new ToolBox(root, join(root, '.leana'), { ...defaults, allowWrite: true });
  await writeFile(join(root, 'src', 'views', 'HomeView.vue'), homeView);
  assert.equal(
    (
      await plain.execute('replace_lines', {
        path: 'src/views/HomeView.vue',
        expectedHash: hash(homeView),
        edits: step41,
      })
    ).ok,
    true,
  );
});

test('Shell command output reaches the harness without colour or hyperlink sequences; content ESC bytes elsewhere are kept', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = new ToolBox(dir, join(dir, '.leana'), { ...defaults, allowBash: true });
  const r = await tools.execute('bash', {
    command: `printf '\\033[96msrc/a.ts\\033[0m:\\033[93m3\\033[0m - \\033]8;;http://x\\007link\\033]8;;\\007 \\033[2K%s\\n' "$NO_COLOR"`,
    purpose: 'print',
    check: false,
  });
  assert.equal(
    JSON.parse(r.text).output,
    'src/a.ts:3 - link 1\n',
    'NO_COLOR is set, and colour, erase and hyperlink sequences are gone',
  );
  const raw = await runCommand('bash', ['-c', `printf 'RESET = "\\033c"\\n'`], dir, 10000);
  assert.equal(
    raw.output,
    'RESET = "\u001bc"\n',
    'a command run for its content (a search, a program) keeps its bytes',
  );
  const { plainText } = await import('../src/commands.js');
  assert.equal(
    plainText('SAVE = "\u001b7"; RED = "\u001b[31m"'),
    'SAVE = "\u001b7"; RED = ""',
    'only CSI and OSC sequences are removed',
  );
});

test('The processes a command left running are described by what it started, and what those started is counted', () => {
  assert.equal(
    describeProcesses([
      { pid: 10, ppid: 1, args: 'npm run dev' },
      { pid: 11, ppid: 10, args: 'sh -c vite' },
      { pid: 12, ppid: 11, args: 'node vite' },
    ]),
    '"npm run dev" (pid 10) and 2 processes started by it',
  );
  assert.equal(
    describeProcesses([
      { pid: 10, ppid: 1, args: 'a' },
      { pid: 20, ppid: 1, args: 'b' },
    ]),
    '"a" (pid 10), "b" (pid 20)',
  );
  assert.equal(
    describeProcesses([
      { pid: 10, ppid: 1, args: 'a' },
      { pid: 20, ppid: 1, args: 'b' },
      { pid: 21, ppid: 20, args: 'c' },
    ]),
    '"a" (pid 10), "b" (pid 20) and 1 process started by them',
  );
});

test(
  'A process group is read from the process table (/proc or ps): its live members with their command lines; an empty group is empty',
  { skip: process.platform === 'win32' && 'Windows has no process groups' },
  async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('bash', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      const found = await groupProcesses(child.pid!);
      assert.deepEqual(found.map(p => p.args).sort(), ['bash -c sleep 30 & sleep 30', 'sleep 30', 'sleep 30']);
      assert(found.filter(p => p.args === 'sleep 30').every(p => p.ppid === child.pid));
      // The ps table (macOS, the BSDs) reads the same.
      assert.deepEqual(await groupProcesses(child.pid!, 'ps'), found);
    } finally {
      process.kill(-child.pid!, 'SIGKILL');
    }
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(await groupProcesses(child.pid!), []);
  },
);

test('shownIn names the newest entry that shows every part a clip kept, as written or inside a JSON string; none when a part is shown nowhere', () => {
  const e = (id: string, text: string, kind = 'bash') => ({ id, step: 1, kind, text, artifact: '', relevance: 0.5 });
  const out = 'src/a.ts(1,1): error "one"\n' + 'x'.repeat(2000) + '\nFound 1 error.\n';
  const field = clipEnds(out, 1200);
  assert.equal(
    shownIn([e('e1', JSON.stringify({ command: 'tsc', output: out }))], field),
    'e1',
    "a command's output sits escaped in its result's JSON",
  );
  assert.equal(shownIn([e('e1', out), e('e2', out)], field), 'e2', 'the newest');
  assert.equal(
    shownIn([e('e1', 'other'), e('e2', out), e('e2', 'other')], field),
    undefined,
    'an id two entries carry says neither',
  );
  assert.equal(shownIn([e('t3', out, 'turn')], field), undefined, 'a turn is not evidence');
  assert.equal(shownIn([e('e1', clip(out, 600))], field), undefined, 'a shorter clip leaves a kept part unshown');
  assert.equal(
    shownIn([e('e1', clip(out, 1500))], clip(out, 700)),
    'e1',
    'a longer clip shows both parts of a shorter one',
  );
  assert.equal(shownIn([e('e1', 'other')], 'short error'), undefined);
});
test('lineDiff counts the lines each text has that the other does not, by a longest common subsequence after the common ends', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nb\nc\n'), { removed: 0, added: 0, exact: true });
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\n'), { removed: 1, added: 1, exact: true });
  assert.deepEqual(
    lineDiff('import x;\na\nb\nc\n', 'a\nb\nc\nd\n'),
    { removed: 1, added: 1, exact: true },
    'a line dropped at the top, one added at the end',
  );
  assert.deepEqual(lineDiff('a\nb\n', 'b\na\n'), { removed: 1, added: 1, exact: true }, 'a swap keeps one line');
  assert.deepEqual(lineDiff('', 'a\nb\n'), { removed: 0, added: 2, exact: true });
  assert.deepEqual(
    lineDiff('a\nb', 'a\nb\n'),
    { removed: 0, added: 0, exact: true },
    'a final line break is not a line',
  );
});

test('lineDiff (review): CRLF endings are not line changes, and a middle too large to compare is not stated as exact', () => {
  assert.deepEqual(lineDiff('a\r\nb\r\nc\r\n', 'a\nB\nc\n'), { removed: 1, added: 1, exact: true });
  const big = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n') + '\n';
  assert.equal(lineDiff(big(2100, 'x'), big(2100, 'y')).exact, false);
});

test(
  'On Windows what a command left running is found by the mark its shell passed down, named as elsewhere: the fork Git Bash keeps for a program is the program, and a bash it ran is found after every process between has exited',
  { skip: process.platform !== 'win32' && 'Windows only' },
  async () => {
    assert.equal(
      windowsArgs('"C:\\Program Files\\nodejs\\node.exe" -e "setInterval(() => {}, 1000)"'),
      'node -e setInterval(() => {}, 1000)',
    );
    assert.equal(windowsArgs('C:\\x\\node.exe idle.mjs'), 'node idle.mjs');
    assert.equal(windowsArgs('python.exe -c "print(\\"a b\\")"'), 'python -c print("a b")');
    const { spawn } = await import('node:child_process');
    const run = async (command: string) => {
      const mark = runMark()!;
      const since = Date.now();
      const child = spawn(bashPath(), ['--noprofile', '--norc', '-o', 'pipefail', '-c', command], {
        stdio: 'ignore',
        env: shellEnv({ ...process.env, LEANA_RUN: mark }),
      });
      await new Promise(r => child.on('exit', r));
      await new Promise(r => setTimeout(r, 300));
      return { mark, found: await windowsLeft(mark, since) };
    };
    const a = await run('node -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo started');
    const b = await run(
      'bash -c "sleep 30 & node -e \'setInterval(() => {}, 1000)\' & wait" >/dev/null 2>&1 & echo started',
    );
    try {
      assert.deepEqual(
        a.found.map(p => p.args),
        ['node -e setInterval(() => {}, 1000)'],
        'the program, not the fork that waits on it nor the console host',
      );
      const nested = b.found.map(p => p.args).sort();
      assert.deepEqual(
        nested,
        [
          "bash -c sleep 30 & node -e 'setInterval(() => {}, 1000)' & wait",
          'node -e setInterval(() => {}, 1000)',
          'sleep 30',
        ].sort(),
        nested.join(' | '),
      );
      const shell = b.found.find(p => p.args.startsWith('bash -c'))!;
      assert(
        b.found.filter(p => p !== shell).every(p => p.ppid === shell.pid),
        'what the bash started is under it',
      );
    } finally {
      stopMarked(a.mark);
      stopMarked(b.mark);
    }
    assert.deepEqual(await windowsLeft(b.mark, Date.now()), [], 'stopped: nothing carries the mark');
  },
);

test('The project the worker is shown is the one git sees: ignored build output and worktrees checked out inside it are not listed; untracked new files are; outside git, the whole tree', async t => {
  const { visibleRepoFiles, listRepoFiles } = await import('../src/files.js');
  const { runCommand } = await import('../src/commands.js');
  const root = await mkdtemp(join(tmpdir(), 'leana-visible-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const f of ['src/a.ts', 'dist/a.js', '.claude/worktrees/w/src/a.ts', 'notes.md', '.env', 'id.key']) {
    await mkdir(join(root, f, '..'), { recursive: true });
    await writeFile(join(root, f), 'x\n');
  }
  assert.deepEqual(await visibleRepoFiles(root), await listRepoFiles(root), 'not a repository: the tree as it is');
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  const git = (...a: string[]) => runCommand('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], root, 20000);
  await git('init', '-q');
  await writeFile(join(root, '.git', 'info', 'exclude'), '.claude/worktrees/\n');
  await git('add', 'src/a.ts', '.gitignore');
  await git('commit', '-qm', 'x');
  assert.deepEqual(
    await visibleRepoFiles(root),
    ['.gitignore', 'notes.md', 'src/a.ts'],
    'tracked and untracked, without what git ignores, .env files or keys',
  );
});
