// A unified diff of two texts by lines, for showing an edit as it lands: hunks of changed lines with a few
// unchanged lines around them, numbered as in each text. The unchanged start and end are set aside first;
// the middle is aligned by a longest common subsequence while it is small enough to align cheaply, and
// otherwise shown as its old lines removed and its new lines added.

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
  // The line's number in the old text (unchanged and removed lines) and in the new one (unchanged and added).
  old?: number;
  new?: number;
}
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface Diff {
  hunks: Hunk[];
  added: number;
  removed: number;
}

// The most cells of the alignment table: a middle of 2,000 by 2,000 lines takes 16 MB and a few milliseconds.
const alignLimit = 4_000_000;
const linesOf = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

export function diffLines(before: string, after: string, context = 3): Diff {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const ops: DiffLine[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', text: a[i]!, old: i + 1, new: i + 1 });
  ops.push(...alignMiddle(a.slice(start, a.length - end), b.slice(start, b.length - end), start));
  for (let i = end; i > 0; i--)
    ops.push({ kind: ' ', text: a[a.length - i]!, old: a.length - i + 1, new: b.length - i + 1 });
  return {
    hunks: hunksOf(ops, context),
    added: ops.filter(l => l.kind === '+').length,
    removed: ops.filter(l => l.kind === '-').length,
  };
}

// The changed middle as unchanged, removed and added lines, numbered from offset.
function alignMiddle(a: string[], b: string[], offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  if (a.length * b.length > alignLimit || !a.length || !b.length) {
    a.forEach((text, i) => out.push({ kind: '-', text, old: offset + i + 1 }));
    b.forEach((text, j) => out.push({ kind: '+', text, new: offset + j + 1 }));
    return out;
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..], in one flat table.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]!, old: offset + i + 1, new: offset + j + 1 });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      out.push({ kind: '+', text: b[j]!, new: offset + j + 1 });
      j++;
    } else {
      out.push({ kind: '-', text: a[i]!, old: offset + i + 1 });
      i++;
    }
  }
  // Within a run of changes, removed lines before added ones, as a unified diff shows them.
  return byRuns(out);
}
function byRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    out.push(...run.filter(l => l.kind === '-'), ...run.filter(l => l.kind === '+'));
    run = [];
  };
  for (const l of lines) {
    if (l.kind === ' ') {
      flush();
      out.push(l);
    } else run.push(l);
  }
  flush();
  return out;
}

// The changed lines with `context` unchanged lines on each side; changes closer than twice that share a hunk.
function hunksOf(ops: DiffLine[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.kind === ' ') i++;
    if (i >= ops.length) break;
    const from = Math.max(0, i - context);
    let to = i;
    // Extend over changes and short unchanged gaps.
    for (;;) {
      while (to < ops.length && ops[to]!.kind !== ' ') to++;
      let gap = to;
      while (gap < ops.length && ops[gap]!.kind === ' ') gap++;
      if (gap < ops.length && gap - to <= 2 * context) to = gap;
      else break;
    }
    const lines = ops.slice(from, Math.min(ops.length, to + context));
    const firstOld = lines.find(l => l.old !== undefined)?.old;
    const firstNew = lines.find(l => l.new !== undefined)?.new;
    hunks.push({ oldStart: firstOld ?? 0, newStart: firstNew ?? 0, lines });
    i = to + context;
  }
  return hunks;
}
