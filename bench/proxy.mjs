// A recorder in front of OpenRouter. Each chat request's settings (never its messages or the key) are written to a
// JSON-lines file with what came back: the endpoint that served it and the usage it reports. A rewrite, when given,
// changes a chat request's settings before it goes on (the runner's: to Leana's), and the record keeps what the
// harness asked for. Used for harnesses whose OpenRouter base URL can be set and that send the same requests to
// another URL (Hermes does not: it drops its reasoning setting for a host that is not openrouter.ai, so it is read
// from its own request dumps).
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const upstream = 'https://openrouter.ai';
// The settings of a chat request that decide what the model does, where it runs and what it costs.
export const settingKeys = [
  'model',
  'reasoning',
  'reasoning_effort',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'provider',
  'stream',
  'usage',
  'tool_choice',
  'session_id',
];
export function settingsOf(body) {
  const pick = {};
  for (const k of settingKeys) if (body?.[k] !== undefined) pick[k] = body[k];
  if (Array.isArray(body?.tools)) pick.tools = body.tools.length;
  if (Array.isArray(body?.messages)) pick.messages = body.messages.length;
  return pick;
}

// rewrite(body) changes a chat request's body in place and returns the keys it changed.
export function startProxy(logFile, rewrite = null) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let raw = Buffer.concat(chunks);
    const path = req.url ?? '/';
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      /* not JSON */
    }
    const chat = /\/chat\/completions/.test(path) && body && typeof body === 'object';
    const record = { at: new Date().toISOString(), method: req.method, path };
    if (chat) {
      const asked = settingsOf(body);
      const changed = rewrite ? rewrite(body) : [];
      if (changed.length) {
        raw = Buffer.from(JSON.stringify(body), 'utf8');
        record.harnessAsked = Object.fromEntries(changed.map(k => [k, asked[k] ?? null]));
      }
      record.sent = settingsOf(body);
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers))
      if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v;
    try {
      const r = await fetch(upstream + path, { method: req.method, headers, body: raw.length ? raw : undefined });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      record.status = r.status;
      let text = '';
      if (r.body)
        for await (const c of r.body) {
          res.write(c);
          if (chat) text += Buffer.from(c).toString('utf8');
        }
      res.end();
      if (chat) {
        // The served endpoint and the usage: in a stream, from its data lines; else from the JSON body.
        const parse = s => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        };
        const objs = (
          text.includes('data:')
            ? text
                .split('\n')
                .filter(l => l.startsWith('data:') && !l.includes('[DONE]'))
                .map(l => parse(l.slice(5)))
            : [parse(text)]
        ).filter(Boolean);
        record.servedBy = objs.find(o => o.provider)?.provider ?? null;
        record.id = objs.find(o => o.id)?.id ?? null;
        const usage = objs.findLast(o => o.usage)?.usage;
        if (usage) record.usage = usage;
        const error = objs.find(o => o.error)?.error;
        if (error) record.error = String(error.message ?? JSON.stringify(error)).slice(0, 300);
      }
    } catch (e) {
      record.error = String(e?.message ?? e);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: record.error } }));
    }
    appendFileSync(logFile, JSON.stringify(record) + '\n');
  });
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () =>
      done({
        url: `http://127.0.0.1:${server.address().port}/api/v1`,
        close: () =>
          new Promise(r => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}
