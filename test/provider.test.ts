import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { defaults, loadConfig, loadSettings } from '../src/config.js';
import {
  effortsOf,
  fitToModel,
  llamaModelInfo,
  modelOptions,
  openrouterModelInfo,
  unsupportedSettings,
} from '../src/models.js';
import { OpenRouter, parseJson } from '../src/openrouter.js';
import { forModel } from '../src/session.js';
import { App } from '../src/app.js';
import { Agent, argsProblem, fileBeingWritten, newSession } from '../src/agent.js';
import { Store } from '../src/store.js';
import { schemas, stepSchema, toolSchema, withDefaults } from '../src/schema.js';
import { AGENT_SYSTEM, actionTool, agentSystem, stepMessages } from '../src/context.js';
import type { Answers, Config, Message, Questions } from '../src/types.js';

const fixtures = fileURLToPath(new URL('../../test/fixtures/openrouter/', import.meta.url));
const catalogue = async () => JSON.parse(await readFile(join(fixtures, 'models.json'), 'utf8'));
const body = async (req: AsyncIterable<any>) => {
  let b = '';
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
};
// OpenRouter's stream: a keep-alive comment, a role delta, then the pieces, the finish, a usage chunk and [DONE].
async function sse(
  res: ServerResponse,
  deltas: Record<string, unknown>[],
  finish = 'stop',
  usage = { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0012 },
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.write(': OPENROUTER PROCESSING\n\n');
  const base = { id: 'gen-1', model: 'm', object: 'chat.completion.chunk' };
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
  );
  for (const d of deltas)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '' }, finish_reason: finish }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: finish }], usage })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}
// A mock OpenRouter: the catalogue at /models, chat answered by `reply` (body and call number).
// A model's endpoints at /models/ID/endpoints when given (else 404: routing is left to OpenRouter).
async function mock(
  t: any,
  reply: (b: any, n: number, res: ServerResponse) => Promise<void> | void,
  extra: any[] = [],
  endpoints?: any[],
) {
  const bodies: any[] = [];
  const list = await catalogue();
  list.data.push(...extra);
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(list));
    }
    if (req.url?.endsWith('/endpoints')) {
      res.statusCode = endpoints ? 200 : 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(endpoints ? { data: { endpoints } } : { error: { message: 'not found' } }));
    }
    const b = await body(req);
    bodies.push(b);
    await reply(b, bodies.length, res);
  }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as any).port}/api/v1`, bodies };
}
const cfg = (url: string, model: string, more: Partial<Config> = {}): Config => ({
  ...defaults,
  provider: 'openrouter',
  openrouterUrl: url,
  model,
  ...more,
});
const pieces = (s: string, n = 7) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'))!;
process.env.OPENROUTER_API_KEY ??= 'test-key';

test("A model's facts come from its provider: OpenRouter's catalogue entry (context, output, parameters, reasoning, prices) and llama-server's props and chat template", async () => {
  const [claude, gpt, ling, plain] = (await catalogue()).data.map(openrouterModelInfo);
  assert.deepEqual(
    [
      claude.reasoning.supported,
      claude.reasoning.mandatory,
      claude.reasoning.efforts,
      claude.reasoning.defaultEffort,
      claude.structured,
    ],
    [true, true, ['max', 'xhigh', 'high', 'medium', 'low'], 'high', true],
  );
  assert(claude.contextLength >= 200000 && claude.maxOutput >= 32000 && claude.pricing!.prompt > 0);
  assert.deepEqual([gpt.reasoning.mandatory, effortsOf(gpt.reasoning).includes('none')], [false, true]);
  assert.deepEqual(
    [ling.reasoning.supported, ling.reasoning.efforts, ling.structured, ling.params.includes('top_k')],
    [true, null, false, true],
    "efforts not listed: any of the gateway's",
  );
  assert.deepEqual([plain.reasoning.supported, plain.reasoning.efforts], [false, []]);
  const template =
    "{%- if enable_thinking is undefined or enable_thinking is true %}\n{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}\n{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{ raise_exception('x') }}{%- endif %}{%- endif %}<think>";
  const bonsai = llamaModelInfo(
    {
      model_alias: 'bonsai-27b',
      model_path: '/m/Ternary-Bonsai-2-27B-PTQ1_0.gguf',
      chat_template: template,
      default_generation_settings: { n_ctx: 64536 },
    },
    { data: [{ id: 'bonsai-27b', meta: { n_params: 27e9, size: 5.9e9, n_ctx_train: 262144 } }] },
    'bonsai-27b',
  );
  assert.deepEqual(
    [
      bonsai.contextLength,
      bonsai.reasoning.efforts,
      bonsai.reasoning.defaultEffort,
      bonsai.reasoning.budget,
      bonsai.details!.parameters,
    ],
    [64536, ['xhigh', 'medium', 'low'], 'xhigh', true, '27.0B'],
  );
  const noThink = llamaModelInfo(
    { chat_template: '{{ messages }}', default_generation_settings: { n_ctx: 8192 } },
    null,
    'x',
  );
  assert.deepEqual(
    [noThink.reasoning.supported, modelOptions(noThink).some(o => /reasoning|effort|budget/.test(o.name))],
    [false, false],
  );
});

test('An effort a model does not take becomes the nearest it takes, rounding down (less reasoning), never off; the note says which (run react-demo-glm-1: medium went to GLM-5.3 default, max)', async () => {
  const { nearestEffort } = await import('../src/models.js');
  assert.equal(nearestEffort('medium', ['max', 'high', 'low']), 'low', 'GLM-5.3: down to low, not its default max');
  assert.equal(nearestEffort('xhigh', ['high', 'low']), 'high');
  assert.equal(nearestEffort('low', ['max', 'high']), 'high', 'nothing below: the nearest above');
  assert.equal(nearestEffort('medium', ['max', 'high', 'none']), 'high', 'rounding down never turns reasoning off');
  assert.equal(nearestEffort('none', ['low', 'none']), 'none');
  assert.equal(nearestEffort('high', ['max', 'high', 'low']), 'high', 'one it takes: as it is');
  assert.equal(nearestEffort('turbo', ['high']), null, 'not an effort of the order: left to the caller');
  const [claude] = (await catalogue()).data.map(openrouterModelInfo);
  const glm = {
    ...claude,
    id: 'z-ai/glm-5.3',
    reasoning: {
      ...claude.reasoning,
      mandatory: true,
      efforts: ['max', 'high', 'low'],
      defaultEffort: 'max',
      budget: true,
    },
  };
  const { config, notes } = forModel({ ...defaults, provider: 'openrouter', thinkingEffort: 'medium' }, glm);
  assert.equal(config.thinkingEffort, 'low');
  assert(
    notes.includes('z-ai/glm-5.3 does not take effort medium (it takes max, high, low): low is used instead'),
    notes.join(' | '),
  );
});

test('A reply that reached its limit with nothing but reasoning is asked again at once with less reasoning (its token budget), and said for what it was when that is all reasoning too (run react-demo-glm-1: three replies of 21,216 reasoning tokens failed as unfinished arguments)', async t => {
  const schema = {
    type: 'object' as const,
    properties: { content: { type: 'string' as const } },
    required: ['content'],
    additionalProperties: false as const,
  };
  const prompt = [
    { role: 'system' as const, content: 'You are the worker.' },
    { role: 'user' as const, content: '{"request":"next"}' },
  ];
  const thinking = async (res: ServerResponse) =>
    sse(res, [{ reasoning: 'Let me think about this at length. '.repeat(20) }], 'length', {
      prompt_tokens: 5000,
      completion_tokens: 21216,
      cost: 0,
    } as any);
  const once = await mock(t, async (_b, n, res) =>
    n === 1 ? thinking(res) : sse(res, [{ content: '{"content":"ok"}' }]),
  );
  const events: any[] = [];
  const or = new OpenRouter(
    cfg(once.url, 'anthropic/claude-sonnet-5.5', { thinkingEffort: 'medium' }),
    'k',
    async (type, data) => {
      events.push({ type, data });
    },
  );
  assert.deepEqual(await or.generate(prompt, schema), { content: 'ok' });
  assert.deepEqual(
    once.bodies.map(b => b.reasoning),
    [{ effort: 'medium' }, { max_tokens: defaults.stepThinkingBudget }],
    'asked again with the step budget',
  );
  const said = events.find(e => e.type === 'reasoning-exhausted')!.data;
  assert.deepEqual(
    [said.tokens, said.reasoning, said.retry],
    [21216, { effort: 'medium' }, { max_tokens: defaults.stepThinkingBudget }],
  );
  const twice = await mock(t, async (_b, _n, res) => thinking(res));
  await assert.rejects(
    new OpenRouter(cfg(twice.url, 'anthropic/claude-sonnet-5.5'), 'k', async () => {}).generate(prompt, schema),
    /^Error: The model spent its whole reply \(21216 tokens\) reasoning and never began to answer, also when asked again with less reasoning$/,
  );
  assert.equal(twice.bodies.length, 2, 'asked again once, not more');
});

test("The completion gate's packet is held under Jev's byte cap: the oldest written file's source goes first and is named as left out, then the longest texts shorten (run react-demo-glm-1: the finish was never judged)", async () => {
  const { fitGateState } = await import('../src/control.js');
  const code = (n: number) =>
    `export const f${n} = () => {\n  return "a \\"quoted\\" line";\n};\n`.repeat(40).slice(0, 1200);
  const sources = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${i}.tsx`, code(i)]));
  const state: Record<string, any> = {
    objective: 'build a landing page',
    summary: 'S'.repeat(1500),
    notes: 'N'.repeat(1500),
    diffStat: 'D'.repeat(700),
    observation: { kind: 'page', target: 'http://127.0.0.1:5173/', ok: true, facts: 'F'.repeat(2900) },
    sources,
  };
  const all = Object.keys(sources);
  assert(Buffer.byteLength(JSON.stringify(state)) > 22000, 'over the cap as built');
  fitGateState(state);
  assert(Buffer.byteLength(JSON.stringify(state)) <= 21000);
  const kept = Object.keys(state.sources);
  assert(kept.length > 0 && kept.at(-1) === 'src/f11.tsx', 'the newest sources kept');
  assert.deepEqual([...state.sourcesLeftOut, ...kept], all, 'the oldest left out, and named');
  const small: Record<string, any> = { summary: 's', sources: { 'a.ts': 'x' } };
  fitGateState(small);
  assert.deepEqual(small, { summary: 's', sources: { 'a.ts': 'x' } }, 'a packet that fits: untouched');
});

test('Only the options the model takes are offered, and a value it does not take is refused with what it takes', async () => {
  const [claude, gpt, ling, plain] = (await catalogue()).data.map(openrouterModelInfo);
  const names = (m: any) => modelOptions(m).map(o => o.name);
  assert(
    !names(plain).some(n => /reasoning|effort|budget/.test(n)),
    'a model that does not reason has no reasoning options',
  );
  assert(names(ling).includes('top-k') && !names(claude).includes('top-k'), 'top-k only where the model takes top_k');
  const always = modelOptions(claude).find(o => o.name === 'reasoning')!;
  assert.equal(always.get(defaults), 'always on');
  assert.throws(() => always.set(defaults, 'off'), /always reasons/);
  const effort = modelOptions(gpt).find(o => o.name === 'effort')!;
  assert.deepEqual(effort.set(defaults, 'high'), { thinkingEffort: 'high' });
  assert.throws(() => effort.set(defaults, 'turbo'), /takes max, xhigh, high, medium, low, none/);
  assert.deepEqual(unsupportedSettings({ ...defaults, stepThinking: true }, plain), [
    `${plain.id} does not reason: reasoning is off for this run`,
  ]);
  // A run fits the config to the model: an effort it takes, its window and output limits, reasoning off where it cannot.
  const fitted = forModel(
    { ...defaults, provider: 'openrouter', stepThinking: true, thinkingEffort: 'xhigh' },
    gpt,
  ).config;
  assert.deepEqual(
    [fitted.thinkingEffort, fitted.contextWindow, fitted.maxTokens <= gpt.maxOutput],
    ['xhigh', gpt.contextLength, true],
  );
  assert.equal(
    forModel(
      { ...defaults, provider: 'openrouter', stepThinking: true, thinkingEffort: 'xhigh' },
      (await catalogue()).data
        .map(openrouterModelInfo)
        .map((m: any) => ({ ...m, reasoning: { ...m.reasoning, efforts: ['high', 'low'], defaultEffort: 'low' } }))[1],
    ).config.thinkingEffort,
    'high',
    'an effort it does not take becomes the nearest it takes, rounding down, not its default',
  );
  assert.equal(forModel({ ...defaults, stepThinking: true }, plain).config.stepThinking, false);
  const small = fitToModel(
    { ...defaults, provider: 'openrouter', workingTokens: 30000, maxTokens: 8192 },
    { ...plain, contextLength: 16000, maxOutput: 4096 },
  );
  assert.deepEqual(
    [small.contextWindow, small.maxTokens, small.workingTokens <= 16000 - small.maxTokens - small.safetyTokens],
    [16000, 4000, true],
  );
});

test('A step through OpenRouter: the JSON schema enforced where the model takes one, reasoning by effort, only the sampling it takes; the reasoning streams ahead of the reply and both come back with usage and cost', async t => {
  const reply = JSON.stringify({
    thought: 'Read the config first.',
    actions: [{ action: 'read_files', args: { files: [{ path: 'vite.config.ts', start: 1, end: 40 }] } }],
  });
  const thinking = 'The build says the plugin is missing; read the config.';
  const { url, bodies } = await mock(t, async (b, n, res) => {
    if (n === 1)
      return sse(res, [
        ...pieces(thinking).map((p, i) =>
          i % 2 ? { reasoning: p } : { reasoning_details: [{ type: 'reasoning.text', text: p }] },
        ),
        ...pieces(reply).map(p => ({ content: p })),
      ]);
    if (n === 2)
      return sse(res, [{ content: '```json\n' }, ...pieces(reply).map(p => ({ content: p })), { content: '\n```' }]);
    if (n === 3)
      return sse(
        res,
        pieces(reply.slice(0, 40)).map(p => ({ content: p })),
        'length',
      );
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { code: 502, message: 'upstream down' } })}\n\n`,
    );
    res.end();
  });
  const logs: [string, any][] = [];
  const schema = {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      actions: { type: 'array', minItems: 1, maxItems: 8, items: stepSchema },
    },
    required: ['thought', 'actions'],
    additionalProperties: false,
  } as any;
  const gpt = new OpenRouter(cfg(url, 'openai/gpt-5.6-luna-pro', { thinkingEffort: 'high' }), 'k', async (ty, d) => {
    logs.push([ty, d]);
  });
  const seen: any[] = [];
  const args = await gpt.generate(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    schema,
    0.2,
    { step: 1, route: 'step' },
    4096,
    p => seen.push({ ...p }),
    2048,
  );
  assert.deepEqual(args, JSON.parse(reply));
  assert.equal(gpt.lastMeta?.reasoning, thinking);
  assert(
    seen.some(p => p.reasoning && !p.text),
    'the reasoning is reported before the reply',
  );
  const b = bodies[0];
  assert.deepEqual(
    [
      b.stream,
      b.response_format.type,
      b.response_format.json_schema.strict,
      b.provider,
      b.reasoning,
      'top_k' in b,
      'min_p' in b,
    ],
    [true, 'json_schema', true, { require_parameters: true }, { effort: 'high' }, false, false],
  );
  const logged = logs.find(([ty]) => ty === 'bonsai')![1];
  assert.deepEqual([logged.cost, logged.reasoningChars, logged.usage.prompt_tokens], [0.0012, thinking.length, 1000]);
  // A model that enforces no schema and takes no response_format gets the schema in its prompt only, and its fenced reply is read; reasoning off where it can be.
  const ling = new OpenRouter(cfg(url, 'inclusionai/ling-3.1-flash'), 'k', async () => {});
  assert.deepEqual(await ling.generate([{ role: 'user', content: 'U' }], schema), JSON.parse(reply));
  assert.deepEqual(
    [
      bodies[1].response_format,
      bodies[1].reasoning,
      bodies[1].top_k,
      bodies[1].tools[0].function.name,
      bodies[1].tool_choice,
    ],
    [undefined, { enabled: false }, defaults.stepTopK, 'reply', { type: 'function', function: { name: 'reply' } }],
    'no schema enforced, tools taken: the reply tool, forced; a reply in text is read all the same',
  );
  await assert.rejects(
    ling.generate([{ role: 'user', content: 'U' }], schema),
    /did not finish a JSON argument object \(length\)/,
    'the length message the agent explains',
  );
  await assert.rejects(
    ling.generate([{ role: 'user', content: 'U' }], schema),
    /^Error: HTTP 502 from http:\/\/127\.0\.0\.1:\d+$/,
    'an error event mid-stream fails as the HTTP error it is, as with llama-server',
  );
  assert.deepEqual(parseJson('Here it is: {"a": 1} done'), { a: 1 });
});

test("A file through OpenRouter is the reply's fenced code block, asked for with nothing pre-filled: prose around it is dropped; a reply with no block writes nothing; a reply cut by its limit is continued after its last whole line; a loop is stopped as it streams", async t => {
  const file = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
  const loop = 'const x = 0;\n' + Array.from({ length: 30 }, () => '  doSomethingAgain(x);\n').join('');
  const { url, bodies } = await mock(t, async (b, n, res) => {
    if (n === 1)
      return sse(res, [
        { reasoning: 'Three constants.' },
        ...pieces('Here is the file:\n```ts\n' + file + '```\nIt exports three constants.', 9).map(p => ({
          content: p,
        })),
      ]);
    if (n === 2)
      return sse(
        res,
        pieces('```ts\n' + file.slice(0, 30), 9).map(p => ({ content: p })),
        'length',
      );
    if (n === 3)
      return sse(
        res,
        pieces('```ts\nexport const b = 2;\nexport const c = 3;\n```', 9).map(p => ({ content: p })),
      );
    if (n === 4)
      return sse(
        res,
        pieces('```ts\n' + loop, 11).map(p => ({ content: p })),
      );
    if (n === 5) return sse(res, [{ content: '{"thought":"Write the stylesheet next.","actions":[]}' }]);
  });
  const logs: [string, any][] = [];
  const or = new OpenRouter(cfg(url, 'inclusionai/ling-3.1-flash'), 'k', async (ty, d) => {
    logs.push([ty, d]);
  });
  const seen: any[] = [];
  const g = await or.generateText([{ role: 'user', content: 'Write it.' }], {
    fence: '```ts',
    think: 1024,
    progress: p => seen.push({ ...p }),
  });
  assert.equal(g.text, file);
  assert.equal(g.meta.reasoning, 'Three constants.');
  assert.equal(g.finish, 'stop');
  assert.deepEqual(
    [bodies[0].messages, 'stop' in bodies[0], bodies[0].reasoning, bodies[0].temperature],
    [[{ role: 'user', content: 'Write it.' }], false, { effort: 'medium' }, defaults.codeTemperature],
    'nothing pre-filled, no stop sequence',
  );
  assert(
    seen.some(p => p.reasoning && !p.text) &&
      seen.some(p => p.text.startsWith('export const a')) &&
      seen.every(p => !p.text.includes('Here is')),
    'only the code shows as it is written',
  );
  const two = await or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```ts' });
  assert.equal(two.text, file);
  assert.equal(two.meta.continuations, 1);
  assert.deepEqual(
    bodies[2].messages.slice(-2).map((m: any) => m.role),
    ['assistant', 'user'],
  );
  assert.equal(
    bodies[2].messages.at(-2).content,
    '```ts\nexport const a = 1;\n',
    'sent back up to its last whole line',
  );
  assert.match(bodies[2].messages.at(-1).content, /right after the line "export const a = 1;"/);
  const cut = await or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```ts' });
  assert.equal(cut.finish, 'repetition');
  assert.equal(cut.cut?.kind, 'lines');
  assert.equal(cut.text, 'const x = 0;\n  doSomethingAgain(x);\n');
  // Run 91 step 10: a reply that is a step's JSON, not the file, was written into src/index.css. It writes nothing now.
  await assert.rejects(
    or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```css' }),
    /holds no fenced code block, so nothing was written; it begins: "\{\\"thought\\"/,
  );
  assert.equal(
    logs.filter(([ty]) => ty === 'bonsai-error').at(-1)![1].reply,
    '{"thought":"Write the stylesheet next.","actions":[]}',
  );
});

test('Calls are repaired only where they read one way: paths for file entries, a bare path, too many files, write with a whole file; anything else is left for the schema to refuse', async () => {
  const { repairCalls } = await import('../src/repair.js');
  const r = (args: any, action = 'read_files') => repairCalls([{ action, args }]);
  const range = (path: string, start = 1, end = 1000000) => ({ path, start, end });
  assert.deepEqual(
    r({ files: [range('a.ts', 3, 9)] }),
    { calls: [{ action: 'read_files', args: { files: [range('a.ts', 3, 9)] } }], repairs: [] },
    'a call as it should be: untouched',
  );
  // A range left out is the whole file by the tool's own defaults (withDefaults): not a repair.
  assert.deepEqual(r({ files: ['a.ts', { path: 'b.ts', start: 40 }] }).calls, [
    { action: 'read_files', args: { files: [{ path: 'a.ts' }, { path: 'b.ts', start: 40 }] } },
  ]);
  assert.deepEqual(r({ path: 'a.ts', start: 5, end: 8, purpose: 'x' }).calls, [
    { action: 'read_files', args: { files: [range('a.ts', 5, 8)] } },
  ]);
  assert.deepEqual(r({ paths: ['a.ts', 'b.ts'] }).calls, [
    { action: 'read_files', args: { files: [{ path: 'a.ts' }, { path: 'b.ts' }] } },
  ]);
  // write with a whole file and nothing to replace: by whether the file exists.
  const w = (args: any, exists: boolean) => repairCalls([{ action: 'write', args }], () => exists).calls;
  assert.deepEqual(w({ path: 'a.ts', content: 'x', expectedHash: 'h' }, true), [
    { action: 'rewrite_file', args: { path: 'a.ts', content: 'x' } },
  ]);
  assert.deepEqual(w({ path: 'n.ts', content: 'x' }, false), [
    { action: 'create_file', args: { path: 'n.ts', content: 'x' } },
  ]);
  assert.deepEqual(
    w({ path: 'a.ts', content: 'x', oldText: 'y' }, true),
    [{ action: 'write', args: { path: 'a.ts', content: 'x', oldText: 'y' } }],
    'text to replace named: left for the schema',
  );
  assert.deepEqual(
    w({ path: 'a.ts', oldText: 'y', newText: 'z' }, true),
    [{ action: 'write', args: { path: 'a.ts', oldText: 'y', newText: 'z' } }],
    'a write as it should be: untouched',
  );
  assert.deepEqual(
    r({ files: ['1', '2', '3', '4', '5', '6', '7'].map(p => range(p)) }).calls.map(c => c.args.files.length),
    [3, 3, 1],
    'seven files, three reads, in order',
  );
  assert.deepEqual(
    r({ files: [{ start: 1, end: 2 }] }).calls[0]!.args,
    { files: [{ start: 1, end: 2 }] },
    'no path: left for the schema',
  );
  assert.deepEqual(r({ query: 'x' }).calls[0]!.args, { query: 'x' }, 'not a read: left as written');
  assert.deepEqual(
    r({ files: ['a.ts'] }, 'search_codebase').calls[0]!.args,
    { files: ['a.ts'] },
    'another action: untouched',
  );
  const { argsProblem } = await import('../src/agent.js');
  for (const c of [
    ...r({ files: ['1', '2', '3', '4'] }).calls,
    ...r({ path: 'a.ts', purpose: 'x' }).calls,
    ...w({ path: 'a.ts', content: 'x', expectedHash: 'h' }, true),
    ...w({ path: 'n.ts', content: 'x' }, false),
  ])
    assert.equal(
      argsProblem(c.action, c.args, ['read_files', 'rewrite_file', 'create_file']),
      undefined,
      'every repaired call passes the schema',
    );
});

test("Under the tools form a step is the model's own tool calling: each action a tool, the text the thought, the calls the batch, files written in the calls and kept whole in the transcript; every call gets its result; a bad call is refused alone; turns are counted; the working budget is the model's", async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-or-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'r'));
  await store.init();
  const check = "node -e \"import('./src/greet.mjs').then(m => process.exit(m.greet('a') === 'Hello, a' ? 0 : 1))\"";
  const content = `// ${'A greeting for whoever is named. '.repeat(10).trim()}\nexport const greet = name => \`Hi, \${name}\`;\n`;
  const steps: { text: string; calls: [string, string][]; finish?: string }[] = [
    {
      text: 'Write the module.',
      calls: [
        ['create_file', JSON.stringify({ path: 'src/greet.mjs', content })],
        ['plan', JSON.stringify({ notes: 'greet written; check next' })],
      ],
    },
    // A read whose file has no path (nothing to repair: see repairCalls) is refused alone, and its batch stops there.
    {
      text: 'Read everything first.',
      calls: [
        ['read_files', JSON.stringify({ files: [{ start: 1, end: 9 }] })],
        ['plan', JSON.stringify({ notes: 'x' })],
      ],
    },
    // An exact replacement without a hash, then the check, in one batch.
    {
      text: 'Say hello, then check.',
      calls: [
        ['write', JSON.stringify({ path: 'src/greet.mjs', oldText: '`Hi, ${name}`', newText: '`Hello, ${name}`' })],
        ['bash', JSON.stringify({ command: check, purpose: 'check', check: true })],
      ],
    },
    {
      text: 'Done.',
      calls: [['finish', JSON.stringify({ summary: 'src/greet.mjs exports greet; the check passes.' })]],
    },
  ];
  let step = 0;
  const { url, bodies } = await mock(t, async (b, _n, res) => {
    const s = steps[step++]!;
    return sse(
      res,
      [
        { reasoning: `Step ${step} reasoning.` },
        ...pieces(s.text, 6).map(p => ({ content: p })),
        ...s.calls.flatMap(([name, args], index) =>
          pieces(args, 25).map((p, i) => ({
            tool_calls: [
              {
                index,
                ...(i ? {} : { id: `call_${step}_${index}`, type: 'function' }),
                function: { ...(i ? {} : { name }), arguments: p },
              },
            ],
          })),
        ),
      ],
      s.finish ?? 'tool_calls',
    );
  });
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  const jev = {
    decide: async (_s: unknown, q: Questions, ctx?: { phase: string }): Promise<Answers> => {
      if (ctx?.phase === 'watchdog')
        return {
          progress: noul(0.8),
          same_failure: noul(0.05),
          stuck: noul(0.05),
          objective_satisfied: noul(0.3),
          needs_user: noul(0.05),
          in_scope: noul(0.9),
        } as any;
      if (ctx?.phase === 'evidence-gate')
        return {
          implementation_matches_request: noul(0.9),
          requirement_unaddressed: noul(0.1),
          claim_supported: noul(0.9),
          weakest_evidence: {
            type: 'choice',
            choice: 'sources',
            confidence: 0.5,
            probabilities: { observation: 0.1, verification: 0.2, sources: 0.5, requirements: 0.2 },
          },
          verification_needed: {
            type: 'choice',
            choice: 'deterministic_only',
            confidence: 0.9,
            probabilities: { deterministic_only: 0.9, semantic_review: 0.05, human: 0.05 },
          },
        } as any;
      if (ctx?.phase === 'failure-triage')
        return { failure: { type: 'choice', choice: 'code_bug', confidence: 0.9, probabilities: {} } } as any;
      return Object.fromEntries(Object.keys(q).map(k => [k, noul(0.5)])) as any;
    },
  };
  const gpt = (await catalogue()).data.map(openrouterModelInfo)[1];
  const { config: fitted } = forModel(
    cfg(url, gpt.id, { stepThinking: true, thinkingEffort: 'medium', maxSteps: 2 }),
    gpt,
  );
  assert.deepEqual(
    [fitted.promptForm, fitted.workingTokens, fitted.allowWrite, fitted.allowBash, fitted.openrouterMaxTurns],
    ['tools', 64000, true, true, 120],
    'tools form; a quarter of the window, at most 64000; write and shell on by default',
  );
  const or = new OpenRouter(fitted, 'k', store.log.bind(store));
  const shown: any[] = [];
  const s = await new Agent(
    fitted,
    store,
    jev as any,
    or,
    root,
    () => {},
    e => shown.push(e),
  ).run(await newSession(root, 'Add a greet function'));
  assert.equal(s.status, 'complete', s.stopReason);
  assert.equal(s.form, 'tools');
  assert(
    s.step > 2 && shown.filter(e => e.kind === 'step').every(e => e.maxTurn === 120 && e.turn >= 1 && e.turn <= 4),
    "turns are counted, not steps (maxSteps 2 is Bonsai's)",
  );
  assert.equal(await readFile(join(root, 'src', 'greet.mjs'), 'utf8'), content.replace('Hi, ', 'Hello, '));
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
  assert.deepEqual(
    events.filter(e => e.type === 'reasoning').map(e => e.data.text),
    ['Step 1 reasoning.', 'Step 2 reasoning.', 'Step 3 reasoning.', 'Step 4 reasoning.'],
  );
  assert(
    shown.some(
      e =>
        e.kind === 'thought' &&
        e.thought === 'Write the module.' &&
        e.actions.map((a: any) => a.action).join() === 'create_file,plan' &&
        e.reasoning === 'Step 1 reasoning.',
    ),
    'the turn reaches the display with its reasoning',
  );
  assert.match(
    events.find(e => e.type === 'refused')!.data.why,
    /^read_files arguments\.files\[0\]: missing path$/,
    'the bad call alone is refused, by what is wrong with it',
  );
  assert.equal(bodies.length, 4, 'one request a turn: no file is generated in a request of its own');
  // The model caches, so its cache points arrive as text parts: read as the text they carry (caching has a test of its own).
  assert(bodies.every(b => b.messages.some((m: any) => Array.isArray(m.content))));
  for (const b of bodies)
    for (const m of b.messages) if (Array.isArray(m.content)) m.content = m.content.map((p: any) => p.text).join('');
  assert(
    bodies.every(
      b =>
        b.tool_choice === 'auto' &&
        b.reasoning?.effort === 'medium' &&
        !b.response_format &&
        b.max_tokens >= fitted.maxTokens + fitted.createTokens,
    ),
    'a model that reasons chooses its calls; a step has room for a file',
  );
  assert.deepEqual(bodies[0].tools.map((x: any) => x.function.name).sort(), [...gptActions].sort());
  const tool = (name: string) => bodies[0].tools.find((x: any) => x.function.name === name).function;
  assert.deepEqual(
    [
      tool('create_file').parameters.required,
      tool('rewrite_file').parameters.required,
      tool('write').parameters.required,
    ],
    [
      ['path', 'content'],
      ['path', 'content'],
      ['path', 'oldText', 'newText'],
    ],
  );
  assert.match(tool('create_file').description, /^Create a file that does not exist yet with its whole content: /);
  assert.doesNotMatch(tool('create_file').description + tool('rewrite_file').description, /generated|purpose/);
  assert.deepEqual(tool('read_files').parameters, toolSchema('read_files'));
  assert.equal(bodies[0].messages[0].content, agentSystem());
  assert(!('actions' in JSON.parse(bodies[0].messages[1].content)), 'the actions are the tools, not the pinned block');
  assert.doesNotMatch(bodies[0].messages.at(-1).content, /Write thought:|pinned block/);
  // Step 2's prompt: the first turn as the model's own calls, the file's content whole, each call answered right after it.
  const second = bodies[1].messages;
  const turn = second.findIndex((m: any) => m.role === 'assistant');
  assert.deepEqual(
    [second[turn].content, second[turn].tool_calls.map((c: any) => [c.id, c.function.name])],
    [
      'Write the module.',
      [
        ['t1_0', 'create_file'],
        ['t1_1', 'plan'],
      ],
    ],
  );
  assert.equal(
    JSON.parse(second[turn].tool_calls[0].function.arguments).content,
    content,
    'what the model wrote is in its turn, whole',
  );
  assert.deepEqual(
    second.slice(turn + 1, turn + 3).map((m: any) => [m.role, m.tool_call_id, JSON.parse(m.content).evidence.id]),
    [
      ['tool', 't1_0', 'e1'],
      ['tool', 't1_1', 'e2'],
    ],
  );
  assert(
    bodies[1].messages
      .slice(0, bodies[0].messages.length - 2)
      .every((m: any, i: number) => JSON.stringify(m) === JSON.stringify(bodies[0].messages[i])),
    'the prompt only grows: a cacheable prefix',
  );
  const third = bodies[2].messages;
  const t2 = third.find((m: any) => m.role === 'assistant' && m.content === 'Read everything first.');
  if (t2) {
    const answers = third.filter(
      (m: any) => m.role === 'tool' && m.tool_call_id.startsWith(t2.tool_calls[0].id.split('_')[0] + '_'),
    );
    assert.match(JSON.parse(answers[0].content).evidence.text, /^No action executed: read_files arguments/);
    assert.equal(answers[1].content, 'Not run: the batch stopped at an earlier call.');
  } else
    assert(
      third.some((m: any) => m.role === 'user' && /No action executed: read_files arguments/.test(m.content)),
      'a turn whose every call was refused leaves; its refusal stays',
    );
  for (const body of bodies)
    for (const [i, m] of (body.messages as any[]).entries())
      if (m.tool_calls)
        assert.deepEqual(
          body.messages.slice(i + 1, i + 1 + m.tool_calls.length).map((x: any) => x.tool_call_id),
          m.tool_calls.map((c: any) => c.id),
          'every call answered right after it',
        );
  // As a native step streams, it is shown as the step reply it becomes: the thought, then each call as it is written.
  steps.push({ text: 'Plan it.', calls: [['plan', JSON.stringify({ notes: 'next' })]] });
  const seen: string[] = [];
  const schema = {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      actions: { type: 'array', minItems: 1, maxItems: 8, items: stepSchema },
    },
  } as any;
  const reply = await or.generate([{ role: 'user', content: 'U' }], schema, 0.2, undefined, 4096, p =>
    seen.push(p.text),
  );
  assert.deepEqual(reply, { thought: 'Plan it.', actions: [{ action: 'plan', args: { notes: 'next' } }] });
  assert(
    seen.includes('{"thought":"Plan it.","actions":[') &&
      seen.at(-1) === '{"thought":"Plan it.","actions":[{"action":"plan","args":{"notes":"next"}' &&
      seen.every(x => !x || x.startsWith('{"thought"')),
    seen.join('\n'),
  );
  // A reply cut by its output limit inside a call keeps the calls it finished; the cut one is not run, and says why.
  steps.push({
    text: 'Two files.',
    calls: [
      ['plan', JSON.stringify({ notes: 'two' })],
      ['create_file', '{"path":"big.ts","content":"export const a = [1, 2,'],
    ],
    finish: 'length',
  });
  const cutReply = await or.generate([{ role: 'user', content: 'U' }], schema, 0.2, undefined, 4096);
  assert.deepEqual(cutReply.actions[0], { action: 'plan', args: { notes: 'two' } });
  assert.match(
    cutReply.actions[1].problem,
    /reached its \d+-token output limit inside this create_file call \(\d+ characters of arguments\), so it was cut off and not run/,
  );
});
const gptActions = [
  'read_files',
  'search_codebase',
  'bash',
  'create_file',
  'rewrite_file',
  'write',
  'replace_lines',
  'move_lines',
  'plan',
  'observe',
  'finish',
  'ask_user',
];

test('Under the tools form a file written in an earlier turn is said in one line, not re-sent; the latest turn keeps what it wrote; a turn changes once, when it stops being the latest (run react-demo-glm-3: 28,000 characters of written files in each of twelve prompts)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-elide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await newSession(dir, 'x');
  s.form = 'tools';
  s.allowedActions = ['create_file', 'write', 'plan'];
  const big = (name: string) =>
    Array.from({ length: 50 }, (_, i) => `export const ${name}${i} = ${i}; // line ${i}`).join('\n');
  const turn = (id: string, step: number, actions: any[]) => ({
    id,
    step,
    kind: 'turn' as const,
    artifact: '',
    relevance: 0.5,
    outcomes: actions.map(a => `${a.action} ok`),
    text: JSON.stringify({ thought: `Turn ${id}.`, actions }),
  });
  const result = (id: string, step: number, of: string, kind = 'create_file') => ({
    id,
    step,
    kind,
    artifact: 'a',
    relevance: 0.5,
    turn: of,
    text: 'written',
  });
  s.entries.push(
    turn('t1', 1, [
      { action: 'create_file', args: { path: 'src/App.tsx', content: big('a') } },
      { action: 'write', args: { path: 'src/main.tsx', oldText: 'x', newText: 'y' } },
    ]),
    result('e1', 1, 't1'),
    result('e2', 2, 't1', 'write'),
    turn('t3', 3, [{ action: 'create_file', args: { path: 'src/index.css', content: big('c') } }]),
    result('e3', 3, 't3'),
  );
  const args = (m: Message[]) =>
    m.filter(x => x.role === 'assistant').map(x => x.tool_calls!.map(c => JSON.parse(c.function.arguments)));
  const first = stepMessages(s, s.allowedActions);
  const [t1, t3] = args(first);
  assert.match(
    t1![0].content,
    /^\[50 lines \(\d+ characters\) written at step 1; not repeated here: read_files shows src\/App\.tsx as it is now\]$/,
  );
  assert.deepEqual(t1![1], { path: 'src/main.tsx', oldText: 'x', newText: 'y' }, 'a short edit is shown as made');
  assert.equal(t3![0].content, big('c'), 'the latest turn shows what it wrote');
  s.entries.push(turn('t4', 4, [{ action: 'plan', args: { notes: 'n' } }]), result('e4', 4, 't4', 'plan'));
  const second = stepMessages(s, s.allowedActions);
  assert.match(args(second)[1]![0].content, /^\[50 lines .* src\/index\.css as it is now\]$/, 'no longer the latest');
  const at = first.findIndex(m => m.role === 'assistant' && m.content === 'Turn t3.');
  assert(at > 0);
  assert.deepEqual(
    second.slice(0, at),
    first.slice(0, at),
    'everything before that turn is as it was: the cache prefix holds',
  );
});

test('The tools are described briefly, each rule the harness enforces kept', () => {
  const descriptions = gptActions.map(a => actionTool(a).function.description);
  const total = descriptions.reduce((n, d) => n + d.length, 0);
  assert(total < 6000, `${total} characters of descriptions`);
  assert(
    descriptions.every(d => d.length <= 700),
    'none runs long',
  );
  const of = (a: string) => actionTool(a).function.description;
  assert.match(of('bash'), /check of record/);
  assert.match(of('bash'), /do not cd elsewhere/);
  assert.match(of('finish'), /verificationAfterLastWrite/);
  assert.match(of('write'), /copied exactly/);
  assert.match(of('replace_lines'), /expectedHash/);
  assert.match(of('read_files'), /up to three/);
  assert.match(of('create_file'), /call of its own/);
});

test("A model's OpenRouter endpoints are asked for in order of what Leana's requests cost there (mostly cached prompt, some output), those down, too small or without tools left out (run react-demo-glm-3: billed at wafer/fp4, $0.179 per million prompt tokens, where wafer/us lists $0.079)", async t => {
  const { endpointOrder, requestCost } = await import('../src/models.js');
  const e = (tag: string, prompt: number, cacheRead: number | undefined, completion: number, more: any = {}) => ({
    tag,
    prompt: prompt / 1e6,
    completion: completion / 1e6,
    ...(cacheRead === undefined ? {} : { cacheRead: cacheRead / 1e6 }),
    context: 1048576,
    params: ['tools', 'reasoning'],
    up: true,
    ...more,
  });
  // GLM-5.3's endpoints on 2026-10-19 (dollars per million tokens), and three that cannot serve a step.
  const glm = [
    e('morph/fp8', 0.04, 0.025, 6.0),
    e('wafer/us', 0.079, 0.078, 1.4),
    e('inference-net/fp4', 0.08, 0.076, 4.381),
    e('wafer/fp4', 0.179, 0.178, 1.4),
    e('sail-research/us', 0.5, 0.119, 1.505),
    e('relace', 0.75, 0.075, 2.4),
    e('nebius/fp4', 1.4, undefined, 4.4),
    e('friendli', 0.01, 0.01, 0.01, { up: false }),
    e('tiny', 0.01, 0.01, 0.01, { context: 32000 }),
    e('notools', 0.01, 0.01, 0.01, { params: ['reasoning'] }),
  ];
  const need = { context: 112000, output: 20000, params: ['tools'] };
  assert.deepEqual(endpointOrder(glm, need), [
    'wafer/us',
    'sail-research/us',
    'wafer/fp4',
    'relace',
    'inference-net/fp4',
  ]);
  assert(requestCost(glm[6]!) > requestCost(glm[3]!) * 5, 'no cache price: cached tokens at the full prompt price');
  // Requests name the order, with OpenRouter's fallbacks kept.
  const endpoints = [
    {
      tag: 'dear',
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      context_length: 200000,
      supported_parameters: ['tools'],
      status: 0,
    },
    {
      tag: 'cheap/us',
      pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.0000001' },
      context_length: 200000,
      supported_parameters: ['tools'],
      status: 0,
    },
  ];
  const schema = {
    type: 'object' as const,
    properties: { content: { type: 'string' as const } },
    required: ['content'],
    additionalProperties: false as const,
  };
  const prompt = [{ role: 'user' as const, content: '{"request":"next"}' }];
  const reply = async (_b: any, _n: number, res: ServerResponse) => sse(res, [{ content: '{"content":"ok"}' }]);
  const routed = await mock(t, reply, [], endpoints);
  const events: any[] = [];
  const or = new OpenRouter(cfg(routed.url, 'anthropic/claude-sonnet-5.5'), 'k', async (type, data) => {
    events.push({ type, data });
  });
  await or.generate(prompt, schema);
  await or.generate(prompt, schema);
  for (const b of routed.bodies) {
    assert.deepEqual(b.provider.order, ['cheap/us', 'dear']);
    assert.equal(b.provider.allow_fallbacks, true);
  }
  assert.equal(events.filter(x => x.type === 'provider-order').length, 1, 'worked out once a run');
  const asIs = await mock(t, reply, [], endpoints);
  await new OpenRouter(
    cfg(asIs.url, 'anthropic/claude-sonnet-5.5', { openrouterRouting: 'default' }),
    'k',
    async () => {},
  ).generate(prompt, schema);
  assert.equal(asIs.bodies[0].provider?.order, undefined, 'routing left to OpenRouter');
  const unlisted = await mock(t, reply);
  await new OpenRouter(cfg(unlisted.url, 'anthropic/claude-sonnet-5.5'), 'k', async () => {}).generate(prompt, schema);
  assert.equal(unlisted.bodies[0].provider?.order, undefined, 'no endpoint list: the request goes as before');
});

test('Under the tools form a result that no longer describes the repository and holds nothing current is said in one line, with why and where it is kept; one that still holds lines no later read shows stays whole (run react-demo-glm-8: six re-reads of its own files, each whole in every later prompt)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await newSession(dir, 'x');
  s.form = 'tools';
  s.allowedActions = ['read_files', 'write', 'plan'];
  const read = (path: string) =>
    `${path} sha256=abc totalLines=40 shown=1..40\n${Array.from({ length: 40 }, (_, i) => `${i + 1}: const v${i} = ${i};`).join('\n')}`;
  const turn = (id: string, step: number, actions: any[]) => ({
    id,
    step,
    kind: 'turn' as const,
    artifact: '',
    relevance: 0.5,
    outcomes: actions.map(a => `${a.action} ok`),
    text: JSON.stringify({ thought: `Turn ${id}.`, actions }),
  });
  s.entries.push(
    turn('t1', 1, [{ action: 'read_files', args: { files: [{ path: 'src/a.ts' }] } }]),
    {
      id: 'e1',
      step: 1,
      kind: 'read_files',
      artifact: '@artifact/00001.txt',
      relevance: 0.5,
      turn: 't1',
      text: read('src/a.ts'),
      stale: 'edited at step 3: text and line numbers no longer match src/a.ts',
    },
    turn('t2', 2, [{ action: 'read_files', args: { files: [{ path: 'src/b.ts' }] } }]),
    {
      id: 'e2',
      step: 2,
      kind: 'read_files',
      artifact: '@artifact/00002.txt',
      relevance: 0.5,
      turn: 't2',
      text: read('src/b.ts'),
      stale: 'superseded by the read at step 9',
    },
    turn('t3', 3, [{ action: 'write', args: { path: 'src/a.ts', oldText: 'v0', newText: 'w0' } }]),
    { id: 'e3', step: 3, kind: 'write', artifact: 'a', relevance: 0.5, turn: 't3', text: 'written' },
  );
  s.writeSteps = { 'src/a.ts': 3 };
  const results = stepMessages(s, s.allowedActions)
    .filter(m => m.role === 'tool')
    .map(m => JSON.parse(m.content).evidence);
  assert.equal(
    results[0].text,
    '[left out: edited at step 3: text and line numbers no longer match src/a.ts. @artifact/00001.txt holds it in full.]',
  );
  assert.equal(results[1].text, read('src/b.ts'), 'its lines are shown by no later read and b.ts was not edited: kept');
  assert.equal(results[2].text, 'written');
});

test("The tools form leaves Bonsai's prompt as it was: no session form, the same system message, the actions pinned, turns as JSON", async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-form-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await newSession(dir, 'x');
  s.allowedActions = ['read_files', 'plan'];
  s.entries.push(
    {
      id: 't1',
      step: 1,
      kind: 'turn',
      artifact: '',
      relevance: 0.5,
      outcomes: ['plan ok'],
      text: JSON.stringify({ thought: 'Plan.', actions: [{ action: 'plan', args: { notes: 'n' } }] }),
    },
    { id: 'e1', step: 1, kind: 'plan', artifact: 'a', relevance: 0.5, turn: 't1', text: 'notes saved' },
  );
  const bonsai = stepMessages(s, ['read_files', 'plan']);
  assert.equal(bonsai[0]!.content, AGENT_SYSTEM);
  assert('actions' in JSON.parse(bonsai[1]!.content));
  assert.deepEqual(
    bonsai.slice(2, 4).map(m => [m.role, 'tool_calls' in m]),
    [
      ['assistant', false],
      ['user', false],
    ],
  );
  s.form = 'tools';
  const tools = stepMessages(s, ['read_files', 'plan']);
  assert.deepEqual(
    tools.slice(2, 4).map(m => [m.role, m.tool_calls?.[0]?.id ?? m.tool_call_id]),
    [
      ['assistant', 't1_0'],
      ['tool', 't1_0'],
    ],
  );
  // A call that ran and whose result was evicted, and one the batch never reached.
  s.entries = [
    {
      ...s.entries[0]!,
      outcomes: ['plan ok'],
      text: JSON.stringify({
        thought: 'Two.',
        actions: [
          { action: 'plan', args: { notes: 'n' } },
          { action: 'read_files', args: { files: [] } },
        ],
      }),
    },
  ];
  assert.deepEqual(
    stepMessages(s, ['read_files', 'plan'])
      .filter(m => m.role === 'tool')
      .map(m => m.content),
    [
      'Ran; its result has left the evidence (earlierSteps summarises it).',
      'Not run: the batch stopped at an earlier call.',
    ],
  );
  // The working budget: Bonsai's as configured, an OpenRouter model's fitted to its window unless set.
  const [claude] = (await catalogue()).data.map(openrouterModelInfo);
  assert.equal(
    fitToModel({ ...defaults, provider: 'openrouter' }, claude).workingTokens,
    Math.min(64000, Math.floor(claude.contextLength / 4)),
  );
  assert.equal(
    fitToModel({ ...defaults, provider: 'openrouter', openrouterWorkingTokens: 20000 }, claude).workingTokens,
    20000,
  );
  assert.equal(
    fitToModel({ ...defaults, provider: 'openrouter' }, { ...claude, params: ['max_tokens'] }).promptForm,
    'text',
  );
  assert.equal(
    modelOptions(claude)
      .find(o => o.name === 'working-tokens')!
      .get(defaults),
    `auto (${Math.min(64000, Math.floor(claude.contextLength / 4))})`,
  );
});

test('The app offers and sets only what the active provider and model take, switches provider and model, and keeps its choices', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { url } = await mock(t, () => {});
  const settingsPath = join(dir, 'settings.json');
  const said: string[] = [];
  await mkdir(join(dir, 'repo'));
  const app = new App({
    base: await loadConfig(undefined, { openrouterUrl: url }),
    settings: { config: { openrouterUrl: url } },
    jevKey: 'j',
    repo: join(dir, 'repo'),
    settingsPath,
    write: l => said.push(l),
  });
  const run = async (line: string) => {
    said.length = 0;
    await app.handle(line);
    return said.join('\n');
  };
  assert.match(await run('/provider openrouter'), /provider: openrouter; choose a model/);
  assert.match(await run('/models gpt'), /openai\/gpt-5\.6-luna-pro/);
  assert.match(await run('/model inclusionai/ling-3.1-flash'), /model: inclusionai\/ling-3\.1-flash/);
  const opts = await run('/options');
  assert.match(opts, /top-k/);
  assert.match(opts, /effort .*max \| xhigh \| high \| medium \| low \| minimal \| none/);
  assert.match(await run('/model unbiased/pareto-26.10-preview'), /model: unbiased\/pareto-26\.10-preview/);
  assert.doesNotMatch(
    await run('/options'),
    /^\s+(reasoning|file-reasoning|effort|budget|file-budget|reasoning-temperature|top-k)\s/m,
    'a model that does not reason and takes no top_k offers neither',
  );
  assert.match(await run('/effort high'), /does not take effort; it takes/);
  assert.match(await run('/model anthropic/claude-sonnet-5.5'), /model: anthropic/);
  assert.match(await run('/reasoning off'), /always reasons; it cannot be turned off/);
  assert.match(await run('/effort turbo'), /takes max, xhigh, high, medium, low/);
  assert.match(await run('/effort low'), /effort: low/);
  assert.match(
    await run('/info'),
    /reasoning: always on; efforts max, xhigh, high, medium, low \(default high\); token budget yes/,
  );
  const kept = await loadSettings(settingsPath);
  assert.deepEqual(
    [kept.config.provider, kept.config.model, kept.config.thinkingEffort],
    ['openrouter', 'anthropic/claude-sonnet-5.5', 'low'],
    'kept between runs',
  );
  assert.deepEqual(app.complete('/eff'), [['/effort'], '/eff']);
  assert.deepEqual(app.complete('/effort l')[0], ['low']);
  assert.match(await run('/allow bash on'), /bash: on \(commands run unsandboxed/);
  assert.match(await run('/nonsense'), /No command \/nonsense/);
  assert.equal(await app.handle('/quit'), 'quit');
  await writeFile(join(dir, 'x'), '');
});

// The catalogue entry of the model of run react-demo-90 (2026-10-04): it always reasons, takes tools and
// response_format, and enforces no JSON schema.
const bunny = {
  id: 'stealth/space-bunny-alpha',
  name: 'Space Bunny (alpha)',
  context_length: 1000000,
  top_provider: { max_completion_tokens: 524288 },
  supported_parameters: [
    'include_reasoning',
    'max_tokens',
    'reasoning',
    'reasoning_effort',
    'response_format',
    'temperature',
    'tool_choice',
    'tools',
    'top_p',
  ],
  reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'max' },
  pricing: { prompt: '0', completion: '0' },
};
const textOnly = {
  ...bunny,
  id: 'some/text-only',
  supported_parameters: ['max_tokens', 'temperature'],
  reasoning: undefined,
};

test("A model that enforces no JSON schema still gets the reply's schema: through the reply tool where it takes tools, else stated in its system message; it is not told it is Bonsai; a reply that misses the schema is logged and explained by what it holds", async t => {
  const reply = { thought: 'Scaffold with Vite.', actions: [{ action: 'plan', args: { notes: 'scaffold' } }] };
  const schema = {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      actions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            action: { const: 'plan' },
            args: { type: 'object', properties: { notes: { type: 'string' } } },
          },
          required: ['action', 'args'],
        },
      },
    },
    required: ['thought', 'actions'],
    additionalProperties: false,
  } as any;
  const { url, bodies } = await mock(
    t,
    async (b, n, res) => {
      const json = JSON.stringify(reply);
      if (n === 1)
        return sse(
          res,
          [
            { reasoning: 'Empty repo; scaffold.' },
            { content: 'Calling the tool.' },
            ...pieces(json, 30).map((p, i) => ({
              tool_calls: [
                {
                  index: 0,
                  ...(i ? {} : { id: 'call_1', type: 'function' }),
                  function: { ...(i ? {} : { name: 'reply' }), arguments: p },
                },
              ],
            })),
          ],
          'tool_calls',
        );
      if (n === 2) return sse(res, [{ content: json }]);
      return sse(res, [{ content: JSON.stringify({ reasoning: 'x', action: 'plan' }) }]);
    },
    [bunny, textOnly],
  );
  const logs: [string, any][] = [];
  const or = new OpenRouter(cfg(url, bunny.id), 'k', async (ty, d) => {
    logs.push([ty, d]);
  });
  const seen: any[] = [];
  assert.deepEqual(
    await or.generate(
      [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: 'U' },
      ],
      schema,
      0.2,
      undefined,
      8192,
      p => seen.push({ ...p }),
    ),
    reply,
    'read from the tool call, not the text beside it',
  );
  assert(
    seen.some(p => p.text.startsWith('{"thought"')),
    "the call's arguments stream as the reply",
  );
  const b = bodies[0];
  assert.deepEqual(
    [b.tools.length, b.tools[0].function.parameters, b.tool_choice, b.response_format, b.reasoning, b.max_tokens],
    [1, schema, 'auto', undefined, { effort: 'medium' }, 8192 + defaults.stepThinkingBudget],
    'a model that reasons chooses the tool itself; it reasons at the configured effort, not its default max, with room for it on top of the reply',
  );
  assert.equal(b.messages[0].content, agentSystem());
  assert.doesNotMatch(b.messages[0].content, /Bonsai/);
  const plain = new OpenRouter(cfg(url, textOnly.id), 'k', async (ty, d) => {
    logs.push([ty, d]);
  });
  assert.deepEqual(
    await plain.generate(
      [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: 'U' },
      ],
      schema,
    ),
    reply,
  );
  assert.deepEqual([bodies[1].tools, bodies[1].response_format], [undefined, undefined]);
  assert(
    bodies[1].messages[0].content.startsWith(agentSystem()) &&
      bodies[1].messages[0].content.endsWith(`valid under this JSON schema:\n${JSON.stringify(schema)}`),
    'the schema stated in the system message',
  );
  await assert.rejects(
    plain.generate(
      [
        { role: 'system', content: AGENT_SYSTEM },
        { role: 'user', content: 'U' },
      ],
      schema,
    ),
    /does not match the reply schema \(args: missing thought\): it has the keys reasoning, action; the schema requires thought, actions/,
  );
  assert.equal(
    logs.filter(([ty]) => ty === 'bonsai-error').at(-1)![1].reply,
    '{"reasoning":"x","action":"plan"}',
    'what the model wrote is kept in the log',
  );
  assert.throws(
    () => parseJson('I will now scaffold the app.'),
    /not one JSON object; it begins: "I will now scaffold the app."/,
  );
});

test('Under the tools form a call may leave out what has a default: the tool schemas do not require it, and it is filled in before the call is checked; a missing hash names the one known', () => {
  const required = (r: any) => toolSchema(r).required;
  const items = (r: any, k: string) => (toolSchema(r).properties as any)[k].items.required;
  assert.deepEqual(
    [
      items('replace_lines', 'edits'),
      items('read_files', 'files'),
      required('observe'),
      items('observe', 'inputs'),
      required('bash'),
      required('search_codebase'),
    ],
    [['start', 'end'], ['path'], ['kind', 'target'], ['do'], ['command'], ['query']],
  );
  assert.deepEqual(
    schemas.replace_lines.required,
    ['path', 'expectedHash', 'edits'],
    "Bonsai's schemas are as they were",
  );
  const all = [...gptActions];
  // Run 94 steps 39-42: one deletion, refused four times over a field with an obvious value.
  const deletion = {
    path: 'src/components/sections/Hero.tsx',
    expectedHash: '6d05dd8f91ece7a0',
    edits: [{ end: 19, start: 6 }],
  };
  assert.equal(argsProblem('replace_lines', withDefaults('replace_lines', deletion), all), undefined);
  assert.deepEqual(withDefaults('replace_lines', deletion).edits, [{ end: 19, start: 6, newText: '', prepend: '' }]);
  assert.equal(
    argsProblem(
      'observe',
      withDefaults('observe', { kind: 'page', target: 'http://localhost:4173/', inputs: [{ do: 'wait', ms: 500 }] }),
      all,
    ),
    undefined,
    'run 93 steps 76-78',
  );
  assert.deepEqual(withDefaults('read_files', { files: [{ path: 'a.ts' }] }), {
    files: [{ path: 'a.ts', start: 1, end: 1000000 }],
  });
  assert.equal(
    argsProblem(
      'replace_lines',
      withDefaults('replace_lines', { path: 'src/a.ts', edits: [{ start: 1, end: 1 }] }),
      all,
      { 'src/a.ts': '0123456789abcdef' },
    ),
    'replace_lines arguments: missing expectedHash (expectedHash is the sha256 of src/a.ts as last read or edited: fileHashes has src/a.ts sha256=0123456789abcdef)',
  );
  assert.equal(
    argsProblem('write', { path: 'b.ts', oldText: 'a', newText: 'b' }, all),
    undefined,
    'an exact replacement needs no hash: its anchor is the guard',
  );
  assert.match(
    argsProblem('move_lines', { source: 'b.ts', start: 1, end: 2, destination: 'c.ts', destinationHash: 'new' }, all)!,
    /missing expectedHash \(expectedHash is the sha256 of b\.ts as last read or edited; read it first\)$/,
  );
});

test('A screenshot reaches a model that takes images as text and image parts after the cache points, which stay where they were; a model that does not take images is sent the prompt without it', async t => {
  const [claude, , ling] = (await catalogue()).data.map(openrouterModelInfo);
  assert.deepEqual([claude.images, ling.images], [true, false], 'from the catalogue: image input');
  assert(
    modelOptions(claude).some(o => o.name === 'screenshots') && !modelOptions(ling).some(o => o.name === 'screenshots'),
  );
  const { loadConfig } = await import('../src/config.js');
  await assert.rejects(loadConfig(undefined, { screenshots: 'sometimes' as any }), /screenshots must be auto or off/);
  const dir = await mkdtemp(join(tmpdir(), 'leana-shot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, 'shot.png');
  await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const msg = (role: 'system' | 'user' | 'assistant', content: string) => ({ role, content });
  const prompt = [
    msg('system', 'You are the worker.'),
    msg('user', '{"objective":"x"}'),
    msg('assistant', '{"thought":"a","actions":[]}'),
    msg('user', '{"evidence":[]}'),
    msg('assistant', '{"thought":"b","actions":[]}'),
    msg('user', '{"request":"next"}'),
  ];
  const schema = {
    type: 'object' as const,
    properties: { content: { type: 'string' as const } },
    required: ['content'],
    additionalProperties: false as const,
  };
  const reply = async (_b: any, _n: number, res: ServerResponse) => sse(res, [{ content: '{"content":"ok"}' }]);
  const withShot = [...prompt, { role: 'user' as const, content: 'Attached: the screenshot', images: [png] }];
  const seen = await mock(t, reply);
  const or = new OpenRouter(cfg(seen.url, claude.id), 'k', async () => {});
  assert.equal(await or.seesImages(), true);
  await or.generate(withShot, schema);
  await or.generate(prompt, schema);
  const [shown, after] = seen.bodies;
  const last = shown.messages.at(-1);
  assert.deepEqual(last.content, [
    { type: 'text', text: 'Attached: the screenshot' },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}` },
    },
  ]);
  assert.equal(last.images, undefined, 'the path stays here');
  const points = (b: any) =>
    b.messages
      .map((m: any, i: number) => (Array.isArray(m.content) && m.content.some((p: any) => p.cache_control) ? i : -1))
      .filter((i: number) => i >= 0);
  assert(points(after).length > 0, 'a prompt the cache points are marked in');
  assert.deepEqual(points(shown), points(after), 'the cache points where every other request puts them');
  assert.deepEqual(shown.messages.slice(0, -1), after.messages, 'everything before it the same');
  assert.equal(
    new OpenRouter(cfg(seen.url, claude.id, { screenshots: 'off' }), 'k', async () => {}).config.screenshots,
    'off',
  );
  assert.equal(
    await new OpenRouter(cfg(seen.url, claude.id, { screenshots: 'off' }), 'k', async () => {}).seesImages(),
    false,
  );
  const textOnly = await mock(t, reply);
  const plain = new OpenRouter(cfg(textOnly.url, ling.id), 'k', async () => {});
  assert.equal(await plain.seesImages(), false);
  await plain.generate(withShot, schema);
  assert.equal(textOnly.bodies[0].messages.length, prompt.length, 'sent without it');
});

test('Prompt caching through OpenRouter: the cache points are marked where the model caches, a run keeps one session for provider routing, a model without a cache price is not marked, off sends neither, and a provider that refuses the markers is asked again without them', async t => {
  const { cachePoints } = await import('../src/context.js');
  const msg = (role: any, content: string) => ({ role, content });
  // The prompt: system, orientation, evidence and turns, then the volatile block and the request.
  const prompt = [
    msg('system', 'You are the worker.'),
    msg('user', '{"objective":"x"}'),
    msg('user', '{"evidence":1}'),
    msg('assistant', 'read a.ts'),
    msg('user', '{"notes":""}'),
    msg('user', '{"role":"act"}'),
  ];
  assert.deepEqual(cachePoints(prompt), [1, 3], 'after the orientation and after the evidence');
  assert.deepEqual(
    cachePoints([...prompt.slice(0, 3), { role: 'assistant', content: '', tool_calls: [] } as any, ...prompt.slice(4)]),
    [1, 2],
    'a turn that only calls tools has no text: the point moves to the message before it',
  );
  assert.deepEqual(cachePoints([msg('user', 'x'), msg('user', 'y')]), [], 'not a prompt of the agent: nothing marked');
  const schema = {
    type: 'object' as const,
    properties: { content: { type: 'string' as const } },
    required: ['content'],
    additionalProperties: false as const,
  };
  const reply = (refuseMarked: boolean) => async (b: any, _n: number, res: ServerResponse) => {
    if (refuseMarked && b.messages.some((m: any) => Array.isArray(m.content))) {
      res.statusCode = 400;
      res.end('{"error":{"message":"unknown field"}}');
      return;
    }
    if (/code/.test(JSON.stringify(b.messages.at(-1)))) {
      await sse(res, [{ content: '```\nconst a = 1;\n```' }]);
      return;
    }
    await sse(res, [{ content: '{"content":"ok"}' }], 'stop', {
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
    } as any);
  };
  const marked = (b: any) =>
    b.messages.map((m: any, i: number) => (Array.isArray(m.content) ? i : -1)).filter((i: number) => i >= 0);
  // A model whose catalogue lists a cache-read price: both points marked, as text parts with cache_control; one session_id for the run.
  const caching = await mock(t, reply(false));
  const events: any[] = [];
  const claude = new OpenRouter(cfg(caching.url, 'anthropic/claude-sonnet-5.5'), 'k', async (type, data) => {
    events.push({ type, data });
  });
  await claude.generate(prompt, schema);
  await claude.generate(prompt, schema);
  await claude.generateText([...prompt.slice(0, 5), msg('user', '{"role":"write the code"}')], { budgetTokens: 200 });
  for (const b of caching.bodies) assert.deepEqual(marked(b), [1, 3], 'the points, and nothing else');
  assert.deepEqual(caching.bodies[0].messages[1].content, [
    { type: 'text', text: '{"objective":"x"}', cache_control: { type: 'ephemeral' } },
  ]);
  assert.equal(caching.bodies[0].messages[0].content, 'You are the worker.', 'the rest as it was');
  assert(
    caching.bodies[0].session_id && caching.bodies.every(b => b.session_id === caching.bodies[0].session_id),
    'one session for the run',
  );
  assert.equal(
    claude.lastMeta?.usage?.prompt_tokens_details?.cached_tokens,
    0,
    'a file generation keeps the cached tokens its replies report',
  );
  assert(
    events.some(e => e.type === 'bonsai' && e.data.usage?.prompt_tokens_details?.cached_tokens === 800),
    'cached tokens are logged as the provider reports them',
  );
  // A model with no cache price: nothing marked, still one provider for the run.
  const plain = await mock(t, reply(false));
  await new OpenRouter(cfg(plain.url, 'inclusionai/ling-3.1-flash'), 'k', async () => {}).generate(prompt, schema);
  assert.deepEqual(marked(plain.bodies[0]), []);
  assert(plain.bodies[0].session_id);
  // Off: neither.
  const off = await mock(t, reply(false));
  await new OpenRouter(
    cfg(off.url, 'anthropic/claude-sonnet-5.5', { promptCache: 'off' }),
    'k',
    async () => {},
  ).generate(prompt, schema);
  assert.deepEqual(marked(off.bodies[0]), []);
  assert.equal(off.bodies[0].session_id, undefined);
  // A provider that refuses the markers: the request is sent again without them, and the run goes on unmarked.
  const refusing = await mock(t, reply(true));
  const logged: string[] = [];
  const client = new OpenRouter(cfg(refusing.url, 'anthropic/claude-sonnet-5.5'), 'k', async type => {
    logged.push(type);
  });
  assert.deepEqual(await client.generate(prompt, schema), { content: 'ok' });
  assert.deepEqual(await client.generate(prompt, schema), { content: 'ok' });
  assert.deepEqual(refusing.bodies.map(marked), [[1, 3], [], []], 'refused once, then sent unmarked');
  assert.equal(logged.filter(x => x === 'cache-markers-off').length, 1);
});

test('Under the tools form a file written inside its call is shown as it is written: the content so far of the last call, when that call writes a file, by its path and the line it starts at', async () => {
  const { partialJson } = await import('../src/display.js');
  // The step reply as it streams: the thought, then each call as far as it has come.
  const streaming = (calls: string) => partialJson(`{"thought":"Write the module.","actions":[${calls}`);
  const create = streaming(
    '{"action":"plan","args":{"notes":"n"}},{"action":"create_file","args":{"path":"src/a.ts","content":"export const a = 1;\\nexport function f() {\\n  return a +',
  );
  assert.deepEqual(fileBeingWritten(create), {
    route: 'create_file',
    path: 'src/a.ts',
    from: 1,
    content: 'export const a = 1;\nexport function f() {\n  return a +',
  });
  assert.deepEqual(
    fileBeingWritten(
      streaming('{"action":"rewrite_file","args":{"path":"src/b.ts","start":40,"end":52,"content":"  x();\\n'),
    ),
    { route: 'rewrite_file', path: 'src/b.ts', from: 40, content: '  x();\n' },
    'a block of a file is numbered from the line it starts at',
  );
  assert.equal(
    fileBeingWritten(streaming('{"action":"create_file","args":{"path":"src/a.ts","content":"')),
    null,
    'nothing written yet',
  );
  assert.equal(
    fileBeingWritten(
      streaming(
        '{"action":"create_file","args":{"path":"src/a.ts","content":"x"}},{"action":"bash","args":{"command":"npm t',
      ),
    ),
    null,
    'a later call is being written: the file is done',
  );
  assert.equal(fileBeingWritten(streaming('')), null);
});

test("Reasoning left to the model ('auto', the default) is on through OpenRouter for a model that reasons, off for one that does not and on a local server; on or off as set wins", async () => {
  const [, gpt, , plain] = (await catalogue()).data.map(openrouterModelInfo);
  const local = llamaModelInfo(
    { chat_template: '{% if enable_thinking %}<think>{% endif %}', default_generation_settings: { n_ctx: 48000 } },
    null,
    'bonsai-27b',
  );
  assert.deepEqual([defaults.stepThinking, defaults.codeThinking], ['auto', 'auto']);
  const fitted = (c: Partial<typeof defaults>, m: any) => {
    const r = forModel({ ...defaults, provider: m.provider, ...c } as typeof defaults, m);
    return [r.config.stepThinking, r.config.codeThinking, r.notes.some(n => /does not reason/.test(n))];
  };
  assert.deepEqual(fitted({}, gpt), [true, true, false], 'a reasoning model through OpenRouter thinks');
  assert.deepEqual(fitted({}, plain), [false, false, false], 'one that does not reason: off, with nothing to say');
  assert.deepEqual(fitted({}, local), [false, false, false], 'a local server (Bonsai): off, as measured');
  assert.deepEqual(fitted({ stepThinking: false }, gpt), [false, true, false], 'off as set');
  assert.deepEqual(fitted({ codeThinking: true }, local), [false, true, false], 'on as set');
  const { loadConfig } = await import('../src/config.js');
  assert.equal((await loadConfig(undefined, { stepThinking: 'auto' })).stepThinking, 'auto');
  assert.equal((await loadConfig(undefined, { stepThinking: false })).stepThinking, false);
  await assert.rejects(loadConfig(undefined, { stepThinking: 'sometimes' as any }), /Invalid config: stepThinking/);
  const reasoning = modelOptions(gpt).find(o => o.name === 'reasoning')!;
  assert.equal(reasoning.get(defaults), 'auto');
  assert.deepEqual(reasoning.set(defaults, 'auto'), { stepThinking: 'auto' });
  assert.deepEqual(reasoning.set(defaults, 'off'), { stepThinking: false });
});

test('Under the tools form a batch keeps going past a refused call for its writes to other files, a create_file of a file the run brought into being writes over it, and an earlier write said in one line keeps the class names it uses (run saas-landing-glm-5.3 trial 4)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-or-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pre.txt'), 'kept\n');
  const store = new Store(join(root, '.leana', 'runs', 'r'));
  await store.init();
  const html = '<!doctype html><html><body><div id="root"></div></body></html>\n';
  const hero = `export function Hero() {\n  return (\n    <section className="hero">\n      <h1 className="hero__title">Ship faster</h1>\n${Array.from({ length: 12 }, (_, i) => `      <p className="hero__text">Line ${i + 1} of the copy for the landing page hero.</p>\n`).join('')}    </section>\n  );\n}\n`;
  const steps: { text: string; calls: [string, string][] }[] = [
    {
      text: 'Scaffold.',
      calls: [
        [
          'bash',
          JSON.stringify({
            command: `node -e "require('fs').writeFileSync('index.html', '<p>scaffold</p>')"`,
            purpose: 'scaffold',
          }),
        ],
      ],
    },
    {
      text: 'Write the app in one batch.',
      calls: [
        ['create_file', JSON.stringify({ path: 'pre.txt', content: 'replaced\n' })],
        ['create_file', JSON.stringify({ path: 'index.html', content: html })],
        ['create_file', JSON.stringify({ path: 'src/Hero.jsx', content: hero })],
        ['bash', JSON.stringify({ command: 'node -e "process.exit(0)"', purpose: 'never', check: true })],
        ['create_file', JSON.stringify({ path: 'src/b.mjs', content: 'export const b = 2;\n' })],
      ],
    },
    { text: 'Note it.', calls: [['plan', JSON.stringify({ notes: 'written' })]] },
    { text: 'Note it again.', calls: [['plan', JSON.stringify({ notes: 'written again' })]] },
  ];
  let step = 0;
  const { url, bodies } = await mock(t, async (b, _n, res) => {
    const s = steps[Math.min(step++, steps.length - 1)]!;
    return sse(res, [
      ...pieces(s.text, 6).map(p => ({ content: p })),
      ...s.calls.flatMap(([name, args], index) =>
        pieces(args, 40).map((p, i) => ({
          tool_calls: [
            {
              index,
              ...(i ? {} : { id: `call_${step}_${index}`, type: 'function' }),
              function: { ...(i ? {} : { name }), arguments: p },
            },
          ],
        })),
      ),
    ]);
  });
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  const jev = {
    decide: async (_s: unknown, q: Questions): Promise<Answers> =>
      Object.fromEntries(
        Object.keys(q).map(k => [k, k === 'progress' || k === 'in_scope' ? noul(0.8) : noul(0.1)]),
      ) as any,
  };
  const gpt = (await catalogue()).data.map(openrouterModelInfo)[1];
  const { config: fitted } = forModel(cfg(url, gpt.id, { openrouterMaxTurns: 4 }), gpt);
  const or = new OpenRouter(fitted, 'k', store.log.bind(store));
  const s = await new Agent(
    fitted,
    store,
    jev as any,
    or,
    root,
    () => {},
    () => {},
  ).run(await newSession(root, 'Build it'));
  assert.equal(s.form, 'tools');
  assert.equal(
    await readFile(join(root, 'pre.txt'), 'utf8'),
    'kept\n',
    'a file there at the start is not created over',
  );
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), html, "the scaffold's file, written over");
  assert.equal(await readFile(join(root, 'src', 'Hero.jsx'), 'utf8'), hero, 'a write after the refusal ran');
  assert.equal(
    await readFile(join(root, 'src', 'b.mjs'), 'utf8'),
    'export const b = 2;\n',
    'and the write after the command',
  );
  assert.equal(s.lastCheckCommand ?? null, null, 'the command after the refusal did not run');
  assert(
    s.entries.some(
      e =>
        /later write\(s\) to other files were run/.test(e.text) &&
        /other 1 action\(s\) were not run \(bash\)/.test(e.text),
    ),
    'the refusal says which actions ran and which did not',
  );
  const last = JSON.stringify(bodies.at(-1));
  assert.match(
    last,
    /written at step \d+; not repeated here: read_files shows src\/Hero\.jsx as it is now; the class names it uses: hero hero__title hero__text/,
  );
});
