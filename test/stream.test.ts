import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaults } from '../src/config.js';
import { Bonsai, post, repeatCut, streamEvents, thinkingBudgetMessage, type StreamProgress } from '../src/clients.js';
import { Display, describe, partialJson, wrap, type ProgressEvent } from '../src/display.js';
import { Agent, newSession } from '../src/agent.js';
import { Store } from '../src/store.js';
import { stepSchema } from '../src/schema.js';
import type { Answers } from '../src/types.js';

// A token as the mock server generates it: its id and its bytes (one character, or part of one).
type Tok = { id: number; bytes: Buffer; eog?: boolean };
// One token per character, ids as code points (as the other mocks); a token of raw bytes; an end-of-generation token.
const chars = (s: string): Tok[] => [...s].map(c => ({ id: c.codePointAt(0)!, bytes: Buffer.from(c) }));
const raw = (id: number, ...b: number[]): Tok => ({ id, bytes: Buffer.from(b) });
const eos: Tok = { id: 151645, bytes: Buffer.alloc(0), eog: true };
// llama-server's validate_utf8 (server-common.cpp): the text's length without a character cut off at its end.
const whole = (b: Buffer) => {
  for (let i = 1; i <= 4 && i <= b.length; i++) {
    const c = b[b.length - i]!;
    if (((c & 0xe0) === 0xc0 && i < 2) || ((c & 0xf0) === 0xe0 && i < 3) || ((c & 0xf8) === 0xf0 && i < 4))
      return b.length - i;
  }
  return b.length;
};
// What llama-server sends for a /completion of these tokens (server-context.cpp process_token, send_final_response):
// a partial per token, holding back text while it could be the start of a stop word and sending no event for a
// token that ends inside a character; then the final event, whose content and tokens are empty in a stream. And
// the reply it sends unstreamed.
function completion(
  tokens: Tok[],
  nPredict: number,
  stops: string[],
  promptTokens: number,
  perToken = false,
  progress = false,
) {
  let text = Buffer.alloc(0);
  let sent = 0;
  let n = 0;
  let stop = 'none';
  let word = '';
  const ids: number[] = [];
  const events: any[] = [];
  const timings = () => ({
    cache_n: promptTokens - 7,
    prompt_n: 7,
    prompt_ms: 12.5,
    prompt_per_token_ms: 1.8,
    prompt_per_second: 560,
    predicted_n: n,
    predicted_ms: n * 25,
    predicted_per_token_ms: 25,
    predicted_per_second: 40,
  });
  for (const t of tokens) {
    n++;
    ids.push(t.id);
    text = Buffer.concat([text, t.bytes]);
    let next = true;
    if (whole(text) === text.length) {
      let pos = Math.min(sent, text.length);
      const s = text.subarray(pos).toString('latin1');
      let send = true;
      let at = -1;
      for (const w of stops) {
        const p = s.indexOf(w, Math.max(0, s.length - w.length - t.bytes.length));
        if (p >= 0 && (at < 0 || p < at)) {
          at = p;
          stop = 'word';
          word = w;
          next = false;
        }
      }
      if (at >= 0) {
        text = text.subarray(0, pos + at);
        pos = Math.min(sent, text.length);
      } else if (!t.eog)
        for (const w of stops)
          for (let len = Math.min(s.length, w.length); len > 0; len--) if (s.endsWith(w.slice(0, len))) send = false;
      const content = send ? text.subarray(pos).toString('utf8') : '';
      if (send) sent = text.length;
      events.push({
        index: 0,
        content,
        tokens: [t.id],
        stop: false,
        id_slot: -1,
        tokens_predicted: n,
        tokens_evaluated: promptTokens,
        ...(stop !== 'none' || perToken ? { timings: timings() } : {}),
      });
    }
    if (next && n >= nPredict) {
      stop = 'limit';
      next = false;
    }
    if (t.eog) {
      stop = 'eos';
      next = false;
    }
    if (!next) break;
  }
  const final = {
    index: 0,
    content: '',
    tokens: [],
    id_slot: 0,
    stop: true,
    model: 'bonsai-27b',
    tokens_predicted: n,
    tokens_evaluated: promptTokens,
    generation_settings: {},
    prompt: '',
    has_new_line: true,
    truncated: false,
    stop_type: stop,
    stopping_word: word,
    tokens_cached: promptTokens + n,
    timings: timings(),
  };
  // With return_progress, the prompt's processing first (send_partial_response with is_progress: no generated token).
  const read = progress
    ? [
        {
          index: 0,
          content: '',
          tokens: [-1],
          stop: false,
          id_slot: -1,
          tokens_predicted: 0,
          tokens_evaluated: promptTokens,
          prompt_progress: { total: promptTokens, cache: promptTokens - 7, processed: promptTokens, time_ms: 3 },
        },
      ]
    : [];
  return { events: [...read, ...events, final], reply: { ...final, content: text.toString('utf8'), tokens: ids } };
}
// What llama-server streams for a chat completion whose JSON content arrives in these pieces (server-task.cpp
// to_json_oaicompat_chat_stream): the role, a delta per piece, the finish, then the usage, which carries the timings.
function chat(pieces: string[], { usage = true, finish = 'stop', progress = false } = {}) {
  const base = {
    created: 1,
    id: 'chatcmpl-1',
    model: 'bonsai-27b',
    system_fingerprint: 'b1',
    object: 'chat.completion.chunk',
  };
  const timings = {
    cache_n: 900,
    prompt_n: 100,
    prompt_ms: 180,
    prompt_per_token_ms: 1.8,
    prompt_per_second: 555,
    predicted_n: pieces.length,
    predicted_ms: pieces.length * 25,
    predicted_per_token_ms: 25,
    predicted_per_second: 40,
  };
  // With return_progress, the prompt's processing first, each event a role delta carrying it.
  const read = progress
    ? [900, 1000].map(processed => ({
        choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }],
        ...base,
        prompt_progress: { total: 1000, cache: 900, processed, time_ms: 5 },
      }))
    : [];
  const events: any[] = [
    ...read,
    { choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }], ...base },
    ...pieces.map(p => ({ choices: [{ finish_reason: null, index: 0, delta: { content: p } }], ...base })),
    { choices: [{ finish_reason: finish, index: 0, delta: {} }], ...base },
  ];
  const used = {
    completion_tokens: pieces.length,
    prompt_tokens: 1000,
    total_tokens: 1000 + pieces.length,
    prompt_tokens_details: { cached_tokens: 900 },
  };
  if (usage) events.push({ choices: [], ...base, usage: used });
  events.at(-1).timings = timings;
  return { events, usage: used, timings };
}
// Writes events as llama-server does (a `data:` line and a blank line each, a keep-alive comment after the first),
// in reads of `cut` bytes when asked (a character or a line split across them), one event per turn of the
// event loop or per `pace` ms; stops when the client goes. Returns how many were written and whether it went first.
async function serve(
  res: ServerResponse,
  events: unknown[],
  { cut = 0, done = false, pace = 0, keep = false } = {},
): Promise<{ written: number; gone: boolean }> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  let gone = false;
  res.on('close', () => {
    gone = !res.writableFinished;
  });
  let written = 0;
  for (const e of events) {
    if (gone) break;
    const bytes = Buffer.from(`data: ${JSON.stringify(e)}\n\n${written ? '' : ':\n\n'}`);
    if (cut)
      for (let k = 0; k < bytes.length; k += cut) {
        res.write(bytes.subarray(k, k + cut));
        await new Promise(r => setImmediate(r));
      }
    else res.write(bytes);
    written++;
    if (pace) await sleep(pace);
    else await new Promise(r => setImmediate(r));
  }
  if (!gone && !keep) {
    if (done) res.write('data: [DONE]\n\n');
    res.end();
  }
  return { written, gone };
}
const body = async (req: AsyncIterable<any>) => {
  let b = '';
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
};
const listen = async (t: any, handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as any).port}`;
};
const chatml = (b: any) =>
  b.messages.map((m: any) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') +
  (b.add_generation_prompt === false ? '' : '<|im_start|>assistant\n<think>\n\n</think>\n\n');
// What was written to a terminal, as lines, without the cursor movements that redraw the panel.
const unescaped = (writes: string[]) =>
  writes
    .join('')
    .replace(/\x1b\[\d*[AJ]/g, '')
    .split('\n');
const stepReply = {
  type: 'object',
  properties: { thought: { type: 'string' }, actions: { type: 'array', minItems: 1, maxItems: 8, items: stepSchema } },
  required: ['thought', 'actions'],
  additionalProperties: false,
} as any;

// Whether a is what a prefix of b's JSON can spell: strings a prefix, arrays and objects with fewer entries, each within b's.
const within = (a: any, b: any): boolean =>
  typeof a === 'string'
    ? typeof b === 'string' && b.startsWith(a)
    : Array.isArray(a)
      ? Array.isArray(b) && a.length <= b.length && a.every((x, i) => within(x, b[i]))
      : a && typeof a === 'object'
        ? !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(a).every(k => k in b && within(a[k], b[k]))
        : a === b;
test('partialJson reads a step reply from any prefix of its JSON: the thought as it grows (an escape or surrogate pair cut off waits), then each action as far as it has come', () => {
  const thought = 'Read "vite.config.ts" first \u2014 caf\u00e9 \ud83d\ude80\nthen C:\\src\ttab';
  const json = `{ "thought" : "Read \\"vite.config.ts\\" first \\u2014 caf\u00e9 \\ud83d\\ude80\\nthen C:\\\\src\\ttab", "actions": [{"thought": "inner", "action": "read_files", "args": {"files": [{"path": "src/App.tsx", "start": 1, "end": 40}]}}, {"thought": "then", "action": "bash", "args": {"command": "npm run build", "purpose": "p", "check": true}}]}`;
  const value = JSON.parse(json);
  assert.equal(value.thought, thought);
  let last: any;
  const seen: string[] = [];
  for (let n = 0; n <= json.length; n++) {
    const v = partialJson(json.slice(0, n));
    if (v === undefined) {
      assert(n === 0, `undefined only before the reply opens (${n})`);
      continue;
    }
    assert(within(v, value), `prefix ${n}: ${JSON.stringify(v)}`);
    assert(last === undefined || within(last, v), `prefix ${n} never takes back what ${n - 1} showed`);
    last = v;
    if (typeof v.thought === 'string') assert(thought.startsWith(v.thought));
    assert(!/\ud83d$/.test(v.thought ?? ''), 'never half a surrogate pair');
    const step = JSON.stringify(v.actions?.map((a: any) => [a.action, a.args && Object.keys(a.args)]));
    if (seen.at(-1) !== step) seen.push(step);
  }
  assert.deepEqual(last, value);
  const order = [
    '[]',
    '[[null,null]]',
    '[["read_files",null]]',
    '[["read_files",[]]]',
    '[["read_files",["files"]]]',
    '[["read_files",["files"]],[null,null]]',
  ].map(x => seen.indexOf(x));
  assert(
    order.every((x, i) => x >= 0 && (!i || x > order[i - 1]!)),
    `actions appear as they come: the array, an action, its route, its arguments (${seen.join(' ')})`,
  );
  // Any JSON, cut anywhere: a value within the whole, growing with the text (random values, random whitespace).
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const gen = (d: number): any => {
    const r = rnd(d > 3 ? 4 : 7);
    return r === 0
      ? rnd(2000) - 1000
      : r === 1
        ? ['x', 'a\\"b', 'caf\u00e9 \ud83d\ude80', 'line\nbreak', '\u2014\t'][rnd(5)]!.repeat(1 + rnd(3))
        : r === 2
          ? [true, false, null][rnd(3)]
          : r === 3
            ? rnd(100) / 7
            : r === 4 || r === 5
              ? Array.from({ length: rnd(4) }, () => gen(d + 1))
              : Object.fromEntries(Array.from({ length: rnd(4) }, (_, i) => [`k${i}`, gen(d + 1)]));
  };
  for (let c = 0; c < 300; c++) {
    const v = { thought: gen(3), actions: gen(1) };
    const text = JSON.stringify(v, null, rnd(3)).replace(/\u2014/g, () => (rnd(2) ? '\\u2014' : '\u2014'));
    let prev: any;
    for (let n = 0; n <= text.length; n++) {
      const p = partialJson(text.slice(0, n));
      if (p === undefined) continue;
      assert(within(p, v), `${text.slice(0, n)} -> ${JSON.stringify(p)}`);
      assert(prev === undefined || within(prev, p));
      prev = p;
    }
    assert.deepEqual(prev, v);
  }
});

test('A step reply is read as it streams: the thought grows in the progress, and the reply, usage, timings and finish are those of the unstreamed request', async t => {
  const content = JSON.stringify({
    thought: 'The build failed in src/App.tsx \u2014 caf\u00e9 \ud83d\ude80; read it first.',
    actions: [{ action: 'read_files', args: { files: [{ path: 'src/App.tsx', start: 1, end: 40 }] } }],
  });
  // Pieces of three characters cut escapes and surrogate pairs anywhere; reads of five bytes cut characters and lines.
  const pieces = content.match(/[\s\S]{1,3}/g)!;
  let mode = 'ok';
  const bodies: any[] = [];
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: chatml(b) }));
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    bodies.push(b);
    if (mode === 'error') {
      await serve(res, [
        chat(pieces).events[1],
        { error: { code: 500, message: 'secret prompt text', type: 'server_error' } },
      ]);
      return;
    }
    if (mode === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: chat(pieces).usage,
          timings: chat(pieces).timings,
        }),
      );
    }
    // A stream that ends cleanly before its finish, and one whose connection drops.
    if (mode === 'short') return serve(res, chat(pieces).events.slice(0, 6));
    if (mode === 'crash') {
      await serve(res, chat(pieces).events.slice(0, 6), { keep: true });
      res.socket?.destroy();
      return;
    }
    const c = chat(mode === 'length' ? pieces.slice(0, 9) : pieces, {
      usage: mode !== 'nousage',
      finish: mode === 'length' ? 'length' : 'stop',
      progress: true,
    });
    await serve(res, c.events, { cut: 5, done: true });
  });
  const logged: [string, any][] = [];
  const bonsai = new Bonsai({ ...defaults, baseUrl: `${url}/v1` }, 'local', async (type, data) => {
    logged.push([type, data]);
  });
  const seen: StreamProgress[] = [];
  const args = await bonsai.generate(
    [{ role: 'user', content: 'u' }],
    stepReply,
    0.2,
    { step: 3, route: 'step' },
    undefined,
    p => seen.push({ ...p }),
  );
  assert.deepEqual(args, JSON.parse(content));
  assert.equal(bonsai.streams, true);
  assert.deepEqual(
    seen.slice(0, 2).map(p => p.prompt),
    [
      { total: 1000, cache: 900, processed: 900, time_ms: 5 },
      { total: 1000, cache: 900, processed: 1000, time_ms: 5 },
    ],
    "the prompt's processing comes first",
  );
  const texts = seen.filter(p => !p.prompt);
  assert(
    texts.length >= pieces.length - 1 &&
      texts.every((p, i) => content.startsWith(p.text) && (!i || p.text.length > texts[i - 1]!.text.length)),
    'the JSON text grows by each delta',
  );
  assert.equal(texts.at(-1)!.text, content);
  assert.equal(texts.at(-1)!.tokens, pieces.length);
  const thoughts = seen.map(p => partialJson(p.text)?.thought ?? '');
  assert(
    thoughts.every((x, i) => (args.thought as string).startsWith(x) && (!i || x.length >= thoughts[i - 1]!.length)),
  );
  const { usage, timings } = chat(pieces);
  assert.deepEqual(bonsai.lastMeta?.usage, usage);
  assert.deepEqual(bonsai.lastMeta?.timings, timings);
  assert.equal(bonsai.lastMeta?.finishReason, 'stop');
  const done = logged.find(([type]) => type === 'bonsai')![1];
  assert.deepEqual([done.usage, done.timings, done.finishReason, done.model], [usage, timings, 'stop', 'bonsai-27b']);
  // Delivery options only: every other field is the unstreamed request's.
  const { stream, stream_options, return_progress, ...rest } = bodies[0];
  assert.deepEqual([stream, stream_options, return_progress], [true, { include_usage: true }, true]);
  assert.deepEqual(Object.keys(rest), [
    'model',
    'messages',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'max_tokens',
    'chat_template_kwargs',
    'response_format',
  ]);
  assert.deepEqual([rest.top_p, rest.top_k], [0.95, 20], 'top_p and top_k are sent, not left to the server flags');
  // A server that sends no usage: made from the timings, as the server builds it.
  mode = 'nousage';
  await bonsai.generate([{ role: 'user', content: 'u' }], stepReply);
  assert.deepEqual(bonsai.lastMeta?.usage, {
    completion_tokens: pieces.length,
    prompt_tokens: 1000,
    total_tokens: 1000 + pieces.length,
    prompt_tokens_details: { cached_tokens: 900 },
  });
  // A reply cut at the token limit is the same error, (length), as unstreamed.
  mode = 'length';
  await assert.rejects(bonsai.generate([{ role: 'user', content: 'u' }], stepReply), /\(length\)/);
  // An error inside the stream is the HTTP error it is unstreamed, without the server's text.
  mode = 'error';
  await assert.rejects(bonsai.generate([{ role: 'user', content: 'u' }], stepReply), (e: Error) =>
    /^HTTP 500 from http:\/\/127\.0\.0\.1:\d+$/.test(e.message),
  );
  assert(logged.some(([type, d]) => type === 'bonsai-error' && /HTTP 500/.test(d.error)));
  // A stream that ends before its finish is a reply cut short: an error, and nothing logged as a reply.
  let before = logged.filter(([type]) => type === 'bonsai').length;
  mode = 'short';
  await assert.rejects(
    bonsai.generate([{ role: 'user', content: 'u' }], stepReply),
    /^Error: Bonsai's stream ended before the generation did \(from http:\/\/127\.0\.0\.1:\d+\)$/,
  );
  assert.equal(logged.filter(([type]) => type === 'bonsai').length, before);
  // A connection that drops mid-stream fails as one that drops before the reply: 'fetch failed', as unstreamed.
  mode = 'crash';
  await assert.rejects(
    bonsai.generate([{ role: 'user', content: 'u' }], stepReply),
    (e: Error) => e instanceof TypeError && e.message === 'fetch failed',
  );
  assert.equal(logged.filter(([type]) => type === 'bonsai').length, before);
  // A display that throws does not fail the generation it draws.
  mode = 'ok';
  assert.deepEqual(
    await bonsai.generate([{ role: 'user', content: 'u' }], stepReply, 0.2, undefined, undefined, () => {
      throw new Error('display: cannot write');
    }),
    JSON.parse(content),
  );
  // A server that ignores `stream` and answers JSON: read as before, and code generations are not streamed.
  mode = 'json';
  assert.deepEqual(await bonsai.generate([{ role: 'user', content: 'u' }], stepReply), JSON.parse(content));
  assert.equal(bonsai.streams, false);
});

test('A transient status before a stream starts is retried as postJson retries it; the stream is then read', async t => {
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    await body(req);
    if (++calls === 1) {
      res.statusCode = 503;
      res.setHeader('retry-after', '0');
      return res.end('{}');
    }
    await serve(res, chat(['{"ok":true}']).events, { done: true });
  });
  const r = await post(`${url}/v1/chat/completions`, {}, 'k', 5000, 1);
  assert.equal(calls, 2);
  assert.match(r.headers.get('content-type')!, /event-stream/);
  assert.match(await r.text(), /\[DONE\]/);
});

// A mock llama-server for code generations: ChatML, ids as code points, /detokenize by the ids' bytes, and
// /completion answered from a script of token lists (one per request), streamed when asked.
async function codeServer(t: any) {
  const state = {
    script: [] as Tok[][],
    requests: [] as any[],
    served: [] as { written: number; gone: boolean; events: number }[],
    detokenized: [] as number[][],
    json: false,
    cut: 0,
    error: false,
    crash: false,
    detokenizeFailures: 0,
  };
  const byId = new Map<number, Buffer>();
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: chatml(b) }));
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/detokenize' && state.detokenizeFailures > 0) {
      state.detokenizeFailures--;
      res.statusCode = 503;
      return res.end('{}');
    }
    if (req.url === '/detokenize') {
      state.detokenized.push(b.tokens);
      return res.end(
        JSON.stringify({
          content: Buffer.concat(
            b.tokens.map((id: number) => byId.get(id) ?? Buffer.from(String.fromCodePoint(id))),
          ).toString('utf8'),
        }),
      );
    }
    if (req.url === '/v1/chat/completions') return serve(res, chat(['{"ok":true}']).events, { done: true });
    if (req.url === '/completion') {
      state.requests.push(b);
      const toks = state.script.shift()!;
      for (const x of toks) byId.set(x.id, x.bytes);
      const { events, reply } = completion(
        toks,
        b.n_predict,
        b.stop ?? [],
        b.prompt.length,
        b.timings_per_token,
        b.return_progress,
      );
      if (!b.stream || state.json) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(reply));
      }
      if (state.crash) {
        await serve(res, events.slice(0, 5), { keep: true });
        res.socket?.destroy();
        return;
      }
      const sent = await serve(
        res,
        state.error ? [...events.slice(0, 3), { error: { code: 500, message: 'x', type: 'server_error' } }] : events,
        { cut: state.cut },
      );
      state.served.push({ ...sent, events: events.length });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return { url, state };
}
const config = (url: string) => ({
  ...defaults,
  baseUrl: `${url}/v1`,
  maxTokens: 4096,
  createTokens: 6000,
  contextWindow: 64000,
  workingTokens: 16000,
  safetyTokens: 1024,
  stepThinking: false,
});
const fenced = (s: string) => chars(s);

test('A streamed code generation is one request to the budget, and its text, finish, cut and log are those of the unstreamed reply of the same tokens', async t => {
  const { url, state } = await codeServer(t);
  // é in two tokens and ⚡ in three, each ending inside the character; the closing fence in two tokens (its line break held back), then text never sent.
  const tokens = [
    ...chars('const a = 1;\nconst s = "caf'),
    raw(9001, 0xc3),
    raw(9002, 0xa9),
    ...chars(' '),
    raw(9003, 0xe2),
    raw(9004, 0x9a),
    raw(9005, 0xa1),
    ...chars('";\nexport { a };'),
    ...chars('\n'),
    { id: 71093, bytes: Buffer.from('```') },
    ...chars('\nmore'),
  ];
  const logged: [string, any][] = [];
  const bonsai = new Bonsai(config(url), 'local', async (type, data) => {
    logged.push([type, data]);
  });
  await bonsai.generate([{ role: 'user', content: 'u' }], {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  });
  assert.equal(bonsai.streams, true, 'learned from the step reply');
  state.script = [tokens];
  state.cut = 7;
  const seen: StreamProgress[] = [];
  const messages = [
    { role: 'system' as const, content: 'S' },
    { role: 'user' as const, content: 'U' },
  ];
  const g = await bonsai.generateText(messages, {
    fence: '```ts',
    context: { step: 4, route: 'create_file' },
    progress: p => seen.push({ ...p }),
  });
  assert.equal(g.text, 'const a = 1;\nconst s = "café ⚡";\nexport { a };');
  assert.equal(g.finish, 'stop');
  assert.equal(g.cut, undefined);
  assert.equal(state.requests.length, 1, 'one request');
  const r = state.requests[0];
  assert.deepEqual(
    [
      r.n_predict,
      r.stream,
      r.timings_per_token,
      r.return_progress,
      r.cache_prompt,
      r.return_tokens,
      r.stop,
      r.temperature,
      r.min_p,
      r.top_k,
      r.top_p,
      r.presence_penalty,
    ],
    [6000, true, true, true, true, true, ['\n```'], 0.3, 0.05, 20, 0.9, 0],
  );
  assert.deepEqual(r.message_delimiters, [{ role: 'user', delimiter: '<|im_start|>user' }]);
  assert.deepEqual(
    r.prompt,
    [...`${chatml({ messages })}\`\`\`ts\n`].map(c => c.codePointAt(0)),
    'the prompt ids as before',
  );
  assert.equal(g.meta.continuations, 0);
  assert.equal(g.meta.usage.completion_tokens, tokens.length - 5, 'every token through the fence');
  assert.equal(g.meta.timings.predicted_n, tokens.length - 5);
  assert(
    seen.length > 10 && seen.every(p => g.text.startsWith(p.text) || p.text.startsWith(g.text)),
    'progress is the text so far',
  );
  assert.deepEqual(
    seen[0],
    {
      text: '',
      tokens: 0,
      prompt: { total: r.prompt.length, cache: r.prompt.length - 7, processed: r.prompt.length, time_ms: 3 },
    },
    "the prompt's processing first",
  );
  const done = logged.filter(([type]) => type === 'bonsai').at(-1)![1];
  assert.deepEqual(
    [done.finishReason, done.continuations, done.raw, done.usage],
    ['stop', 0, true, { prompt_tokens: r.prompt.length, completion_tokens: tokens.length - 5 }],
  );
  // The same tokens unstreamed (a client that has not seen a stream sends the request as before): the same result.
  const plain = new Bonsai(config(url), 'local', async () => {});
  state.script = [tokens];
  const u = await plain.generateText(messages, { fence: '```ts' });
  assert.deepEqual([u.text, u.finish, u.cut, u.meta.usage], [g.text, g.finish, g.cut, g.meta.usage]);
  assert.equal(state.requests.at(-1).stream, false);
  assert.equal(state.requests.at(-1).n_predict, 1024, 'its chunk, as before');
});

test('A stream that stops at its token limit: text held back as the start of the closing fence is detokenized; a character cut off at the end is a replacement character; both as the unstreamed reply has them', async t => {
  const { url, state } = await codeServer(t);
  const streamed = new Bonsai(config(url), 'local', async () => {});
  streamed.streams = true;
  const plain = new Bonsai(config(url), 'local', async () => {});
  const both = async (tokens: Tok[], budget: number, chunk = budget) => {
    state.script = [tokens];
    const s = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', budgetTokens: budget });
    const p = new Bonsai({ ...config(url), maxTokens: chunk }, 'local', async () => {});
    state.script = [tokens];
    const u = await p.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', budgetTokens: budget });
    return { s, u };
  };
  // The budget ends on a line break: held back by the server, recovered from its id, so the last line is whole.
  state.detokenizeFailures = 1; // a server that fails it once is asked again
  const held = await both(chars('line one\nline two\nline three'), 18);
  assert.deepEqual(state.detokenized.at(-1), [10], 'the held line break, by its id');
  assert.deepEqual([held.s.text, held.s.finish, held.s.cut], ['line one\nline two\n', 'length', undefined]);
  assert.deepEqual(
    [held.s.text, held.s.finish, held.s.cut, held.s.meta.usage],
    [held.u.text, held.u.finish, held.u.cut, held.u.meta.usage],
  );
  // The budget ends inside ⚡: the line is unfinished and cut, with the same facts (its length counts the replacement character).
  const lost = await both(
    [...chars('ok\nx = "'), raw(9003, 0xe2), raw(9004, 0x9a), raw(9005, 0xa1), ...chars('"\n')],
    10,
  );
  assert.deepEqual(
    [lost.s.text, lost.s.finish, lost.s.cut?.kind, lost.s.cut?.lineChars],
    ['ok\n', 'length', 'budget', 6],
  );
  assert.deepEqual([lost.s.text, lost.s.finish, lost.s.cut], [lost.u.text, lost.u.finish, lost.u.cut]);
  // An end-of-generation token before the fence: the file is not complete, as unstreamed.
  const ended = await both([...chars('a = 1\n'), eos], 100);
  assert.deepEqual([ended.s.text, ended.s.finish], [ended.u.text, ended.u.finish]);
  assert.equal(ended.s.finish, 'eos');
  // A server that answers a stream request with JSON: read as one chunk, and later generations go back to chunks.
  state.json = true;
  state.script = [chars('x = 1\n\n```')];
  assert.equal((await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' })).text, 'x = 1\n');
  state.json = false;
  assert.equal(streamed.streams, false);
  state.script = [chars('y = 2\n\n```')];
  await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  assert.deepEqual([state.requests.at(-1).stream, state.requests.at(-1).n_predict], [false, 1024]);
  streamed.streams = true;
  // An error inside the stream fails as the HTTP error, and a stream that ends before its final event fails.
  state.error = true;
  state.script = [chars('x = 1\n\n```')];
  await assert.rejects(
    streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' }),
    /^Error: HTTP 500 from http:\/\/127\.0\.0\.1:\d+$/,
  );
  state.error = false;
});

test('A streamed generation that starts repeating itself is stopped as it arrives: the request is aborted, the server sees the client go, and the cut is the one the chunk-end judgement gives', async t => {
  const { url, state } = await codeServer(t);
  const streamed = new Bonsai(config(url), 'local', async () => {});
  streamed.streams = true;
  const loop = ['<div className="feature">', '  <h3>Fast</h3>', '  <p>Really fast builds.</p>', '</div>'].join('\n');
  const tokens = chars(`const b = 2;\n${Array.from({ length: 40 }, () => loop).join('\n')}\n`);
  state.script = [tokens];
  const s = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  await sleep(50);
  const served = state.served.at(-1)!;
  assert(
    served.gone && served.written < served.events / 2,
    `the client went after ${served.written} of ${served.events} events`,
  );
  // A repeat of whole lines is judged where the first chunk would have ended: stopped there, cut as the chunks cut it.
  assert.equal(s.finish, 'repetition');
  assert.equal(s.cut?.kind, 'lines');
  assert.equal(s.meta.usage.completion_tokens, 1024);
  const plain = new Bonsai(config(url), 'local', async () => {});
  state.script = [tokens];
  const u = await plain.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.deepEqual([s.text, s.cut, s.meta.usage], [u.text, u.cut, u.meta.usage]);
  // A loop inside one line, which never ends the line: judged as the line grows.
  const path = chars(`const c = <path d="M0 0${' 0 0.267 0 0.4 0 0.133'.repeat(200)}`);
  state.script = [path];
  const p = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.deepEqual([p.finish, p.text, p.cut?.kind, p.cut?.unit], ['repetition', '', 'cycle', 22]);
  assert(p.meta.usage.completion_tokens < path.length / 2);
  // A region's block that starts reproducing the lines after the region: stopped once the ten lines that identify them have come.
  const around = {
    before: 'import { x } from "./x"\n\nexport function a() {',
    region: '  return x(0)',
    after:
      '}\n\nexport function b(n: number) {\n  return x(n) * 2\n}\n\nexport const c = b(3)\nexport const d = 4\nexport const e = 5\nexport const f = 6\nexport const g = 7\nexport const h = 8\nexport const i = 9\nexport const j = 10\nexport const k = 11',
  };
  const echo = chars(`  return x(1)\n${around.after}\n`);
  state.script = [echo];
  const e = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts', around });
  assert.deepEqual([e.finish, e.text, e.cut?.kind, e.cut?.line], ['repetition', '  return x(1)\n', 'echo', 2]);
  assert(
    e.cut!.echoed! >= 12 && e.cut!.echoed! < 17,
    `stopped at the repeat (${e.cut!.echoed} lines after the region)`,
  );
  assert.equal(state.requests.at(-1).n_predict, 6000, 'no 128-token chunks: the block is judged as it arrives');
  // Each is the cut a chunk ending where the stream was stopped gives: repeatCut on the text of the tokens received.
  const upTo = (toks: Tok[], n: number) =>
    toks
      .slice(0, n)
      .map(x => x.bytes.toString())
      .join('');
  assert.deepEqual(repeatCut(upTo(echo, e.meta.usage.completion_tokens), around), { kept: e.text, cut: e.cut });
  assert.deepEqual(repeatCut(upTo(tokens, s.meta.usage.completion_tokens)), { kept: s.text, cut: s.cut });
});

test('Between chunk ends a stream is judged only for a loop inside the line being written and for an echo: a legitimate run of identical lines is kept, and a loop the first chunk end finds is stopped there with the same facts', async t => {
  const { url, state } = await codeServer(t);
  const streamed = new Bonsai(config(url), 'local', async () => {});
  streamed.streams = true;
  const plain = new Bonsai(config(url), 'local', async () => {});
  // react-demo-40 step 6's shape: eight identical decorative lines in a file that ends before its first chunk end.
  const hero = [
    'export function Hero() {',
    '  return (',
    '    <section className="hero">',
    '      <h1 className="hero__title">Build faster</h1>',
    '      <div className="hero__visual">',
    ...Array(8).fill('        <div className="hero__visual__line" />'),
    '      </div>',
    '      <p className="hero__text">Ship the landing page today.</p>',
    '    </section>',
    '  )',
    '}',
    '',
  ].join('\n');
  assert.equal(
    repeatCut(hero.slice(0, hero.indexOf('      </div>'))),
    null,
    'eight identical lines are not a loop at a chunk end either (twelve are)',
  );
  state.script = [chars(`${hero}\`\`\`\n`)];
  const s = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  state.script = [chars(`${hero}\`\`\`\n`)];
  const u = await plain.generateText([{ role: 'system', content: 'S' }], { fence: '```tsx' });
  assert.deepEqual([s.text, s.finish, s.cut], [hero.replace(/\n$/, ''), 'stop', undefined]);
  assert.deepEqual([u.text, u.finish, u.cut], [s.text, s.finish, s.cut]);
  // A loop inside one line that drifts: verbatim for 800 characters at the first chunk end (1024 tokens), broken
  // just after it, verbatim again later. Judged only every 256 characters it would run on past the chunk end.
  const filler = Array.from({ length: 196 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * 7 + i * i) % 26]).join('');
  const line = `const d = "${filler}${'0 0.267 0 '.repeat(81)}X${'0 0.267 0 '.repeat(300)}";`;
  const loop = chars(`const a = 1;\n${line}\n\`\`\`\n`);
  state.script = [loop];
  const ls = await streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  state.script = [loop];
  const lu = await plain.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' });
  assert.deepEqual(
    [ls.finish, ls.text, ls.cut?.kind, ls.cut?.unit, ls.meta.usage.completion_tokens],
    ['repetition', 'const a = 1;\n', 'cycle', 10, 1024],
  );
  assert.deepEqual(
    [ls.text, ls.cut, ls.meta.usage],
    [lu.text, lu.cut, lu.meta.usage],
    "the chunk end's cut, facts and all",
  );
});

test('A stream that stops coming is aborted at a deadline each event pushes back (keep-alive comments do not); a dropped connection fails as unstreamed; a display that throws fails nothing', async t => {
  const url = await listen(t, async (req, res) => {
    await body(req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    const ping = setInterval(() => res.write(':\n\n'), 20);
    res.on('close', () => clearInterval(ping));
    if (req.url === '/hang') res.write('data: {"n":1}\n\n');
    if (req.url === '/slow') {
      for (let n = 0; n < 8; n++) {
        res.write(`data: {"n":${n}}\n\n`);
        await sleep(50);
      }
      clearInterval(ping);
      res.end();
    }
  });
  const read = async (path: string, firstMs: number, gapMs: number) => {
    const abort = new AbortController();
    const r = await post(`${url}${path}`, {}, 'k', 10000, 0, abort.signal);
    const started = performance.now();
    const got: any[] = [];
    try {
      for await (const e of streamEvents(r, url, abort, firstMs, gapMs)) got.push(e);
      return { got, ms: performance.now() - started };
    } catch (e) {
      return { got, ms: performance.now() - started, error: e as Error };
    }
  };
  const hang = await read('/hang', 2000, 150);
  assert.deepEqual(hang.got, [{ n: 1 }]);
  assert.deepEqual(
    [hang.error?.name, hang.error?.message],
    ['TimeoutError', 'The operation was aborted due to timeout'],
    'the error a request gives at its deadline',
  );
  assert(hang.ms >= 140 && hang.ms < 1000, `${hang.ms} ms`);
  const silent = await read('/silent', 150, 5000);
  assert.equal(silent.error?.name, 'TimeoutError');
  assert(silent.ms < 1000);
  const slow = await read('/slow', 2000, 150);
  assert.equal(slow.error, undefined);
  assert.equal(slow.got.length, 8, 'events 50 ms apart keep a 150 ms deadline away');
  // /completion: a dropped connection, a held tail whose detokenize failed once, a display that throws.
  const code = await codeServer(t);
  const streamed = new Bonsai(config(code.url), 'local', async () => {});
  streamed.streams = true;
  code.state.crash = true;
  code.state.script = [chars('a = 1\nb = 2\n```\n')];
  await assert.rejects(
    streamed.generateText([{ role: 'system', content: 'S' }], { fence: '```ts' }),
    (e: Error) => e instanceof TypeError && e.message === 'fetch failed',
  );
  code.state.crash = false;
  code.state.script = [chars('a = 1\nb = 2\n```\n')];
  const g = await streamed.generateText([{ role: 'system', content: 'S' }], {
    fence: '```ts',
    progress: () => {
      throw new Error('display: cannot write');
    },
  });
  assert.deepEqual([g.text, g.finish], ['a = 1\nb = 2', 'stop']);
});

// The cells a terminal row takes at most: one per ASCII character, two per other.
const cells = (l: string) => [...l].reduce((n, c) => n + (c < '\x7f' ? 1 : 2), 0);
test("The display shows a step's thought and actions as they are written and prints them whole once, a file being written by its last lines, and how each generation ended; off a terminal only finished lines", () => {
  const tty: string[] = [];
  const plain: string[] = [];
  const d = new Display(
    { write: (s: string) => tty.push(s), isTTY: true, columns: 80, rows: 40 },
    { objective: 'Fix the build', session: 's', verbose: false },
  );
  const p = new Display(
    { write: (s: string) => plain.push(s), isTTY: false },
    { objective: 'Fix the build', session: 's', verbose: false },
  );
  const both = (es: ProgressEvent[]) => {
    for (const e of es) {
      d.update(e);
      p.update(e);
    }
  };
  const row = (label: string) => d.panel().find(l => l.startsWith(label))!;
  const thought =
    'The build fails because src/App.tsx imports ./components/Hero, which does not exist yet — I will read App.tsx to see what it expects from Hero, then create the component with the props it passes and run the build again to confirm.';
  both([
    { kind: 'step', step: 2, phase: 'implement', maxStep: 80 },
    { kind: 'route', step: 2, route: 'step', tokens: 3000, entries: 4 },
    { kind: 'generating', step: 2, route: 'step', attempt: 1 },
    { kind: 'generating', step: 2, route: 'step', attempt: 1, prompt: { total: 3000, cache: 2400, processed: 2700 } },
  ]);
  assert.match(
    row('Now'),
    /^Now {8}[|/\\-] Bonsai reading the step prompt \| 300 \/ 600 tokens \| 2\.4k cached$/,
    'labels keep their column',
  );
  const panelRows = d.panel().length;
  assert.equal(panelRows, 11, 'no live rows before a generation streams');
  both([
    { kind: 'thinking', step: 2, text: thought.slice(0, 40), tokens: 12 },
    { kind: 'thinking', step: 2, text: thought.slice(0, 200), tokens: 1 },
  ]);
  let live = d.panel().slice(11);
  assert.equal(live.length, 7, 'the live rows take a fixed height');
  const rows = live.filter(Boolean);
  assert(rows.length >= 2 && rows.length <= 7 && rows[0]!.startsWith('Thinking   '), live.join('\n'));
  assert(thought.slice(0, 200).endsWith(rows.at(-1)!.trim()), 'the newest words show, a dash as a dash');
  assert.equal(row('Now').slice(13), 'Bonsai thinking | 1 token');
  both([
    {
      kind: 'thinking',
      step: 2,
      text: thought,
      tokens: 61,
      actions: [{ action: 'read_files', args: { files: [{ path: 'src/App.tsx', start: 1, end: 40 }] } }, {}],
    },
  ]);
  live = d.panel().slice(11).filter(Boolean);
  assert.deepEqual(
    live.slice(-2),
    ['Action 1   read_files src/App.tsx 1..40', 'Action 2   '],
    'each action as far as it has come, under the thought (one whose name has not come yet is an empty row)',
  );
  assert(
    live[0]!.startsWith('Thinking   ') && live.length === 6 && live.slice(1, -2).every(l => /^ {11}\S/.test(l)),
    live.join('\n'),
  );
  assert.equal(row('Now').slice(13), 'Bonsai choosing the actions | 61 tokens');
  both([
    { kind: 'generated', step: 2, route: 'step', meta: null, args: {} },
    {
      kind: 'thought',
      step: 2,
      thought,
      actions: [
        { action: 'read_files', args: { files: [{ path: 'src/App.tsx', start: 1, end: 40 }] } },
        { action: 'bash', args: { command: 'npm run build', purpose: 'p', check: true } },
        {
          action: 'bash',
          args: {
            command: 'printf "\x1b[2J"; npx vitest run --reporter=verbose src/components/Hero.test.tsx',
            purpose: 'p',
            check: false,
          },
        },
      ],
    },
  ]);
  assert.deepEqual(d.panel().slice(11), Array(7).fill(''), 'the live rows stay, blank, so the panel does not jump');
  const out = unescaped(tty);
  const at = out.findIndex(l => l.startsWith('[2] thought: '));
  const block: string[] = [out[at]!];
  for (let i = at + 1; /^ {13}\S/.test(out[i] ?? ''); i++) block.push(out[i]!);
  assert.equal(out.filter(l => l.startsWith('[2] thought: ')).length, 1, 'printed once');
  assert.equal(block.map(l => l.trim()).join(' '), `[2] thought: ${thought}`, 'word-wrapped, never cut');
  assert(block.length >= 3 && block.every(l => cells(l) <= 79), block.join('\n'));
  const chose =
    '[2] actions: read_files src/App.tsx 1..40 | bash npm run build | bash printf "[2J"; npx vitest run --reporter=verbose src/components/Hero.test.tsx';
  const from = out.findIndex(l => l.startsWith('[2] actions: '));
  const actions = [out[from]!];
  for (let i = from + 1; /^ {13}\S/.test(out[i] ?? ''); i++) actions.push(out[i]!);
  assert.equal(actions.map(l => l.trim()).join(' '), chose, 'every action, wrapped');
  assert(actions.length >= 2 && actions.every(l => l.length <= 79));
  assert(!tty.join('').includes('\x1b[2J'), 'no escape sequence from the model reaches the terminal');
  // A file being written: its last lines numbered as in the file, tabs as spaces, a long line cut at its end
  // once whole and shown by its end while it is still being written.
  const code = Array.from({ length: 120 }, (_, i) =>
    i === 116
      ? `\t\treturn <div className="${'x'.repeat(120)}" />`
      : i === 119
        ? `const label = '修复构建 ${'y'.repeat(100)}end`
        : `  line ${i + 1}`,
  );
  both([
    { kind: 'step', step: 3, phase: 'implement', maxStep: 80 },
    { kind: 'route', step: 3, route: 'create_file', tokens: 3100, entries: 5 },
    { kind: 'generating', step: 3, route: 'create_file', attempt: 1 },
    {
      kind: 'writing',
      step: 3,
      route: 'create_file',
      path: 'src/components/Hero.tsx',
      from: 1,
      lines: 120,
      tokens: 1500,
      perSecond: 41.3,
      tail: code.slice(-7),
      open: true,
    },
  ]);
  assert.equal(
    row('Now').slice(13),
    'Bonsai writing src/components/Hero.tsx | 120 lines | 1.5k token...',
    'the path once, with how far it has come, fitted to the width',
  );
  live = d.panel().slice(11);
  assert.deepEqual(
    live.map(l => l.slice(0, 19)),
    ['Writing      114 | ', ...[115, 116, 117, 118, 119, 120].map(n => `             ${n} | `)],
  );
  assert.equal(live[0], 'Writing      114 |   line 114', 'indentation kept');
  assert(
    live[3]!.startsWith('             117 |     return <div className="xxx') &&
      live[3]!.endsWith('...') &&
      live[3]!.length === 79,
    'tabs as spaces, a whole line cut at its end',
  );
  assert(
    live[6]!.startsWith('             120 | ...') && live[6]!.endsWith('yyyyend') && cells(live[6]!) <= 79,
    `the line being written by its end: ${live[6]}`,
  );
  both([
    {
      kind: 'writing',
      step: 3,
      route: 'create_file',
      path: 'src/components/Hero.tsx',
      from: 1,
      lines: 120,
      tokens: 1520,
      tail: code.slice(-7, -1).concat(code[119]!.slice(0, 30)),
      open: true,
    },
  ]);
  assert(d.panel().at(-1)!.endsWith(`120 | const label = '修复构建 yyyyyyyyyy`), 'other scripts as they are');
  assert(
    d.panel().every(l => cells(l) <= 79 && !/[\x00-\x1f\x7f]/.test(l)),
    'every row fits the width, counting any non-ASCII character as two cells',
  );
  const meta = {
    ms: 30000,
    usage: { completion_tokens: 1520 },
    timings: { predicted_per_second: 41.3 },
    finishReason: 'repetition',
    promptTokens: 3100,
  };
  const warning =
    'src/components/Hero.tsx: the generated content started repeating a block of lines at line 110; it was cut there: the file holds lines 1..109 as generated; nothing from line 110 on was written';
  both([
    {
      kind: 'generated',
      step: 3,
      route: 'create_file',
      meta,
      args: { chars: 4000, finish: 'repetition' },
      file: { path: 'src/components/Hero.tsx', from: 1, lines: 120 },
    },
    { kind: 'warning', step: 3, text: warning },
    { kind: 'result', step: 3, route: 'create_file', ok: true, ms: 3, chars: 10, text: 'ok' },
    { kind: 'generation_error', step: 4, message: 'fetch failed' },
  ]);
  assert.deepEqual(d.panel().slice(11), Array(7).fill(''), 'the live block goes when the generation ends');
  const after = unescaped(tty);
  const w = after.findIndex(l => l.startsWith('warning | '));
  assert.equal(
    after
      .slice(w, w + 3)
      .map(l => l.trim())
      .join(' '),
    `warning | ${warning}`,
    'a warning wrapped, not cut',
  );
  assert(/^ {10}\S/.test(after[w + 1]!));
  // Off a terminal: the route lines, the finished thought whole on one line and the actions, how the file generation ended; nothing partial, no escapes.
  assert.deepEqual(plain, [
    '[2] step | 3000 prompt tokens | 4 evidence entries\n',
    `[2] thought: ${thought}\n${chose}\n`,
    '[3] create_file | 3100 prompt tokens | 5 evidence entries\n',
    '[3] generated src/components/Hero.tsx | 120 lines | 1.5k tokens | 30.0s | 41.3 tok/s | repetition\n',
    `warning | ${warning}\n`,
    '[4] no action: fetch failed\n',
  ]);
  const g = after.findIndex(l => l.startsWith('[3] generated '));
  assert.equal(
    `${after[g]} ${after[g + 1]!.trim()}`,
    '[3] generated src/components/Hero.tsx | 120 lines | 1.5k tokens | 30.0s | 41.3 tok/s | repetition',
  );
  assert(after.includes('[4] no action: fetch failed'));
  assert.deepEqual(wrap('aaaa bbbb cccccccccccc', 8, 2), ['aaaa', '  bbbb', '  cccccc', '  cccccc']);
  assert.deepEqual(wrap('修复构建 été', 7), ['修复构', '建', 'été'], 'wrapped by cells');
  // Verbose: a step's arguments are not printed again before its thought.
  assert.equal(
    describe({ kind: 'generated', step: 2, route: 'step', meta: null, args: { thought } }, true),
    '[2]   bonsai - | ? generated tokens | finish ?',
  );
});

test('The panel fits the screen: on a short terminal the live rows take only the rows left and the panel never scrolls its top away; on a narrow one every row fits', () => {
  const thought = 'word '.repeat(200);
  const events: ProgressEvent[] = [
    { kind: 'step', step: 1, phase: 'implement', maxStep: 80 },
    { kind: 'thinking', step: 1, text: thought, tokens: 200, actions: [{ action: 'plan', args: { notes: 'n' } }] },
    {
      kind: 'writing',
      step: 1,
      route: 'create_file',
      path: 'src/a.ts',
      from: 1,
      lines: 300,
      tokens: 3000,
      tail: Array.from({ length: 7 }, (_, i) => `line ${i} ${'z'.repeat(200)}`),
      open: true,
    },
    { kind: 'generated', step: 1, route: 'create_file', meta: null, args: {} },
    { kind: 'stop', step: 1, status: 'paused', reason: 'x' },
  ];
  for (const [columns, rows] of [
    [100, 24],
    [100, 19],
    [100, 18],
    [100, 15],
    [100, 12],
    [100, 8],
    [50, 40],
    [20, 40],
  ] as const) {
    const out: string[] = [];
    const d = new Display(
      { write: (s: string) => out.push(s), isTTY: true, columns, rows },
      { objective: 'o', session: 's', verbose: false },
    );
    const heights: number[] = [];
    for (const e of events) {
      d.update(e);
      const panel = d.panel();
      heights.push(panel.length);
      assert(panel.length <= rows - 1, `${columns}x${rows}: ${panel.length} rows`);
      assert(
        panel.every(l => cells(l) <= columns - 1),
        `${columns}x${rows}: ${panel.find(l => cells(l) > columns - 1)}`,
      );
    }
    assert.deepEqual(
      heights.slice(1, 4),
      Array(3).fill(Math.min(rows - 1, 18)),
      `${columns}x${rows}: one height while generating and after`,
    );
    d.close();
  }
});

test("A step and a file generation stream through the real Agent: the thought is shown as it comes (at most ten updates a second), printed once, and the file's lines are shown as they are written", async t => {
  const reply = JSON.stringify({
    thought: 'Create the greeting module: one exported function that formats a name, nothing else is needed yet.',
    actions: [
      { action: 'create_file', args: { path: 'src/greet.ts', purpose: 'export greet(name) returning a greeting' } },
    ],
  });
  const file = 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n';
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: chatml(b) }));
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/v1/chat/completions')
      return serve(res, chat(reply.match(/[\s\S]{1,4}/g)!, { progress: b.return_progress }).events, {
        done: true,
        pace: 4,
      });
    if (req.url === '/completion')
      return serve(
        res,
        completion(chars(`${file}\`\`\`\n`), b.n_predict, b.stop, b.prompt.length, true, b.return_progress).events,
        { pace: 2 },
      );
    res.statusCode = 404;
    res.end('{}');
  });
  const root = await mkdtemp(join(tmpdir(), 'leana-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, '.leana', 'runs', 'r'));
  await store.init();
  const cfg = {
    ...defaults,
    baseUrl: `${url}/v1`,
    allowWrite: true,
    allowBash: false,
    maxSteps: 1,
    contextWindow: 64000,
    workingTokens: 16000,
    maxTokens: 4096,
    createTokens: 4000,
    codeThinking: false,
  };
  const noul = (v: number) => ({ type: 'noul' as const, noul: v });
  const jev = {
    decide: async (_s: unknown, _q: unknown, ctx?: { phase: string }): Promise<Answers> => {
      if (ctx?.phase === 'watchdog')
        return {
          progress: noul(0.8),
          same_failure: noul(0.05),
          stuck: noul(0.05),
          objective_satisfied: noul(0.2),
          needs_user: noul(0.05),
          in_scope: noul(0.9),
        };
      throw new Error(`unexpected ${ctx?.phase}`);
    },
  };
  const seen: { at: number; e: ProgressEvent }[] = [];
  const screen: string[] = [];
  const display = new Display(
    { write: (s: string) => screen.push(s), isTTY: true, columns: 100 },
    { objective: 'greet', session: 's', verbose: false },
  );
  const bonsai = new Bonsai(cfg, 'local', store.log.bind(store));
  await new Agent(
    cfg,
    store,
    jev as any,
    bonsai,
    root,
    l => display.log(l),
    e => {
      seen.push({ at: performance.now(), e });
      display.update(e);
    },
  ).run(await newSession(root, 'Add a greet function'));
  display.close();
  assert.equal(await readFile(join(root, 'src/greet.ts'), 'utf8'), file);
  const thinking = seen.filter(x => x.e.kind === 'thinking');
  assert(thinking.length >= 2, `${thinking.length} thinking events`);
  assert(
    thinking.every((x, i) => !i || x.at - thinking[i - 1]!.at >= 99),
    'at most one each 100 ms',
  );
  const thought = seen.filter(x => x.e.kind === 'thought');
  assert.equal(thought.length, 1);
  assert.equal((thought[0]!.e as any).thought, JSON.parse(reply).thought);
  assert.deepEqual(
    (thought[0]!.e as any).actions.map((a: any) => a.action),
    ['create_file'],
  );
  const writing = seen.filter(x => x.e.kind === 'writing').map(x => x.e as Extract<ProgressEvent, { kind: 'writing' }>);
  assert(writing.length >= 1 && writing.every(w => w.path === 'src/greet.ts' && w.from === 1 && w.tail.length <= 7));
  assert.deepEqual(
    seen.filter(x => x.e.kind === 'generating' && x.e.prompt).map(x => (x.e as any).route),
    ['step', 'create_file'],
    'how far each prompt has been read, before its first token',
  );
  assert.deepEqual(
    seen.find(x => x.e.kind === 'generated' && x.e.route === 'create_file')?.e.kind === 'generated' &&
      (seen.find(x => x.e.kind === 'generated' && x.e.route === 'create_file')!.e as any).file,
    { path: 'src/greet.ts', from: 1, lines: 3 },
  );
  const shown = unescaped(screen);
  assert.equal(shown.filter(l => l.startsWith('[1] thought: ')).length, 1);
  assert(
    shown.some(l =>
      new RegExp(
        `^\\[1\\] generated src/greet\\.ts \\| 3 lines \\| ${[...`${file}\`\`\``].length} tokens \\| (?:\\d+ms|[\\d.]+s) \\| 40\\.0 tok/s$`,
      ).test(l),
    ),
    shown.join('\n'),
  );
  const events = (await readFile(join(store.path, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
  assert(
    events.every(e => !['thinking', 'writing', 'generating'].includes(e.type)),
    'nothing display-only is logged',
  );
  const raw = events.filter(e => e.type === 'bonsai' && e.data.raw).at(-1).data;
  assert.deepEqual(
    [raw.finishReason, raw.continuations, raw.usage.completion_tokens],
    ['stop', 0, [...`${file}\`\`\``].length],
  );
});

test("With stepThinking the step request asks for the model's own thinking at thinkingEffort within its budget; the thinking streams ahead of the reply, is kept in the meta and the log, and never enters the reply", async t => {
  const reply = JSON.stringify({
    thought: 'Read the config first.',
    actions: [{ action: 'read_files', args: { files: [{ path: 'vite.config.ts', start: 1, end: 40 }] } }],
  });
  const reasoning =
    'The build says the plugin is missing. Is it in the manifest? The config imports it, so read the config first.';
  const bodies: any[] = [];
  const logs: [string, any][] = [];
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template') return res.end(JSON.stringify({ prompt: chatml(b) }));
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    bodies.push(b);
    const { events } = chat(reply.match(/[\s\S]{1,4}/g)!);
    // The server parses the thinking out ahead of the content (reasoning_format deepseek): reasoning_content deltas first.
    const thinking = reasoning
      .match(/[\s\S]{1,5}/g)!
      .map(p => ({ ...events[1], choices: [{ finish_reason: null, index: 0, delta: { reasoning_content: p } }] }));
    await serve(res, [events[0], ...thinking, ...events.slice(1)], { done: true });
  });
  const bonsai = new Bonsai({ ...defaults, baseUrl: `${url}/v1` }, 'local', async (type, data) => {
    logs.push([type, data]);
  });
  const seen: StreamProgress[] = [];
  const args = await bonsai.generate(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    stepReply,
    0.2,
    { step: 1, route: 'step' },
    undefined,
    p => seen.push({ ...p }),
    1024,
  );
  assert.deepEqual(args, JSON.parse(reply), 'the reply is the content alone');
  assert.equal(bonsai.lastMeta?.reasoning, reasoning);
  const b = bodies.at(-1);
  assert.deepEqual(
    [b.chat_template_kwargs, b.reasoning_effort, b.reasoning_budget_tokens, typeof b.reasoning_budget_message],
    [{ enable_thinking: true }, defaults.thinkingEffort, 1024, 'string'],
    'the configured effort, the same for every request',
  );
  assert(
    seen.some(p => p.reasoning && !p.text) && seen.at(-1)!.reasoning === reasoning,
    'the thinking is reported as it streams, before the reply',
  );
  const logged = logs.find(([type]) => type === 'bonsai')![1];
  assert.deepEqual([logged.reasoningChars, logged.reasoningForced], [reasoning.length, false]);
  // Without a budget the request is today's: the empty think block is pre-filled and no thinking field is sent.
  await bonsai.generate(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    stepReply,
    0.2,
    { step: 2, route: 'step' },
    undefined,
    undefined,
  );
  assert.deepEqual(
    [
      bodies.at(-1).chat_template_kwargs,
      'reasoning_effort' in bodies.at(-1),
      'reasoning_budget_tokens' in bodies.at(-1),
    ],
    [{ enable_thinking: false }, false, false],
  );
  assert.equal(bonsai.lastMeta?.reasoning, undefined);
  // The display shows the thinking live by its last rows, then prints it whole above the thought.
  assert.equal(
    describe(
      {
        kind: 'thought',
        step: 3,
        thought: 'Read the config first.',
        actions: [{ action: 'plan', args: { notes: 'n' } }],
        reasoning,
      },
      false,
    )!.split('\n')[0],
    `[3] reasoning: ${reasoning}`,
  );
  const writes: string[] = [];
  const d = new Display(
    {
      isTTY: true,
      columns: 100,
      rows: 40,
      write: (x: string) => {
        writes.push(x);
        return true;
      },
    } as any,
    { objective: 'o', session: 's', verbose: false },
  );
  d.update({ kind: 'reasoning', step: 3, text: reasoning, tokens: 30 });
  assert(
    d.panel().some(l => l.startsWith('Reasoning  ') && l.includes('The build says')),
    'live under the panel',
  );
  d.close();
});

test('With codeThinking a file is planned first: a thought at the thinking-mode sampling, stopped at </think> or its budget, then the code at the code sampling after the closed thought, inside the opened fence', async t => {
  const bodies: any[] = [];
  const thought = 'The canvas is #gameCanvas; speeds are pixels per second, times dt in seconds.';
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template')
      return res.end(
        JSON.stringify({
          prompt: chatml(b).replace(
            /<think>\n\n<\/think>\n\n$/,
            b.chat_template_kwargs?.enable_thinking ? '<think>\n' : '<think>\n\n</think>\n\n',
          ),
        }),
      );
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    if (req.url === '/detokenize')
      return res.end(JSON.stringify({ content: (b.tokens as number[]).map(c => String.fromCodePoint(c)).join('') }));
    bodies.push({ ...b, text: (b.prompt as number[]).map((c: number) => String.fromCodePoint(c)).join('') });
    const reply = b.stop?.[0] === '</think>' ? (bodies.length === 1 ? thought : 'x'.repeat(40)) : 'const a = 1;\n';
    const stopType = b.stop?.[0] === '</think>' ? (bodies.length === 1 ? 'word' : 'limit') : 'word';
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        content: reply,
        tokens: [...reply].map(c => c.codePointAt(0)),
        stop_type: stopType,
        stopping_word: stopType === 'word' ? (b.stop?.[0] ?? '') : '',
        tokens_predicted: reply.length,
        timings: { predicted_per_second: 40 },
      }),
    );
  });
  const logs: [string, any][] = [];
  const bonsai = new Bonsai({ ...defaults, baseUrl: `${url}/v1` }, 'local', async (type, data) => {
    logs.push([type, data]);
  });
  const seen: StreamProgress[] = [];
  const g = await bonsai.generateText(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    { fence: '```ts', think: 512, progress: p => seen.push(p) },
  );
  assert.equal(g.text, 'const a = 1;\n');
  assert.equal(g.meta.reasoning, thought);
  const [think, code] = bodies;
  assert.deepEqual(
    [think.stop, think.n_predict, think.temperature, think.top_p],
    [['</think>'], 512, defaults.stepThinkingTemperature, defaults.stepTopP],
    'the thought: thinking-mode sampling, its own budget, stopped at </think>',
  );
  assert(think.text.endsWith('<|im_start|>assistant\n<think>\n'), 'the template opened the thought');
  assert(
    code.text.endsWith(`<think>\n${thought}\n</think>\n\n\`\`\`ts\n`),
    'the code follows the closed thought inside the opened fence',
  );
  assert.deepEqual(
    [code.temperature, code.top_p, code.min_p],
    [defaults.codeTemperature, defaults.codeTopP, defaults.codeMinP],
    'the code: the code sampling',
  );
  assert.equal(logs.find(([type]) => type === 'bonsai')![1].reasoningForced, false);
  // A thought that reaches its budget is closed after the budget message.
  bodies.length = 1;
  await bonsai.generateText(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    { fence: '```ts', think: 40 },
  );
  assert(bodies.at(-1).text.endsWith(`${'x'.repeat(40)}${thinkingBudgetMessage}</think>\n\n\`\`\`ts\n`));
});

test("Every request renders at the one thinkingEffort: a file written without its own thought while the steps think is rendered as they are, its thought left empty, so the system message (where xhigh puts its sentence) is the steps' and the cached prefix holds", async t => {
  const templates: any[] = [];
  const prompts: string[] = [];
  const url = await listen(t, async (req, res) => {
    const b = await body(req);
    if (req.url === '/apply-template') {
      templates.push(b.chat_template_kwargs);
      const think = b.chat_template_kwargs?.enable_thinking;
      const effort = think ? (b.chat_template_kwargs.reasoning_effort ?? 'xhigh') : null;
      return res.end(
        JSON.stringify({
          prompt: `<|im_start|>system\n${effort === 'xhigh' ? 'Reasoning effort is set to xhigh.\n\n' : ''}S<|im_end|>\n<|im_start|>assistant\n${think ? '<think>\n' : '<think>\n\n</think>\n\n'}`,
        }),
      );
    }
    if (req.url === '/tokenize')
      return res.end(JSON.stringify({ tokens: [...String(b.content)].map(c => c.codePointAt(0)) }));
    prompts.push((b.prompt as number[]).map((c: number) => String.fromCodePoint(c)).join(''));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        content: 'const a = 1;\n',
        tokens: [],
        stop_type: 'word',
        stopping_word: '\n```',
        tokens_predicted: 5,
      }),
    );
  });
  const bonsai = new Bonsai(
    { ...defaults, baseUrl: `${url}/v1`, stepThinking: true, thinkingEffort: 'xhigh', codeThinking: false },
    'local',
    async () => {},
  );
  await bonsai.generateText(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    { fence: '```ts' },
  );
  assert.deepEqual(
    templates.filter(k => k?.enable_thinking),
    [{ enable_thinking: true, reasoning_effort: 'xhigh' }],
  );
  assert.equal(
    prompts[0],
    '<|im_start|>system\nReasoning effort is set to xhigh.\n\nS<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n```ts\n',
    "the steps' system message, the template's own empty thought",
  );
  const quiet = new Bonsai(
    { ...defaults, baseUrl: `${url}/v1`, stepThinking: false, codeThinking: false },
    'local',
    async () => {},
  );
  await quiet.generateText(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    { fence: '```ts' },
  );
  assert.equal(
    prompts[1],
    '<|im_start|>system\nS<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n```ts\n',
    'with no thinking anywhere, the plain prompt',
  );
});
