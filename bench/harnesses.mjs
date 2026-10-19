#!/usr/bin/env node
// Runs one coding task through several agent harnesses (Leana, Hermes, Cline, OpenCode) on the same model through
// OpenRouter, and measures each the same way: wall time, the dollars OpenRouter billed (the API key's usage before and
// after), the requests and tokens the harness itself reports, and whether its result builds and renders. See
// BENCHMARK.md, "Compare harnesses".
//
//   npm run build && node bench/harnesses.mjs --runs 3
//   node bench/harnesses.mjs --harness leana,opencode --runs 1
//
// Trials run one after another (never in parallel: the key's usage is read around each, and two dev servers would
// contend for ports). Every trial starts in a new empty directory under work/bench/harnesses/<stamp>/.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream,
  cpSync,
  copyFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// A harness may stop every Node process on the machine: Cline stopped its preview server with
// `Get-Process node | Stop-Process -Force`, which stopped the runner (and its proxy) too. On Windows the runner runs as a
// copy of Node under another name, which a command naming node does not reach; the harnesses still run as themselves.
// It is started detached: Node puts a child in a job that ends with its parent, and the parent here is a node. Its
// output comes through the parent while that lives; if the parent is stopped, the runner carries on (its results are
// files), its writes to the closed pipes ignored.
if (process.platform === 'win32' && !/leana-bench\.exe$/i.test(process.execPath)) {
  const copy = join(tmpdir(), 'leana-bench-node', 'leana-bench.exe');
  if (!existsSync(copy) || statSync(copy).size !== statSync(process.execPath).size) {
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(process.execPath, copy);
  }
  const c = spawn(copy, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
    env: { ...process.env, LEANA_BENCH_NODE: process.execPath },
  });
  c.stdout.pipe(process.stdout);
  c.stderr.pipe(process.stderr);
  await new Promise(() => c.on('exit', code => process.exit(code ?? 1)));
}
if (process.env.LEANA_BENCH_NODE) for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
// The Node that runs Leana: the one the runner was started with, as a harness would be.
const nodeExe = process.env.LEANA_BENCH_NODE || process.execPath;
const { values: args } = parseArgs({
  options: {
    harness: { type: 'string', default: 'leana,hermes,cline,opencode' },
    runs: { type: 'string', default: '1' },
    scenario: { type: 'string', default: join(here, 'scenario.json') },
    out: { type: 'string', default: join(root, 'work', 'bench', 'harnesses') },
    'skip-verify': { type: 'boolean', default: false },
    rescore: { type: 'string' },
    resume: { type: 'string' },
    'keep-deps': { type: 'boolean', default: false },
  },
});
// A resumed suite keeps the scenario it was started with.
const scenario = args.resume
  ? JSON.parse(readFileSync(join(resolve(args.resume), 'suite.json'), 'utf8')).scenario
  : JSON.parse(readFileSync(args.scenario, 'utf8'));
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Set OPENROUTER_API_KEY: every harness is pointed at OpenRouter with this key.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { killTree, runMark, stopMarked, windowsLeft } = await import(
  new URL('../dist/src/shell.js', import.meta.url).href
).catch(() => {
  throw new Error('Build Leana first (npm run build): the runner uses its process and page-observation code.');
});
const { renderFacts } = await import(new URL('../dist/src/render.js', import.meta.url).href);

// ---- the OpenRouter key's spend: read before and after each trial ------------------------------------------------
async function keyUsage() {
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`OpenRouter /key answered ${r.status}`);
  return Number((await r.json()).data.usage);
}
// OpenRouter books a generation's cost shortly after it ends: wait until the usage has held still for 20 s (at most 3 min).
async function settledUsage(before) {
  let last = await keyUsage();
  let still = Date.now();
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    await sleep(5000);
    const now = await keyUsage();
    if (now !== last) {
      last = now;
      still = Date.now();
    } else if (Date.now() - still >= 20_000 && (last > before || Date.now() - still >= 60_000)) break;
  }
  return last;
}

// ---- running a command, bounded in time, with its whole tree stopped afterwards ----------------------------------
// On Windows a CLI installed by npm or Volta is a .cmd shim, which Node starts only through cmd.exe: each argument is
// quoted for it. An .exe (Hermes) and everything elsewhere start directly.
function resolved(command, argv) {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return { command, argv, verbatim: false };
  const found =
    spawnSync('where', [command], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
  const exe = found.find(f => /\.exe$/i.test(f));
  if (exe) return { command: exe, argv, verbatim: false };
  const cmd = found.find(f => /\.cmd$/i.test(f));
  if (!cmd) return { command, argv, verbatim: false };
  const quote = a => `"${String(a).replaceAll('"', '""')}"`;
  return { command: 'cmd.exe', argv: ['/d', '/s', '/c', `"${[cmd, ...argv].map(quote).join(' ')}"`], verbatim: true };
}
// A harness can leave processes running that hold its output open after it exits (a dev server it started; OpenCode
// did): the run ends when the harness exits, after a short drain, not when its pipes close. On Windows every process it
// starts carries a mark (LEANA_RUN, inherited through the environment), and whatever still carries it afterwards is
// stopped, detached or not; elsewhere the harness runs in its own process group, which is stopped whole.
//
// signal: aborting it stops the harness (the watchdog's last resort for one that does nothing for long); the result
// says stalled.
// onSpawn({pid, mark, at}): what the watchdog needs to find what the harness has started.
function run(command, argv, { cwd, env = {}, timeoutMs, stdout, stderr, signal, onSpawn }) {
  const r = resolved(command, argv);
  const mark = runMark();
  return new Promise(done => {
    const child = spawn(r.command, r.argv, {
      windowsVerbatimArguments: r.verbatim,
      cwd,
      // PWD as well as the process's directory: OpenCode takes its project from PWD, which a shell sets and Node does
      // not (it worked in the directory the runner was started from).
      env: { ...process.env, PWD: cwd, ...env, ...(mark ? { LEANA_RUN: mark } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    onSpawn?.({ pid: child.pid, mark, at: Date.now() });
    const out = stdout ? createWriteStream(stdout) : null;
    const err = stderr ? createWriteStream(stderr) : null;
    let text = '';
    child.stdout.on('data', d => {
      text += d;
      out?.write(d);
    });
    child.stderr.on('data', d => err?.write(d));
    let timedOut = false;
    let stalled = false;
    let finished = false;
    let drain = null;
    const stop = () => {
      killTree(child.pid, 'SIGKILL');
      if (mark) stopMarked(mark);
    };
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drain);
      stop();
      out?.end();
      err?.end();
      done({ code, timedOut, stalled, stdout: text, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      setTimeout(() => finish(null), 5000);
    }, timeoutMs);
    signal?.addEventListener('abort', () => {
      if (finished) return;
      stalled = true;
      stop();
      setTimeout(() => finish(null), 5000);
    });
    child.on('error', e => finish(-1, e.message));
    child.on('exit', code => {
      drain = setTimeout(() => finish(code), 3000);
    });
    child.on('close', code => finish(code));
  });
}
// ---- what a harness leaves running ---------------------------------------------------------------------------------
// A harness can start a server and leave it running: Cline and OpenCode left a vite preview, which held the runner's
// output open after they exited; Hermes waited on its own until it was stopped (11 minutes); a test left
// `npx http-server -p 4599 .`. On Windows a parent chain breaks when a parent exits, and LEANA_RUN reaches only what
// Git Bash starts (windowsLeft), so the harness's family is followed while it runs: on each look at the process table,
// every process started since the trial began by a member, living or not, joins it. Elsewhere the harness runs in its
// own process group. What runs from inside the trial's directory, by its command line, is taken too.
function processTable() {
  if (process.platform === 'win32') {
    const ps =
      'Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.ParentProcessId + [char]9 + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + [char]9 + $_.CommandLine }';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return (r.stdout ?? '')
      .split(/\r?\n/)
      .map(l => l.split('\t'))
      .filter(f => f.length >= 3)
      .map(([pid, ppid, created, ...line]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        group: 0,
        created: Number(created),
        line: line.join('\t').toLowerCase(),
      }));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '')
    .split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[3]), created: 0, line: m[4].toLowerCase() }));
}
// The family of the harness of one trial. keep: what the harness's own command lines hold (the prompt); a process
// holding it is the harness, never stopped while it runs.
function family(trial, keep) {
  const dir = resolve(trial).toLowerCase();
  const kept = keep.map(k => k.toLowerCase()).filter(Boolean);
  const members = new Set();
  let root = null;
  const look = () => {
    const rows = processTable();
    if (root && process.platform === 'win32')
      for (let grew = true; grew;) {
        grew = false;
        for (const r of rows)
          if (members.has(r.ppid) && !members.has(r.pid) && r.created >= root.at - 1000) {
            members.add(r.pid);
            grew = true;
          }
      }
    return rows;
  };
  return {
    started(s) {
      root = s;
      members.add(s.pid);
    },
    look,
    // Stops what the family and the trial's directory still run (the harness itself only once it has exited).
    async stop({ harnessToo = false } = {}) {
      const rows = look();
      const ours = r =>
        members.has(r.pid) || (root && r.group === root.pid && process.platform !== 'win32') || r.line.includes(dir);
      const pids = new Set(
        rows
          .filter(r => ours(r) && r.pid !== process.pid)
          .filter(r => harnessToo || (r.pid !== root?.pid && !kept.some(k => r.line.includes(k))))
          .map(r => r.pid),
      );
      if (root?.mark)
        for (const p of await windowsLeft(root.mark, root.at))
          if (harnessToo || !kept.some(k => p.args.toLowerCase().includes(k))) pids.add(p.pid);
      pids.delete(process.pid);
      if (!harnessToo) pids.delete(root?.pid);
      for (const p of pids) killTree(p, 'SIGKILL');
      return pids.size;
    },
  };
}
const freePort = () =>
  new Promise(done => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
const jsonLines = text =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
// Every object anywhere inside a value (usage blocks sit at different depths in each harness's output).
function* objects(v) {
  if (v && typeof v === 'object') {
    yield v;
    for (const x of Object.values(v)) yield* objects(x);
  }
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const { startProxy, settingsOf } = await import(new URL('./proxy.mjs', import.meta.url).href);

// ---- the settings every harness sends: Leana's ---------------------------------------------------------------------
// Each harness is asked for the scenario's reasoning effort with its own option. The rest of what decides a request's
// result and cost is set to what Leana sent in the same round (its reference): sampling (temperature, top_p, top_k),
// the output cap, and the OpenRouter endpoint order with fallbacks. Cline and OpenCode reach OpenRouter through the
// recording proxy, which sets them on each request; Hermes through a plugin in a Hermes home of its own (see the
// adapter). Every chat request a trial sent is recorded in its requests.jsonl, and compared with the reference.
const effortOf = s => s?.reasoning?.effort ?? s?.reasoning_effort ?? null;
const capOf = s => s?.max_tokens ?? s?.max_completion_tokens ?? null;
const compared = {
  model: s => s.model ?? null,
  effort: effortOf,
  temperature: s => s.temperature ?? null,
  top_p: s => s.top_p ?? null,
  top_k: s => s.top_k ?? null,
  maxTokens: capOf,
  provider: s => s.provider ?? null,
};
const records = file => (existsSync(file) ? jsonLines(readFileSync(file, 'utf8')).filter(r => r.sent) : []);
const distinct = xs => [...new Set(xs.map(x => JSON.stringify(x ?? null)))].map(x => JSON.parse(x));
// The settings most of a Leana trial's requests carried (its code requests and retries sample differently).
function referenceOf(rs) {
  if (!rs.length) return null;
  const mode = f => {
    const n = new Map();
    for (const r of rs) {
      const k = JSON.stringify(f(r.sent) ?? null);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return JSON.parse([...n].sort((a, b) => b[1] - a[1])[0][0]);
  };
  return Object.fromEntries(Object.entries(compared).map(([k, f]) => [k, mode(f)]));
}
// What a trial's requests carried, how many the proxy changed and what the harness had asked for there, the endpoints
// that served them, and every way they differ from the reference.
// A trial's requests and tokens as OpenRouter reported them, request by request, through the proxy: the same
// count for every harness behind it. Harnesses count their own way: Cline reported a fifth to a third of the output
// tokens OpenRouter billed it for. Null when the proxy recorded no usage (Hermes, whose requests come from its dumps).
function meteredOf(rs) {
  const u = rs.map(r => r.usage).filter(Boolean);
  if (!u.length) return null;
  const sum = f => u.reduce((n, x) => n + num(f(x)), 0);
  return {
    requests: rs.length,
    promptTokens: sum(x => x.prompt_tokens),
    cachedTokens: sum(x => x.prompt_tokens_details?.cached_tokens),
    outputTokens: sum(x => x.completion_tokens),
    reasoningTokens: sum(x => x.completion_tokens_details?.reasoning_tokens),
    cost: +sum(x => x.cost).toFixed(6),
  };
}
function settingsReport(rs, ref) {
  const seen = Object.fromEntries(Object.entries(compared).map(([k, f]) => [k, distinct(rs.map(r => f(r.sent)))]));
  const servedBy = {};
  for (const r of rs)
    if ('servedBy' in r) servedBy[r.servedBy ?? 'unknown'] = (servedBy[r.servedBy ?? 'unknown'] ?? 0) + 1;
  const asked = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.harnessAsked ?? {})) (asked[k] ??= []).push(v);
  return {
    requests: rs.length,
    ...seen,
    sessions: distinct(rs.map(r => r.sent.session_id)).length,
    servedBy: Object.keys(servedBy).length ? servedBy : null,
    changedByRunner: rs.filter(r => r.harnessAsked).length,
    harnessAsked: Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, distinct(v)])),
    differences:
      ref && rs.length
        ? Object.keys(compared)
            .filter(k => seen[k].length !== 1 || JSON.stringify(seen[k][0]) !== JSON.stringify(ref[k]))
            .map(k => `${k} ${seen[k].map(v => JSON.stringify(v)).join(' / ')} (Leana ${JSON.stringify(ref[k])})`)
        : ['no requests recorded'],
  };
}
// The proxy's rewrite to the reference, for a harness that reaches OpenRouter through it. The reasoning effort is
// changed only when the harness did not send the reference's (it is asked for it with its own option); the output cap
// keeps the name the harness gives it; a request with no session_id gets the trial's, as Leana's and Hermes's carry one.
const asLeana = (ref, session) => body => {
  const changed = [];
  const set = (k, v) => {
    if (JSON.stringify(body[k]) === JSON.stringify(v ?? undefined)) return;
    if (v === null || v === undefined) delete body[k];
    else body[k] = v;
    changed.push(k);
  };
  if (effortOf(body) !== ref.effort) {
    set('reasoning', ref.effort ? { effort: ref.effort } : null);
    set('reasoning_effort', null);
  }
  for (const k of ['temperature', 'top_p', 'top_k']) set(k, ref[k]);
  if (body.max_completion_tokens !== undefined && body.max_tokens === undefined)
    set('max_completion_tokens', ref.maxTokens);
  else {
    set('max_tokens', ref.maxTokens);
    set('max_completion_tokens', null);
  }
  set('provider', ref.provider);
  if (body.session_id === undefined) set('session_id', session);
  return changed;
};
// A recording proxy for a trial, its rewrite to the reference when one is given.
const proxyFor = (trial, rewrite) => startProxy(join(trial, 'requests.jsonl'), rewrite);

// ---- the harnesses ----------------------------------------------------------------------------------------------
// Each: its version, how it is run on the scenario in an empty directory, and the usage it reports itself.
const harnesses = {
  leana: {
    version: () =>
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version + ` (${git('rev-parse --short HEAD')})`,
    // Through the proxy too, unchanged: what it sends is recorded the same way, and becomes the round's reference.
    async prepare(s, repo, trial) {
      const proxy = await proxyFor(trial, null);
      const config = join(trial, 'leana-config.json');
      writeFileSync(config, JSON.stringify({ openrouterUrl: proxy.url }, null, 2));
      return { proxy, config };
    },
    command: (s, repo, trial, ctx) => [
      nodeExe,
      [
        join(root, 'dist', 'src', 'cli.js'),
        'run',
        s.prompt,
        '--repo',
        repo,
        '--provider',
        s.provider,
        '--model',
        s.model,
        '--effort',
        s.effort,
        '--plain',
        '--config',
        ctx.config,
      ],
    ],
    requires: ['TYPESAFE_API_KEY'],
    usage(trial, stdout) {
      const session = stdout.match(/^Session: (.+)$/m)?.[1]?.trim();
      if (!session || !existsSync(join(session, 'events.jsonl'))) return null;
      const u = {
        requests: 0,
        promptTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        reportedCost: 0,
        extra: {},
      };
      let jev = 0;
      for (const e of jsonLines(readFileSync(join(session, 'events.jsonl'), 'utf8'))) {
        if (e.type === 'jev') jev++;
        if (e.type !== 'bonsai' || !e.data?.usage) continue;
        const x = e.data.usage;
        u.requests++;
        u.promptTokens += num(x.prompt_tokens);
        u.cachedTokens += num(x.prompt_tokens_details?.cached_tokens);
        u.outputTokens += num(x.completion_tokens);
        u.reasoningTokens += num(x.completion_tokens_details?.reasoning_tokens);
        u.reportedCost += num(x.cost);
      }
      u.extra = { session, jevCalls: jev };
      return u;
    },
    cleanup: async ctx => ctx.proxy.close(),
  },
  hermes: {
    version: () => firstLine('hermes', ['--version']),
    // Hermes sends its reasoning setting only to openrouter.ai, so it is not put behind the proxy: it runs from a Hermes
    // home of its own (the user's is left alone) whose plugin sets the reference on each request, and that dumps each
    // request it sends (HERMES_DUMP_REQUESTS, the key masked). The user's model cache is copied in: Hermes sends a
    // reasoning setting only for a model its cache lists as reasoning. Its side calls (titles, compression) are given
    // the same effort and endpoint order through its auxiliary settings; they are not dumped. The proxy is its
    // HTTPS_PROXY, a tunnel that passes its requests unread: it tells only when Hermes last talked to OpenRouter (the
    // watchdog's and the working time's measure), logged to connections.jsonl.
    async prepare(s, repo, trial, ref) {
      const proxy = await startProxy(join(trial, 'connections.jsonl'));
      const home = join(tmpdir(), `leana-bench-hermes-${Date.now()}`);
      const user =
        process.env.HERMES_HOME ??
        (process.platform === 'win32'
          ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes')
          : join(homedir(), '.hermes'));
      mkdirSync(join(home, 'plugins', 'leana-bench'), { recursive: true });
      if (existsSync(join(user, 'cache'))) cpSync(join(user, 'cache'), join(home, 'cache'), { recursive: true });
      const plugin = join(home, 'plugins', 'leana-bench');
      writeFileSync(
        join(plugin, 'plugin.yaml'),
        'name: leana-bench\nversion: 1.0.0\ndescription: "Sends the settings Leana sent (harness benchmark)."\n',
      );
      writeFileSync(join(plugin, '__init__.py'), hermesPlugin(ref));
      const side = JSON.stringify({
        reasoning_effort: ref.effort ?? '',
        extra_body: ref.provider ? { provider: ref.provider } : {},
      });
      writeFileSync(
        join(home, 'config.yaml'),
        [
          'model:',
          `  provider: ${s.provider}`,
          `  default: ${s.model}`,
          'terminal:',
          '  backend: local',
          `  cwd: ${JSON.stringify(repo)}`,
          'plugins:',
          '  enabled: [leana-bench]',
          'auxiliary:',
          `  title_generation: ${side}`,
          `  compression: ${side}`,
          '',
        ].join('\n'),
      );
      writeFileSync(join(trial, 'hermes-config.yaml'), readFileSync(join(home, 'config.yaml')));
      writeFileSync(join(trial, 'hermes-plugin.py'), readFileSync(join(plugin, '__init__.py')));
      return { home, proxy };
    },
    command: (s, repo, trial) => [
      'hermes',
      [
        '-z',
        s.prompt,
        '--usage-file',
        join(trial, 'hermes-usage.json'),
        '--provider',
        s.provider,
        '-m',
        s.model,
        '--reasoning',
        s.effort,
        '--yolo',
        '--in',
        repo,
      ],
    ],
    // Its terminal tool starts in TERMINAL_CWD; without it, a one-shot run worked in the user's home directory.
    env: (repo, ctx) => ({
      TERMINAL_CWD: repo,
      HERMES_HOME: ctx.home,
      HERMES_DUMP_REQUESTS: '1',
      HTTPS_PROXY: ctx.proxy.origin,
      https_proxy: ctx.proxy.origin,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }),
    usage(trial) {
      const f = join(trial, 'hermes-usage.json');
      if (!existsSync(f)) return null;
      const r = JSON.parse(readFileSync(f, 'utf8'));
      const pick = (...names) => {
        for (const o of objects(r))
          for (const n of names) if (o[n] !== undefined && typeof o[n] !== 'object') return num(o[n]);
        return 0;
      };
      const input = pick('input_tokens', 'prompt_tokens');
      const cached = pick('cache_read_tokens', 'cached_tokens');
      return {
        requests: pick('api_calls', 'api_call_count'),
        // Hermes counts cache reads apart from input tokens: the prompt is both.
        promptTokens: input + cached,
        cachedTokens: cached,
        outputTokens: pick('output_tokens', 'completion_tokens'),
        reasoningTokens: pick('reasoning_tokens'),
        reportedCost: pick('actual_cost_usd', 'estimated_cost_usd', 'cost_usd', 'cost'),
        extra: { report: r },
      };
    },
    // Its request dumps, read into the trial's requests.jsonl (OpenRouter's fields in extra_body read as the request's
    // own), then its home removed.
    async cleanup(ctx, trial) {
      await ctx.proxy.close();
      const dumps = [];
      const walk = d => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/^request_dump_.*\.json$/.test(e.name)) dumps.push(p);
        }
      };
      if (existsSync(join(ctx.home, 'sessions'))) walk(join(ctx.home, 'sessions'));
      const lines = dumps
        .map(f => {
          const d = JSON.parse(readFileSync(f, 'utf8'));
          const { extra_body: extra, ...body } = d.request?.body ?? {};
          return {
            at: d.timestamp ?? statSync(f).mtime.toISOString(),
            source: 'hermes request dump',
            sent: settingsOf({ ...body, ...extra }),
          };
        })
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      writeFileSync(join(trial, 'requests.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));
      rmSync(ctx.home, { recursive: true, force: true });
    },
  },
  cline: {
    version: () => firstLine('cline', ['--version']),
    // State (and the key, which cline saves) in a private directory per trial, removed after the trial. Its OpenRouter
    // base URL, which its auth command does not take for OpenRouter, is set in the provider settings it wrote.
    async prepare(s, repo, trial, ref) {
      const proxy = await proxyFor(trial, asLeana(ref, `bench-${Date.now()}`));
      const data = join(tmpdir(), `leana-bench-cline-${Date.now()}`);
      mkdirSync(data, { recursive: true });
      const x = resolved('cline', ['auth', '-p', s.provider, '-k', key, '-m', s.model, '--data-dir', data]);
      const a = spawnSync(x.command, x.argv, {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: x.verbatim,
      });
      writeFileSync(join(trial, 'cline-auth.txt'), `${a.stdout ?? ''}${a.stderr ?? ''}`.replaceAll(key, '<key>'));
      const f = join(data, 'settings', 'providers.json');
      const settings = JSON.parse(readFileSync(f, 'utf8'));
      settings.providers[s.provider].settings.baseUrl = proxy.url;
      writeFileSync(f, JSON.stringify(settings, null, 2));
      return { proxy, data };
    },
    command: (s, repo, trial, ctx) => [
      'cline',
      [
        '-y',
        '--json',
        '-c',
        repo,
        '-P',
        s.provider,
        '-m',
        s.model,
        '--thinking',
        s.effort,
        '--data-dir',
        ctx.data,
        s.prompt,
      ],
    ],
    // The run ends with one run_result line: its iterations (one request each) and the run's usage, cache reads
    // inside inputTokens.
    usage(trial, stdout) {
      const end = jsonLines(stdout).findLast(l => l.type === 'run_result');
      if (!end?.usage) return null;
      const x = end.usage;
      return {
        requests: num(end.iterations),
        promptTokens: num(x.inputTokens),
        cachedTokens: num(x.cacheReadTokens),
        outputTokens: num(x.outputTokens),
        reasoningTokens: 0,
        reportedCost: num(x.totalCost),
        extra: { finishReason: end.finishReason, durationMs: end.durationMs },
      };
    },
    async cleanup(ctx) {
      await ctx.proxy.close();
      rmSync(ctx.data, { recursive: true, force: true });
    },
  },
  opencode: {
    version: () => firstLine('opencode', ['--version']),
    // Its OpenRouter base URL set to the proxy in a config of the trial's own (OPENCODE_CONFIG, merged over the user's),
    // and its small model (titles) the scenario's model, so every request it makes is on that model.
    async prepare(s, repo, trial, ref) {
      const proxy = await proxyFor(trial, asLeana(ref, `bench-${Date.now()}`));
      const config = join(trial, 'opencode-config.json');
      writeFileSync(
        config,
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            small_model: `${s.provider}/${s.model}`,
            provider: { [s.provider]: { options: { baseURL: proxy.url } } },
          },
          null,
          2,
        ),
      );
      return { proxy, config };
    },
    command: (s, repo) => [
      'opencode',
      ['run', '--standalone', '--auto', '--format', 'json', '-m', `${s.provider}/${s.model}#${s.effort}`, s.prompt],
    ],
    env: (repo, ctx) => ({ OPENCODE_CONFIG: ctx.config }),
    usage(trial, stdout) {
      const u = {
        requests: 0,
        promptTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        reportedCost: 0,
        extra: {},
      };
      for (const e of jsonLines(stdout))
        for (const o of objects(e)) {
          // A step's finish carries its tokens ({input, output, reasoning, cache: {read, write}}) and cost.
          if (o.tokens && typeof o.tokens === 'object' && o.tokens.input !== undefined) {
            u.requests++;
            u.promptTokens += num(o.tokens.input) + num(o.tokens.cache?.read);
            u.cachedTokens += num(o.tokens.cache?.read);
            u.outputTokens += num(o.tokens.output) + num(o.tokens.reasoning);
            u.reasoningTokens += num(o.tokens.reasoning);
            u.reportedCost += num(o.cost);
          }
        }
      return u.requests ? u : null;
    },
    cleanup: async ctx => ctx.proxy.close(),
  },
};
// The Hermes plugin: request middleware that sets the reference's sampling, output cap and endpoint order on each
// request (OpenRouter's own fields in extra_body), and its effort only when Hermes did not send the reference's.
function hermesPlugin(ref) {
  return [
    '# Written by bench/harnesses.mjs for one trial: the settings Leana sent, set on each request Hermes sends.',
    'import json',
    '',
    `REF = json.loads(${JSON.stringify(JSON.stringify(ref))})`,
    '',
    '',
    'def register(ctx):',
    '    def as_leana(request=None, **_):',
    '        if not isinstance(request, dict):',
    '            return None',
    '        r = dict(request)',
    '        extra = dict(r.get("extra_body") or {})',
    '        for k in ("temperature", "top_p"):',
    '            if REF.get(k) is None:',
    '                r.pop(k, None)',
    '            else:',
    '                r[k] = REF[k]',
    '        for k, v in (("top_k", REF.get("top_k")), ("provider", REF.get("provider"))):',
    '            if v is None:',
    '                extra.pop(k, None)',
    '            else:',
    '                extra[k] = v',
    '        r.pop("max_completion_tokens", None)',
    '        if REF.get("maxTokens") is None:',
    '            r.pop("max_tokens", None)',
    '        else:',
    '            r["max_tokens"] = REF["maxTokens"]',
    '        effort = (extra.get("reasoning") or {}).get("effort") or extra.get("reasoning_effort")',
    '        if REF.get("effort") and effort != REF["effort"]:',
    '            extra["reasoning"] = {"enabled": True, "effort": REF["effort"]}',
    '            extra.pop("reasoning_effort", None)',
    '        r["extra_body"] = extra',
    '        return {"request": r, "source": "leana-bench", "reason": "the settings Leana sent"}',
    '',
    '    ctx.register_middleware("llm_request", as_leana)',
    '',
  ].join('\n');
}
function git(cmd) {
  return spawnSync('git', cmd.split(' '), { cwd: root, encoding: 'utf8' }).stdout.trim();
}
function firstLine(command, argv) {
  const x = resolved(command, argv);
  const r = spawnSync(x.command, x.argv, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    windowsVerbatimArguments: x.verbatim,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? 'unknown';
}

// ---- checking the result the same way for every harness -------------------------------------------------------
// The project's own build, then its page served by its own scripts and loaded in a headless browser (Leana's page
// observer): exceptions, failed requests, how much text it shows, and a screenshot to look at.
// The project a harness built: its directory, or the one subdirectory (two levels down at most) that holds a
// package.json, as Cline (app/) and Hermes (saas-landing/) scaffold into a new folder.
function projectDir(repo) {
  if (existsSync(join(repo, 'package.json'))) return repo;
  const found = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, 'package.json'))) found.push(p);
      else if (depth < 2) walk(p, depth + 1);
    }
  };
  walk(repo, 1);
  return found.length === 1 ? found[0] : null;
}
async function verify(trialRepo, trial) {
  const out = { project: null, packageJson: false, installed: false, build: null, served: null, page: null };
  const repo = projectDir(trialRepo);
  if (!repo) return out;
  out.project = repo === trialRepo ? '.' : repo.slice(trialRepo.length + 1).replaceAll('\\', '/');
  const pkgPath = join(repo, 'package.json');
  out.packageJson = true;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts ?? {};
  out.scripts = Object.keys(scripts);
  // npm through a shell: on Windows it is a .cmd script.
  const npm = (line, file) => runShell(`npm ${line}`, repo, join(trial, file));
  out.installed = existsSync(join(repo, 'node_modules')) || (await npm('install', 'verify-install.txt')).code === 0;
  if (scripts.build) out.build = (await npm('run build', 'verify-build.txt')).code === 0;
  const port = await freePort();
  // Served by its own scripts, with the flags its tool takes: Next.js (next start after a passing build, else next dev)
  // takes -p and -H and refuses Vite's --strictPort (OpenCode built a Next.js app, failed as not served); Vite and the
  // rest, --port, --strictPort and --host.
  const next = /\bnext\b/.test(`${scripts.dev ?? ''} ${scripts.start ?? ''}`);
  const serve = next
    ? scripts.start && out.build
      ? `npm run start -- -p ${port} -H 127.0.0.1`
      : scripts.dev
        ? `npm run dev -- -p ${port} -H 127.0.0.1`
        : null
    : scripts.preview && out.build
      ? `npm run preview -- --port ${port} --strictPort --host 127.0.0.1`
      : scripts.dev
        ? `npm run dev -- --port ${port} --strictPort --host 127.0.0.1`
        : scripts.start
          ? `npm run start -- -p ${port}`
          : null;
  out.served = serve;
  if (!serve) return dropDeps(repo, out);
  const r = await renderFacts(repo, `http://127.0.0.1:${port}/`, serve, join(trial, 'page.png'), 90_000, [
    { do: 'wait', what: '', ms: 3000 },
  ]);
  writeFileSync(join(trial, 'verify-page.txt'), r.text);
  out.page = {
    ok: r.ok,
    textChars: Number(r.text.match(/(\d+) characters of text/)?.[1] ?? 0),
    title: r.text.match(/title "([^"]*)"/)?.[1] ?? null,
  };
  return dropDeps(repo, out);
}
// A checked project's installed packages and build caches are removed (--keep-deps keeps them): a trial's
// node_modules is a few hundred megabytes, and a 4-run suite filled the disk. npm install puts them back for a rescore.
function dropDeps(repo, out) {
  if (args['keep-deps']) return out;
  for (const d of ['node_modules', join('.next', 'cache')]) rmSync(join(repo, d), { recursive: true, force: true });
  return out;
}
function runShell(line, cwd, file, timeoutMs = 300_000) {
  return run(
    process.platform === 'win32' ? 'cmd.exe' : 'sh',
    process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['-c', line],
    {
      cwd,
      timeoutMs,
      stdout: file,
      stderr: file.replace('.txt', '.err.txt'),
    },
  );
}

// ---- rescoring a finished suite: usage, settings and verification again from each trial's saved output (no agent runs)
async function rescore(suiteDir) {
  const meta = JSON.parse(readFileSync(join(suiteDir, 'suite.json'), 'utf8'));
  const results = [];
  for (const d of readdirSync(suiteDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()) {
    const trial = join(suiteDir, d);
    if (!existsSync(join(trial, 'trial.json'))) continue;
    const old = JSON.parse(readFileSync(join(trial, 'trial.json'), 'utf8'));
    const stdout = existsSync(join(trial, 'agent-stdout.txt'))
      ? readFileSync(join(trial, 'agent-stdout.txt'), 'utf8')
      : '';
    let usage = null;
    try {
      usage = harnesses[old.harness].usage(trial, stdout);
    } catch (e) {
      usage = { error: e.message };
    }
    const sent = records(join(trial, 'requests.jsonl'));
    const repo = join(trial, 'repo');
    const result = {
      ...old,
      wroteHere: readdirSync(repo).some(n => n !== '.git'),
      usage,
      settings: settingsReport(sent, old.harness === 'leana' ? referenceOf(sent) : old.reference),
      metered: meteredOf(sent),
      // --skip-verify keeps each trial's verification: the summary and the usage and settings figures, recomputed alone.
      verification: args['skip-verify']
        ? old.verification
        : await verify(repo, trial).catch(e => ({ error: e.message })),
    };
    writeFileSync(join(trial, 'trial.json'), JSON.stringify(result, null, 2));
    results.push(result);
    console.log(
      `${d}: ${(result.metered ?? result.usage)?.requests ?? '?'} requests | build ${result.verification?.build ?? '-'} | page ${result.verification?.page?.ok ?? '-'}`,
    );
  }
  return { meta, results };
}

// The reference when the round has no Leana trial that sent requests (Leana not among the harnesses run, or its trial
// sent none): a short Leana run on the scenario's model and effort through the proxy, kept in reference-<n>/.
async function referenceRun(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  const s = { ...scenario, prompt: 'Create a file named ok.txt that contains the word OK.' };
  const h = harnesses.leana;
  const ctx = await h.prepare(s, repo, dir);
  const [command, argv] = h.command(s, repo, dir, ctx);
  await run(command, argv, {
    cwd: repo,
    timeoutMs: 300_000,
    stdout: join(dir, 'agent-stdout.txt'),
    stderr: join(dir, 'agent-stderr.txt'),
  });
  await h.cleanup(ctx, dir);
  return referenceOf(records(join(dir, 'requests.jsonl')));
}

// ---- the suite -----------------------------------------------------------------------------------------------------
let suite, results, versions, chosen, runs, sc;
if (args.rescore) {
  suite = resolve(args.rescore);
  const r = await rescore(suite);
  ({ versions, runs } = r.meta);
  sc = r.meta.scenario;
  chosen = Object.keys(versions);
  results = r.results;
} else {
  sc = scenario;
  chosen = args.harness
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const h of chosen)
    if (!harnesses[h]) throw new Error(`Unknown harness ${h}; known: ${Object.keys(harnesses).join(', ')}`);
  // Leana first in each round: what it sends is the reference for the others.
  chosen.sort((a, b) => (b === 'leana') - (a === 'leana'));
  // Leana's requirements always: it sets the reference even when it is not among the harnesses run.
  for (const h of new Set(['leana', ...chosen]))
    for (const v of harnesses[h].requires ?? []) if (!process.env[v]) throw new Error(`${h} needs ${v}`);
  // --resume: the suite's own harnesses and runs; a trial with a trial.json is kept, any other run (a trial to redo is
  // removed first). The versions found now must be those the suite was started with.
  const resumed = args.resume ? JSON.parse(readFileSync(join(resolve(args.resume), 'suite.json'), 'utf8')) : null;
  if (resumed) chosen = Object.keys(resumed.versions);
  suite = resumed ? resolve(args.resume) : join(args.out, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(suite, { recursive: true });
  runs = resumed ? resumed.runs : Number(args.runs);
  versions = Object.fromEntries(chosen.map(h => [h, harnesses[h].version()]));
  // Leana's version names the checkout's commit: a commit that changed only the runner leaves Leana as it was, so its
  // source tree is compared.
  const sameLeana = (now, then) => {
    const [a, b] = [now, then].map(v => v.match(/\(([0-9a-f]+)\)$/)?.[1]);
    return (
      Boolean(a && b) && git(`rev-parse ${a}:src`) === git(`rev-parse ${b}:src`) && git(`rev-parse ${a}:src`) !== ''
    );
  };
  if (resumed)
    for (const h of chosen)
      if (versions[h] !== resumed.versions[h] && !(h === 'leana' && sameLeana(versions[h], resumed.versions[h])))
        throw new Error(`${h} is ${versions[h]} now, ${resumed.versions[h]} when the suite started: start a new suite`);
  if (!resumed)
    writeFileSync(
      join(suite, 'suite.json'),
      JSON.stringify(
        {
          scenario,
          runs,
          versions,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          started: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  console.log(
    `Suite ${suite}\n${Object.entries(versions)
      .map(([h, v]) => `  ${h}: ${v}`)
      .join('\n')}`,
  );
  results = [];
  let ref = null;
  for (let i = 1; i <= runs; i++) {
    if (!chosen.includes('leana')) ref = null;
    for (const name of chosen) {
      const h = harnesses[name];
      if (name !== 'leana' && !ref) {
        console.log(`\n[reference ${i}] a short Leana run, for the settings Leana sends`);
        ref = await referenceRun(join(suite, `reference-${i}`));
        if (!ref)
          throw new Error('The reference Leana run sent no requests: there are no settings to give the harnesses');
      }
      const trial = join(suite, `${name}-${i}`);
      if (resumed && existsSync(join(trial, 'trial.json'))) {
        const kept = JSON.parse(readFileSync(join(trial, 'trial.json'), 'utf8'));
        if (name === 'leana') ref = referenceOf(records(join(trial, 'requests.jsonl'))) ?? ref;
        results.push(kept);
        console.log(`
[${name} ${i}/${runs}] kept from before: exit ${kept.exitCode}, billed ${kept.billedUsd}`);
        continue;
      }
      const repo = join(trial, 'repo');
      mkdirSync(repo, { recursive: true });
      // Its own empty git repository: a harness takes the enclosing repository as its project (OpenCode wrote its
      // project into the checkout that holds work/, and Cline's linter read that checkout's .gitignore).
      spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
      console.log(`\n[${name} ${i}/${runs}] ${repo}`);
      const before = await keyUsage();
      // What the checkout holding the runner has at its top level: a harness that writes outside its directory
      // (OpenCode did, into this checkout) is caught by what appears here.
      const outsideBefore = new Set(readdirSync(root));
      const ctx = h.prepare ? await h.prepare(scenario, repo, trial, ref) : {};
      const [command, argv] = h.command(scenario, repo, trial, ctx);
      writeFileSync(
        join(trial, 'command.json'),
        JSON.stringify(
          {
            command,
            argv: argv.map(a => (a === key ? '<key>' : a)),
            effort: scenario.effort,
            reference: name === 'leana' ? 'this trial' : ref,
          },
          null,
          2,
        ),
      );
      const t0 = Date.now();
      // The watchdog: a harness that has not talked to OpenRouter for idleMinutes, with no request open, is waiting on
      // something else. Hermes, done in 2 minutes, waited 11 more on the vite preview it had left running, until it was
      // stopped by hand. Whatever the harness's family runs is stopped (family), never the harness; a harness idle that
      // long again with nothing left to stop is stopped itself (stalled). Long builds and installs in between
      // model requests last a few minutes at most.
      const idleMs = (scenario.idleMinutes ?? 4) * 60_000;
      const stalls = [];
      const abort = new AbortController();
      let lastStop = t0;
      const fam = family(trial, [scenario.prompt.slice(0, 60)]);
      let looking = false;
      const watchdog = setInterval(async () => {
        if (looking) return;
        looking = true;
        try {
          await tick();
        } finally {
          looking = false;
        }
      }, 10_000);
      const tick = async () => {
        fam.look();
        const a = ctx.proxy?.activity();
        if (!a || a.open) return;
        const quiet = Date.now() - Math.max(a.last, t0);
        if (quiet < idleMs || Date.now() - lastStop < idleMs) return;
        lastStop = Date.now();
        const stopped = await fam.stop();
        stalls.push({ at: new Date().toISOString(), quietSeconds: Math.round(quiet / 1000), stopped });
        console.log(
          `  no OpenRouter traffic for ${Math.round(quiet / 1000)} s: ${stopped ? `stopped ${stopped} process${stopped === 1 ? '' : 'es'} it left running` : 'nothing of its own to stop'}`,
        );
        if (!stopped && stalls.filter(x => !x.stopped).length >= 2) abort.abort();
      };
      const r = await run(command, argv, {
        cwd: repo,
        env: h.env ? h.env(repo, ctx) : {},
        timeoutMs: scenario.timeoutMinutes * 60_000,
        stdout: join(trial, 'agent-stdout.txt'),
        stderr: join(trial, 'agent-stderr.txt'),
        signal: abort.signal,
        onSpawn: s => fam.started(s),
      }).finally(() => clearInterval(watchdog));
      const wallSeconds = (Date.now() - t0) / 1000;
      // Working time: until the harness's last exchange with OpenRouter (its last reply, or for Leana the last before its
      // completion check), less the quiet spells the watchdog ended by stopping what the harness waited on: the waits
      // after its work, or within it (Hermes waited 7 minutes on the `npm run dev` it had started, then replied once).
      const lastTalk = ctx.proxy?.activity().last ?? 0;
      const cut = stalls.filter(x => x.stopped && Date.parse(x.at) <= lastTalk).reduce((n, x) => n + x.quietSeconds, 0);
      const workingSeconds = lastTalk > t0 ? Math.max(0, Math.min(wallSeconds, (lastTalk - t0) / 1000) - cut) : null;
      const after = await settledUsage(before);
      let usage = null;
      try {
        usage = h.usage(trial, r.stdout);
      } catch (e) {
        usage = { error: e.message };
      }
      await h.cleanup?.(ctx, trial);
      const leftover = await fam.stop({ harnessToo: true });
      if (leftover) console.log(`  stopped ${leftover} process${leftover === 1 ? '' : 'es'} it left running`);
      const sent = records(join(trial, 'requests.jsonl'));
      if (name === 'leana') ref = referenceOf(sent);
      const settings = settingsReport(sent, ref);
      // A harness that wrote its project somewhere else leaves its directory empty: said, never scored as a result.
      const wroteHere = readdirSync(repo).some(n => n !== '.git');
      const wroteOutside = readdirSync(root)
        .filter(n => !outsideBefore.has(n))
        .map(n => join(root, n));
      if (wroteOutside.length) console.log(`  it wrote outside its directory: ${wroteOutside.join(', ')}`);
      if (!wroteHere) console.log('  its directory is empty: it wrote its project elsewhere, or nothing');
      const verification = args['skip-verify'] ? null : await verify(repo, trial).catch(e => ({ error: e.message }));
      await fam.stop({ harnessToo: true });
      const result = {
        harness: name,
        trial: i,
        effort: scenario.effort,
        reference: ref,
        settings,
        metered: meteredOf(sent),
        wroteHere,
        ...(wroteOutside.length ? { wroteOutside } : {}),
        exitCode: r.code,
        timedOut: r.timedOut,
        stalled: r.stalled,
        ...(stalls.length ? { stalls } : {}),
        wallSeconds,
        workingSeconds,
        billedUsd: +(after - before).toFixed(6),
        usage,
        verification,
      };
      writeFileSync(join(trial, 'trial.json'), JSON.stringify(result, null, 2));
      results.push(result);
      console.log(
        `  exit ${r.code}${r.timedOut ? ' (timed out)' : r.stalled ? ' (stalled: stopped)' : ''} | ${wallSeconds.toFixed(0)} s, working ${workingSeconds === null ? '?' : workingSeconds.toFixed(0)} s | billed $${result.billedUsd.toFixed(4)} | ${(result.metered ?? usage)?.requests ?? '?'} requests, ${(result.metered ?? usage)?.promptTokens ?? '?'} prompt / ${(result.metered ?? usage)?.outputTokens ?? '?'} output tokens | build ${verification?.build ?? '-'} | page ${verification?.page?.ok ?? '-'}`,
      );
      console.log(
        `  settings: ${name === 'leana' ? 'the reference' : settings.differences.length ? `differ from Leana's: ${settings.differences.join('; ')}` : "Leana's"} | effort ${settings.effort.join('/')} | served by ${
          settings.servedBy
            ? Object.entries(settings.servedBy)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')
            : 'not recorded'
        }`,
      );
    }
  }
}

// ---- summary ---------------------------------------------------------------------------------------------------
const median = xs => {
  const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '?');
const usd = x => (Number.isFinite(x) ? `$${x.toFixed(4)}` : '?');
// A trial passes when the harness exited 0 within its time, wrote its project where it was asked, the project's build
// passed (when it has one) and its page loaded with no exception or failed request.
const passed = r =>
  r.exitCode === 0 &&
  !r.timedOut &&
  !r.stalled &&
  r.wroteHere !== false &&
  !r.wroteOutside?.length &&
  r.verification?.build !== false &&
  r.verification?.page?.ok === true;
const asReference = r => r.settings && !r.settings.differences.length;
const rows = chosen.map(name => {
  const rs = results.filter(r => r.harness === name);
  const of = f => rs.map(f).map(Number);
  const billed = of(r => r.billedUsd).filter(Number.isFinite);
  const efforts = distinct(rs.flatMap(r => r.settings?.effort ?? []));
  return `| ${name} | ${efforts.length ? efforts.join(' / ') : '?'} | ${name === 'leana' ? 'reference' : `${rs.filter(asReference).length}/${rs.length}`} | ${rs.filter(passed).length}/${rs.length} | ${fmt(median(of(r => r.wallSeconds)))} s | ${fmt(median(of(r => r.workingSeconds ?? NaN)))} s${rs.some(r => r.stalls?.length) ? ` (${rs.filter(r => r.stalls?.length).length} waited on leftovers)` : ''} | ${usd(median(billed))} (${billed.length ? `${usd(Math.min(...billed))}–${usd(Math.max(...billed))}` : '?'}) | ${fmt(median(of(r => (r.metered ?? r.usage)?.requests)))} | ${fmt(median(of(r => (r.metered ?? r.usage)?.promptTokens)))} | ${fmt(median(of(r => (r.metered ?? r.usage)?.outputTokens)))} |`;
});
const describe = ref =>
  ref
    ? `effort ${ref.effort ?? 'none'}, temperature ${ref.temperature ?? 'none'}, top_p ${ref.top_p ?? 'none'}, top_k ${ref.top_k ?? 'none'}, output cap ${ref.maxTokens ?? 'none'}, endpoints ${ref.provider?.order?.join(' > ') ?? "OpenRouter's choice"}${ref.provider?.allow_fallbacks ? ' (then any other)' : ''}`
    : 'none recorded';
const references = distinct(results.map(r => r.reference).filter(Boolean));
const settingLines = chosen.map(name => {
  const rs = results.filter(r => r.harness === name && r.settings);
  const served = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.settings.servedBy ?? {})) served[k] = (served[k] ?? 0) + v;
  const asked = {};
  for (const r of rs)
    for (const [k, v] of Object.entries(r.settings.harnessAsked ?? {}))
      asked[k] = distinct([...(asked[k] ?? []), ...v]);
  const changed = rs.reduce((n, r) => n + r.settings.changedByRunner, 0);
  const total = rs.reduce((n, r) => n + r.settings.requests, 0);
  const diffs = rs
    .filter(r => r.settings.differences.length)
    .map(r => `trial ${r.trial}: ${r.settings.differences.join('; ')}`);
  return [
    `- **${name}**: ${total} requests recorded; endpoints that served them: ${
      Object.keys(served).length
        ? Object.entries(served)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')
        : 'not recorded (Hermes is not behind the proxy; its requests come from its own dumps)'
    }.`,
    ...(changed
      ? [
          `  Set by the runner on ${changed} of them; the harness had asked for ${Object.entries(asked)
            .map(([k, v]) => `${k} ${v.map(x => (x === null ? 'none' : JSON.stringify(x))).join(' / ')}`)
            .join(', ')}.`,
        ]
      : []),
    ...(name === 'leana'
      ? []
      : diffs.length
        ? diffs.map(d => `  Differs from Leana's, ${d}.`)
        : ["  Every request carried Leana's settings."]),
  ].join('\n');
});
const summary = [
  `# ${sc.id}`,
  '',
  `Prompt: "${sc.prompt}"  `,
  `Model: ${sc.provider}/${sc.model}, reasoning effort: ${sc.effort}. ${runs} trial${runs === 1 ? '' : 's'} per harness, run one after another.`,
  '',
  "| Harness | Effort sent | Leana's settings | Passed | Wall time (median) | Working time (median) | Billed by OpenRouter (median, range) | Requests (median) | Prompt tokens (median) | Output tokens (median) |",
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  '## Settings sent',
  '',
  `Leana's (the reference): ${references.length ? references.map(describe).join('; then, in a later round, ') : 'none recorded'}.`,
  '',
  ...settingLines,
  '',
  'Versions: ' +
    Object.entries(versions)
      .map(([h, v]) => `${h} ${v}`)
      .join('; ') +
    '.',
  '',
  "Effort sent: the reasoning effort on the requests each harness sent. Leana's settings: trials whose every request carried the effort, sampling, output cap and endpoint order Leana sent in that round. Wall time: from starting the harness to its exit. Working time: to its last exchange with OpenRouter, leaving out any wait after it, such as for a server it left running (the watchdog stops those after a quiet spell and notes it). Billed: the OpenRouter key's usage before and after each trial, which is what was charged, whichever endpoint served it. Requests and tokens: as OpenRouter reported them through the proxy (Leana, Cline, OpenCode); Hermes's own report, as it is not behind the proxy (see BENCHMARK.md). Passed: exit 0 in time without being stopped, the project written where asked, its build passed (when it has one) and its page loaded with no exception or failed request. Look at each trial's page.png too: a page can load and still look wrong.",
].join('\n');
writeFileSync(join(suite, 'summary.json'), JSON.stringify(results, null, 2));
writeFileSync(join(suite, 'SUMMARY.md'), summary + '\n');
console.log(`\n${summary}\n\n${join(suite, 'SUMMARY.md')}`);
// Every trial's processes are stopped: nothing left open (a pipe a stray process held) keeps the runner alive.
process.exit(0);
