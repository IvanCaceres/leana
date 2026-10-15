// The conversation as blocks: what the user said, each step's thought and actions, each tool's result, each
// edit as a diff, warnings, and the outcome. A block with a body folds to its title and first rows. Rows are
// rendered per block and kept until the block, the width or its fold changes, so a long session redraws cheaply.
import { cells, fitTo, row, wrap } from '../text.js';

export type Tone = 'user' | 'thought' | 'ok' | 'fail' | 'diff' | 'info' | 'warn' | 'outcome' | 'live';
// A body line: text (wrapped to the width), or a diff line (fitted, with its line number and mark).
export type BodyLine = string | { mark: '+' | '-' | ' ' | '@'; text: string; number?: number };
export interface Block {
  readonly id: number;
  tone: Tone;
  title: string;
  body: BodyLine[];
  collapsed: boolean;
  // The rows of the body a folded block still shows.
  preview: number;
  version: number;
}
export interface Styles {
  dim(s: string): string;
  bold(s: string): string;
  inverse(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
}
export function styles(color: boolean): Styles {
  const sgr = (on: string, off: string) => (s: string) => (color && s ? `\x1b[${on}m${s}\x1b[${off}m` : s);
  return {
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    inverse: sgr('7', '27'),
    red: sgr('31', '39'),
    green: sgr('32', '39'),
    yellow: sgr('33', '39'),
    blue: sgr('34', '39'),
    magenta: sgr('35', '39'),
    cyan: sgr('36', '39'),
  };
}
// A rendered row and the block it belongs to.
export interface Row {
  text: string;
  block: number;
}

const icons: Record<Tone, string> = {
  user: '>',
  thought: '*',
  ok: 'v',
  fail: 'x',
  diff: '~',
  info: '-',
  warn: '!',
  outcome: '#',
  live: '*',
};

export class Transcript {
  private blocks: Block[] = [];
  private next = 1;
  private cache = new Map<number, { key: string; rows: Row[] }>();
  get list(): readonly Block[] {
    return this.blocks;
  }
  add(tone: Tone, title: string, body: BodyLine[] = [], fold?: { collapsed?: boolean; preview?: number }): Block {
    const b: Block = {
      id: this.next++,
      tone,
      title,
      body,
      collapsed: fold?.collapsed ?? false,
      preview: fold?.preview ?? 3,
      version: 0,
    };
    this.blocks.push(b);
    return b;
  }
  change(b: Block, to: Partial<Pick<Block, 'tone' | 'title' | 'body' | 'collapsed'>>): void {
    Object.assign(b, to);
    b.version++;
  }
  remove(b: Block): void {
    this.blocks = this.blocks.filter(x => x !== b);
    this.cache.delete(b.id);
  }
  toggle(id: number): void {
    const b = this.blocks.find(x => x.id === id);
    if (b && b.body.length) this.change(b, { collapsed: !b.collapsed });
  }
  // Folds every block with a body, or unfolds them all when every one is folded.
  toggleAll(): void {
    const foldable = this.blocks.filter(b => b.body.length > b.preview);
    const fold = foldable.some(b => !b.collapsed);
    for (const b of foldable) this.change(b, { collapsed: fold });
  }
  rows(width: number, selected: number | null, s: Styles): Row[] {
    const out: Row[] = [];
    for (const b of this.blocks) {
      const key = `${width}:${b.version}:${b.collapsed}:${b.id === selected}`;
      let hit = this.cache.get(b.id);
      if (!hit || hit.key !== key) {
        hit = { key, rows: renderBlock(b, width, b.id === selected, s).map(text => ({ text, block: b.id })) };
        this.cache.set(b.id, hit);
      }
      out.push(...hit.rows);
    }
    return out;
  }
}

const toneStyle = (tone: Tone, s: Styles): ((x: string) => string) =>
  ({
    user: s.magenta,
    thought: s.cyan,
    ok: s.green,
    fail: s.red,
    diff: s.yellow,
    info: s.dim,
    warn: s.yellow,
    outcome: s.bold,
    live: s.cyan,
  })[tone];

// A block's rows: a blank row before a new step or a message of the user, the title with its fold mark and
// icon, then the body indented (all of it, or the folded block's first rows and how many more there are).
export function renderBlock(b: Block, width: number, selected: boolean, s: Styles): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  if (b.tone === 'user' || b.tone === 'thought' || b.tone === 'outcome') out.push('');
  const foldable = b.body.length > b.preview;
  const mark = !b.body.length ? ' ' : b.collapsed && foldable ? '+' : '-';
  const head = fitTo(`${mark} ${icons[b.tone]} ${row(b.title)}`, w);
  out.push(selected ? s.inverse(head) : toneStyle(b.tone, s)(head));
  const body: string[] = [];
  for (const line of b.body) {
    if (typeof line === 'string') {
      for (const r of wrap(row(line), w - 4)) body.push(`    ${r}`);
      continue;
    }
    if (line.mark === '@') {
      body.push(s.dim(fitTo(`    ${line.text}`, w)));
      continue;
    }
    const gutter = line.number === undefined ? '     ' : String(line.number).padStart(5);
    const text = fitTo(`${gutter} ${line.mark} ${row(line.text.replace(/\t/g, '  '))}`, w);
    body.push(line.mark === '+' ? s.green(text) : line.mark === '-' ? s.red(text) : s.dim(text));
  }
  if (b.collapsed && foldable) {
    out.push(...body.slice(0, b.preview));
    const more = body.length - b.preview;
    if (more > 0)
      out.push(s.dim(fitTo(`    ... ${more} more line${more === 1 ? '' : 's'} (Tab, then Enter to unfold)`, w)));
  } else out.push(...body);
  return out.map(r => (cells(stripStyles(r)) > w ? fitTo(stripStyles(r), w) : r));
}
// A row without its style codes, to measure it.
export const stripStyles = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
