// Text for a terminal: numbers and durations in a few characters, rows of text fitted to a width counted in
// cells, and text wrapped to it.
export const k = (n: number | null | undefined) =>
  n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
export const secs = (ms: number | null | undefined) =>
  ms == null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
export const plural = (n: number, what: string) => `${k(n)} ${what}${n === 1 ? '' : 's'}`;
// A shown value cut to n characters (clip's marker is an instruction to the model, not for the screen).
export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
// Text for one terminal row: line breaks, tabs and the other spacing controls as one space, and control,
// format and combining characters (escape sequences, zero-width joiners, bidi overrides, stacked accents)
// and unpaired surrogates dropped. Spaces stay as they are, so labels keep their columns.
export const row = (s: string) =>
  s.replace(/[\t\n\v\f\r\x85\u2028\u2029]+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{M}\p{Cs}]/gu, '');
// The same, words separated by single spaces, for text that is wrapped.
export const plain = (s: string) => row(s).replace(/ +/g, ' ').trim();
// The cells a row takes, counting any character but ASCII as two: no terminal draws one wider (wide CJK and
// emoji take two, ambiguous-width ones one or two), so a row counted under the width never wraps.
export const cellsOf = (c: string) => (c < '\x7f' ? 1 : 2);
export const cells = (s: string) => {
  let n = 0;
  for (const c of s) n += cellsOf(c);
  return n;
};
// The longest start of s (or end) that takes at most w cells.
export function take(s: string, w: number, end = false): string {
  const cs = [...s];
  let n = 0;
  let i = 0;
  for (; i < cs.length; i++) {
    n += cellsOf(cs[end ? cs.length - 1 - i : i]!);
    if (n > w) break;
  }
  return end ? cs.slice(cs.length - i).join('') : cs.slice(0, i).join('');
}
// A row fitted to w cells: its start, or its end (a line still being written grows there), marked where cut.
export const fitTo = (s: string, w: number, end = false) =>
  cells(s) <= w ? s : end ? `...${take(s, w - 3, true)}` : `${take(s, w - 3)}...`;
// Rows of at most width cells broken at spaces (a longer word is broken inside it), each after the first indented.
export function wrap(s: string, width: number, indent = 0): string[] {
  const rows: string[] = [];
  let row = '';
  const room = () => Math.max(2, width - (rows.length ? indent : 0));
  for (let word of s.split(' ')) {
    if (row && cells(row) + 1 + cells(word) > room()) {
      rows.push(row);
      row = '';
    }
    while (!row && cells(word) > room()) {
      const head = take(word, room());
      rows.push(head);
      word = word.slice(head.length);
    }
    row = row ? `${row} ${word}` : word;
  }
  rows.push(row);
  return rows.map((r, i) => (i ? ' '.repeat(indent) + r : r));
}
