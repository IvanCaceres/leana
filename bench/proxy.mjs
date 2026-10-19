// A recorder in front of OpenRouter. Each chat request's settings (never its messages or the key) are written to a
// JSON-lines file with what came back: the endpoint that served it and the usage it reports. A rewrite, when given,
// changes a chat request's settings before it goes on (the runner's: to Leana's), and the record keeps what the
// harness asked for. Used for harnesses whose OpenRouter base URL can be set and that send the same requests to
// another URL (Hermes does not: it drops its reasoning setting for a host that is not openrouter.ai, so it is read
// from its own request dumps).
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';

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
//
// The proxy also tunnels HTTPS (CONNECT), for a harness given it as HTTPS_PROXY (Hermes): the tunnel carries the
// harness's own encrypted requests to OpenRouter unchanged and unread, so it records only when bytes went to or came
// from openrouter.ai. activity() tells, for both ways in, when OpenRouter last sent or received anything and how many
// requests through the recorder are still open: the runner's watchdog and its working time read it.
export function startProxy(logFile, rewrite = null) {
  let last = 0;
  let open = 0;
  const tunnels = new Set();
  const server = createServer(async (req, res) => {
    open++;
    last = Date.now();
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
          last = Date.now();
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
    } finally {
      open--;
      last = Date.now();
    }
    record.ended = new Date(last).toISOString();
    appendFileSync(logFile, JSON.stringify(record) + '\n');
  });
  server.on('connect', (req, socket, head) => {
    const [host, port] = String(req.url ?? '').split(':');
    const counted = /(^|\.)openrouter\.ai$/i.test(host ?? '');
    const record = { at: new Date().toISOString(), tunnel: host, bytesUp: 0, bytesDown: 0 };
    const up = connect(Number(port) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    tunnels.add(socket);
    // Activity is a chunk that can carry a request or a reply: an idle connection's few closing bytes are not (one
    // Hermes left open closed 6 minutes after its last use, and moved a quiet spell's start to then).
    const talk = d => {
      if (d.length >= 64) last = Date.now();
    };
    if (counted) {
      socket.on('data', d => {
        record.bytesUp += d.length;
        talk(d);
      });
      up.on('data', d => {
        record.bytesDown += d.length;
        talk(d);
      });
    }
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      tunnels.delete(socket);
      socket.destroy();
      up.destroy();
      if (counted) appendFileSync(logFile, JSON.stringify({ ...record, ended: new Date().toISOString() }) + '\n');
    };
    up.on('error', end);
    up.on('close', end);
    socket.on('error', end);
    socket.on('close', end);
  });
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      done({
        url: `${origin}/api/v1`,
        origin,
        activity: () => ({ last, open }),
        close: () =>
          new Promise(r => {
            for (const s of tunnels) s.destroy();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    }),
  );
}
