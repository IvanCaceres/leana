import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { defaults, loadConfig, loadSettings } from '../src/config.js';
import { effortsOf, fitToModel, llamaModelInfo, modelOptions, openrouterModelInfo, unsupportedSettings } from '../src/models.js';
import { OpenRouter, parseJson } from '../src/openrouter.js';
import { forModel } from '../src/session.js';
import { App } from '../src/app.js';
import { Agent, newSession } from '../src/agent.js';
import { Store } from '../src/store.js';
import { stepSchema } from '../src/schema.js';
import type { Answers, Config, Questions } from '../src/types.js';

const fixtures = new URL('../../test/fixtures/openrouter/', import.meta.url).pathname;
const catalogue = async () => JSON.parse(await readFile(join(fixtures, 'models.json'), 'utf8'));
const body = async (req: AsyncIterable<any>) => { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
// OpenRouter's stream: a keep-alive comment, a role delta, then the pieces, the finish, a usage chunk and [DONE].
async function sse(res: ServerResponse, deltas: Record<string, unknown>[], finish = 'stop', usage = { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0012 }) {
  res.setHeader('Content-Type', 'text/event-stream'); res.write(': OPENROUTER PROCESSING\n\n');
  const base = { id: 'gen-1', model: 'm', object: 'chat.completion.chunk' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
  for (const d of deltas) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '' }, finish_reason: finish }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: finish }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}
// A mock OpenRouter: the catalogue at /models, chat answered by `reply` (body and call number).
async function mock(t: any, reply: (b: any, n: number, res: ServerResponse) => Promise<void> | void) {
  const bodies: any[] = []; const list = await catalogue();
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(list)); }
    const b = await body(req); bodies.push(b); await reply(b, bodies.length, res);
  }).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r)); t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as any).port}/api/v1`, bodies };
}
const cfg = (url: string, model: string, more: Partial<Config> = {}): Config => ({ ...defaults, provider: 'openrouter', openrouterUrl: url, model, ...more });
const pieces = (s: string, n = 7) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g'))!;
process.env.OPENROUTER_API_KEY ??= 'test-key';

test('A model\'s facts come from its provider: OpenRouter\'s catalogue entry (context, output, parameters, reasoning, prices) and llama-server\'s props and chat template', async () => {
  const [claude, gpt, ling, plain] = (await catalogue()).data.map(openrouterModelInfo);
  assert.deepEqual([claude.reasoning.supported, claude.reasoning.mandatory, claude.reasoning.efforts, claude.reasoning.defaultEffort, claude.structured], [true, true, ['max', 'xhigh', 'high', 'medium', 'low'], 'high', true]);
  assert(claude.contextLength >= 200000 && claude.maxOutput >= 32000 && claude.pricing!.prompt > 0);
  assert.deepEqual([gpt.reasoning.mandatory, effortsOf(gpt.reasoning).includes('none')], [false, true]);
  assert.deepEqual([ling.reasoning.supported, ling.reasoning.efforts, ling.structured, ling.params.includes('top_k')], [true, null, false, true], 'efforts not listed: any of the gateway\'s');
  assert.deepEqual([plain.reasoning.supported, plain.reasoning.efforts], [false, []]);
  const template = "{%- if enable_thinking is undefined or enable_thinking is true %}\n{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}\n{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{ raise_exception('x') }}{%- endif %}{%- endif %}<think>";
  const bonsai = llamaModelInfo({ model_alias: 'bonsai-27b', model_path: '/m/Ternary-Bonsai-2-27B-PTQ1_0.gguf', chat_template: template, default_generation_settings: { n_ctx: 64536 } }, { data: [{ id: 'bonsai-27b', meta: { n_params: 27e9, size: 5.9e9, n_ctx_train: 262144 } }] }, 'bonsai-27b');
  assert.deepEqual([bonsai.contextLength, bonsai.reasoning.efforts, bonsai.reasoning.defaultEffort, bonsai.reasoning.budget, bonsai.details!.parameters], [64536, ['xhigh', 'medium', 'low'], 'xhigh', true, '27.0B']);
  const noThink = llamaModelInfo({ chat_template: '{{ messages }}', default_generation_settings: { n_ctx: 8192 } }, null, 'x');
  assert.deepEqual([noThink.reasoning.supported, modelOptions(noThink).some(o => /reasoning|effort|budget/.test(o.name))], [false, false]);
});

test('Only the options the model takes are offered, and a value it does not take is refused with what it takes', async () => {
  const [claude, gpt, ling, plain] = (await catalogue()).data.map(openrouterModelInfo);
  const names = (m: any) => modelOptions(m).map(o => o.name);
  assert(!names(plain).some(n => /reasoning|effort|budget/.test(n)), 'a model that does not reason has no reasoning options');
  assert(names(ling).includes('top-k') && !names(claude).includes('top-k'), 'top-k only where the model takes top_k');
  const always = modelOptions(claude).find(o => o.name === 'reasoning')!;
  assert.equal(always.get(defaults), 'always on'); assert.throws(() => always.set(defaults, 'off'), /always reasons/);
  const effort = modelOptions(gpt).find(o => o.name === 'effort')!;
  assert.deepEqual(effort.set(defaults, 'high'), { thinkingEffort: 'high' }); assert.throws(() => effort.set(defaults, 'turbo'), /takes max, xhigh, high, medium, low, none/);
  assert.deepEqual(unsupportedSettings({ ...defaults, stepThinking: true }, plain), [`${plain.id} does not reason: reasoning is off for this run`]);
  // A run fits the config to the model: an effort it takes, its window and output limits, reasoning off where it cannot.
  const fitted = forModel({ ...defaults, provider: 'openrouter', stepThinking: true, thinkingEffort: 'xhigh' }, gpt).config;
  assert.deepEqual([fitted.thinkingEffort, fitted.contextWindow, fitted.maxTokens <= gpt.maxOutput], ['xhigh', gpt.contextLength, true]);
  assert.equal(forModel({ ...defaults, provider: 'openrouter', stepThinking: true, thinkingEffort: 'xhigh' }, (await catalogue()).data.map(openrouterModelInfo).map((m: any) => ({ ...m, reasoning: { ...m.reasoning, efforts: ['high', 'low'], defaultEffort: 'low' } }))[1]).config.thinkingEffort, 'low', 'an effort it does not take becomes its default');
  assert.equal(forModel({ ...defaults, stepThinking: true }, plain).config.stepThinking, false);
  const small = fitToModel({ ...defaults, provider: 'openrouter', workingTokens: 30000, maxTokens: 8192 }, { ...plain, contextLength: 16000, maxOutput: 4096 });
  assert.deepEqual([small.contextWindow, small.maxTokens, small.workingTokens <= 16000 - small.maxTokens - small.safetyTokens], [16000, 4000, true]);
});

test('A step through OpenRouter: the JSON schema enforced where the model takes one, reasoning by effort, only the sampling it takes; the reasoning streams ahead of the reply and both come back with usage and cost', async t => {
  const reply = JSON.stringify({ thought: 'Read the config first.', actions: [{ action: 'read_files', args: { files: [{ path: 'vite.config.ts', start: 1, end: 40 }] } }] });
  const thinking = 'The build says the plugin is missing; read the config.';
  const { url, bodies } = await mock(t, async (b, n, res) => {
    if (n === 1) return sse(res, [...pieces(thinking).map((p, i) => i % 2 ? { reasoning: p } : { reasoning_details: [{ type: 'reasoning.text', text: p }] }), ...pieces(reply).map(p => ({ content: p }))]);
    if (n === 2) return sse(res, [{ content: '```json\n' }, ...pieces(reply).map(p => ({ content: p })), { content: '\n```' }]);
    if (n === 3) return sse(res, pieces(reply.slice(0, 40)).map(p => ({ content: p })), 'length');
    res.setHeader('Content-Type', 'text/event-stream'); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }], error: { code: 502, message: 'upstream down' } })}\n\n`); res.end();
  });
  const logs: [string, any][] = [];
  const schema = { type: 'object', properties: { thought: { type: 'string' }, actions: { type: 'array', minItems: 1, maxItems: 8, items: stepSchema } }, required: ['thought', 'actions'], additionalProperties: false } as any;
  const gpt = new OpenRouter(cfg(url, 'openai/gpt-5.6-luna-pro', { thinkingEffort: 'high' }), 'k', async (ty, d) => { logs.push([ty, d]); });
  const seen: any[] = [];
  const args = await gpt.generate([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], schema, .2, { step: 1, route: 'step' }, 4096, p => seen.push({ ...p }), 2048);
  assert.deepEqual(args, JSON.parse(reply)); assert.equal(gpt.lastMeta?.reasoning, thinking);
  assert(seen.some(p => p.reasoning && !p.text), 'the reasoning is reported before the reply');
  const b = bodies[0];
  assert.deepEqual([b.stream, b.response_format.type, b.response_format.json_schema.strict, b.provider, b.reasoning, 'top_k' in b, 'min_p' in b], [true, 'json_schema', true, { require_parameters: true }, { effort: 'high' }, false, false]);
  const logged = logs.find(([ty]) => ty === 'bonsai')![1]; assert.deepEqual([logged.cost, logged.reasoningChars, logged.usage.prompt_tokens], [0.0012, thinking.length, 1000]);
  // A model that enforces no schema and takes no response_format gets the schema in its prompt only, and its fenced reply is read; reasoning off where it can be.
  const ling = new OpenRouter(cfg(url, 'inclusionai/ling-3.1-flash'), 'k', async () => {});
  assert.deepEqual(await ling.generate([{ role: 'user', content: 'U' }], schema), JSON.parse(reply));
  assert.deepEqual([bodies[1].response_format, bodies[1].reasoning, bodies[1].top_k], [undefined, { enabled: false }, defaults.stepTopK]);
  await assert.rejects(ling.generate([{ role: 'user', content: 'U' }], schema), /did not finish a JSON argument object \(length\)/, 'the length message the agent explains');
  await assert.rejects(ling.generate([{ role: 'user', content: 'U' }], schema), /^Error: HTTP 502 from http:\/\/127\.0\.0\.1:\d+$/, 'an error event mid-stream fails as the HTTP error it is, as with llama-server');
  assert.deepEqual(parseJson('Here it is: {"a": 1} done'), { a: 1 });
});

test('A file through OpenRouter: the reply opened with the fence, the closing fence the stop; a fence written again dropped; a reply cut by its limit continued from what it wrote; a loop stopped as it streams', async t => {
  const file = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
  const loop = 'const x = 0;\n' + Array.from({ length: 30 }, () => '  doSomethingAgain(x);\n').join('');
  const { url, bodies } = await mock(t, async (b, n, res) => {
    if (n === 1) return sse(res, [{ reasoning: 'Three constants.' }, ...pieces('```ts\n' + file, 9).map(p => ({ content: p }))]);
    if (n === 2) return sse(res, pieces(file.slice(0, 30), 9).map(p => ({ content: p })), 'length');
    if (n === 3) return sse(res, pieces(file.slice(30), 9).map(p => ({ content: p })));
    if (n === 4) return sse(res, pieces(loop, 11).map(p => ({ content: p })));
  });
  const or = new OpenRouter(cfg(url, 'inclusionai/ling-3.1-flash'), 'k', async () => {});
  const seen: any[] = [];
  const g = await or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```ts', think: 1024, progress: p => seen.push({ ...p }) });
  assert.equal(g.text, file); assert.equal(g.meta.reasoning, 'Three constants.'); assert.equal(g.finish, 'stop');
  assert.deepEqual([bodies[0].messages.at(-1), bodies[0].stop, bodies[0].reasoning, bodies[0].temperature], [{ role: 'assistant', content: '```ts\n' }, ['\n```'], { effort: 'medium' }, defaults.codeTemperature], 'ling lists no efforts of its own: any of the gateway\'s');
  assert(seen.some(p => p.reasoning && !p.text) && seen.some(p => p.text.startsWith('export const a')));
  const two = await or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```ts' });
  assert.equal(two.text, file); assert.equal(two.meta.continuations, 1);
  assert.equal(bodies[2].messages.at(-1).content, '```ts\n' + file.slice(0, 30), 'continued from what it wrote');
  const cut = await or.generateText([{ role: 'user', content: 'Write it.' }], { fence: '```ts' });
  assert.equal(cut.finish, 'repetition'); assert.equal(cut.cut?.kind, 'lines'); assert.equal(cut.text, 'const x = 0;\n  doSomethingAgain(x);\n');
});

test('The agent runs through OpenRouter as through llama-server: steps with reasoning, a file written, a check, completion; the reasoning logged, the context kept in budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leana-or-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'r')); await store.init();
  const steps = [
    { thought: 'Write the module.', actions: [{ action: 'create_file', args: { path: 'src/greet.mjs', purpose: 'export greet(name) returning a greeting' } }] },
    { thought: 'Check it runs.', actions: [{ action: 'bash', args: { command: 'node -e "import(\'./src/greet.mjs\').then(m => process.exit(m.greet(\'a\') === \'Hello, a\' ? 0 : 1))"', purpose: 'check', check: true } }] },
    { thought: 'Done.', actions: [{ action: 'finish', args: { summary: 'src/greet.mjs exports greet; the check passes.' } }] },
  ];
  let step = 0;
  const { url, bodies } = await mock(t, async (b, _n, res) => {
    if (b.response_format) { const r = JSON.stringify(steps[step++]); return sse(res, [{ reasoning: `Step ${step} reasoning.` }, ...pieces(r, 40).map(p => ({ content: p }))]); }
    return sse(res, [{ content: 'export const greet = name => `Hello, ${name}`;\n' }]);
  });
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  const jev = { decide: async (_s: unknown, q: Questions, ctx?: { phase: string }): Promise<Answers> => {
    if (ctx?.phase === 'watchdog') return { progress: noul(.8), same_failure: noul(.05), stuck: noul(.05), objective_satisfied: noul(.3), needs_user: noul(.05), in_scope: noul(.9) } as any;
    if (ctx?.phase === 'evidence-gate') return { implementation_matches_request: noul(.9), requirement_unaddressed: noul(.1), claim_supported: noul(.9), weakest_evidence: { type: 'choice', choice: 'sources', confidence: .5, probabilities: { observation: .1, verification: .2, sources: .5, requirements: .2 } }, verification_needed: { type: 'choice', choice: 'deterministic_only', confidence: .9, probabilities: { deterministic_only: .9, semantic_review: .05, human: .05 } } } as any;
    if (ctx?.phase === 'failure-triage') return { failure: { type: 'choice', choice: 'code_bug', confidence: .9, probabilities: {} } } as any;
    return Object.fromEntries(Object.keys(q).map(k => [k, noul(.5)])) as any;
  } };
  const config = { ...cfg(url, 'openai/gpt-5.6-luna-pro', { stepThinking: true, thinkingEffort: 'medium', allowWrite: true, allowBash: true, maxSteps: 6 }) };
  const { config: fitted } = forModel(config, (await catalogue()).data.map(openrouterModelInfo)[1]);
  const or = new OpenRouter(fitted, 'k', store.log.bind(store));
  const shown: any[] = [];
  const s = await new Agent(fitted, store, jev as any, or, root, () => {}, e => shown.push(e)).run(await newSession(root, 'Add a greet function'));
  assert.equal(s.status, 'complete', s.stopReason);
  assert.equal(await readFile(join(root, 'src', 'greet.mjs'), 'utf8'), 'export const greet = name => `Hello, ${name}`;\n');
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.filter(e => e.type === 'reasoning').map(e => e.data.text), ['Step 1 reasoning.', 'Step 2 reasoning.', 'Step 3 reasoning.']);
  assert(shown.some(e => e.kind === 'thought' && e.reasoning === 'Step 1 reasoning.'), 'the reasoning reaches the display with its step');
  const stepBodies = bodies.filter(b => b.response_format);
  assert(stepBodies.every(b => b.reasoning?.effort === 'medium' && b.max_tokens <= 128000));
  assert(stepBodies[1].messages.length > stepBodies[0].messages.length && stepBodies[1].messages.slice(0, stepBodies[0].messages.length - 2).every((m: any, i: number) => JSON.stringify(m) === JSON.stringify(stepBodies[0].messages[i])), 'the prompt only grows: a cacheable prefix');
});

test('The app offers and sets only what the active provider and model take, switches provider and model, and keeps its choices', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leana-app-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { url } = await mock(t, () => {});
  const settingsPath = join(dir, 'settings.json'); const said: string[] = [];
  await mkdir(join(dir, 'repo'));
  const app = new App({ base: await loadConfig(undefined, { openrouterUrl: url }), settings: { config: { openrouterUrl: url } }, jevKey: 'j', repo: join(dir, 'repo'), settingsPath, write: l => said.push(l) });
  const run = async (line: string) => { said.length = 0; await app.handle(line); return said.join('\n'); };
  assert.match(await run('/provider openrouter'), /provider: openrouter; choose a model/);
  assert.match(await run('/models gpt'), /openai\/gpt-5\.6-luna-pro/);
  assert.match(await run('/model inclusionai/ling-3.1-flash'), /model: inclusionai\/ling-3\.1-flash/);
  const opts = await run('/options');
  assert.match(opts, /top-k/); assert.match(opts, /effort .*max \| xhigh \| high \| medium \| low \| minimal \| none/);
  assert.match(await run('/model unbiased/pareto-26.10-preview'), /model: unbiased\/pareto-26\.10-preview/);
  assert.doesNotMatch(await run('/options'), /^\s+(reasoning|file-reasoning|effort|budget|file-budget|reasoning-temperature|top-k)\s/m, 'a model that does not reason and takes no top_k offers neither');
  assert.match(await run('/effort high'), /does not take effort; it takes/);
  assert.match(await run('/model anthropic/claude-sonnet-5.5'), /model: anthropic/);
  assert.match(await run('/reasoning off'), /always reasons; it cannot be turned off/);
  assert.match(await run('/effort turbo'), /takes max, xhigh, high, medium, low/);
  assert.match(await run('/effort low'), /effort: low/);
  assert.match(await run('/info'), /reasoning: always on; efforts max, xhigh, high, medium, low \(default high\); token budget yes/);
  const kept = await loadSettings(settingsPath);
  assert.deepEqual([kept.config.provider, kept.config.model, kept.config.thinkingEffort], ['openrouter', 'anthropic/claude-sonnet-5.5', 'low'], 'kept between runs');
  assert.deepEqual(app.complete('/eff'), [['/effort'], '/eff']); assert.deepEqual(app.complete('/effort l')[0], ['low']);
  assert.match(await run('/allow bash on'), /bash: on \(commands run unsandboxed/);
  assert.match(await run('/nonsense'), /No command \/nonsense/);
  assert.equal(await app.handle('/quit'), 'quit');
  await writeFile(join(dir, 'x'), '');
});
