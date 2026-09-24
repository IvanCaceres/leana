export type Route = 'read_files' | 'search_codebase' | 'create_file' | 'write' | 'replace_lines' | 'move_lines' | 'bash' | 'tasks' | 'plan' | 'render' | 'finish' | 'ask_user';
// One tool, one meaning: create_file creates, write replaces an anchor in an
// existing file, replace_lines edits by line number, move_lines relocates.
export const editRoutes: readonly Route[] = ['create_file', 'write', 'replace_lines', 'move_lines'];
export interface Coverage { total: number; ranges: [number, number][] }
// samples are short heads for decision state; diagnostics are the complete
// messages with their continuation lines, for a repair prompt.
export interface CheckSummary { errors: number; syntax: number; resolution?: number; byFile: Record<string, { count: number; syntax: number; resolution?: number; lines: number[]; samples: string[]; diagnostics?: string[] }> }
export interface CheckRecord { step: number; ok: boolean; text: string; summary: CheckSummary; fileHashes?: Record<string, string>; command?: string }
export interface SourceEvidence { path: string; hash?: string; facts: Record<string, unknown>[]; excerpt?: string; error?: string; omitted?: number }
export type DeliverableKind = 'move' | 'create' | 'modify' | 'delete' | 'export' | 'import' | 'verify' | 'other';
// exports and dependsOn are the design's contract for a file to create: what it
// provides, and which other deliverables it imports, so creation can be ordered
// and every prompt can carry the exact signatures a file may import. A derived
// item was added by the harness for an import a generated file made.
export interface Deliverable { packages?: string[]; command?: string; commandProbed?: boolean; id: string; kind: DeliverableKind; name?: string; from?: string; to?: string; detail: string; required: number; status: 'pending' | 'done' | 'unknown'; note?: string; unresolvable?: boolean; optional?: boolean; contents?: string[]; exports?: string[]; dependsOn?: string[]; derived?: boolean; attempts?: number; importer?: string; spec?: string; setAside?: boolean; placement?: string }
export interface NameOrigin { name: string; inFile: string; importLine?: string; importedBy?: string; declaredIn?: string; exported?: boolean; note?: string; kind?: 'unused' | 'move' | 'reexport' | 'alias' | 'respec'; line?: number; move?: { source: string; start: number; end: number } }
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
  // Tool-observed excerpts of documents explicitly referenced by the objective.
  referenceEvidence: { path: string; hash: string; text: string; scope?: string }[];
  // unmet: the deliverables the audit did not accept; unmetPending: those of
  // them that were pending by source facts at the time, the only ones whose
  // later completion by facts answers the rejection without an edit.
  completionFeedback: { step: number; text: string; awaitingEvidence: boolean; addressed?: boolean; unmet?: string[]; unmetPending?: string[] } | null;
  // The passing check for which the harness already proposed a finish; one attempt per check.
  finishTriedAtCheck: number;
  // Coverage per content hash, so a rollback to known content restores read state.
  coverageByHash: Record<string, Coverage>; repetitionSteps: Record<string, number>;
  // Harness-fetched context and harness-applied fixes, once per failing check.
  focusReadAt: number; autoFixKeys: Record<string, string>;
  missingNames: NameOrigin[];
  // Edits of the current transaction (since the last check), and edits that a
  // rollback rejected: those must never be generated again verbatim.
  transaction: { key: string; identity: string; step: number; route: string; paths: string[]; summary: string; kind?: string }[];
  lastCheckCommand: string | null;
  // Harness-owned verification cycle: a check is due after every edit transaction,
  // and an objectively worse check rolls that transaction back without a vote.
  pendingCheck: boolean; autoUndo: { files: Record<string, string>; reason: string } | null;
  inspectionsSinceAction: number;
  rejectedEdits: { key: string; identity: string; step: number; undoneAt: number; route: string; summary: string; reason: string }[];
  actions: Record<string, number>; searches: Record<string, string>; blockedRoute: Route | null;
  // The last tool error per edit route: the same error twice in a row blocks the route.
  lastToolError: { route: Route; message: string; step: number } | null;
  // The first successful move fixes the direction of the extraction; deliverables never travel back.
  moveDirection: { source: string; destination: string } | null;
  // Deliverables of kind move still declared in the source: performed by the harness.
  pendingMoves: { name: string; source: string; start: number; end: number; destination: string }[];
  // The harness's own deliverable list, classified by Jev; statuses come from source facts.
  ledger: Deliverable[]; ledgerAttempts: number; ledgerBuilt: boolean; ledgerComplete: number;
  // The worker's design for an open-ended objective: what the whole should be and the conventions every file follows.
  // composition: how the deliverables assemble into the whole; fixtures: the
  // literal data the result ships with, held in one module the others read.
  design: { summary: string; conventions: string; shared?: string; composition?: string; fixtures?: string } | null;
  // Verification selected from the repository when none is configured: attempts, the change count at the last one, and the configuration files' state at the last trial.
  checkInferences: number; checkInferredFor: number; checkTrialKey?: string;
  // Dependencies installed by the harness when a check trial showed them missing:
  // once per manifest version; a failed install is fix work for the manifest.
  setupDone: boolean; setupKey?: string; setupError?: string | null;
  // Git's view of the tree when the session began: changes already present are not the session's.
  baselineStatus: string[] | null;
  // The first pre-edit snapshot of each changed file, for the completion diff ('@new' for created files).
  baselineArtifacts: Record<string, string>;
  readHashes: Record<string, string>; writeSteps: Record<string, number>;
  editsSinceCheck: number;
  // Files the harness created that do not parse or miss a promised export:
  // repaired by a region rewrite before any model is asked to decide anything,
  // at most two attempts each.
  pendingRepairs: { path: string; errors: string[]; attempts: number }[];
  // Design candidates Jev judged out of scope, kept so an import of one of
  // them re-adds it with its design contents instead of a bare stub.
  droppedCandidates?: Deliverable[];
  // Failed region rewrites per file version: after three, the fix is not
  // offered again until the file changes.
  fixAttempts?: Record<string, number>;
  // File versions (content hashes) a check reported errors in: a rewrite that
  // reproduces one is known wrong and is refused before it lands.
  failedVersions?: Record<string, string[]>;
  // Every command run this session with its outcome: a verify deliverable that
  // names a command is done only when that command passed after the last edit.
  commandRuns?: Record<string, { step: number; ok: boolean }>;
  // Decided fixes that landed in a file without changing its diagnostics, in a
  // row: after three, the file's fix is not offered until its errors change.
  fixStalls?: Record<string, { signature: string; count: number }>;
  // Decided fixes generated per file over the whole session, landed or not:
  // a file that has had ten and still fails is set aside for the audit.
  fixTotals?: Record<string, number>;
  // Verification candidates whose trial could not start (their configuration
  // did not exist yet): the check is selected again once configuration changes.
  checkDeferred?: string[];
  // The orient-reason-act loop: the worker's running notes (its plan, revised
  // as it learns), the orientation facts gathered by code at the start, its
  // last stated reasoning, the watchdog's readings, and action keys Jev found
  // repeating a failure, which are refused once.
  notes?: string; orientation?: Record<string, unknown>; lastThought?: string;
  watch?: { noProgress: number; readings: { step: number; progress: number; stuck: number; sameFailure: number; objective: number; needsUser: number; inScope?: number }[]; escalations: number };
  blockedActions?: string[];
  // The last render of the running application: what the user would see, as facts.
  lastRender?: { step: number; ok: boolean; url: string; text: string };
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
  // Output budgets for the long generations: a file's content or a region
  // rewrite (continued across chunks) and the design, which may think first.
  createTokens: number;
}
export interface GenerationMeta { ms: number; usage?: any; timings?: any; finishReason?: string; promptTokens: number; continuations?: number }
export interface Message { role: 'system' | 'user'; content: string }
export type JsonSchema = {
  anyOf?: JsonSchema[]; const?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false;
  items?: JsonSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; enum?: string[];
};
export interface ToolResult { text: string; ok: boolean; changed?: string[]; check?: boolean; verification?: boolean; stale?: boolean; hashes?: Record<string, string>; snapshots?: Record<string, string>;
  // A created file reports what the parser found and what it imports, so the
  // harness can queue a repair and derive the deliverables its imports imply.
  parseErrors?: string[]; imports?: { spec: string; names: string[] }[] }
export type Log = (type: string, data: unknown) => Promise<void>;
