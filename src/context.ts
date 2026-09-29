import type { Deliverable, Answers, Config, Coverage, Entry, Message, Questions, Route, Session, SourceEvidence } from './types.js';
import { editRoutes } from './types.js';
import { focusedEditSchema, schemas } from './schema.js';
import { referenceContext } from './references.js';
import { sourceFile } from './profiles.js';
import { observerCatalog } from './observe-catalog.js';
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
  rewrite_file: 'Regenerate an existing file, or one block of it, as code: name its path and what must change. With start and end only lines start..end are generated anew and spliced in (end = start - 1 inserts before line start; start = totalLines + 1 appends), so adding or replacing a block costs only that block; without them the whole file is regenerated. The current content is in front of you either way. For any change larger than a few lines.',
  plan: 'Replace your running notes: the plan, what is done, what is known, what is next.',
  observe: `See the result as its user meets it, which no build, type check or test shows. ${observerCatalog.map(o => `kind ${o.kind}: ${o.what}.`).join(' ')}`,
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
    // A repeat's statement that a file is unchanged holds until the next write or check.
    const historicalAttempt = (e.kind === 'generation_error' || e.kind === 'repeat') && e.step < Math.max(s.lastWriteStep, s.lastCheck?.step ?? -1);
    // A check followed by edits describes files as they were: its errors may already be fixed.
    const editedAfter = verification && !supersededCheck ? Object.entries(s.writeSteps).filter(([, step]) => step > e.step).map(([p]) => p) : [];
    if (!e.stale && (supersededCheck || historicalAttempt || editedAfter.length)) {
      e.stale = supersededCheck ? `superseded by verification at step ${s.lastCheck!.step}` : editedAfter.length ? `files edited since this check (${editedAfter.slice(0, 6).join(', ')}): its errors describe them as they were` : e.kind === 'repeat' ? 'stated before later edits or verification ran' : 'historical generation attempt; later edits or verification have run';
      e.relevance = .1;
    }
  }
}
// The lines of a file the evidence shows as numbered text of the version with the given
// sha256 (any version when undefined: an archived output never changes): from every read
// result still in the prompt and not marked stale, each line with the entry that shows it.
// A line a clip cut into is not counted as shown.
export function shownLines(s: Session, path: string, sha: string | undefined): { total: number | null; by: Map<number, string> } {
  const by = new Map<number, string>(); let total: number | null = null;
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^${esc} sha256=(\\w+) totalLines=(\\d+) shown=(\\d+)\\.\\.(\\d+)$`);
  // clip() keeps a result's two ends around a marker line; the line each side of it is cut.
  const marker = '[…truncated; use a narrower read';
  for (const e of s.entries) {
    if (e.kind !== 'read_files' || e.stale) continue;
    const lines = e.text.split('\n'); let next = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const h = i === 0 || lines[i - 1] === '' ? line.match(header) : null;
      if (h) { next = sha === undefined || h[1] === sha ? Number(h[3]) : -1; if (next > 0) total = Number(h[2]); continue; }
      if (next < 0) continue;
      // After a clip marker the text may belong to another file of the same read: nothing is
      // credited until the next complete header.
      if (line.startsWith(marker)) { next = -1; continue; }
      const n = Number(line.match(/^(\d+): /)?.[1] ?? NaN);
      if (n !== next) { next = -1; continue; }
      if (!lines[i + 1]?.startsWith(marker)) by.set(n, e.id);
      next++;
    }
  }
  return { total, by };
}
// How many lines one text has that another does not, and the other way round: the lines a
// longest common subsequence leaves over, after the common first and last lines. Lines are
// compared without their endings (a CRLF line equals its LF copy). A middle too large to compare
// line by line counts whole, and exact is false (the counts are then upper bounds).
export function lineDiff(before: string, after: string): { removed: number; added: number; exact: boolean } {
  const split = (t: string) => t === '' ? [] : t.replace(/\r?\n$/, '').split('\n').map(l => l.replace(/\r$/, ''));
  const a = split(before); const b = split(after); let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf); const y = b.slice(pre, b.length - suf);
  if (!x.length || !y.length) return { removed: x.length, added: y.length, exact: true };
  if (x.length * y.length > 4_000_000) return { removed: x.length, added: y.length, exact: false };
  let row = new Array<number>(y.length + 1).fill(0);
  for (const line of x) { const next = new Array<number>(y.length + 1).fill(0); for (let j = 1; j <= y.length; j++) next[j] = line === y[j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!); row = next; }
  const common = row[y.length]!;
  return { removed: x.length - common, added: y.length - common, exact: true };
}
// Line numbers as ranges: [1, 2, 3, 7] -> [[1, 3], [7, 7]].
export function lineRanges(ns: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of [...ns].sort((a, b) => a - b)) { const last = out.at(-1); if (last && n === last[1] + 1) last[1] = n; else if (!last || n > last[1]) out.push([n, n]); }
  return out;
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
// A turn and its results are one group: reasoning without its outcome
// misleads, so a turn stays while any result of its batch remains and goes
// with the last of them, leaving one line in the trail. The running turn and
// the freshest entry are never evicted.
// from: only entries at that index or later are candidates, and none whose
// removal would add a line to the trail (the trail sits before the evidence):
// an eviction that stays behind a point the prompt already changes at costs
// no reprocessing of its own.
// only: the one entry that may be taken (for following a planned order).
// allowCited: over the hard budget, the entries the freshest entry names give way when nothing else can go.
export function evictOne(s: Session, from = 0, only?: string, allowCited = false): Entry | undefined {
  retireEvidence(s);
  const hasResults = (turn: Entry) => s.entries.some(e => e.turn === turn.id);
  // The freshest entry is never evicted, nor while it is the freshest the entries it names.
  // The entries it names give way when nothing else can go (their citing statement is then marked).
  let protectedIds = new Set([s.entries.at(-1)?.id, s.currentTurn ?? undefined, ...(s.entries.at(-1)?.cites ?? [])]);
  const endsTurn = (e: Entry) => e.kind === 'turn' || (e.turn !== undefined && s.entries.some(t => t.kind === 'turn' && t.id === e.turn) && !s.entries.some(x => x !== e && x.turn === e.turn));
  const pick = () => s.entries.filter((e, i) => (only === undefined || e.id === only) && i >= from && !(from > 0 && endsTurn(e)) && (s.entries.length === 1 || !protectedIds.has(e.id)) && !(e.kind === 'turn' && hasResults(e)));
  let candidates = pick();
  if (!candidates.length && allowCited && s.entries.at(-1)?.cites?.length) { protectedIds = new Set([s.entries.at(-1)?.id, s.currentTurn ?? undefined]); candidates = pick(); }
  // Stale entries go first, then the least relevant, then the oldest.
  const candidate = [...candidates].sort((a, b) => Number(Boolean(b.stale)) - Number(Boolean(a.stale)) || a.relevance - b.relevance || a.step - b.step)[0];
  if (!candidate) return undefined;
  s.entries = s.entries.filter(e => e !== candidate);
  // A repeat's answer that names the entry no longer describes the prompt: it is marked, not removed (nothing before it changes).
  for (const e of s.entries) if (e.kind === 'repeat' && !e.stale && e.cites?.includes(candidate.id)) { e.stale = `names ${candidate.id}, which has left the prompt`; e.relevance = .1; }
  const turn = candidate.kind === 'turn' ? candidate : s.entries.find(e => e.kind === 'turn' && e.id === candidate.turn);
  if (turn && !hasResults(turn) && turn.id !== s.currentTurn) { s.entries = s.entries.filter(e => e !== turn); s.trail = [...(s.trail ?? []), trailLine(turn)].sort((a, b) => Number(a.match(/^step (\d+)/)?.[1]) - Number(b.match(/^step (\d+)/)?.[1])).slice(-12); }
  return candidate;
}
// The entries the next batched eviction would take, in its order, down to target
// tokens: evictOne's own global order, run on a copy of the session.
export function plannedEviction(s: Session, target: number): string[] {
  const copy = structuredClone(s); const ids: string[] = [];
  while (evidenceTokens(copy) > target) { const e = evictOne(copy); if (!e) break; ids.push(e.id); }
  return ids;
}
// An eviction that rides on a change the prompt already makes at index at: it
// takes only the start of the planned order that lies behind that point, and
// stops at the first planned entry in front of it (or one whose removal would
// change the trail). So it removes exactly what the next eviction would remove
// first, never a fresh entry the planned order keeps, and never widens the change.
export function evictBehind(s: Session, at: number, target: number): Entry[] {
  const out: Entry[] = [];
  for (const id of plannedEviction(s, target)) {
    const i = s.entries.findIndex(e => e.id === id);
    if (i < 0) continue;
    if (i < at) break;
    const e = evictOne(s, at, id); if (!e) break;
    out.push(e);
  }
  return out;
}
// Generated content in a turn's arguments is on disk and in the results; the
// turn keeps what identifies the action (paths, commands, queries, ranges).
export function compactArgs(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 240 ? `${v.slice(0, 160)}… [${v.length} chars]` : v;
  if (Array.isArray(v)) return v.map(compactArgs);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'expectedHash' && k !== 'destinationHash').map(([k, x]) => [k, compactArgs(x)]));
  return v;
}
// The worker's reasoning and actions for a batch, exactly in the shape it
// generated them, recorded before the batch runs so that the prefix only grows.
export function turnEntry(step: number, thought: string, batch: { action: string; args: Record<string, any> }[]): Entry {
  return { id: `t${step}`, step, kind: 'turn', artifact: '', relevance: .5, outcomes: [],
    text: JSON.stringify({ thought: cut(thought, 600), actions: batch.map(b => ({ action: b.action, args: compactArgs(b.args) })) }) };
}
const cut = (text: string, n: number) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
function trailLine(turn: Entry): string {
  let actions: { action: string; args: Record<string, any> }[] = [];
  try { actions = JSON.parse(turn.text).actions ?? []; } catch { /* not a turn */ }
  const named = actions.map(a => { const x = a.args ?? {}; const what = x.path ?? x.command ?? x.query ?? x.url ?? x.source ?? (Array.isArray(x.files) ? x.files.map((f: any) => f.path).join(',') : ''); return `${a.action}${what ? ` ${cut(String(what), 70)}` : ''}`; });
  return cut(`step ${turn.step}: ${named.join('; ')} -> ${turn.outcomes?.length ? turn.outcomes.join('; ') : 'no result'}`, 240);
}
// The evidence's share of the prompt, estimated from its rendered length; the
// batched eviction is decided on it, the hard budget by the server's count.
// Where the prompt changed between two states of the session: the index of the
// first entry of before that is gone, 0 when the trail changed (it sits in
// front of the evidence), or null when nothing before the new entries changed.
export function breakIndex(before: { ids: string[]; trail: string[] }, s: Session): number | null {
  if ((s.trail ?? []).join('\n') !== before.trail.join('\n')) return 0;
  const now = new Set(s.entries.map(e => e.id));
  const i = before.ids.findIndex(id => !now.has(id));
  return i < 0 ? null : i;
}
export function evidenceTokens(s: Session): number {
  return Math.ceil(agentPrefix(s).slice(2).filter(m => !m.content.startsWith('{"earlierSteps"')).reduce((n, m) => n + m.content.length, 0) / 3.5);
}
const details: Record<Route, string> = {
  rewrite_file: 'path is an existing file; purpose says what the new content must contain and change. Its current content is put in front of you when the block or the file is generated, so there is no need to read it first to append to it or change it. start and end (optional, 1-based, inclusive, numbered as in the latest read or edit result of the file) limit the regeneration to that block: give them whenever most of the file stays as it is (appending rules, adding a component, replacing one function); omit them only when most of the file changes. Never put file content in the arguments: it is generated next, as code, from the current content, your thought and purpose.',
  observe: `kind is one of ${observerCatalog.map(o => o.kind).join(', ')}: whichever is how the objective's user meets the result. start is the shell command that starts what is observed and keeps running (a server on a fixed port with no browser opening, a service), stopped afterwards; "" when it already runs or nothing needs starting. target is what is observed: a URL, or the command to run with its arguments. Everything runs in the repository root.`,
  plan: 'notes is the whole of your notes, replaced: a short plan with what is done, what you have learned (versions, commands that work, decisions), and what comes next. Keep it under forty lines.',
  read_files: 'When verification.files names lines in the file being fixed, read around those lines rather than from line 1. Use exact regular repository-relative file paths; globs, directories, and wildcard paths are invalid. Use 1-based inclusive start/end; a read shows as many lines of the range as fit in the read budget (shared across the requested files; the result reports the last line shown), so a long file is read in a few large ranges, or located first with search_codebase and read around the definition; readCoverage shows what was already read, and reading it again yields nothing new. Output is cut at line boundaries within a character budget shared across the requested files and reports the last line shown; continue from the next line in a later read. Use @artifact/NAME to retrieve prior outputs. Read before editing.',
  search_codebase: 'Use a narrow literal query or mode files. Text matches are returned as path:line:text, so a query such as "const DEFAULT_DEPENDENCIES" gives the exact line to read next. searched lists every query already run and what it found; never repeat one, search for the next symbol the objective still needs. The path is a repository-relative directory, usually "."; use "@artifacts" to search archived tool outputs. Do not use search results as read_files paths unless they are exact regular files.',
  replace_lines: 'Each edit is { start, end, newText, prepend }. To insert lines without replacing any, use end = start - 1: the newText is inserted before line start (start = totalLines + 1 appends); this is how imports are added, never by retyping an existing line. With prepend non-empty (for example "export ") every line in start..end keeps its text and gets that prefix; newText must be "" and nothing is retyped. This is how declarations are exported: one edit per declaration line, all in one call. With prepend "", the range is replaced by newText ("" deletes it). Edits that would leave the file unparseable are refused with the parser message. An error at a line means that line needs fixing in place: a missing import is added at the top of the file, never by overwriting the line that uses the name. The file must have been read since it last changed: expectedHash must equal the sha256 of that read. edits is a list of up to 40 non-overlapping ranges {start, end, newText} (1-based, inclusive) of path, all numbered as in that read, never from a check that ran before the latest edit of the file (verification.writtenSince names the files edited after that check ran); the harness applies them bottom-up so they never shift each other. expectedHash comes from fileHashes. newText may be empty to delete the lines. Only new text is generated, so this is the way to remove many unused import lines in one step (one edit per reported line) or rewrite a region. After it runs, line numbers below the first edit have shifted: its result gives the new sha256 and the lines as they now read. Line numbers are always those of the text whose sha256 is expectedHash: a later edit of the same file in the same batch that carries the same hash is numbered as in that same text, and the harness maps its ranges through the batch\'s earlier edits (the result states old -> new ranges; a range an earlier edit changed is refused with the facts).',
  move_lines: 'Cut lines start..end (1-based, inclusive, at most 2000) from source and append them unchanged to the end of destination; take the numbers from read_files or search_codebase. expectedHash is the current source sha256 from fileHashes; destinationHash is the destination sha256 from fileHashes, or "new" only when the destination does not exist yet. Nothing else is changed in either file: whatever the moved lines need in their new place (imports, exports, references) is yours to add with an edit.',
  create_file: 'path is the repository-relative path of a file that does not exist yet (never an existing file: those are edited with write or replace_lines); purpose says in one sentence what the file must contain. The content itself is not written here: the harness asks for it as code in the next generation.',
  write: 'For a short anchor only (a few lines) in a file that exists: for a region of many lines use replace_lines, and to relocate a block use move_lines. expectedHash must be the current sha256 of the path from fileHashes (the same value the latest read_files or edit result reported). oldText is a small unique anchor (a few consecutive lines) copied exactly from that read; never paste a truncated excerpt or an entire file. newText replaces the anchor and must differ from it. Never overwrite an unread file; a new file is made with create_file.',
  bash: 'check is true only when this command is the verification of the work (a build, a type check, a test run): from then on it is the check of record, and running that same command again is a check too; false for installs, scaffolds, inspections and everything else. The harness never runs the check by itself: run it after edits when you want them judged, and before finish, which is refused while an edit is newer than the last check. command runs with bash in the repository root (the harness already sets cwd; use repository-relative paths and do not cd into a subdirectory or to /workspace). Explain its purpose. Use it for diagnostics too. A command that succeeded is not run again until something is written or installed, because its output is already in the evidence. Do not start background processes or servers.',
  finish: 'summary reports the final code structure, the verification from verification, and limitations concisely. While a check command exists and verificationAfterLastWrite is false, finish is refused: run the check first. The evidence gate reads the changed files as they are now, the diff and the last observation; your earlier turns show what was done. Missing history proves neither that a requested procedure was followed nor that it was skipped. Do not infer a procedural violation from absent records. Report only what the evidence establishes.',
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
// cut: the output was cut at a loop, so it may consist of nothing but echoed
// context (every one of its lines may be taken as repeated context).
export function trimContext(output: string, before: string, after: string, cut = false): string {
  let lines = output.replace(/\n$/, '').split('\n');
  const b = before ? before.split('\n') : []; const a = after ? after.split('\n') : [];
  // A single matching line of brackets or a few characters is ambiguous (the
  // region's own closing brace looks like the context's): only a run of two or
  // more lines, or one substantive line, is taken as repeated context.
  const substantive = (l: string) => l.trim().replace(/[{}()[\];,]/g, '').length >= 8;
  for (let n = Math.min(b.length, lines.length - (cut ? 0 : 1)); n > 0; n--) if (b.slice(-n).every((l, i) => l.trim() === lines[i]!.trim()) && (n >= 2 || substantive(lines[0]!))) { lines = lines.slice(n); break; }
  for (let n = Math.min(a.length, lines.length - 1); n > 0; n--) if (a.slice(0, n).every((l, i) => l.trim() === lines[lines.length - n + i]!.trim()) && (n >= 2 || substantive(lines[lines.length - 1]!))) { lines = lines.slice(0, lines.length - n); break; }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
// Every field of the prompt merged into one object, for inspection and tests.
export function promptFields(prompt: Message[]): Record<string, any> {
  const out: Record<string, any> = {}; const evidence: unknown[] = [];
  for (const m of prompt.slice(1)) {
    let parsed: any; try { parsed = JSON.parse(m.content); } catch { continue; }
    if (m.role === 'assistant') continue;
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
export const AGENT_SYSTEM = 'You are Bonsai, a coding agent working in a repository through tools. Each step you reason briefly about the objective, what you know and what you just observed, then name the actions to take. Your own earlier turns are the assistant messages, each followed by the results of its actions; steps whose evidence was dropped for room are summarised in earlierSteps. You decide what to read, what to run (scaffolders, package managers, checks), what to write and in what order; the harness executes your action, verifies what it can, and shows you what happened. Prefer acting on facts you have over reading what is already shown. Keep your notes current with the plan action.';
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
  // Files written after the check ran: its output describes them as they were, not as they are.
  const since = staleFor(s);
  const edited = (f: string) => since.some(w => w === f || w.endsWith(`/${f}`) || f.endsWith(`/${w}`));
  return { verification: s.lastCheck ? { command: s.lastCheck.command ?? s.lastCheckCommand, step: s.lastCheck.step, ok: s.lastCheck.ok, exitCode: s.lastCheck.summary.code, ...(since.length ? { writtenSince: since } : {}), files: Object.fromEntries(Object.entries(s.lastCheck.summary.files).filter(([f]) => !edited(f)).slice(0, 8)), ...(since.length ? { outputWithheld: `files were edited after this check ran (${since.join(', ')}); what it said about them no longer describes them, so it is not shown: run the check again to see them as they are` } : { output: clipEnds(s.lastCheck.text, 1200) }) } : { command: s.lastCheckCommand, step: null, ok: null } };
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
    // The trail changes only when evidence is evicted, which already reprocesses from the
    // oldest entry, so it sits before the evidence rather than being reprocessed every step.
    ...(s.trail?.length ? [{ role: 'user' as const, content: JSON.stringify({ earlierSteps: s.trail }) }] : []),
    ...s.entries.map(e => e.kind === 'turn' ? { role: 'assistant' as const, content: e.text } : { role: 'user' as const, content: JSON.stringify({ evidence: { id: e.id, kind: e.kind, artifact: e.artifact, text: e.text } }) }),
  ];
}
function volatile(s: Session): Message[] {
  return [{ role: 'user', content: JSON.stringify({ notes: s.notes ?? '', files: relevantFiles(s, 40), ...verificationBlock(s) }) }];
}
export function stepMessages(s: Session, allowed: string[], note?: string): Message[] {
  const request = { role: 'Reason, then act. Write thought: one to three sentences on what the latest evidence shows and what to do next and why; your notes and your earlier turns already record what is done, so do not list it again. Then actions: an ordered list of one to eight actions (each an action name from allowedActions with its args under that action\'s schema; descriptions, instructions and schemas are in the pinned block under actions). The harness runs them in order and stops at the first failure, so batch what follows from your reasoning (several files to create, an edit and its check, a check and an observation) and put a check or an observation last; keep to one action when its result decides what comes next.',
    ...agentRequestBase(s), allowedActions: allowed, ...(note ? { harnessNote: note } : {}) };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify({ ...request, verificationAfterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep) }) }];
}
// One block of an existing file, written as code: the block as it is now, the
// lines around it, and the whole file when it is small enough to read cheaply.
// Only the block is generated; the harness splices it in.
export function regionMessages(s: Session, path: string, purpose: string, current: string, start: number, end: number, contracts: FileContract[], declared: string[], shrink = 0, markup: Record<string, unknown> = {}): Message[] {
  const lines = (current.endsWith('\n') ? current.slice(0, -1) : current).split('\n');
  const total = current === '' ? 0 : lines.length; const window = shrink ? 20 : 40;
  const request = {
    role: `Write the new content for lines ${start}..${end} of ${path} as code: only those lines, which replace the ones in region (${end < start ? 'an insertion: region is empty' : `${end - start + 1} line(s)`}). Everything outside them stays as it is. The harness has opened the code block; write only the new lines and close the block.`,
    file: path, purpose, lines: `${start}..${end} of ${total}`,
    before: lines.slice(Math.max(0, start - 1 - window), start - 1).join('\n'), region: lines.slice(start - 1, end).join('\n'), after: lines.slice(end, end + window).join('\n'),
    // The whole file only when before, region and after do not already show all of it.
    ...(!shrink && current.length <= 16000 && !(start - 1 - window <= 0 && end + window >= total) ? { currentContent: current } : {}),
    modules: contracts.slice(0, shrink ? 4 : 12).map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60), ...markup,
    rules: [`Write only the new lines ${start}..${end} of ${path}: working code with no placeholders, and nothing from before or after (they stay in the file).`, 'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.', 'Write the lines only, then the closing fence; no explanation before or after them.'],
  };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify(request) }];
}
// A new file, written as code: the worker's purpose (its reasoning is the turn in the prefix), the real
// exported signatures of the repository modules it names, and the packages
// the manifest declares, so nothing is invented.
export function newFileMessages(s: Session, path: string, purpose: string, contracts: FileContract[], declared: string[], shrink = 0, current?: string, markup: Record<string, unknown> = {}): Message[] {
  const request = {
    role: current === undefined ? `Write the complete file ${path} as code. The harness has opened the code block; write only the file content and close the block.` : `Rewrite the complete file ${path} as code: its whole new content, keeping what should stay and changing what purpose asks. The harness has opened the code block; write only the file content and close the block.`,
    file: path, purpose, ...(current !== undefined ? { currentContent: shrink ? clip(current, 6000) : current } : {}),
    modules: contracts.slice(0, shrink ? 4 : 12).map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60), ...markup,
    rules: [`Write the complete content of ${path}: working code with no placeholders, TODOs or omitted sections.`, 'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.', 'Write the file content only, then the closing fence; no explanation before or after it.'],
  };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify(request) }];
}
