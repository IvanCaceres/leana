// One replace_lines call, from the ranges the worker sent to the text that lands. The ranges are checked
// against the file as read, rendered (a prefix, new text, or a deletion), applied from the bottom up so no
// edit shifts another's line numbers, and judged by the bracket balance and the parser before anything is
// written. A break caused only by new text that repeats the lines around its range is repaired by leaving
// the repeat out; any other is refused with the facts of each range.
import {
  assertBalancePreserved,
  assertNoBulkDuplication,
  assertParses,
  droppedLines,
  dropDuplicateImports,
  editFacts,
  nearRetype,
  rangeEchoes,
  worseBrackets,
  type LineChange,
} from './edit-checks.js';

// A range as the worker sends it: lines start..end (end = start - 1: an insertion before start, start =
// totalLines + 1 appends) replaced by newText, or each line of it prefixed with prepend.
export interface LineEdit {
  start: number;
  end: number;
  newText: string;
  prepend?: string;
}
// A range with its place in the call (n), as the worker numbered it.
type Numbered = LineEdit & { n: number };
type Parser = (path: string, text: string) => Promise<string[]>;
const isInsertion = (e: { start: number; end: number }) => e.end === e.start - 1;
// At an equal start a replacement is taken before an insertion: inserting before line k
// and replacing k..m do not overlap, whatever order they were sent in.
const bottomUp = (x: { start: number; end: number }, y: { start: number; end: number }) =>
  y.start - x.start || Number(isInsertion(x)) - Number(isInsertion(y));
const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

export class LineEditPlan {
  readonly lines: string[];
  // A file ending in a newline splits into a trailing empty element; appending
  // at totalLines + 1 must land before it so the file keeps its final newline.
  readonly trailing: boolean;
  // Every range of the call, bottom up.
  readonly all: Numbered[];
  // The ranges that change the file (not skipped as unchanged), bottom up.
  edits: Numbered[] = [];
  // Ranges whose new text equals the lines they replace.
  skipped: Numbered[] = [];
  // Import lines the new text repeated from the rest of the file, left out.
  readonly droppedImports: string[] = [];
  // The text that lands, and how far it moved the lines below the first edit.
  updated = '';
  delta = 0;
  // What a repair left unwritten, and the ranges as they were applied after it (null: as sent).
  repaired = '';
  applied: LineEdit[] | null = null;
  private outsideText = '';

  constructor(
    readonly path: string,
    readonly original: string,
    readonly requested: LineEdit[],
    // A harness-chosen rewrite (a region the code picked, validated before
    // it got here) is applied as it is: the paste and retype rules are for
    // the worker's own line edits.
    readonly harness: boolean,
    private readonly parse: Parser,
  ) {
    this.lines = original.split('\n');
    const lines = this.lines;
    this.trailing = lines.length > 1 && lines.at(-1) === '';
    this.all = requested
      .map((e, i) => ({
        ...e,
        n: i + 1,
        ...(this.trailing && isInsertion(e) && e.start === lines.length + 1
          ? { start: lines.length, end: lines.length - 1 }
          : {}),
      }))
      .sort(bottomUp);
  }

  // Each range fits the file and none overlaps another; a prefix goes on declaration lines only.
  checkRanges(): void {
    const lines = this.lines;
    const all = this.all;
    for (const [i, e] of all.entries()) {
      const insert = isInsertion(e);
      if (!insert && (e.end < e.start || e.end - e.start >= 2000))
        throw new Error(
          `Range ${e.start}..${e.end} must contain 1..2000 lines, or end = start - 1 to insert before start`,
        );
      if (insert && e.prepend)
        throw new Error(`Range ${e.start}..${e.end} is an insertion; prepend applies to existing lines only`);
      if (insert && !e.newText) throw new Error(`Range ${e.start}..${e.end} is an insertion and needs newText`);
      if ((insert ? e.start - 1 : e.end) > lines.length)
        throw new Error(`Range ${e.start}..${e.end} exceeds ${this.path} (${lines.length} lines)`);
      const next = all[i + 1];
      if (next && Math.max(next.end, next.start - 1) >= e.start && !(insert && next.end < e.start))
        throw new Error(`Ranges ${next.start}..${next.end} and ${e.start}..${e.end} overlap; merge them into one edit`);
      if (e.prepend) this.checkPrepend(e);
    }
  }
  private checkPrepend(e: Numbered): void {
    const prepend = e.prepend!;
    for (let n = e.start; n <= e.end; n++) {
      const line = this.lines[n - 1] ?? '';
      if (/^\s*$/.test(line))
        throw new Error(`Line ${n} is blank; prepend "${prepend}" belongs on the declaration line`);
      if (/^\s*(import|export)\b/.test(line) && /^\s*export\s*$/.test(prepend))
        throw new Error(
          `Line ${n} already starts with ${line.trim().split(/\s+/)[0]} (${JSON.stringify(line.trim().slice(0, 60))}); export is prepended only to a declaration line`,
        );
      const lastWord = prepend.trim().split(/\s+/).pop() ?? '';
      if (lastWord && line.trimStart().startsWith(`${lastWord} `))
        throw new Error(
          `Line ${n} already starts with ${JSON.stringify(lastWord)} (${JSON.stringify(line.trim().slice(0, 60))}); prepend adds only what is missing, so use prepend ${JSON.stringify(prepend.trim().split(/\s+/).slice(0, -1).join(' ') + ' ')}`,
        );
    }
  }

  // The lines a range puts in its place. Import lines the file already has (outside the replaced
  // ranges) are dropped from the inserted text: the intent is met, so the edit is repaired.
  rendered(e: LineEdit): string[] {
    if (e.prepend) return this.lines.slice(e.start - 1, e.end).map(l => `${e.prepend}${l}`);
    if (e.newText === '') return [];
    const { kept, dropped } = dropDuplicateImports(this.outsideText, e.newText.replace(/\n$/, '').split('\n'));
    for (const d of dropped) if (!this.droppedImports.includes(d)) this.droppedImports.push(d);
    return kept;
  }

  // An edit that leaves its lines as they are is skipped, not fatal: in a
  // batch of forty deletions one redundant rewrite must not void the rest.
  selectEdits(): void {
    const lines = this.lines;
    this.outsideText = lines
      .filter((_, i) => !this.all.some(e => e.end >= e.start && i + 1 >= e.start && i + 1 <= e.end))
      .join('\n');
    // A deletion is never a no-op; a rewrite is one only when every line is unchanged.
    this.skipped = this.all.filter(
      e =>
        e.end >= e.start &&
        !(e.newText === '' && !e.prepend) &&
        same(lines.slice(e.start - 1, e.end), this.rendered(e)),
    );
    this.edits = this.all.filter(e => !this.skipped.includes(e) && !(e.end < e.start && this.rendered(e).length === 0));
    if (!this.edits.length)
      throw new Error(
        this.droppedImports.length
          ? `replace_lines produced no change: the only new lines were imports ${this.path} already has (${this.droppedImports.map(l => l.trim()).join('; ')})`
          : `replace_lines produced no change: every newText equals the current lines (${this.all.map(e => `${e.start}..${e.end}`).join(', ')})`,
      );
  }

  // The file with the given ranges applied, bottom up, and how far they moved the lines below them.
  private splice(xs: Numbered[]): { text: string; delta: number } {
    let out = this.lines;
    let shift = 0;
    for (const e of xs) {
      const fresh = this.rendered(e);
      const removed = Math.max(0, e.end - e.start + 1);
      out = [...out.slice(0, e.start - 1), ...fresh, ...out.slice(e.start - 1 + removed)];
      shift += fresh.length - removed;
    }
    return { text: out.join('\n'), delta: shift };
  }
  private async passes(text: string): Promise<boolean> {
    try {
      assertBalancePreserved(this.original, text, this.path);
      await assertParses(this.path, this.original, text, this.parse);
      return true;
    } catch {
      return false;
    }
  }
  // The ranges as a refusal names them.
  private described(xs: Numbered[]) {
    return xs
      .filter(e => !e.prepend)
      .map(e => ({
        label: `edit ${e.n} (${e.end < e.start ? `insert before line ${e.start}` : `lines ${e.start}..${e.end}`})`,
        start: e.start,
        end: e.end,
        fresh: this.rendered(e),
      }));
  }

  // The text that lands: the edits applied, when the brackets match and the file parses as well as it did;
  // else the edits without the lines that repeat their surroundings, when that alone is the break (repair);
  // else a refusal with each range's facts. mapped is the stale-range mapping a refusal may end with.
  async judge(mapped: string): Promise<void> {
    ({ text: this.updated, delta: this.delta } = this.splice(this.edits));
    if (await this.passes(this.updated)) return;
    // New text that repeats the lines just outside its range is the range drawn too
    // small, or the text drawn too large: the file is the same either way, so when
    // the repeat alone breaks it (without it the brackets match and the file parses)
    // and no range moved by the repeat fits (below), it is not written, as a region
    // rewrite's repeat is not. Of the 7 refusals in runs 49-76 with such a repeat, this
    // writes 3: run 73 step 50 (its new text ended with line 38, the line after its
    // range; redone by a 10.6 s whole-file rewrite),
    // run 62 step 35 (redone by a rewrite to the same code) and run 49 step 34. The
    // other 4 break the file without the repeat too and are refused with the facts.
    // A trailing blank line is kept as one (newText drops a final line break).
    const cut = new Map<number, { head: number; tail: number }>();
    const trimmed = this.harness ? this.edits : this.withoutEchoes(cut);
    const again = cut.size ? this.splice(trimmed) : null;
    if (
      again &&
      again.text !== this.original &&
      (await this.passes(again.text)) &&
      !(await this.anotherReadingFits(cut, trimmed, again.text))
    ) {
      this.repair(cut, trimmed, again);
      return;
    }
    await this.refuse(mapped);
  }
  // The edits without the lines of new text that repeat the lines around their ranges; cut records how many
  // were left out at the head and the tail of each edit, by its number.
  private withoutEchoes(cut: Map<number, { head: number; tail: number }>): Numbered[] {
    const edits = this.edits;
    return edits
      .map(e => {
        if (e.prepend || e.newText === '') return e;
        const fresh = this.rendered(e);
        const echo = rangeEchoes(this.lines, e, fresh, n => edits.some(x => x !== e && n >= x.start && n <= x.end));
        if (!echo.head && !echo.tail) return e;
        const kept = fresh.slice(echo.head, fresh.length - echo.tail);
        cut.set(e.n, echo);
        return { ...e, newText: `${kept.join('\n')}${kept.at(-1) === '' ? '\n' : ''}` };
      })
      .filter(e => !(e.end < e.start && this.rendered(e).length === 0));
  }
  // The same repeat is what a range drawn k lines off shows (line numbers from an older
  // read: run 76 step 10 sent line 6 for line 7): the text is then meant for the range
  // moved k lines, which keeps the line the sent range loses at its other end. When that
  // edit changes lines and passes the checks too, the two readings are two files, and the
  // edit is refused with its facts. Moved one line down, run 73 step 50's text would follow
  // the setValue line it rewrites, and 1 '{' would be unmatched: one reading.
  private async anotherReadingFits(
    cut: Map<number, { head: number; tail: number }>,
    xs: Numbered[],
    text: string,
  ): Promise<boolean> {
    const lines = this.lines;
    for (const [n, c] of cut)
      for (const k of [-c.head, c.tail].filter(Boolean)) {
        const e = this.edits.find(x => x.n === n)!;
        const m = { ...e, start: e.start + k, end: e.end + k };
        const end = Math.max(m.end, m.start - 1);
        const others = xs.filter(x => x.n !== n);
        if (
          m.start < 1 ||
          end > lines.length ||
          (m.end >= m.start && same(lines.slice(m.start - 1, m.end), this.rendered(m))) ||
          others.some(x => x.start <= end && m.start <= Math.max(x.end, x.start - 1))
        )
          continue;
        const alt = this.splice([...others, m].sort(bottomUp)).text;
        if (alt !== text && alt !== this.original && (await this.passes(alt))) return true;
      }
    return false;
  }
  private repair(
    cut: Map<number, { head: number; tail: number }>,
    trimmed: Numbered[],
    again: { text: string; delta: number },
  ): void {
    const worse = worseBrackets(this.original, this.updated).map(w => w.said);
    this.repaired = ` ${editFacts(this.lines, this.described([...this.edits].sort((x, y) => x.n - y.n)), [])
      .map((f, i) => `${i ? f[0]!.toLowerCase() : f[0]}${f.slice(1, -1)}`)
      .join(
        '; ',
      )}; ${[...cut.values()].reduce((k, c) => k + c.head + c.tail, 0) > 1 ? 'those lines were not written, since with them' : 'that line was not written, since with it'} ${this.path} would ${worse.length ? `have ${worse.join(', ')}` : 'no longer parse'}.`;
    this.applied = this.requested.map((r, i) => {
      const t = trimmed.find(e => e.n === i + 1);
      return cut.has(i + 1) ? { ...r, newText: t ? t.newText : '' } : r;
    });
    this.edits = trimmed;
    ({ text: this.updated, delta: this.delta } = again);
  }
  // A refusal states each range's facts. For the brackets: what the replaced lines leave
  // unmatched against what the new text does, and new text repeating the lines around its
  // range, fitted to the error entry with the mapping this message may end with. For the
  // parser: the lines the ranges held that the new text drops, the cause of an unclosed
  // tag, not only where the parser noticed it; then new text repeating the lines around its
  // range (run 72 step 20's edit 3 ended with line 33), last, where an entry already over its
  // 600 characters keeps it; one that fits is not pushed over (run 57 step 52's, 562, whose
  // dropped "5: <Layout>" is the opener of the "</Layout>" the parser names).
  private async refuse(mapped: string): Promise<void> {
    const told = this.described([...this.edits].sort((x, y) => x.n - y.n));
    const reserved = mapped ? mapped.length + 90 : 0;
    const room = 600 - 'Tool error: '.length - reserved;
    const gone = droppedLines(
      this.lines,
      this.edits.filter(x => !x.prepend),
      e => this.rendered(e),
    );
    // The lines dropped follow the bracket facts while they fit: run 76 step 10's cause was the
    // dropped "6: export default defineConfig({", which the balance alone does not quote.
    try {
      assertBalancePreserved(this.original, this.updated, this.path, told, reserved);
    } catch (e) {
      const more = gone.length
        ? ` The replaced range(s) held line(s) the new text does not contain: ${gone.join('; ')}.`
        : '';
      throw new Error(
        (e as Error).message.length + more.length <= room ? `${(e as Error).message}${more}` : (e as Error).message,
      );
    }
    try {
      await assertParses(this.path, this.original, this.updated, this.parse);
    } catch (e) {
      const echoes = editFacts(this.lines, told, [])
        .map(f => ` ${f}`)
        .join('');
      const said = gone.length
        ? `${(e as Error).message} The replaced range(s) held line(s) the new text does not contain: ${gone.join('; ')}.`
        : (e as Error).message;
      throw new Error(said.length + echoes.length <= room || said.length > room ? `${said}${echoes}` : said);
    }
  }

  // Ranges whose new text is the old text with a few characters changed: worth a note, not a refusal.
  retypes(): string[] {
    const out: string[] = [];
    if (!this.harness)
      for (const e of this.edits)
        if (!e.prepend && e.end >= e.start) {
          const why = nearRetype(this.lines.slice(e.start - 1, e.end), this.rendered(e), e.start);
          if (why) out.push(why);
        }
    return out;
  }
  // Retyping a range in place is a rewrite, not a paste: the inserted lines are judged against the file
  // without the ranges they replace. The refusal states what the edit replaces and what stays, so a whole
  // new file sent as a small range shows itself as that.
  assertNoPastedFile(): void {
    if (this.harness) return;
    const lines = this.lines;
    const edits = this.edits;
    const outside = lines
      .filter((_, i) => !edits.some(e => e.end >= e.start && i + 1 >= e.start && i + 1 <= e.end))
      .join('\n');
    try {
      assertNoBulkDuplication(
        outside,
        edits.filter(e => !e.prepend).flatMap(e => this.rendered(e)),
        this.path,
      );
    } catch (e) {
      const removed = edits.reduce((n, x) => n + Math.max(0, x.end - x.start + 1), 0);
      const added = edits
        .filter(x => !x.prepend && x.newText)
        .reduce((n, x) => n + x.newText.replace(/\n$/, '').split('\n').length, 0);
      const total = lines.length - (this.trailing ? 1 : 0);
      throw new Error(
        `${(e as Error).message} This edit replaces ${removed} line(s) (${edits
          .map(x => `${x.start}..${x.end}`)
          .reverse()
          .join(
            ', ',
          )}) with ${added}; the other ${total - removed} line(s) of ${this.path} stay as they are. rewrite_file replaces a whole file.`,
      );
    }
  }

  // The edits as line changes, in the numbering of the text they were applied to.
  changes(): LineChange[] {
    return this.edits.map(e => ({ start: e.start, end: Math.max(e.end, e.start - 1), count: this.rendered(e).length }));
  }
  // What the result says after the hash: the ranges' mapping, what was not written, skipped or dropped,
  // how far the lines below moved, and the file around the edits as it now reads.
  report(mapped: string, retypes: string[]): { summary: string; tail: string } {
    const edits = this.edits;
    const summary = edits
      .map(e => `${e.start}..${e.end}`)
      .reverse()
      .join(', ');
    const newLines = this.updated.split('\n');
    const lo = Math.max(1, Math.min(...edits.map(e => e.start)) - 3);
    const hi = Math.min(newLines.length, Math.max(...edits.map(e => e.end)) + this.delta + 3);
    const region =
      hi >= lo && hi - lo < 120
        ? `\nThe file now reads, lines ${lo}..${hi}:\n${newLines
            .slice(lo - 1, hi)
            .map((l, i) => `${lo + i}: ${l}`)
            .join('\n')}`
        : '';
    // Lines not written come first: the entry keeps this result's first 389 characters (run 49 step 34's
    // note, after the skipped and dropped ones, was cut at "since wi").
    const note = [
      this.repaired,
      this.skipped.length
        ? ` Skipped ${this.skipped.length} unchanged range(s): ${this.skipped
            .map(e => `${e.start}..${e.end}`)
            .reverse()
            .join(', ')}.`
        : '',
      this.droppedImports.length ? ` Dropped ${this.droppedImports.length} import line(s) the file already had.` : '',
      retypes.length ? ` Note: ${retypes.join('; ')}.` : '',
    ].join('');
    return {
      summary,
      tail: `${mapped}${note} Line numbers below the first edit shifted by ${this.delta} in total.${region}`,
    };
  }
}
