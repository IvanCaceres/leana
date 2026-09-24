import type { Deliverable, Answers, Config, Coverage, Entry, Message, Questions, Route, Session, SourceEvidence } from './types.js';
import { editRoutes } from './types.js';
import { focusedEditSchema, schemas } from './schema.js';
import { referenceContext } from './references.js';
import { sourceFile } from './profiles.js';
// A tool's output kept from both ends: a runner's verdict is its last lines,
// a compiler's first diagnostics its first.
export function clipEnds(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.55); const tail = limit - head - 3;
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`;
}
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[…truncated; use a narrower read or query…]\n';
  const room = Math.max(0, limit - marker.length);
  return text.slice(0, Math.ceil(room * .7)) + marker + text.slice(-Math.floor(room * .3));
}
export const routeDescriptions: Record<Route, string> = {
  rewrite_file: 'Replace the whole content of an existing file: name its path and what the new content must be; the complete new content is then generated as code, with the current content in front of you. For any change larger than a few lines, and for any file you would otherwise rewrite through replace_lines.',
  plan: 'Replace your running notes: the plan, what is done, what is known, what is next.',
  render: 'See what the user will see: start the app\'s server, load a page in a headless browser, and get the facts (exceptions, failed requests, broken images, console messages, overflow, how the page is styled, headings, text). The build cannot tell you any of this.',
  read_files: 'Read a requirements document, an uninspected file, or an exact source range already located by search or diagnostics; retrieve a stored artifact from @artifact/name. To locate named declarations in an already-read large source file, choose search_codebase instead of rereading its beginning or paging through it.',
  search_codebase: 'Locate files, definitions, references or tests using a text query or file listing; text matches return file:line, which is the one-step way to find where a symbol is defined in a large file before reading that range. Search path @artifacts for archived evidence.',
  create_file: 'Create a file that does not exist yet: name its path and purpose here; its complete content is then generated as code in a separate step.',
  write: 'Replace one short anchor with new text in an already-read existing file; never for blocks or moves, which replace_lines and move_lines do by line number without retyping, and never to create a file (create_file does that).',
  replace_lines: 'For small, local edits only: newText is part of this JSON reply and the whole reply is limited in length, so a large replacement is cut off and lost; use rewrite_file for anything larger. Replace, delete or prefix up to 40 line ranges of an already-read file in one step, addressed by line numbers instead of exact anchors; the way to remove many unused-import lines at once, to export many declarations at once (prepend), or to rewrite a region.',
  move_lines: 'Cut a contiguous line range from an already-read file and append it, unchanged, to another file (created when it does not exist), without retyping it.',
  bash: 'Run a shell command, including tests, builds or diagnostics, with explicit execution permission.',
  finish: 'Report completion when the objective is met and the supplied evidence supports completion.',
  ask_user: 'Pause because essential user information or a permission is missing; no other action fits.',
};
// The full repository listing does not fit a small working context; rank paths
// by how many of their segments the objective, ledger and edits mention, and
// summarize the rest as directories. search_codebase mode=files lists the rest.
export function relevantFiles(s: Session, limit = 80): string[] {
  const text = `${s.objective}\n${s.tasks.map(t => t.description).join('\n')}`.toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_.@\-]{3,}/g) ?? []);
  const score = (path: string): number => {
    const segments = path.toLowerCase().split('/');
    const base = segments.at(-1)!;
    return (text.includes(path.toLowerCase()) ? 100 : 0) + segments.filter(x => tokens.has(x)).length +
      (tokens.has(base.replace(/\.[^.]+$/, '')) ? 1 : 0);
  };
  const ranked = s.knownFiles.map(path => ({ path, score: score(path) })).filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit).map(f => f.path);
  return ranked.slice(0, limit);
}
export function repoOverview(s: Session, limit = 60): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of s.knownFiles) {
    const parts = path.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : '.';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit));
}
export function coverageSummary(s: Session, limit = 30): Record<string, string> {
  return Object.fromEntries(Object.entries(s.coverage).slice(-limit)
    .map(([path, c]) => [path, `read ${c.ranges.map(([a, b]) => `${a}-${b}`).join(',')} of ${c.total} lines`]));
}
export function mergeCoverage(c: Coverage | undefined, total: number, start: number, end: number): Coverage {
  const ranges = [...(c?.total === total ? c.ranges : []), [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]);
  }
  return { total, ranges: merged };
}
// Files edited after the last check: its line numbers no longer match them.
export function staleFor(s: Session): string[] {
  return s.lastCheck ? Object.entries(s.writeSteps).filter(([, step]) => step > s.lastCheck!.step).map(([path]) => path) : [];
}
// Bounded views of the volatile fields. Whatever the working budget, these must
// stay small: they sit after the evidence in the prompt, change every step and
// are therefore reprocessed by the server on every step.
export function compactRejected(s: Session, limit: number): { step: number; route: string; args: string; reason: string }[] {
  return s.rejectedEdits.slice(-limit).map(r => ({ step: r.step, route: r.route, args: clip(r.summary, 120), reason: clip(r.reason, 140) }));
}
export function compactSearched(s: Session, limit: number): Record<string, string> {
  return Object.fromEntries(Object.entries(s.searches).slice(-limit).map(([k, v]) => [clip(k, 80), clip(v, 100)]));
}
// Old checks and failed generation attempts are history, not current blockers.
// Keep their text unchanged for prompt caching, but retire their eviction priority.
// This also handles checkpoints written before entries carried verification metadata.
export function retireEvidence(s: Session): void {
  for (const e of s.entries) {
    let verification = e.verification;
    if (verification === undefined && e.kind === 'bash' && s.lastCheckCommand) {
      const command = e.text.match(/^\{"command":("(?:[^"\\]|\\.)*")/);
      if (command) { try { verification = JSON.parse(command[1]!) === s.lastCheckCommand; } catch { /* incomplete legacy entry */ } }
    }
    const supersededCheck = verification && s.lastCheck && e.step < s.lastCheck.step;
    const historicalAttempt = e.kind === 'generation_error' && e.step < Math.max(s.lastWriteStep, s.lastCheck?.step ?? -1);
    if (!e.stale && (supersededCheck || historicalAttempt)) {
      e.stale = supersededCheck ? `superseded by verification at step ${s.lastCheck!.step}` : 'historical generation attempt; later edits or verification have run';
      e.relevance = .1;
    }
  }
}
export function rememberEdit(s: Session, step: number, route: string, paths: string[], artifact: string, text: string, args?: Record<string, any>): void {
  const applied = args ? clip(JSON.stringify({ ...args, expectedHash: undefined, destinationHash: undefined }), 700) : undefined;
  s.editEvidence.push({ step, route, paths, artifact, text: clip(text.replace(/sha256=\w+/g, 'sha256=[recorded in artifact]'), 400), applied });
  s.editEvidence = s.editEvidence.slice(-20);
}
export function confidentChoice(a: Answers[string] | undefined, c: Config): string | null {
  if (a?.type !== 'choice') return null;
  const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const [top, p] = ranked[0]!;
  // Compare with a tolerance: 0.41 - 0.40 must count as a 0.01 margin.
  return p >= c.routeProbability - 1e-9 && p - (ranked[1]?.[1] ?? 0) >= c.routeMargin - 1e-9 ? top : null;
}
export function evictOne(s: Session): Entry | undefined {
  retireEvidence(s);
  // Preserve the freshest result until all older candidates have been evicted.
  const candidates = s.entries.length > 1 ? s.entries.slice(0, -1) : s.entries;
  // Stale entries go first, then the least relevant, then the oldest.
  const candidate = [...candidates].sort((a, b) => Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || a.relevance - b.relevance || a.step - b.step)[0];
  if (candidate) s.entries = s.entries.filter(e => e.id !== candidate.id);
  return candidate;
}
const details: Record<Route, string> = {
  rewrite_file: 'path is an existing file; purpose says what the new version must contain and change. Never put file content in the arguments: it is generated next, as code, from the current content, your thought and purpose.',
  render: 'serve is the shell command that starts the server for the page (for example a dev or preview script, with a fixed port and no browser opening); it runs in the repository root and is stopped after the render; pass "" when a server is already running. url is the page to load. Do this for every user-facing change before finishing: a build that passes says nothing about what renders.',
  plan: 'notes is the whole of your notes, replaced: a short plan with what is done, what you have learned (versions, commands that work, decisions), and what comes next. Keep it under forty lines.',
  read_files: 'When verification.files names lines in the file being fixed, read around those lines rather than from line 1. Use exact regular repository-relative file paths; globs, directories, and wildcard paths are invalid. Use 1-based inclusive start/end; at most 250 lines per file (end <= start+249). For a file longer than 250 lines, locate the definition with search_codebase first and read only that range; readCoverage shows what was already read, and reading it again yields nothing new. Output is cut at line boundaries within a character budget shared across the requested files and reports the last line shown; continue from the next line in a later read. Use @artifact/NAME to retrieve prior outputs. Read before editing.',
  search_codebase: 'Use a narrow literal query or mode files. Text matches are returned as path:line:text, so a query such as "const DEFAULT_DEPENDENCIES" gives the exact line to read next. searched lists every query already run and what it found; never repeat one, search for the next symbol the objective still needs. The path is a repository-relative directory, usually "."; use "@artifacts" to search archived tool outputs. Do not use search results as read_files paths unless they are exact regular files.',
  replace_lines: 'Each edit is { start, end, newText, prepend }. To insert lines without replacing any, use end = start - 1: the newText is inserted before line start (start = totalLines + 1 appends); this is how imports are added, never by retyping an existing line. With prepend non-empty (for example "export ") every line in start..end keeps its text and gets that prefix; newText must be "" and nothing is retyped. This is how declarations are exported: one edit per declaration line, all in one call. With prepend "", the range is replaced by newText ("" deletes it). Edits that would leave the file unparseable are refused with the parser message. An error at a line means that line needs fixing in place: a missing import is added at the top of the file, never by overwriting the line that uses the name. The file must have been read since it last changed: expectedHash must equal the sha256 of that read. edits is a list of up to 40 non-overlapping ranges {start, end, newText} (1-based, inclusive) of path, all numbered as in that read, never from a check that ran before the latest edit of the file (compare verification.step with the steps in editEvidence); the harness applies them bottom-up so they never shift each other. expectedHash comes from fileHashes. newText may be empty to delete the lines. Only new text is generated, so this is the way to remove many unused import lines in one step (one edit per reported line) or rewrite a region. After it runs, line numbers below the first edit have shifted: re-read before addressing them.',
  move_lines: 'Cut lines start..end (1-based, inclusive, at most 2000) from source and append them unchanged to the end of destination; take the numbers from read_files or search_codebase. expectedHash is the current source sha256 from fileHashes; destinationHash is the destination sha256 from fileHashes, or "new" only when the destination does not exist yet. Nothing else is changed in either file: whatever the moved lines need in their new place (imports, exports, references) is yours to add with an edit.',
  create_file: 'path is the repository-relative path of a file that does not exist yet (never an existing file: those are edited with write or replace_lines); purpose says in one sentence what the file must contain. The content itself is not written here: the harness asks for it as code in the next generation.',
  write: 'For a short anchor only (a few lines) in a file that exists: for a region of many lines use replace_lines, and to relocate a block use move_lines. expectedHash must be the current sha256 of the path from fileHashes (the same value the latest read_files or edit result reported). oldText is a small unique anchor (a few consecutive lines) copied exactly from that read; never paste a truncated excerpt or an entire file. newText replaces the anchor and must differ from it. Never overwrite an unread file; a new file is made with create_file.',
  bash: 'check is true only when this command is the verification of the work (a build, a type check, a test run): from then on it is the check of record, and running that same command again is a check too; false for installs, scaffolds, inspections and everything else. The harness never runs the check by itself: run it after edits when you want them judged, and before finish, which is refused while an edit is newer than the last check. command runs with bash in the repository root (the harness already sets cwd; use repository-relative paths and do not cd into a subdirectory or to /workspace). Explain its purpose. Use it for diagnostics too. Do not start background processes or servers.',
  finish: 'summary reports the final code structure, the verification from verification, and limitations concisely. While a check command exists and verificationAfterLastWrite is false, finish is refused: run the check first. The evidence gate reads the changed files as they are now, the diff and the last render; editEvidence holds historical actions only. Missing history proves neither that a requested procedure was followed nor that it was skipped. Do not infer a procedural violation from absent records. Report only what the evidence establishes.',
  ask_user: 'Ask one concise question that explains the missing information.',
};
export const language = (path: string): string => ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', css: 'css', scss: 'scss', html: 'html', md: 'md', yml: 'yaml', yaml: 'yaml', toml: 'toml', py: 'python', rs: 'rust', go: 'go', sh: 'bash' } as Record<string, string>)[path.split('.').pop() ?? ''] ?? '';
// The fence for a file's code block: four backticks for documents that may
// themselves contain fenced blocks, so the closing fence is unambiguous.
export const fenceFor = (path: string): string => /\.(md|mdx|markdown)$/i.test(path) ? '````' + language(path) : '```' + language(path);
// What a file to create may rely on: for each dependency, the path to import
// it from and its exported surface (parsed from the file when it exists, from
// the design when it is still planned), and who will import this file.
export interface FileContract { path: string; importPath: string; status: 'exists' | 'planned'; exports: string[] }
// A rewritten region that repeats the context lines shown around it is trimmed
// to the region: the worker's intent is unambiguous, so the output is repaired.
export function trimContext(output: string, before: string, after: string): string {
  let lines = output.replace(/\n$/, '').split('\n');
  const b = before ? before.split('\n') : []; const a = after ? after.split('\n') : [];
  // A single matching line of brackets or a few characters is ambiguous (the
  // region's own closing brace looks like the context's): only a run of two or
  // more lines, or one substantive line, is taken as repeated context.
  const substantive = (l: string) => l.trim().replace(/[{}()[\];,]/g, '').length >= 8;
  for (let n = Math.min(b.length, lines.length - 1); n > 0; n--) if (b.slice(-n).every((l, i) => l.trim() === lines[i]!.trim()) && (n >= 2 || substantive(lines[0]!))) { lines = lines.slice(n); break; }
  for (let n = Math.min(a.length, lines.length - 1); n > 0; n--) if (a.slice(0, n).every((l, i) => l.trim() === lines[lines.length - n + i]!.trim()) && (n >= 2 || substantive(lines[lines.length - 1]!))) { lines = lines.slice(0, lines.length - n); break; }
  return `${lines.join('\n')}\n`;
}
// Every field of the prompt merged into one object, for inspection and tests.
export function promptFields(prompt: Message[]): Record<string, any> {
  const out: Record<string, any> = {}; const evidence: unknown[] = [];
  for (const m of prompt.slice(1)) {
    let parsed: any; try { parsed = JSON.parse(m.content); } catch { continue; }
    if (parsed && typeof parsed === 'object' && 'evidence' in parsed && Object.keys(parsed).length === 1) evidence.push(parsed.evidence);
    else Object.assign(out, parsed);
  }
  out.evidence = evidence;
  return out;
}

// ---------------------------------------------------------------------------
// The orient-reason-act loop's prompts. One system message, one pinned block
// (objective, instructions, orientation), the evidence entries one per
// message, and a last message stating the request: reason and name an action,
// or produce the arguments of the action just chosen, or write a file.
export const AGENT_SYSTEM = 'You are Bonsai, a coding agent working in a repository through tools. Each step you reason briefly about the objective, what you know and what you just observed, then take exactly one action. You decide what to read, what to run (scaffolders, package managers, checks), what to write and in what order; the harness executes your action, verifies what it can, and shows you what happened. Prefer acting on facts you have over reading what is already shown. Keep your notes current with the plan action.';
export function orientationBlock(s: Session, allowed?: string[]): Record<string, unknown> {
  return { objective: s.objective, repositoryInstructions: s.instructions || undefined, orientation: s.orientation ?? undefined,
    ...(allowed ? { actions: Object.fromEntries(allowed.map(a => [a, { description: routeDescriptions[a as Route], instructions: details[a as Route], argumentSchema: schemas[a as Route] }])) } : {}) };
}
export function agentRequestBase(s: Session): Record<string, unknown> {
  const staleEvidence = Object.fromEntries(s.entries.filter(e => e.stale).map(e => [e.id, e.stale]));
  return {
    changedFiles: s.writes.slice(-30), fileCount: s.knownFiles.length, staleEvidence,
    ...(s.referenceEvidence.length ? { referenceEvidence: referenceContext(s, 3000) } : {}),
    ...(s.completionFeedback && !s.completionFeedback.addressed ? { completionFeedback: s.completionFeedback.text } : {}),
    editEvidence: s.editEvidence.slice(-4).map(e => ({ step: e.step, route: e.route, paths: e.paths, applied: e.applied ? clip(e.applied, 160) : undefined })),
    readCoverage: coverageSummary(s, 12), searched: compactSearched(s, 8), fileHashes: Object.fromEntries(Object.entries(s.hashes).slice(-12)),
    rejectedEdits: compactRejected(s, 3),
    lastError: s.lastError && clip(s.lastError, 700),
  };
}
// Message boundaries are cache checkpoints: the notes change rarely, the
// file list changes when files are created, the check state changes when the
// check runs; each sits in its own message so a step re-processes only what
// changed after the last unchanged boundary.
export function verificationBlock(s: Session): Record<string, unknown> {
  return { verification: s.lastCheck ? { command: s.lastCheck.command ?? s.lastCheckCommand, step: s.lastCheck.step, ok: s.lastCheck.ok, exitCode: s.lastCheck.summary.code, files: Object.fromEntries(Object.entries(s.lastCheck.summary.files).slice(0, 8)), output: clipEnds(s.lastCheck.text, 1200) } : { command: s.lastCheckCommand, step: null, ok: null } };
}
// The prompt is ordered by how often each part changes, because the server
// reuses its cache only up to the first changed message: the system message and
// the orientation never change in a session; the evidence is append-only (an
// entry is removed only by a batched eviction); the notes, the file list, the
// check state and the request change every turn and come last. Every call, a
// reasoning turn or a file generation, shares this prefix.
export function agentAllowed(s: Session): string[] | undefined { return s.allowedActions; }
function agentPrefix(s: Session): Message[] {
  return [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: JSON.stringify(orientationBlock(s, s.allowedActions)) },
    ...s.entries.map(e => ({ role: 'user' as const, content: JSON.stringify({ evidence: { id: e.id, kind: e.kind, artifact: e.artifact, text: e.text } }) })),
  ];
}
function volatile(s: Session): Message[] {
  return [{ role: 'user', content: JSON.stringify({ notes: s.notes ?? '', files: relevantFiles(s, 40), ...verificationBlock(s) }) }];
}
export function stepMessages(s: Session, allowed: string[], note?: string): Message[] {
  const request = { role: 'Reason, then act. Write thought: two to five sentences on where the work stands given the objective, your notes and the latest evidence, and what to do next and why. Then actions: an ordered list of one to eight actions (each an action name from allowedActions with its args under that action\'s schema; descriptions, instructions and schemas are in the pinned block under actions). The harness runs them in order and stops at the first failure, so batch what follows from your reasoning (several files to create, an edit and its check, a check and a render) and put a check or a render last; keep to one action when its result decides what comes next.',
    ...agentRequestBase(s), allowedActions: allowed, ...(note ? { harnessNote: note } : {}) };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify({ ...request, verificationAfterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep) }) }];
}
// A new file, written as code: the worker's purpose and thought, the real
// exported signatures of the repository modules it names, and the packages
// the manifest declares, so nothing is invented.
export function newFileMessages(s: Session, path: string, purpose: string, thought: string, contracts: FileContract[], declared: string[], shrink = 0, current?: string): Message[] {
  const request = {
    role: current === undefined ? `Write the complete file ${path} as code. The harness has opened the code block; write only the file content and close the block.` : `Rewrite the complete file ${path} as code: its whole new content, keeping what should stay and changing what purpose asks. The harness has opened the code block; write only the file content and close the block.`,
    file: path, purpose, thought, ...(current !== undefined ? { currentContent: shrink ? clip(current, 6000) : current } : {}),
    modules: contracts.slice(0, shrink ? 4 : 12).map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60),
    rules: [`Write the complete content of ${path}: working code with no placeholders, TODOs or omitted sections.`, 'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.', 'Write the file content only, then the closing fence; no explanation before or after it.'],
  };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify(request) }];
}
