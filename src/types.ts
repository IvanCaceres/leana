export type Route = 'read_files' | 'search_codebase' | 'write' | 'replace_lines' | 'move_lines' | 'bash' | 'tasks' | 'finish' | 'ask_user';
export const editRoutes: readonly Route[] = ['write', 'replace_lines', 'move_lines'];
export interface Coverage { total: number; ranges: [number, number][] }
export interface CheckSummary { errors: number; syntax: number; byFile: Record<string, { count: number; syntax: number; lines: number[]; samples: string[] }> }
export interface CheckRecord { step: number; ok: boolean; text: string; summary: CheckSummary; fileHashes?: Record<string, string> }
export interface SourceEvidence { path: string; hash?: string; facts: Record<string, unknown>[]; excerpt?: string; error?: string; omitted?: number }
export interface NameOrigin { name: string; inFile: string; importLine?: string; importedBy?: string; declaredIn?: string; exported?: boolean; note?: string }
export type Phase = 'inspect' | 'implement' | 'verify';
export type Question = { type: 'noul'; instructions: string } |
  { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type Answer = { type: 'noul'; noul: number } |
  { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;
export interface Task { id: string; description: string; status: 'pending' | 'done'; evidence: string }
export interface Entry { id: string; step: number; kind: string; text: string; artifact: string; relevance: number; stale?: string; verification?: boolean }
export interface EditEvidence { step: number; route: string; paths: string[]; artifact: string; text: string; applied?: string }
export interface Session {
  version: 1; root: string; objective: string; instructions: string; step: number;
  tasks: Task[]; focus: string | null; entries: Entry[]; lastCompact: number;
  phase: Phase; knownFiles: string[]; inspectionCount: number; lastError: string | null;
  lastRoute: Route | null; lastResultOk: boolean; lastWriteStale: boolean;
  status: 'running' | 'paused' | 'complete'; stopReason: string;
  writes: string[]; lastWriteStep: number; lastCheckStep: number;
  repetitions: Record<string, number>; coverage: Record<string, Coverage>;
  hashes: Record<string, string>; lastPromptTokens: number;
  lastCheck: CheckRecord | null; previousCheck: CheckRecord | null;
  // Pre-edit snapshots of files edited since the previous check, and the set
  // offered for rollback once the next check has judged those edits.
  editSnapshots: Record<string, string>;
  // Tool-confirmed edits survive ordinary evidence eviction; undo removes them.
  editEvidence: EditEvidence[];
  // Coverage per content hash, so a rollback to known content restores read state.
  coverageByHash: Record<string, Coverage>; repetitionSteps: Record<string, number>;
  // Harness-fetched context and harness-applied fixes, once per failing check.
  focusReadAt: number; autoFixKeys: Record<string, string>;
  missingNames: NameOrigin[];
  // Edits of the current transaction (since the last check), and edits that a
  // rollback rejected: those must never be generated again verbatim.
  transaction: { key: string; identity: string; step: number; route: string; paths: string[]; summary: string }[];
  lastCheckCommand: string | null;
  // Harness-owned verification cycle: a check is due after every edit transaction,
  // and an objectively worse check rolls that transaction back without a vote.
  pendingCheck: boolean; autoUndo: { files: Record<string, string>; reason: string } | null;
  inspectionsSinceAction: number;
  rejectedEdits: { key: string; identity: string; step: number; undoneAt: number; route: string; summary: string; reason: string }[];
  actions: Record<string, number>; searches: Record<string, string>; blockedRoute: Route | null;
  readHashes: Record<string, string>; writeSteps: Record<string, number>;
  editsSinceCheck: number;
}
export interface Config {
  baseUrl: string; model: string; contextWindow: number; maxTokens: number;
  workingTokens: number; safetyTokens: number; jevUrl: string; jevModel: string;
  routeProbability: number; routeMargin: number; compactProbability: number;
  completeProbability: number; compactCooldown: number; maxSteps: number;
  toolChars: number; commandTimeoutMs: number; allowWrite: boolean; allowBash: boolean; verbose: boolean;
  // The verification command. When set, it is run as a baseline before any edit and
  // after every edit; only this command counts as verification.
  checkCommand: string;
}
export interface GenerationMeta { ms: number; usage?: any; timings?: any; finishReason?: string; promptTokens: number }
export interface Message { role: 'system' | 'user'; content: string }
export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false;
  items?: JsonSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: string[];
};
export interface ToolResult { text: string; ok: boolean; changed?: string[]; check?: boolean; verification?: boolean; stale?: boolean; hashes?: Record<string, string>; snapshots?: Record<string, string> }
export type Log = (type: string, data: unknown) => Promise<void>;
