// The terminal as a full screen: the alternate screen (the shell's own screen comes back on leaving), raw
// input with bracketed paste, mouse-wheel reports when asked for, and drawing by rows. A frame is drawn by rewriting only
// the rows that differ from the last one, in one write, so streaming at ten updates a second costs a few rows.
// Leaving restores everything, also when the process exits, crashes or is signalled.
import { KeyReader, type Key } from './keys.js';

export interface TerminalInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export interface TerminalOutput {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}
// A position on the screen, 0-based.
export interface Cursor {
  row: number;
  col: number;
}

// Mouse reports are off unless asked for: while they are on, the terminal sends a click or drag to the app
// instead of selecting text, so nothing on the screen can be copied. With them off, a terminal that turns the
// wheel into Up and Down in the alternate screen (alternate scroll) is told not to, as Up recalls history
// here; leaving turns it back on for the programs that rely on it.
const enterSeq = '\x1b[?1049h\x1b[?1007l\x1b[?2004h\x1b[?25l\x1b[2J';
const mouseOn = '\x1b[?1000h\x1b[?1006h';
const mouseOff = '\x1b[?1006l\x1b[?1000l';
const leaveSeq = `\x1b[?2004l${mouseOff}\x1b[?1007h\x1b[0m\x1b[?25h\x1b[?1049l`;

export class Terminal {
  private frame: string[] = [];
  private active = false;
  private wheel = false;
  private readonly reader = new KeyReader();
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private onResize: (() => void) | null = null;
  private readonly restore = () => this.leave();
  constructor(
    readonly input: TerminalInput = process.stdin,
    readonly output: TerminalOutput = process.stdout,
  ) {}
  get columns(): number {
    return Math.max(20, this.output.columns ?? 80);
  }
  get rows(): number {
    return Math.max(8, this.output.rows ?? 24);
  }
  enter(keys: (keys: Key[]) => void, resized: () => void): void {
    if (this.active) return;
    this.active = true;
    this.output.write(enterSeq + (this.wheel ? mouseOn : ''));
    this.input.setRawMode?.(true);
    this.onData = chunk => keys(this.reader.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    this.input.on('data', this.onData);
    this.input.resume();
    this.onResize = () => {
      this.frame = [];
      resized();
    };
    this.output.on?.('resize', this.onResize);
    process.once('exit', this.restore);
  }
  leave(): void {
    if (!this.active) return;
    this.active = false;
    if (this.onData) this.input.off('data', this.onData);
    if (this.onResize) this.output.off?.('resize', this.onResize);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write(leaveSeq);
    this.frame = [];
    process.off('exit', this.restore);
  }
  // The wheel scrolls the app (mouse reports on), or the mouse selects text as the terminal's own does (off).
  setMouse(on: boolean): void {
    if (this.active && on !== this.wheel) this.output.write(on ? mouseOn : mouseOff);
    this.wheel = on;
  }
  get mouse(): boolean {
    return this.wheel;
  }
  get isActive(): boolean {
    return this.active;
  }
  // The rows last drawn.
  get screen(): readonly string[] {
    return this.frame;
  }
  // Draws the frame (one string per row, already fitted to the width, styles included) and places the cursor.
  draw(rows: string[], cursor: Cursor | null): void {
    if (!this.active) return;
    let out = '\x1b[?25l';
    const height = Math.max(rows.length, this.frame.length);
    for (let i = 0; i < height; i++) {
      const row = rows[i] ?? '';
      if (row === this.frame[i]) continue;
      out += `\x1b[${i + 1};1H${row}\x1b[0m\x1b[K`;
    }
    if (cursor) out += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    this.output.write(out);
    this.frame = rows.slice();
  }
}
