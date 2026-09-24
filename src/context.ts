import type { Deliverable, Answers, Config, Coverage, Entry, Message, NameOrigin, Questions, Route, Session, SourceEvidence } from './types.js';
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
  plan: 'Replace your running notes: the plan, what is done, what is known, what is next.',
  render: 'See what the user will see: start the app\'s server, load a page in a headless browser, and get the facts (errors, failed requests, broken images, overflow, unstyled lists, headings, text). The build cannot tell you any of this.',
  read_files: 'Read a requirements document, an uninspected file, or an exact source range already located by search or diagnostics; retrieve a stored artifact from @artifact/name. To locate named declarations in an already-read large source file, choose search_codebase instead of rereading its beginning or paging through it.',
  search_codebase: 'Locate files, definitions, references or tests using a text query or file listing; text matches return file:line, which is the one-step way to find where a symbol is defined in a large file before reading that range. Search path @artifacts for archived evidence.',
  create_file: 'Create a file that does not exist yet: name its path and purpose here; its complete content is then generated as code in a separate step.',
  write: 'Replace one short anchor with new text in an already-read existing file; never for blocks, import lists, exports or moves, which replace_lines and move_lines do by line number without retyping, and never to create a file (create_file does that).',
  replace_lines: 'Replace, delete or prefix up to 40 line ranges of an already-read file in one step, addressed by line numbers instead of exact anchors; the way to remove many unused-import lines at once, to export many declarations at once (prepend), or to rewrite a region.',
  move_lines: 'Move a contiguous line range from an already-read file into another file without retyping it; the way to extract a large block into a new module.',
  bash: 'Run a shell command, including tests, builds or diagnostics, with explicit execution permission.',
  tasks: 'Create or update a concise task ledger; preserve existing unfinished work and evidence.',
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
// How the verification changed across the edits it judged, for the undo decision.
export function checkDelta(s: Session): string | null {
  if (!s.lastCheck || !s.previousCheck) return null;
  const files = [...new Set(s.transaction.flatMap(t => t.paths))];
  const before = s.previousCheck.summary; const after = s.lastCheck.summary;
  const per = files.map(f => {
    const key = (o: Record<string, unknown>) => Object.keys(o).find(k => k.endsWith(f) || f.endsWith(k));
    const a = key(after.byFile) ? after.byFile[key(after.byFile)!]! : null; const b = key(before.byFile) ? before.byFile[key(before.byFile)!]! : null;
    return `${f}: ${b ? `${b.count} errors (${b.syntax} syntax)` : 'no errors'} before, ${a ? `${a.count} errors (${a.syntax} syntax)` : 'no errors'} after${a?.samples.length ? `; now: ${a.samples[0]}` : ''}`;
  });
  return `Check at step ${s.previousCheck.step}: ${before.errors} errors (${before.syntax} syntax). Check at step ${s.lastCheck.step}${files.length ? `, after editing ${files.join(', ')}` : ''}: ${after.errors} errors (${after.syntax} syntax).${per.length ? ` ${per.join('. ')}` : ''}`;
}
// Bounded views of the volatile fields. Whatever the working budget, these must
// stay small: they sit after the evidence in the prompt, change every step and
// are therefore reprocessed by the server on every step.
export function focus(s: Session, files = 5): Record<string, { lines: number[]; sample: string }> | null {
  if (!s.lastCheck || s.lastCheck.ok) return null;
  // Files this session edits come first: errors cascading into other files are
  // consequences, not targets.
  const inScope = (f: string) => s.writes.some(w => w.endsWith(f) || f.endsWith(w));
  const ranked = Object.entries(s.lastCheck.summary.byFile).sort((a, b) => Number(inScope(b[0])) - Number(inScope(a[0])) || b[1].count - a[1].count);
  return Object.fromEntries(ranked.slice(0, files).map(([f, v]) => [f, { lines: v.lines.slice(0, 8), sample: clip(v.samples[0] ?? '', 110) }]));
}
// Grouped by the edit that fixes them: import lines to add per file, line
// numbers to export per file (one replace_lines call with prepend "export "
// per line), and names nothing resolved. Far smaller than one row per name.
export interface NameFixes { addImports: Record<string, string[]>; addExportAtLines: Record<string, number[]>; removeImports: Record<string, string[]>; removeImportLines: Record<string, Record<string, number>>; aliasImports: Record<string, { name: string; actual: string; line: number }[]>; respecImports: Record<string, { from: string; to: string; line: number }[]>; moveDeclarations: { name: string; source: string; start: number; end: number; into: string }[]; unresolved: string[]; total: number }
// Empty collections are noise in every prompt: only fixes that exist are pinned.
export function compactFixes(f: NameFixes): Partial<NameFixes> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null ? Object.keys(v).length > 0 : v !== 0)) as Partial<NameFixes>;
}
export function compactNames(s: Session, limit: number, names: NameOrigin[] = s.missingNames): NameFixes {
  const out: NameFixes = { addImports: {}, addExportAtLines: {}, removeImports: {}, removeImportLines: {}, aliasImports: {}, respecImports: {}, moveDeclarations: [], unresolved: [], total: names.length };
  for (const n of names.slice(0, limit)) {
    if (n.kind === 'move') {
      if (n.move && !out.moveDeclarations.some(m => m.source === n.move!.source && m.start === n.move!.start)) out.moveDeclarations.push({ name: n.name, source: n.move.source, start: n.move.start, end: n.move.end, into: n.inFile });
      else if (!n.move) out.unresolved.push(`${n.name}: ${clip(n.note ?? 'unresolved', 240)}`);
      continue;
    }
    if (n.kind === 'alias' && n.importLine && n.line) { (out.aliasImports[n.inFile] ??= []).push({ name: n.name, actual: n.importLine, line: n.line }); continue; }
    if (n.kind === 'respec' && n.importLine && n.line) { (out.respecImports[n.inFile] ??= []).push({ from: n.name, to: n.importLine, line: n.line }); continue; }
    if (n.kind === 'unused') { (out.removeImports[n.inFile] ??= []).push(n.name); if (n.line && /twice|conflicts|declared locally/.test(n.note ?? '')) (out.removeImportLines[n.inFile] ??= {})[n.name] = n.line; continue; }
    if (n.importLine) { const lines = out.addImports[n.inFile] ??= []; if (!lines.includes(n.importLine)) lines.push(n.importLine); }
    if (n.declaredIn && n.exported === false) {
      const [file, line] = n.declaredIn.split(':');
      if (file && line) (out.addExportAtLines[file] ??= []).push(Number(line));
      else out.unresolved.push(`${n.name}: ${clip(n.note ?? 'declaration line unknown', 240)}`);
    } else if (!n.importLine) out.unresolved.push(`${n.name}: ${clip(n.note ?? 'unresolved', 240)}`);
  }
  for (const k of Object.keys(out.addExportAtLines)) out.addExportAtLines[k] = [...new Set(out.addExportAtLines[k])].sort((a, b) => a - b);
  // Names nothing resolved are the least actionable; never let them dominate the prompt.
  if (out.unresolved.length > 8) out.unresolved = [...out.unresolved.slice(0, 8).map(u => clip(u, 70)), `+${out.unresolved.length - 8} more unresolved; re-run the check to refresh`];
  return out;
}
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
  render: 'serve is the shell command that starts the server for the page (for example a dev or preview script, with a fixed port and no browser opening); it runs in the repository root and is stopped after the render; pass "" when a server is already running. url is the page to load. Do this for every user-facing change before finishing: a build that passes says nothing about what renders.',
  plan: 'notes is the whole of your notes, replaced: a short plan with what is done, what you have learned (versions, commands that work, decisions), and what comes next. Keep it under forty lines.',
  read_files: 'When focus is present, read around the lines it names for the file being fixed rather than from line 1. Use exact regular repository-relative file paths; globs, directories, and wildcard paths are invalid. Use 1-based inclusive start/end; at most 250 lines per file (end <= start+249). For a file longer than 250 lines, locate the definition with search_codebase first and read only that range; readCoverage shows what was already read, and reading it again yields nothing new. Output is cut at line boundaries within a character budget shared across the requested files and reports the last line shown; continue from the next line in a later read. Use @artifact/NAME to retrieve prior outputs. Read before editing.',
  search_codebase: 'Use a narrow literal query or mode files. Text matches are returned as path:line:text, so a query such as "const DEFAULT_DEPENDENCIES" gives the exact line to read next. searched lists every query already run and what it found; never repeat one, search for the next symbol the objective still needs. The path is a repository-relative directory, usually "."; use "@artifacts" to search archived tool outputs. Do not use search results as read_files paths unless they are exact regular files.',
  replace_lines: 'Each edit is { start, end, newText, prepend }. To insert lines without replacing any, use end = start - 1: the newText is inserted before line start (start = totalLines + 1 appends); this is how imports are added, never by retyping an existing line. With prepend non-empty (for example "export ") every line in start..end keeps its text and gets that prefix; newText must be "" and nothing is retyped. This is how declarations are exported: one edit per declaration line, all in one call. With prepend "", the range is replaced by newText ("" deletes it). missingNames lists the fixes the harness resolved from the last check and applies itself (imports inserted after the import block, export prepended at the declaration lines); a fix still listed after that was refused or rolled back, so make it yourself with the insert form after the last import statement, or fix the declaration line the error names. Edits that would leave the file unparseable are refused with the parser message. An error at a line means that line needs fixing in place: a missing import is added at the top of the file, never by overwriting the line that uses the name. The file must have been read since it last changed: expectedHash must equal the sha256 of that read. edits is a list of up to 40 non-overlapping ranges {start, end, newText} (1-based, inclusive) of path, all numbered as in that read, never from a check that ran before an edit (see lastCheck.staleFor); the harness applies them bottom-up so they never shift each other. expectedHash comes from fileHashes. newText may be empty to delete the lines. Only new text is generated, so this is the way to remove many unused import lines in one step (one edit per reported line) or rewrite a region. After it runs, line numbers below the first edit have shifted: re-read before addressing them.',
  move_lines: 'Cut lines start..end (1-based, inclusive, at most 2000) from source and append them to destination without retyping them; take the numbers from read_files or search_codebase. expectedHash is the current source sha256 from fileHashes. destinationHash is the destination sha256 from fileHashes, or "new" only when the destination does not exist yet. If the range is refused as incomplete, the error names the exact start or end line to retry with. The harness completes the extraction itself: it adds export to the moved top-level declarations, copies the import lines the moved code uses from the source (paths re-based), and inserts the import the source still needs from the destination; leave replacement and prefix empty unless you need something beyond that. The result names any names the moved code uses that are declared in the source without export; those need an export there or a move of their own. The check runs automatically afterwards.',
  create_file: 'path is the repository-relative path of a file that does not exist yet (never an existing file: those are edited with write or replace_lines); purpose says in one sentence what the file must contain. The content itself is not written here: the harness asks for it as code in the next generation.',
  write: 'For a short anchor only (a few lines) in a file that exists: for a region of many lines use replace_lines, and to relocate a block use move_lines. expectedHash must be the current sha256 of the path from fileHashes (the same value the latest read_files or edit result reported). oldText is a small unique anchor (a few consecutive lines) copied exactly from that read; never paste a truncated excerpt or an entire file. newText replaces the anchor and must differ from it. Never overwrite an unread file; a new file is made with create_file.',
  bash: 'check is true only when this command is the verification of the work (a build, a type check, a test run): the harness re-runs the check after every edit and judges edits by it; false for installs, scaffolds, inspections and everything else. command runs with bash in the repository root (the harness already sets cwd; use repository-relative paths and do not cd into a subdirectory or to /workspace). Explain its purpose. Use it for diagnostics; the harness runs the verification command itself after every edit. Do not start background processes or servers.',
  tasks: 'Return the full task ledger, max 12 tasks. Preserve existing IDs and all unfinished work. Mark done only with concrete evidence from supplied tool results. Break complex work into bounded changes and verification.',
  finish: 'Report the final code structure from currentSource, verification from lastCheck, and limitations concisely. currentSource contains fresh filesystem facts; missing historical edit records do not mean that those declarations or imports are absent now. Use editEvidence for historical actions only. Missing history proves neither that a requested procedure was followed nor that it was skipped. Do not infer a procedural violation from absent records. Report only what the evidence establishes.',
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
    ...(s.missingNames.length ? { missingNames: compactFixes(compactNames(s, 40)) } : {}),
    rejectedEdits: compactRejected(s, 3),
    lastError: s.lastError && clip(s.lastError, 700),
  };
}
// Message boundaries are cache checkpoints: the notes change rarely, the
// file list changes when files are created, the check state changes when the
// check runs; each sits in its own message so a step re-processes only what
// changed after the last unchanged boundary.
export function verificationBlock(s: Session): Record<string, unknown> {
  return { verification: s.lastCheck ? { command: s.lastCheck.command ?? s.lastCheckCommand, step: s.lastCheck.step, ok: s.lastCheck.ok, errors: s.lastCheck.summary.errors, byFile: Object.fromEntries(Object.entries(s.lastCheck.summary.byFile).slice(0, 6).map(([f, v]) => [f, (v.diagnostics ?? v.samples).slice(0, 3).map(d => clip(d, 400))])) } : { command: s.lastCheckCommand, step: null, ok: null } };
}
function agentPrefix(s: Session, includeStale = true, allowed?: string[]): Message[] {
  return [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: JSON.stringify(orientationBlock(s, allowed)) },
    { role: 'user', content: JSON.stringify({ notes: s.notes ?? '' }) },
    { role: 'user', content: JSON.stringify({ files: relevantFiles(s, 40) }) },
    ...s.entries.filter(e => includeStale || !e.stale).map(e => ({ role: 'user' as const, content: JSON.stringify({ evidence: { id: e.id, kind: e.kind, artifact: e.artifact, text: e.text } }) })),
    { role: 'user', content: JSON.stringify(verificationBlock(s)) },
  ];
}
export function stepMessages(s: Session, allowed: string[], note?: string): Message[] {
  const request = { role: 'Reason, then act. Write thought: two to five sentences on where the work stands given the objective, your notes and the latest evidence, and what to do next and why. Then actions: an ordered list of one to eight actions (each an action name from allowedActions with its args under that action\'s schema; descriptions, instructions and schemas are in the pinned block under actions). The harness runs them in order and stops at the first failure, so batch what follows from your reasoning (several files to create, an edit and its check, a check and a render) and put a check or a render last; keep to one action when its result decides what comes next.',
    ...agentRequestBase(s), allowedActions: allowed, ...(note ? { harnessNote: note } : {}) };
  return [...agentPrefix(s, true, allowed), { role: 'user', content: JSON.stringify({ ...request, verificationAfterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep) }) }];
}
// A new file, written as code: the worker's purpose and thought, the real
// exported signatures of the repository modules it names, and the packages
// the manifest declares, so nothing is invented.
export function newFileMessages(s: Session, path: string, purpose: string, thought: string, contracts: FileContract[], declared: string[], shrink = 0): Message[] {
  const request = {
    role: `Write the complete file ${path} as code. The harness has opened the code block; write only the file content and close the block.`,
    file: path, purpose, thought, notes: clip(s.notes ?? '', shrink ? 600 : 2000),
    modules: contracts.slice(0, shrink ? 4 : 12).map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60),
    rules: [`Write the complete content of ${path}: working code with no placeholders, TODOs or omitted sections.`, 'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.', 'Write the file content only, then the closing fence; no explanation before or after it.'],
  };
  return [...agentPrefix(s, false), { role: 'user', content: JSON.stringify(request) }];
}
