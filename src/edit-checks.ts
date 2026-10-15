// The guards an edit meets before it lands, and the facts a refused edit is told with: line ranges mapped
// through earlier edits, bracket balance, the parser, duplicated and echoed lines.
import { open } from 'node:fs/promises';
import { syntaxErrors } from './code.js';
// A write whose target was never read, or was read before it changed. Only this
// failure class requires a fresh read; other edit failures are argument mistakes.
export class StaleWriteError extends Error {}
// One edit that landed, in the numbering of the text it was applied to: lines
// start..end (end = start - 1: none, an insertion before start) were replaced by
// count lines; every other line is unchanged and moves by the difference.
// changes null: the whole text was replaced, so no line of it maps forward.
export type LineChange = { start: number; end: number; count: number };
export type EditRecord = {
  path: string;
  step: number;
  route: string;
  before: string;
  after: string;
  changes: LineChange[] | null;
};
export const describeChange = (c: LineChange) =>
  c.end < c.start ? `inserted ${c.count} line(s) before ${c.start}` : `${c.start}..${c.end} -> ${c.count} line(s)`;
// Where lines start..end (end = start - 1: the position before start) of a text
// are after changes numbered in that same text landed; null when a change
// replaced any of those lines or put lines between them. The arithmetic is the
// bottom-up application replace_lines does within one call.
export function mapRange(start: number, end: number, changes: LineChange[]): { start: number; end: number } | null {
  const insert = end === start - 1;
  let shift = 0;
  for (const c of changes) {
    const cInsert = c.end === c.start - 1;
    const delta = c.count - (c.end - c.start + 1);
    if (cInsert ? c.start <= start : c.end < start) shift += delta;
    else if (insert ? !cInsert && c.start < start : c.start <= end) return null;
  }
  return { start: start + shift, end: end + shift };
}
// An import or export line the file already has is dropped from an insertion:
// the intent (have that import) is already met, so the edit is repaired, not
// refused. Returns the lines to insert and the ones dropped.
export function dropDuplicateImports(before: string, inserted: string[]): { kept: string[]; dropped: string[] } {
  const norm = (l: string) => l.trim().replace(/'/g, '"').replace(/;$/, '').replace(/\s+/g, ' ');
  const present = new Set(before.split('\n').map(norm));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of inserted) {
    if (/^\s*(import|export)\b.*\bfrom\b/.test(line) && present.has(norm(line))) dropped.push(line);
    else kept.push(line);
  }
  return { kept, dropped };
}
// An edit that pastes a block the file already contains (a header copied
// again, a function duplicated) is wrong content, the recurring way a small
// model breaks a file: refused, so the worker generates something else.
export function assertNoBulkDuplication(before: string, inserted: string[], label: string, countRule = true): void {
  const trimmed = (xs: string[]) => xs.map(l => l.trim());
  const beforeLines = trimmed(before.split('\n'));
  if (!countRule) return;
  // A run of five consecutive substantive inserted lines that already appears
  // consecutively in the file is a pasted block, not a shared idiom.
  // (five closing braces are not a paste: every line must carry some text and the run some substance)
  const substantive = (w: string[]) => w.every(l => l.length >= 4) && w.join('').length >= 60;
  const windows = new Set<string>();
  for (let i = 0; i + 5 <= beforeLines.length; i++) {
    const w = beforeLines.slice(i, i + 5);
    if (substantive(w)) windows.add(w.join('\n'));
  }
  const ins = trimmed(inserted);
  for (let i = 0; i + 5 <= ins.length; i++) {
    const w = ins.slice(i, i + 5);
    if (substantive(w) && windows.has(w.join('\n')))
      throw new Error(
        `Edit refused: it would insert a block that ${label} already contains (starting ${JSON.stringify(w[0]!.slice(0, 60))}). The file already has these lines; add only what is missing.`,
      );
  }
}
// The lines the replaced ranges held that their new text does not contain
// (compared trimmed, each new line matching one old line), as "n: text".
export function droppedLines(
  lines: string[],
  edits: { start: number; end: number }[],
  rendered: (e: any) => string[],
  limit = 6,
): string[] {
  const out: string[] = [];
  for (const e of [...edits].sort((x, y) => x.start - y.start)) {
    if (e.end < e.start) continue;
    const left = new Map<string, number>();
    for (const l of rendered(e)) {
      const t = l.trim();
      left.set(t, (left.get(t) ?? 0) + 1);
    }
    for (let n = e.start; n <= e.end; n++) {
      const t = (lines[n - 1] ?? '').trim();
      if (!t) continue;
      const k = left.get(t) ?? 0;
      if (k > 0) left.set(t, k - 1);
      else out.push(`${n}: ${t.slice(0, 80)}`);
    }
  }
  return out.length > limit ? [...out.slice(0, limit), `${out.length - limit} more`] : out;
}
// The lines at the start of a range's new text that are the lines just before the range as they
// are, and those at its end that are the lines just after it: exact, with some text among them,
// and never lines another range of the call replaces. In runs 49-76, 18 edits repeated a
// neighbouring line and in none did the worker's thought ask for a second copy: 7 of the 8 that
// landed left a duplicate (a CSS property, a wrapper div, 8 CSS rules, an object key, a
// destructured name, a call), and 7 calls were refused.
export function rangeEchoes(
  lines: string[],
  e: { start: number; end: number },
  fresh: string[],
  taken: (n: number) => boolean = () => false,
): { head: number; tail: number } {
  const last = Math.max(e.end, e.start - 1); // an insertion before line s sits between s - 1 and s
  const repeats = (from: number, xs: string[]) =>
    xs.some(l => l.trim()) && xs.every((l, i) => l === lines[from - 1 + i] && !taken(from + i));
  let head = 0;
  for (let k = Math.min(fresh.length, e.start - 1); k > 0 && !head; k--)
    if (repeats(e.start - k, fresh.slice(0, k))) head = k;
  let tail = 0;
  for (let k = Math.min(fresh.length - head, lines.length - last); k > 0 && !tail; k--)
    if (repeats(last + 1, fresh.slice(fresh.length - k))) tail = k;
  return { head, tail };
}
const bracketPairs = [
  ['{', '}'],
  ['(', ')'],
  ['[', ']'],
] as const;
type Pair = readonly [string, string];
// The brackets of one kind that code (literals and comments stripped) leaves unmatched: how many
// opens it does not close and how many closes it does not open.
function unmatched(code: string, [open, close]: Pair): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  for (const ch of code)
    if (ch === open) opens++;
    else if (ch === close) {
      if (opens) opens--;
      else closes++;
    }
  return { opens, closes };
}
// The lines outside a range holding the brackets that match the ones it leaves unmatched: the
// first ones of the other side not matched on the way, scanning away from the range.
function matchingLines(
  stripped: string[],
  from: number,
  forward: boolean,
  [open, close]: Pair,
  count: number,
): number[] {
  const out: number[] = [];
  let depth = 0;
  const [away, back] = forward ? [open, close] : [close, open];
  for (let i = from; out.length < count && i >= 0 && i < stripped.length; i += forward ? 1 : -1)
    for (const ch of forward ? stripped[i]! : [...stripped[i]!].reverse())
      if (ch === away) depth++;
      else if (ch === back) {
        if (depth) depth--;
        else if (out.push(i + 1) === count) break;
      }
  return out;
}
// A refused edit stated range by range: for the bracket kinds the refusal names, what the replaced
// lines leave unmatched (with the line outside the range that matches it) against what the new
// text does, and new text that repeats the lines around its range. Only ranges that change that
// balance or repeat a neighbour are stated. Run 73 step 50's new text ended with line 38, the line
// after its range; step 58's opened a '{' it never closed; both were told only that "the range cuts
// through a declaration", and were redone by a whole-file rewrite (10.6 s) and a read and a region
// rewrite (25.5 s).
export function editFacts(
  lines: string[],
  edits: { label: string; start: number; end: number; fresh: string[] }[],
  kinds: readonly Pair[],
): string[] {
  const stripped = stripLiterals(lines.join('\n')).split('\n');
  const out: string[] = [];
  const count = (n: number, ch: string) => `${n} '${ch}'`;
  const by = (xs: number[], verb: string) => {
    const u = [...new Set(xs)];
    return u.length > 1 ? `lines ${u.join(', ')} ${verb}` : `line ${u[0]} ${verb}s`;
  };
  const quote = (l: string) => JSON.stringify(l.length > 80 ? `${l.slice(0, 80)}…` : l);
  for (const e of edits) {
    const taken = (n: number) => edits.some(x => x !== e && n >= x.start && n <= x.end);
    const { head, tail } = rangeEchoes(lines, e, e.fresh, taken);
    const last = Math.max(e.end, e.start - 1);
    const was = kinds.map(k => unmatched(e.end >= e.start ? stripped.slice(e.start - 1, e.end).join('\n') : '', k));
    const now = kinds.map(k => unmatched(stripLiterals(e.fresh.join('\n')), k));
    const changed = kinds.filter((_, i) => was[i]!.opens - was[i]!.closes !== now[i]!.opens - now[i]!.closes);
    if (!changed.length && !head && !tail) continue;
    const old = changed.flatMap(k => {
      const w = was[kinds.indexOf(k)]!;
      const after = matchingLines(stripped, e.end, true, k, w.opens);
      const before = matchingLines(stripped, e.start - 2, false, k, w.closes);
      return [
        ...(w.opens ? [`open ${count(w.opens, k[0])}${after.length ? ` that ${by(after, 'close')}` : ''}`] : []),
        ...(w.closes ? [`close ${count(w.closes, k[1])}${before.length ? ` that ${by(before, 'open')}` : ''}`] : []),
      ];
    });
    const fresh = changed.flatMap(k => {
      const w = now[kinds.indexOf(k)]!;
      return [
        ...(w.opens ? [`opens ${count(w.opens, k[0])} it does not close`] : []),
        ...(w.closes ? [`closes ${count(w.closes, k[1])} it does not open`] : []),
      ];
    });
    const none = `no unmatched ${changed
      .flatMap(k => [`'${k[0]}'`, `'${k[1]}'`])
      .join(', ')
      .replace(/, ([^,]+)$/, ' or $1')}`;
    const echo = [
      ...(head
        ? [
            `${head === e.fresh.length ? 'is' : 'starts with'} ${head === 1 ? `${quote(e.fresh[0]!)}, which is line ${e.start - 1} as it is, the line before the range` : `lines ${e.start - head}..${e.start - 1} as they are, the lines before the range`}`,
          ]
        : []),
      ...(tail
        ? [
            `${tail === e.fresh.length ? 'is' : 'ends with'} ${tail === 1 ? `${quote(e.fresh.at(-1)!)}, which is line ${last + 1} as it is, the line after the range` : `lines ${last + 1}..${last + tail} as they are, the lines after the range`}`,
          ]
        : []),
    ];
    const replaced =
      !changed.length || e.end < e.start
        ? ''
        : `the replaced lines ${old.length ? old.join(' and ') : `have ${none}`}; `;
    const text = [...(changed.length ? [fresh.length ? fresh.join(' and ') : `has ${none}`] : []), ...echo].join(
      ', and ',
    );
    out.push(`${e.label[0]!.toUpperCase()}${e.label.slice(1)}: ${replaced}its new text ${text}.`);
  }
  return out;
}
// Facts in the room a refusal has: the evidence entry of a failed edit keeps 600 characters
// (agent.ts), so whole facts are kept while they fit, the first always, and the rest are counted.
export function factsInRoom(facts: string[], room: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const [i, f] of facts.entries()) {
    if (kept.length && used + f.length + 1 + (i < facts.length - 1 ? 40 : 0) > room) break;
    kept.push(f);
    used += f.length + 1;
  }
  return `${kept.join(' ')}${kept.length < facts.length ? ` (${facts.length - kept.length} more range(s) left out for room.)` : ''}`;
}
// A large range whose new text mostly equals the old is a retype. The lines
// that differ are the change the worker meant, so the edit is applied and the
// note names them; refusing it would only discard the generation.
export function nearRetype(oldLines: string[], newLines: string[], start: number): string | null {
  if (oldLines.length < 12 || newLines.length !== oldLines.length) return null;
  const differing = oldLines.map((l, i) => (l.trim() === newLines[i]!.trim() ? -1 : start + i)).filter(n => n >= 0);
  if (differing.length === 0 || differing.length > Math.max(2, Math.floor(oldLines.length * 0.2))) return null;
  return `this rewrote ${oldLines.length} lines of which only ${differing.length} changed (line${differing.length > 1 ? 's' : ''} ${differing.join(', ')}); next time edit only those lines, in ranges of their own`;
}
export async function assertParses(
  path: string,
  before: string,
  after: string,
  parse: (path: string, text: string) => Promise<string[]> = syntaxErrors,
): Promise<void> {
  const problems = await parse(path, after);
  if (!problems.length) return;
  const had = await parse(path, before);
  if (had.length && had.length >= problems.length) return; // already broken; do not block repairs
  throw new Error(
    `Edit refused: ${path} would no longer parse (${problems.join('; ')}). Re-read the lines around the error and cover whole statements; a missing import is added at the top of the file, never by overwriting the line that uses the name.`,
  );
}
// The bracket kinds an edit leaves with more unmatched brackets than before, as a refusal names them.
export function worseBrackets(before: string, after: string): { pair: Pair; said: string }[] {
  const count = (text: string, ch: string): number => text.split(ch).length - 1;
  const b = stripLiterals(before);
  const a = stripLiterals(after);
  return bracketPairs.flatMap(pair => {
    const [open, close] = pair;
    const was = count(b, open) - count(b, close);
    const now = count(a, open) - count(a, close);
    return Math.abs(now) > Math.abs(was)
      ? [{ pair, said: `${Math.abs(now)} unmatched '${now > 0 ? open : close}' (was ${Math.abs(was)})` }]
      : [];
  });
}
// With the ranges of the edit, the refusal states their facts (editFacts) in the room the error
// entry leaves after the reserved characters.
export function assertBalancePreserved(
  before: string,
  after: string,
  label: string,
  edits: { label: string; start: number; end: number; fresh: string[] }[] = [],
  reserved = 0,
): void {
  const worse = worseBrackets(before, after);
  if (!worse.length) return;
  const head = `Edit refused: it would leave ${label} with ${worse.map(w => w.said).join(', ')}.`;
  const facts = edits.length
    ? factsInRoom(
        editFacts(
          before.split('\n'),
          edits,
          worse.map(w => w.pair),
        ),
        600 - 'Tool error: '.length - head.length - 1 - reserved,
      )
    : '';
  throw new Error(facts ? `${head} ${facts}` : head);
}
export function stripLiterals(code: string): string {
  return code.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    m => m.replace(/[^\n]/g, ' '),
  );
}
