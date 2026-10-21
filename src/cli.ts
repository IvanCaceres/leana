#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadSettings } from './config.js';
import { Jev, postJson } from './clients.js';
import { runCommand } from './commands.js';
import { renderReport } from './report.js';
import { describeModel, effortsOf, listModels, modelOptions } from './models.js';
import { elapsed, endingLine, forModel, modelClient, providerKey, readKey, runSession, stepsOf } from './session.js';
import { startApp, startTui } from './app.js';
import { usageLine } from './display.js';
export { readKey, dirtySessionConflict } from './session.js';

const usage = `Leana — a coding agent: the model reasons and acts, Jev guards the loop

  leana                                   the app: type objectives, set provider, model and options in place (/help)
  leana run "objective" --repo path [--read-only] [--no-bash]
  leana resume session-directory [--message "new guidance"]
  leana models [words]                    the provider's models (OpenRouter: those matching every word)
  leana model [--model id]                what the model is and the options it takes
  leana report session-directory [--follow]
  leana doctor
  leana --version

Model:   --provider llama|openrouter, --model ID, --reasoning on|off, --file-reasoning on|off,
         --effort LEVEL, --reasoning-budget N  (only what the model takes is accepted; see leana model)
Other:   --plain (the prompt and status panel instead of the full-screen app), --key-file PATH (Jev), --env-file PATH, --config PATH, --max-steps N (turns through OpenRouter), --allow-dirty, --verbose,
         --check "command" (the verification; run as a baseline first and after every edit),
         --unattended (no one is there to review: a finish Jev would send to you goes back to the worker instead)
Keys:    OpenRouter's from OPENROUTER_API_KEY or providerKeyFile in the config; Jev's from --key-file or TYPESAFE_API_KEY.
Default: the model writes files and runs shell commands, unsandboxed with your user privileges (including
file changes outside the repository). --no-bash turns the shell off; --read-only turns off writes and the shell. The app keeps its choices in ~/.config/leana/settings.json.`;
const onOff = (v: string | undefined, flag: string): boolean | undefined =>
  v === undefined
    ? undefined
    : /^(on|true|yes)$/i.test(v)
      ? true
      : /^(off|false|no)$/i.test(v)
        ? false
        : (() => {
            throw new Error(`${flag} takes on or off`);
          })();
async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      config: { type: 'string' },
      'key-file': { type: 'string' },
      'env-file': { type: 'string' },
      'allow-write': { type: 'boolean' },
      'allow-bash': { type: 'boolean' },
      'read-only': { type: 'boolean' },
      'no-bash': { type: 'boolean' },
      'max-steps': { type: 'string' },
      message: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      'allow-dirty': { type: 'boolean' },
      unattended: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      follow: { type: 'boolean' },
      plain: { type: 'boolean' },
      check: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      reasoning: { type: 'string' },
      'file-reasoning': { type: 'string' },
      effort: { type: 'string' },
      'reasoning-budget': { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  if (v.version) {
    // package.json sits two levels up from dist/src, in the repository and in the installed package alike.
    console.log(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (v.help || (!command && !process.stdin.isTTY)) {
    console.log(usage);
    return;
  }
  if (command && !['run', 'resume', 'doctor', 'report', 'models', 'model'].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (command === 'report') {
    if (rest.length !== 1) throw new Error('report requires a session-directory');
    const dir = await realpath(resolve(rest[0]!));
    const write = async () => {
      await renderReport(dir);
      return join(dir, 'report.html');
    };
    console.log(await write());
    if (v.follow) {
      let last = (await stat(join(dir, 'events.jsonl'))).size;
      setInterval(async () => {
        const size = (await stat(join(dir, 'events.jsonl')).catch(() => ({ size: last }))).size;
        if (size !== last) {
          last = size;
          await write();
        }
      }, 3000);
      console.error('Following the session; press Ctrl-C to stop.');
    }
    return;
  }
  if (v['env-file']) process.loadEnvFile(resolve(v['env-file']));
  // The config file, then the app's kept choices, then this command's flags.
  const settings = await loadSettings();
  const flags = {
    ...(v.provider ? { provider: v.provider as 'llama' | 'openrouter' } : {}),
    ...(v.model ? { model: v.model } : {}),
    ...(onOff(v.reasoning, '--reasoning') !== undefined ? { stepThinking: onOff(v.reasoning, '--reasoning')! } : {}),
    ...(onOff(v['file-reasoning'], '--file-reasoning') !== undefined
      ? { codeThinking: onOff(v['file-reasoning'], '--file-reasoning')! }
      : {}),
    ...(v.effort ? { thinkingEffort: v.effort } : {}),
    ...(v['reasoning-budget']
      ? { stepThinkingBudget: Number(v['reasoning-budget']), codeThinkingBudget: Number(v['reasoning-budget']) }
      : {}),
    ...(v['allow-write'] ? { allowWrite: true } : {}),
    ...(v['allow-bash'] ? { allowBash: true } : {}),
    ...(v['read-only'] ? { allowWrite: false, allowBash: false } : {}),
    ...(v['no-bash'] ? { allowBash: false } : {}),
    ...(v['max-steps'] ? { maxSteps: Number(v['max-steps']), openrouterMaxTurns: Number(v['max-steps']) } : {}),
    ...(v.verbose ? { verbose: true } : {}),
    ...(v.check ? { checkCommand: v.check } : {}),
    ...(v.unattended ? { unattended: true } : {}),
  };
  // A provider switched by flag starts from its own default model, unless one is named.
  const kept =
    flags.provider && flags.provider !== settings.config.provider && !flags.model
      ? { ...settings.config, model: flags.provider === 'llama' ? 'bonsai-27b' : settings.config.model }
      : settings.config;
  const config = await loadConfig(v.config, { ...kept, ...flags });
  const jevKey = v['key-file'] ? await readKey(v['key-file']) : (process.env.TYPESAFE_API_KEY ?? '');
  // On a terminal the app is the full-screen UI; --plain (or output that is not a terminal) keeps the prompt.
  const tui = !v.plain && process.stdin.isTTY && process.stdout.isTTY;
  if (!command)
    return (tui ? startTui : startApp)({
      base: config,
      settings,
      jevKey,
      repo: await realpath(resolve(v.repo ?? settings.repo ?? '.')),
      ...(v.config ? { configPath: v.config } : {}),
    });
  const key = await providerKey(config);
  if (command === 'models') {
    for (const m of (await listModels(config, key, rest.join(' '))).slice(0, 50))
      console.log(
        `${m.id.padEnd(48)} ${String(Math.round(m.contextLength / 1000)).padStart(5)}k  ${m.reasoning.supported ? `reasons${m.reasoning.mandatory ? ' (always)' : ''}${effortsOf(m.reasoning).length ? `: ${effortsOf(m.reasoning).join('/')}` : ''}` : ''}`,
      );
    return;
  }
  if (command === 'model') {
    const m = await describeModel(config, key);
    const { config: fitted, notes } = forModel(config, m);
    console.log(`${m.provider}: ${m.id} (${m.name}); context ${m.contextLength}, replies up to ${m.maxOutput} tokens`);
    console.log(
      `reasoning: ${m.reasoning.supported ? `${m.reasoning.mandatory ? 'always on' : 'on/off'}; efforts ${effortsOf(m.reasoning).join(', ') || 'none'}; budget ${m.reasoning.budget ? 'yes' : 'no'}` : 'no'}`,
    );
    for (const o of modelOptions(m)) console.log(`  ${o.name.padEnd(22)} ${o.get(fitted).padEnd(10)} ${o.values}`);
    for (const n of notes) console.log(`note: ${n}`);
    return;
  }
  if (command === 'doctor') {
    // Raw events only when asked; the summary lines are the point of doctor.
    const log = async (type: string, data: unknown) => {
      if (config.verbose) console.log(JSON.stringify({ type, data }));
    };
    const rg = await runCommand('rg', ['--version'], process.cwd(), 5000);
    if (rg.code !== 0) throw new Error('ripgrep is required');
    const m = await describeModel(config, key);
    console.log(`Model: ${m.provider} ${m.id}, context ${m.contextLength} tokens`);
    const client = modelClient(forModel(config, m).config, key, log);
    const result = await client.generate([{ role: 'user', content: 'Return {"ok":true} as JSON.' }], {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    });
    if (result.ok !== true) throw new Error('Model smoke check failed');
    console.log('Model JSON generation: OK');
    if (config.provider === 'llama') {
      // Prefix-cache probe: a long prompt, then the same prompt changed in the middle. A server that can
      // resume from a checkpoint reuses the shared prefix; one that cannot reprocesses everything on every step.
      // A fresh nonce per run: the server keeps earlier prompt states in host memory and would otherwise
      // restore a previous doctor run's prompt. The harness sends its prompt as several user messages,
      // because llama.cpp checkpoints hybrid and sliding-window models only at user-message starts.
      const nonce = randomUUID();
      const block = (i: number, mark = '') => ({
        role: 'user',
        content:
          `Block ${i} (${nonce}${mark}): ` +
          Array.from({ length: 40 }, (_, j) => `the harness records evidence ${i}.${j} about the repository`).join(
            '; ',
          ),
      });
      const probe = async (blocks: unknown[]) => {
        const r = await postJson(
          `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            model: config.model,
            messages: [{ role: 'system', content: 'Reply with one word.' }, ...blocks],
            max_tokens: 1,
            temperature: 0,
            stream: false,
            cache_prompt: true,
            chat_template_kwargs: { enable_thinking: false },
          },
          key,
          180000,
          0,
        );
        return {
          total: r.usage?.prompt_tokens ?? 0,
          cached: r.usage?.prompt_tokens_details?.cached_tokens ?? r.timings?.cache_n ?? 0,
          ms: r.timings?.prompt_ms ?? 0,
        };
      };
      const blocks = Array.from({ length: 8 }, (_, i) => block(i));
      const first = await probe(blocks);
      const changed = await probe(blocks.map((b, i) => (i === 5 ? block(i, ' changed') : b)));
      const share = first.total ? Math.round((100 * changed.cached) / first.total) : 0;
      console.log(
        `Prefix cache: ${changed.cached} of ${changed.total} prompt tokens reused after changing message 6 of 8 (${share}%, ideal about 62%); prompt processing ${changed.ms.toFixed(0)} ms after the change, ${first.ms.toFixed(0)} ms for the full prompt`,
      );
      if (share < 40)
        console.log(
          '  The server is not resuming from the message boundary before the change. Start llama-server with --checkpoint-min-step 0 --ctx-checkpoints 128 so a checkpoint is created at the start of every user message (the default spacing of 8192 tokens skips them); keep cache_prompt enabled.',
        );
    }
    const jev = new Jev(config, jevKey, log);
    const a = await jev.decide(
      { test: 'The build exited with code zero. No changes are needed.' },
      {
        successful: { type: 'noul', instructions: 'Did the build succeed?' },
        next: {
          type: 'choice',
          instructions: 'Which next action fits the stated test?',
          criteria: { report: 'Report successful completion.', debug: 'Debug a failed build.' },
        },
      },
    );
    console.log(`Jev typed API: OK (${JSON.stringify(a)})`);
    return;
  }
  if (command === 'resume' && rest.length !== 1) throw new Error('resume requires a session-directory');
  if (command === 'run' && rest.length !== 1) throw new Error('run requires one quoted objective');
  if (command === 'run' && v.message)
    throw new Error('--message applies to resume; pass the objective for run as the quoted argument');
  const outcome = await runSession({
    config,
    jevKey,
    ...(command === 'resume'
      ? { sessionDir: rest[0]!, ...(v.message ? { message: v.message } : {}) }
      : { objective: rest[0]!, repo: v.repo ?? '.' }),
    ...(v['allow-dirty'] ? { allowDirty: true } : {}),
  });
  // Wall-clock for this invocation and, when the session was resumed, since its first event.
  let since = '';
  // Jev's calls in this invocation, priced as each was logged (Jev bills input tokens only): a cost of its own, apart
  // from the worker's.
  let jevLine = '';
  try {
    const lines = (await readFile(join(outcome.store.path, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    const at = lines[0] ? Date.parse(JSON.parse(lines[0]).at) : NaN;
    const began = Date.now() - outcome.elapsedMs;
    if (Number.isFinite(at) && at < began - 5000) since = `; ${elapsed(Date.now() - at)} since the session began`;
    let calls = 0;
    let input = 0;
    let cost = 0;
    for (const l of lines) {
      if (!l.includes('"type":"jev"')) continue;
      const e = JSON.parse(l);
      if (e.type !== 'jev' || Date.parse(e.at) < began - 1000) continue;
      calls++;
      input += e.data?.usage?.input_tokens ?? 0;
      cost += e.data?.costUsd ?? 0;
    }
    if (calls)
      jevLine = `\nJev: ${calls} call${calls === 1 ? '' : 's'} | ${(input / 1000).toFixed(1)}k in | $${cost.toFixed(4)}`;
  } catch {
    /* no event log */
  }
  const r = outcome.session;
  console.log(
    `\n${endingLine(r)}\nElapsed: ${elapsed(outcome.elapsedMs)} for ${stepsOf(outcome.steps)} (${r.step} in total)${since}${outcome.usage.requests ? `\nUsage: ${usageLine(outcome.usage)}` : ''}${jevLine}\nSession: ${outcome.store.path}`,
  );
  if (r.status !== 'complete') process.exitCode = 2;
}
// Run only when started as the program, not when imported. A global npm install starts it through a link (a
// symlink in the bin directory on macOS and Linux), so the path it was started by is resolved as Node resolves
// the module's own.
const startedAs = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
  } catch {
    return null;
  }
})();
if (import.meta.url === startedAs)
  main().catch(e => {
    console.error(`Leana: ${(e as Error).message}`);
    process.exitCode = 1;
  });
