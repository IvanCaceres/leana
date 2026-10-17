#!/usr/bin/env node
import { runsDir } from './store.js';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readKey } from './cli.js';
import { loadConfig } from './config.js';
import { benchmarkPrompt, benchmarkVersion, fixtureFiles, fixtureHash, prepareBenchmark } from './benchmark-fixture.js';
import { verifyBenchmark } from './benchmark-verify.js';
import { comparisonMarkdown, summarizeEvents, type Event } from './benchmark-metrics.js';
import { hash } from './files.js';
import { runCommand } from './commands.js';
import { snapshotFiles } from './live-test.js';
import { killTree } from './shell.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const absolute = (path: string) => resolve(path.replace(/^~(?=\/)/, homedir()));
async function launch(
  args: string[],
  runDir: string,
  timeoutMs: number,
): Promise<{ code: number; timedOut: boolean; wallSeconds: number }> {
  const transcript = createWriteStream(join(runDir, 'agent-console.txt'), { mode: 0o600 });
  const started = performance.now();
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const kill = () => killTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      transcript.write(chunk);
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      transcript.write(chunk);
    });
    child.on('error', e => {
      clearTimeout(timer);
      transcript.end();
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      kill();
      transcript.end(() =>
        resolveRun({ code: code ?? 1, timedOut, wallSeconds: (performance.now() - started) / 1000 }),
      );
    });
  });
}
async function baseline(runDir: string, repo: string): Promise<void> {
  const result = await runCommand(process.execPath, ['--test', 'test/behavior.test.mjs'], repo, 30000);
  await writeFile(join(runDir, 'baseline.txt'), result.output);
  if (result.code !== 0 || result.timedOut)
    throw new Error(`Baseline behavior failed; inspect ${join(runDir, 'baseline.txt')}`);
  console.log('Baseline behavior tests: PASS. The shared architecture has not been implemented yet.');
}
export async function evaluateBenchmark(
  runDir: string,
  options: {
    label?: string;
    wallSeconds?: number;
    agentCompleted?: boolean;
    timedOut?: boolean;
    settings?: unknown;
    telemetry?: boolean;
    harnessHash?: string;
  },
) {
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const verification = await verifyBenchmark(runDir);
  const paths = options.telemetry ? await readdir(runsDir(join(runDir, 'repo'))).catch(() => []) : [];
  const sessionPath = paths[0] ? join(runsDir(join(runDir, 'repo')), paths[0]) : null;
  const events: Event[] = sessionPath
    ? (await readFile(join(sessionPath, 'events.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];
  const metrics = events.length ? summarizeEvents(events) : null;
  const checkpoint = sessionPath
    ? await readFile(join(sessionPath, 'checkpoint.json'), 'utf8').then(
        s => JSON.parse(s),
        () => null,
      )
    : null;
  const completed = options.agentCompleted ?? null;
  const report = {
    version: benchmarkVersion,
    fixtureHash: manifest.fixtureHash,
    promptHash: manifest.promptHash,
    label: options.label ?? manifest.label,
    evaluatedAt: new Date().toISOString(),
    passed: verification.passed && (completed === null || completed),
    verification,
    agentCompleted: completed,
    timedOut: options.timedOut ?? null,
    stopReason: options.timedOut ? 'Benchmark wall-time limit reached' : (checkpoint?.stopReason ?? null),
    finalStep: checkpoint?.step ?? null,
    harnessHash: options.harnessHash ?? null,
    wallSeconds: options.wallSeconds ?? null,
    timingSource: options.telemetry
      ? 'measured-agent-process'
      : options.wallSeconds === undefined
        ? 'unknown'
        : 'user-supplied',
    settings: options.settings ?? null,
    telemetrySource: events.length ? 'leana-events' : 'unavailable',
    metrics,
    sessionPath,
  };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  const rows = [
    ['Behavior preserved', verification.behaviorPassed ? 'PASS' : 'FAIL'],
    ['Shared architecture', verification.architecturePassed ? 'PASS' : 'FAIL'],
    ['Protected files unchanged', verification.protectedFilesUnchanged ? 'PASS' : 'FAIL'],
    ['Agent completed', completed ?? 'unknown'],
    ['Agent wall seconds', options.wallSeconds?.toFixed(2) ?? 'unknown'],
    ['Jev requests', metrics?.jevRequests ?? 'unknown'],
    ['Jev median latency ms', metrics?.jevLatency.medianMs?.toFixed(1) ?? 'unknown'],
    ['Bonsai prompt tokens', metrics?.bonsaiPromptTokens ?? 'unknown'],
    ['Bonsai output tokens', metrics?.bonsaiCompletionTokens ?? 'unknown'],
    ['Bonsai cached prompt tokens', metrics?.bonsaiCachedPromptTokens ?? 'unknown'],
    ['Peak prompt tokens', metrics?.peakPromptTokens ?? 'unknown'],
    ['Compactions', metrics?.compactions ?? 'unknown'],
    ['Repeated read requests', metrics?.repeatedReadRequests ?? 'unknown'],
    ['Tool errors', metrics?.toolErrors ?? 'unknown'],
  ];
  const readable = `# ${report.label}: ${report.passed ? 'PASS' : 'FAIL'}\n\nFixture: ${benchmarkVersion}\n\n| Measurement | Result |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\nStop reason: ${report.stopReason ?? 'not supplied by external agent'}\n\nChanged files: ${verification.changedFiles.join(', ') || '(none)'}\n\nSee changes.diff, behavior-verification.txt and architecture-verification.txt. Jev questions and answers: ${sessionPath ? join(sessionPath, 'jev-decisions.md') : 'not available for this agent'}.\n\nTiming covers the agent process, excluding baseline and independent verification. Provider latency includes network, queueing and bounded retries. Usage covers responses that supplied usage; missing/error usage is not estimated. External-agent timing is labeled user-supplied. This benchmark does not measure GPU memory.\n`;
  await writeFile(join(runDir, 'REPORT.md'), readable);
  console.log('\nBefore/after diff:\n');
  process.stdout.write((await readFile(join(runDir, 'changes.diff'), 'utf8')) || '(No source changes.)\n');
  console.log(
    `\n${report.passed ? 'PASS' : 'FAIL'}: ${report.label}\nReport: ${join(runDir, 'REPORT.md')}\nResults: ${join(runDir, 'result.json')}`,
  );
  if (sessionPath) console.log(`Jev questions: ${join(sessionPath, 'jev-decisions.md')}`);
  return report;
}
async function main(): Promise<void> {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      'key-file': { type: 'string' },
      'env-file': { type: 'string' },
      config: { type: 'string' },
      'max-steps': { type: 'string', default: '80' },
      'timeout-minutes': { type: 'string', default: '20' },
      runs: { type: 'string', default: '1' },
      label: { type: 'string' },
      'wall-seconds': { type: 'string' },
      'prepare-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = v['prepare-only'] ? 'prepare' : (positionals[0] ?? 'run');
  if (v.help) {
    console.log(
      `Refactor benchmark\n\n  npm run bench:refactor -- --key-file ~/jumanji.txt [--runs 3]\n  npm run bench:refactor -- prepare --label cline\n  npm run bench:refactor -- evaluate RUN_DIRECTORY --label cline [--wall-seconds N]\n  npm run bench:refactor -- compare RUN_DIRECTORY RUN_DIRECTORY\n\nLive options: --config PATH, --env-file PATH, --max-steps 80, --timeout-minutes 20\nEach live run uses a fresh fixture with shell and edits enabled. Reports include diffs,\nindependent verification, metrics, and readable Jev questions. No real repository is modified.`,
    );
    return;
  }
  if (command === 'compare') {
    const reports = await Promise.all(
      positionals.slice(1).map(p => readFile(join(absolute(p), 'result.json'), 'utf8').then(JSON.parse)),
    );
    const text = comparisonMarkdown(reports);
    const parent = join(projectRoot, 'work/benchmark-comparisons');
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, 'compare-'));
    await writeFile(join(dir, 'COMPARISON.md'), text);
    console.log(text + `\nSaved: ${join(dir, 'COMPARISON.md')}`);
    return;
  }
  if (command === 'evaluate') {
    if (positionals.length !== 2) throw new Error('evaluate requires exactly one run directory');
    const wallSeconds = v['wall-seconds'] === undefined ? undefined : Number(v['wall-seconds']);
    if (wallSeconds !== undefined && (!Number.isFinite(wallSeconds) || wallSeconds < 0))
      throw new Error('Invalid --wall-seconds');
    const report = await evaluateBenchmark(absolute(positionals[1]!), { label: v.label, wallSeconds });
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (!['prepare', 'run'].includes(command)) throw new Error(`Unknown benchmark command: ${command}`);
  const parent = join(projectRoot, 'work/benchmarks');
  if (command === 'prepare') {
    const { runDir, repo } = await prepareBenchmark(parent, v.label ?? 'external');
    await baseline(runDir, repo);
    console.log(
      `\nPrepared identical starting fixture: ${repo}\nGive the agent this task: ${join(runDir, 'PROMPT.md')}\nAfter it finishes, run:\nnpm run bench:refactor -- evaluate ${runDir} --label ${v.label ?? 'external'}\nNo model requests made.`,
    );
    return;
  }
  const runs = Number(v.runs);
  const minutes = Number(v['timeout-minutes']);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('--runs must be 1..10');
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120)
    throw new Error('--timeout-minutes must be >0 and <=120');
  if (v['env-file']) process.loadEnvFile(absolute(v['env-file']));
  if (v['key-file']) await readKey(absolute(v['key-file']));
  else if (!process.env.TYPESAFE_API_KEY) throw new Error('Provide --key-file PATH or TYPESAFE_API_KEY');
  // The benchmark still requires independent verification to pass. A slightly
  // lower completion threshold avoids rejecting a completed refactor solely
  // because Jev is conservative after all tasks and checks are evidenced.
  const config = await loadConfig(v.config ? absolute(v.config) : undefined, {
    allowWrite: true,
    allowBash: true,
    maxSteps: Number(v['max-steps']),
    completeProbability: 0.75,
  });
  const rg = await runCommand('rg', ['--version'], process.cwd(), 5000);
  if (rg.code !== 0) throw new Error('ripgrep is required');
  await mkdir(parent, { recursive: true });
  const suiteDir = await mkdtemp(join(parent, 'suite-'));
  const harnessFiles: Record<string, string> = {
    ...(await snapshotFiles(join(projectRoot, 'src'))),
    'package-lock.json': await readFile(join(projectRoot, 'package-lock.json'), 'utf8'),
  };
  const harnessHash = hash(
    JSON.stringify(
      Object.keys(harnessFiles)
        .sort()
        .map(k => [k, harnessFiles[k]!]),
    ),
  );
  const reports = [];
  console.log(
    `Suite: ${suiteDir}\nFixture hash: ${fixtureHash()}\nShared server: avoid concurrent Cline requests for comparable timings.`,
  );
  for (let i = 0; i < runs; i++) {
    const { runDir, repo } = await prepareBenchmark(suiteDir, v.label ?? 'leana');
    await baseline(runDir, repo);
    console.log(`\nRun ${i + 1}/${runs}: ${repo}`);
    await writeFile(join(runDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    const args = ['run', benchmarkPrompt, '--repo', repo, '--config', join(runDir, 'config.json')];
    for (const flag of ['key-file', 'env-file'] as const) if (v[flag]) args.push(`--${flag}`, absolute(v[flag]!));
    const agent = await launch(args, runDir, minutes * 60000);
    const report = await evaluateBenchmark(runDir, {
      label: v.label ?? 'leana',
      wallSeconds: agent.wallSeconds,
      agentCompleted: agent.code === 0,
      timedOut: agent.timedOut,
      settings: config,
      telemetry: true,
      harnessHash,
    });
    reports.push({ runDir, ...report });
    await writeFile(
      join(suiteDir, 'summary.json'),
      JSON.stringify(
        {
          version: benchmarkVersion,
          fixtureHash: fixtureHash(),
          promptHash: hash(benchmarkPrompt),
          runs: reports.length,
          passed: reports.filter(r => r.passed).length,
          completionRate: reports.filter(r => r.passed).length / reports.length,
          results: reports,
        },
        null,
        2,
      ) + '\n',
    );
  }
  console.log(
    `\nVerified completions: ${reports.filter(r => r.passed).length}/${reports.length}\nSuite summary: ${join(suiteDir, 'summary.json')}`,
  );
  if (reports.some(r => !r.passed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => {
    console.error(`Benchmark: ${(e as Error).message}`);
    process.exitCode = 1;
  });
