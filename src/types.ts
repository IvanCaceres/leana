export type Route = 'read_files' | 'search_codebase' | 'write' | 'move_lines' | 'bash' | 'tasks' | 'finish' | 'ask_user';
export const editRoutes: readonly Route[] = ['write', 'move_lines'];
export interface Coverage { total: number; ranges: [number, number][] }
export type Phase = 'inspect' | 'implement' | 'verify';
export type Question = { type: 'noul'; instructions: string } |
  { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Answer = { type: 'noul'; noul: number } |
  { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;
export interface Task { id: string; description: string; status: 'pending' | 'done'; evidence: string }
export interface Entry { id: string; step: number; kind: string; text: string; artifact: string; relevance: number }
export interface Session {
  version: 1; root: string; objective: string; instructions: string; step: number;
  tasks: Task[]; focus: string | null; entries: Entry[]; lastCompact: number;
  phase: Phase; knownFiles: string[]; inspectionCount: number; lastError: string | null;
  lastRoute: Route | null; lastResultOk: boolean; lastWriteStale: boolean;
  status: 'running' | 'paused' | 'complete'; stopReason: string;
  writes: string[]; lastWriteStep: number; lastCheckStep: number;
  repetitions: Record<string, number>; coverage: Record<string, Coverage>;
}
export interface Config {
  baseUrl: string; model: string; contextWindow: number; maxTokens: number;
  workingTokens: number; safetyTokens: number; jevUrl: string; jevModel: string;
  routeProbability: number; routeMargin: number; compactProbability: number;
  completeProbability: number; compactCooldown: number; maxSteps: number;
  toolChars: number; commandTimeoutMs: number; allowWrite: boolean; allowBash: boolean;
}
export interface Message { role: 'system' | 'user'; content: string }
export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false;
  items?: JsonSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: string[];
};
export interface ToolResult { text: string; ok: boolean; changed?: string[]; check?: boolean; stale?: boolean }
export type Log = (type: string, data: unknown) => Promise<void>;
