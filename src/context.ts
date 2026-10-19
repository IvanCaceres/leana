import type {
  Deliverable,
  Answers,
  Config,
  Coverage,
  Entry,
  Message,
  Questions,
  Route,
  Session,
  SourceEvidence,
} from './types.js';
import { editRoutes } from './types.js';
import { focusedEditSchema, schemas, toolSchema } from './schema.js';
import { referenceContext } from './references.js';
import { classNamesIn, sourceFile } from './profiles.js';
import { observerCatalog } from './observe-catalog.js';
import { contentLines, echoOf, substantive, type Around, type Echo } from './clients.js';
// A tool's output kept from both ends: a runner's verdict is its last lines,
// a compiler's first diagnostics its first.
export function clipEnds(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.55);
  const tail = limit - head - 3;
  return `${text.slice(0, whole(text, head))}\n…\n${text.slice(whole(text, text.length - tail))}`;
}
const clipMarker = '\n[…truncated; use a narrower read or query…]\n';
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const room = Math.max(0, limit - clipMarker.length);
  return (
    text.slice(0, whole(text, Math.ceil(room * 0.7))) +
    clipMarker +
    text.slice(whole(text, text.length - Math.floor(room * 0.3)))
  );
}
// A cut at i moved back off the middle of a character written as two UTF-16 units (an emoji): either half alone is
// not Unicode text, and TypeSafe refuses a request holding one (HTTP 400). Run saas-landing-glm-5.3 trial 6 lost its
// finished run when the excerpt of src/data.ts its completion gate sent ended half way through an icon's emoji.
export const whole = (text: string, i: number): number =>
  i > 0 && i < text.length && /[\ud800-\udbff]/.test(text[i - 1]!) && /[\udc00-\udfff]/.test(text[i]!) ? i - 1 : i;
// The entry, newest first, that shows every part of text a clip kept (clipEnds and clip cut at
// their markers), as written or as the content of a JSON string (a command's output sits in its
// result's JSON). A tail field that restates it names the entry instead: the tail is processed
// again on every request, the entry once. When no entry shows every part the field stays: in runs
// 49-51 coloured output (6 JSON characters per escape) left the end of the check's entry short of
// the field's, and a refusal's entry keeps 600 characters where lastError keeps 700. An id two entries
// carry names neither: a command retried at its own step (a failure Jev reads as transient) leaves the failed
// run and the retry both as e<step> (run 60 step 43, npm run dev), and 3 lastErrors of runs 49-76 would have named such an id.
export function shownIn(entries: { id: string; kind?: string; text: string }[], text: string): string | undefined {
  const parts = text.split('\n…\n').flatMap(p => p.split(clipMarker));
  return [...entries]
    .reverse()
    .find(
      e =>
        e.kind !== 'turn' &&
        entries.filter(x => x.id === e.id).length === 1 &&
        parts.every(p => e.text.includes(p) || e.text.includes(JSON.stringify(p).slice(1, -1))),
    )?.id;
}
// What a tail field carries: where the prompt shows text, when saying so is the shorter (a check that prints "ok").
const named = (text: string, at: string | undefined): string => {
  const p = at === 'harnessNote' ? 'stated in harnessNote' : `shown in evidence ${at}`;
  return at && p.length < text.length ? p : text;
};
export const routeDescriptions: Record<Route, string> = {
  rewrite_file:
    'Regenerate an existing file, or one block of it, as code: name its path and what must change. With start and end only lines start..end are generated anew and spliced in (end = start - 1 inserts before line start; start = totalLines + 1 appends), so adding or replacing a block costs only that block; without them the whole file is regenerated. The current content is in front of you either way. For any change larger than a few lines.',
  plan: 'Replace your running notes: the plan, what is done, what is known, what is next.',
  observe: `See the result as its user meets it, which no build, type check or test shows. ${observerCatalog.map(o => `kind ${o.kind}: ${o.what}.`).join(' ')}`,
  read_files:
    'Read a requirements document, an uninspected file, or an exact source range already located by search or diagnostics; retrieve a stored artifact from @artifact/name. To locate named declarations in an already-read large source file, choose search_codebase instead of rereading its beginning or paging through it.',
  search_codebase:
    'Locate files, definitions, references or tests using a text query or file listing; text matches return file:line, which is the one-step way to find where a symbol is defined in a large file before reading that range. Search path @artifacts for archived evidence.',
  create_file:
    'Create a file that does not exist yet: name its path and purpose here; its complete content is then generated as code in a separate step.',
  write:
    'Replace one short anchor with new text in an already-read existing file; never for blocks or moves, which replace_lines and move_lines do by line number without retyping, and never to create a file (create_file does that).',
  replace_lines:
    'For small, local edits only: newText is part of this JSON reply and the whole reply is limited in length, so a large replacement is cut off and lost; use rewrite_file for anything larger. Replace, delete or prefix up to 40 line ranges of an already-read file in one step, addressed by line numbers instead of exact anchors; the way to remove many unused-import lines at once, to export many declarations at once (prepend), or to rewrite a region.',
  move_lines:
    'Cut a contiguous line range from an already-read file and append it, unchanged, to another file (created when it does not exist), without retyping it.',
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
    return (
      (text.includes(path.toLowerCase()) ? 100 : 0) +
      segments.filter(x => tokens.has(x)).length +
      (tokens.has(base.replace(/\.[^.]+$/, '')) ? 1 : 0)
    );
  };
  const ranked = s.knownFiles
    .map(path => ({ path, score: score(path) }))
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(f => f.path);
  return ranked.slice(0, limit);
}
export function repoOverview(s: Session, limit = 60): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of s.knownFiles) {
    const parts = path.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : '.';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit),
  );
}
export function coverageSummary(s: Session, limit = 30): Record<string, string> {
  return Object.fromEntries(
    Object.entries(s.coverage)
      .slice(-limit)
      .map(([path, c]) => [path, `read ${c.ranges.map(([a, b]) => `${a}-${b}`).join(',')} of ${c.total} lines`]),
  );
}
export function mergeCoverage(c: Coverage | undefined, total: number, start: number, end: number): Coverage {
  const ranges = [...(c?.total === total ? c.ranges : []), [start, end] as [number, number]].sort(
    (a, b) => a[0] - b[0],
  );
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { total, ranges: merged };
}
// Files edited after the last check: its line numbers no longer match them.
export function staleFor(s: Session): string[] {
  return s.lastCheck
    ? Object.entries(s.writeSteps)
        .filter(([, step]) => step > s.lastCheck!.step)
        .map(([path]) => path)
    : [];
}
// Bounded views of the volatile fields. Whatever the working budget, these must
// stay small: they sit after the evidence in the prompt, change every step and
// are therefore reprocessed by the server on every step.
export function compactRejected(
  s: Session,
  limit: number,
): { step: number; route: string; args: string; reason: string }[] {
  return s.rejectedEdits
    .slice(-limit)
    .map(r => ({ step: r.step, route: r.route, args: clip(r.summary, 120), reason: clip(r.reason, 140) }));
}
export function compactSearched(s: Session, limit: number): Record<string, string> {
  return Object.fromEntries(
    Object.entries(s.searches)
      .slice(-limit)
      .map(([k, v]) => [clip(k, 80), clip(v, 100)]),
  );
}
// Old checks and failed generation attempts are history, not current blockers.
// Keep their text unchanged for prompt caching, but mark them stale: evictOne takes them first
// unless they still hold something current (holdsCurrent).
// This also handles checkpoints written before entries carried verification metadata.
export function retireEvidence(s: Session): void {
  for (const e of s.entries) {
    let verification = e.verification;
    if (verification === undefined && e.kind === 'bash' && s.lastCheckCommand) {
      const command = e.text.match(/^\{"command":("(?:[^"\\]|\\.)*")/);
      if (command) {
        try {
          verification = JSON.parse(command[1]!) === s.lastCheckCommand;
        } catch {
          /* incomplete legacy entry */
        }
      }
    }
    const supersededCheck = verification && s.lastCheck && e.step < s.lastCheck.step;
    // A repeat's statement that a file is unchanged holds until the next write or check.
    const historicalAttempt =
      (e.kind === 'generation_error' || e.kind === 'repeat') &&
      e.step < Math.max(s.lastWriteStep, s.lastCheck?.step ?? -1);
    // A check followed by edits describes files as they were: its errors may already be fixed.
    const editedAfter =
      verification && !supersededCheck
        ? Object.entries(s.writeSteps)
            .filter(([, step]) => step > e.step)
            .map(([p]) => p)
        : [];
    if (!e.stale && (supersededCheck || historicalAttempt || editedAfter.length)) {
      e.stale = supersededCheck
        ? `superseded by verification at step ${s.lastCheck!.step}`
        : editedAfter.length
          ? `files edited since this check (${editedAfter.slice(0, 6).join(', ')}): its errors describe them as they were`
          : e.kind === 'repeat'
            ? 'stated before later edits or verification ran'
            : 'historical generation attempt; later edits or verification have run';
    }
  }
}
// The lines of a file the evidence shows as numbered text of the version with the given
// sha256 (any version when undefined: an archived output never changes): from every read
// result still in the prompt and not marked stale, each line with the entry that shows it.
// A line a clip cut into is not counted as shown.
export function shownLines(
  s: Session,
  path: string,
  sha: string | undefined,
): { total: number | null; by: Map<number, string> } {
  const by = new Map<number, string>();
  let total: number | null = null;
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^${esc} sha256=(\\w+) totalLines=(\\d+) shown=(\\d+)\\.\\.(\\d+)$`);
  // clip() keeps a result's two ends around a marker line; the line each side of it is cut.
  const marker = '[…truncated; use a narrower read';
  for (const e of s.entries) {
    if (e.kind !== 'read_files' || e.stale) continue;
    const lines = e.text.split('\n');
    let next = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const h = i === 0 || lines[i - 1] === '' ? line.match(header) : null;
      if (h) {
        next = sha === undefined || h[1] === sha ? Number(h[3]) : -1;
        if (next > 0) total = Number(h[2]);
        continue;
      }
      if (next < 0) continue;
      // After a clip marker the text may belong to another file of the same read: nothing is
      // credited until the next complete header.
      if (line.startsWith(marker)) {
        next = -1;
        continue;
      }
      const n = Number(line.match(/^(\d+): /)?.[1] ?? NaN);
      if (n !== next) {
        next = -1;
        continue;
      }
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
  const split = (t: string) =>
    t === ''
      ? []
      : t
          .replace(/\r?\n$/, '')
          .split('\n')
          .map(l => l.replace(/\r$/, ''));
  const a = split(before);
  const b = split(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  if (!x.length || !y.length) return { removed: x.length, added: y.length, exact: true };
  if (x.length * y.length > 4_000_000) return { removed: x.length, added: y.length, exact: false };
  let row = new Array<number>(y.length + 1).fill(0);
  for (const line of x) {
    const next = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) next[j] = line === y[j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!);
    row = next;
  }
  const common = row[y.length]!;
  return { removed: x.length - common, added: y.length - common, exact: true };
}
// Line numbers as ranges: [1, 2, 3, 7] -> [[1, 3], [7, 7]].
export function lineRanges(ns: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of [...ns].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) out.push([n, n]);
  }
  return out;
}
export function rememberEdit(
  s: Session,
  step: number,
  route: string,
  paths: string[],
  artifact: string,
  text: string,
  args?: Record<string, any>,
): void {
  const applied = args
    ? clip(JSON.stringify({ ...args, expectedHash: undefined, destinationHash: undefined }), 700)
    : undefined;
  s.editEvidence.push({
    step,
    route,
    paths,
    artifact,
    text: clip(text.replace(/sha256=\w+/g, 'sha256=[recorded in artifact]'), 400),
    applied,
  });
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
  const endsTurn = (e: Entry) =>
    e.kind === 'turn' ||
    (e.turn !== undefined &&
      s.entries.some(t => t.kind === 'turn' && t.id === e.turn) &&
      !s.entries.some(x => x !== e && x.turn === e.turn));
  const pick = () =>
    s.entries.filter(
      (e, i) =>
        (only === undefined || e.id === only) &&
        i >= from &&
        !(from > 0 && endsTurn(e)) &&
        (s.entries.length === 1 || !protectedIds.has(e.id)) &&
        !(e.kind === 'turn' && hasResults(e)),
    );
  let candidates = pick();
  if (!candidates.length && allowCited && s.entries.at(-1)?.cites?.length) {
    protectedIds = new Set([s.entries.at(-1)?.id, s.currentTurn ?? undefined]);
    candidates = pick();
  }
  // Stale entries that hold nothing current go first, oldest first; then the least relevant, then the oldest.
  const gone = new Map(candidates.map(e => [e, Boolean(e.stale) && !holdsCurrent(s, e)]));
  const candidate = [...candidates].sort(
    (a, b) =>
      Number(gone.get(b)) - Number(gone.get(a)) || (gone.get(a) ? 0 : a.relevance - b.relevance) || a.step - b.step,
  )[0];
  if (!candidate) return undefined;
  s.entries = s.entries.filter(e => e !== candidate);
  // A repeat's answer that names the entry no longer describes the prompt: it is marked, not removed (nothing before it changes).
  for (const e of s.entries)
    if (e.kind === 'repeat' && !e.stale && e.cites?.includes(candidate.id))
      e.stale = `names ${candidate.id}, which has left the prompt`;
  const turn =
    candidate.kind === 'turn' ? candidate : s.entries.find(e => e.kind === 'turn' && e.id === candidate.turn);
  if (turn && !hasResults(turn) && turn.id !== s.currentTurn) {
    s.entries = s.entries.filter(e => e !== turn);
    s.trail = [...(s.trail ?? []), trailLine(turn)]
      .sort((a, b) => Number(a.match(/^step (\d+)/)?.[1]) - Number(b.match(/^step (\d+)/)?.[1]))
      .slice(-12);
  }
  return candidate;
}
// A stale entry can still be the only place something is shown as it is. A read goes stale when
// any one of its files is edited or read again from the same line, while its other files stay as
// they are: in the replay of runs 49-76, 18 of the 85 stale reads evicted still showed such a file,
// and after run 56's reset took one at step 36 the next line edits went without it and step 38 read
// it again. A later read covers a block only when it shows all of its lines: one from the same line
// can be narrower (run 73 read Testimonials.tsx 1..142 at step 28, then 1..15 at step 40).
// The last check, followed by edits but by no other check, is the only place its errors are shown
// (the verification block names their files and lines, not what they say), while it failed and names
// a file not edited since, or none. Such an entry is evicted as the result it is.
function holdsCurrent(s: Session, e: Entry): boolean {
  if (e.verification) {
    if (!s.lastCheck) return true;
    if (e.step < s.lastCheck.step) return false;
    const since = staleFor(s);
    const files = Object.keys(s.lastCheck.summary.files);
    return (
      !s.lastCheck.ok &&
      (!files.length || files.some(f => !since.some(w => w === f || w.endsWith(`/${f}`) || f.endsWith(`/${w}`))))
    );
  }
  if (e.kind !== 'read_files') return false;
  const blocks = (x: Entry) =>
    [...x.text.matchAll(/(?:^|\n\n)(\S+) sha256=\w+ totalLines=\d+ shown=(\d+)\.\.(\d+)/g)].map(m => ({
      path: m[1]!,
      start: Number(m[2]),
      end: Number(m[3]),
    }));
  const later = s.entries.filter(x => x !== e && x.kind === 'read_files' && x.step > e.step).flatMap(blocks);
  return blocks(e).some(
    b =>
      !((s.writeSteps[b.path] ?? -1) > e.step) &&
      !later.some(l => l.path === b.path && l.start <= b.start && l.end >= b.end),
  );
}
// Once the prompt changes at index at, every entry behind it is reprocessed anyway: the stale
// entries there that hold nothing current go too, at no cost of their own, and each later step
// is that much shorter. Nothing in front of at is touched, and no trail line is added unless
// the trail already changed (at 0).
export function evictStaleBehind(s: Session, at: number): Entry[] {
  const out: Entry[] = [];
  for (const e of s.entries.slice(at))
    if (s.entries.includes(e) && e.stale && !holdsCurrent(s, e)) {
      const x = evictOne(s, at, e.id);
      if (x) out.push(x);
    }
  return out;
}
// The entries the next batched eviction would take, in its order, down to target
// tokens: evictOne's own global order, run on a copy of the session.
export function plannedEviction(s: Session, target: number): string[] {
  const copy = structuredClone(s);
  const ids: string[] = [];
  while (evidenceTokens(copy) > target) {
    const e = evictOne(copy);
    if (!e) break;
    ids.push(e.id);
  }
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
    const e = evictOne(s, at, id);
    if (!e) break;
    out.push(e);
  }
  return out;
}
// Generated content in a turn's arguments is on disk and in the results; the
// turn keeps what identifies the action (paths, commands, queries, ranges).
export function compactArgs(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 240 ? `${v.slice(0, 160)}… [${v.length} chars]` : v;
  if (Array.isArray(v)) return v.map(compactArgs);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'expectedHash' && k !== 'destinationHash')
        .map(([k, x]) => [k, compactArgs(x)]),
    );
  return v;
}
// The worker's reasoning and actions for a batch, exactly in the shape it
// generated them, recorded before the batch runs so that the prefix only grows.
// whole: the calls as the model made them (the tools form, where a file's content is in its call and the
// turn is how the model knows what it wrote), not compacted.
export function turnEntry(
  step: number,
  thought: string,
  batch: { action: string; args: Record<string, any> }[],
  whole = false,
): Entry {
  return {
    id: `t${step}`,
    step,
    kind: 'turn',
    artifact: '',
    relevance: 0.5,
    outcomes: [],
    text: JSON.stringify({
      thought: whole ? thought : cut(thought, 600),
      actions: batch.map(b => ({ action: b.action, args: whole ? b.args : compactArgs(b.args) })),
    }),
  };
}
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
function trailLine(turn: Entry): string {
  let actions: { action: string; args: Record<string, any> }[] = [];
  try {
    actions = JSON.parse(turn.text).actions ?? [];
  } catch {
    /* not a turn */
  }
  const named = actions.map(a => {
    const x = a.args ?? {};
    const what =
      x.path ??
      x.command ??
      x.query ??
      x.url ??
      x.source ??
      (Array.isArray(x.files) ? x.files.map((f: any) => f.path).join(',') : '');
    return `${a.action}${what ? ` ${cut(String(what), 70)}` : ''}`;
  });
  return cut(
    `step ${turn.step}: ${named.join('; ')} -> ${turn.outcomes?.length ? turn.outcomes.join('; ') : 'no result'}`,
    240,
  );
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
  return Math.ceil(
    agentPrefix(s)
      .slice(2)
      .filter(m => !m.content.startsWith('{"earlierSteps"'))
      .reduce((n, m) => n + m.content.length, 0) / 3.5,
  );
}
const details: Record<Route, string> = {
  rewrite_file:
    'path is an existing file; purpose says what the new content must contain and change. Its current content is put in front of you when the block or the file is generated, so there is no need to read it first to append to it or change it. start and end (optional, 1-based, inclusive, numbered as in the latest read or edit result of the file) limit the regeneration to that block: give them whenever most of the file stays as it is (appending rules, adding a component, replacing one function); omit them only when most of the file changes. Never put file content in the arguments: it is generated next, as code, from the current content, your thought and purpose.',
  observe: `kind is one of ${observerCatalog.map(o => o.kind).join(', ')}: whichever is how the objective's user meets the result. start is the shell command that starts what is observed and keeps running (a server on a fixed port with no browser opening, a service), stopped afterwards; "" when it already runs or nothing needs starting. target is what is observed: a URL, or the command to run with its arguments. inputs plays a page as its user would, in order (page only; [] for none): press a key (what: Enter, Space, Escape, an arrow, a letter), hold one for ms, type text into what has focus, click the element a CSS selector names, or wait; each is followed by ms of watching, and what it did is stated: exceptions thrown, frames drawn, how much of each canvas changed and where, text that came or went. Everything runs in the repository root.`,
  plan: 'notes is the whole of your notes, replaced: a short plan with what is done, what you have learned (versions, commands that work, decisions), and what comes next. Keep it under forty lines.',
  read_files:
    'files lists up to three files, each {path, start, end}; more go in further read_files calls of the same turn. When verification.files names lines in the file being fixed, read around those lines rather than from line 1. Use exact regular repository-relative file paths; globs, directories, and wildcard paths are invalid. Use 1-based inclusive start/end; a read shows as many lines of the range as fit in the read budget (shared across the requested files; the result reports the last line shown), so a long file is read in a few large ranges, or located first with search_codebase and read around the definition; readCoverage shows what was already read, and reading it again yields nothing new. Output is cut at line boundaries within a character budget shared across the requested files and reports the last line shown; continue from the next line in a later read. Use @artifact/NAME to retrieve prior outputs. Read before editing.',
  search_codebase:
    'Use a narrow literal query or mode files. Text matches are returned as path:line:text, so a query such as "const DEFAULT_DEPENDENCIES" gives the exact line to read next. searched lists every query already run and what it found; never repeat one, search for the next symbol the objective still needs. The path is a repository-relative directory, usually "."; use "@artifacts" to search archived tool outputs. Do not use search results as read_files paths unless they are exact regular files.',
  replace_lines:
    'Each edit is { start, end, newText, prepend }. To insert lines without replacing any, use end = start - 1: the newText is inserted before line start (start = totalLines + 1 appends); this is how imports are added, never by retyping an existing line. With prepend non-empty (for example "export ") every line in start..end keeps its text and gets that prefix; newText must be "" and nothing is retyped. This is how declarations are exported: one edit per declaration line, all in one call. With prepend "", the range is replaced by newText ("" deletes it). Edits that would leave the file unparseable are refused with the parser message. An error at a line means that line needs fixing in place: a missing import is added at the top of the file, never by overwriting the line that uses the name. The file must have been read since it last changed: expectedHash must equal the sha256 of that read. edits is a list of up to 40 non-overlapping ranges {start, end, newText} (1-based, inclusive) of path, all numbered as in that read, never from a check that ran before the latest edit of the file (verification.writtenSince names the files edited after that check ran); the harness applies them bottom-up so they never shift each other. expectedHash comes from fileHashes. newText may be empty to delete the lines. Only new text is generated, so this is the way to remove many unused import lines in one step (one edit per reported line) or rewrite a region. After it runs, line numbers below the first edit have shifted: its result gives the new sha256 and the lines as they now read. Line numbers are always those of the text whose sha256 is expectedHash: a later edit of the same file in the same batch that carries the same hash is numbered as in that same text, and the harness maps its ranges through the batch\'s earlier edits (the result states old -> new ranges; a range an earlier edit changed is refused with the facts).',
  move_lines:
    'Cut lines start..end (1-based, inclusive, at most 2000) from source and append them unchanged to the end of destination; take the numbers from read_files or search_codebase. expectedHash is the current source sha256 from fileHashes; destinationHash is the destination sha256 from fileHashes, or "new" only when the destination does not exist yet. Nothing else is changed in either file: whatever the moved lines need in their new place (imports, exports, references) is yours to add with an edit.',
  create_file:
    'path is the repository-relative path of a file that does not exist yet (never an existing file: those are edited with write or replace_lines); purpose says in one sentence what the file must contain. The content itself is not written here: the harness asks for it as code in the next generation.',
  write:
    'For a short anchor only (a few lines) in a file that exists: for a region of many lines use replace_lines, and to relocate a block use move_lines. expectedHash must be the current sha256 of the path from fileHashes (the same value the latest read_files or edit result reported). oldText is a small unique anchor (a few consecutive lines) copied exactly from that read; never paste a truncated excerpt or an entire file. newText replaces the anchor and must differ from it. Never overwrite an unread file; a new file is made with create_file.',
  bash: 'check is true only when this command is the verification of the work (a build, a type check, a test run): from then on it is the check of record, and running that same command again is a check too; false for installs, scaffolds, inspections and everything else. The harness never runs the check by itself: run it after edits when you want them judged, and before finish, which is refused while an edit is newer than the last check. command runs with bash in the repository root (the harness already sets cwd; use repository-relative paths and do not cd into a subdirectory or to /workspace). Explain its purpose. Use it for diagnostics too. A command that succeeded is not run again until something is written or installed, because its output is already in the evidence. Do not start background processes or servers.',
  finish:
    'summary reports the final code structure, the verification from verification, and limitations concisely. Once anything has been written, finish is refused while verificationAfterLastWrite is false: run the check first. With nothing written there is nothing to verify: the summary is your answer, judged against what you read, so state what the evidence you gathered shows. The evidence gate reads the changed files as they are now, the diff and the last observation; your earlier turns show what was done. Missing history proves neither that a requested procedure was followed nor that it was skipped. Do not infer a procedural violation from absent records. Report only what the evidence establishes.',
  ask_user: 'Ask one concise question that explains the missing information.',
};
export const language = (path: string): string =>
  (
    ({
      ts: 'ts',
      tsx: 'tsx',
      js: 'js',
      jsx: 'jsx',
      mjs: 'js',
      cjs: 'js',
      json: 'json',
      css: 'css',
      scss: 'scss',
      html: 'html',
      md: 'md',
      yml: 'yaml',
      yaml: 'yaml',
      toml: 'toml',
      py: 'python',
      rs: 'rust',
      go: 'go',
      sh: 'bash',
    }) as Record<string, string>
  )[path.split('.').pop() ?? ''] ?? '';
// The fence for a file's code block: four backticks for documents that may
// themselves contain fenced blocks, so the closing fence is unambiguous.
export const fenceFor = (path: string): string =>
  /\.(md|mdx|markdown)$/i.test(path) ? '````' + language(path) : '```' + language(path);
// What a file to create may rely on: for each dependency, the path to import
// it from and its exported surface (parsed from the file when it exists, from
// the design when it is still planned), and who will import this file.
export interface FileContract {
  path: string;
  importPath: string;
  status: 'exists' | 'planned';
  exports: string[];
}
// A rewritten region that repeats lines around it is trimmed to the region: the
// worker's intent is unambiguous, so the output is repaired. Lines are compared
// trimmed and without blank lines, as a copy is made, and a repeat takes the blank
// lines next to it. At the start, a repeat of the lines just before the region; one
// line of the block is kept unless cut: the output was cut at a loop, so it may be
// nothing but repeated context. At the end, a repeat of the lines after the region,
// as far as it goes (echoOf): a block that is nothing but that repeat is empty, which
// removes the region, and one that reproduces the first lines after the region and
// goes on past them is cut where the repeat starts, since what it wrote there lies
// outside the region. Only a run of two or more lines, or one substantive line, is
// taken as repeated context.
export function trimContext(output: string, around: Around, cut = false): { text: string; echo: Echo | null } {
  let lines = output === '' ? [] : output.replace(/\n$/, '').split('\n');
  const b = contentLines(around.before).map(x => x.t);
  const g = contentLines(lines.join('\n'));
  for (let n = Math.min(b.length, g.length - (cut ? 0 : 1)); n > 0; n--)
    if (g.slice(0, n).every((x, i) => x.t === b[b.length - n + i]) && (n >= 2 || substantive(g[0]!.t))) {
      lines = lines.slice(n < g.length ? g[n]!.i : lines.length);
      break;
    }
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  const echo = echoOf(text, around);
  return { text: !echo ? text : echo.line > 1 ? `${lines.slice(0, echo.line - 1).join('\n')}\n` : '', echo };
}
// Every field of the prompt merged into one object, for inspection and tests.
export function promptFields(prompt: Message[]): Record<string, any> {
  const out: Record<string, any> = {};
  const evidence: unknown[] = [];
  for (const m of prompt.slice(1)) {
    let parsed: any;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (m.role === 'assistant') continue;
    if (parsed && typeof parsed === 'object' && 'evidence' in parsed && Object.keys(parsed).length === 1)
      evidence.push(parsed.evidence);
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
// The agent's system message; named for the model when it has a name of its own here (Bonsai, served
// locally), otherwise it is just the coding agent.
export const agentSystem = (name?: string): string =>
  `You are ${name ? `${name}, a` : 'a'} coding agent working in a repository through tools. Each step you reason briefly about the objective, what you know and what you just observed, then name the actions to take. Your own earlier turns are the assistant messages, each followed by the results of its actions; steps whose evidence was dropped for room are summarised in earlierSteps. You decide what to read, what to run (scaffolders, package managers, checks), what to write and in what order; the harness executes your action, verifies what it can, and shows you what happened. Prefer acting on facts you have over reading what is already shown. Keep your notes current with the plan action.`;
export const AGENT_SYSTEM = agentSystem('Bonsai');
export function orientationBlock(s: Session, allowed?: string[]): Record<string, unknown> {
  return {
    objective: s.objective,
    repositoryInstructions: s.instructions || undefined,
    orientation: s.orientation ?? undefined,
    ...(allowed
      ? {
          actions: Object.fromEntries(
            allowed.map(a => [
              a,
              {
                description: routeDescriptions[a as Route],
                instructions: details[a as Route],
                argumentSchema: schemas[a as Route],
              },
            ]),
          ),
        }
      : {}),
  };
}
// note: the request's harnessNote. The loop's notes state unaddressed completion feedback every step, so
// the field would be a second copy of it (runs 49-76: in 43 of 43 step prompts; 3.6k tokens in run 76).
export function agentRequestBase(s: Session, note = ''): Record<string, unknown> {
  const staleEvidence = Object.fromEntries(s.entries.filter(e => e.stale).map(e => [e.id, e.stale]));
  // The failed result the error comes from is the freshest entry, right above the tail (runs 49-76: shown in it
  // in 201 of 214 step prompts). A rejected finish is clipped there to 600 characters, and harnessNote states it whole (9 of the 13).
  const lastError = s.lastError && clip(s.lastError, 700);
  const errorAt = lastError ? shownIn([{ id: 'harnessNote', text: note }, ...s.entries], lastError) : undefined;
  return {
    changedFiles: s.writes.slice(-30),
    fileCount: s.knownFiles.length,
    staleEvidence,
    ...(s.referenceEvidence.length ? { referenceEvidence: referenceContext(s, 3000) } : {}),
    ...(s.completionFeedback && !s.completionFeedback.addressed && !note.includes(s.completionFeedback.text)
      ? { completionFeedback: s.completionFeedback.text }
      : {}),
    readCoverage: coverageSummary(s, 12),
    searched: compactSearched(s, 8),
    fileHashes: Object.fromEntries(Object.entries(s.hashes).slice(-12)),
    rejectedEdits: compactRejected(s, 3),
    lastError: lastError && named(lastError, errorAt),
  };
}
// Message boundaries are cache checkpoints: the notes change rarely, the
// file list changes when files are created, the check state changes when the
// check runs; each sits in its own message so a step re-processes only what
// changed after the last unchanged boundary.
// point: false restates the output where it would be named, as the key of a code request reads it (agent.ts).
export function verificationBlock(s: Session, point = true): Record<string, unknown> {
  // Files written after the check ran: its output describes them as they were, not as they are.
  const since = staleFor(s);
  const edited = (f: string) => since.some(w => w === f || w.endsWith(`/${f}`) || f.endsWith(`/${w}`));
  // While the check's own entry shows the output, the output is named, not restated: the step prompts of runs 49-76
  // carried it 349 times, with that entry in the prompt every time (holdsCurrent keeps a failed check of record) and showing all of it in 336.
  // The entries of the check's step are its own (ids are e<step>): a retry at that step leaves two, and it is restated.
  const c = s.lastCheck;
  const output = c && !since.length ? clipEnds(c.text, 1200) : '';
  const at =
    output && point
      ? shownIn(
          s.entries.filter(e => e.step === c!.step),
          output,
        )
      : undefined;
  return {
    verification: c
      ? {
          command: c.command ?? s.lastCheckCommand,
          step: c.step,
          ok: c.ok,
          exitCode: c.summary.code,
          ...(since.length ? { writtenSince: since } : {}),
          files: Object.fromEntries(
            Object.entries(c.summary.files)
              .filter(([f]) => !edited(f))
              .slice(0, 8),
          ),
          ...(since.length
            ? {
                outputWithheld: `files were edited after this check ran (${since.join(', ')}); what it said about them no longer describes them, so it is not shown: run the check again to see them as they are`,
              }
            : { output: named(output, at) }),
        }
      : { command: s.lastCheckCommand, step: null, ok: null },
  };
}
// The prompt is ordered by how often each part changes, because the server
// reuses its cache only up to the first changed message: the system message and
// the orientation never change in a session; the evidence is append-only (an
// entry is removed only by a batched eviction); the notes, the file list, the
// check state and the request change every turn and come last. Every call, a
// reasoning turn or a file generation, shares this prefix.
export function agentAllowed(s: Session): string[] | undefined {
  return s.allowedActions;
}
function agentPrefix(s: Session): Message[] {
  return [
    { role: 'system', content: s.form ? agentSystem() : AGENT_SYSTEM },
    // Under the tools form the actions are the model's tools, each with its description, instructions and schema.
    { role: 'user', content: JSON.stringify(orientationBlock(s, s.form === 'tools' ? undefined : s.allowedActions)) },
    // The trail changes only when evidence is evicted, which already reprocesses from the
    // oldest entry, so it sits before the evidence rather than being reprocessed every step.
    ...(s.trail?.length ? [{ role: 'user' as const, content: JSON.stringify({ earlierSteps: s.trail }) }] : []),
    ...(s.form === 'tools'
      ? toolTranscript(s)
      : s.entries.map(e => (e.kind === 'turn' ? { role: 'assistant' as const, content: e.text } : evidenceMessage(e)))),
  ];
}
// Where a prompt stops changing, for a provider that caches a prefix where the request marks it: after the
// orientation (the same for the whole session, whatever is evicted) and after the evidence (append-only between
// evictions, so the next turn's prompt extends it). Every prompt here is agentPrefix, then the volatile block and
// the request; a continuation appends after those and is not marked.
export function cachePoints(messages: Message[]): number[] {
  if (messages[0]?.role !== 'system' || messages.length < 4) return [];
  // A marker goes on text: an assistant turn that only calls tools has none, so its point is the message before it.
  let end = messages.length - 3;
  while (end > 1 && !messages[end]!.content) end--;
  return [...new Set([1, end])];
}
const evidenceContent = (e: Entry): string =>
  JSON.stringify({ evidence: { id: e.id, kind: e.kind, artifact: e.artifact, text: e.text } });
const evidenceMessage = (e: Entry): Message => ({ role: 'user', content: evidenceContent(e) });
// Each action as one of the model's tools (the tools form), described once, briefly: the tool definitions are sent
// with every request, and the catalogue Bonsai reads (routeDescriptions, details) ran to 9,800 characters, about a
// quarter of a small run's prompt (run react-demo-glm-3). Every rule the harness enforces is kept; the reasons and
// examples are not. The file actions write their content in the call (toolForms).
const toolBriefs: Record<Route, string> = {
  read_files:
    'Read files or line ranges, or a stored output as @artifact/NAME. files: up to three {path, start, end} (1-based, inclusive; no range reads the whole file); more go in further read_files calls of the same turn. Exact repository-relative paths, no globs or directories. A read shows as much of each range as fits its budget and names the last line shown: continue from the next line. To find a declaration in a large file, search_codebase first and read around it. Read a file before editing it.',
  search_codebase:
    'Find text (mode text: path:line:text) or files by name (mode files) under path: "." for the repository, "@artifacts" for stored outputs. Use a narrow literal query; never repeat a query already in searched.',
  bash: 'Run a shell command in the repository root (do not cd elsewhere; no background processes or servers: observe starts and watches those). check is true only when the command verifies the work (a build, a type check, tests): it becomes the check of record, and finish is refused while an edit is newer than the last check. A command that succeeded is not run again until something is written or installed.',
  create_file:
    'Create a file that does not exist yet with its whole content: working code with no placeholders, TODOs or omitted parts, importing repository modules by the names they export and packages the manifest declares. A large file goes in a call of its own: a reply cut off by its length limit is not run. An existing file is changed with rewrite_file or write.',
  rewrite_file:
    "Replace an existing file's whole content, or with start and end (1-based, inclusive, numbered as in your latest read or edit of it) only those lines; end = start - 1 inserts before start, start = totalLines + 1 appends. Give start and end when most of the file stays. Lines numbered from a version you have not seen are refused.",
  write:
    "Replace one exact piece of an existing file: oldText copied exactly from the file as you last read or wrote it, occurring once; newText differs from it. expectedHash (optional) is the file's sha256 from fileHashes; without it oldText must match the file as it is now.",
  replace_lines:
    'Edit up to 40 non-overlapping line ranges of a file you have read, by number, all numbered as in the read whose sha256 is expectedHash (from fileHashes); never from a check that ran before the file\'s latest edit. Each edit {start, end, newText} replaces the lines (newText "" deletes; end = start - 1 inserts before start). With prepend (e.g. "export ") and newText "", every line of the range gets that prefix. Edits apply bottom-up; a later edit of the same file in the batch, with the same hash, is numbered as in that same text. Edits that leave the file unparseable are refused. A missing import is added at the top, never by overwriting the line that uses the name.',
  move_lines:
    'Move lines start..end (at most 2000) of source, unchanged, to the end of destination (created if new). expectedHash is the source sha256 and destinationHash the destination sha256 from fileHashes, or "new" for a new destination. What the moved lines need in their new place (imports, references) is yours to add.',
  plan: 'Replace your notes, under forty lines: the plan, what is done, what you learned (versions, commands that work, decisions), what is next.',
  observe:
    'See the result as its user meets it. kind page: a page in a headless browser (exceptions, failed requests, console, styling, layout, text, canvases); http: one GET to a running service (status, content type, body); program: a command run as its user would (exit code, output). start: the command that starts what is observed and keeps running (a server on a fixed port, no browser opening), stopped afterwards; "" when nothing needs starting. target: the URL, or the command with its arguments. inputs (page only, in order): press or hold a key, type text, click a CSS selector, or wait; each is followed by ms of watching, and what it did is stated.',
  finish:
    'Report completion: summary gives the final structure, the verification and limitations. Refused while an edit is newer than the last check (verificationAfterLastWrite false). With nothing written, the summary is your answer, judged against what you read. Report only what the evidence shows: missing history proves neither that a step was followed nor that it was skipped.',
  ask_user:
    'Pause because essential information or a permission only the user has is missing. Ask one concise question.',
};
// An action as one of the model's tools (the tools form): its name, its description and instructions, its arguments' schema.
export function actionTool(action: string): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  const a = action as Route;
  return {
    type: 'function',
    function: {
      name: action,
      description: toolBriefs[a] ?? `${routeDescriptions[a]} ${details[a]}`,
      parameters: toolSchema(a) as unknown as Record<string, unknown>,
    },
  };
}
// A file's text in a call of an earlier turn, said in one line instead of repeated: the file as it is now is a
// read away, and the call's result states what was written (its sha256 and line count). Every request re-sent
// every file the run had written, whole: run react-demo-glm-3 (GLM-5.3, 16 requests) sent App.tsx and index.css,
// 28,000 characters, in each of its last twelve prompts, about 45% of its prompt tokens. The latest turn keeps its
// text, so the step after a write sees what it wrote; the turn before it changes once, when it stops being latest.
const elidedFields: Record<string, string[]> = {
  create_file: ['content'],
  rewrite_file: ['content'],
  write: ['oldText', 'newText'],
};
function elided(action: string, args: unknown, step: number): unknown {
  const fields = elidedFields[action];
  if (!fields || !args || typeof args !== 'object') return args ?? {};
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const f of fields) {
    const text = out[f];
    if (typeof text !== 'string' || text.length <= 600) continue;
    // The class names markup uses stay said: a stylesheet written in a later turn is written against them. Run
    // saas-landing-glm-5.3 trial 4 wrote its components with BEM names (nav__brand) and, a turn later and without
    // them, a stylesheet with hyphenated ones (nav-links): 13 of 125 matched, and the stylesheet was written again.
    const classes = /\.(css|scss|sass|less|styl)$/i.test(String(out.path ?? '')) ? [] : classNamesIn(text);
    out[f] =
      `[${text.split('\n').length} lines (${text.length} characters) written at step ${step}; not repeated here: read_files shows ${String(out.path ?? 'the file')} as it is now${classes.length ? `; the class names it uses: ${classes.slice(0, 80).join(' ')}${classes.length > 80 ? ' …' : ''}` : ''}]`;
  }
  return out;
}
// A result that no longer describes the repository (a read of a file since edited or read again, a check
// superseded by a later one) and holds nothing current, said in one line with why and where it is kept, instead
// of in full: the evidence marks such entries stale and evicts them first, but only once the prompt passes its
// working budget, which a run through OpenRouter (90,000 tokens) seldom reaches. Run react-demo-glm-8 re-read files
// it had written six times, and every read stayed whole in every later prompt. The entry changes once, when it
// turns stale.
function currentContent(s: Session, e: Entry): string {
  if (!e.stale || e.text.length <= 400 || holdsCurrent(s, e)) return evidenceContent(e);
  const where = e.artifact ? ` ${e.artifact} holds it in full.` : '';
  return JSON.stringify({
    evidence: { id: e.id, kind: e.kind, artifact: e.artifact, text: `[left out: ${e.stale}.${where}]` },
  });
}
// The evidence as the model's own tool-calling transcript: a turn is an assistant message, its thought as the
// text and one call per action; right after it, one tool message per call. Action i of a turn ran at the turn's
// step + i, so a call's result is the turn's entries of that step. A call with none says what is known of it:
// it ran and its result has left the evidence; the batch stopped before it; or, while the batch runs (a file of
// it is being written), it is the one the request is for, or it runs later. Entries of no turn shown, and the
// results of a turn that left, stay user messages where they are.
function toolTranscript(s: Session): Message[] {
  const shown = new Set(s.entries.filter(e => e.kind === 'turn').map(e => e.id));
  // The latest turn is shown as written; an earlier one without the files it wrote (see elided).
  const latest = s.entries.filter(e => e.kind === 'turn').at(-1)?.id;
  const out: Message[] = [];
  for (const e of s.entries) {
    if (e.kind !== 'turn') {
      if (!e.turn || !shown.has(e.turn)) out.push({ role: 'user', content: currentContent(s, e) });
      continue;
    }
    let turn: { thought?: unknown; actions?: { action: string; args?: unknown }[] } = {};
    try {
      turn = JSON.parse(e.text);
    } catch {
      /* not a turn */
    }
    const calls = (Array.isArray(turn.actions) ? turn.actions : []).map((a, i) => ({
      id: `${e.id}_${i}`,
      type: 'function' as const,
      function: {
        name: String(a.action),
        arguments: JSON.stringify(e.id === latest ? (a.args ?? {}) : elided(String(a.action), a.args, e.step + i)),
      },
    }));
    out.push({
      role: 'assistant',
      content: String(turn.thought ?? ''),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    const results = s.entries.filter(r => r.kind !== 'turn' && r.turn === e.id);
    const ran = e.outcomes?.length ?? 0;
    const running = s.currentTurn === e.id ? s.step - e.step : -1;
    calls.forEach((c, i) => {
      const mine = results.filter(r => Math.min(Math.max(r.step - e.step, 0), calls.length - 1) === i);
      const content = mine.length
        ? mine.map(r => currentContent(s, r)).join('\n')
        : i === running
          ? 'Running: the request below is for this call.'
          : running >= 0 && i > running
            ? 'Not run yet: it runs after the calls before it.'
            : i < ran
              ? 'Ran; its result has left the evidence (earlierSteps summarises it).'
              : 'Not run: the batch stopped at an earlier call.';
      out.push({ role: 'tool', tool_call_id: c.id, content });
    });
  }
  return out;
}
export function volatile(s: Session, point = true): Message[] {
  return [
    {
      role: 'user',
      content: JSON.stringify({ notes: s.notes ?? '', files: relevantFiles(s, 40), ...verificationBlock(s, point) }),
    },
  ];
}
export function stepMessages(s: Session, allowed: string[], note?: string): Message[] {
  // The pinned block lists the session's actions: allowedActions is sent only when a step allows fewer
  // (runs 49-76: equal in 729 of 729 prompts), and the request then names it.
  const pinned = agentAllowed(s) ?? [];
  const narrowed = allowed.length !== pinned.length || allowed.some(a => !pinned.includes(a));
  const request = {
    role:
      s.form === 'tools'
        ? `Reason, then act. Write one to three sentences on what the latest evidence shows and what to do next and why; your notes and your earlier turns already record what is done, so do not list it again. Then call the tools, up to sixteen calls in order. Every turn re-sends the whole conversation, so the fewer turns the better: batch every call that follows from what you know now. Read every file you need in one turn; write every file you can write now in one turn, one call each; then the check, and an observation last. The harness runs the calls in order and stops at the first failure. Make a turn of one call only when its result decides everything after it.`
        : `Reason, then act. Write thought: one to three sentences on what the latest evidence shows and what to do next and why; your notes and your earlier turns already record what is done, so do not list it again. Then actions: an ordered list of one to eight actions (each an action name from ${narrowed ? 'allowedActions' : "the pinned block's actions"} with its args under that action's schema; descriptions, instructions and schemas are in the pinned block under actions). The harness runs them in order and stops at the first failure, so batch what follows from your reasoning (several files to create, an edit and its check, a check and an observation) and put a check or an observation last; keep to one action when its result decides what comes next.`,
    ...agentRequestBase(s, note),
    ...(narrowed && s.form !== 'tools' ? { allowedActions: allowed } : {}),
    ...(note ? { harnessNote: note } : {}),
  };
  return [
    ...agentPrefix(s),
    ...volatile(s),
    {
      role: 'user',
      content: JSON.stringify({
        ...request,
        verificationAfterLastWrite: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep),
      }),
    },
  ];
}
// How the code is written: into the block the harness opened (Bonsai), or as the reply's one fenced code block.
const opened = (s: Session, what: string): string =>
  s.form
    ? `Reply with ${what} as one fenced code block and nothing outside it.`
    : `The harness has opened the code block; write only ${what} and close the block.`;
// One block of an existing file, written as code: the block as it is now, the
// lines around it, and the whole file when it is small enough to read cheaply.
// Only the block is generated; the harness splices it in.
export function regionMessages(
  s: Session,
  path: string,
  purpose: string,
  current: string,
  start: number,
  end: number,
  contracts: FileContract[],
  declared: string[],
  shrink = 0,
  markup: Record<string, unknown> = {},
): Message[] {
  const lines = (current.endsWith('\n') ? current.slice(0, -1) : current).split('\n');
  const total = current === '' ? 0 : lines.length;
  const window = shrink ? 20 : 40;
  const request = {
    role: `Write the new content for lines ${start}..${end} of ${path} as code: only those lines, which replace the ones in region (${end < start ? 'an insertion: region is empty' : `${end - start + 1} line(s)`}). Everything outside them stays as it is. ${opened(s, 'the new lines')}`,
    file: path,
    purpose,
    lines: `${start}..${end} of ${total}`,
    before: lines.slice(Math.max(0, start - 1 - window), start - 1).join('\n'),
    region: lines.slice(start - 1, end).join('\n'),
    after: lines.slice(end, end + window).join('\n'),
    // The whole file only when before, region and after do not already show all of it.
    ...(!shrink && current.length <= 16000 && !(start - 1 - window <= 0 && end + window >= total)
      ? { currentContent: current }
      : {}),
    modules: contracts
      .slice(0, shrink ? 4 : 12)
      .map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60),
    ...markup,
    rules: [
      `Write only the new lines ${start}..${end} of ${path}: working code with no placeholders, and nothing from before or after (they stay in the file).`,
      'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.',
      s.form
        ? 'Reply with the lines in one fenced code block; no explanation before or after it.'
        : 'Write the lines only, then the closing fence; no explanation before or after them.',
    ],
  };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify(request) }];
}
// A new file, written as code: the worker's purpose (its reasoning is the turn in the prefix), the real
// exported signatures of the repository modules it names, and the packages
// the manifest declares, so nothing is invented.
export function newFileMessages(
  s: Session,
  path: string,
  purpose: string,
  contracts: FileContract[],
  declared: string[],
  shrink = 0,
  current?: string,
  markup: Record<string, unknown> = {},
): Message[] {
  const request = {
    role:
      current === undefined
        ? `Write the complete file ${path} as code. ${opened(s, 'the file content')}`
        : `Rewrite the complete file ${path} as code: its whole new content, keeping what should stay and changing what purpose asks. ${opened(s, 'the file content')}`,
    file: path,
    purpose,
    ...(current !== undefined ? { currentContent: shrink ? clip(current, 6000) : current } : {}),
    modules: contracts
      .slice(0, shrink ? 4 : 12)
      .map(c => ({ import: c.importPath, file: c.path, exports: shrink ? c.exports.slice(0, 6) : c.exports })),
    declaredPackages: declared.slice(0, 60),
    ...markup,
    rules: [
      `Write the complete content of ${path}: working code with no placeholders, TODOs or omitted sections.`,
      'Import repository modules only as listed in modules, with the names they export; import packages only from declaredPackages, or add them to the manifest first.',
      s.form
        ? 'Reply with the file content in one fenced code block; no explanation before or after it.'
        : 'Write the file content only, then the closing fence; no explanation before or after it.',
    ],
  };
  return [...agentPrefix(s), ...volatile(s), { role: 'user', content: JSON.stringify(request) }];
}
