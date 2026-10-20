import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './types.js';
export const defaults: Config = {
  provider: 'llama',
  openrouterUrl: 'https://openrouter.ai/api/v1',
  providerKeyFile: '',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'bonsai-27b',
  contextWindow: 48000,
  maxTokens: 8192,
  workingTokens: 12000,
  safetyTokens: 1024,
  // The evidence budget of a model through OpenRouter: 0 fits it to the model (a quarter of its window, at most
  // 64000 tokens); workingTokens is Bonsai's, sized for its window and its local prefill.
  openrouterWorkingTokens: 0,
  // The turns an invocation through OpenRouter may take (a turn runs one to sixteen actions); maxSteps is Bonsai's, in actions.
  openrouterMaxTurns: 120,
  // Prompt caching through OpenRouter: auto for a model whose catalogue lists a cache-read price, or off.
  promptCache: 'auto',
  // A page observation's screenshot, shown to a model that takes images with the next step: auto, or off.
  screenshots: 'auto',
  // OpenRouter endpoints by what Leana's requests cost on them (endpointOrder), or OpenRouter's own choice.
  openrouterRouting: 'cost',
  // How the prompt is written (Session.form): json for Bonsai; fitted to an OpenRouter model, tools when it takes them, else text.
  promptForm: 'json',
  jevUrl: 'https://api.typesafe.ai/v1/systemone',
  jevModel: 'jev-latest',
  // What TypeSafe charges per million input tokens to Jev (docs.typesafe.ai/models: $42 per billion; output tokens are
  // free). Jev's reply reports its tokens, not a cost; each is priced at this.
  jevUsdPerMillionInput: 0.042,
  // No one will review a finish: one Jev would route to the user goes back to the worker with Jev's readings.
  unattended: false,
  routeProbability: 0.55,
  routeMargin: 0.12,
  compactProbability: 0.75,
  completeProbability: 0.9,
  compactCooldown: 4,
  maxSteps: 80,
  toolChars: 6000,
  commandTimeoutMs: 60000,
  allowWrite: true,
  allowBash: true,
  verbose: false,
  checkCommand: '',
  createTokens: 12000,
  // The server's own min_p is 0.05, so these defaults change nothing it did before.
  stepTemperature: 0.2,
  stepMinP: 0.05,
  // Code at temperature 0.3, top_p 0.9, min_p 0.05: the settings of the runs that worked. PrismML's instruct-mode
  // sampling (0.7, top_p 0.8, min_p 0, presence_penalty 1.5) and its thinking mode were tried on 2026-10-03 and
  // made the same objective slower and worse (below); codePresencePenalty stays for an experiment.
  codeTemperature: 0.3,
  codeMinP: 0.05,
  codePresencePenalty: 0,
  // Thinking-mode sampling, used only when a step thinks (stepThinking): PrismML's temperature 1.0, top_p 0.95,
  // top_k 20, min_p 0.05. top_p and top_k apply to every step.
  stepThinkingTemperature: 1,
  stepTopP: 0.95,
  stepTopK: 20,
  codeTopP: 0.9,
  codeTopK: 20,
  // Only after turns that changed nothing. The server applies temperature after top_k,
  // top_p and min_p, so a higher value reweights the same candidate tokens, never adds one.
  stepTemperatureEscalation: [0.5, 0.8, 1],
  // The model's own thinking is off: measured on one objective ("a supermarket groceries react app"), runs
  // without it took 13 and 20.5 min and completed (react-demo-82, -84); step thinking at 1024 tokens 20.3 and
  // 23.5 min (-85, -86, the second at temperature 1.0); thinking at effort xhigh with 4096 tokens for steps and
  // files, code at 0.7, 78 min, the 120-step limit and an unusable app (-87: a step's reply went from 174 to
  // 2955 tokens at the median, and the work spread into 26 files it could not reconcile). PrismML's scores
  // were measured with thinking; on this harness and these tasks it cost time and bought no quality.
  // Each thinking token costs about 27 ms and is never reused from the cache.
  // That holds for Bonsai. Through OpenRouter it is the reverse ('auto': on for a model that reasons, off for
  // Bonsai; see forModel): the same objective with Claude Haiku 5.5 ("a blade runner neon cyber cityscape scene in
  // 3d"), effort medium, 1024-token budget, took 54 s, 6 steps, 4 requests and $0.006 with thinking (brunner4),
  // against 62-65 s, 14 steps, 9-10 requests and $0.007-0.008 without (brunner2, brunner3); every run finished
  // and was accepted at its first finish.
  stepThinking: 'auto',
  stepThinkingBudget: 1024,
  thinkingEffort: 'medium',
  codeThinking: 'auto',
  codeThinkingBudget: 1024,
};
// Settings that are on, off, or decided for the model ('auto').
const automatic = new Set(['stepThinking', 'codeThinking']);
const zeroable = new Set(['stepMinP', 'codeMinP', 'codePresencePenalty', 'openrouterWorkingTokens']);
export async function loadConfig(path?: string, overrides: Partial<Config> = {}): Promise<Config> {
  const input = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const c = { ...defaults, ...input, ...overrides } as Config;
  for (const [key, value] of Object.entries(c)) {
    const expected = defaults[key as keyof Config];
    if (automatic.has(key) ? value !== 'auto' && typeof value !== 'boolean' : typeof value !== typeof expected)
      throw new Error(`Invalid config: ${key}`);
    if (expected === undefined) throw new Error(`Invalid config: ${key}`);
    // min_p and the presence penalty may be 0 (off); every other number is positive.
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || (value === 0 && !zeroable.has(key))))
      throw new Error(`Invalid number: ${key}`);
  }
  for (const k of ['routeProbability', 'routeMargin', 'compactProbability', 'completeProbability'] as const)
    if (c[k] >= 1) throw new Error(`${k} must be between 0 and 1`);
  for (const k of [
    'contextWindow',
    'maxTokens',
    'workingTokens',
    'safetyTokens',
    'compactCooldown',
    'maxSteps',
    'openrouterMaxTurns',
    'toolChars',
    'commandTimeoutMs',
    'createTokens',
  ] as const)
    if (!Number.isSafeInteger(c[k])) throw new Error(`${k} must be an integer`);
  if (c.workingTokens < 2000 || c.workingTokens > c.contextWindow - c.maxTokens - c.safetyTokens)
    throw new Error('workingTokens must fit inside contextWindow minus output and safety reserves');
  // A long generation is continued in chunks; its whole output plus the largest
  // allowed prompt must still fit the window, or a continuation is cut short.
  for (const k of ['createTokens'] as const)
    if (c[k] < c.maxTokens || c[k] > c.contextWindow - c.workingTokens - c.safetyTokens)
      throw new Error(`${k} must be between maxTokens and contextWindow minus workingTokens and the safety reserve`);
  for (const k of ['stepTopP', 'codeTopP'] as const)
    if (c[k] > 1) throw new Error(`${k} must be above 0 and at most 1`);
  for (const k of ['stepTopK', 'codeTopK'] as const)
    if (!Number.isSafeInteger(c[k])) throw new Error(`${k} must be an integer`);
  for (const k of ['stepTemperature', 'stepThinkingTemperature', 'codeTemperature'] as const)
    if (c[k] > 2) throw new Error(`${k} must be above 0 and at most 2`);
  if (c.codePresencePenalty > 2) throw new Error('codePresencePenalty must be between 0 and 2');
  for (const k of ['stepMinP', 'codeMinP'] as const) if (c[k] >= 1) throw new Error(`${k} must be between 0 and 1`);
  if (
    !Array.isArray(c.stepTemperatureEscalation) ||
    c.stepTemperatureEscalation.length > 8 ||
    c.stepTemperatureEscalation.some(t => typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 2)
  )
    throw new Error('stepTemperatureEscalation must be a list of at most 8 temperatures, each above 0 and at most 2');
  if (!['llama', 'openrouter'].includes(c.provider)) throw new Error('provider must be llama or openrouter');
  // Which efforts a model takes is the model's (models.ts); here only the shape.
  if (!/^[a-z]+$/.test(c.thinkingEffort)) throw new Error('thinkingEffort must be one word, such as medium');
  if (!['json', 'text', 'tools'].includes(c.promptForm)) throw new Error('promptForm must be json, text or tools');
  if (!['auto', 'off'].includes(c.promptCache)) throw new Error('promptCache must be auto or off');
  if (!['auto', 'off'].includes(c.screenshots)) throw new Error('screenshots must be auto or off');
  if (!['cost', 'default'].includes(c.openrouterRouting)) throw new Error('openrouterRouting must be cost or default');
  if (
    !Number.isSafeInteger(c.openrouterWorkingTokens) ||
    (c.openrouterWorkingTokens && c.openrouterWorkingTokens < 2000)
  )
    throw new Error('openrouterWorkingTokens must be 0 (fitted to the model) or an integer of at least 2000');
  if (!Number.isSafeInteger(c.codeThinkingBudget) || c.codeThinkingBudget > 8192)
    throw new Error('codeThinkingBudget must be an integer of at most 8192');
  if (!Number.isSafeInteger(c.stepThinkingBudget) || c.stepThinkingBudget >= c.maxTokens - 256)
    throw new Error(
      'stepThinkingBudget must be an integer below maxTokens - 256 (the reply follows the thinking in the same output budget)',
    );
  if (c.toolChars < 500 || c.toolChars > 20000) throw new Error('toolChars must be 500..20000');
  for (const key of ['baseUrl', 'jevUrl', 'openrouterUrl'] as const) {
    const u = new URL(c[key]);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(`Invalid ${key}`);
  }
  return c;
}

// The choices made in the app (provider, model, reasoning, sampling, limits), kept between runs in the user's
// config directory. Permissions are not kept: write and shell are on unless turned off for a run.
export const settingsPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'leana', 'settings.json');
const kept = new Set([
  'provider',
  'model',
  'openrouterUrl',
  'providerKeyFile',
  'baseUrl',
  'stepThinking',
  'codeThinking',
  'thinkingEffort',
  'stepThinkingBudget',
  'codeThinkingBudget',
  'stepTemperature',
  'stepThinkingTemperature',
  'codeTemperature',
  'stepTopP',
  'codeTopP',
  'stepTopK',
  'codeTopK',
  'stepMinP',
  'codeMinP',
  'codePresencePenalty',
  'maxTokens',
  'workingTokens',
  'openrouterWorkingTokens',
  'maxSteps',
  'openrouterMaxTurns',
  'promptCache',
  'screenshots',
  'openrouterRouting',
]);
export interface Settings {
  config: Partial<Config>;
  repo?: string;
}
export async function loadSettings(path = settingsPath()): Promise<Settings> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { config: {} };
  }
  const config = Object.fromEntries(Object.entries(raw?.config ?? {}).filter(([k]) => kept.has(k))) as Partial<Config>;
  return { config, ...(typeof raw?.repo === 'string' ? { repo: raw.repo } : {}) };
}
export async function saveSettings(s: Settings, path = settingsPath()): Promise<void> {
  const config = Object.fromEntries(Object.entries(s.config).filter(([k]) => kept.has(k)));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ config, ...(s.repo ? { repo: s.repo } : {}) }, null, 2)}\n`, {
    mode: 0o600,
  });
}
