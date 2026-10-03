import { readFile } from 'node:fs/promises';
import type { Config } from './types.js';
export const defaults: Config = {
  baseUrl: 'http://127.0.0.1:8080/v1', model: 'bonsai-27b', contextWindow: 48000,
  maxTokens: 4096, workingTokens: 12000, safetyTokens: 1024,
  jevUrl: 'https://api.typesafe.ai/v1/systemone', jevModel: 'jev-latest',
  routeProbability: .55, routeMargin: .12, compactProbability: .75, completeProbability: .9,
  compactCooldown: 4, maxSteps: 80, toolChars: 6000, commandTimeoutMs: 60000,
  allowWrite: false, allowBash: false, verbose: false, checkCommand: '',
  createTokens: 12000,
  // The server's own min_p is 0.05, so these defaults change nothing it did before.
  stepTemperature: .2, stepMinP: .05, codeTemperature: .3, codeMinP: .05,
  // PrismML's thinking-mode sampling for Bonsai 2 (the GGUF's general.sampling, its docs and demo scripts):
  // temperature 1.0, top_p 0.95, top_k 20, min_p 0.05; every published Bonsai score was measured with it, and
  // PrismML warns that mixing thinking and instruct settings degrades output. Code keeps its own (top_p 0.9).
  stepThinkingTemperature: 1, stepTopP: .95, stepTopK: 20, codeTopP: .9, codeTopK: 20,
  // Only after turns that changed nothing. The server applies temperature after top_k,
  // top_p and min_p, so a higher value reweights the same candidate tokens, never adds one.
  stepTemperatureEscalation: [.5, .8, 1],
  // Thinking costs generation time only (about 27 ms a token; it is never reused from the cache, the next
  // prompt holding the turn without it): 1024 tokens is at most about 28 s a step.
  stepThinking: true, stepThinkingBudget: 1024,
};
export async function loadConfig(path?: string, overrides: Partial<Config> = {}): Promise<Config> {
  const input = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const c = { ...defaults, ...input, ...overrides } as Config;
  for (const [key, value] of Object.entries(c)) {
    const expected = defaults[key as keyof Config];
    if (expected === undefined || typeof value !== typeof expected) throw new Error(`Invalid config: ${key}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new Error(`Invalid number: ${key}`);
  }
  for (const k of ['routeProbability', 'routeMargin', 'compactProbability', 'completeProbability'] as const)
    if (c[k] >= 1) throw new Error(`${k} must be between 0 and 1`);
  for (const k of ['contextWindow', 'maxTokens', 'workingTokens', 'safetyTokens', 'compactCooldown', 'maxSteps', 'toolChars', 'commandTimeoutMs', 'createTokens'] as const)
    if (!Number.isSafeInteger(c[k])) throw new Error(`${k} must be an integer`);
  if (c.workingTokens < 2000 || c.workingTokens > c.contextWindow - c.maxTokens - c.safetyTokens)
    throw new Error('workingTokens must fit inside contextWindow minus output and safety reserves');
  // A long generation is continued in chunks; its whole output plus the largest
  // allowed prompt must still fit the window, or a continuation is cut short.
  for (const k of ['createTokens'] as const)
    if (c[k] < c.maxTokens || c[k] > c.contextWindow - c.workingTokens - c.safetyTokens) throw new Error(`${k} must be between maxTokens and contextWindow minus workingTokens and the safety reserve`);
  for (const k of ['stepTopP', 'codeTopP'] as const) if (c[k] > 1) throw new Error(`${k} must be above 0 and at most 1`);
  for (const k of ['stepTopK', 'codeTopK'] as const) if (!Number.isSafeInteger(c[k])) throw new Error(`${k} must be an integer`);
  for (const k of ['stepTemperature', 'stepThinkingTemperature', 'codeTemperature'] as const) if (c[k] > 2) throw new Error(`${k} must be above 0 and at most 2`);
  for (const k of ['stepMinP', 'codeMinP'] as const) if (c[k] >= 1) throw new Error(`${k} must be between 0 and 1`);
  if (!Array.isArray(c.stepTemperatureEscalation) || c.stepTemperatureEscalation.length > 8 || c.stepTemperatureEscalation.some(t => typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 2))
    throw new Error('stepTemperatureEscalation must be a list of at most 8 temperatures, each above 0 and at most 2');
  if (!Number.isSafeInteger(c.stepThinkingBudget) || c.stepThinkingBudget >= c.maxTokens - 256) throw new Error('stepThinkingBudget must be an integer below maxTokens - 256 (the reply follows the thinking in the same output budget)');
  if (c.toolChars < 500 || c.toolChars > 20000) throw new Error('toolChars must be 500..20000');
  for (const key of ['baseUrl', 'jevUrl'] as const) {
    const u = new URL(c[key]);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(`Invalid ${key}`);
  }
  return c;
}
